/**
 * index.js -- MINIMAL VERSION for emergency startup
 * 
 * Stripped to essentials only:
 * - Manual .env parsing (no dotenv)
 * - Cron: screening + management cycles
 * - Telegram polling (non-TTY mode)
 * - Graceful shutdown
 * 
 * NOT included (can be added back later):
 * - REPL interface
 * - Sweep proposal helpers
 * - Morning briefing cron
 * - PnL poll interval
 * - /apply_sweep, /reject_sweep commands
 * - Health server
 */

import "./init.js"; // Load .env FIRST — before any other module

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import cron from "node-cron";

// ── Imports ────────────────────────────────────────────────────────────────────
import { acquireScreeningLock, completeScreeningLock, acquireManagementLock, completeManagementLock, resetScreeningLockForRescreen } from "./tools/lock-manager.js";
import { agentLoop, probeLLMProviders } from "./agent.js";
import http from "http";
import { log } from "./logger.js";
import { logWithId, logSkip, shortId, logCycleStart } from "./log-utils.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { getCircuitState, shouldSkipNextCycle, getActiveProvider } from "./tools/circuit-breaker.js";
import { evolveThresholds, getPerformanceSummary, getClosedPoolsForBacktest } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled, notifyClose, sendWithButtons, registerCallback, unregisterCallback } from "./telegram.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, updateFibTouchState, getStateSummary } from "./state.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { runBacktest } from "./backtest.js";
import { runDailyBacktest } from "./tools/daily-backtester.js";
import { config, getPositionSizing, calculateCurrentExposure, calculateCurrentExposureSol, canOpenNewPosition, checkExposureCap } from "./config.js";
import { hybridDataProvider } from "./tools/dataProvider.js";

// ── Startup validation ─────────────────────────────────────────────────────────
const lpKey     = process.env.LPAGENT_API_KEY;
const lpKeyBackup = process.env.LPAGENT_API_KEY_BACKUP;
if (!lpKey) {
  console.error("FATAL: LPAGENT_API_KEY not set in .env — cannot start");
  process.exit(1);
}
log("startup", `LPAgent: primary=${lpKey ? "YES (len=" + lpKey.length + ")" : "MISSING"} backup=${lpKeyBackup ? "YES (len=" + lpKeyBackup.length + ")" : "MISSING"}`);

// LLM provider probe — called async below in startAgent()

// Also warn if Telegram not configured (non-fatal)
const _tel = telegramEnabled();
log("startup", `Telegram: bot=${_tel ? "ACTIVE" : "DISABLED"} chatId=${process.env.TELEGRAM_CHAT_ID || "MISSING"}`);
if (_tel) {
  sendMessage("✅ Prospera Agent started — LIVE mode").catch(() => {});
}

// ── State ─────────────────────────────────────────────────────────────────────
const _startTime = Date.now();
let _lastCorrelationId = null;

const SCREENING_INTERVAL_MS = (config.schedule?.screeningIntervalMin || 15) * 60_000;
const MANAGEMENT_INTERVAL_MS = (config.schedule?.managementIntervalMin || 3) * 60_000;

let _cronTasks = [];
let _managementBusy = false;
let _managementLastCompleted = 0;
let _screeningBusy = false;
let _screeningBusySince = 0;  // timestamp when _screeningBusy was last set to true
let _screeningLastTriggered = 0;
let _exposureHardPausedUntil = 0;

const timers = { managementLastRun: 0, screeningLastRun: 0 };
const POSITION_META_PATH = path.join(__dirname, "position-meta.json");

// PnL trend tracking: positionAddress → [pnl1, pnl2, pnl3] (last 3 values)
const _pnlHistory = new Map();
// Positions with pending trend alert (suppress re-alert for 30 min)
const _trendAlertedUntil = new Map();


// ── Health Server ──────────────────────────────────────────────────────────────
let _healthServer = null;

function startHealthServer(port = 3000) {
  if (_healthServer) return;
  _healthServer = http.createServer(async (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: Math.round(process.uptime()) }));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  _healthServer.listen(port, () => log("health", `Health server listening on port ${port}`));
  _healthServer.on("error", e => log("health", `Health server error: ${e.message}`));
}

function stopHealthServer() {
  if (_healthServer) { _healthServer.close(); _healthServer = null; }
}

// ── REPL Mode — disabled in PM2 (always non-TTY), kept for potential future use ──
// REPL consumed ~50KB of readline machinery for zero practical use in PM2 mode.
// To re-enable: uncomment the block below and remove the stub.
// function startREPL() { ... }
// STUB: no REPL in PM2 — delete this stub if re-enabling.
function startREPL() {
  log("startup", "REPL disabled — PM2 always runs non-TTY. Run manually with: node --input-type=module");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopCronJobs() {
  for (const task of _cronTasks) task?.stop?.();
  _cronTasks = [];
}

// ── Morning Briefing ─────────────────────────────────────────────────────────
async function runMorningBriefing({ force = false } = {}) {
  log("briefing", "Morning Briefing triggered");
  const today = new Date().toISOString().slice(0, 10);
  if (!force && getLastBriefingDate() === today) return; // already briefed today

  const corrId = shortId();
  const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

  const [positions, balance, perf] = await Promise.all([
    getMyPositions({ force: true }).catch(() => null),
    getWalletBalances().catch(() => null),
  ]).then(([p, b]) => Promise.all([p, b, getPerformanceSummary()]));

  const posList = positions?.positions ?? [];
  const totalPositions = positions?.total_positions ?? 0;
  const walletSol = balance?.sol ?? 0;
  const deployAmt = getPositionSizing(walletSol);
  // Bug fix: calculateCurrentExposureSol returns SOL (not USD like before)
  const deployedSol = posList.length > 0 ? calculateCurrentExposureSol(posList, balance?.sol_price ?? 0) : 0;
  const capPct = config.risk.totalExposureCapPct ?? 0.60;
  const exposurePct = walletSol > 0 ? +((deployedSol / walletSol) * 100).toFixed(1) : 0;

  // Circuit state
  const cb = getCircuitState();

  // Backtest results from today
  let backtestSummary = null;
  try {
    const backtestDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backtest");
    for (const label of ["7d", "14d"]) {
      const file = path.join(backtestDir, `${today}_${label}.json`);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const winRate = data.results?.length > 0
          ? ((data.results.filter(r => (r.pnl_pct ?? 0) > 0).length / data.results.length) * 100).toFixed(0)
          : "N/A";
        backtestSummary = `${label}: ${data.results?.length ?? 0} pools | WR: ${winRate}%`;
        break;
      }
    }
  } catch { /**/ }

  // Performance from lessons
  const perfLines = perf
    ? `WR: ${perf.win_rate ?? "?"}% | Avg: ${perf.avg_pnl_pct != null ? (perf.avg_pnl_pct >= 0 ? "+" : "") + perf.avg_pnl_pct.toFixed(1) + "%" : "?"} | Closed: ${perf.total ?? 0}`
    : null;

  // Build lines
  const lines = [
    `💰 Wallet: ${walletSol.toFixed(3)} SOL | Deploy: ${deployAmt} SOL/pos`,
    `📉 Exposure: ${exposurePct}% / ${(capPct * 100).toFixed(0)}% cap | ${totalPositions}/${config.risk.maxPositions} positions`,
  ];

  if (cb?.isCircuitBroken) {
    lines.push(`🔧 Circuit: OPEN (${cb.cooldownRemainingSec}s left)`);
  }

  if (posList.length > 0) {
    const totalPnl = posList.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
    lines.push(`📊 Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`);
    const posLines = posList.map(p => {
      const pnl = p.pnl_pct ?? 0;
      const sign = pnl >= 0 ? "+" : "";
      const fees = (p.unclaimed_fees_usd ?? 0) > 0 ? ` | $${p.unclaimed_fees_usd.toFixed(2)} fees` : "";
      const oor = !p.in_range ? " ⚠️OOR" : "";
      return `${p.pair} ${sign}${pnl.toFixed(1)}%${fees}${oor}`;
    });
    lines.push(`📋 ${posLines.join(" | ")}`);
  } else {
    lines.push("📋 No open positions");
  }

  if (perfLines) lines.push(`📈 Performance: ${perfLines}`);
  if (backtestSummary) lines.push(`📈 Backtest: ${backtestSummary}`);

  lines.push(`⚙️ ${config.screening.minBinStep}–${config.screening.maxBinStep} bin | Vol min $${config.screening.minVolume.toLocaleString()} | SL ${config.management.stopLossPct}% / TP ${config.management.takeProfitMaxPct}%`);

  const msg = `🌅 Morning Briefing [${ts}]\n\n${lines.join("\n")}`;
  if (telegramEnabled()) sendMessage(msg).catch(() => {});

  setLastBriefingDate();
  log("briefing", `Morning briefing sent — positions: ${totalPositions}, exposure: ${exposurePct}%`);
}

