/**
 * dsh-openviking — DeepSeek Harness 的 OpenViking 记忆插件。
 *
 * 与官方 OpenCode / Codex 插件对齐的三项能力：
 *   1. 自动召回：每个 turn 的第一步，以用户消息为查询召回记忆并注入上下文；
 *   2. 增量捕获：会话事件火线把 user/assistant/tool 消息写入 OpenViking 会话，
 *      compaction 前与插件卸载时提交（commit）；
 *   3. MCP 工具：`mcp__openviking__<tool>` 模型可调工具（find/search/recall/
 *      remember 等），经 OpenViking stdio MCP proxy 转发。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, resolveDataDir } from "./config.js";
import { createMemorySessionManager } from "./memory-session.js";
import { createMemoryRecall } from "./memory-recall.js";
import { startMcpBridge } from "./mcp-bridge.js";
import { registerConfigRoutes } from "./config-http.js";
import { initLogger, log } from "./utils.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const name = "dsh-openviking";

/** 召回注入的合成消息（source 标记为 plugin，捕获与查询提取都会跳过它）。
 *  必须带非空 id：dsh 会话加载验证（assertMessageEventShape）要求
 *  user/message 携带 identified message，否则历史加载会以
 *  SessionPersistenceCorruptionError 拒绝整个会话。 */
function createRecallMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-openviking", form: "openviking-recall" },
  };
}

export function apply(ctx, config = {}) {
  const ovConfig = loadConfig(pluginRoot, config);
  const dataDir = resolveDataDir(pluginRoot, ovConfig);
  initLogger(dataDir, ovConfig.debug);
  log("INFO", "plugin", "OpenViking plugin starting", {
    endpoint: ovConfig.endpoint,
    credentialSource: ovConfig.credentialSource,
    dataDir,
    autoRecall: ovConfig.autoRecall.enabled,
    autoCapture: ovConfig.autoCapture,
    mcp: ovConfig.mcp?.enabled !== false,
  });

  // 设置页读写通道：无论插件是否 enabled 都注册，保证用户能从设置页改配置。
  // ovConfig 是所有闭包共享的可变对象，热重载时原地合并（Object.assign），
  // 凭据与行为改动即时生效；MCP proxy 子进程另行监听凭据文件自行重载。
  // 注意：ctx.effect 的回调立即执行，其返回值才是 dispose 时调用的 disposer。
  const disposeRoute = registerConfigRoutes({ ctx, pluginRoot, entryConfig: config, sharedConfig: ovConfig });
  ctx.effect(() => disposeRoute);

  if (!ovConfig.enabled) {
    log("INFO", "plugin", "OpenViking plugin is disabled in configuration");
    return;
  }

  const tools = ctx.get("tools");

  // ---- 会话管理：捕获 / commit ----
  const sessionManager = createMemorySessionManager({ config: ovConfig, dataDir });
  void sessionManager.init().catch((error) => {
    log("ERROR", "plugin", "Session manager init failed", { error: error?.message });
  });

  // 会话启动：派生 OpenViking 会话 id，服务器健康时重放落盘队列。
  ctx.on("agent/session-start", (payload) => {
    const id = payload?.agent?.id;
    if (!id) return;
    void sessionManager.handleSessionStart(id).catch((error) => {
      log("ERROR", "session", "Session start handling failed", { error: error?.message });
    });
  });

  // 会话事件火线：增量捕获 user/assistant/tool 消息，compaction/start 时 commit。
  ctx.on("session/event", (session, event) => {
    void sessionManager.handleSessionEvent(session, event).catch((error) => {
      log("ERROR", "event", "Session event handling failed", {
        error: error?.message,
        eventType: event?.type,
      });
    });
  });

  // ---- 自动召回：agent/pre-step waterfall ----
  const recall = createMemoryRecall({ config: ovConfig });
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind === "reject") return decision;
    if (payload?.step !== 1) return decision;
    if (payload?.signal?.aborted) return decision;
    try {
      const block = await recall.recallForStep(payload, decision.messages ?? payload.messages, payload.signal);
      if (block) {
        decision.messages = [createRecallMessage(block), ...(decision.messages ?? [])];
      }
    } catch (error) {
      log("WARN", "recall", "Auto recall failed", { error: error?.message ?? String(error) });
    }
    return decision;
  });

  // agent 销毁：清理召回去重状态。
  ctx.on("agent/disposed", (payload) => {
    if (payload?.agent?.id != null) recall.forgetAgent(payload.agent.id);
  });

  // ---- MCP 工具桥 ----
  let mcpBridge;
  if (tools && ovConfig.mcp?.enabled !== false) {
    mcpBridge = startMcpBridge({ ctx, config: ovConfig, pluginRoot });
    void mcpBridge.ready.catch((error) => {
      log("ERROR", "mcp", "MCP bridge startup failed", { error: error?.message ?? String(error) });
    });
  } else if (ovConfig.mcp?.enabled !== false) {
    log("WARN", "mcp", "No tool runtime in this composition; skipping OpenViking MCP tools");
  }

  // ---- dispose：提交所有未提交的捕获 ----
  ctx.on("dispose", () => {
    if (mcpBridge) void mcpBridge.dispose();
    void sessionManager.flushAll({ commit: true }).catch((error) => {
      log("ERROR", "plugin", "Final flush failed", { error: error?.message });
    });
  });

  log("INFO", "plugin", "OpenViking plugin active");
}
// 注意：不要导出 default —— loader 的 unwrapExports 会优先取 default，
// 使模块退化为裸函数并丢失 name 等导出元数据。
