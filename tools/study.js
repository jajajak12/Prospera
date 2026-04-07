/**
 * study.js — LPAgent API integration for fibonacci-lp
 *
 * Pure LPAgent data source. No Meteora fallback.
 * Supports primary + backup API key.
 * Set in .env:
 *   LPAGENT_API_KEY=primary_key
 *   LPAGENT_API_KEY_BACKUP=backup_key
 *
 * Rate limiting:
 *   - Min 6s delay between any LPAgent calls (shared across keys)
 *   - Exponential backoff + jitter on 429 (2s, 4s, 8s, max 30s)
 *   - Global backoff cooldown respected before any call
 */

import { log } from "../logger.js";

const LPAGENT_API     = "https://api.lpagent.io/open-api/v1";
const LPAGENT_PRIMARY = (process.env.LPAGENT_API_KEY || "").trim();
const LPAGENT_BACKUP  = (process.env.LPAGENT_API_KEY_BACKUP || "").trim();

// ── Rate limiting state ────────────────────────────────────────────────────
const MIN_CALL_INTERVAL_MS = 6000;  // min 6s between any calls
const MAX_BACKOFF_MS        = 30000; // max 30s backoff

let _lastCallAt     = 0;            // timestamp of last completed call
let _backoffUntil   = 0;            // timestamp: don't call before this
let _backoffAttempt = 0;            // consecutive 429 count (reset on success)

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.3);
}

async function enforceMinInterval() {
  const now = Date.now();
  const wait = Math.max(_backoffUntil - now, _lastCallAt + MIN_CALL_INTERVAL_MS - now);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
}

function recordBackoff(retryAfterHeader) {
  _backoffAttempt++;
  const base = Math.min(2000 * Math.pow(2, _backoffAttempt - 1), MAX_BACKOFF_MS);
  const delay = jitter(base);
  _backoffUntil = Date.now() + delay;
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
  if (retryAfter && retryAfter > delay) _backoffUntil = Date.now() + retryAfter;
  log.warn("lpagent", "LPAgent rate limited, backing off...", {
    retryAfter: retryAfterHeader ?? "none",
    backoffMs:  _backoffUntil - Date.now(),
    attempt:    _backoffAttempt,
  });
}

function recordSuccess() {
  _lastCallAt     = Date.now();
  _backoffAttempt = 0;
}

// ── Single fetch (one key, respects rate limits) ───────────────────────────
/**
 * Returns:
 *   { status: 'ok', data: [...] }   — success (may be empty array)
 *   { status: 'ratelimit' }         — 429, backoff recorded
 *   { status: 'error' }             — other HTTP error or network failure
 */
async function fetchWithKey(walletAddress, apiKey) {
  await enforceMinInterval();

  let res;
  try {
    res = await fetch(
      `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) }
    );
  } catch (err) {
    _lastCallAt = Date.now();
    log.error("lpagent", `fetch failed: ${err.message} (key: ...${apiKey.slice(-6)})`);
    return { status: "error" };
  }

  _lastCallAt = Date.now();

  if (res.status === 429) {
    recordBackoff(res.headers.get("retry-after"));
    return { status: "ratelimit" };
  }

  if (!res.ok) {
    log.error("lpagent", `HTTP ${res.status} (key: ...${apiKey.slice(-6)})`);
    return { status: "error" };
  }

  recordSuccess();

  const body = await res.json();
  if (!body.data?.length) {
    log("lpagent", `No open positions (count=${body.count ?? 0})`);
    return { status: "ok", data: [] };
  }
  return { status: "ok", data: body.data };
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Fetch open LP positions for a wallet.
 * Strategy:
 *   - Enforce global min interval + backoff cooldown
 *   - Try primary key once
 *   - If 429 on primary → wait out backoff, then try backup key
 *   - If other error on primary → immediately try backup key
 *   - If backup also fails → return null (caller skips cycle)
 *
 * Returns data array, [] for empty, or null if all keys fail.
 */
export async function fetchLPAgentOpenPositions(walletAddress) {
  if (!LPAGENT_PRIMARY) {
    log.error("lpagent", "LPAGENT_API_KEY not set in .env");
    return null;
  }

  // ── Primary key ────────────────────────────────────────────────
  const primary = await fetchWithKey(walletAddress, LPAGENT_PRIMARY);

  if (primary.status === "ok") return primary.data;

  if (primary.status === "ratelimit") {
    // backoff already recorded; if we have a backup key, wait then try it
    if (!LPAGENT_BACKUP) {
      log.error("lpagent", "Rate limited on primary, no backup key — skipping cycle");
      return null;
    }
    // enforceMinInterval will wait for _backoffUntil automatically
    log("lpagent", "Rate limited on primary — waiting backoff, then trying backup key...");
  } else {
    // non-429 error on primary
    if (!LPAGENT_BACKUP) {
      log.error("lpagent", "Primary key failed, no backup key — skipping cycle");
      return null;
    }
    log("lpagent", "Primary key failed — trying backup key...");
  }

  // ── Backup key ─────────────────────────────────────────────────
  const backup = await fetchWithKey(walletAddress, LPAGENT_BACKUP);

  if (backup.status === "ok") {
    log("lpagent", "Backup key succeeded");
    return backup.data;
  }

  log.error("lpagent", "Both keys failed — skipping cycle");
  return null;
}
