/**
 * index.js — Main entry: REPL + cron orchestration + Telegram bot polling
 *
 * Fibonacci LP Agent — deploys DLMM positions on Meteora using
 * Fibonacci retracement + Volume Profile signals.
 *
 * Adapted from Meridian's index.js.
 * Key changes:
 * - Screener uses get_chart_candidates (Fib signal pre-filtered)
 * - Stop loss: -20% OR OOR > 10 bins
 * - Removed: OKX smart money, minTokenFeesSol check, strategy library
 * - Management interval: 3m default (faster for Fib strategy)
 */

import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import readline from "readline";

import {
  acquireScreeningLock, completeScreeningLock,
  acquireManagementLock, completeManagementLock,
  readScreeningLock, readManagementLock,
  isScreeningRunning,
} from "./tools/lock-manager.js";

// ── Sweep proposal helpers ───────────────────────────────────────────────────
function saveSweepProposal(p) {
  fs.writeFileSync(SWEEP_PROPOSAL_PATH, JSON.stringify(p, null, 2));
}
function loadSweepProposal() {
  try { return fs.existsSync(SWEEP_PROPOSAL_PATH) ? JSON.parse(fs.readFileSync(SWEEP_PROPOSAL_PATH, "utf8")) : null; }
  catch { return null; }
}
function clearSweepProposal() {
  if (fs.existsSync(SWEEP_PROPOSAL_PATH)) fs.unlinkSync(SWEEP_PROPOSAL_PATH);
}
function applySweepProposal(proposal) {
  let userCfg = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    userCfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  }
  // Backup sebelum apply
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fs.writeFileSync(
    path.join(__dirname, `user-config.${stamp}.backup.json`),
    JSON.stringify(userCfg, null, 2)
  );
  Object.assign(userCfg, proposal.changes, { _lastAgentTune: new Date().toISOString() });
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  reloadScreeningThresholds();
}
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount, getPositionSizing, calculateCurrentExposure, canOpenNewPosition } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getClosedPoolsForBacktest } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled } from "./telegram.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, getStateSummary } from "./state.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { runBacktest, runBacktestWithSweep } from "./backtest.js";

