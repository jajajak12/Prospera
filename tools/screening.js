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
import { logWithId, logSkip } from "../log-utils.js";
import { analyzeSignal } from "./chart.js";
import { hybridDataProvider } from "./dataProvider.js";
import { getTokenAdvancedInfo, getTokenPriceInfo } from "./okx.js";
import { batchGetTokenVolumeH1, getJupiterTokenInfo } from "./token.js";
import { checkSmartWalletActivity } from "../smart-wallets.js";
import { isPoolOnATHCooldown } from "../pool-memory.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEXSCREENER_BASE  = "https://api.dexscreener.com";
const GECKO_BASE        = "https://api.geckoterminal.com/api/v2";
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
    if (!raw || typeof raw !== "object") return new Map();
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function _saveBrokenSupportCache(map) {
  try {
    fs.writeFileSync(BROKEN_SUPPORT_CACHE_PATH, JSON.stringify(Object.fromEntries(map)));
  } catch { /* non-fatal */ }
}

const _fibBrokenSupportCache = _loadBrokenSupportCache();

// Cached sets with file mtime tracking — reload only when file changes
function makeCachedSet(filename) {
  let cache = { mtime: 0, set: new Set() };
  return () => {
    const p = path.join(__dirname, "..", filename);
    try {
      if (!fs.existsSync(p)) return cache.set;
      const { mtimeMs } = fs.statSync(p);
      if (mtimeMs !== cache.mtime) {
        cache.mtime = mtimeMs;
        cache.set = new Set(JSON.parse(fs.readFileSync(p, "utf8")));
        log("screening", `Loaded ${filename}: ${cache.set.size} entries cached`);
      }
    } catch { /* non-fatal */ }
    return cache.set;
  };
}

const _blacklistCache = makeCachedSet("token-blacklist.json");
const _devBlockCache = makeCachedSet("dev-blocklist.json");

function isBlacklisted(mint) {
  return _blacklistCache().has(mint);
}

