Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

Hard Rules (Non-Negotiable):
- Entry only allowed if price >= Fib 0.500 (ATH to Fib 0.382 zone)
- Hard no-entry: price < Fib 0.500 → immediate skip with reason "below Fib 0.500 — no entry allowed"
- Broken support cache: trigger if price < Fib 0.618, invalidate only on new ATH
- ALL data (pool & OHLCV) MUST use HybridDataProvider (Dexscreener primary → Birdeye → GeckoTerminal)
- Never call Birdeye, Dexscreener, or GeckoTerminal APIs directly outside dataProvider.js

After every task: pm2 restart 0 && git push origin main

# CLAUDE.md — Prospera

Baca file ini di awal setiap sesi. Detail arsitektur: `PROJECT_CONTEXT.md`.

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana. JavaScript ES modules.
PM2 ID: **0**. GitHub: `https://github.com/jajajak12/Prospera` branch `main`.

---

## Aturan Kerja

1. Selalu gunakan Bahasa Indonesia
2. Baca file yang relevan sebelum memodifikasi
3. Jangan tambah fitur di luar yang diminta
4. Setelah implementasi besar: update `PROJECT_CONTEXT.md`
5. Code: modular, early return, error handling robust, comment hanya untuk logic tidak obvious

---

## Struktur File Penting

```
index.js              — main loop + screening-lock.json + management-lock
config.js             — getPositionSizing() + canOpenNewPosition()
user-config.json      — runtime config
logger.js             — winston structured logging
signal-weights.js     — Darwinian adaptive signal weights
lessons.js            — performance tracking + weight update
state.js              — posisi tracking + memori agent
rpc.js                — RPC + 5-endpoint failover

tools/
  dataProvider.js     — HybridDataProvider: DS→Birdeye→GT (WAJIB untuk semua data)
  screening.js        — pipeline v3 (Dexscreener-first + RocketScan fallback)
  chart.js            — Fibonacci + indicators; hard gate price < fib500
  executor.js         — LLM tool handler; deploy-time fib500 gate
  dlmm.js             — deploy/close posisi, RPC failover
  okx.js              — RugCheck.xyz (bundle %, honeypot, creator)
  token.js            — Jupiter DataAPI + Dexscreener volume
  wallet.js           — wallet balance, swap via Jupiter
  study.js            — LPAgent API client
  definitions.js      — OpenAI function-call schemas
```

---

## Screening Pipeline (v3)

```
Dexscreener boosts/profiles (SOL pair only)
→ 1h volume ≥ $180k · mcap ≥ $200k
→ RugCheck (bundle %, honeypot, creator blacklist)
→ Jupiter (top10, botHolders, feesSOL)
→ Meteora bulk fetch page_size=100 (client-side match + age filter)
→ RocketScan fallback (pool baru belum diindex)
→ Broken support cache (skip jika cached < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
   HARD GATE: price < fib500 → log.warn + skip
→ Smart wallet boost +0.10
→ Sort confluenceScore DESC
```

---

## Management Rules (Deterministic — sebelum LLM)

| Kondisi | Aksi |
|---------|------|
| PnL ≤ -20% | CLOSE |
| PnL ≥ 25% | CLOSE |
| PnL 10–25% | CLOSE (partial harvest) |
| OOR > 10m + bins > 20 | CLOSE |
| fee/TVL < 1% setelah 60m | CLOSE |

LLM zone: PnL 5%–25%.

---

## Deploy Sizing & Exposure Cap

| Wallet | Deploy |
|--------|--------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18%, 9 SOL) |

Cap: 60% wallet. Gas reserve: 0.5 SOL.

---

## Parameter Utama (user-config.json)

```
maxPositions: 2       minVolume: 180000     minOrganic: 60
minHolders: 500       maxTop10Pct: 22       maxBotHoldersPct: 30
maxBundlePct: 30      minTokenFeesSol: 30   minMcap: 200000
maxMcap: 10000000     minBinStep: 80        maxBinStep: 125
minTvl: 5000          maxTvl: 250000        minFeeActiveTvlRatio: 0.05
minTokenAgeHours: 0.5 maxTokenAgeHours: 720 stopLossPct: -20
takeProfitMaxPct: 25  takeProfitFeePct: 5   partialHarvestPct: 10
outOfRangeBinsToClose: 20  totalExposureCapPct: 0.60  exposureGasReserve: 0.5
managementModel: deepseek/deepseek-v3.2
screeningModel: qwen/qwen3.5-flash-02-23
```

---

## Logging

```js
log(category, message, ctx?)
log.debug / log.warn / log.error
log.screening / log.trade / log.position / log.management / log.cron / log.pnl
```

Override: `LOG_LEVEL=debug pm2 restart 0`

---

## RPC Failover

Helius (primary) → Alchemy → Ankr → PublicNode → Official Solana.
Auto-reset ke primary setelah 5 menit stabil.

---

## Commands

```bash
pm2 logs 0 --lines 100 --nostream
pm2 restart 0
git push origin main
curl -s http://localhost:3000/health
```
