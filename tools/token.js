/**
 * token.js — Jupiter DataAPI + GeckoTerminal token volume client
 *
 * Jupiter endpoint: https://datapi.jup.ag/v1  (no key required)
 * GeckoTerminal:    https://api.geckoterminal.com/api/v2  (no key required)
 *
 * Used in get_token_holders, get_token_info, and volume screening filter.
 */

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_HEADERS = { Accept: "application/json;version=20230302" };

/**
 * Batch-fetch 5m token volume across all DEXes for up to 30 mints at once.
 * Uses GeckoTerminal multi-token endpoint which aggregates across all pools/DEXes.
 *
 * Returns a Map<mint, volume5mUsd>
 * volume5mUsd = h24 / 288  (average 5-minute volume)
 *
 * If a mint is missing from the response, it is omitted from the map (caller
 * should treat missing = skip filter rather than reject).
 */
export async function batchGetTokenVolume5m(mints) {
  const result = new Map();
  if (!mints || mints.length === 0) return result;

  // GeckoTerminal multi-token endpoint supports up to 30 addresses per call
  const chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = `${GECKO_BASE}/networks/solana/tokens/multi/${chunk.join(",")}`;
      const res = await fetch(url, { headers: GECKO_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const json = await res.json();
      for (const item of (json?.data ?? [])) {
        const mint    = item?.attributes?.address;
        const h24     = parseFloat(item?.attributes?.volume_usd?.h24 ?? 0) || 0;
        const vol5m   = h24 / 288; // avg 5-minute volume
        if (mint) result.set(mint, vol5m);
      }
    } catch { /* skip chunk on error */ }
  }));

  return result;
}

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
