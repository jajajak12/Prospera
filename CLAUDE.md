Caveman mode ULTRA STRICT - NO EXCEPTIONS.

Rules (must follow):
- Output ONLY code changes. Nothing else.
- NO "● Update", NO "●", NO "Now", NO "Let me", NO "Dua masalah", NO explanations.
- NO progress text, NO "Read 1 file", NO "CHANGED" comments unless in code.
- Just pure code blocks with // CHANGED on modified lines if necessary.
- Maximum 1 short line summary at the very end.
- Never describe what you did or what you will do.

You are Prospera Data Provider Engineer.

# CLAUDE.md — Prospera

Baca file ini di awal setiap sesi. Berisi konteks proyek, aturan kerja, dan status terkini.
Untuk detail lengkap perubahan arsitektur, baca `PROJECT_CONTEXT.md`.

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana.
- Strategi: Fibonacci retracement entry signals, single-sided bid_ask
- Bahasa: **JavaScript** (ES modules) — bukan TypeScript
- PM2 process ID: **0** (name: `prospera`) — bukan 1
- GitHub: `https://github.com/jajajak12/Prospera` branch `main`

---

## Filosofi

- **Teknikal-first**, bukan volatility-based
- Kualitas sinyal > kuantitas — lebih baik skip deal bagus daripada masuk posisi buruk
- Safety selalu diutamakan: blacklist, holder distribution, bundle % wajib dicek
- Setiap keputusan harus didasarkan pada confluence yang kuat

---

## Aturan Kerja

1. **Selalu gunakan Bahasa Indonesia**
2. Setelah setiap perubahan kode: restart PM2 (`pm2 restart 0`) + push ke GitHub
3. Baca file yang relevan sebelum memodifikasi — jangan asumsi struktur kode
4. `bypassPermissions` aktif — tidak perlu minta konfirmasi untuk tool calls
5. Jangan tambah fitur di luar yang diminta
6. Setelah implementasi besar: update `PROJECT_CONTEXT.md`
7. **Setelah setiap task selesai: update README.md + push ke GitHub**

## Aturan Coding

- Code modular, clean, readable — mudah di-maintain
- Gunakan early return
- Error handling robust dengan retry dan fallback
- Tambahkan comment hanya untuk logic yang tidak obvious (Fib, confluence, safety)
- Jangan tambah docstring/comment ke code yang tidak diubah

---

## Struktur File Penting

```
index.js              — main loop: deterministic rules + LLM agent calls
config.js             — config loader + getPositionSizing() + exposure cap functions
user-config.json      — runtime config (edit ini untuk ubah parameter)
prompt.js             — system prompt builder (SCREENER/MANAGER/GENERAL)
signal-weights.js     — Darwinian adaptive signal weights
rpc.js                — RPC connection + 5-endpoint failover
logger.js             — winston structured logging (combined + error log harian)
lessons.js            — performance tracking + weight update trigger
state.js              — posisi tracking + memori agent

tools/
  screening.js        — pipeline screening v3 (Dexscreener-first + RocketScan fallback)
  chart.js            — Fibonacci + indicators; broken support = price < fib500
  dataProvider.js     — HybridDataProvider: Dexscreener → Birdeye → GeckoTerminal
  dlmm.js             — deploy/close posisi, RPC failover
  wallet.js           — wallet balance, swap via Jupiter
  study.js            — LPAgent API client (primary + backup key)
  okx.js              — RugCheck.xyz API (bundle %, honeypot, creator address)
  token.js            — Jupiter DataAPI + Dexscreener volume
  executor.js         — tool handler untuk LLM function calls; deploy-time fib500 gate
  definitions.js      — OpenAI function-call schemas
```

---

## Screening Pipeline (v2 — GeckoTerminal-first + RocketScan fallback)

```
GeckoTerminal trending Solana (2 pages, ~40 token, semua DEX)
  → Dexscreener 1h volume ≥ minVolume ($100k default)
  → mcap pre-filter dari GT data
  → RugCheck: bundle % check, honeypot/rugged flag, creator blacklist
  → Jupiter: top10/botHolders/feesSOL
  → Meteora bulk fetch (fetchMeteoraDlmmPoolMap):
      satu request page_size=100, timeframe=24h
      filter API: tvl, bin_step, fee/tvl ratio, organic, holders, mcap
      match client-side by token_x.address
      filter age client-side dari token_x.created_at
  → RocketScan fallback (Step 7b):
      token tanpa pool di Meteora API → cek rocketscan.fun/api/pools?tokenBMint=
      detail pool dari dlmm.datapi.meteora.ag
      apply manual filters: bin_step, TVL, holders, mcap, organic, age, pair=SOL
  → Fibonacci analysis (GT candles + Meteora bin_step)
  → Broken support cache (3 jam, invalidate jika harga naik >50%)
  → Smart wallet boost (+0.10 confluenceScore)
  → Sort by confluenceScore DESC
```

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

