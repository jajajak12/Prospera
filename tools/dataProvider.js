/**
 * Hybrid Data Provider for OHLCV + Pool Data
 *
 * Priority chain:
 *
 * - Pool Discovery & Matching:
 *   Meteora pool-discovery API (primary) + RocketScan fallback
 *   Dexscreener hanya untuk initial discovery, volume, dan supplementary data
 *
 * - Pool Detail (TVL, binStep, fee, liquidity dll):
 *   Meteora DLMM API (primary)
 *   Birdeye hanya sebagai last fallback (jarang dipakai)
 *
 * - OHLCV (USD-consistent untuk Technical Analysis):
 *   GeckoTerminal (primary) → Birdeye (fallback) → skip candidate
 *
 * Tujuan: Menghemat Birdeye API quota (30k/bulan).
 * Birdeye sekarang hanya dipakai sebagai fallback untuk OHLCV.
 * Jika GeckoTerminal dan Birdeye gagal → skip kandidat (jangan pakai TA yang degraded).
 *
 * Fallback triggers: timeout > 3s, HTTP 429, any thrown error.
 * Each source: 1 retry on 429 before falling back to next.
 */

import { log } from "../logger.js";

const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const BIRDEYE_BASE       = "https://public-api.birdeye.so";
const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const JUPITER_QUOTE_API  = "https://api.jup.ag/swap/v1";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const SOL_MINT           = "So11111111111111111111111111111111111111112"; // wrapped SOL
const TIMEOUT_MS = 3000;

// Birdeye multi-key support — rotate on 401
const _birdeyeKeys = () => [
  process.env.BIRDEYE_API_KEY,
  process.env.BIRDEYE_API_KEY_2,
].filter(Boolean);
let _beKeyIdx = 0;
function birdeyeKey() {
  const keys = _birdeyeKeys();
  if (keys.length === 0) return null;
  const key = keys[_beKeyIdx % keys.length];
  return key;
}

// Advance key index and return the next key (called after a 401)
function birdeyeKeyRotate() {
  _beKeyIdx++;
  const keys = _birdeyeKeys();
  return keys[_beKeyIdx % keys.length] ?? null;
}

function sig(ms) { return AbortSignal.timeout(ms); }