log("startup", "Fibonacci LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || config.llm.screeningModel}`);

// ═══════════════════════════════════════════
//  HEALTH TRACKING
// ═══════════════════════════════════════════
const _startTime = Date.now();
let _errorCount = 0;
let _lastWalletBalance = null;

// ═══════════════════════════════════════════
//  CRASH RECOVERY — Global Error Handlers
// ═══════════════════════════════════════════
async function gracefulShutdown(reason) {
  log("shutdown", `Graceful shutdown: ${reason}`);
  stopCronJobs();
  stopPolling();
  // State sudah auto-persisted di setiap mutasi — tidak perlu flush manual
  log("shutdown", "Shutdown complete.");
}

process.on("uncaughtException", (err) => {
  _errorCount++;
  log("crash", `uncaughtException: ${err.message}\n${err.stack}`);
  sendMessage(`🚨 Uncaught Exception!\n${err.message}\n\nAgent akan restart otomatis...`).catch(() => {});
  gracefulShutdown("uncaughtException").finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  _errorCount++;
  const msg = reason instanceof Error ? reason.message : String(reason);
  log("crash", `unhandledRejection: ${msg}`);
  sendMessage(`⚠️ Unhandled Rejection!\n${msg}`).catch(() => {});
});

// ═══════════════════════════════════════════
//  HEALTH CHECK HTTP SERVER
// ═══════════════════════════════════════════
function startHealthServer() {
  const PORT = process.env.HEALTH_PORT || 3000;
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0];
    res.setHeader("Content-Type", "application/json");

    if (url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "ok",
        uptime_seconds: Math.floor((Date.now() - _startTime) / 1000),
        last_screening: timers.screeningLastRun ? new Date(timers.screeningLastRun).toISOString() : null,
        last_management: timers.managementLastRun ? new Date(timers.managementLastRun).toISOString() : null,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (url === "/status") {
      const summary = getStateSummary?.() ?? {};
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "running",
        uptime_seconds: Math.floor((Date.now() - _startTime) / 1000),
        open_positions: summary.openPositions ?? null,
        last_screening: timers.screeningLastRun ? new Date(timers.screeningLastRun).toISOString() : null,
        last_management: timers.managementLastRun ? new Date(timers.managementLastRun).toISOString() : null,
        error_count: _errorCount,
        wallet_sol: _lastWalletBalance,
        screening_busy: _screeningBusy,
        management_busy: _managementBusy,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("error", (e) => log("health", `Health server error: ${e.message}`));
  server.listen(PORT, () => log("health", `Health server on port ${PORT}`));
  return server;
}

// Deploy amount is computed dynamically per wallet balance — see getPositionSizing()

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

/** Strip <think>...</think> reasoning blocks */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ═══════════════════════════════════════════
//  CRON STATE
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy          = false;
let _managementLastCompleted = 0;
let _screeningBusy           = false; // in-process guard — synced with lock-manager
let _screeningLastTriggered  = 0;
let _pollTriggeredAt         = 0;

function stopCronJobs() {
  for (const task of _cronTasks) task?.stop?.();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

// ═══════════════════════════════════════════
//  MANAGEMENT CYCLE
// ═══════════════════════════════════════════

export async function runManagementCycle({ silent = false } = {}) {
  // Layer 1: in-memory busy flag — cycle sedang berjalan di proses ini
  if (_managementBusy) {
    log("cron", "Management skipped — cycle sedang berjalan (in-memory busy flag)");
    return null;
  }
  // Layer 2: screening sedang berjalan — tunggu selesai dulu
  if (_screeningBusy) {
    log("cron", "Management skipped — screening cycle sedang berjalan");
    return null;
  }
  // Layer 3: file-based lock via lock-manager
  const lockResult = acquireManagementLock();
  if (!lockResult.acquired) {
    log("cron", `Management skipped — ${lockResult.reason}`);
    return null;
  }

  // Layer 4: timestamp in-memory check
  const msSinceCompleted = Date.now() - _managementLastCompleted;
  const MANAGEMENT_MIN_GAP_MS = 45_000;
  if (_managementLastCompleted > 0 && msSinceCompleted < MANAGEMENT_MIN_GAP_MS) {
    log("cron", `Management skipped — cycle terakhir selesai ${Math.round(msSinceCompleted / 1000)}s lalu (min gap: ${MANAGEMENT_MIN_GAP_MS / 1000}s)`);
    return null;
  }

  // ── Pre-check: skip entire cycle if no open positions ──────────────────
  // Do this BEFORE setting _managementBusy to avoid blocking next cycle
  const prePositions = await getMyPositions({ force: true }).catch(() => null);
  const prePositionCount = prePositions?.positions?.length ?? 0;
  if (prePositionCount === 0) {
    log("cron", "No open positions — skipping management cycle");
    return null;
  }

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", `Starting management cycle (${prePositionCount} open position(s))`);

  const screeningIntervalMs = (config.schedule.screeningIntervalMin || 15) * 60_000;

  let mgmtReport = null;
  let positions = [];

  try {
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    // LPAgent unavailable — skip cycle entirely, do NOT trigger screening
    // (we don't know actual position state, so don't act on stale assumptions)
    if (livePositions?.error) {
      log("cron", `Management cycle skipped — ${livePositions.error}`);
      return null;
    }

    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      if (Date.now() - _screeningLastTriggered > screeningIntervalMs) {
        log("cron", "No open positions — triggering screening cycle");
        runScreeningCycle().catch(e => log("cron_error", `Triggered screening failed: ${e.message}`));
      } else {
        const waitMin = Math.ceil((screeningIntervalMs - (Date.now() - _screeningLastTriggered)) / 60000);
        log("cron", `No open positions — screening cooldown active (${waitMin}m left)`);
      }
      return null;
    }

    // Snapshot + load pool memory
    const positionData = positions.map(p => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP / stop loss check
    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Load position ATH metadata (for OOR new-ATH check) ──────
    let positionMeta = {};
    try {
      if (fs.existsSync(POSITION_META_PATH)) {
        positionMeta = JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8"));
      }
    } catch { /* ignore */ }

    // ── Deterministic rule checks ────────────────────────────────
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Sanity-check PnL
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false;
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("cron_warn", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value`);
          return true;
        }
        return false;
      })();

      // Rule 1: stop loss (-20%)
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 1, reason: "stop loss -20%" });
        continue;
      }
      // Rule 2: hard take profit
      const tpMax = config.management.takeProfitMaxPct ?? config.management.takeProfitFeePct;
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= tpMax) {
        actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: `hard take profit (${p.pnl_pct.toFixed(1)}% >= ${tpMax}%)` });
        continue;
      }
      // Rule 2b: partial harvest — auto-close between soft TP and hard TP
      const ph = config.management.partialHarvestPct;
      if (ph && !pnlSuspect && p.pnl_pct != null && p.pnl_pct >= ph && p.pnl_pct < tpMax) {
        actionMap.set(p.position, { action: "CLOSE", rule: "2b", reason: `partial harvest — locked ${p.pnl_pct.toFixed(1)}% gain (threshold: ${ph}%)` });
        continue;
      }
      // Rule 2c: soft take profit — LLM decides
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        actionMap.set(p.position, { action: "INSTRUCTION", rule: 2, reason: `PnL ${p.pnl_pct.toFixed(1)}% hit soft TP (${config.management.takeProfitFeePct}%). Close to lock gains OR provide reasoning to hold.` });
        continue;
      }
      // Rule 3: pumped far above range — only close if price made new ATH
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        const meta = positionMeta[p.position];
        if (meta?.athBin != null && p.active_bin <= meta.athBin) {
          // OOR above range but still below ATH at entry — price bouncing within Fib framework, hold
          log("management", `${p.pair}: OOR ${p.active_bin - p.upper_bin} bins above range but no new ATH (active=${p.active_bin} ≤ athBin=${meta.athBin}) — holding`);
          actionMap.set(p.position, { action: "STAY" });
          continue;
        }
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: meta?.athBin != null ? "pumped above range — new ATH confirmed" : "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range — only close if price made new ATH
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin &&
          (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
        const meta = positionMeta[p.position];
        if (meta?.athBin != null && p.active_bin <= meta.athBin) {
          // OOR but price hasn't broken above entry ATH — hold, wait for pullback into range
          log("management", `${p.pair}: OOR ${p.minutes_out_of_range}m above range but no new ATH (active=${p.active_bin} ≤ athBin=${meta.athBin}) — holding`);
          actionMap.set(p.position, { action: "STAY" });
          continue;
        }
        actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: meta?.athBin != null ? "OOR — new ATH confirmed" : "OOR stale" });
        continue;
      }
      // Rule 5: crashed below range (Fib 618 broken — stop loss territory)
      if (p.active_bin != null && p.lower_bin != null &&
          p.active_bin < p.lower_bin - config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: "crashed below Fib 618 level — stop loss range" });
        continue;
      }
      // Rule 6: fee yield too low
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= 60) {
        actionMap.set(p.position, { action: "CLOSE", rule: 6, reason: "low yield" });
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Log PnL per position untuk debugging ────────────────────────
    for (const p of positionData) {
      const sign = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
      log("management", `PnL [${p.pair}]: ${sign}${(p.pnl_pct ?? 0).toFixed(2)}% | val=$${p.total_value_usd} | unclaimed=$${p.unclaimed_fees_usd}`);
    }

    // ── Build JS report ────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map(p => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = `$${p.total_value_usd ?? "?"}`;
      const unclaimed = `$${p.unclaimed_fees_usd ?? "?"}`;
      const pnlFmt = p.pnl_pct != null
        ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%`
        : "?%";
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${pnlFmt} | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Exit: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | $${totalValue.toFixed(4)} | fees: $${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM for all positions ─────────────────────────────────
    if (positionData.length > 0) {
      log("cron", `Management: ${positionData.length} position(s) — invoking LLM [model: ${config.llm.managementModel}]`);

      const allBlocks = positionData.map(p => {
        const act = actionMap.get(p.position);
        const forced = act.action === "CLOSE" || act.action === "CLAIM";
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          forced
            ? `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ ${act.reason}` : ""} [MANDATORY — execute immediately]`
            : `  action: EVALUATE — use judgment to close or hold`,
          `  pnl_pct: ${p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%"} | unclaimed_fees_usd: $${p.unclaimed_fees_usd} | value: $${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.recall ? `  pool_memory: ${p.recall}` : null,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT REVIEW — ${positionData.length} position(s)

${allBlocks}

FIBONACCI STOP LOSS RULES:
- PnL <= -20%: STOP LOSS → close immediately
- OOR > ${config.management.outOfRangeBinsToClose} bins below range: price broke Fib 618 support → close
- OOR > ${config.management.outOfRangeWaitMinutes}m: close (support not holding)

RULES:
- MANDATORY actions (CLOSE/CLAIM): execute immediately
- EVALUATE: close if you see clear reason (stop loss near, fib level broken, volume collapsed); or hold if Fib support is intact
- When closing: call close_position only — it handles claiming and auto-swap internally

After acting, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 512);

      mgmtReport += `\n\n${content}`;
    }

    // Trigger screening after management — wait for lock to clear first
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningIntervalMs) {
      const lock = readScreeningLock();
      const lockAge = lock ? Date.now() - lock.ts : Infinity;
      if (lock && lock.status === "running") {
        log("cron", `Post-management: screening still locked (pid ${lock.pid}, ${Math.round(lockAge/1000)}s ago) — waiting`);
        setTimeout(() => {
          if (!(_managementBusy || _screeningBusy)) {
            runScreeningCycle().catch(e => log("cron_error", `Triggered screening failed: ${e.message}`));
          }
        }, Math.max(SCREENING_LOCK_GAP_MS - lockAge + 5000, 5000));
      } else {
        log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
        runScreeningCycle().catch(e => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
    }

  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    _managementLastCompleted = Date.now();
    completeManagementLock(); // tulis timestamp selesai — TIDAK menghapus file
    if (!silent && telegramEnabled()) {
      if (mgmtReport) sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => {});
      for (const p of positions) {
        if (!p.in_range && (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
        }
      }
    }
  }
  return mgmtReport;
}

// ═══════════════════════════════════════════
//  SCREENING CYCLE
// ═══════════════════════════════════════════
export async function runScreeningCycle({ silent = false, force = false } = {}) {
  // Layer 1: in-memory busy flag
  if (_screeningBusy) {
    log("cron", "Screening skipped — cycle sedang berjalan (_screeningBusy flag)");
    return null;
  }
  // Layer 2: file-based lock via lock-manager
  const lockResult = acquireScreeningLock();
  if (!lockResult.acquired) {
    log("cron", `Screening skipped — ${lockResult.reason}`);
    return null;
  }

  _screeningBusy = true;
  _screeningLastTriggered = Date.now();

  // Release lock helper; used by all early-return paths
  const _releaseAndSkip = (msg) => {
    completeScreeningLock();
    _screeningBusy = false;
    if (msg) log("cron", msg);
    return null;
  };

  let prePositions, preBalance, deployAmount;
  try {
    [prePositions, preBalance] = await Promise.all([
      getMyPositions({ force: true }),
      getWalletBalances(),
    ]);
    if (preBalance?.sol != null) _lastWalletBalance = preBalance.sol;

    // ── Max positions check ───────────────────────────────────────────────
    if (prePositions.total_positions >= config.risk.maxPositions) {
      return _releaseAndSkip(`Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
    }

    // ── Deploy sizing (tiered) ────────────────────────────────────────────
    deployAmount = getPositionSizing(preBalance.sol);
    if (deployAmount === 0) {
      return _releaseAndSkip(`Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} SOL, need at least ${(config.risk.exposureGasReserve ?? 1) + 1} SOL)`);
    }

    // ── Exposure cap check (50%) ──────────────────────────────────────────
    const currentExposure = calculateCurrentExposure(prePositions.positions);
    const exposureCheck   = canOpenNewPosition(deployAmount, currentExposure, preBalance.sol);
    if (!exposureCheck.allowed) {
      log("cron", `Screening skipped — ${exposureCheck.reason}`, {
        currentExposure: currentExposure.toFixed(2),
        maxExposure: exposureCheck.maxExposureSol.toFixed(2),
        proposed: deployAmount,
      });
      return _releaseAndSkip(null);
    }
    log("cron", `Exposure check OK: ${currentExposure.toFixed(2)}→${exposureCheck.projectedExposureSol.toFixed(2)} SOL (${exposureCheck.exposurePct}% of ${(preBalance.sol - (config.risk.exposureGasReserve ?? 1)).toFixed(2)} SOL deployable)`);
  } catch (e) {
    return _releaseAndSkip(`Screening pre-check failed: ${e.message}`);
  }

  timers.screeningLastRun = Date.now();
  log("cron", `Starting Fibonacci screening cycle [model: ${config.llm.screeningModel}]`);
  log("cron", `Deploy amount: ${deployAmount} SOL (wallet: ${preBalance.sol} SOL)`);
  let screenReport = null;
  let topResult    = null;

  try {

    // Fetch Fibonacci-filtered candidates
    topResult = await getTopCandidates({ limit: 20 }).catch(() => null);
    const candidates = topResult?.candidates || [];

    // If GeckoTerminal returned nothing (rate limit / network), allow retry in 60s
    // (partial reset — not full 0, to avoid double-fire on management's next tick)
    if ((topResult?.total_screened ?? 0) === 0) {
      _screeningLastTriggered = Date.now() - (config.schedule.screeningIntervalMin * 60 * 1000) + 60_000;
      log("cron", "Screening aborted — discovery returned 0 tokens, retry in 60s");
      return null; // finally releases lock
    }

    if (candidates.length === 0) {
      screenReport = "No entry signals (failed EMA/RSI/Fib filters)";
      return screenReport; // finally releases lock + sends Telegram
    }

    // ── Auto-backtest pre-deploy filter ────────────────────────────────────
    if (config.screening.autoBacktest) {
      const targetAgg   = config.screening.backtestAggregate ?? 15;
      const minWinRate  = config.screening.minBacktestWinRate ?? 0.50;
      log("cron", `Auto-backtest: testing ${candidates.length} candidate(s) (agg=${targetAgg}m, minWR=${(minWinRate*100).toFixed(0)}%)...`);

      const btResults = await Promise.allSettled(
        candidates.map(async (pool) => {
          let result = null;
          for (const agg of [targetAgg, 5, 1]) {
            try {
              result = await runBacktest({
                poolAddress:  pool.pool,
                binStep:      pool.bin_step,
                feePct:       pool.fee_pct,
                aggregate:    agg,
                candleLimit:  500,
              });
              if (result && result.totalTrades >= 3) break;
            } catch { result = null; }
          }
          return { poolAddr: pool.pool, result };
        })
      );

      const preCount = candidates.length;
      const passed = candidates.filter((pool, i) => {
        const r = btResults[i];
        if (r.status !== "fulfilled" || !r.value?.result) {
          log("cron", `Auto-backtest: ${pool.name} — fetch failed, keeping`);
          return true;
        }
        const { totalTrades, winRate, avgPnlPct } = r.value.result;
        if (totalTrades < 3) {
          log("cron", `Auto-backtest: ${pool.name} — insufficient history (${totalTrades} trades), keeping`);
          return true;
        }
        const ok = winRate >= minWinRate;
        log("cron", `Auto-backtest: ${pool.name} — WR=${(winRate*100).toFixed(0)}% avgPnL=${avgPnlPct?.toFixed(1)}% (${totalTrades}t) → ${ok ? "PASS" : "REJECT"}`);
        if (ok) pool._backtest = r.value.result;
        return ok;
      });

      const removed = preCount - passed.length;
      if (removed > 0) log("cron", `Auto-backtest: filtered ${removed}/${preCount} low win-rate pool(s)`);
      candidates.length = 0;
      passed.forEach(c => candidates.push(c));

      if (candidates.length === 0) {
        screenReport = `Auto-backtest filtered all ${preCount} candidate(s) — win rate below ${(minWinRate*100).toFixed(0)}% threshold.`;
        return screenReport; // finally will still run: lock released + Telegram sent
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // Pre-fetch active_bin for all candidates in parallel
    const activeBinResults = await Promise.allSettled(
      candidates.map(p => getActiveBin({ pool_address: p.pool }))
    );

    // Persist pool→ATH metadata so executor can save ath_bin per position after deploy
    const PENDING_ATH_PATH = path.join(__dirname, "screening-pending.json");
    try {
      const pending = {};
      for (let i = 0; i < candidates.length; i++) {
        const c   = candidates[i];
        const fib = c.fib_signal;
        const ath        = fib?.ath ?? fib?.fibLevels?.swingHigh ?? null;
        const entryPrice = fib?.currentPrice ?? c.price ?? null;
        const activeBin  = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
        if (c.pool && ath && entryPrice && activeBin != null) {
          pending[c.pool] = {
            ath, entryPrice, binStep: c.bin_step ?? null, activeBinAtScreening: activeBin,
            fib500: fib?.fibLevels?.fib500 ?? null, // deploy-time fib500 gate in executor.js
          };
        }
      }
      fs.writeFileSync(PENDING_ATH_PATH, JSON.stringify(pending));
    } catch { /* non-fatal */ }

    // Build candidate blocks for LLM
    const candidateBlocks = candidates.map((pool, i) => {
      const fib = pool.fib_signal;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      const mem = recallForPool(pool.pool);

      const fibStr = fib ? [
        `signal=${fib.signal}`,
        `confluenceScore=${fib.confluenceScore?.toFixed(2) ?? "?"}`,
        `binsBelow=${fib.binsBelow}`,
        `pricePosition=${fib.pricePosition != null ? (fib.pricePosition * 100).toFixed(0) + "%" : "?"}`,
        fib.fibLevels ? `fib618=${fib.fibLevels.fib618?.toPrecision(6)} fib236=${fib.fibLevels.fib236?.toPrecision(6)}` : null,
        fib.poc ? `poc=${fib.poc.toPrecision(6)} val=${fib.val?.toPrecision(6)}` : null,
      ].filter(Boolean).join(" | ") : "no signal";

      return [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol5m=$${pool._vol5m ?? pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
        `  fib: ${fibStr}`,
        `  price: ${pool.price} | change: ${pool.price_change_pct}% | trend: ${pool.price_trend ?? "?"}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        pool._backtest ? `  backtest: winRate=${(pool._backtest.winRate*100).toFixed(0)}% avgPnL=${pool._backtest.avgPnlPct?.toFixed(1)}% trades=${pool._backtest.totalTrades}` : null,
        mem ? `  memory: ${mem}` : null,
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const { content } = await agentLoop(`
FIBONACCI SCREENING CYCLE
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

ALL CANDIDATES HAVE PASSED FIBONACCI SIGNAL FILTER.
Sorted by confluenceScore (highest first = best signal quality).

PRE-LOADED CANDIDATES (${candidates.length} pools, Fib-confirmed):
${candidateBlocks}

DEPLOY RULES:
1. Pick the pool with highest confluenceScore among those with good pool metrics.
2. Use fib_signal.binsBelow EXACTLY — this is pre-calculated to cover fib_618 level.
3. bins_above = 0 ALWAYS.
4. strategy = "bid_ask" ALWAYS.
5. amount_y = ${deployAmount} SOL (use this exact amount).
6. active_bin is pre-fetched above — no need to call get_active_bin.
7. Pass: pool_address, amount_y=${deployAmount}, strategy="bid_ask", bins_below=<from fib_signal>, bins_above=0, pool_name, bin_step, volatility, fee_tvl_ratio, organic_score, mcap.

ADDITIONAL CHECKS (disqualify if):
- price_trend is strongly downward AND confluenceScore < 0.5 (may break below fib_618)
- Pool memory shows recent losses without recovery

After deploying, report:
Deployed: PAIR
bin_step=X | binsBelow=X | confluenceScore=X | fee=X%
fib618=X | fib236=X | poc=X
reason: <one sentence why this over others>
    `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048);

    screenReport = content;

  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    completeScreeningLock(); // release file lock via lock-manager
    _screeningBusy = false;  // release in-process guard
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        const _ts  = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });
        const _tot = topResult?.total_screened    ?? 0;
        const _vol = topResult?.after_volume_count ?? 0;
        const _mtr = topResult?.withPool_count     ?? 0;
        const _hdr = `🔍 Fibonacci Screening [${_ts}]\nDiscovered: ${_tot} | After volume: ${_vol} | Meteora pools: ${_mtr}\n\n`;
        sendMessage(`${_hdr}${stripThink(screenReport)}`).catch(() => {});
      }
    }
  }
  return screenReport;
}

// ═══════════════════════════════════════════
//  PERIODIC BACKTEST (02:00 daily)
// ═══════════════════════════════════════════
async function runPeriodicBacktest() {
  log("cron", "Periodic backtest starting...");

  const pools = getClosedPoolsForBacktest({ hours: 168, limit: 8 });
  if (pools.length === 0) {
    log("cron", "Periodic backtest: no closed pools in last 7 days — skipping");
    return;
  }

  const results = [];
  for (const p of pools) {
    let bt = null; let sweepBest = null; let sweepAll = [];
    for (const agg of [15, 5, 1]) {
      try {
        const res = await runBacktestWithSweep({ poolAddress: p.pool, binStep: p.bin_step, feePct: p.fee_pct, aggregate: agg, candleLimit: 200 });
        bt = res.backtest; sweepBest = res.sweepBest; sweepAll = res.sweepAll ?? [];
        if (bt && bt.totalTrades >= 3) break;
      } catch { bt = null; sweepBest = null; }
    }
    results.push({ ...p, bt, sweepBest, sweepAll });
  }

  // ── Build suggestions ───────────────────────────────────────────────────────
  const withData    = results.filter(r => r.bt && r.bt.totalTrades >= 3);
  const suggestions = [];

  if (withData.length > 0) {
    const avgBtWr = withData.reduce((s, r) => s + r.bt.winRate, 0) / withData.length;

    // Suggest raising minBacktestWinRate if most pools backtest poorly
    if (avgBtWr < 0.45 && !config.screening.autoBacktest) {
      suggestions.push(`Aktifkan auto-backtest filter (WR rata-rata: ${(avgBtWr*100).toFixed(0)}%)`);
    }

    // Suggest bin_step focus if one range clearly outperforms
    const byStep = {};
    for (const r of withData) {
      const bucket = r.bin_step <= 100 ? "80–100" : r.bin_step <= 150 ? "100–150" : "150–200";
      if (!byStep[bucket]) byStep[bucket] = [];
      byStep[bucket].push(r.bt.winRate);
    }
    let bestBucket = null, bestWr = 0;
    for (const [bucket, wrs] of Object.entries(byStep)) {
      const avg = wrs.reduce((a, b) => a + b, 0) / wrs.length;
      if (avg > bestWr) { bestWr = avg; bestBucket = bucket; }
    }
    if (bestBucket && bestWr > 0.60) {
      suggestions.push(`Bin step ${bestBucket} unggul (WR ${(bestWr*100).toFixed(0)}%) — pertimbangkan fokuskan range bin step`);
    }

    // Suggest stop loss tightening if many stop-loss exits
    const slHits = withData.filter(r => r.close_reason === "stop_loss").length;
    if (slHits >= Math.ceil(withData.length * 0.5)) {
      suggestions.push(`${slHits}/${withData.length} posisi kena stop loss — pertimbangkan perketat confluence`);
    }

    // Parameter sweep recommendation — aggregate best params across all pools
    const sweepable = withData.filter(r => r.sweepBest);
    if (sweepable.length >= 2) {
      const curRsi  = config.screening.rsiMin          ?? 48;
      const curConf = config.screening.minConfluenceScore ?? 0.30;

      // Vote tally
      const rsiVotes = {}, confVotes = {};
      for (const r of sweepable) {
        rsiVotes[r.sweepBest.rsiMin]             = (rsiVotes[r.sweepBest.rsiMin]             || 0) + 1;
        confVotes[r.sweepBest.minConfluenceScore] = (confVotes[r.sweepBest.minConfluenceScore] || 0) + 1;
      }
      const bestRsi  = Object.entries(rsiVotes).sort((a, b) => b[1] - a[1])[0];
      const bestConf = Object.entries(confVotes).sort((a, b) => b[1] - a[1])[0];
      const majority = Math.ceil(sweepable.length * 0.5);

      // WR improvement: average (sweepBest.winRate - baseline.winRate) across pools
      const avgWrImprovement = sweepable.reduce((s, r) => s + (r.sweepBest.winRate - r.bt.winRate), 0) / sweepable.length;
      const MIN_WR_IMPROVEMENT = 0.07; // +7%

      const proposed = {};

      // RSI: majority consensus + WR improvement + max ±4 pts per run
      if (bestRsi && bestRsi[1] >= majority && avgWrImprovement >= MIN_WR_IMPROVEMENT) {
        const raw   = Number(bestRsi[0]);
        const delta = Math.max(-4, Math.min(4, raw - curRsi));
        const clamped = curRsi + delta;
        if (clamped !== curRsi) {
          proposed.rsiMin = clamped;
          suggestions.push(`Sweep: RSI min ${curRsi} → ${clamped} (konsensus ${bestRsi[1]}/${sweepable.length}, WR +${(avgWrImprovement*100).toFixed(0)}%)`);
        }
      } else if (bestRsi && Number(bestRsi[0]) !== curRsi) {
        const reason = bestRsi[1] < majority
          ? `konsensus lemah (${bestRsi[1]}/${sweepable.length})`
          : `WR improvement +${(avgWrImprovement*100).toFixed(0)}% < 7%`;
        suggestions.push(`Sweep: RSI min ${curRsi} → ${bestRsi[0]} — ${reason}, tidak di-apply`);
      }

      // Confluence: majority consensus + WR improvement + max ±0.05 per run
      if (bestConf && bestConf[1] >= majority && avgWrImprovement >= MIN_WR_IMPROVEMENT) {
        const raw   = Number(bestConf[0]);
        const delta = Math.max(-0.05, Math.min(0.05, raw - curConf));
        const clamped = Math.round((curConf + delta) * 100) / 100;
        if (Math.abs(clamped - curConf) >= 0.01) {
          proposed.minConfluenceScore = clamped;
          suggestions.push(`Sweep: confluence min ${curConf} → ${clamped} (konsensus ${bestConf[1]}/${sweepable.length}, WR +${(avgWrImprovement*100).toFixed(0)}%)`);
        }
      } else if (bestConf && Math.abs(Number(bestConf[0]) - curConf) >= 0.05) {
        const reason = bestConf[1] < majority
          ? `konsensus lemah (${bestConf[1]}/${sweepable.length})`
          : `WR improvement +${(avgWrImprovement*100).toFixed(0)}% < 7%`;
        suggestions.push(`Sweep: confluence min ${curConf} → ${bestConf[0]} — ${reason}, tidak di-apply`);
      }

      // Send Telegram preview + save proposal (user must confirm via /apply_sweep)
      if (Object.keys(proposed).length > 0) {
        const proposal = {
          changes: proposed,
          curRsi, curConf,
          avgWrImprovement: +avgWrImprovement.toFixed(3),
          pools: sweepable.length,
          createdAt: new Date().toISOString(),
        };
        saveSweepProposal(proposal);
        const previewLines = Object.entries(proposed).map(([k, v]) => {
          const cur = k === "rsiMin" ? curRsi : curConf;
          return `  ${k}: ${cur} → ${v}`;
        });
        await sendMessage(
          `🔬 Sweep proposal (WR +${(avgWrImprovement*100).toFixed(0)}%, ${sweepable.length} pools):\n` +
          previewLines.join("\n") + "\n\n" +
          `Ketik /apply_sweep untuk apply, /reject_sweep untuk batalkan.\n` +
          `Config lama akan di-backup otomatis sebelum di-apply.`
        ).catch(() => {});
        log("cron", `Sweep proposal saved: ${JSON.stringify(proposed)}`);
      }
    }

    if (suggestions.length === 0) {
      suggestions.push("Tidak ada perubahan yang disarankan — strategi berjalan sesuai ekspektasi");
    }
  }

  // ── Build Telegram message ──────────────────────────────────────────────────
  const lines = results.map(r => {
    if (!r.bt || r.bt.totalTrades < 3) return `  • ${r.pool_name} — data tidak cukup`;
    const wr   = `WR ${(r.bt.winRate*100).toFixed(0)}%`;
    const avg  = `avgPnL ${r.bt.avgPnlPct?.toFixed(1)}%`;
    const act  = r.actual_pnl != null ? ` | live ${r.actual_pnl >= 0 ? "+" : ""}${r.actual_pnl.toFixed(1)}%` : "";
    const best = r.sweepBest ? ` | best: RSI${r.sweepBest.rsiMin} conf${r.sweepBest.minConfluenceScore}` : "";
    return `  • ${r.pool_name} — ${wr} ${avg} (${r.bt.totalTrades}t)${act}${best}`;
  });

  const msg =
    `📊 Periodic Backtest (7 hari terakhir)\n\n` +
    `Pool ditest: ${pools.length} | Data cukup: ${withData.length}\n\n` +
    lines.join("\n") +
    `\n\n💡 Saran:\n` +
    suggestions.map(s => `  • ${s}`).join("\n");

  await sendMessage(msg).catch(() => {});
  log("cron", `Periodic backtest done — ${withData.length}/${pools.length} pools had data`);
}

// ═══════════════════════════════════════════
//  CRON SCHEDULER
// ═══════════════════════════════════════════
export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    async () => {
      if (_managementBusy) {
        log("cron", "Management cron fired — skipped (in-memory busy flag aktif)");
        return;
      }
      if (_screeningBusy) {
        log("cron", "Management cron fired — skipped (screening sedang berjalan)");
        return;
      }
      const lock = readManagementLock();
      if (!lock) {
        await runManagementCycle();
        return;
      }
      const lockAge = Date.now() - lock.ts;
      const MANAGEMENT_MIN_GAP_MS = 45_000;
      if (lockAge < MANAGEMENT_MIN_GAP_MS) {
        log("cron", `Management cron fired — skipped (lock file: ${Math.round(lockAge / 1000)}s lalu < ${MANAGEMENT_MIN_GAP_MS / 1000}s min gap)`);
        return;
      }
      await runManagementCycle();
    }
  );

  const screenTask = cron.schedule(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    runScreeningCycle
  );

  // Lightweight 30s PnL poller — cek exit alerts antara management cycles
  // Hanya trigger management jika ada exit alert DAN management belum jalan dalam 45s terakhir
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length || result?.error) return;
      for (const p of result.positions) {
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          const lock = readManagementLock();
          const lockAge = lock ? Date.now() - lock.ts : Infinity;
          const MANAGEMENT_MIN_GAP_MS = 45_000;
          if (lockAge >= MANAGEMENT_MIN_GAP_MS) {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management (lock age: ${Math.round(lockAge / 1000)}s)`);
            runManagementCycle({ silent: true }).catch(e => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — skipped (lock age: ${Math.round(lockAge / 1000)}s < ${MANAGEMENT_MIN_GAP_MS / 1000}s)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  // Morning briefing — runs at 08:00 server time every day
  const briefingTask = cron.schedule("0 8 * * *", async () => {
    try {
      const [positions, balance] = await Promise.all([
        getMyPositions({ force: true }).catch(() => ({ positions: [], total_positions: 0 })),
        getWalletBalances().catch(() => null),
      ]);
      const { getPerformanceSummary, getLessonsForPrompt } = await import("./lessons.js");
      const perf   = getPerformanceSummary();
      const walletSol  = balance?.sol ?? 0;
      const deploy     = getPositionSizing(walletSol);
      const exposure   = calculateCurrentExposure(positions.positions ?? []);
      const gasReserve = config.risk.exposureGasReserve ?? 1.0;
      const capPct     = config.risk.totalExposureCapPct ?? 0.50;
      const maxExposure = Math.max(0, walletSol - gasReserve) * capPct;

      const posLines = positions.positions?.length
        ? positions.positions.map(p => {
            const pnl  = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(1)}%` : "?";
            const fees = p.unclaimed_fees_usd != null ? ` | fees $${p.unclaimed_fees_usd.toFixed(2)}` : "";
            const oor  = !p.in_range ? " ⚠️OOR" : "";
            return `  • ${p.pair} — PnL: ${pnl}${fees}${oor}`;
          }).join("\n")
        : "  No open positions";

      const perfLines = perf
        ? `Closed: ${perf.total ?? 0} | WR: ${perf.win_rate ?? "?"}% | Avg PnL: ${perf.avg_pnl_pct != null ? (perf.avg_pnl_pct >= 0 ? "+" : "") + perf.avg_pnl_pct.toFixed(1) + "%" : "?"}`
        : "No closed positions yet";

      const msg =
        `☀️ Morning Briefing — ${new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" })}\n\n` +
        `💰 Wallet: ${walletSol.toFixed(3)} SOL | Deploy: ${deploy} SOL/position\n` +
        `📉 Exposure: ${exposure.toFixed(2)}/${maxExposure.toFixed(2)} SOL (${((exposure / Math.max(maxExposure, 0.001)) * 100).toFixed(0)}% cap)\n` +
        `📊 Open Positions (${positions.total_positions ?? 0}/${config.risk.maxPositions}):\n${posLines}\n\n` +
        `📈 Performance: ${perfLines}\n\n` +
        `⚙️ Strategy: ${config.screening.minBinStep}–${config.screening.maxBinStep} bin step | ` +
        `Vol min $${config.screening.minVolume.toLocaleString()} | ` +
        `SL ${config.management.stopLossPct}% / TP ${config.management.takeProfitMaxPct}%`;

      await sendMessage(msg);
      log("cron", "Morning briefing sent");
    } catch (e) {
      log("cron_error", `Morning briefing failed: ${e.message}`);
    }
  });

  // Periodic backtest — runs at 02:00 server time every day
  const backtestTask = cron.schedule("0 2 * * *", () => {
    runPeriodicBacktest().catch(e => log("cron_error", `Periodic backtest failed: ${e.message}`));
  });

  _cronTasks = [mgmtTask, screenTask, briefingTask, backtestTask];
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No Fibonacci entry signals found right now.";

  const lines = candidates.map((p, i) => {
    const name   = (p.name || "unknown").padEnd(20);
    const score  = `${p.fib_signal?.confluenceScore?.toFixed(2) ?? "?"}`.padStart(6);
    const vol    = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const bins   = String(p.fib_signal?.binsBelow ?? "?").padStart(5);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  confScore:${score}  vol:${vol}  bins:${bins}  organic:${org}`;
  });

  return [
    "  #   pool                  confScore    vol     bins  organic",
    "  " + "─".repeat(65),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = [];
const sessionHistory = [];
const MAX_HISTORY = 20;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user",      content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun  = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup ──────────────────────────────────────────────────────
  console.log(`
╔═══════════════════════════════════════════╗
║      Fibonacci LP Agent — Ready           ║
╚═══════════════════════════════════════════╝
`);
  console.log("Fetching wallet and Fibonacci candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, fibResult] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 10 }).catch(() => ({ candidates: [], total_screened: 0, fib_analyzed: 0 })),
    ]);

    startupCandidates = fibResult.candidates || [];

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    const total   = fibResult.total_screened ?? 0;
    const analyzed = fibResult.fib_analyzed ?? 0;
    const passed   = startupCandidates.length;
    console.log(`Fibonacci signals: ${passed} entry / ${analyzed} analyzed / ${total} screened:\n`);
    console.log(formatCandidates(startupCandidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  launchCron();

  // ── Telegram queue drain ─────────────────────────────────────────
  async function drainTelegramQueue() {
    while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
      const queued = _telegramQueue.shift();
      await telegramHandler(queued);
    }
  }

  async function telegramHandler(text) {
    if (_managementBusy || _screeningBusy || busy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(text);
        sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
      } else {
        sendMessage("Queue is full. Wait for the agent to finish.").catch(() => {});
      }
      return;
    }

    if (text === "/positions") {
      try {
        const { positions, total_positions } = await getMyPositions({ force: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const lines = positions.map((p, i) => {
          const pnl = p.pnl_usd >= 0 ? `+$${p.pnl_usd}` : `-$${Math.abs(p.pnl_usd)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | $${p.total_value_usd} | PnL: ${pnl} | fees: $${p.unclaimed_fees_usd} | ${age}${oor}`;
        });
        await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({ position_address: pos.position });
        if (result.success) {
          await sendMessage(`✅ Closed ${pos.pair}\nPnL: $${result.pnl_usd ?? "?"} | txs: ${result.txs?.join(", ")}`);
        } else {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, note);
        await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (text === "/status") {
      try {
        const [wallet, { positions, total_positions }] = await Promise.all([
          getWalletBalances().catch(() => null),
          getMyPositions({ force: true }).catch(() => ({ positions: [], total_positions: 0 })),
        ]);
        const uptime  = Math.floor((Date.now() - _startTime) / 1000);
        const uptimeStr = uptime < 3600 ? `${Math.floor(uptime/60)}m` : `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;
        const mgmt = timers.managementLastRun ? `${Math.floor((Date.now()-timers.managementLastRun)/60000)}m ago` : "belum";
        const scrn = timers.screeningLastRun  ? `${Math.floor((Date.now()-timers.screeningLastRun)/60000)}m ago` : "belum";
        const posLines = total_positions === 0
          ? "  Tidak ada posisi terbuka"
          : positions.map((p, i) => {
              const pnl = p.pnl_usd >= 0 ? `+$${p.pnl_usd}` : `-$${Math.abs(p.pnl_usd)}`;
              return `  ${i+1}. ${p.pair} | ${pnl} | ${p.in_range ? "in range" : "⚠️ OOR"}`;
            }).join("\n");
        await sendMessage(
          `📡 Agent Status\n\n` +
          `Uptime: ${uptimeStr}\n` +
          `Wallet: ${wallet ? `${wallet.sol} SOL ($${wallet.sol_usd})` : "?"}\n` +
          `Errors: ${_errorCount}\n\n` +
          `Posisi (${total_positions}):\n${posLines}\n\n` +
          `Management: ${mgmt}\n` +
          `Screening: ${scrn}`
        );
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (text === "/apply_sweep") {
      const proposal = loadSweepProposal();
      if (!proposal) { await sendMessage("Tidak ada sweep proposal yang pending."); return; }
      try {
        applySweepProposal(proposal);
        clearSweepProposal();
        const lines = Object.entries(proposal.changes).map(([k, v]) => `  ${k}: ${v}`);
        await sendMessage(`✅ Sweep applied:\n${lines.join("\n")}\n\nConfig lama sudah di-backup.`);
        log("telegram", `Sweep applied by user: ${JSON.stringify(proposal.changes)}`);
      } catch (e) {
        await sendMessage(`❌ Apply gagal: ${e.message}`);
      }
      return;
    }

    if (text === "/reject_sweep") {
      const proposal = loadSweepProposal();
      if (!proposal) { await sendMessage("Tidak ada sweep proposal yang pending."); return; }
      clearSweepProposal();
      await sendMessage("❌ Sweep proposal dibatalkan.");
      log("telegram", "Sweep proposal rejected by user");
      return;
    }

    // /backtest [7d|30d|all] — on-demand periodic backtest
    const btMatch = text.match(/^\/backtest(?:\s+(7d|30d|all))?$/i);
    if (btMatch) {
      const range = (btMatch[1] || "7d").toLowerCase();
      const hours = range === "30d" ? 720 : range === "all" ? 99999 : 168;
      const label = range === "30d" ? "30 hari" : range === "all" ? "semua waktu" : "7 hari";
      await sendMessage(`🔄 Menjalankan backtest (${label})...`);
      const saved = getClosedPoolsForBacktest({ hours, limit: 8 });
      if (saved.length === 0) {
        await sendMessage(`Belum ada pool yang ditutup dalam ${label}.`);
        return;
      }
      await runPeriodicBacktest().catch(e => sendMessage(`Error: ${e.message}`).catch(() => {}));
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, config.llm.generalModel);
      appendHistory(text, content);
      await sendMessage(stripThink(content));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
      drainTelegramQueue().catch(() => {});
    }
  }

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy into that Fib-confirmed pool (amount based on wallet balance)
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh Fibonacci candidates list
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /backtest [7d|30d|all]  Run periodic backtest on recently closed pools
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick ─────────────────────────────────────────────────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        const bins = pool.fib_signal?.binsBelow ?? 69;
        const bal  = await getWalletBalances();
        const amt  = getPositionSizing(bal.sol);
        console.log(`\nDeploying ${amt} SOL into ${pool.name} (bins_below=${bins})...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${amt} SOL into pool ${pool.pool} (${pool.name}). ` +
          `Use bins_below=${bins} (pre-calculated Fibonacci bins to fib_618 level), bins_above=0, strategy=bid_ask. ` +
          `Call deploy_position directly — active_bin is pre-fetched: use fib_signal data. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto ────────────────────────────────────────────────────────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        const bal = await getWalletBalances();
        const amt = getPositionSizing(bal.sol);
        console.log("\nAgent running Fibonacci screening and deploying...\n");
        const { content: reply } = await agentLoop(
          `Call get_chart_candidates, pick the best Fibonacci signal, deploy_position with ${amt} SOL. Execute now.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    if (input.toLowerCase() === "go") { launchCron(); rl.prompt(); return; }
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const fibResult = await getTopCandidates({ limit: 10 }).catch(() => ({ candidates: [], total_screened: 0, fib_analyzed: 0 }));
        startupCandidates = fibResult.candidates || [];
        console.log(`\nFibonacci signals: ${startupCandidates.length} entry / ${fibResult.fib_analyzed ?? 0} analyzed:\n`);
        console.log(formatCandidates(startupCandidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minOrganic:      ${s.minOrganic}`);
      console.log(`  minHolders:      ${s.minHolders}`);
      console.log(`  minTvl:          ${s.minTvl}`);
      console.log(`  maxTvl:          ${s.maxTvl}`);
      console.log(`  minVolume:       ${s.minVolume}`);
      console.log(`  minBinStep:      ${s.minBinStep}`);
      console.log(`  maxBinStep:      ${s.maxBinStep}`);
      console.log(`  candleLimit:     ${s.candleLimit}`);
      console.log(`  fibConfluence:   ${s.fibConfluenceRequired}`);
      console.log(`  stopLossPct:     ${config.management.stopLossPct}%`);
      console.log(`  oorBinsToClose:  ${config.management.outOfRangeBinsToClose} bins`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — defaults active.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[`binsByStep_${Object.keys(val || {})[0]}`] || JSON.stringify(val)}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────────────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY (pm2) mode — start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startHealthServer();
  startCronJobs();
  // Reset so first cron tick always passes screening cooldown
  _screeningLastTriggered = 0;
  // Cron jobs handle everything — no manual setTimeout triggers needed.
  // Lock-manager stale detection ensures previous-process locks are ignored.

  // Telegram handler for non-TTY mode
  const _nonTtyQueue = [];
  async function nonTtyDrainQueue() {
    while (_nonTtyQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
      const queued = _nonTtyQueue.shift();
      await nonTtyTelegramHandler(queued);
    }
  }

  async function nonTtyTelegramHandler(text) {
    if (_managementBusy || _screeningBusy || busy) {
      if (_nonTtyQueue.length < 5) {
        _nonTtyQueue.push(text);
        sendMessage(`⏳ Queued: "${text.slice(0, 60)}"`).catch(() => {});
      } else {
        sendMessage("Queue is full. Wait for the agent to finish.").catch(() => {});
      }
      return;
    }

    if (text === "/positions") {
      try {
        const { positions, total_positions } = await getMyPositions({ force: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const lines = positions.map((p, i) => {
          const pnl = p.pnl_usd >= 0 ? `+$${p.pnl_usd}` : `-$${Math.abs(p.pnl_usd)}`;
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | $${p.total_value_usd} | PnL: ${pnl}${oor}`;
        });
        await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> | /set <n> <note>`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number."); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({ position_address: pos.position });
        if (result.success) {
          await sendMessage(`✅ Closed ${pos.pair}\nPnL: $${result.pnl_usd ?? "?"}`);
        } else {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number."); return; }
        setPositionInstruction(positions[idx].position, note);
        await sendMessage(`✅ Note set for ${positions[idx].pair}: "${note}"`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    // Free-form chat via LLM
    busy = true;
    try {
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, [], agentRole, config.llm.generalModel);
      await sendMessage(stripThink(content));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      nonTtyDrainQueue().catch(() => {});
    }
  }

  startPolling(nonTtyTelegramHandler);
}
