import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { hybridDataProvider } from './dataProvider.js';
import { log } from "../logger.js";
import { getConnection, withRpcFallback, reportRpcSuccess, reportRpcError } from "../rpc.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint } from "./wallet.js";
import { fetchLPAgentOpenPositions } from "./study.js";
// telegram notify handled by callers (executor.js / index.js)

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet init ─────────────────────────────────────────
let _wallet = null;

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

// ─── Estimate bin array initialization fee (non-refundable) ────
// Returns SOL cost for bin arrays that don't yet exist on-chain.
export async function estimateBinInitFee(poolAddress, binsBelow, binsAbove) {
  const { getBinArrayKeysCoverage, BIN_ARRAY_FEE, chunkedGetMultipleAccountInfos } = await import("@meteora-ag/dlmm");
  const pool = await getPool(poolAddress);
  const activeBin = await pool.getActiveBin();
  const minBinId = activeBin.binId - binsBelow;
  const maxBinId = activeBin.binId + binsAbove;
  const keys = getBinArrayKeysCoverage(minBinId, maxBinId, pool.pubkey, pool.program.programId);
  const accounts = await chunkedGetMultipleAccountInfos(getConnection(), keys);
  const newArrays = accounts.filter(a => a == null).length;
  return { estimatedFee: newArrays * BIN_ARRAY_FEE, newArrays, totalArrays: keys.length };
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: parseFloat(pool.fromPricePerLamport(Number(activeBin.price))),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  mcap,
  volume_5m,
  confluence_score,
  fib_zone,
  fib_entry_pct,
  fib500,
  fib_levels_sol,
  rsi,
  atr_pct,
  in_primary_zone,
  has_hidden_divergence,
  smart_wallet_present,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;

  // Fib 0.500 gate is handled in executor.js (pre-deploy) with correct tokenMint.
  // Removed duplicate check here — it had wrong tokenMint (pool_address) and blocked deploy on null price.

  const activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  // bins_above can be NEGATIVE for ATH zone (passive-bid: range entirely below current price).
  // Negative value shifts maxBinId below activeBin so range top lands at fib 0.236.
  const activeBinsAbove = bins_above ?? 0;

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown (closed for low yield) — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed for low yield. Try a different pool." };
  }

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
  const newPosition = Keypair.generate();

  const deployCtx = { pool: pool_address, pair: pool_name };
  log("deploy", `Pool: ${pool_address}`, deployCtx);
  const rangeMode = activeBinsAbove < 0 ? " — PASSIVE BID (range below active bin)" : "";
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins, active=${activeBin.binId}${isWideRange ? " WIDE" : ""}${rangeMode})`, deployCtx);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`, deployCtx);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`, deployCtx);

  // Track Phase 1 key for wide-range phantom cleanup on Phase 2 failure
  let _phase1PositionKey = null;

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, createTxArray[i], signers), "deploy:create");
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }
      // Phase 1 confirmed on-chain — track for phantom cleanup if Phase 2 fails
      _phase1PositionKey = newPosition.publicKey;

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, addTxArray[i], [wallet]), "deploy:add_liquidity");
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
      _phase1PositionKey = null; // Phase 2 succeeded — no phantom
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, tx, [wallet, newPosition]), "deploy:standard");
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`, deployCtx);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      mcap,
      volume_5m,
      confluence_score:      confluence_score      ?? null,
      fib_zone:              fib_zone              ?? null,
      fib_entry_pct:         fib_entry_pct         ?? null,
      fib_levels_sol:        fib_levels_sol        ?? null,
      rsi:                   rsi                   ?? null,
      atr_pct:               atr_pct               ?? null,
      in_primary_zone:       in_primary_zone       ?? null,
      has_hidden_divergence: has_hidden_divergence ?? null,
      smart_wallet_present:  smart_wallet_present  ?? null,
    });

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat(pool.fromPricePerLamport(Number(activeBin.price)));
    const minPrice = activePrice * Math.pow(1 + actualBinStep / 10000, minBinId - activeBin.binId);
    const maxPrice = activePrice * Math.pow(1 + actualBinStep / 10000, maxBinId - activeBin.binId);

    // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
    const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
    const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    // Always invalidate cache so next cycle fetches fresh LPAgent state
    _positionsCacheAt = 0;

    // Wide-range: Phase 1 created an empty on-chain position but Phase 2 failed.
    // Close it immediately so LPAgent doesn't return it as an active position,
    // which would block re-entry for the same token/pool.
    if (_phase1PositionKey) {
      try {
        log("deploy", `Phantom cleanup: closing empty position ${_phase1PositionKey.toString().slice(0, 8)} (Phase 2 failed: ${error.message.slice(0, 60)})`);
        const cleanupTxs = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: _phase1PositionKey,
          fromBinId: -887272,
          toBinId: 887272,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });
        for (const tx of Array.isArray(cleanupTxs) ? cleanupTxs : [cleanupTxs]) {
          await withRpcFallback(conn => sendAndConfirmTransaction(conn, tx, [wallet]), "deploy:phantom_cleanup")
            .catch(e => log("deploy_error", `Phantom cleanup tx failed: ${e.message}`));
        }
        log("deploy", `Phantom cleanup OK: empty position closed`);
      } catch (cleanupErr) {
        log("deploy_error", `Phantom cleanup failed: ${cleanupErr.message}`);
      }
    }

    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes
const ORPHAN_SCAN_INTERVAL_MS = 60 * 60_000; // 1 hour

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
let _orphanScanAt = 0;

// ─── Orphan Position Scanner ────────────────────────────────────
// Finds on-chain DLMM positions that LPAgent doesn't return (phantom/failed deploys).
// Throttled to once per hour to avoid expensive RPC scans every cycle.
export async function scanOrphanPositions(lpAgentAddresses, lpAgentPositionData = []) {
  if (Date.now() - _orphanScanAt < ORPHAN_SCAN_INTERVAL_MS) return [];
  _orphanScanAt = Date.now();

  log("orphan_scan", `LPAgent knows ${lpAgentAddresses.length} position(s): [${lpAgentAddresses.map(a => a.slice(0, 8)).join(", ")}]`);
  for (const p of lpAgentPositionData) {
    log("orphan_scan", `  LPAgent pos ${(p.position || "?").slice(0, 8)} | pair=${p.pair} | sol=${p.total_value_sol} | usd=${p.total_value_usd} | age_min=${p.age_minutes}`);
  }

  try {
    const { DLMM } = await getDLMM();
    const wallet = getWallet();
    const allPositions = await DLMM.getAllLbPairPositionsByUser(
      getConnection(),
      wallet.publicKey
    );

    const poolCount = Object.keys(allPositions).length;
    let chainTotal = 0;
    for (const posData of Object.values(allPositions)) chainTotal += (posData.lbPairPositionsData || []).length;
    log("orphan_scan", `On-chain: ${chainTotal} position(s) across ${poolCount} pool(s)`);

    const knownSet = new Set(lpAgentAddresses);
    const orphans = [];

    for (const [lbPairKey, posData] of Object.entries(allPositions)) {
      for (const pos of (posData.lbPairPositionsData || [])) {
        const addr = pos.publicKey.toString();
        const isKnown = knownSet.has(addr);
        // Log total liquidity to detect zero-value positions skipped by LPAgent
        const totalLiq = pos.positionData?.totalXAmount != null
          ? `X=${pos.positionData.totalXAmount} Y=${pos.positionData.totalYAmount}`
          : "liq=unknown";
        log("orphan_scan", `  chain pos ${addr.slice(0, 8)} pool=${lbPairKey.slice(0, 8)} ${totalLiq} | known=${isKnown}`);
        if (!isKnown) {
          orphans.push({ position: addr, pool: lbPairKey });
        }
      }
    }

    if (orphans.length > 0) {
      log("orphan_scan", `Found ${orphans.length} orphan(s): ${orphans.map(o => o.position.slice(0, 8)).join(", ")}`);
    } else {
      log("orphan_scan", "No orphan positions found");
    }

    return orphans;
  } catch (e) {
    log("orphan_scan", `Scan failed: ${e.message}`);
    return [];
  }
}

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${(data && typeof data === "object" ? Object.keys(data).join(", ") : "null/undefined")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    // ── Fetch solPrice for SOL→USD conversion (needed since ...Native fields = SOL) ─
    const { sol_price: solPrice } = await import("./wallet.js").then(m => m.getWalletBalances().catch(() => ({ sol_price: 0 })));

    // ── Pure LPAgent — study.js already handles retry + backup key ─
    const lpAgentData = await fetchLPAgentOpenPositions(walletAddress);

    if (lpAgentData === null) {
      log("positions_error", "LPAgent unavailable. Skipping cycle.");
      return { wallet: walletAddress, total_positions: 0, positions: [], error: "LPAgent unavailable — check LPAGENT_API_KEY in .env" };
    }

    if (!silent) log("positions", `LPAgent: ${lpAgentData.length} open position(s)`);

    // ── SOL price for native→USD conversion (from getWalletBalances or cached balance) ─
    const _solPrice = solPrice > 0 ? solPrice : 0;

    const positions = lpAgentData.map(lp => {
      const positionAddress = lp.position || lp.tokenId;
      const tracked = getTrackedPosition(positionAddress);
      const isOOR = !lp.inRange;

      if (isOOR) markOutOfRange(positionAddress);
      else markInRange(positionAddress);

      const ageFromState = tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null;

      // Convert SOL (Native) → USD for all value fields
      // total_value_usd, unclaimed_fees_usd, collected_fees_usd, pnl_usd were mislabeled as _usd
      // but actually contained SOL values from LPAgent's ...Native fields
      return {
        position:             positionAddress,
        pool:                 lp.pool,
        pair:                 tracked?.pool_name || lp.pairName || (lp.token0Info?.symbol + "/" + lp.token1Info?.symbol),
        base_mint:            lp.token0,
        lower_bin:            lp.range?.[0] ?? tracked?.bin_range?.min ?? null,
        upper_bin:            lp.range?.[1] ?? tracked?.bin_range?.max ?? null,
        active_bin:           lp.range?.[2] ?? tracked?.bin_range?.active ?? null,
        in_range:             !!lp.inRange,
        fib_zone:             tracked?.fib_zone ?? null,
        current_fib_level:   null,  // live Fib level vs ATH — expensive to compute every cycle; nullable for future use
        unclaimed_fees_sol:   Math.round((lp.unCollectedFeeNative ?? 0) * 100_000) / 100_000,
        total_value_sol:      Math.round((lp.valueNative          ?? 0) * 100_000) / 100_000,
        unclaimed_fees_usd:   _solPrice > 0 ? Math.round((lp.unCollectedFeeNative ?? 0) * _solPrice * 100) / 100 : 0,
        total_value_usd:      _solPrice > 0 ? Math.round((lp.valueNative          ?? 0) * _solPrice * 100) / 100 : 0,
        collected_fees_usd:   _solPrice > 0 ? Math.round((lp.collectedFeeNative   ?? 0) * _solPrice * 100) / 100 : 0,
        pnl_usd:              _solPrice > 0 ? Math.round((lp.pnl?.valueNative     ?? 0) * _solPrice * 100) / 100 : 0,
        // percentNative from LPAgent already in % format (0.38 = 0.38%) — no conversion needed
        pnl_pct:              Math.round((lp.pnl?.percentNative ?? 0) * 100) / 100,
        // dprNative = dimensionless ratio (0.015 = 1.5% daily fee/TVL) — multiply by 100 for %
        fee_per_tvl_24h:      Math.round((lp.dprNative ?? 0) * 100 * 100) / 100,
        age_minutes:          lp.ageHour != null ? Math.round(lp.ageHour * 60) : ageFromState,
        minutes_out_of_range: minutesOutOfRange(positionAddress),
        instruction:          tracked?.instruction ?? null,
        _source:              "lpagent",
      };
    });

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map(p => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `getMyPositions failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_sol: null,  // not available from Meteora wallet positions — use LPAgent path
        total_value_sol:    null,  // not available from Meteora wallet positions — use LPAgent path
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, tx, [wallet]), "claim");
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason, skip_swap = false, _pool_hint = null }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    const closeCtx = { position: position_address, pool: tracked?.pool, pair: tracked?.pool_name, reason };
    log("close", `Closing position: ${position_address}`, closeCtx);
    const wallet = getWallet();
    const poolAddress = _pool_hint ?? await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);

    const txHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`, closeCtx);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`, closeCtx);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, tx, [wallet]), "close:claim");
            txHashes.push(claimHash);
          }
          log("close", `Step 1 OK: ${txHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    log("close", `Step 2: Removing liquidity and closing account`, closeCtx);
    const closeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });

    for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
      const txHash = await withRpcFallback(conn => sendAndConfirmTransaction(conn, tx, [wallet]), "close:remove_liquidity");
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`, closeCtx);
    // Wait for RPC to reflect withdrawn balances before returning
    await new Promise(r => setTimeout(r, 5000));

    // ─── Step 3: Auto-swap base token to SOL ──────────────────────
    if (!skip_swap) {
      try {
        const { getWalletBalances, swapToken: doSwap } = await import("./wallet.js");
        const baseMint = pool.lbPair.tokenXMint.toString();
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new Promise(r => setTimeout(r, attempt * 3000));
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === baseMint);
          if (token && token.usd >= 0.10) {
            log("close", `Step 3: Auto-swapping ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) to SOL`);
            const swapR = await doSwap({ input_mint: baseMint, output_mint: "SOL", amount: token.balance }).catch(e => ({ error: e.message }));
            if (swapR?.error) log("close_warn", `Step 3 swap failed: ${swapR.error}`);
            else if (swapR?.amount_out) log("close", `Step 3 OK: received ${swapR.amount_out} SOL`);
            break;
          }
        }
      } catch (e) {
        log("close_warn", `Step 3 auto-swap error: ${e.message}`);
      }
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      // Cumulative OOR: total_minutes_oor (past streaks) + current streak if still OOR
      let minutesOOR = tracked.total_minutes_oor || 0;
      if (tracked.out_of_range_since) {
        minutesOOR += Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      // Snapshot pre-close PnL BEFORE cache invalidation — race-condition-safe fallback
      const _preCloseSnapshot = _positionsCache?.positions?.find(p => p.position === position_address);

      _positionsCacheAt = 0; // invalidate cache so next cycle re-fetches

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        const res = await fetch(closedUrl);
        if (res.ok) {
          const data = await res.json();
          const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
          if (posEntry) {
            pnlUsd        = parseFloat(posEntry.pnlUsd || 0);
            pnlPct        = parseFloat(posEntry.pnlPctChange || 0);
            finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
            initialUsd    = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
            feesUsd       = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
            log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`);
          } else {
            log("close_warn", `Position not found in status=closed response — may still be settling`);
          }
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close snapshot (captured before cache invalidation — avoids race condition)
      if (finalValueUsd === 0 && _preCloseSnapshot) {
        pnlUsd        = _preCloseSnapshot.pnl_usd         ?? 0;
        pnlPct        = _preCloseSnapshot.pnl_pct         ?? 0;
        finalValueUsd = _preCloseSnapshot.total_value_usd ?? 0;
        feesUsd       = (_preCloseSnapshot.collected_fees_usd || 0) + (_preCloseSnapshot.unclaimed_fees_usd || 0) || feesUsd;
        initialUsd    = tracked.initial_value_usd || (finalValueUsd - pnlUsd) || 0;
        log("close_warn", `Using pre-close snapshot as PnL fallback: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%)`);
      }

      // Fetch SOL price at close from Meteora (native SOL — consistent with SOL-first architecture).
      // Used for deploy cooldown check: current SOL price vs SOL price at close.
      // Also fetch USD ATH from Dexscreener for legacy compatibility (pool-memory.js fallback).
      let athPriceSolAtClose = null;
      let athPriceAtClose = null;
      try {
        const activeBin = await pool.getActiveBin();
        athPriceSolAtClose = parseFloat(activeBin.price); // Meteora native SOL
        log("close", `ATH SOL at close: ${athPriceSolAtClose}`);
      } catch (e) {
        log("close_warn", `Meteora active bin at close failed: ${e.message}`);
      }
      try {
        const poolData = await hybridDataProvider.getPoolData(poolAddress.toString());
        athPriceAtClose = poolData?.ath_price ?? null;
        log("close", `ATH USD at close: ${athPriceAtClose ?? "N/A"}`);
      } catch (e) {
        log("close_warn", `ATH fetch at close failed: ${e.message}`);
      }

      try { await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        mcap: tracked.mcap || null,
        volume_5m: tracked.volume_5m || null,
        confluence_score:      tracked.confluence_score      ?? null,
        fib_zone:              tracked.fib_zone              ?? null,
        fib_entry_pct:         tracked.fib_entry_pct         ?? null,
        rsi:                   tracked.rsi                   ?? null,
        atr_pct:               tracked.atr_pct               ?? null,
        in_primary_zone:       tracked.in_primary_zone       ?? null,
        has_hidden_divergence: tracked.has_hidden_divergence ?? null,
        smart_wallet_present:  tracked.smart_wallet_present  ?? null,
        amount_sol: tracked.amount_sol,
        // allTimeWithdrawals already includes fee tokens — allTimeFees double-counts them
        // Use pnlUsd from Meteora directly (already correct), don't add fees separately
        fees_earned_usd: 0,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        // Trust Meteora's pnlUsd which is pre-calculated without double-count
        pnl_usd_override: pnlUsd,
        pnl_pct_override: pnlPct,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        ath_price: athPriceAtClose,
        ath_price_sol: athPriceSolAtClose,
        fib_levels_sol: tracked.fib_levels_sol ?? null,
        deployed_at: tracked.deployed_at ?? null,
        base_mint: pool.lbPair.tokenXMint.toString(),
      }); } catch (e) { log("close_warn", `recordPerformance failed: ${e.message}`); }

      return { success: true, position: position_address, pool: poolAddress, pool_name: tracked.pool_name || null, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct, base_mint: pool.lbPair.tokenXMint.toString(), close_reason: reason || "agent decision" };
    }

    return { success: true, position: position_address, pool: poolAddress, pool_name: null, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString(), close_reason: reason || "agent decision" };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