// Exponential backoff for rate-limit retries (retries=2 → 3 total attempts: 0s → 2s → 4s)
async function withRetry(fn, retries = 2, baseDelayMs = 2000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (!err.message?.includes("429")) throw err;
      if (attempt === retries) throw err; // exhausted retries
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Dexscreener ─────────────────────────────────────────────────────────────

async function dexscreenerPoolData(poolAddress, chain) {
  return withRetry(async () => {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/pairs/${chain}/${poolAddress}`, { signal: sig(TIMEOUT_MS) });
    if (res.status === 429) throw new Error("Dexscreener 429");
    if (!res.ok) throw new Error(`Dexscreener pool error: ${res.status}`);
    const data = await res.json();
    const pair = data?.pair ?? data?.pairs?.[0];
    if (!pair) throw new Error("Dexscreener: no pair data");
    // ATH dari priceHistory candles (highest high across all candles)
    const ath_price = pair.priceHistory?.reduce
      ? (pair.priceHistory.length > 0
          ? pair.priceHistory.reduce((max, c) => Math.max(max, Number(c.h) || 0), 0)
          : null)
      : null;

    return {
      poolAddress, chain,
      baseToken:  pair.baseToken,
      quoteToken: pair.quoteToken,
      price:      parseFloat(pair.priceUsd) || null,
      mcap:       parseFloat(pair.fdv ?? pair.marketCap) || null,

      volume: {
        m5:  parseFloat(pair.volume?.m5  ?? 0),
        h1:  parseFloat(pair.volume?.h1  ?? 0),
        h6:  parseFloat(pair.volume?.h6  ?? 0),
        h24: parseFloat(pair.volume?.h24 ?? 0),
      },
      liquidity: parseFloat(pair.liquidity?.usd) || null,
      dex:       pair.dexId,
      _source:   "dexscreener",
      ath_price: ath_price > 0 ? ath_price : null,
    };
  });
}

async function dexscreenerOHLCV(poolAddress, chain, timeframe, limit) {
  return withRetry(async () => {
    const typeMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1D": "1D", "1d": "1D" };
    const dsType = typeMap[timeframe] ?? "5";
    const res = await fetch(
      `${DEXSCREENER_BASE}/dex/candles/${chain}/${poolAddress}?res=${dsType}&cb=${limit}`,
      { signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("Dexscreener 429");
    if (!res.ok) throw new Error(`Dexscreener OHLCV error: ${res.status}`);
    const data = await res.json();
    const bars = data?.candles ?? data?.data?.candles;
    if (!bars || bars.length === 0) throw new Error("Dexscreener: empty OHLCV");
    return bars.map(b => ({
      timestamp: b.t ?? b.time,
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v),
    }));
  });
}

// ─── Birdeye ─────────────────────────────────────────────────────────────────

function birdeyeHeaders(chain, apiKeyOverride = null) {
  const apiKey = apiKeyOverride ?? birdeyeKey();
  if (!apiKey) throw new Error("BIRDEYE_API_KEY not configured");
  return { "X-API-KEY": apiKey, "x-chain": chain };
}

async function birdeyePoolData(poolAddress, chain) {
  return withRetry(async () => {
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/pool_overview?address=${poolAddress}`,
      { headers: birdeyeHeaders(chain), signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("Birdeye 429");
    if (!res.ok) throw new Error(`Birdeye pool error: ${res.status}`);
    const data = await res.json();
    const pool = data?.data;
    if (!pool) throw new Error("Birdeye: no pool data");
    return {
      poolAddress, chain,
      baseToken:  { address: pool.baseAddress,  symbol: pool.baseSymbol },
      quoteToken: { address: pool.quoteAddress, symbol: pool.quoteSymbol },
      price:      pool.price ?? null,
      mcap:       pool.mc   ?? null,
      volume: { m5: pool.v5m ?? 0, h1: pool.v1h ?? 0, h6: pool.v6h ?? 0, h24: pool.v24h ?? 0 },
      liquidity: pool.liquidity ?? null,
      dex:       pool.source ?? null,
      _source:   "birdeye",
    };
  });
}

// ─── Birdeye key rotation helper (DRY) ───────────────────────────────────────
async function withBirdeyeKeyRotation(fn) {
  const keys = _birdeyeKeys();
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      return await fn(key);
    } catch (err) {
      if (err.message?.includes("401")) { lastErr = err; continue; }
      throw err; // non-401 — no point trying other keys
    }
  }
  throw lastErr ?? new Error("Birdeye: no valid keys");
}

// Birdeye OHLCV by token mint (address_type=token) — used by chart.js Fib logic
async function birdeyeOHLCVByMint(tokenMint, type, limit, chain) {
  return withBirdeyeKeyRotation(key => _birdeyeOHLCVByMintOnce(tokenMint, type, limit, chain, key));
}

