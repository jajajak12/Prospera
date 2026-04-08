/**
 * log-utils.js — Logging helpers: correlation ID + structured skip logging.
 * Reuses the winston instance already configured in logger.js.
 */

import crypto from "crypto";
import { log } from "./logger.js";

export function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Correlation-aware log with 8-char ID injected into ctx.
 * @param {string} category  — e.g. "screening", "management", "error", "warn"
 * @param {string} message
 * @param {object} [meta]    — symbol, fibLevel, rsi, exposurePct, skipReason, etc.
 * @returns {string} correlationId
 */
export function logWithId(category, message, meta = {}) {
  const id = shortId();
  const ctx = { ...meta, correlationId: id };
  log(category, `[${id}] ${message}`, ctx);
  return id;
}

/**
 * Convenience wrapper for screening skips.
 * @param {string} reason    — fib | rsi | exposure | lock | max_positions | insufficient_balance | exposure_pause
 * @param {object} [meta]    — symbol, fibLevel, rsi, exposurePct, pair, etc.
 * @returns {string} correlationId
 */
export function logSkip(reason, meta = {}) {
  return logWithId("screening", `SKIP [${reason}]`, { ...meta, skipReason: reason });
}
