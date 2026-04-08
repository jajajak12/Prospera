/**
 * tools/daily-backtester.js — Periodic backtesting with real vs simulated comparison.
 *
 * Runs daily at 02:00 server time (via cron in index.js).
 * Analyzes closed positions from lessons.js against historical backtest results.
 *
 * Outputs:
 * - Telegram summary: real PnL vs backtest PnL, win rate diff, exit reasons, exposure
 * - File: backtest/YYYY-MM-DD.json with full structured results
 *
 * Correlation ID: propagated from caller (runScreeningCycle's corrId or shortId).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { logWithId } from "../log-utils.js";
import { runBacktest, runBacktestWithSweep } from "../backtest.js";
import { getClosedPoolsForBacktest } from "../lessons.js";
import { sendMessage } from "../telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_DIR = path.join(__dirname, "..", "backtest");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureBacktestDir() {
  if (!fs.existsSync(BACKTEST_DIR)) {
    fs.mkdirSync(BACKTEST_DIR, { recursive: true });
  }
}

function saveBacktestResult(result, label) {
  ensureBacktestDir();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const fname = path.join(BACKTEST_DIR, `${today}_${label}.json`);
  fs.writeFileSync(fname, JSON.stringify(result, null, 2));
  return fname;
}

function loadBacktestHistory(days = 30) {
  ensureBacktestDir();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = (fs.readdirSync(BACKTEST_DIR) || [])
    .filter(f => f.endsWith("_7d.json") || f.endsWith("_14d.json"))
    .filter(f => {
      const stat = fs.statSync(path.join(BACKTEST_DIR, f));
      return stat.mtimeMs >= cutoff;
    })
    .sort();
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR, f), "utf8"));
    } catch { return null; }
  }).filter(Boolean);
}

// ── Core backtest runner for closed pools ────────────────────────────────────

async function backtestPools(pools, { aggregate = 15, correlationId = null } = {}) {
  const _l = (msg, meta = {}) => logWithId("backtest", msg, meta, correlationId);
  const results = [];

  for (const p of pools) {
    _l(`Backtesting ${p.pool_name || p.pool.slice(0, 8)}...`, { pool: p.pool, aggregate });
    let bt = null, sweepBest = null;

    for (const agg of [aggregate, 5, 1]) {
      try {
        const res = await runBacktestWithSweep({
          poolAddress: p.pool,
          binStep:    p.bin_step,
          feePct:     p.fee_pct,
          aggregate:  agg,
          candleLimit: 200,
        });
        bt = res.backtest;
        sweepBest = res.sweepBest;
        if (bt && bt.totalTrades >= 3) break;
      } catch {
        bt = null; sweepBest = null;
      }
    }

    results.push({
      pool:       p.pool,
      pool_name:  p.pool_name ?? p.pool.slice(0, 8),
      bin_step:   p.bin_step,
      fee_pct:    p.fee_pct,
      actual_pnl: p.actual_pnl ?? null,
      close_reason: p.close_reason ?? null,
      bt,
      sweepBest,
    });
  }

  return results;
}

// ── Real vs Backtest comparison ───────────────────────────────────────────────

function compareResults(results7d, results14d) {
  const combine = (results) => {
    const withData = results.filter(r => r.bt && r.bt.totalTrades >= 3);
    if (withData.length === 0) return null;

    const avgBtWr    = withData.reduce((s, r) => s + r.bt.winRate, 0) / withData.length;
    const avgBtPnl  = withData.reduce((s, r) => s + (r.bt.avgPnlPct ?? 0), 0) / withData.length;
    const withActual = withData.filter(r => r.actual_pnl != null);

    let avgActualPnl = null, pnlDiff = null;
    if (withActual.length > 0) {
      avgActualPnl = withActual.reduce((s, r) => s + r.actual_pnl, 0) / withActual.length;
      pnlDiff = avgActualPnl - avgBtPnl;
    }

    // Exit reason breakdown
    const exitReasons = {};
    for (const r of withData) {
      if (!r.bt.summary?.byExitReason) continue;
      for (const [reason, count] of Object.entries(r.bt.summary.byExitReason)) {
        exitReasons[reason] = (exitReasons[reason] || 0) + count;
      }
    }

    // Zone performance
    const zoneWr = {};
    for (const r of withData) {
      if (!r.bt.summary?.byZone) continue;
      for (const [zone, data] of Object.entries(r.bt.summary.byZone)) {
        if (!zoneWr[zone]) zoneWr[zone] = { count: 0, totalWr: 0 };
        zoneWr[zone].count++;
        zoneWr[zone].totalWr += data.winRate / 100;
      }
    }

    // Exposure behavior: how many positions went OOR
    const oorCount = withData.filter(r =>
      r.bt.summary?.byExitReason?.["out_of_range"] ||
      r.bt.summary?.byExitReason?.["oor_below_range"]
    ).length;

    return {
      poolsAnalyzed: withData.length,
      poolsWithActual: withActual.length,
      avgBacktestWinRate: +(avgBtWr * 100).toFixed(1),
      avgBacktestPnl:     +avgBtPnl.toFixed(2),
      avgActualPnl:       avgActualPnl != null ? +avgActualPnl.toFixed(2) : null,
      pnlDiffVsBacktest:  pnlDiff != null ? +pnlDiff.toFixed(2) : null,
      topExitReasons: Object.entries(exitReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => ({ reason, count })),
      zoneWinRates: Object.fromEntries(
        Object.entries(zoneWr).map(([z, v]) => [z, +((v.totalWr / v.count) * 100).toFixed(1)])
      ),
      oorExposurePct: withData.length > 0 ? +((oorCount / withData.length) * 100).toFixed(1) : null,
      sweepBestCount: results.filter(r => r.sweepBest).length,
    };
  };

  return {
    period7d:  combine(results7d),
    period14d: combine(results14d),
  };
}

// ── Suggestions engine ─────────────────────────────────────────────────────────

function generateSuggestions(comparison, config) {
  const suggestions = [];
  const s7  = comparison?.period7d;
  const s14 = comparison?.period14d;

  // Win rate comparison
  if (s7 && s7.avgBacktestWinRate < 40) {
    suggestions.push({
      type: "warning",
      text: `⚠️ WR 7d rendah: ${s7.avgBacktestWinRate}% — confluence threshold mungkin perlu dinaikkan`,
    });
  }

  // Real vs backtest divergence
  if (s7?.pnlDiffVsBacktest != null) {
    const diff = s7.pnlDiffVsBacktest;
    if (diff < -10) {
      suggestions.push({
        type: "error",
        text: `🔴 Real PnL -${Math.abs(diff)}% vs backtest — posisi closing terlalu cepat atau fees tidak terakumulasi`,
      });
    } else if (diff > 5) {
      suggestions.push({
        type: "info",
        text: `🟢 Real PnL +${diff.toFixed(1)}% vs backtest — lebih baik dari estimasi`,
      });
    }
  }

  // Exit reason dominance
  if (s7?.topExitReasons?.length > 0) {
    const top = s7.topExitReasons[0];
    if (top.count >= 3) {
      if (top.reason === "stop_loss") {
        suggestions.push({
          type: "warning",
          text: `⛔ Stop loss mendominasi (${top.count}x) — perketat RSI/Fib confluence`,
        });
      } else if (top.reason === "out_of_range" || top.reason === "oor_below_range") {
        suggestions.push({
          type: "warning",
          text: `📉 OOR exit mendominasi (${top.count}x) — bins range terlalu sempit`,
        });
      }
    }
  }

  // OOR exposure
  if (s7?.oorExposurePct != null && s7.oorExposurePct > 40) {
    suggestions.push({
      type: "warning",
      text: `📊 ${s7.oorExposurePct}% posisi kena OOR — exposure management perlu diperbaiki`,
    });
  }

  // Zone performance
  if (s7?.zoneWinRates) {
    const zones = Object.entries(s7.zoneWinRates).sort((a, b) => b[1] - a[1]);
    if (zones.length > 1 && zones[0][1] - zones[zones.length - 1][1] > 20) {
      const [bestZone, bestWr] = zones[0];
      suggestions.push({
        type: "info",
        text: `🏹 Zone ${bestZone} WR ${bestWr}% — entry di zona ini punya win rate lebih tinggi`,
      });
    }
  }

  if (suggestions.length === 0) {
    suggestions.push({
      type: "ok",
      text: `✅ Tidak ada anomali signifikan — strategi berjalan normal`,
    });
  }

  return suggestions;
}

// ── Telegram message builder ─────────────────────────────────────────────────

function buildTelegramMessage(comparison, suggestions, corrId) {
  const s7  = comparison?.period7d;
  const s14 = comparison?.period14d;
  const today = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  const lines = [];

  lines.push(`📊 *Daily Backtest Report* [${today}]`);
  if (corrId) lines.push(`ID: \`${corrId}\``);
  lines.push("");

  // ── 7 day ──
  lines.push("*7-Day Analysis*");
  if (!s7 || s7.poolsAnalyzed === 0) {
    lines.push("  Tidak ada data cukup (\\<3 trades per pool)");
  } else {
    lines.push(`  Pools: ${s7.poolsAnalyzed} | WR: ${s7.avgBacktestWinRate}% | Avg PnL: ${s7.avgBacktestPnl}%`);
    if (s7.avgActualPnl != null) {
      const diff = s7.pnlDiffVsBacktest;
      const arrow = diff >= 0 ? "▲" : "▼";
      lines.push(`  Real PnL: ${s7.avgActualPnl}% ${arrow} (vs BT: ${diff > 0 ? "+" : ""}${diff}%)`);
    }
    if (s7.topExitReasons.length > 0) {
      const top3 = s7.topExitReasons.slice(0, 3)
        .map(r => `${r.reason.replace(/_/g, " ")} (${r.count}x)`)
        .join(", ");
      lines.push(`  Exit: ${top3}`);
    }
    if (s7.oorExposurePct != null) {
      lines.push(`  OOR: ${s7.oorExposurePct}%`);
    }
  }
  lines.push("");

  // ── 14 day ──
  lines.push("*14-Day Analysis*");
  if (!s14 || s14.poolsAnalyzed === 0) {
    lines.push("  Tidak ada data cukup");
  } else {
    lines.push(`  Pools: ${s14.poolsAnalyzed} | WR: ${s14.avgBacktestWinRate}% | Avg PnL: ${s14.avgBacktestPnl}%`);
    if (s14.avgActualPnl != null) {
      lines.push(`  Real PnL: ${s14.avgActualPnl}%`);
    }
    if (s14.topExitReasons.length > 0) {
      const top3 = s14.topExitReasons.slice(0, 3)
        .map(r => `${r.reason.replace(/_/g, " ")} (${r.count}x)`)
        .join(", ");
      lines.push(`  Exit: ${top3}`);
    }
  }
  lines.push("");

  // ── Suggestions ──
  lines.push("*Insights*");
  for (const s of suggestions) {
    lines.push(`  ${s.text}`);
  }

  return lines.join("\n");
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Run daily backtest analysis on recently closed pools.
 * @param {object} opts
 * @param {string} [opts.correlationId] - Correlation ID from caller cycle
 * @param {number} [opts.hours=168]       - Hours of history to analyze (default 7 days)
 */
