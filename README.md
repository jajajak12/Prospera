# Prospera

Autonomous DLMM LP agent untuk pool Meteora di Solana. Entry sinyal berbasis Fibonacci retracement dari ATH, filter keamanan berlapis, dan self-learning dari history posisi.

**Disclaimer: Use at your own risk. Not financial advice.**

---

## Current Status — Phase 3 (April 2026)

**Currently running: Minimal Version — Phase 3 Live Monitoring**

Active monitoring goals:
- Performa: PnL per posisi, total PnL, win rate
- Drawdown: OOR time, loss vs fees ratio
- Circuit breaker: LLM fallback behavior, cooldown cycles
- Screening accuracy: false positive/negative rate
- Cron health: management cycle, screening cycle, morning briefing

Feature status:
- Morning Briefing: aktif 09:00 UTC (wallet balance, deploy/pos, perf, fees, strategy params)
- Telegram: /positions, /status, /briefing, /backtest, /close, /screening, /management, /help
- Chart lesson self-learning: aktif (PROFIT/LOSS pattern dari OHLCV pre-entry)
- Darwinian signal weights: aktif (update setelah 6+ posisi ditutup)
- Smart wallet boost: sementara dinonaktifkan (LP API rate limit)
- Exposure cap: sementara dinonaktifkan untuk Phase 3 (ada bug yang sedang diinvestigasi)

---

## Strategi Entry

### Zone Fibonacci

```
ATH Zone (di atas 0.236)        → Pre-posisi, harga dekat ATH (bins_above negatif — passive bid)
Primary Zone (0.236 – 0.382)    → Entry ideal, pullback dangkal ✓ RECOMMENDED
Secondary Zone (0.382 – 0.500)  → Entry valid, pullback lebih dalam
Hard Gate: Fib 0.500             → HARUS di atas ini. Di bawah = SKIP langsung.
```

### Syarat Entry (semua harus lolos)

| Sinyal | Kondisi |
|--------|---------|
| Harga | Di atas Fib 0.500 (hard gate — no exceptions) |
| Tren EMA | EMA20 > EMA50 |
| Momentum RSI | RSI >= `rsiMin` (ATH zone: 40, Primary/Secondary: 45) + slope >= -2.0 |
| Volatilitas | ATR% < bin_step% × 4 |

### Confluence Score

Skor dasar dari posisi harga di zona Fib.

| Kondisi | Penyesuaian |
|---------|------------|
| Primary zone | +0.10 |
| Hidden Bullish Divergence | +0.15 |
| RSI slope > 3 | +0.10 |
| RSI slope > 0 | +0.05 |
| Smart wallet aktif di pool | +0.10 *(sementara dinonaktifkan)* |

> RSI slope > 3 dan slope > 0 bersifat kumulatif (max +0.15 dari slope).

Kandidat di bawah `minConfluenceScore` difilter sebelum masuk ke LLM decision.

### bins_below Calculation

- **ATH Zone**: dihitung dari Fib 0.236 → Fib 0.618. `bins_above` bernilai negatif (passive-bid positioning).
- **Fib Zone**: dihitung dari harga saat ini → swing low terdekat di bawah Fib 0.618 minus buffer ATR. Fallback ke Fib 0.786 jika tidak ada swing low. `bins_above = 0`.

`bins_below` dibatasi di [35, 90].

### Position Sizing

| Saldo Wallet | Deploy per Posisi |
|-------------|-------------------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18% wallet, 9 SOL) |

**Exposure Cap: 60%** — Total deploy tidak boleh melebihi 60% saldo deployable (setelah gas reserve 0.3 SOL). *(Sementara dinonaktifkan — Phase 3)*

---

## Filter Keamanan Token

Diterapkan berurutan (murah ke mahal):

1. **Discovery** — Dexscreener boosted tokens + profiles + RocketScan SOL-pair DLMM pools
2. **Blacklist** — `token-blacklist.json` (mint) + `dev-blocklist.json` (deployer)
3. **Volume 1h** — >= $150k dari semua DEX (`volume.h1` Dexscreener)
4. **MCap pre-filter** — $200k–$5M
5. **RugCheck** — bundle %, honeypot detection
6. **Jupiter safety** — top10 holders %, bot holders %, fees SOL
7. **Pool matching** — Meteora pool-discovery-api (primary) → RocketScan fallback
8. **Pre-pool cap** — Ranking by volume, TOP 10 saja (rate limit protection)
9. **Fibonacci + RSI + EMA** — OHLCV via HybridDataProvider (GeckoTerminal primary → Birdeye fallback)
10. **Smart wallet check** — confluence +0.10 *(sementara dinonaktifkan — LP API rate limit)*

