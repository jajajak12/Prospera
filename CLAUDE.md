Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

---

## Hard Rules (Non-Negotiable)

**Entry:**
- Entry only allowed if price >= Fib 0.500
- Hard no-entry: `price < fib.fib500` → immediate skip before indicators
- Valid zones: ATH (> fib236) or PRIMARY (fib236–fib382)

**Broken Support Cache:**
- Trigger: price < fib618 OR crash ≥80%/24h
- Invalidate: ONLY if `currentPrice > cached.athAtRejection` (new ATH)
- File: `broken-support-cache.json`, duration 24h

**Data:**
- ALL pool data and OHLCV MUST use `hybridDataProvider` from `tools/dataProvider.js`
- Fallback chain: Dexscreener → Birdeye → GeckoTerminal
- NEVER call Birdeye/Dexscreener/GeckoTerminal APIs directly outside `dataProvider.js`
- `getOHLCV(poolAddress, timeframe, limit, chain, tokenMint?)` — unified method

**Deploy:**
- `executor.js` re-checks live price vs `fib500` before deploy
- Block if `livePrice < fib500`

After every task: `pm2 restart 0 && git push origin main`

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana.
- Strategi: Fibonacci retracement entry signals, single-sided bid_ask
- Bahasa: **JavaScript** (ES modules)
- PM2 process ID: **0** (name: `prospera`)
- GitHub: `https://github.com/jajajak12/Prospera` branch `main`

---

## Aturan Kerja

1. Selalu gunakan Bahasa Indonesia
2. Baca file yang relevan sebelum memodifikasi
3. Jangan tambah fitur di luar yang diminta
4. Setelah implementasi besar: update `PROJECT_CONTEXT.md`

---

## Struktur File

```
index.js              — main loop + screening-lock.json + management-lock
config.js             — getPositionSizing() + canOpenNewPosition()
user-config.json      — runtime config

tools/
  dataProvider.js     — HybridDataProvider (WAJIB untuk semua data)
  screening.js        — pipeline v3 (Dexscreener-first + RocketScan fallback)
  chart.js            — Fibonacci + indicators; hard gate price < fib500
  executor.js         — LLM tool handler; deploy-time fib500 gate
  dlmm.js             — deploy/close posisi, RPC failover
  okx.js              — RugCheck.xyz (bundle %, honeypot, creator)
  token.js            — Jupiter DataAPI + Dexscreener volume
  wallet.js           — wallet balance, swap via Jupiter
  study.js            — LPAgent API client
  definitions.js      — OpenAI function-call schemas

signal-weights.js     — Darwinian adaptive signal weights
lessons.js            — performance tracking + weight update
logger.js             — winston structured logging
state.js              — posisi tracking + memori agent
rpc.js                — RPC connection + 5-endpoint failover
```

---

## Screening Pipeline

```
Dexscreener boosts/profiles (SOL pair only)
→ 1h volume ≥ $100k
→ mcap pre-filter
→ RugCheck (bundle %, honeypot, creator blacklist)
→ Jupiter (top10, bot holders, fees SOL)
→ Meteora bulk fetch (page_size=100, match client-side)
→ RocketScan fallback
→ Broken support cache check (skip if cached < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
   HARD GATE: price < fib500 → skip sebelum indicators
→ Smart wallet boost (+0.10)
→ Sort by confluenceScore DESC
```

---

## Management Rules

| Rule | Kondisi | Aksi |
|------|---------|------|
| 1 | PnL ≤ -20% | CLOSE |
| 2a | PnL ≥ 25% | CLOSE |
| 2b | PnL ≥ 10% dan < 25% | CLOSE (partial harvest) |
| 3 | OOR > 10m dan bins > 20 | CLOSE |
| 4 | fee/TVL < 1% setelah 60m | CLOSE |

LLM zone: PnL 5%–25%.

---

## Deploy Sizing

| Wallet | Deploy |
|--------|--------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18%, 9 SOL) |

Max 60% wallet deployed. Gas reserve 0.5 SOL.

---

## Parameter Utama

```
maxPositions: 2       minVolume: 100000     minOrganic: 60
minHolders: 500       maxTop10Pct: 20       maxBotHoldersPct: 30
maxBundlePct: 30      minTokenFeesSol: 30   minMcap: 150000
maxMcap: 5000000      minBinStep: 80        maxBinStep: 125
minTvl: 5000          maxTvl: 250000        minFeeActiveTvlRatio: 0.05
minTokenAgeHours: 0.5 maxTokenAgeHours: 720 stopLossPct: -20
takeProfitMaxPct: 25  takeProfitFeePct: 5   partialHarvestPct: 10
totalExposureCapPct: 0.60  exposureGasReserve: 0.5
managementModel: deepseek/deepseek-v3.2
screeningModel: qwen/qwen3.5-flash-02-23
```

---

## Commands

```bash
pm2 logs 0 --lines 100 --nostream
pm2 restart 0
git push origin main
curl -s http://localhost:3000/health
```
