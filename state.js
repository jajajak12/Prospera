/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 *
 * Adapted from Meridian's state.js.
 * Key change: outOfRangeBinsToClose default = 10 (was 20 in Meridian).
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";
const MAX_RECENT_EVENTS = 20;

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!data.positions || typeof data.positions !== "object" || Array.isArray(data.positions)) data.positions = {};
    return data;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  mcap,
  volume_5m,
  fib_entry_pct = null,          // Where in fib zone was entry? (0% = fib236, 100% = fib618)
  confluence_score = null,       // Fibonacci confluence score at entry (0-1)
  fib_zone = null,               // ATH_ZONE / PRIMARY / SECONDARY
  fib_levels_sol = null,         // { fib236, fib500, fib618 } in SOL — for Successful Rebound tracking
  rsi = null,                    // RSI at entry
  atr_pct = null,                // ATR% at entry
  in_primary_zone = null,        // true = primary zone (fib 0.236–0.382)
  has_hidden_divergence = null,  // hidden bullish divergence detected
  smart_wallet_present = null,   // smart wallet boost was applied
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    mcap,
    volume_5m,
    fib_entry_pct,
    confluence_score,
    fib_zone,
    fib_levels_sol,
    touched_lower_fib: false,
    rsi,
    atr_pct,
    in_primary_zone,
    has_hidden_divergence,
    smart_wallet_present,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = instruction || null;
  save(state);
  log("state", `Position ${position_address} instruction set: ${instruction}`);
  return true;
}

export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter(p => !p.closed) : all;
}

export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter(p => !p.closed);
  const closed = Object.values(state.positions).filter(p => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map(p => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
      fib_entry_pct: p.fib_entry_pct ?? null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position.
 * outOfRangeBinsToClose default = 10 for Fibonacci strategy.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Track peak PnL
  if (currentPnlPct != null && currentPnlPct > (pos.peak_pnl_pct ?? 0)) {
    pos.peak_pnl_pct = currentPnlPct;
    changed = true;
  }

  // Activate trailing TP
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && currentPnlPct >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated at ${currentPnlPct}%`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss (-20% default for Fibonacci) ───────────────────────────
  if (currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield ─────────────────────────────────────────────────
  // Only check when position has dropped below fib.236 (ATH zone entries are skipped)
  // We wait for entry zone to be touched; if fees are low, pool may be dead
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h
  ) {
    // Skip if still in ATH zone — we give ATH zone positions time to recover
    if (pos.fib_zone === 'ATH_ZONE') {
      return null;
    }
    const now = Date.now();
    const lastCheck = pos.last_low_yield_check_at ? new Date(pos.last_low_yield_check_at).getTime() : 0;
    const minInterval = (mgmtConfig.lowYieldCheckIntervalMin ?? 120) * 60 * 1000;
    if (now - lastCheck < minInterval) {
      // Skip this cycle — not enough time since last check
      return null;
    }
    pos.last_low_yield_check_at = new Date().toISOString();
    changed = true;
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}%`,
    };
  } else {
    // Reset check timer if yield is ok
    if (pos.last_low_yield_check_at) {
      pos.last_low_yield_check_at = null;
      changed = true;
    }
  }

  return null;
}

// ─── Failed Rebound Tracking ──────────────────────────────────

/**
 * Update Fib touch state for a position.
 * Sets touched_lower_fib=true when price <= fib500.
 * Returns { touched, fib236 } for the management cycle to check successful rebound.
 */
export function updateFibTouchState(position_address, livePriceSol) {
  if (livePriceSol == null) return { touched: false, fib236: null };
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || !pos.fib_levels_sol) return { touched: false, fib236: null };

  if (!pos.touched_lower_fib && livePriceSol <= pos.fib_levels_sol.fib500) {
    pos.touched_lower_fib = true;
    save(state);
    log("state", `Position ${position_address} touched Fib ≤0.500 (price ${livePriceSol.toPrecision(4)} <= fib500 ${pos.fib_levels_sol.fib500.toPrecision(4)}) — watching for successful rebound to 0.236`);
  }

  return { touched: !!pos.touched_lower_fib, fib236: pos.fib_levels_sol?.fib236 ?? null };
}

// ─── Briefing Tracking ─────────────────────────────────────────

export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10);
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 */
const SYNC_GRACE_MS = 5 * 60_000;

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
