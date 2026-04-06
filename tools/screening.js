/**
 * screening.js — Token-first discovery + Fibonacci signal filter
 *
 * Flow (v2 — GeckoTerminal-first):
 * 1. Discover trending Solana tokens from GeckoTerminal (all DEXes, not just Meteora trending)
 * 2. Filter by 5m cross-DEX volume (Dexscreener)
 * 3. Safety checks: OKX bundle/honeypot + Jupiter top10/botHolders/feesSOL
 * 4. Find Meteora DLMM pool for each candidate (TVL, fee/TVL, bin_step, organic, holders)
 * 5. Fibonacci analysis using GeckoTerminal candles + Meteora pool bin_step
 * 6. Smart wallet boost
 * 7. Sort by confluenceScore, return
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { analyzeSignal } from "./chart.js";
import { getTokenAdvancedInfo, getTokenPriceInfo } from "./okx.js";
import { batchGetTokenVolumeH1, getJupiterTokenInfo } from "./token.js";
import { checkSmartWalletActivity } from "../smart-wallets.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

// Cache pools rejected with "broken support" — price well below Fib 0.618, skip re-analysis for 45 min
const _fibBrokenSupportCache = new Map(); // poolAddress → timestamp
const FIB_BROKEN_CACHE_MS = 3 * 60 * 60 * 1000; // 3 jam — dead tokens tidak recover dalam 45 menit

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
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
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
//  Discovery: GeckoTerminal trending Solana pools (all DEXes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover trending tokens on Solana from GeckoTerminal.
 * Fetches `pages` pages of trending pools (each page ~20 pools).
 * Returns unique base tokens with their GT pool address for later OHLCV fetch.
 */
