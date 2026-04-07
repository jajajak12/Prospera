Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

Hard Rules (Non-Negotiable):
- Entry only allowed if price >= Fib 0.500 (ATH to Fib 0.382 zone)
- Hard no-entry: price < Fib 0.500 → immediate skip
- Broken support cache: trigger if price < Fib 0.618, invalidate only on new ATH
- ALL data (pool & OHLCV) MUST use HybridDataProvider (Dexscreener primary → Birdeye → GeckoTerminal)
- Never call Birdeye/Dexscreener/GeckoTerminal directly outside dataProvider.js

After every task: pm2 restart 0 && git push origin main

# CLAUDE.md — Prospera

Baca file ini di awal setiap sesi. Detail arsitektur lengkap: `PROJECT_CONTEXT.md`.

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana.
- Strategi: Fibonacci retracement entry signals, single-sided bid_ask
- Bahasa: **JavaScript** (ES modules) — bukan TypeScript
- PM2 process ID: **0** (name: `prospera`) — bukan 1
- GitHub: `https://github.com/jajajak12/Prospera` branch `main`

---

## Aturan Kerja

1. **Selalu gunakan Bahasa Indonesia**
2. Setelah setiap perubahan kode: `pm2 restart 0` + push ke GitHub
3. Baca file yang relevan sebelum memodifikasi — jangan asumsi struktur kode
4. `bypassPermissions` aktif — tidak perlu minta konfirmasi untuk tool calls
5. Jangan tambah fitur di luar yang diminta
6. Setelah implementasi besar: update `PROJECT_CONTEXT.md`

### Aturan Coding
- Code modular, clean, readable
- Gunakan early return
- Error handling robust dengan retry dan fallback
- Comment hanya untuk logic yang tidak obvious

---

## Struktur File Penting

```
index.js              — main loop: deterministic rules + LLM agent; screening-lock.json
config.js             — getPositionSizing() + canOpenNewPosition() + exposure cap
user-config.json      — runtime config (edit ini untuk ubah parameter)
prompt.js             — system prompt builder (SCREENER/MANAGER/GENERAL)
signal-weights.js     — Darwinian adaptive signal weights
rpc.js                — RPC connection + 5-endpoint failover
logger.js             — winston structured logging
lessons.js            — performance tracking + weight update trigger
state.js              — posisi tracking + memori agent

tools/
  dataProvider.js     — HybridDataProvider (WAJIB untuk semua data)
  screening.js        — pipeline v3 (Dexscreener-first + RocketScan fallback)
  chart.js            — Fibonacci + indicators; hard gate price < fib500
  executor.js         — LLM tool handler; deploy-time fib500 gate
  dlmm.js             — deploy/close posisi, RPC failover
  wallet.js           — wallet balance, swap via Jupiter
  study.js            — LPAgent API client (primary + backup key)
  okx.js              — RugCheck.xyz API (bundle %, honeypot, creator)
  token.js            — Jupiter DataAPI + Dexscreener volume
  definitions.js      — OpenAI function-call schemas
```

---

## Screening Pipeline (v3 — Dexscreener-first + HybridDataProvider)

```
Dexscreener boosts/profiles (SOL pair only)
→ 1h volume ≥ $180k
→ mcap ≥ $200k pre-filter
→ RugCheck: bundle %, honeypot/rugged flag, creator blacklist
→ Jupiter: top10/botHolders/feesSOL
→ Meteora bulk fetch (page_size=100, timeframe=24h)
    filter API: tvl, bin_step, fee/tvl, organic, holders, mcap
    match client-side by token_x.address
    age filter client-side dari token_x.created_at
→ RocketScan fallback (Step 7b)
    token tanpa pool → rocketscan.fun/api/pools?tokenBMint=
    detail dari dlmm.datapi.meteora.ag
→ Broken support cache (skip jika cached price < fib618)
→ Fibonacci analysis via hybridDataProvider.getOHLCV()
    HARD GATE: price < fib500 → skip (log.warn + return SKIP)
→ Smart wallet boost (+0.10 confluenceScore)
→ Sort by confluenceScore DESC
```

---

## Management Rules (Deterministic — sebelum LLM)

| Rule | Kondisi | Aksi |
|------|---------|------|
| 1 | PnL ≤ -20% | CLOSE |
| 2a | PnL ≥ 25% | CLOSE |
| 2b | PnL ≥ 10% dan < 25% | CLOSE (partial harvest) |
| 3 | OOR > 10m dan bins > 20 | CLOSE |
| 4 | fee/TVL < 1% setelah 60m | CLOSE |

LLM decision zone: PnL 5%–25%.

---

## Deploy Sizing & Exposure Cap

| Saldo Wallet | Deploy per Posisi |
|--------------|-------------------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18% wallet, 9 SOL) |

Max 60% wallet deployed. Gas reserve 0.5 SOL.
Check via `canOpenNewPosition()` sebelum setiap screening.

---

## Parameter Utama (user-config.json)

```
maxPositions: 2             minVolume: 180000        minOrganic: 60
minHolders: 500             maxTop10Pct: 22          maxBotHoldersPct: 30
maxBundlePct: 30            minTokenFeesSol: 30      minMcap: 200000
maxMcap: 10000000           minBinStep: 80           maxBinStep: 125
minTvl: 5000                maxTvl: 250000           minFeeActiveTvlRatio: 0.05
minTokenAgeHours: 0.5       maxTokenAgeHours: 720    stopLossPct: -20
takeProfitMaxPct: 25        takeProfitFeePct: 5      partialHarvestPct: 10
outOfRangeBinsToClose: 20   totalExposureCapPct: 0.60  exposureGasReserve: 0.5
managementModel: deepseek/deepseek-v3.2
screeningModel: qwen/qwen3.5-flash-02-23
```

---

## Logging (winston)

```js
log(category, message, ctx?)
log.debug / log.warn / log.error
log.screening / log.trade / log.position / log.management / log.cron / log.pnl
// ctx fields: pool, position, pair, token, confluenceScore, pnl, action, reason
```

Override level: `LOG_LEVEL=debug pm2 restart 0`

---

## RPC Failover

Helius (primary) → Alchemy → Ankr → PublicNode → Official Solana.
Auto-reset ke primary setelah 5 menit stabil.

---

## Commands Berguna

```bash
pm2 logs 0 --lines 100 --nostream   # log terbaru
pm2 restart 0                        # restart prospera
git log --oneline -5                 # commit terakhir
git push origin main                 # push ke GitHub
curl -s http://localhost:3000/health  # health check
```
