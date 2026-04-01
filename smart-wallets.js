/**
 * smart-wallets.js — Smart money wallet tracker with self-learning
 *
 * Two modes:
 * 1. Manual: add/remove wallets by address
 * 2. Auto-learning: observe pool participants at close time, promote wallets
 *    that consistently appear in profitable pools
 *
 * Auto-promotion rules:
 *   - observations >= MIN_OBSERVATIONS (3)
 *   - win_rate >= MIN_WIN_RATE (0.65)
 *   → wallet auto-added to smart list with label "auto"
 *
 * During screening: if a smart wallet has an open position in a candidate pool
 * → confluenceScore gets +0.10 boost.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH   = path.join(__dirname, "smart-wallets.json");
const OBSERVED_PATH  = path.join(__dirname, "observed-wallets.json");

const MIN_OBSERVATIONS = 3;
const MIN_WIN_RATE     = 0.65;

// ─── Smart wallet list (manual + auto-promoted) ───────────────────────────────

/** @returns {Array<{ address, label, addedAt, auto? }>} */
export function loadSmartWallets() {
  try {
    if (!fs.existsSync(WALLETS_PATH)) return [];
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch { return []; }
}

function saveSmartWallets(wallets) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
}

/** Add a wallet manually. Returns { added, alreadyExists }. */
export function addSmartWallet(address, label = "") {
  const wallets = loadSmartWallets();
  if (wallets.some(w => w.address === address)) {
    return { added: false, alreadyExists: true, address };
  }
  wallets.push({ address, label: label || address.slice(0, 8), addedAt: new Date().toISOString() });
  saveSmartWallets(wallets);
  log("smart-wallets", `Added smart wallet: ${address.slice(0, 8)} (${label || "manual"})`);
  return { added: true, address, label };
}

/** Remove a wallet by address. Returns { removed }. */
export function removeSmartWallet(address) {
  const wallets = loadSmartWallets();
  const before   = wallets.length;
  saveSmartWallets(wallets.filter(w => w.address !== address));
  const removed  = before > loadSmartWallets().length;

  // Also clear from observed
  const obs = loadObserved();
  delete obs[address];
  saveObserved(obs);

  if (removed) log("smart-wallets", `Removed smart wallet: ${address.slice(0, 8)}`);
  return { removed, address };
}

// ─── Observed wallet store ────────────────────────────────────────────────────
// { [address]: { wins, losses, pools, lastSeen } }

function loadObserved() {
  try {
    if (!fs.existsSync(OBSERVED_PATH)) return {};
    return JSON.parse(fs.readFileSync(OBSERVED_PATH, "utf8"));
  } catch { return {}; }
}

function saveObserved(obs) {
  fs.writeFileSync(OBSERVED_PATH, JSON.stringify(obs, null, 2));
}

// ─── Pool participant fetch ───────────────────────────────────────────────────

const DLMM_API = "https://dlmm.datapi.meteora.ag";

/**
 * Fetch all wallet addresses currently holding open positions in a pool.
 * Uses Meteora DataAPI — public endpoint, no auth needed.
 * Returns string[] of wallet addresses (excludes our own wallet).
 */
async function fetchPoolParticipants(poolAddress, ownWallet) {
  try {
    const url = `${DLMM_API}/positions/${poolAddress}/pnl?status=open&pageSize=100&page=1`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];

    const data = await res.json();
    const rows = data?.data ?? data?.positions ?? data ?? [];

    // Extract unique user/owner addresses, exclude our own
    const addresses = new Set();
    for (const row of rows) {
      const addr = row.user || row.owner || row.wallet;
      if (addr && addr !== ownWallet) addresses.add(addr);
    }
    return [...addresses];
  } catch {
    return [];
  }
}

// ─── Self-learning: observe & promote ────────────────────────────────────────

/**
 * Called after every position close. Fetches other wallets in the pool and
 * records them as co-winners (profitable close) or losers (stop-loss close).
 * Wallets that hit promotion threshold get auto-added to smart-wallets.json.
 *
 * @param {string} poolAddress
 * @param {number} pnlPct  - our PnL % at close (positive = profit)
 * @param {string} ownWallet - our wallet address (to exclude from list)
 */
