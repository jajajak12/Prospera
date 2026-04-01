/**
 * okx.js — OKX DEX Web3 API client
 *
 * Public API, no key required.
 * Endpoint: https://web3.okx.com
 * Header:   Ok-Access-Client-type: agent-cli
 * Chain:    501 = Solana
 */

const OKX_BASE  = "https://web3.okx.com";
const OKX_CHAIN = "501";
const OKX_HEADERS = {
  "Ok-Access-Client-type": "agent-cli",
  "Content-Type": "application/json",
};

async function okxGet(path, params = {}) {
  const url = new URL(`${OKX_BASE}${path}`);
  url.searchParams.set("chainIndex", OKX_CHAIN);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString(), {
      headers: OKX_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  } catch {
    return null;
  }
}

/**
 * Fetch bundle %, sniper %, dev info, risk level, honeypot tag from OKX.
 * Used in screening (bundle filter) and get_token_holders tool.
 */
export async function getTokenAdvancedInfo(mint) {
  const d = await okxGet("/api/v5/dex/market/advanced-info", {
    tokenContractAddress: mint,
  });
  if (!d) return null;

  const tags = Array.isArray(d.tags) ? d.tags : [];

  return {
    bundlePct:     parseFloat(d.bundleHoldingPercent    ?? 0) || 0,
    sniperPct:     parseFloat(d.sniperHoldingPercent    ?? 0) || 0,
    suspiciousPct: parseFloat(d.suspiciousHoldingPercent ?? 0) || 0,
    riskLevel:     d.riskControlLevel    ?? null,
    devHoldingPct: parseFloat(d.devHoldingPercent ?? 0) || 0,
    devSoldAll:    tags.includes("devHoldingStatusSellAll"),
    smartMoneyBuy: tags.includes("smartMoneyBuy"),
    honeypot:      tags.includes("honeypot"),
    devRugCount:   parseInt(d.devRugPullTokenCount ?? 0) || 0,
    creator:       d.creatorAddress ?? null,
  };
}

/**
 * Fetch ATH price and current price info from OKX.
 * Used for athFilterPct check in screening.
 */
export async function getTokenPriceInfo(mint) {
  const d = await okxGet("/api/v5/dex/market/price-info", {
    tokenContractAddress: mint,
  });
  if (!d) return null;

  return {
    ath:          parseFloat(d.maxPrice ?? 0) || null,
    currentPrice: parseFloat(d.price    ?? 0) || null,
  };
}

/**
 * Fetch cluster / KOL trend data from OKX.
 * Info-only — not used for hard filtering.
 */
export async function getTokenClusterList(mint) {
  return okxGet("/api/v5/dex/market/cluster/list", {
    tokenContractAddress: mint,
  });
}
