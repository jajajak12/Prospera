/**
 * screening.js — Meteora pool discovery + Fibonacci signal filter
 *
 * Fetches top pools from Meteora Pool Discovery API,
 * then runs Fibonacci + Volume Profile analysis on each candidate.
 * Only pools with ENTRY signal are returned.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { analyzeSignal } from "./chart.js";
import { getTokenAdvancedInfo, getTokenPriceInfo } from "./okx.js";
import { checkSmartWalletActivity } from "../smart-wallets.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

/**
 * Fetch raw pools from the Meteora Pool Discovery API with Fibonacci-appropriate filters.
 */
async function discoverPools({ page_size = 50 } = {}) {
  const s = config.screening;

  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `fee>=${s.minFee ?? 25}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    s.minTokenAgeHours != null ? `base_token_age_hours>=${s.minTokenAgeHours}` : null,
    s.maxTokenAgeHours != null ? `base_token_age_hours<=${s.maxTokenAgeHours}` : null,
  ].filter(Boolean).join("&&");

  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=trending`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return { pools: (data.data || []).map(condensePool), total: data.total };
}

/**
 * Condense a raw pool object for LLM consumption.
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
    active_tvl:          round(p.active_tvl),
    fee_window:          round(p.fee),
    volume_window:       round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility:         fix(p.volatility, 2),

    // Token health
    holders:            p.base_token_holders,
    mcap:               round(p.token_x?.market_cap),
    organic_score:      Math.round(p.token_x?.organic_score || 0),
    token_age_hours:    p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,

    // Price action
    price:              p.pool_price,
    price_change_pct:   fix(p.pool_price_change_pct, 1),
    price_trend:        p.price_trend,
    min_price:          p.min_price,
    max_price:          p.max_price,

    // Activity
    volume_change_pct:  fix(p.volume_change_pct, 1),
    swap_count:         p.swap_count,
    unique_traders:     p.unique_traders,
    active_positions:   p.active_positions,
    active_pct:         fix(p.active_positions_pct, 1),
  };
}

function round(n) { return n != null ? Math.round(n) : null; }
function fix(n, d) { return n != null ? Number(n.toFixed(d)) : null; }

/**
 * Get top candidates with Fibonacci + Volume Profile signal filter applied.
 * Runs chart analysis in parallel for all candidates.
 * Returns only pools with signal === "ENTRY", sorted by confluenceScore descending.
 *
 * @param {object} opts
 * @param {number} opts.limit - Max pools to scan (default 20)
 */