// ── PnL Poll ──────────────────────────────────────────────────────────────────
async function runPnLPoll() {
  const corrId = shortId();
  const positions = await getMyPositions({ force: true }).catch(() => null);
  const posList = positions?.positions ?? [];

  // Guard: no positions → skip
  if (posList.length === 0) {
    log("pnl_poll", "No open positions — skipping poll");
    return;
  }

  const balance = await getWalletBalances().catch(() => null);
  const deployedSol = calculateCurrentExposureSol(posList, balance?.sol_price ?? 0);
  const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;
  const totalPnl = posList.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
  const totalValue = posList.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);

  const lines = [
    `📊 Positions: ${positions?.total_positions ?? 0}/${config.risk.maxPositions}`,
    `💰 Exposure: ${exposurePct}% | SOL: ${balance?.sol?.toFixed(3) ?? "?"}`,
    `📉 Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`,
  ];
  if (posList.length > 0) lines.push(`💵 TVL: $${totalValue.toFixed(0)}`);

  const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  if (telegramEnabled()) sendMessage(`📈 PnL Poll [${ts}] ID: ${corrId}\n\n${lines.join("\n")}`).catch(() => {});
  log("pnl_poll", `PnL poll — positions: ${positions?.total_positions ?? 0}, exposure: ${exposurePct}%, pnl: ${totalPnl.toFixed(2)}%`);

}

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── Retrace Snapshot ───────────────────────────────────────────────────────────
// Compute deterministic retrace character from OHLCV — no LLM, pure math.
// Used to inject chart context into management goal so LLM can apply chart lessons.
function computeRetraceSnapshot(candles, fibs) {
  if (!candles || candles.length < 3) return null;

  const recent = candles.slice(-10);
  const vols = recent.map(c => c.volume ?? 0).sort((a, b) => a - b);
  const median = vols[Math.floor(vols.length / 2)] || 1;

  // Red/green per candle
  const isRed = c => c.close < c.open;

  // Dump velocity: avg % drop per red candle
  const redCandles = recent.filter(isRed);
  const dumpVelocity = redCandles.length > 0
    ? redCandles.reduce((s, c) => s + Math.abs((c.close - c.open) / c.open * 100), 0) / redCandles.length
    : 0;

  // Avg volume on red candles vs median
  const volOnRed = redCandles.length > 0
    ? (redCandles.reduce((s, c) => s + (c.volume ?? 0), 0) / redCandles.length) / median
    : 0;

  // Consecutive red from latest candle
  let consecutiveRed = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (isRed(recent[i])) consecutiveRed++;
    else break;
  }

  // Price change % over all recent candles
  const priceChangePct = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close * 100);

  // Range narrowing (last 3 candles): high-low getting smaller = stabilizing
  const ranges = recent.slice(-3).map(c => c.open > 0 ? (c.high - c.low) / c.open * 100 : 0);
  const rangeNarrowing = ranges.length === 3 && ranges[2] < ranges[0] * 0.6;

  // Candles since fib500 was last above (= when did breach start)
  let candlesSinceFib500Breach = null;
  if (fibs?.fib500 != null) {
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].close >= fibs.fib500) {
        candlesSinceFib500Breach = recent.length - 1 - i;
        break;
      }
    }
    // All candles already below fib500
    if (candlesSinceFib500Breach === null) candlesSinceFib500Breach = recent.length;
  }

  // Classify retrace character
  let retraceType;
  const latestClose = recent[recent.length - 1].close;
  if (fibs?.fib786 != null && latestClose < fibs.fib786) {
    retraceType = 'BREAKDOWN_786'; // below fib786 — real breakdown, no support below
  } else if (fibs?.fib618 != null && latestClose < fibs.fib618) {
    retraceType = 'DIP_618';       // below fib618 but above fib786 — possible support/bounce zone
  } else if (dumpVelocity > 5 || (volOnRed > 2.0 && consecutiveRed >= 3)) {
    retraceType = 'AGGRESSIVE';    // fast dump or heavy volume sell (still above fib618)
  } else if (rangeNarrowing && consecutiveRed < 2) {
    retraceType = 'STABILIZING';   // candles shrinking, selling slowing — bounce potential
  } else {
    retraceType = 'HEALTHY';       // slow drift, expected retrace
  }

  return { retraceType, dumpVelocity, volOnRed, consecutiveRed, priceChangePct, candlesSinceFib500Breach, rangeNarrowing };
}

