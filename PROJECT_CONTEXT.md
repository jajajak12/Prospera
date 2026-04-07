# Prospera — Project Context

---

## Stack

- Node.js ES modules, PM2 ID 0, Solana/Meteora DLMM
- LLM: deepseek-v3.2 (management), qwen3.5-flash (screening)

---

## HybridDataProvider (`tools/dataProvider.js`)

```js
getPoolData(poolAddress, chain)
getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)
```

Fallback: **Dexscreener → Birdeye → GeckoTerminal**. 1 retry on 429.
- `tokenMint` ada → Birdeye token first
- `tokenMint` null → Dexscreener → Birdeye pair → GT

---

## Screening (`tools/screening.js`)

```
Dexscreener (boosts + profiles, SOL pair)
→ 1h volume ≥ $180k
→ mcap ≥ $200k
→ RugCheck (bundle %, honeypot, creator)
→ Jupiter (top10, botHolders, feesSOL)
→ Meteora bulk fetch (client-side match + age filter)
→ RocketScan fallback
→ Broken support cache (skip if < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
→ Smart wallet boost +0.10
→ Sort confluenceScore DESC
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

- File: `broken-support-cache.json`
- Trigger: price < fib618 OR crash ≥80%/24h
- Stored: `{ cachedAt, priceAtRejection, athAtRejection }`
- Invalidate: ONLY if `currentPrice > athAtRejection`
- Duration: 24h

---

## Deploy Gate (`tools/executor.js`)

Re-check live price vs `fib500` from `screening-pending.json` before deploy.
Block if `livePrice < fib500`.

---

## Locks

| File | Logic |
|------|-------|
| `screening-lock.json` | `running` → block; `done && <60s` → block; all early-returns call `_releaseAndSkip()` |
| `management.lock` | gap minimum 45s |

---

## Management Rules

| Trigger | Action |
|---------|--------|
| PnL ≤ -20% | CLOSE |
| PnL ≥ 25% | CLOSE |
| PnL 10–25% | CLOSE (partial harvest) |
| OOR >10m + bins>20 | CLOSE |
| fee/TVL <1% after 60m | CLOSE |

LLM zone: 5–25%. Model: deepseek-v3.2.

---

## Deploy Sizing

```
<8 SOL→1.5  8–15→2.8  15–25→4.2  25–40→6.0  >40→min(18%,9)
Cap: 60% wallet. Gas reserve: 0.5 SOL.
```

---

## Feature Status

- [x] HybridDataProvider unified (`getOHLCV`)
- [x] Hard gate fib500 before indicators
- [x] Broken support cache file-based, ATH-only invalidation
- [x] Deploy-time fib500 gate
- [x] File-based screening lock
- [x] Telegram unified format
- [x] Tiered sizing + 60% cap
- [x] Partial harvest 10%
- [x] Darwinian signal weighting
- [x] RPC failover 5 endpoints
- [ ] Darwinian weights need 6+ closed positions
- [ ] Monitor entry rate

---

## Meteora API Notes

- Invalid filters: `base_token_address`, `base_token_age_hours` → client-side
- Valid timeframes: `5m` `1h` `4h` `12h` `24h` (not `1d`)
