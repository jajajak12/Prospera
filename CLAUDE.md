# CLAUDE.md — Prospera

Baca file ini di awal setiap sesi. Berisi konteks proyek, aturan kerja, dan status terkini.
Untuk detail lengkap perubahan arsitektur, baca `PROJECT_CONTEXT.md`.

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana.
- Strategi: Fibonacci retracement + Volume Profile entry signals
- Single-sided bid_ask, SOL-quoted pools
- PM2 process ID: `1` (name: `prospera`)
- GitHub: `https://github.com/jajajak12/Prospera` branch `main`

---

## Aturan Kerja

1. **Selalu gunakan Bahasa Indonesia**
2. Setelah setiap perubahan kode: restart PM2 (`pm2 restart 1`) + push ke GitHub
3. Baca file yang relevan sebelum memodifikasi — jangan asumsi struktur kode
4. `bypassPermissions` aktif — tidak perlu minta konfirmasi untuk tool calls
5. Jangan tambah fitur di luar yang diminta
6. Setelah implementasi besar: update `PROJECT_CONTEXT.md`

---

## Struktur File Penting

```
index.js              — main loop: deterministic rules + LLM agent calls
config.js             — config loader + computeDeployAmount()
user-config.json      — runtime config (edit ini untuk ubah parameter)
prompt.js             — system prompt builder (SCREENER/MANAGER/GENERAL)
signal-weights.js     — Darwinian adaptive signal weights
rpc.js                — RPC connection + 5-endpoint failover
logger.js             — structured logging dengan context object
lessons.js            — performance tracking + weight update trigger
state.js              — posisi tracking + memori agent

tools/
  screening.js        — pipeline screening v2 (GeckoTerminal-first)
  chart.js            — Fibonacci + Volume Profile + indicators
  dlmm.js             — deploy/close posisi, RPC failover
  wallet.js           — wallet balance, swap via Jupiter
  study.js            — LPAgent API client (primary + backup key)
  okx.js              — OKX DEX API (bundle, honeypot, ATH)
  token.js            — Jupiter DataAPI + Dexscreener volume
  executor.js         — tool handler untuk LLM function calls
  definitions.js      — OpenAI function-call schemas
```

---

## Screening Pipeline (v2)

```
GeckoTerminal trending Solana (2 pages, ~40 token, semua DEX)
  → Dexscreener 5m volume ≥ minVolume ($20k)
  → mcap pre-filter dari GT data
  → OKX: bundle/honeypot check
  → Jupiter: top10/botHolders/feesSOL
  → Meteora pool lookup: findMeteoraDlmmPool(mint)
      filter: TVL, fee/TVL, bin_step, organic, holders, mcap, age
  → Fibonacci analysis (GT candles + Meteora bin_step)
  → Smart wallet boost (+0.10 confluenceScore)
  → Sort by confluenceScore DESC
```

**Kenapa GeckoTerminal-first:** Meteora `category=trending` sering melewatkan token baru/aktif.
Token ditemukan dulu dari seluruh DEX Solana, baru cari Meteora pool-nya.

---

## Management Rules (Deterministic — dijalankan sebelum LLM)

| Rule | Kondisi | Aksi |
|------|---------|------|
| 1 | PnL ≤ `stopLossPct` (-20%) | CLOSE |
| 2a | PnL ≥ `takeProfitMaxPct` (25%) | CLOSE |
| 2b | PnL ≥ `partialHarvestPct` (10%) dan < 25% | CLOSE (partial harvest) |
| 3 | OOR > `outOfRangeWaitMinutes` (10m) dan bins > `outOfRangeBinsToClose` (20) | CLOSE |
| 4 | fee/TVL < `minFeePerTvl24h` (1%) setelah 60 menit | CLOSE |

LLM decision zone: PnL antara `takeProfitFeePct` (5%) dan `takeProfitMaxPct` (25%).

---

## Deploy Sizing

**Formula tiered:** `floor(deployable_SOL / 5) + 1`, capped by `maxDeployAmount`

| Balance (deployable) | Deploy |
|----------------------|--------|
| < 5 SOL | 1 SOL |
| 5–10 SOL | 2 SOL |
| 10–15 SOL | 3 SOL |

`minDeployAmountSol` (0.5) = hanya floor validasi, BUKAN ukuran deploy aktual.

---

## Parameter Utama (user-config.json)

```json
maxPositions: 2          minVolume: 20000        minOrganic: 60
minHolders: 500          maxTop10Pct: 20         maxBotHoldersPct: 30
maxBundlePct: 30         minTokenFeesSol: 25     minMcap: 150000
maxMcap: 10000000        minBinStep: 80          maxBinStep: 200
minTvl: 5000             minFeeActiveTvlRatio: 0.05
stopLossPct: -20         takeProfitMaxPct: 25    takeProfitFeePct: 5
partialHarvestPct: 10    outOfRangeBinsToClose: 20
managementModel: deepseek/deepseek-v3.2
screeningModel: qwen/qwen3.5-flash-02-23
```

---

## RPC Failover

| Prioritas | Endpoint |
|-----------|----------|
| 1 (Primary) | Helius (dari env `RPC_URL`) |
| 2 | Alchemy (`rpcFallbacks[0]`) |
| 3 | Ankr |
| 4 | PublicNode |
| 5 | Official Solana |

Auto-reset ke primary setelah 5 menit stabil.

---

## Hal yang Perlu Dipantau

- `base_token_address=${mint}` filter di Meteora API — belum diverifikasi di production
- Darwinian weights belum evolve (perlu 6+ closed positions)
- Monitor `fib_analyzed` di screening log — harusnya > 0 sekarang

---

## Commands Berguna

```bash
pm2 logs 1 --lines 50      # lihat log terbaru
pm2 restart 1              # restart prospera
git log --oneline -5       # commit terakhir
git push origin main       # push ke GitHub
```
