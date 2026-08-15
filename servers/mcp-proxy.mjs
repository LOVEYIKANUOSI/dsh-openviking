#!/usr/bin/env node

/**
 * stdio → streamable-HTTP MCP proxy for the OpenViking DeepSeek Harness plugin.
 *
 * dsh-openviking spawns this process as a local MCP server. The proxy reads the
 * same OpenViking credential sources as the lifecycle hooks (ovcli.conf → env →
 * ov.conf), forwards JSON-RPC requests to the server's /mcp endpoint, and keeps
 * stdout protocol-clean.
 */

import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createLogger } from "../lib/shared/debug-log.mjs";
import { createOpenVikingMcpProxy } from "../lib/shared/mcp-proxy-core.mjs";
import { resolveEffectivePeerId } from "../lib/shared/workspace-peer.mjs";

export { createOpenVikingMcpProxy } from "../lib/shared/mcp-proxy-core.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolvePath(join(homedir(), raw.slice(2)));
  return resolvePath(raw);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveDshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env.trim() : join(homedir(), ".dsh");
}

function readProxyConfig() {
  const cfg = loadConfig(resolvePath(fileURLToPath(import.meta.url), "..", ".."));
  const effectivePeer = resolveEffectivePeerId({ cfg, cwd: process.cwd() });
  const mcpUrl = cfg.mcpUrl || `${trimSlash(cfg.endpoint)}/mcp`;
  return {
    mcpUrl,
    apiKey: cfg.apiKey || "",
    account: cfg.account || "",
    user: cfg.user || "",
    peerId: effectivePeer.peerId,
    userAgent: cfg.userAgent || "",
    timeoutMs: Math.max(1000, Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS),
    debug: cfg.debug === true,
    debugLogPath: cfg.debug ? (cfg.debugLogPath || join(homedir(), ".openviking", "logs", "dsh-plugin-mcp.log")) : "",
    credentialSource: cfg.credentialSource || "auto",
    credentialPath: cfg.credentialPath || "",
    watchedPaths: uniq([
      cfg.credentialPath,
      cfg.configPath,
      normalizePath(process.env.OPENVIKING_CLI_CONFIG_FILE),
      normalizePath(process.env.OPENVIKING_CONFIG_FILE),
      normalizePath(process.env.OPENVIKING_PLUGIN_CONFIG),
      join(homedir(), ".openviking", "ovcli.conf"),
      join(homedir(), ".openviking", "ov.conf"),
      join(homedir(), ".openviking", "dsh-config.json"),
      join(resolveDshHome(), "openviking-config.json"),
    ]),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  createOpenVikingMcpProxy({ readConfig: readProxyConfig, loggerFactory: createLogger }).start();
}
