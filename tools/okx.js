/**
 * okx.js — Token safety checks via RugCheck.xyz
 *
 * Replaced OKX Web3 API (endpoint /api/v5/dex/market/advanced-info returned
 * HTTP 404 for all tokens as of Apr 2026).
 *
 * RugCheck API: https://api.rugcheck.xyz/v1
 * Public, no API key required.
 */

const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";

async function rugcheckGet(mint) {
  try {
    const url = `${RUGCHECK_BASE}/tokens/${mint}/report`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch bundle %, honeypot flag, and creator info from RugCheck.
 * Returns same shape as old OKX getTokenAdvancedInfo() — only fields
 * used in screening are populated; unused OKX-specific fields are dropped.
 *
 * bundlePct: largest transfer-type insider network as % of total supply.
 *            Conservative proxy — doesn't double-count across networks.
 * honeypot:  token already rugged, OR explicit "honeypot" risk detected.
 * creator:   deployer address for blacklist check.
 */
export async function getTokenAdvancedInfo(mint) {
  const d = await rugcheckGet(mint);
  if (!d) return null;

  const totalSupply = d.token?.supply ?? 0;

  // Bundle %: largest transfer-type insider network / total supply
  const insiderNetworks = Array.isArray(d.insiderNetworks) ? d.insiderNetworks : [];
  const transferNets = insiderNetworks.filter(n => n.type === "transfer");
  let bundlePct = 0;
  if (transferNets.length > 0 && totalSupply > 0) {
    const largest = Math.max(...transferNets.map(n => n.tokenAmount ?? 0));
    bundlePct = Math.min((largest / totalSupply) * 100, 100);
  }

  // Honeypot: already rugged, or explicit risk tag
  const risks = Array.isArray(d.risks) ? d.risks : [];
  const riskNames = risks.map(r => (r.name ?? r.type ?? "").toLowerCase());
  const honeypot = d.rugged === true || riskNames.some(n => n.includes("honeypot"));

  // Locked supply %: sum pct of topHolders whose address appears in lockers dict
  const lockerAddrs = new Set(Object.keys(d.lockers ?? {}));
  const topHolders = Array.isArray(d.topHolders) ? d.topHolders : [];
  const lockedPct = parseFloat(
    topHolders
      .filter(h => lockerAddrs.has(h.address))
      .reduce((sum, h) => sum + (h.pct ?? 0), 0)
      .toFixed(2)
  );

  return {
    bundlePct:     parseFloat(bundlePct.toFixed(2)),
    sniperPct:     0,   // not available from RugCheck
    suspiciousPct: 0,   // not available from RugCheck
    riskLevel:     d.score_normalised ?? null,
    devHoldingPct: 0,   // not available from RugCheck
    devSoldAll:    false,
    smartMoneyBuy: false,
    honeypot,
    devRugCount:   0,   // not available from RugCheck
    creator:       d.creator ?? null,
    lockedPct,
    // RugCheck extras (not used by hard filters but passed through for logging)
    rugScore:      d.score ?? null,
    rugged:        d.rugged ?? false,
    graphInsiders: d.graphInsidersDetected ?? 0,
  };
}

/**
 * ATH price info — not provided by RugCheck.
 * Returns null so callers fall back gracefully.
 */
export async function getTokenPriceInfo(_mint) {
  return null;
}

/**
 * Cluster / KOL trend data — not provided by RugCheck.
 * Returns null so callers fall back gracefully.
 */
export async function getTokenClusterList(_mint) {
  return null;
}
