/**
 * agent.js — Core ReAct agent loop for Fibonacci LP agent.
 *
 * Adapted from Meridian's agent.js.
 * Key changes:
 * - SCREENER_TOOLS: uses get_chart_candidates instead of get_top_candidates
 * - Removed: check_smart_wallets_on_pool, get_token_holders, get_token_narrative, study_top_lpers
 */

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS = new Set([
  "close_position",
  "claim_fees",
  "swap_token",
  "update_config",
  "get_position_pnl",
  "get_my_positions",
  "set_position_note",
  "add_pool_note",
  "get_wallet_balance",
  "get_pool_detail",
  "get_active_bin",
]);

const SCREENER_TOOLS = new Set([
  "deploy_position",
  "get_active_bin",
  "get_chart_candidates",
  "get_my_positions",
  "get_wallet_balance",
  "update_config",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  deploy:    new Set(["deploy_position", "get_chart_candidates", "get_active_bin", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:     new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:     new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:      new Set(["swap_token", "get_wallet_balance"]),
  config:    new Set(["update_config"]),
  balance:   new Set(["get_wallet_balance", "get_my_positions"]),
  positions: new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note"]),
  screen:    new Set(["get_chart_candidates", "get_pool_detail", "get_my_positions"]),
};

const INTENT_PATTERNS = [
  { intent: "deploy",    re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",     re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",     re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",      re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "config",    re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",   re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions", re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "screen",    re: /\b(screen|candidate|find pool|search|fib|fibonacci|signal)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  if (matched.size === 0) return tools;
  return tools.filter(t => matched.has(t.function.name));
}

import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import {
  getActiveProvider,
  getProviderConfig,
  isFallbackActive,
  recordSuccess,
  recordFailure,
  getBackoffDelay,
  circuitSleep,
  getCircuitState,
  setCorrelationId,
} from "./tools/circuit-breaker.js";

// ── Key resolution (single source of truth) ────────────────────────────────
// Priority: process.env.LLM_API_KEY → config.llm.minimaxApiKey (user-config.json)
const _minimaxKey = (process.env.LLM_API_KEY || config.llm?.minimaxApiKey || "").trim();
const _minimaxKeyPresent = !!(_minimaxKey && _minimaxKey !== "placeholder" && _minimaxKey.length > 10);

const _openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
const _openrouterKeyPresent = !!(_openrouterKey && _openrouterKey !== "placeholder" && _openrouterKey.length > 10);

// Two immutable client instances — one per provider. Never mutated after init.
const minimaxClient = new OpenAI({
  baseURL: "https://api.minimax.io/v1",
  apiKey: _minimaxKeyPresent ? _minimaxKey : "NO_KEY",
  timeout: 5 * 60 * 1000,
});

const openrouterClient = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: _openrouterKeyPresent ? _openrouterKey : "NO_KEY",
  timeout: 5 * 60 * 1000,
});

// Probe result set once at startup by probeLLMProviders().
// null = not probed yet (use circuit-breaker state as fallback).
let _probeResult = null; // "minimax" | "openrouter" | "none"

function getClient() {
  // After probe: use confirmed provider
  if (_probeResult === "minimax") return minimaxClient;
  if (_probeResult === "openrouter") return openrouterClient;
  // Before probe or probe not run: fall back to circuit-breaker state
  if (!_minimaxKeyPresent || getActiveProvider() === "openrouter") return openrouterClient;
  return minimaxClient;
}

/**
 * Probe both LLM providers at startup. Call once from index.js before cycles start.
 * Sets _probeResult and logs clearly. Does NOT throw.
 *
 * @returns {{ provider: "minimax"|"openrouter"|"none", minimaxStatus: string, openrouterStatus: string }}
 */
export async function probeLLMProviders() {
  const results = { minimax: "skip", openrouter: "skip" };

  // ── Probe MiniMax FIRST (primary) ─────────────────────────────────────────
  if (_minimaxKeyPresent) {
    const keyHint = _minimaxKey.slice(0, 12) + "...";
    log("startup", `LLM probe: MiniMax key=${keyHint} (len=${_minimaxKey.length}) — testing...`);
    try {
      const resp = await minimaxClient.chat.completions.create({
        model: config.llm?.screeningModel || "minimax-2.7",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      if (resp?.choices?.length) {
        results.minimax = "ok";
        log("startup", `LLM probe: MiniMax → OK ✓ (model=${config.llm?.screeningModel || "minimax-2.7"})`);
      } else {
        results.minimax = "bad_response";
        log("startup", `LLM probe: MiniMax → unexpected response shape — treating as failure`);
      }
    } catch (e) {
      const code = e.status || e.code || "unknown";
      const msg = (e.message || "").slice(0, 120);
      results.minimax = `error_${code}`;
      if (code === 401) {
        log("startup", `LLM probe: MiniMax → 401 UNAUTHORIZED — key is invalid or expired`);
      } else {
        log("startup", `LLM probe: MiniMax → FAIL (${code}) — ${msg}`);
      }
    }
  } else {
    results.minimax = "no_key";
    log("startup", `LLM probe: MiniMax → SKIP (no key configured)`);
  }

  // ── Only probe OpenRouter if MiniMax is unavailable ─────────────────────────
  if (results.minimax === "ok") {
    // MiniMax is primary and working — skip OpenRouter probe entirely to save cost
    results.openrouter = "skipped";
    log("startup", `LLM probe: OpenRouter → SKIP (MiniMax primary and available — no need to probe)`);
  } else if (_openrouterKeyPresent) {
    // MiniMax failed — probe OpenRouter as fallback
    const orKeyHint = _openrouterKey.slice(0, 12) + "...";
    const orModel = config.llm?.openrouterModel || "anthropic/claude-sonnet-4";
    log("startup", `LLM probe: OpenRouter key=${orKeyHint} (len=${_openrouterKey.length}) — testing (fallback)...`);
    try {
      const resp = await openrouterClient.chat.completions.create({
        model: orModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      if (resp?.choices?.length) {
        results.openrouter = "ok";
        log("startup", `LLM probe: OpenRouter → OK ✓ (model=${orModel})`);
      } else {
        results.openrouter = "bad_response";
        log("startup", `LLM probe: OpenRouter → unexpected response shape`);
      }
    } catch (e) {
      const code = e.status || e.code || "unknown";
      const msg = (e.message || "").slice(0, 120);
      results.openrouter = `error_${code}`;
      log("startup", `LLM probe: OpenRouter → FAIL (${code}) — ${msg}`);
    }
  } else {
    results.openrouter = "no_key";
    log("startup", `LLM probe: OpenRouter → SKIP (no key configured)`);
  }

  // ── Decide active provider ─────────────────────────────────────────────────
  if (results.minimax === "ok") {
    _probeResult = "minimax";
  } else if (results.openrouter === "ok") {
    _probeResult = "openrouter";
    // Trip circuit so runtime calls go to openrouter immediately — log only, no recordFailure (probe ≠ real call)
    log("startup", `LLM probe: MiniMax unavailable — circuit set to OpenRouter (no failure recorded)`);
  } else {
    _probeResult = "none";
    log("startup", `LLM probe: ⚠️ BOTH providers unavailable — agent will run but LLM calls will fail`);
  }

  log("startup", `LLM probe result: active=${_probeResult} | minimax=${results.minimax} | openrouter=${results.openrouter}`);
  return { provider: _probeResult, minimaxStatus: results.minimax, openrouterStatus: results.openrouter };
}

const DEFAULT_MODEL = process.env.LLM_MODEL || config.llm?.generalModel || "minimax-2.7";

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 12)
 * @param {Array}  sessionHistory - Prior conversation turns
 * @param {string} agentType - "GENERAL" | "SCREENER" | "MANAGER"
 * @param {string|null} model - Override model
 * @param {number|null} maxOutputTokens - Override max output tokens
 * @returns {Promise<{ content: string, userMessage: string }>}
 */
export async function agentLoop(
  goal,
  maxSteps = config.llm.maxSteps,
  sessionHistory = [],
  agentType = "GENERAL",
  model = null,
  maxOutputTokens = null,
  correlationId = null
) {
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons      = getLessonsForPrompt({ agentType });
  const perfSummary  = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  const NO_RETRY_TOOLS   = new Set(["deploy_position"]);
  const firedOnce        = new Set();

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap)\b/i;
      const toolChoice = (step === 0 && agentType === "GENERAL" && ACTION_INTENTS.test(goal)) ? "required" : "auto";

      let response;
      const MAX_ATTEMPTS = 4; // circuit breaker max call attempts (includes backoff)

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Get provider config (respects circuit state — may be openrouter during fallback)
        const { model: usedModel, provider } = getProviderConfig();
        const client = getClient();
        const _keyHint = provider === "minimax" && _minimaxKeyPresent ? _minimaxKey.slice(0, 10) + "..." : "N/A";

        if (attempt > 0) {
          log("agent", `Retry ${attempt}/${MAX_ATTEMPTS} with ${provider} (${usedModel})`);
        } else {
          log("agent", `LLM call → ${provider} | model=${usedModel} | key=${_keyHint}`);
        }

        try {
          const _t0 = Date.now();
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
          log("agent", `LLM response ← ${provider} | ${Date.now() - _t0}ms | status=ok`);

          // Success
          recordSuccess(correlationId);
          break;

        } catch (apiError) {
          const errCode  = apiError.status || apiError.code;
          const errMsg   = apiError.message || "";
          const isRetryable = [429, 502, 503, 529].includes(errCode)
            || /overloaded|timeout|rate.?limit|connection|fetch/i.test(errMsg);

          if (!isRetryable) {
            // Non-retryable error (auth, invalid request, etc.) — record + propagate
            if (provider === "minimax" && errCode === 401) {
              log("error", `MiniMax 401 — key invalid → switching to OpenRouter | msg=${errMsg.slice(0, 120)}`);
            } else {
              log("error", `LLM error ${provider} | status=${errCode} | msg=${errMsg.slice(0, 120)}`);
            }
            recordFailure(apiError, correlationId);
            throw apiError;
          }

          // Retryable: record failure, apply backoff, maybe trip circuit
          const justTripped = recordFailure(apiError, correlationId);

          if (attempt === MAX_ATTEMPTS - 1) {
            // Last attempt failed — circuit is now open (if it wasn't already)
            log("error", `All ${MAX_ATTEMPTS} attempts failed — circuit breaker may trip`, {
              lastError: errMsg.slice(0, 200),
              provider,
              correlationId: correlationId,
            });
            throw apiError;
          }

          const delay = getBackoffDelay(attempt);
          log("warn", `API error (${errCode}) — ${provider} retryable, backing off ${delay / 1000}s`, {
            attempt: attempt + 1,
            maxAttempts: MAX_ATTEMPTS,
            provider,
            correlationId: correlationId,
          });

          await circuitSleep(delay);
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }

      const msg = response.choices[0].message;

      // Repair malformed tool call JSON
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) {
          messages.pop();
          log("agent", "Empty response, retrying...");
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      // Execute tool calls in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing twice
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              blocked: true,
              reason: `${functionName} already attempted this session — do not retry.`,
            }),
          };
        }

        const result = await executeTool(functionName, functionArgs);

        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);

    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

/**
 * Lightweight single-turn LLM call — no tools, no agentLoop overhead.
 * Used for background tasks like post-trade chart lesson analysis.
 */
export async function callLLMDirect(userPrompt, { maxTokens = 200, systemPrompt = null } = {}) {
  const { model: usedModel } = getProviderConfig();
  const client = getClient();
  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });
    const resp = await client.chat.completions.create({
      model: usedModel,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4,
    });
    const content = resp?.choices?.[0]?.message?.content?.trim() ?? null;
    // Strip <think>...</think> reasoning traces (MiniMax M2.7 style)
    if (content) return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || content;
    return null;
  } catch (e) {
    log("agent", `callLLMDirect failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
