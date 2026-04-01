/**
 * backtest.js — Fibonacci strategy backtesting engine
 *
 * Replays historical OHLCV data and simulates Prospera's entry/exit logic.
 * Reuses all chart.js calculation functions (no extra API calls beyond initial fetch).
 *
 * Data source: GeckoTerminal OHLCV (max 1000 candles per timeframe)
 *   aggregate=1  → 1m  candles → ~16.7h of history
 *   aggregate=5  → 5m  candles → ~3.5 days
 *   aggregate=15 → 15m candles → ~10 days
 *   aggregate=60 → 1h  candles → ~42 days
 *
 * PnL model (simplified — good enough to rank signal quality):
 *   Entry: deploy SOL at entryPrice, range = [rangeBottom, entryPrice]
 *   rangeBottom = entryPrice × (1 − binStep/10000)^binsBelow
 *   In range: accumulate approximate fees each candle
 *   Below range: position frozen at rangeBottom price (all base token)
 *   PnL = (exitPrice − entryPrice) / entryPrice × 100  (price-based approximation)
 *   Fees: feePct × in_range_candles / total_candles_per_day × fee_utilization (rough)
 *
 * Limitations:
 *   - IL not modelled precisely (DLMM mechanics simplified)
 *   - Fee accrual is approximate (no actual swap volume data per candle)
 *   - Only one position open at a time in simulation
 */

import {
  fetchOHLCV,
  fetchDailyOHLCV,
  detectSwing,
  calcFibLevels,
  buildVolumeProfile,
  calcEMA,
  calcRSI,
  calcRSISlope,
  calcATR,
  calcBinsToTarget,
  detectHiddenBullishDivergence,
} from "./tools/chart.js";
import { getStrategy } from "./strategy-library.js";
import { log } from "./logger.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ─── Fetch with configurable aggregate ───────────────────────────────────────

async function fetchOHLCVAggregate(poolAddress, aggregate = 5, limit = 1000) {
  const url =
    `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute` +
    `?aggregate=${aggregate}&limit=${limit}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json;version=20230302" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}: ${res.statusText}`);

  const data = await res.json();
  const raw  = data?.data?.attributes?.ohlcv_list;
  if (!raw || raw.length === 0) throw new Error("Empty OHLCV list");

  return [...raw].reverse().map(([timestamp, open, high, low, close, volume]) => ({
    timestamp: Number(timestamp),
    open:  Number(open),
    high:  Number(high),
    low:   Number(low),
    close: Number(close),
    volume: Number(volume),
  }));
}

// ─── Signal logic (no API — pure calculation) ─────────────────────────────────

/**
 * Run signal analysis on a candle window using pre-fetched Fib levels.
 * Returns { signal, binsBelow, inAthZone, inPrimaryZone, confluenceScore, reason }
 */
