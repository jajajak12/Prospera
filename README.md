# Prospera

Autonomous DLMM liquidity provider agent for Meteora pools on Solana. Combines Fibonacci retracement + Volume Profile entry signals with multi-layer token safety filters and self-learning position management.

---

## Overview

Prospera is a fully autonomous LP agent that:
- Discovers trending Meteora DLMM pools via the Pool Discovery API
- Filters by Fibonacci + Volume Profile entry signals (ATH-based Fib levels from daily candles)
- Runs multi-layer token safety checks (organic score, OKX honeypot/bundle, token age, blacklists)
- Manages open positions with tiered rules (stop loss, LLM decision zone, auto take-profit)
- Learns from closed positions to evolve screening thresholds and detect smart money wallets

---

## Entry Strategy

### Fibonacci Levels

Fibonacci is drawn from **all-time-low → ATH** using daily OHLCV candles (GeckoTerminal). For tokens with ≤ 3 daily candles, intraday extremes are also included to capture the current session's high/low. Since data is fetched fresh every screening cycle, new ATHs are automatically reflected on the next run.

### Signal Requirements (all must pass)

| Signal | Condition | Purpose |
|--------|-----------|---------|
| **Price** | Above Fib 0.618 (not broken support) | Token still in valid range |
| **Volume Profile** | POC/VAL in fib zone (or POC ≥ 0.618 for ATH zone) | Volume distribution healthy |
| **EMA Trend** | EMA20 > EMA50 | Confirmed uptrend |
| **RSI Momentum** | RSI > 48 + rising slope | Bullish momentum |
| **ATR Check** | ATR% < bin\_step% × 4 | Volatility compatible with pool |

### Zone Tiers

- **ATH Zone (above 0.236)** — pre-position entry, price still near ATH, range set from Fib 0.236 → 0.618 anticipating pullback
- **Primary zone (0.236–0.382)** — ideal entry, shallow pullback
- **Secondary zone (0.382–0.618)** — valid entry, deeper pullback

### Confluence Score

Base score from price position (0.6 weight) + POC volume strength (0.4 weight).

| Condition | Adjustment |
|-----------|-----------|
| Primary zone | +0.10 |
| Hidden Bullish Divergence | +0.15 |
| RSI slope > 3 | +0.05 |
| Price action support below Fib 0.618 found | +0.15 |
| No price action support found (fib zone only) | −0.20 |
| Smart wallet present in pool | +0.10 |

### bins_below Calculation

- **ATH Zone**: calculated from Fib 0.236 → Fib 0.618 (range sits below current price, ready for pullback)
- **Fib Zone**: calculated from current price → nearest swing low below Fib 0.618 minus one ATR buffer. Falls back to Fib 0.786 if no swing low found.

Clamped to [35, 90]. `bins_above` is always 0.

---

## Token Safety Filters

Applied in order — any failure eliminates the pool:

1. **Meteora API filters** — organic score, holders, mcap, volume, TVL, bin step, fee/TVL ratio, token age
2. **Blacklists** — `token-blacklist.json` (mints) and `dev-blocklist.json` (deployer addresses)
3. **OKX DEX filter** — honeypot detection, bundle % check, creator address cross-check
4. **ATH proximity filter** (optional) — skip tokens too close to ATH (configurable `athFilterPct`)
5. **Fibonacci signal filter** — Fib zone, volume profile, EMA, RSI, ATR

---

## Position Management

### Close Rules (tiered)

| Condition | Action |
|-----------|--------|
| PnL ≤ −20% | Mandatory close (stop loss) |
| PnL ≥ 25% | Mandatory close (auto take-profit) |
| OOR > 10 min AND active bin > 20 bins out | Mandatory close (left Fib zone) |
| Fee/TVL < 1% after 60 min | Mandatory close (low yield) |
| PnL 5%–25% | LLM evaluates: hold or close based on volume/momentum |
| Any PnL above stop loss | LLM may close on concrete deterioration signals |

After any close, base token is automatically swapped back to SOL via Jupiter (skips tokens worth < $0.10).

### Compounding Deploy Amount

Deploy size scales automatically with wallet balance:

| Available SOL (after gas reserve) | Deploy |
|-----------------------------------|--------|
| < 5 SOL | 1 SOL |
| 5–10 SOL | 2 SOL |
| 10–15 SOL | 3 SOL |
| 15–20 SOL | 4 SOL |
| +5 SOL per bracket | +1 SOL |

Capped by `maxDeployAmount` (default 50 SOL).

---

## Smart Wallet Tracker

Self-learning system that automatically identifies and tracks high-quality LP wallets.

**How it works:**
1. Every time a position closes, Prospera fetches all other wallets that had positions in the same pool
2. Wallets in pools where Prospera was profitable get +1 win; stop-loss pools get +1 loss
3. After ≥ 3 observations with ≥ 65% win rate → wallet is **automatically promoted** to the smart list
4. During screening, if a smart wallet has an active position in a candidate pool → confluenceScore +0.10

