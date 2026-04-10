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
    maxPositions:              u.maxPositions              ?? 3,
    maxDeployAmount:           u.maxDeployAmount           ?? 50,
    exposureWarningPct:        u.exposureWarningPct        ?? 0.50,  // soft warning threshold (50%)
    totalExposureCapPct:       u.totalExposureCapPct       ?? 0.60,  // max % of balance deployed (60% hard cap)
    exposureHardPauseMinutes:  u.exposureHardPauseMinutes ?? 15,    // hard pause duration (minutes)
    exposureGasReserve:        u.exposureGasReserve        ?? 1.0,   // SOL reserved for gas (excluded from cap calc)
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minTvl:        u.minTvl        ?? 5_000,
    maxTvl:        u.maxTvl        ?? 500_000,
    minVolume:     u.minVolume     ?? 150_000,
    minOrganic:    u.minOrganic    ?? 60,
    minHolders:        u.minHolders        ?? 500,
    maxBundlePct:         u.maxBundlePct         ?? 30,
    maxBotHoldersPct:     u.maxBotHoldersPct     ?? 30,
    maxTop10Pct:          u.maxTop10Pct          ?? 22,
    minTokenFeesSol:           u.minTokenFeesSol           ?? 25,
    minTokenFeesSolHighMcap:  u.minTokenFeesSolHighMcap  ?? 80,  // fee min for mcap > $1M
    athFilterPct:            u.athFilterPct            ?? null,
    minMcap:       u.minMcap       ?? 200_000,
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
    maxTechnicalAnalysisCandidates: u.maxTechnicalAnalysisCandidates ?? 10,  // Birdeye 60 RPM ÷ 2 calls = 30 max. We use 10 (~33% of limit).
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
    minFeePerTvl24h:           u.minFeePerTvl24h           ?? 1,
    lowYieldCheckIntervalMin:   u.lowYieldCheckIntervalMin   ?? 120, // 2h per position
    minAgeBeforeYieldCheck:     u.minAgeBeforeYieldCheck     ?? 60,
    minSolToOpen:          u.minSolToOpen          ?? 0.6,
    minDeployAmountSol:    u.minDeployAmountSol    ?? (u.deployAmountSol ?? 0.5), // minimum validation — actual deploy is tiered: floor(sol/5)+1
    gasReserve:            u.gasReserve            ?? 0.1,
    // Partial harvest — auto-close at this PnL% (between soft TP and max TP). null = disabled.
    partialHarvestPct:     u.partialHarvestPct     ?? null,
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
    managementIntervalMin:  u.managementIntervalMin  ?? 5,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 15,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── Dashboard / Public API ─────────────────
  dashboard: {
    baseUrl:        u.dashboardBaseUrl        ?? "http://localhost:3000",
    apiKey:         u.dashboardApiKey         ?? null,
    refreshIntervalSec: u.dashboardRefreshSec ?? 30,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature:     u.temperature     ?? 0.373,
    maxTokens:       u.maxTokens       ?? 4096,
    maxSteps:        u.maxSteps        ?? 12,
    screeningModel:  u.screeningModel  ?? "MiniMax-M2.7",
    managementModel: u.managementModel ?? "MiniMax-M2.7",
    generalModel:    u.generalModel    ?? "MiniMax-M2.7",
    minimaxApiKey:   u.minimaxApiKey   ?? null,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Tiered position sizing based on total wallet balance.
 *
 * Tiers:
 *   < 8 SOL   → 1.5 SOL per posisi
 *   8–15 SOL  → 2.8 SOL per posisi
 *   15–25 SOL → 4.2 SOL per posisi
 *   25–40 SOL → 6.0 SOL per posisi
 *   > 40 SOL  → min(18% wallet, 9 SOL)
 *
 * Selalu di-cap oleh single-position max = exposurableBalance × totalExposureCapPct.
 * Returns 0 jika saldo tidak cukup untuk deploy minimum.
 */
export function getPositionSizing(totalSol) {
  const gasReserve = config.risk.exposureGasReserve ?? 1.0;
  const capPct     = config.risk.totalExposureCapPct ?? 0.60;

  const exposurableBalance = Math.max(0, totalSol - gasReserve);
  if (exposurableBalance < 1.0) return 0;

  let perPosition;
  if (totalSol < 8)         perPosition = 1.5;
  else if (totalSol < 15)   perPosition = 2.8;
  else if (totalSol < 25)   perPosition = 4.2;
  else if (totalSol <= 40)  perPosition = 6.0;
  else                      perPosition = Math.min(totalSol * 0.18, 9.0);

  // Hard cap: single position tidak boleh melebihi totalExposureCapPct% exposurable balance
  const maxSinglePosition = exposurableBalance * capPct;
  perPosition = Math.min(perPosition, maxSinglePosition, config.risk.maxDeployAmount ?? 50);

  return parseFloat(perPosition.toFixed(2));
}

/**
 * Total value USD dari semua posisi aktif.
 * Setelah fix dlmm.js getMyPositions (valueNative → USD conversion),
 * total_value_usd sudah dalam USD. Tidak perlu bagi solPrice lagi.
 * @param {Array} positions - array position objects dari getMyPositions
 * @returns {number} total value USD
 */
export function calculateCurrentExposure(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return 0;
  const totalUsd = positions.reduce((sum, p) => sum + (p.total_value_usd ?? 0), 0);
  return Math.round(totalUsd * 100) / 100;
}

/**
 * Cek apakah membuka posisi baru dengan proposedAmountSol masih dalam exposure cap.
 *
 * @param {number} proposedAmountSol    - SOL yang akan di-deploy
 * @param {number} currentExposureSol   - Total SOL yang sudah di-deploy (dari calculateCurrentExposure)
 * @param {number} walletSol            - Total saldo wallet saat ini
 * @returns {{ allowed: boolean, currentExposureSol: number, projectedExposureSol: number,
 *             maxExposureSol: number, exposurePct: number, reason?: string }}
 */
export function canOpenNewPosition(proposedAmountSol, currentExposureSol, walletSol) {
  const gasReserve = config.risk.exposureGasReserve ?? 1.0;
  const capPct     = config.risk.totalExposureCapPct ?? 0.60;

  const exposurableBalance  = Math.max(0, walletSol - gasReserve);
  const maxExposureSol      = parseFloat((exposurableBalance * capPct).toFixed(4));
  const projectedExposureSol = parseFloat((currentExposureSol + proposedAmountSol).toFixed(4));
  const exposurePct = exposurableBalance > 0
    ? parseFloat(((projectedExposureSol / exposurableBalance) * 100).toFixed(1))
    : 100;

  const allowed = projectedExposureSol <= maxExposureSol + 0.001; // +0.001 untuk floating point tolerance

  return {
    allowed,
    currentExposureSol: parseFloat(currentExposureSol.toFixed(3)),
    projectedExposureSol,
    maxExposureSol,
    exposurePct,
    ...(!allowed && {
      reason: `Exposure cap terlampaui: ${projectedExposureSol.toFixed(2)} SOL projected > ${maxExposureSol.toFixed(2)} SOL max (${capPct * 100}% of ${exposurableBalance.toFixed(2)} SOL)`,
    }),
  };
}

/**
 * Robust exposure check: pre-deployment validation with warning + hard cap.
 * Returns level: "ok" | "warning" | "hard_pause"
 *
 * @param {number} currentExposureSol - Total SOL already deployed
 * @param {number} walletSol         - Current wallet SOL balance
 * @param {number} proposedAmountSol - Proposed SOL to deploy (optional, default = getPositionSizing)
 * @returns {{ level: string, exposurePct: number, warningPct: number, hardCapPct: number,
 *            gasReserveSol: number, currentExposureSol: number, projectedExposureSol: number,
 *            maxExposureSol: number, allowed: boolean, reason?: string, pauseUntil?: number }}
 */
export function checkExposureCap(currentExposureSol, walletSol, proposedAmountSol = null) {
  const gasReserve     = config.risk.exposureGasReserve ?? 1.0;
  const warningPct     = (config.risk.exposureWarningPct ?? 0.50) * 100;
  const hardCapPct     = (config.risk.totalExposureCapPct ?? 0.60) * 100;
  const pauseMinutes   = config.risk.exposureHardPauseMinutes ?? 15;

  const exposurableBalance = Math.max(0, walletSol - gasReserve);
  const maxExposureSol     = parseFloat((exposurableBalance * hardCapPct / 100).toFixed(4));

  if (proposedAmountSol === null) {
    proposedAmountSol = getPositionSizing(walletSol);
  }

  const projectedExposureSol = parseFloat((currentExposureSol + proposedAmountSol).toFixed(4));
  const exposurePct = exposurableBalance > 0
    ? parseFloat(((projectedExposureSol / exposurableBalance) * 100).toFixed(1))
    : 100;

  // Hard cap check
  if (exposurePct >= hardCapPct) {
    return {
      level: "hard_pause",
      exposurePct,
      warningPct,
      hardCapPct,
      gasReserveSol: gasReserve,
      currentExposureSol: parseFloat(currentExposureSol.toFixed(3)),
      projectedExposureSol,
      maxExposureSol,
      allowed: false,
      pauseUntil: Date.now() + pauseMinutes * 60_000,
      reason: `⚠️ HARD CAP: exposure ${exposurePct}% >= ${hardCapPct.toFixed(0)}% — new entry PAUSED for ${pauseMinutes} min. Current ${currentExposureSol.toFixed(2)} SOL + pending ${proposedAmountSol.toFixed(2)} SOL = ${projectedExposureSol.toFixed(2)} SOL (max ${maxExposureSol.toFixed(2)} SOL)`,
    };
  }

  // Soft warning check
  if (exposurePct >= warningPct) {
    return {
      level: "warning",
      exposurePct,
      warningPct,
      hardCapPct,
      gasReserveSol: gasReserve,
      currentExposureSol: parseFloat(currentExposureSol.toFixed(3)),
      projectedExposureSol,
      maxExposureSol,
      allowed: true,
      reason: `⚠️ SOFT WARNING: exposure ${exposurePct}% >= ${warningPct.toFixed(0)}% — approaching hard cap. Projected ${projectedExposureSol.toFixed(2)} SOL / ${maxExposureSol.toFixed(2)} SOL`,
    };
  }

  return {
    level: "ok",
    exposurePct,
    warningPct,
    hardCapPct,
    gasReserveSol: gasReserve,
    currentExposureSol: parseFloat(currentExposureSol.toFixed(3)),
    projectedExposureSol,
    maxExposureSol,
    allowed: true,
  };
}

/**
 * @deprecated Gunakan getPositionSizing(). Wrapper untuk backward compatibility.
 */
export function computeDeployAmount(walletSol) {
  return getPositionSizing(walletSol);
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
    if (fresh.maxTechnicalAnalysisCandidates != null) s.maxTechnicalAnalysisCandidates = fresh.maxTechnicalAnalysisCandidates;
    if (fresh.maxTop10Pct         != null) s.maxTop10Pct         = fresh.maxTop10Pct;
    if (fresh.minFeeActiveTvlRatio  != null) s.minFeeActiveTvlRatio  = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenAgeHours      !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours      !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.maxBundlePct          !== undefined) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct      !== undefined) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.maxTop10Pct           !== undefined) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.minTokenFeesSol           !== undefined) s.minTokenFeesSol          = fresh.minTokenFeesSol;
    if (fresh.minTokenFeesSolHighMcap   !== undefined) s.minTokenFeesSolHighMcap  = fresh.minTokenFeesSolHighMcap;
    if (fresh.athFilterPct              !== undefined) s.athFilterPct             = fresh.athFilterPct;
    if (fresh.autoBacktest          !== undefined) s.autoBacktest      = fresh.autoBacktest;
    if (fresh.minBacktestWinRate    != null)       s.minBacktestWinRate = fresh.minBacktestWinRate;
    if (fresh.backtestAggregate     != null)       s.backtestAggregate  = fresh.backtestAggregate;
    if (fresh.rsiMin                != null)       s.rsiMin             = fresh.rsiMin;
    if (fresh.minConfluenceScore    != null)       s.minConfluenceScore = fresh.minConfluenceScore;
    if (fresh.binsExtraLow  != null) config.strategy.binsExtraLow  = fresh.binsExtraLow;
    if (fresh.binsExtraMid  != null) config.strategy.binsExtraMid  = fresh.binsExtraMid;
    if (fresh.binsExtraHigh != null) config.strategy.binsExtraHigh = fresh.binsExtraHigh;
    if (fresh.binsByStep    != null) config.strategy.binsByStep    = fresh.binsByStep;
    if (fresh.partialHarvestPct !== undefined) config.management.partialHarvestPct = fresh.partialHarvestPct;
  } catch { /* ignore */ }
}
