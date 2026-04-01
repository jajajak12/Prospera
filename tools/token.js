/**
 * token.js — Jupiter DataAPI client
 *
 * Endpoint: https://datapi.jup.ag/v1
 * No API key required.
 *
 * Used in get_token_holders and get_token_info tools.
 */

const JUPITER_BASE = "https://datapi.jup.ag/v1";

/**
 * Fetch bot holder %, top 10 concentration, total fees SOL,
 * funding address, and mint/freeze authority status from Jupiter.
 */
export async function getJupiterTokenInfo(mint) {
  try {
    const res = await fetch(`${JUPITER_BASE}/tokens/${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();

    return {
      botHoldersPct:  d?.audit?.botHoldersPercentage   ?? null,
      top10Pct:       d?.audit?.topHoldersPercentage    ?? null,
      feesSOL:        d?.fees                           ?? null,
      fundingAddress: d?.addressInfo?.fundingAddress    ?? null,
      mintDisabled:   d?.audit?.mintAuthorityDisabled   ?? null,
      freezeDisabled: d?.audit?.freezeAuthorityDisabled ?? null,
    };
  } catch {
    return null;
  }
}
