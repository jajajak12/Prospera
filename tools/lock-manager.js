/**
 * lock-manager.js — Anti-overlap protection via file-based lock.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ───────────────────────────────────────────────────────────────────
export const SCREENING_LOCK_PATH  = path.join(__dirname, "..", "screening-lock.json");
export const MANAGEMENT_LOCK_PATH  = path.join(__dirname, "..", "management.lock");

// ── Config ──────────────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

/**
 * Determine if a lock is stale.
 * @param {object|null} lock
 * @param {"screening"|"management"} type
 * @returns {boolean}
 *
 * Stale rules:
 *  - lock null → not stale (no lock to check)
 *  - same PID → not stale (lock from current process)
 *  - "running" from old PID → immediately stale (process died while holding lock)
 *  - "completed" from old PID → stale only if age > 5 min (respect normal gap)
 */
export function isStaleLock(lock, type) {
  if (!lock) return false;
  if (lock.pid === process.pid) return false;

  if (lock.status === "running") return true; // process died holding lock

  const age = Date.now() - lock.ts;
  return age > STALE_THRESHOLD_MS;
}

// ── Low-level read/write ─────────────────────────────────────────────────────
function readLock(filePath, type) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const lock = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isStaleLock(lock, type)) {
      const age = Math.round((Date.now() - lock.ts) / 1000);
      console.log(`[lock] Stale ${type} lock detected from PID ${lock.pid} (age: ${age}s, status: ${lock.status}) — ignoring`);
      return null;
    }
    return lock;
  } catch { return null; }
}

function writeLock(filePath, status) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ ts: Date.now(), pid: process.pid, status }), { flag: "w" });
  } catch { /* non-fatal */ }
}

// ── Screening lock ───────────────────────────────────────────────────────────
export function readScreeningLock() {
  return readLock(SCREENING_LOCK_PATH, "screening");
}

export function writeScreeningLock(status) {
  writeLock(SCREENING_LOCK_PATH, status);
}

export function acquireScreeningLock() {
  const lock = readScreeningLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (lock?.status === "running") {
    return { acquired: false, reason: `screening lock: another cycle running (pid ${lock.pid})`, lock };
  }
  if (ageMs < 60_000) {
    return { acquired: false, reason: `screening lock: last run ${Math.round(ageMs / 1000)}s ago (min 60s)`, lock };
  }
  writeScreeningLock("running");
  return { acquired: true };
}

export function completeScreeningLock() {
  writeScreeningLock("completed");
}

// ── Management lock ──────────────────────────────────────────────────────────
export function readManagementLock() {
  return readLock(MANAGEMENT_LOCK_PATH, "management");
}

export function writeManagementLock(status) {
  writeLock(MANAGEMENT_LOCK_PATH, status);
}

export function acquireManagementLock() {
  const lock = readManagementLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (ageMs < 45_000) {
    return { acquired: false, reason: `management lock: last run ${Math.round(ageMs / 1000)}s ago (min 45s)` };
  }
  writeManagementLock("running");
  return { acquired: true };
}

export function completeManagementLock() {
  writeManagementLock("completed");
}

// ── Guard utilities ──────────────────────────────────────────────────────────
export function isScreeningRunning() {
  const lock = readScreeningLock();
  if (!lock) return false;
  return lock.status === "running" || (Date.now() - lock.ts) < 60_000;
}

export function getLockAge(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const { ts } = JSON.parse(raw);
    return Date.now() - ts;
  } catch { return Infinity; }
}
