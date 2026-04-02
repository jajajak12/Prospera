/**
 * chart.js — GeckoTerminal OHLCV + Fibonacci + Volume Profile + Indicators
 *
 * Signal engine for the Fibonacci LP agent.
 * Fetches 50x 1m candles, calculates:
 *   - Fibonacci retracement levels (swing high/low)
 *   - Volume Profile (POC, VAH, VAL)
 *   - EMA trend filter (EMA20 > EMA50)
 *   - RSI momentum: RSI > 48 + rising slope (not oversold filter)
 *   - Hidden Bullish Divergence detection → score boost
 *   - ATR vs bin_step compatibility check
 *   - Dynamic bins_above based on zone position + RSI
 */

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ─── OHLCV Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candles from GeckoTerminal for a Solana pool.
 * Returns array of { timestamp, open, high, low, close, volume } in chronological order.
 */
export async function fetchOHLCV(poolAddress, limit = 50) {
  const url =
    `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute` +
    `?aggregate=1&limit=${limit}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`GeckoTerminal OHLCV error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const raw = data?.data?.attributes?.ohlcv_list;

  if (!raw || raw.length === 0) {
    throw new Error("GeckoTerminal returned empty OHLCV list");
  }

  // GeckoTerminal returns newest-first — reverse to chronological order
  return [...raw].reverse().map(([timestamp, open, high, low, close, volume]) => ({
    timestamp: Number(timestamp),
    open:      Number(open),
    high:      Number(high),
    low:       Number(low),
    close:     Number(close),
    volume:    Number(volume),
  }));
}

/**
 * Fetch daily OHLCV candles from GeckoTerminal for a pool.
 * Used to find ATH and all-time-low across the token's full price history.
 */
