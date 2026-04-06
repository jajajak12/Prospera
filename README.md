# Prospera

Autonomous DLMM liquidity provider agent untuk pool Meteora di Solana. Menggabungkan sinyal entry Fibonacci retracement, filter keamanan token berlapis, backtesting otomatis dengan auto-apply konservatif, crash recovery mandiri, dan manajemen posisi self-learning.

---

## Gambaran Umum

Prospera adalah LP agent yang berjalan sepenuhnya otomatis:
- Menemukan token Solana trending dari semua DEX via GeckoTerminal, lalu mencari pool Meteora DLMM-nya
- Memfilter berdasarkan sinyal entry Fibonacci (level Fib dari ATH menggunakan candle GeckoTerminal)
- Opsional: backtest setiap kandidat di data OHLCV historis sebelum deploy
- Menjalankan filter keamanan token berlapis (organic score, RugCheck bundle/honeypot, usia token, blacklist)
- Mengelola posisi terbuka dengan aturan bertingkat (stop loss, LLM decision zone, auto take-profit)
- Belajar dari posisi yang ditutup untuk mengevolusi threshold screening dan mendeteksi smart money wallet
- Mengirim briefing pagi harian via Telegram pukul 08:00
- Self-healing saat crash — global error handler notifikasi Telegram dan biarkan PM2 auto-restart

---

## Strategi Entry

### Level Fibonacci

Fibonacci digambar dari **all-time-low → ATH** menggunakan candle OHLCV harian (GeckoTerminal). Untuk token dengan ≤ 3 candle harian, ekstrem intraday juga disertakan untuk menangkap high/low sesi berjalan. Karena data diambil fresh setiap siklus screening, ATH baru otomatis tercermin di run berikutnya.

### Syarat Sinyal (semua harus lolos)

| Sinyal | Kondisi | Tujuan |
|--------|---------|--------|
| **Harga** | Di atas Fib 0.618 (support belum jebol) | Token masih dalam range valid |
| **Tren EMA** | EMA20 > EMA50 | Uptrend terkonfirmasi |
| **Momentum RSI** | RSI > `rsiMin` (default 48) + slope naik | Momentum bullish |
| **Cek ATR** | ATR% < bin\_step% × 4 | Volatilitas kompatibel dengan pool |

### Tier Zone

- **ATH Zone (di atas 0.236)** — entry pre-posisi, harga masih dekat ATH, range diset dari Fib 0.236 → 0.618 mengantisipasi pullback
- **Primary zone (0.236–0.382)** — entry ideal, pullback dangkal
- **Secondary zone (0.382–0.618)** — entry valid, pullback lebih dalam

### Confluence Score

Skor dasar dari posisi harga (bobot 0.6) + kekuatan volume POC (bobot 0.4).

| Kondisi | Penyesuaian |
|---------|------------|
| Primary zone | +0.10 |
| Hidden Bullish Divergence | +0.15 |
| Slope RSI > 3 | +0.05 |
| Smart wallet ada di pool | +0.10 |

Kandidat di bawah `minConfluenceScore` difilter sebelum dilihat LLM.

### Perhitungan bins_below

- **ATH Zone**: dihitung dari Fib 0.236 → Fib 0.618 (range di bawah harga saat ini, siap untuk pullback)
- **Fib Zone**: dihitung dari harga saat ini → swing low terdekat di bawah Fib 0.618 minus satu buffer ATR. Fallback ke Fib 0.786 jika tidak ada swing low.

Dibatasi di [35, 90]. `bins_above` selalu 0.

---

## Filter Keamanan Token

Diterapkan secara berurutan dari yang paling murah ke paling mahal — kegagalan di satu tahap langsung mengeliminasi pool:

