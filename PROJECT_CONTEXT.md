# Prospera — Project Context

Ringkasan perubahan arsitektur, fitur, dan keputusan penting per sesi.

---

## Arsitektur Saat Ini

### Screening Pipeline (v3 — Dexscreener-first + HybridDataProvider)

1. **Dexscreener** — trending token Solana via `token-boosts/top/v1` + `token-profiles/latest/v1`, enriched pair data (price USD, mcap, h1 volume) via `tokens/v1/solana/{mints}`; hanya SOL pair
2. **Volume filter** — h1 volume dari step 1; fallback `batchGetTokenVolumeH1` hanya untuk token tanpa data
3. **mcap pre-filter** — dari data Dexscreener jika tersedia
4. **RugCheck** — bundle %/honeypot/creator check
5. **Jupiter DataAPI** — top10 holders, bot holders, fees SOL
6. **Meteora bulk fetch** — `fetchMeteoraDlmmPoolMap()`: satu request page_size=100, filter API-level, match client-side by `token_x.address`
7. **RocketScan fallback** — token tanpa pool di step 6 dicoba via `rocketscan.fun/api/pools?tokenBMint=`, detail dari `dlmm.datapi.meteora.ag`
8. **Fibonacci analysis** — `analyzeSignal(tokenMint, binStep, currentPrice, candleLimit, opts, poolAddress)`; OHLCV via `hybridDataProvider.getOHLCV(poolAddress, timeframe, limit, chain, tokenMint)`
9. **Smart wallet boost** — +0.10 ke confluenceScore jika smart money terdeteksi

### HybridDataProvider (`tools/dataProvider.js`)

Semua pool data dan OHLCV melalui satu interface dengan fallback chain:

**Dexscreener (primary) → Birdeye (fallback) → GeckoTerminal (last resort)**

- Trigger fallback: timeout >3s, HTTP 429, atau error apapun; 1 retry on 429 sebelum fallback
- `getPoolData(poolAddress, chain)` — price USD, mcap, volume (m5/h1/h6/h24), liquidity; field `_source` menunjukkan siapa yang berhasil
- `getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)`:
  - Jika `tokenMint` diberikan → Birdeye token endpoint first (best history), lalu Dexscreener → GeckoTerminal
  - Jika hanya `poolAddress` → Dexscreener → Birdeye pair → GeckoTerminal
- Singleton: `export const hybridDataProvider = new HybridDataProvider()`
- `chart.js` menggunakan `hybridDataProvider.getOHLCV(poolAddress, "1m"/"1D", limit, "solana", tokenMint)` via `fetchOHLCV()` dan `fetchDailyOHLCV()`
- `screening.js` menggunakan `hybridDataProvider.getPoolData(pool.pool)` sebagai fallback jika `token.price` (USD) null

### Hard Entry Rules (chart.js — analyzeSignal)

1. **Fib 0.500 hard gate** — `if (currentPrice < fib.fib500) → SKIP "broken support, no entry"` — dicek PERTAMA setelah `calcFibLevels`, sebelum indicators dihitung
2. **Entry zone** — price harus di ATH zone (> fib236) atau PRIMARY zone (fib382–fib236); deep pullback (fib500–fib382) → SKIP
3. **EMA trend** — EMA20 > EMA50 wajib
4. **RSI momentum** — RSI > 48 AND slope positif

### Broken Support Cache (`screening.js`)

- File-based: `broken-support-cache.json` — persist lintas PM2 restart
- Cache duration: 24 jam
- Disimpan: `{ cachedAt, priceAtRejection, athAtRejection }` — `athAtRejection` = `fibLevels.swingHigh` saat rejection
- Trigger: price < fib500 (chart.js returns "broken support") ATAU price crash ≥80% dalam 24h
- **Invalidasi**: HANYA jika `currentPrice > cached.athAtRejection` (new ATH) — bukan pump % threshold
- Log: `cache invalidated — new ATH $X > prev ATH $Y, re-analyzing`

### Telegram Screening Report Format

```
🔍 Fibonacci Screening [HH:MM]
Discovered: X | After volume: Y | Meteora pools: Z

<LLM report atau "No entry signals">
```

- Header selalu dibangun di `finally` block — single consistent format, tidak ada `_alreadyHasHeader` check
- `getTopCandidates()` return `{ candidates, total_screened, after_volume_count, withPool_count, fib_analyzed, fib_passed }`

### File-Based Screening Lock (`index.js`)

- File: `screening-lock.json` — `{ ts, pid, status: "running"|"done" }`
- `status=running` → block unconditional (tidak peduli umur)
- `status=done && age < 60s` → block
- Semua early-return path (max positions, no SOL, exposure cap) melepas lock via `_releaseAndSkip()`
- `finally` block selalu memanggil `_writeScreeningLock("done")`

