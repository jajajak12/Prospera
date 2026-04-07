Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.
After every task: pm2 restart 0 && git push origin main

---

## Hard Rules (Non-Negotiable)

- price < fib500 → SKIP immediately (before indicators)
- Entry zone: ATH (>fib236) or PRIMARY (fib236–fib382) only
- Broken support cache: trigger < fib618, invalidate only on new ATH
- ALL data MUST use `hybridDataProvider` — never call APIs directly outside `dataProvider.js`
- Deploy blocked if live price < fib500 (executor.js re-check)

---

## Project

**Prospera** — autonomous DLMM LP agent, Meteora/Solana. JavaScript ES modules.
PM2 ID: **0**. GitHub: `https://github.com/jajajak12/Prospera` branch `main`.

---

## Work Rules

1. Bahasa Indonesia
2. Baca file sebelum modifikasi
3. Jangan tambah fitur di luar yang diminta
4. Setelah implementasi besar: update `PROJECT_CONTEXT.md`

---

## Key Files

```
tools/dataProvider.js  — HybridDataProvider (DS→Birdeye→GT) — WAJIB untuk semua data
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

| Rule | Trigger | Action |
|------|---------|--------|
| Stop loss | PnL ≤ -20% | CLOSE |
| Take profit | PnL ≥ 25% | CLOSE |
| Partial harvest | PnL 10–25% | CLOSE |
| OOR | >10m + bins>20 | CLOSE |
| Low fee/TVL | <1% after 60m | CLOSE |

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
