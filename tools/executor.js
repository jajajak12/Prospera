/**
 * executor.js — Tool dispatch, safety checks, pre/post hooks
 *
 * Adapted from Meridian's executor.js.
 * Maps tool names → implementations and enforces safety rules.
 */

import { getTopCandidates, getPoolDetail } from "./screening.js";
import { hybridDataProvider } from "./dataProvider.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  estimateBinInitFee,
  getWallet as dlmmGetWallet,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { getTokenAdvancedInfo, getTokenPriceInfo, getTokenClusterList } from "./okx.js";
import { getJupiterTokenInfo } from "./token.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition, trackPosition, markPositionAdopted, markPositionUnusable } from "../state.js";
import { addPoolNote } from "../pool-memory.js";
import { addSmartWallet, removeSmartWallet, loadSmartWallets, observePoolParticipants, getObservationStats } from "../smart-wallets.js";
import { runBacktest } from "../backtest.js";
import { listStrategies, getStrategy } from "../strategy-library.js";
import { config, reloadScreeningThresholds } from "../config.js";
import { acquireDeployLock, releaseDeployLock } from "./lock-manager.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH    = path.join(__dirname, "../user-config.json");
const PENDING_ATH_PATH    = path.join(__dirname, "../screening-pending.json");
const POSITION_META_PATH  = path.join(__dirname, "../position-meta.json");

import { log, logAction } from "../logger.js";
import { safeSave } from "../log-utils.js";
import { notifyDeploy, notifyClose, notifySwap, notifyExistingPositionAdopted, notifyZeroLiquidityStalePosition } from "../telegram.js";

function getPreferredBinStepRange(screeningCfg = config.screening ?? {}) {
  return {
    min: screeningCfg.preferredBinStepMin ?? screeningCfg.minBinStep ?? 80,
    max: screeningCfg.preferredBinStepMax ?? screeningCfg.maxBinStep ?? 200,
  };
}

function getConditionalBinStepSet(screeningCfg = config.screening ?? {}) {
  return new Set((screeningCfg.conditionalBinSteps ?? []).map(Number).filter(Number.isFinite));
}