Wallets can also be added/removed manually via `add_smart_wallet` / `remove_smart_wallet` commands.

---

## Strategy Library

Four built-in strategy presets. Switch via `apply_strategy`:

| Preset | Description |
|--------|-------------|
| `fibonacci` | Default — balanced risk/reward |
| `conservative` | Stricter filters, tighter stop loss, trailing TP enabled |
| `aggressive` | Higher bin steps, looser entry, wider take-profit |
| `trending` | High-volume uptrend focus, fast exits |

---

## Architecture

```
index.js              Main entry: REPL + cron + Telegram bot
agent.js              ReAct loop (OpenRouter LLM → tool call → repeat)
config.js             Runtime config + tiered deploy amount logic
prompt.js             System prompts per role (SCREENER / MANAGER / GENERAL)
state.js              Position registry, trailing TP, PnL tracking
lessons.js            Learning engine: performance → threshold evolution
pool-memory.js        Per-pool deploy history + snapshots
smart-wallets.js      Smart money tracker with self-learning auto-promotion
strategy-library.js   Strategy presets (fibonacci / conservative / aggressive / trending)

tools/
  chart.js            Signal engine: GeckoTerminal OHLCV + Fib (ATH-based) + VP + EMA + RSI + ATR
  screening.js        Pool discovery + multi-layer filters + Fib signal + smart wallet check
  definitions.js      Tool schemas (OpenAI function-calling format)
  executor.js         Tool dispatch + safety checks + post-close hooks
  dlmm.js             Meteora DLMM SDK (deploy, close, claim, positions)
  wallet.js           SOL/token balances + Jupiter swap
  okx.js              OKX DEX Web3 API (honeypot, bundle %, ATH price, smart money)
  token.js            Jupiter DataAPI (bot holders, top10, fees SOL)
  study.js            LPAgent API integration for real-time PnL
```

---

## Agent Roles

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | `get_chart_candidates`, `deploy_position` |
| `MANAGER` | Manage open positions | `close_position`, `claim_fees`, `get_position_pnl` |
| `GENERAL` | Manual commands + strategy management | All tools |

---

## Available Tools (21)

**Screening:** `get_chart_candidates`, `get_pool_detail`

**Deployment:** `get_active_bin`, `deploy_position`

**Management:** `get_my_positions`, `get_position_pnl`, `claim_fees`, `close_position`, `set_position_note`, `add_pool_note`

**Wallet:** `get_wallet_balance`, `swap_token`, `get_wallet_positions`

**Token Safety:** `get_token_holders`, `get_token_info`

**Smart Wallets:** `add_smart_wallet`, `remove_smart_wallet`, `list_smart_wallets`, `get_smart_wallet_stats`

**Strategy:** `list_strategies`, `apply_strategy`

**Config & Learning:** `update_config`, `get_performance_history`, `add_lesson`, `list_lessons`

---

## Scheduling

| Cycle | Default Interval |
|-------|-----------------|
| Management | Every 3 minutes |
| Screening | Every 15 minutes |

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Solana wallet private key (base58) |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key (OpenRouter) |
| `LPAGENT_API_KEY` | Yes | LPAgent primary API key (real-time PnL) |
| `LPAGENT_API_KEY_BACKUP` | No | LPAgent backup key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `HELIUS_API_KEY` | No | Enhanced Solana data |

---

## Quick Start

```bash
cp .env.example .env
# fill in WALLET_PRIVATE_KEY, RPC_URL, OPENROUTER_API_KEY, LPAGENT_API_KEY

npm install
node index.js
```

With PM2:
```bash
pm2 start index.js --name prospera
pm2 save
pm2 logs prospera
```

Dry run (no real transactions):
```bash
DRY_RUN=true node index.js
```

---

## Key Configuration (`user-config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `maxPositions` | 2 | Max concurrent open positions |
| `minBinStep` / `maxBinStep` | 80 / 200 | Pool bin step range |
| `minVolume` | 20000 | Min 5m volume ($) |
| `minMcap` / `maxMcap` | 150k / 10M | Token market cap range |
| `minTokenAgeHours` / `maxTokenAgeHours` | 1 / 1440 | Token age range (1h – 2 months) |
| `stopLossPct` | −20 | Stop loss threshold |
| `takeProfitMaxPct` | 25 | Auto take-profit threshold |
| `takeProfitFeePct` | 5 | LLM decision zone starts here |
| `outOfRangeBinsToClose` | 20 | OOR bin distance to trigger close |
| `maxBundlePct` | 30 | Max bundle % (OKX filter) |
| `fibConfluenceRequired` | true | Require Fib confluence for entry |
| `candleLimit` | 100 | OHLCV candles for analysis |
