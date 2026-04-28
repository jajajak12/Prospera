import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (e) {
    log("telegram_warn", `loadChatId: failed to read user-config.json — ${e.message}`);
  }
}

function saveChatId(id) {
  const tmp = `${USER_CONFIG_PATH}.tmp`;
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, USER_CONFIG_PATH);
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

loadChatId();
if (TOKEN && !chatId) {
  log("telegram_warn", "TELEGRAM_CHAT_ID not set — bot will ignore all incoming messages until env is configured");
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendMessage failed: ${e.message}`);
  }
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendHTML failed: ${e.message}`);
  }
}


// ─── Inline keyboard callbacks ───────────────────────────────────
const _callbackHandlers = new Map(); // callbackData → { handler, timer }

export function registerCallback(callbackData, handler, ttlMs = 30 * 60_000) {
  const existing = _callbackHandlers.get(callbackData);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => _callbackHandlers.delete(callbackData), ttlMs);
  if (timer.unref) timer.unref(); // don't prevent process exit
  _callbackHandlers.set(callbackData, { handler, timer });
}

export function unregisterCallback(callbackData) {
  const existing = _callbackHandlers.get(callbackData);
  if (existing?.timer) clearTimeout(existing.timer);
  _callbackHandlers.delete(callbackData);
}

async function answerCallbackQuery(callbackQueryId) {
  if (!TOKEN) return;
  await fetch(`${BASE}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => {});
}

export async function sendWithButtons(text, buttons) {
  // buttons: [[{ text, callback_data }], ...]  (rows of columns)
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendWithButtons ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendWithButtons failed: ${e.message}`);
  }
}

// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;

        // ── Inline button callback ──
        const cbq = update.callback_query;
        if (cbq) {
          await answerCallbackQuery(cbq.id);
          const entry = _callbackHandlers.get(cbq.data);
          if (entry) {
            const { handler, timer } = entry;
            if (timer) clearTimeout(timer);
            _callbackHandlers.delete(cbq.data); // one-shot
            await handler(cbq.data).catch(e => log("telegram_error", `Callback handler error: ${e.message}`));
          }
          continue;
        }

        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Reject all messages if chatId not configured — require explicit TELEGRAM_CHAT_ID in env
        if (!chatId) {
          log("telegram_warn", `Message from ${incomingChatId} ignored — TELEGRAM_CHAT_ID not set in env`);
          continue;
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) continue;

        await onMessage(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee }) {
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, reason }) {
  const sign = pnlUsd >= 0 ? "+" : "";
  const reasonLine = reason ? `\nReason: ${reason}` : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}${reasonLine}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR, correlationId = null }) {
  const corr = correlationId ? ` [${correlationId}]` : "";
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}${corr}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

export async function notifyExposureWarning({ exposurePct, projectedSol, maxSol, gasReserveSol, correlationId = null }) {
  const corr = correlationId ? ` [${correlationId}]` : "";
  await sendHTML(
    `⚠️ <b>Exposure Warning</b>${corr}\n` +
    `Exposure: <b>${exposurePct}%</b>\n` +
    `Projected: ${projectedSol} SOL / ${maxSol} SOL max\n` +
    `Gas reserve: ${gasReserveSol} SOL (excluded from cap)`
  );
}

export async function notifyExposureHardCap({ exposurePct, projectedSol, maxSol, gasReserveSol, pauseMinutes, correlationId = null }) {
  const corr = correlationId ? ` [${correlationId}]` : "";
  await sendHTML(
    `🔴 <b>HARD CAP TRIGGERED</b>${corr}\n` +
    `Exposure: <b>${exposurePct}%</b> — new entry PAUSED\n` +
    `Projected: ${projectedSol} SOL / ${maxSol} SOL max\n` +
    `Gas reserve: ${gasReserveSol} SOL\n` +
    `Pause duration: ${pauseMinutes} minutes\n` +
    `─────────────────────\n` +
    `To resume early: reduce deployed positions or increase wallet SOL.\n` +
    `Auto-resume after pause or manual intervention.`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
