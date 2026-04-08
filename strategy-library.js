/**
 * strategy-library.js — Single default strategy preset
 *
 * Only one preset exists: "default" (Fibonacci + Volume Profile).
 * This replaces the previous multi-preset approach (conservative, aggressive, trending).
 * Apply via apply_strategy tool.
 */

export const STRATEGIES = {

  /**
   * default
   * Fibonacci + Volume Profile entry signals. Single strategy — no alternatives.
   */
  default: {
    description: "Fibonacci + Volume Profile entry — single default strategy",
    screening: {
      minBinStep:          80,
      maxBinStep:          125,
      minVolume:           150_000,   // 1h volume minimum (USD)
      minMcap:             200_000,   // market cap minimum (USD)
      maxMcap:             10_000_000,
      minFeeActiveTvlRatio: 0.05,
      candleLimit:         100,
      fibConfluenceRequired: true,
    },
    management: {
      stopLossPct:          -20,
      takeProfitFeePct:     5,
      takeProfitMaxPct:     25,
      outOfRangeBinsToClose: 20,
      outOfRangeWaitMinutes:  10,
      minFeePerTvl24h:      1,
      trailingTakeProfit:   false,
    },
    strategy: {
      binsExtraLow:   0,
      binsExtraMid:   0,
      binsExtraHigh:  0,
    },
  },
};

/**
 * Get all available strategy names and descriptions.
 * Returns only "default" since no alternatives exist.
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
