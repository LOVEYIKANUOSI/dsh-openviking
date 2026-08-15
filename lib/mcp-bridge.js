/**
 * dsh-openviking — MCP 工具桥。
 *
 * 与官方 OpenCode/Codex 插件同款：把 OpenViking 的 stdio MCP proxy
 * （servers/mcp-proxy.mjs，转发到 OpenViking server 的 /mcp 端点）作为子进程
 * 拉起，经 MCP SDK 连接、发现工具，并注册到 harness 的 ctx.tools。
 * 模型看到 `mcp__openviking__<tool>` 形式的名字（与 dsh-mcp-client 的命名
 * 契约一致），凭据与生命周期钩子共享同一套解析链。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { log } from "./utils.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;
const GENERATION_CLOSE_TIMEOUT_MS = 5000;

/** 与 dsh-mcp-client 相同的公开名派生（64 字符、[A-Za-z0-9_-]）。 */
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/** MCP content 数组 → 文本投影（图片/资源/音频为占位符）。 */
function extractText(mcpContent, toolName) {
  const parts = [];
  for (const value of mcpContent ?? []) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      parts.push("[unsupported content type: unknown]");
      continue;
    }
    switch (value.type) {
      case "text":
        if (value.text !== undefined) parts.push(value.text);
        break;
      case "image":
        parts.push(`[image: ${value.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "audio":
        parts.push(`[audio: ${value.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "resource":
      case "resource_link":
        parts.push("[resource: content discarded]");
        break;
      default:
        parts.push(`[unsupported content type: ${value.type}]`);
    }
  }
  return parts.join("\n") || `(${toolName} returned no text content)`;
}

/** 规范输出声明：canonical 值为 { content, structuredContent? }。 */
function createOutput(rawName) {
  return {
    schema: {
      type: "object",
      properties: {
        content: { type: "array", items: {} },
        structuredContent: {},
      },
      required: ["content"],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: "text", text: extractText(value?.content, rawName) }];
    },
  };
}

/** 一个 MCP 工具的执行函数：永远用 rawName 发 tools/call。 */
function createExecutor(client, rawName, toolCallTimeoutMs) {
  return async (args, exec) => {
    const result = await client.callTool(
      { name: rawName, arguments: typeof args === "object" && args !== null ? args : {} },
      undefined,
      { signal: exec.signal, timeout: toolCallTimeoutMs },
    );
    if (!Array.isArray(result.content)) {
      const rendered = "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)";
      if (result.isError === true) throw new Error(typeof rendered === "string" ? rendered : "(no output)");
      return {
        content: [{ type: "text", text: typeof rendered === "string" ? rendered : "(no output)" }],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      };
    }
    const text = extractText(result.content, rawName);
    if (result.isError === true) throw new Error(text);
    return {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  };
}

/** 拉取工具列表并注册为一代（fetch 失败不动上一代）。 */
async function syncTools(client, toolsRuntime, serverName, toolCallTimeoutMs, previous) {
  const definitions = new Map();
  let cursor;
  do {
    const response = await client.listTools(cursor === undefined ? undefined : { cursor });
    log("DEBUG", "mcp", "syncTools listed tools", { count: response.tools.length, cursor: cursor ?? null });
    for (const tool of response.tools) {
      const publicName = publicToolName(serverName, tool.name);
      if (definitions.has(publicName)) {
        throw new Error(`openviking-mcp: server listed tool "${tool.name}" more than once`);
      }
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        output: createOutput(tool.name),
        execute: createExecutor(client, tool.name, toolCallTimeoutMs),
      });
    }
    cursor = response.nextCursor;
  } while (cursor);

  for (const dispose of previous.values()) dispose();
  const disposers = new Map();
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, toolsRuntime.register(definition));
    }
    log("INFO", "mcp", "syncTools registered tools", { count: disposers.size });
  } catch (error) {
    for (const dispose of disposers.values()) dispose();
    log("ERROR", "mcp", "tool registration failed", { error: String(error) });
    return new Map();
  }
  return disposers;
}

