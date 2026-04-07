# Prospera — Project Context

Arsitektur final dan status fitur. Detail kode ada di file masing-masing.

---

## Stack

- **Runtime**: Node.js ES modules, PM2 process ID 0
- **Chain**: Solana — Meteora DLMM pools
- **Strategy**: Fibonacci retracement + single-sided bid_ask
- **LLM**: deepseek-v3.2 (management), qwen3.5-flash (screening)

---

## Data Layer

### HybridDataProvider (`tools/dataProvider.js`)

Semua data wajib lewat `hybridDataProvider` singleton.

| Method | Signature | Fallback chain |
|--------|-----------|----------------|
| `getPoolData` | `(poolAddress, chain)` | Dexscreener → Birdeye → GeckoTerminal |
| `getOHLCV` | `(poolAddress, timeframe, limit, chain, tokenMint?)` | tokenMint→Birdeye token first; else Dexscreener→Birdeye pair→GT |

Trigger fallback: timeout >3s, HTTP 429, error apapun. 1 retry on 429.

---

## Screening Pipeline (`tools/screening.js`)

```
Dexscreener boosts/profiles → SOL pair only
→ 1h volume ≥ $100k
→ mcap pre-filter
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

## Entry Rules (`tools/chart.js` — `analyzeSignal`)

```
calcFibLevels(swingHigh, swingLow)
  ↓
HARD GATE: price < fib500 → skip "below Fib 0.500 — no entry allowed"
  ↓
Calculate indicators (EMA, RSI, ATR)
  ↓
Zone check: ATH (>fib236) or PRIMARY (fib236–fib382) only
  ↓
EMA20 > EMA50 required
  ↓
RSI > 48 AND slope > 0 required
```

---

## Broken Support Cache (`tools/screening.js`)

- **File**: `broken-support-cache.json` (persists across PM2 restart)
- **Trigger**: price < fib618 OR crash ≥80%/24h
- **Stored**: `{ cachedAt, priceAtRejection, athAtRejection }`
- **Invalidate**: only if `currentPrice > athAtRejection` (new ATH)
- **Duration**: 24h

---

## Deploy-Time Gate (`tools/executor.js`)

Reads `fib500` from `screening-pending.json`, fetches live price before deploy.
Blocks if `livePrice < fib500`.

---

## Screening Lock (`index.js`)

File: `screening-lock.json` `{ ts, pid, status: "running"|"done" }`
- `running` → block unconditional
- `done && age < 60s` → block
- All early-returns release via `_releaseAndSkip()`
- `finally` always: `_writeScreeningLock("done")` + `_screeningBusy = false`

---

## Management Rules

| Rule | Trigger | Action |
|------|---------|--------|
| Stop loss | PnL ≤ -20% | CLOSE |
| Take profit | PnL ≥ 25% | CLOSE |
| Partial harvest | PnL 10–25% | CLOSE |
| OOR | >10m + bins>20 | CLOSE |
| Low fee/TVL | <1% after 60m | CLOSE |

LLM zone: 5–25% PnL. File lock: `management.lock`, 45s gap.

---

## Deploy Sizing

```
< 8 SOL   → 1.5 SOL
8–15 SOL  → 2.8 SOL
15–25 SOL → 4.2 SOL
25–40 SOL → 6.0 SOL
> 40 SOL  → min(18%, 9 SOL)
```

Cap: 60% wallet. Gas reserve: 0.5 SOL.

---

## Feature Status

### Active
- [x] HybridDataProvider — DS→Birdeye→GT, `getOHLCV` unified
- [x] Hard gate fib500 before indicators
- [x] Broken support cache file-based, ATH-only invalidation
- [x] Deploy-time fib500 re-check
- [x] File-based screening lock (no double-screening after restart)
- [x] Telegram unified format — header in `finally`
- [x] Dexscreener-first discovery
- [x] RocketScan fallback
- [x] Tiered sizing + 60% exposure cap
- [x] Partial harvest 10%
- [x] Darwinian signal weighting
- [x] RPC failover 5 endpoints
- [x] Winston structured logging
- [x] Signal attribution (6 signals saved on deploy)
- [x] Management optimization (5m interval, 512 tokens)

### Pending
- [ ] Darwinian weights: need 6+ closed positions to evolve
- [ ] Monitor entry rate

---

## API Notes

**RugCheck**: `https://api.rugcheck.xyz/v1/tokens/{mint}/report` — public, no key
- `bundlePct` from `insiderNetworks` transfer type
- `honeypot` from `rugged===true` or risks "honeypot"

**Meteora Pool Discovery**: `https://pool-discovery-api.datapi.meteora.ag`
- Invalid filters: `base_token_address`, `base_token_age_hours` → client-side only
- Valid timeframes: `5m` `30m` `1h` `2h` `4h` `12h` `24h` (not `1d`)
