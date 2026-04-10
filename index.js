/**
 * index.js -- MINIMAL VERSION for emergency startup
 * 
 * Stripped to essentials only:
 * - Manual .env parsing (no dotenv)
 * - Cron: screening + management cycles
 * - Telegram polling (non-TTY mode)
 * - Graceful shutdown
 * 
 * NOT included (can be added back later):
 * - REPL interface
 * - Sweep proposal helpers
 * - Morning briefing cron
 * - PnL poll interval
 * - /apply_sweep, /reject_sweep commands
 * - Health server
 */

import "./init.js"; // Load .env FIRST — before any other module

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import cron from "node-cron";

// ── Imports ────────────────────────────────────────────────────────────────────
import { acquireScreeningLock, completeScreeningLock, acquireManagementLock, completeManagementLock } from "./tools/lock-manager.js";
import { agentLoop, probeLLMProviders } from "./agent.js";
import http from "http";
import { log } from "./logger.js";
import { logWithId, logSkip, shortId, logCycleStart } from "./log-utils.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { getCircuitState, shouldSkipNextCycle, getActiveProvider } from "./tools/circuit-breaker.js";
import { evolveThresholds, getPerformanceSummary, getClosedPoolsForBacktest } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, getStateSummary } from "./state.js";
import { recordPositionSnapshot, recallForPool } from "./pool-memory.js";
import { runBacktest } from "./backtest.js";
import { runDailyBacktest } from "./tools/daily-backtester.js";
import { config, computeDeployAmount, getPositionSizing, calculateCurrentExposure, canOpenNewPosition, checkExposureCap } from "./config.js";

// ── Startup validation ─────────────────────────────────────────────────────────
const lpKey     = process.env.LPAGENT_API_KEY;
const lpKeyBackup = process.env.LPAGENT_API_KEY_BACKUP;
if (!lpKey) {
  console.error("FATAL: LPAGENT_API_KEY not set in .env — cannot start");
  process.exit(1);
}
log("startup", `LPAgent: primary=${lpKey ? "YES (len=" + lpKey.length + ")" : "MISSING"} backup=${lpKeyBackup ? "YES (len=" + lpKeyBackup.length + ")" : "MISSING"}`);

// LLM provider probe — called async below in startAgent()

// Also warn if Telegram not configured (non-fatal)
const _tel = telegramEnabled();
log("startup", `Telegram: bot=${_tel ? "ACTIVE" : "DISABLED"} chatId=${process.env.TELEGRAM_CHAT_ID || "MISSING"}`);
if (_tel) {
  sendMessage("✅ Prospera Agent started — LIVE mode").catch(() => {});
}

// ── State ─────────────────────────────────────────────────────────────────────
const _startTime = Date.now();
let _lastCorrelationId = null;

const SCREENING_INTERVAL_MS = (config.schedule?.screeningIntervalMin || 15) * 60_000;
const MANAGEMENT_INTERVAL_MS = (config.schedule?.managementIntervalMin || 3) * 60_000;

let _cronTasks = [];
let _managementBusy = false;
let _managementLastCompleted = 0;
let _screeningBusy = false;
let _screeningLastTriggered = 0;
let _exposureHardPausedUntil = 0;

const timers = { managementLastRun: 0, screeningLastRun: 0 };

// ── Shared state for dashboard ─────────────────────────────────────────────────
let _lastScreeningReport = null; // { discovered, afterVolume, meteoraPools, fibPassed, candidates, content }
let _closedPoolsHistory = [];    // [{pair, pnl_pct, closedAt}]

/**
 * Serve static files from public/ folder — used for /dashboard route.
 * Serves index.html + app.js as-is (no injection needed, Vite env vars handle config).
 */
