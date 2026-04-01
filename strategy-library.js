/**
 * strategy-library.js — Preset LP strategy configurations
 *
 * Each preset defines screening + deployment parameters optimized for a
 * specific market condition or risk profile. Apply via apply_strategy tool.
 *
 * Presets only override config keys they care about — others stay as-is.
 */

export const STRATEGIES = {

  /**
   * fibonacci (default)
   * Fibonacci + Volume Profile entry signals. Balanced risk/reward.
   * Good for: trending tokens in healthy accumulation zones.
   */
  fibonacci: {
    description: "Fibonacci + Volume Profile entry — balanced risk/reward (default)",
    screening: {
      minBinStep: 80,
      maxBinStep: 125,
      minVolume:  20000,
      minMcap:    150_000,
      maxMcap:    10_000_000,
      minFeeActiveTvlRatio: 0.05,
      candleLimit: 100,
      fibConfluenceRequired: true,
    },
    management: {
      stopLossPct:      -20,
      takeProfitFeePct:   5,
      takeProfitMaxPct:  25,
      outOfRangeBinsToClose: 20,
      outOfRangeWaitMinutes: 10,
      minFeePerTvl24h: 1,
      trailingTakeProfit: false,
    },
    strategy: {
      binsExtraLow:  0,
      binsExtraMid:  0,
      binsExtraHigh: 0,
    },
  },

  /**
   * conservative
   * Wider Fib zone + stricter quality filters + tighter stop loss.
   * Good for: lower conviction markets, capital preservation.
   */
  conservative: {
    description: "Stricter filters, wider range coverage, tighter stop loss",
    screening: {
      minBinStep: 80,
      maxBinStep: 100,
      minVolume:  30000,
      minMcap:    300_000,
      maxMcap:    5_000_000,
      minOrganic: 70,
      minHolders: 750,
      minFeeActiveTvlRatio: 0.08,
      candleLimit: 100,
      fibConfluenceRequired: true,
    },
    management: {
      stopLossPct:      -15,
      takeProfitFeePct:   4,
      takeProfitMaxPct:  20,
      outOfRangeBinsToClose: 15,
      outOfRangeWaitMinutes:  8,
      minFeePerTvl24h: 1.5,
      trailingTakeProfit: true,
      trailingTriggerPct: 4,
      trailingDropPct: 2,
    },
    strategy: {
      binsExtraLow:  5,  // slightly wider downside coverage
      binsExtraMid:  0,
      binsExtraHigh: 0,
    },
  },

  /**
   * aggressive
   * Concentrated liquidity, higher bin steps, looser entry.
   * Good for: high-confidence setups with strong momentum.
   * Higher APR potential, higher OOR risk.
   */
  aggressive: {
    description: "Concentrated liquidity in high bin-step pools, higher APR potential",
    screening: {
      minBinStep: 100,
      maxBinStep: 125,
      minVolume:  15000,
      minMcap:    100_000,
      maxMcap:    15_000_000,
      minFeeActiveTvlRatio: 0.04,
      candleLimit: 100,
      fibConfluenceRequired: false, // allow non-confluence entries
    },
    management: {
      stopLossPct:      -25,
      takeProfitFeePct:   6,
      takeProfitMaxPct:  35,
      outOfRangeBinsToClose: 25,
      outOfRangeWaitMinutes: 12,
      minFeePerTvl24h: 0.8,
      trailingTakeProfit: true,
      trailingTriggerPct: 8,
      trailingDropPct: 3,
    },
    strategy: {
      binsExtraLow:  0,
      binsExtraMid:  0,
      binsExtraHigh: 0,
    },
  },

  /**
   * trending
   * Optimized for tokens in strong uptrends, high swap velocity.
   * Narrower range centered on current price, fast exits.
   */
  trending: {
    description: "Optimized for strong uptrend momentum — narrower range, fast exits",
    screening: {
      minBinStep:  80,
      maxBinStep: 125,
      minVolume:  40000,
      minMcap:    200_000,
      maxMcap:    8_000_000,
      minOrganic:  65,
      minFeeActiveTvlRatio: 0.07,
      candleLimit: 100,
      fibConfluenceRequired: true,
    },
    management: {
      stopLossPct:      -18,
      takeProfitFeePct:   5,
      takeProfitMaxPct:  30,
      outOfRangeBinsToClose: 18,
      outOfRangeWaitMinutes:  8,
      minFeePerTvl24h: 1.2,
      trailingTakeProfit: true,
      trailingTriggerPct: 5,
      trailingDropPct: 2,
    },
    strategy: {
      binsExtraLow:  0,
      binsExtraMid:  0,
      binsExtraHigh: 0,
    },
  },
};

/**
 * Get all available strategy names and descriptions.
 */
export function listStrategies() {
  return Object.entries(STRATEGIES).map(([name, s]) => ({
    name,
    description: s.description,
  }));
}

/**
 * Get a strategy preset by name.
 * @param {string} name
 * @returns {object|null}
 */
export function getStrategy(name) {
  return STRATEGIES[name] ?? null;
}