### Management Loop

- **Deterministic rules** dijalankan di `index.js` SEBELUM LLM:
  - Rule 1: PnL ≤ stopLossPct → CLOSE
  - Rule 2a: PnL ≥ takeProfitMaxPct → CLOSE
  - Rule 2b (Partial Harvest): PnL ≥ `partialHarvestPct` (10%) dan < takeProfitMaxPct → CLOSE
  - Rule 3: OOR > outOfRangeWaitMinutes dan bins away > outOfRangeBinsToClose → CLOSE
  - Rule 4: fee/TVL < minFeePerTvl24h setelah 60 menit → CLOSE
- **LLM decision zone**: PnL antara `takeProfitFeePct` (5%) dan `takeProfitMaxPct` (25%)
- **File-based management lock** — `management.lock`, gap minimum 45 detik, persist lintas restart

---

## Fitur yang Ditambahkan

### Darwinian Signal Weighting (`signal-weights.js`)
- Weight per sinyal (organic, fee_tvl, volume, confluence, fib_zone, bin_step, volatility)
- Semua mulai di 1.0 (netral); setelah 6+ posisi ditutup: lift analysis
- lift > 0.1 → weight +0.05 (max 2.5); lift < -0.1 → weight -0.05 (min 0.3)

### RocketScan Fallback (`tools/screening.js` — Step 7b)
- Token tanpa pool di Meteora API dicoba via RocketScan (event-based, lebih cepat tersedia)
- Alur: `GET rocketscan.fun/api/pools?tokenBMint={mint}&poolType=DLMM` → `poolId` → `GET dlmm.datapi.meteora.ag/pools?query={poolId}`
- Filter manual: bin_step, TVL, holders, mcap, organic, age, pair=SOL wajib

### Tiered Position Sizing & Total Exposure Cap (`config.js`)
- `getPositionSizing(totalSol)`:
  ```
  < 8 SOL   → 1.5 SOL
  8–15 SOL  → 2.8 SOL
  15–25 SOL → 4.2 SOL
  25–40 SOL → 6.0 SOL
  > 40 SOL  → min(18% wallet, 9 SOL)
  ```
- `canOpenNewPosition()` — exposure cap 60% dari exposurable balance (wallet − 0.5 SOL gas reserve)

### Deploy-Time Fib 0.500 Gate (`tools/executor.js`)
- Sebelum deploy: baca `fib500` dari `screening-pending.json`, fetch live price via `getPoolDetail()`
- Jika `livePrice < fib500` → block deploy dengan reason
- Double-check terpisah dari screening-time gate di `chart.js`

### RPC Failover (`rpc.js`)
- Urutan: Helius (primary) → Alchemy → Ankr → PublicNode → Official Solana
- Auto-reset ke primary setelah 5 menit stabil

### Structured Logging (`logger.js`)
- `combined-YYYY-MM-DD.log` — semua level; `error-YYYY-MM-DD.log` — JSON; `actions/snapshots JSONL`
- Domain shortcuts: `log.screening`, `log.trade`, `log.position`, `log.management`, dll.

### Signal Attribution
- 6 sinyal disimpan saat deploy: `fib_entry_pct`, `rsi`, `atr_pct`, `in_primary_zone`, `has_hidden_divergence`, `smart_wallet_present`
- Win-rate YES vs NO per sinyal via `computeSignalAttribution()` di `lessons.js`

---

## Perubahan Config

| Key | Nilai | Keterangan |
|-----|-------|------------|
| `partialHarvestPct` | 10 | Auto-close di 10% PnL |
| `totalExposureCapPct` | 0.60 | Max 60% wallet di-deploy sekaligus |
| `exposureGasReserve` | 0.5 | SOL reserved untuk gas |
| `minVolume` | 100000 | 1h volume minimum ($100k) |
| `maxTvl` | 250000 | Max TVL pool |
| `minTokenAgeHours` | 0.5 | Min age token (30 menit) |
| `maxTop10Pct` | 20 | Max top 10 holder concentration |
| `managementModel` | deepseek/deepseek-v3.2 | LLM untuk management |
| `screeningModel` | qwen/qwen3.5-flash-02-23 | LLM untuk screening |

---

## Masalah yang Ditemukan & Solusinya

