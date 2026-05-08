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
import { appendScreeningSignalSnapshot, buildScreeningSignalSnapshot } from "./screeningDiagnostics.js";
import { getTokenAdvancedInfo, getTokenPriceInfo } from "./okx.js";
import { batchGetTokenVolumeH1, getJupiterTokenInfo } from "./token.js";
import { isPoolOnATHCooldown } from "../pool-memory.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEXSCREENER_BASE  = "https://api.dexscreener.com";
const GECKO_BASE        = "https://api.geckoterminal.com/api/v2";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const DLMM_API_BASE = "https://dlmm.datapi.meteora.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STATE_DIR = path.join(__dirname, "..", "state");
const FAST_PENDING_POOLS_PATH = path.join(STATE_DIR, "fast-pending-pools.json");

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

// ─── Keyword blacklist (charity/scam type tokens) ─────────────────────────────
const TOKEN_TYPE_BLACKLIST_PATH = path.join(__dirname, "..", "token-type-blacklist.json");
let _keywordCache = { mtime: 0, keywords: [] };

function getKeywordBlacklist() {
  try {
    if (!fs.existsSync(TOKEN_TYPE_BLACKLIST_PATH)) return _keywordCache.keywords;
    const { mtimeMs } = fs.statSync(TOKEN_TYPE_BLACKLIST_PATH);
    if (mtimeMs !== _keywordCache.mtime) {
      _keywordCache.mtime = mtimeMs;
      _keywordCache.keywords = JSON.parse(fs.readFileSync(TOKEN_TYPE_BLACKLIST_PATH, "utf8"));
    }
  } catch { /* non-fatal */ }
  return _keywordCache.keywords;
}

function matchedKeyword(name, symbol) {
  const haystack = `${name ?? ""} ${symbol ?? ""}`.toLowerCase();
  return getKeywordBlacklist().find(kw => haystack.includes(kw.toLowerCase())) ?? null;
}

function isDevBlocked(devAddress) {
  if (!devAddress) return false;
  return _devBlockCache().has(devAddress);
}

/**
 * Condense a raw Meteora pool object for LLM consumption.
 */
function condensePool(p) {
  const activeTvl = p.active_tvl ?? p.tvl ?? null;
  const feeWindow = typeof p.fee === "number"
    ? p.fee
    : (p.fees?.["24h"] ?? p.fees?.["1h"] ?? null);
  const volumeWindow = typeof p.volume === "number"
    ? p.volume
    : (p.volume?.["24h"] ?? p.volume?.["1h"] ?? null);
  const feeActiveTvlRatio = p.fee_active_tvl_ratio > 0
    ? p.fee_active_tvl_ratio
    : (p.fee_tvl_ratio?.["24h"] ?? p.fee_tvl_ratio?.["1h"] ?? null);

  return {
    pool: p.pool_address ?? p.address,
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
    bin_step:   normalizeBinStep(p),
    fee_pct:    p.fee_pct ?? p.dynamic_fee_pct ?? p.pool_config?.base_fee_pct ?? null,

    // Core metrics
    active_tvl:           round(activeTvl),
    fee_window:           round(feeWindow),
    volume_window:        round(volumeWindow),
    fee_active_tvl_ratio: feeActiveTvlRatio > 0
      ? fix(feeActiveTvlRatio, 4)
      : (activeTvl > 0 && feeWindow != null ? fix((feeWindow / activeTvl) * 100, 4) : 0),
    volatility:          fix(p.volatility, 2),

    // Token health
    holders:           p.base_token_holders ?? p.token_x?.holders,
    mcap:              round(p.token_x?.market_cap),
    organic_score:     Math.round(p.token_x?.organic_score || 0),
    token_age_hours:   ageHoursFrom(p.token_x?.created_at ?? p.created_at),

    // Price action
    price:             p.pool_price ?? p.current_price ?? p.token_x?.price ?? null,
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
    _source: "meteora_bulk",
  };
}