function SERVE_DASHBOARD_HTML() {
  try {
    let html = fs.readFileSync(path.join(__dirname, "public", "dashboard", "index.html"), "utf8");
    const baseUrl = (config.dashboard?.baseUrl || '').replace(/\/$/, '') || `http://localhost:${_healthPort || 3000}`;
    const apiKey  = config.dashboard?.apiKey || '';
    // Inject API base URL into meta tag so app.js can read it
    html = html.replace(
      '<meta name="prospera-api-base" content="" />',
      `<meta name="prospera-api-base" content="${escHtml(baseUrl)}" />`
    ).replace(
      '<meta name="prospera-api-key" content="" />',
      apiKey ? `<meta name="prospera-api-key" content="${escHtml(apiKey)}" />` : ''
    );
    return html;
  } catch {
    return "<html><body style='background:#0f1117;color:#e2e8f0;font-family:system-ui;padding:40px'><h1>Dashboard not found</h1><p>public/dashboard/index.html missing.</p></body></html>";
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/**
 * Build rich health data for dashboard /health-data endpoint.
 */
async function getHealthDataForDashboard(cb) {
  // Use force:false so dashboard polling respects the 5-min cache TTL.
  // Dashboard refreshes every ~15s but gets cached data — zero LPAgent API calls.
  const positions = await getMyPositions({ force: false }).catch(() => null);
  const balance   = await getWalletBalances().catch(() => null);
  const posList   = positions?.positions ?? [];
  const deployedSol = posList.length > 0 ? calculateCurrentExposure(posList) : 0;
  const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;
  const pnlToday   = posList.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);

  // Parse LLM zone count from last mgmt report
  const state = getStateSummary ? getStateSummary() : {};
  const lastBriefing = getLastBriefingDate ? getLastBriefingDate() : null;

  return {
    status: "ok",
    uptime: Math.round(process.uptime()),
    activeProvider: getActiveProvider(), // dynamic from circuit-breaker
    totalPositions: positions?.total_positions ?? 0,
    maxPositions: config.risk.maxPositions,
    deployedSol: deployedSol > 0 ? deployedSol.toFixed(4) : 0,
    exposurePct,
    solBalance: balance?.sol ?? 0,
    solPrice: balance?.sol_price ?? 0,
    pnlToday,
    llmZone: _lastLlmZoneCount ?? 0,
    lastScreening: timers.screeningLastRun ? new Date(timers.screeningLastRun).toISOString() : null,
    lastManagement: timers.managementLastRun ? new Date(timers.managementLastRun).toISOString() : null,
    lastBriefing: lastBriefing || null,
    briefingDate: lastBriefing || "",
    circuitState: cb,
    positions: posList.map(p => ({
      pair: p.pair ?? p.name ?? "?",
      pnl_pct: p.pnl_pct ?? 0,
      in_range: p.in_range ?? false,
      minutes_out_of_range: p.minutes_out_of_range ?? 0,
      unclaimed_fees_usd: p.unclaimed_fees_usd ?? 0,
      total_value_usd: p.total_value_usd ?? 0,
      action: p.action ?? "STAY",
    })),
    lastScreeningReport: _lastScreeningReport || {},
    closedHistory: _closedPoolsHistory.slice(-10),
    deterministicCount: (() => {
      const posList = positions?.positions ?? [];
      return posList.filter(p => {
        const act = p.action ?? "STAY";
        return act === "CLOSE" || act === "CLAIM";
      }).length;
    })(),
    pnlHistory: _pnlHistory.slice(),
    pnlStats: (() => {
      const wins = _closedPoolsHistory.filter(p => p.pnl_pct > 0).length;
      const total = _closedPoolsHistory.length;
      const winRate = total > 0 ? +((wins / total) * 100).toFixed(1) : null;
      const totalPnl = _closedPoolsHistory.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
      const allPnl = _closedPoolsHistory.map(p => p.pnl_pct ?? 0);
      let maxDrawdown = 0;
      let peak = 0;
      for (const pnl of allPnl) {
        peak = Math.max(peak, pnl);
        maxDrawdown = Math.min(maxDrawdown, pnl - peak);
      }
      return { winRate, totalPnl: totalPnl.toFixed(2), maxDrawdown: maxDrawdown.toFixed(2), totalClosed: total };
    })(),
    dashboard: {
      baseUrl: config.dashboard.baseUrl,
      apiKey: config.dashboard.apiKey || null,
      refreshIntervalSec: config.dashboard.refreshIntervalSec,
    },
  };
}

// Ring buffer of recent log lines (max 200) for dashboard
const _logRing = [];
const _maxLogRing = 200;

// PnL history ring buffer for dashboard charts
const _pnlHistory = [];
const _maxPnlHistory = 100; // ~1 per hour for 4 days

function _ringLog(category, message) {
  _logRing.push({
    ts: new Date().toISOString(),
    cat: category,
    msg: message,
  });
  if (_logRing.length > _maxLogRing) _logRing.shift();
}

function getRecentLogs(n = 50) {
  return _logRing.slice(-n);
}

// Called by management cycle to update LLM zone count for dashboard
let _lastLlmZoneCount = 0;

const POSITION_META_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "position-meta.json");

// ── Health Server ──────────────────────────────────────────────────────────────
let _healthServer = null;
let _healthPort = 3000;