async function _birdeyeOHLCVByMintOnce(tokenMint, type, limit, chain, apiKey) {
  return withRetry(async () => {
    const typeMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1D": "1D", "1d": "1D" };
    const bType = typeMap[type] ?? "5m";
    const intervalSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400, "1d": 86400 }[type] ?? 300;
    const now      = Math.floor(Date.now() / 1000);
    const timeFrom = now - intervalSec * limit;
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenMint}&address_type=token&type=${bType}&time_from=${timeFrom}&time_to=${now}`,
      { headers: birdeyeHeaders(chain, apiKey), signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("Birdeye 429");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("Birdeye 401");
      throw new Error(`Birdeye OHLCV error: ${res.status}`);
    }
    const data  = await res.json();
    const items = data?.data?.items;
    if (!items || items.length === 0) throw new Error("Birdeye: empty OHLCV");
    return items.map(item => ({
      timestamp: item.unixTime,
      open: Number(item.o), high: Number(item.h), low: Number(item.l), close: Number(item.c), volume: Number(item.v),
    }));
  });
}

// Birdeye OHLCV by pool/pair address
async function birdeyeOHLCVByPair(poolAddress, timeframe, limit, chain) {
  return withBirdeyeKeyRotation(key => _birdeyeOHLCVByPairOnce(poolAddress, timeframe, limit, chain, key));
}

async function _birdeyeOHLCVByPairOnce(poolAddress, timeframe, limit, chain, apiKey) {
  return withRetry(async () => {
    const typeMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1D": "1D", "1d": "1D" };
    const bType = typeMap[timeframe] ?? "5m";
    const intervalSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400, "1d": 86400 }[timeframe] ?? 300;
    const now      = Math.floor(Date.now() / 1000);
    const timeFrom = now - intervalSec * limit;
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/ohlcv/pair?address=${poolAddress}&type=${bType}&time_from=${timeFrom}&time_to=${now}`,
      { headers: birdeyeHeaders(chain, apiKey), signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("Birdeye 429");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("Birdeye 401");
      throw new Error(`Birdeye OHLCV error: ${res.status}`);
    }
    const data  = await res.json();
    const items = data?.data?.items;
    if (!items || items.length === 0) throw new Error("Birdeye: empty OHLCV");
    return items.map(item => ({
      timestamp: item.unixTime,
      open: Number(item.o), high: Number(item.h), low: Number(item.l), close: Number(item.c), volume: Number(item.v),
    }));
  });
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────

const GT_HEADERS = { "Accept": "application/json;version=20230302" };

async function geckoPoolData(poolAddress, chain) {
  return withRetry(async () => {
    const network = chain === "solana" ? "solana" : chain;
    const res = await fetch(`${GECKOTERMINAL_BASE}/networks/${network}/pools/${poolAddress}`, { headers: GT_HEADERS, signal: sig(TIMEOUT_MS) });
    if (res.status === 429) throw new Error("GeckoTerminal 429");
    if (!res.ok) throw new Error(`GeckoTerminal pool error: ${res.status}`);
    const data  = await res.json();
    const attrs = data?.data?.attributes;
    if (!attrs) throw new Error("GeckoTerminal: no pool attributes");
    return {
      poolAddress, chain,
      baseToken:  { address: data.data?.relationships?.base_token?.data?.id?.split("_")[1] ?? null, symbol: attrs.base_token_symbol },
      quoteToken: { address: data.data?.relationships?.quote_token?.data?.id?.split("_")[1] ?? null, symbol: attrs.quote_token_symbol },
      price:      parseFloat(attrs.base_token_price_usd) || null,
      mcap:       parseFloat(attrs.market_cap_usd) || null,
      volume: {
        m5:  parseFloat(attrs.volume_usd?.m5  ?? 0),
        h1:  parseFloat(attrs.volume_usd?.h1  ?? 0),
        h6:  parseFloat(attrs.volume_usd?.h6  ?? 0),
        h24: parseFloat(attrs.volume_usd?.h24 ?? 0),
      },
      liquidity: parseFloat(attrs.reserve_in_usd) || null,
      dex:       null,
      _source:   "geckoterminal",
    };
  });
}

// GeckoTerminal token info — includes top_pools sorted by relevance (most active pool first)
async function geckoTokenInfo(tokenMint, chain) {
  return withRetry(async () => {
    const network = chain === "solana" ? "solana" : chain;
    const res = await fetch(`${GECKOTERMINAL_BASE}/networks/${network}/tokens/${tokenMint}`, { headers: GT_HEADERS, signal: sig(TIMEOUT_MS) });
    if (res.status === 429) throw new Error("GeckoTerminal 429");
    if (!res.ok) throw new Error(`GeckoTerminal token info error: ${res.status}`);
    const data = await res.json();
    return data;
  });
}