function round(n) { return n != null ? Math.round(n) : null; }
function fix(n, d) { return n != null ? Number(n.toFixed(d)) : null; }
function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function toFiniteInteger(value) {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return null;
  const rounded = Math.round(parsed);
  return Number.isFinite(rounded) ? rounded : null;
}
function normalizeBinStep(pool) {
  const candidates = [
    pool?.bin_step,
    pool?.binStep,
    pool?.binStepBps,
    pool?.bin_step_bps,
    pool?.dlmm_params?.bin_step,
    pool?.pool_config?.bin_step,
    pool?.poolConfig?.bin_step,
    pool?.poolConfig?.binStep,
    pool?.config?.bin_step,
    pool?.config?.binStep,
    pool?.parameters?.bin_step,
    pool?.poolData?.binStep,
    pool?.poolData?.bin_step,
  ];
  for (const candidate of candidates) {
    const step = toFiniteInteger(candidate);
    if (step != null && step > 0) return step;
  }
  return null;
}
function collectBinStepHints(pool) {
  return {
    bin_step: pool?.bin_step ?? null,
    binStep: pool?.binStep ?? null,
    binStepBps: pool?.binStepBps ?? null,
    bin_step_bps: pool?.bin_step_bps ?? null,
    dlmm_params_bin_step: pool?.dlmm_params?.bin_step ?? null,
    pool_config_bin_step: pool?.pool_config?.bin_step ?? null,
    poolConfig_bin_step: pool?.poolConfig?.bin_step ?? null,
    poolConfig_binStep: pool?.poolConfig?.binStep ?? null,
    config_bin_step: pool?.config?.bin_step ?? null,
    config_binStep: pool?.config?.binStep ?? null,
    parameters_bin_step: pool?.parameters?.bin_step ?? null,
    poolData_binStep: pool?.poolData?.binStep ?? null,
    poolData_bin_step: pool?.poolData?.bin_step ?? null,
  };
}
function mergeDefined(baseValue, incomingValue) {
  return incomingValue != null ? incomingValue : baseValue;
}
function mergePoolRecords(basePool, incomingPool) {
  if (!basePool) return incomingPool;
  if (!incomingPool) return basePool;

  const incomingResolvedBinStep = normalizeBinStep(incomingPool);
  const baseResolvedBinStep = normalizeBinStep(basePool);
  const merged = {
    ...basePool,
    ...incomingPool,
    base: {
      ...(basePool.base ?? {}),
      ...(incomingPool.base ?? {}),
    },
    quote: {
      ...(basePool.quote ?? {}),
      ...(incomingPool.quote ?? {}),
    },
  };

  merged.pool = mergeDefined(basePool.pool, incomingPool.pool);
  merged.name = mergeDefined(basePool.name, incomingPool.name);
  merged.bin_step = mergeDefined(baseResolvedBinStep, incomingResolvedBinStep);
  merged.fee_pct = mergeDefined(basePool.fee_pct, incomingPool.fee_pct);
  merged.active_tvl = mergeDefined(basePool.active_tvl, incomingPool.active_tvl);
  merged.fee_window = mergeDefined(basePool.fee_window, incomingPool.fee_window);
  merged.volume_window = mergeDefined(basePool.volume_window, incomingPool.volume_window);
  merged.fee_active_tvl_ratio = mergeDefined(basePool.fee_active_tvl_ratio, incomingPool.fee_active_tvl_ratio);
  merged.volatility = mergeDefined(basePool.volatility, incomingPool.volatility);
  merged.holders = mergeDefined(basePool.holders, incomingPool.holders);
  merged.mcap = mergeDefined(basePool.mcap, incomingPool.mcap);
  merged.organic_score = mergeDefined(basePool.organic_score, incomingPool.organic_score);
  merged.token_age_hours = mergeDefined(basePool.token_age_hours, incomingPool.token_age_hours);
  merged.price = mergeDefined(basePool.price, incomingPool.price);
  merged.price_change_pct = mergeDefined(basePool.price_change_pct, incomingPool.price_change_pct);
  merged.price_trend = mergeDefined(basePool.price_trend, incomingPool.price_trend);
  merged.created_at = mergeDefined(basePool.created_at, incomingPool.created_at);

  const sourceSet = new Set([
    ...(Array.isArray(basePool._sources) ? basePool._sources : (basePool._source ? [basePool._source] : [])),
    ...(Array.isArray(incomingPool._sources) ? incomingPool._sources : (incomingPool._source ? [incomingPool._source] : [])),
  ]);
  merged._sources = [...sourceSet];
  merged._source = incomingResolvedBinStep != null && baseResolvedBinStep == null
    ? (incomingPool._source ?? basePool._source ?? "unknown")
    : (basePool._source ?? incomingPool._source ?? "unknown");

  return merged;
}
function asTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsedNum = Number(value);
    if (Number.isFinite(parsedNum) && value.trim() !== "") {
      return parsedNum < 1e12 ? parsedNum * 1000 : parsedNum;
    }
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) ? parsedDate : null;
  }
  return null;
}
function ageHoursFrom(value) {
  const ts = asTimestampMs(value);
  return ts != null ? (Date.now() - ts) / 3_600_000 : null;
}
function poolQualityTuple(pool) {
  return [
    pool.active_tvl ?? 0,
    pool.volume_window ?? 0,
    pool.fee_active_tvl_ratio ?? 0,
    pool.holders ?? 0,
  ];
}
function isPoolBetter(candidate, incumbent) {
  if (!incumbent) return true;
  const a = poolQualityTuple(candidate);
  const b = poolQualityTuple(incumbent);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function getPreferredBinStepRange(screeningCfg = config.screening ?? {}) {
  return {
    min: screeningCfg.preferredBinStepMin ?? screeningCfg.minBinStep ?? 80,
    max: screeningCfg.preferredBinStepMax ?? screeningCfg.maxBinStep ?? 200,
  };
}

function getConditionalBinStepSet(screeningCfg = config.screening ?? {}) {
  return new Set((screeningCfg.conditionalBinSteps ?? []).map(Number).filter(Number.isFinite));
}

function getBinStepPolicy(binStep, screeningCfg = config.screening ?? {}) {
  const { min, max } = getPreferredBinStepRange(screeningCfg);
  if (binStep != null && binStep >= min && binStep <= max) return "preferred";
  if (
    screeningCfg.allowBinStep50IfRangeCoverageOk !== false &&
    getConditionalBinStepSet(screeningCfg).has(Number(binStep))
  ) {
    return "conditional";
  }
  return "rejected";
}
function getFastPoolRecheckConfig() {
  const s = config.screening ?? {};
  const intervalSeconds = Math.max(10, s.fastPoolRecheckIntervalSeconds ?? 15);
  const ttlMinutes = Math.max(30, s.fastPoolRecheckTtlMinutes ?? 120);
  const maxCandidates = Math.max(1, s.fastPoolRecheckMaxCandidates ?? 30);
  return {
    enabled: s.fastPoolRecheckEnabled !== false,
    intervalSeconds,
    intervalMs: intervalSeconds * 1000,
    ttlMinutes,
    ttlMs: ttlMinutes * 60_000,
    maxCandidates,
    useMeteoraDirect: s.fastPoolRecheckUseMeteoraDirect !== false,
  };
}
function loadPendingPoolCandidates() {
  try {
    if (!fs.existsSync(FAST_PENDING_POOLS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(FAST_PENDING_POOLS_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function savePendingPoolCandidates(store) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(FAST_PENDING_POOLS_PATH, JSON.stringify(store, null, 2));
  } catch { /* non-fatal */ }
}
function pendingCandidateToToken(entry) {
  return {
    mint: entry.mint,
    symbol: entry.symbol ?? "UNKNOWN",
    name: entry.name ?? entry.symbol ?? "UNKNOWN",
    price: null,
    mcap: entry.mcap ?? null,
    _volH1: entry.volume1h ?? null,
    _pendingPoolWatch: true,
    _pendingPoolMeta: entry,
  };
}
function isPendingPoolReasonWatchable(reason) {
  return reason === "NO_POOL" ||
    reason === "NO_ELIGIBLE_DLMM_POOL" ||
    reason === "DLMM_POOL_BIN_STEP_OUT_OF_RANGE" ||
    reason === "ONLY_INVALID_BIN_STEP_POOLS_FOUND";
}
function updatePendingPoolCandidate(store, token, reason, extra = {}) {
  const fastCfg = getFastPoolRecheckConfig();
  const nowIso = new Date().toISOString();
  const existing = store[token.mint];
  const next = {
    mint: token.mint,
    symbol: token.symbol ?? existing?.symbol ?? "UNKNOWN",
    name: token.name ?? existing?.name ?? token.symbol ?? "UNKNOWN",
    firstSeenAt: existing?.firstSeenAt ?? nowIso,
    lastCheckedAt: nowIso,
    expiresAt: existing?.expiresAt ?? new Date(Date.now() + fastCfg.ttlMs).toISOString(),
    checkCount: (existing?.checkCount ?? 0) + 1,
    lastRejectReason: reason,
    marketCap: token.mcap ?? existing?.marketCap ?? existing?.mcap ?? null,
    mcap: token.mcap ?? existing?.marketCap ?? existing?.mcap ?? null,
    volume1h: token._volH1 ?? existing?.volume1h ?? null,
    liquidity: extra.liquidity ?? existing?.liquidity ?? null,
    holders: extra.holders ?? extra.holderCount ?? existing?.holders ?? existing?.holderCount ?? null,
    holderCount: extra.holders ?? extra.holderCount ?? existing?.holders ?? existing?.holderCount ?? null,
    invalidPools: extra.invalidPools ?? existing?.invalidPools ?? [],
    bestInvalidPool: extra.bestInvalidPool ?? existing?.bestInvalidPool ?? null,
    lastEligiblePool: extra.lastEligiblePool ?? existing?.lastEligiblePool ?? null,
    status: extra.status ?? existing?.status ?? "pending",
    readyForRescreen: extra.readyForRescreen ?? existing?.readyForRescreen ?? false,
  };
  store[token.mint] = next;
  return { entry: next, isNew: !existing };
}

function normalizeDirectSearchPool(p, fallbackToken = null) {
  const tokenXMint = p.mint_x ?? p.token_x?.address ?? null;
  const tokenYMint = p.mint_y ?? p.token_y?.address ?? null;
  return {
    pool: p.address ?? p.pool_address,
    name: p.name ?? `${p.mint_x_symbol ?? fallbackToken?.symbol ?? "UNKNOWN"}-${p.mint_y_symbol ?? "SOL"}`,
    base: {
      symbol: p.mint_x_symbol ?? p.token_x?.symbol ?? fallbackToken?.symbol ?? "UNKNOWN",
      mint: tokenXMint,
      organic: Math.round(p.token_x?.organic_score ?? 0),
      warnings: p.token_x?.warnings?.length ?? 0,
    },
    quote: {
      symbol: p.mint_y_symbol ?? p.token_y?.symbol ?? "SOL",
      mint: tokenYMint,
    },
    bin_step: normalizeBinStep(p),
    fee_pct: p.base_fee_percentage ?? p.fee_pct ?? p.pool_config?.base_fee_pct ?? null,
    active_tvl: p.liquidity ?? p.active_tvl ?? p.tvl ?? null,
    fee_window: p.fees_24h ?? null,
    volume_window: p.trade_volume_24h ?? p.trade_volume ?? null,
    fee_active_tvl_ratio: p.fee_active_tvl_ratio ?? null,
    volatility: p.volatility ?? null,
    holders: p.token_x?.holders ?? p.base_token_holders ?? 0,
    mcap: Math.round(p.token_x?.market_cap ?? p.base_token_market_cap ?? fallbackToken?.mcap ?? 0),
    organic_score: Math.round(p.token_x?.organic_score ?? 0),
    token_age_hours: ageHoursFrom(p.token_x?.created_at ?? p.created_at),
    price: p.current_price ?? p.pool_price ?? p.token_x?.price ?? null,
    price_change_pct: p.price_change_percent_24h ?? p.pool_price_change_pct ?? null,
    price_trend: Array.isArray(p.price_trend) ? p.price_trend : null,
    created_at: p.created_at ?? null,
    _source: "meteora_direct",
  };
}

function dedupePoolsByAddress(pools) {
  const byPool = new Map();
  for (const pool of pools) {
    const address = pool?.pool;
    if (!address) continue;
    const existing = byPool.get(address);
    byPool.set(address, mergePoolRecords(existing, pool));
  }
  return [...byPool.values()];
}

function classifyDlmmPools(token, pools, s) {
  const validPools = [];
  const invalidBinStepPools = [];
  const unresolvedMetadataPools = [];
  let bestPreferredEligiblePool = null;
  let bestConditionalEligiblePool = null;

  for (const pool of pools) {
    const binStep = normalizeBinStep(pool);
    pool.bin_step = binStep;
    if (binStep == null) {
      unresolvedMetadataPools.push(pool);
      log(
        "screening",
        `DLMM_POOL_METADATA_UNRESOLVED token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${pool._source ?? "unknown"} missing=bin_step hints=${JSON.stringify(collectBinStepHints(pool))}`
      );
      continue;
    }
    const policy = getBinStepPolicy(binStep, s);
    if (policy === "rejected") {
      invalidBinStepPools.push(pool);
      const preferred = getPreferredBinStepRange(s);
      const conditional = [...getConditionalBinStepSet(s)].join(",") || "none";
      log("screening", `DLMM_POOL_DISQUALIFIED_BIN_STEP token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} bin_step=${binStep ?? "null"} preferred=${preferred.min}-${preferred.max} conditional=${conditional} source=${pool._source ?? "unknown"}`);
      continue;
    }
    pool._binStepPolicy = policy;
    validPools.push(pool);
    if ((pool.active_tvl ?? 0) < (s.minTvl ?? 0)) continue;
    if (s.maxTvl != null && (pool.active_tvl ?? 0) > s.maxTvl) continue;
    if (pool.organic_score != null && pool.organic_score < (s.minOrganic ?? 0)) continue;
    if ((pool.holders ?? 0) < (s.minHolders ?? 0)) continue;
    if ((pool.mcap ?? 0) < (s.minMcap ?? 0)) continue;
    if (pool.token_age_hours != null && s.minTokenAgeHours != null && pool.token_age_hours < s.minTokenAgeHours) continue;
    if (pool.token_age_hours != null && s.maxTokenAgeHours != null && pool.token_age_hours > s.maxTokenAgeHours) continue;
    if (policy === "preferred") {
      if (isPoolBetter(pool, bestPreferredEligiblePool)) bestPreferredEligiblePool = pool;
    } else if (isPoolBetter(pool, bestConditionalEligiblePool)) {
      bestConditionalEligiblePool = pool;
    }
  }

  const bestEligiblePool = bestPreferredEligiblePool ?? bestConditionalEligiblePool;

  let rejectionReason = null;
  if (!bestEligiblePool) {
    if (pools.length === 0) rejectionReason = "NO_POOL";
    else if (validPools.length === 0 && unresolvedMetadataPools.length === 0) rejectionReason = invalidBinStepPools.length > 0
      ? "ONLY_INVALID_BIN_STEP_POOLS_FOUND"
      : "DLMM_POOL_BIN_STEP_OUT_OF_RANGE";
    else if (validPools.length === 0 && unresolvedMetadataPools.length > 0 && invalidBinStepPools.length === 0) rejectionReason = "DLMM_POOL_METADATA_UNRESOLVED";
    else rejectionReason = "NO_ELIGIBLE_DLMM_POOL";
  }

  const bestInvalidPool = invalidBinStepPools.reduce((best, pool) => isPoolBetter(pool, best) ? pool : best, null);
  return { pools, validPools, invalidBinStepPools, unresolvedMetadataPools, bestEligiblePool, bestInvalidPool, rejectionReason };
}

async function fetchDirectMeteoraPoolsForToken(token) {
  const res = await fetch(
    `${DLMM_API_BASE}/pools?query=${encodeURIComponent(token.mint)}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) throw new Error(`Meteora direct HTTP ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data) ? data : (data.data ?? []);
  return pools
    .map(pool => normalizeDirectSearchPool(pool, token))
    .filter(pool => pool.pool && pool.base?.mint === token.mint && (pool.quote?.mint === SOL_MINT || pool.quote?.symbol === "SOL"));
}

async function fetchDirectMeteoraPoolByAddress(poolAddress, token = null) {
  const res = await fetch(
    `${DLMM_API_BASE}/pools?query=${encodeURIComponent(poolAddress)}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) throw new Error(`Meteora direct detail HTTP ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data) ? data : (data.data ?? []);
  const match = pools.find(pool => (pool.address ?? pool.pool_address) === poolAddress);
  if (!match) return null;
  const normalized = normalizeDirectSearchPool(match, token);
  normalized._source = "meteora_direct_detail";
  return normalized;
}

async function fetchMeteoraPoolDetailByAddress(poolAddress, token = null) {
  const pdRes = await fetch(
    `${POOL_DISCOVERY_BASE}/pools?filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&page_size=1&timeframe=1h`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!pdRes.ok) throw new Error(`Meteora detail HTTP ${pdRes.status}`);
  const pdData = await pdRes.json();
  const dm = pdData.data?.find(pool => (pool.pool_address ?? pool.address) === poolAddress) ?? pdData.data?.[0] ?? null;
  if (!dm) return null;
  const normalized = normalizePoolDetail(dm, token);
  normalized._source = "meteora_detail";
  return normalized;
}

async function fetchRocketScanDetailedPoolsForToken(token) {
  const rsRes = await fetch(
    `${ROCKETSCAN_API}?tokenBMint=${token.mint}&poolType=DLMM`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!rsRes.ok) {
    log("screening", `  ${token.symbol}: RocketScan HTTP ${rsRes.status} for ${token.mint.slice(0, 8)}...`);
    return [];
  }
  const rsData = await rsRes.json();
  const rsPools = (rsData.data ?? []).filter(p => p.poolType === "DLMM");
  if (rsPools.length === 0) return [];

  const sortedRsPools = [...rsPools].sort((a, b) =>
    (b.poolData?.tvl ?? 0) - (a.poolData?.tvl ?? 0) ||
    (b.poolData?.volume24h ?? 0) - (a.poolData?.volume24h ?? 0)
  );

  const detailResults = await Promise.all(sortedRsPools.map(async (rsPool) => {
    const poolId = rsPool.poolId;
    if (!poolId) return null;
    const pdRes = await fetch(
      `${POOL_DISCOVERY_BASE}/pools?filter_by=${encodeURIComponent(`pool_address=${poolId}`)}&page_size=1&timeframe=1h`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!pdRes.ok) return null;
    const pdData = await pdRes.json();
    const dm = pdData.data?.[0];
    if (!dm || (dm.pool_address ?? dm.address) !== poolId) return null;
    const quoteSymbol = dm.token_y?.symbol ?? dm.token_y?.name ?? "";
    if (quoteSymbol !== "SOL" && dm.token_y?.address !== SOL_MINT) return null;
    const pool = normalizePoolDetail(dm, token);
    pool._source = "rocketscan";
    pool.organic_score = Math.round(dm.token_x?.organic_score ?? rsPool.tokenB?.organicScore ?? pool.organic_score ?? 0);
    pool.token_age_hours = ageHoursFrom(
      dm.token_x?.created_at ??
      dm.created_at ??
      rsPool.tokenB?.tokenCreatedAt ??
      rsPool.tokenB?.createdAt
    );
    pool.created_at = dm.created_at ?? null;
    return pool;
  }));

  return detailResults.filter(Boolean);
}

async function enrichPoolsWithMetadata(token, pools, { rocketPools = null } = {}) {
  const enriched = dedupePoolsByAddress(pools);
  const rocketPoolMap = new Map((rocketPools ?? []).filter(Boolean).map(pool => [pool.pool, pool]));

  for (let i = 0; i < enriched.length; i++) {
    let pool = enriched[i];
    pool.bin_step = normalizeBinStep(pool);
    if (pool.bin_step != null) continue;

    log("screening", `DLMM_POOL_METADATA_INCOMPLETE token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${pool._source ?? "unknown"} missing=bin_step`);

    const attempts = [
      {
        label: "meteora_direct_detail",
        run: () => fetchDirectMeteoraPoolByAddress(pool.pool, token),
      },
      {
        label: "meteora_detail",
        run: () => fetchMeteoraPoolDetailByAddress(pool.pool, token),
      },
      {
        label: "rocketscan_cached",
        run: async () => rocketPoolMap.get(pool.pool) ?? null,
      },
    ];

    for (const attempt of attempts) {
      try {
        log("screening", `DLMM_POOL_DETAIL_FETCH_ATTEMPT token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${attempt.label}`);
        const detailedPool = await attempt.run();
        if (!detailedPool) {
          log("screening", `DLMM_POOL_DETAIL_FETCH_FAILED token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${attempt.label} err=no_match`);
          continue;
        }
        pool = mergePoolRecords(pool, detailedPool);
        pool.bin_step = normalizeBinStep(pool);
        enriched[i] = pool;
        if (pool.bin_step != null) {
          log("screening", `DLMM_POOL_DETAIL_FETCH_SUCCESS token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${attempt.label} bin_step=${pool.bin_step}`);
          log("screening", `DLMM_POOL_METADATA_RESOLVED token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} bin_step=${pool.bin_step} source=${pool._source ?? attempt.label}`);
          break;
        }
        log("screening", `DLMM_POOL_DETAIL_FETCH_FAILED token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${attempt.label} err=bin_step_still_missing`);
      } catch (err) {
        log("screening", `DLMM_POOL_DETAIL_FETCH_FAILED token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} source=${attempt.label} err=${err.message?.slice(0, 120) ?? err}`);
      }
    }
  }

  return dedupePoolsByAddress(enriched);
}

async function discoverDlmmPoolsForToken(token, s, opts = {}) {
  const {
    seedPools = [],
    useMeteoraDirect = false,
    useRocketScan = true,
  } = opts;

  const collectedPools = [...seedPools];

  if (useMeteoraDirect) {
    try {
      const directPools = await fetchDirectMeteoraPoolsForToken(token);
      collectedPools.push(...directPools);
    } catch (e) {
      log("screening", `  ${token.symbol}: Meteora direct lookup error: ${e.message?.slice(0, 80) ?? e}`);
    }
  }

  if (useRocketScan) {
    try {
      const rocketPools = await fetchRocketScanDetailedPoolsForToken(token);
      collectedPools.push(...rocketPools);
      const enriched = await enrichPoolsWithMetadata(token, collectedPools, { rocketPools });
      return classifyDlmmPools(token, enriched, s);
    } catch (e) {
      log("screening", `  ${token.symbol}: RocketScan exception: ${e.message?.slice(0, 80) ?? e}`);
    }
  }

  const pools = await enrichPoolsWithMetadata(token, collectedPools, { rocketPools: [] });
  return classifyDlmmPools(token, pools, s);
}

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
      const pairAgeHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : null;
      if (!existing) {
        byMint.set(mint, {
          mint,
          symbol: pair.baseToken?.symbol ?? "UNKNOWN",
          price:  parseFloat(pair.priceUsd) || null,
          mcap:   parseFloat(pair.fdv ?? pair.marketCap) || null,
          _volH1: Math.round(volH1),
          _mcapAtDiscovery: parseFloat(pair.fdv ?? pair.marketCap) || null,
          token_age_hours: pairAgeHours,
        });
      } else {
        // Aggregate: sum h1 volume across ALL pools for this mint
        existing._volH1 += volH1;
        // Keep the oldest known pair (earliest listing = true token age)
        if (pairAgeHours != null && (existing.token_age_hours == null || pairAgeHours > existing.token_age_hours)) {
          existing.token_age_hours = pairAgeHours;
        }
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

function normalizePoolDetail(dm, fallbackToken = null) {
  const binStep = normalizeBinStep(dm);
  const volumeWindow = typeof dm.volume === "number"
    ? dm.volume
    : (dm.volume?.["1h"] ?? dm.volume?.["24h"] ?? 0);
  const feeActiveTvlRatio = dm.fee_active_tvl_ratio ?? dm.fee_tvl_ratio?.["1h"] ?? dm.fee_tvl_ratio?.["24h"] ?? null;
  const tokenAge = ageHoursFrom(dm.token_x?.created_at ?? dm.created_at);
  return {
    pool:                dm.pool_address ?? dm.address,
    name:                dm.name ?? `${dm.token_x?.symbol ?? fallbackToken?.symbol ?? "UNKNOWN"}-${dm.token_y?.symbol ?? "SOL"}`,
    base: {
      symbol:   dm.token_x?.symbol ?? dm.token_x?.name ?? fallbackToken?.symbol ?? "UNKNOWN",
      mint:     dm.token_x?.address ?? fallbackToken?.mint ?? null,
      organic:  Math.round(dm.token_x?.organic_score ?? 0),
      warnings: dm.token_x?.warnings?.length ?? 0,
    },
    quote: {
      symbol: dm.token_y?.symbol ?? "SOL",
      mint:   dm.token_y?.address,
    },
    bin_step:            binStep,
    fee_pct:             dm.fee_pct ?? dm.dynamic_fee_pct ?? dm.pool_config?.base_fee_pct ?? null,
    active_tvl:          dm.active_tvl ?? dm.tvl ?? null,
    fee_window:          null,
    volume_window:       Math.round(volumeWindow),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility:          dm.volatility ?? null,
    holders:             dm.base_token_holders ?? dm.token_x?.holders ?? 0,
    mcap:                Math.round(dm.token_x?.market_cap ?? dm.base_token_market_cap ?? 0),
    organic_score:       Math.round(dm.token_x?.organic_score ?? 0),
    token_age_hours:     tokenAge,
    price:               dm.pool_price ?? dm.current_price ?? dm.token_x?.price ?? null,
    price_change_pct:    dm.pool_price_change_pct ?? null,
    price_trend:         Array.isArray(dm.price_trend) ? dm.price_trend : null,
    _source:             "meteora_detail",
  };
}

/**
 * Untuk token yang tidak ditemukan di Meteora pool-discovery-api,
 * coba cari pool-nya via RocketScan (deteksi on-chain, lebih cepat diindex).
 * Jika ditemukan, fetch detail dari dlmm.datapi.meteora.ag dan apply basic filters.
 *
 * Returns array of { token, pool?, rejectionReason?, bestInvalidPool? }.
 */
async function fetchRocketScanFallback(tokens, s) {
  if (tokens.length === 0) return [];

  const results = await Promise.all(tokens.map(async (token) => {
    try {
      const result = await discoverDlmmPoolsForToken(token, s, { useMeteoraDirect: true, useRocketScan: true });
      if (result.bestEligiblePool) return { token, pool: result.bestEligiblePool };
      if (result.rejectionReason === "NO_ELIGIBLE_DLMM_POOL" || result.rejectionReason === "ONLY_INVALID_BIN_STEP_POOLS_FOUND") {
        log("screening", `NO_ELIGIBLE_DLMM_POOL token=${token.symbol}/${token.mint.slice(0, 8)} checked_pools=${result.pools.length} reason=${result.rejectionReason}`);
      }
      return {
        token,
        rejectionReason: result.rejectionReason ?? "NO_POOL",
        bestInvalidPool: result.bestInvalidPool ? {
          pool: result.bestInvalidPool.pool,
          bin_step: result.bestInvalidPool.bin_step,
          tvl: result.bestInvalidPool.active_tvl ?? null,
          volume1h: result.bestInvalidPool.volume_window ?? null,
          holderCount: result.bestInvalidPool.holders ?? null,
          source: result.bestInvalidPool._source ?? null,
        } : null,
        invalidPools: result.invalidBinStepPools.map(pool => ({
          pool: pool.pool,
          bin_step: pool.bin_step,
          tvl: pool.active_tvl ?? null,
          volume1h: pool.volume_window ?? null,
          source: pool._source ?? null,
        })),
      };
    } catch (e) {
      log("screening", `  ${token.symbol}: RocketScan exception: ${e.message?.slice(0, 80) ?? e}`);
      return { token, rejectionReason: "NO_POOL" };
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
  const preferredBinStep = getPreferredBinStepRange(s);

  const filters = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl ?? 500_000}`,
    `dlmm_bin_step>=${preferredBinStep.min}`,
    `dlmm_bin_step<=${preferredBinStep.max}`,
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
      return { poolMap: new Map(), totalTvlMap: new Map() };
    }
    const data = await res.json();
    let pools = (data.data ?? []);

    if (!Array.isArray(pools) || pools.length === 0) {
      log("screening", `Meteora API returned 0 pools (or unexpected format) — RocketScan will handle all pool discovery`);
      return { poolMap: new Map(), totalTvlMap: new Map() };
    }

    // Sum TVL per base mint across ALL pools (pre-condense, pre-age-filter)
    const totalTvlMap = new Map();
    for (const p of pools) {
      const mint = p.token_x?.address;
      if (!mint) continue;
      totalTvlMap.set(mint, (totalTvlMap.get(mint) ?? 0) + (p.tvl ?? p.active_tvl ?? 0));
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

    // Build Map<baseMint, bestPool> — prefer the strongest eligible pool per token
    const poolMap = new Map();
    for (const pool of pools) {
      const mint = pool.base?.mint;
      if (!mint) continue;
      const existing = poolMap.get(mint);
      if (isPoolBetter(pool, existing)) {
        poolMap.set(mint, pool);
      }
    }
    return { poolMap, totalTvlMap };
  } catch (err) {
    log("screening", `Meteora bulk fetch error: ${err.message}`);
    return { poolMap: new Map(), totalTvlMap: new Map() };
  }
}

export async function recheckFastPendingPools({ correlationId = null } = {}) {
  const fastCfg = getFastPoolRecheckConfig();
  if (!fastCfg.enabled) return { triggeredRescreen: false, rechecked: 0, eligibleFound: 0 };

  const _s = (message) => {
    if (correlationId) return logWithId("screening", message, {}, correlationId);
    return log("screening", message);
  };

  const s = config.screening;
  const store = loadPendingPoolCandidates();
  const now = Date.now();
  let changed = false;
  let triggeredRescreen = false;
  let eligibleFound = 0;
  let expiredCount = 0;

  const candidates = Object.values(store)
    .filter(entry => {
      const expiresAt = asTimestampMs(entry.expiresAt) ?? (asTimestampMs(entry.firstSeenAt) ?? now) + fastCfg.ttlMs;
      if (expiresAt <= now) {
        _s(`FAST_POOL_CANDIDATE_EXPIRED token=${entry.symbol ?? "UNKNOWN"}/${entry.mint?.slice(0, 8) ?? "unknown"} reason=${entry.lastRejectReason ?? "unknown"}`);
        delete store[entry.mint];
        expiredCount++;
        changed = true;
        return false;
      }
      if (entry.status === "resolved" || entry.status === "expired") return false;
      if (entry.readyForRescreen || entry.status === "readyForRescreen") {
        triggeredRescreen = true;
        return false;
      }
      if (entry.status === "checking" || entry.status === "screening") return false;
      const lastCheckedAt = asTimestampMs(entry.lastCheckedAt) ?? 0;
      return now - lastCheckedAt >= fastCfg.intervalMs;
    })
    .sort((a, b) => (asTimestampMs(a.firstSeenAt) ?? now) - (asTimestampMs(b.firstSeenAt) ?? now))
    .slice(0, fastCfg.maxCandidates);

  for (const entry of candidates) {
    const token = pendingCandidateToToken(entry);
    const existing = store[entry.mint] ?? entry;
    existing.status = "checking";
    store[entry.mint] = existing;
    changed = true;
    const nextCheckCount = (existing.checkCount ?? 0) + 1;
    if (nextCheckCount === 1 || nextCheckCount % 20 === 0) {
      _s(`FAST_POOL_CANDIDATE_RECHECK token=${entry.symbol ?? "UNKNOWN"}/${entry.mint.slice(0, 8)} reason=${entry.lastRejectReason ?? "unknown"} check_count=${nextCheckCount}`);
    }
    const result = await discoverDlmmPoolsForToken(token, s, {
      useMeteoraDirect: fastCfg.useMeteoraDirect,
      useRocketScan: true,
    });

    if (result.bestEligiblePool) {
      existing.lastCheckedAt = new Date(now).toISOString();
      existing.checkCount = (existing.checkCount ?? 0) + 1;
      existing.readyForRescreen = true;
      existing.status = "readyForRescreen";
      existing.lastEligiblePool = {
        pool: result.bestEligiblePool.pool,
        bin_step: result.bestEligiblePool.bin_step,
        tvl: result.bestEligiblePool.active_tvl ?? null,
        volume1h: result.bestEligiblePool.volume_window ?? null,
        source: result.bestEligiblePool._source ?? "unknown",
      };
      store[entry.mint] = existing;
      _s(`PENDING_POOL_ELIGIBLE_FOUND token=${entry.symbol ?? "UNKNOWN"}/${entry.mint.slice(0, 8)} pool=${result.bestEligiblePool.pool?.slice(0, 8) ?? "unknown"} bin_step=${result.bestEligiblePool.bin_step}`);
      triggeredRescreen = true;
      eligibleFound++;
      changed = true;
      continue;
    }

    updatePendingPoolCandidate(store, token, result.rejectionReason ?? existing.lastRejectReason ?? "NO_POOL", {
      liquidity: result.bestInvalidPool?.active_tvl ?? existing.liquidity ?? null,
      holders: result.bestInvalidPool?.holders ?? existing.holders ?? null,
      invalidPools: result.invalidBinStepPools.map(pool => ({
        pool: pool.pool,
        bin_step: pool.bin_step,
        tvl: pool.active_tvl ?? null,
        volume1h: pool.volume_window ?? null,
        source: pool._source ?? null,
      })),
      bestInvalidPool: result.bestInvalidPool ? {
        pool: result.bestInvalidPool.pool,
        bin_step: result.bestInvalidPool.bin_step,
        tvl: result.bestInvalidPool.active_tvl ?? null,
        volume1h: result.bestInvalidPool.volume_window ?? null,
        source: result.bestInvalidPool._source ?? null,
      } : existing.bestInvalidPool ?? null,
      status: "pending",
      readyForRescreen: false,
    });
    changed = true;
  }

  if (candidates.length > 0 || eligibleFound > 0 || expiredCount > 0) {
    _s(`FAST_POOL_RECHECK_SUMMARY checked=${candidates.length} eligible_found=${eligibleFound} expired=${expiredCount} pending_total=${Object.keys(store).length}`);
  }
  if (changed) savePendingPoolCandidates(store);
  return { triggeredRescreen, rechecked: candidates.length, eligibleFound };
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
export async function getTopCandidates({ limit = 20, correlationId = null, athOorPools = null } = {}) {
  const s = config.screening;
  const pendingPoolStore = loadPendingPoolCandidates();
  const pendingTokens = [];
  let pendingStoreChanged = false;
  const pendingNowMs = Date.now();

  for (const [mint, entry] of Object.entries(pendingPoolStore)) {
    const expiresAtTs = asTimestampMs(entry.expiresAt) ?? Number.POSITIVE_INFINITY;
    if (expiresAtTs <= pendingNowMs) {
      log("screening", `FAST_POOL_CANDIDATE_EXPIRED token=${entry.symbol ?? "UNKNOWN"}/${mint.slice(0, 8)} reason=${entry.lastRejectReason ?? "unknown"}`);
      delete pendingPoolStore[mint];
      pendingStoreChanged = true;
      continue;
    }
    if (!(entry.readyForRescreen || entry.status === "readyForRescreen")) continue;
    pendingTokens.push(pendingCandidateToToken(entry));
  }
  if (pendingStoreChanged) savePendingPoolCandidates(pendingPoolStore);

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
  const mergedByMint = new Map(allTokens.map(t => [t.mint, t]));
  for (const pendingToken of pendingTokens) {
    const existing = mergedByMint.get(pendingToken.mint);
    if (existing) {
      existing._pendingPoolWatch = true;
      existing._pendingPoolMeta = pendingToken._pendingPoolMeta;
      if (!existing.name && pendingToken.name) existing.name = pendingToken.name;
      if (existing._volH1 == null && pendingToken._volH1 != null) existing._volH1 = pendingToken._volH1;
      if (existing.mcap == null && pendingToken.mcap != null) existing.mcap = pendingToken.mcap;
      continue;
    }
    mergedByMint.set(pendingToken.mint, pendingToken);
  }
  const discoveryTokens = [...mergedByMint.values()];
  const totalScreened = discoveryTokens.length;
  log("screening", `Discovery: ${discoveryTokens.length} tokens total (dex=${dexTokens.length}, rocket=${rocketTokens.length} new, pending=${pendingTokens.length})`);

  // Exclude pools/mints where wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));

  let eligible = discoveryTokens.filter(t => {
    if (occupiedMints.has(t.mint)) {
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — already has open position (${t.mint.slice(0, 8)}...)`);
      return false;
    }
    if (isBlacklisted(t.mint)) {
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — token blacklisted`);
      return false;
    }
    const kw = matchedKeyword(t.name, t.symbol);
    if (kw) {
      log("screening", `  [SKIP] ${t.name ?? t.symbol}-SOL — matched keyword "${kw}" (scam_type_keyword)`);
      return false;
    }
    // isDevBlocked already called correctly at line 578 (after okx.creator available)
    // Note: isDevBlocked(t.mint) was removed — _devBlockCache stores dev wallet addresses, not token mints
    return true;
  });

  if (eligible.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: 0, withPool_count: 0, fib_analyzed: 0 };
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
    const bigMcapThresholdVol = s.bigMcapThreshold ?? 5_000_000;
    const minVolBigMcap       = s.minVolBigMcap    ?? 1_000_000;
    eligible = eligible.filter(t => {
      const volH1 = t._volH1 ?? 0;
      const mcap  = t.mcap   ?? 0;
      const volMin = mcap > bigMcapThresholdVol ? minVolBigMcap : s.minVolume;
      if (volH1 >= volMin) {
        t._volH1 = Math.round(volH1);
        return true;
      }
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — vol $${Math.round(volH1)} < min $${volMin}${mcap > bigMcapThresholdVol ? " (big-mcap)" : ""} [${t._volH1Source ?? "dexscreener"}] | mcap=${t.mcap ? "$" + Math.round(t.mcap) : "?"}`);
      return false;
    });
    log.screening(`Step 2 — Volume filter: ${eligible.length}/${before} passed (3-layer chain exhausted)`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: 0, withPool_count: 0, fib_analyzed: 0 };
  }

  const afterVolumeCount = eligible.length;

  // ── Step 3: Meteora pool check — BEFORE RugCheck/Jupiter ─────────────────
  // Hemat API quota: skip RugCheck/Jupiter untuk token yang tidak punya pool.
  // Meteora kadang butuh 6-8 jam untuk index pool baru → RocketScan fallback.
  {
    log("screening", `Step 3 — Meteora pool check: ${eligible.length} token(s) after volume...`);
    const { poolMap, totalTvlMap } = await fetchMeteoraDlmmPoolMap();
    log("screening", `Meteora pool universe: ${poolMap.size} qualifying pools fetched`);
    const fallbackDiagnostics = new Map();

    const missingPool = eligible.filter(t => !poolMap.has(t.mint));
    if (missingPool.length > 0) {
      log("screening", `Pool match: ${eligible.length - missingPool.length}/${eligible.length} in Meteora → ${missingPool.length} checking RocketScan...`);
      const fallbacks = await fetchRocketScanFallback(missingPool, s);
      for (const result of fallbacks) {
        fallbackDiagnostics.set(result.token.mint, result);
        if (!result.pool) continue;
        poolMap.set(result.token.mint, result.pool);
      }
      if (fallbacks.every(r => !r.pool)) {
        log("screening", `RocketScan fallback: no pools found for ${missingPool.length} token(s) — skipping`);
      }
    }

    const before = eligible.length;
    // Attach pool info to token, filter out tokens with no pool
    eligible = eligible.filter(t => {
      const pool = poolMap.get(t.mint);
      if (!pool) {
        const diag = fallbackDiagnostics.get(t.mint);
        if (diag && isPendingPoolReasonWatchable(diag.rejectionReason)) {
          const { isNew } = updatePendingPoolCandidate(pendingPoolStore, t, diag.rejectionReason, {
            liquidity: diag.bestInvalidPool?.tvl ?? null,
            holders: diag.bestInvalidPool?.holderCount ?? t.holders ?? null,
            bestInvalidPool: diag.bestInvalidPool ?? null,
            invalidPools: diag.invalidPools ?? [],
            status: "pending",
            readyForRescreen: false,
          });
          const bestInvalid = diag.bestInvalidPool
            ? ` pool=${diag.bestInvalidPool.pool?.slice(0, 8) ?? "unknown"} bin_step=${diag.bestInvalidPool.bin_step ?? "null"}`
            : "";
          if (isNew) {
            log("screening", `FAST_POOL_CANDIDATE_ADDED token=${t.symbol}/${t.mint.slice(0, 8)} reason=${diag.rejectionReason}${bestInvalid}`);
          }
          pendingStoreChanged = true;
        }
        log("screening", `  ${t.symbol}(${t.mint.slice(0, 8)}): ${diag?.rejectionReason ?? "NO_POOL"} — no eligible DLMM pool selected`);
        return false;
      }
      t._pool = pool; // attach for use in Step 8
      t._totalMintTvl = totalTvlMap.get(t.mint) ?? (pool.active_tvl ?? 0);
      log("screening", `DLMM_POOL_SELECTED token=${t.symbol}/${t.mint.slice(0, 8)} pool=${pool.pool.slice(0, 8)} bin_step=${pool.bin_step} tvl=${Math.round(pool.active_tvl ?? 0)} volume1h=${Math.round(pool.volume_window ?? 0)} source=${pool._source ?? "meteora_bulk"}`);
      if (pendingPoolStore[t.mint]) {
        log("screening", `PENDING_POOL_ELIGIBLE_FOUND token=${t.symbol}/${t.mint.slice(0, 8)} pool=${pool.pool.slice(0, 8)} bin_step=${pool.bin_step}`);
        delete pendingPoolStore[t.mint];
        pendingStoreChanged = true;
      }
      return true;
    });
    if (pendingStoreChanged) savePendingPoolCandidates(pendingPoolStore);

    log.screening(`Step 3 — Pool check: ${eligible.length}/${before} have Meteora DLMM pool`);

    // High-TVL gate: total token TVL > threshold requires proportionally high volume
    const highTvlThreshold = s.highTvlThreshold ?? 300_000;
    const minVolumeHighTvl = s.minVolumeHighTvl ?? 1_000_000;
    if (highTvlThreshold > 0 && minVolumeHighTvl > 0) {
      const beforeHtvl = eligible.length;
      eligible = eligible.filter(t => {
        if ((t._totalMintTvl ?? 0) > highTvlThreshold && (t._volH1 ?? 0) < minVolumeHighTvl) {
          log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — high_tvl_low_volume (totalTvl=$${Math.round(t._totalMintTvl)})`);
          return false;
        }
        return true;
      });
      if (eligible.length < beforeHtvl) {
        log.screening(`High-TVL filter: ${eligible.length}/${beforeHtvl} passed (totalTvl>$${highTvlThreshold} requires 1h vol>$${minVolumeHighTvl})`);
      }
    }
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 4: mcap + age filter ───────────────────────────────────────────────
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
      if (t.token_age_hours != null && s.maxTokenAgeHours != null && t.token_age_hours > s.maxTokenAgeHours) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0, 8)}): SKIP — token age ${(t.token_age_hours / 24).toFixed(1)}d > max ${(s.maxTokenAgeHours / 24).toFixed(0)}d | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
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
      log.screening(`Step 4 — mcap filter: ${eligible.length}/${before} passed`);
    }
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
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
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
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
      if (jup.top10Pct != null) {
        const lockedPct = t._okx?.lockedPct ?? 0;
        const effectiveTop10 = Math.max(0, jup.top10Pct - lockedPct);
        const maxTop10 = s.maxTop10Pct ?? 20;
        if (effectiveTop10 > maxTop10) {
          const lockNote = lockedPct > 0 ? ` (locked=${lockedPct}%, effective=${effectiveTop10.toFixed(2)}%)` : "";
          log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — top10 ${jup.top10Pct}%${lockNote} > max ${maxTop10}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
          return false;
        }
      }
      if (jup.botHoldersPct != null && jup.botHoldersPct > (s.maxBotHoldersPct ?? 30)) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — bot holders ${jup.botHoldersPct}% > max ${s.maxBotHoldersPct ?? 30}% | 1h vol=${t._volH1 ? "$" + t._volH1 : "?"}`);
        return false;
      }
      // feesSOL: base gate only — ATH mcap check happens post-Fibonacci (uses real ATH price from OHLCV)
      const feeThreshold = s.minTokenFeesSol ?? 24;
      if (jup.feesSOL != null && jup.feesSOL < feeThreshold) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — fees ${jup.feesSOL.toFixed(4)} SOL < min ${feeThreshold} SOL | mcap=${((t.mcap ?? 0)/1e6).toFixed(2)}M`);
        return false;
      }
      // Big mcap gate: mcap > $5M requires fees >= 400 SOL
      const bigMcapThreshold = s.bigMcapThreshold ?? 5_000_000;
      const bigMcapFeeMin    = s.minTokenFeesSolBigMcap ?? 400;
      if ((t.mcap ?? 0) > bigMcapThreshold && jup.feesSOL != null && jup.feesSOL < bigMcapFeeMin) {
        log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): SKIP — mcap $${((t.mcap)/1e6).toFixed(2)}M > $${(bigMcapThreshold/1e6).toFixed(0)}M but fees ${jup.feesSOL.toFixed(2)} SOL < ${bigMcapFeeMin} SOL`);
        return false;
      }
      t._jup = jup;
      const _lockedPct = t._okx?.lockedPct ?? 0;
      const _lockNote = _lockedPct > 0 ? `, locked=${_lockedPct}%` : "";
      log("screening", `  ${t.symbol}(${t.mint.slice(0,8)}): OK — top10=${jup.top10Pct ?? "?"}%${_lockNote}, bots=${jup.botHoldersPct ?? "?"}%, fees=${jup.feesSOL ?? "?"} SOL${t._source === "jupiter" ? " [rocket-scan]" : ""}`);
      return true;
    });
    _s("screening", `Jupiter filter: ${eligible.length}/${before} passed`);
  }

  if (eligible.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
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
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount ?? 0, withPool_count: 0, fib_analyzed: 0 };
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
  // Pool sudah di-attach ke t._pool di Step 3 — build withPool dari topCandidates
  const withPool = topCandidates.map(t => ({ token: t, pool: t._pool }));

  _s("screening", `Step 7 — Fibonacci analysis: ${withPool.length} candidates with confirmed pool`);

  if (withPool.length === 0) {
    return { candidates: [], total_screened: totalScreened, after_volume_count: afterVolumeCount, withPool_count: 0, fib_analyzed: 0 };
  }

  // ── Step 8: Fibonacci + OHLCV analysis ───────────────────────────────────
  // OHLCV hanya dipanggil di sini — setelah semua filter terlewati + pool confirmed.
  // Filter out pools cached as "broken support"
  const now = Date.now();
  const toAnalyze = withPool.filter(({ token, pool }) => {
    // Skip pools that are actively crashing (>80% price drop in 24h) — not an entry signal
    if (pool.price_change_pct != null && pool.price_change_pct <= -80) {
      log("screening", `  ${pool.name}: SKIP — price crashed ${pool.price_change_pct.toFixed(1)}% in 24h`);
      const solPrice = pool.price ?? 0; // Meteora pool_price: SOL-denominated
      _fibBrokenSupportCache.set(pool.pool, { cachedAt: now, priceAtRejection: solPrice, athAtRejection: null });
      _saveBrokenSupportCache(_fibBrokenSupportCache);
      return false;
    }
    // Skip pools cached as "broken support" — invalidate ONLY if price broke previous ATH
    const cached = _fibBrokenSupportCache.get(pool.pool);
    if (cached && now - cached.cachedAt < FIB_BROKEN_CACHE_MS) {
      const solPrice = pool.price ?? 0; // SOL-denominated
      if (cached.athAtRejection != null && solPrice > cached.athAtRejection) {
        _fibBrokenSupportCache.delete(pool.pool);
        _saveBrokenSupportCache(_fibBrokenSupportCache);
        log("screening", `  ${pool.name}: broken support cache INVALIDATED — price ${solPrice.toPrecision(4)} SOL reclaimed above fib swing high ${cached.athAtRejection.toPrecision(4)} SOL, re-analyzing`);
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
      // Primary price: Meteora pool_price (native SOL for TOKEN/SOL DLMM pools).
      // Fallback: getReliableSOLPrice (GT OHLCV last close → Birdeye USD ÷ solPrice).
      // ALL prices in SOL denomination — consistent with OHLCV candles from getOHLCV().
      let currentPrice = (pool.price != null && pool.price > 0) ? pool.price : null;
      if (currentPrice != null) {
        log.screening(`  ${pool.name}: price=${currentPrice.toPrecision(4)} SOL source=meteora-pool`);
      } else {
        try {
          const reliable = await hybridDataProvider.getReliableSOLPrice(token.mint, pool.pool);
          if (reliable?.price != null && reliable.price > 0) {
            currentPrice = reliable.price;
            log.screening(`  ${pool.name}: price=${currentPrice.toPrecision(4)} SOL source=${reliable.source}`);
          }
        } catch { /* non-fatal */ }
      }
      if (currentPrice == null || currentPrice <= 0) {
        return { signal: "SKIP", reason: "Missing SOL price — Meteora pool_price null and all SOL price fallbacks failed" };
      }
      const binStep = pool.bin_step;
      if (!binStep) {
        return { signal: "SKIP", reason: "Missing bin_step" };
      }
      if (pool._binStepPolicy === "conditional" && binStep === 50) {
        log("screening", `BIN_STEP_50_CONDITIONAL_CHECK token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} bin_step=50`);
      }
      const isAthOor = athOorPools != null && athOorPools.has(pool.pool);
      return analyzeSignal(token.mint, binStep, currentPrice, s.candleLimit ?? 50, { rsiMin: s.rsiMin ?? null, skipRsiSlope: isAthOor, symbol: token.symbol }, pool.pool);
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

    if (pool.bin_step === 50 && pool._binStepPolicy === "conditional") {
      const coverage = analysis.rangeCoverage ?? null;
      if (analysis.signal === "ENTRY" && coverage?.coverageOk) {
        log("screening", `BIN_STEP_50_ALLOWED_RANGE_COVERAGE_OK token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} rangeTop=${coverage.computedRangeTopPrice ?? analysis.rangeTopPrice ?? "null"} rangeBottom=${coverage.computedRangeBottomPrice ?? analysis.rangeBottomPrice ?? "null"} targetBottom=${coverage.targetBottomPrice ?? "null"}`);
      } else if (analysis.reason?.includes("RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP")) {
        log("screening", `BIN_STEP_50_REJECTED_RANGE_TOO_NARROW token=${token.symbol}/${token.mint.slice(0, 8)} pool=${pool.pool?.slice(0, 8) ?? "unknown"} rangeBottom=${coverage?.computedRangeBottomPrice ?? "null"} targetBottom=${coverage?.targetBottomPrice ?? "null"}`);
      }
    }
    if (analysis.reason?.includes("RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP")) {
      log("screening", `RANGE_COVERAGE_TOO_NARROW_FOR_BIN_STEP token=${token.symbol}/${token.mint.slice(0, 8)} bin_step=${pool.bin_step ?? "null"}`);
    }

    // Cache pools rejected for broken support — store ATH from Fib so invalidation is ATH-aware
    if (analysis.signal !== "ENTRY" && analysis.reason?.includes("broken support")) {
      const rejectedPrice  = pool.price ?? 0; // SOL-denominated (Meteora pool_price)
      const athAtRejection = analysis.fibLevels?.swingHigh ?? null; // SOL-denominated (from OHLCV candles)
      _fibBrokenSupportCache.set(pool.pool, { cachedAt: now, priceAtRejection: rejectedPrice, athAtRejection });
      _saveBrokenSupportCache(_fibBrokenSupportCache);
    }

    log("screening", `  ${pool.name}: ${analysis.signal} — ${analysis.reason}`);
    if (analysis.signal === "ENTRY") {
      log("screening", `  ${pool.name}: volume_flow cmf20=${analysis.cmf20 ?? "null"} adSlope=${analysis.adSlope ?? "null"} bias=${analysis.volumeFlowBias ?? "neutral"}`);
    }
    appendScreeningSignalSnapshot(buildScreeningSignalSnapshot({
      token,
      pool,
      analysis,
      currentPrice: analysis.currentPrice ?? pool.price ?? null,
    }));
    if (analysis.signal !== "ENTRY") continue;

    // ATH mcap check: use real ATH price from OHLCV candles (not current mcap)
    // Formula: athMcap = (athPrice / currentPrice) * currentMcap
    // If ATH mcap > $1M → require 80 SOL fees (token already proven capable of $1M+)
    {
      const athPrice     = analysis.ath;
      const curPrice     = analysis.currentPrice;
      const curMcap      = token.mcap ?? 0;
      const feesSOL      = token._jup?.feesSOL ?? null;
      const highFeeMin   = s.minTokenFeesSolHighMcap ?? 80;
      if (athPrice > 0 && curPrice > 0 && curMcap > 0) {
        const athMcap = (athPrice / curPrice) * curMcap;
        if (athMcap > 1_000_000 && feesSOL != null && feesSOL < highFeeMin) {
          log("screening", `  ${pool.name}: SKIP — ATH mcap $${(athMcap/1e6).toFixed(2)}M > $1M but fees ${feesSOL.toFixed(2)} SOL < ${highFeeMin} SOL`);
          continue;
        }
      }
    }

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
        rangeTopPrice:       analysis.rangeTopPrice ?? null,
        rangeBottomPrice:    analysis.rangeBottomPrice ?? null,
        supportPrice:        analysis.supportPrice ?? null,
        targetTopPrice:      analysis.rangeCoverage?.targetTopPrice ?? null,
        targetBottomPrice:   analysis.rangeCoverage?.targetBottomPrice ?? null,
        computedRangeTopPrice: analysis.rangeCoverage?.computedRangeTopPrice ?? null,
        computedRangeBottomPrice: analysis.rangeCoverage?.computedRangeBottomPrice ?? null,
        rangeCoverageOk:     analysis.rangeCoverage?.coverageOk ?? null,
        requiredDepthBinsRaw: analysis.rangeCoverage?.requiredDepthBinsRaw ?? null,
        maxBinsForPosition:  analysis.rangeCoverage?.maxBinsForPosition ?? null,
        ath:                 analysis.ath ?? analysis.fibLevels?.swingHigh ?? null,
        atl:                 analysis.atl ?? analysis.fibLevels?.swingLow ?? null,
        currentPrice:        analysis.currentPrice,
        confluenceScore:     analysis.confluenceScore ?? 0,
        pricePosition:       analysis.pricePosition   ?? null,
        inPrimaryZone:       analysis.inPrimaryZone   ?? false,
        inAthZone:           analysis.inAthZone        ?? false,
        hasHiddenDivergence: analysis.hasHiddenDivergence ?? false,
        blowoffClassification: analysis.blowoffClassification ?? null,
        microConsolidation: analysis.microConsolidation ?? null,
        rsi:                 analysis.rsi      ?? null,
        rsiSlope:            analysis.rsiSlope ?? null,
        cmf10:               analysis.cmf10    ?? null,
        cmf20:               analysis.cmf20    ?? null,
        adSlope:             analysis.adSlope  ?? null,
        volumeFlowBias:      analysis.volumeFlowBias ?? "neutral",
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
  // observePoolParticipants() in executor.js still fires post-close and auto-promotes
  // wallets to smart-wallets.json. Re-enable this block when LP API tier allows it.
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
    // Use SOL price (fib_signal.currentPrice from Meteora) — consistent with SOL-first architecture.
    // Legacy candidates without fib_signal: use c.price (Dexscreener USD) as fallback for cooldown check,
    // but this means unit mismatch in comparison. Acceptable — legacy entries get 1h time fallback anyway.
    const priceSol = c.fib_signal?.currentPrice ?? (c.price ?? null);
    if (!addr) return true;
    if (priceSol != null && isPoolOnATHCooldown(addr, priceSol)) {
      log("screening", `  ${c.name}: SKIP — TP/SL close, no new ATH since close`);
      return false;
    }
    return true;
  });
  _s("screening", `ATH cooldown: ${cooldownFiltered.length}/${beforeCooldown} passed (TP/SL/rebound closes without new ATH filtered)`);

  _s("screening", `Step 8 — Fibonacci: ${cooldownFiltered.length}/${withPool.length} passed broken-support → ${candidates.length} ENTRY`);
  _s("screening", `Summary: discovered=${totalScreened} (dex=${dexTokens.length}+rocket=${rocketTokens.length}+pending=${pendingTokens.length}) → volume=${afterVolumeCount} → eligible=${eligible.length} → prePoolCap=${maxTechAnalysis} → pools=${withPool.length} → fib_entry=${filtered.length}`);

  return {
    candidates:        cooldownFiltered,
    total_screened:    totalScreened,
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
