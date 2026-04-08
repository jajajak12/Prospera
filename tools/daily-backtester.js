/**
 * tools/daily-backtester.js — Clean daily backtest runner.
 *
 * Cron: 00:00 server time (set di startCronJobs index.js)
 * Backtest 7d + 14d closed pools → compare vs real → save to backtest/ → Telegram
 *
 * Correlation ID: propagated from caller cycle.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logWithId } from "../log-utils.js";
import { runBacktestWithSweep } from "../backtest.js";
import { getClosedPoolsForBacktest } from "../lessons.js";
import { sendMessage } from "../telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKTEST_DIR = path.join(__dirname, "..", "backtest");

// ── File helpers ──────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(BACKTEST_DIR)) fs.mkdirSync(BACKTEST_DIR, { recursive: true });
}

function saveResult(data, label) {
  ensureDir();
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKTEST_DIR, `${today}_${label}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ── Single pool backtester (sequential, non-aggressive) ──────────────────────

async function backtestPool(pool, { correlationId } = {}) {
  const _l = msg => logWithId("backtest", msg, { pool: pool.pool.slice(0, 8) }, correlationId);

  let bt = null, sweepBest = null;
  for (const agg of [15, 5, 1]) {
    try {
      const res = await runBacktestWithSweep({
        poolAddress: pool.pool,
        binStep: pool.bin_step,
        feePct: pool.fee_pct,
        aggregate: agg,
        candleLimit: 200,
      });
      bt = res.backtest;
      sweepBest = res.sweepBest;
      if (bt && bt.totalTrades >= 3) break;
    } catch { bt = null; }
  }

  return {
    pool: pool.pool,
    pool_name: pool.pool_name ?? pool.pool.slice(0, 8),
    actual_pnl: pool.actual_pnl ?? null,
    close_reason: pool.close_reason ?? null,
    bt,
    sweepBest,
  };
}

// ── Insights (max 5 lines) ───────────────────────────────────────────────────

function buildInsights(s7, s14) {
  const lines = [];

  if (s7?.avgBacktestWinRate < 40) {
    lines.push(`⚠️ WR 7d rendah: ${s7.avgBacktestWinRate}% — naikkan confluence`);
  }
  if (s7?.pnlDiffVsBacktest != null && s7.pnlDiffVsBacktest < -10) {
    lines.push(`🔴 Real PnL ${s7.pnlDiffVsBacktest}% vs backtest — posisi closing terlalu cepat`);
  }
  if (s7?.topExitReasons?.[0]?.reason === "stop_loss" && s7.topExitReasons[0].count >= 3) {
    lines.push(`⛔ Stop loss dominan (${s7.topExitReasons[0].count}x) — perketat RSI`);
  }
  if (s7?.oorExposurePct > 40) {
    lines.push(`📉 OOR ${s7.oorExposurePct}% — exposure management perlu diperbaiki`);
  }
  if (s14?.avgBacktestWinRate > 60) {
    lines.push(`🟢 WR 14d bagus: ${s14.avgBacktestWinRate}% — strategi on track`);
  }

  return lines.length ? lines : ["✅ Tidak ada anomali signifikan"];
}

// ── Telegram message builder ─────────────────────────────────────────────────

function buildMsg(s7, s14, corrId) {
  const date = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  const insights = buildInsights(s7, s14);

  const sec = (label, s) => {
    if (!s || s.poolsAnalyzed === 0) return `${label}: tidak ada data cukup\n`;
    let l = `${label}: ${s.poolsAnalyzed} pools | WR ${s.avgBacktestWinRate}% | avg ${s.avgBacktestPnl}%\n`;
    if (s.avgActualPnl != null) l += `  Real: ${s.avgActualPnl}% (vs BT: ${s.pnlDiffVsBacktest != null ? (s.pnlDiffVsBacktest > 0 ? "+" : "") + s.pnlDiffVsBacktest + "%" : "n/a"})\n`;
    if (s.topExitReasons?.length) l += `  Exit: ${s.topExitReasons.map(r => `${r.reason}(${r.count}x)`).join(", ")}\n`;
    return l;
  };

  return (
    `📊 Daily Backtest [${date}]\n` +
    `ID: \`${corrId}\`\n\n` +
    `*7-Day*\n${sec("7d", s7)}` +
    `*14-Day*\n${sec("14d", s14)}` +
    `*Insights*\n${insights.map(l => "  " + l).join("\n")}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  opts.correlationId
 * @param {number}  [opts.hours=168]
 */
