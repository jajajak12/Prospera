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
import cron from "node-cron";

// ── Imports ────────────────────────────────────────────────────────────────────
import { acquireScreeningLock, completeScreeningLock, acquireManagementLock, completeManagementLock } from "./tools/lock-manager.js";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { logWithId, logSkip, shortId, logCycleStart } from "./log-utils.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { getCircuitState } from "./tools/circuit-breaker.js";
import { config, computeDeployAmount, getPositionSizing, calculateCurrentExposure, canOpenNewPosition, checkExposureCap } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getClosedPoolsForBacktest } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, getStateSummary } from "./state.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { runBacktest } from "./backtest.js";
import { runDailyBacktest } from "./tools/daily-backtester.js";

// ── Startup validation ─────────────────────────────────────────────────────────
const lpKey     = process.env.LPAGENT_API_KEY;
const lpKeyBackup = process.env.LPAGENT_API_KEY_BACKUP;
if (!lpKey) {
  console.error("FATAL: LPAGENT_API_KEY not set in .env — cannot start");
  process.exit(1);
}
log("startup", `LPAgent: primary=${lpKey ? "YES (len=" + lpKey.length + ")" : "MISSING"} backup=${lpKeyBackup ? "YES (len=" + lpKeyBackup.length + ")" : "MISSING"}`);

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
let _screeningLastTriggered = 0;
let _exposureHardPausedUntil = 0;

const timers = { managementLastRun: 0, screeningLastRun: 0 };

