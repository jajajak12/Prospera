/**
 * chart.js — Hybrid OHLCV + Fibonacci + Indicators
 *
 * Signal engine for the Fibonacci LP agent.
 * Fetches candles via HybridDataProvider (GeckoTerminal primary → Birdeye fallback → skip candidate), calculates:
 *   - Fibonacci retracement levels (ATH/ATL from daily candles)
 *   - EMA trend filter (EMA20 > EMA50)
 *   - RSI momentum: RSI > 48 + rising slope
 *   - Hidden Bullish Divergence detection → score boost
 *   - Dynamic bins_above based on zone (ATH passive-bid or PRIMARY)
 *
 * Volume Profile is available via buildVolumeProfile() but is NOT used in
 * confluence scoring or entry decisions — purely informational if needed externally.
 */

import { hybridDataProvider } from "./dataProvider.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITION_META_PATH = path.join(__dirname, "../position-meta.json");
const POOL_MEMORY_PATH = path.join(__dirname, "../pool-memory.json");

// ─── OHLCV Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch main intraday OHLCV candles for a Solana token.
 * Production timeframe remains 5m unless config-driven callers explicitly request otherwise.
 */
export async function fetchOHLCV(tokenMint, limit = 50, poolAddress = null) {
  return hybridDataProvider.getOHLCV(poolAddress, "5m", limit, "solana", tokenMint);
}

async function fetchMicroOHLCV(tokenMint, limit = 120, poolAddress = null, timeframe = "1m") {
  return hybridDataProvider.getOHLCV(poolAddress, timeframe, limit, "solana", tokenMint);
}

/**
 * Fetch daily OHLCV candles for a token.
 * Used to find ATH and all-time-low across the token's full price history.
 */
export async function fetchDailyOHLCV(tokenMint, limit = 1000, poolAddress = null) {
  try {
    return await hybridDataProvider.getOHLCV(poolAddress, "1D", limit, "solana", tokenMint);
  } catch {
    return null; // non-fatal — fall back to intraday swing
  }
}

// ─── Wick Filter ─────────────────────────────────────────────────────────────

/**
 * Return the effective high for a candle, suppressing anomalous upper wicks.
 * Doji (body < 0.1% of high) → use candle.high as-is (wick is price action).
 * Upper wick >= body * wickRatioThreshold → use body top (max of open/close).
 */
function effectiveHigh(candle, wickRatioThreshold = 1.0) {
  const bodyTop = Math.max(candle.open, candle.close);
  const body = Math.abs(candle.open - candle.close);
  if (body < candle.high * 0.001) return candle.high; // doji — skip filter
  const upperWick = candle.high - bodyTop;
  if (upperWick >= body * wickRatioThreshold) return bodyTop;
  return candle.high;
}

// ─── Swing Detection ─────────────────────────────────────────────────────────

/**
 * Detect swing high and swing low from candles array.
 * wickRatioThreshold: when set, suppresses spike wicks via effectiveHigh().
 * Returns { swingHigh, swingLow, highIndex, lowIndex }
 */
export function detectSwing(candles, wickRatioThreshold = null) {
  let swingHigh = -Infinity, highIndex = 0;
  let swingLow  =  Infinity, lowIndex  = 0;

  for (let i = 0; i < candles.length; i++) {
    const hi = wickRatioThreshold != null ? effectiveHigh(candles[i], wickRatioThreshold) : candles[i].high;
    if (hi > swingHigh) { swingHigh = hi; highIndex = i; }
    if (candles[i].low < swingLow) { swingLow = candles[i].low; lowIndex = i; }
  }

  return { swingHigh, swingLow, highIndex, lowIndex };
}

// ─── Price Action S/R Detection ──────────────────────────────────────────────

/**
 * Find local swing lows (support levels) from candle data.
 * A swing low is a candle whose low is lower than `lookback` candles on each side.
 */
function findSwingLows(candles, lookback = 5) {
  const levels = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const price = candles[i].low;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].low <= price) { isLow = false; break; }
    }
    if (isLow) levels.push(price);
  }
  return levels;
}

/**
 * Find local swing highs (resistance levels) from candle data.
 */
function findSwingHighs(candles, lookback = 5, wickRatioThreshold = null) {
  const levels = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const price = wickRatioThreshold != null ? effectiveHigh(candles[i], wickRatioThreshold) : candles[i].high;
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const cmpPrice = wickRatioThreshold != null ? effectiveHigh(candles[j], wickRatioThreshold) : candles[j].high;
      if (cmpPrice >= price) { isHigh = false; break; }
    }
    if (isHigh) levels.push(price);
  }
  return levels;
}

// ─── Fibonacci Levels ────────────────────────────────────────────────────────

/**
 * Calculate Fibonacci retracement levels from swing high to low.
 * fib0 = swing high (0% retracement), fib100 = swing low (100% retracement).
 */
export function calcFibLevels(swingHigh, swingLow) {
  const range = swingHigh - swingLow;
  return {
    fib0:   swingHigh,
    fib236: swingHigh - 0.236 * range,
    fib326: swingHigh - 0.326 * range,
    fib382: swingHigh - 0.382 * range,
    fib500: swingHigh - 0.500 * range,
    fib618: swingHigh - 0.618 * range,
    fib786: swingHigh - 0.786 * range,
    fib100: swingLow,
    swingHigh,
    swingLow,
    range,
  };
}

// ─── Volume Profile ──────────────────────────────────────────────────────────

/**
 * Build volume profile from candles (50 price buckets).
 * Assigns each candle's volume to the bucket containing its midpoint (high+low)/2.
 * POC = highest volume bucket. Value Area = 70% of total volume around POC.
 *
 * Returns { poc, vah, val, buckets, pocIdx, loIdx, hiIdx }
 */