export async function fetchDailyOHLCV(poolAddress, limit = 1000) {
  const url =
    `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/day` +
    `?aggregate=1&limit=${limit}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return null; // non-fatal — fall back to intraday swing

  const data = await res.json();
  const raw  = data?.data?.attributes?.ohlcv_list;
  if (!raw || raw.length === 0) return null;

  return [...raw].reverse().map(([timestamp, open, high, low, close, volume]) => ({
    timestamp: Number(timestamp),
    open:      Number(open),
    high:      Number(high),
    low:       Number(low),
    close:     Number(close),
    volume:    Number(volume),
  }));
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
 *   1. Price in Fib zone [fib_236, fib_618]
 *   2. Volume confirmation: POC or VAL within Fib zone
 *   3. EMA trend: EMA20 > EMA50 (uptrend)
 *   4. RSI momentum: RSI > 48 AND RSI slope positive (rising momentum, not oversold filter)
 *
 * Score boosts:
 *   - Hidden Bullish Divergence detected → +0.15 to confluenceScore
 *   - Price in primary zone [fib_236, fib_382] → higher base score
 *   - Price in secondary zone [fib_382, fib_618] → lower base score
 *
 * Dynamic bins_above:
 *   - Primary zone (0.236–0.382) + RSI < 55 → bins_above = 8 (catch bounce)
 *   - Otherwise → bins_above = 0
 *
 * ATR compatibility:
 *   - If ATR% > binStep% × 4 → SKIP (too volatile for this bin step, OOR every candle)
 *   - If ATR% > binStep% × 2 → flag warning in reason but allow entry
 *
 * @param {string} poolAddress
 * @param {number} binStep
 * @param {number} currentPrice
 * @param {number} candleLimit
 * @returns {Promise<SignalResult>}
 */
export async function analyzeSignal(poolAddress, binStep, currentPrice, candleLimit = 50) {
  // ── Fetch OHLCV (1m for indicators) + Daily (for ATH-based Fibonacci) ──────
  let candles, dailyCandles;
  try {
    [candles, dailyCandles] = await Promise.all([
      fetchOHLCV(poolAddress, candleLimit),
      fetchDailyOHLCV(poolAddress, 1000),
    ]);
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

  if (swingHigh <= swingLow || swingHigh === swingLow) {
    return skip("No price movement detected (swing_high === swing_low)", currentPrice);
  }

  const fib = calcFibLevels(swingHigh, swingLow);

  // ── Volume Profile ─────────────────────────────────────────────────────────
  const vp = buildVolumeProfile(candles, 50);

  // ── Indicators ────────────────────────────────────────────────────────────
  const ema20Values = calcEMA(candles, 20);
  const ema50Values = calcEMA(candles, 50);
  const rsiValues   = calcRSI(candles, 14);
  const { atr, atrPct } = calcATR(candles, 14);

  const ema20 = ema20Values[ema20Values.length - 1];
  const ema50 = ema50Values[ema50Values.length - 1];
  const rsi   = rsiValues[rsiValues.length - 1];
  const rsiSlope = calcRSISlope(rsiValues, 5);

  // ── ATR Compatibility ──────────────────────────────────────────────────────
  // binStep is in basis points (e.g. 100 = 1% per bin)
  const binStepPct = binStep / 100;
  let atrWarning = null;

  if (atrPct != null) {
    if (atrPct > binStepPct * 4) {
      return skip(
        `ATR (${atrPct.toFixed(2)}%/candle) exceeds bin_step (${binStepPct}%) × 4 — too volatile, position would go OOR every candle`,
        currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val }
      );
    }
    if (atrPct > binStepPct * 2) {
      atrWarning = `ATR=${atrPct.toFixed(2)}% > binStep×2 (${(binStepPct * 2).toFixed(2)}%) — high volatility, OOR risk elevated`;
    }
  }

  // ── Check 1: Price not below Fib 0.618 (key support) ─────────────────────
  // Entry is allowed in three zones:
  //   ATH zone    : price > fib236  (pre-position before pullback, range covers 0.236→0.618)
  //   Primary zone: fib382 → fib236 (shallow pullback, ideal)
  //   Secondary   : fib618 → fib382 (deeper pullback, still valid)
  // Reject only if price has already broken below fib 0.618.
  const inFibZone    = currentPrice >= fib.fib618 && currentPrice <= fib.fib236;
  const inAthZone    = currentPrice > fib.fib236;   // still near ATH, hasn't pulled back yet
  const inEntryRange = inFibZone || inAthZone;       // either is valid

  if (!inEntryRange) {
    return skip(
      `Price ${fmt(currentPrice)} below Fib 0.618 support (${fmt(fib.fib618)}) — broken support, no entry`,
      currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val }
    );
  }

  // ── Check 2: Volume Confirmation ───────────────────────────────────────────
  // In ATH zone: price hasn't pulled back yet so POC/VAL won't be in fib zone.
  // Require only that POC is above fib 0.618 (healthy volume distribution).
  // In fib zone: require POC or VAL within zone (standard check).
  const pocInZone = vp.poc >= fib.fib618 && vp.poc <= fib.fib236;
  const valInZone = vp.val >= fib.fib618 && vp.val <= fib.fib236;
  const pocAbove618 = vp.poc >= fib.fib618;
  const volumeConfirmed = inAthZone ? pocAbove618 : (pocInZone || valInZone);

  if (!volumeConfirmed) {
    const reason = inAthZone
      ? `ATH zone: POC=${fmt(vp.poc)} below Fib 0.618 (${fmt(fib.fib618)}) — volume distribution too low`
      : `No volume support in Fib zone — POC=${fmt(vp.poc)} (${pocInZone ? "in" : "out"}), VAL=${fmt(vp.val)} (${valInZone ? "in" : "out"})`;
    return skip(reason, currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val });
  }

  // ── Check 3: EMA Trend Filter ──────────────────────────────────────────────
  if (ema20 != null && ema50 != null && ema20 <= ema50) {
    return skip(
      `EMA trend bearish — EMA20 (${fmt(ema20)}) <= EMA50 (${fmt(ema50)}). Fib pullback invalid in downtrend.`,
      currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val }
    );
  }

  // ── Check 4: RSI Momentum ──────────────────────────────────────────────────
  if (rsi != null) {
    if (rsi < 48) {
      return skip(
        `RSI momentum weak — RSI=${rsi.toFixed(1)} < 48. Pullback lacks bullish momentum.`,
        currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val }
      );
    }
    if (rsiSlope <= 0) {
      return skip(
        `RSI slope declining (${rsiSlope.toFixed(1)} over 5 candles). Need rising momentum for valid entry.`,
        currentPrice, fib, { poc: vp.poc, vah: vp.vah, val: vp.val }
      );
    }
  }

  // ── Hidden Bullish Divergence ──────────────────────────────────────────────
  const hasHiddenDivergence = detectHiddenBullishDivergence(candles, rsiValues);

  // ── Entry Zone Tier ────────────────────────────────────────────────────────
  const inPrimaryZone = currentPrice >= fib.fib382 && currentPrice <= fib.fib236;

  // pricePosition: 0 = at fib236 (top of zone), 1 = at fib618 (bottom)
  // For ATH zone (above fib236), clamp to 0 (treated as top of zone)
  const zoneWidth     = fib.fib236 - fib.fib618;
  const rawPosition   = zoneWidth > 0 ? (fib.fib236 - currentPrice) / zoneWidth : 0.5;
  const pricePosition = Math.max(0, rawPosition); // clamp: ATH zone → 0

  // ── Price Action S/R: find real support below Fib 0.618 ──────────────────
  const dailySR    = dailyCandles ? [...findSwingLows(dailyCandles), ...findSwingHighs(dailyCandles)] : [];
  const intradaySR = [...findSwingLows(candles), ...findSwingHighs(candles)];
  const srLevels   = [...dailySR, ...intradaySR];

  const supportsBelow = srLevels.filter(l => l < fib.fib618).sort((a, b) => b - a);
  const nearestSupport = supportsBelow[0] ?? null;
  const paConfluence   = nearestSupport != null;

  // ── bins_below ────────────────────────────────────────────────────────────
  // ATH zone: range starts at fib 0.236 (not current price) → fib 0.618
  //   All liquidity sits in the anticipated pullback zone, not above it.
  // Fib zone: current price → nearest support below fib618 (or fib786)
  const atrBuffer = atr ?? (fib.fib618 * binStepPct / 100);
  const supportTarget = inAthZone
    ? fib.fib618
    : (nearestSupport ?? fib.fib786);
  const rangeTop  = inAthZone ? fib.fib236 : currentPrice;
  const binsBelow = calcBinsToTarget(rangeTop, supportTarget - atrBuffer, binStep);

  const binsAbove = 0;

  // ── Confluence Score ───────────────────────────────────────────────────────
  const totalVol    = vp.buckets.reduce((s, b) => s + b.volume, 0);
  const pocVol      = vp.buckets[vp.pocIdx]?.volume ?? 0;
  const pocStrength = totalVol > 0 ? pocVol / totalVol : 0;

  const idealPosition = (fib.fib236 - fib.fib382) / zoneWidth;
  const positionScore = Math.max(0, 1 - Math.abs(pricePosition - idealPosition) * 2);

  let score = positionScore * 0.6 + pocStrength * 0.4;
  if (inPrimaryZone)       score += 0.10;
  if (hasHiddenDivergence) score += 0.15;
  if (rsiSlope > 3)        score += 0.05;

  const confluenceScore = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;

  // ── Build Reason ──────────────────────────────────────────────────────────
  const zoneTier = inAthZone
    ? "ATH_ZONE(above 0.236, pre-position)"
    : inPrimaryZone ? "PRIMARY(0.236-0.382)" : "SECONDARY(0.382-0.618)";
  const parts = [
    `Zone: ${zoneTier}`,
    `RSI=${rsi?.toFixed(1)} slope=+${rsiSlope.toFixed(1)}`,
    `EMA20>EMA50 ✓`,
    `Vol: POC=${pocInZone ? "in" : "out"} VAL=${valInZone ? "in" : "out"}`,
    `bins=${binsBelow}↓/${binsAbove}↑`,
    nearestSupport != null ? `support @${fmt(nearestSupport)}` : `support=fib786`,
  ];
  if (hasHiddenDivergence) parts.push("HiddenDiv ✓");
  if (atrWarning)          parts.push(atrWarning);

  return {
    signal:          "ENTRY",
    reason:          parts.join(" | "),
    fibLevels:       fib,
    volumeProfile:   { poc: vp.poc, vah: vp.vah, val: vp.val },
    binsBelow,
    binsAbove,
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

function skip(reason, currentPrice, fibLevels = null, volumeProfile = null) {
  return {
    signal:       "SKIP",
    reason,
    fibLevels,
    volumeProfile,
    binsBelow:    35,
    binsAbove:    0,
    currentPrice,
  };
}