export async function getTopCandidates({ limit = 20 } = {}) {
  // Fetch pool list
  const { pools } = await discoverPools({ page_size: Math.max(limit, 50) });

  // Exclude pools where wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map(p => p.pool));
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter(p => !occupiedPools.has(p.pool) && !occupiedMints.has(p.base?.mint))
    .filter(p => {
      // Token blacklist
      if (isBlacklisted(p.base?.mint)) {
        log("screening", `  ${p.name}: SKIP — token blacklisted`);
        return false;
      }
      // Dev blocklist (deployer field from pool data)
      if (isDevBlocked(p.base?.deployer)) {
        log("screening", `  ${p.name}: SKIP — dev blocked`);
        return false;
      }
      return true;
    })
    .slice(0, limit);

  if (eligible.length === 0) {
    return { candidates: [], total_screened: pools.length, fib_analyzed: 0 };
  }


  if (eligible.length === 0) {
    return { candidates: [], total_screened: pools.length, fib_analyzed: 0 };
  }

  // ── OKX bundle / honeypot / dev filter ───────────────────────────────────
  const maxBundlePct = config.screening.maxBundlePct;
  {
    const okxResults = await Promise.all(
      eligible.map(p => getTokenAdvancedInfo(p.base?.mint))
    );
    const before = eligible.length;
    eligible.splice(0, eligible.length,
      ...eligible.filter((p, i) => {
        const okx = okxResults[i];
        if (!okx) return true; // API miss → don't filter out
        if (okx.honeypot) {
          log("screening", `  ${p.name}: SKIP — honeypot`);
          return false;
        }
        if (maxBundlePct != null && okx.bundlePct > maxBundlePct) {
          log("screening", `  ${p.name}: SKIP — bundle ${okx.bundlePct}% > max ${maxBundlePct}%`);
          return false;
        }
        if (isDevBlocked(okx.creator)) {
          log("screening", `  ${p.name}: SKIP — creator blocked (OKX)`);
          return false;
        }
        p._okx = okx;
        return true;
      })
    );
    log("screening", `OKX filter: ${eligible.length}/${before} pools passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: pools.length, fib_analyzed: 0 };
  }

  // ── ATH proximity filter ─────────────────────────────────────────────────
  const athFilterPct = config.screening.athFilterPct;
  if (athFilterPct != null) {
    const priceResults = await Promise.all(
      eligible.map(p => getTokenPriceInfo(p.base?.mint))
    );
    const before = eligible.length;
    eligible.splice(0, eligible.length,
      ...eligible.filter((p, i) => {
        const pr = priceResults[i];
        if (!pr?.ath || !pr?.currentPrice) return true;
        const distFromAth = (pr.ath - pr.currentPrice) / pr.ath * 100;
        if (distFromAth < athFilterPct) {
          log("screening", `  ${p.name}: SKIP — price ${distFromAth.toFixed(1)}% from ATH (min ${athFilterPct}%)`);
          return false;
        }
        p._ath = pr.ath;
        return true;
      })
    );
    log("screening", `ATH filter: ${eligible.length}/${before} pools passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: pools.length, fib_analyzed: 0 };
  }

  log("screening", `Running Fibonacci analysis on ${eligible.length} pools...`);

  // Run chart analysis in parallel
  const signalResults = await Promise.allSettled(
    eligible.map(pool => {
      const currentPrice = pool.price;
      const binStep = pool.bin_step;
      if (!currentPrice || !binStep) {
        return Promise.resolve({
          signal: "SKIP",
          reason: "Missing price or bin_step",
          fibLevels: null,
          volumeProfile: null,
          binsBelow: 35,
          currentPrice,
        });
      }
      return analyzeSignal(
        pool.pool,
        binStep,
        currentPrice,
        config.screening.candleLimit ?? 50
      );
    })
  );

  // Filter to ENTRY signals only
  const candidates = [];
  for (let i = 0; i < eligible.length; i++) {
    const pool = eligible[i];
    const result = signalResults[i];
    const analysis = result.status === "fulfilled"
      ? result.value
      : { signal: "SKIP", reason: `Analysis failed: ${result.reason?.message || result.reason}` };

    log("screening", `  ${pool.name}: ${analysis.signal} — ${analysis.reason}`);

    if (analysis.signal !== "ENTRY") continue;

    candidates.push({
      ...pool,
      ath:              pool._ath            ?? null,
      okx:              pool._okx            ?? null,
      fib_signal: {
        signal:             analysis.signal,
        reason:             analysis.reason,
        binsBelow:          analysis.binsBelow,
        binsAbove:          analysis.binsAbove ?? 0,
        currentPrice:       analysis.currentPrice,
        confluenceScore:    analysis.confluenceScore ?? 0,
        pricePosition:      analysis.pricePosition ?? null,
        inPrimaryZone:      analysis.inPrimaryZone ?? false,
        inAthZone:          analysis.inAthZone ?? false,
        hasHiddenDivergence: analysis.hasHiddenDivergence ?? false,
        rsi:                analysis.rsi ?? null,
        rsiSlope:           analysis.rsiSlope ?? null,
        atrPct:             analysis.atrPct ?? null,
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

  // ── Smart wallet activity check ──────────────────────────────────────────────
  if (candidates.length > 0) {
    try {
      const poolAddresses = candidates.map(c => c.pool);
      const smartMoneyMap = await checkSmartWalletActivity(poolAddresses);
      if (smartMoneyMap.size > 0) {
        for (const c of candidates) {
          const walletLabels = smartMoneyMap.get(c.pool);
          if (walletLabels && walletLabels.length > 0) {
            c.smart_money = { present: true, wallets: walletLabels };
            // Boost confluence score by +0.10 for smart money presence
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

  // Sort by confluence score descending (best signal first)
  candidates.sort((a, b) => (b.fib_signal.confluenceScore ?? 0) - (a.fib_signal.confluenceScore ?? 0));

  log("screening", `Fibonacci filter: ${candidates.length}/${eligible.length} pools passed`);

  return {
    candidates,
    total_screened: pools.length,
    fib_analyzed: eligible.length,
    fib_passed: candidates.length,
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
