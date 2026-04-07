# Prospera — Project Context

Arsitektur final dan status fitur.

---

## Stack

- Node.js ES modules, PM2 ID 0, Solana/Meteora DLMM
- Strategy: Fibonacci retracement + single-sided bid_ask
- LLM: deepseek-v3.2 (management), qwen3.5-flash (screening)

---

## Data Layer — HybridDataProvider (`tools/dataProvider.js`)

Wajib untuk semua data. Fallback: **Dexscreener → Birdeye → GeckoTerminal**.

```js
getPoolData(poolAddress, chain)
getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)
  // tokenMint → Birdeye token first → DS → GT
  // no tokenMint → DS → Birdeye pair → GT
```

Trigger fallback: timeout >3s, HTTP 429, error. 1 retry on 429.

---

## Screening Pipeline

```
Dexscreener boosts/profiles (SOL pair)
→ 1h volume ≥ $180k
→ mcap ≥ $200k pre-filter
→ RugCheck (bundle %, honeypot, creator)
→ Jupiter (top10, botHolders, feesSOL)
→ Meteora bulk fetch page_size=100 (client-side match + age filter)
→ RocketScan fallback (pool baru belum diindex)
→ Broken support cache (skip if cached < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
→ Smart wallet boost +0.10
→ Sort confluenceScore DESC
```

---

## Entry Rules (`tools/chart.js`)

```
calcFibLevels()
  → HARD GATE: price < fib500 → skip "below Fib 0.500 — no entry allowed"
  → Zone: ATH (>fib236) or PRIMARY (fib236–fib382) only
  → EMA20 > EMA50 required
  → RSI > 48 AND slope > 0 required
```

---

## Broken Support Cache

- File: `broken-support-cache.json` (persists PM2 restart)
- Trigger: price < fib618 OR crash ≥80%/24h
- Stored: `{ cachedAt, priceAtRejection, athAtRejection }`
- Invalidate: ONLY if `currentPrice > athAtRejection`
- Duration: 24h

---

## Locks

**Screening** — `screening-lock.json` `{ ts, pid, status }`
- `running` → block unconditional
- `done && age < 60s` → block
- All early-returns: `_releaseAndSkip()` releases both file + in-process

**Management** — `management.lock`, gap 45s minimum

---

## Management Rules

| Trigger | Action |
|---------|--------|
| PnL ≤ -20% | CLOSE |
| PnL ≥ 25% | CLOSE |
| PnL 10–25% | CLOSE (partial harvest) |
| OOR >10m + bins>20 | CLOSE |
| fee/TVL <1% after 60m | CLOSE |

LLM zone: 5–25%.

---

## Deploy Sizing

```
< 8 SOL   → 1.5    8–15 → 2.8    15–25 → 4.2
25–40 → 6.0        > 40  → min(18%, 9 SOL)
```

Cap: 60% wallet. Gas reserve: 0.5 SOL.

---

## Feature Status

- [x] HybridDataProvider — `getOHLCV` unified, no direct API calls
- [x] Hard gate fib500 before indicators
- [x] Broken support cache (file-based, ATH-only invalidation)
- [x] Deploy-time fib500 re-check (executor.js)
- [x] File-based screening lock (no double screening after restart)
- [x] Telegram unified format (header in `finally`)
- [x] Dexscreener-first discovery
- [x] RocketScan fallback
- [x] Tiered sizing + 60% exposure cap
- [x] Partial harvest 10%
- [x] Darwinian signal weighting
- [x] RPC failover 5 endpoints
- [x] Management optimization (5m, 512 tokens)
- [ ] Darwinian weights: need 6+ closed positions
- [ ] Monitor entry rate

---

## API Notes

**RugCheck**: `https://api.rugcheck.xyz/v1/tokens/{mint}/report` — public, no key

**Meteora Pool Discovery**: `https://pool-discovery-api.datapi.meteora.ag`
- Invalid filters: `base_token_address`, `base_token_age_hours` → client-side
- Valid timeframes: `5m` `1h` `4h` `12h` `24h` (not `1d`)