export function buildVolumeProfile(candles, numBuckets = 50) {
  const priceMax = Math.max(...candles.map(c => c.high));
  const priceMin = Math.min(...candles.map(c => c.low));
  const priceRange = priceMax - priceMin;

  if (priceRange === 0) {
    return { poc: priceMin, vah: priceMin, val: priceMin, buckets: [] };
  }

  const bucketSize = priceRange / numBuckets;
  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    index:      i,
    priceLow:   priceMin + i * bucketSize,
    priceHigh:  priceMin + (i + 1) * bucketSize,
    priceMid:   priceMin + (i + 0.5) * bucketSize,
    volume:     0,
  }));

  for (const c of candles) {
    const mid = (c.high + c.low) / 2;
    const idx = Math.min(Math.floor((mid - priceMin) / bucketSize), numBuckets - 1);
    if (idx >= 0) buckets[idx].volume += c.volume;
  }

  // POC = max volume bucket
  let pocIdx = 0;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;
  }
  const poc = buckets[pocIdx].priceMid;

  // Value Area = expand from POC until 70% of total volume covered
  const totalVolume  = buckets.reduce((s, b) => s + b.volume, 0);
  const targetVolume = totalVolume * 0.70;
  let loIdx = pocIdx, hiIdx = pocIdx;
  let accumulated = buckets[pocIdx].volume;

  while (accumulated < targetVolume) {
    const canLo = loIdx > 0;
    const canHi = hiIdx < numBuckets - 1;
    if (!canLo && !canHi) break;

    const loVol = canLo ? buckets[loIdx - 1].volume : -Infinity;
    const hiVol = canHi ? buckets[hiIdx + 1].volume : -Infinity;

    if (loVol >= hiVol) { loIdx--; accumulated += buckets[loIdx].volume; }
    else                { hiIdx++; accumulated += buckets[hiIdx].volume; }
  }

  return {
    poc,
    vah:    buckets[hiIdx].priceHigh,
    val:    buckets[loIdx].priceLow,
    buckets,
    pocIdx,
    loIdx,
    hiIdx,
  };
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

/**
 * Calculate EMA values for a given period from candles close prices.
 * Returns array of EMA values (same length as candles, null for warmup period).
 */
export function calcEMA(candles, period) {
  if (candles.length < period) return candles.map(() => null);

  const k = 2 / (period + 1);
  const result = candles.map(() => null);

  // Seed with SMA of first `period` candles
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    result[i] = ema;
  }

  return result;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

/**
 * Calculate RSI values (Wilder's smoothing) for a given period.
 * Returns array of RSI values (null during warmup).
 */
export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return candles.map(() => null);

  const result = candles.map(() => null);
  let avgGain = 0, avgLoss = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff;
    else          avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }

  return result;
}

function getFiniteVolume(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function calcMoneyFlowPoint(candle) {
  if (!candle) return null;
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const volume = getFiniteVolume(Number(candle.volume));

  if (![high, low, close].every(Number.isFinite)) return null;
  const range = high - low;
  if (!Number.isFinite(range) || range <= 0) {
    return { mfm: 0, mfv: 0, volume };
  }

  const mfm = ((close - low) - (high - close)) / range;
  if (!Number.isFinite(mfm)) {
    return { mfm: 0, mfv: 0, volume };
  }

  const mfv = mfm * volume;
  return {
    mfm,
    mfv: Number.isFinite(mfv) ? mfv : 0,
    volume,
  };
}

export function calcADLine(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let cumulative = 0;
  let hasAnyPoint = false;
  const adLine = [];

  for (const candle of candles) {
    const point = calcMoneyFlowPoint(candle);
    if (!point) {
      adLine.push(hasAnyPoint ? cumulative : 0);
      continue;
    }
    cumulative += point.mfv;
    if (Number.isFinite(cumulative)) {
      hasAnyPoint = true;
      adLine.push(cumulative);
    } else {
      return null;
    }
  }

  return hasAnyPoint ? adLine : null;
}

export function calcADSlope(candles, lookback = 5) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const adLine = calcADLine(candles);
  if (!Array.isArray(adLine) || adLine.length < 2) return null;

  const valid = adLine.filter(Number.isFinite);
  const normalizedLookback = Math.max(2, Number(lookback) || 5);
  if (valid.length < normalizedLookback) return null;

  const tail = valid.slice(-normalizedLookback);
  const slope = tail[tail.length - 1] - tail[0];
  return Number.isFinite(slope) ? slope : null;
}

export function calcCMF(candles, period = 20) {
  if (!Array.isArray(candles)) return null;
  const normalizedPeriod = Math.max(1, Number(period) || 20);
  if (candles.length < normalizedPeriod) return null;

  const window = candles.slice(-normalizedPeriod);
  let mfvSum = 0;
  let volumeSum = 0;

  for (const candle of window) {
    const point = calcMoneyFlowPoint(candle);
    if (!point) return null;
    mfvSum += point.mfv;
    volumeSum += point.volume;
  }

  if (!Number.isFinite(mfvSum) || !Number.isFinite(volumeSum) || volumeSum <= 0) return null;
  const cmf = mfvSum / volumeSum;
  return Number.isFinite(cmf) ? cmf : null;
}

export function calcCMF10(candles) {
  return calcCMF(candles, 10);
}

export function calcCMF20(candles) {
  return calcCMF(candles, 20);
}

export function classifyVolumeFlowBias({ cmf20 = null, adSlope = null } = {}) {
  if (!Number.isFinite(cmf20) || !Number.isFinite(adSlope)) return "neutral";
  if (cmf20 > 0.15 && adSlope > 0) return "strong_accumulation";
  if (cmf20 > 0.05 && adSlope > 0) return "accumulation";
  if (cmf20 < -0.15 && adSlope < 0) return "strong_distribution";
  if (cmf20 < -0.05 && adSlope < 0) return "distribution";
  return "neutral";
}

/**
 * Calculate RSI slope over last `lookback` candles.
 * Positive = RSI rising, negative = RSI falling.
 */
export function calcRSISlope(rsiValues, lookback = 5) {
  const valid = rsiValues.filter(v => v != null);
  if (valid.length < lookback) return 0;
  const tail = valid.slice(-lookback);
  return tail[tail.length - 1] - tail[0];
}

/**
 * Detect Hidden Bullish Divergence:
 * Price makes a higher low, but RSI makes a lower low at the same points.
 * Signals underlying bullish momentum during a pullback in an uptrend.
 *
 * Returns true if hidden bullish divergence is detected.
 */
export function detectHiddenBullishDivergence(candles, rsiValues) {
  // Find local swing lows: candle[i].low < candle[i-1].low AND < candle[i+1].low
  const swingLows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i + 1].low &&
      rsiValues[i] != null
    ) {
      swingLows.push({ index: i, price: candles[i].low, rsi: rsiValues[i] });
    }
  }

  if (swingLows.length < 2) return false;

  const prev   = swingLows[swingLows.length - 2];
  const recent = swingLows[swingLows.length - 1];

  // Hidden Bullish: price higher low + RSI lower low
  return recent.price > prev.price && recent.rsi < prev.rsi;
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

/**
 * Calculate latest ATR value (Wilder's smoothing).
 * Returns { atr, atrPct } where atrPct = ATR / currentPrice * 100.
 */
