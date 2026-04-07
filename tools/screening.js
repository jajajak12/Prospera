/**
 * screening.js — Token-first discovery + Fibonacci signal filter
 *
 * Flow (v3 — Dexscreener-first + Birdeye OHLCV):
 * 1. Discover trending Solana tokens from Dexscreener (boosts + latest profiles)
 * 2. Filter by 1h cross-DEX volume (pre-populated from discovery or Dexscreener)
 * 3. Safety checks: RugCheck bundle/honeypot + Jupiter top10/botHolders/feesSOL
 * 4. Find Meteora DLMM pool for each candidate (TVL, fee/TVL, bin_step, organic, holders)
 * 5. Fibonacci analysis using Birdeye OHLCV candles + Meteora pool bin_step
 * 6. Smart wallet boost
 * 7. Sort by confluenceScore, return
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { analyzeSignal } from "./chart.js";
import { hybridDataProvider } from "./dataProvider.js";
import { getTokenAdvancedInfo, getTokenPriceInfo } from "./okx.js";
import { batchGetTokenVolumeH1, getJupiterTokenInfo } from "./token.js";
import { checkSmartWalletActivity } from "../smart-wallets.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEXSCREENER_BASE  = "https://api.dexscreener.com";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Cache pools rejected with "broken support" — persists across PM2 restarts via JSON file
// Stores { cachedAt, priceAtRejection, athAtRejection } — invalidated ONLY if price > ATH at rejection
const BROKEN_SUPPORT_CACHE_PATH = path.join(__dirname, "..", "broken-support-cache.json");
const FIB_BROKEN_CACHE_MS = 24 * 60 * 60 * 1000; // 24 jam (was 3h)

function _loadBrokenSupportCache() {
  try {
    if (!fs.existsSync(BROKEN_SUPPORT_CACHE_PATH)) return new Map();
    const raw = JSON.parse(fs.readFileSync(BROKEN_SUPPORT_CACHE_PATH, "utf8"));
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function _saveBrokenSupportCache(map) {
  try {
    fs.writeFileSync(BROKEN_SUPPORT_CACHE_PATH, JSON.stringify(Object.fromEntries(map)));
  } catch { /* non-fatal */ }
}

const _fibBrokenSupportCache = _loadBrokenSupportCache();