function getBinStepPolicy(binStep, screeningCfg = config.screening ?? {}) {
  const step = Number(binStep);
  if (!Number.isFinite(step)) return "unknown";
  const preferred = getPreferredBinStepRange(screeningCfg);
  if (step >= preferred.min && step <= preferred.max) return "preferred";
  if (
    screeningCfg.allowBinStep50IfRangeCoverageOk !== false &&
    getConditionalBinStepSet(screeningCfg).has(step)
  ) {
    return "conditional";
  }
  return "rejected";
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  get_chart_candidates:  getTopCandidates,
  get_pool_detail:       getPoolDetail,

  get_token_holders: async ({ mint }) => {
    const s = config.screening;
    const [okx, jup] = await Promise.all([
      getTokenAdvancedInfo(mint),
      getJupiterTokenInfo(mint),
    ]);
    const flags = [];
    if (okx?.honeypot)                                                   flags.push("HONEYPOT");
    if (okx?.bundlePct    > (s.maxBundlePct     ?? 30))                  flags.push(`bundle ${okx.bundlePct}% > max ${s.maxBundlePct ?? 30}%`);
    if (jup?.botHoldersPct != null && jup.botHoldersPct > (s.maxBotHoldersPct ?? 30)) flags.push(`bot_holders ${jup.botHoldersPct}% > max ${s.maxBotHoldersPct ?? 30}%`);
    if (jup?.top10Pct      != null && jup.top10Pct      > (s.maxTop10Pct      ?? 22)) flags.push(`top10 ${jup.top10Pct}% > max ${s.maxTop10Pct ?? 22}%`);
    if (jup?.feesSOL       != null && jup.feesSOL       < (s.minTokenFeesSol  ?? 30)) flags.push(`fees ${jup.feesSOL} SOL < min ${s.minTokenFeesSol ?? 30}`);
    return { mint, okx, jupiter: jup, flags, pass: flags.length === 0 };
  },

  get_token_info: async ({ mint }) => {
    const [advanced, price, cluster] = await Promise.all([
      getTokenAdvancedInfo(mint),
      getTokenPriceInfo(mint),
      getTokenClusterList(mint),
    ]);
    return { mint, advanced, price, cluster };
  },
  get_position_pnl:      getPositionPnl,
  get_active_bin:        getActiveBin,
  deploy_position:       deployPosition,
  get_my_positions:      getMyPositions,
  get_wallet_positions:  getWalletPositions,
  claim_fees:            claimFees,
  close_position:        closePosition,
  get_wallet_balance:    getWalletBalances,
  swap_token:            swapToken,

  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },

  add_pool_note: addPoolNote,

  // ── Backtesting ────────────────────────────────────────────────────────────
  run_backtest: ({ pool_address, bin_step, fee_pct, aggregate = 5, candle_limit = 100, preset = null }) =>
    runBacktest({ poolAddress: pool_address, binStep: bin_step, feePct: fee_pct, aggregate, candleLimit: candle_limit, preset }),

  // ── Smart Wallets ──────────────────────────────────────────────────────────
  add_smart_wallet:    ({ address, label }) => addSmartWallet(address, label),
  remove_smart_wallet: ({ address }) => removeSmartWallet(address),
  list_smart_wallets:  () => {
    const wallets = loadSmartWallets();
    return { wallets, count: wallets.length };
  },
  get_smart_wallet_stats: () => {
    const stats = getObservationStats();
    return {
      observed_count:    stats.length,
      promotion_threshold: { min_observations: 3, min_win_rate_pct: 65 },
      wallets: stats,
    };
  },

  // ── Strategy Library ───────────────────────────────────────────────────────
  list_strategies: () => ({ strategies: listStrategies() }),

  apply_strategy: ({ name }) => {
    const preset = getStrategy(name);
    if (!preset) {
      return { success: false, error: `Unknown strategy: "${name}". Use list_strategies to see options.` };
    }

    const applied = {};

    // Apply screening overrides
    if (preset.screening) {
      for (const [key, val] of Object.entries(preset.screening)) {
        if (config.screening[key] !== undefined || key in config.screening) {
          config.screening[key] = val;
          applied[key] = val;
        }
      }
    }

    // Apply management overrides
    if (preset.management) {
      for (const [key, val] of Object.entries(preset.management)) {
        if (config.management[key] !== undefined || key in config.management) {
          config.management[key] = val;
          applied[key] = val;
        }
      }
    }

    // Apply strategy overrides
    if (preset.strategy) {
      for (const [key, val] of Object.entries(preset.strategy)) {
        config.strategy[key] = val;
        applied[key] = val;
      }
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig.preset = name;
    userConfig._lastStrategyApplied = new Date().toISOString();
    safeSave(USER_CONFIG_PATH, userConfig, "user_config");

    log("strategy", `Applied preset "${name}": ${Object.keys(applied).join(", ")}`);
    addLesson(`[STRATEGY] Switched to preset "${name}" — ${preset.description}`, ["strategy", "config_change"]);

    return {
      success: true,
      strategy: name,
      description: preset.description,
      applied,
    };
  },

  get_performance_history: getPerformanceHistory,

  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },

  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping
    const CONFIG_MAP = {
      // screening
      minTvl:                ["screening", "minTvl"],
      maxTvl:                ["screening", "maxTvl"],
      minVolume:             ["screening", "minVolume"],
      minOrganic:            ["screening", "minOrganic"],
      minHolders:            ["screening", "minHolders"],
      minMcap:               ["screening", "minMcap"],
      maxMcap:               ["screening", "maxMcap"],
      minBinStep:            ["screening", "minBinStep"],
      maxBinStep:            ["screening", "maxBinStep"],
      timeframe:             ["screening", "timeframe"],
      candleLimit:           ["screening", "candleLimit"],
      fibConfluenceRequired: ["screening", "fibConfluenceRequired"],
      minConfluenceScore:    ["screening", "minConfluenceScore"],
      // management
      minClaimAmount:        ["management", "minClaimAmount"],
      autoSwapAfterClaim:    ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance:  ["management", "minVolumeToRebalance"],
      stopLossPct:           ["management", "stopLossPct"],
      takeProfitFeePct:      ["management", "takeProfitFeePct"],
      profitProtectionPct:   ["management", "profitProtectionPct"],
      protectedRunnerPct:    ["management", "protectedRunnerPct"],
      runnerStrongTakeProfitPct: ["management", "runnerStrongTakeProfitPct"],
      runnerPeakGivebackPct: ["management", "runnerPeakGivebackPct"],
      trailingTakeProfit:    ["management", "trailingTakeProfit"],
      trailingTriggerPct:    ["management", "trailingTriggerPct"],
      trailingDropPct:       ["management", "trailingDropPct"],
      minSolToOpen:          ["management", "minSolToOpen"],
      minDeployAmountSol:    ["management", "minDeployAmountSol"],
      gasReserve:            ["management", "gasReserve"],
      minFeePerTvl24h:       ["management", "minFeePerTvl24h"],
      // risk
      maxPositions:          ["risk", "maxPositions"],
      maxDeployAmount:       ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin:  ["schedule", "screeningIntervalMin"],
      // models
      managementModel:       ["llm", "managementModel"],
      screeningModel:        ["llm", "screeningModel"],
      generalModel:          ["llm", "generalModel"],
      solMode:               ["management", "solMode"],
      // strategy
      binsBelow:             ["strategy", "binsBelow"],
      binsExtraLow:          ["strategy", "binsExtraLow"],
      binsExtraMid:          ["strategy", "binsExtraMid"],
      binsExtraHigh:         ["strategy", "binsExtraHigh"],
    };

    const applied = {};
    const unknown = [];

    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}`);
      return { success: false, unknown, reason };
    }

    // Hard floors
    if (applied.minTvl != null && applied.minTvl < 1000) {
      applied.minTvl = 1000;
      log("config", `update_config: minTvl clamped to 1000 (hard floor)`);
    }
    if (applied.minVolume != null && applied.minVolume < 100) {
      applied.minVolume = 100;
      log("config", `update_config: minVolume clamped to 100 (hard floor)`);
    }
    if (applied.minBinStep != null && applied.minBinStep < 1) {
      applied.minBinStep = 1;
      log("config", `update_config: minBinStep clamped to 1 (hard floor)`);
    }
    if (applied.maxBinStep != null && applied.maxBinStep > 500) {
      applied.maxBinStep = 500;
      log("config", `update_config: maxBinStep clamped to 500 (hard ceiling)`);
    }
    if (applied.maxMcap != null && applied.maxMcap > 100_000_000) {
      applied.maxMcap = 100_000_000;
      log("config", `update_config: maxMcap clamped to 100_000_000 (hard ceiling)`);
    }
    if (applied.stopLossPct != null && applied.stopLossPct < -50) {
      applied.stopLossPct = -50;
      log("config", `update_config: stopLossPct clamped to -50 (hard floor)`);
    }
    if (applied.stopLossPct != null && applied.stopLossPct > 0) {
      applied.stopLossPct = 0;
      log("config", `update_config: stopLossPct clamped to 0 (cannot be positive)`);
    }
    if (applied.maxPositions != null && (applied.maxPositions < 1 || applied.maxPositions > 10)) {
      applied.maxPositions = Math.min(10, Math.max(1, applied.maxPositions));
      log("config", `update_config: maxPositions clamped to [1–10]: ${applied.maxPositions}`);
    }
    if (applied.minConfluenceScore != null) {
      if (applied.minConfluenceScore < 0 || applied.minConfluenceScore > 1) {
        applied.minConfluenceScore = Math.min(1, Math.max(0, applied.minConfluenceScore));
        log("config", `update_config: minConfluenceScore clamped to [0–1]: ${applied.minConfluenceScore}`);
      }
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key] ?? CONFIG_MAP_LOWER[key.toLowerCase()]?.[1];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val}`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    safeSave(USER_CONFIG_PATH, userConfig, "user_config");

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save non-interval changes as a lesson
    const lessonKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonKeys.length > 0) {
      const summary = lessonKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts
  name = name.replace(/<.*$/, "").trim();

  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // Safety checks for write operations
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return { blocked: true, reason: safetyCheck.reason };
    }
  }

  // Atomic deploy lock — prevents concurrent deploys across screening + management cycles
  let _heldDeployLock = false;
  if (name === "deploy_position") {
    const lock = acquireDeployLock();
    if (!lock.acquired) {
      log("safety_block", `deploy_position blocked: ${lock.reason}`);
      return { blocked: true, reason: lock.reason };
    }
    _heldDeployLock = true;
  }

  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (name === "deploy_position" && result?.zero_liq_stale) {
      notifyZeroLiquidityStalePosition({
        pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
        position: result.position,
        cleanupAttempted: result.cleanup_attempted === true,
        cleanupClosed: result.cleanup_closed === true,
      }).catch(() => {});
    }

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({
          inputSymbol:  args.input_mint?.slice(0, 8),
          outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" ? "SOL" : args.output_mint?.slice(0, 8),
          amountIn:  result.amount_in,
          amountOut: result.amount_out,
          tx:        result.tx,
        }).catch(() => {});

      } else if (name === "deploy_position") {
        // Handle already-exists adoption case — no new position opened, existing was adopted
        if (result?.adopted && result?.position) {
          log("deploy", `DEPLOY_SKIPPED_EXISTING_ADOPTED pool=${args.pool_address} position=${result.position.slice(0, 8)}`);
          notifyExistingPositionAdopted({
            pair:     result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
            position: result.position,
          }).catch(() => {});
        } else if (result?.success) {
          log("deploy", `DEPLOY_EXECUTED pool=${args.pool_address} price_range=${result.price_range ?? "n/a"} binsBelow=${args.bins_below ?? "n/a"} binsAbove=${args.bins_above ?? "n/a"} fib236=${args.fib_levels_sol?.fib236 ?? "n/a"}`);
          notifyDeploy({
            pair:       result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
            amountSol:  args.amount_y ?? args.amount_sol ?? 0,
            position:   result.position,
            tx:         result.txs?.[0] ?? result.tx,
            priceRange: result.price_range,
            binStep:    result.bin_step,
            baseFee:    result.base_fee,
          }).catch(() => {});
        }

        // Save ath_bin for OOR management — close only if price makes new ATH
        try {
          if (result.position && fs.existsSync(PENDING_ATH_PATH)) {
            const pending  = JSON.parse(fs.readFileSync(PENDING_ATH_PATH, "utf8"));
            const entry    = pending[args.pool_address];
            if (entry?.ath && entry?.entryPrice && entry?.binStep != null && entry?.activeBinAtScreening != null) {
              const binsDelta = Math.log(entry.ath / entry.entryPrice) / Math.log(1 + entry.binStep / 10000);
              const athBin    = Math.round(entry.activeBinAtScreening + binsDelta);
              const meta      = fs.existsSync(POSITION_META_PATH) ? JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8")) : {};
              meta[result.position] = { athBin, ath: entry.ath, peakPrice: entry.ath, pool: args.pool_address, openedAt: new Date().toISOString() };
              fs.writeFileSync(POSITION_META_PATH, JSON.stringify(meta, null, 2));
              log("management", `Saved ATH meta for ${result.position?.slice(0, 8)}: ath=${entry.ath} athBin=${athBin}`);
            }
          }
        } catch { /* non-fatal */ }

      } else if (name === "close_position") {
        notifyClose({
          pair:   result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          reason: result.close_reason || args.reason || null,
        }).catch(() => {});

        // Add pool note with close context
        const poolAddr = result.pool || args.pool_address;
        if (poolAddr && args.reason) {
          const pnlCtx = result.pnl_pct != null ? ` | PnL: ${result.pnl_pct >= 0 ? "+" : ""}${result.pnl_pct?.toFixed(1)}%` : "";
          const note = `Closed ${new Date().toISOString().slice(0, 10)}: ${args.reason}${pnlCtx}`;
          addPoolNote({ pool_address: poolAddr, note }).catch?.(() => {});
        }

        // Smart wallet self-learning: observe pool participants at close
        {
          const poolAddr = result.pool || args.pool_address;
          const pnlPct   = result.pnl_pct ?? null;
          if (poolAddr && pnlPct != null) {
            let ownWallet = null;
            try { const { Keypair } = await import("@solana/web3.js"); const bs58 = (await import("bs58")).default; ownWallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString(); } catch { /**/ }
            observePoolParticipants(poolAddr, pnlPct, ownWallet).catch(() => {});
          }
        }
        // Step 3 swap handled inside closePosition() in dlmm.js (10 retries + RPC fallback)
        if (result.auto_swapped) {
          log("executor", `Auto-swap already done inside closePosition — ${result.sol_received ? `received ${result.sol_received} SOL` : "completed"}`);
        }

      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logAction({ tool: name, args, error: error.message, duration_ms: duration, success: false });
    const retryable_expiry = (error.message || "").includes("block height exceeded");
    return { error: error.message, tool: name, ...(retryable_expiry ? { retryable_expiry: true } : {}) };
  } finally {
    if (_heldDeployLock) releaseDeployLock();
  }
}

