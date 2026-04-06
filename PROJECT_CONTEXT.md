# Prospera — Project Context

Ringkasan perubahan arsitektur, fitur, dan keputusan penting per sesi.

---

## Arsitektur Saat Ini

### Screening Pipeline (v2 — GeckoTerminal-first)
Flow baru menggantikan Meteora trending sebagai sumber discovery:

1. **GeckoTerminal** — ambil trending token Solana dari semua DEX (2 halaman, ~40 token)
2. **Dexscreener** — filter **1h** cross-DEX volume ≥ `minVolume` ($20k default) via `batchGetTokenVolumeH1`
3. **mcap pre-filter** — dari data GT jika tersedia
4. **OKX** — bundle/honeypot/creator check
5. **Jupiter DataAPI** — top10 holders, bot holders, fees SOL
6. **Meteora bulk fetch** — `fetchMeteoraDlmmPoolMap()`: satu request page_size=100, filter API-level (tvl/bin\_step/fee/organic/holders/mcap), match client-side by `token_x.address`
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

### Structured Logging (`logger.js`)
- `log(category, message, ctx)` dengan ctx: `{ pair, pool, position, token, reason, step }`
- Pool/position address ditruncate ke 8 karakter

---

## Perubahan Config

| Key | Lama | Baru | Keterangan |
|-----|------|------|------------|
| `deployAmountSol` | ada | dihapus | Diganti `minDeployAmountSol` |
| `positionSizePct` | 0.35 | dihapus | Tidak digunakan di manapun |
| `minDeployAmountSol` | — | 0.5 | Hanya floor validasi, bukan ukuran deploy |
| `partialHarvestPct` | — | 10 | Auto-close di 10% PnL |
| `rpcFallbacks` | — | [Alchemy, Ankr, PublicNode, Official] | Failover chain |

**Deploy sizing aktual:** `floor(deployable_SOL / 5) + 1`, capped by `maxDeployAmount`

---

## Masalah yang Ditemukan & Solusinya

| Masalah | Root Cause | Solusi |
|---------|-----------|--------|
| `fib_analyzed: 0` selama 24 jam | VP gate (POC/VAL harus di Fib zone) terlalu ketat untuk token muda | Hapus VP sebagai hard gate; tetap tampilkan sebagai info |
| Token aktif tidak terdeteksi (contoh: `771oWnZy...`) | Meteora `category=trending` tidak mencakup token baru/kecil | Ganti dengan GeckoTerminal-first discovery |
| LPAgent 429 burst | double retry: study.js 3x + dlmm.js 3x = 12 request | Hapus retry loop, langsung failover ke backup key |
| Prospera melaporkan `deployAmountSol` dan `positionSizePct` sebagai parameter aktif | Field lama tidak dibersihkan dari config/prompt | Rename + hapus, tambahkan dokumentasi tiered formula di prompt |
| **0 entry selama 4 hari** (Apr 2026) | 3 bug kritis di screening pipeline (lihat tabel bawah) | Fix di `token.js`, `screening.js`, `logger.js` |

### Bug Kritis Screening (diperbaiki Apr 2026)

| Bug | Dampak | Root Cause | Fix |
|-----|--------|-----------|-----|
| Volume filter 5m terlalu ketat | Hanya 1/39 token lolos setiap cycle | `volume.m5` ($20k/5m = $240k/jam) | Ganti ke `volume.h1`, threshold tetap $20k |
| Meteora API HTTP 400 | Semua pool lookup return null | `timeframe=1d` tidak valid (valid: `24h`) | Ganti ke `timeframe=24h` |
| `base_token_address` filter invalid | Pool lookup selalu 0 hasil per-token | Parameter tidak didukung Meteora API | Bulk fetch semua pool, match client-side by `token_x.address` |
| `base_token_age_hours` filter invalid | Pool universe = 0 ketika age filter aktif | Parameter tidak didukung Meteora API | Hapus dari query, filter client-side dari `token_x.created_at` |
| EACCES crash mid-cycle | Screening berhenti di tengah saat log write | Log files dimiliki root setelah `sudo pm2` | `logger.js` try/catch di semua `appendFileSync` |

---

## Status Saat Ini

### Selesai
- [x] VP gate dihapus dari Fibonacci screening
- [x] Darwinian Signal Weighting
- [x] Partial Harvest (auto-close di 10%)
- [x] RPC failover (5 endpoint)
- [x] LPAgent failover (primary → backup langsung)
- [x] Structured logging dengan context
- [x] Config cleanup (positionSizePct, deployAmountSol)
- [x] GeckoTerminal-first screening pipeline
- [x] ATR threshold naik ×4 → ×8 (token volatile di Fib zone bisa lolos)
- [x] Double screening bug fix (cron + management cooldown guard)
- [x] Fib rejection cache 3 jam (dead tokens tidak waste OHLCV API tiap cycle)
- [x] GT 0 tokens reset cooldown (HTTP 429 tidak bakar 15 menit sia-sia)
- [x] OKX/Jupiter per-token logging (API miss case ter-log)
- [x] Dead token pre-filter: price_change_pct <= -80% langsung skip Fib
- [x] Signal attribution: RSI/ATR/primary_zone/hidden_div/smart_wallet disimpan saat deploy, dianalisa setiap 5 close

### Pending / Perlu Dipantau
- [ ] Darwinian weights belum memiliki data (perlu 6+ posisi ditutup untuk mulai evolve)
- [ ] Signal attribution baru bisa dievaluasi setelah ada closed positions
- [ ] OKX API sering miss data — semua token lolos via fallback `return true`. Perlu investigasi apakah endpoint masih valid
- [ ] GeckoTerminal rate limit (HTTP 429) terjadi berulang — pertimbangkan delay antar page request
- [ ] Monitor entry rate setelah fix screening pipeline (diharapkan ada candidate saat market kondusif)

---

## File Utama

| File | Fungsi |
|------|--------|
| `tools/screening.js` | Pipeline screening lengkap (v2) |
| `tools/chart.js` | Fibonacci + Volume Profile + Indicators |
| `tools/dlmm.js` | Deploy/close posisi, integrasi RPC failover |
| `signal-weights.js` | Darwinian adaptive signal weights |
| `rpc.js` | RPC connection + failover logic |
| `lessons.js` | Performance tracking + weight update trigger |
| `index.js` | Main loop: deterministic rules + LLM agent |
| `prompt.js` | System prompt builder (SCREENER/MANAGER/GENERAL) |
| `config.js` | Config loader + `computeDeployAmount()` |
| `user-config.json` | User-facing runtime config |