function analyzeWindow(window, fibLevels, binStep, cfg) {
  const candles = window;
  const currentPrice = candles[candles.length - 1].close;
  const fib = fibLevels;

  // ATR
  const { atr, atrPct } = calcATR(candles, 14);
  const binStepPct = binStep / 100;

  // ATR compatibility
  if (atrPct != null && atrPct > binStepPct * 4) {
    return { signal: "SKIP", reason: `ATR too high (${atrPct?.toFixed(2)}%)` };
  }

  // Zone check
  const inAthZone = currentPrice > fib.fib236;
  const inFibZone = currentPrice >= fib.fib618 && currentPrice <= fib.fib236;
  if (!inAthZone && !inFibZone) {
    return { signal: "SKIP", reason: "Price outside entry range" };
  }

  // Volume profile
  const vp = buildVolumeProfile(candles, 50);
  const pocInZone   = vp.poc >= fib.fib618 && vp.poc <= fib.fib236;
  const valInZone   = vp.val >= fib.fib618 && vp.val <= fib.fib236;
  const pocAbove618 = vp.poc >= fib.fib618;
  const volumeOk    = inAthZone ? pocAbove618 : (pocInZone || valInZone);
  if (!volumeOk) return { signal: "SKIP", reason: "Volume not in zone" };

  // EMA
  const ema20v = calcEMA(candles, 20);
  const ema50v = calcEMA(candles, 50);
  const ema20  = ema20v[ema20v.length - 1];
  const ema50  = ema50v[ema50v.length - 1];
  if (ema20 != null && ema50 != null && ema20 <= ema50) {
    return { signal: "SKIP", reason: "EMA bearish" };
  }

  // RSI
  const rsiValues = calcRSI(candles, 14);
  const rsi       = rsiValues[rsiValues.length - 1];
  const rsiSlope  = calcRSISlope(rsiValues, 5);
  const rsiMin    = cfg.rsiMin ?? 48;
  if (rsi != null) {
    if (rsi < rsiMin)  return { signal: "SKIP", reason: `RSI too low (${rsi?.toFixed(1)})` };
    if (rsiSlope <= 0) return { signal: "SKIP", reason: "RSI slope declining" };
  }

  // bins_below
  const atrBuffer     = atr ?? (fib.fib618 * binStepPct / 100);
  const inPrimaryZone = currentPrice >= fib.fib382 && currentPrice <= fib.fib236;
  const rangeTop      = inAthZone ? fib.fib236 : currentPrice;
  const supportTarget = inAthZone ? fib.fib618 : fib.fib786;
  const binsBelow     = calcBinsToTarget(rangeTop, supportTarget - atrBuffer, binStep);

  // Confluence score (simplified)
  const zoneWidth   = fib.fib236 - fib.fib618;
  const rawPos      = zoneWidth > 0 ? (fib.fib236 - currentPrice) / zoneWidth : 0.5;
  const pricePos    = Math.max(0, rawPos);
  const totalVol    = vp.buckets.reduce((s, b) => s + b.volume, 0);
  const pocStrength = totalVol > 0 ? (vp.buckets[vp.pocIdx]?.volume ?? 0) / totalVol : 0;
  const idealPos    = (fib.fib236 - fib.fib382) / zoneWidth;
  const posScore    = Math.max(0, 1 - Math.abs(pricePos - idealPos) * 2);

  const hasDiv = detectHiddenBullishDivergence(candles, rsiValues);

  let score = posScore * 0.6 + pocStrength * 0.4;
  if (inPrimaryZone) score += 0.10;
  if (hasDiv)        score += 0.15;
  if (rsiSlope > 3)  score += 0.05;
  if (!inAthZone) score += pocInZone || valInZone ? 0.15 : -0.20;

  const confluenceScore = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;

  // Require minimum confluence if configured
  const minConfluence = cfg.minConfluenceScore ?? 0.30;
  if (cfg.fibConfluenceRequired && confluenceScore < minConfluence) {
    return { signal: "SKIP", reason: `Confluence too low (${confluenceScore})` };
  }

  return {
    signal: "ENTRY",
    binsBelow,
    inAthZone,
    inPrimaryZone,
    confluenceScore,
    reason: `${inAthZone ? "ATH" : inPrimaryZone ? "PRIMARY" : "SECONDARY"} | RSI=${rsi?.toFixed(1)} slope=${rsiSlope?.toFixed(1)} | score=${confluenceScore}`,
  };
}

// ─── Position simulation ───────────────────────────────────────────────────────

/**
 * Simulate a position from entryIdx until exit conditions are met.
 * Returns trade result object.
 */