export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return { atr: null, atrPct: null };

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    );
    atr += tr;
  }
  atr /= period;

  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    );
    atr = (atr * (period - 1) + tr) / period;
  }

  const currentPrice = candles[candles.length - 1].close;
  return {
    atr,
    atrPct: currentPrice > 0 ? (atr / currentPrice) * 100 : null,
  };
}

function getCandleSeriesDiagnostics(candles, fallbackTimeframe = null) {
  const meta = candles?._meta ?? {};
  return {
    provider: meta.source ?? null,
    timeframe: meta.timeframe ?? fallbackTimeframe,
    candleCount: Array.isArray(candles) ? candles.length : 0,
    firstCandleTimestamp: meta.firstCandleTimestamp ?? candles?.[0]?.timestamp ?? null,
    lastCandleTimestamp: meta.lastCandleTimestamp ?? candles?.[candles.length - 1]?.timestamp ?? null,
    normalizedAscending: meta.normalizedAscending ?? null,
  };
}

function buildAnalysisDiagnostics({ candles, dailyCandles, timeframe = "5m" } = {}) {
  return {
    selectedTimeframe: timeframe,
    mainOhlcv: getCandleSeriesDiagnostics(candles, timeframe),
    dailyOhlcv: getCandleSeriesDiagnostics(dailyCandles, "1D"),
  };
}

function calcAvg(values) {
  const nums = values.filter(v => Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function calcRangePct(candles) {
  if (!candles || candles.length === 0) return null;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0) return null;
  return ((high - low) / low) * 100;
}

function calcAverageBarRangePct(candles) {
  return calcAvg(candles.map(c => {
    const denom = c.close || c.high || c.low;
    return denom > 0 ? ((c.high - c.low) / denom) * 100 : null;
  }));
}

async function runMicroConsolidationCheck({
  tokenMint,
  symbol,
  poolAddress,
  currentPrice,
  fib,
}) {
  const screeningCfg = config.screening ?? {};
  const timeframe = screeningCfg.microConsolidationTimeframe ?? "1m";
  const minCandles = Math.max(5, screeningCfg.minMicroConsolidationCandles ?? 20);
  const maxRangePct = screeningCfg.maxConsolidationRangePct ?? 18;
  const minPullbackPct = screeningCfg.minPullbackFromAthPct ?? 18;
  const minSupportHoldCount = Math.max(1, screeningCfg.minSupportHoldCount ?? 4);
  const fetchLimit = Math.max(60, minCandles * 3);
  const immediateWindowSize = 5;
  const maxImmediateCollapsePct = 35;
  const maxPostPumpVolatilityRatio = 0.75;
  const minVolumeRetentionRatio = 0.10;
  const maxVolumeRetentionRatio = 0.85;

  const mintOrSymbol = symbol ?? tokenMint;
  let candles;
  try {
    candles = await fetchMicroOHLCV(tokenMint, fetchLimit, poolAddress, timeframe);
  } catch (err) {
    const result = {
      available: false,
      timeframe,
      candlesAfterATH: 0,
      pullbackFromATHPct: null,
      consolidationMinutes: 0,
      rangeCompressionPct: null,
      supportHoldCount: 0,
      volumeCooldownPct: null,
      decision: "UNAVAILABLE",
      error: err.message,
    };
    log("screening", `MICRO_1M_CONSOLIDATION_FAILED mint=${tokenMint} symbol=${mintOrSymbol} candlesAfterATH=0 pullbackFromATHPct=null consolidationMinutes=0 rangeCompressionPct=null supportHoldCount=0 volumeCooldownPct=null decision=${result.decision}`, { pool: poolAddress });
    return result;
  }

  if (!candles || candles.length < minCandles + 1) {
    const result = {
      available: false,
      timeframe,
      candlesAfterATH: candles?.length ?? 0,
      pullbackFromATHPct: null,
      consolidationMinutes: 0,
      rangeCompressionPct: null,
      supportHoldCount: 0,
      volumeCooldownPct: null,
      decision: "UNAVAILABLE",
      error: `insufficient_micro_candles_${candles?.length ?? 0}`,
    };
    log("screening", `MICRO_1M_CONSOLIDATION_FAILED mint=${tokenMint} symbol=${mintOrSymbol} candlesAfterATH=${result.candlesAfterATH} pullbackFromATHPct=null consolidationMinutes=0 rangeCompressionPct=null supportHoldCount=0 volumeCooldownPct=null decision=${result.decision}`, { pool: poolAddress });
    return result;
  }

  let ath = -Infinity;
  let athIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > ath) {
      ath = candles[i].high;
      athIdx = i;
    }
  }

  const postAthAll = candles.slice(athIdx + 1);
  const candlesAfterATH = postAthAll.length;
  const consolidationWindow = postAthAll.slice(0, Math.min(postAthAll.length, Math.max(minCandles * 2, 40)));
  const consolidationMinutes = consolidationWindow.length;
  const lastClose = consolidationWindow[consolidationWindow.length - 1]?.close ?? currentPrice;
  const pullbackFromATHPct = ath > 0 && lastClose > 0 ? ((ath - lastClose) / ath) * 100 : null;
  const postAthMinLow = postAthAll.length > 0 ? Math.min(...postAthAll.map(c => c.low)) : null;
  const deepestPullbackPct = ath > 0 && postAthMinLow != null ? ((ath - postAthMinLow) / ath) * 100 : null;
  const rangeCompressionPct = calcRangePct(consolidationWindow);
  const consolidationHigh = consolidationWindow.length > 0 ? Math.max(...consolidationWindow.map(c => c.high)) : null;
  const consolidationLow = consolidationWindow.length > 0 ? Math.min(...consolidationWindow.map(c => c.low)) : null;
  const supportLevel = consolidationHigh != null && consolidationLow != null
    ? consolidationLow + ((consolidationHigh - consolidationLow) * 0.25)
    : null;
  const supportHoldCount = supportLevel != null
    ? consolidationWindow.filter(c => c.close >= supportLevel).length
    : 0;
  const immediateWindow = postAthAll.slice(0, Math.min(immediateWindowSize, postAthAll.length));
  const immediateCollapse = immediateWindow.some(c => {
    const drawdownPct = ath > 0 ? ((ath - c.low) / ath) * 100 : 0;
    const fibBreak = fib?.fib500 != null && c.close < fib.fib500;
    return drawdownPct >= maxImmediateCollapsePct || fibBreak;
  });
  const pumpLeg = candles.slice(Math.max(0, athIdx - 20), athIdx + 1);
  const pumpVolatilityPct = calcAverageBarRangePct(pumpLeg);
  const consolidationVolatilityPct = calcAverageBarRangePct(consolidationWindow);
  const volatilityCompressed = pumpVolatilityPct != null && consolidationVolatilityPct != null
    ? consolidationVolatilityPct <= (pumpVolatilityPct * maxPostPumpVolatilityRatio)
    : false;
  const pumpVolumeAvg = calcAvg(pumpLeg.map(c => c.volume));
  const consolidationVolumeAvg = calcAvg(consolidationWindow.map(c => c.volume));
  const volumeRetentionRatio = pumpVolumeAvg > 0 && consolidationVolumeAvg != null
    ? (consolidationVolumeAvg / pumpVolumeAvg)
    : null;
  const volumeCooldownPct = volumeRetentionRatio != null
    ? (1 - volumeRetentionRatio) * 100
    : null;
  const volumeHealthy = volumeRetentionRatio != null
    ? volumeRetentionRatio >= minVolumeRetentionRatio && volumeRetentionRatio <= maxVolumeRetentionRatio
    : false;

  const enoughCandles = candlesAfterATH >= minCandles;
  const pullbackOk = pullbackFromATHPct != null && pullbackFromATHPct >= minPullbackPct;
  const rangeOk = rangeCompressionPct != null && rangeCompressionPct <= maxRangePct;
  const supportOk = supportHoldCount >= minSupportHoldCount;

  let decision = "FAILED_NO_CONSOLIDATION";
  if (enoughCandles && pullbackOk && !immediateCollapse && rangeOk && supportOk && volatilityCompressed && volumeHealthy) {
    decision = "HEALTHY_CONSOLIDATION";
  } else if (enoughCandles && !immediateCollapse && supportOk && volatilityCompressed && (pullbackOk || rangeOk)) {
    decision = "WATCH_CONSOLIDATION";
  }

  const result = {
    available: true,
    timeframe,
    candlesAfterATH,
    pullbackFromATHPct: pullbackFromATHPct != null ? Math.round(pullbackFromATHPct * 100) / 100 : null,
    deepestPullbackPct: deepestPullbackPct != null ? Math.round(deepestPullbackPct * 100) / 100 : null,
    consolidationMinutes,
    rangeCompressionPct: rangeCompressionPct != null ? Math.round(rangeCompressionPct * 100) / 100 : null,
    supportHoldCount,
    supportLevel: supportLevel != null ? Math.round(supportLevel * 1e8) / 1e8 : null,
    volumeCooldownPct: volumeCooldownPct != null ? Math.round(volumeCooldownPct * 100) / 100 : null,
    pumpVolatilityPct: pumpVolatilityPct != null ? Math.round(pumpVolatilityPct * 100) / 100 : null,
    consolidationVolatilityPct: consolidationVolatilityPct != null ? Math.round(consolidationVolatilityPct * 100) / 100 : null,
    decision,
    immediateCollapse,
  };

  log("screening", `MICRO_1M_CONSOLIDATION_CHECK mint=${tokenMint} symbol=${mintOrSymbol} candlesAfterATH=${result.candlesAfterATH} pullbackFromATHPct=${result.pullbackFromATHPct ?? "null"} consolidationMinutes=${result.consolidationMinutes} rangeCompressionPct=${result.rangeCompressionPct ?? "null"} supportHoldCount=${result.supportHoldCount} volumeCooldownPct=${result.volumeCooldownPct ?? "null"} decision=${result.decision}`, { pool: poolAddress });
  if (decision === "HEALTHY_CONSOLIDATION") {
    log("screening", `MICRO_1M_CONSOLIDATION_HEALTHY mint=${tokenMint} symbol=${mintOrSymbol} candlesAfterATH=${result.candlesAfterATH} pullbackFromATHPct=${result.pullbackFromATHPct ?? "null"} consolidationMinutes=${result.consolidationMinutes} rangeCompressionPct=${result.rangeCompressionPct ?? "null"} supportHoldCount=${result.supportHoldCount} volumeCooldownPct=${result.volumeCooldownPct ?? "null"} decision=${result.decision}`, { pool: poolAddress });
  } else {
    log("screening", `MICRO_1M_CONSOLIDATION_FAILED mint=${tokenMint} symbol=${mintOrSymbol} candlesAfterATH=${result.candlesAfterATH} pullbackFromATHPct=${result.pullbackFromATHPct ?? "null"} consolidationMinutes=${result.consolidationMinutes} rangeCompressionPct=${result.rangeCompressionPct ?? "null"} supportHoldCount=${result.supportHoldCount} volumeCooldownPct=${result.volumeCooldownPct ?? "null"} decision=${result.decision}`, { pool: poolAddress });
  }
  return result;
}

