Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

Hard Rules (Non-Negotiable):
- Entry only allowed if price >= Fib 0.500 (ATH to Fib 0.382)
- Hard no-entry: price < Fib 0.500 → immediate skip
- Broken support cache: trigger if price < Fib 0.618, invalidate only on new ATH
- ALL data MUST use HybridDataProvider (Dexscreener primary → Birdeye → GeckoTerminal)
- Never call APIs directly outside dataProvider.js

After every task: pm2 restart 0 && git push origin main

# CLAUDE.md — Prospera

Baca file ini di awal setiap sesi. Detail arsitektur: `PROJECT_CONTEXT.md`.

---

## Identitas Proyek

**Prospera** — autonomous DLMM LP agent di Meteora, Solana. JavaScript ES modules.
PM2 ID: **0**. GitHub: `https://github.com/jajajak12/Prospera` branch `main`.

---

## Aturan Kerja

1. Bahasa Indonesia
2. Baca file sebelum modifikasi
3. Jangan tambah fitur di luar yang diminta
4. Setelah implementasi besar: update `PROJECT_CONTEXT.md`

---

## Key Files

```
tools/dataProvider.js  — HybridDataProvider (DS→Birdeye→GT) — WAJIB
tools/screening.js     — pipeline v3 (Dexscreener-first + RocketScan fallback)
tools/chart.js         — Fibonacci + indicators; hard gate fib500
tools/executor.js      — LLM tool handler; deploy-time fib500 gate
index.js               — main loop; screening-lock.json; management-lock
config.js              — getPositionSizing() + canOpenNewPosition()
user-config.json       — runtime config
```

---

## Screening Pipeline

```
Dexscreener → volume ≥$180k → mcap ≥$200k → RugCheck → Jupiter
→ Meteora bulk → RocketScan fallback → broken support cache
→ Fibonacci (hybridDataProvider.getOHLCV) → smart wallet boost
→ sort confluenceScore DESC
```

---

## Management Rules

| Trigger | Action |
|---------|--------|
| PnL ≤ -20% | CLOSE |
| PnL ≥ 25% | CLOSE |
| PnL 10–25% | CLOSE (partial harvest) |
| OOR >10m + bins>20 | CLOSE |
| fee/TVL <1% after 60m | CLOSE |

LLM zone: 5–25% PnL.

---

## Deploy Sizing

| Wallet | Deploy |
|--------|--------|
| <8 SOL | 1.5 SOL |
| 8–15 SOL | 2.8 SOL |
| 15–25 SOL | 4.2 SOL |
| 25–40 SOL | 6.0 SOL |
| >40 SOL | min(18%, 9 SOL) |

Cap: 60% wallet. Gas reserve: 0.5 SOL.

---

## Commands

```bash
pm2 logs 0 --lines 100 --nostream
pm2 restart 0
git push origin main
curl -s http://localhost:3000/health
```
