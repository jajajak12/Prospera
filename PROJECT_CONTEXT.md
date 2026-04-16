# Prospera — Project Context

---

## Stack

Node.js ES modules · PM2 ID 0 · Solana/Meteora DLMM
LLM: deepseek-v3.2 (management) · qwen3.5-flash (screening)

---

## HybridDataProvider (`tools/dataProvider.js`)

ALL data must go through `hybridDataProvider`. Fallback: **Dexscreener → Birdeye → GeckoTerminal**.

```js
getPoolData(poolAddress, chain)
getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)
  // tokenMint → Birdeye token first → DS → GT
  // no tokenMint → DS → Birdeye pair → GT
```

---

## Screening Pipeline (`tools/screening.js`)

```
Dexscreener boosts/profiles (SOL pair)
→ 1h volume ≥ $180k · mcap ≥ $200k
→ RugCheck (bundle%, honeypot, creator)
→ Jupiter (top10, botHolders, feesSOL)
→ Meteora bulk fetch page_size=100 (client-side match + age filter)
→ RocketScan fallback
→ Broken support cache (skip if cached < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
→ Smart wallet +0.10 · sort confluenceScore DESC
```

---

## Entry Rules (`tools/chart.js`)

```
calcFibLevels()
→ HARD GATE: price < fib500 → skip "below Fib 0.500 — no entry allowed"
→ Zone: ATH (>fib236) or PRIMARY (fib236–fib382)
→ EMA20 > EMA50
→ RSI > 48 AND slope > 0
```

---

## Broken Support Cache

File: `broken-support-cache.json` · Duration: 24h
Trigger: price < fib618 OR crash ≥80%/24h
Stored: `{ cachedAt, priceAtRejection, athAtRejection }`
Invalidate: ONLY if `currentPrice > athAtRejection`

---

## Deploy Gate (`tools/executor.js`)

Reads `fib500` from `screening-pending.json`, fetches live price.
Blocks deploy if `livePrice < fib500`.

---

## Locks

`screening-lock.json` — `running` blocks unconditional · `done && <60s` blocks
All early-returns: `_releaseAndSkip()` · `finally` always releases both locks

`management.lock` — 45s minimum gap

---

## Management Rules

| Trigger | Action |
|---------|--------|
| PnL ≤ -20% | CLOSE |
| PnL ≥ 25% | CLOSE |
| PnL 10–25% | CLOSE (partial harvest) |
| OOR >10m + bins>20 | CLOSE |
| fee/TVL <1% after 60m | CLOSE |
| loss ≥3× unclaimed fees after 2h | CLOSE (IL > fees) |
| fees ≥2% position value AND price ≥ fib382 | CLAIM FEES |

LLM zone: 5–25%.

---

## Deploy Sizing

```
<8→1.5  8–15→2.8  15–25→4.2  25–40→6.0  >40→min(18%,9)
Cap: 60% wallet · Gas reserve: 0.5 SOL
```

---

## Status

- [x] HybridDataProvider — `getOHLCV` unified, no direct API calls
- [x] Hard gate fib500 before indicators
- [x] Broken support cache (file-based, ATH-only invalidation)
- [x] Deploy-time fib500 gate
- [x] File-based screening lock (no double screening)
- [x] Telegram unified format
- [x] Tiered sizing + 60% cap · Partial harvest · RPC failover
- [x] Chart lesson analysis — LLM evaluates why trade succeeded/failed, saves to lessons.json
- [x] Signal weights defensive load — handles missing/corrupt history field
- [x] Auto-claim fees — triggers when fees ≥2% position value AND price ≥ fib382
- [x] Exit rule — close when loss ≥3× unclaimed fees after 2h (IL overtaking fees)
- [ ] Darwinian weights: need 6+ closed positions
- [ ] Monitor entry rate

---

## Meteora API

Invalid filters: `base_token_address`, `base_token_age_hours` → client-side only
Valid timeframes: `5m` `1h` `4h` `12h` `24h` (not `1d`)