const POSITION_META_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "position-meta.json");

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopCronJobs() {
  for (const task of _cronTasks) task?.stop?.();
  _cronTasks = [];
}

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── Management Cycle ───────────────────────────────────────────────────────────
export async function runManagementCycle({ silent = false } = {}) {
  const corrId = logCycleStart("management");
  _lastCorrelationId = corrId;
  const _m = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  if (_managementBusy) { _m("management", "Cycle busy — skipped"); return null; }
  if (_screeningBusy) { _m("management", "Screening running — skipped"); return null; }

  const lockResult = acquireManagementLock();
  if (!lockResult.acquired) { _m("management", "Lock not acquired"); return null; }

  const prePositions = await getMyPositions({ force: true }).catch(() => null);

  // Distinguish LPAgent error from truly zero positions
  if (!prePositions || prePositions.error) {
    _m("warn", `LPAgent unavailable — ${prePositions?.error ?? "network error"} — skipping cycle (positions unknown)`);
    logSkip("lpagent_unavailable", { error: prePositions?.error ?? "network_error" }, corrId, "management");
    completeManagementLock();
    return null;
  }

  const preCount = prePositions?.positions?.length ?? 0;
  if (preCount === 0) {
    _m("management", "No open positions");
    logSkip("no_open_positions", {}, corrId);
    if (telegramEnabled()) sendMessage(`Management [${corrId}] — No open positions`).catch(() => {});
    completeManagementLock();
    return null;
  }

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  _m("management", `Starting cycle`, { openPositions: preCount });

  let mgmtReport = null;
  let positions = [];

  try {
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    if (!livePositions || livePositions.error) {
      _m("error", `LPAgent unavailable: ${livePositions?.error ?? "network error"}`);
      completeManagementLock();
      return null;
    }
    positions = livePositions?.positions || [];
    if (positions.length === 0) {
      if (Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
        _m("management", "No positions — triggering screening");
        runScreeningCycle().catch(e => _m("error", `Screening failed: ${e.message}`));
      }
      return null;
    }

    const positionData = positions.map(p => ({ ...p, recall: recallForPool(p.pool) }));

    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) exitMap.set(p.position, exit.reason);
    }

    let positionMeta = {};
    try { if (fs.existsSync(POSITION_META_PATH)) positionMeta = JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8")); } catch { /**/ }

    const actionMap = new Map();
    for (const p of positionData) {
      if (exitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", reason: exitMap.get(p.position) }); continue; }
      if (p.instruction) { actionMap.set(p.position, { action: "INSTRUCTION" }); continue; }
      if (p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) { actionMap.set(p.position, { action: "CLOSE", reason: "stop loss" }); continue; }
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) { actionMap.set(p.position, { action: "CLAIM" }); continue; }
      actionMap.set(p.position, { action: "STAY" });
    }

    const reportLines = positionData.map(p => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
      const pnl = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%";
      return `${p.pair} | PnL: ${pnl} | ${inRange} | ${act.action}`;
    });

    mgmtReport = reportLines.join("\n");

    if (positionData.length > 0) {
      const allBlocks = positionData.map(p => {
        const act = actionMap.get(p.position);
        return `POSITION: ${p.pair}\n  action: ${act.action} | pnl: ${p.pnl_pct}% | fees: $${p.unclaimed_fees_usd}`;
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT REVIEW — ${positionData.length} position(s)
${allBlocks}
RULES: MANDATORY close/claim execute immediately. EVALUATE use judgment.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 512, corrId);

      mgmtReport += `\n\n${content}`;
    }

    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
      runScreeningCycle().catch(e => _m("error", `Screening failed: ${e.message}`));
    }

  } catch (error) {
    _m("error", `Management failed: ${error.message}`);
    mgmtReport = `Failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    _managementLastCompleted = Date.now();
    completeManagementLock();
    if (!silent && telegramEnabled() && mgmtReport) {
      sendMessage(`Management [${corrId}]\n\n${stripThink(mgmtReport)}`).catch(() => {});
    }
  }
  return mgmtReport;
}

// ── Screening Cycle ────────────────────────────────────────────────────────────
export async function runScreeningCycle({ silent = false } = {}) {
  const corrId = logCycleStart("screening");
  _lastCorrelationId = corrId;
  const _s = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  if (_screeningBusy) { log("cron", "Screening skipped — busy"); return null; }

  if (_exposureHardPausedUntil > Date.now()) {
    _s("screening", `HARD CAP pause active`);
    return null;
  }

  const lockResult = acquireScreeningLock();
  if (!lockResult.acquired) { _s("screening", `Lock not acquired`); return null; }

  _screeningBusy = true;
  _screeningLastTriggered = Date.now();

  const _release = () => { completeScreeningLock(); _screeningBusy = false; };

  let prePositions, preBalance, deployAmount;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);

    if (!prePositions || prePositions.error) {
      _s("error", `LPAgent unavailable: ${prePositions?.error ?? "network error"}`);
      _release();
      return null;
    }

    if (prePositions.total_positions >= config.risk.maxPositions) { logSkip("max_positions", {}, corrId); _release(); return null; }
    deployAmount = getPositionSizing(preBalance.sol);
    if (deployAmount === 0) { logSkip("insufficient_balance", {}, corrId); _release(); return null; }

    const currentExposure = calculateCurrentExposure(prePositions.positions);
    const cap = checkExposureCap(currentExposure, preBalance.sol, deployAmount);
    if (cap.level === "hard_pause") {
      _exposureHardPausedUntil = cap.pauseUntil;
      _s("error", "HARD CAP TRIGGERED");
      if (telegramEnabled()) sendMessage(`Screening [${corrId}] — HARD CAP TRIGGERED, pausing entries`).catch(() => {});
      _release(); return null;
    }
  } catch (e) {
    _s("error", `Screening error: ${e.message}`);
    if (telegramEnabled()) sendMessage(`Screening [${corrId}] — Error: ${e.message}`).catch(() => {});
    _release(); return null;
  }

  timers.screeningLastRun = Date.now();
  _s("screening", `Starting cycle | deploy: ${deployAmount} SOL | wallet: ${preBalance.sol} SOL`);

  let screenReport = null;
  try {
    const topResult = await getTopCandidates({ limit: 20, correlationId: corrId }).catch(() => null);
    const candidates = topResult?.candidates || [];
    if (candidates.length === 0) {
      screenReport = "No entry signals";
      if (telegramEnabled()) sendMessage(`Screening [${corrId}] [${new Date().toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit",hour12:false})}] — No entry signals`).catch(() => {});
      _release();
      return screenReport;
    }

    const PENDING_ATH_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "screening-pending.json");
    const activeBinResults = await Promise.allSettled(candidates.map(p => getActiveBin({ pool_address: p.pool })));
    try {
      const pending = {};
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const fib = c.fib_signal;
        const ath = fib?.ath ?? fib?.fibLevels?.swingHigh ?? null;
        const entryPrice = fib?.currentPrice ?? c.price ?? null;
        const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
        if (c.pool && ath && entryPrice && activeBin != null) {
          pending[c.pool] = { ath, entryPrice, binStep: c.bin_step ?? null, activeBinAtScreening: activeBin, fib500: fib?.fibLevels?.fib500 ?? null };
        }
      }
      fs.writeFileSync(PENDING_ATH_PATH, JSON.stringify(pending));
    } catch { /**/ }

    const candidateBlocks = candidates.map((pool, i) => {
      const fib = pool.fib_signal;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      return `POOL: ${pool.name} (${pool.pool})\n  metrics: bin_step=${pool.bin_step}, fee=${pool.fee_pct}%, tvl=$${pool.active_tvl}\n  fib: signal=${fib?.signal} conf=${fib?.confluenceScore?.toFixed(2)} binsBelow=${fib?.binsBelow}\n  active_bin: ${activeBin}`;
    }).join("\n\n");

    const { content } = await agentLoop(`
FIBONACCI SCREENING CYCLE
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CANDIDATES (Fibonacci-confirmed):
${candidateBlocks}

RULES:
1. Pick highest confluenceScore pool with good metrics.
2. bins_above=0 ALWAYS. bins_below from fib_signal.
3. strategy=bid_ask. amount_y=${deployAmount} SOL.
    `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, corrId);

    screenReport = content;

  } catch (error) {
    _s("error", `Screening failed: ${error.message}`);
    screenReport = `Failed: ${error.message}`;
  } finally {
    _release();
    if (!silent && telegramEnabled() && screenReport) {
      const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });
      sendMessage(`Screening [${corrId}] [${ts}]\n\n${stripThink(screenReport)}`).catch(() => {});
    }
  }
  return screenReport;
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy || _screeningBusy) return;
    const lockAge = Date.now() - _managementLastCompleted;
    if (lockAge < 45_000) return;
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, () => {
    runScreeningCycle().catch(e => log("cron_error", `Screening cron failed: ${e.message}`));
  });

  const backtestTask = cron.schedule("0 0 * * *", () => {
    const corrId = shortId();
    runDailyBacktest({ correlationId: corrId, hours: 168 }).catch(e => log("cron_error", `Daily backtest failed: ${e.message}`));
  });

  _cronTasks = [mgmtTask, screenTask, backtestTask];
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
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
    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true }).catch(() => ({ positions: [] }));
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      await sendMessage(result.success ? `Closed ${pos.pair}` : `Close failed: ${JSON.stringify(result)}`);
      return;
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

if (isTTY) {
  // REPL mode — start cron + Telegram polling
  startCronJobs();
  _screeningLastTriggered = 0;
  startPolling(handleTelegram);
  console.log("\nFibonacci LP Agent — Minimal Mode — Running.\nCron: screening + management active.\n");
} else {
  // PM2 / non-TTY mode
  log("startup", "Non-TTY mode — starting cycles.");
  startCronJobs();
  _screeningLastTriggered = 0;
  startPolling(handleTelegram);
}