1. **Discovery GeckoTerminal** — token Solana trending dari semua DEX (~40 token, 2 halaman)
2. **Blacklist** — `token-blacklist.json` (mint address) dan `dev-blocklist.json` (alamat deployer)
3. **Volume 1h Dexscreener** — volume 1 jam terakhir aktual dari SEMUA DEX (`minVolume`), lebih stabil dari snapshot 5m
4. **Pre-filter mcap** — dari data GeckoTerminal (`minMcap` / `maxMcap`)
5. **Filter RugCheck** — deteksi honeypot/rugged, cek bundle %, verifikasi alamat creator
6. **Keamanan token Jupiter** — konsentrasi 10 holder teratas, % bot holder, kumulatif fee SOL (`minTokenFeesSol`)
7. **Pool Discovery Meteora** — bulk fetch semua pool DLMM qualifying dalam satu request (`page_size=100`, `timeframe=24h`), match by `token_x.address` client-side; filter usia diterapkan client-side
8. **Filter ATH proximity** (opsional) — skip token yang terlalu dekat ATH (`athFilterPct`)
9. **Filter sinyal Fibonacci** — Fib zone, EMA, RSI, ATR, gate confluenceScore (paling mahal — dijalankan terakhir)
10. **Filter auto-backtest** (opsional) — cek win rate historis setiap kandidat sebelum deploy

---

## Backtesting & Optimasi Parameter

Prospera menyertakan engine backtesting bawaan (`backtest.js`) yang memutar ulang logika entry/exit Fibonacci pada data OHLCV historis dari GeckoTerminal.

### Auto-Backtest Periodik (02:00 setiap hari)

Setiap malam pukul 02:00, Prospera otomatis:
1. Mengambil hingga 8 pool yang baru-baru ini ditutup (7 hari terakhir)
2. Menjalankan backtest + parameter sweep di setiap pool
3. Mengevaluasi konsensus antar pool
4. Jika kriteria terpenuhi, mengirim **proposal Telegram** untuk konfirmasi

**Parameter sweep** menguji 16 kombinasi dari:
- Threshold minimum RSI: `40 / 44 / 48 / 52`
- Minimum confluence score: `0.25 / 0.30 / 0.35 / 0.40`

### Aturan Auto-Apply Konservatif

Hasil sweep diusulkan (tidak langsung diterapkan) hanya jika **semua** kondisi ini terpenuhi:

| Guard | Nilai |
|-------|-------|
| Peningkatan win rate vs baseline | ≥ +7% rata-rata antar pool |
| Konsensus mayoritas | > 50% pool yang diuji setuju |
| Max perubahan RSI per run | ±4 poin |
| Max perubahan confluence per run | ±0.05 |

Jika kondisi terpenuhi, Prospera mengirim preview Telegram:

```
🔬 Sweep proposal (WR +12%, 4 pools):
  rsiMin: 48 → 44
  minConfluenceScore: 0.30 → 0.35

Ketik /apply_sweep untuk apply, /reject_sweep untuk batalkan.
Config lama akan di-backup otomatis sebelum di-apply.
```

Balas `/apply_sweep` untuk menerapkan (config lama di-backup sebagai `user-config.YYYYMMDD.backup.json`), atau `/reject_sweep` untuk membatalkan.

### On-Demand via Telegram

```
/backtest        — 7 hari terakhir
/backtest 30d    — 30 hari terakhir
/backtest all    — sepanjang waktu
```

### Parameter Backtest

| Aggregate | History yang dicakup |
|-----------|---------------------|
| 1m | ~16.7 jam |
| 5m | ~3.5 hari |
| 15m | ~10 hari (default untuk periodik) |
| 60m | ~42 hari |

**Fallback graceful untuk token baru:** jika pool tidak memiliki cukup history pada aggregate yang diminta, otomatis fallback ke timeframe lebih kecil (15m → 5m → 1m). Jika masih < 3 trade simulasi, pool dilewati tanpa penalti.

> **Catatan:** PnL bersifat perkiraan — fee diestimasi pada 40% utilisasi in-range, IL disederhanakan. Paling berguna untuk perankingan kualitas sinyal dan tuning parameter, bukan proyeksi profit akurat.

---

## Manajemen Posisi

### Aturan Penutupan (bertingkat)

