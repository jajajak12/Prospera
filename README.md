# Prospera

Autonomous DLMM LP agent untuk pool Meteora di Solana. Entry sinyal berbasis Fibonacci retracement dari ATH, filter keamanan berlapis, auto backtesting, dan self-learning dari history posisi.

**Disclaimer: Use at your own risk. Not financial advice.**

---

## Current Status — Phase 3 (April 2026)

**Currently running: Upgraded Minimal Version for Phase 3 Stability Test (7-day live monitoring)**

Active monitoring goals:
- Performa: PnL per posisi, total PnL, win rate
- Drawdown: max exposure cap 60%, OOR time
- Circuit breaker: LLM fallback behavior, cooldown cycles
- Screening accuracy: false positive/negative rate
- Data freshness: Dexscreener stale rate, GeckoTerminal fallback rate
- Cron health: management cycle, screening cycle, morning briefing, daily backtest

Feature status:
- Morning Briefing: upgraded (wallet balance, deploy/pos, exposure cap, perf, fees, strategy params)
- Daily Backtest: active 00:00 UTC (7d+14d), sweep suggestion via Telegram
- Telegram: /positions, /status, /briefing, /backtest, /close, /screening, /management, /help
- REPL, /sweep, enhanced /status: deferred until post-7-day test

### Nota Teknis

- **Full version** (index.js.bak, 1,507 lines) — di-archive sementara. Contains REPL mode + extra Telegram commands (/sweep, enhanced /status). Tidak di-running karena ada unresolved module issue (ERR_AMBIGUOUS_MODULE_SYNTAX) di Node.js v22.
- **Minimal version** — pilihan stabil untuk production. Semua fitur critical sudah ada. Fitur dari full bisa di-port satu-per-satu setelah 7 hari test stabil.
- Riwayat fix penting: state.json positions guard (b923c42), Layer 4 mcap thresholds (ee49e80), volume priority chain (136599a), Object.entries/keys null guards (c0a403d, b754914)

---

## Strategi Entry

### Zone Fibonacci

```
ATH Zone (di atas 0.236)       → Pre-posisi, harga dekat ATH
Primary Zone (0.236 – 0.382)   → Entry ideal, pullback dangkal ✓ RECOMMENDED
Secondary Zone (0.382 – 0.500)  → Entry valid, pullback lebih dalam
Hard Gate: Fib 0.500            → HARUS di atas ini. Di bawah = SKIP langsung.
```

### Syarat Entry (semua harus lolos)

| Sinyal | Kondisi |
|--------|---------|
| Harga | Di atas Fib 0.500 (hard gate — no exceptions) |
| Tren EMA | EMA20 > EMA50 |
| Momentum RSI | RSI >= `rsiMin` (default 45) + slope >= -2.0 |
| Volatilitas | ATR% < bin_step% × 4 |

### Confluence Score

Skor dasar dari posisi harga (bobot 0.6) + volume POC (bobot 0.4).

| Kondisi | Penyesuaian |
|---------|------------|
| Primary zone | +0.10 |
| Hidden Bullish Divergence | +0.15 |
| Slope RSI > 3 | +0.05 |
| Smart wallet ada di pool | +0.10 |

Kandidat di bawah `minConfluenceScore` difilter sebelum masuk ke LLM decision.

### bins_below Calculation

- **ATH Zone**: dihitung dari Fib 0.236 → Fib 0.618
- **Fib Zone**: dihitung dari harga saat ini → swing low terdekat di bawah Fib 0.618 minus buffer ATR. Fallback ke Fib 0.786 jika tidak ada swing low.

Dibatasi di [35, 90]. `bins_above` selalu 0.

### Position Sizing

| Saldo Wallet | Deploy per Posisi |
|-------------|-------------------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18% wallet, 9 SOL) |

**Exposure Cap: 60%** — Total deploy tidak boleh melebihi 60% saldo deployable (setelah gas reserve 1 SOL).

---

## Filter Keamanan Token

Diterapkan berurutan (murah ke mahal):

