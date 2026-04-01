# Prospera

Autonomous DLMM liquidity provider agent for Meteora pools on Solana. Combines Fibonacci retracement + Volume Profile entry signals with multi-layer token safety filters, automated backtesting with parameter optimization, and self-learning position management.

---

## Overview

Prospera is a fully autonomous LP agent that:
- Discovers trending Meteora DLMM pools via the Pool Discovery API
- Filters by Fibonacci + Volume Profile entry signals (ATH-based Fib levels from daily candles)
- Optionally backtests each candidate on historical OHLCV before deploying
- Runs multi-layer token safety checks (organic score, OKX honeypot/bundle, token age, blacklists)
- Manages open positions with tiered rules (stop loss, LLM decision zone, auto take-profit)
- Learns from closed positions to evolve screening thresholds and detect smart money wallets
- Sends a daily morning briefing via Telegram at 08:00

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

Applied in order from cheapest to most expensive — any failure eliminates the pool immediately:

1. **Meteora API filters** — organic score, holders, mcap, TVL, bin step, fee/TVL ratio, token age
2. **Blacklists** — `token-blacklist.json` (mints) and `dev-blocklist.json` (deployer addresses)
3. **Token volume filter** — actual last-5m volume across ALL DEXes via Dexscreener (`volume.m5` summed per token). Accurate for tokens as young as 1 hour — no 24h averaging
4. **OKX DEX filter** — honeypot detection, bundle % check, creator address cross-check
5. **Jupiter token safety** — top 10 holder concentration (`maxTop10Pct`), bot holder % (`maxBotHoldersPct`), min fees SOL (`minTokenFeesSol`)
6. **ATH proximity filter** (optional) — skip tokens too close to ATH (configurable `athFilterPct`)
7. **Fibonacci signal filter** — Fib zone, volume profile, EMA, RSI, ATR (most expensive — only runs on tokens that passed all above)
8. **Auto-backtest filter** (optional) — historical win rate check on each candidate before deploy

---

## Backtesting & Parameter Optimization

Prospera includes a built-in backtesting engine (`backtest.js`) that replays Fibonacci entry/exit logic on historical OHLCV data from GeckoTerminal.

### Periodic Auto-Backtest (02:00 daily)

Every night at 02:00, Prospera automatically:
1. Fetches up to 8 recently closed pools (last 7 days)
2. Runs backtest + parameter sweep on each
3. Sends a Telegram report with results and optimization suggestions

**Parameter sweep** tests 16 combinations of:
- RSI minimum threshold: `40 / 44 / 48 / 52`
- Confluence score minimum: `0.25 / 0.30 / 0.35 / 0.40`

The sweep is pure CPU (no extra API calls) and ranks combinations by win rate + avg PnL. Suggestions are cross-pool consensus — e.g. "RSI min 44 performed better in 3/5 pools". Changes are **informational only** — you decide whether to apply them via `update_config`.

### On-Demand via Telegram

```
/backtest        — last 7 days
/backtest 30d    — last 30 days
/backtest all    — all time
```

Or ask the LLM directly:
> "backtest pool `<address>` bin_step 100 fee 1.0"

### Backtest Parameters

| Aggregate | History covered |
|-----------|----------------|
| 1m | ~16.7 hours |
| 5m | ~3.5 days |
| 15m | ~10 days (default for periodic) |
| 60m | ~42 days |

**Graceful fallback for new tokens:** if a pool has insufficient history at the requested aggregate, automatically falls back to a smaller timeframe (15m → 5m → 1m). If still < 3 simulated trades, the pool is skipped without penalty.

> **Note:** PnL is approximate — fees estimated at 40% in-range utilization, IL simplified. Best used for signal quality ranking and parameter tuning, not exact profit projection.

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
backtest.js           Backtesting engine: historical OHLCV replay + PnL simulation
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

## Available Tools (23)

**Screening:** `get_chart_candidates`, `get_pool_detail`

**Deployment:** `get_active_bin`, `deploy_position`

**Management:** `get_my_positions`, `get_position_pnl`, `claim_fees`, `close_position`, `set_position_note`

**Wallet:** `get_wallet_balance`, `swap_token`, `get_wallet_positions`

**Token Safety:** `get_token_holders`, `get_token_info`

**Smart Wallets:** `add_smart_wallet`, `remove_smart_wallet`, `list_smart_wallets`, `get_smart_wallet_stats`

**Strategy:** `list_strategies`, `apply_strategy`

**Backtesting:** `run_backtest` (manual per-pool; periodic sweep runs automatically at 02:00)

**Config & Learning:** `update_config`

---

## Scheduling

| Cycle | Default Interval |
|-------|-----------------|
| Management | Every 3 minutes |
| Screening | Every 15 minutes |
| Morning Briefing | Daily at 08:00 |
| Periodic Backtest | Daily at 02:00 |

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
| `minVolume` | 20000 | Min actual 5m volume across all DEXes ($) — sourced from Dexscreener |
| `minMcap` / `maxMcap` | 150k / 10M | Token market cap range |
| `minTokenAgeHours` / `maxTokenAgeHours` | 1 / 1440 | Token age range (1h – 2 months) |
| `stopLossPct` | −20 | Stop loss threshold |
| `takeProfitMaxPct` | 25 | Auto take-profit threshold |
| `takeProfitFeePct` | 5 | LLM decision zone starts here |
| `outOfRangeBinsToClose` | 20 | OOR bin distance to trigger close |
| `maxBundlePct` | 30 | Max bundle % (OKX filter) |
| `maxTop10Pct` | 20 | Max top 10 holders concentration % (Jupiter) |
| `maxBotHoldersPct` | 30 | Max bot holder % (Jupiter) |
| `minTokenFeesSol` | 25 | Min fees earned in SOL (Jupiter) |
| `fibConfluenceRequired` | true | Require Fib confluence for entry |
| `candleLimit` | 100 | OHLCV candles for analysis |
| `autoBacktest` | false | Enable pre-deploy backtest filter (optional — periodic cron runs regardless) |
| `minBacktestWinRate` | 0.50 | Minimum win rate to pass pre-deploy filter |
| `backtestAggregate` | 15 | Candle size for backtest (minutes) |
