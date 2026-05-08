import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS_DIR = path.join(__dirname, "..", "data", "diagnostics");
export const SCREENING_SNAPSHOT_PATH = path.join(DIAGNOSTICS_DIR, "screening_signal_snapshots.jsonl");
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVES = 5;

function ensureDiagnosticsDir() {
  if (!fs.existsSync(DIAGNOSTICS_DIR)) {
    fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  }
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const { size } = fs.statSync(filePath);
    if (size < MAX_FILE_SIZE_BYTES) return;
    for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i + 1 > MAX_ARCHIVES) fs.unlinkSync(src);
        else fs.renameSync(src, dest);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (err) {
    log.warn("diagnostics", `screening snapshot rotation failed: ${err.message}`);
  }
}

function roundNumber(value, digits = 8) {
  return Number.isFinite(value) ? Math.round(value * (10 ** digits)) / (10 ** digits) : null;
}

function summarizeMicroConsolidation(micro) {
  if (!micro || typeof micro !== "object") return null;
  return {
    available: micro.available ?? null,
    timeframe: micro.timeframe ?? null,
    decision: micro.decision ?? null,
    candlesAfterATH: micro.candlesAfterATH ?? null,
    pullbackFromATHPct: micro.pullbackFromATHPct ?? null,
    deepestPullbackPct: micro.deepestPullbackPct ?? null,
    consolidationMinutes: micro.consolidationMinutes ?? null,
    rangeCompressionPct: micro.rangeCompressionPct ?? null,
    supportHoldCount: micro.supportHoldCount ?? null,
    volumeCooldownPct: micro.volumeCooldownPct ?? null,
    immediateCollapse: micro.immediateCollapse ?? null,
  };
}

function inferGate(reason = "") {
  if (!reason) return null;
  if (reason.includes("Fib 0.500")) return "FIB_500_GATE";
  if (reason.includes("BLOWOFF_TOP_")) return "BLOWOFF_GUARD";
  if (reason.includes("RSI_SLOPE")) return "RSI_SLOPE_GUARD";
  if (reason.includes("RSI momentum weak")) return "RSI_LEVEL_GUARD";
  if (reason.includes("deep pullback zone")) return "FIB_ZONE_GUARD";
  if (reason.includes("EMA trend bearish")) return "EMA_TREND_GUARD";
  if (reason.includes("RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP")) return "RANGE_COVERAGE_GUARD";
  if (reason.includes("Chart data unavailable")) return "DATA_UNAVAILABLE";
  if (reason.includes("Insufficient candle data")) return "INSUFFICIENT_CANDLES";
  return "OTHER";
}

export function buildScreeningSignalSnapshot({ token, pool, analysis, currentPrice = null }) {
  const fib = analysis?.fibLevels ?? null;
  const mainOhlcv = analysis?.analysisDiagnostics?.mainOhlcv ?? {};
  return {
    timestamp: new Date().toISOString(),
    mint: token?.mint ?? null,
    symbol: token?.symbol ?? null,
    name: token?.name ?? null,
    poolAddress: pool?.pool ?? null,
    binStep: pool?.bin_step ?? null,
    selectedPoolSource: pool?._source ?? null,
    marketCap: token?.mcap ?? null,
    volume1h: token?._volH1 ?? null,
    liquidityTvl: pool?.active_tvl ?? pool?.tvl ?? null,
    currentPrice: roundNumber(analysis?.currentPrice ?? currentPrice, 12),
    ath: roundNumber(analysis?.ath ?? fib?.swingHigh ?? null, 12),
    fib236: roundNumber(fib?.fib236 ?? null, 12),
    fib382: roundNumber(fib?.fib382 ?? null, 12),
    fib500: roundNumber(fib?.fib500 ?? null, 12),
    fib618: roundNumber(fib?.fib618 ?? null, 12),
    rangeTop: roundNumber(analysis?.rangeTopPrice ?? null, 12),
    rangeBottom: roundNumber(analysis?.rangeBottomPrice ?? null, 12),
    selectedTimeframe: analysis?.analysisDiagnostics?.selectedTimeframe ?? "5m",
    ohlcvProvider: mainOhlcv.provider ?? null,
    candleCount: mainOhlcv.candleCount ?? null,
    firstCandleTimestamp: mainOhlcv.firstCandleTimestamp ?? null,
    lastCandleTimestamp: mainOhlcv.lastCandleTimestamp ?? null,
    candlesNormalizedAscending: mainOhlcv.normalizedAscending ?? null,
    rsi: analysis?.rsi ?? null,
    rsiSlope: analysis?.rsiSlope ?? null,
    ema20: analysis?.ema20 ?? null,
    ema50: analysis?.ema50 ?? null,
    blowoffClassification: analysis?.blowoffClassification ?? null,
    microConsolidation: summarizeMicroConsolidation(analysis?.microConsolidation),
    rejectionReason: analysis?.signal === "ENTRY" ? null : (analysis?.reason ?? null),
    finalDecision: analysis?.signal ?? "SKIP",
    rejectionGate: inferGate(analysis?.reason ?? ""),
    deployValidationReached: analysis?.signal === "ENTRY",
  };
}

export function appendScreeningSignalSnapshot(snapshot) {
  try {
    ensureDiagnosticsDir();
    rotateIfNeeded(SCREENING_SNAPSHOT_PATH);
    fs.appendFileSync(SCREENING_SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
  } catch (err) {
    log.warn("diagnostics", `screening snapshot append failed: ${err.message}`);
  }
}
