Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

## Hard Rules (Non-Negotiable)
- Entry only allowed if price >= Fib 0.500 (ATH to Fib 0.382 zone)
- Hard no-entry: price < Fib 0.500 → immediate skip with reason "below Fib 0.500 — no entry allowed"
- Broken support cache: trigger if price < Fib 0.618, invalidate only on new ATH
- ALL data (pool & OHLCV) MUST use HybridDataProvider (Dexscreener primary → Birdeye → GeckoTerminal)
- Never call Birdeye, Dexscreener, or GeckoTerminal APIs directly outside dataProvider.js

**After every task: `pm2 restart 0 && git push origin main`**

---

# CLAUDE.md — Prospera

## Identitas Proyek
**Prospera** — autonomous DLMM LP agent di Meteora, Solana.
- Strategi: Fibonacci retracement entry signals, single-sided bid_ask
- Bahasa: JavaScript (ES modules)
- PM2 process ID: 0 (name: prospera)
- GitHub: https://github.com/jajajak12/Prospera branch main

## Aturan Kerja
1. Selalu gunakan Bahasa Indonesia
2. Setelah setiap perubahan kode: `pm2 restart 0` + `git push origin main`
3. Baca file yang relevan sebelum memodifikasi
4. Jangan tambah fitur di luar yang diminta
5. Setelah implementasi besar: update PROJECT_CONTEXT.md

## Struktur File Penting
```
index.js           — main loop + screening-lock.json + management-lock
config.js          — getPositionSizing() + canOpenNewPosition()
user-config.json   — runtime config
tools/
  dataProvider.js  — HybridDataProvider (WAJIB untuk semua data)
  screening.js     — pipeline v3 (Dexscreener-first + RocketScan fallback)
  chart.js         — Fibonacci + indicators; hard gate fib500
  executor.js      — LLM tool handler; deploy-time fib500 gate
  dlmm.js          — deploy/close posisi, RPC failover
  okx.js           — RugCheck.xyz (bundle %, honeypot, creator)
  token.js         — Jupiter DataAPI + Dexscreener volume
  wallet.js        — wallet balance, swap via Jupiter
  study.js         — LPAgent API client
```

## Screening Pipeline (v3)
```
Dexscreener (boosts + profiles, SOL pair only)
→ 1h volume ≥ $180k → mcap ≥ $200k → RugCheck → Jupiter
→ Meteora bulk fetch (client-side match + age filter)
→ RocketScan fallback
→ Broken support cache (skip if cached < fib618)
→ Fibonacci via hybridDataProvider.getOHLCV()
   HARD GATE: price < fib500 → skip "below Fib 0.500 — no entry allowed"
→ Smart wallet boost (+0.10)
→ Sort by confluenceScore DESC
```

## Management Rules
| Trigger               | Action                  |
|-----------------------|-------------------------|
| PnL ≤ -20%            | CLOSE                   |
| PnL ≥ 25%             | CLOSE                   |
| PnL 10–25%            | CLOSE (partial harvest) |
| OOR >10m + bins >20   | CLOSE                   |
| fee/TVL <1% after 60m | CLOSE                   |

LLM zone: 5–25% PnL.

## Deploy Sizing
| Wallet      | Deploy per posisi      |
|-------------|------------------------|
| < 8 SOL     | 1.5 SOL                |
| 8–15 SOL    | 2.8 SOL                |
| 15–25 SOL   | 4.2 SOL                |
| 25–40 SOL   | 6.0 SOL                |
| > 40 SOL    | min(18% wallet, 9 SOL) |

**Cap**: 60% wallet. **Gas reserve**: 0.5 SOL.

## Commands Berguna
```bash
pm2 logs 0 --lines 100 --nostream   # lihat logs real-time
pm2 restart 0                        # restart agent
pm2 status                           # cek status process
git push origin main                 # push ke GitHub
git log --oneline -10                # lihat 10 commit terakhir
```

---

Baca file ini di awal setiap sesi. Detail arsitektur lengkap: PROJECT_CONTEXT.md.