function loadJsonSet(filename) {
  try {
    const p = path.join(__dirname, "..", filename);
    if (!fs.existsSync(p)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch { return new Set(); }
}

function isBlacklisted(mint) {
  return loadJsonSet("token-blacklist.json").has(mint);
}

function isDevBlocked(devAddress) {
  if (!devAddress) return false;
  return loadJsonSet("dev-blocklist.json").has(devAddress);
}

/**
 * Condense a raw Meteora pool object for LLM consumption.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint:   p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint:   p.token_y?.address,
    },
    bin_step:   p.dlmm_params?.bin_step || null,
    fee_pct:    p.fee_pct,

    // Core metrics
    active_tvl:           round(p.active_tvl),
    fee_window:           round(p.fee),
    volume_window:        round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility:          fix(p.volatility, 2),

    // Token health
    holders:           p.base_token_holders,
    mcap:              round(p.token_x?.market_cap),
    organic_score:     Math.round(p.token_x?.organic_score || 0),
    token_age_hours:   p.token_x?.created_at
      ? (Date.now() - p.token_x.created_at) / 3_600_000
      : null,

    // Price action
    price:             p.pool_price,
    price_change_pct:  fix(p.pool_price_change_pct, 1),
    price_trend:       p.price_trend,
    min_price:         p.min_price,
    max_price:         p.max_price,

    // Activity
    volume_change_pct: fix(p.volume_change_pct, 1),
    swap_count:        p.swap_count,
    unique_traders:    p.unique_traders,
    active_positions:  p.active_positions,
    active_pct:        fix(p.active_positions_pct, 1),
  };
}

function round(n) { return n != null ? Math.round(n) : null; }
function fix(n, d) { return n != null ? Number(n.toFixed(d)) : null; }

// ─────────────────────────────────────────────────────────────────────────────
//  Discovery: Dexscreener trending Solana tokens (boosts + latest profiles)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover trending tokens on Solana from Dexscreener.
 * Fetches top-boosted + latest token profiles, then enriches with pair data
 * (price, mcap, 1h volume) via the tokens endpoint.
 *
 * Returns unique base tokens with SOL pair: { mint, symbol, price, mcap, _vol5m }
 */
async function discoverTokensFromDexscreener() {
  const seen     = new Set();
  const rawMints = [];

  // Fetch top boosted tokens + latest token profiles in parallel
  const [boostsResult, profilesResult] = await Promise.allSettled([
    fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`,       { signal: AbortSignal.timeout(10_000) }),
    fetch(`${DEXSCREENER_BASE}/token-profiles/latest/v1`,  { signal: AbortSignal.timeout(10_000) }),
  ]);

  for (const result of [boostsResult, profilesResult]) {
    if (result.status !== "fulfilled" || !result.value.ok) continue;
    try {
      const items = await result.value.json();
      for (const item of (Array.isArray(items) ? items : [])) {
        if (item.chainId !== "solana") continue;
        const mint = item.tokenAddress;
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        rawMints.push(mint);
      }
    } catch { /* skip */ }
  }

  if (rawMints.length === 0) {
    log("screening", "Dexscreener discovery: no tokens found from boosts/profiles");
    return [];
  }

  // Batch fetch pair details (max 30 per request) to get price, mcap, h1 volume
  const chunks = [];
  for (let i = 0; i < rawMints.length; i += 30) chunks.push(rawMints.slice(i, i + 30));

  const chunkResults = await Promise.allSettled(
    chunks.map(chunk =>
      fetch(`${DEXSCREENER_BASE}/tokens/v1/solana/${chunk.join(",")}`, { signal: AbortSignal.timeout(10_000) })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  );

  // Per mint: keep only SOL-paired tokens, pick best pair (highest h1 volume)
  const byMint = new Map();
  for (const result of chunkResults) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const pairList = Array.isArray(result.value) ? result.value : (result.value?.pairs ?? []);
    for (const pair of pairList) {
      if (pair.chainId !== "solana") continue;
      const quoteAddr = pair.quoteToken?.address;
      // Only include tokens paired against native SOL (WSOL)
      if (quoteAddr !== SOL_MINT && pair.quoteToken?.symbol !== "SOL") continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const volH1 = parseFloat(pair.volume?.h1 ?? 0) || 0;
      const existing = byMint.get(mint);
      if (!existing || volH1 > (existing._vol5m ?? 0)) {
        byMint.set(mint, {
          mint,
          symbol: pair.baseToken?.symbol ?? "UNKNOWN",
          price:  parseFloat(pair.priceUsd) || null,
          mcap:   parseFloat(pair.fdv ?? pair.marketCap) || null,
          _vol5m: Math.round(volH1),
        });
      }
    }
  }

  const tokens = [...byMint.values()];
  log("screening", `Dexscreener discovery: ${tokens.length} unique SOL-pair tokens from ${rawMints.length} candidates`);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RocketScan fallback — untuk pool yang belum diindex Meteora pool-discovery-api
// ─────────────────────────────────────────────────────────────────────────────

const ROCKETSCAN_API   = "https://rocketscan.fun/api/pools";
const DLMM_DATAPI_BASE = "https://dlmm.datapi.meteora.ag";

/**
 * Untuk token yang tidak ditemukan di Meteora pool-discovery-api,
 * coba cari pool-nya via RocketScan (deteksi on-chain, lebih cepat diindex).
 * Jika ditemukan, fetch detail dari dlmm.datapi.meteora.ag dan apply basic filters.
 *
 * Returns array of { token, pool } yang lolos filter.
 */
async function fetchRocketScanFallback(tokens, s) {
  if (tokens.length === 0) return [];

  const results = await Promise.all(tokens.map(async (token) => {
    try {
      // 1. Cari DLMM pool di RocketScan
      const rsRes = await fetch(
        `${ROCKETSCAN_API}?tokenBMint=${token.mint}&poolType=DLMM`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!rsRes.ok) return null;
      const rsData = await rsRes.json();
      const rsPools = (rsData.data ?? []).filter(p => p.poolType === "DLMM");
      if (rsPools.length === 0) return null;

      // Ambil pool pertama (paling baru per default sort RocketScan)
      const rsPool = rsPools[0];
      const poolId = rsPool.poolId;
      if (!poolId) return null;

      // 2. Fetch detail pool dari dlmm.datapi.meteora.ag
      const dmRes = await fetch(
        `${DLMM_DATAPI_BASE}/pools?query=${poolId}`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!dmRes.ok) return null;
      const dmData = await dmRes.json();
      const dm = dmData.data?.[0];
      if (!dm || dm.address !== poolId) return null;

      // 3. Pastikan pair-nya SOL
      const quoteSymbol = dm.token_y?.symbol ?? "";
      if (quoteSymbol !== "SOL" && dm.token_y?.address !== "So11111111111111111111111111111111111111112") {
        log("screening", `  ${token.symbol}: RS fallback — pool pair bukan SOL (${quoteSymbol}), skip`);
        return null;
      }

      // 4. Apply basic filters
      const binStep      = dm.pool_config?.bin_step ?? null;
      const tvl          = dm.tvl ?? 0;
      const holders      = dm.token_x?.holders ?? 0;
      const mcap         = dm.token_x?.market_cap ?? 0;
      const organicScore = rsPool.tokenB?.organicScore ?? null;
      const tokenAge     = rsPool.tokenB?.tokenCreatedAt
        ? (Date.now() - new Date(rsPool.tokenB.tokenCreatedAt).getTime()) / 3_600_000
        : null;

      if (binStep == null || binStep < (s.minBinStep ?? 0) || binStep > (s.maxBinStep ?? 9999)) {
        log("screening", `  ${token.symbol}: RS fallback — bin_step ${binStep} diluar range [${s.minBinStep}-${s.maxBinStep}]`);
        return null;
      }
      if (tvl < (s.minTvl ?? 0)) {
        log("screening", `  ${token.symbol}: RS fallback — TVL $${Math.round(tvl)} < min $${s.minTvl}`);
        return null;
      }
      if (s.maxTvl != null && tvl > s.maxTvl) {
        log("screening", `  ${token.symbol}: RS fallback — TVL $${Math.round(tvl)} > max $${s.maxTvl}`);
        return null;
      }
      if (organicScore != null && organicScore < (s.minOrganic ?? 0)) {
        log("screening", `  ${token.symbol}: RS fallback — organic ${organicScore.toFixed(0)} < min ${s.minOrganic}`);
        return null;
      }
      if (holders < (s.minHolders ?? 0)) {
        log("screening", `  ${token.symbol}: RS fallback — holders ${holders} < min ${s.minHolders}`);
        return null;
      }
      if (mcap < (s.minMcap ?? 0)) {
        log("screening", `  ${token.symbol}: RS fallback — mcap $${Math.round(mcap)} < min $${s.minMcap}`);
        return null;
      }
      if (tokenAge != null && s.minTokenAgeHours != null && tokenAge < s.minTokenAgeHours) {
        log("screening", `  ${token.symbol}: RS fallback — token age ${(tokenAge * 60).toFixed(0)}m < min ${s.minTokenAgeHours * 60}m`);
        return null;
      }
      if (tokenAge != null && s.maxTokenAgeHours != null && tokenAge > s.maxTokenAgeHours) {
        log("screening", `  ${token.symbol}: RS fallback — token age ${tokenAge.toFixed(1)}h > max ${s.maxTokenAgeHours}h`);
        return null;
      }

      // 5. Build condensed pool object kompatibel dengan pipeline
      // fee_active_tvl_ratio dilewati — pool terlalu baru untuk punya data 24h yang valid
      const pool = {
        pool:                poolId,
        name:                dm.name,
        base: {
          symbol:   dm.token_x?.symbol,
          mint:     dm.token_x?.address,
          organic:  Math.round(organicScore ?? 0),
          warnings: 0,
        },
        quote: {
          symbol: dm.token_y?.symbol,
          mint:   dm.token_y?.address,
        },
        bin_step:            binStep,
        fee_pct:             dm.pool_config?.base_fee_pct ?? null,
        active_tvl:          null,
        fee_window:          null,
        volume_window:       Math.round(dm.volume?.["24h"] ?? dm.volume?.["1h"] ?? 0),
        fee_active_tvl_ratio: null, // new pool — insufficient 24h data
        volatility:          null,
        holders,
        mcap:                Math.round(mcap),
        organic_score:       Math.round(organicScore ?? 0),
        token_age_hours:     tokenAge,
        price:               dm.current_price,
        price_change_pct:    null,
        price_trend:         null,
        _source:             "rocketscan",
      };

      log("screening", `  ${token.symbol}: RS fallback — pool ${poolId.slice(0, 8)}... ditemukan (bin_step=${binStep}, TVL=$${Math.round(tvl)})`);
      return { token, pool };
    } catch (e) {
      // Fallback failure tidak boleh crash screening
      return null;
    }
  }));

  return results.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Meteora pool lookup: find DLMM pool for a specific base token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all qualifying Meteora DLMM pools in one bulk request.
 * Returns a Map<baseMint, bestPool> — best pool = highest active TVL per token.
 *
 * Note: Meteora pool-discovery API does NOT support filtering by base_token_address.
 * We fetch all qualifying pools and match client-side by token_x.address.
 */
async function fetchMeteoraDlmmPoolMap() {
  const s = config.screening;

  const filters = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl ?? 500_000}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `fee>=${s.minFee ?? 25}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    `base_token_holders>=${s.minHolders}`,
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    // Note: base_token_age_hours is NOT a valid API filter — applied client-side below
  ].filter(Boolean).join("&&");

  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=100` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=24h` +
    `&sort_by=volume_desc`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log("screening", `Meteora API error: ${res.status}`);
      return new Map();
    }
    const data = await res.json();
    let pools = (data.data ?? []).map(condensePool);

    // Client-side age filter (API doesn't support base_token_age_hours)
    if (s.minTokenAgeHours != null || s.maxTokenAgeHours != null) {
      pools = pools.filter(p => {
        const age = p.token_age_hours;
        if (age == null) return true; // unknown age → keep
        if (s.minTokenAgeHours != null && age < s.minTokenAgeHours) return false;
        if (s.maxTokenAgeHours != null && age > s.maxTokenAgeHours) return false;
        return true;
      });
    }

    // Build Map<baseMint, bestPool> — keep highest active_tvl per token
    const poolMap = new Map();
    for (const pool of pools) {
      const mint = pool.base?.mint;
      if (!mint) continue;
      const existing = poolMap.get(mint);
      if (!existing || (pool.active_tvl ?? 0) > (existing.active_tvl ?? 0)) {
        poolMap.set(mint, pool);
      }
    }
    return poolMap;
  } catch (err) {
    log("screening", `Meteora bulk fetch error: ${err.message}`);
    return new Map();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main screening entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get top candidates with Fibonacci signal filter applied.
 *
 * @param {object} opts
 * @param {number} opts.limit - Max tokens to fully analyze (default 20)
 */
export async function getTopCandidates({ limit = 20 } = {}) {
  const s = config.screening;

  // ── Step 1: Discover tokens ──────────────────────────────────────────────
  const dexTokens = await discoverTokensFromDexscreener();

  // Exclude pools/mints where wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));

  let eligible = dexTokens.filter(t => {
    if (occupiedMints.has(t.mint)) return false;
    if (isBlacklisted(t.mint)) {
      log("screening", `  ${t.symbol}: SKIP — token blacklisted`);
      return false;
    }
    if (isDevBlocked(t.mint)) {
      log("screening", `  ${t.symbol}: SKIP — dev blocked`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  log.screening(`Step 1 — Discovery: ${eligible.length} tokens (raw: ${dexTokens.length}, excl blacklist/occupied)`);

  // ── Step 2: 1h volume filter ─────────────────────────────────────────────
  // Dexscreener discovery already provides _vol5m (h1 volume) for tokens with SOL pairs.
  // Only fetch separately for tokens where volume wasn't available in discovery.
  {
    const missingVol = eligible.filter(t => t._vol5m == null).map(t => t.mint);
    const volMap = missingVol.length > 0
      ? await batchGetTokenVolumeH1(missingVol).catch(() => new Map())
      : new Map();
    const before = eligible.length;
    eligible = eligible.filter(t => {
      const volH1 = t._vol5m ?? volMap.get(t.mint);
      if (volH1 == null) return true; // API miss → keep
      if (volH1 < s.minVolume) {
        log("screening", `  ${t.symbol}: SKIP — 1h vol $${Math.round(volH1)} < min $${s.minVolume}`);
        return false;
      }
      t._vol5m = Math.round(volH1);
      return true;
    });
    log.screening(`Step 2 — Volume filter: ${eligible.length}/${before} passed (min 1h $${s.minVolume})`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: 0, withPool_count: 0, fib_analyzed: 0 };
  }

  const afterVolumeCount = eligible.length;

  // ── Step 3: mcap pre-filter from Dexscreener discovery data (when available) ─
  {
    const before = eligible.length;
    eligible = eligible.filter(t => {
      if (t.mcap == null) return true; // no GT data → defer to Meteora query
      if (t.mcap < s.minMcap) {
        log("screening", `  ${t.symbol}: SKIP — mcap $${Math.round(t.mcap)} < min $${s.minMcap}`);
        return false;
      }
      if (t.mcap > s.maxMcap) {
        log("screening", `  ${t.symbol}: SKIP — mcap $${Math.round(t.mcap)} > max $${s.maxMcap}`);
        return false;
      }
      return true;
    }).slice(0, limit * 3); // cap before expensive API calls
    if (eligible.length < before) log.screening(`Step 3 — mcap filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 4: RugCheck bundle / honeypot / dev filter ──────────────────────
  {
    const rugResults = await Promise.all(
      eligible.map(t => getTokenAdvancedInfo(t.mint))
    );
    const before = eligible.length;
    eligible = eligible.filter((t, i) => {
      const okx = rugResults[i];
      if (!okx) { log("screening", `  ${t.symbol}: OK (no RugCheck data)`); return true; } // API miss → keep
      if (okx.honeypot) {
        log("screening", `  ${t.symbol}: SKIP — honeypot/rugged`);
        return false;
      }
      if (s.maxBundlePct != null && okx.bundlePct > s.maxBundlePct) {
        log("screening", `  ${t.symbol}: SKIP — bundle ${okx.bundlePct}% > max ${s.maxBundlePct}%`);
        return false;
      }
      if (isDevBlocked(okx.creator)) {
        log("screening", `  ${t.symbol}: SKIP — creator blocked`);
        return false;
      }
      t._okx = okx;
      log("screening", `  ${t.symbol}: OK — bundle=${okx.bundlePct ?? "?"}%, insiders=${okx.graphInsiders ?? "?"}`);
      return true;
    });
    log("screening", `RugCheck filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 5: Jupiter token safety filter (top10, bot holders, fees SOL) ───
  {
    const jupResults = await Promise.all(
      eligible.map(t => getJupiterTokenInfo(t.mint).catch(() => null))
    );
    const before = eligible.length;
    eligible = eligible.filter((t, i) => {
      const jup = jupResults[i];
      if (!jup) { log("screening", `  ${t.symbol}: OK (no Jupiter data)`); return true; } // API miss → keep
      if (jup.top10Pct != null && jup.top10Pct > (s.maxTop10Pct ?? 20)) {
        log("screening", `  ${t.symbol}: SKIP — top10 ${jup.top10Pct}% > max ${s.maxTop10Pct ?? 20}%`);
        return false;
      }
      if (jup.botHoldersPct != null && jup.botHoldersPct > (s.maxBotHoldersPct ?? 30)) {
        log("screening", `  ${t.symbol}: SKIP — bot holders ${jup.botHoldersPct}% > max ${s.maxBotHoldersPct ?? 30}%`);
        return false;
      }
      if (jup.feesSOL != null && jup.feesSOL < (s.minTokenFeesSol ?? 25)) {
        log("screening", `  ${t.symbol}: SKIP — fees ${jup.feesSOL} SOL < min ${s.minTokenFeesSol ?? 25}`);
        return false;
      }
      t._jup = jup;
      log("screening", `  ${t.symbol}: OK — top10=${jup.top10Pct ?? "?"}%, bots=${jup.botHoldersPct ?? "?"}%, fees=${jup.feesSOL ?? "?"} SOL`);
      return true;
    });
    log("screening", `Jupiter filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 6: ATH proximity filter (optional) ──────────────────────────────
  if (s.athFilterPct != null) {
    const priceResults = await Promise.all(
      eligible.map(t => getTokenPriceInfo(t.mint))
    );
    const before = eligible.length;
    eligible = eligible.filter((t, i) => {
      const pr = priceResults[i];
      if (!pr?.ath || !pr?.currentPrice) return true;
      const distFromAth = (pr.ath - pr.currentPrice) / pr.ath * 100;
      if (distFromAth < s.athFilterPct) {
        log("screening", `  ${t.symbol}: SKIP — price ${distFromAth.toFixed(1)}% from ATH (min ${s.athFilterPct}%)`);
        return false;
      }
      t._ath = pr.ath;
      return true;
    });
    log("screening", `ATH filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 7: Find Meteora DLMM pool for each passing token ────────────────
  // Fetch all qualifying pools in one bulk request, then match by token mint.
  log("screening", `Finding Meteora DLMM pools for ${eligible.length} tokens...`);
  const meteoraPoolMap = await fetchMeteoraDlmmPoolMap();
  log("screening", `Meteora pool universe: ${meteoraPoolMap.size} qualifying pools fetched`);

  // ── Step 7b: RocketScan fallback untuk token yang tidak ditemukan ─────────
  // pool-discovery-api butuh waktu untuk mengindex pool baru.
  // RocketScan mendeteksi pool secara on-chain sehingga lebih cepat.
  const missingTokens = eligible.filter(t => !meteoraPoolMap.has(t.mint));
  if (missingTokens.length > 0) {
    const fallbacks = await fetchRocketScanFallback(missingTokens, s);
    for (const { token, pool } of fallbacks) {
      meteoraPoolMap.set(token.mint, pool);
    }
    if (fallbacks.length > 0) {
      log("screening", `RocketScan fallback: ${fallbacks.length}/${missingTokens.length} token mendapat pool`);
    }
  }

  const withPool = eligible
    .map(t => ({ token: t, pool: meteoraPoolMap.get(t.mint) ?? null }))
    .filter(({ token, pool }) => {
      if (!pool) {
        log("screening", `  ${token.symbol}: NO POOL — not in Meteora qualifying pool list`);
        return false;
      }
      return true;
    });

  log.screening(`Step 7 — Meteora pool match: ${withPool.length}/${eligible.length} tokens have qualifying pools`);

  if (withPool.length === 0) {
    return { candidates: [], total_screened: dexTokens.length, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 8: Fibonacci analysis ───────────────────────────────────────────
  // Birdeye OHLCV uses token mint; Meteora pool bin_step for bin range calculation.

  // Filter out pools cached as "broken support" — price far below Fib 0.618, no recovery expected soon
  // All price values are stored in USD (token.price from GT) to match GT OHLCV candle units.
  const now = Date.now();
  const toAnalyze = withPool.filter(({ token, pool }) => {
    // Skip pools that are actively crashing (>80% price drop in 24h) — not an entry signal
    if (pool.price_change_pct != null && pool.price_change_pct <= -80) {
      log("screening", `  ${pool.name}: SKIP — price crashed ${pool.price_change_pct.toFixed(1)}% in 24h`);
      const usdPrice = token.price ?? pool.price ?? 0;
      _fibBrokenSupportCache.set(pool.pool, { cachedAt: now, priceAtRejection: usdPrice, athAtRejection: null });
      _saveBrokenSupportCache(_fibBrokenSupportCache);
      return false;
    }
    // Skip pools cached as "broken support" — invalidate ONLY if price broke previous ATH
    const cached = _fibBrokenSupportCache.get(pool.pool);
    if (cached && now - cached.cachedAt < FIB_BROKEN_CACHE_MS) {
      const usdPrice = token.price ?? pool.price ?? 0;
      if (cached.athAtRejection != null && usdPrice > cached.athAtRejection) {
        _fibBrokenSupportCache.delete(pool.pool);
        _saveBrokenSupportCache(_fibBrokenSupportCache);
        log("screening", `  ${pool.name}: cache invalidated — new ATH $${usdPrice.toPrecision(4)} > prev ATH $${cached.athAtRejection.toPrecision(4)}, re-analyzing`);
        return true;
      }
      const hrsLeft = (FIB_BROKEN_CACHE_MS - (now - cached.cachedAt)) / 3_600_000;
      log("screening", `  ${pool.name}: SKIP — broken support cached, recheck in ${hrsLeft < 1 ? `${Math.ceil(hrsLeft * 60)}m` : `${hrsLeft.toFixed(1)}h`}`);
      return false;
    }
    return true;
  });
  log("screening", `Running Fibonacci analysis on ${toAnalyze.length} pools...`);

  const signalResults = await Promise.allSettled(
    toAnalyze.map(async ({ token, pool }) => {
      // MUST use USD price — OHLCV candles are in USD.
      // pool.price is Meteora SOL-denominated; using it against USD Fib levels causes unit mismatch.
      let currentPrice = token.price; // no fallback to pool.price (SOL-denominated)
      const binStep    = pool.bin_step;
      if (!binStep) {
        return { signal: "SKIP", reason: "Missing bin_step" };
      }
      // If Dexscreener discovery didn't provide USD price, try hybridDataProvider
      if (!currentPrice) {
        try {
          const poolData = await hybridDataProvider.getPoolData(pool.pool);
          currentPrice = poolData.price ?? null;
        } catch { /* non-fatal */ }
      }
      if (!currentPrice) {
        return { signal: "SKIP", reason: "Missing USD price — skip to avoid unit mismatch" };
      }
      return analyzeSignal(token.mint, binStep, currentPrice, s.candleLimit ?? 50, { rsiMin: s.rsiMin ?? 48 }, pool.pool);
    })
  );

  // ── Build candidates from ENTRY signals ──────────────────────────────────
  const candidates = [];
  for (let i = 0; i < toAnalyze.length; i++) {
    const { token, pool } = toAnalyze[i];
    const result   = signalResults[i];
    const analysis = result.status === "fulfilled"
      ? result.value
      : { signal: "SKIP", reason: `Analysis failed: ${result.reason?.message || result.reason}` };

    // Cache pools rejected for broken support — store ATH from Fib so invalidation is ATH-aware
    if (analysis.signal !== "ENTRY" && analysis.reason?.includes("broken support")) {
      const rejectedPrice  = token.price ?? pool.price ?? 0;
      const athAtRejection = analysis.fibLevels?.swingHigh ?? null;
      _fibBrokenSupportCache.set(pool.pool, { cachedAt: now, priceAtRejection: rejectedPrice, athAtRejection });
      _saveBrokenSupportCache(_fibBrokenSupportCache);
    }

    log("screening", `  ${pool.name}: ${analysis.signal} — ${analysis.reason}`);
    if (analysis.signal !== "ENTRY") continue;

    candidates.push({
      ...pool,
      volume_h1: token._vol5m ?? null,
      ath:       token._ath   ?? null,
      okx:       token._okx   ?? null,
      fib_signal: {
        signal:              analysis.signal,
        reason:              analysis.reason,
        binsBelow:           analysis.binsBelow,
        binsAbove:           analysis.binsAbove ?? 0,
        currentPrice:        analysis.currentPrice,
        confluenceScore:     analysis.confluenceScore ?? 0,
        pricePosition:       analysis.pricePosition   ?? null,
        inPrimaryZone:       analysis.inPrimaryZone   ?? false,
        inAthZone:           analysis.inAthZone        ?? false,
        hasHiddenDivergence: analysis.hasHiddenDivergence ?? false,
        rsi:                 analysis.rsi      ?? null,
        rsiSlope:            analysis.rsiSlope ?? null,
        atrPct:              analysis.atrPct   ?? null,
        fibLevels: analysis.fibLevels ? {
          fib236:    analysis.fibLevels.fib236,
          fib382:    analysis.fibLevels.fib382,
          fib500:    analysis.fibLevels.fib500,
          fib618:    analysis.fibLevels.fib618,
          swingHigh: analysis.fibLevels.swingHigh,
          swingLow:  analysis.fibLevels.swingLow,
        } : null,
      },
    });
  }

  // ── Step 9: Smart wallet activity check ──────────────────────────────────
  if (candidates.length > 0) {
    try {
      const poolAddresses = candidates.map(c => c.pool);
      const smartMoneyMap = await checkSmartWalletActivity(poolAddresses);
      if (smartMoneyMap.size > 0) {
        for (const c of candidates) {
          const walletLabels = smartMoneyMap.get(c.pool);
          if (walletLabels?.length > 0) {
            c.smart_money = { present: true, wallets: walletLabels };
            c.fib_signal.confluenceScore = Math.min(
              1,
              Math.round((c.fib_signal.confluenceScore + 0.10) * 100) / 100
            );
            log("screening", `  ${c.name}: SMART MONEY ✓ (${walletLabels.join(", ")}) — score boosted`);
          } else {
            c.smart_money = { present: false, wallets: [] };
          }
        }
      }
    } catch (e) {
      log("screening", `Smart wallet check failed (non-fatal): ${e.message}`);
    }
  }

  // Filter by minConfluenceScore if configured
  const minConf = s.minConfluenceScore ?? 0;
  const beforeConf = candidates.length;
  const filtered = minConf > 0
    ? candidates.filter(c => {
        if ((c.fib_signal.confluenceScore ?? 0) < minConf) {
          log("screening", `  ${c.name}: SKIP — confluenceScore ${c.fib_signal.confluenceScore} < min ${minConf}`);
          return false;
        }
        return true;
      })
    : candidates;

  // Sort by confluence score descending
  filtered.sort((a, b) => (b.fib_signal.confluenceScore ?? 0) - (a.fib_signal.confluenceScore ?? 0));

  log.screening(`Step 8 — Fibonacci: ${filtered.length}/${withPool.length} passed (analyzed: ${toAnalyze.length}, entry: ${candidates.length}${minConf > 0 && filtered.length < beforeConf ? `, dropped ${beforeConf - filtered.length} below minConf ${minConf}` : ""})`);
  log.screening(`Summary: discovered=${dexTokens.length} → volume=${afterVolumeCount} → pools=${withPool.length} → fib_entry=${filtered.length}`);

  return {
    candidates:        filtered,
    total_screened:    dexTokens.length,
    after_volume_count: afterVolumeCount,
    withPool_count:    withPool.length,
    fib_analyzed:      toAnalyze.length,
    fib_passed:        candidates.length,
  };
}

/**
 * Get full raw details for a specific pool.
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const pool = (data.data || [])[0];
  if (!pool) throw new Error(`Pool ${pool_address} not found`);

  return pool;
}