// ─── Bins Calculator ─────────────────────────────────────────────────────────

function getBinRangeConfig() {
  const minBins = Math.max(1, config.screening.minBinsForPosition ?? 35);
  const maxBins = Math.max(minBins, config.screening.maxBinsForPosition ?? 90);
  return { minBins, maxBins };
}

export function calcRawBinsToTarget(currentPrice, targetPrice, binStep) {
  const { minBins } = getBinRangeConfig();
  if (!currentPrice || !targetPrice || targetPrice >= currentPrice) return minBins;
  const n = Math.log(targetPrice / currentPrice) / Math.log(1 - binStep / 10000);
  return Math.max(minBins, Math.round(Math.abs(n)));
}

/**
 * Calculate bins needed to cover from currentPrice down to targetPrice.
 * Uses DLMM geometric price formula and clamps to configured safe limits.
 */
export function calcBinsToTarget(currentPrice, targetPrice, binStep) {
  const { minBins, maxBins } = getBinRangeConfig();
  return Math.max(minBins, Math.min(maxBins, calcRawBinsToTarget(currentPrice, targetPrice, binStep)));
}

/**
 * Calculate bins needed to cover from currentPrice UP to targetPrice.
 * Used for bins_above to cover up to Fib 0.236.
 */
function calcBinsAbove(currentPrice, targetPrice, binStep) {
  if (targetPrice <= currentPrice) return 0;
  const n = Math.log(targetPrice / currentPrice) / Math.log(1 + binStep / 10000);
  return Math.max(0, Math.min(30, Math.round(n)));
}

function calcPriceAfterDownBins(startPrice, bins, binStep) {
  if (!startPrice || startPrice <= 0) return null;
  if (!Number.isFinite(bins) || bins <= 0) return startPrice;
  return startPrice * Math.pow(1 - binStep / 10000, bins);
}

