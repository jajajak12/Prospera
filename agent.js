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

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey:  process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || config.llm?.generalModel || "deepseek/deepseek-r1";

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
  maxOutputTokens = null
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
      const activeModel = model || DEFAULT_MODEL;
      const FALLBACK_CHAIN = [
        "deepseek/deepseek-v3.2",
        "stepfun/step-3.5-flash:free",
      ];
      let response;
      let usedModel = activeModel;
      let fallbackIndex = 0;

      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap)\b/i;
      const toolChoice = (step === 0 && agentType === "GENERAL" && ACTION_INTENTS.test(goal)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        response = await client.chat.completions.create({
          model: usedModel,
          messages,
          tools: getToolsForRole(agentType, goal),
          tool_choice: toolChoice,
          temperature: config.llm.temperature,
          max_tokens: maxOutputTokens ?? config.llm.maxTokens,
        });
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 429 || errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (fallbackIndex < FALLBACK_CHAIN.length) {
            fallbackIndex++;
            usedModel = FALLBACK_CHAIN[fallbackIndex - 1];
            log("agent", `Fallback ${fallbackIndex}: trying ${usedModel} (err ${errCode})`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, wait));
          }
        } else {
          break;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