function simulatePosition(candles, entryIdx, entryPrice, binsBelow, binStep, feePct, cfg) {
  // Range bottom = geometric price at binsBelow bins below entry
  const rangeBottom = entryPrice * Math.pow(1 - binStep / 10000, binsBelow);

  const stopLoss   = cfg.stopLossPct / 100;        // e.g. -0.20
  const takeProfit = cfg.takeProfitMaxPct / 100;    // e.g. 0.25
  const oorBins    = cfg.outOfRangeBinsToClose;     // e.g. 20
  const oorMinutes = cfg.outOfRangeWaitMinutes;     // e.g. 10

  // Approximate candles per day based on candle timestamps
  const candleIntervalMs = candles.length > 1
    ? (candles[candles.length - 1].timestamp - candles[0].timestamp) / (candles.length - 1) * 1000
    : 60000;
  const candlesPerDay = Math.round(86400000 / candleIntervalMs);

  // Fee per in-range candle (very rough — assumes 40% utilization)
  const feePerCandle = (feePct / 100) * (1 / candlesPerDay) * 0.40;

  let accumulatedFees = 0;
  let oorCount        = 0; // consecutive OOR candles
  let entryTime       = candles[entryIdx].timestamp;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const candle = candles[i];
    const price  = candle.close;

    // Current position value approximation
    // In range: value ≈ initial + fees (IL roughly offset by fees)
    // Below range: frozen at rangeBottom
    const effectivePrice = Math.max(price, rangeBottom);
    const pricePnl       = (effectivePrice - entryPrice) / entryPrice;

    const inRange = price >= rangeBottom && price <= entryPrice;
    const oorBinsAway = !inRange
      ? Math.round(Math.log(price < rangeBottom ? rangeBottom / price : price / entryPrice) / Math.log(1 + binStep / 10000))
      : 0;

    if (inRange) {
      accumulatedFees += feePerCandle;
      oorCount = 0;
    } else {
      oorCount++;
    }

    const totalPnl = pricePnl + accumulatedFees;

    // Exit conditions
    if (totalPnl <= stopLoss) {
      return trade(entryIdx, i, entryTime, candle.timestamp, entryPrice, price, totalPnl, accumulatedFees, "stop_loss", binsBelow, candles);
    }
    if (totalPnl >= takeProfit) {
      return trade(entryIdx, i, entryTime, candle.timestamp, entryPrice, price, totalPnl, accumulatedFees, "take_profit", binsBelow, candles);
    }
    // OOR close
    const oorMinutesElapsed = oorCount * (candleIntervalMs / 60000);
    if (oorCount > 0 && oorBinsAway > oorBins && oorMinutesElapsed >= oorMinutes) {
      return trade(entryIdx, i, entryTime, candle.timestamp, entryPrice, price, totalPnl, accumulatedFees, "oor_close", binsBelow, candles);
    }
  }

  // End of data — close at last price
  const lastCandle = candles[candles.length - 1];
  const lastPrice  = Math.max(lastCandle.close, rangeBottom);
  const lastPnl    = (lastPrice - entryPrice) / entryPrice + accumulatedFees;
  return trade(entryIdx, candles.length - 1, entryTime, lastCandle.timestamp, entryPrice, lastCandle.close, lastPnl, accumulatedFees, "end_of_data", binsBelow, candles);
}

function trade(entryIdx, exitIdx, entryTime, exitTime, entryPrice, exitPrice, pnlPct, fees, reason, binsBelow, candles) {
  const durationMs  = (exitTime - entryTime) * 1000;
  const durationMin = Math.round(durationMs / 60000);
  return {
    entryIdx,
    exitIdx,
    entryTime:  new Date(entryTime * 1000).toISOString(),
    exitTime:   new Date(exitTime  * 1000).toISOString(),
    entryPrice: +entryPrice.toPrecision(6),
    exitPrice:  +exitPrice.toPrecision(6),
    pnlPct:     +( pnlPct * 100).toFixed(2),
    feePct:     +(fees    * 100).toFixed(3),
    reason,
    binsBelow,
    durationMin,
    win: pnlPct > 0,
  };
}

// ─── Main backtest runner ─────────────────────────────────────────────────────

