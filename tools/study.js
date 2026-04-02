/**
 * study.js — LPAgent API integration for fibonacci-lp
 *
 * Pure LPAgent data source. No Meteora fallback.
 * Supports primary + backup API key.
 * Set in .env:
 *   LPAGENT_API_KEY=primary_key
 *   LPAGENT_API_KEY_BACKUP=backup_key
 */

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_PRIMARY = (process.env.LPAGENT_API_KEY || "").trim();
const LPAGENT_BACKUP  = (process.env.LPAGENT_API_KEY_BACKUP || "").trim();

/**
 * Single fetch attempt to LPAgent with a specific API key.
 * Returns raw data array, [] for empty positions, or null on error.
 */
async function fetchWithKey(walletAddress, apiKey) {
  try {
    const res = await fetch(
      `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`,
      { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) }
    );

    if (!res.ok) {
      console.error(`[LPAGENT] HTTP ${res.status} (key: ...${apiKey.slice(-6)})`);
      return null;
    }

    const data = await res.json();

    if (!data.data?.length) {
      console.log(`[LPAGENT] No open positions (count=${data.count ?? 0})`);
      return [];
    }

    return data.data;
  } catch (err) {
    console.error(`[LPAGENT] fetch failed: ${err.message} (key: ...${apiKey.slice(-6)})`);
    return null;
  }
}

/**
 * Fetch open LP positions for a wallet.
 * Strategy:
 *   - Try primary key once
 *   - If primary fails (any error incl. 429), immediately try backup key
 *   - If backup also fails, return null → caller skips cycle
 *
 * Returns raw data array, [] for empty, or null if all keys fail.
 */
export async function fetchLPAgentOpenPositions(walletAddress) {
  if (!LPAGENT_PRIMARY) {
    console.error("[LPAGENT] LPAGENT_API_KEY not set in .env");
    return null;
  }

  // ── Primary key ───────────────────────────────────────────────
  const primary = await fetchWithKey(walletAddress, LPAGENT_PRIMARY);
  if (primary !== null) return primary;

  // ── Backup key (immediate failover) ───────────────────────────
  if (LPAGENT_BACKUP) {
    console.log("[LPAGENT] Primary key failed — trying backup key...");
    const backup = await fetchWithKey(walletAddress, LPAGENT_BACKUP);
    if (backup !== null) {
      console.log("[LPAGENT] Backup key succeeded");
      return backup;
    }
    console.error("[LPAGENT] Both keys failed — skipping cycle");
  } else {
    console.error("[LPAGENT] Primary key failed, no backup key set — skipping cycle");
  }

  return null;
}