async function geckoOHLCV(poolAddress, chain, timeframe, limit) {
  return withRetry(async () => {
    const network = chain === "solana" ? "solana" : chain;
    const aggMap  = { "1m": ["minute","1"], "5m": ["minute","5"], "15m": ["minute","15"], "1h": ["hour","1"], "4h": ["hour","4"], "1D": ["day","1"], "1d": ["day","1"] };
    const [agg, mult] = aggMap[timeframe] ?? ["minute","5"];
    const res = await fetch(
      `${GECKOTERMINAL_BASE}/networks/${network}/pools/${poolAddress}/ohlcv/${agg}?aggregate=${mult}&limit=${limit}`,
      { headers: GT_HEADERS, signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("GeckoTerminal 429");
    if (!res.ok) throw new Error(`GeckoTerminal OHLCV error: ${res.status}`);
    const data      = await res.json();
    const ohlcvList = data?.data?.attributes?.ohlcv_list;
    if (!ohlcvList || ohlcvList.length === 0) throw new Error("GeckoTerminal: empty OHLCV");
    return ohlcvList.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts,
      open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v),
    }));
  });
}

// ─── Jupiter Quote (SOL → token) ─────────────────────────────────────────────
// Last-resort price: get token/USD by quoting SOL → token, then invert.
async function jupiterQuotePrice(tokenMint, chain = "solana") {
  return withRetry(async () => {
    const amountStr = (1e9).toString(); // 1 SOL in lamports
    const res = await fetch(
      `${JUPITER_QUOTE_API}/quote?inputMint=${SOL_MINT}&outputMint=${tokenMint}&amount=${amountStr}&slippageBps=500`,
      { signal: sig(TIMEOUT_MS) }
    );
    if (res.status === 429) throw new Error("Jupiter 429");
    if (!res.ok) throw new Error(`Jupiter quote error: ${res.status}`);
    const data = await res.json();
    const inAmount  = Number(data.inAmount);
    const outAmount = Number(data.outAmount);
    if (!inAmount || !outAmount) throw new Error("Jupiter: missing inAmount/outAmount");
    const pricePerTokenLamports = inAmount / outAmount;
    const solUsd = await jupiterSolPrice();
    const priceUSD = pricePerTokenLamports * solUsd;
    if (!priceUSD || priceUSD <= 0) throw new Error("Jupiter: invalid priceUSD");
    log.debug("screening", `jupiterQuotePrice: ${tokenMint} = $${priceUSD} (SOL/USD=${solUsd})`);
    return priceUSD;
  });
}