/**
 * Run a full backtest for a pool.
 *
 * @param {object} opts
 * @param {string}  opts.poolAddress
 * @param {number}  opts.binStep        Pool bin step (e.g. 100)
 * @param {number}  opts.feePct         Pool base fee % (e.g. 1.0)
 * @param {number}  [opts.aggregate=5]  Candle size in minutes (1, 5, 15, 60)
 * @param {number}  [opts.candleLimit=100] Window size for indicator calculation
 * @param {string}  [opts.preset]       Strategy preset name (default: current config values)
 * @returns {Promise<BacktestResult>}
 */
export async function runBacktest({
  poolAddress,
  binStep,
  feePct,
  aggregate   = 5,
  candleLimit = 100,
  preset      = null,
}) {
  // Load strategy config
  const strategy = preset ? getStrategy(preset) : null;
  const cfg = {
    stopLossPct:           strategy?.management?.stopLossPct           ?? -20,
    takeProfitMaxPct:      strategy?.management?.takeProfitMaxPct      ?? 25,
    outOfRangeBinsToClose: strategy?.management?.outOfRangeBinsToClose ?? 20,
    outOfRangeWaitMinutes: strategy?.management?.outOfRangeWaitMinutes ?? 10,
    fibConfluenceRequired: strategy?.screening?.fibConfluenceRequired  ?? true,
  };

  log("backtest", `Fetching data for ${poolAddress.slice(0, 8)}... (${aggregate}m candles)`);

  // Fetch data
  const [candles, dailyCandles] = await Promise.all([
    fetchOHLCVAggregate(poolAddress, aggregate, 1000),
    fetchDailyOHLCV(poolAddress, 1000),
  ]);

  if (candles.length < candleLimit + 10) {
    throw new Error(`Not enough candle data (${candles.length} candles, need ${candleLimit + 10}+)`);
  }

  // Build Fib levels from daily ATH/ATL
  let swingHigh, swingLow;
  if (dailyCandles && dailyCandles.length >= 1) {
    swingHigh = Math.max(...dailyCandles.map(c => c.high));
    swingLow  = Math.min(...dailyCandles.map(c => c.low));
    if (dailyCandles.length <= 3) {
      const ih = Math.max(...candles.map(c => c.high));
      const il = Math.min(...candles.map(c => c.low));
      swingHigh = Math.max(swingHigh, ih);
      swingLow  = Math.min(swingLow,  il);
    }
  } else {
    let maxH = -Infinity, minL = Infinity;
    for (const c of candles) { if (c.high > maxH) maxH = c.high; if (c.low < minL) minL = c.low; }
    swingHigh = maxH; swingLow = minL;
  }

  const fibLevels = calcFibLevels(swingHigh, swingLow);

  log("backtest", `Fib levels — ATH: ${swingHigh.toPrecision(6)}, ATL: ${swingLow.toPrecision(6)}`);
  log("backtest", `Fib236: ${fibLevels.fib236.toPrecision(6)}, Fib618: ${fibLevels.fib618.toPrecision(6)}`);

  // Walk through candles
  const trades   = [];
  let positionOpen = false;
  let skipUntil    = 0; // candle index to resume screening after a trade

  for (let i = candleLimit; i < candles.length; i++) {
    if (i < skipUntil) continue;
    if (positionOpen) continue;

    const window = candles.slice(i - candleLimit, i);
    const result = analyzeWindow(window, fibLevels, binStep, cfg);

    if (result.signal !== "ENTRY") continue;

    // Simulate position
    const entryPrice = candles[i].close;
    positionOpen = true;

    const trade = simulatePosition(
      candles, i, entryPrice,
      result.binsBelow, binStep, feePct, cfg
    );

    trade.zone        = result.inAthZone ? "ATH" : result.inPrimaryZone ? "PRIMARY" : "SECONDARY";
    trade.confluence  = result.confluenceScore;
    trade.signalReason = result.reason;

    trades.push(trade);
    positionOpen = false;
    skipUntil    = trade.exitIdx + 1; // don't re-enter immediately

    log("backtest", `Trade ${trades.length}: ${trade.zone} entry @ ${trade.entryPrice} → exit @ ${trade.exitPrice} (${trade.pnlPct > 0 ? "+" : ""}${trade.pnlPct}% | ${trade.reason} | ${trade.durationMin}m)`);
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  const wins        = trades.filter(t => t.win);
  const losses      = trades.filter(t => !t.win);
  const winRate     = trades.length > 0 ? wins.length / trades.length : 0;
  const avgPnl      = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const totalPnl    = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgDuration = trades.length > 0 ? Math.round(trades.reduce((s, t) => s + t.durationMin, 0) / trades.length) : 0;
  const bestTrade   = trades.length > 0 ? trades.reduce((a, b) => a.pnlPct > b.pnlPct ? a : b) : null;
  const worstTrade  = trades.length > 0 ? trades.reduce((a, b) => a.pnlPct < b.pnlPct ? a : b) : null;

  // Exit reason breakdown
  const byReason = {};
  for (const t of trades) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  }

  // Zone breakdown
  const byZone = {};
  for (const t of trades) {
    if (!byZone[t.zone]) byZone[t.zone] = { count: 0, wins: 0, totalPnl: 0 };
    byZone[t.zone].count++;
    if (t.win) byZone[t.zone].wins++;
    byZone[t.zone].totalPnl += t.pnlPct;
  }

  const result = {
    pool:       poolAddress,
    binStep,
    feePct,
    aggregate:  `${aggregate}m`,
    preset:     preset ?? "current_config",
    period: {
      from: candles[candleLimit].timestamp ? new Date(candles[candleLimit].timestamp * 1000).toISOString() : null,
      to:   candles[candles.length - 1].timestamp ? new Date(candles[candles.length - 1].timestamp * 1000).toISOString() : null,
      totalCandles: candles.length,
    },
    fibLevels: {
      ath:    +swingHigh.toPrecision(6),
      atl:    +swingLow.toPrecision(6),
      fib236: +fibLevels.fib236.toPrecision(6),
      fib382: +fibLevels.fib382.toPrecision(6),
      fib618: +fibLevels.fib618.toPrecision(6),
    },
    summary: {
      totalTrades:  trades.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      +( winRate * 100).toFixed(1),
      avgPnlPct:    +avgPnl.toFixed(2),
      totalPnlPct:  +totalPnl.toFixed(2),
      avgDurationMin: avgDuration,
      bestTrade:    bestTrade  ? { pnlPct: bestTrade.pnlPct,  reason: bestTrade.reason,  zone: bestTrade.zone  } : null,
      worstTrade:   worstTrade ? { pnlPct: worstTrade.pnlPct, reason: worstTrade.reason, zone: worstTrade.zone } : null,
      byExitReason: byReason,
      byZone:       Object.fromEntries(
        Object.entries(byZone).map(([z, v]) => [z, {
          count:   v.count,
          winRate: +((v.wins / v.count) * 100).toFixed(1),
          avgPnl:  +(v.totalPnl / v.count).toFixed(2),
        }])
      ),
    },
    trades,
    note: "PnL is approximate — IL simplified, fees estimated at 40% utilization. Use for signal quality ranking, not exact P&L projection.",
  };

  log("backtest", `Done: ${trades.length} trades | WR: ${result.summary.winRate}% | Avg PnL: ${avgPnl.toFixed(2)}% | Total: ${totalPnl.toFixed(2)}%`);

  // Attach flat fields for backward-compat with callers that use top-level keys
  result.totalTrades = result.summary.totalTrades;
  result.winRate     = result.summary.winRate / 100;
  result.avgPnlPct   = result.summary.avgPnlPct;
  result.totalPnlPct = result.summary.totalPnlPct;

  return result;
}

