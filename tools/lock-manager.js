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
export const SCREENING_LOCK_PATH = path.join(__dirname, "..", "screening-lock.json");
export const MANAGEMENT_LOCK_PATH = path.join(__dirname, "..", "management.lock");

// ── Config ──────────────────────────────────────────────────────────────────
const SCREENING_LOCK_GAP_MS = 60_000; // screening cooldown antar run
const MANAGEMENT_LOCK_GAP_MS = 45_000; // management cooldown antar run

// ── Helpers ─────────────────────────────────────────────────────────────────
export function readScreeningLock() {
  try {
    if (!fs.existsSync(SCREENING_LOCK_PATH)) return null;
    return JSON.parse(fs.readFileSync(SCREENING_LOCK_PATH, "utf8"));
  } catch { return null; }
}

export function writeScreeningLock(status) {
  try {
    fs.writeFileSync(
      SCREENING_LOCK_PATH,
      JSON.stringify({ ts: Date.now(), pid: process.pid, status }),
      { flag: "w" }
    );
  } catch { /* non-fatal */ }
}

export function readManagementLock() {
  try {
    if (!fs.existsSync(MANAGEMENT_LOCK_PATH)) return null;
    return JSON.parse(fs.readFileSync(MANAGEMENT_LOCK_PATH, "utf8"));
  } catch { return null; }
}

export function writeManagementLock(status) {
  try {
    fs.writeFileSync(
      MANAGEMENT_LOCK_PATH,
      JSON.stringify({ ts: Date.now(), pid: process.pid, status }),
      { flag: "w" }
    );
  } catch { /* non-fatal */ }
}

// ── Screening Lock ────────────────────────────────────────────────────────────
export function acquireScreeningLock() {
  const lock = readScreeningLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (lock?.status === "running") {
    return {
      acquired: false,
      reason: "screening lock: another cycle is running (pid ${lock.pid})",
      lock,
    };
  }
  if (ageMs < SCREENING_LOCK_GAP_MS) {
    return {
      acquired: false,
      reason: `screening lock: last run ${Math.round(ageMs / 1000)}s ago (min gap ${SCREENING_LOCK_GAP_MS / 1000}s)`,
      lock,
    };
  }
  writeScreeningLock("running");
  return { acquired: true };
}

export function completeScreeningLock() {
  writeScreeningLock("completed");
}

// ── Management Lock ───────────────────────────────────────────────────────────
export function acquireManagementLock() {
  const lock = readManagementLock();
  const ageMs = lock ? Date.now() - lock.ts : Infinity;

  if (ageMs < MANAGEMENT_LOCK_GAP_MS) {
    return {
      acquired: false,
      reason: `management lock: last run ${Math.round(ageMs / 1000)}s ago (min gap ${MANAGEMENT_LOCK_GAP_MS / 1000}s)`,
    };
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
  return lock.status === "running" || (Date.now() - lock.ts) < SCREENING_LOCK_GAP_MS;
}

export function getLockAge(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const { ts } = JSON.parse(raw);
    return Date.now() - ts;
  } catch { return Infinity; }
}