---

## Data Providers

### Provider Priority

| Priority | Provider | Use Case |
|----------|----------|----------|
| **Discovery** | Dexscreener | Trending tokens, volume 1h, pool data (price/mcap/liquidity) |
| **Discovery (alt)** | RocketScan | Graduated pump.fun tokens yang miss Dexscreener boosts |
| **OHLCV Primary** | GeckoTerminal | OHLCV candles untuk Fib/RSI/EMA calculation |
| **OHLCV Fallback** | Birdeye | Jika GeckoTerminal down/rate-limited |
| **Pool Detail** | Meteora dlmm.datapi.meteora.ag | Pool TVL, fee, bin_step, organic score |

### Alur Screening (Flowchart)

```
1. Discovery           → Dexscreener (boosts + profiles) + RocketScan (SOL-pair DLMM)
2. Blacklist filter    → token-blacklist.json + dev-blocklist.json
3. Volume 1h           → Dexscreener volume.h1 >= $150k
4. MCap pre-filter     → $200k – $5M
5. RugCheck            → bundle %, honeypot detection
6. Jupiter safety      → top10 holders, bot %, fees SOL
7. Pool matching       → Meteora pool-discovery-api → RocketScan fallback
8. Pre-pool cap        → Ranking by volume, TOP 10 SAJA
9. Fib/RSI/EMA         → HybridDataProvider OHLCV (GeckoTerminal → Birdeye)
10. Smart wallet check → +0.10 confluence (sementara dinonaktifkan)
11. LLM deploy decision → SCREENER role
```

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
Update trigger: setelah 6+ posisi ditutup (win ≥+5%, loss ≤-5%). Lift analysis win vs loss.

### Chart Lesson Analysis

Setelah setiap posisi ditutup (PnL >= +5% atau <= -5%), LLM menganalisis **pola chart SEBELUM entry** menggunakan 40 candles OHLCV pre-entry. Fokus pada bentuk harga (V-reversal, double bottom, flag, breakdown) — bukan indikator. Insight disimpan ke `lessons.json` dan diinjeksikan ke SCREENER prompt.

Outcome classification:
- PnL >= +5% → `CHART [PROFIT]`
- PnL <= -5% → `CHART [LOSS]`
- -5% < PnL < +5% → neutral, skip

### Smart Wallet Tracker

Wallet dengan win rate >= 65% dari >= 3 observasi → auto-promoted ke smart wallet list. Kalau smart wallet aktif di pool kandidat → confluenceScore +0.10 *(sementara dinonaktifkan)*.

---

## Telegram Commands

| Command | Deskripsi |
|---------|-----------|
| `/status` | Uptime, saldo wallet, posisi terbuka, LLM provider |
| `/positions` | Daftar posisi + PnL |
| `/close <n>` | Tutup posisi nomor n |
| `/backtest [7d\|30d\|all]` | Jalankan backtest |
| `/briefing` | Trigger morning briefing manual |
| `/screening` | Trigger screening manual |
| `/management` | Trigger management cycle manual |
| `/help` | Daftar commands |

---

## Jadwal Siklus