// ── Management Cycle ───────────────────────────────────────────────────────────
export async function runManagementCycle({ silent = false } = {}) {
  if (shouldSkipNextCycle()) {
    log("management", "Circuit breaker skip — cycle skipped (auto-clears when cooldown expires)");
    return null;
  }

  const corrId = logCycleStart("management");
  _lastCorrelationId = corrId;
  const _m = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  // _managementBusy guard: block concurrent cron invocations before anything else.
  // Also blocks if a previous cycle died without clearing the flag (failsafe).
  if (_managementBusy) { _m("management", "Cycle busy — skipped"); return null; }
  const _screeningStuck = _screeningBusy && (Date.now() - _screeningBusySince) > 5 * 60_000;
  if (_screeningStuck) {
    _m("management", "Screening stuck >5m — force-clearing busy flag");
    _screeningBusy = false;
  }
  if (_screeningBusy) { _m("management", "Screening running — skipped"); return null; }

  // ── Fast path: cek posisi dulu sebelum acquire lock / busy flag ─────────────
  // Jika 0 posisi → skip secepat mungkin, tidak perlu lock, tidak perlu LPAgent call
  // Pisahkan error handling per call — getMyPositions error = skip cycle,
  // getWalletBalances error = lanjut dengan preBalance=null (exposure tampil "?")
  let prePositions = null;
  let preBalance = null;
  try {
    prePositions = await getMyPositions({ force: true });
  } catch (e) {
    _m("warn", `getMyPositions failed — ${e.message} — skipping cycle`, { correlationId: corrId });
    logSkip("lpagent_error", { error: e.message }, corrId, "management");
    if (!silent && telegramEnabled()) sendMessage(`Management [${corrId}] — LPAgent error: ${e.message}, skipping`).catch(() => {});
    return null;
  }
  try {
    preBalance = await getWalletBalances();
  } catch (e) {
    _m("warn", `getWalletBalances failed — ${e.message} — continuing with preBalance=null`);
    // Non-fatal: cycle can still run, exposure will show "?" in report
  }

  if (!prePositions || prePositions.error) {
    _m("warn", `LPAgent unavailable — ${prePositions?.error ?? "network error"} — skipping cycle`);
    logSkip("lpagent_unavailable", { error: prePositions?.error ?? "network_error" }, corrId, "management");
    if (!silent && telegramEnabled()) sendMessage(`Management [${corrId}] — LPAgent unavailable, skipping`).catch(() => {});
    return null;
  }

  const preCount = prePositions?.positions?.length ?? 0;
  if (preCount === 0) {
    _m("management", "No open positions — skipping management cycle");
    logSkip("no_open_positions", {}, corrId, "management");
    return null;
  }

  // ── Has positions → acquire lock and run full management ───────────────────
  const lockResult = acquireManagementLock();
  if (!lockResult.acquired) { _m("management", "Lock not acquired"); return null; }
  let lockAcquired = true;

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  _m("management", `Management cycle started — checking ${preCount} open position(s)`);

  let mgmtReport = null;
  let llmZone = [];
  let positions = prePositions.positions ?? [];

  try {
    if (positions.length === 0) {
      if (Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
        _m("management", "No positions — triggering screening");
        runScreeningCycle().catch(e => _m("error", `Screening failed: ${e.message}`));
      }
      mgmtReport = "No open positions — cycle skipped";
      return null;
    }

    const positionData = positions.map(p => ({ ...p, recall: recallForPool(p.pool) }));

    // Fetch live prices for Successful Rebound fib tracking (only for positions with stored fib levels)
    const positionsWithFibLevels = positionData.filter(p => getTrackedPosition(p.position)?.fib_levels_sol != null);
    const livePriceMap = new Map();
    const candleHighMap = new Map(); // max candle HIGH over last 12×5m — catches rebounds between cycles
    if (positionsWithFibLevels.length > 0) {
      const livePriceResults = await Promise.allSettled(
        positionsWithFibLevels.map(p => getActiveBin({ pool_address: p.pool }))
      );
      for (let i = 0; i < positionsWithFibLevels.length; i++) {
        const r = livePriceResults[i];
        if (r.status === 'fulfilled' && r.value?.price != null) {
          livePriceMap.set(positionsWithFibLevels[i].position, r.value.price);
        }
      }
      // For touched positions, also fetch 5m candle HIGHs to catch rebounds that happened between cycles
      const touchedPositions = positionsWithFibLevels.filter(p => getTrackedPosition(p.position)?.touched_lower_fib);
      if (touchedPositions.length > 0) {
        const candleResults = await Promise.allSettled(
          touchedPositions.map(p => {
            const tracked = getTrackedPosition(p.position);
            return hybridDataProvider.getOHLCV(p.pool, "5m", 12, "solana", tracked?.base_mint ?? null);
          })
        );
        for (let i = 0; i < touchedPositions.length; i++) {
          const r = candleResults[i];
          if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
            const maxHigh = Math.max(...r.value.map(c => c.high ?? 0));
            if (maxHigh > 0) candleHighMap.set(touchedPositions[i].position, maxHigh);
          }
        }
      }
    }

    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) { exitMap.set(p.position, exit.reason); continue; }

      // Successful Rebound: position touched Fib ≤0.500, then price recovered to ≥0.236 → close + ATH cooldown
      // effectiveHigh = max(livePrice, candle HIGH over last hour) — catches rebounds between cycles
      const livePrice  = livePriceMap.get(p.position) ?? null;
      const candleHigh = candleHighMap.get(p.position) ?? null;
      const effectiveHigh = (livePrice != null || candleHigh != null) ? Math.max(livePrice ?? 0, candleHigh ?? 0) : null;
      const fibState = updateFibTouchState(p.position, livePrice);
      if (fibState.touched && effectiveHigh != null && fibState.fib236 != null && effectiveHigh >= fibState.fib236) {
        const reboundViaCandleOnly = candleHigh != null && candleHigh >= fibState.fib236 && (livePrice == null || livePrice < fibState.fib236);
        // Guard: jika candle high yang jadi penentu tapi live price masih < fib500,
        // candle high itu dari fase pump sebelum dip (bukan rebound sesungguhnya) → skip
        if (reboundViaCandleOnly && livePrice != null && fibState.fib500 != null && livePrice < fibState.fib500) {
          _m("management", `Rebound suppressed: ${p.pair} — candle high ${candleHigh.toPrecision(4)} >= fib236 but live price ${livePrice.toPrecision(4)} < fib500 ${fibState.fib500.toPrecision(4)} (pre-dip candle, not a true rebound)`);
        } else {
          const src = reboundViaCandleOnly ? "candle high" : "live";
          _m("management", `Successful rebound: ${p.pair} — touched Fib ≤0.500 then recovered ≥0.236 (${src}=${effectiveHigh.toPrecision(4)} >= fib236=${fibState.fib236.toPrecision(4)}) → closing + ATH cooldown`);
          exitMap.set(p.position, `Successful rebound: touched ≤0.500 then recovered to 0.236`);
        }
      }
      // Rebound from .618 + profit ≥10%: touched Fib .618, recovered to ≥.500 → early exit
      if (!exitMap.has(p.position) && fibState.touched618 && effectiveHigh != null && fibState.fib500 != null && effectiveHigh >= fibState.fib500 && p.pnl_pct != null && p.pnl_pct >= 10) {
        const src = (candleHigh != null && candleHigh >= fibState.fib500 && (livePrice == null || livePrice < fibState.fib500)) ? "candle high" : "live";
        _m("management", `618 rebound+profit: ${p.pair} — touched ≤.618 then recovered ≥.500 (${src}=${effectiveHigh.toPrecision(4)} >= fib500=${fibState.fib500.toPrecision(4)}) pnl=${p.pnl_pct.toFixed(1)}% ≥10% → closing`);
        exitMap.set(p.position, `Rebound .618→.500 with profit ${p.pnl_pct.toFixed(1)}%`);
      }
    }

    // ── ATH OOR Recovery: jika new ATH ≥120% dari ATH lama (pernah terjadi) → close + rescreen ──
    // peakPrice di-track tiap cycle agar kondisi 20% dievaluasi sepanjang lifetime posisi,
    // bukan hanya saat management cek (harga bisa sudah retrace saat cek dilakukan)
    const ATH_NEW_THRESHOLD = 1.20;
    let positionMeta = {};
    let positionMetaDirty = false;
    try { if (fs.existsSync(POSITION_META_PATH)) positionMeta = JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8")); } catch { /**/ }
    const athCandidates = positionData.filter(p => !exitMap.has(p.position) && positionMeta[p.position]);
    if (athCandidates.length > 0 && Object.keys(positionMeta).length > 0) {
      const activeBinResults = await Promise.allSettled(
        athCandidates.map(p => getActiveBin({ pool_address: p.pool }))
      );
      for (let i = 0; i < athCandidates.length; i++) {
        const p = athCandidates[i];
        const meta = positionMeta[p.position];
        if (!meta?.athBin || !meta?.ath) continue;
        const res = activeBinResults[i];
        if (res.status !== "fulfilled" || res.value?.binId == null) continue;
        const currentActiveBin = res.value.binId;
        const currentPrice = res.value.price ?? null;
        // Update peakPrice (running max sejak deploy)
        if (currentPrice != null) {
          const prevPeak = meta.peakPrice ?? meta.ath;
          if (currentPrice > prevPeak) {
            meta.peakPrice = currentPrice;
            positionMetaDirty = true;
          }
        }
        const peakPrice = meta.peakPrice ?? meta.ath;
        // Kondisi: activeBin > athBin (harga pernah/sedang di atas ATH lama)
        // DAN peakPrice pernah mencapai ≥120% dari ath lama (meski sekarang sudah retrace)
        if (currentActiveBin > meta.athBin) {
          if (peakPrice < meta.ath * ATH_NEW_THRESHOLD) {
            _m("management", `ATH OOR skip ${p.pair}: activeBin ${currentActiveBin} > athBin ${meta.athBin} but peakPrice ${peakPrice.toPrecision(4)} < ath*1.20 (${(meta.ath * ATH_NEW_THRESHOLD).toPrecision(4)}) — waiting for stronger ATH`);
            continue;
          }
          _m("management", `ATH OOR recovery: ${p.pair} — new ATH confirmed (peakPrice=${peakPrice.toPrecision(4)} >= ath*1.20=${(meta.ath * ATH_NEW_THRESHOLD).toPrecision(4)}, activeBin=${currentActiveBin} > athBin=${meta.athBin}) → close + rescreen`);
          exitMap.set(p.position, `New ATH +${(((peakPrice / meta.ath) - 1) * 100).toFixed(0)}% from entry ATH (peakPrice=${peakPrice.toPrecision(4)}) — reposition`);
        }
      }
      if (positionMetaDirty) {
        try { fs.writeFileSync(POSITION_META_PATH, JSON.stringify(positionMeta, null, 2)); } catch { /**/ }
      }
    }

    // ── LLM zone & report vars — declared outside try, reassign here ──
    mgmtReport = "";

    const actionMap = new Map();
    for (const p of positionData) {
      if (exitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", reason: exitMap.get(p.position) }); continue; }
      if (p.instruction) { actionMap.set(p.position, { action: "INSTRUCTION" }); continue; }
      if (p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) { actionMap.set(p.position, { action: "CLOSE", reason: "stop loss" }); continue; }
      if (p.pnl_pct != null && config.management.takeProfitMaxPct != null && p.pnl_pct >= config.management.takeProfitMaxPct) { actionMap.set(p.position, { action: "CLOSE", reason: `Hard TP: PnL ${p.pnl_pct.toFixed(1)}% ≥ ${config.management.takeProfitMaxPct}%` }); continue; }
      // Exposure cap temporarily disabled for Phase 3 Stability Test
      // ── Auto-claim fees: ≥2% of position value AND live price ≥ fib 0.382 ───
      {
        const feesUsd  = p.unclaimed_fees_usd ?? 0;
        const totalUsd = p.total_value_usd ?? 0;
        const feePct   = totalUsd > 0 ? (feesUsd / totalUsd) * 100 : 0;
        if (feePct >= 2.0) {
          const _fibLvl   = getTrackedPosition(p.position)?.fib_levels_sol;
          const _liveP    = livePriceMap.get(p.position) ?? null;
          let aboveFib382 = false;
          if (_fibLvl?.fib236 != null && _fibLvl?.fib500 != null && _liveP != null) {
            const fib382 = _fibLvl.fib500 + (_fibLvl.fib236 - _fibLvl.fib500) * (0.118 / 0.264);
            aboveFib382 = _liveP >= fib382;
          }
          if (aboveFib382) {
            _m("management", `Auto-claim: ${p.pair} fees ${feePct.toFixed(1)}% ≥2% AND price above fib0.382 → claim+swap to SOL`);
            actionMap.set(p.position, { action: "CLAIM" });
            continue;
          }
        }
      }
      // ── 2h Low Yield Auto-Close ─────────────────────────────────────────────
      // If position open > 2h AND unclaimed fee < 1% of position value (SOL basis) → auto close
      const solPrice = preBalance?.sol_price ?? 0;
      const LOW_YIELD_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours
      const MIN_FEE_PCT = 1.0; // 1%
      const ageMs = p.age_minutes != null ? p.age_minutes * 60 * 1000 : null;
      if (ageMs != null && ageMs >= LOW_YIELD_HOURS_MS) {
        const feesSol = p.unclaimed_fees_sol ?? (p.unclaimed_fees_usd != null && solPrice > 0 ? p.unclaimed_fees_usd / solPrice : null);
        const totalSol = p.total_value_sol ?? (p.total_value_usd != null && solPrice > 0 ? p.total_value_usd / solPrice : null);
        const feePct2 = (feesSol != null && totalSol != null && totalSol > 0) ? (feesSol / totalSol) * 100 : null;
        if (feePct2 !== null && feePct2 < MIN_FEE_PCT) {
          const reasonStr = `2h low yield (<${feePct2.toFixed(2)}% fee collected)`;
          _m("management", `2h low yield: ${p.pair} ${p.age_minutes}m old, fee ${feePct2.toFixed(2)}% < ${MIN_FEE_PCT}% → auto close`);
          actionMap.set(p.position, { action: "CLOSE", reason: reasonStr });
          continue;
        }
      }

      // ── #1: Loss ≥3× fees close (IL overwhelming fees) ────────────────────────
      if (ageMs != null && ageMs >= LOW_YIELD_HOURS_MS) {
        const feesUsd2  = p.unclaimed_fees_usd ?? 0;
        const pnlUsd2   = p.pnl_usd ?? (p.pnl_pct != null && p.total_value_usd != null ? p.total_value_usd * (p.pnl_pct / 100) : null);
        const lossUsd2  = pnlUsd2 != null ? -pnlUsd2 : null;
        if (feesUsd2 > 0 && lossUsd2 != null && lossUsd2 >= feesUsd2 * 3) {
          const reasonStr = `loss $${lossUsd2.toFixed(2)} ≥ 3× fees $${feesUsd2.toFixed(2)}`;
          _m("management", `Loss≥3×fees close: ${p.pair} loss=$${lossUsd2.toFixed(2)} fees=$${feesUsd2.toFixed(2)} → close`);
          actionMap.set(p.position, { action: "CLOSE", reason: reasonStr });
          continue;
        }
      }

      // ── #2: PnL trend alert — 3 declining cycles & PnL < -8% → Telegram yes/no ─
      {
        const pnlNow = p.pnl_pct;
        if (pnlNow != null) {
          const hist = _pnlHistory.get(p.position) ?? [];
          hist.push(pnlNow);
          if (hist.length > 4) hist.shift();
          _pnlHistory.set(p.position, hist);

          const suppressedUntil = _trendAlertedUntil.get(p.position) ?? 0;
          const declining3 = hist.length >= 3
            && hist[hist.length - 1] < hist[hist.length - 2]
            && hist[hist.length - 2] < hist[hist.length - 3]
            && pnlNow < -8.0;

          if (declining3 && Date.now() > suppressedUntil && telegramEnabled()) {
            _trendAlertedUntil.set(p.position, Date.now() + 30 * 60_000);
            const cbYes = `trend_close_yes_${p.position}`;
            const cbNo  = `trend_close_no_${p.position}`;
            registerCallback(cbYes, async () => {
              _m("management", `Trend alert: user confirmed close ${p.pair}`);
              const r = await closePosition({ position_address: p.position, reason: `user confirmed trend close (PnL ${pnlNow.toFixed(2)}%)` }).catch(e => ({ success: false, error: e.message }));
              if (r.success) notifyClose({ pair: p.pair, pnlUsd: r.pnl_usd ?? 0, pnlPct: r.pnl_pct ?? 0, reason: "trend close confirmed" }).catch(() => {});
              else sendMessage(`Close failed: ${r.error}`).catch(() => {});
            });
            registerCallback(cbNo, async () => {
              _m("management", `Trend alert: user skipped close ${p.pair}`);
              sendMessage(`OK, keeping ${p.pair} open. Next alert in 30 min if trend continues.`).catch(() => {});
            });
            sendWithButtons(
              `⚠️ PnL Trend Alert: ${p.pair}\nPnL: ${hist.slice(-3).map(v => v.toFixed(1) + "%").join(" → ")} (3 declining cycles)\nClose position?`,
              [[{ text: "✅ Yes, close", callback_data: cbYes }, { text: "❌ No, keep", callback_data: cbNo }]]
            ).catch(() => {});
            _m("management", `Trend alert sent for ${p.pair}: PnL ${hist.slice(-3).map(v => v.toFixed(1) + "%").join(" → ")}`);
          }
        }
      }

      // Build STAY reason: which checks passed
      const pnl = p.pnl_pct ?? 0;
      const inRange = p.in_range ? "in range" : `OOR ${p.minutes_out_of_range ?? 0}m`;
      const slDist = p.pnl_pct != null ? `SL:${(config.management.stopLossPct - pnl).toFixed(1)}%` : "SL:?";
      actionMap.set(p.position, { action: "STAY", reason: `${inRange}, ${slDist}` });
    }

    // Per-position check logging — STAY shows why no exit triggered
    for (const p of positionData) {
      const act = actionMap.get(p.position);
      if (act.action === "STAY") {
        _m("management", `Checking ${p.pair} — STAY: ${act.reason}, Fib gate OK`);
      }
    }

    // ── Deterministic actions: execute immediately without LLM ──────────────────
    const deterministic = positionData.filter(p => {
      const act = actionMap.get(p.position);
      return act.action === "CLOSE" || act.action === "CLAIM";
    });
    for (const p of deterministic) {
      const act = actionMap.get(p.position);
      _m("management", `EXEC deterministic ${act.action} ${p.pair} (${act.reason})`);
      if (act.action === "CLOSE") {
        const r = await closePosition({ position_address: p.position, reason: act.reason }).catch(e => ({ success: false, error: e.message }));
        if (r.success) {
          _m("management", `  → closed ${p.pair}`);
          notifyClose({ pair: p.pair, pnlUsd: r.pnl_usd ?? 0, pnlPct: r.pnl_pct ?? 0, reason: act.reason }).catch(() => {});
        } else _m("error", `  → close failed: ${r.error}`);
      } else if (act.action === "CLAIM") {
        const { executeTool } = await import("./tools/executor.js");
        const r = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ success: false, error: e.message }));
        if (r?.success) _m("management", `  → fees claimed ${p.pair}`); else _m("error", `  → claim failed: ${r?.error}`);
      }
    }

    // ── LLM Zone: positions needing judgment ───────────────────────────────────
    // Includes:
    //   - PnL 5%–25%, in range, no deterministic exit (core judgment zone)
    //   - PnL null/0–5% AND OOR (blind spot — needs monitoring, no automatic close)
    //   - PnL null/0–5% AND in-range but close to stop loss boundary (risk judgment)
    llmZone = positionData.filter(p => {
      const act = actionMap.get(p.position);
      if (act.action !== "STAY") return false;
      const pnl = p.pnl_pct ?? 0;
      // All positions → NEEDS JUDGMENT (LLM can close based on chart at any PnL)
      if (!p.in_range) _m("management", `LLM zone: ${p.pair} PnL ${pnl.toFixed(2)}% OOR ${p.minutes_out_of_range ?? 0}m`);
      return true;
    });

    if (llmZone.length > 0) {
      _m("management", `LLM zone: ${llmZone.length} position(s) for judgment`);
    }

    const reportLines = positionData.map(p => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
      const pnl = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%";
      const deterministicTag = (act.action === "CLOSE" || act.action === "CLAIM") ? `[${act.action}:${act.reason}]` : "";
      return `${p.pair} | PnL: ${pnl} | ${inRange} | ${act.action}${deterministicTag}`;
    });

    // Compute total exposure percentage
    const deployedSol = calculateCurrentExposureSol(positions, preBalance?.sol_price ?? 0);
    const exposurePct = preBalance?.sol > 0 ? +((deployedSol / preBalance.sol) * 100).toFixed(1) : 0;

    // Count actions for summary
    const counts = { STAY: 0, CLOSE: 0, CLAIM: 0, INSTRUCTION: 0 };
    for (const p of positionData) {
      const act = actionMap.get(p.position);
      if (counts[act.action] !== undefined) counts[act.action]++;
    }
    _m("management", `Management cycle completed — ${counts.STAY} STAY | ${counts.CLOSE} CLOSE | ${counts.CLAIM} CLAIM | exposure ${exposurePct}%`);

    mgmtReport = `Positions: ${positionData.length} | Total Exposure: ${exposurePct}% | LLM zone: ${llmZone.length}\n\n${reportLines.join("\n")}`;

    // Always call LLM every management cycle (MiniMax limits are large enough)
    // Builds rich context: all STAY positions with Fibonacci state + chart lesson context
    {
      const stayPositions = positionData.filter(p => actionMap.get(p.position)?.action === "STAY");

      if (stayPositions.length > 0) {
        // Fetch OHLCV for all stay positions in parallel → retrace snapshot
        const retraceMap = new Map();
        {
          const snapResults = await Promise.allSettled(
            stayPositions.map(p => {
              const tracked = getTrackedPosition(p.position);
              const baseMint = tracked?.base_mint ?? null;
              const fibs = tracked?.fib_levels_sol ?? null;
              return hybridDataProvider.getOHLCV(p.pool, "5m", 12, "solana", baseMint)
                .then(candles => ({ position: p.position, candles, fibs }));
            })
          );
          for (const r of snapResults) {
            if (r.status === 'fulfilled' && r.value?.candles?.length >= 3) {
              const snap = computeRetraceSnapshot(r.value.candles, r.value.fibs);
              if (snap) retraceMap.set(r.value.position, snap);
            }
          }
        }

        const allBlocks = stayPositions.map(p => {
          const tracked = getTrackedPosition(p.position);
          const fibs    = tracked?.fib_levels_sol;
          const age     = tracked?.deployed_at ? Math.round((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000) : (p.age_minutes ?? '?');
          const fibLine = fibs
            ? `  fib: fib618=${fibs.fib618?.toPrecision(4) ?? '?'} fib500=${fibs.fib500?.toPrecision(4) ?? '?'} fib236=${fibs.fib236?.toPrecision(4) ?? '?'}`
            : '';
          const inLLMZone = llmZone.some(lp => lp.position === p.position);
          const livePrice = livePriceMap.get(p.position);
          const livePriceLine = livePrice != null ? `  live_price: ${livePrice.toPrecision(5)}` : '';

          let fibStatus = '';
          if (fibs && livePrice != null) {
            if (livePrice < (fibs.fib786 ?? 0))  fibStatus = '  fib_status: BELOW fib786 — real breakdown, no support';
            else if (livePrice < fibs.fib618)     fibStatus = '  fib_status: fib618–fib786 zone — possible bounce/support';
            else if (livePrice < fibs.fib500)     fibStatus = '  fib_status: BELOW fib500 — weak (monitor closely)';
            else if (livePrice < fibs.fib326)     fibStatus = '  fib_status: fib500–fib326 zone (acceptable)';
            else                                   fibStatus = '  fib_status: ABOVE fib326 — strong';
          }

          // Retrace snapshot line
          let retraceLine = '';
          const snap = retraceMap.get(p.position);
          if (snap) {
            const breachNote = snap.candlesSinceFib500Breach != null && snap.candlesSinceFib500Breach > 0
              ? ` | fib500_breach=${snap.candlesSinceFib500Breach}c ago`
              : '';
            const narrowNote = snap.rangeNarrowing ? ' | range_narrowing=YES' : '';
            retraceLine = `  retrace: ${snap.retraceType} | dump_vel=${snap.dumpVelocity.toFixed(1)}%/c | vol_red=${snap.volOnRed.toFixed(1)}x | consec_red=${snap.consecutiveRed} | Δprice=${snap.priceChangePct.toFixed(1)}%${breachNote}${narrowNote}`;
          }

          return [
            `POSITION: ${p.pair} ${inLLMZone ? '[NEEDS JUDGMENT]' : '[MONITORING]'}`,
            `  pnl: ${p.pnl_pct ?? '?'}% | fees: $${p.unclaimed_fees_usd ?? 0} | in_range: ${p.in_range} | age: ${age}min`,
            fibLine,
            livePriceLine,
            fibStatus,
            retraceLine,
          ].filter(Boolean).join('\n');
        }).join("\n\n");

        const deterministicSummary = counts.CLOSE > 0 || counts.CLAIM > 0
          ? `\nDeterministic actions already executed this cycle: CLOSE×${counts.CLOSE} CLAIM×${counts.CLAIM}`
          : '';

        let agentContent = "";
        try {
          const result = await agentLoop(`
MANAGEMENT REVIEW — ${stayPositions.length} position(s) open | LLM judgment needed: ${llmZone.length}
${allBlocks}${deterministicSummary}

TASK: Review all positions above. Base ALL decisions on the data provided.
- [NEEDS JUDGMENT]: evaluate dan execute close/claim berdasarkan fib_status + retrace + pnl.
  • retrace=BREAKDOWN_786 → close (no support below fib786)
  • retrace=AGGRESSIVE + fib500_breach <= 3 candles ago → dump terlalu cepat setelah entry, close
  • retrace=AGGRESSIVE + fib_status BELOW fib500 → strong close signal
  • retrace=DIP_618 → HOLD dan monitor — fib618–fib786 adalah bounce/support zone, jangan close hanya karena dip
  • retrace=STABILIZING atau HEALTHY → hold, retrace normal
- [MONITORING]: catat via set_position_note HANYA jika ada anomali nyata (BREAKDOWN_786 atau AGGRESSIVE + fib500 breach).
- Jika butuh data tambahan: call get_pool_detail dulu.
RULES: DO NOT invent observations. ONLY use data in position blocks above.
          `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 600, corrId);
          agentContent = result?.content ?? "";
        } catch (agentErr) {
          _m("error", `agentLoop crashed: ${agentErr.message} | stack: ${(agentErr.stack || "").slice(0, 500)}`);
          agentContent = `(agentLoop error: ${agentErr.message})`;
        }

        mgmtReport += `\n\n${agentContent}`;
      }
    }

    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    // ATH OOR recovery close → force rescreen immediately + bypass RSI slope for those pools
    const athOorPoolSet = new Set(
      positionData
        .filter(p => (exitMap.get(p.position) ?? "").startsWith("New ATH"))
        .map(p => p.pool)
    );
    if (athOorPoolSet.size > 0) { _screeningLastTriggered = 0; resetScreeningLockForRescreen(); }
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
      runScreeningCycle({ athOorPools: athOorPoolSet.size > 0 ? athOorPoolSet : null }).catch(e => _m("error", `Screening failed: ${e.message}`));
    }

  } catch (error) {
    _m("error", `Management failed: ${error.message}`);
    mgmtReport = `Failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    _managementLastCompleted = Date.now();

    if (lockAcquired) completeManagementLock();
    if (!silent && telegramEnabled() && mgmtReport) {
      const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
      sendMessage(`🔄 Management Cycle [${ts}] ID: ${corrId}\n${stripThink(mgmtReport)}`).catch(() => {});
    }
  }
  return mgmtReport;
}

// ── Screening Cycle ────────────────────────────────────────────────────────────
export async function runScreeningCycle({ silent = false, athOorPools = null } = {}) {
  const corrId = logCycleStart("screening");
  _lastCorrelationId = corrId;
  const _s = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  // All early-exit checks MUST happen before lock acquisition to avoid writing
  // a stale "running" lock file when the cycle will exit anyway.
  if (shouldSkipNextCycle()) {
    _s("screening", "Circuit breaker skip — cycle skipped (auto-clears when cooldown expires)");
    return null;
  }

  if (_screeningBusy) {
    log("cron", "Screening skipped — busy");
    if (!silent && telegramEnabled()) sendMessage(`🔍 Screening busy — cycle already running`).catch(() => {});
    return null;
  }

  if (_exposureHardPausedUntil > Date.now()) {
    const resumeAt = new Date(_exposureHardPausedUntil).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
    _s("screening", `HARD CAP pause active until ${resumeAt}`);
    if (!silent && telegramEnabled()) sendMessage(`🔍 Screening paused — exposure cap active, resumes at ${resumeAt} UTC`).catch(() => {});
    return null;
  }

  const lockResult = acquireScreeningLock();
  if (!lockResult.acquired) {
    _s("screening", `Lock not acquired`);
    if (!silent && telegramEnabled()) sendMessage(`🔍 Screening skipped — lock busy`).catch(() => {});
    return null;
  }

  _screeningBusy = true;
  _screeningBusySince = Date.now();
  _screeningLastTriggered = Date.now();
  timers.screeningLastRun = Date.now();

  // _release defined at function scope so both pre-check and main body share it
  const _release = () => {
    completeScreeningLock();
    _screeningBusy = false;
    _s("screening", "Screening lock released");
  };

  // Outer try/finally guarantees _release() even if pre-screening logic throws unexpectedly
  try {

  let prePositions = null, preBalance = null, deployAmount;

  // Separate try/catch per call — getMyPositions error = skip cycle, getWalletBalances error = continue
  try {
    prePositions = await getMyPositions({ force: true });
  } catch (e) {
    _s("error", `getMyPositions failed — ${e.message} — skipping cycle`);
    if (telegramEnabled()) sendMessage(`Screening [${corrId}] — LPAgent error: ${e.message}, skipping cycle`).catch(() => {});
    _release(); return null;
  }
  try {
    preBalance = await getWalletBalances();
  } catch (e) {
    _s("warn", `getWalletBalances failed — ${e.message} — continuing with preBalance=null`);
    preBalance = preBalance ?? { sol: 0, sol_price: 0 };
  }

  if (prePositions.total_positions >= config.risk.maxPositions) { logSkip("max_positions", {}, corrId); _release(); return null; }
  const solPriceAvailable = (preBalance?.sol_price ?? 0) > 0;
  const currentExposure = solPriceAvailable
    ? calculateCurrentExposureSol(prePositions.positions, preBalance.sol_price)
    : 0; // sol_price unavailable → skip cap check, exposure treated as 0
  const totalPortfolio = (preBalance?.sol ?? 0) + currentExposure;
  deployAmount = getPositionSizing(totalPortfolio > 0 ? totalPortfolio : (preBalance?.sol ?? 0));
  if (deployAmount === 0) { logSkip("insufficient_balance", {}, corrId); _release(); return null; }
  if (!solPriceAvailable) {
    _s("screening", "SOL price unavailable — skipping exposure cap check, proceeding with screening");
  }
  const cap = solPriceAvailable
    ? checkExposureCap(currentExposure, preBalance.sol, deployAmount)
    : { level: "ok" };
  // Exposure cap temporarily disabled for Phase 3 Stability Test
  if (config.risk.exposureCapDisabled) {
    // cap always returns level:"ok" — no block, no warning, silent bypass
  } else if (cap.level === "hard_pause") {
    _exposureHardPausedUntil = cap.pauseUntil;
    _s("error", "HARD CAP TRIGGERED");
    if (telegramEnabled()) sendMessage(`🔍 Screening BLOCKED — exposure cap\nCurrent: ${cap.currentExposureSol.toFixed(2)} SOL (${((cap.currentExposureSol / Math.max(preBalance.sol - cap.gasReserveSol, 0.01)) * 100).toFixed(1)}%)\nProposed: +${deployAmount.toFixed(2)} SOL\nProjected: ${cap.projectedExposureSol.toFixed(2)} SOL (${cap.exposurePct.toFixed(1)}%) > cap ${cap.hardCapPct.toFixed(0)}%`).catch(() => {});
    _release(); return null;
  }
  // Exposure cap temporarily disabled for Phase 3 Stability Test
  if (!config.risk.exposureCapDisabled && cap.level === "warning") {
    _s("warn", `Exposure warning: ${cap.exposurePct.toFixed(1)}%`);
    if (telegramEnabled()) sendMessage(`⚠️ Exposure warning: ${cap.exposurePct.toFixed(1)}% (max ${cap.hardCapPct.toFixed(1)}%)`).catch(() => {});
  }

  _s("screening", `Starting cycle | deploy: ${deployAmount} SOL | wallet: ${preBalance.sol} SOL`);

  let screenReport = null;
  let stats = { discovered: 0, afterVolume: 0, meteoraPools: 0, fibPassed: 0 };
  let freshCandidates = [];

  try {
    const topResult = await getTopCandidates({ limit: 20, correlationId: corrId, athOorPools }).catch(() => null);
    const candidates = topResult?.candidates || [];
    stats = {
      discovered: topResult?.total_screened ?? 0,
      afterVolume: topResult?.after_volume_count ?? 0,
      meteoraPools: topResult?.withPool_count ?? 0,
      fibPassed: topResult?.fib_passed ?? 0,
    };

    if (candidates.length === 0) {
      // Build skip reason from available stats
      const reason = stats.afterVolume === 0 ? "no pools after volume filter" :
        stats.fibPassed === 0 ? "failed Fib 0.500" :
        "failed EMA/RSI confluence";
      screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\nNo entry signals (${reason})`;
      // fall through to finally → _release() + Telegram send
    } else {
      const PENDING_ATH_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "screening-pending.json");
      const activeBinResults = await Promise.allSettled(candidates.map(p => getActiveBin({ pool_address: p.pool })));

      // ── Freshness check: drop candidates where price crashed >50% since pool discovery ──
      // activeBin.price and pool.price are both SOL-denominated (Meteora pool_price)
      freshCandidates = [];
      const freshActiveBinResults = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const activeBinData = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value : null;
        const poolPriceAtDiscovery = c.price ?? null;
        const activeBinPrice = activeBinData?.price ?? null;
        if (poolPriceAtDiscovery && activeBinPrice && activeBinPrice < poolPriceAtDiscovery * 0.5) {
          const dropPct = ((1 - activeBinPrice / poolPriceAtDiscovery) * 100).toFixed(0);
          _s("screening", `  ${c.name}: STALE — price dropped ${dropPct}% since pool discovery, skipping`);
          continue;
        }
        freshCandidates.push(c);
        freshActiveBinResults.push(activeBinResults[i]);
      }

      if (freshCandidates.length === 0 && candidates.length > 0) {
        screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\n→ ${candidates.length} candidate(s) passed Fib but all STALE (price crashed since screening)`;
        // fall through to finally → _release() + Telegram send
      } else {
        try {
          const pending = {};
          for (let i = 0; i < freshCandidates.length; i++) {
            const c = freshCandidates[i];
            const fib = c.fib_signal;
            const ath = fib?.ath ?? fib?.fibLevels?.swingHigh ?? null;
            const entryPrice = fib?.currentPrice ?? c.price ?? null;
            const activeBin = freshActiveBinResults[i]?.status === "fulfilled" ? freshActiveBinResults[i].value?.binId : null;
            if (c.pool && ath && entryPrice && activeBin != null) {
              pending[c.pool] = { ath, entryPrice, binStep: c.bin_step ?? null, activeBinAtScreening: activeBin, fib500: fib?.fibLevels?.fib500 ?? null, tokenMint: c.base?.mint ?? null };
            }
          }
          fs.writeFileSync(PENDING_ATH_PATH, JSON.stringify(pending));
        } catch { /**/ }

        const candidateBlocks = freshCandidates.map((pool, i) => {
          const fib = pool.fib_signal;
          const activeBin = freshActiveBinResults[i]?.status === "fulfilled" ? freshActiveBinResults[i].value?.binId : null;
          const fib500 = fib?.fibLevels?.fib500 != null ? `${fib.fibLevels.fib500.toPrecision(4)} SOL` : "n/a";
          const fib382 = fib?.fibLevels?.fib382 != null ? `${fib.fibLevels.fib382.toPrecision(4)} SOL` : "n/a";
          const screenPrice = fib?.currentPrice != null ? `${fib.currentPrice.toPrecision(4)} SOL` : "n/a";
          const conf = fib?.confluenceScore != null ? fib.confluenceScore.toFixed(2) : "n/a";
          return `POOL: ${pool.name} (${pool.pool})\n  metrics: bin_step=${pool.bin_step}, fee=${pool.fee_pct}%, tvl=$${pool.active_tvl}\n  fib: signal=${fib?.signal} conf=${conf} binsBelow=${fib?.binsBelow} binsAbove=${fib?.binsAbove ?? 0}\n  fib_levels: fib500=${fib500} fib382=${fib382} screenPrice=${screenPrice}\n  active_bin: ${activeBin}`;
        }).join("\n\n");

        let agentContent = "";
        try {
          const result = await agentLoop(`
FIBONACCI SCREENING CYCLE
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CANDIDATES (Fibonacci-confirmed):
${candidateBlocks}

RULES:
1. Pick highest confluenceScore pool with good metrics.
2. bins_below and bins_above from fib_signal (chart.js output). In ATH zone bins_above is NEGATIVE — pass it AS-IS (do NOT zero it out).
3. strategy=bid_ask. amount_y=${deployAmount} SOL.
    `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, corrId);
          agentContent = result?.content ?? "";
        } catch (agentErr) {
          _s("error", `agentLoop crashed: ${agentErr.message} | stack: ${(agentErr.stack || "").slice(0, 500)}`);
          agentContent = `(agentLoop error: ${agentErr.message})`;
        }

        screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\n→ ${freshCandidates.length} candidate(s) passed Fib + RSI + EMA\n\n🤖 LLM DECISION:\n${agentContent}`;
      }
    }
  } catch (error) {
    _s("error", `Screening main loop failed: ${error.message}`);
    screenReport = `Failed: ${error.message}`;
  } finally {
    _release();
    if (!silent && telegramEnabled() && screenReport) {
      const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
      sendMessage(`🔍 Fibonacci Screening [${ts}] ID: ${corrId}\n${stripThink(screenReport)}`).catch(() => {});
    }
  }
  return screenReport;

  } catch (outerErr) {
    // Outer safety net — ensures _screeningBusy is always released even if pre-screening throws
    _s("error", `Screening outer catch: ${outerErr.message} — releasing lock`);
    _release();
    return null;
  }
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    // _managementBusy guard: prevent concurrent management cycles from cron overlap
    if (_managementBusy) return;
    const lockAge = Date.now() - _managementLastCompleted;
    if (lockAge < 45_000) return;
    await runManagementCycle({ silent: true });
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, () => {
    runScreeningCycle().catch(e => log("cron_error", `Screening cron failed: ${e.message}`));
  });

  const backtestTask = cron.schedule("0 0 * * *", () => {
    // Skip backtest if circuit is broken (LLM likely down) — backtest needs LLM to analyze pools
    const cb = getCircuitState();
    if (cb?.isCircuitBroken) {
      log("cron", "Daily backtest SKIPPED — circuit broken (LLM likely unavailable)");
      return;
    }
    const corrId = shortId();
    runDailyBacktest({ correlationId: corrId, hours: 336 }).catch(e => log("cron_error", `Daily backtest failed: ${e.message}`));
  });

  const briefingTask = cron.schedule("0 9 * * *", () => {
    runMorningBriefing().catch(e => log("cron_error", `Morning briefing failed: ${e.message}`));
  });

  const pollTask = cron.schedule("*/30 * * * *", () => {
    runPnLPoll().catch(e => log("cron_error", `PnL poll failed: ${e.message}`));
  });

  _cronTasks = [mgmtTask, screenTask, backtestTask, briefingTask, pollTask];
  log("cron", `Cron started — mgmt=*/${config.schedule.managementIntervalMin}min screen=*/${config.schedule.screeningIntervalMin}min`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  const corrId = _lastCorrelationId || "none";
  const cb = getCircuitState();
  log("shutdown", `[${corrId}] Shutdown: ${signal}`, {
    signal, isCircuitBroken: cb.isCircuitBroken,
    fallbackProvider: cb.isFallbackActive ? "openrouter" : "minimax",
  });
  stopPolling();
  stopHealthServer();
  const positions = await getMyPositions().catch(() => ({}));
  log("shutdown", `[${corrId}] Open positions: ${positions.total_positions ?? "?"}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Telegram Handler (non-TTY / PM2 mode) ─────────────────────────────────────
let busy = false;

async function handleTelegram(text) {
  if (busy) { sendMessage("Agent busy, try again shortly.").catch(() => {}); return; }
  busy = true;
  try {
    if (text === "/positions") {
      const { positions, total_positions } = await getMyPositions({ force: true }).catch(() => ({ positions: [], total_positions: 0 }));
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const lines = positions.map((p, i) => `${i+1}. ${p.pair} | $${p.total_value_usd} | PnL: ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`);
      await sendMessage(`Open Positions (${total_positions}):\n${lines.join("\n")}`);
      return;
    }
    if (text === "/briefing") {
      await sendMessage("Running morning briefing...");
      await runMorningBriefing({ force: true }).catch(e => sendMessage(`Briefing error: ${e.message}`));
      return;
    }
    if (text === "/screening") {
      await sendMessage("Running screening cycle...");
      await runScreeningCycle({ silent: false }).catch(e => sendMessage(`Screening error: ${e.message}`));
      return;
    }
    if (text === "/management") {
      await sendMessage("Running management cycle...");
      await runManagementCycle({ silent: false }).catch(e => sendMessage(`Management error: ${e.message}`));
      return;
    }
    if (text.startsWith("/backtest")) {
      const label = text.includes("14d") ? "14d" : "7d";
      await sendMessage(`Running ${label} backtest...`);
      const corrId = shortId();
      const result = await runDailyBacktest({ correlationId: corrId, hours: label === "14d" ? 336 : 168 }).catch(e => null);
      if (result && !result.skipped) {
        const sum = label === "14d" ? result.s14 : result.s7;
        const wr = sum?.avgBacktestWinRate != null ? `${sum.avgBacktestWinRate}%` : "N/A";
        const pools = sum?.poolsAnalyzed ?? 0;
        await sendMessage(`${label} backtest: ${pools} pools | WR: ${wr}`);
      } else {
        await sendMessage(`No ${label} backtest data available.`);
      }
      return;
    }
    if (text === "/help") {
      await sendMessage(`Prospera Commands:\n/positions — list open positions\n/status — agent status overview\n/briefing — trigger morning briefing\n/backtest — run 7d backtest\n/backtest 14d — run 14d backtest\n/close <N> — close position N\n/screening — trigger screening cycle
/management — trigger management cycle
/help — show this message`);
      return;
    }
    if (text === "/status") {
      const cb = getCircuitState();
      const activeProvider = getActiveProvider();
      const positions = await getMyPositions({ force: true }).catch(() => null);
      const balance = await getWalletBalances().catch(() => null);
      const deployedSol = (positions?.positions?.length ?? 0) > 0 ? calculateCurrentExposureSol(positions.positions, balance?.sol_price ?? 0) : 0;
      const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;
      const lastScreen = timers.screeningLastRun ? new Date(timers.screeningLastRun).toLocaleString("id-ID") : "never";
      const lastMgmt = timers.managementLastRun ? new Date(timers.managementLastRun).toLocaleString("id-ID") : "never";
      const uptime = Math.round(process.uptime() / 60);
      await sendMessage(`Prospera Status\n\nMode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}\nUptime: ${uptime}m\nProvider: ${activeProvider}\nCircuit: ${cb?.isCircuitBroken ? "OPEN (fallback)" : "OK (primary)"}\nLast Screening: ${lastScreen}\nLast Management: ${lastMgmt}\nOpen Positions: ${positions?.total_positions ?? 0}/${config.risk.maxPositions}\nExposure: ${exposurePct}%\nSOL Balance: ${balance?.sol?.toFixed(3) ?? "?"}`);
      return;
    }
      const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true }).catch(() => ({ positions: [] }));
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position, reason: "manual close" });
      if (result.success) {
        const sign = (result.pnl_usd ?? 0) >= 0 ? "+" : "";
        await sendMessage(`🔒 Closed ${pos.pair}\nPnL: ${sign}$${(result.pnl_usd ?? 0).toFixed(2)} (${sign}${(result.pnl_pct ?? 0).toFixed(2)}%)`);
      } else {
        await sendMessage(`Close failed: ${JSON.stringify(result)}`);
      }
      return;
    }
    // ── Free-flow conversation with safety guard ──────────────────────────────

    // ── Token-specific questions: answer from data, not LLM hallucination ─────
    // Detect SOL mint addresses (base58, ~44 chars) or pump.fun-style (~9-12 chars)
    const mintPattern = /([1-9A-HJ-NP-Za-kmnp-z]{32,46})/g;
    const mints = (text.match(mintPattern) || []).filter(m => m.length > 20);

    if (mints.length > 0 && /(\?)|(kenapa)|(status)|(Tidak)|(skip)|(gagal)|(masuk)|(screening)|(volume)|(mcap)|(price)/i.test(text)) {
      // Fetch Dexscreener data for this token
      const mint = mints[0];
      try {
        const s = config.screening;
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) { await sendMessage(`Tidak bisa fetch data untuk token ini.`); return; }
        const data = await res.json();
        const pairs = (Array.isArray(data) ? data : []).filter(p => p.chainId === "solana" && (p.quoteToken?.address === "So11111111111111111111111111111111111111112" || p.quoteToken?.symbol === "SOL"));
        if (pairs.length === 0) { await sendMessage(`Token tidak punya pool SOL — tidak masuk screening.`); return; }

        // Best pair by 1h volume
        const best = pairs.reduce((a, b) => (parseFloat(a.volume?.h1 ?? 0) > parseFloat(b.volume?.h1 ?? 0) ? a : b));
        const volH1 = Math.round(parseFloat(best.volume?.h1 ?? 0) || 0);
        const mcap = Math.round(parseFloat(best.fdv ?? best.marketCap) || 0);
        const price = parseFloat(best.priceUsd) || null;

        // Check volume filter
        if (volH1 < s.minVolume) {
          await sendMessage(
            `Token itu volume 1h $${volH1.toLocaleString()} < min $${s.minVolume.toLocaleString()}, jadi tidak masuk pool checking.\n` +
            `mcap: ${mcap > 0 ? "$" + mcap.toLocaleString() : "?"} | min mcap: $${s.minMcap.toLocaleString()}${price ? `\nprice: $${price < 0.001 ? price.toExponential(3) : price.toFixed(6)}` : ""}`
          );
          return;
        }
        if (mcap > 0 && mcap < s.minMcap) {
          await sendMessage(
            `Token itu mcap $${mcap.toLocaleString()} < min $${s.minMcap.toLocaleString()}, jadi tidak masuk pool checking.\n` +
            `1h vol: $${volH1.toLocaleString()} | min vol: $${s.minVolume.toLocaleString()}${price ? `\nprice: $${price < 0.001 ? price.toExponential(3) : price.toFixed(6)}` : ""}`
          );
          return;
        }
        if (mcap > 0 && mcap > s.maxMcap) {
          await sendMessage(
            `Token itu mcap $${mcap.toLocaleString()} > max $${s.maxMcap.toLocaleString()}, jadi tidak masuk screening.\n` +
            `1h vol: $${volH1.toLocaleString()} | mcap terlalu besar untuk strategi ini.`
          );
          return;
        }
        // Volume & mcap OK but might not be in Dexscreener boosts/profiles (not discovered)
        await sendMessage(
          `Token itu vol 1h $${volH1.toLocaleString()}, mcap $${mcap.toLocaleString()}.\n` +
          `Volume & mcap lolos. Tapi tidak masuk screening mungkin karena:\n` +
          `1) Tidak masuk Dexscreener boosts/profiles (screening hanya scan token trending)\n` +
          `2) Gagal RugCheck / Jupiter safety check\n` +
          `3) Rank di luar top 60 setelah filter (pre-pool cap)\n\nCek log screening untuk detail lengkap.`
        );
        return;
      } catch (e) {
        await sendMessage(`Error fetching token data: ${e.message}`);
        return;
      }
    }

    // Patterns that indicate user wants to CHANGE something (require explicit confirmation)
    const changePatterns = [
      /\bubah\b/i, /\bchange\b/i, /\bmodify\b/i, /\bupdate\b/i,
      /\btukar\b/i, /\breplace\b/i, /\bswap\b/i,
      /\bset\s+\w+\s+to\b/i, /\bset\b.*\bto\b/i,
      /\b(min|rsi|fib|volume|exposure|max).*\b(jadi|to|=|:=\b)/i,
      /^(RSI|FIB|MIN|VOLUME|EXPOSURE).*?(=|:=\s*)/i,
    ];
    const wantsChange = changePatterns.some(p => p.test(text));

    if (wantsChange) {
      await sendMessage(
        `⚠️ Anda meminta perubahan parameter.\n` +
        `Saya tidak akan langsung mengubah sebelum Anda konfirmasi.\n` +
        `Kirim "ya" atau "ubah" untuk melanjutkan, atau abaikan pesan ini.`
      );
      return;
    }

    // /hermes and /grok prefixes — route to agent as-is
    if (text.startsWith("/hermes ") || text.startsWith("/grok ")) {
      text = text.replace(/^\/(hermes|grok)\s*/i, "");
    }

    const corrId = shortId();
    const hasClose = /\bclose\b|\bsell\b/i.test(text);
    const hasDeploy = /\bdeploy\b|\bopen\b|\blp into\b/i.test(text);
    const role = hasDeploy ? "SCREENER" : "GENERAL";
    const { content } = await agentLoop(text, config.llm.maxSteps, [], role, config.llm.generalModel, null, corrId);
    await sendMessage(stripThink(content));
  } catch (e) {
    await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
log("startup", "Fibonacci LP Agent starting (minimal mode)...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);

registerCronRestarter(() => { startCronJobs(); });

const isTTY = process.stdin.isTTY;

// Probe LLM providers before starting cycles
probeLLMProviders().catch(e => log("startup", `LLM probe error: ${e.message}`)).finally(() => {
  if (isTTY) {
    // REPL mode — start cron + Telegram polling + REPL interface
    startCronJobs();
    startHealthServer();
    startREPL(); // does not return — blocks on readline
  } else {
    // PM2 / non-TTY mode
    startCronJobs();
    startHealthServer();
    _screeningLastTriggered = 0;
    startPolling(handleTelegram);
  }
});
