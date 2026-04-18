Caveman mode ULTRA STRICT - NO BULLSHIT.
Reply ONLY with changed code. No explanations. Max 1 line summary at the end.

You are Prospera Data Provider Engineer.

## Hard Rules (Non-Negotiable)
- Entry only allowed if price >= Fib 0.500 (ATH to Fib 0.382 zone)
- Hard no-entry: price < Fib 0.500 → immediate skip with reason "below Fib 0.500 — no entry allowed"
- Blowoff top gate: pump ≥80% in last 10 candles with no correction → skip entry (chart.js Check 1)
- minConfluenceScore: 0.50 — skip if confluenceScore < 0.50
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
5. Setelah implementasi besar: update PROJECT_CONTEXT.md dan CLAUDE.md

## Struktur File Penting
```
index.js           — main loop + screening-lock.json + management-lock
                     computeRetraceSnapshot() — deterministic retrace character
config.js          — getPositionSizing() + canOpenNewPosition()
user-config.json   — runtime config (minConfluenceScore, managementModel, dll)
prompt.js          — system prompt MANAGER + SCREENER + GENERAL
lessons.js         — derivLesson() + runChartLessonAnalysis() + recordPerformance()
state.js           — trackPosition(), markOutOfRange/InRange (cumulative OOR), updatePosition()
tools/
  dataProvider.js  — HybridDataProvider (WAJIB untuk semua data)
  screening.js     — pipeline v3 (Dexscreener-first + RocketScan fallback)
  chart.js         — Fibonacci + indicators; Check1=blowoff top; Check2=fib500/zone gate
  executor.js      — LLM tool handler; deploy-time fib500 gate
  dlmm.js          — deploy/close posisi, RPC failover, cumulative minutesOOR
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
   Check 1: Blowoff top — pump ≥80% no correction → skip
   Check 2: HARD GATE price < fib500 → skip; zone ATH/PRIMARY only
   Check 3: EMA20 > EMA50
   Check 4: RSI > 48 + slope > 0
   Gate: confluenceScore < 0.50 → skip
→ Smart wallet boost (+0.10)
→ Sort by confluenceScore DESC
```

## Management Cycle
Per cycle, index.js injects per-position:
- `retrace` snapshot: HEALTHY / STABILIZING / AGGRESSIVE / DIP_618 / BREAKDOWN_786
- `fib_status`: live price vs fib levels (fib236/382/500/618/786)
- `live_price`, `dumpVelocity`, `volOnRed`, `consecutiveRed`

LLM rules (DIP_618 = hold/bounce zone; BREAKDOWN_786 = close; AGGRESSIVE + breach ≤3c = close)

## Management Rules
| Trigger               | Action                  |
|-----------------------|-------------------------|
| PnL ≤ -20%            | CLOSE                   |
| PnL ≥ 25%             | CLOSE                   |
| PnL 10–25%            | CLOSE (partial harvest) |
| OOR >10m + bins >20   | CLOSE                   |
| fee/TVL <1% after 60m | CLOSE                   |
| loss ≥3× fees after 2h| CLOSE (IL > fees)       |

LLM zone: 5–25% PnL.

## Lessons System
- `derivLesson()` — auto-generates PREFER/AVOID/DIRECTIONAL DUMP lessons dari closed position
- `runChartLessonAnalysis()` — LLM analisis chart post-trade (English only, CJK filter)
- DIRECTIONAL DUMP: range_efficiency=100% + SL = token dump in-range, bukan OOR failure
- Lessons diinject ke management prompt sebagai context (bukan trigger)

## OOR Tracking
`state.js` tracks cumulative OOR via `total_minutes_oor`:
- Setiap kali position kembali in-range: elapsed OOR ditambahkan ke `total_minutes_oor`
- `dlmm.js` close: `minutesOOR = total_minutes_oor + current streak` → `range_efficiency` akurat

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
pm2 logs 0 --lines 100 --nostream   # lihat logs
pm2 restart 0                        # restart agent
pm2 status                           # cek status process
git push origin main                 # push ke GitHub
git log --oneline -10                # lihat 10 commit terakhir
```

---

Baca file ini di awal setiap sesi. Detail arsitektur lengkap: PROJECT_CONTEXT.md.
