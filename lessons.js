/**
 * lessons.js — Agent learning system for Fibonacci LP strategy.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. Evolved thresholds focus on binsByStep learning.
 *
 * Adapted from Meridian's lessons.js:
 * - Removed: minOrganic evolution, minFeeActiveTvlRatio evolution, smart wallet references
 * - Added: fib_entry_pct tracking (0% = at fib_236, 100% = at fib_618)
 * - Kept: binsByStep learning (same logic)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { safeSave } from "./log-utils.js";
import { sendMessage } from "./telegram.js";
import { updateSignalWeights } from "./signal-weights.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP  = 0.20;

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    // Handle legacy bare-array format (e.g. "[]") and missing fields
    if (Array.isArray(data)) return { lessons: [], performance: [] };
    if (!Array.isArray(data?.lessons)) data.lessons = [];
    if (!Array.isArray(data?.performance)) data.performance = [];
    return data;
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  safeSave(LESSONS_FILE, data, "lessons");
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes.
 *
 * @param {Object} perf
 * @param {string} perf.position
 * @param {string} perf.pool
 * @param {string} perf.pool_name
 * @param {string} perf.strategy
 * @param {number} perf.bin_range
 * @param {number} perf.bin_step
 * @param {number} perf.volatility
 * @param {number} perf.fee_tvl_ratio
 * @param {number} perf.organic_score
 * @param {number} perf.amount_sol
 * @param {number} perf.fees_earned_usd
 * @param {number} perf.final_value_usd
 * @param {number} perf.initial_value_usd
 * @param {number} perf.minutes_in_range
 * @param {number} perf.minutes_held
 * @param {string} perf.close_reason
 * @param {number}  [perf.fib_entry_pct]         - Where in Fib zone was entry (0=fib236, 100=fib618)
 * @param {number}  [perf.confluence_score]      - Fibonacci confluence score at entry (0-1)
 * @param {string}  [perf.fib_zone]              - ATH_ZONE / PRIMARY / SECONDARY
 * @param {number}  [perf.rsi]                   - RSI at entry
 * @param {number}  [perf.atr_pct]               - ATR% at entry
 * @param {boolean} [perf.in_primary_zone]       - Price was in primary Fib zone at entry
 * @param {boolean} [perf.has_hidden_divergence] - Hidden bullish divergence at entry
 * @param {boolean} [perf.smart_wallet_present]  - Smart wallet boost was applied
 * @param {number}  [perf.ath_price]             - ATH price at close time (for deploy cooldown)
 */
export async function recordPerformance(perf) {
  const data = load();

  // BUG FIX: Always compute pnl_pct locally from USD values.
  // pnl_pct_override from Meteora can be WRONG for BULL-SOL positions where SOL price
  // moved significantly — Meteora may have a stale/wrong initialUsd stored, causing
  // pnlPctChange to be incorrect even when pnlUsd is correct (e.g., -22.58% instead of +252%).
  // Trust pnlUsd as authoritative (always correct in USD terms), derive percentage locally.
  // allTimeWithdrawals already includes fee tokens — do NOT add allTimeFees separately.
  const pnl_usd = perf.pnl_usd_override != null
    ? perf.pnl_usd_override
    : (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Update Darwinian signal weights
  updateSignalWeights(entry);

  const lesson = derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
    const emoji = lesson.outcome === "good" ? "✅" : lesson.outcome === "bad" ? "❌" : "⚠️";
    sendMessage(`${emoji} Pelajaran baru [${lesson.outcome.toUpperCase()}]\n${lesson.rule}`).catch(() => {});
  }

  save(data);

  // Chart self-learning: fire-and-forget LLM post-trade analysis (non-blocking)
  const chartOutcome = pnl_pct >= 5 ? "good" : pnl_pct <= -5 ? "bad" : "neutral";
  if (chartOutcome !== "neutral") {
    runChartLessonAnalysis(entry, chartOutcome).catch(e => log("lessons", `Chart analysis error: ${e.message}`));
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name:       perf.pool_name,
      base_mint:       perf.base_mint,
      deployed_at:     perf.deployed_at,
      closed_at:       entry.recorded_at,
      pnl_pct:         entry.pnl_pct,
      pnl_usd:         entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held:    perf.minutes_held,
      close_reason:    perf.close_reason,
      strategy:        perf.strategy,
      volatility:      perf.volatility,
      ath_price:      perf.ath_price ?? null,
      ath_price_sol:  perf.ath_price_sol ?? null,
    });
  }

  // Evolve thresholds + run signal attribution every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
      const lines = Object.entries(result.changes).map(([k, v]) => {
        if (k === "binsByStep") return `• binsByStep = ${JSON.stringify(v)}`;
        return `• ${k} = ${v}`;
      }).join("\n");
      sendMessage(`🧠 Threshold auto-evolved (${data.performance.length} posisi):\n${lines}`).catch(() => {});
    }

    // Signal attribution: which entry signals predicted wins?
    const attribution = computeSignalAttribution(data.performance);
    if (attribution) {
      log("attribution", attribution.summary);
      sendMessage(`📊 Signal Attribution (${data.performance.length} posisi):\n${attribution.summary}`).catch(() => {});
    }
  }
}

