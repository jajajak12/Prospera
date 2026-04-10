# Prospera

Autonomous DLMM LP (Liquidity Provider) agent untuk pool Meteora di Solana. Agent ini secara otomatis menemukan token Solana yang trending, menyaringnya melalui Fibonacci retracement, filter keamanan berlapis, dan menerapkan posisi liquidity di Meteora DLMM.

**Disclaimer: Gunakan dengan risiko sendiri. Bukan financial advice.**

---

## Table of Contents

1. [ Prerequisites ](#prerequisites)
2. [ Installation ](#installation)
3. [ Environment Variables ](#environment-variables)
4. [ Configuration ](#configuration)
5. [ Running the Agent ](#running-the-agent)
6. [ Telegram Setup ](#telegram-setup-optional)
7. [ Health Check & Monitoring ](#health-check--monitoring)
8. [ Project Structure ](#project-structure)
9. [ Strategy & Entry Rules ](#strategy--entry-rules)
10. [ Troubleshooting ](#troubleshooting)

---

## Prerequisites

- **Node.js** >= 18.0.0
- **npm** atau **yarn**
- **PM2** (untuk production run)
- **Solana wallet** dengan SOL untuk deployment + gas reserve
- **OpenRouter API key** (untuk LLM decision-making)
- **LPAgent API key** (untuk real-time PnL tracking)
- **RPC endpoint** (rekomendasi: Helius)

Opsional:
- **Telegram bot token + chat ID** (untuk notifikasi & perintah)
- **UptimeRobot** atau service serupa (untuk health monitoring)

---

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/jajajak12/Prospera.git
cd Prospera
```

### 2. Install Dependencies

```bash
npm install
```

> Note: `postinstall` script secara otomatis menjalankan `patch-anchor.js` untuk fix kompatibilitas `@meteora-ag/dlmm`.

### 3. Buat File Environment

```bash
cp .env.example .env
```

### 4. Isi Environment Variables

Buka file `.env` dan isi semua variable yang diperlukan. Lihat bagian [Environment Variables](#environment-variables) untuk detail.

### 5. Verifikasi Instalasi (Dry Run)

```bash
DRY_RUN=true node index.js
```

Kalau output menunjukkan agent mulai scanning tanpa error, instalasi berhasil.

---

## Environment Variables

### Required

| Variable | Deskripsi |
|----------|-----------|
| `WALLET_PRIVATE_KEY` | Private key wallet Solana (format base58). **JANGAN shared atau commit ke git.** |
| `RPC_URL` | Endpoint RPC Solana. Rekomendasi: `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` |
| `OPENROUTER_API_KEY` | API key untuk LLM (OpenRouter). Digunakan untuk decision-making agent. |
| `LPAGENT_API_KEY` | API key utama LPAgent untuk tracking PnL real-time. |

### Optional

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `LPAGENT_API_KEY_BACKUP` | - | Backup LPAgent API key. Otomatis failover jika primary gagal. |
| `TELEGRAM_BOT_TOKEN` | - | Token bot Telegram. Diperlukan untuk notifikasi + perintah. |
| `TELEGRAM_CHAT_ID` | - | Chat ID Telegram target untuk pengiriman notifikasi. |
| `HELIUS_API_KEY` | - | Kalau di-set, otomatis ditambahkan sebagai fallback RPC. |
| `HEALTH_PORT` | `3000` | Port HTTP server untuk health check endpoint. |
| `DRY_RUN` | `false` | `true` = simulasi tanpa transaksi nyata. |

### Contoh `.env` yang Sudah Terisi

```env
WALLET_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_helius_key
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
LPAGENT_API_KEY=sk-la-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
LPAGENT_API_KEY_BACKUP=sk-la-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=-1001234567890
HELIUS_API_KEY=your_helius_key
HEALTH_PORT=3000
```

---

## Configuration

Semua parameter strategi ada di `user-config.json`. **Jangan edit `config.js` langsung** — `user-config.json` meng-override nilai default di `config.js`.

### Parameter Utama

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `maxPositions` | `2` | Maksimal posisi terbuka bersamaan |
| `minBinStep` / `maxBinStep` | `80` / `200` | Range bin step pool (dalam basis point) |
| `minVolume` | `150000` | Min volume 1h dari semua DEX ($) |
| `minFeeActiveTvlRatio` | `0.05` | Min rasio fee/active TVL (timeframe 24h) |
| `minMcap` / `maxMcap` | `200000` / `10000000` | Range market cap token ($) |
| `minTvl` / `maxTvl` | `5000` / `250000` | Range TVL pool ($) |
| `minTokenAgeHours` / `maxTokenAgeHours` | `0.5` / `720` | Range usia token (jam) |
| `minTokenFeesSol` | `30` | Min kumulatif fee dalam SOL |
| `rsiMin` | `45` | RSI minimum untuk entry (slope >= -2.0 allowed) |
| `minConfluenceScore` | `0` | Minimum confluence score gate |
| `totalExposureCapPct` | `0.60` | Max % saldo deployable yang boleh di-deploy |
| `exposureGasReserve` | `0.5` | SOL reserved untuk gas (dikecualikan dari exposure cap) |
| `stopLossPct` | `-20` | Stop loss threshold (%) |
| `takeProfitMaxPct` | `25` | Auto take-profit threshold (%) |
| `takeProfitFeePct` | `5` | LLM decision zone mulai di sini (%) |
| `partialHarvestPct` | `10` | Auto-close di PnL ini untuk kunci gain (set `null` untuk disable) |
| `outOfRangeBinsToClose` | `20` | Jarak bin OOR untuk trigger penutupan |
| `maxBundlePct` | `30` | Max bundle % (RugCheck filter) |
| `maxTop10Pct` | `20` | Max konsentrasi 10 holder teratas (%) |
| `maxBotHoldersPct` | `30` | Max % bot holder |
| `fibConfluenceRequired` | `true` | Wajib Fib confluence untuk entry |
| `candleLimit` | `100` | Jumlah candle OHLCV untuk analisis |
| `maxTechnicalAnalysisCandidates` | `10` | Maksimal kandidat ke tahap Birdeye analysis |
| `autoBacktest` | `false` | Aktifkan filter backtest sebelum deploy |
| `minBacktestWinRate` | `0.50` | Min win rate untuk lolos pre-deploy backtest |
| `backtestAggregate` | `15` | Timeframe candle untuk backtest (menit) |

### Cara Edit Config

Edit langsung `user-config.json`:

```json
{
  "rsiMin": 48,
  "minConfluenceScore": 0.35,
  "maxPositions": 3
}
```

Config di atas override hanya `rsiMin`, `minConfluenceScore`, dan `maxPositions`. Nilai lain tetap dari default `config.js`.

---

## Running the Agent

### Development (Dry Run)

Tanpa transaksi nyata:

```bash
DRY_RUN=true node index.js
```

### Production (PM2)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs prospera
```

### Verifikasi Status

```bash
pm2 status
curl http://localhost:3000/status
```

### Restart Setelah Edit

```bash
pm2 restart prospera
```

---

## Telegram Setup (Optional)

### 1. Buat Bot Telegram

1. Buka [BotFather](https://t.me/BotFather) di Telegram
2. Kirim `/newbot`
3. Ikuti instruksi, simpan bot token yang diberikan

### 2. Dapat Chat ID

1. Kirim pesan apapun ke bot yang baru dibuat
2. Buka: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Cari `"chat":{"id":` — itu adalah chat ID kamu
4. Untuk group: tambahkan bot ke group, lalu gunakan chat ID (negatif untuk group)

### 3. Isi .env

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 4. Kirim Test Message

```bash
curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=test"
```

### Perintah Telegram

| Perintah | Deskripsi |
|----------|-----------|
| `/status` | Status agent, saldo wallet, posisi terbuka |
| `/positions` | Daftar posisi terbuka dengan PnL |
| `/close <n>` | Tutup posisi berdasarkan nomor |
| `/backtest [7d\|30d\|all]` | Jalankan backtest |
| `/apply_sweep` | Terapkan proposal sweep parameter |
| `/reject_sweep` | Batalkan proposal sweep |
| `/set <n> <catatan>` | Set instruksi untuk posisi |

---

## Health Check & Monitoring

### Endpoint

| Endpoint | Mengembalikan |
|----------|---------------|
| `GET /health` | `status`, `uptime_seconds`, timestamp screening/management terakhir |
| `GET /status` | + jumlah posisi terbuka, error count, SOL wallet, busy flag |

### Setup Uptime Monitoring (UptimeRobot)

1. Daftar di [uptimerobot.com](https://uptimerobot.com) (gratis)
2. Klik "Add New Monitor"
3. Type: **HTTP(s)**
4. Friendly Name: `Prospera Health`
5. URL: `http://your-server:3000/health`
6. Monitoring Interval: **5 minutes**
7. Alert Settings: configure email/alert kamu

Kalau agent down, UptimeRobot akan kirim notifikasi.

### PM2 Health

```bash
pm2 status
pm2 logs prospera --lines 50
pm2 monit
```

---

## Project Structure

```
Prospera/
├── index.js                 # Entry utama: REPL + cron + Telegram bot + health server
├── agent.js                # ReAct loop (LLM → tool call → ulang)
├── backtest.js             # Engine backtesting: replay OHLCV historis + simulasi PnL
├── config.js               # Runtime config + tiered deploy sizing
├── prompt.js               # System prompt per role (SCREENER / MANAGER / GENERAL)
├── state.js                # Registry posisi, trailing TP, PnL tracking
├── lessons.js              # Learning engine: performa → evolusi threshold
├── pool-memory.js          # History deploy per pool + snapshot
├── smart-wallets.js        # Smart money tracker dengan auto-promosi
├── signal-weights.js       # Bobot sinyal adaptif Darwinian
├── strategy-library.js      # Preset strategi (fibonacci, conservative, aggressive, trending)
├── telegram.js             # Bot Telegram + perintah
├── logger.js               # Logging with rotation
├── log-utils.js            # Helper logging
├── rpc.js                  # RPC failover logic
├── user-config.json        # User override config (HIGH PRIORITY)
├── ecosystem.config.cjs    # PM2 config
├── .env                    # Environment variables (JANGAN di-commit!)
├── .env.example            # Template .env
├── package.json
└── tools/
    ├── chart.js            # OHLCV + Fib + EMA + RSI (Birdeye)
    ├── screening.js        # Discovery + filter + Fib signals
    ├── dataProvider.js     # Hybrid: Dexscreener → Birdeye → GeckoTerminal
    ├── definitions.js       # Tool schema (OpenAI function-calling format)
    ├── executor.js         # Tool dispatcher + safety check + post-close hooks
    ├── dlmm.js             # Meteora DLMM SDK wrapper
    ├── wallet.js           # SOL/token balance + Jupiter swap
    ├── okx.js              # RugCheck.xyz API
    ├── token.js            # Jupiter DataAPI (holders, fees)
    └── study.js            # LPAgent API integration
```

---

## Strategy & Entry Rules

### Fibonacci Entry Zone

```
ATH Zone (di atas 0.236)     → Entry pre-posisi, dekat ATH
Primary Zone (0.236 – 0.382) → Entry ideal, pullback dangkal ✓ RECOMMENDED
Secondary Zone (0.382 – 0.500)→ Entry valid, pullback lebih dalam
Hard Gate: Fib 0.500         → HARUS di atas ini untuk entry
```

### Syarat Entry (semua harus lolos)

| Sinyal | Kondisi |
|--------|---------|
| Harga | Di atas Fib 0.500 (hard gate) |
| Tren EMA | EMA20 > EMA50 |
| Momentum RSI | RSI >= `rsiMin` (default 45) + slope >= -2.0 |
| Volatilitas | ATR% < bin_step% × 4 |

### Position Sizing (Tiered)

| Saldo Wallet | Deploy per Posisi |
|-------------|-------------------|
| < 8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| > 40 SOL | min(18% wallet, 9 SOL) |

### Exposure Cap

Total yang di-deploy tidak boleh melebihi **60%** dari saldo deployable (setelah dikurangi 1 SOL gas reserve).

---

## Troubleshooting

### Error: `ERR_AMBIGUOUS_MODULE_SYNTAX`

**Penyebab:** Node.js v22+ dengan ES modules dan dotenv v16+.

**Fix:**
```bash
pm2 restart prospera --update-env
```

### Error: `401 Unauthorized` pada LLM API

**Penyebab:** API key invalid atau expired.

**Fix:** Cek dan update `OPENROUTER_API_KEY` di `.env`. Restart:
```bash
pm2 restart prospera --update-env
```

### Error: Birdeye Rate Limit

**Penyebab:** Terlalu banyak kandidat yang dianalisis.

**Fix:** Pastikan `maxTechnicalAnalysisCandidates` = 10 (default). Ini udah dioptimasi untuk 60 RPM limit Birdeye.

### Agent Tidak Melakukan Screening

**Cek:** Lock file `screening-lock.json` mungkin masih aktif.

```bash
cat screening-lock.json
```

Biasanya timeout 10 menit. Tunggu atau hapus file kalau stuck.

###posisi Tidak Tertutup Otomatis

**Cek:** Pastikan `totalExposureCapPct` belum tercapai (exposure cap 60%).

### Dry Run vs Real Mode

```bash
# Dry run (simulasi, tidak ada transaksi nyata)
DRY_RUN=true node index.js

# Real mode
node index.js
# atau dengan PM2:
pm2 start ecosystem.config.cjs
```

---

## Data Flow

```
Dexscreener (Discovery trending token)
    ↓
Blacklist filter (token-blocklist.json + dev-blocklist.json)
    ↓
Volume 1h filter (minVolume = $150k)
    ↓
MCap pre-filter (minMcap/maxMcap)
    ↓
RugCheck (honeypot/bundle% detection)
    ↓
Jupiter safety (top10 holders, bot holders, fees)
    ↓
Meteora DLMM pool matching
    ↓
Pre-pool cap: TOP 10 by volume (Birdeye RPM protection)
    ↓
Fibonacci + RSI + EMA analysis (Birdeye OHLCV)
    ↓
Smart wallet check (confluence +0.10 kalau smart wallet ada di pool)
    ↓
LLM deploy decision (SCREENER role)
    ↓
Deploy position (Meteora DLMM)
```

---

## Jadwal Siklus

| Siklus | Interval |
|--------|----------|
| Management | Setiap 3 menit |
| Screening | Setiap 15 menit |
| Morning Briefing (Telegram) | Setiap hari 08:00 |
| Backtest + Parameter Sweep | Setiap hari 02:00 |

---

## Safety Rules

1. **Hard gate Fib 0.500** — Harga di bawah 0.500 = skip langsung, tidak ada exceptions
2. **Exposure cap 60%** — Tidak pernah lebih dari 60% saldo deployable
3. **Gas reserve 1 SOL** — Selalu ada buffer untuk transaksi
4. **Max 2 posisi** — Tidak boleh lebih dari `maxPositions`
5. **Stop loss -20%** — Mandatory close kalau PnL <= -20%

---

## License

MIT. Use at your own risk.
