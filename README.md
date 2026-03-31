# Prospera

Autonomous DLMM liquidity provider agent for Meteora pools on Solana, powered by Fibonacci retracement + Volume Profile entry signals.

---

## Overview

Prospera is a self-running LP agent that deploys liquidity positions on Meteora DLMM using technical analysis signals instead of traditional fee/volume screening alone. It enters positions at high-probability support zones and manages them autonomously — claiming fees, detecting out-of-range conditions, and closing positions based on defined rules.

---

## Entry Strategy

### Signal Requirements (all must pass)

| Signal | Condition | Purpose |
|--------|-----------|---------|
| **Fibonacci Zone** | Price between Fib 0.236–0.618 | Pullback in uptrend, not overextended |
| **Volume Profile** | POC or VAL within Fib zone | Volume support confirms the level |
| **EMA Trend** | EMA20 > EMA50 | Confirms uptrend — pullback not a reversal |
| **RSI Momentum** | RSI > 48 + rising slope | Bullish momentum present during pullback |
| **ATR Check** | ATR% < bin_step% × 4 | Volatility compatible with pool bin step |

### Zone Tiers

- **Primary zone (0.236–0.382)** — ideal entry, shallow pullback, higher confluence score
- **Secondary zone (0.382–0.618)** — valid entry, deeper pullback, lower confidence

### Confluence Score Boosts
- Price in primary zone → +0.10
- Hidden Bullish Divergence detected (price higher low + RSI lower low) → +0.15
- RSI slope > 3 → +0.05

---

## Position Parameters

| Parameter | Value |
|-----------|-------|
| Strategy | `bid_ask` (always) |
| `bins_below` | Calculated to cover current price → Fib 0.618 |
| `bins_above` | 8 if primary zone + RSI < 55, else 0 |
| Stop loss | -20% PnL |
| OOR close | Active bin > 10 bins out of range |

---

## Management Rules

1. **Stop loss** — close if PnL ≤ -20%
2. **Out of range** — close if OOR > `outOfRangeWaitMinutes` AND active bin > 10 bins from range
3. **Low yield** — close if fee/TVL < threshold after 60 minutes
4. **Auto-swap** — after any close, base token is automatically swapped back to SOL

---

## Learning System

Prospera learns from closed positions and evolves its parameters over time:

- **`binsByStep`** — learns optimal `bins_below` per bin step value (e.g. bin_step=80 → 75 bins, bin_step=125 → 52 bins)
- **`binsExtraLow/Mid/High`** — adjusts bin offsets per volatility tier based on OOR performance
- Evolution triggers every 5 closed positions via `evolveThresholds()`

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot
agent.js            ReAct loop (OpenRouter): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt per role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json)
lessons.js          Learning engine: closed-position performance → threshold evolution
pool-memory.js      Per-pool deploy history + snapshots

tools/
  chart.js          Core signal engine: GeckoTerminal OHLCV + Fib + Volume Profile + EMA + RSI + ATR
  screening.js      Pool discovery (Meteora API) + Fibonacci signal filter
  definitions.js    Tool schemas (OpenAI function-calling format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions)
  wallet.js         SOL/token balances + Jupiter swap
  study.js          LPAgent API integration (pure — no Meteora fallback)
```

---

## Agent Roles

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | `get_chart_candidates`, `deploy_position` |
| `MANAGER` | Manage open positions | `close_position`, `claim_fees`, `swap_token`, `get_position_pnl` |
| `GENERAL` | Manual commands via chat | All tools |

---

## PnL Source

Prospera uses **LPAgent API** exclusively for real-time position PnL. No Meteora API fallback.

- Primary key tried up to 3× with backoff
- Backup key attempted if primary fails
- If both fail → management cycle is skipped, not errored

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Solana wallet private key (base58) |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key (OpenRouter) |
| `LPAGENT_API_KEY` | Yes | LPAgent primary API key |
| `LPAGENT_API_KEY_BACKUP` | No | LPAgent backup key (used after 3 primary failures) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |

---

## Quick Start

```bash
cp .env.example .env
# fill in .env with your keys

npm install
node index.js
```

Or with PM2:
```bash
pm2 start index.js --name prospera
pm2 save
```
