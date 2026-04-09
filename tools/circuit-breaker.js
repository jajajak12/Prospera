/**
 * tools/circuit-breaker.js — Circuit breaker for LLM provider calls.
 *
 * Protects against MiniMax API failures (primary provider).
 * On 3 consecutive failures → circuit OPENS → skip next cycle + Telegram alert.
 * Does NOT fallback to OpenRouter for trade actions (avoids tool-calling incompatibility).
 * After cooldown → HALF-OPEN → probe MiniMax. Success → circuit CLOSES.
 *
 * State is module-level (survives PM2 restarts via in-memory + logs).
 * Exponential backoff: 1s → 2s → 4s → 8s per call attempt.
 */

import { log } from "../logger.js";
import { config } from "../config.js"; // lazy access — ok as long as config.js doesn't import circuit-breaker
import { sendMessage, isEnabled as telegramEnabled } from "../telegram.js";

// ── Circuit state ───────────────────────────────────────────────────────────
let failureCount     = 0;
let isCircuitBroken  = false;
let fallbackUntil    = 0;    // timestamp (ms) when fallback period ends
let lastError        = null; // last error message for debugging
let lastCorrId       = null; // last correlation ID for graceful shutdown logging
let skipUntil        = 0;    // timestamp (ms) — if Date.now() < skipUntil, next cycle is skipped (auto-clears when expired)

// Config constants
const TRIP_THRESHOLD  = 3;          // consecutive failures to trip circuit
const COOLDOWN_MS     = 10 * 60 * 1000; // 10 minutes cooldown
const BACKOFF_DELAYS  = [1_000, 2_000, 4_000, 8_000]; // ms per attempt

// ── Provider configs ────────────────────────────────────────────────────────
const PROVIDERS = {
  minimax: {
    baseURL: "https://api.minimax.io/v1",
    apiKeyEnv: "LLM_API_KEY",
    model: "MiniMax-M2.7", // resolved from config at runtime via getProviderConfig
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    model: "deepseek/deepseek-v3.2",
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns current active provider: 'openrouter' if circuit broken, else 'minimax'.
 */
export function getActiveProvider() {
  if (isCircuitBroken && Date.now() < fallbackUntil) {
    return "openrouter";
  }
  // Half-open: circuit was broken but cooldown expired — try minimax again
  if (isCircuitBroken) {
    return "minimax";
  }
  return "minimax";
}

/**
 * Returns { baseURL, apiKey, model } for the active provider.
 * Handles half-open state (circuit expired but not yet confirmed working).
 */
export function getProviderConfig() {
  const provider = getActiveProvider();
  const p = PROVIDERS[provider];

  // Resolve model from config at runtime (supports user overrides)
  let model;
  if (provider === "minimax") {
    model = config.llm?.minimaxModel || p.model;
  } else {
    model = config.llm?.openrouterModel || p.model;
  }

  return {
    baseURL: p.baseURL,
    apiKey: process.env[p.apiKeyEnv] || "placeholder",
    model,
    provider,
  };
}

/**
 * Returns true if we should use the fallback (circuit is open and within cooldown).
 */
export function isFallbackActive() {
  return isCircuitBroken && Date.now() < fallbackUntil;
}

/**
 * Returns true if we should skip the next cycle (skipUntil has not yet expired).
 * Auto-clears when skipUntil expires (no manual clear needed).
 */
export function shouldSkipNextCycle() {
  if (Date.now() < skipUntil) return true;
  skipUntil = 0; // expired — auto-clear
  return false;
}

/**
 * Returns current circuit state for health checks / logging.
 */
export function getCircuitState() {
  return {
    isCircuitBroken,
    fallbackUntil,
    failureCount,
    lastError,
    lastCorrId,
    isFallbackActive: isFallbackActive(),
    cooldownRemainingSec: isCircuitBroken ? Math.max(0, Math.ceil((fallbackUntil - Date.now()) / 1000)) : 0,
    skipUntil,
    skipActive: Date.now() < skipUntil,
  };
}

/**
 * Record a successful LLM call → reset failure count, close circuit.
 */
export function recordSuccess(corrId = null) {
  if (failureCount > 0 || isCircuitBroken) {
    log("circuit", `Circuit CLOSED — provider healthy`, {
      previousFailures: failureCount,
      provider: getActiveProvider(),
      correlationId: corrId || lastCorrId,
    });
  }
  failureCount    = 0;
  isCircuitBroken  = false;
  fallbackUntil    = 0;
  lastError        = null;
}

/**
 * Record a failed LLM call → increment count, trip circuit at threshold.
 * Returns true if circuit just tripped (transitions to open).
 */
export function recordFailure(error, corrId = null) {
  lastError = error?.message || String(error);
  if (corrId) lastCorrId = corrId;

  // Don't count failures during fallback period — they're expected
  if (isCircuitBroken && Date.now() < fallbackUntil) {
    return false;
  }

  failureCount++;

  if (failureCount >= TRIP_THRESHOLD) {
    isCircuitBroken = true;
    fallbackUntil   = Date.now() + COOLDOWN_MS;
    skipUntil       = Date.now() + COOLDOWN_MS;
    log("error", `Circuit TRIPPED — 3 consecutive failures → skip next cycle + alert for ${COOLDOWN_MS / 60_000} min until ${new Date(skipUntil).toISOString()}`, {
      lastError: lastError.slice(0, 200),
      fallbackUntil: new Date(fallbackUntil).toISOString(),
      skipUntil: new Date(skipUntil).toISOString(),
      correlationId: corrId || lastCorrId,
    });
    failureCount = 0; // reset count once tripped

    // Telegram alert — fire and forget
    if (telegramEnabled()) {
      sendMessage(`🔧 Circuit Breaker TRIPPED — 3 consecutive LLM failures\n⏭ Skip cycles for ${COOLDOWN_MS / 60_000} min (until ${new Date(skipUntil).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })})\n📋 Last error: ${lastError?.slice(0, 120) ?? "unknown"}\n♻️ Auto-resumes when cooldown expires`).catch(() => {});
    }

    return true;
  }

  log("warn", `LLM call failed (${failureCount}/${TRIP_THRESHOLD} before trip)`, {
    lastError: lastError.slice(0, 200),
    correlationId: corrId || lastCorrId,
  });
  return false;
}

/**
 * Returns exponential backoff delay for a given attempt index (0-based).
 * @param {number} attempt - 0-based attempt index
 * @returns {number} delay in ms
 */
export function getBackoffDelay(attempt) {
  return BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)];
}

/**
 * Set the last correlation ID (called from index.js with active cycle ID).
 */
export function setCorrelationId(corrId) {
  lastCorrId = corrId;
}

/**
 * Sleep helper for backoff.
 */
export function circuitSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