/**
 * 启动受监督的 MCP 连接，返回 { ready, dispose }。
 * ready 在首次连接 + 工具注册后 resolve；连接失败时按 2s 间隔重试，
 * dispose 后停止并注销全部工具。
 */
export function startMcpBridge({ ctx, config, pluginRoot }) {
  const serverName = config.mcp?.serverName || "openviking";
  const toolCallTimeoutMs = config.mcp?.toolCallTimeoutMs || 15000;
  const label = `openviking-mcp(${serverName})`;
  const proxyPath = resolve(pluginRoot, "servers", "mcp-proxy.mjs");
  // Cordis 4 的属性访问（ctx.tools）需要 inject 声明；这里用 ctx.get 读取
  // 运行时引用（主插件已确认其存在），闭包内只使用该引用。
  const toolsRuntime = ctx.get("tools");
  if (!toolsRuntime) {
    log("WARN", "mcp", "No tool runtime in this composition; skipping OpenViking MCP tools");
    return { ready: Promise.resolve(), dispose: async () => {}, proxyPath };
  }

  let disposed = false;
  let client;
  let disposers = new Map();
  let syncChain = Promise.resolve();
  let reconnectTimer = null;
  let readyResolve;
  const ready = new Promise((resolveReady) => {
    readyResolve = resolveReady;
  });
  let settled = false;
  let failedAttempts = 0;
  const MAX_ATTEMPTS = 10;

  function isCurrent(generation) {
    return !disposed && client === generation;
  }

  function enqueueSync(generation) {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return;
      disposers = await syncTools(generation, toolsRuntime, serverName, toolCallTimeoutMs, disposers);
    });
    syncChain = run.catch(() => {});
    return run;
  }

  function generationDown(generation) {
    if (!isCurrent(generation)) return;
    client = undefined;
    ctx.logger.warn(`${label}: connection lost, scheduling reconnect`);
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    failedAttempts += 1;
    if (failedAttempts > MAX_ATTEMPTS) {
      ctx.logger.error(`${label}: giving up after ${MAX_ATTEMPTS} failed attempts`);
      if (!settled) {
        settled = true;
        readyResolve(); // 工具缺失不阻塞 harness 启动；日志已说明原因。
      }
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => {
        ctx.logger.warn(`${label}: reconnect attempt failed: ${String(error)}`);
      });
    }, 2000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  async function connect() {
    const generation = new Client({ name: "dsh-openviking", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [proxyPath],
      env: { ...process.env },
    });
    transport.onclose = () => generationDown(generation);
    transport.onerror = (error) => {
      ctx.logger.warn(`${label}: transport error: ${String(error)}`);
    };
    client = generation;
    try {
      await generation.connect(transport);
      failedAttempts = 0;
      await enqueueSync(generation);
      ctx.logger.info(`${label}: connected, ${disposers.size} tool(s) registered`);
      log("INFO", "mcp", "MCP bridge connected", {
        serverName,
        proxyPath,
        toolCount: disposers.size,
      });
      if (!settled) {
        settled = true;
        readyResolve();
      }
    } catch (error) {
      if (isCurrent(generation)) {
        client = undefined;
      }
      try {
        await generation.close();
      } catch { /* already dead */ }
      ctx.logger.warn(`${label}: connect failed: ${String(error)}`);
      log("WARN", "mcp", "MCP bridge connect failed", { serverName, error: String(error) });
      scheduleReconnect();
    }
  }

  async function dispose() {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const current = client;
    client = undefined;
    for (const unregister of disposers.values()) {
      try {
        unregister();
      } catch { /* best effort */ }
    }
    disposers = new Map();
    if (current) {
      try {
        await Promise.race([
          current.close(),
          new Promise((resolveClose) => {
            const timer = setTimeout(resolveClose, GENERATION_CLOSE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch { /* best effort */ }
    }
    if (!settled) {
      settled = true;
      readyResolve();
    }
  }

  // 启动连接；ready 由调用方决定是否 await。
  connect().catch(() => { /* connect 内部自含重试与 ready 结算 */ });

  return { ready, dispose, proxyPath };
}