| Kondisi | Aksi |
|---------|------|
| PnL ≤ −20% | Tutup wajib (stop loss) |
| PnL ≥ 25% | Tutup wajib (auto take-profit) |
| PnL ≥ 10% (partial harvest) | Tutup wajib — kunci gain, biarkan screening redeploy jika masih valid |
| OOR > 10 menit DAN active bin > 20 bin keluar | Tutup wajib (keluar Fib zone) |
| Fee/TVL < 1% setelah 60 menit | Tutup wajib (yield rendah) |
| PnL 5%–10% | LLM mengevaluasi: tahan atau tutup berdasarkan volume/momentum |
| PnL apapun di atas stop loss | LLM bisa menutup jika ada sinyal deteriorasi konkret |

`partialHarvestPct` bisa dikonfigurasi (default 10%). Set ke `null` untuk menonaktifkan.

Setelah penutupan apapun, base token otomatis di-swap kembali ke SOL via Jupiter (melewati token bernilai < $0.10).

### Ukuran Deploy Compounding

Ukuran deploy otomatis menyesuaikan saldo wallet:

| SOL tersedia (setelah gas reserve) | Deploy |
|------------------------------------|--------|
| < 5 SOL | 1 SOL |
| 5–10 SOL | 2 SOL |
| 10–15 SOL | 3 SOL |
| 15–20 SOL | 4 SOL |
| +5 SOL per bracket | +1 SOL |

Dibatasi oleh `maxDeployAmount` (default 50 SOL).

---

## Crash Recovery & Health Check

### Self-Healing

Prospera menangkap error yang tidak tertangani di level proses:

- **`uncaughtException`** — log error, kirim alert Telegram, graceful shutdown → PM2 auto-restart
- **`unhandledRejection`** — log + peringatan Telegram, proses berlanjut

PM2 dikonfigurasi via `ecosystem.config.cjs`:

```js
restart_delay: 5000   // tunggu 5 detik sebelum restart
max_restarts: 10      // batasi burst restart
min_uptime: 10s       // harus bertahan 10 detik untuk dihitung stabil
```

### HTTP Server Health Check

Berjalan di port `3000` (bisa diubah via env var `HEALTH_PORT`):

| Endpoint | Mengembalikan |
|----------|--------------|
| `GET /health` | `status`, `uptime_seconds`, timestamp screening/management terakhir |
| `GET /status` | + jumlah posisi terbuka, jumlah error, SOL wallet, flag busy |

