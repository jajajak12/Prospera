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
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled } from "./telegram.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits } from "./state.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";

log("startup", "Fibonacci LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || config.llm.screeningModel}`);

const DEPLOY = config.management.deployAmountSol;

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
let _managementBusy = false;
let _screeningBusy = false;
let _screeningLastTriggered = 0;
let _pollTriggeredAt = 0;

function stopCronJobs() {
  for (const task of _cronTasks) task?.stop?.();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

// ═══════════════════════════════════════════
//  MANAGEMENT CYCLE
// ═══════════════════════════════════════════
export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");

  let mgmtReport = null;
  let positions = [];
  const screeningCooldownMs = config.schedule.screeningIntervalMin * 60 * 1000;

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
      if (Date.now() - _screeningLastTriggered > screeningCooldownMs) {
        log("cron", "No open positions — triggering screening cycle");
        runScreeningCycle().catch(e => log("cron_error", `Triggered screening failed: ${e.message}`));
      } else {
        const waitMin = Math.ceil((screeningCooldownMs - (Date.now() - _screeningLastTriggered)) / 60000);
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
      // Rule 2b: soft take profit — LLM decides
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        actionMap.set(p.position, { action: "INSTRUCTION", rule: 2, reason: `PnL ${p.pnl_pct.toFixed(1)}% hit soft TP (${config.management.takeProfitFeePct}%). Close to lock gains OR provide reasoning to hold.` });
        continue;
      }
      // Rule 3: pumped far above range (OOR > outOfRangeBinsToClose bins above)
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin &&
          (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes) {
        actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: "OOR" });
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

    // ── Build JS report ────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map(p => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = `$${p.total_value_usd ?? "?"}`;
      const unclaimed = `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | ${inRange} | ${statusLabel}`;
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
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees_usd: $${p.unclaimed_fees_usd} | value: $${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
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
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048);

      mgmtReport += `\n\n${content}`;
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch(e => log("cron_error", `Triggered screening failed: ${e.message}`));
    }

  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
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
export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true;
  _screeningLastTriggered = Date.now();

  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([
      getMyPositions({ force: true }),
      getWalletBalances(),
    ]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      _screeningBusy = false;
      return null;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`);
      _screeningBusy = false;
      return null;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    _screeningBusy = false;
    return null;
  }

  timers.screeningLastRun = Date.now();
  log("cron", `Starting Fibonacci screening cycle [model: ${config.llm.screeningModel}]`);
  let screenReport = null;

  try {
    const deployAmount = computeDeployAmount(preBalance.sol);
    log("cron", `Deploy amount: ${deployAmount} SOL (wallet: ${preBalance.sol} SOL)`);

    // Fetch Fibonacci-filtered candidates
    const topResult = await getTopCandidates({ limit: 20 }).catch(() => null);
    const candidates = topResult?.candidates || [];

    if (candidates.length === 0) {
      screenReport = `No Fibonacci entry signals found. Total screened: ${topResult?.total_screened ?? 0}, Fib analyzed: ${topResult?.fib_analyzed ?? 0}. All pools either outside Fib zone or lack volume support at key levels.`;
      return screenReport;
    }

    // Pre-fetch active_bin for all candidates in parallel
    const activeBinResults = await Promise.allSettled(
      candidates.map(p => getActiveBin({ pool_address: p.pool }))
    );

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
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
        `  fib: ${fibStr}`,
        `  price: ${pool.price} | change: ${pool.price_change_pct}% | trend: ${pool.price_trend ?? "?"}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
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
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) sendMessage(`🔍 Fibonacci Screening\n\n${stripThink(screenReport)}`).catch(() => {});
    }
  }
  return screenReport;
}

// ═══════════════════════════════════════════
//  CRON SCHEDULER
// ═══════════════════════════════════════════
export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    async () => {
      if (_managementBusy) return;
      timers.managementLastRun = Date.now();
      await runManagementCycle();
    }
  );

  const screenTask = cron.schedule(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    runScreeningCycle
  );

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles
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
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch(e => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask];
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
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that Fib-confirmed pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh Fibonacci candidates list
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
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
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name} (bins_below=${bins})...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). ` +
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
        console.log("\nAgent running Fibonacci screening and deploying...\n");
        const { content: reply } = await agentLoop(
          `Call get_chart_candidates, pick the best Fibonacci signal, deploy_position with ${DEPLOY} SOL. Execute now.`,
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
  startCronJobs();
  setTimeout(
    () => runManagementCycle().catch(e => log("cron_error", `Startup management failed: ${e.message}`)),
    3000
  );

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
