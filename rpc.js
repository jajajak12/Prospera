/**
 * rpc.js — Centralized Solana RPC connection with automatic failover
 *
 * Priority order:
 *   1. RPC_URL env var (primary, skipped if Helius)
 *   2. rpcFallbacks[] in user-config.json (Helius URLs filtered out)
 *
 * Helius is disabled. Any Helius endpoint is silently skipped.
 *
 * On any RPC error (timeout, 429, 5xx, connection refused):
 *   - Switches to next endpoint automatically
 *   - Logs the switch with reason
 *   - Resets back to primary after RESET_AFTER_MS of stability
 */

import { Connection } from "@solana/web3.js";
import fs from "fs";
import { log } from "./logger.js";

const CONFIG_PATH = "./user-config.json";
const RESET_AFTER_MS = 5 * 60_000; // 5 minutes — try primary again after stability

// RPC error patterns that trigger failover
const RPC_ERROR_PATTERNS = [
  "failed to fetch",
  "fetch failed",
  "503",
  "502",
  "429",
  "ECONNREFUSED",
  "ECONNRESET",
  "timeout",
  "timed out",
  "socket hang up",
  "network error",
];

function isRpcError(err) {
  const msg = (err?.message || "").toLowerCase();
  return RPC_ERROR_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

function isHeliusUrl(url) {
  return typeof url === "string" && url.toLowerCase().includes("helius");
}

function maskUrl(url) {
  return url.replace(/api-key=[^&]+/, "api-key=***").slice(0, 60);
}

function loadEndpoints() {
  const endpoints = [];

  // Primary from env — skip if Helius
  if (process.env.RPC_URL && !isHeliusUrl(process.env.RPC_URL)) {
    endpoints.push(process.env.RPC_URL);
  }

  // Fallbacks from user-config — filter out Helius
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (Array.isArray(cfg.rpcFallbacks)) {
        for (const url of cfg.rpcFallbacks) {
          if (!url || isHeliusUrl(url)) continue;
          if (!endpoints.includes(url)) endpoints.push(url);
        }
      }
    }
  } catch { /* ignore */ }

  // Deduplicate and filter empty
  return [...new Set(endpoints.filter(Boolean))];
}

// ─── State ────────────────────────────────────────────────────────

let _endpoints = [];
let _currentIdx = 0;
let _connection = null;
let _lastFailoverAt = 0;
let _lastSuccessAt = Date.now();

function buildConnection(url) {
  return new Connection(url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 30_000,
  });
}

function init() {
  log("rpc", "HELIUS_RPC_DISABLED reason=disabled_by_config");
  _endpoints = loadEndpoints();
  if (_endpoints.length === 0) throw new Error("No non-Helius RPC endpoint configured");
  log("rpc", `RPC_PROVIDER_ORDER=${_endpoints.map(maskUrl).join(" → ")}`);
  _connection = buildConnection(_endpoints[0]);
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Get the current active Connection.
 * Call this fresh each time — do not cache the result.
 */
export function getConnection() {
  if (!_connection) init();

  // Auto-reset to primary after stability period
  if (_currentIdx > 0 && Date.now() - _lastSuccessAt > RESET_AFTER_MS) {
    log("rpc", `Resetting to primary RPC after ${Math.round(RESET_AFTER_MS / 60000)}m stability`);
    _currentIdx = 0;
    _connection = buildConnection(_endpoints[0]);
  }

  return _connection;
}

/**
 * Report a successful RPC call — resets the stability timer.
 */
export function reportRpcSuccess() {
  _lastSuccessAt = Date.now();
}

/**
 * Report an RPC error. If it looks like an infrastructure failure,
 * switches to the next available endpoint.
 *
 * @param {Error} err
 * @returns {boolean} true if switched to a new endpoint
 */
export function reportRpcError(err) {
  if (!isRpcError(err)) return false;

  _endpoints = loadEndpoints(); // reload in case config changed
  if (_endpoints.length <= 1) {
    log("rpc_warn", `RPC error but no fallback configured: ${err.message}`);
    return false;
  }

  const prevUrl = _endpoints[_currentIdx];
  _currentIdx = (_currentIdx + 1) % _endpoints.length;
  const nextUrl = _endpoints[_currentIdx];

  _connection = buildConnection(nextUrl);
  _lastFailoverAt = Date.now();

  log("rpc_warn", `RPC failover: ${prevUrl.slice(0, 35)}... → ${nextUrl.slice(0, 35)}... (${err.message.slice(0, 60)})`);
  return true;
}

/**
 * Wrap an async RPC call with automatic failover retry.
 * Usage: await withRpcFallback(() => sendAndConfirmTransaction(...))
 *
 * Tries current endpoint, then each fallback once.
 */
export async function withRpcFallback(fn, label = "rpc_call") {
  if (!_connection) init();
  const total = Math.max(1, _endpoints.length);

  for (let attempt = 0; attempt < total; attempt++) {
    try {
      // Use _connection directly — avoids getConnection()'s auto-reset to primary,
      // which would undo reportRpcError's endpoint switch on every iteration.
      const result = await fn(_connection);
      reportRpcSuccess();
      return result;
    } catch (err) {
      const switched = reportRpcError(err);
      if (!switched || attempt === total - 1) {
        log("rpc_error", `${label} failed after ${attempt + 1} attempt(s): ${err.message}`);
        throw err;
      }
      log("rpc", `${label} retrying on new endpoint (attempt ${attempt + 2}/${total})`);
    }
  }
}

/**
 * True when active connection is a fallback endpoint (not primary).
 * Fallback RPCs may report stale blockhashes — callers should add buffer.
 */
export function isOnFallback() {
  return _currentIdx > 0;
}

/**
 * Return current RPC status for health/debug.
 */
export function getRpcStatus() {
  const eps = _endpoints.length > 0 ? _endpoints : loadEndpoints();
  return {
    current_index: _currentIdx,
    current_url:   eps[_currentIdx]?.slice(0, 50) ?? "none",
    total_endpoints: eps.length,
    last_failover: _lastFailoverAt ? new Date(_lastFailoverAt).toISOString() : null,
  };
}