async function discoverTokensFromGecko({ pages = 2 } = {}) {
  const seen = new Set();
  const tokens = [];

  for (let page = 1; page <= pages; page++) {
    try {
      const url = `${GECKO_BASE}/networks/solana/trending_pools?page=${page}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log("screening", `GeckoTerminal page ${page} error: HTTP ${res.status}`);
        break;
      }

      const data = await res.json();
      for (const p of (data?.data ?? [])) {
        const baseId  = p.relationships?.base_token?.data?.id ?? "";
        const mint    = baseId.replace(/^solana_/, "");
        // skip if the ID had no "solana_" prefix (i.e., not a Solana token)
        if (!mint || mint === baseId) continue;
        if (seen.has(mint)) continue;
        seen.add(mint);

        const poolId = (p.id ?? "").replace(/^solana_/, "");
        const attrs  = p.attributes ?? {};

        tokens.push({
          mint,
          geckoPoolAddress: poolId,
          symbol: (attrs.name ?? "UNKNOWN").split(" / ")[0],
          price:  parseFloat(attrs.base_token_price_usd) || null,
          mcap:   parseFloat(attrs.market_cap_usd ?? attrs.fdv_usd) || null,
        });
      }
    } catch (e) {
      log("screening", `GeckoTerminal page ${page} failed: ${e.message}`);
      break;
    }
  }

  log("screening", `GeckoTerminal discovery: ${tokens.length} unique tokens across ${pages} pages`);
  return tokens;
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
  const geckoTokens = await discoverTokensFromGecko({ pages: 2 });

  // Exclude pools/mints where wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));

  let eligible = geckoTokens.filter(t => {
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
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
  }

  // ── Step 2: 1h volume filter (Dexscreener — cross-DEX accurate) ──────────
  {
    const mints  = eligible.map(t => t.mint).filter(Boolean);
    const volMap = await batchGetTokenVolumeH1(mints).catch(() => new Map());
    const before = eligible.length;
    eligible = eligible.filter(t => {
      const volH1 = volMap.get(t.mint);
      if (volH1 == null) return true; // API miss → keep
      if (volH1 < s.minVolume) {
        log("screening", `  ${t.symbol}: SKIP — 1h vol $${Math.round(volH1)} < min $${s.minVolume}`);
        return false;
      }
      t._vol5m = Math.round(volH1); // keep field name for downstream compatibility
      return true;
    });
    log("screening", `Volume filter: ${eligible.length}/${before} passed (min 1h vol $${s.minVolume})`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
  }

  // ── Step 3: mcap pre-filter from GeckoTerminal data (when available) ─────
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

  if (eligible.length === 0) {
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
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
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
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
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
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
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
  }

  // ── Step 7: Find Meteora DLMM pool for each passing token ────────────────
  // Fetch all qualifying pools in one bulk request, then match by token mint.
  log("screening", `Finding Meteora DLMM pools for ${eligible.length} tokens...`);
  const meteoraPoolMap = await fetchMeteoraDlmmPoolMap();
  log("screening", `Meteora pool universe: ${meteoraPoolMap.size} qualifying pools fetched`);

  const withPool = eligible
    .map(t => ({ token: t, pool: meteoraPoolMap.get(t.mint) ?? null }))
    .filter(({ token, pool }) => {
      if (!pool) {
        log("screening", `  ${token.symbol}: NO POOL — not in Meteora qualifying pool list`);
        return false;
      }
      return true;
    });

  log("screening", `Meteora pool filter: ${withPool.length}/${eligible.length} tokens have qualifying pools`);

  if (withPool.length === 0) {
    return { candidates: [], total_screened: geckoTokens.length, fib_analyzed: 0 };
  }

  // ── Step 8: Fibonacci analysis ───────────────────────────────────────────
  // Use the GeckoTerminal pool for candles (guaranteed indexed since found in GT trending),
  // but use Meteora pool's bin_step and price for accurate bin range calculation.

  // Filter out pools cached as "broken support" — price far below Fib 0.618, no recovery expected soon
  const now = Date.now();
  const toAnalyze = withPool.filter(({ pool }) => {
    // Skip pools that are actively crashing (>80% price drop in 24h) — not an entry signal
    if (pool.price_change_pct != null && pool.price_change_pct <= -80) {
      log("screening", `  ${pool.name}: SKIP — price crashed ${pool.price_change_pct.toFixed(1)}% in 24h`);
      _fibBrokenSupportCache.set(pool.pool, now); // cache as broken, recheck in 3h
      return false;
    }
    // Skip pools cached as "broken support"
    const cachedAt = _fibBrokenSupportCache.get(pool.pool);
    if (cachedAt && now - cachedAt < FIB_BROKEN_CACHE_MS) {
      const hrsLeft = (FIB_BROKEN_CACHE_MS - (now - cachedAt)) / 3_600_000;
      log("screening", `  ${pool.name}: SKIP — broken support cached, recheck in ${hrsLeft < 1 ? `${Math.ceil(hrsLeft * 60)}m` : `${hrsLeft.toFixed(1)}h`}`);
      return false;
    }
    return true;
  });
  log("screening", `Running Fibonacci analysis on ${toAnalyze.length} pools...`);

  const signalResults = await Promise.allSettled(
    toAnalyze.map(({ token, pool }) => {
      const currentPrice = pool.price ?? token.price;
      const binStep      = pool.bin_step;
      if (!currentPrice || !binStep) {
        return Promise.resolve({ signal: "SKIP", reason: "Missing price or bin_step" });
      }
      // GeckoTerminal pool from discovery (may be any DEX) used for OHLCV candles.
      // Meteora pool address used as fallback if geckoPoolAddress is unavailable.
      const gtPool = token.geckoPoolAddress || pool.pool;
      return analyzeSignal(gtPool, binStep, currentPrice, s.candleLimit ?? 50, { rsiMin: s.rsiMin ?? 48 });
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

    // Cache pools rejected for broken support — price already below Fib 0.618
    if (analysis.signal !== "ENTRY" && analysis.reason?.includes("broken support")) {
      _fibBrokenSupportCache.set(pool.pool, now);
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
        poc: analysis.volumeProfile?.poc ?? null,
        vah: analysis.volumeProfile?.vah ?? null,
        val: analysis.volumeProfile?.val ?? null,
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

  log("screening", `Fibonacci filter: ${filtered.length}/${withPool.length} pools passed${minConf > 0 && filtered.length < beforeConf ? ` (${beforeConf - filtered.length} below minConfluenceScore ${minConf})` : ""}`);

  return {
    candidates: filtered,
    total_screened: geckoTokens.length,
    fib_analyzed:   toAnalyze.length,
    fib_passed:     candidates.length,
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
