# Prospera — Project Context

Ringkasan perubahan arsitektur, fitur, dan keputusan penting per sesi.

---

## Arsitektur Saat Ini

### Screening Pipeline (v2 — GeckoTerminal-first)
Flow menggantikan Meteora trending sebagai sumber discovery:

1. **GeckoTerminal** — ambil trending token Solana dari semua DEX (2 halaman, ~40 token)
2. **Dexscreener** — filter **1h** cross-DEX volume ≥ `minVolume` ($100k default) via `batchGetTokenVolumeH1`
3. **mcap pre-filter** — dari data GT jika tersedia
4. **RugCheck** — bundle %/honeypot/creator check (menggantikan OKX yang mati)
5. **Jupiter DataAPI** — top10 holders, bot holders, fees SOL
6. **Meteora bulk fetch** — `fetchMeteoraDlmmPoolMap()`: satu request page_size=100, filter API-level (tvl/bin_step/fee/organic/holders/mcap), match client-side by `token_x.address`
7. **Client-side age filter** — `base_token_age_hours` diterapkan client-side (bukan API filter)
8. **Fibonacci analysis** — pakai GT candles + Meteora `bin_step`
9. **Smart wallet boost** — +0.10 ke confluenceScore jika smart money terdeteksi

### Management Loop
- **Deterministic rules** dijalankan di `index.js` SEBELUM LLM:
  - Rule 1: PnL ≤ stopLossPct → CLOSE
  - Rule 2a: PnL ≥ takeProfitMaxPct → CLOSE
  - **Rule 2b (Partial Harvest)**: PnL ≥ `partialHarvestPct` (10%) dan < takeProfitMaxPct → CLOSE (lock gains)
  - Rule 3: OOR > outOfRangeWaitMinutes dan bins away > outOfRangeBinsToClose → CLOSE
  - Rule 4: fee/TVL < minFeePerTvl24h setelah 60 menit → CLOSE
- **LLM decision zone**: PnL antara `takeProfitFeePct` (5%) dan `takeProfitMaxPct` (25%)

---

## Fitur yang Ditambahkan

### Darwinian Signal Weighting (`signal-weights.js`)
- Weight per sinyal (organic, fee_tvl, volume, confluence, fib_zone, bin_step, volatility)
- Semua mulai di 1.0 (netral)
- Setelah 6+ posisi ditutup: lift analysis — win vs loss signal correlation
- lift > 0.1 → weight +0.05 (max 2.5); lift < -0.1 → weight -0.05 (min 0.3)
- Weight ditampilkan di SCREENER prompt via `formatWeightsForPrompt()`

### Partial Harvest
- Auto-close ketika PnL mencapai `partialHarvestPct` (default 10%)
- Berjalan sebagai deterministic rule (tidak menunggu LLM)
- Config key: `partialHarvestPct` di `user-config.json`

### RPC Failover (`rpc.js`)
- Urutan endpoint: Helius (primary via env) → Alchemy → Ankr → PublicNode → Official
- `withRpcFallback(fn, label)` — wrap semua `sendAndConfirmTransaction`
- Auto-reset ke primary setelah 5 menit stabil
- Config key: `rpcFallbacks` array di `user-config.json`

### LPAgent API Failover
- Primary API key → langsung failover ke backup key (tidak retry 3x lagi)
- Menghindari burst 12 request yang menyebabkan 429

### Structured Logging (`logger.js`) — Winston
- Dibangun di atas winston + winston-daily-rotate-file
- `combined-YYYY-MM-DD.log` — semua level, human-readable, retensi 30 hari
- `error-YYYY-MM-DD.log` — error saja, JSON structured untuk analisis
- `actions-YYYY-MM-DD.jsonl` — audit trail tool execution
- Domain shortcuts: `log.screening`, `log.trade`, `log.position`, `log.confluence`, `log.pnl`, `log.rpc`
- Level shortcuts: `log.debug`, `log.warn`, `log.error`
- ctx fields baru: `confluenceScore`, `pnl`, `action`
- `tools/study.js` dimigrasikan dari console.log/error ke `log()`

