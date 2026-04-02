# Prospera — Project Context

Ringkasan perubahan arsitektur, fitur, dan keputusan penting per sesi.

---

## Arsitektur Saat Ini

### Screening Pipeline (v2 — GeckoTerminal-first)
Flow baru menggantikan Meteora trending sebagai sumber discovery:

1. **GeckoTerminal** — ambil trending token Solana dari semua DEX (2 halaman, ~40 token)
2. **Dexscreener** — filter 5m cross-DEX volume ≥ `minVolume` ($20k default)
3. **mcap pre-filter** — dari data GT jika tersedia
4. **OKX** — bundle/honeypot/creator check
5. **Jupiter DataAPI** — top10 holders, bot holders, fees SOL
6. **Meteora pool lookup** — cari DLMM pool untuk token (`findMeteoraDlmmPool`), filter TVL/fee/bin\_step/organic/holders
7. **Fibonacci analysis** — pakai GT candles + Meteora `bin_step`
8. **Smart wallet boost** — +0.10 ke confluenceScore jika smart money terdeteksi

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

### Pending / Perlu Dipantau
- [ ] Verifikasi `base_token_address=${mint}` didukung Meteora Pool Discovery API (test dari live screening)
- [ ] Darwinian weights belum memiliki data (perlu 6+ posisi ditutup untuk mulai evolve)
- [ ] Monitor apakah `fib_analyzed` sekarang menunjukkan angka > 0 di screening cycle berikutnya

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
