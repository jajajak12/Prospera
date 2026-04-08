/**
 * log-utils.js — Correlation ID helpers for Prospera cycles.
 *
 * Each screening/management cycle gets ONE correlation ID at the start.
 * All log calls within that cycle use the SAME ID — enables tracing.
 *
 * Reuses the winston instance already configured in logger.js (no re-init).
 */

import crypto from "crypto";
import { log } from "./logger.js";

export function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Correlation-aware log. Generates a NEW ID if not provided.
 * @param {string} category  — e.g. "screening", "management", "error", "warn"
 * @param {string} message
 * @param {object} [meta]    — symbol, fibLevel, rsi, exposurePct, skipReason, etc.
 * @param {string} [corrId]  — existing correlation ID to reuse (optional)
 * @returns {string} correlationId (provided or newly generated)
 */
export function logWithId(category, message, meta = {}, corrId = null) {
  const id = corrId ?? shortId();
  const ctx = { ...meta, correlationId: id };
  log(category, `[${id}] ${message}`, ctx);
  return id;
}

/**
 * Log a cycle start event with a NEW correlation ID.
 * Returns the new ID so it can be propagated through the cycle.
 * @param {string} cycleName  — "screening" or "management"
 * @returns {string} correlationId
 */
export function logCycleStart(cycleName) {
  return logWithId(cycleName, `>>> CYCLE START <<<`, { event: "cycle_start" });
}

/**
 * Convenience wrapper for screening skips — reuses existing correlation ID.
 * @param {string} reason     — fib | rsi | exposure | lock | max_positions | insufficient_balance | etc.
 * @param {object} [meta]      — symbol, fibLevel, rsi, etc.
 * @param {string} [corrId]   — existing correlation ID to reuse (required for proper tracing)
 * @returns {string} correlationId
 */
export function logSkip(reason, meta = {}, corrId = null, cat = "screening") {
  return logWithId(cat, `SKIP [${reason}]`, { ...meta, skipReason: reason }, corrId);
}