### Signal Attribution
- 6 sinyal disimpan saat deploy: `fib_entry_pct`, `rsi`, `atr_pct`, `in_primary_zone`, `has_hidden_divergence`, `smart_wallet_present`
- Dianalisa setiap 5 close via `computeSignalAttribution()` di `lessons.js`
- Win-rate YES vs NO per sinyal, laporan dikirim via Telegram

---

## Perubahan Config

| Key | Lama | Baru | Keterangan |
|-----|------|------|------------|
| `deployAmountSol` | ada | dihapus | Diganti `minDeployAmountSol` |
| `positionSizePct` | 0.35 | dihapus | Tidak digunakan di manapun |
| `minDeployAmountSol` | — | 0.5 | Hanya floor validasi, bukan ukuran deploy |
| `partialHarvestPct` | — | 10 | Auto-close di 10% PnL |
| `rpcFallbacks` | — | [Alchemy, Ankr, PublicNode, Official] | Failover chain |
| `minVolume` | 20000 | 100000 | Volume 1h minimum naik ke $100k |
| `maxTvl` | 300000 | 250000 | Max TVL pool turun ke $250k |

**Deploy sizing aktual:** `floor(deployable_SOL / 5) + 1`, capped by `maxDeployAmount`

---

## Masalah yang Ditemukan & Solusinya

| Masalah | Root Cause | Solusi |
|---------|-----------|--------|
| `fib_analyzed: 0` selama 24 jam | VP gate (POC/VAL harus di Fib zone) terlalu ketat untuk token muda | Hapus VP sebagai hard gate; tetap tampilkan sebagai info |
| Token aktif tidak terdeteksi | Meteora `category=trending` tidak mencakup token baru/kecil | Ganti dengan GeckoTerminal-first discovery |
| LPAgent 429 burst | double retry: study.js 3x + dlmm.js 3x = 12 request | Hapus retry loop, langsung failover ke backup key |
| Prospera melaporkan config lama sebagai aktif | Field lama tidak dibersihkan | Rename + hapus, tambahkan dokumentasi tiered formula |
| **0 entry selama 4 hari** (Apr 2026) | 3 bug kritis di screening pipeline | Fix di `token.js`, `screening.js`, `logger.js` |
| OKX API mati | Endpoint `/api/v5/dex/market/advanced-info` return 404 untuk semua token | Ganti dengan RugCheck.xyz — gratis, tanpa API key |
| Bundle/honeypot check disabled | OKX null → semua token lolos via fallback | RugCheck: bundlePct dari insiderNetworks, honeypot dari rugged flag |

### Bug Kritis Screening (diperbaiki Apr 2026)

| Bug | Dampak | Root Cause | Fix |
|-----|--------|-----------|-----|
| Volume filter 5m terlalu ketat | Hanya 1/39 token lolos setiap cycle | `volume.m5` ($20k/5m = $240k/jam) | Ganti ke `volume.h1`, threshold $100k |
| Meteora API HTTP 400 | Semua pool lookup return null | `timeframe=1d` tidak valid (valid: `24h`) | Ganti ke `timeframe=24h` |
| `base_token_address` filter invalid | Pool lookup selalu 0 hasil per-token | Parameter tidak didukung Meteora API | Bulk fetch semua pool, match client-side by `token_x.address` |
| `base_token_age_hours` filter invalid | Pool universe = 0 ketika age filter aktif | Parameter tidak didukung Meteora API | Hapus dari query, filter client-side dari `token_x.created_at` |
| EACCES crash mid-cycle | Screening berhenti di tengah saat log write | Log files dimiliki root setelah `sudo pm2` | `logger.js` try/catch di semua `appendFileSync` |
| OKX endpoint mati (Apr 2026) | Bundle/honeypot check bypass semua token | HTTP 404 untuk semua mint → okx=null → return true | Ganti ke RugCheck.xyz |

---

## Status Saat Ini