## Deploy Sizing & Exposure Cap

**Tiered position sizing** via `getPositionSizing(walletSol)`:

| Saldo Wallet | Deploy per Posisi |
|--------------|-------------------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18% wallet, 9 SOL) |

**Total Exposure Cap:** Max 60% dari saldo deployable (setelah 0.5 SOL gas reserve).
Cek via `canOpenNewPosition()` sebelum setiap screening — jika cap terlampaui, screening dilewati.

---

## Parameter Utama (user-config.json)

```
maxPositions: 2             minVolume: 100000        minOrganic: 60
minHolders: 500             maxTop10Pct: 20          maxBotHoldersPct: 30
maxBundlePct: 30            minTokenFeesSol: 30      minMcap: 150000
maxMcap: 5000000            minBinStep: 80           maxBinStep: 125
minTvl: 5000                maxTvl: 250000           minFeeActiveTvlRatio: 0.05
minTokenAgeHours: 0.5       maxTokenAgeHours: 720    stopLossPct: -20
takeProfitMaxPct: 25        takeProfitFeePct: 5      partialHarvestPct: 10
outOfRangeBinsToClose: 20   totalExposureCapPct: 0.60  exposureGasReserve: 0.5
managementModel: deepseek/deepseek-v3.2
screeningModel: qwen/qwen3.5-flash-02-23
```

---

## Logging (winston)

`logger.js` menggunakan winston + winston-daily-rotate-file.

**File log di `./logs/`:**
- `combined-YYYY-MM-DD.log` — semua level, human-readable
- `error-YYYY-MM-DD.log` — error saja, format JSON
- `actions-YYYY-MM-DD.jsonl` — audit trail tool execution
- `snapshots-YYYY-MM-DD.jsonl` — portfolio snapshots

**API:**
```js
log(category, message, ctx?)        // general (info level)
log.debug(category, message, ctx?)
log.warn(category, message, ctx?)
log.error(category, message, ctx?)

// Domain shortcuts:
log.screening(msg, ctx)   log.trade(msg, ctx)     log.position(msg, ctx)
log.confluence(msg, ctx)  log.pnl(msg, ctx)       log.rpc(msg, ctx)
log.management(msg, ctx)  log.cron(msg, ctx)

// ctx fields: pool, position, pair, token, confluenceScore, pnl, action, reason, step
```

Override level: `LOG_LEVEL=debug pm2 restart 0`

---

## Fungsi Config Penting

```js
getPositionSizing(walletSol)                        // tiered deploy amount
calculateCurrentExposure(positions)                  // total SOL in active positions
canOpenNewPosition(proposed, current, walletSol)     // exposure cap check
computeDeployAmount(walletSol)                       // deprecated, wrapper ke getPositionSizing
reloadScreeningThresholds()                          // hot-reload config tanpa restart
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

## Safety Rules (Non-Negotiable)

- Selalu respect blacklist (token & dev wallet)
- Cek holder distribution dan bundle % sebelum deploy (via RugCheck + Jupiter)
- RPC failover harus aktif
- Volume Profile (POC/VAL) bersifat **informational only** — bukan hard gate
- `autoBacktest` default **false** — jangan asumsi aktif kecuali user minta
- Exposure cap 60% harus selalu dicek sebelum open posisi baru

---

## Hal yang Perlu Dipantau

- Darwinian weights belum evolve (perlu 6+ closed positions)
- Signal attribution baru bisa dievaluasi setelah ada closed positions
- GeckoTerminal rate limit (HTTP 429) terjadi berulang — pertimbangkan delay antar page
- Monitor entry rate setelah fix screening pipeline

---

## Commands Berguna

```bash
pm2 logs 0 --lines 100 --nostream   # log terbaru
pm2 restart 0                        # restart prospera
git log --oneline -5                 # commit terakhir
git push origin main                 # push ke GitHub
curl -s http://localhost:3000/health  # health check
```
