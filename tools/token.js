/**
 * token.js — Jupiter DataAPI + Dexscreener token volume client
 *
 * Jupiter endpoint:    https://datapi.jup.ag/v1         (no key required)
 * Dexscreener tokens: https://api.dexscreener.com/tokens/v1  (no key required)
 *
 * Used in get_token_holders, get_token_info, and volume screening filter.
 */

const DEXSCREENER_BASE = "https://api.dexscreener.com/tokens/v1";

/**
 * Batch-fetch 1h token volume across ALL DEXes.
 * Uses Dexscreener which returns volume.h1 per pair — we sum across all pairs
 * for each token to get true cross-DEX 1h volume.
 *
 * Dexscreener supports up to 30 addresses per call (comma-separated).
 *
 * Returns a Map<mint, volumeH1Usd>
 *
 * If a mint is missing from the response, it is omitted from the map
 * (caller should treat missing = skip filter rather than reject).
 */
export async function batchGetTokenVolumeH1(mints) {
  const result = new Map();
  if (!mints || mints.length === 0) return result;

  // Dexscreener supports up to 30 addresses per request
  const chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = `${DEXSCREENER_BASE}/solana/${chunk.join(",")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const json = await res.json();
      const pairs = Array.isArray(json) ? json : (json?.pairs ?? []);

      // Sum volume.h1 across all pairs for each token (base token)
      const totals = new Map();
      for (const pair of pairs) {
        const mint = pair?.baseToken?.address;
        const h1   = parseFloat(pair?.volume?.h1 ?? 0) || 0;
        if (mint) totals.set(mint, (totals.get(mint) ?? 0) + h1);
      }
      for (const [mint, vol] of totals) result.set(mint, vol);
    } catch { /* skip chunk on error */ }
  }));

  return result;
}

// Keep legacy alias for backward compatibility
export const batchGetTokenVolume5m = batchGetTokenVolumeH1;

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
    if (res.status === 404) return { notFound: true };
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