| Siklus | Interval |
|--------|----------|
| Management | Setiap 5 menit |
| Screening | Setiap 15 menit |
| Morning Briefing | Setiap hari 09:00 UTC |
| Backtest | Setiap hari 02:00 UTC |

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
OPENROUTER_API_KEY=         # LLM decision-making (fallback)
MINIMAX_API_KEY=            # LLM primary (MiniMax M2.7)
LPAGENT_API_KEY=            # Real-time PnL tracking
```

**Optional:**

```env
LPAGENT_API_KEY_BACKUP=     # Failover LPAgent key
TELEGRAM_BOT_TOKEN=         # Bot notifications + commands
TELEGRAM_CHAT_ID=           # Target chat ID
HEALTH_PORT=3000            # Health check port
DRY_RUN=true                # Simulasi tanpa transaksi nyata
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
pm2 logs 0 --lines 50
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
  "totalExposureCapPct": 0.60
}
```

### Parameter Table

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `maxPositions` | 3 | Max posisi concurrent |
| `minBinStep` / `maxBinStep` | 80 / 200 | Range bin step pool (bps) |
| `minVolume` | 150000 | Min volume 1h semua DEX ($) |
| `minFeeActiveTvlRatio` | 0.05 | Min fee/active TVL ratio (24h) |
| `minMcap` / `maxMcap` | 200k / 5M | Range mcap ($) |
| `minTokenAgeHours` | 0.5 | Min usia token (jam) |
| `maxTokenAgeHours` | 336 | Max usia token (jam, 2 minggu) |
| `rsiMin` | 45 | RSI minimum (ATH zone override: 40) |
| `minConfluenceScore` | 0.30 | Minimum confluence gate |
| `totalExposureCapPct` | 0.60 | Max % saldo deployable |
| `exposureGasReserve` | 0.3 | SOL reserved untuk gas |
| `stopLossPct` | -20 | Stop loss threshold |
| `takeProfitMaxPct` | 25 | Auto take-profit threshold |
| `maxBundlePct` | 30 | Max bundle % (RugCheck) |
| `maxTop10Pct` | 22 | Max top10 holders % |
| `maxBotHoldersPct` | 60 | Max bot holder % |
| `maxTechnicalAnalysisCandidates` | 10 | Max kandidat ke TA stage |
| `autoBacktest` | false | Filter backtest sebelum deploy |
| `managementIntervalMin` | 5 | Management cycle interval (menit) |
| `screeningIntervalMin` | 15 | Screening cycle interval (menit) |

---

## Project Structure

```
Prospera/
├── index.js              # Entry utama: cron + Telegram + health server
├── agent.js              # ReAct loop (LLM → tool call → repeat)
├── backtest.js           # Backtest engine: OHLCV replay + PnL simulasi
├── config.js             # Runtime config + tiered deploy sizing
├── user-config.json      # User override (high priority)
├── state.js              # Position registry + PnL tracking
├── lessons.js            # Learning engine: chart lessons + threshold evolution
├── pool-memory.js        # Per-pool history + deploy cooldown
├── smart-wallets.js      # Smart money tracker + auto-promotion
├── signal-weights.js     # Darwinian adaptive signal weights
├── telegram.js           # Telegram bot + commands
├── prompt.js             # System prompt per role
├── logger.js             # Winston logging + rotation
├── rpc.js                # RPC failover logic
└── tools/
    ├── chart.js          # Fib/EMA/RSI/ATR calculation
    ├── screening.js      # Discovery + filters + Fibonacci signals
    ├── dataProvider.js   # HybridDataProvider: GeckoTerminal → Birdeye
    ├── executor.js       # Tool dispatcher + safety + post-close
    ├── dlmm.js           # Meteora DLMM SDK wrapper
    ├── wallet.js         # SOL balance + Jupiter swap
    ├── okx.js            # RugCheck.xyz API
    ├── token.js          # Jupiter DataAPI
    └── study.js          # LPAgent PnL integration
```

---

## Troubleshooting

### Screening tidak menemukan kandidat

Debug urut dari atas:
1. GeckoTerminal/Dexscreener — cek network error di logs
2. Volume filter — log: `Volume filter: X/Y passed`
3. RugCheck/Jupiter — cek 429 atau timeout
4. Meteora pool universe — log: `Meteora pool universe: N qualifying pools`
5. Fibonacci analysis — cek RSI threshold dan Fib zone
6. `minConfluenceScore` — cek apakah semua di-filter di sini

### LLM API 401 Unauthorized

Cek `MINIMAX_API_KEY` atau `OPENROUTER_API_KEY` di `.env`. Restart:

```bash
pm2 restart 0 --update-env
```

### Screening Stuck (lock file)

```bash
cat screening-lock.json   # Cek apakah ada timeout aktif
# Jika stuck > 5 menit, management cycle akan auto-reset flag.
# Manual: hapus screening-lock.json dan pm2 restart 0
```

### Dry Run vs Real Mode

```bash
# Dry run (simulasi, tidak ada transaksi nyata)
DRY_RUN=true node index.js

# Real mode
pm2 start ecosystem.config.cjs
```

---

## Safety Rules

1. **Hard gate Fib 0.500** — Di bawah = skip, no exceptions (hardcoded di chart.js + executor.js)
2. **Exposure cap 60%** — Max 60% wallet di-deploy sekaligus (sementara dinonaktifkan — Phase 3)
3. **Gas reserve 0.3 SOL** — Excluded dari exposure calculation
4. **Max positions** — Dibatasi `maxPositions` (default 3)
5. **Stop loss -20%** — Mandatory close

---

## License

MIT. Use at your own risk.
