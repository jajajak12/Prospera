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
    minHolders:    u.minHolders    ?? 500,
    minMcap:       u.minMcap       ?? 150_000,
    maxMcap:       u.maxMcap       ?? 10_000_000,
    minBinStep:    u.minBinStep    ?? 80,
    maxBinStep:    u.maxBinStep    ?? 200,
    timeframe:     u.timeframe     ?? "1m",
    // Fibonacci-specific
    candleLimit:           u.candleLimit           ?? 50,
    fibConfluenceRequired: u.fibConfluenceRequired ?? true,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 10,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? -20,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 10,
    takeProfitMaxPct:      u.takeProfitMaxPct      ?? u.takeProfitFeePct ?? 15,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 5,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
    minSolToOpen:          u.minSolToOpen          ?? 0.6,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.1,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit (disabled by default for Fibonacci strategy)
    trailingTakeProfit:    u.trailingTakeProfit    ?? false,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 5,
    trailingDropPct:       u.trailingDropPct       ?? 2,
    solMode:               u.solMode               ?? false,
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
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.1;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
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
    if (fresh.candleLimit    != null) s.candleLimit    = fresh.candleLimit;
    if (fresh.fibConfluenceRequired !== undefined) s.fibConfluenceRequired = fresh.fibConfluenceRequired;
    if (fresh.binsExtraLow  != null) config.strategy.binsExtraLow  = fresh.binsExtraLow;
    if (fresh.binsExtraMid  != null) config.strategy.binsExtraMid  = fresh.binsExtraMid;
    if (fresh.binsExtraHigh != null) config.strategy.binsExtraHigh = fresh.binsExtraHigh;
    if (fresh.binsByStep    != null) config.strategy.binsByStep    = fresh.binsByStep;
  } catch { /* ignore */ }
}
