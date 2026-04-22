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
 *   GeckoTerminal (primary) → Birdeye (fallback) → Dexscreener chart (last resort) → skip candidate
 *
 * Tujuan: Menghemat Birdeye API quota (30k/bulan).
 * Birdeye sekarang hanya dipakai sebagai fallback untuk OHLCV.
 * Jika semua source gagal → skip kandidat + notif Telegram dengan token address + alasan error.
 *
 * Fallback triggers: timeout > 3s, HTTP 429, any thrown error.
 * Each source: 1 retry on 429 before falling back to next.
 */

import { log } from "../logger.js";
import { sendHTML as telegramSendHTML } from "../telegram.js";

const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const BIRDEYE_BASE       = "https://public-api.birdeye.so";
const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const CODEX_BASE         = "https://graph.codex.io/graphql";
const CODEX_SOLANA_NET   = 1399811149;
const JUPITER_QUOTE_API  = "https://api.jup.ag/swap/v1";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const SOL_MINT           = "So11111111111111111111111111111111111111112"; // wrapped SOL
const TIMEOUT_MS = 3000;

// Birdeye multi-key support — rotate on 401
const _birdeyeKeys = () => [
  process.env.BIRDEYE_API_KEY,
  process.env.BIRDEYE_API_KEY_2,
  process.env.BIRDEYE_API_KEY_3,
  process.env.BIRDEYE_API_KEY_4,
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

// Dexscreener OHLCV via priceHistory from pair or token endpoint.
// poolCandidates: array of pool addresses to try in order (lowercase first per DS convention).
async function dexscreenerOHLCV(primaryPool, chain, tokenMint = null, poolCandidates = []) {
  return withRetry(async () => {
    const parseBars = (bars) => bars
      .filter(b => b && (b.t || b.time))
      .map(b => ({
        timestamp: b.t ?? b.time,
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v) || 0,
      }));

    const allPools = [...new Set([
      ...(poolCandidates.length ? poolCandidates : [primaryPool]),
    ].filter(Boolean))];

    // Try each pool candidate against DS pair endpoint
    for (const addr of allPools) {
      const res = await fetch(
        `${DEXSCREENER_BASE}/latest/dex/pairs/${chain}/${addr}`,
        { signal: sig(TIMEOUT_MS) }
      );
      if (res.status === 429) throw new Error("Dexscreener 429");
      if (!res.ok) continue;
      const data = await res.json();
      const pair = data?.pair ?? data?.pairs?.[0];
      const bars = pair?.priceHistory;
      if (bars && bars.length > 0) return parseBars(bars);
    }

    // Fallback: token endpoint — pick highest-volume pair
    if (tokenMint) {
      const res = await fetch(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`,
        { signal: sig(TIMEOUT_MS) }
      );
      if (res.status === 429) throw new Error("Dexscreener 429");
      if (res.ok) {
        const data = await res.json();
        const pairs = (data?.pairs ?? [])
          .sort((a, b) => (Number(b.volume?.h24) || 0) - (Number(a.volume?.h24) || 0));
        for (const pair of pairs.slice(0, 3)) {
          const bars = pair?.priceHistory;
          if (bars && bars.length > 0) return parseBars(bars);
        }
      }
    }

    throw new Error("Dexscreener OHLCV: no priceHistory from any pool or token endpoint");
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
    if (res.status === 400) throw new Error("Birdeye: token not indexed (400)");
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

// Dedup map for OHLCV failure Telegram notifications — max 1 notif per token per 30 minutes
const _ohlcvFailNotified = new Map(); // tokenMint → lastNotifiedAtMs
const OHLCV_NOTIF_COOLDOWN_MS = 30 * 60 * 1000;


// Cache SOL/USD price for 60s — shared across all getOHLCV calls within a screening cycle
let _solPriceCache = null;
let _solPriceCachedAt = 0;
async function jupiterSolPrice() {
  const now = Date.now();
  if (_solPriceCache && now - _solPriceCachedAt < 60_000) return _solPriceCache;
  const res = await fetch(`${JUPITER_PRICE_API}?ids=${SOL_MINT}`, { signal: sig(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Jupiter price error: ${res.status}`);
  const data = await res.json();
  // v3 response: { "So1111...": { usdPrice: 81.7, ... } }
  const entry = data?.[SOL_MINT];
  const price = entry?.usdPrice ?? entry?.price;
  if (!price || price <= 0) throw new Error("Jupiter: missing SOL/USD");
  _solPriceCache = price;
  _solPriceCachedAt = now;
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
  log("price", `Final USD price for ${tokenMint}: null (ALL SOURCES FAILED)`);
  return null;
}

// ─── Reliable SOL Price (last-resort chain) ──────────────────────────────────
// Priority: GeckoTerminal OHLCV last close (native SOL) → Birdeye USD ÷ solPrice → null
// Returns: { price: number, source: string } | null
async function getReliableSOLPrice(tokenMint, poolAddress = null, chain = "solana") {
  // 1. GeckoTerminal OHLCV last close (native SOL for TOKEN/SOL pools)
  if (poolAddress) {
    try {
      const candles = await geckoOHLCV(poolAddress, chain, "5m", 5);
      const last = candles[candles.length - 1];
      if (last?.close > 0) {
        log.screening(`  [sol-price] GeckoTerminal OHLCV → ${last.close.toPrecision(4)} SOL`);
        return { price: last.close, source: "geckoterminal-ohlcv" };
      }
    } catch (err) {
      log.screening(`  [sol-price] GeckoTerminal → FAILED (${err.message})`);
    }
  }

  // 2. Birdeye OHLCV USD ÷ solPrice → SOL
  if (tokenMint) {
    try {
      const [usdCandles, solPrice] = await Promise.all([
        birdeyeOHLCVByMint(tokenMint, "5m", 5, chain),
        jupiterSolPrice(),
      ]);
      const last = usdCandles[usdCandles.length - 1];
      if (last?.close > 0 && solPrice > 0) {
        const priceSOL = last.close / solPrice;
        log.screening(`  [sol-price] Birdeye USD÷${solPrice.toFixed(0)} → ${priceSOL.toPrecision(4)} SOL`);
        return { price: priceSOL, source: "birdeye-ohlcv" };
      }
    } catch (err) {
      log.screening(`  [sol-price] Birdeye → FAILED (${err.message})`);
    }
  }

  log.warn("screening", `ALL SOL PRICE SOURCES FAILED for ${tokenMint} — pool=${poolAddress ?? "none"}`);
  return null;
}

// ─── Codex.io ────────────────────────────────────────────────────────────────

// Codex GraphQL OHLCV — last fallback when GT + Birdeye + Dexscreener all fail.
// Returns USD prices → caller divides by solPrice to get SOL denomination.
// Tries poolAddress first (most accurate for TOKEN/SOL pairs), then tokenMint.
async function codexOHLCV(timeframe, limit, tokenMint) {
  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) throw new Error("CODEX_API_KEY not configured");
  if (!tokenMint) throw new Error("Codex: tokenMint required");

  const resMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1D": "1D", "1d": "1D" };
  const resolution = resMap[timeframe] ?? "5";
  const intervalSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400, "1d": 86400 }[timeframe] ?? 300;
  const to   = Math.floor(Date.now() / 1000);
  const from = to - intervalSec * limit;

  const symbol = `${tokenMint}:${CODEX_SOLANA_NET}`;
  const query = `query GetBars($symbol: String!, $from: Int!, $to: Int!, $resolution: String!) {
    getBars(symbol: $symbol, from: $from, to: $to, resolution: $resolution) { o h l c v t }
  }`;

  const res = await fetch(CODEX_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": apiKey },
    body: JSON.stringify({ query, variables: { symbol, from, to, resolution } }),
    signal: sig(TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("Codex 429");
  if (!res.ok) throw new Error(`Codex error: ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(`Codex GraphQL: ${data.errors[0]?.message}`);
  const bars = data?.data?.getBars;
  if (!bars) throw new Error("Codex: null response");

  // Codex returns columnar format: { t: [...], o: [...], h: [...], l: [...], c: [...], v: [...] }
  if (Array.isArray(bars.t)) {
    if (bars.t.length === 0) throw new Error("Codex: empty OHLCV");
    return bars.t.map((t, i) => ({
      timestamp: Number(t),
      open: Number(bars.o[i]), high: Number(bars.h[i]),
      low: Number(bars.l[i]), close: Number(bars.c[i]),
      volume: Number(bars.v[i]) || 0,
    }));
  }
  // Fallback: row format [{ t, o, h, l, c, v }, ...]
  if (Array.isArray(bars)) {
    if (bars.length === 0) throw new Error("Codex: empty OHLCV");
    return bars.map(b => ({
      timestamp: Number(b.t),
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v) || 0,
    }));
  }
  throw new Error("Codex: unexpected response format");
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
   * OHLCV candles. Oldest-first. ALL PRICES IN SOL DENOMINATION.
   *
   * Priority:
   *   GeckoTerminal (primary, native SOL for TOKEN/SOL pools)
   *   → Birdeye USD ÷ solPrice (fallback)
   *   → Dexscreener chart USD ÷ solPrice (last resort)
   *   → throw (skip candidate) + Telegram notif
   *
   * GeckoTerminal returns TOKEN/SOL prices natively — no conversion needed.
   * Birdeye + Dexscreener return USD → divided by solPrice to normalize to SOL.
   *
   * @param {string} poolAddress
   * @param {string} [timeframe="5m"]
   * @param {number} [limit=100]
   * @param {string} [chain="solana"]
   * @param {string} [tokenMint=null]
   */
  async getOHLCV(poolAddress, timeframe = "5m", limit = 100, chain = "solana", tokenMint = null) {
    const MIN_CANDLES = 6;
    const errors = {};

    // ── Step 0: Resolve canonical pool via GT token info ─────────────────────
    // pump.fun pool address ≠ Meteora pool address.
    // GT/DS need the pump.fun pool. geckoTokenInfo returns GT's indexed top pool.
    let canonicalPool = null;
    if (tokenMint) {
      try {
        const tokenData = await geckoTokenInfo(tokenMint, chain);
        const topPoolId = tokenData?.data?.relationships?.top_pools?.data?.[0]?.id;
        canonicalPool = topPoolId?.split("_")[1] ?? null;
        if (canonicalPool) {
          log.debug("screening", `getOHLCV: canonical pool = ${canonicalPool}`, { token: tokenMint });
        }
      } catch (err) {
        log.warn("screening", `getOHLCV: GT token info failed (${err.message}) — using Meteora pool`, { token: tokenMint });
        if (err.message?.includes("429")) await new Promise(r => setTimeout(r, 8000));
      }
    }
    // Fallback to Meteora pool if GT token info failed
    const gtPool = canonicalPool ?? poolAddress;

    // ── 1. GeckoTerminal PRIMARY — native SOL denomination ───────────────────
    if (gtPool) {
      try {
        const candles = await geckoOHLCV(gtPool, chain, timeframe, limit);
        if (candles.length >= 5) {
          log.debug("screening", `getOHLCV: GeckoTerminal OK (${candles.length} candles, SOL-native)`, { pool: gtPool });
          return candles;
        }
        if (candles.length > 0) {
          errors.gt = `thin (${candles.length})`;
          log.warn("screening", `getOHLCV: GT thin (${candles.length}) → DS`, { pool: gtPool });
        } else {
          errors.gt = "empty";
        }
      } catch (err) {
        errors.gt = err.message;
        log.warn("screening", `getOHLCV: GeckoTerminal failed → DS (${err.message})`, { pool: gtPool });
        if (err.message?.includes("429")) await new Promise(r => setTimeout(r, 8000));
      }
    } else {
      errors.gt = "no pool resolved";
    }

    // ── 2. Dexscreener SECONDARY — USD ÷ solPrice → SOL ─────────────────────
    // DS uses lowercase pool address. Try canonical pool first, then Meteora pool.
    const dsPools = [...new Set([
      canonicalPool?.toLowerCase(),
      canonicalPool,
      poolAddress?.toLowerCase(),
      poolAddress,
    ].filter(Boolean))];

    if (dsPools.length > 0 || tokenMint) {
      try {
        const [usdCandles, solPrice] = await Promise.all([
          dexscreenerOHLCV(dsPools[0] ?? null, chain, tokenMint, dsPools),
          jupiterSolPrice(),
        ]);
        if (!solPrice || solPrice <= 0) throw new Error("solPrice unavailable");
        const toSOL = c => ({
          timestamp: c.timestamp,
          open: c.open / solPrice, high: c.high / solPrice,
          low:  c.low  / solPrice, close: c.close / solPrice,
          volume: c.volume,
        });
        const candles = usdCandles.map(toSOL);
        if (candles.length >= MIN_CANDLES) {
          log.debug("screening", `getOHLCV: Dexscreener OK (${candles.length} candles, USD÷${solPrice.toFixed(2)}→SOL)`);
          return candles;
        }
        errors.dexscreener = `thin (${candles.length})`;
      } catch (err) {
        errors.dexscreener = err.message;
        log.warn("screening", `getOHLCV: Dexscreener failed (${err.message})`);
      }
    } else {
      errors.dexscreener = "no pool";
    }

    // ── 3. Birdeye FALLBACK — USD ÷ solPrice → SOL ───────────────────────────
    if (tokenMint) {
      try {
        const [usdCandles, solPrice] = await Promise.all([
          birdeyeOHLCVByMint(tokenMint, timeframe, limit, chain),
          jupiterSolPrice(),
        ]);
        if (!solPrice || solPrice <= 0) throw new Error("solPrice unavailable");
        const toSOL = c => ({
          timestamp: c.timestamp,
          open: c.open / solPrice, high: c.high / solPrice,
          low:  c.low  / solPrice, close: c.close / solPrice,
          volume: c.volume,
        });
        const candles = usdCandles.map(toSOL);
        if (candles.length >= MIN_CANDLES) {
          log.debug("screening", `getOHLCV: Birdeye OK (${candles.length} candles, USD÷${solPrice.toFixed(2)}→SOL)`, { token: tokenMint });
          return candles;
        }
        errors.birdeye = `thin (${candles.length})`;
      } catch (err) {
        errors.birdeye = err.message;
        log.warn("screening", `getOHLCV: Birdeye failed (${err.message})`, { token: tokenMint });
      }
    } else {
      errors.birdeye = "no tokenMint";
    }

    // ── 4. Codex LAST FALLBACK — USD ÷ solPrice → SOL ───────────────────────
    if (tokenMint) {
      try {
        const [usdCandles, solPrice] = await Promise.all([
          codexOHLCV(timeframe, limit, tokenMint),
          jupiterSolPrice(),
        ]);
        if (!solPrice || solPrice <= 0) throw new Error("solPrice unavailable");
        const toSOL = c => ({
          timestamp: c.timestamp,
          open: c.open / solPrice, high: c.high / solPrice,
          low:  c.low  / solPrice, close: c.close / solPrice,
          volume: c.volume,
        });
        const candles = usdCandles.map(toSOL);
        if (candles.length >= MIN_CANDLES) {
          log.debug("screening", `getOHLCV: Codex OK (${candles.length} candles, USD÷${solPrice.toFixed(2)}→SOL)`, { token: tokenMint });
          return candles;
        }
        errors.codex = `thin (${candles.length})`;
      } catch (err) {
        errors.codex = err.message;
        log.warn("screening", `getOHLCV: Codex failed (${err.message})`, { token: tokenMint });
      }
    } else {
      errors.codex = "no tokenMint";
    }

    // ── All sources failed ────────────────────────────────────────────────────
    const key = tokenMint ?? poolAddress;
    const now = Date.now();
    const lastNotified = _ohlcvFailNotified.get(key) ?? 0;
    if (now - lastNotified > OHLCV_NOTIF_COOLDOWN_MS) {
      _ohlcvFailNotified.set(key, now);
      const dsLink = `https://dexscreener.com/solana/${tokenMint ?? poolAddress}`;
      const msg = [
        `⚠️ <b>OHLCV Gagal — Kandidat Di-skip</b>`,
        ``,
        `<b>Token:</b> <code>${tokenMint ?? "—"}</code>`,
        `<b>Pool (canonical):</b> <code>${gtPool ?? "—"}</code>`,
        ``,
        `<b>Error per source:</b>`,
        `• GeckoTerminal: ${errors.gt ?? "—"}`,
        `• Dexscreener: ${errors.dexscreener ?? "—"}`,
        `• Birdeye: ${errors.birdeye ?? "—"}`,
        `• Codex: ${errors.codex ?? "—"}`,
        ``,
        `<b>Chart:</b> <a href="${dsLink}">Dexscreener</a>`,
      ].join("\n");
      telegramSendHTML(msg).catch(() => {});
    }

    throw new Error(`getOHLCV: all sources failed for ${key} — candidate skipped`);
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

  /**
   * Reliable SOL price for a token. Used for Fib gate at deploy time.
   * Priority: GeckoTerminal OHLCV last close (native SOL) → Birdeye USD ÷ solPrice → null.
   * @param {string} tokenMint
   * @param {string|null} poolAddress
   * @param {string} [chain="solana"]
   * @returns {{ price: number, source: string } | null}
   */
  async getReliableSOLPrice(tokenMint, poolAddress = null, chain = "solana") {
    return getReliableSOLPrice(tokenMint, poolAddress, chain);
  }
}

export const hybridDataProvider = new HybridDataProvider();
