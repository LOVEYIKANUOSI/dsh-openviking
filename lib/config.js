/**
 * dsh-openviking — 配置加载（DeepSeek Harness 版）。
 *
 * 行为配置与官方 OpenCode/Codex 插件保持一致（autoRecall / autoCapture /
 * commit 阈值等），凭据解析链完全复用 shared/credentials.mjs
 * （ovcli.conf → 环境变量 → ov.conf → 默认 http://127.0.0.1:1933）。
 *
 * 配置文件查找顺序（后者优先）：
 *   1. 插件目录内的 openviking-config.json（默认值）
 *   2. ~/.openviking/dsh-config.json
 *   3. $DSH_HOME/openviking-config.json
 *   4. 环境变量 OPENVIKING_PLUGIN_CONFIG 指名的 JSON 文件
 *
 * 运行时文件（状态、日志）默认在 ~/.openviking/dsh-plugin/ 下。
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  buildUserAgent,
  readManifestVersion,
  resolveOpenVikingCredentials,
} from "./shared/credentials.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";

const USER_AGENT = buildUserAgent(
  "dsh",
  readManifestVersion(new URL("../package.json", import.meta.url)),
);

const DEFAULT_CONFIG = {
  endpoint: "http://127.0.0.1:1933",
  apiKey: "",
  account: "",
  user: "",
  peerId: "",
  workspacePeer: true,
  recallPeerScope: "all",
  enabled: true,
  timeoutMs: 30000,
  mcp: {
    enabled: true,
    serverName: "openviking",
    toolCallTimeoutMs: 15000,
  },
  runtime: {
    dataDir: "",
  },
  autoRecall: {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.35,
    maxContentChars: 500,
    preferAbstract: true,
    tokenBudget: 2000,
    minQueryLength: 3,
  },
  autoCapture: true,
  captureMode: "semantic",
  captureMaxLength: 24000,
  captureAssistantTurns: true,
  captureToolMaxChars: 2000,
  commitTokenThreshold: 20000,
  commitKeepRecentCount: 10,
  bypassSession: false,
  bypassSessionPatterns: [],
  debug: false,
  debugLogPath: path.join(homedir(), ".openviking", "logs", "dsh-plugin.log"),
};

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function normalizeNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function envBool(name) {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  const lower = String(value).trim().toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  return undefined;
}

function str(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
  return value;
}

/** $DSH_HOME，缺省 ~/.dsh（与 @deepseek-ai/dsh-home-paths 一致）。 */
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env.trim() : path.join(homedir(), ".dsh");
}

function getConfigPaths(pluginRoot) {
  const paths = [];
  if (process.env.OPENVIKING_PLUGIN_CONFIG) paths.push(expandHome(process.env.OPENVIKING_PLUGIN_CONFIG));
  paths.push(path.join(resolveDshHome(), "openviking-config.json"));
  paths.push(path.join(homedir(), ".openviking", "dsh-config.json"));
  paths.push(path.join(pluginRoot, "openviking-config.json"));
  return paths;
}

function readConfigFile(pluginRoot) {
  for (const configPath of getConfigPaths(pluginRoot)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      return { path: configPath, data: JSON.parse(fs.readFileSync(configPath, "utf8")) };
    } catch (error) {
      console.warn(`[dsh-openviking] Failed to load config from ${configPath}:`, error);
    }
  }
  return { path: "", data: {} };
}

function applyLegacyConnection(config, fileConfig) {
  const hasLegacyCredentials = ["endpoint", "apiKey", "account", "user", "peerId"]
    .some((key) => fileConfig[key] !== undefined && fileConfig[key] !== "");
  if (!hasLegacyCredentials) return false;
  if (fileConfig.endpoint !== undefined) config.endpoint = fileConfig.endpoint;
  if (fileConfig.apiKey !== undefined) config.apiKey = fileConfig.apiKey;
  if (fileConfig.account !== undefined) config.account = fileConfig.account;
  if (fileConfig.user !== undefined) config.user = fileConfig.user;
  if (fileConfig.peerId !== undefined) config.peerId = fileConfig.peerId;
  return true;
}