1. **Discovery** — Dexscreener boosted tokens + profiles + RocketScan SOL-pair DLMM pools
2. **Blacklist** — `token-blacklist.json` (mint) + `dev-blocklist.json` (deployer)
3. **Volume 1h** — >= $150k dari semua DEX (`volume.h1` Dexscreener)
4. **MCap pre-filter** — $180k–$10M
5. **RugCheck** — bundle %, honeypot detection
6. **Jupiter safety** — top10 holders %, bot holders %, fees SOL
7. **Pool matching** — Meteora pool-discovery-api (primary) → RocketScan fallback
8. **Pre-pool cap** — Ranking by volume, TOP 10 saja (rate limit protection)
9. **Fibonacci + RSI + EMA** — USD-consistent OHLCV (GeckoTerminal primary)
10. **Smart wallet check** — confluence +0.10 kalau smart wallet aktif di pool

---

## Data Providers

> ⚠️ **Aturan utama: SEMUA harga sudah SOL end-to-end sejak migrasi April 2026. `pool.price` (Meteora native SOL) adalah primary price untuk Fib comparison. `getReliableSOLPrice` digunakan sebagai fallback.**

### Provider Priority

| Priority | Provider | Use Case |
|----------|----------|----------|
| **Discovery** | Dexscreener | Trending tokens, volume 1h, pool data (price/mcap/liquidity) |
| **Discovery (alt)** | RocketScan | Graduated pump.fun tokens yang miss Dexscreener boosts |
| **OHLCV Primary** | GeckoTerminal | USD-consistent OHLCV candles untuk Fib/RSI/EMA calculation |
| **OHLCV Fallback** | CoinGecko | Jika GeckoTerminal down |
| **Backtest** | GeckoTerminal | Historical OHLCV untuk backtest replay |
| **Pool Detail** | Meteora dlmm.datapi.meteora.ag | Pool TVL, fee, bin_step, holders |

### Kenapa Dexscreener Bukan untuk Technical Analysis?

Dexscreener TOKEN/SOL pairs return harga dalam **SOL denomination**, bukan USD. Ini menyebabkan RSI/EMA/Fib calculation mismatch kalau compared against USD currentPrice.

### Kenapa Birdeye Tidak Dipakai?

Birdeye API key returns **401 permanent** sejak April 2026. Tidak reliable untuk production.

### Alur Screening (Flowchart)

```
1. Discovery           → Dexscreener (boosts + profiles) + RocketScan (SOL-pair DLMM)
2. Blacklist filter    → token-blacklist.json + dev-blocklist.json
3. Volume 1h           → Dexscreener volume.h1 >= $150k
4. MCap pre-filter     → $180k – $10M
5. RugCheck            → bundle %, honeypot detection
6. Jupiter safety      → top10 holders, bot %, fees SOL
7. Pool matching       → Meteora pool-discovery-api → RocketScan fallback
8. Pre-pool cap        → Ranking by volume, TOP 10 SAJA
9. Fib/RSI/EMA         → GeckoTerminal OHLCV (USD-consistent)
10. Smart wallet check → +0.10 confluence kalau smart wallet aktif
11. LLM deploy decision → SCREENER role
```

---

## Backtesting & Auto Parameter Tuning

### Engine

Backtest replay OHLCV historis dari GeckoTerminal. Simulasi entry/exit Fibonacci. PnL bersifat **estimasi** (fee ~40% in-range utilization, IL disederhanakan).

### Auto Sweep (02:00 setiap hari)

1. Ambil pool yang baru ditutup (7 hari terakhir)
2. Jalankan parameter sweep: RSI × Confluence combinations
3. Kalau win rate improvement >= +7% dengan consensus > 50% → kirim proposal Telegram
4. User konfirmasi `/apply_sweep` atau `/reject_sweep`

**Parameter sweep:** 16 kombinasi dari `rsiMin: [40, 44, 48, 52]` × `minConfluenceScore: [0.25, 0.30, 0.35, 0.40]`

### On-Demand via Telegram

```
/backtest        — 7 hari terakhir
/backtest 30d   — 30 hari terakhir
/backtest all   — sepanjang waktu
```

### Aggregate History Coverage

| Timeframe | History |
|-----------|---------|
| 1m | ~16.7 jam |
| 5m | ~3.5 hari |
| 15m | ~10 hari (default) |
| 60m | ~42 hari |

---

## Manajemen Posisi

### Aturan Penutupan Bertingkat

| Kondisi | Aksi |
|---------|------|
| PnL <= -20% | Stop loss — wajib tutup |
| PnL >= 25% | Auto take-profit — wajib tutup |
| PnL 10–25% | Partial harvest — tutup |
| OOR > 10 menit AND active bin > 20 bin keluar | Tutup — keluar Fib zone |
| Fee/TVL < 1% setelah 60 menit | Tutup — yield rendah |
| Loss >= 3× unclaimed fees setelah 2 jam | Tutup — IL overtaking fees |
| PnL 5%–25% | LLM decision zone — tahan atau tutup |