function isDevBlocked(devAddress) {
  if (!devAddress) return false;
  return _devBlockCache().has(devAddress);
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
 * Discover pump.fun graduated tokens via RocketScan DLMM pool scan.
 * Graduated tokens (pumpswap/raydium) often miss Dexscreener boosts/profiles.
 *
 * Strategy:
 * 1. Query RocketScan for recent DLMM pools with SOL quote, sorted by volume
 * 2. RocketScan gives: mcap, buyVolume (SOL), fees, top10%, bot%, organic score
 * 3. Apply screening filters (minVolume, minMcap)
 * 4. Deduplicate by mint
 *
 * Returns tokens: { mint, symbol, price=null, mcap, _volH1, _source }
 */
async function discoverTokensFromRocketScan(s) {
  const ROCKETSCAN = "https://rocketscan.fun/api/pools";

  try {
    const res = await fetch(
      `${ROCKETSCAN}?poolType=DLMM&sort=volume&limit=50`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) {
      log("screening", `Jupiter discovery: RocketScan HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const pools = data.data ?? [];

    // Only SOL pairs (tokenA = SOL), graduated pump.fun tokens
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const byMint  = new Map();

    for (const p of pools) {
      const tokenA = p.tokenA ?? {};
      const tokenB = p.tokenB ?? {};
      if (tokenA.mint !== SOL_MINT) continue;

      const mint = tokenB.mint;
      if (!mint) continue;

      // Apply mcap filter
      const mcap = parseFloat(tokenB.mcap ?? 0) || 0;
      if (mcap < 150_000) continue; // min mcap $150K

      // Deduplicate: keep highest mcap per mint
      const existing = byMint.get(mint);
      if (existing && existing.mcap >= mcap) continue;

      byMint.set(mint, {
        mint,
        symbol:  tokenB.symbol ?? "UNKNOWN",
        price:   null,
        mcap:    Math.round(mcap),
        _volH1:  null,  // Step 2 fetches USD volume via Dexscreener batch
        _source: "rocketscan",
      });
    }

    const tokens = [...byMint.values()];

    if (tokens.length > 0) {
      log("screening", `RocketScan discovery: ${tokens.length} SOL-pair DLMM pools (min mcap $150K)`);
    }
    return tokens;
  } catch (e) {
    log("screening", `RocketScan discovery error: ${e.message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * Discover trending tokens on Solana from Dexscreener.
 * Fetches top-boosted + latest token profiles, then enriches with pair data
 * (price, mcap, 1h volume) via the tokens endpoint.
 *
 * Returns unique base tokens with SOL pair: { mint, symbol, price, mcap, _volH1 }
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

  // Per mint: sum volume.h1 across ALL SOL-paired pools (Dexscreener returns per-pool data).
  // Solana tokens can have multiple pools (Pump.fun, Raydium, Orca, Meteora) — taking only
  // the highest-volume pool underestimates true cross-DEX activity. Use sum instead.
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
      if (!existing) {
        byMint.set(mint, {
          mint,
          symbol: pair.baseToken?.symbol ?? "UNKNOWN",
          price:  parseFloat(pair.priceUsd) || null,
          mcap:   parseFloat(pair.fdv ?? pair.marketCap) || null,
          _volH1: Math.round(volH1),
          _mcapAtDiscovery: parseFloat(pair.fdv ?? pair.marketCap) || null,
        });
      } else {
        // Aggregate: sum h1 volume across ALL pools for this mint
        existing._volH1 += volH1;
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

const ROCKETSCAN_API = "https://rocketscan.fun/api/pools";

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
      if (!rsRes.ok) {
        log("screening", `  ${token.symbol}: RocketScan HTTP ${rsRes.status} for ${token.mint.slice(0, 8)}...`);
        return null;
      }
      const rsData = await rsRes.json();
      const rsPools = (rsData.data ?? []).filter(p => p.poolType === "DLMM");
      if (rsPools.length === 0) {
        log("screening", `  ${token.symbol}: RocketScan — no DLMM pool found for ${token.mint.slice(0, 8)}...`);
        return null;
      }

      // Ambil pool pertama (paling baru per default sort RocketScan)
      const rsPool = rsPools[0];
      const poolId = rsPool.poolId;
      if (!poolId) return null;

      // 2. Fetch pool detail dari pool-discovery-api (dlmm.datapi.meteora.ag now 403)
      const pdRes = await fetch(
        `${POOL_DISCOVERY_BASE}/pools?filter_by=${encodeURIComponent(`pool_address=${poolId}`)}&page_size=1&timeframe=1h`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!pdRes.ok) return null;
      const pdData = await pdRes.json();
      const dm = pdData.data?.[0];
      if (!dm || dm.pool_address !== poolId) return null;

      // 3. Pastikan pair-nya SOL
      const quoteSymbol = dm.token_y?.symbol ?? dm.token_y?.name ?? "";
      if (quoteSymbol !== "SOL" && dm.token_y?.address !== "So11111111111111111111111111111111111111112") {
        log("screening", `  ${token.symbol}: RS fallback — pool pair bukan SOL (${quoteSymbol}), skip`);
        return null;
      }

      // 4. Apply basic filters (pool-discovery-api field names)
      const binStep      = dm.dlmm_params?.bin_step ?? null;
      const tvl          = dm.tvl ?? 0;
      const holders      = dm.base_token_holders ?? dm.token_x?.holders ?? 0;
      const mcap         = dm.token_x?.market_cap ?? dm.base_token_market_cap ?? 0;
      const organicScore = dm.token_x?.organic_score ?? rsPool.tokenB?.organicScore ?? null;
      const tokenAge     = dm.token_x?.created_at
        ? (Date.now() - dm.token_x.created_at) / 3_600_000
        : (rsPool.tokenB?.tokenCreatedAt
            ? (Date.now() - new Date(rsPool.tokenB.tokenCreatedAt).getTime()) / 3_600_000
            : null);

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
      const pool = {
        pool:                poolId,
        name:                dm.name,
        base: {
          symbol:   dm.token_x?.symbol ?? dm.token_x?.name ?? token.symbol,
          mint:     dm.token_x?.address,
          organic:  Math.round(organicScore ?? 0),
          warnings: dm.token_x?.warnings?.length ?? 0,
        },
        quote: {
          symbol: dm.token_y?.symbol ?? "SOL",
          mint:   dm.token_y?.address,
        },
        bin_step:            binStep,
        fee_pct:             dm.fee_pct ?? dm.dynamic_fee_pct ?? null,
        active_tvl:          dm.active_tvl ?? null,
        fee_window:          null,
        volume_window:       Math.round(dm.volume ?? 0),
        fee_active_tvl_ratio: dm.fee_active_tvl_ratio ?? null,
        volatility:          dm.volatility ?? null,
        holders,
        mcap:                Math.round(mcap),
        organic_score:       Math.round(organicScore ?? 0),
        token_age_hours:     tokenAge,
        price:               dm.pool_price ?? dm.token_x?.price ?? null,
        price_change_pct:    dm.pool_price_change_pct ?? null,
        price_trend:         Array.isArray(dm.price_trend) ? dm.price_trend : null,
        _source:             "rocketscan",
      };

      log("screening", `  ${token.symbol}: RS fallback — pool ${poolId.slice(0, 8)}... ditemukan (bin_step=${binStep}, TVL=$${Math.round(tvl)})`);
      return { token, pool };
    } catch (e) {
      // Fallback failure tidak boleh crash screening
      log("screening", `  ${token.symbol}: RocketScan exception: ${e.message?.slice(0, 80) ?? e}`);
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
      log("screening", `Meteora API error: HTTP ${res.status} — will rely on RocketScan fallback for pool discovery`);
      return new Map();
    }
    const data = await res.json();
    let pools = (data.data ?? []);

    if (!Array.isArray(pools) || pools.length === 0) {
      log("screening", `Meteora API returned 0 pools (or unexpected format) — RocketScan will handle all pool discovery`);
      return new Map();
    }

    pools = pools.map(condensePool);

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
export async function getTopCandidates({ limit = 20, correlationId = null } = {}) {
  const s = config.screening;

  // ── Correlation helper: uses existing ID when provided ──────────────────
  // Falls back to log() for non-cycle calls (e.g. direct getTopCandidates usage)
  const _s = (category, message, meta = {}) => {
    if (correlationId) {
      return logWithId(category, message, meta, correlationId);
    }
    return log(category, message, meta);
  };

  // ── Step 1: Discover tokens (Dexscreener + Jupiter) ──────────────────────
  // Dexscreener: boosts + latest profiles (covers paid-promoted tokens)
  // RocketScan: additional DLMM pools not in Dexscreener
  const [dexTokens, rocketTokens] = await Promise.all([
    discoverTokensFromDexscreener(),
    discoverTokensFromRocketScan(s),
  ]);

  // Merge: dedup by mint, Dexscreener tokens preferred (already have _volH1)
  const allTokens = [...dexTokens];
  const dexMintSet = new Set(dexTokens.map(t => t.mint));
  for (const t of rocketTokens) {
    if (!dexMintSet.has(t.mint)) allTokens.push(t);
  }
  log("screening", `Discovery: ${allTokens.length} tokens total (dex=${dexTokens.length}, rocket=${rocketTokens.length} new)`);

  // Exclude pools/mints where wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));

  let eligible = allTokens.filter(t => {
    if (occupiedMints.has(t.mint)) {
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — already has open position (${t.mint.slice(0, 8)}...)`);
      return false;
    }
    if (isBlacklisted(t.mint)) {
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — token blacklisted`);
      return false;
    }
    // isDevBlocked already called correctly at line 578 (after okx.creator available)
    // Note: isDevBlocked(t.mint) was removed — _devBlockCache stores dev wallet addresses, not token mints
    return true;
  });

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: 0, withPool_count: 0, fib_analyzed: 0 };
  }

  log.screening(`Step 1 — Discovery: ${eligible.length} tokens (raw: ${dexTokens.length}, excl blacklist/occupied)`);

  // ── Step 2: Volume Priority Chain ───────────────────────────────────────────
  // 3-layer sequential: Dexscreener → GeckoTerminal → Jupiter
  // Each layer ONLY runs for tokens where the previous layer's vol < minVolume.
  // If ANY layer returns >= minVolume, token passes immediately (no need to check further layers).
  // This replaces the old split-flow where Step 2 ran before Step 2b, causing stale Dexscreener
  // data to skip tokens before GeckoTerminal could override them.

  // Layer 1: Dexscreener h1 volume (primary) — already available as _volH1 from discovery,
  // batch-fetched for any tokens missing it.
  {
    const missingVol = eligible.filter(t => t._volH1 == null).map(t => t.mint);
    if (missingVol.length > 0) {
      const volMap = await batchGetTokenVolumeH1(missingVol).catch(() => new Map());
      for (const [mint, vol] of volMap) {
        const t = eligible.find(t => t.mint === mint);
        if (t) t._volH1 = Math.round(vol);
      }
    }
  }

  // Layer 2: GeckoTerminal vol24h → h1 conversion — override if Dexscreener vol < minVolume
  // GeckoTerminal aggregates across ALL DEX pools, more accurate for migrated tokens.
  // Convert h24 → h1 by dividing by 24 (conservative: real tokens often have intraday spikes).
  {
    const needsGecko = eligible.filter(t => (t._volH1 ?? 0) < s.minVolume);
    const geckoVolMap = new Map();
    const chunkSize = 20;
    for (let i = 0; i < needsGecko.length; i += chunkSize) {
      const chunk = needsGecko.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        chunk.map(mint =>
          fetch(`${GECKO_BASE}/networks/solana/tokens/${mint}`, { signal: AbortSignal.timeout(8_000) })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      );
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value) continue;
        try {
          const attrs = result.value?.data?.attributes;
          if (!attrs) continue;
          const mint = result.value.data.id;
          const vol24h = parseFloat(attrs.volume_usd?.h24 ?? 0) || 0;
          const marketCap = parseFloat(attrs.market_cap_usd) || 0;
          // Use h1 if available, otherwise convert h24 → h1
          const volH1 = vol24h > 0 ? Math.round(vol24h / 24) : 0;
          if (volH1 > 0) geckoVolMap.set(mint, { volH1, marketCap });
        } catch { /**/ }
      }
    }
    let geckoOverrideCount = 0;
    for (const t of needsGecko) {
      const gecko = geckoVolMap.get(t.mint);
      if (gecko && gecko.volH1 > (t._volH1 ?? 0)) {
        t._volH1 = gecko.volH1;
        if (gecko.marketCap > 0) t.mcap = gecko.marketCap;
        t._volH1Source = "geckoterminal";
        geckoOverrideCount++;
      }
    }
    if (geckoOverrideCount > 0) {
      log.screening(`Step 2b — GeckoTerminal override: ${geckoOverrideCount} tokens (Dexscreener stale)`);
    }
  }

  // Layer 3: Jupiter assets/search — last fallback if GeckoTerminal also < minVolume or error/404
  // /assets/search returns feesSOL and holder data but also has a volume-related 'volumeUsd24h' field.
  // We reuse getJupiterTokenInfo which already hits this endpoint; extract vol from result.
  {
    const needsJupiter = eligible.filter(t => (t._volH1 ?? 0) < s.minVolume);
    if (needsJupiter.length > 0) {
      const jupResults = await Promise.all(
        needsJupiter.map(t => getJupiterTokenInfo(t.mint).catch(() => null))
      );
      let jupiterOverrideCount = 0;
      for (let i = 0; i < needsJupiter.length; i++) {
        const jup = jupResults[i];
        if (!jup || jup.notFound) continue;
        // Jupiter 'volumeUsd24h' field (if present) as 1h proxy: use 1/24 of 24h volume
        const vol24h = jup.volumeUsd24h ?? 0;
        if (vol24h > 0) {
          const volH1 = Math.round(vol24h / 24);
          const t = needsJupiter[i];
          if (volH1 > (t._volH1 ?? 0)) {
            t._volH1 = volH1;
            t._volH1Source = "jupiter";
            jupiterOverrideCount++;
          }
        }
      }
      if (jupiterOverrideCount > 0) {
        log.screening(`Step 2c — Jupiter override: ${jupiterOverrideCount} tokens (GeckoTerminal stale/error)`);
      }
    }
  }

  // Layer 4: strict mcap-growth fallback
  // Hanya aktif jika:
  // - Semua layer sebelumnya (Dexscreener, Gecko, Jupiter) gagal/stale
  // - Mcap grew >= 3.0x sejak discovery
  // - Estimated 1h volume >= full minVolume ($150K)
  {
    const MCAP_VOL_RATIO     = 1.0;   // $vol/h per $1 mcap (full conservative)
    const MIN_GROWTH_RATIO   = 3.0;   // min mcap multiplier
    const VOL_OVERRIDE_RATIO = 1.0;   // full minVolume required
    let mcapOverrideCount = 0;
    for (const t of eligible) {
      if ((t._volH1 ?? 0) >= s.minVolume) continue;
      if (t._mcapAtDiscovery == null || t.mcap == null) continue;
      const ratio = t.mcap / t._mcapAtDiscovery;
      if (ratio >= MIN_GROWTH_RATIO) {
        const estimatedVol = Math.round(t.mcap * MCAP_VOL_RATIO);
        const threshold = Math.round(s.minVolume * VOL_OVERRIDE_RATIO);
        if (estimatedVol >= threshold) {
          t._volH1 = estimatedVol;
          t._volH1Source = "mcap-growth-override";
          mcapOverrideCount++;
          log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): VOL OVERRIDE (mcap ${ratio.toFixed(1)}x growth) | est_1h_vol=$${estimatedVol} [${t._volH1Source}]`);
        }
      }
    }
    if (mcapOverrideCount > 0) {
      log.screening(`Step 2d — mcap-growth override: ${mcapOverrideCount} tokens (all API sources stale)`);
    }
  }

  // Final pass: volume filter using the highest volume found across all layers
  {
    const before = eligible.length;
    eligible = eligible.filter(t => {
      const volH1 = t._volH1 ?? 0;
      if (volH1 >= s.minVolume) {
        t._volH1 = Math.round(volH1);
        return true;
      }
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — vol $${Math.round(volH1)} < min $${s.minVolume} [${t._volH1Source ?? "dexscreener"}] | mcap=${t.mcap ? "$" + Math.round(t.mcap) : "?"}`);
      return false;
    });
    log.screening(`Step 2 — Volume filter: ${eligible.length}/${before} passed (3-layer chain exhausted)`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: 0, withPool_count: 0, fib_analyzed: 0 };
  }

  const afterVolumeCount = eligible.length;

  // ── Step 3: mcap filter + pre-cap cull ─────────────────────────────────────
  {
    const before = eligible.length;
    const afterMcapFilter = eligible.filter(t => {
      if (t.mcap == null) return true;
      if (t.mcap < s.minMcap) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0, 8)}): SKIP — mcap $${Math.round(t.mcap)} < min $${s.minMcap} | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      if (t.mcap > s.maxMcap) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0, 8)}): SKIP — mcap $${Math.round(t.mcap)} > max $${s.maxMcap} | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      return true;
    });
    const preCapCount = afterMcapFilter.length;
    if (preCapCount > limit * 3) {
      const ranked = [...afterMcapFilter].sort((a, b) => (b._volH1 ?? 0) - (a._volH1 ?? 0));
      for (const t of ranked.slice(limit * 3)) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — pre-cap cull (rank ${ranked.indexOf(t) + 1} > ${limit * 3}) | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"} | mcap=${t.mcap ? "$" + Math.round(t.mcap) : "?"}`);
      }
    }
    eligible = afterMcapFilter.slice(0, limit * 3);
    if (eligible.length < before) {
      log.screening(`Step 3 — mcap filter: ${eligible.length}/${before} passed`);
    }
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 4: RugCheck bundle / honeypot / dev filter ──────────────────────
  {
    const rugResults = await Promise.all(
      eligible.map(t => getTokenAdvancedInfo(t.mint))
    );
    const before = eligible.length;
    eligible = eligible.filter((t, i) => {
      const okx = rugResults[i];
      if (!okx) { log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): OK (no RugCheck data)`); return true; } // API miss → keep
      if (okx.honeypot) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — honeypot/rugged | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      if (s.maxBundlePct != null && okx.bundlePct > s.maxBundlePct) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — bundle ${okx.bundlePct}% > max ${s.maxBundlePct}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      if (isDevBlocked(okx.creator)) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0, 8)}): SKIP — creator blocked | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      t._okx = okx;
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): OK — bundle=${okx.bundlePct ?? "?"}%, insiders=${okx.graphInsiders ?? "?"}`);
      return true;
    });
    _s("screening", `RugCheck filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 5: Jupiter token safety filter (top10, bot holders, fees SOL) ───
  {
    const jupResults = await Promise.all(
      eligible.map(t => getJupiterTokenInfo(t.mint).catch(() => null))
    );
    const before = eligible.length;
    eligible = eligible.filter((t, i) => {
      const jup = jupResults[i];
      if (!jup) { log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): OK (no Jupiter data — API error)`); return true; }
      if (jup.notFound) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — not indexed by Jupiter (feesSOL unknown, treated as 0 < min ${s.minTokenFeesSol ?? 23})`);
        return false;
      }
      if (jup.top10Pct != null && jup.top10Pct > (s.maxTop10Pct ?? 20)) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — top10 ${jup.top10Pct}% > max ${s.maxTop10Pct ?? 20}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      if (jup.botHoldersPct != null && jup.botHoldersPct > (s.maxBotHoldersPct ?? 30)) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — bot holders ${jup.botHoldersPct}% > max ${s.maxBotHoldersPct ?? 30}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      // feesSOL: >$1M mcap → 80 SOL, ≤$1M mcap → 23 SOL
      const feeThreshold = (t.mcap > 1_000_000) ? 80 : (s.minTokenFeesSol ?? 23);
      if (jup.feesSOL != null && jup.feesSOL < feeThreshold) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — fees ${jup.feesSOL.toFixed(4)} SOL < min ${feeThreshold} SOL | mcap=${(t.mcap/1e6).toFixed(1)}M`);
        return false;
      }
      t._jup = jup;
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): OK — top10=${jup.top10Pct ?? "?"}%, bots=${jup.botHoldersPct ?? "?"}%, fees=${jup.feesSOL ?? "?"} SOL${t._source === "jupiter" ? " [rocket-scan]" : ""}`);
      return true;
    });
    _s("screening", `Jupiter filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
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
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — price ${distFromAth.toFixed(1)}% from ATH < min ${s.athFilterPct}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      t._ath = pr.ath;
      return true;
    });
    _s("screening", `ATH filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 6b: Pre-pool cap & ranking ─────────────────────────────────────
  // Birdeye rate limit = 60 RPM. Each analyzeSignal = 2 Birdeye calls
  // (OHLCV 1m + daily candles). Max candidates = floor(60 ÷ 2) = 30.
  // We cap at 10 to stay well within safe margin (only ~33% of limit).
  // Ranking by volume (_volH1) before expensive Meteora API calls = efficiency.
  // Pre-pool cap means we only fetch pools for the top N candidates.
  const maxTechAnalysis = s.maxTechnicalAnalysisCandidates ?? 10;
  const rankedEligible = [...eligible].sort((a, b) => (b._volH1 ?? 0) - (a._volH1 ?? 0));
  const preCapCount = eligible.length;
  const topCandidates = rankedEligible.slice(0, maxTechAnalysis);
  if (preCapCount > maxTechAnalysis) {
    for (const t of rankedEligible.slice(maxTechAnalysis)) {
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — pre-pool cap rank ${rankedEligible.indexOf(t) + 1} > ${maxTechAnalysis} | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"} | mcap=${t.mcap ? "$" + Math.round(t.mcap) : "?"}`);
    }
    log.screening(`Pre-pool cap: top ${maxTechAnalysis} by volume selected from ${preCapCount} passing filters — Meteora/RocketScan calls now limited to ${maxTechAnalysis}, Birdeye = ${maxTechAnalysis * 2} RPM`);
  }
  const eligibleForPoolMatch = topCandidates; // rename for clarity in pool matching step

  // ── Step 7: Find Meteora DLMM pool — only for top N candidates ──────────
  // Fetch all qualifying pools in one bulk request, then match by token mint.
  // Only top N tokens are matched (efficiency: skip pool lookup for low-volume tokens).
  log("screening", `Finding Meteora DLMM pools for ${eligibleForPoolMatch.length} top candidates (pre-capped from ${eligible.length})...`);
  const meteoraPoolMap = await fetchMeteoraDlmmPoolMap();
  log("screening", `Meteora pool universe: ${meteoraPoolMap.size} qualifying pools fetched`);

  // ── Step 7b: RocketScan fallback — only for top N tokens not in Meteora ──
  // pool-discovery-api butuh waktu untuk mengindex pool baru.
  // RocketScan mendeteksi pool on-chain, lebih cepat untuk pool baru.
  const missingTokens = eligibleForPoolMatch.filter(t => !meteoraPoolMap.has(t.mint));
  log("screening", `Pool match: ${eligibleForPoolMatch.length - missingTokens.length}/${eligibleForPoolMatch.length} found in Meteora → ${missingTokens.length} checking RocketScan...`);
  if (missingTokens.length > 0) {
    const fallbacks = await fetchRocketScanFallback(missingTokens, s);
    for (const { token, pool } of fallbacks) {
      meteoraPoolMap.set(token.mint, pool);
      log("screening", `Found pool in RocketScan: ${token.symbol} → ${pool.pool.slice(0, 8)}... (bin_step=${pool.bin_step})`);
    }
    if (fallbacks.length > 0) {
      log("screening", `RocketScan fallback: ${fallbacks.length}/${missingTokens.length} token(s) received pool`);
    } else if (missingTokens.length > 0) {
      log("screening", `RocketScan fallback: no pools found for ${missingTokens.length} token(s) — skipping`);
    }
  }

  const withPool = eligibleForPoolMatch
    .map(t => ({ token: t, pool: meteoraPoolMap.get(t.mint) ?? null }))
    .filter(({ token, pool }) => {
      if (!pool) {
        log("screening", `  ${token.symbol}: NO POOL — not found in Meteora or RocketScan`);
        return false;
      }
      return true;
    });

  _s("screening", `Step 7 — Meteora pool match: ${withPool.length}/${eligibleForPoolMatch.length} top candidates have pools`);

  if (withPool.length === 0) {
    return { candidates: [], total_screened: allTokens.length, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 8: Fibonacci analysis ──────────────────────────────────────────
  // Birdeye OHLCV called ONLY for the capped top N candidates.
  // Meteora pool bin_step for bin range calculation.
  // Birdeye 60 RPM ÷ 2 calls = 30 candidates max. We use 10 (~33% capacity).

  // Filter out pools cached as "broken support" — price far below Fib 0.618, no recovery expected soon
  // All price values are stored in USD (token.price from Dexscreener) to match OHLCV candle units.
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
        log("screening", `  ${pool.name}: broken support cache INVALIDATED — price $${usdPrice.toPrecision(4)} reclaimed above fib swing high $${cached.athAtRejection.toPrecision(4)}, re-analyzing`);
        return true;
      }
      const hrsLeft = (FIB_BROKEN_CACHE_MS - (now - cached.cachedAt)) / 3_600_000;
      log("screening", `  ${pool.name}: SKIP — broken support cached, recheck in ${hrsLeft < 1 ? `${Math.ceil(hrsLeft * 60)}m` : `${hrsLeft.toFixed(1)}h`}`);
      return false;
    }
    return true;
  });
  _s("screening", `Running Fibonacci analysis on ${toAnalyze.length} pools (pre-pool capped from ${maxTechAnalysis} top by volume)...`);

  const signalResults = await Promise.allSettled(
    toAnalyze.map(async ({ token, pool }) => {
      // MUST use USD price — OHLCV candles are in USD.
      // pool.price is Meteora SOL-denominated; using it against USD Fib levels causes unit mismatch.
      let currentPrice = token.price; // no fallback to pool.price (SOL-denominated)
      const binStep    = pool.bin_step;
      if (!binStep) {
        return { signal: "SKIP", reason: "Missing bin_step" };
      }
      // If Dexscreener discovery didn't provide USD price, try full fallback chain
      if (!currentPrice) {
        try {
          const reliable = await hybridDataProvider.getReliableUSDPrice(token.mint, pool.pool);
          currentPrice = reliable?.price ?? null;
          if (!currentPrice) {
            return { signal: "SKIP", reason: "Missing USD price — ALL price sources failed" };
          }
          log.screening(`  ${pool.name}: getReliableUSDPrice=${{ price: currentPrice, source: reliable.source }}`);
        } catch { /* non-fatal */ }
      }
      return analyzeSignal(token.mint, binStep, currentPrice, s.candleLimit ?? 50, { rsiMin: s.rsiMin ?? null }, pool.pool);
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
      volume_h1: token._volH1 ?? null,
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

  // ── Step 9: Smart wallet activity check (DISABLED — LP API free tier rate limited)
  // if (candidates.length > 0) {
  //   try {
  //     const poolAddresses = candidates.map(c => c.pool);
  //     const smartMoneyMap = await checkSmartWalletActivity(poolAddresses);
  //     if (smartMoneyMap.size > 0) {
  //       for (const c of candidates) {
  //         const walletLabels = smartMoneyMap.get(c.pool);
  //         if (walletLabels?.length > 0) {
  //           c.smart_money = { present: true, wallets: walletLabels };
  //           c.fib_signal.confluenceScore = Math.min(
  //             1,
  //             Math.round((c.fib_signal.confluenceScore + 0.10) * 100) / 100
  //           );
  //           log("screening", `  ${c.name}: SMART MONEY ✓ (${walletLabels.join(", ")}) — score boosted`);
  //         } else {
  //           c.smart_money = { present: false, wallets: [] };
  //         }
  //       }
  //     }
  //   } catch (e) {
  //     _s("screening", `Smart wallet check failed (non-fatal): ${e.message}`);
  //   }
  // }

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

  // ── ATH-based deploy cooldown ─────────────────────────────────────────────
  const beforeCooldown = filtered.length;
  const cooldownFiltered = filtered.filter(c => {
    const addr = c.pool || c.poolAddress;
    const price = c.price || c.fib_signal?.currentPrice;
    if (!addr || !price) return true;
    if (isPoolOnATHCooldown(addr, price)) {
      log("screening", `  ${c.name}: SKIP — TP/SL close, no new ATH since close`);
      return false;
    }
    return true;
  });
  _s("screening", `ATH cooldown: ${cooldownFiltered.length}/${beforeCooldown} passed (TP/SL closes without new ATH filtered)`);

  _s("screening", `Step 8 — Fibonacci: ${cooldownFiltered.length}/${withPool.length} passed broken-support → ${candidates.length} ENTRY`);
  _s("screening", `Summary: discovered=${allTokens.length} (dex=${dexTokens.length}+rocket=${rocketTokens.length}) → volume=${afterVolumeCount} → eligible=${eligible.length} → prePoolCap=${maxTechAnalysis} → pools=${withPool.length} → fib_entry=${filtered.length}`);

  return {
    candidates:        cooldownFiltered,
    total_screened:    allTokens.length,
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
