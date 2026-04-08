/**
 * log-utils.js — Logging helpers: correlation ID + structured skip logging.
 * Reuses logger.js underlying winston instance via module-level import.
 */

import crypto from "crypto";

// Re-use winston logger from logger.js (singleton, already configured)
import { createLogger } from "winston";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// ── Inline minimal logger (avoids circular import) ───────────────────────────
// We need access to the same winston instance configured in logger.js.
// Best approach: import the configured log function directly.
import { log } from "./logger.js";

// ── shortId ──────────────────────────────────────────────────────────────────

export function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

// ── logWithId ─────────────────────────────────────────────────────────────────

/**
 * Correlation-aware log helper.
 * Prefixes message with 8-char ID and merges meta into ctx.
 * Delegates to existing log() for actual output.
 *
 * @param {string} category  — e.g. "screening", "management", "error", "warn"
 * @param {string} message
 * @param {object} [meta]    — structured fields: symbol, fibLevel, rsi, exposurePct, skipReason, etc.
 * @returns {string} correlationId
 */
export function logWithId(category, message, meta = {}) {
  const id = shortId();
  const ctx = { ...meta, correlationId: id };
  log(category, `[${id}] ${message}`, ctx);
  return id;
}

// ── logSkip ───────────────────────────────────────────────────────────────────

/**
 * Convenience wrapper for screening skips.
 * Formats: "SKIP [reason]" with structured meta.
 *
 * @param {string} reason    — fib | rsi | exposure | lock | max_positions | insufficient_balance
 * @param {object} [meta]    — symbol, fibLevel, rsi, exposurePct, pair, etc.
 * @returns {string} correlationId
 */
export function logSkip(reason, meta = {}) {
  return logWithId("screening", `SKIP [${reason}]`, { ...meta, skipReason: reason });
}