/**
 * Derive a lesson from a closed position's performance.
 */
function derivLesson(perf) {
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct <= -5 ? "bad"
    : "neutral";

  if (outcome === "neutral") return null;

  const fibEntryStr = perf.fib_entry_pct != null ? `, fib_entry=${perf.fib_entry_pct.toFixed(0)}%` : "";
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `bin_range=${typeof perf.bin_range === "object" ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
    fibEntryStr ? fibEntryStr.slice(2) : null,
  ].filter(Boolean).join(", ");

  let rule = "";
  const tags = [];

  if (outcome === "bad" && perf.range_efficiency < 30) {
    rule = `AVOID: ${perf.pool_name}-type pools (bin_step=${perf.bin_step}, volatility=${perf.volatility}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of time.${fibEntryStr}`;
    tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
  } else if (outcome === "good" && perf.range_efficiency > 80) {
    rule = `PREFER: ${perf.pool_name}-type pools (bin_step=${perf.bin_step}) — ${perf.range_efficiency}% in-range, PnL +${perf.pnl_pct}%.${fibEntryStr}`;
    tags.push("efficient", "fib_entry");
  } else if (outcome === "bad" && perf.close_reason?.includes("stop loss")) {
    rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, hit stop loss. Consider tighter Fib zone entry or lower stopLossPct threshold.`;
    tags.push("stop_loss", "fib_entry");
  } else if (outcome === "good") {
    rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
    tags.push("worked", "fib_entry");
  } else {
    rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
    tags.push("failed");
  }

  if (!rule) return null;

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    fib_entry_pct: perf.fib_entry_pct ?? null,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze performance data and evolve screening thresholds.
 * Fibonacci agent only evolves binsByStep — the core Fib signal handles the rest.
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter(p => p.pnl_pct > 0);
  const losers  = perfData.filter(p => p.pnl_pct < -5);

  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── binsByStep (optimal bins_below per bin_step) ──────────────────────────
  {
    const currentMap = config.strategy?.binsByStep ?? {};
    const updatedMap = { ...currentMap };
    let mapChanged = false;

    const stepGroups = {};
    for (const p of perfData) {
      const step = p.bin_step;
      const bins = p.bin_range?.bins_below;
      if (!step || !isFiniteNum(bins) || !isFiniteNum(p.range_efficiency)) continue;
      if (!stepGroups[step]) stepGroups[step] = { winners: [], losers: [] };
      if (p.pnl_pct >= 5 && p.range_efficiency >= 55) stepGroups[step].winners.push(bins);
      else if (p.pnl_pct < -3) stepGroups[step].losers.push(bins);
    }

    for (const [step, group] of Object.entries(stepGroups)) {
      const current = currentMap[step] ?? 69;
      const hasWinners = group.winners.length >= 2;
      const hasLosers  = group.losers.length  >= 2;

      if (!hasWinners && !hasLosers) continue;

      let target = current;
      let signal = null;

      if (hasWinners && hasLosers) {
        const avgW = avg(group.winners);
        const avgL = avg(group.losers);
        const diff = avgW - avgL;
        if (Math.abs(diff) >= 5) {
          target = clamp(Math.round(current + Math.sign(diff) * Math.min(Math.abs(diff) * 0.5, 10)), 35, 90);
          signal = `winners avg ${avgW.toFixed(0)} vs losers avg ${avgL.toFixed(0)} bins`;
        }
      } else if (hasWinners) {
        const avgW = avg(group.winners);
        const diff = avgW - current;
        if (Math.abs(diff) >= 5) {
          target = clamp(Math.round(current + Math.sign(diff) * Math.min(Math.abs(diff) * 0.5, 8)), 35, 90);
          signal = `winners avg ${avgW.toFixed(0)} bins (${group.winners.length} samples)`;
        }
      }

      if (signal && target !== current) {
        updatedMap[step] = target;
        mapChanged = true;
        rationale[`binsByStep_${step}`] = `bin_step ${step}: ${signal} — ${current} → ${target}`;
      }
    }

    if (mapChanged) changes.binsByStep = updatedMap;
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // Persist changes to user-config.json
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved   = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config immediately
  if (changes.binsByStep != null) {
    if (!config.strategy) config.strategy = {};
    config.strategy.binsByStep = changes.binsByStep;
  }

  // Log as a lesson
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Signal Attribution ────────────────────────────────────────

/**
 * Analyze which entry signals correlate with wins (pnl_pct > 0).
 * Only runs if at least 5 positions have signal data.
 * Returns a summary string for Telegram/logs, or null if insufficient data.
 */
export function computeSignalAttribution(perfData) {
  if (!perfData || perfData.length < 5) return null;

  const signals = [
    { key: "rsi_above_55",         label: "RSI > 55",             test: p => p.rsi != null ? p.rsi > 55      : null },
    { key: "in_primary_zone",      label: "Primary Fib zone",      test: p => p.in_primary_zone != null ? !!p.in_primary_zone : null },
    { key: "has_hidden_divergence",label: "Hidden divergence",     test: p => p.has_hidden_divergence != null ? !!p.has_hidden_divergence : null },
    { key: "smart_wallet_present", label: "Smart wallet",          test: p => p.smart_wallet_present != null ? !!p.smart_wallet_present : null },
    { key: "confluence_above_0_5", label: "Confluence ≥ 0.5",      test: p => p.confluence_score != null ? p.confluence_score >= 0.5 : null },
    { key: "fib_zone_primary",     label: "fib_zone=PRIMARY",      test: p => p.fib_zone != null ? p.fib_zone === "PRIMARY" : null },
  ];

  const lines = [];
  let hasData = false;

  for (const sig of signals) {
    const withSignal    = perfData.filter(p => sig.test(p) === true);
    const withoutSignal = perfData.filter(p => sig.test(p) === false);

    if (withSignal.length < 2 && withoutSignal.length < 2) continue;
    hasData = true;

    const wrWith    = withSignal.length    > 0 ? withSignal.filter(p => p.pnl_pct > 0).length / withSignal.length : null;
    const wrWithout = withoutSignal.length > 0 ? withoutSignal.filter(p => p.pnl_pct > 0).length / withoutSignal.length : null;

    const withStr    = wrWith    != null ? `${(wrWith    * 100).toFixed(0)}% (${withSignal.filter(p => p.pnl_pct > 0).length}/${withSignal.length})`    : "n/a";
    const withoutStr = wrWithout != null ? `${(wrWithout * 100).toFixed(0)}% (${withoutSignal.filter(p => p.pnl_pct > 0).length}/${withoutSignal.length})` : "n/a";

    const diff = (wrWith ?? 0) - (wrWithout ?? 0);
    const marker = Math.abs(diff) >= 0.20 ? (diff > 0 ? " ✅" : " ❌") : "";

    lines.push(`• ${sig.label}: YES=${withStr} / NO=${withoutStr}${marker}`);
  }

  if (!hasData) return null;

  return {
    summary: lines.join("\n"),
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// ─── Chart Self-Learning ───────────────────────────────────────

/**
 * Post-trade LLM analysis. Full lifecycle chart study: pre-deploy → hold → close.
 * Generates TWO lessons: one for SCREENER (entry pattern), one for MANAGER (hold/exit pattern).
 * Uses dynamic import to avoid circular dependency with agent.js.
 */
async function runChartLessonAnalysis(perf, outcome) {
  const n = v => (v != null ? v : '?');
  const pnlStr  = `${(perf.pnl_pct ?? 0) >= 0 ? '+' : ''}${(perf.pnl_pct ?? 0).toFixed(2)}%`;
  const isProfit = outcome === "good";
  const label    = isProfit ? "PROFIT" : "LOSS";

  // ── Build full-lifecycle chart context ─────────────────────────────────────
  let candleCtx = "";
  let fibCtx    = "";
  try {
    const { hybridDataProvider } = await import("./tools/dataProvider.js");
    const minutesHeld   = perf.minutes_held ?? 0;
    const candlesHeld   = Math.max(1, Math.round(minutesHeld / 15));
    const preDeployCtx  = 20;  // candles before deploy for momentum context
    const postCloseCtx  = 5;   // candles after close to confirm direction
    const totalNeeded   = preDeployCtx + candlesHeld + postCloseCtx;

    const raw = await hybridDataProvider.getOHLCV(perf.pool, "15m", Math.min(totalNeeded + 10, 150), "solana", perf.base_mint ?? null);
    if (raw && raw.length >= 10) {
      // Estimate deploy position in candle array
      const closeIdx  = raw.length - 1 - postCloseCtx;
      const deployIdx = Math.max(0, closeIdx - candlesHeld);
      const preStart  = Math.max(0, deployIdx - preDeployCtx);

      const slice      = raw.slice(preStart, raw.length);
      const localDeploy = deployIdx - preStart;
      const localClose  = closeIdx  - preStart;
      const basePrice  = slice[0]?.close ?? 1;

      // Fibonacci level annotations (if available)
      const fibs = perf.fib_levels_sol;
      const fibLabels = fibs ? (() => {
        const ref = basePrice;
        const pct = v => v != null ? ((v - ref) / ref * 100).toFixed(1) : null;
        return {
          fib236: pct(fibs.fib236),
          fib326: pct(fibs.fib326),
          fib382: pct(fibs.fib382),
          fib500: pct(fibs.fib500),
          fib618: pct(fibs.fib618),
          fib786: pct(fibs.fib786),
        };
      })() : null;

      if (fibLabels) {
        const parts = [
          fibLabels.fib236 != null ? `fib236=${fibLabels.fib236}%` : null,
          fibLabels.fib326 != null ? `fib326=${fibLabels.fib326}%` : null,
          fibLabels.fib382 != null ? `fib382=${fibLabels.fib382}%` : null,
          fibLabels.fib500 != null ? `fib500=${fibLabels.fib500}%` : null,
          fibLabels.fib618 != null ? `fib618=${fibLabels.fib618}%` : null,
          fibLabels.fib786 != null ? `fib786=${fibLabels.fib786}%` : null,
        ].filter(Boolean);
        fibCtx = `\nFibonacci levels (% dari candle pertama): ${parts.join(' | ')}`;
      }

      const pctArr = slice.map((c, i) => {
        const pct = ((c.close - basePrice) / basePrice * 100).toFixed(1);
        if (i === localDeploy) return `[DEPLOY:${pct}%]`;
        if (i === localClose)  return `[CLOSE:${pct}%]`;
        if (i > localDeploy && i < localClose) return `(${pct}%)`;   // during hold
        if (i > localClose) return `{${pct}%}`;                       // post-close
        return `${pct}%`;                                              // pre-deploy context
      });

      const deployPct = ((slice[localDeploy]?.close - basePrice) / basePrice * 100).toFixed(1);
      const closePct  = ((slice[localClose]?.close  - basePrice) / basePrice * 100).toFixed(1);
      const holdMoves = slice.slice(localDeploy, localClose + 1).map(c => ((c.close - basePrice) / basePrice * 100).toFixed(1));
      const holdMin   = Math.min(...holdMoves.map(Number)).toFixed(1);
      const holdMax   = Math.max(...holdMoves.map(Number)).toFixed(1);

      candleCtx =
        `\nChart full lifecycle (% dari candle pertama, 15m/candle):` +
        `\n  Format: sebelum deploy | [DEPLOY] (selama hold) [CLOSE] {setelah close}` +
        `\nChart: ${pctArr.join(" → ")}` +
        fibCtx +
        `\nSummary: deploy@${deployPct}% → hold range [${holdMin}%..${holdMax}%] → close@${closePct}% | held ${minutesHeld}min (${candlesHeld} candles)`;
    }
  } catch (e) {
    log("lessons", `OHLCV fetch for chart analysis failed: ${e.message}`);
  }

  const meta =
    `Pair: ${perf.pool_name ?? '?'} | PnL: ${pnlStr} | Hasil: ${label}\n` +
    `Zone: ${n(perf.fib_zone)}, RSI entry: ${n(perf.rsi?.toFixed(0))}, ATR: ${n(perf.atr_pct?.toFixed(1))}%, conf: ${n(perf.confluence_score?.toFixed(2))}\n` +
    `held: ${n(perf.minutes_held)}min | exit reason: ${perf.close_reason ?? '?'} | hidden_div: ${perf.has_hidden_divergence ? 'yes' : 'no'}`;

  // ── SCREENER lesson: pre-deploy entry pattern ──────────────────────────────
  const screenerPrompt =
    `Kamu adalah analis pola chart DLMM LP untuk ENTRY SCREENING.\n\n` +
    `${meta}${candleCtx}\n\n` +
    `Analisa pola harga SEBELUM deploy ([DEPLOY] marker) yang mengindikasikan apakah entry ini ${isProfit ? 'layak diambil' : 'seharusnya di-skip'}.\n` +
    `Fokus pada: kecepatan pump sebelum entry, kedalaman retracement, apakah Fib 0.500 dijaga atau ditembus, konsolidasi sebelum entry.\n` +
    `Balas MAKSIMAL 2 kalimat. Format: [SCREENING] <observasi>`;

  const screenerSys = `You are a crypto chart pattern analyst specializing in DLMM LP entry signals. Analyze the PRE-DEPLOY chart section and describe: (1) what the price action showed BEFORE entry, (2) whether fib500 held or was breached, (3) whether entry timing was good or bad. Max 2 sentences. Be specific about candle counts and percentage moves. No preamble.`;

  // ── MANAGER lesson: hold + exit pattern ───────────────────────────────────
  const managerPrompt =
    `Kamu adalah analis pola chart DLMM LP untuk POSITION MANAGEMENT.\n\n` +
    `${meta}${candleCtx}\n\n` +
    `Analisa pola harga SELAMA hold (antara [DEPLOY] dan [CLOSE]) untuk mengidentifikasi:\n` +
    `1. Apakah ada sinyal untuk close lebih awal atau lebih lama dari yang dilakukan?\n` +
    `2. Apakah Fib 0.500 ditembus terlalu cepat (red flag)? Jika ya, berapa candle setelah deploy?\n` +
    `3. Apakah ada pola volume dry-up atau reversal yang bisa jadi exit signal?\n` +
    `Balas MAKSIMAL 3 kalimat singkat. Format: [MANAGEMENT] <observasi>`;

  const managerSys = `You are a crypto position management analyst for DLMM LP. Analyze the HOLD period chart (between [DEPLOY] and [CLOSE]) and identify: early exit signals missed, whether fib500 was broken too quickly, volume patterns suggesting reversal. Max 3 sentences. Be specific (candle counts, % moves). No preamble.`;

  let { callLLMDirect } = await import("./agent.js");

  const [screenerResp, managerResp] = await Promise.all([
    callLLMDirect(screenerPrompt, { maxTokens: 280, systemPrompt: screenerSys }).catch(() => null),
    callLLMDirect(managerPrompt,  { maxTokens: 350, systemPrompt: managerSys  }).catch(() => null),
  ]);

  const data = load();
  const now  = new Date().toISOString();
  const base = { outcome: isProfit ? "good" : "bad", source: "chart_analysis", pnl_pct: perf.pnl_pct ?? null, pool: perf.pool ?? null, pool_name: perf.pool_name ?? null };

  if (screenerResp && screenerResp.length >= 15) {
    const rule = `CHART [${label}][SCREENING]: ${screenerResp.slice(0, 320)}`;
    data.lessons.push({ id: Date.now(), rule, tags: ["chart_lesson", isProfit ? "positive_pattern" : "negative_pattern", "screening", "entry"], ...base, created_at: now });
    log("lessons", `Screening chart lesson saved [${label}]: ${rule.slice(0, 120)}`);
  }

  if (managerResp && managerResp.length >= 15) {
    const rule = `CHART [${label}][MANAGEMENT]: ${managerResp.slice(0, 400)}`;
    data.lessons.push({ id: Date.now() + 1, rule, tags: ["chart_lesson", isProfit ? "positive_pattern" : "negative_pattern", "management", "hold", "close"], ...base, created_at: now });
    log("lessons", `Management chart lesson saved [${label}]: ${rule.slice(0, 120)}`);
  }

  save(data);

  if (screenerResp || managerResp) {
    const emoji = isProfit ? "🔍✅" : "🔍❌";
    const msg = [
      `${emoji} Chart Lesson [${perf.pool_name ?? '?'} ${pnlStr}]`,
      screenerResp ? `📊 Entry: ${screenerResp.slice(0, 200)}` : null,
      managerResp  ? `⚙️ Hold: ${managerResp.slice(0, 250)}`   : null,
    ].filter(Boolean).join('\n');
    sendMessage(msg).catch(() => {});
  }
}

// ─── Manual Lessons ────────────────────────────────────────────

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  });
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
}

export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find(l => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find(l => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];
  if (pinned !== null) lessons = lessons.filter(l => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter(l => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter(l => l.tags?.includes(tag));
  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map(l => ({
      id:         l.id,
      rule:       l.rule.slice(0, 120),
      tags:       l.tags,
      outcome:    l.outcome,
      pinned:     !!l.pinned,
      role:       l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter(l => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter(l => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

const ROLE_TAGS = {
  SCREENER: ["screening", "strategy", "deployment", "fib_entry", "entry", "volume", "chart_lesson"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "stop_loss", "chart_lesson"],
  GENERAL:  [],
};

export function getLessonsForPrompt(opts = {}) {
  if (typeof opts === "number") opts = { maxLessons: opts };
  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const isManager   = agentType === "MANAGER";
  const PINNED_CAP  = isManager ? 3  : (isAutoCycle ? 5  : 10);
  const ROLE_CAP    = isManager ? 6  : (isAutoCycle ? 6  : 15);  // manager gets 6 to include chart_lessons
  const RECENT_CAP  = maxLessons ?? (isManager ? 3 : (isAutoCycle ? 10 : 35));  // manager gets 3 recent

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  const pinned = data.lessons
    .filter(l => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map(l => l.id));

  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter(l => {
      if (usedIds.has(l.id)) return false;
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some(t => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach(l => usedIds.add(l.id));

  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter(l => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map(l => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const filtered = p
    .filter(r => r.recorded_at >= cutoff)
    .slice(-limit)
    .map(r => ({
      pool_name:       r.pool_name,
      pool:            r.pool,
      strategy:        r.strategy,
      pnl_usd:         r.pnl_usd,
      pnl_pct:         r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held:    r.minutes_held,
      close_reason:    r.close_reason,
      fib_entry_pct:   r.fib_entry_pct ?? null,
      closed_at:       r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter(r => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter(x => x.pnl_usd > 0).length;

  return {
    total_positions_closed:   p.length,
    total_pnl_usd:            Math.round(totalPnl * 100) / 100,
    avg_pnl_pct:              Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct:             Math.round((wins / p.length) * 100),
    total_lessons:            data.lessons.length,
  };
}

/**
 * Return unique closed pools from the last N hours, with bin_step + fee_pct,
 * for use in periodic backtesting.
 */
export function getClosedPoolsForBacktest({ hours = 168, limit = 8 } = {}) {
  const data = load();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const seen = new Set();
  const result = [];

  for (const r of [...data.performance].reverse()) {
    if (!r.pool || !r.bin_step || !r.fee_pct) continue;
    if (r.recorded_at < cutoff) continue;
    if (seen.has(r.pool)) continue;
    seen.add(r.pool);
    result.push({
      pool:       r.pool,
      pool_name:  r.pool_name  ?? r.pool.slice(0, 8),
      bin_step:   r.bin_step,
      fee_pct:    r.fee_pct,
      actual_pnl: r.pnl_pct,
      close_reason: r.close_reason ?? null,
    });
    if (result.length >= limit) break;
  }

  return result;
}
