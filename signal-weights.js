/**
 * signal-weights.js — Darwinian Signal Weighting
 *
 * Tracks which screening signals correlate with profitable trades.
 * After each position closes, weights update via lift analysis:
 *   - Signal shows higher avg value in wins vs losses → weight +0.05 (max 2.5)
 *   - Signal shows lower avg value in wins vs losses  → weight -0.05 (min 0.3)
 *   - Neutral or insufficient data                   → unchanged
 *
 * Weights are injected into the SCREENER prompt so the LLM naturally
 * prioritises signals that historically predict good outcomes.
 *
 * Signals tracked (all available in performance records):
 *   organic_score, fee_tvl_ratio, volume_5m, confluence_score,
 *   fib_zone, bin_step, volatility
 */

import fs from "fs";
import { log } from "./logger.js";

const WEIGHTS_FILE  = "./signal-weights.json";
const WEIGHT_MIN    = 0.3;
const WEIGHT_MAX    = 2.5;
const WEIGHT_STEP   = 0.05;
const MIN_SAMPLES   = 6;   // minimum history entries before adjusting

export const DEFAULT_WEIGHTS = {
  organic_score:    1.0,
  fee_tvl_ratio:    1.0,
  volume_5m:        1.0,
  confluence_score: 1.0,
  fib_zone:         1.0,
  bin_step:         1.0,
  volatility:       1.0,
};

// Expected numeric ranges for normalisation to [0,1]
const SIGNAL_RANGES = {
  organic_score:    [0,   100],
  fee_tvl_ratio:    [0,   0.5],
  volume_5m:        [0,   200_000],
  confluence_score: [0,   1],
  bin_step:         [80,  200],
  volatility:       [0,   0.15],
};

// fib_zone categorical → ordinal score
const FIB_ZONE_SCORE = {
  PRIMARY:   1.0,
  ATH_ZONE:  0.7,
  SECONDARY: 0.5,
};

function load() {
  if (!fs.existsSync(WEIGHTS_FILE)) return { weights: { ...DEFAULT_WEIGHTS }, history: [] };
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
  } catch {
    return { weights: { ...DEFAULT_WEIGHTS }, history: [] };
  }
}

function save(data) {
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
}

function normalise(signal, value) {
  if (signal === "fib_zone") return FIB_ZONE_SCORE[value] ?? 0.5;
  if (typeof value !== "number") return null;
  const [lo, hi] = SIGNAL_RANGES[signal] ?? [0, 1];
  if (hi <= lo) return null;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

function avg(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Update weights after a position closes.
 * Called from lessons.recordPerformance.
 *
 * @param {Object} perf - performance record (same shape as lessons.js entry)
 */
export function updateSignalWeights(perf) {
  const data = load();
  const { pnl_pct } = perf;
  if (pnl_pct == null) return;

  const win  = pnl_pct >= 5;
  const loss = pnl_pct <= -5;
  if (!win && !loss) return; // neutral — skip

  const snapshot = {
    win,
    ts: new Date().toISOString(),
    signals: {
      organic_score:    perf.organic_score    ?? null,
      fee_tvl_ratio:    perf.fee_tvl_ratio    ?? null,
      volume_5m:        perf.volume_5m        ?? null,
      confluence_score: perf.confluence_score ?? null,
      fib_zone:         perf.fib_zone         ?? null,
      bin_step:         perf.bin_step         ?? null,
      volatility:       perf.volatility       ?? null,
    },
  };

  data.history.push(snapshot);
  if (data.history.length > 100) data.history = data.history.slice(-100);

  if (data.history.length < MIN_SAMPLES) {
    save(data);
    return;
  }

  const wins   = data.history.filter(h => h.win);
  const losses = data.history.filter(h => !h.win);
  const changed = {};

  for (const signal of Object.keys(DEFAULT_WEIGHTS)) {
    const wv = wins.map(h  => normalise(signal, h.signals[signal])).filter(v => v != null);
    const lv = losses.map(h => normalise(signal, h.signals[signal])).filter(v => v != null);

    if (wv.length < 2 || lv.length < 2) continue;

    const lift = avg(wv) - avg(lv);
    let w = data.weights[signal] ?? 1.0;

    if      (lift >  0.1) w = Math.min(WEIGHT_MAX, w + WEIGHT_STEP);
    else if (lift < -0.1) w = Math.max(WEIGHT_MIN, w - WEIGHT_STEP);

    w = Math.round(w * 100) / 100;
    if (w !== (data.weights[signal] ?? 1.0)) changed[signal] = w;
    data.weights[signal] = w;
  }

  data.lastUpdated = new Date().toISOString();
  save(data);

  if (Object.keys(changed).length > 0) {
    log("signal_weights", `Updated: ${Object.entries(changed).map(([k,v]) => `${k}→${v}`).join(", ")}`);
  }
}

/**
 * Return current weights map.
 */
export function getSignalWeights() {
  return load().weights ?? { ...DEFAULT_WEIGHTS };
}

/**
 * Format weights for injection into LLM system prompt.
 * Returns null if not enough history yet.
 */
export function formatWeightsForPrompt() {
  const data = load();
  const n = data.history?.length ?? 0;
  if (n < MIN_SAMPLES) return null;

  const w = data.weights ?? { ...DEFAULT_WEIGHTS };
  const lines = Object.entries(w)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => {
      const label = v >= 1.5 ? "⬆ strong" : v <= 0.6 ? "⬇ weak" : "→ neutral";
      return `  ${k}: ${v.toFixed(2)} ${label}`;
    });

  return `SIGNAL WEIGHTS (learned from ${n} closed positions — prioritise ⬆ signals):\n${lines.join("\n")}`;
}

/**
 * Reset weights and history to defaults.
 */
export function resetSignalWeights() {
  save({ weights: { ...DEFAULT_WEIGHTS }, history: [] });
  return { ...DEFAULT_WEIGHTS };
}
