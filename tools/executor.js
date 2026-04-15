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
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { getTokenAdvancedInfo, getTokenPriceInfo, getTokenClusterList } from "./okx.js";
import { getJupiterTokenInfo } from "./token.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";
import { addPoolNote } from "../pool-memory.js";
import { addSmartWallet, removeSmartWallet, loadSmartWallets, observePoolParticipants, getObservationStats } from "../smart-wallets.js";
import { runBacktest } from "../backtest.js";
import { listStrategies, getStrategy } from "../strategy-library.js";
import { config, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH    = path.join(__dirname, "../user-config.json");
const PENDING_ATH_PATH    = path.join(__dirname, "../screening-pending.json");
const POSITION_META_PATH  = path.join(__dirname, "../position-meta.json");

import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

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
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

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
      // management
      minClaimAmount:        ["management", "minClaimAmount"],
      autoSwapAfterClaim:    ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance:  ["management", "minVolumeToRebalance"],
      stopLossPct:           ["management", "stopLossPct"],
      takeProfitFeePct:      ["management", "takeProfitFeePct"],
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
    if (applied.minBinStep != null && applied.minBinStep < 80) {
      applied.minBinStep = 80;
      log("config", `update_config: minBinStep clamped to 80 (hard floor)`);
    }
    if (applied.stopLossPct != null && applied.stopLossPct < -50) {
      applied.stopLossPct = -50;
      log("config", `update_config: stopLossPct clamped to -50 (hard floor)`);
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
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
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

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
        notifyDeploy({
          pair:       result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
          amountSol:  args.amount_y ?? args.amount_sol ?? 0,
          position:   result.position,
          tx:         result.txs?.[0] ?? result.tx,
          priceRange: result.price_range,
          binStep:    result.bin_step,
          baseFee:    result.base_fee,
        }).catch(() => {});

        // Save ath_bin for OOR management — close only if price makes new ATH
        try {
          if (result.position && fs.existsSync(PENDING_ATH_PATH)) {
            const pending  = JSON.parse(fs.readFileSync(PENDING_ATH_PATH, "utf8"));
            const entry    = pending[args.pool_address];
            if (entry?.ath && entry?.entryPrice && entry?.binStep != null && entry?.activeBinAtScreening != null) {
              const binsDelta = Math.log(entry.ath / entry.entryPrice) / Math.log(1 + entry.binStep / 10000);
              const athBin    = Math.round(entry.activeBinAtScreening + binsDelta);
              const meta      = fs.existsSync(POSITION_META_PATH) ? JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8")) : {};
              meta[result.position] = { athBin, ath: entry.ath, pool: args.pool_address, openedAt: new Date().toISOString() };
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

        // Auto-swap base token back to SOL
        if (!args.skip_swap && result.base_mint) {
          try {
            let token = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise(r => setTimeout(r, attempt * 3000));
              const balances = await getWalletBalances({});
              token = balances.tokens?.find(t => t.mint === result.base_mint);
              if (token && token.usd >= 0.10) break;
              log("executor", `Auto-swap attempt ${attempt}/3: token not found or < $0.10, retrying...`);
            }
            if (token && token.usd >= 0.10) {
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL. Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            } else {
              log("executor_warn", `Auto-swap after close: ${result.base_mint.slice(0, 8)} not found after 3 attempts`);
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
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
    return { error: error.message, tool: name };
  }
}

/**
 * Safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Bin step range check
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside allowed range [${minStep}-${maxStep}].`,
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
      if (positions.positions.some(p => p.pool === args.pool_address)) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Non-refunded (unclaimed) fee guard — must claim fees before deploying new position
      const posWithUnclaimedFees = positions.positions.filter(p => (p.unclaimed_fees_sol ?? 0) > 0.001);
      if (posWithUnclaimedFees.length > 0) {
        const detail = posWithUnclaimedFees.map(p => `${p.pair} (${(p.unclaimed_fees_sol ?? 0).toFixed(4)} SOL unclaimed)`).join(", ");
        return {
          pass: false,
          reason: `Deploy blocked — positions with non-refunded fees must be claimed first: ${detail}`,
        };
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

      // Real-time Fib 0.500 gate — SOL denomination (consistent with OHLCV candles and Fib levels)
      let _deployMeta = null;
      try {
        const pending = fs.existsSync(PENDING_ATH_PATH)
          ? JSON.parse(fs.readFileSync(PENDING_ATH_PATH, "utf8"))
          : {};
        _deployMeta = pending[args.pool_address];
        if (_deployMeta?.fib500 != null) {
          const reliable = await hybridDataProvider.getReliableSOLPrice(_deployMeta.tokenMint ?? null, args.pool_address, "solana");
          const livePriceSol = reliable?.price ?? null;
          if (livePriceSol == null) {
            // Price unavailable at deploy time — fib500 already verified at screening, allow deploy
            log.warn("deploy", `Fib deploy-gate: SOL price unavailable → allowing deploy (fib500=${_deployMeta.fib500?.toPrecision(4)} SOL verified at screening)`, { pool: args.pool_address });
          } else if (livePriceSol < _deployMeta.fib500) {
            return {
              pass: false,
              reason: `Deploy blocked — live price ${livePriceSol.toPrecision(4)} SOL dropped below Fib 0.500 (${_deployMeta.fib500.toPrecision(4)} SOL) since screening.`,
            };
          }
        }
      } catch { /* non-fatal — if check fails, allow deploy */ }

      // Inject fib levels for Failed Rebound tracking in management cycle
      if (_deployMeta?.fib500 != null && _deployMeta?.ath != null) {
        const range = (_deployMeta.ath - _deployMeta.fib500) / 0.500;
        args.fib_levels_sol = {
          fib236: _deployMeta.ath - 0.236 * range,
          fib500: _deployMeta.fib500,
          fib618: _deployMeta.ath - 0.618 * range,
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