### Auto-Claim Fees

Unclaimed fees di-claim otomatis ketika:
- Fees >= 2% dari total position value, **DAN**
- Harga saat ini >= Fib 0.382 (harga masih di zona valid)

### After Close

Base token di-swap kembali ke SOL via Jupiter (lewat token < $0.10).

---

## Fitur Self-Learning

### Darwinian Signal Weighting

Track sinyal entry yang historically menghasilkan trade profitable. Bobot sinyal adaptif (min 0.3, max 2.5). Disimpan di `signal-weights.json`. LLM secara otomatis memprioritaskan sinyal ⬆ saat memilih antar kandidat.

Signals tracked: `organic_score`, `fee_tvl_ratio`, `volume_5m`, `confluence_score`, `fib_zone`, `bin_step`, `volatility`.
Update trigger: setelah 6+ posisi ditutup. Lift analysis win vs loss.

### Chart Lesson Analysis

Setelah setiap posisi ditutup, LLM mengevaluasi **mengapa** trade berhasil atau gagal berdasarkan chart signals (Fib zone, RSI, ATR, hidden divergence, smart wallet). Insight disimpan ke `lessons.json` dengan tag `chart_lesson` dan diinjeksikan ke SCREENER prompt untuk memperbaiki keputusan entry di masa depan.

Outcome classification:
- PnL >= 5% → `CHART [PROFIT]`
- PnL >= -3% → `CHART [NEUTRAL]`  
- PnL < -3% → `CHART [LOSS]`

### Smart Wallet Tracker

Wallet dengan win rate >= 65% dari >= 3 observasi → auto-promoted ke smart wallet list. Kalau smart wallet aktif di pool kandidat → confluenceScore +0.10.

---

## Telegram Commands

| Command | Deskripsi |
|---------|-----------|
| `/status` | Uptime, saldo wallet, posisi terbuka |
| `/positions` | Daftar posisi + PnL |
| `/close <n>` | Tutup posisi nomor n |
| `/backtest [7d\|30d\|all]` | Jalankan backtest |
| `/apply_sweep` | Apply proposal sweep |
| `/reject_sweep` | Tolak proposal sweep |
| `/set <n> <notes>` | Set catatan untuk posisi |

---

## Jadwal Siklus

| Siklus | Interval |
|--------|----------|
| Management | Setiap 5 menit |
| Screening | Setiap 15 menit |
| Morning Briefing | Setiap hari 08:00 |
| Backtest + Sweep | Setiap hari 02:00 |

---

## Installation

### 1. Clone

```bash
git clone https://github.com/jajajak12/Prospera.git
cd Prospera
```

### 2. Install Dependencies

```bash
npm install
```

> `postinstall` script otomatis menjalankan `patch-anchor.js` untuk kompatibilitas `@meteora-ag/dlmm`.

### 3. Setup Environment

```bash
cp .env.example .env
```

**Mandatory variables:**

```env
WALLET_PRIVATE_KEY=         # Solana wallet base58 private key
RPC_URL=                    # Helius recommended: https://mainnet.helius-rpc.com/?api-key=<KEY>
OPENROUTER_API_KEY=         # LLM decision-making
LPAGENT_API_KEY=            # Real-time PnL tracking
```

**Optional:**

```env
LPAGENT_API_KEY_BACKUP=     # Failover LPAgent key
TELEGRAM_BOT_TOKEN=         # Bot notifications + commands
TELEGRAM_CHAT_ID=           # Target chat ID
HEALTH_PORT=3000            # Health check port
DRY_RUN=true               # Simulasi tanpa transaksi nyata
```

> 🔒 **Security:** `WALLET_PRIVATE_KEY` punya akses penuh ke funds. JANGAN pernah commit `.env` ke git. Sudah di-gitignore.

### 4. Verifikasi (Dry Run)

```bash
DRY_RUN=true node index.js
```

Kalau agent mulai scanning tanpa error → instalasi berhasil.

### 5. Production Run (PM2)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs prospera --lines 50
```

### 6. Health Monitoring

```bash
curl http://localhost:3000/health
```

**UptimeRobot** (gratis): add monitor HTTP → `http://your-server:3000/health` → interval 5 menit.

---