Gunakan [UptimeRobot](https://uptimerobot.com) (gratis) untuk ping `/health` setiap 5 menit dan mendapat notifikasi jika agent mati.

---

## Darwinian Signal Weighting

Sistem self-learning yang melacak sinyal entry mana yang secara historis memprediksi trade menguntungkan.

**Sinyal yang dilacak:** `organic_score`, `fee_tvl_ratio`, `volume_h1`, `confluence_score`, `fib_zone`, `bin_step`, `volatility`

**Cara kerja:**
1. Setiap kali posisi ditutup dengan PnL ≥ +5% (menang) atau ≤ −5% (kalah), snapshot sinyal disimpan
2. Setelah 6+ observasi: untuk setiap sinyal, bandingkan nilai rata-rata ternormalisasi pada menang vs kalah
3. Sinyal dengan nilai lebih tinggi di kemenangan → bobot +0.05 (maks 2.5)
4. Sinyal dengan nilai lebih rendah di kemenangan → bobot −0.05 (min 0.3)
5. Bobot disuntikkan ke prompt SCREENER: `⬆ kuat`, `→ netral`, `⬇ lemah`

LLM secara alami memprioritaskan sinyal ⬆ saat memilih di antara kandidat. Disimpan di `signal-weights.json`.

---

## Smart Wallet Tracker

Sistem self-learning yang secara otomatis mengidentifikasi dan melacak wallet LP berkualitas tinggi.

**Cara kerja:**
1. Setiap kali posisi ditutup, Prospera mengambil semua wallet lain yang punya posisi di pool yang sama
2. Wallet di pool yang Prospera untung mendapat +1 menang; pool stop-loss mendapat +1 kalah
3. Setelah ≥ 3 observasi dengan win rate ≥ 65% → wallet otomatis **dipromosikan** ke daftar smart
4. Saat screening, jika smart wallet punya posisi aktif di pool kandidat → confluenceScore +0.10

Wallet juga bisa ditambah/dihapus manual via perintah `add_smart_wallet` / `remove_smart_wallet`.

---

## Strategy Library

Empat preset strategi bawaan. Ganti via `apply_strategy`:

| Preset | Deskripsi |
|--------|-----------|
| `fibonacci` | Default — risk/reward seimbang |
| `conservative` | Filter lebih ketat, stop loss lebih rapat, trailing TP aktif |
| `aggressive` | Bin step lebih tinggi, entry lebih longgar, take-profit lebih lebar |
| `trending` | Fokus volume tinggi uptrend, exit cepat |

---

## Arsitektur

```
index.js              Entry utama: REPL + cron + Telegram bot + health server
agent.js              ReAct loop (LLM OpenRouter → tool call → ulang)
backtest.js           Engine backtesting: replay OHLCV historis + simulasi PnL
config.js             Runtime config + logika ukuran deploy bertingkat
prompt.js             System prompt per role (SCREENER / MANAGER / GENERAL)
state.js              Registry posisi, trailing TP, tracking PnL
lessons.js            Engine learning: performa → evolusi threshold (binsByStep)
pool-memory.js        History deploy per-pool + snapshot
smart-wallets.js      Smart money tracker dengan auto-promosi self-learning
strategy-library.js   Preset strategi (fibonacci / conservative / aggressive / trending)
signal-weights.js     Bobot sinyal adaptif Darwinian
ecosystem.config.cjs  Config PM2: autorestart, restart_delay, max_restarts

tools/
  chart.js            Engine sinyal: OHLCV GeckoTerminal + Fib (ATH-based) + EMA + RSI + ATR
  screening.js        Discovery pool + filter berlapis + sinyal Fib + cek smart wallet
  definitions.js      Schema tool (format OpenAI function-calling)
  executor.js         Dispatch tool + safety check + post-close hooks
  dlmm.js             SDK Meteora DLMM (deploy, close, claim, posisi)
  wallet.js           Saldo SOL/token + swap Jupiter
  okx.js              RugCheck.xyz API (honeypot, bundle %, creator address)
  token.js            Jupiter DataAPI (bot holder, top10, fee SOL)
  study.js            Integrasi LPAgent API untuk PnL real-time
```

---

## Role Agent

| Role | Tujuan | Tool Utama |
|------|--------|-----------|
| `SCREENER` | Temukan dan deploy posisi baru | `get_chart_candidates`, `deploy_position` |
| `MANAGER` | Kelola posisi terbuka | `close_position`, `claim_fees`, `get_position_pnl` |
| `GENERAL` | Perintah manual + manajemen strategi | Semua tool |

---

## Perintah Telegram

| Perintah | Deskripsi |
|---------|-----------|
| `/status` | Uptime agent, saldo wallet, posisi terbuka, waktu siklus terakhir |
| `/positions` | Daftar posisi terbuka dengan PnL |
| `/close <n>` | Tutup posisi berdasarkan nomor |
| `/set <n> <catatan>` | Set instruksi untuk suatu posisi |
| `/backtest [7d\|30d\|all]` | Jalankan backtest periodik pada pool yang baru ditutup |
| `/apply_sweep` | Terapkan proposal sweep yang tertunda (setelah preview Telegram) |
| `/reject_sweep` | Batalkan proposal sweep yang tertunda |

---

## Jadwal

| Siklus | Interval Default |
|--------|-----------------|
| Management | Setiap 3 menit |
| Screening | Setiap 15 menit |
| Morning Briefing | Setiap hari pukul 08:00 |
| Backtest + Sweep Periodik | Setiap hari pukul 02:00 |

---

## Environment Variables

| Variable | Wajib | Tujuan |
|----------|-------|--------|
| `WALLET_PRIVATE_KEY` | Ya | Private key wallet Solana (base58) |
| `RPC_URL` | Ya | Endpoint RPC Solana utama (rekomendasi: Helius) |
| `OPENROUTER_API_KEY` | Ya | API key LLM (OpenRouter) |
| `LPAGENT_API_KEY` | Ya | API key utama LPAgent (PnL real-time) |
| `LPAGENT_API_KEY_BACKUP` | Tidak | Backup key LPAgent — failover instan jika primary gagal |
| `TELEGRAM_BOT_TOKEN` | Tidak | Notifikasi Telegram + antarmuka perintah |
| `TELEGRAM_CHAT_ID` | Tidak | Target chat Telegram |
| `HELIUS_API_KEY` | Tidak | Otomatis ditambahkan sebagai fallback RPC jika di-set |
| `HEALTH_PORT` | Tidak | Port HTTP server health check (default: 3000) |

### RPC Failover

| Prioritas | Provider | Catatan |
|-----------|----------|---------|
| Primary | Helius (`RPC_URL`) | Tercepat, latensi terendah untuk trading |
| Fallback 1 | Alchemy | Sangat cepat, free tier dermawan |
| Fallback 2 | Ankr | Stabil, terdesentralisasi |
| Fallback 3 | PublicNode | Endpoint publik andal |
| Last Resort | Solana Official | Selalu up, paling lambat saat congestion |

Otomatis reset ke primary setelah 5 menit stabil.

---

## Quick Start

```bash
cp .env.example .env
# isi WALLET_PRIVATE_KEY, RPC_URL, OPENROUTER_API_KEY, LPAGENT_API_KEY

npm install
```

Dengan PM2 (rekomendasi):
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs prospera
```

Dry run (tanpa transaksi nyata):
```bash
DRY_RUN=true node index.js
```

---

## Konfigurasi Utama (`user-config.json`)

| Key | Default | Deskripsi |
|-----|---------|-----------|
| `maxPositions` | 2 | Maksimal posisi terbuka bersamaan |
| `minBinStep` / `maxBinStep` | 80 / 200 | Range bin step pool |
| `minVolume` | 100000 | Min volume **1h** aktual dari semua DEX ($) — `volume.h1` Dexscreener |
| `minFeeActiveTvlRatio` | 0.05 | Min rasio fee/active TVL pool Meteora (timeframe 24h) |
| `minMcap` / `maxMcap` | 150k / 5M | Range market cap token |
| `minTvl` / `maxTvl` | 5000 / 250000 | Range TVL pool ($) |
| `minTokenAgeHours` / `maxTokenAgeHours` | 1 / 1440 | Range usia token |
| `minTokenFeesSol` | 30 | Min kumulatif fee dalam SOL (Jupiter — tips + priority + trading) |
| `rsiMin` | 48 | RSI minimum untuk sinyal entry (auto-tuned oleh backtest sweep) |
| `minConfluenceScore` | 0 | Gate minimum confluence score (auto-tuned oleh backtest sweep) |
| `stopLossPct` | −20 | Threshold stop loss |
| `takeProfitMaxPct` | 25 | Threshold auto take-profit |
| `takeProfitFeePct` | 5 | LLM decision zone dimulai di sini |
| `partialHarvestPct` | 10 | Auto-close di PnL ini untuk kunci gain (set null untuk nonaktifkan) |
| `outOfRangeBinsToClose` | 20 | Jarak bin OOR untuk trigger penutupan |
| `maxBundlePct` | 30 | Maksimal bundle % (filter RugCheck) |
| `maxTop10Pct` | 20 | Maksimal konsentrasi 10 holder teratas % |
| `maxBotHoldersPct` | 30 | Maksimal % bot holder |
| `rpcFallbacks` | [] | Daftar endpoint RPC fallback berurutan |
| `fibConfluenceRequired` | true | Wajibkan Fib confluence untuk entry |
| `candleLimit` | 100 | Candle OHLCV untuk analisis |
| `autoBacktest` | false | Aktifkan filter backtest sebelum deploy |
| `minBacktestWinRate` | 0.50 | Win rate minimum untuk lolos filter pre-deploy |
| `backtestAggregate` | 15 | Ukuran candle untuk backtest (menit) |