/**
 * Safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Bin step policy check
      const binStepPolicy = args.bin_step != null ? getBinStepPolicy(args.bin_step, config.screening) : "unknown";
      if (args.bin_step != null && binStepPolicy === "rejected") {
        const preferred = getPreferredBinStepRange(config.screening);
        const conditional = [...getConditionalBinStepSet(config.screening)].join(",") || "none";
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside allowed policy (preferred ${preferred.min}-${preferred.max}, conditional ${conditional}).`,
        };
      }

      // Position count + duplicate pool guard
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      // Check for existing position on-chain before attempting deploy.
      // Handles case where on-chain position exists but LPAgent is slow/stale returning it.
      // This prevents "account already in use" errors and duplicate position attempts.
      if (args.pool_address) {
        try {
          const { DLMM } = await import("@meteora-ag/dlmm");
          const wallet = dlmmGetWallet();
          const walletKey = wallet.publicKey.toString();
          if (walletKey) {
            const { withRpcFallback } = await import("../rpc.js");
            const allUserPositions = await withRpcFallback(
              conn => DLMM.getAllLbPairPositionsByUser(conn, wallet.publicKey),
              "executor:predeploy_scan"
            );
            const poolBytes = args.pool_address;
            const poolEntry = Object.entries(allUserPositions || {}).find(([k]) => k === poolBytes || k.slice(0, 8) === poolBytes.slice(0, 8));
            if (poolEntry) {
              for (const pos of (poolEntry[1].lbPairPositionsData || [])) {
                const existingAddr = pos.publicKey.toString();
                const xAmt = pos.positionData?.totalXAmount ?? null;
                const yAmt = pos.positionData?.totalYAmount ?? null;
                const isZeroLiq = xAmt !== null && yAmt !== null
                  && BigInt(xAmt.toString()) === 0n && BigInt(yAmt.toString()) === 0n;
                const trackedRec = getTrackedPosition(existingAddr);
                const isTrackedOpen = !!(trackedRec && !trackedRec.closed);
                if (isTrackedOpen && !isZeroLiq) {
                  // Already in our state — suppress duplicate deploy
                  log("deploy", `DUPLICATE_DEPLOY_SUPPRESSED pool=${args.pool_address} existing_pos=${existingAddr.slice(0, 8)} — tracked in state`);
                  return {
                    pass: false,
                    reason: `Existing position ${existingAddr.slice(0, 8)}... already active in pool ${args.pool_address}. Position adopted in prior session.`,
                    existing_position: existingAddr,
                    adopted: true,
                  };
                } else if (isTrackedOpen && isZeroLiq) {
                  log("deploy", `ZERO_LIQ_POSITION_ACCOUNT_DETECTED position=${existingAddr} pool=${args.pool_address}`);
                  markPositionUnusable({
                    pool: args.pool_address,
                    position: existingAddr,
                    reason: "predeploy_tracked_zero_liquidity",
                    pool_name: args.pool_name || null,
                    context: { source: "runSafetyChecks" },
                  });
                } else if (!isZeroLiq) {
                  // On-chain position found, not tracked in state, non-zero liquidity
                  // → adopt into state and suppress deploy so we don't hit "account already in use"
                  log("deploy", `EXISTING_POSITION_FOUND_BEFORE_DEPLOY pool=${args.pool_address} — adopting untracked pos=${existingAddr.slice(0, 8)} with non-zero liquidity`);
                  trackPosition({
                    position: existingAddr,
                    pool: args.pool_address,
                    pool_name: args.pool_name || null,
                    strategy: "bid_ask",
                    amount_sol: 0,
                    amount_x: 0,
                  });
                  markPositionAdopted({ pool: args.pool_address, position: existingAddr, pool_name: args.pool_name || null, source: "predeploy_scan" });
                  return {
                    pass: false,
                    reason: `Existing on-chain position ${existingAddr.slice(0, 8)}... adopted into state. No duplicate deploy attempted.`,
                    existing_position: existingAddr,
                    adopted: true,
                  };
                }
                // Zero-liquidity account → not an active deploy blocker
                log("deploy", `ZERO_LIQ_POSITION_ACCOUNT_DETECTED position=${existingAddr} pool=${args.pool_address}`);
                markPositionUnusable({
                  pool: args.pool_address,
                  position: existingAddr,
                  reason: "predeploy_zero_liquidity",
                  pool_name: args.pool_name || null,
                  context: { source: "runSafetyChecks" },
                });
              }
            }
          }
        } catch (scanErr) {
          log("deploy_warn", `Pre-deploy on-chain scan failed: ${scanErr.message} — proceeding with deploy`);
        }
      }

      if (positions.positions.some(p => p.pool === args.pool_address)) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Bin initialization fee guard — non-refundable SOL for new bin arrays
      // Only charges for arrays that don't exist on-chain yet. Cap: 0.13 SOL.
      try {
        const binsBelow = args.bins_below ?? config.strategy.binsBelow ?? 69;
        const binsAbove = Math.abs(args.bins_above ?? 0);
        const { estimatedFee, newArrays, totalArrays } = await estimateBinInitFee(args.pool_address, binsBelow, binsAbove);
        if (estimatedFee > 0.13) {
          return {
            pass: false,
            reason: `Deploy blocked — bin initialization fee ${estimatedFee.toFixed(5)} SOL (${newArrays}/${totalArrays} new arrays × 0.07143744 SOL) exceeds max 0.13 SOL.`,
          };
        }
        if (newArrays > 0) {
          log("safety", `Bin init fee: ${estimatedFee.toFixed(5)} SOL (${newArrays}/${totalArrays} new arrays) — within limit`, { pool: args.pool_address });
        }
      } catch (e) {
        log.warn("safety", `Bin init fee check failed: ${e.message} — allowing deploy`);
      }

      // Duplicate base token check
      if (args.base_mint) {
        if (positions.positions.some(p => p.base_mint === args.base_mint)) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Blocked launchpad check
      const blockedLaunchpads = config.blocklists?.blockedLaunchpads ?? [];
      if (blockedLaunchpads.length > 0 && args.launchpad) {
        if (blockedLaunchpads.includes(args.launchpad)) {
          return { pass: false, reason: `Launchpad "${args.launchpad}" is blocked.` };
        }
      }

      // Force bid_ask strategy
      if (args.strategy && args.strategy !== "bid_ask") {
        log("safety_block", `deploy_position: strategy "${args.strategy}" overridden to bid_ask`);
        args.strategy = "bid_ask";
      }

      // Allow small bins_above only when fib_signal explicitly provides it (primary zone + RSI < 55)
      // Cap at 10 to prevent overexposure above current price
      if (args.bins_above && args.bins_above > 10) {
        log("safety_block", `deploy_position: bins_above ${args.bins_above} capped to 10`);
        args.bins_above = 10;
      }

      // Amount checks
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return { pass: false, reason: "Must provide a positive SOL amount (amount_y)." };
      }

      const minDeploy = Math.max(0.1, config.management.minDeployAmountSol);
      if (amountY < minDeploy) {
        return { pass: false, reason: `Amount ${amountY} SOL is below minimum deploy amount (${minDeploy} SOL).` };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return { pass: false, reason: `Amount ${amountY} exceeds maximum per position (${config.risk.maxDeployAmount}).` };
      }

      // SOL balance check
      const balance = await getWalletBalances();
      const gasReserve = config.management.gasReserve;
      const minRequired = amountY + gasReserve;
      if (balance.sol < minRequired) {
        return {
          pass: false,
          reason: `Insufficient SOL: have ${balance.sol}, need ${minRequired} (${amountY} deploy + ${gasReserve} gas).`,
        };
      }

      // Exposure cap hard block disabled by source-of-truth (Phase 3 Stability Test).

      // Real-time Fib gates + deploy range validation
      let _deployMeta = null;
      const manualOverride = args?.allow_missing_deploy_meta === true || args?.manual_override === true;
      try {
        const pending = fs.existsSync(PENDING_ATH_PATH)
          ? JSON.parse(fs.readFileSync(PENDING_ATH_PATH, "utf8"))
          : {};
        _deployMeta = pending[args.pool_address];
        if (!_deployMeta) {
          if (binStepPolicy === "conditional") {
            return {
              pass: false,
              reason: `Deploy blocked — conditional bin_step ${args.bin_step} requires screening deploy metadata with range coverage validation.`,
            };
          }
          if (manualOverride) {
            log.warn("deploy", `DEPLOY_META_MISSING override=true pool=${args.pool_address} — allowing by explicit manual override`);
          } else {
            return {
              pass: false,
              reason: `Deploy blocked — missing screening deploy metadata for pool ${args.pool_address}. Re-run screening or use explicit manual override.`,
            };
          }
        }

        if (_deployMeta?.fib500 != null) {
          // PRE_DEPLOY_REVALIDATION: fetch live active bin price from on-chain; fallback to SOL price API
          let livePriceSol = null;
          try {
            const activeBinData = await getActiveBin({ pool_address: args.pool_address });
            livePriceSol = activeBinData?.price ?? null;
          } catch (binErr) {
            log.warn("deploy", `PRE_DEPLOY_REVALIDATION active bin fetch failed: ${binErr.message} — trying SOL price fallback`);
            try {
              const reliable = await hybridDataProvider.getReliableSOLPrice(_deployMeta.tokenMint ?? null, args.pool_address, "solana");
              livePriceSol = reliable?.price ?? null;
            } catch (_) {}
          }

          if (livePriceSol == null) {
            return {
              pass: false,
              reason: `PRE_DEPLOY_ABORT_STALE_SIGNAL — live price unavailable (active bin + SOL price both failed); cannot validate zone before deploy. Pool: ${args.pool_address}`,
            };
          }

          // Derive Fib levels from stored ATH + fib500
          const fibRange = _deployMeta.ath != null ? (_deployMeta.ath - _deployMeta.fib500) / 0.500 : null;
          const fib382 = fibRange != null ? _deployMeta.ath - 0.382 * fibRange : null;
          const fib236 = _deployMeta.fib236 ?? (fibRange != null ? _deployMeta.ath - 0.236 * fibRange : null);

          log("deploy", `PRE_DEPLOY_REVALIDATION pool=${args.pool_address} livePrice=${livePriceSol.toPrecision(6)} fib500=${_deployMeta.fib500.toPrecision(4)} fib382=${fib382?.toPrecision(4) ?? "n/a"} fib236=${fib236?.toPrecision(4) ?? "n/a"}`);

          if (livePriceSol < _deployMeta.fib500) {
            return {
              pass: false,
              reason: `PRE_DEPLOY_ABORT_STALE_SIGNAL — live price ${livePriceSol.toPrecision(4)} SOL dropped below Fib 0.500 (${_deployMeta.fib500.toPrecision(4)} SOL) since screening.`,
            };
          }

          if (fib382 != null && livePriceSol < fib382) {
            return {
              pass: false,
              reason: `PRE_DEPLOY_ABORT_STALE_SIGNAL — live price ${livePriceSol.toPrecision(4)} SOL is below Fib 0.382 (${fib382.toPrecision(4)} SOL) — too deep in retracement for entry.`,
            };
          }

          // Zone drift check: abort if zone changed between screening and deploy
          if (fib236 != null) {
            const screeningWasAthZone = (_deployMeta.binsAbove ?? 0) < 0 || (_deployMeta.entryPrice != null && _deployMeta.entryPrice > fib236);
            const liveIsAthZone = livePriceSol > fib236;
            if (screeningWasAthZone !== liveIsAthZone) {
              log.warn("deploy", `PRE_DEPLOY_ZONE_CHANGED pool=${args.pool_address} screening=${screeningWasAthZone ? "ATH_ZONE" : "PRIMARY"} live=${liveIsAthZone ? "ATH_ZONE" : "PRIMARY"} livePrice=${livePriceSol.toPrecision(6)} fib236=${fib236.toPrecision(6)}`);
              return {
                pass: false,
                reason: `PRE_DEPLOY_ABORT_STALE_SIGNAL — zone changed from ${screeningWasAthZone ? "ATH_ZONE" : "PRIMARY"} to ${liveIsAthZone ? "ATH_ZONE" : "PRIMARY"} (fib236=${fib236.toPrecision(4)} SOL). Re-screen required.`,
              };
            }
          }
        }

        // PRE_DEPLOY_DEPTH_CHECK: reject if pool TVL dropped below safe threshold for this deploy size
        try {
          const deployAmountSol = args.amount_y ?? args.amount_sol ?? 0;
          if (deployAmountSol > 0.5 && args.pool_address) {
            const poolRaw = await getPoolDetail({ pool_address: args.pool_address });
            const tvlUsd = poolRaw?.tvl ?? poolRaw?.liquidity ?? null;
            const minTvl = config.screening?.minTvl ?? 25000;
            const depthFloor = minTvl * 0.5;
            log("deploy", `PRE_DEPLOY_DEPTH_CHECK pool=${args.pool_address} tvlUsd=${tvlUsd?.toFixed(0) ?? "n/a"} depthFloor=${depthFloor.toFixed(0)} deploySOL=${deployAmountSol}`);
            if (tvlUsd != null && tvlUsd < depthFloor) {
              return {
                pass: false,
                reason: `DEPLOY_SIZE_TOO_LARGE_FOR_POOL_DEPTH — pool TVL $${tvlUsd.toFixed(0)} is below depth floor $${depthFloor.toFixed(0)} (50% of screening minTvl $${minTvl}). Deploy of ${deployAmountSol} SOL may overwhelm thin pool and cause slippage.`,
              };
            }
          }
        } catch (depthErr) {
          log.warn("deploy", `PRE_DEPLOY_DEPTH_CHECK failed: ${depthErr.message} — allowing deploy`);
        }

        if (_deployMeta) {
          const pendingFib236 = _deployMeta?.fib236 ?? null;
          const pendingFib500 = _deployMeta?.fib500 ?? null;
          const pendingRangeTop = _deployMeta?.computedRangeTopPrice ?? _deployMeta?.rangeTopPrice ?? null;
          const pendingRangeBottom = _deployMeta?.computedRangeBottomPrice ?? _deployMeta?.rangeBottomPrice ?? null;
          const targetTopPrice = _deployMeta?.targetTopPrice ?? pendingFib236 ?? null;
          const targetBottomPrice = _deployMeta?.targetBottomPrice ?? _deployMeta?.fib618 ?? null;
          const entryPrice = _deployMeta?.entryPrice ?? null;
          const binsAbove = _deployMeta?.binsAbove ?? args?.bins_above ?? 0;
          const effectiveBinStep = args.bin_step ?? _deployMeta?.binStep ?? null;
          const effectivePolicy = effectiveBinStep != null ? getBinStepPolicy(effectiveBinStep, config.screening) : binStepPolicy;
          const isAthZonePassiveBid = binsAbove < 0 || (entryPrice != null && pendingFib236 != null && entryPrice > pendingFib236);
          const zoneType = isAthZonePassiveBid ? "ATH_ZONE_PASSIVE_BID" : "PRIMARY_OR_OTHER";

          if (effectivePolicy === "conditional" && _deployMeta?.rangeCoverageOk !== true) {
            return {
              pass: false,
              reason: `RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP token=${_deployMeta?.tokenMint ?? args.base_mint ?? "unknown"} bin_step=${effectiveBinStep}`,
            };
          }

          if (isAthZonePassiveBid && targetTopPrice != null && pendingRangeTop != null) {
            const topDiffPct = Math.abs(pendingRangeTop - targetTopPrice) / Math.max(targetTopPrice, 1e-12);
            const tolerancePct = Math.max(0.01, Math.min(0.03, ((effectiveBinStep ?? 100) / 10000) * 2));
            if (topDiffPct > tolerancePct) {
              return {
                pass: false,
                reason: `Deploy blocked — ATH zone range top mismatch: rangeTop=${pendingRangeTop.toPrecision(6)} vs targetTop=${targetTopPrice.toPrecision(6)} (diff ${(topDiffPct * 100).toFixed(2)}% > tol ${(tolerancePct * 100).toFixed(2)}%).`,
              };
            }
          }

          if (targetBottomPrice != null && pendingRangeBottom != null && pendingRangeBottom > targetBottomPrice) {
            return {
              pass: false,
              reason: `RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP token=${_deployMeta?.tokenMint ?? args.base_mint ?? "unknown"} bin_step=${effectiveBinStep}`,
            };
          }

          if (_deployMeta?.ath != null && pendingFib500 != null && pendingFib236 != null) {
            const range = (_deployMeta.ath - pendingFib500) / 0.500;
            const expectedFib236 = _deployMeta.ath - 0.236 * range;
            const fibDiffPct = Math.abs(pendingFib236 - expectedFib236) / Math.max(expectedFib236, 1e-12);
            if (fibDiffPct > 0.03) {
              return {
                pass: false,
                reason: `Deploy blocked — fib236 inconsistent with ATH/fib500 context: pending=${pendingFib236.toPrecision(6)} expected=${expectedFib236.toPrecision(6)} diff ${(fibDiffPct * 100).toFixed(2)}%.`,
              };
            }
          }

          log("deploy", `DEPLOY_RANGE_VALIDATION pool=${args.pool_address} zoneType=${zoneType} fib236=${pendingFib236 ?? "n/a"} fib500=${pendingFib500 ?? "n/a"} rangeTop=${pendingRangeTop ?? "n/a"} rangeBottom=${pendingRangeBottom ?? "n/a"} targetBottom=${targetBottomPrice ?? "n/a"} binsBelow=${_deployMeta?.binsBelow ?? args.bins_below ?? "n/a"} binsAbove=${binsAbove} activeBinPrice=${entryPrice ?? "n/a"} rangeCoverageOk=${_deployMeta?.rangeCoverageOk ?? "n/a"}`);
        }
      } catch (e) {
        return {
          pass: false,
          reason: `Deploy blocked — deploy validation failed: ${e.message}`,
        };
      }

      // Inject fib levels for Failed Rebound tracking in management cycle
      if (_deployMeta?.fib500 != null && _deployMeta?.ath != null) {
        const range = (_deployMeta.ath - _deployMeta.fib500) / 0.500;
        args.fib_levels_sol = {
          fib236: _deployMeta.ath - 0.236 * range,
          fib326: _deployMeta.ath - 0.326 * range,
          fib382: _deployMeta.ath - 0.382 * range,
          fib500: _deployMeta.fib500,
          fib618: _deployMeta.ath - 0.618 * range,
          fib786: _deployMeta.ath - 0.786 * range,
        };
      }

      return { pass: true };
    }

    case "swap_token":
    default:
      return { pass: true };
  }
}

function summarizeResult(result) {
  const str = JSON.stringify(result);
  return str.length > 1000 ? str.slice(0, 1000) + "...(truncated)" : result;
}