function getFibLevelPrice(fib, level) {
  const normalized = Number(level);
  if (!Number.isFinite(normalized)) return null;
  const map = new Map([
    [0, fib?.fib0],
    [0.236, fib?.fib236],
    [0.326, fib?.fib326],
    [0.382, fib?.fib382],
    [0.5, fib?.fib500],
    [0.500, fib?.fib500],
    [0.618, fib?.fib618],
    [0.786, fib?.fib786],
    [1, fib?.fib100],
  ]);
  return map.get(normalized) ?? null;
}

// ─── Full Signal Analysis ─────────────────────────────────────────────────────

/**
 * Full signal analysis for a pool.
 *
 * Entry conditions (all must pass):
 *   1. Price in ATH zone (> fib236) or PRIMARY zone (near fib_236; fib_236..fib_326 tolerance)
 *   2. EMA trend: EMA20 > EMA50 (uptrend confirmed)
 *   3. RSI momentum: RSI > 48 AND RSI slope positive
 *
 * Confluence score components (no Volume Profile):
 *   - Position within primary zone (centered = higher score)
 *   - Primary zone bonus vs ATH zone
 *   - Hidden Bullish Divergence → +0.15
 *   - RSI slope strength → +0.05–0.10
 *
 * @param {string} tokenMint  — Solana token mint address (used for Birdeye OHLCV)
 * @param {number} binStep
 * @param {number} currentPrice
 * @param {number} candleLimit
 * @returns {Promise<SignalResult>}
 */
