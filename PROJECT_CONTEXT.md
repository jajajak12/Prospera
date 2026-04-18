# Prospera — Project Context

---

## Stack

Node.js ES modules · PM2 ID 0 · Solana/Meteora DLMM
LLM: MiniMax-M2.7 (management + screening + general)

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
→ Gate: confluenceScore < 0.50 → skip
```

---

## Entry Rules (`tools/chart.js`)

```
calcFibLevels()
→ Check 1: Blowoff top gate — pump ≥80% in last 10 candles + no correction candle or <5% pullback → skip
→ Check 2: HARD GATE price < fib500 → skip; Zone ATH (>fib236) or PRIMARY (fib236–fib382)
→ Check 3: EMA20 > EMA50
→ Check 4: RSI > 48 AND slope > 0
```

`minConfluenceScore`: 0.50 — filters low-confluence signals before deploy.

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
Injects `fib_levels_sol` (fib236/326/382/500/618/786) for management cycle.

---

## Locks

`screening-lock.json` — `running` blocks unconditional · `done && <60s` blocks
All early-returns: `_releaseAndSkip()` · `finally` always releases both locks

`management.lock` — 45s minimum gap

---

## Management Cycle (`index.js`)

Per cycle, injects into each position block:
- **retrace snapshot** — `computeRetraceSnapshot(candles, fibs)`:
  - `retraceType`: HEALTHY / STABILIZING / AGGRESSIVE / DIP_618 / BREAKDOWN_786
  - `dumpVelocity` (%/candle), `volOnRed` (vs median), `consecutiveRed`
  - DIP_618: price fib618–fib786 = bounce/support zone → HOLD
  - BREAKDOWN_786: price < fib786 = real breakdown → consider CLOSE
- **fib_status**: live price vs all fib levels (string description)
- **live_price**, **candlesSinceFib500Breach**

LLM rules: DIP_618 → hold; BREAKDOWN_786 → close; AGGRESSIVE + fib500 breach ≤3c → close.

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

## Lessons System (`lessons.js`)

- `derivLesson()` — auto-generates PREFER/AVOID/DIRECTIONAL DUMP dari closed position
- `runChartLessonAnalysis()` — LLM post-trade chart analysis (English only)
- CJK filter: lessons dengan karakter Chinese dibuang (MiniMax guard)
- **DIRECTIONAL DUMP**: `range_efficiency=100% + SL` = token dump in-range, bukan OOR failure
- Lessons diinject ke management prompt sebagai CONTEXT only (bukan trigger langsung)

---

## OOR Tracking (`state.js`)

`total_minutes_oor` accumulates across all OOR streaks:
- `markInRange()` / `updatePosition()`: tambah elapsed ke `total_minutes_oor` sebelum reset `out_of_range_since`
- `dlmm.js` close: `minutesOOR = total_minutes_oor + current streak (if any)`
- `range_efficiency = (minutesHeld - minutesOOR) / minutesHeld × 100` — akurat

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
- [x] Blowoff top gate — pump ≥80% no correction → skip entry
- [x] minConfluenceScore 0.50 — filters weak signals
- [x] Broken support cache (file-based, ATH-only invalidation)
- [x] Deploy-time fib500 gate
- [x] File-based screening lock (no double screening)
- [x] Telegram unified format
- [x] Tiered sizing + 60% cap · Partial harvest · RPC failover
- [x] Chart lesson analysis — LLM evaluates post-trade, saves to lessons.json
- [x] CJK leakage filter — MiniMax Chinese char guard on lessons
- [x] DIRECTIONAL DUMP lesson category — in-range dump vs OOR failure
- [x] Retrace snapshot — HEALTHY/STABILIZING/AGGRESSIVE/DIP_618/BREAKDOWN_786 per cycle
- [x] fib786 split — DIP_618=hold (bounce zone), BREAKDOWN_786=close
- [x] Hallucination prevention — pre-computed data injection + prompt guards
- [x] Cumulative OOR tracking — total_minutes_oor across all streaks
- [x] Signal weights defensive load — handles missing/corrupt history field
- [x] Auto-claim fees — triggers when fees ≥2% position value AND price ≥ fib382
- [x] Exit rule — close when loss ≥3× unclaimed fees after 2h (IL overtaking fees)
- [ ] Darwinian weights: need 6+ closed positions
- [ ] Monitor entry rate

---

## Meteora API

Invalid filters: `base_token_address`, `base_token_age_hours` → client-side only
Valid timeframes: `5m` `1h` `4h` `12h` `24h` (not `1d`)