export async function runDailyBacktest({ correlationId = null, hours = 168 } = {}) {
  const _l = msg => logWithId("backtest", msg, {}, correlationId);

  _l(`Daily backtest starting... [${hours}h window]`);

  // 7d window: min(hours, 168) so it scales if hours > 168
  // 14d window: min(hours, 336), skipped if hours < 336
  const win7  = Math.min(hours, 168);
  const win14 = Math.min(hours, 336);
  const pools7d  = win7  >= 168 ? getClosedPoolsForBacktest({ hours: win7,  limit: 8 }) : [];
  const pools14d = win14 >= 336 ? getClosedPoolsForBacktest({ hours: win14, limit: 8 }) : [];

  if (pools7d.length === 0 && pools14d.length === 0) {
    _l("No closed pools — skipping");
    return { skipped: true };
  }

  // Sequential backtest (non-aggressive)
  const results7d = [];
  for (const p of pools7d) {
    results7d.push(await backtestPool(p, { correlationId }));
  }

  const results14d = [];
  for (const p of pools14d) {
    results14d.push(await backtestPool(p, { correlationId }));
  }

  // Aggregate stats
  const aggregate = (results) => {
    const has = results.filter(r => r.bt && r.bt.totalTrades >= 3);
    if (!has.length) return null;

    const avgWr    = has.reduce((s, r) => s + r.bt.winRate, 0) / has.length;
    const avgPnl   = has.reduce((s, r) => s + (r.bt.avgPnlPct ?? 0), 0) / has.length;
    const withAct  = has.filter(r => r.actual_pnl != null);
    const avgReal  = withAct.length ? withAct.reduce((s, r) => s + r.actual_pnl, 0) / withAct.length : null;
    const diff     = avgReal != null ? +(avgReal - avgPnl).toFixed(2) : null;

    const exitMap = {};
    for (const r of has) {
      if (!r.bt.summary?.byExitReason) continue;
      for (const [reason, count] of Object.entries(r.bt.summary.byExitReason)) {
        exitMap[reason] = (exitMap[reason] || 0) + count;
      }
    }
    const topExit = Object.entries(exitMap).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([reason, count]) => ({ reason, count }));

    const oorCount = has.filter(r =>
      r.bt.summary?.byExitReason?.["out_of_range"] ||
      r.bt.summary?.byExitReason?.["oor_below_range"]
    ).length;

    return {
      poolsAnalyzed: has.length,
      avgBacktestWinRate: +(avgWr * 100).toFixed(1),
      avgBacktestPnl: +avgPnl.toFixed(2),
      avgActualPnl: avgReal != null ? +avgReal.toFixed(2) : null,
      pnlDiffVsBacktest: diff,
      topExitReasons: topExit,
      oorExposurePct: has.length ? +((oorCount / has.length) * 100).toFixed(1) : null,
    };
  };

  const s7  = aggregate(results7d);
  const s14 = aggregate(results14d);

  // Save
  const file7d  = results7d.length  > 0 ? saveResult({ period: "7d",  s7, results: results7d,  savedAt: new Date().toISOString() }, "7d")  : null;
  const file14d = results14d.length > 0 ? saveResult({ period: "14d", s14, results: results14d, savedAt: new Date().toISOString() }, "14d") : null;

  _l(`Saved: ${file7d?.split("/").pop() ?? "none"} | ${file14d?.split("/").pop() ?? "none"}`);

  // Telegram
  const msg = buildMsg(s7, s14, correlationId);
  await sendMessage(msg).catch(() => {});

  return { s7, s14, file7d, file14d, correlationId };
}