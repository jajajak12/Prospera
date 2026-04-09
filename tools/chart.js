/**
 * chart.js — Hybrid OHLCV + Fibonacci + Indicators
 *
 * Signal engine for the Fibonacci LP agent.
 * Fetches candles via HybridDataProvider (Dexscreener → Birdeye → GeckoTerminal), calculates:
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

// ─── OHLCV Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch 1m OHLCV candles for a Solana token.
 * Primary: Birdeye token endpoint. Fallback to Dexscreener/GeckoTerminal if poolAddress provided.
 */
export async function fetchOHLCV(tokenMint, limit = 50, poolAddress = null) {
  return hybridDataProvider.getOHLCV(poolAddress, "5m", limit, "solana", tokenMint);
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

// ─── Swing Detection ─────────────────────────────────────────────────────────

/**
 * Detect swing high and swing low from candles array.
 * Returns { swingHigh, swingLow, highIndex, lowIndex }
 */
export function detectSwing(candles) {
  let swingHigh = -Infinity, highIndex = 0;
  let swingLow  =  Infinity, lowIndex  = 0;

  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > swingHigh) { swingHigh = candles[i].high; highIndex = i; }
    if (candles[i].low  < swingLow)  { swingLow  = candles[i].low;  lowIndex  = i; }
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
function findSwingHighs(candles, lookback = 5) {
  const levels = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const price = candles[i].high;
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && candles[j].high >= price) { isHigh = false; break; }
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

// ─── Bins Calculator ─────────────────────────────────────────────────────────

/**
 * Calculate bins needed to cover from currentPrice down to targetPrice.
 * Uses DLMM geometric price formula.
 * Returns bins clamped to [35, 90].
 */
export function calcBinsToTarget(currentPrice, targetPrice, binStep) {
  if (targetPrice >= currentPrice) return 35;
  const n = Math.log(targetPrice / currentPrice) / Math.log(1 - binStep / 10000);
  return Math.max(35, Math.min(90, Math.round(Math.abs(n))));
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

// ─── Full Signal Analysis ─────────────────────────────────────────────────────

/**
 * Full signal analysis for a pool.
 *
 * Entry conditions (all must pass):
 *   1. Price in ATH zone (> fib236) or PRIMARY zone [fib_236, fib_382]
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
  // ── Fetch OHLCV (1m for indicators) + Daily (for ATH-based Fibonacci) ──────
  let candles, dailyCandles;
  try {
    // Sequential (not parallel) to respect rate limits
    candles      = await fetchOHLCV(tokenMint, candleLimit, poolAddress);
    dailyCandles = await fetchDailyOHLCV(tokenMint, 1000, poolAddress);
  } catch (e) {
    return skip(`Chart data unavailable: ${e.message}`, currentPrice);
  }

  if (!candles || candles.length < 20) {
    return skip(`Insufficient candle data (${candles?.length ?? 0} candles, need 20+)`, currentPrice);
  }

  // ── Fibonacci: drawn from all-time-low → ATH ───────────────────────────────
  // Daily candles give full price history. Fib is the overall range framework;
  // S/R from price action validates which levels are meaningful.
  let swingHigh, swingLow;
  if (dailyCandles && dailyCandles.length >= 1) {
    // Use all available daily candles for ATH/ATL — even a single candle
    // is better than intraday for new tokens (captures full-day high/low).
    // Since daily data is fetched fresh every cycle, a new ATH is picked up
    // automatically on the next screening run.
    swingHigh = Math.max(...dailyCandles.map(c => c.high));
    swingLow  = Math.min(...dailyCandles.map(c => c.low));
    // For tokens with very few daily candles, also consider intraday extremes
    // to ensure the current session's ATH is captured.
    if (dailyCandles.length <= 3) {
      const { swingHigh: intradayHigh, swingLow: intradayLow } = detectSwing(candles);
      swingHigh = Math.max(swingHigh, intradayHigh);
      swingLow  = Math.min(swingLow,  intradayLow);
    }
  } else {
    // Fallback to intraday swing if daily data completely unavailable
    ({ swingHigh, swingLow } = detectSwing(candles));
  }

  // Guard: for very new tokens (≤1 daily candle), the daily high may include a
  // thin-liquidity launch spike (first trades at extreme prices before liquidity settles).
  // If swingHigh is >5x the current price in this case, re-derive from filtered
  // intraday candles — drop the top 5% of price outliers to remove the spike.
  if (swingHigh > currentPrice * 5 && dailyCandles != null && dailyCandles.length <= 1) {
    const sortedHighs = candles.map(c => c.high).sort((a, b) => a - b);
    const p95 = sortedHighs[Math.floor(sortedHighs.length * 0.95)] ?? swingHigh;
    const cleaned = candles.filter(c => c.high <= p95);
    if (cleaned.length >= 20) {
      const { swingHigh: h, swingLow: l } = detectSwing(cleaned);
      swingHigh = h;
      swingLow  = Math.min(swingLow, l);
    }
  }

  if (swingHigh <= swingLow || swingHigh === swingLow) {
    return skip("No price movement detected (swing_high === swing_low)", currentPrice);
  }

  const fib = calcFibLevels(swingHigh, swingLow);

  // ── Hard gate: NO ENTRY below Fib 0.500 ──────────────────────────────────
  if (currentPrice < fib.fib500) {
    log.warn("screening", `Fib 0.500 gate blocked — price ${fmt(currentPrice)} < fib500 ${fmt(fib.fib500)}`, { token: tokenMint });
    return skip(
      `Price ${fmt(currentPrice)} below Fib 0.500 (${fmt(fib.fib500)}) — no entry allowed`,
      currentPrice, fib
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

  // binStep is in basis points (e.g. 100 = 1% per bin)
  const binStepPct = binStep / 100;

  // ── Check 1: Price must be in ATH zone or Primary zone ───────────────────
  const inPrimaryZone = currentPrice >= fib.fib382 && currentPrice <= fib.fib236;
  const inAthZone     = currentPrice > fib.fib236;
  const inEntryRange  = inPrimaryZone || inAthZone;

  if (!inEntryRange) {
    return skip(
      `Price ${fmt(currentPrice)} in deep pullback zone (0.382–0.500) — wait for primary zone (0.236–0.382)`,
      currentPrice, fib
    );
  }

  // ── Check 2: EMA Trend Filter ──────────────────────────────────────────────
  if (ema20 != null && ema50 != null && ema20 <= ema50) {
    return skip(
      `EMA trend bearish — EMA20 (${fmt(ema20)}) <= EMA50 (${fmt(ema50)}). Fib pullback invalid in downtrend.`,
      currentPrice, fib
    );
  }

  // ── Check 3: RSI Momentum ─────────────────────────────────────────────────
  const rsiMin = opts.rsiMin ?? (inAthZone ? 40 : 45); // ATH zone: leniency 40, otherwise 45
  if (rsi != null) {
    if (rsi < rsiMin) {
      return skip(
        `RSI momentum weak — RSI=${rsi.toFixed(1)} < ${rsiMin}. Pullback lacks bullish momentum.`,
        currentPrice, fib
      );
    }
    if (rsiSlope < -2.0) { // slope >= -2.0 allowed
      return skip(
        `RSI slope declining (${rsiSlope.toFixed(1)} over 5 candles). Need rising momentum for valid entry.`,
        currentPrice, fib
      );
    }
  }

  // ── Hidden Bullish Divergence ──────────────────────────────────────────────
  const hasHiddenDivergence = detectHiddenBullishDivergence(candles, rsiValues);

  // ── Entry Zone Tier ────────────────────────────────────────────────────────
  // pricePosition: 0 = at fib236 (top of primary zone), 1 = at fib382 (bottom)
  // For ATH zone (above fib236), clamp to 0
  const primaryWidth  = fib.fib236 - fib.fib382;
  const rawPosition   = primaryWidth > 0 ? (fib.fib236 - currentPrice) / primaryWidth : 0.5;
  const pricePosition = inAthZone ? 0 : Math.max(0, Math.min(1, rawPosition));

  // ── Price Action S/R: find real support below Fib 0.618 ──────────────────
  const dailySR    = dailyCandles ? [...findSwingLows(dailyCandles), ...findSwingHighs(dailyCandles)] : [];
  const intradaySR = [...findSwingLows(candles), ...findSwingHighs(candles)];
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
  const supportTarget = nearestSupport ?? fib.fib786;
  const supportPrice  = Math.max(supportTarget - atrBuffer, fib.fib786);

  let binsBelow, binsAbove;

  if (inAthZone) {
    // Unclamped shift calculation — exact bins from currentPrice to fib236
    const shiftBins = Math.max(0, Math.round(
      Math.abs(Math.log(fib.fib236 / currentPrice) / Math.log(1 - binStep / 10000))
    ));
    // Depth of the range: from fib236 down to support (use existing clamped function)
    const depthBins = calcBinsToTarget(fib.fib236, supportPrice, binStep);

    binsBelow = shiftBins + depthBins;   // total bins below activeBin to reach support
    binsAbove = -shiftBins;              // negative → shifts range top to fib236
  } else {
    // Primary zone: range from currentPrice down to support
    binsBelow = calcBinsToTarget(currentPrice, supportPrice, binStep);
    binsAbove = 0;
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
  const zoneTier = inAthZone ? "ATH_ZONE(above 0.236)" : "PRIMARY(0.236-0.382)";
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
    ath:             Math.round(swingHigh * 1e8) / 1e8,
    atl:             Math.round(swingLow  * 1e8) / 1e8,
    currentPrice,
    confluenceScore,
    pricePosition:   Math.round(pricePosition * 100) / 100,
    inPrimaryZone,
    inAthZone,
    hasHiddenDivergence,
    rsi:             rsi != null ? Math.round(rsi * 10) / 10 : null,
    rsiSlope:        Math.round(rsiSlope * 10) / 10,
    ema20:           ema20 != null ? Math.round(ema20 * 1e8) / 1e8 : null,
    ema50:           ema50 != null ? Math.round(ema50 * 1e8) / 1e8 : null,
    atrPct:          atrPct != null ? Math.round(atrPct * 100) / 100 : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  return n != null ? n.toPrecision(6) : "null";
}

function skip(reason, currentPrice, fibLevels = null) {
  return {
    signal:    "SKIP",
    reason,
    fibLevels,
    binsBelow: 35,
    binsAbove: 0,
    currentPrice,
  };
}