## Konfigurasi Utama (`user-config.json`)

Edit langsung file ini untuk override default di `config.js`:

```json
{
  "rsiMin": 45,
  "minConfluenceScore": 0.30,
  "maxPositions": 2,
  "partialHarvestPct": null,
  "totalExposureCapPct": 0.60
}
```

### Parameter Table

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `maxPositions` | 2 | Max posisi concurrent |
| `minBinStep` / `maxBinStep` | 80 / 125 | Range bin step pool (bps) |
| `minVolume` | 150000 | Min volume 1h semua DEX ($) |
| `minFeeActiveTvlRatio` | 0.05 | Min fee/active TVL ratio (24h) |
| `minMcap` / `maxMcap` | 180k / 10M | Range mcap ($) |
| `minTokenAgeHours` | 0.5 | Min usia token (jam) |
| `rsiMin` | 45 | RSI minimum + slope >= -2.0 |
| `minConfluenceScore` | 0 | Minimum confluence gate |
| `totalExposureCapPct` | 0.60 | Max % saldo deployable |
| `exposureGasReserve` | 0.5 | SOL reserved untuk gas |
| `stopLossPct` | -20 | Stop loss threshold |
| `takeProfitMaxPct` | 25 | Auto take-profit threshold |
| `partialHarvestPct` | null | Auto-close di PnL ini (null = off) |
| `maxBundlePct` | 30 | Max bundle % (RugCheck) |
| `maxTop10Pct` | 22 | Max top10 holders % |
| `maxBotHoldersPct` | 50 | Max bot holder % |
| `maxTechnicalAnalysisCandidates` | 10 | Max kandidat ke TA stage |
| `autoBacktest` | false | Filter backtest sebelum deploy |
| `managementIntervalMin` | 5 | Management cycle interval |

---

## Project Structure

```
Prospera/
├── index.js              # Entry utama: cron + Telegram + health server
├── agent.js              # ReAct loop (LLM → tool call → repeat)
├── backtest.js          # Backtest engine: OHLCV replay + PnL simulasi
├── config.js            # Runtime config + tiered deploy sizing
├── user-config.json     # User override (high priority)
├── state.js             # Position registry + trailing TP + PnL
├── lessons.js           # Learning engine: threshold evolution
├── pool-memory.js       # Per-pool history + snapshots
├── smart-wallets.js     # Smart money tracker + auto-promotion
├── signal-weights.js    # Darwinian adaptive signal weights
├── telegram.js          # Telegram bot + commands
├── prompt.js            # System prompt per role
├── logger.js            # Winston logging + rotation
├── rpc.js               # RPC failover logic
└── tools/
    ├── chart.js         # Fib/EMA/RSI/ATR calculation
    ├── screening.js     # Discovery + filters + signals
    ├── dataProvider.js  # Hybrid: Dexscreener + GeckoTerminal + CoinGecko
    ├── executor.js      # Tool dispatcher + safety + post-close
    ├── dlmm.js          # Meteora DLMM SDK wrapper
    ├── wallet.js        # SOL balance + Jupiter swap
    ├── okx.js           # RugCheck.xyz API
    ├── token.js         # Jupiter DataAPI
    └── study.js         # LPAgent PnL integration
```

---

## Troubleshooting

### `ERR_AMBIGUOUS_MODULE_SYNTAX` (Node.js v22+ ESM)

```bash
pm2 restart prospera --update-env
```

### LLM API 401 Unauthorized

Cek `OPENROUTER_API_KEY` atau `minimaxApiKey` di `.env`. Restart:

```bash
pm2 restart prospera --update-env
```

### Screening Stuck (lock file)

```bash
cat screening-lock.json   # Cek apakah ada timeout aktif
# Biasanya timeout 10 menit. Tunggu atau hapus kalau stuck.
```

### Dry Run vs Real Mode

```bash
# Dry run (simulasi, tidak ada transaksi nyata)
DRY_RUN=true node index.js

# Real mode
pm2 start ecosystem.config.cjs
```

---

## Safety Rules (Hardcoded)

1. **Hard gate Fib 0.500** — Di bawah = skip, no exceptions
2. **Exposure cap 60%** — Tidak pernah exceed
3. **Gas reserve 1 SOL** — Selalu buffer untuk tx fees
4. **Max 2 posisi** — Dibatasi `maxPositions`
5. **Stop loss -20%** — Mandatory close

---

## License

MIT. Use at your own risk.