export async function runDailyBacktest({ correlationId = null, hours = 168 } = {}) {
  const _l = (category, msg, meta = {}) => logWithId(category, msg, meta, correlationId);

  _l("backtest", `Daily backtest starting...`, { hours });

  // Fetch closed pools for both periods
  const pools7d  = getClosedPoolsForBacktest({ hours: Math.min(hours, 168),  limit: 8 });
  const pools14d = getClosedPoolsForBacktest({ hours: Math.min(hours, 336),  limit: 8 });

  _l("backtest", `Found ${pools7d.length} pools (7d), ${pools14d.length} pools (14d)`, {
    pools7d: pools7d.length, pools14d: pools14d.length,
  });

  if (pools7d.length === 0 && pools14d.length === 0) {
    _l("backtest", "No closed pools to backtest — skipping");
    return { skipped: true, reason: "no_closed_pools", correlationId };
  }

  // Run backtests in parallel
  const [results7d, results14d] = await Promise.all([
    pools7d.length  > 0 ? backtestPools(pools7d,  { aggregate: 15, correlationId }) : [],
    pools14d.length > 0 ? backtestPools(pools14d, { aggregate: 15, correlationId }) : [],
  ]);

  // Compare
  const comparison = compareResults(results7d, results14d);

  // Generate suggestions
  const { config } = await import("../config.js");
  const suggestions = generateSuggestions(comparison, config);

  // Save to file
  const today = new Date().toISOString().slice(0, 10);
  const saved7d  = results7d.length  > 0 ? saveBacktestResult({ ...comparison, results: results7d,  poolsSource: `${hours}h`, savedAt: new Date().toISOString() }, "7d")  : null;
  const saved14d = results14d.length > 0 ? saveBacktestResult({ ...comparison, results: results14d, poolsSource: `${hours}h`, savedAt: new Date().toISOString() }, "14d") : null;

  _l("backtest", `Backtest saved: ${saved7d ? saved7d.split("/").pop() : "none"} + ${saved14d ? saved14d.split("/").pop() : "none"}`);

  // Send Telegram
  const msg = buildTelegramMessage(comparison, suggestions, correlationId);
  await sendMessage(msg).catch(() => {});

  _l("backtest", `Daily backtest complete — ${comparison?.period7d?.poolsAnalyzed ?? 0} pools (7d), ${comparison?.period14d?.poolsAnalyzed ?? 0} (14d)`);

  return {
    correlationId,
    comparison,
    suggestions,
    saved7d,
    saved14d,
  };
}