// ─── Parameter Sweep ──────────────────────────────────────────────────────────

/**
 * Run a lightweight parameter sweep on pre-fetched candle data.
 * Tests combinations of rsiMin and minConfluenceScore.
 * Returns ranked results — best combo first (by win rate, then avg PnL).
 *
 * Pure CPU — no API calls. Fast even for 1000 candles.
 *
 * @param {Array}  candles       - Intraday OHLCV candles
 * @param {Object} fibLevels     - Pre-calculated Fib levels
 * @param {number} binStep
 * @param {number} feePct
 * @param {Object} baseCfg       - Base config (stopLossPct etc.)
 * @returns {Array} ranked sweep results
 */
function sweepParams(candles, fibLevels, binStep, feePct, baseCfg, candleLimit = 100) {
  const RSI_CANDIDATES         = [40, 44, 48, 52];
  const CONFLUENCE_CANDIDATES  = [0.25, 0.30, 0.35, 0.40];

  const results = [];

  for (const rsiMin of RSI_CANDIDATES) {
    for (const minConfluenceScore of CONFLUENCE_CANDIDATES) {
      const cfg = { ...baseCfg, rsiMin, minConfluenceScore, fibConfluenceRequired: true };

      const trades  = [];
      let skipUntil = 0;

      for (let i = candleLimit; i < candles.length; i++) {
        if (i < skipUntil) continue;

        const window = candles.slice(i - candleLimit, i);
        const sig    = analyzeWindow(window, fibLevels, binStep, cfg);
        if (sig.signal !== "ENTRY") continue;

        const t = simulatePosition(candles, i, candles[i].close, sig.binsBelow, binStep, feePct, cfg);
        trades.push(t);
        skipUntil = t.exitIdx + 1;
      }

      if (trades.length < 3) continue; // not enough trades to be meaningful

      const wins    = trades.filter(t => t.win).length;
      const winRate = wins / trades.length;
      const avgPnl  = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;

      results.push({ rsiMin, minConfluenceScore, trades: trades.length, winRate, avgPnlPct: +avgPnl.toFixed(2) });
    }
  }

  // Sort: win rate desc, then avgPnl desc
  results.sort((a, b) => b.winRate - a.winRate || b.avgPnlPct - a.avgPnlPct);
  return results;
}