function startHealthServer(port = 3000) {
  _healthPort = port;
  if (_healthServer) return;
  _healthServer = http.createServer((req, res) => {
    const cb = getCircuitState();

    if (req.url === "/health") {
      getHealthDataForDashboard(cb).then(data => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      }).catch(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failed" }));
      });
      return;
    }

    // Alias: /health-data → /health (same data, no duplication needed)
    if (req.url === "/health-data") {
      req.url = "/health";
    }

    if (req.url === "/health") {
      getHealthDataForDashboard(cb).then(data => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      }).catch(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failed" }));
      });
      return;
    }

    if (req.url === "/health-logs") {
      const recent = getRecentLogs(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: recent }));
      return;
    }

    // ── Public consolidated dashboard API ──────────────────────────────────────
    // Used by remote/static dashboard instances (Vercel, Grok, etc.)
    if (req.url === "/api/dashboard") {
      // Optional API key check via ?key= or Authorization header
      const url = new URL(req.url, "http://localhost");
      const providedKey = url.searchParams.get("key") || req.headers["x-api-key"] || null;
      if (config.dashboard.apiKey && providedKey !== config.dashboard.apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      getHealthDataForDashboard(cb).then(data => {
        data.logs = getRecentLogs(50);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      }).catch(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failed" }));
      });
      return;
    }

    if (req.url === "/" || req.url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SERVE_DASHBOARD_HTML());
      return;
    }

    // Serve app.js from public/dashboard/ — both paths work
    if (req.url === "/dashboard/app.js" || req.url === "/app.js") {
      try {
        const js = fs.readFileSync(path.join(__dirname, "public", "dashboard", "app.js"), "utf8");
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(js);
      } catch {
        res.writeHead(404); res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
  _healthServer.listen(port, () => log("health", `Health server listening on port ${port}`));
  _healthServer.on("error", e => log("health", `Health server error: ${e.message}`));
}

function stopHealthServer() {
  if (_healthServer) { _healthServer.close(); _healthServer = null; }
}

// ── REPL Mode — disabled in PM2 (always non-TTY), kept for potential future use ──
// REPL consumed ~50KB of readline machinery for zero practical use in PM2 mode.
// To re-enable: uncomment the block below and remove the stub.
// function startREPL() { ... }
// STUB: no REPL in PM2 — delete this stub if re-enabling.
function startREPL() {
  log("startup", "REPL disabled — PM2 always runs non-TTY. Run manually with: node --input-type=module");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stopCronJobs() {
  for (const task of _cronTasks) task?.stop?.();
  _cronTasks = [];
}

// ── Morning Briefing ─────────────────────────────────────────────────────────
async function runMorningBriefing({ force = false } = {}) {
  log("briefing", "Morning Briefing triggered");
  const today = new Date().toISOString().slice(0, 10);
  if (!force && getLastBriefingDate() === today) return; // already briefed today

  const corrId = shortId();
  const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

  // Positions + PnL
  const positions = await getMyPositions({ force: true }).catch(() => null);
  const posList = positions?.positions ?? [];
  const totalPositions = positions?.total_positions ?? 0;

  // Balance + exposure
  const balance = await getWalletBalances().catch(() => null);
  const deployedSol = posList.length > 0 ? calculateCurrentExposure(posList) : 0;
  const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;

  // Circuit state
  const cb = getCircuitState();

  // Backtest results from today
  let backtestSummary = null;
  try {
    const backtestDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backtest");
    for (const label of ["7d", "14d"]) {
      const file = path.join(backtestDir, `${today}_${label}.json`);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const winRate = data.results?.length > 0
          ? ((data.results.filter(r => (r.pnl_pct ?? 0) > 0).length / data.results.length) * 100).toFixed(0)
          : "N/A";
        backtestSummary = `${label}: ${data.results?.length ?? 0} pools | WR: ${winRate}%`;
        break; // show 7d first
      }
    }
  } catch { /**/ }

  // Build lines
  const lines = [
    `📊 Open Positions: ${totalPositions}`,
    `💰 Exposure: ${exposurePct}% | SOL: ${balance?.sol?.toFixed(3) ?? "?"}`,
  ];

  if (cb?.isCircuitBroken) {
    lines.push(`🔧 Circuit: OPEN (${cb.cooldownRemainingSec}s left)`);
  }

  if (backtestSummary) {
    lines.push(`📈 Backtest: ${backtestSummary}`);
  }

  if (posList.length > 0) {
    const totalPnl = posList.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
    lines.push(`📉 Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`);

    // Per-position breakdown
    const posLines = posList.map(p => {
      const pnl = p.pnl_pct ?? 0;
      const sign = pnl >= 0 ? "+" : "";
      const status = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
      return `${p.pair} ${sign}${pnl.toFixed(1)}% (${status})`;
    });
    lines.push(`📋 ${posLines.join(" | ")}`);
  }

  const msg = `🌅 Morning Briefing [${ts}]\n\n${lines.join("\n")}`;
  if (telegramEnabled()) sendMessage(msg).catch(() => {});

  setLastBriefingDate();
  log("briefing", `Morning briefing sent — positions: ${totalPositions}, exposure: ${exposurePct}%`);
}

// ── PnL Poll ──────────────────────────────────────────────────────────────────
async function runPnLPoll() {
  const corrId = shortId();
  const positions = await getMyPositions({ force: true }).catch(() => null);
  const posList = positions?.positions ?? [];

  // Guard: no positions → skip
  if (posList.length === 0) {
    log("pnl_poll", "No open positions — skipping poll");
    return;
  }

  const balance = await getWalletBalances().catch(() => null);
  const deployedSol = calculateCurrentExposure(posList);
  const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;
  const totalPnl = posList.reduce((s, p) => s + (p.pnl_pct ?? 0), 0);
  const totalValue = posList.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);

  const lines = [
    `📊 Positions: ${positions?.total_positions ?? 0}/${config.risk.maxPositions}`,
    `💰 Exposure: ${exposurePct}% | SOL: ${balance?.sol?.toFixed(3) ?? "?"}`,
    `📉 Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%`,
  ];
  if (posList.length > 0) lines.push(`💵 TVL: $${totalValue.toFixed(0)}`);

  const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  if (telegramEnabled()) sendMessage(`📈 PnL Poll [${ts}] ID: ${corrId}\n\n${lines.join("\n")}`).catch(() => {});
  log("pnl_poll", `PnL poll — positions: ${positions?.total_positions ?? 0}, exposure: ${exposurePct}%, pnl: ${totalPnl.toFixed(2)}%`);

  // Record to pnlHistory ring buffer for dashboard
  _pnlHistory.push({ ts: new Date().toISOString(), totalPnl, exposurePct, positionCount: posList.length });
  if (_pnlHistory.length > _maxPnlHistory) _pnlHistory.shift();
}

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── Management Cycle ───────────────────────────────────────────────────────────
export async function runManagementCycle({ silent = false } = {}) {
  if (shouldSkipNextCycle()) {
    log("management", "Circuit breaker skip — cycle skipped (auto-clears when cooldown expires)");
    return null;
  }

  const corrId = logCycleStart("management");
  _lastCorrelationId = corrId;
  const _m = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  if (_managementBusy) { _m("management", "Cycle busy — skipped"); return null; }
  if (_screeningBusy) { _m("management", "Screening running — skipped"); return null; }

  // ── Fast path: cek posisi dulu sebelum acquire lock / busy flag ─────────────
  // Jika 0 posisi → skip secepat mungkin, tidak perlu lock, tidak perlu LPAgent call
  // Pisahkan error handling per call — getMyPositions error = skip cycle,
  // getWalletBalances error = lanjut dengan preBalance=null (exposure tampil "?")
  let prePositions = null;
  let preBalance = null;
  try {
    prePositions = await getMyPositions({ force: true });
  } catch (e) {
    _m("warn", `getMyPositions failed — ${e.message} — skipping cycle`, { correlationId: corrId });
    logSkip("lpagent_error", { error: e.message }, corrId, "management");
    if (!silent && telegramEnabled()) sendMessage(`Management [${corrId}] — LPAgent error: ${e.message}, skipping`).catch(() => {});
    return null;
  }
  try {
    preBalance = await getWalletBalances();
  } catch (e) {
    _m("warn", `getWalletBalances failed — ${e.message} — continuing with preBalance=null`);
    // Non-fatal: cycle can still run, exposure will show "?" in report
  }

  if (!prePositions || prePositions.error) {
    _m("warn", `LPAgent unavailable — ${prePositions?.error ?? "network error"} — skipping cycle`);
    logSkip("lpagent_unavailable", { error: prePositions?.error ?? "network_error" }, corrId, "management");
    if (!silent && telegramEnabled()) sendMessage(`Management [${corrId}] — LPAgent unavailable, skipping`).catch(() => {});
    return null;
  }

  const preCount = prePositions?.positions?.length ?? 0;
  if (preCount === 0) {
    _m("management", "No open positions — skipping management cycle");
    logSkip("no_open_positions", {}, corrId, "management");
    return null;
  }

  // ── Has positions → acquire lock and run full management ───────────────────
  const lockResult = acquireManagementLock();
  if (!lockResult.acquired) { _m("management", "Lock not acquired"); return null; }
  let lockAcquired = true;

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  _m("management", `Starting cycle`, { openPositions: preCount });

  let mgmtReport = null;
  let positions = prePositions.positions ?? [];

  try {
    if (positions.length === 0) {
      if (Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
        _m("management", "No positions — triggering screening");
        runScreeningCycle().catch(e => _m("error", `Screening failed: ${e.message}`));
      }
      mgmtReport = "No open positions — cycle skipped";
      return null;
    }

    const positionData = positions.map(p => ({ ...p, recall: recallForPool(p.pool) }));

    const exitMap = new Map();
    for (const p of positionData) {
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) exitMap.set(p.position, exit.reason);
    }

    // positionMeta.json written by executor.js after deploy (ATH bin tracking)
    // RESERVED for future OOR/ATH recovery logic — loaded only when needed, not every cycle
    // let positionMeta = {};
    // try { if (fs.existsSync(POSITION_META_PATH)) positionMeta = JSON.parse(fs.readFileSync(POSITION_META_PATH, "utf8")); } catch { /**/ }
    // if (Object.keys(positionMeta).length > 0) {
    //   _m("management", `positionMeta loaded: ${Object.keys(positionMeta).length} entries (reserved for future ATH recovery logic)`);
    // }

    // ── LLM zone & report vars — init before try so finally always has defined value ──
    let llmZone = [];
    let mgmtReport = "";

    const actionMap = new Map();
    for (const p of positionData) {
      if (exitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", reason: exitMap.get(p.position) }); continue; }
      if (p.instruction) { actionMap.set(p.position, { action: "INSTRUCTION" }); continue; }
      if (p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct) { actionMap.set(p.position, { action: "CLOSE", reason: "stop loss" }); continue; }
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) { actionMap.set(p.position, { action: "CLAIM" }); continue; }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Deterministic actions: execute immediately without LLM ──────────────────
    const deterministic = positionData.filter(p => {
      const act = actionMap.get(p.position);
      return act.action === "CLOSE" || act.action === "CLAIM";
    });
    for (const p of deterministic) {
      const act = actionMap.get(p.position);
      _m("management", `EXEC deterministic ${act.action} ${p.pair} (${act.reason})`);
      if (act.action === "CLOSE") {
        const r = await closePosition({ position_address: p.position }).catch(e => ({ success: false, error: e.message }));
        if (r.success) {
          _m("management", `  → closed ${p.pair}`);
          _closedPoolsHistory.push({ pair: p.pair, pnl_pct: p.pnl_pct ?? 0, closedAt: new Date().toISOString() });
          if (_closedPoolsHistory.length > 50) _closedPoolsHistory.shift();
        } else _m("error", `  → close failed: ${r.error}`);
      } else if (act.action === "CLAIM") {
        const { executeTool } = await import("./tools/executor.js");
        const r = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ success: false, error: e.message }));
        if (r?.success) _m("management", `  → fees claimed ${p.pair}`); else _m("error", `  → claim failed: ${r?.error}`);
      }
    }

    // ── LLM Zone: positions needing judgment ───────────────────────────────────
    // Includes:
    //   - PnL 5%–25%, in range, no deterministic exit (core judgment zone)
    //   - PnL null/0–5% AND OOR (blind spot — needs monitoring, no automatic close)
    //   - PnL null/0–5% AND in-range but close to stop loss boundary (risk judgment)
    llmZone = positionData.filter(p => {
      const act = actionMap.get(p.position);
      if (act.action !== "STAY") return false;
      const pnl = p.pnl_pct ?? 0;
      // Core LLM zone: PnL 5%–25% and in range
      if (pnl >= 5 && pnl <= 25 && p.in_range) return true;
      // Expanded zone: PnL null/0–5% and OOR — needs monitoring, not auto-close
      if (pnl < 5 && !p.in_range) {
        _m("management", `LLM blind-spot: ${p.pair} PnL ${pnl.toFixed(2)}% OOR ${p.minutes_out_of_range ?? 0}m — added to LLM zone`);
        return true;
      }
      // Expanded zone: PnL null/0–5% and near stop loss boundary
      if (pnl < 5 && p.in_range && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct + 3) {
        _m("management", `LLM blind-spot: ${p.pair} PnL ${pnl.toFixed(2)}% near stop loss boundary — added to LLM zone`);
        return true;
      }
      return false;
    });

    if (llmZone.length > 0) {
      _m("management", `LLM zone: ${llmZone.length} position(s) for judgment`);
    }

    const reportLines = positionData.map(p => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
      const pnl = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "?%";
      const deterministicTag = (act.action === "CLOSE" || act.action === "CLAIM") ? `[${act.action}:${act.reason}]` : "";
      return `${p.pair} | PnL: ${pnl} | ${inRange} | ${act.action}${deterministicTag}`;
    });

    // Compute total exposure percentage
    const deployedSol = calculateCurrentExposure(positions);
    const exposurePct = preBalance?.sol > 0 ? +((deployedSol / preBalance.sol) * 100).toFixed(1) : 0;

    mgmtReport = `Positions: ${positionData.length} | Total Exposure: ${exposurePct}% | LLM zone: ${llmZone.length}\n\n${reportLines.join("\n")}`;

    if (llmZone.length > 0) {
      const allBlocks = llmZone.map(p => {
        const act = actionMap.get(p.position);
        return `POSITION: ${p.pair}\n  pnl: ${p.pnl_pct}% | fees: $${p.unclaimed_fees_usd} | in_range: ${p.in_range}`;
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT REVIEW — ${llmZone.length} position(s) need LLM judgment
${allBlocks}
RULES: MANDATORY close/claim execute immediately. EVALUATE use judgment.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 512, corrId);

      mgmtReport += `\n\n${content}`;
    }

    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > SCREENING_INTERVAL_MS) {
      runScreeningCycle().catch(e => _m("error", `Screening failed: ${e.message}`));
    }

  } catch (error) {
    _m("error", `Management failed: ${error.message}`);
    mgmtReport = `Failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    _managementLastCompleted = Date.now();
    _lastLlmZoneCount = llmZone.length;
    if (lockAcquired) completeManagementLock();
    if (!silent && telegramEnabled() && mgmtReport) {
      const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
      sendMessage(`🔄 Management Cycle [${ts}] ID: ${corrId}\n${stripThink(mgmtReport)}`).catch(() => {});
    }
  }
  return mgmtReport;
}

// ── Screening Cycle ────────────────────────────────────────────────────────────
export async function runScreeningCycle({ silent = false } = {}) {
  if (shouldSkipNextCycle()) {
    log("screening", "Circuit breaker skip — cycle skipped (auto-clears when cooldown expires)");
    return null;
  }

  const corrId = logCycleStart("screening");
  _lastCorrelationId = corrId;
  const _s = (cat, msg, meta = {}) => logWithId(cat, msg, meta, corrId);

  if (_screeningBusy) { log("cron", "Screening skipped — busy"); return null; }

  if (_exposureHardPausedUntil > Date.now()) {
    _s("screening", `HARD CAP pause active`);
    return null;
  }

  const lockResult = acquireScreeningLock();
  if (!lockResult.acquired) { _s("screening", `Lock not acquired`); return null; }

  _screeningBusy = true;
  _screeningLastTriggered = Date.now();
  timers.screeningLastRun = Date.now();

  // _release defined at function scope so both pre-check and main body share it
  const _release = () => {
    completeScreeningLock();
    _screeningBusy = false;
    _s("screening", "Screening lock released");
  };

  // Outer try/finally guarantees _release() even if pre-screening logic throws unexpectedly
  try {

  let prePositions = null, preBalance = null, deployAmount;

  // Separate try/catch per call — getMyPositions error = skip cycle, getWalletBalances error = continue
  try {
    prePositions = await getMyPositions({ force: true });
  } catch (e) {
    _s("error", `getMyPositions failed — ${e.message} — skipping cycle`);
    if (telegramEnabled()) sendMessage(`Screening [${corrId}] — LPAgent error: ${e.message}, skipping cycle`).catch(() => {});
    _release(); return null;
  }
  try {
    preBalance = await getWalletBalances();
  } catch (e) {
    _s("warn", `getWalletBalances failed — ${e.message} — continuing with preBalance=null`);
    preBalance = preBalance ?? { sol: 0, sol_price: 0 };
  }

  if (prePositions.total_positions >= config.risk.maxPositions) { logSkip("max_positions", {}, corrId); _release(); return null; }
  deployAmount = getPositionSizing(preBalance.sol);
  if (deployAmount === 0) { logSkip("insufficient_balance", {}, corrId); _release(); return null; }

  const currentExposure = calculateCurrentExposure(prePositions.positions);
  const cap = checkExposureCap(currentExposure, preBalance.sol, deployAmount);
  if (cap.level === "hard_pause") {
    _exposureHardPausedUntil = cap.pauseUntil;
    _s("error", "HARD CAP TRIGGERED");
    if (telegramEnabled()) sendMessage(`🔍 Fibonacci Screening — HARD CAP ${cap.exposurePct.toFixed(1)}% TRIGGERED`).catch(() => {});
    _release(); return null;
  }
  if (cap.level === "warning") {
    _s("warn", `Exposure warning: ${cap.exposurePct.toFixed(1)}%`);
    if (telegramEnabled()) sendMessage(`⚠️ Exposure warning: ${cap.exposurePct.toFixed(1)}% (max ${cap.hardCapPct.toFixed(1)}%)`).catch(() => {});
  }

  _s("screening", `Starting cycle | deploy: ${deployAmount} SOL | wallet: ${preBalance.sol} SOL`);

  let screenReport = null;
  let stats = { discovered: 0, afterVolume: 0, meteoraPools: 0, fibPassed: 0 };
  let freshCandidates = [];

  try {
    const topResult = await getTopCandidates({ limit: 20, correlationId: corrId }).catch(() => null);
    const candidates = topResult?.candidates || [];
    stats = {
      discovered: topResult?.total_screened ?? 0,
      afterVolume: topResult?.after_volume_count ?? 0,
      meteoraPools: topResult?.withPool_count ?? 0,
      fibPassed: topResult?.fib_passed ?? 0,
    };

    if (candidates.length === 0) {
      // Build skip reason from available stats
      const reason = stats.afterVolume === 0 ? "no pools after volume filter" :
        stats.fibPassed === 0 ? "failed Fib 0.500" :
        "failed EMA/RSI confluence";
      screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\nNo entry signals (${reason})`;
      // fall through to finally → _release() + Telegram send
    } else {
      const PENDING_ATH_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "screening-pending.json");
      const activeBinResults = await Promise.allSettled(candidates.map(p => getActiveBin({ pool_address: p.pool })));

      // ── Freshness check: drop candidates where price crashed >50% since pool discovery ──
      // activeBin.price and pool.price are both SOL-denominated (Meteora pool_price)
      freshCandidates = [];
      const freshActiveBinResults = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const activeBinData = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value : null;
        const poolPriceAtDiscovery = c.price ?? null;
        const activeBinPrice = activeBinData?.price ?? null;
        if (poolPriceAtDiscovery && activeBinPrice && activeBinPrice < poolPriceAtDiscovery * 0.5) {
          const dropPct = ((1 - activeBinPrice / poolPriceAtDiscovery) * 100).toFixed(0);
          _s("screening", `  ${c.name}: STALE — price dropped ${dropPct}% since pool discovery, skipping`);
          continue;
        }
        freshCandidates.push(c);
        freshActiveBinResults.push(activeBinResults[i]);
      }

      if (freshCandidates.length === 0 && candidates.length > 0) {
        screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\n→ ${candidates.length} candidate(s) passed Fib but all STALE (price crashed since screening)`;
        // fall through to finally → _release() + Telegram send
      } else {
        try {
          const pending = {};
          for (let i = 0; i < freshCandidates.length; i++) {
            const c = freshCandidates[i];
            const fib = c.fib_signal;
            const ath = fib?.ath ?? fib?.fibLevels?.swingHigh ?? null;
            const entryPrice = fib?.currentPrice ?? c.price ?? null;
            const activeBin = freshActiveBinResults[i]?.status === "fulfilled" ? freshActiveBinResults[i].value?.binId : null;
            if (c.pool && ath && entryPrice && activeBin != null) {
              pending[c.pool] = { ath, entryPrice, binStep: c.bin_step ?? null, activeBinAtScreening: activeBin, fib500: fib?.fibLevels?.fib500 ?? null };
            }
          }
          fs.writeFileSync(PENDING_ATH_PATH, JSON.stringify(pending));
        } catch { /**/ }

        const candidateBlocks = freshCandidates.map((pool, i) => {
          const fib = pool.fib_signal;
          const activeBin = freshActiveBinResults[i]?.status === "fulfilled" ? freshActiveBinResults[i].value?.binId : null;
          const fib500 = fib?.fibLevels?.fib500 != null ? `$${fib?.fibLevels?.fib500.toPrecision(4)}` : "n/a";
          const fib382 = fib?.fibLevels?.fib382 != null ? `$${fib?.fibLevels?.fib382.toPrecision(4)}` : "n/a";
          const screenPrice = fib?.currentPrice != null ? `$${fib?.currentPrice.toPrecision(4)}` : "n/a";
          const conf = fib?.confluenceScore != null ? fib.confluenceScore.toFixed(2) : "n/a";
          return `POOL: ${pool.name} (${pool.pool})\n  metrics: bin_step=${pool.bin_step}, fee=${pool.fee_pct}%, tvl=$${pool.active_tvl}\n  fib: signal=${fib?.signal} conf=${conf} binsBelow=${fib?.binsBelow} binsAbove=${fib?.binsAbove ?? 0}\n  fib_levels: fib500=${fib500} fib382=${fib382} screenPrice=${screenPrice}\n  active_bin: ${activeBin}`;
        }).join("\n\n");

        const { content } = await agentLoop(`
FIBONACCI SCREENING CYCLE
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CANDIDATES (Fibonacci-confirmed):
${candidateBlocks}

RULES:
1. Pick highest confluenceScore pool with good metrics.
2. bins_below and bins_above from fib_signal (chart.js output). In ATH zone bins_above is NEGATIVE — pass it AS-IS (do NOT zero it out).
3. strategy=bid_ask. amount_y=${deployAmount} SOL.
    `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, corrId);

        screenReport = `Discovered: ${stats.discovered} | After volume: ${stats.afterVolume} | Meteora pools: ${stats.meteoraPools}\n\n→ ${freshCandidates.length} candidate(s) passed Fib + RSI + EMA\n\n${content}`;
      }
    }
  } catch (error) {
    _s("error", `Screening main loop failed: ${error.message}`);
    screenReport = `Failed: ${error.message}`;
  } finally {
    _release();
    _lastScreeningReport = {
      discovered: stats.discovered,
      afterVolume: stats.afterVolume,
      meteoraPools: stats.meteoraPools,
      fibPassed: stats.fibPassed,
      candidates: freshCandidates.map(c => ({
        name: c.name,
        symbol: c.symbol,
        pool: c.pool,
        price: c.price,
        volume_1h: c.volume_1h,
        market_cap: c.market_cap,
        tvl: c.active_tvl,
        signal: c.fib_signal?.signal,
        confluence: c.fib_signal?.confluenceScore,
        binsBelow: c.fib_signal?.binsBelow,
        binsAbove: c.fib_signal?.binsAbove ?? 0,
      })),
      content: screenReport,
    };
    if (!silent && telegramEnabled() && screenReport) {
      const ts = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
      sendMessage(`🔍 Fibonacci Screening [${ts}] ID: ${corrId}\n${stripThink(screenReport)}`).catch(() => {});
    }
  }
  return screenReport;

  } catch (outerErr) {
    // Outer safety net — ensures _screeningBusy is always released even if pre-screening throws
    _s("error", `Screening outer catch: ${outerErr.message} — releasing lock`);
    _release();
    return null;
  }
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy || _screeningBusy) return;
    const lockAge = Date.now() - _managementLastCompleted;
    if (lockAge < 45_000) return;
    await runManagementCycle({ silent: true });
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, () => {
    runScreeningCycle().catch(e => log("cron_error", `Screening cron failed: ${e.message}`));
  });

  const backtestTask = cron.schedule("0 0 * * *", () => {
    // Skip backtest if circuit is broken (LLM likely down) — backtest needs LLM to analyze pools
    const cb = getCircuitState();
    if (cb?.isCircuitBroken) {
      log("cron", "Daily backtest SKIPPED — circuit broken (LLM likely unavailable)");
      return;
    }
    const corrId = shortId();
    runDailyBacktest({ correlationId: corrId, hours: 336 }).catch(e => log("cron_error", `Daily backtest failed: ${e.message}`));
  });

  const briefingTask = cron.schedule("0 9 * * *", () => {
    runMorningBriefing().catch(e => log("cron_error", `Morning briefing failed: ${e.message}`));
  });

  const pollTask = cron.schedule("*/30 * * * *", () => {
    runPnLPoll().catch(e => log("cron_error", `PnL poll failed: ${e.message}`));
  });

  _cronTasks = [mgmtTask, screenTask, backtestTask, briefingTask, pollTask];
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m, Morning Briefing 09:00, Daily Backtest 00:00`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  const corrId = _lastCorrelationId || "none";
  const cb = getCircuitState();
  log("shutdown", `[${corrId}] Shutdown: ${signal}`, {
    signal, isCircuitBroken: cb.isCircuitBroken,
    fallbackProvider: cb.isFallbackActive ? "openrouter" : "minimax",
  });
  stopPolling();
  stopHealthServer();
  const positions = await getMyPositions().catch(() => ({}));
  log("shutdown", `[${corrId}] Open positions: ${positions.total_positions ?? "?"}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Telegram Handler (non-TTY / PM2 mode) ─────────────────────────────────────
let busy = false;

async function handleTelegram(text) {
  if (busy) { sendMessage("Agent busy, try again shortly.").catch(() => {}); return; }
  busy = true;
  try {
    if (text === "/positions") {
      const { positions, total_positions } = await getMyPositions({ force: true }).catch(() => ({ positions: [], total_positions: 0 }));
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const lines = positions.map((p, i) => `${i+1}. ${p.pair} | $${p.total_value_usd} | PnL: ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct}%`);
      await sendMessage(`Open Positions (${total_positions}):\n${lines.join("\n")}`);
      return;
    }
    if (text === "/briefing") {
      await sendMessage("Running morning briefing...");
      await runMorningBriefing({ force: true }).catch(e => sendMessage(`Briefing error: ${e.message}`));
      return;
    }
    if (text === "/screening") {
      await sendMessage("Running screening cycle...");
      await runScreeningCycle({ silent: false }).catch(e => sendMessage(`Screening error: ${e.message}`));
      return;
    }
    if (text === "/management") {
      await sendMessage("Running management cycle...");
      await runManagementCycle({ silent: false }).catch(e => sendMessage(`Management error: ${e.message}`));
      return;
    }
    if (text.startsWith("/backtest")) {
      const label = text.includes("14d") ? "14d" : "7d";
      await sendMessage(`Running ${label} backtest...`);
      const corrId = shortId();
      const result = await runDailyBacktest({ correlationId: corrId, hours: label === "14d" ? 336 : 168 }).catch(e => null);
      if (result && !result.skipped) {
        const sum = label === "14d" ? result.s14 : result.s7;
        const wr = sum?.avgBacktestWinRate != null ? `${sum.avgBacktestWinRate}%` : "N/A";
        const pools = sum?.poolsAnalyzed ?? 0;
        await sendMessage(`${label} backtest: ${pools} pools | WR: ${wr}`);
      } else {
        await sendMessage(`No ${label} backtest data available.`);
      }
      return;
    }
    if (text === "/help") {
      await sendMessage(`Prospera Commands:\n/positions — list open positions\n/status — agent status overview\n/briefing — trigger morning briefing\n/backtest — run 7d backtest\n/backtest 14d — run 14d backtest\n/close <N> — close position N\n/screening — trigger screening cycle
/management — trigger management cycle
/help — show this message`);
      return;
    }
    if (text === "/status") {
      const cb = getCircuitState();
      const { getActiveProvider } = await import("./tools/circuit-breaker.js");
      const activeProvider = getActiveProvider();
      const positions = await getMyPositions({ force: true }).catch(() => null);
      const balance = await getWalletBalances().catch(() => null);
      const deployedSol = (positions?.positions?.length ?? 0) > 0 ? calculateCurrentExposure(positions.positions) : 0;
      const exposurePct = balance?.sol > 0 ? +((deployedSol / balance.sol) * 100).toFixed(1) : 0;
      const lastScreen = timers.screeningLastRun ? new Date(timers.screeningLastRun).toLocaleString("id-ID") : "never";
      const lastMgmt = timers.managementLastRun ? new Date(timers.managementLastRun).toLocaleString("id-ID") : "never";
      const uptime = Math.round(process.uptime() / 60);
      await sendMessage(`Prospera Status\n\nMode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}\nUptime: ${uptime}m\nProvider: ${activeProvider}\nCircuit: ${cb?.isCircuitBroken ? "OPEN (fallback)" : "OK (primary)"}\nLast Screening: ${lastScreen}\nLast Management: ${lastMgmt}\nOpen Positions: ${positions?.total_positions ?? 0}/${config.risk.maxPositions}\nExposure: ${exposurePct}%\nSOL Balance: ${balance?.sol?.toFixed(3) ?? "?"}`);
      return;
    }
    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true }).catch(() => ({ positions: [] }));
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      await sendMessage(result.success ? `Closed ${pos.pair}` : `Close failed: ${JSON.stringify(result)}`);
      return;
    }
    // ── Free-flow conversation with safety guard ──────────────────────────────

    // ── Token-specific questions: answer from data, not LLM hallucination ─────
    // Detect SOL mint addresses (base58, ~44 chars) or pump.fun-style (~9-12 chars)
    const mintPattern = /([1-9A-HJ-NP-Za-kmnp-z]{32,46})/g;
    const mints = (text.match(mintPattern) || []).filter(m => m.length > 20);

    if (mints.length > 0 && /(\?)|(kenapa)|(status)|(Tidak)|(skip)|(gagal)|(masuk)|(screening)|(volume)|(mcap)|(price)/i.test(text)) {
      // Fetch Dexscreener data for this token
      const mint = mints[0];
      try {
        const s = config.screening;
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) { await sendMessage(`Tidak bisa fetch data untuk token ini.`); return; }
        const data = await res.json();
        const pairs = (Array.isArray(data) ? data : []).filter(p => p.chainId === "solana" && (p.quoteToken?.address === "So11111111111111111111111111111111111111112" || p.quoteToken?.symbol === "SOL"));
        if (pairs.length === 0) { await sendMessage(`Token tidak punya pool SOL — tidak masuk screening.`); return; }

        // Best pair by 1h volume
        const best = pairs.reduce((a, b) => (parseFloat(a.volume?.h1 ?? 0) > parseFloat(b.volume?.h1 ?? 0) ? a : b));
        const volH1 = Math.round(parseFloat(best.volume?.h1 ?? 0) || 0);
        const mcap = Math.round(parseFloat(best.fdv ?? best.marketCap) || 0);
        const price = parseFloat(best.priceUsd) || null;

        // Check volume filter
        if (volH1 < s.minVolume) {
          await sendMessage(
            `Token itu volume 1h $${volH1.toLocaleString()} < min $${s.minVolume.toLocaleString()}, jadi tidak masuk pool checking.\n` +
            `mcap: ${mcap > 0 ? "$" + mcap.toLocaleString() : "?"} | min mcap: $${s.minMcap.toLocaleString()}${price ? `\nprice: $${price < 0.001 ? price.toExponential(3) : price.toFixed(6)}` : ""}`
          );
          return;
        }
        if (mcap > 0 && mcap < s.minMcap) {
          await sendMessage(
            `Token itu mcap $${mcap.toLocaleString()} < min $${s.minMcap.toLocaleString()}, jadi tidak masuk pool checking.\n` +
            `1h vol: $${volH1.toLocaleString()} | min vol: $${s.minVolume.toLocaleString()}${price ? `\nprice: $${price < 0.001 ? price.toExponential(3) : price.toFixed(6)}` : ""}`
          );
          return;
        }
        if (mcap > 0 && mcap > s.maxMcap) {
          await sendMessage(
            `Token itu mcap $${mcap.toLocaleString()} > max $${s.maxMcap.toLocaleString()}, jadi tidak masuk screening.\n` +
            `1h vol: $${volH1.toLocaleString()} | mcap terlalu besar untuk strategi ini.`
          );
          return;
        }
        // Volume & mcap OK but might not be in Dexscreener boosts/profiles (not discovered)
        await sendMessage(
          `Token itu vol 1h $${volH1.toLocaleString()}, mcap $${mcap.toLocaleString()}.\n` +
          `Volume & mcap lolos. Tapi tidak masuk screening mungkin karena:\n` +
          `1) Tidak masuk Dexscreener boosts/profiles (screening hanya scan token trending)\n` +
          `2) Gagal RugCheck / Jupiter safety check\n` +
          `3) Rank di luar top 60 setelah filter (pre-pool cap)\n\nCek log screening untuk detail lengkap.`
        );
        return;
      } catch (e) {
        await sendMessage(`Error fetching token data: ${e.message}`);
        return;
      }
    }

    // Patterns that indicate user wants to CHANGE something (require explicit confirmation)
    const changePatterns = [
      /\bubah\b/i, /\bchange\b/i, /\bmodify\b/i, /\bupdate\b/i,
      /\btukar\b/i, /\breplace\b/i, /\bswap\b/i,
      /\bset\s+\w+\s+to\b/i, /\bset\b.*\bto\b/i,
      /\b(min|rsi|fib|volume|exposure|max).*\b(jadi|to|=|:=\b)/i,
      /^(RSI|FIB|MIN|VOLUME|EXPOSURE).*?(=|:=\s*)/i,
    ];
    const wantsChange = changePatterns.some(p => p.test(text));

    if (wantsChange) {
      await sendMessage(
        `⚠️ Anda meminta perubahan parameter.\n` +
        `Saya tidak akan langsung mengubah sebelum Anda konfirmasi.\n` +
        `Kirim "ya" atau "ubah" untuk melanjutkan, atau abaikan pesan ini.`
      );
      return;
    }

    // /hermes and /grok prefixes — route to agent as-is
    if (text.startsWith("/hermes ") || text.startsWith("/grok ")) {
      text = text.replace(/^\/(hermes|grok)\s*/i, "");
    }

    const corrId = shortId();
    const hasClose = /\bclose\b|\bsell\b/i.test(text);
    const hasDeploy = /\bdeploy\b|\bopen\b|\blp into\b/i.test(text);
    const role = hasDeploy ? "SCREENER" : "GENERAL";
    const { content } = await agentLoop(text, config.llm.maxSteps, [], role, config.llm.generalModel, null, corrId);
    await sendMessage(stripThink(content));
  } catch (e) {
    await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
log("startup", "Fibonacci LP Agent starting (minimal mode)...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);

registerCronRestarter(() => { startCronJobs(); });

const isTTY = process.stdin.isTTY;

// Probe LLM providers before starting cycles
probeLLMProviders().catch(e => log("startup", `LLM probe error: ${e.message}`)).finally(() => {
  if (isTTY) {
    // REPL mode — start cron + Telegram polling + REPL interface
    startCronJobs();
    startHealthServer();
    log("startup", `Dashboard local: http://localhost:${_healthPort}/dashboard`);
    log("startup", `Vercel deploy: git clone repo, cp public/dashboard/*, vercel.json + env VITE_PROSPERA_API_URL. Docs: PROSPERA.md § Vercel.`);
    startREPL(); // does not return — blocks on readline
  } else {
    // PM2 / non-TTY mode
    log("startup", `Dashboard local: http://localhost:${_healthPort}/dashboard`);
    log("startup", `Vercel deploy: git clone repo, cp public/dashboard/*, vercel.json + env VITE_PROSPERA_API_URL. Docs: PROSPERA.md § Vercel.`);
    startCronJobs();
    startHealthServer();
    _screeningLastTriggered = 0;
    startPolling(handleTelegram);
  }
});
