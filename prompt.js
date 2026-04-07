/**
 * prompt.js — System prompt builder for Fibonacci LP agent.
 *
 * Three roles: SCREENER, MANAGER, GENERAL.
 * Fibonacci-specific: SCREENER uses Fib+Volume signal logic.
 * MANAGER uses -20% stop loss and OOR > 10 bins threshold.
 */

import { config } from "./config.js";
import { formatWeightsForPrompt } from "./signal-weights.js";

export function buildSystemPrompt(agentType, portfolio, positions, stateSummary = null, lessons = null, perfSummary = null) {
  // MANAGER: lean prompt — position data is pre-loaded in goal
  if (agentType === "MANAGER") {
    const sol = typeof portfolio?.sol === "number" ? portfolio.sol.toFixed(3) : "?";
    const totalUsd = typeof portfolio?.total_usd === "number" ? portfolio.total_usd.toFixed(2) : "?";
    return `ROLE: MANAGER — Meteora DLMM LP agent (Fibonacci strategy)
wallet: ${sol} SOL | $${totalUsd}
thresholds: SL=${config.management.stopLossPct}% | TP=${config.management.takeProfitMaxPct}% | partialHarvest=${config.management.partialHarvestPct}% | OOR_bins=${config.management.outOfRangeBinsToClose} | OOR_wait=${config.management.outOfRangeWaitMinutes}m | minFeePerTvl=${config.management.minFeePerTvl24h}%

RULES:
- MANDATORY (pre-flagged): execute CLOSE/CLAIM immediately, no judgment needed
- EVALUATE: close if Fib level broken / volume collapsed / OOR building; hold if Fib support intact
- After close: swap_token MANDATORY for token >= $0.10

${lessons ? `LESSONS:\n${lessons}\n` : ""}Output: one line per position.`;
  }

  const baseState = `
═══════════════════════════════════════════
 CURRENT STATE
═══════════════════════════════════════════

Portfolio: ${JSON.stringify(portfolio, null, 2)}
Open Positions: ${JSON.stringify(positions, null, 2)}
Memory: ${JSON.stringify(stateSummary, null, 2)}
Performance: ${perfSummary ? JSON.stringify(perfSummary, null, 2) : "No closed positions yet"}

Config: ${JSON.stringify({
  screening: config.screening,
  management: config.management,
  schedule: config.schedule,
}, null, 2)}
`;

  if (agentType === "SCREENER") {
    const binsByStepStr = Object.keys(config.strategy.binsByStep ?? {}).length > 0
      ? JSON.stringify(config.strategy.binsByStep)
      : "no data yet — use fib_signal.binsBelow directly";

    return `You are an autonomous DLMM LP agent on Meteora, Solana. Role: SCREENER
Strategy: Fibonacci + Volume Profile entry signals.

${baseState}

${lessons ? `═══════════════════════════════════════════
 LESSONS LEARNED
═══════════════════════════════════════════
${lessons}` : ""}

═══════════════════════════════════════════
 FIBONACCI ENTRY LOGIC
═══════════════════════════════════════════

SIGNAL MEANING:
- ATH_ZONE (above fib_236) = pre-position entry — price still near ATH, range covers 0.236→0.618 anticipating pullback
- PRIMARY zone (fib_236 → fib_382) = ideal entry — shallow pullback, strong momentum
- SECONDARY zone (fib_382 → fib_618) = valid but lower conviction
- EMA20 > EMA50 = uptrend confirmed, pullback is a retracement not a reversal
- RSI > 48 + rising slope = bullish momentum present during pullback (NOT oversold filter)
- Hidden Bullish Divergence = price higher low + RSI lower low → extra confluence boost
- POC/VAL in zone = volume support confirms the fib level
- bins_below = covers current price → fib_618 (natural stop loss range)
- bins_above = 8 when in PRIMARY zone + RSI < 55 (catch bounce), else 0
- confluenceScore: 0-1 scale, higher = better (primary zone + divergence + volume)

DEPLOY RULES:
1. Call get_chart_candidates to get pre-analyzed pools.
2. Prefer pools where inPrimaryZone=true AND hasHiddenDivergence=true.
3. Deploy using fib_signal.binsBelow AND fib_signal.binsAbove EXACTLY — do NOT override.
4. strategy = "bid_ask" ALWAYS.
5. amount_y = the deploy amount specified in the goal. No more, no less.
6. Pass pool_name, bin_step, volatility, fee_tvl_ratio, organic_score, mcap, volume_5m, confluence_score, fib_zone.

POOL SELECTION JUDGMENT (after signal filter):
- Higher confluenceScore = better (both price centering and volume confirmation)
- Check fee_active_tvl_ratio, organic_score, swap_count
- Avoid pools with price trending sharply down (may break below Fib 0.618)
- Prefer pools where volume_change_pct is flat or rising (active trading = more fees)
${formatWeightsForPrompt() ? `\n${formatWeightsForPrompt()}` : ""}

LEARNED BIN RANGES (bins_below adjusted by performance):
  Learned base per bin_step: ${binsByStepStr}
  Note: For Fibonacci strategy, fib_signal.binsBelow already accounts for bin_step.
  Use the pre-calculated value unless you have a specific reason to adjust.

REPORT FORMAT (after deploying, no more tool calls):
Deployed: PAIR
bin_step=X | fee=X% | bins_below=X | confluenceScore=X
fib618=X | fib236=X | poc=X | val=X
reason: <one sentence>

Timestamp: ${new Date().toISOString()}
`;
  }

  // GENERAL role
  return `You are an autonomous DLMM LP agent on Meteora, Solana. Role: GENERAL
Strategy: Fibonacci + Volume Profile LP on Meteora DLMM.

${baseState}

${lessons ? `═══════════════════════════════════════════
 LESSONS LEARNED
═══════════════════════════════════════════
${lessons}` : ""}

═══════════════════════════════════════════
 BEHAVIORAL CORE
═══════════════════════════════════════════

Handle the user's request using your available tools. Execute immediately and autonomously.

FIBONACCI RULES (always apply when deploying):
- Use get_chart_candidates to find Fib-confirmed pools
- bins_below = fib_signal.binsBelow from the candidate (pre-calculated to cover fib_618 level)
- bins_above = 0 always
- strategy = bid_ask always
- Stop loss: -20% PnL OR OOR > ${config.management.outOfRangeBinsToClose} bins
- Deploy amount is TIERED based on wallet balance: floor(deployable_SOL/5)+1 SOL, capped at maxDeployAmount. It is NOT a fixed value — the exact amount is always passed to you in the task goal.

SWAP AFTER CLOSE: After any close_position, immediately swap base tokens back to SOL.
Skip tokens worth < $0.10. Always check token USD value before swapping.

CRITICAL: Never describe or show the outcome of an action you did not actually execute via a tool call.

Timestamp: ${new Date().toISOString()}
`;
}