async function jupiterSolPrice() {
  const res = await fetch(`${JUPITER_PRICE_API}?ids=${SOL_MINT}`, { signal: sig(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Jupiter price error: ${res.status}`);
  const data = await res.json();
  // v3 response: { "So1111...": { usdPrice: 81.7, ... } }
  const entry = data?.[SOL_MINT];
  const price = entry?.usdPrice ?? entry?.price;
  if (!price || price <= 0) throw new Error("Jupiter: missing SOL/USD");
  return price;
}

// ─── Reliable USD Price (last-resort chain) ───────────────────────────────────
// Priority: GeckoTerminal → Birdeye → Jupiter quote (SOL→token→USD) → Dexscreener priceUsd → null
// Returns: { price: number, source: string } | null
async function getReliableUSDPrice(tokenMint, poolAddress = null, chain = "solana") {
  // 1. GeckoTerminal (primary — most reliable for USD)
  if (poolAddress) {
    try {
      const pool = await geckoPoolData(poolAddress, chain);
      if (pool.price && pool.price > 0) {
        log.screening(`  [price] GeckoTerminal → $${pool.price.toPrecision(4)}`);
        return { price: pool.price, source: "geckoterminal" };
      }
      log.screening(`  [price] GeckoTerminal → null (no price in pool data)`);
    } catch (err) {
      log.screening(`  [price] GeckoTerminal → FAILED (${err.message})`);
    }
  }

  // 2. Birdeye
  if (poolAddress) {
    try {
      const pool = await birdeyePoolData(poolAddress, chain);
      if (pool.price && pool.price > 0) {
        log.screening(`  [price] Birdeye → $${pool.price.toPrecision(4)}`);
        return { price: pool.price, source: "birdeye" };
      }
      log.screening(`  [price] Birdeye → null (no price in pool data)`);
    } catch (err) {
      log.screening(`  [price] Birdeye → FAILED (${err.message})`);
    }
  }

  // 3. Jupiter quote (SOL → token → USD)
  try {
    const price = await jupiterQuotePrice(tokenMint, chain);
    if (price && price > 0) {
      log.screening(`  [price] Jupiter quote → $${price.toPrecision(4)} (SOL→token→USD)`);
      return { price, source: "jupiter-quote" };
    }
    log.screening(`  [price] Jupiter quote → null (invalid price)`);
  } catch (err) {
    log.screening(`  [price] Jupiter quote → FAILED (${err.message})`);
  }

  // 4. Last resort: Dexscreener priceUsd
  if (poolAddress) {
    try {
      const pool = await dexscreenerPoolData(poolAddress, chain);
      if (pool.price && pool.price > 0) {
        log.warn("screening", `  [price] Dexscreener LAST RESORT → $${pool.price.toPrecision(4)} (unreliable — use with caution)`);
        return { price: pool.price, source: "dexscreener-last-resort" };
      }
      log.screening(`  [price] Dexscreener → null (no price in pool data)`);
    } catch (err) {
      log.screening(`  [price] Dexscreener → FAILED (${err.message})`);
    }
  }

  log.warn("screening", `ALL PRICE SOURCES FAILED for ${tokenMint} — pool=${poolAddress ?? "none"}`);
  return null;
}

// ─── HybridDataProvider ───────────────────────────────────────────────────────

export class HybridDataProvider {
  /**
   * Pool metadata (price in USD, mcap, volume, liquidity).
   * Priority: Dexscreener (primary) → Birdeye (fallback) → GeckoTerminal (last resort).
   * Dexscreener is primary because it has highest rate limits and best freshness for pool data.
   * Birdeye used only for Fib/RSI/EMA technical analysis (called on capped 10 candidates max).
   * @param {string} poolAddress
   * @param {string} [chain="solana"]
   */
  async getPoolData(poolAddress, chain = "solana") {
    try {
      const data = await dexscreenerPoolData(poolAddress, chain);
      log.debug("screening", `getPoolData: Dexscreener OK`, { pool: poolAddress });
      return data;
    } catch (err) {
      log.warn("screening", `getPoolData: Dexscreener failed → Birdeye (${err.message})`, { pool: poolAddress });
    }

    try {
      const data = await birdeyePoolData(poolAddress, chain);
      log.debug("screening", `getPoolData: Birdeye OK`, { pool: poolAddress });
      return data;
    } catch (err) {
      log.warn("screening", `getPoolData: Birdeye failed → GeckoTerminal (${err.message})`, { pool: poolAddress });
    }

    const data = await geckoPoolData(poolAddress, chain);
    log.warn("screening", `getPoolData: GeckoTerminal (last resort)`, { pool: poolAddress });
    return data;
  }

  /**
   * OHLCV candles. Oldest-first.
   *
   * Priority:
   *   tokenMint provided:   GeckoTerminal (primary, USD) → Birdeye (fallback, USD) → throw (skip candidate)
   *   poolAddress only:      GeckoTerminal (primary, USD) → Birdeye (fallback, USD) → throw (skip candidate)
   *
   * Dexscreener OHLCV is SKIPPED — it returns SOL-denominated prices for TOKEN/SOL pairs,
   * causing unit mismatch against USD currentPrice in Fib analysis.
   *
   * Birdeye is last-resort fallback to conserve its 30k/month API quota.
   * If both GeckoTerminal AND Birdeye fail for a candidate → throw (skip, do NOT use degraded TA).
   *
   * @param {string} poolAddress
   * @param {string} [timeframe="5m"]
   * @param {number} [limit=100]
   * @param {string} [chain="solana"]
   * @param {string} [tokenMint=null]
   */
  async getOHLCV(poolAddress, timeframe = "5m", limit = 100, chain = "solana", tokenMint = null) {
    const MIN_CANDLES = 6;

    // ── GeckoTerminal primary (always available when poolAddress is known) ──────
    if (poolAddress) {
      try {
        const candles = await geckoOHLCV(poolAddress, chain, timeframe, limit);
        log.debug("screening", `getOHLCV: GeckoTerminal OK (${candles.length} candles)`, { pool: poolAddress });

        // Pool-specific candle data may be thin for newly-created pools.
        // If insufficient, fetch the most active pool for this token via GeckoTerminal
        // token info (top_pools[0] — sorted by relevance/TVL) and retry OHLCV with that.
        if (candles.length < MIN_CANDLES && tokenMint) {
          log.warn("screening", `getOHLCV: GeckoTerminal thin (${candles.length} < ${MIN_CANDLES}) → fetching top pool for ${tokenMint}`);
          try {
            const tokenData = await geckoTokenInfo(tokenMint, chain);
            const topPoolId = tokenData?.data?.relationships?.top_pools?.data?.[0]?.id;
            const topPoolAddress = topPoolId?.split("_")[1] ?? null;
            if (topPoolAddress && topPoolAddress !== poolAddress) {
              log.warn("screening", `getOHLCV: top pool ${topPoolAddress} != current ${poolAddress} → retrying OHLCV with top pool`);
              const topCandles = await geckoOHLCV(topPoolAddress, chain, timeframe, limit);
              log.debug("screening", `getOHLCV: top pool OHLCV OK (${topCandles.length} candles)`, { pool: topPoolAddress });
              return topCandles;
            }
          } catch (err) {
            log.warn("screening", `getOHLCV: top pool fetch failed → Birdeye token mint fallback (${err.message})`);
          }

          // Fallback to Birdeye token mint if top pool retry also thin
          try {
            const tokenCandles = await birdeyeOHLCVByMint(tokenMint, timeframe, limit, chain);
            log.debug("screening", `getOHLCV: Birdeye token mint OK (${tokenCandles.length} candles)`, { token: tokenMint });
            return tokenCandles;
          } catch {
            log.warn("screening", `getOHLCV: Birdeye token mint also thin — using GeckoTerminal (${candles.length} candles)`, { pool: poolAddress });
          }
        }
        return candles;
      } catch (err) {
        log.warn("screening", `getOHLCV: GeckoTerminal failed → Birdeye (${err.message})`, { pool: poolAddress });
      }
    }

    // ── Birdeye fallback (only when tokenMint available) ───────────────────────
    if (tokenMint) {
      try {
        const candles = await birdeyeOHLCVByMint(tokenMint, timeframe, limit, chain);
        log.debug("screening", `getOHLCV: Birdeye token OK (${candles.length} candles)`, { token: tokenMint });
        return candles;
      } catch (err) {
        log.warn("screening", `getOHLCV: Birdeye fallback failed → skip candidate (${err.message})`, { token: tokenMint });
      }
    }

    // ── Both failed → skip candidate (degraded TA is worse than missed opportunity) ──
    throw new Error(`getOHLCV: both GeckoTerminal and Birdeye failed for ${poolAddress ?? tokenMint} — candidate skipped`);
  }

  /**
   * Last-resort USD price finder.
   * Priority: GeckoTerminal → Birdeye → Jupiter quote (SOL→token→USD) → Dexscreener priceUsd → null.
   * Logs "ALL PRICE SOURCES FAILED" if every source returns null/throws.
   * @param {string} tokenMint
   * @param {string|null} poolAddress
   * @param {string} [chain="solana"]
   * @returns {{ price: number, source: string } | null}
   */
  async getReliableUSDPrice(tokenMint, poolAddress = null, chain = "solana") {
    return getReliableUSDPrice(tokenMint, poolAddress, chain);
  }
}

export const hybridDataProvider = new HybridDataProvider();
