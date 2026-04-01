/**
 * Tool schemas in OpenAI function-calling format.
 * These are what the LLM sees — keep descriptions accurate and concise.
 */

export const tools = [
  // ═══════════════════════════════════════════
  //  SCREENING TOOLS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "get_chart_candidates",
      description: `Fetch trending Meteora DLMM pools and filter by Fibonacci + Volume Profile entry signals.

Each candidate has been analyzed with:
1. 50x 1m OHLCV candles from GeckoTerminal
2. Swing high/low detection over the 50-candle window
3. Fibonacci retracement levels (0.236, 0.382, 0.500, 0.618)
4. Volume Profile with POC and Value Area (VAL/VAH)

ENTRY signal conditions (both must be true):
- Current price is within [fib_618, fib_236] retracement zone
- POC or VAL is within the same zone (volume support confirms the level)

Returns only pools that pass the signal filter. Each candidate includes:
- fib_signal.binsBelow: pre-calculated bins to cover current price → fib_618 level
- fib_signal.confluenceScore: 0-1, how well price and volume align (higher = better)
- fib_signal.fibLevels: all Fib price levels
- fib_signal.poc / vah / val: Volume Profile key prices

Use binsBelow from fib_signal DIRECTLY in deploy_position. bins_above = 0 always.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max pools to scan before applying Fib filter (default 20)",
          },
        },
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_pool_detail",
      description: `Get detailed info for a specific DLMM pool by address.
Use during management to check current pool health (volume, fees, organic score, price trend).
Default timeframe is 5m for real-time accuracy during management.

IMPORTANT: Only call with a real pool address from get_my_positions or get_chart_candidates.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The on-chain pool address (base58 public key)",
          },
          timeframe: {
            type: "string",
            enum: ["5m", "15m", "30m", "1h", "2h", "4h", "12h", "24h"],
            description: "Data timeframe. Default 5m for management.",
          },
        },
        required: ["pool_address"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  POSITION DEPLOYMENT TOOLS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "get_active_bin",
      description: `Get the current active bin and price for a DLMM pool.
Returns: binId, price, pricePerLamport.

Only call if you need to verify the current active bin. deploy_position fetches active bin internally.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address",
          },
        },
        required: ["pool_address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM liquidity position.

FIBONACCI STRATEGY RULES (hard):
- Strategy: ALWAYS bid_ask. Never use spot or curve.
- bins_above: ALWAYS 0 — single-sided below current price.
- bins_below: Use fib_signal.binsBelow from get_chart_candidates EXACTLY.
- amount_y: SOL only. Never set amount_x > 0.
- Bin Step: Only deploy in pools with bin_step between 80 and 200.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          pool_address:     { type: "string",  description: "The DLMM pool address to LP in" },
          amount_y:         { type: "number",  description: "Amount of SOL to deposit (quote token)" },
          amount_x:         { type: "number",  description: "Amount of base token — DO NOT USE. Always 0." },
          strategy:         { type: "string",  enum: ["bid_ask"], description: "Always bid_ask" },
          bins_below:       { type: "number",  description: "Bins below active bin — use fib_signal.binsBelow from get_chart_candidates" },
          bins_above:       { type: "number",  description: "Always 0 for Fibonacci strategy" },
          pool_name:        { type: "string",  description: "Human-readable pool name for records" },
          base_mint:        { type: "string",  description: "Base token mint address" },
          bin_step:         { type: "number",  description: "Pool bin step" },
          base_fee:         { type: "number",  description: "Pool base fee percentage" },
          volatility:       { type: "number",  description: "Pool volatility at deploy time" },
          fee_tvl_ratio:    { type: "number",  description: "fee/TVL ratio at deploy time" },
          organic_score:    { type: "number",  description: "Base token organic score at deploy time" },
          initial_value_usd:{ type: "number",  description: "Estimated USD value being deployed" },
          mcap:             { type: "number",  description: "Base token market cap at deploy time" },
          volume_5m:        { type: "number",  description: "Token 5m volume at deploy time" },
        },
        required: ["pool_address"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  POSITION MANAGEMENT TOOLS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get detailed PnL and real-time Fee/TVL metrics for an open position.
Returns: pnl_usd, pnl_pct, current_value_usd, unclaimed_fee_usd, fee_per_tvl_24h, in_range, bin range data.`,
      parameters: {
        type: "object",
        properties: {
          pool_address:     { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" },
        },
        required: ["pool_address", "position_address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.
Returns positions with: pool, pair, bin range, in-range status, unclaimed fees, PnL, age.
Use at the start of every management cycle.`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  {
    type: "function",
    function: {
      name: "claim_fees",
      description: `Claim accumulated swap fees from a specific position.
Only call when unclaimed fees > $5 to justify transaction costs.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to claim fees from",
          },
        },
        required: ["position_address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position.

FIBONACCI STOP-LOSS RULES — close when:
- PnL <= -20% (stop loss)
- Position is OOR for > outOfRangeWaitMinutes AND active_bin is > outOfRangeBinsToClose bins away
- Token shows clear danger signals (volume collapse, organic score crash)

After close: base token is automatically swapped back to SOL.

WARNING: Real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close",
          },
          skip_swap: {
            type: "boolean",
            description: "Set true to hold base token after close instead of auto-swapping to SOL",
          },
          reason: {
            type: "string",
            description: "Why this position is being closed (e.g. 'stop loss -20%', 'OOR > 10 bins', 'volume collapse')",
          },
        },
        required: ["position_address"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  WALLET TOOLS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current wallet balances: SOL, USDC, and all SPL token holdings with USD values.
Use to check available capital before deploying.`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  {
    type: "function",
    function: {
      name: "swap_token",
      description: `Swap tokens via Jupiter aggregator.
Use to convert claimed fee tokens or base tokens back to SOL after closing a position.

WARNING: Real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          input_mint:  { type: "string", description: "Mint address of the token to sell" },
          output_mint: { type: "string", description: "Mint address of the token to buy" },
          amount:      { type: "number", description: "Amount of input token (human-readable, not lamports)" },
        },
        required: ["input_mint", "output_mint", "amount"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  CONFIG & LEARNING TOOLS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update operating parameters at runtime. Changes persist to user-config.json immediately.

VALID KEYS:
Screening: minTvl, maxTvl, minVolume, minOrganic, minHolders, minMcap, maxMcap, minBinStep, maxBinStep, timeframe, candleLimit, fibConfluenceRequired, autoBacktest, minBacktestWinRate, backtestAggregate
Management: minClaimAmount, outOfRangeBinsToClose, outOfRangeWaitMinutes, stopLossPct, takeProfitFeePct, minSolToOpen, deployAmountSol, gasReserve, positionSizePct
Risk: maxPositions, maxDeployAmount
Schedule: managementIntervalMin, screeningIntervalMin
Models: managementModel, screeningModel, generalModel`,
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Key-value pairs of settings to update",
          },
          reason: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["changes"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "set_position_note",
      description: `Set a persistent instruction or note on a position.
Examples: "close at 5% profit", "hold until volume recovers", "monitor OOR".
The instruction is shown in every management cycle and the agent acts on it.`,
      parameters: {
        type: "object",
        properties: {
          position_address: { type: "string", description: "The position public key" },
          instruction: { type: "string", description: "The instruction text. Pass null or empty string to clear." },
        },
        required: ["position_address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: `Deep holder analysis for a token using OKX + Jupiter DataAPI.
Returns bundle %, bot holders %, top 10 concentration %, total fees SOL, dev status, and funding address.
Use before deploying a position to verify token safety beyond what screening already checked.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" },
        },
        required: ["mint"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_token_info",
      description: `Get token security info, ATH price, and KOL/cluster activity from OKX.
Returns sniper %, suspicious %, risk level (1–5), dev holding %, dev sold-all tag, smart money buy tag, rug history count, and KOL cluster data.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" },
        },
        required: ["mint"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "get_wallet_positions",
      description: `Get all open DLMM positions for any Solana wallet address.
Use to check another wallet's positions. Returns same structure as get_my_positions.`,
      parameters: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "The Solana wallet address (base58 public key) to check",
          },
        },
        required: ["wallet_address"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  SMART WALLETS
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a Solana wallet address to the smart money tracker.
Smart wallet activity in a candidate pool boosts its confluenceScore by +0.10 during screening.
Use for wallets known to make high-quality DLMM LP entries (verified alpha traders, top performers).`,
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Solana wallet address (base58)" },
          label:   { type: "string", description: "Human-readable label (e.g. 'trader_X', 'whale_1')" },
        },
        required: ["address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "remove_smart_wallet",
      description: `Remove a wallet from the smart money tracker.`,
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Solana wallet address to remove" },
        },
        required: ["address"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "list_smart_wallets",
      description: `List all wallets in the smart money tracker with their labels and added dates.`,
      parameters: { type: "object", properties: {} },
    },
  },

  {
    type: "function",
    function: {
      name: "get_smart_wallet_stats",
      description: `Show self-learning progress: wallets observed but not yet promoted.
Lists win rate, total observations, and how close each wallet is to promotion threshold (3+ observations, ≥65% win rate).`,
      parameters: { type: "object", properties: {} },
    },
  },

  // ═══════════════════════════════════════════
  //  BACKTESTING
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "run_backtest",
      description: `Backtest the Fibonacci strategy on a pool using historical OHLCV data.
Replays entry/exit logic on past candles and returns win rate, avg PnL, exit reason breakdown, and per-zone performance.

Candle coverage by aggregate:
  aggregate=5  → ~3.5 days of history (recommended)
  aggregate=15 → ~10 days
  aggregate=60 → ~42 days

Returns summary stats + individual trade list. PnL is approximate (IL simplified, fees estimated).`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string",  description: "Pool address to backtest" },
          bin_step:     { type: "number",  description: "Pool bin step (e.g. 100)" },
          fee_pct:      { type: "number",  description: "Pool base fee % (e.g. 1.0)" },
          aggregate:    { type: "number",  enum: [1, 5, 15, 60], description: "Candle size in minutes. Default 5." },
          candle_limit: { type: "number",  description: "Indicator window size. Default 100." },
          preset:       { type: "string",  enum: ["fibonacci", "conservative", "aggressive", "trending"], description: "Strategy preset to simulate. Default: current config." },
        },
        required: ["pool_address", "bin_step", "fee_pct"],
      },
    },
  },

  // ═══════════════════════════════════════════
  //  STRATEGY LIBRARY
  // ═══════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_strategies",
      description: `List all available LP strategy presets with descriptions.
Presets: fibonacci (default), conservative, aggressive, trending.`,
      parameters: { type: "object", properties: {} },
    },
  },

  {
    type: "function",
    function: {
      name: "apply_strategy",
      description: `Apply a strategy preset, updating screening and management config in bulk.
Available: fibonacci, conservative, aggressive, trending.
This will overwrite the relevant config keys — use list_strategies to see what each changes.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: ["fibonacci", "conservative", "aggressive", "trending"],
            description: "Strategy preset name to apply",
          },
        },
        required: ["name"],
      },
    },
  },
];
