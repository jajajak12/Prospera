# Prospera — Project Context

Ringkasan arsitektur, fitur, dan keputusan penting. Detail kode ada di file masing-masing.

---

## Arsitektur Saat Ini

### Data Layer — HybridDataProvider (`tools/dataProvider.js`)

Semua pool data dan OHLCV wajib lewat `hybridDataProvider` (singleton).

**Fallback chain: Dexscreener → Birdeye → GeckoTerminal**
- Trigger fallback: timeout >3s, HTTP 429, error apapun; 1 retry on 429
- `getPoolData(poolAddress, chain)` — price USD, mcap, volume, liquidity, `_source`
- `getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)`:
  - `tokenMint` ada → Birdeye token first → Dexscreener → GeckoTerminal
  - `tokenMint` null → Dexscreener → Birdeye pair → GeckoTerminal
- Dilarang panggil Birdeye/Dexscreener/GT langsung di luar `dataProvider.js`

### Screening Pipeline (`tools/screening.js`)

```
Dexscreener boosts/profiles (SOL pair only)
→ 1h volume filter ≥ $100k
→ mcap pre-filter
→ RugCheck (bundle %, honeypot, creator blacklist)
→ Jupiter (top10, bot holders, fees SOL)
→ Meteora bulk fetch page_size=100 (filter API-level, match client-side)
→ RocketScan fallback (pool baru belum diindex Meteora API)
→ Broken support cache check (skip jika cached < fib618)
→ Fibonacci analysis via hybridDataProvider.getOHLCV()
→ Smart wallet boost (+0.10 confluenceScore)
→ Sort by confluenceScore DESC
```

### Hard Entry Rules (`tools/chart.js` — `analyzeSignal`)

1. **Fib 0.500 hard gate** — dicek PERTAMA setelah `calcFibLevels`, sebelum indicators:
   ```js
   if (currentPrice < fib.fib500) return skip("below Fib 0.500 — no entry allowed")
   ```
2. **Entry zone** — ATH zone (> fib236) atau PRIMARY zone (fib236–fib382); deep pullback (fib382–fib500) → SKIP
3. **EMA trend** — EMA20 > EMA50 wajib
4. **RSI momentum** — RSI > 48 AND slope positif wajib

### Broken Support Cache (`tools/screening.js`)

- **File**: `broken-support-cache.json` — persist lintas PM2 restart
- **Trigger**: price < fib618 (chart.js returns "broken support") ATAU crash ≥80%/24h
- **Disimpan**: `{ cachedAt, priceAtRejection, athAtRejection }` — `athAtRejection = fibLevels.swingHigh`
- **Invalidasi**: HANYA jika `currentPrice > cached.athAtRejection` (new ATH)
- **Durasi**: 24 jam

### Deploy-Time Gate (`tools/executor.js`)

Re-check live price vs `fib500` dari `screening-pending.json` sebelum deploy.
Jika `livePrice < fib500` → block deploy.

### Screening Lock (`index.js`)

- **File**: `screening-lock.json` — `{ ts, pid, status: "running"|"done" }`
- `running` → block unconditional
- `done && age < 60s` → block
- Semua early-return path melepas lock via `_releaseAndSkip()`
- `finally` selalu panggil `_writeScreeningLock("done")` + `_screeningBusy = false`

### Management Loop (`index.js`)

Deterministic rules (sebelum LLM):

| Rule | Kondisi | Aksi |
|------|---------|------|
| 1 | PnL ≤ -20% | CLOSE |
| 2a | PnL ≥ 25% | CLOSE |
| 2b | PnL ≥ 10% dan < 25% | CLOSE (partial harvest) |
| 3 | OOR > 10m dan bins > 20 | CLOSE |
| 4 | fee/TVL < 1% setelah 60m | CLOSE |

LLM zone: PnL 5%–25%.
File lock: `management.lock`, gap minimum 45 detik.

---

## Deploy Sizing & Exposure Cap

| Wallet | Deploy |
|--------|--------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18%, 9 SOL) |

Max 60% wallet di-deploy sekaligus. Gas reserve 0.5 SOL.

---

## Status Fitur

### Aktif
- [x] HybridDataProvider — DS→Birdeye→GT, `getOHLCV` unified (hapus `getOHLCVByMint`)
- [x] Hard gate fib500 sebelum indicators di `chart.js`
- [x] Broken support cache file-based, trigger < fib618, invalidasi ATH-only
- [x] Deploy-time fib500 re-check di `executor.js`
- [x] File-based screening lock — `screening-lock.json`
- [x] Telegram format unified — header `🔍 Fibonacci Screening [HH:MM]` selalu di `finally`
- [x] Dexscreener-first discovery (hapus GeckoTerminal-first)
- [x] RocketScan fallback (pool baru)
- [x] Tiered position sizing + Exposure Cap 60%
- [x] Partial harvest auto-close 10%
- [x] Darwinian Signal Weighting
- [x] RPC failover 5 endpoint
- [x] Management cost optimization (5m interval, maxTokens 512)
- [x] PnL formula fix (hapus extra ×100)
- [x] ATH zone passive-bid fix (fib236→fib618)
- [x] Unit mismatch fix (token.price USD strict, fallback ke `hybridDataProvider.getPoolData()`)
- [x] Step-by-step screening logs Step 1–8

### Pending
- [ ] Darwinian weights belum evolve (perlu 6+ closed positions)
- [ ] Signal attribution belum bisa dievaluasi (perlu closed positions)
- [ ] Monitor entry rate

---

## API Notes

### RugCheck (`tools/okx.js`)
`https://api.rugcheck.xyz/v1/tokens/{mint}/report` — publik, tanpa API key.
- `bundlePct` dari `insiderNetworks` tipe transfer
- `honeypot` dari `rugged === true` atau risks "honeypot"

### Meteora Pool Discovery
`https://pool-discovery-api.datapi.meteora.ag`
- Filter TIDAK VALID: `base_token_address`, `base_token_age_hours` → client-side
- Timeframe valid: `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h` (bukan `1d`)

---

## File Utama

| File | Fungsi |
|------|--------|
| `tools/dataProvider.js` | HybridDataProvider (WAJIB untuk semua data) |
| `tools/screening.js` | Pipeline screening v3 |
| `tools/chart.js` | Fibonacci + Indicators; hard gate fib500 |
| `tools/executor.js` | LLM tool handler; deploy-time fib500 gate |
| `tools/dlmm.js` | Deploy/close posisi |
| `tools/okx.js` | RugCheck.xyz client |
| `index.js` | Main loop; screening lock; management lock |
| `config.js` | Sizing + exposure cap |
| `signal-weights.js` | Darwinian weights |
| `lessons.js` | Performance tracking |
| `logger.js` | Winston structured logging |