### Selesai
- [x] VP gate dihapus dari Fibonacci screening
- [x] Darwinian Signal Weighting
- [x] Partial Harvest (auto-close di 10%)
- [x] RPC failover (5 endpoint)
- [x] LPAgent failover (primary → backup langsung)
- [x] Structured logging dengan winston (combined + error log harian)
- [x] Config cleanup (positionSizePct, deployAmountSol)
- [x] GeckoTerminal-first screening pipeline
- [x] ATR threshold naik ×4 → ×8 (token volatile di Fib zone bisa lolos)
- [x] Double screening bug fix (cron + management cooldown guard)
- [x] Fib rejection cache 3 jam (dead tokens tidak waste OHLCV API tiap cycle)
- [x] GT 0 tokens reset cooldown (HTTP 429 tidak bakar 15 menit sia-sia)
- [x] OKX diganti RugCheck.xyz (bundle %, honeypot, creator blacklist aktif kembali)
- [x] Signal attribution: RSI/ATR/primary_zone/hidden_div/smart_wallet disimpan saat deploy
- [x] minVolume naik $20k → $100k (1h volume)
- [x] maxTvl turun $300k → $250k
- [x] README diterjemahkan ke Bahasa Indonesia

### Pending / Perlu Dipantau
- [ ] Darwinian weights belum memiliki data (perlu 6+ posisi ditutup untuk mulai evolve)
- [ ] Signal attribution baru bisa dievaluasi setelah ada closed positions
- [ ] GeckoTerminal rate limit (HTTP 429) terjadi berulang — pertimbangkan delay antar page request
- [ ] Monitor entry rate setelah fix screening pipeline (diharapkan ada candidate saat market kondusif)

---

## RugCheck API — Catatan Penting

**Base URL:** `https://api.rugcheck.xyz/v1`
**Endpoint:** `GET /tokens/{mint}/report`
**Publik, tidak perlu API key.**

**Field yang digunakan Prospera:**
- `bundlePct` → dihitung dari `insiderNetworks` tipe `transfer`: `max(tokenAmount) / token.supply × 100` (conservative, tidak double-count)
- `honeypot` → `rugged === true` ATAU risks array mengandung "honeypot"
- `creator` → `d.creator` untuk dev blacklist check
- `graphInsiders` → `d.graphInsidersDetected` (ditampilkan di log sebagai info)

**Field OKX yang tidak tersedia di RugCheck (di-default ke 0/false):**
- `sniperPct`, `suspiciousPct`, `devHoldingPct`, `devSoldAll`, `smartMoneyBuy`, `devRugCount`

---

## Meteora Pool Discovery API — Catatan Penting

**Base URL:** `https://pool-discovery-api.datapi.meteora.ag`

**Filter yang VALID:**
- `pool_type`, `tvl`, `dlmm_bin_step`, `fee_active_tvl_ratio`, `fee`
- `base_token_organic_score`, `quote_token_organic_score`
- `base_token_holders`, `base_token_market_cap`
- `base_token_has_critical_warnings`, `base_token_has_high_single_ownership`

**Filter yang TIDAK VALID (return 0 hasil):**
- `base_token_address` — match client-side via `token_x.address`
- `base_token_age_hours` — hitung dari `token_x.created_at`

**Timeframe valid:** `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h` (bukan `1d`)

---

## File Utama

| File | Fungsi |
|------|--------|
| `tools/screening.js` | Pipeline screening lengkap (v2) |
| `tools/chart.js` | Fibonacci + Volume Profile + Indicators |
| `tools/dlmm.js` | Deploy/close posisi, integrasi RPC failover |
| `tools/okx.js` | RugCheck.xyz client (menggantikan OKX) |
| `signal-weights.js` | Darwinian adaptive signal weights |
| `rpc.js` | RPC connection + failover logic |
| `lessons.js` | Performance tracking + weight update trigger |
| `logger.js` | Winston structured logging |
| `index.js` | Main loop: deterministic rules + LLM agent |
| `prompt.js` | System prompt builder (SCREENER/MANAGER/GENERAL) |
| `config.js` | Config loader + `computeDeployAmount()` |
| `user-config.json` | User-facing runtime config |