export async function observePoolParticipants(poolAddress, pnlPct, ownWallet) {
  const isWin = typeof pnlPct === "number" && pnlPct >= 0;

  let participants;
  try {
    participants = await fetchPoolParticipants(poolAddress, ownWallet);
  } catch {
    return;
  }

  if (participants.length === 0) return;

  const obs     = loadObserved();
  const smart   = loadSmartWallets();
  const smartSet = new Set(smart.map(w => w.address));
  const promoted = [];

  for (const addr of participants) {
    if (smartSet.has(addr)) continue; // already promoted

    if (!obs[addr]) {
      obs[addr] = { wins: 0, losses: 0, pools: [], lastSeen: null };
    }

    const entry = obs[addr];
    if (isWin) entry.wins++;
    else        entry.losses++;

    if (!entry.pools.includes(poolAddress)) {
      entry.pools.push(poolAddress);
      if (entry.pools.length > 20) entry.pools = entry.pools.slice(-20); // keep last 20
    }
    entry.lastSeen = new Date().toISOString();

    // Check promotion threshold
    const total    = entry.wins + entry.losses;
    const winRate  = total > 0 ? entry.wins / total : 0;

    if (total >= MIN_OBSERVATIONS && winRate >= MIN_WIN_RATE) {
      smart.push({
        address:  addr,
        label:    `auto_${addr.slice(0, 6)}`,
        addedAt:  new Date().toISOString(),
        auto:     true,
        winRate:  Math.round(winRate * 100),
        observations: total,
      });
      smartSet.add(addr);
      promoted.push(addr.slice(0, 8));
      log("smart-wallets", `AUTO-PROMOTED wallet ${addr.slice(0, 8)} — ${entry.wins}W/${entry.losses}L (${Math.round(winRate * 100)}% win rate)`);
    }
  }

  saveObserved(obs);
  if (promoted.length > 0) saveSmartWallets(smart);

  const outcome = isWin ? `+${pnlPct?.toFixed(1)}%` : `${pnlPct?.toFixed(1)}%`;
  log("smart-wallets", `Observed ${participants.length} wallets in ${poolAddress.slice(0, 8)} (${outcome}) — ${promoted.length} promoted`);
}

/**
 * Get observation stats for all tracked (not yet promoted) wallets.
 */
export function getObservationStats() {
  const obs = loadObserved();
  return Object.entries(obs).map(([address, e]) => ({
    address,
    wins:      e.wins,
    losses:    e.losses,
    total:     e.wins + e.losses,
    winRate:   e.wins + e.losses > 0 ? Math.round(e.wins / (e.wins + e.losses) * 100) : 0,
    lastSeen:  e.lastSeen,
  })).sort((a, b) => b.winRate - a.winRate || b.total - a.total);
}

// ─── Activity Check (used by screening) ──────────────────────────────────────

/**
 * Check which candidate pool addresses have smart wallet positions.
 * Fetches positions for all smart wallets in parallel (one request per wallet).
 * Returns Map<pool_address, wallet_label[]>
 *
 * @param {string[]} poolAddresses
 * @returns {Promise<Map<string, string[]>>}
 */
export async function checkSmartWalletActivity(poolAddresses) {
  const wallets = loadSmartWallets();
  if (wallets.length === 0 || poolAddresses.length === 0) return new Map();

  const poolSet = new Set(poolAddresses);
  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.allSettled(
    wallets.map(w => getWalletPositions({ wallet_address: w.address }))
  );

  const poolToWallets = new Map();
  for (let i = 0; i < wallets.length; i++) {
    if (results[i].status !== "fulfilled") continue;
    for (const pos of results[i].value?.positions ?? []) {
      if (pos.pool && poolSet.has(pos.pool)) {
        if (!poolToWallets.has(pos.pool)) poolToWallets.set(pos.pool, []);
        poolToWallets.get(pos.pool).push(wallets[i].label);
      }
    }
  }

  return poolToWallets;
}