export async function analyzeSignal(tokenMint, binStep, currentPrice, candleLimit = 50, opts = {}, poolAddress = null) {
  let analysisDiagnostics = {
    selectedTimeframe: "5m",
    mainOhlcv: {
      provider: null,
      timeframe: "5m",
      candleCount: 0,
      firstCandleTimestamp: null,
      lastCandleTimestamp: null,
      normalizedAscending: null,
    },
    dailyOhlcv: {
      provider: null,
      timeframe: "1D",
      candleCount: 0,
      firstCandleTimestamp: null,
      lastCandleTimestamp: null,
      normalizedAscending: null,
    },
  };
  // ── Hard invalid-price guard ───────────────────────────────────────────────
  // Threshold 1e-12 SOL: allows any realistic token price (even <$0.001 mcap tokens)
  // without falsely rejecting ultra-cheap meme tokens. Old 0.000001 was calibrated for USD.
  if (!currentPrice || currentPrice < 1e-12) {
    log.warn("fib_error", `Invalid price detected: ${currentPrice} — skipping Fib calculation`, { token: tokenMint });
    return skip(`Invalid price (${currentPrice}) — cannot compute Fib levels`, currentPrice, null, null, { analysisDiagnostics });
  }

  // ── Fetch OHLCV (1m for indicators) + Daily (for ATH-based Fibonacci) ──────
  let candles, dailyCandles;
  try {
    // Sequential (not parallel) to respect rate limits
    candles      = await fetchOHLCV(tokenMint, candleLimit, poolAddress);
    dailyCandles = await fetchDailyOHLCV(tokenMint, 1000, poolAddress);
    analysisDiagnostics = buildAnalysisDiagnostics({ candles, dailyCandles, timeframe: "5m" });
  } catch (e) {
    return skip(`Chart data unavailable: ${e.message}`, currentPrice, null, null, { analysisDiagnostics });
  }

  if (!candles || candles.length < 6) {
    return skip(`Insufficient candle data (${candles?.length ?? 0} candles, need 6+)`, currentPrice, null, null, { analysisDiagnostics });
  }

  // ── Fibonacci: drawn from all-time-low → ATH ───────────────────────────────
  // Daily candles give full price history. Fib is the overall range framework;
  // S/R from price action validates which levels are meaningful.
  const wickThresh = config.screening.wickRatioThreshold;
  const intradaySwing = detectSwing(candles, wickThresh);
  const rawCandleATH = (dailyCandles && dailyCandles.length > 0)
    ? Math.max(...dailyCandles.map(c => effectiveHigh(c, wickThresh)))
    : null;
  let cleanedCandleATH = rawCandleATH;
  const dailyATL = (dailyCandles && dailyCandles.length > 0)
    ? Math.min(...dailyCandles.map(c => c.low))
    : null;
  const intradayHigh = intradaySwing.swingHigh;
  const intradayLow = intradaySwing.swingLow;
  const previousKnownATH = getPreviousKnownATH(poolAddress, tokenMint);

  // Launch-spike guard applies ONLY to candle-derived ATH (daily/intraday candles),
  // never to previousKnownATH memory.
  if (cleanedCandleATH != null && cleanedCandleATH > currentPrice * 5 && dailyCandles != null && dailyCandles.length <= 1) {
    const sortedHighs = candles.map(c => effectiveHigh(c, wickThresh)).sort((a, b) => a - b);
    const p95 = sortedHighs[Math.floor(sortedHighs.length * 0.95)] ?? cleanedCandleATH;
    const cleaned = candles.filter(c => effectiveHigh(c, wickThresh) <= p95);
    if (cleaned.length >= 20) {
      const { swingHigh: h } = detectSwing(cleaned, wickThresh);
      if (Number.isFinite(h) && h > 0) cleanedCandleATH = h;
    }
  }

  let rawAth = Math.max(
    ...[cleanedCandleATH, intradayHigh, previousKnownATH].filter(v => Number.isFinite(v) && v > 0)
  );
  if (!Number.isFinite(rawAth)) rawAth = intradayHigh;
  let swingHigh = rawAth;
  if (swingHigh < currentPrice) {
    log("screening", `ATH_CORRECTED_FROM_CURRENT_PRICE ${tokenMint}: rawAth=${fmt(swingHigh)} < currentPrice=${fmt(currentPrice)}`, { pool: poolAddress });
    swingHigh = currentPrice;
  }
  let swingLow = Math.min(
    ...[dailyATL, intradayLow].filter(v => Number.isFinite(v) && v > 0)
  );

  log("screening", `ATH_COMPONENTS ${tokenMint}: rawCandleATH=${fmt(rawCandleATH)} cleanedCandleATH=${fmt(cleanedCandleATH)} intradayHigh=${fmt(intradayHigh)} previousKnownATH=${fmt(previousKnownATH)} currentPrice=${fmt(currentPrice)} finalATH=${fmt(swingHigh)}`, { pool: poolAddress });

  if (swingHigh <= swingLow || swingHigh === swingLow) {
    return skip("No price movement detected (swing_high === swing_low)", currentPrice, null, null, { analysisDiagnostics });
  }

  const fib = calcFibLevels(swingHigh, swingLow);

  // ── Hard gate: NO ENTRY below Fib 0.500 ──────────────────────────────────
  if (currentPrice < fib.fib500) {
    log.warn("screening", `Fib 0.500 gate blocked — price ${fmt(currentPrice)} < fib500 ${fmt(fib.fib500)}`, { token: tokenMint });
    return skip(
      `Price ${fmt(currentPrice)} below Fib 0.500 (${fmt(fib.fib500)}) — no entry allowed`,
      currentPrice, fib, null, { analysisDiagnostics }
    );
  }

  // ── Indicators ────────────────────────────────────────────────────────────
  const ema20Values = calcEMA(candles, 20);
  const ema50Values = calcEMA(candles, 50);
  const rsiValues   = calcRSI(candles, 14);
  const { atr, atrPct } = calcATR(candles, 14);

  const ema20 = ema20Values[ema20Values.length - 1];
  const ema50 = ema50Values[ema50Values.length - 1];
  const rsi   = rsiValues[rsiValues.length - 1];
  const rsiSlope = calcRSISlope(rsiValues, 5);
  const cmf10 = calcCMF10(candles);
  const cmf20 = calcCMF20(candles);
  const adSlope = calcADSlope(candles, 5);
  const volumeFlowBias = classifyVolumeFlowBias({ cmf20, adSlope });
  let microConsolidation = null;
  let blowoffClassification = null;

  // binStep is in basis points (e.g. 100 = 1% per bin)
  const binStepPct = binStep / 100;

  // ── Check 1: Pre-entry pump gate — blowoff top detection ─────────────────
  // Skip if recent candles show large pump (>80% from low) without any correction.
  // A healthy entry needs at least 1 correction candle after the pump peak.
  {
    const lookback = Math.min(candles.length, 10);
    const recent   = candles.slice(-lookback);
    // Find peak high and its index within recent window
    let peakHigh = -Infinity, peakIdx = 0;
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].high > peakHigh) { peakHigh = recent[i].high; peakIdx = i; }
    }
    // Find lowest low BEFORE the peak (the base of the pump)
    let baseLow = Infinity;
    for (let i = 0; i <= peakIdx; i++) {
      if (recent[i].low < baseLow) baseLow = recent[i].low;
    }
    const pumpPct = baseLow > 0 ? (peakHigh - baseLow) / baseLow * 100 : 0;
    // Candles AFTER the peak
    const postPeak = recent.slice(peakIdx + 1);
    // Correction = any red candle OR >5% pullback from peak
    const hasCorrection = postPeak.some(c => c.close < c.open)
      || (postPeak.length > 0 && (peakHigh - postPeak[postPeak.length - 1].close) / peakHigh > 0.05);

    if (pumpPct >= 80 && !hasCorrection) {
      const microEnabled = (config.screening?.enableMicroConsolidationCheck !== false)
        && (config.screening?.microConsolidationOnlyForBlowoff !== false);
      if (microEnabled) {
        microConsolidation = await runMicroConsolidationCheck({
          tokenMint,
          symbol: opts.symbol,
          poolAddress,
          currentPrice,
          fib,
        });
      }

      if (microConsolidation?.decision === "HEALTHY_CONSOLIDATION") {
        blowoffClassification = "BLOWOFF_TOP_DOWNGRADED_POST_PUMP_CONSOLIDATION";
        log("screening", `BLOWOFF_DOWNGRADED_BY_1M_CONSOLIDATION mint=${tokenMint} symbol=${opts.symbol ?? tokenMint} candlesAfterATH=${microConsolidation.candlesAfterATH} pullbackFromATHPct=${microConsolidation.pullbackFromATHPct ?? "null"} consolidationMinutes=${microConsolidation.consolidationMinutes} rangeCompressionPct=${microConsolidation.rangeCompressionPct ?? "null"} supportHoldCount=${microConsolidation.supportHoldCount} volumeCooldownPct=${microConsolidation.volumeCooldownPct ?? "null"} decision=${blowoffClassification}`, { pool: poolAddress });
      } else if (microConsolidation?.decision === "WATCH_CONSOLIDATION") {
        blowoffClassification = "BLOWOFF_TOP_WATCH_CONSOLIDATION";
        return skip(
          `${blowoffClassification}: +${pumpPct.toFixed(0)}% pump on main timeframe; 1m shows developing consolidation but not enough to clear blowoff yet`,
          currentPrice,
          fib,
          null,
          { microConsolidation, blowoffClassification, analysisDiagnostics }
        );
      } else {
        blowoffClassification = "BLOWOFF_TOP_REJECT_TRUE_SUDDEN_PUMP";
        log("screening", `BLOWOFF_CONFIRMED_NO_CONSOLIDATION mint=${tokenMint} symbol=${opts.symbol ?? tokenMint} candlesAfterATH=${microConsolidation?.candlesAfterATH ?? 0} pullbackFromATHPct=${microConsolidation?.pullbackFromATHPct ?? "null"} consolidationMinutes=${microConsolidation?.consolidationMinutes ?? 0} rangeCompressionPct=${microConsolidation?.rangeCompressionPct ?? "null"} supportHoldCount=${microConsolidation?.supportHoldCount ?? 0} volumeCooldownPct=${microConsolidation?.volumeCooldownPct ?? "null"} decision=${blowoffClassification}`, { pool: poolAddress });
        return skip(
          `${blowoffClassification}: +${pumpPct.toFixed(0)}% pump in last ${peakIdx + 1} main candle(s) with no correction`,
          currentPrice,
          fib,
          null,
          { microConsolidation, blowoffClassification, analysisDiagnostics }
        );
      }
    }
  }

  // ── Check 2: Price must be in ATH zone or Primary zone ───────────────────
  const inPrimaryZone = currentPrice >= fib.fib326 && currentPrice <= fib.fib236;
  const inAthZone     = currentPrice > fib.fib236;
  const inEntryRange  = inPrimaryZone || inAthZone;

  if (!inEntryRange) {
    return skip(
      `Price ${fmt(currentPrice)} in deep pullback zone (0.382–0.500) — wait for primary zone near 0.236`,
      currentPrice, fib, null, { analysisDiagnostics }
    );
  }

  // ── Check 3: EMA Trend Filter ──────────────────────────────────────────────
  // If EMA20/EMA50 not yet formed (insufficient candles for that period),
  // skip EMA filter — rely on RSI only for momentum confirmation.
  if (ema20 != null && ema50 != null) {
    if (ema20 <= ema50) {
      return skip(
        `EMA trend bearish — EMA20 (${fmt(ema20)}) <= EMA50 (${fmt(ema50)}). Fib pullback invalid in downtrend.`,
        currentPrice, fib, null, { analysisDiagnostics }
      );
    }
  }

  // ── Check 4: RSI Momentum ─────────────────────────────────────────────────
  const rsiMin = (opts.rsiMin != null ? opts.rsiMin : (inAthZone ? 40 : 45)); // ATH zone: leniency 40, otherwise 45
  if (rsi != null) {
    if (rsi < rsiMin) {
      return skip(
        `RSI momentum weak — RSI=${rsi.toFixed(1)} < ${rsiMin}. Pullback lacks bullish momentum.`,
        currentPrice, fib, null, { analysisDiagnostics }
      );
    }
    if (rsiSlope < -8.0 && !opts.skipRsiSlope) { // slope >= -8.0 allowed; bypass for ATH OOR reposition
      if (microConsolidation?.decision === "HEALTHY_CONSOLIDATION" || microConsolidation?.decision === "WATCH_CONSOLIDATION") {
        return skip(
          `RSI_SLOPE_DECLINING_WATCH_CONSOLIDATION: RSI slope declining (${rsiSlope.toFixed(1)} over 5 candles) while 1m shows post-pump consolidation. Not auto-entering.`,
          currentPrice,
          fib,
          null,
          { microConsolidation, blowoffClassification, analysisDiagnostics }
        );
      }
      return skip(
        `RSI slope declining (${rsiSlope.toFixed(1)} over 5 candles). Need rising momentum for valid entry.`,
        currentPrice, fib, null, { analysisDiagnostics }
      );
    }
  }

  // ── Hidden Bullish Divergence ──────────────────────────────────────────────
  const hasHiddenDivergence = detectHiddenBullishDivergence(candles, rsiValues);

  // ── Entry Zone Tier ────────────────────────────────────────────────────────
  // pricePosition: 0 = at fib236 (top of primary zone), 1 = at fib326 (bottom)
  // For ATH zone (above fib236), clamp to 0
  const primaryWidth  = fib.fib236 - fib.fib326;
  const rawPosition   = primaryWidth > 0 ? (fib.fib236 - currentPrice) / primaryWidth : 0.5;
  const pricePosition = inAthZone ? 0 : Math.max(0, Math.min(1, rawPosition));

  // ── Price Action S/R: find real support below Fib 0.618 ──────────────────
  const dailySR    = dailyCandles ? [...findSwingLows(dailyCandles), ...findSwingHighs(dailyCandles, 5, wickThresh)] : [];
  const intradaySR = [...findSwingLows(candles), ...findSwingHighs(candles, 5, wickThresh)];
  const srLevels   = [...dailySR, ...intradaySR];

  const supportsBelow = srLevels.filter(l => l < fib.fib618).sort((a, b) => b - a);
  const nearestSupport = supportsBelow[0] ?? null;

  // ── bins_below / bins_above ───────────────────────────────────────────────
  // Primary zone: activeBin = currentPrice, range extends DOWN to support.
  //   binsBelow = bins(currentPrice → support), binsAbove = 0
  //   Range = [support, currentPrice] — active bin at top.
  //
  // ATH zone: currentPrice is ABOVE fib236. We want a passive-bid range
  //   from fib236 DOWN to support (entirely below current price).
  //   To achieve this we use NEGATIVE binsAbove to shift the range top
  //   from activeBin (currentPrice) down to fib236:
  //     maxBinId = activeBin + binsAbove = activeBin - shift = fib236_bin  ✓
  //     minBinId = activeBin - binsBelow = activeBin - shift - depth = support_bin  ✓
  //   totalBins = binsBelow + binsAbove = (shift + depth) + (−shift) = depth  ✓
  //   Position starts all-in SOL (passive bid); earns fees as price falls to fib236.

  const atrBuffer     = atr ?? (fib.fib618 * binStepPct / 100);
  const supportTarget = nearestSupport ?? (fib.fib618 * 0.80);
  const supportPrice  = Math.max(supportTarget - atrBuffer, fib.fib786);

  let binsBelow, binsAbove;
  let shiftBins = 0;
  let requiredDepthBinsRaw;

  if (inAthZone) {
    // bin_step can be as small as 0.00001 (0.01 bp/bin) for TOKEN/SOL pairs.
    // At that granularity, a 0.023% price distance gives shiftBins=1 — far too small.
    // Cap effectiveBinStep at 1 bp/step so shift calculation stays meaningful.
    const effectiveBinStep = Math.max(binStep, 1);
    shiftBins = Math.max(0, Math.round(
      Math.abs(Math.log(fib.fib236 / currentPrice) / Math.log(1 - effectiveBinStep / 10000))
    ));
    // Depth of the range: from fib236 down to support (use existing clamped function)
    requiredDepthBinsRaw = calcRawBinsToTarget(fib.fib236, supportPrice, binStep);
    const depthBins = calcBinsToTarget(fib.fib236, supportPrice, binStep);

    binsBelow = shiftBins + depthBins;   // total bins below activeBin to reach support
    binsAbove = -shiftBins;              // negative → shifts range top to fib236
  } else {
    // Primary zone: range from currentPrice down to support
    requiredDepthBinsRaw = calcRawBinsToTarget(currentPrice, supportPrice, binStep);
    binsBelow = calcBinsToTarget(currentPrice, supportPrice, binStep);
    binsAbove = 0;
  }

  const { maxBins: maxBinsForPosition } = getBinRangeConfig();
  const targetTopPrice = inAthZone ? fib.fib236 : currentPrice;
  const minimumBottomFibPrice = getFibLevelPrice(fib, config.screening.minRangeBottomFibLevel ?? 0.618) ?? fib.fib618;
  const targetBottomPrice = nearestSupport ?? minimumBottomFibPrice;
  const computedRangeTopPrice = inAthZone
    ? calcPriceAfterDownBins(currentPrice, shiftBins, binStep)
    : currentPrice;
  const computedRangeBottomPrice = calcPriceAfterDownBins(currentPrice, binsBelow, binStep);
  const topTolerancePct = Math.max(0.01, Math.min(0.03, (Math.max(binStep, 1) / 10000) * 2));
  const topDiffPct = (inAthZone && targetTopPrice > 0 && computedRangeTopPrice > 0)
    ? Math.abs(computedRangeTopPrice - targetTopPrice) / Math.max(targetTopPrice, 1e-12)
    : 0;
  const topCoverageOk = !inAthZone || topDiffPct <= topTolerancePct;
  const bottomCoverageOk = computedRangeBottomPrice != null && targetBottomPrice != null
    ? computedRangeBottomPrice <= targetBottomPrice
    : false;
  const requiredBinCountWithinLimit = requiredDepthBinsRaw <= maxBinsForPosition;
  const rangeCoverageOk = topCoverageOk && bottomCoverageOk && requiredBinCountWithinLimit;

  if (!rangeCoverageOk) {
    return skip(
      `RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP bin_step=${binStep} computedBottom=${fmt(computedRangeBottomPrice)} targetBottom=${fmt(targetBottomPrice)} requiredBins=${requiredDepthBinsRaw}/${maxBinsForPosition}`,
      currentPrice,
      fib,
      {
        targetTopPrice,
        targetBottomPrice,
        computedRangeTopPrice,
        computedRangeBottomPrice,
        topCoverageOk,
        bottomCoverageOk,
        requiredDepthBinsRaw,
        maxBinsForPosition,
        coverageOk: false,
      },
      { analysisDiagnostics }
    );
  }

  // ── Confluence Score (Fib + Momentum only — no Volume Profile) ───────────
  // ATH zone: fixed base 0.35 (passive-bid, less certain than direct primary entry)
  // PRIMARY zone: 0–0.60 based on how centered in the zone (0.5 = ideal)
  const positionScore = Math.max(0, 1 - Math.abs(pricePosition - 0.5) * 2);
  let score = inAthZone ? 0.35 : positionScore * 0.60;

  if (inPrimaryZone)       score += 0.10; // primary zone is more reliable than ATH
  if (hasHiddenDivergence) score += 0.15; // strong momentum signal
  if (rsiSlope > 3)        score += 0.10; // strong RSI momentum
  if (rsiSlope > 0)        score += 0.05; // any positive slope gets small boost

  const confluenceScore = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;

  // ── Build Reason ──────────────────────────────────────────────────────────
  const zoneTier = inAthZone ? "ATH_ZONE(0-0.236)" : "PRIMARY(near 0.236)";
  const rangeTopLabel  = inAthZone ? `fib236 @${fmt(fib.fib236)}` : `current @${fmt(currentPrice)}`;
  const rangeBotLabel  = `support @${fmt(supportPrice)}`;
  const parts = [
    `Zone: ${zoneTier}`,
    `RSI=${rsi?.toFixed(1)} slope=+${rsiSlope.toFixed(1)}`,
    `EMA20>EMA50 ✓`,
    `range: ${rangeTopLabel} → ${rangeBotLabel} (${binsBelow + binsAbove} bins)`,
    inAthZone ? `passiveBid shift=${-binsAbove}bins` : null,
  ].filter(Boolean);
  if (hasHiddenDivergence) parts.push("HiddenDiv ✓");

  return {
    signal:          "ENTRY",
    reason:          parts.join(" | "),
    fibLevels:       fib,
    binsBelow,
    binsAbove,
    // Actual range boundaries (not relative to activeBin):
    rangeTopPrice:   inAthZone ? Math.round(fib.fib236 * 1e8) / 1e8 : Math.round(currentPrice * 1e8) / 1e8,
    rangeBottomPrice: Math.round(supportPrice * 1e8) / 1e8,
    supportPrice:    Math.round(supportTarget * 1e8) / 1e8,
    nearestSupportBelow618: nearestSupport != null ? Math.round(nearestSupport * 1e8) / 1e8 : null,
    rangeCoverage: {
      targetTopPrice: Math.round(targetTopPrice * 1e8) / 1e8,
      targetBottomPrice: Math.round(targetBottomPrice * 1e8) / 1e8,
      computedRangeTopPrice: computedRangeTopPrice != null ? Math.round(computedRangeTopPrice * 1e8) / 1e8 : null,
      computedRangeBottomPrice: computedRangeBottomPrice != null ? Math.round(computedRangeBottomPrice * 1e8) / 1e8 : null,
      requiredDepthBinsRaw,
      maxBinsForPosition,
      topCoverageOk,
      bottomCoverageOk,
      coverageOk: true,
    },
    ath:             Math.round(swingHigh * 1e8) / 1e8,
    atl:             Math.round(swingLow  * 1e8) / 1e8,
    currentPrice,
    confluenceScore,
    pricePosition:   Math.round(pricePosition * 100) / 100,
    inPrimaryZone,
    inAthZone,
    hasHiddenDivergence,
    microConsolidation,
    blowoffClassification,
    analysisDiagnostics,
    rsi:             rsi != null ? Math.round(rsi * 10) / 10 : null,
    rsiSlope:        Math.round(rsiSlope * 10) / 10,
    cmf10:           cmf10 != null ? Math.round(cmf10 * 1000) / 1000 : null,
    cmf20:           cmf20 != null ? Math.round(cmf20 * 1000) / 1000 : null,
    adSlope:         adSlope != null ? Math.round(adSlope * 100) / 100 : null,
    volumeFlowBias,
    ema20:           ema20 != null ? Math.round(ema20 * 1e8) / 1e8 : null,
    ema50:           ema50 != null ? Math.round(ema50 * 1e8) / 1e8 : null,
    atrPct:          atrPct != null ? Math.round(atrPct * 100) / 100 : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  return n != null ? n.toPrecision(6) : "null";
}

