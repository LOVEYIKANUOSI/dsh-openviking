/**
 * dsh-openviking — 自动召回（DeepSeek Harness 版）。
 *
 * 在 agent/pre-step（每个 turn 的第一步）时，以本轮用户消息为查询调用
 * OpenViking 召回（优先 /api/v1/search/recall 端点，失败时回退到
 * find + 本地排序），把结果注入为一条 synthetic user 消息，
 * 与官方插件的 `<openviking-context>` 注入块格式一致。
 */

import { buildRecallBlock } from "./shared/recall-core.mjs";
import { isBypassed } from "./shared/session-model.mjs";
import { effectivePeerFor } from "./config.js";
import { fetchJSON, log } from "./utils.js";

/** 从 claimed 消息里提取用户文本（跳过 synthetic / plugin 来源）。 */
export function extractQuery(messages) {
  const texts = [];
  for (const message of messages ?? []) {
    if (!message || message.role !== "user") continue;
    if (message.source?.kind === "plugin") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== "text" || typeof block.text !== "string") continue;
      if (block.text.includes("<openviking-context")) return null;
      texts.push(block.text);
    }
  }
  const joined = texts.join(" ").trim();
  return joined || null;
}

export function createMemoryRecall({ config }) {
  /** agentId -> 已召回过的 turn 号（每 turn 只召回一次）。 */
  const recalledTurns = new Map();

  async function recallForStep(payload, messages, signal) {
    if (!config.autoRecall?.enabled) return null;
    const agentId = payload?.agent?.id;
    if (agentId == null) return null;
    if (recalledTurns.get(agentId) === payload.turn) return null;
    recalledTurns.set(agentId, payload.turn);

    const query = extractQuery(messages);
    if (!query) return null;
    if (query.length < config.minQueryLength) return null;

    const cwd = payload.agent?.session?.header?.cwd;
    if (isBypassed(config, { sessionId: agentId, cwd })) return null;
    if (signal?.aborted) return null;

    const health = await fetchJSON(config, "/health", {}, { timeoutMs: 5000, abortSignal: signal });
    if (!health.ok) return null;

    const actorPeerId = effectivePeerFor(config, cwd);
    const block = await buildRecallBlock(
      (path, init = {}, options = {}) => fetchJSON(config, path, init, {
        ...options,
        abortSignal: signal,
        timeoutMs: options.timeoutMs ?? 5000,
      }),
      config,
      query,
      {
        actorPeerId,
        log: (stage, data) => log("DEBUG", "recall", stage, data),
      },
    );
    if (block) {
      log("INFO", "recall", "Injected OpenViking context", {
        dsh_session: agentId,
        turn: payload.turn,
      });
    }
    return block;
  }

  function forgetAgent(agentId) {
    recalledTurns.delete(agentId);
  }

  return { recallForStep, forgetAgent };
}