function applyBehaviorConfig(config, fileConfig = {}) {
  if (fileConfig.enabled !== undefined) config.enabled = fileConfig.enabled !== false;
  if (fileConfig.timeoutMs !== undefined) config.timeoutMs = fileConfig.timeoutMs;
  config.runtime = { ...DEFAULT_CONFIG.runtime, ...(fileConfig.runtime ?? {}) };
  config.mcp = {
    ...DEFAULT_CONFIG.mcp,
    ...(typeof fileConfig.mcp === "object" && fileConfig.mcp !== null ? fileConfig.mcp : {}),
  };

  const autoRecall = fileConfig.autoRecall ?? {};
  config.autoRecall = {
    ...DEFAULT_CONFIG.autoRecall,
    ...autoRecall,
    enabled: autoRecall.enabled !== false,
    limit: autoRecall.limit ?? fileConfig.recallLimit ?? DEFAULT_CONFIG.autoRecall.limit,
    scoreThreshold: autoRecall.scoreThreshold ?? fileConfig.scoreThreshold ?? DEFAULT_CONFIG.autoRecall.scoreThreshold,
    maxContentChars: autoRecall.maxContentChars ?? fileConfig.recallMaxContentChars ?? DEFAULT_CONFIG.autoRecall.maxContentChars,
    preferAbstract: autoRecall.preferAbstract ?? fileConfig.recallPreferAbstract ?? DEFAULT_CONFIG.autoRecall.preferAbstract,
    tokenBudget: autoRecall.tokenBudget ?? fileConfig.recallTokenBudget ?? DEFAULT_CONFIG.autoRecall.tokenBudget,
    minQueryLength: autoRecall.minQueryLength ?? fileConfig.minQueryLength ?? DEFAULT_CONFIG.autoRecall.minQueryLength,
  };

  for (const key of [
    "autoCapture",
    "captureMode",
    "captureMaxLength",
    "captureAssistantTurns",
    "captureToolMaxChars",
    "commitTokenThreshold",
    "commitKeepRecentCount",
    "noAutoInject",
    "bypassSession",
    "bypassSessionPatterns",
    "debug",
    "debugLogPath",
    "workspacePeer",
    "recallPeerScope",
  ]) {
    if (fileConfig[key] !== undefined) config[key] = fileConfig[key];
  }
}