/**
 * Run backtest + parameter sweep for a single pool.
 * Returns { backtest, sweepBest } where sweepBest is the top-ranked param combo.
 */
export async function runBacktestWithSweep({ poolAddress, binStep, feePct, aggregate = 15, candleLimit = 100 }) {
  const [candles, dailyCandles] = await Promise.all([
    fetchOHLCVAggregate(poolAddress, aggregate, 1000),
    fetchDailyOHLCV(poolAddress, 1000),
  ]);

  if (candles.length < candleLimit + 10) {
    throw new Error(`Not enough candle data (${candles.length} candles)`);
  }

  // Build Fib levels
  let swingHigh, swingLow;
  if (dailyCandles && dailyCandles.length >= 1) {
    swingHigh = Math.max(...dailyCandles.map(c => c.high));
    swingLow  = Math.min(...dailyCandles.map(c => c.low));
    if (dailyCandles.length <= 3) {
      swingHigh = Math.max(swingHigh, ...candles.map(c => c.high));
      swingLow  = Math.min(swingLow,  ...candles.map(c => c.low));
    }
  } else {
    swingHigh = Math.max(...candles.map(c => c.high));
    swingLow  = Math.min(...candles.map(c => c.low));
  }

  const fibLevels = calcFibLevels(swingHigh, swingLow);

  const baseCfg = {
    stopLossPct:           -20,
    takeProfitMaxPct:      25,
    outOfRangeBinsToClose: 20,
    outOfRangeWaitMinutes: 10,
    fibConfluenceRequired: true,
  };

  const sweepResults = sweepParams(candles, fibLevels, binStep, feePct, baseCfg, candleLimit);
  const sweepBest    = sweepResults[0] ?? null;

  // Also run baseline backtest using current default params
  const baseline = await runBacktest({ poolAddress, binStep, feePct, aggregate, candleLimit });

  return { backtest: baseline, sweepBest, sweepAll: sweepResults.slice(0, 5) };
}
