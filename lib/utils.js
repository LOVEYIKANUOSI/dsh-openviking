/**
 * dsh-openviking — HTTP 与日志工具（DSH 版）。
 * fetchJSON 与官方插件行为一致：鉴权头、超时、失败统一为
 * `{ ok, status, result? , error? }`，便于 shared 模块直接消费。
 */

import fs from "node:fs";
import path from "node:path";

let logFilePath = null;

export function initLogger(dataDir, debug = false) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    logFilePath = path.join(dataDir, "openviking-memory.log");
    if (debug) console.log(`[dsh-openviking] log file: ${logFilePath}`);
  } catch {
    logFilePath = null;
  }
}

export function safeStringify(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => safeStringify(item));
  const result = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === "function") {
      result[key] = "[Function]";
    } else if (typeof item === "object" && item !== null) {
      try {
        result[key] = safeStringify(item);
      } catch {
        result[key] = "[Circular or Non-serializable]";
      }
    } else {
      result[key] = item;
    }
  }
  return result;
}

export function log(level, toolName, message, data) {
  const normalizedLevel = String(level || "INFO").toUpperCase();
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    tool: toolName,
    message,
    ...(data ? { data: safeStringify(data) } : {}),
  };
  if (!logFilePath) {
    if (normalizedLevel === "ERROR") console.error(`[dsh-openviking] ${message}`, data ?? "");
    return;
  }
  try {
    fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write OpenViking plugin log:", error);
  }
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "");
}

function makeAuthHeaders(config, headers = {}, actorPeerId = "") {
  const result = { ...headers };
  if (config.apiKey) result["Authorization"] = `Bearer ${config.apiKey}`;
  if (config.account) result["X-OpenViking-Account"] = config.account;
  if (config.user) result["X-OpenViking-User"] = config.user;
  const peerId = String(actorPeerId || "").trim();
  if (peerId) result["X-OpenViking-Actor-Peer"] = peerId;
  if (config.userAgent) result["User-Agent"] = config.userAgent;
  return result;
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * GET/POST OpenViking HTTP API。
 *
 * @param {object} config - loadConfig 结果
 * @param {string} endpoint - 如 "/health"
 * @param {object} init - fetch init（不含 headers/signal）
 * @param {object} options - { timeoutMs, actorPeerId, abortSignal }
 */
export async function fetchJSON(config, endpoint, init = {}, options = {}) {
  const url = `${normalizeEndpoint(config.endpoint)}${endpoint}`;
  const headers = makeAuthHeaders(
    config,
    { "Content-Type": "application/json", ...(init.headers ?? {}) },
    options.actorPeerId,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs);
  let onAbort = null;
  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    const payload = text ? parseJsonOrText(text) : {};
    if (!response.ok || payload?.status === "error") {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || payload?.message || { message: `HTTP ${response.status}` },
      };
    }
    return { ok: true, status: response.status, result: payload?.result ?? payload };
  } catch (error) {
    return { ok: false, status: 0, error: { message: error?.message ?? String(error) } };
  } finally {
    clearTimeout(timeout);
    if (onAbort) options.abortSignal?.removeEventListener("abort", onAbort);
  }
}