| Masalah | Root Cause | Solusi |
|---------|-----------|--------|
| VP gate terlalu ketat | POC/VAL harus di Fib zone → 0 candidates | Hapus VP sebagai hard gate |
| Token aktif tidak terdeteksi | Meteora `category=trending` tidak lengkap | Dexscreener-first discovery |
| LPAgent 429 burst | double retry → 12 request | Hapus retry, langsung failover |
| 0 entry selama 4 hari (Apr 2026) | 3 bug kritis di screening pipeline | Fix volume filter, Meteora timeframe, bulk fetch |
| OKX API mati | Endpoint 404 untuk semua token | Ganti RugCheck.xyz |
| Posisi dibuka saat broken support | Unit mismatch + cache tidak persist | token.price USD strict + file-based cache |
| Double Telegram report | in-memory busy flag hilang saat restart + tidak ada min gap setelah completion | File-based screening lock (`screening-lock.json`) |
| PnL 100x inflasi | extra ×100 pada percentNative | Hapus extra multiply |

### Bug Kritis Screening (diperbaiki Apr 2026)

| Bug | Dampak | Fix |
|-----|--------|-----|
| Volume filter 5m terlalu ketat | Hanya 1/39 token lolos | Ganti ke `volume.h1`, threshold $100k |
| Meteora API HTTP 400 | Semua pool lookup null | `timeframe=1d` → `timeframe=24h` |
| `base_token_address` filter invalid | Pool lookup selalu 0 hasil | Bulk fetch, match client-side |
| `base_token_age_hours` filter invalid | Pool universe = 0 | Filter client-side dari `token_x.created_at` |
| Unit mismatch SOL vs USD | False ENTRY saat token.price null | `const currentPrice = token.price` — tidak fallback ke pool.price |
| Broken support cache in-memory | Cache hilang saat PM2 restart | File-based `broken-support-cache.json` |

---

## Status Saat Ini

### Selesai
- [x] HybridDataProvider — Dexscreener→Birdeye→GT, singleton `hybridDataProvider`
- [x] `getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)` — unified method, `getOHLCVByMint` dihapus
- [x] Hard gate fib500 dipindah ke tepat setelah `calcFibLevels` — skip sebelum hitung indicators
- [x] Broken support cache file-based — persist lintas PM2 restart, invalidasi ATH-only
- [x] Deploy-time fib500 re-check di `executor.js`
- [x] File-based screening lock — `screening-lock.json`, running/done + timestamp
- [x] Telegram format unified — header selalu dibangun di `finally`, tidak ada duplicate
- [x] Step-by-step screening logs Step 1–8 + summary
- [x] Unit mismatch fix — token.price null → fallback `hybridDataProvider.getPoolData()`, bukan pool.price
- [x] Darwinian Signal Weighting
- [x] Partial Harvest (auto-close 10%)
- [x] RPC failover (5 endpoint)
- [x] Structured logging winston
- [x] Tiered position sizing + Exposure Cap 60%
- [x] RocketScan fallback
- [x] Signal attribution
- [x] Management cost optimization (prompt kompak, 5m interval, maxTokens 512)
- [x] PnL formula fix (hapus extra ×100)
- [x] ATH zone passive-bid fix (range fib236→fib618)

### Pending / Perlu Dipantau
- [ ] Darwinian weights belum evolve (perlu 6+ posisi ditutup)
- [ ] Monitor entry rate setelah screening pipeline fix
- [ ] GeckoTerminal rate limit (HTTP 429) — pertimbangkan delay antar request

---

## API Notes

### RugCheck (`tools/okx.js`)
- Base URL: `https://api.rugcheck.xyz/v1/tokens/{mint}/report` — publik, tanpa API key
- `bundlePct` dari `insiderNetworks` tipe `transfer`; `honeypot` dari `rugged === true` atau risks "honeypot"; `creator` dari `d.creator`

### Meteora Pool Discovery API
- Base URL: `https://pool-discovery-api.datapi.meteora.ag`
- Filter VALID: `pool_type`, `tvl`, `dlmm_bin_step`, `fee_active_tvl_ratio`, `fee`, `base_token_organic_score`, dll.
- Filter TIDAK VALID: `base_token_address`, `base_token_age_hours` — match/filter client-side
- Timeframe valid: `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h` (bukan `1d`)

---

## File Utama

| File | Fungsi |
|------|--------|
| `tools/screening.js` | Pipeline screening lengkap (v3) |
| `tools/chart.js` | Fibonacci + Indicators; hard gate fib500 |
| `tools/dataProvider.js` | HybridDataProvider — DS→Birdeye→GT |
| `tools/executor.js` | Tool handler LLM; deploy-time fib500 gate |
| `tools/dlmm.js` | Deploy/close posisi, RPC failover |
| `tools/okx.js` | RugCheck.xyz client |
| `signal-weights.js` | Darwinian adaptive signal weights |
| `rpc.js` | RPC connection + failover |
| `lessons.js` | Performance tracking + weight update |
| `logger.js` | Winston structured logging |
| `index.js` | Main loop: deterministic rules + LLM agent; screening lock |
| `config.js` | Config loader + sizing + exposure cap |
| `user-config.json` | Runtime config |
