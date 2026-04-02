import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minTvl:        u.minTvl        ?? 5_000,
    maxTvl:        u.maxTvl        ?? 500_000,
    minVolume:     u.minVolume     ?? 500,
    minOrganic:    u.minOrganic    ?? 60,
    minHolders:        u.minHolders        ?? 500,
    maxBundlePct:         u.maxBundlePct         ?? 30,
    maxBotHoldersPct:     u.maxBotHoldersPct     ?? 30,
    maxTop10Pct:          u.maxTop10Pct          ?? 60,
    minTokenFeesSol:      u.minTokenFeesSol      ?? 25,
    athFilterPct:         u.athFilterPct         ?? null,
    minMcap:       u.minMcap       ?? 150_000,
    maxMcap:       u.maxMcap       ?? 10_000_000,
    minBinStep:           u.minBinStep           ?? 80,
    maxBinStep:           u.maxBinStep           ?? 200,
    timeframe:            u.timeframe            ?? "5m",
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minFee:               u.minFee               ?? 25,
    minTokenAgeHours:     u.minTokenAgeHours     ?? null,
    maxTokenAgeHours:     u.maxTokenAgeHours     ?? null,
    // Fibonacci-specific
    candleLimit:           u.candleLimit           ?? 100,
    fibConfluenceRequired: u.fibConfluenceRequired ?? true,
    // Auto-backtest pre-deploy filter
    autoBacktest:         u.autoBacktest         ?? false,
    minBacktestWinRate:   u.minBacktestWinRate   ?? 0.50,
    backtestAggregate:    u.backtestAggregate    ?? 15,
  },

  // ─── Blocklists ─────────────────────────
  blocklists: {
    blockedLaunchpads: u.blockedLaunchpads ?? [],
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 20,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 10,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? -20,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    takeProfitMaxPct:      u.takeProfitMaxPct      ?? 25,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 1,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
    minSolToOpen:          u.minSolToOpen          ?? 0.6,
    minDeployAmountSol:    u.minDeployAmountSol    ?? (u.deployAmountSol ?? 0.5), // minimum validation — actual deploy is tiered: floor(sol/5)+1
    gasReserve:            u.gasReserve            ?? 0.1,
    // Partial harvest — auto-close at this PnL% (between soft TP and max TP). null = disabled.
    partialHarvestPct:     u.partialHarvestPct     ?? 10,
    // Trailing take-profit (disabled by default for Fibonacci strategy)
    trailingTakeProfit:    u.trailingTakeProfit    ?? false,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 5,
    trailingDropPct:       u.trailingDropPct       ?? 2,
    solMode:               u.solMode               ?? true,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:      u.strategy      ?? "bid_ask",
    binsBelow:     u.binsBelow     ?? 69,
    binsExtraLow:  u.binsExtraLow  ?? 0,
    binsExtraMid:  u.binsExtraMid  ?? 0,
    binsExtraHigh: u.binsExtraHigh ?? 0,
    binsByStep:    u.binsByStep    ?? {},
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 3,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 15,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature:     u.temperature     ?? 0.373,
    maxTokens:       u.maxTokens       ?? 4096,
    maxSteps:        u.maxSteps        ?? 12,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "deepseek/deepseek-r1",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "deepseek/deepseek-r1",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "deepseek/deepseek-r1",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the deploy amount for a given wallet balance using tiered compounding.
 *
 * Tier table (based on available SOL after gas reserve):
 *   < 5 SOL  → 1 SOL
 *   5–10     → 2 SOL
 *   10–15    → 3 SOL
 *   15–20    → 4 SOL
 *   … and so on — every additional 5 SOL bracket adds 1 SOL.
 *
 * Formula: floor(deployable / 5) + 1, capped by maxDeployAmount.
 * Returns 0 if deployable < 1 SOL (not enough to open a position).
 */
export function computeDeployAmount(walletSol) {
  const reserve    = config.management.gasReserve ?? 0.1;
  const ceil       = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);

  if (deployable < 1) return 0;

  const tier   = Math.floor(deployable / 5) + 1;
  const result = Math.min(ceil, tier);
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.candleLimit           != null) s.candleLimit           = fresh.candleLimit;
    if (fresh.fibConfluenceRequired !== undefined) s.fibConfluenceRequired = fresh.fibConfluenceRequired;
    if (fresh.maxTop10HolderPct     != null) s.maxTop10HolderPct     = fresh.maxTop10HolderPct;
    if (fresh.minFeeActiveTvlRatio  != null) s.minFeeActiveTvlRatio  = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenAgeHours      !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours      !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.maxBundlePct          !== undefined) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct      !== undefined) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.maxTop10Pct           !== undefined) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.minTokenFeesSol       !== undefined) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.athFilterPct          !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.autoBacktest          !== undefined) s.autoBacktest      = fresh.autoBacktest;
    if (fresh.minBacktestWinRate    != null)       s.minBacktestWinRate = fresh.minBacktestWinRate;
    if (fresh.backtestAggregate     != null)       s.backtestAggregate  = fresh.backtestAggregate;
    if (fresh.binsExtraLow  != null) config.strategy.binsExtraLow  = fresh.binsExtraLow;
    if (fresh.binsExtraMid  != null) config.strategy.binsExtraMid  = fresh.binsExtraMid;
    if (fresh.binsExtraHigh != null) config.strategy.binsExtraHigh = fresh.binsExtraHigh;
    if (fresh.binsByStep    != null) config.strategy.binsByStep    = fresh.binsByStep;
    if (fresh.partialHarvestPct !== undefined) config.management.partialHarvestPct = fresh.partialHarvestPct;
  } catch { /* ignore */ }
}
