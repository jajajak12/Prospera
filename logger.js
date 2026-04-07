/**
 * logger.js — Structured logging for Prospera
 *
 * Built on winston + winston-daily-rotate-file.
 *
 * Exports:
 *   log(category, message, ctx?)       — general logging (info level)
 *   log.debug / .warn / .error         — level-specific variants
 *   log.screening / .trade / .position / .confluence / .pnl / .rpc
 *   logAction(action)                  — tool execution audit trail (JSONL)
 *   logSnapshot(snapshot)              — portfolio snapshot (JSONL)
 *
 * Files written to ./logs/:
 *   combined-YYYY-MM-DD.log  — all levels, human-readable
 *   error-YYYY-MM-DD.log     — errors only, JSON (structured for analysis)
 *   actions-YYYY-MM-DD.jsonl — tool execution events
 *   snapshots-YYYY-MM-DD.jsonl — portfolio snapshots
 *
 * Log level override: LOG_LEVEL=debug|info|warn|error (default: info)
 */

import fs from "fs";
import path from "path";
import winston from "winston";
import "winston-daily-rotate-file";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ── Formatters ──────────────────────────────────────────────────────────────

function ctxSuffix(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];
  if (ctx.pair)           parts.push(`pair=${ctx.pair}`);
  if (ctx.pool)           parts.push(`pool=${String(ctx.pool).slice(0, 8)}`);
  if (ctx.position)       parts.push(`pos=${String(ctx.position).slice(0, 8)}`);
  if (ctx.token)          parts.push(`token=${String(ctx.token).slice(0, 8)}`);
  if (ctx.confluenceScore != null) parts.push(`confluence=${ctx.confluenceScore}`);
  if (ctx.pnl != null)    parts.push(`pnl=${ctx.pnl >= 0 ? "+" : ""}${ctx.pnl}%`);
  if (ctx.action)         parts.push(`action=${ctx.action}`);
  if (ctx.reason)         parts.push(`reason=${ctx.reason}`);
  if (ctx.step)           parts.push(`step=${ctx.step}`);
  return parts.length ? ` | ${parts.join(" ")}` : "";
}

// Human-readable line: [TIMESTAMP] [CATEGORY] message | ctx
const humanFormat = winston.format.printf(({ timestamp, category, message, ctx }) => {
  const cat = (category || "info").toUpperCase();
  return `[${timestamp}] [${cat}] ${message}${ctxSuffix(ctx)}`;
});

const consoleFormat = winston.format.combine(
  winston.format.colorize({ level: true }),
  winston.format.printf(({ level, timestamp, category, message, ctx }) => {
    const cat = (category || "info").toUpperCase();
    return `${level} [${timestamp}] [${cat}] ${message}${ctxSuffix(ctx)}`;
  })
);

const timestampFmt = winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" });

// ── Winston instance ─────────────────────────────────────────────────────────

const winstonLogger = winston.createLogger({
  level: LOG_LEVEL,
  transports: [
    // Console — colorized, human-readable
    new winston.transports.Console({
      format: winston.format.combine(timestampFmt, consoleFormat),
    }),

    // combined-YYYY-MM-DD.log — all levels, human-readable (replaces agent-*.log)
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIR, "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      level: LOG_LEVEL,
      format: winston.format.combine(timestampFmt, humanFormat),
    }),

    // error-YYYY-MM-DD.log — errors only, JSON for structured analysis
    new winston.transports.DailyRotateFile({
      filename: path.join(LOG_DIR, "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      level: "error",
      format: winston.format.combine(timestampFmt, winston.format.json()),
    }),
  ],
});

// ── Core log() function ──────────────────────────────────────────────────────

/**
 * Primary log function.
 * @param {string} category  — e.g. "screening", "trade", "management"
 * @param {string} message
 * @param {object} [ctx]     — { pool, position, pair, token, confluenceScore, pnl, action, reason, step }
 */
function log(category, message, ctx = null) {
  const level = category.includes("error") ? "error"
    : category.includes("warn")  ? "warn"
    : "info";

  winstonLogger.log(level, message, { category, ctx });
}

// ── Level shortcuts ──────────────────────────────────────────────────────────

log.debug = (category, message, ctx = null) =>
  winstonLogger.debug(message, { category, ctx });

log.warn = (category, message, ctx = null) =>
  winstonLogger.warn(message, { category: category || "warn", ctx });

log.error = (category, message, ctx = null) =>
  winstonLogger.error(message, { category: category || "error", ctx });

// ── Domain shortcuts ─────────────────────────────────────────────────────────

log.screening  = (message, ctx) => log("screening",  message, ctx);
log.trade      = (message, ctx) => log("trade",      message, ctx);
log.position   = (message, ctx) => log("position",   message, ctx);
log.confluence = (message, ctx) => log("confluence", message, ctx);
log.pnl        = (message, ctx) => log("pnl",        message, ctx);
log.rpc        = (message, ctx) => log("rpc",         message, ctx);
log.management = (message, ctx) => log("management", message, ctx);
log.cron       = (message, ctx) => log("cron",        message, ctx);

// ── logAction ────────────────────────────────────────────────────────────────

function actionHint(action) {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name || a.pool_address?.slice(0, 8)} ${a.amount_y ?? a.amount_sol} SOL`;
    case "close_position":    return ` ${a.position_address?.slice(0, 8)}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${a.position_address?.slice(0, 8)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || a.pool_address?.slice(0, 8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${r?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount} ${a.input_mint?.slice(0, 6)}→SOL`;
    case "update_config":     return ` ${Object.keys(r.applied || {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, ...action };

  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  winstonLogger.info(`[${action.tool}] ${status}${hint}${dur}`, { category: "action" });

  const actionsFile = path.join(LOG_DIR, `actions-${timestamp.split("T")[0]}.jsonl`);
  try {
    fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
  } catch { /* ignore write errors */ }
}

// ── logSnapshot ───────────────────────────────────────────────────────────────

export function logSnapshot(snapshot) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, ...snapshot };

  const snapshotFile = path.join(LOG_DIR, `snapshots-${timestamp.split("T")[0]}.jsonl`);
  try {
    fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
  } catch { /* ignore write errors */ }
}

// ── Export ────────────────────────────────────────────────────────────────────

export { log };
export default log;