function skip(reason, currentPrice, fibLevels = null, rangeCoverage = null, extra = {}) {
  return {
    signal:    "SKIP",
    reason,
    fibLevels,
    binsBelow: 35,
    binsAbove: 0,
    currentPrice,
    rangeCoverage,
    ...extra,
  };
}

function getPreviousKnownATH(poolAddress, tokenMint) {
  let fromPositionMeta = null;
  let fromPoolMemory = null;

  try {
    if (fs.existsSync(POSITION_META_PATH)) {
      const meta = JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8"));
      for (const m of Object.values(meta || {})) {
        const matchesPool = poolAddress && m?.pool === poolAddress;
        const matchesMint = tokenMint && m?.tokenMint === tokenMint;
        if (!matchesPool && !matchesMint) continue;
        const candidate = Math.max(m?.peakPrice ?? 0, m?.ath ?? 0);
        if (candidate > (fromPositionMeta ?? 0)) fromPositionMeta = candidate;
      }
    }
  } catch {
    // non-fatal
  }

  try {
    if (poolAddress && fs.existsSync(POOL_MEMORY_PATH)) {
      const mem = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
      const deploys = mem?.[poolAddress]?.deploys ?? [];
      for (const d of deploys) {
        const candidate = d?.ath_price_sol_at_close;
        if (Number.isFinite(candidate) && candidate > (fromPoolMemory ?? 0)) fromPoolMemory = candidate;
      }
    }
  } catch {
    // non-fatal
  }

  const maxAth = Math.max(fromPositionMeta ?? 0, fromPoolMemory ?? 0);
  return maxAth > 0 ? maxAth : null;
}