function applyEnv(config) {
  if (process.env.OPENVIKING_TIMEOUT_MS) config.timeoutMs = process.env.OPENVIKING_TIMEOUT_MS;
  if (process.env.OPENVIKING_AUTO_RECALL !== undefined) {
    config.autoRecall.enabled = envBool("OPENVIKING_AUTO_RECALL") ?? config.autoRecall.enabled;
  }
  if (process.env.OPENVIKING_RECALL_LIMIT) config.autoRecall.limit = process.env.OPENVIKING_RECALL_LIMIT;
  if (process.env.OPENVIKING_SCORE_THRESHOLD) config.autoRecall.scoreThreshold = process.env.OPENVIKING_SCORE_THRESHOLD;
  if (process.env.OPENVIKING_RECALL_MAX_CONTENT_CHARS) {
    config.autoRecall.maxContentChars = process.env.OPENVIKING_RECALL_MAX_CONTENT_CHARS;
  }
  if (process.env.OPENVIKING_RECALL_TOKEN_BUDGET) config.autoRecall.tokenBudget = process.env.OPENVIKING_RECALL_TOKEN_BUDGET;
  if (process.env.OPENVIKING_RECALL_PREFER_ABSTRACT !== undefined) {
    config.autoRecall.preferAbstract = envBool("OPENVIKING_RECALL_PREFER_ABSTRACT") ?? config.autoRecall.preferAbstract;
  }
  if (process.env.OPENVIKING_RECALL_PEER_SCOPE) config.recallPeerScope = process.env.OPENVIKING_RECALL_PEER_SCOPE;
  if (process.env.OPENVIKING_WORKSPACE_PEER !== undefined) {
    config.workspacePeer = envBool("OPENVIKING_WORKSPACE_PEER") ?? config.workspacePeer;
  }
  if (process.env.OPENVIKING_MIN_QUERY_LENGTH) config.autoRecall.minQueryLength = process.env.OPENVIKING_MIN_QUERY_LENGTH;
  if (process.env.OPENVIKING_AUTO_CAPTURE !== undefined) {
    config.autoCapture = envBool("OPENVIKING_AUTO_CAPTURE") ?? config.autoCapture;
  }
  if (process.env.OPENVIKING_CAPTURE_MODE) config.captureMode = process.env.OPENVIKING_CAPTURE_MODE;
  if (process.env.OPENVIKING_CAPTURE_MAX_LENGTH) config.captureMaxLength = process.env.OPENVIKING_CAPTURE_MAX_LENGTH;
  if (process.env.OPENVIKING_CAPTURE_ASSISTANT_TURNS !== undefined) {
    config.captureAssistantTurns = envBool("OPENVIKING_CAPTURE_ASSISTANT_TURNS") ?? config.captureAssistantTurns;
  }
  if (process.env.OPENVIKING_CAPTURE_TOOL_MAX_CHARS) {
    config.captureToolMaxChars = process.env.OPENVIKING_CAPTURE_TOOL_MAX_CHARS;
  }
  if (process.env.OPENVIKING_COMMIT_TOKEN_THRESHOLD) {
    config.commitTokenThreshold = process.env.OPENVIKING_COMMIT_TOKEN_THRESHOLD;
  }
  if (process.env.OPENVIKING_COMMIT_KEEP_RECENT_COUNT) {
    config.commitKeepRecentCount = process.env.OPENVIKING_COMMIT_KEEP_RECENT_COUNT;
  }
  if (process.env.OPENVIKING_BYPASS_SESSION !== undefined) {
    config.bypassSession = envBool("OPENVIKING_BYPASS_SESSION") ?? config.bypassSession;
  }
  if (process.env.OPENVIKING_BYPASS_SESSION_PATTERNS) {
    config.bypassSessionPatterns = process.env.OPENVIKING_BYPASS_SESSION_PATTERNS
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (process.env.OPENVIKING_DEBUG !== undefined) config.debug = envBool("OPENVIKING_DEBUG") ?? config.debug;
  if (process.env.OPENVIKING_DEBUG_LOG) config.debugLogPath = process.env.OPENVIKING_DEBUG_LOG;
}

function normalizeConfig(config) {
  config.endpoint = str(config.endpoint, DEFAULT_CONFIG.endpoint).replace(/\/+$/, "");
  config.baseUrl = config.endpoint;
  config.accountId = config.account;
  config.userId = config.user;
  config.userAgent = USER_AGENT;
  config.timeoutMs = normalizeNumber(config.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 300000);
  config.mcp.toolCallTimeoutMs = normalizeNumber(
    config.mcp.toolCallTimeoutMs,
    DEFAULT_CONFIG.mcp.toolCallTimeoutMs,
    1000,
    300000,
  );
  config.autoRecall.limit = Math.max(1, Math.min(50, Math.round(Number(config.autoRecall.limit) || 6)));
  config.autoRecall.scoreThreshold = Math.max(0, Math.min(1, Number(config.autoRecall.scoreThreshold) || 0));
  config.autoRecall.maxContentChars = Math.max(100, Math.min(5000, Math.round(Number(config.autoRecall.maxContentChars) || 500)));
  config.autoRecall.tokenBudget = Math.max(200, Math.min(50000, Math.round(Number(config.autoRecall.tokenBudget) || 2000)));
  config.autoRecall.minQueryLength = Math.max(1, Math.min(64, Math.round(Number(config.autoRecall.minQueryLength) || 3)));
  config.captureMode = config.captureMode === "keyword" ? "keyword" : "semantic";
  config.recallPeerScope = config.recallPeerScope === "actor" ? "actor" : "all";
  config.captureMaxLength = Math.max(200, Math.min(100000, Math.round(Number(config.captureMaxLength) || 24000)));
  config.captureToolMaxChars = Math.max(200, Math.min(20000, Math.round(Number(config.captureToolMaxChars) || 2000)));
  config.commitTokenThreshold = Math.max(1000, Math.round(Number(config.commitTokenThreshold) || 20000));
  const rawCommitKeepRecentCount = config.commitKeepRecentCount;
  const commitKeepRecentCount = rawCommitKeepRecentCount == null ||
    (typeof rawCommitKeepRecentCount === "string" && rawCommitKeepRecentCount.trim() === "")
    ? Number.NaN
    : Number(rawCommitKeepRecentCount);
  config.commitKeepRecentCount = Number.isFinite(commitKeepRecentCount)
    ? Math.max(0, Math.round(commitKeepRecentCount))
    : DEFAULT_CONFIG.commitKeepRecentCount;
  if (!Array.isArray(config.bypassSessionPatterns)) config.bypassSessionPatterns = [];

  // recall-core 用的扁平别名（与官方插件同一套命名）。
  config.recallLimit = config.autoRecall.limit;
  config.scoreThreshold = config.autoRecall.scoreThreshold;
  config.recallMaxContentChars = config.autoRecall.maxContentChars;
  config.recallPreferAbstract = config.autoRecall.preferAbstract !== false;
  config.recallTokenBudget = config.autoRecall.tokenBudget;
  config.minQueryLength = config.autoRecall.minQueryLength;
  return config;
}

/**
 * 加载并归一化配置。默认凭据来自 shared/credentials.mjs 的完整解析链，
 * 只有旧式（openviking-config.json 内嵌连接字段）才需要文件覆盖。
 *
 * @param pluginRoot - 插件包根目录。
 * @param entryConfig - cordis.yml 条目上用户按 id 覆盖的配置（可选）。
 * @returns 归一化后的配置对象。
 */
export function loadConfig(pluginRoot, entryConfig = {}) {
  const config = cloneDefaultConfig();
  const { path: configPath, data: fileConfig } = readConfigFile(pluginRoot);
  applyBehaviorConfig(config, fileConfig);
  if (entryConfig && typeof entryConfig === "object") applyBehaviorConfig(config, entryConfig);

  const creds = resolveOpenVikingCredentials();
  config.endpoint = creds.baseUrl;
  config.apiKey = creds.apiKey;
  config.account = creds.account;
  config.user = creds.user;
  config.peerId = creds.peerId;
  config.mcpUrl = creds.mcpUrl;
  config.credentialSource = creds.credentialSource;
  config.credentialPath = creds.cliPath || creds.ovPath || "";

  const mayUseLegacyCredentials = creds.credentialSource !== "env" &&
    creds.credentialSource !== "ovcli" &&
    !creds.apiKey &&
    !creds.account &&
    !creds.user &&
    !creds.peerId;
  const legacyUsed = mayUseLegacyCredentials ? applyLegacyConnection(config, fileConfig) : false;
  applyEnv(config);
  config.configPath = configPath;
  config.legacyCredentialsUsed = legacyUsed && creds.credentialSource !== "env";
  const normalized = normalizeConfig(config);
  normalized.effectivePeer = resolveEffectivePeerId({ cfg: normalized, cwd: process.cwd() });
  return normalized;
}

/** 插件数据目录（会话状态文件、日志）。 */
export function resolveDataDir(pluginRoot, config) {
  const configured = config.runtime?.dataDir;
  if (configured) return expandHome(configured);
  return path.join(homedir(), ".openviking", "dsh-plugin");
}

/** 按会话 cwd 重新派生 actor peer（召回/捕获时调用）。 */
export function effectivePeerFor(config, cwd) {
  const resolved = resolveEffectivePeerId({ cfg: config, cwd: cwd || process.cwd() });
  return resolved.peerId;
}
