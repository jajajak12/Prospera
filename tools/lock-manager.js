/**
 * lock-manager.js — Anti-overlap protection via file-based lock.
 * Satu lock per loop type: screening vs management.
 * Lock TIDAK PERNAH dihapus — hanya di-overwrite (survives PM2 restart).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ───────────────────────────────────────────────────────────────────
export const SCREENING_LOCK_PATH  = path.join(__dirname, "..", "screening-lock.json");
export const MANAGEMENT_LOCK_PATH  = path.join(__dirname, "..", "management.lock");

// ── Config ──────────────────────────────────────────────────────────────────
const SCREENING_LOCK_GAP_MS   = 60_000;
const MANAGEMENT_LOCK_GAP_MS  = 45_000;
const STALE_THRESHOLD_MS      = 5 * 60_1000;  // 5 min — lock dari proses mati dianggap invalid

// ── Core stale detection — reusable untuk semua lock types ─────────────────
export function isStaleLock(lock) {
  if (!lock || lock.pid === process.pid) return false;
  if (lock.status !== "running") return false;
  return Date.now() - lock.ts > STALE_THRESHOLD_MS;
}

// ── Read / Write helpers ─────────────────────────────────────────────────────
function readLock(path) {
  try {
    if (!fs.existsSync(path)) return null;
    const lock = JSON.parse(fs.readFileSync(path, "utf8"));
    if (isStaleLock(lock)) {
      console.log(`[lock] stale lock detected (pid ${lock.pid}, age ${Math.round((Date.now() - lock.ts) / 1000)}s) — treating as empty`);
      return null;
    }
    return lock;
  } catch { return null; }
}

function writeLock(path, status) {
  try {
    fs.writeFileSync(path, JSON.stringify({ ts: Date.now(), pid: process.pid, status }), { flag: "w" });
  } catch { /* non-fatal */ }
}

// ── Screening lock ───────────────────────────────────────────────────────────
export function readScreeningLock()  { return readLock(SCREENING_LOCK_PATH); }
export function writeScreeningLock(status) { writeLock(SCREENING_LOCK_PATH, status); }

export function acquireScreeningLock() {
  const lock = readScreeningLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (lock?.status === "running") {
    return { acquired: false, reason: `screening lock: another cycle running (pid ${lock.pid})`, lock };
  }
  if (ageMs < SCREENING_LOCK_GAP_MS) {
    return { acquired: false, reason: `screening lock: last run ${Math.round(ageMs / 1000)}s ago (min ${SCREENING_LOCK_GAP_MS / 1000}s)`, lock };
  }
  writeScreeningLock("running");
  return { acquired: true };
}

export function completeScreeningLock() { writeScreeningLock("completed"); }

// ── Management lock ──────────────────────────────────────────────────────────
export function readManagementLock()  { return readLock(MANAGEMENT_LOCK_PATH); }
export function writeManagementLock(status) { writeLock(MANAGEMENT_LOCK_PATH, status); }

export function acquireManagementLock() {
  const lock = readManagementLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (ageMs < MANAGEMENT_LOCK_GAP_MS) {
    return { acquired: false, reason: `management lock: last run ${Math.round(ageMs / 1000)}s ago (min ${MANAGEMENT_LOCK_GAP_MS / 1000}s)` };
  }
  writeManagementLock("running");
  return { acquired: true };
}

export function completeManagementLock() { writeManagementLock("completed"); }

// ── Guard utilities ──────────────────────────────────────────────────────────
export function isScreeningRunning() {
  const lock = readScreeningLock();
  if (!lock) return false;
  return lock.status === "running" || (Date.now() - lock.ts) < SCREENING_LOCK_GAP_MS;
}

export function getLockAge(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const { ts } = JSON.parse(raw);
    return Date.now() - ts;
  } catch { return Infinity; }
}
