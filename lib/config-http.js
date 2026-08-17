/**
 * dsh-openviking — 设置页 HTTP 通道。
 *
 * DSH 的 settings 域对第三方插件有显式白名单（settings-not-exposed），
 * 因此插件自建一个 exact 路由作为浏览器设置页的读写通道：
 *
 *   GET  /api/openviking/config   返回脱敏后的当前生效配置
 *   POST /api/openviking/config   保存凭据（ovcli.conf）与行为配置
 *                                 （dsh-config.json），随后热重载
 *
 * 凭据只沿一个方向跨越协议：GET 永远不回传 apiKey 值（只回 hasApiKey）。
 * 路由经 webServer 注册（exact 优先于 /api 前缀的 gateway），
 * headless 组装没有 webServer 时自动跳过。
 *
 * 安全：所有方法都要求自定义 header `x-dsh-openviking: 1`。自定义 header
 * 会触发浏览器 CORS preflight，跨站页面无法携带，因此同时挡住 CSRF 写入
 * （改 endpoint 把带 apiKey 的请求导流到攻击者服务器）与跨站读取。
 */

import {
  BEHAVIOR_FIELDS,
  reloadSharedConfig,
  saveBehaviorConfig,
  saveCredentials,
} from "./config.js";
import { log } from "./utils.js";

const ROUTE = "/api/openviking/config";

/** CSRF 守卫：自定义 header 触发 CORS preflight，跨站页面无法携带。 */
const GUARD_HEADER = "x-dsh-openviking";
const GUARD_HEADER_VALUE = "dsh-openviking";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** 校验守卫 header；不通过则 403 并返回 false。 */
function guarded(req, res) {
  if (req.headers[GUARD_HEADER] === GUARD_HEADER_VALUE) return true;
  sendJson(res, 403, { ok: false, error: "forbidden" });
  return false;
}

/** 脱敏视图：apiKey 只回 hasApiKey，其余字段照实返回。 */
function sanitizeConfig(cfg) {
  return {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    hasApiKey: Boolean(cfg.apiKey),
    account: cfg.account,
    user: cfg.user,
    credentialSource: cfg.credentialSource,
    configPath: cfg.configPath,
    timeoutMs: cfg.timeoutMs,
    autoRecall: { ...cfg.autoRecall },
    autoCapture: cfg.autoCapture,
    captureMode: cfg.captureMode,
    captureMaxLength: cfg.captureMaxLength,
    captureAssistantTurns: cfg.captureAssistantTurns,
    captureToolMaxChars: cfg.captureToolMaxChars,
    commitTokenThreshold: cfg.commitTokenThreshold,
    commitKeepRecentCount: cfg.commitKeepRecentCount,
    recallPeerScope: cfg.recallPeerScope,
    workspacePeer: cfg.workspacePeer,
    bypassSession: cfg.bypassSession,
    bypassSessionPatterns: [...cfg.bypassSessionPatterns],
    debug: cfg.debug,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** 校验并提取行为字段；返回 { section, errors }。 */
function extractBehavior(body) {
  const section = {};
  const errors = [];
  for (const key of BEHAVIOR_FIELDS) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === "autoRecall") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push("autoRecall 必须是对象");
        continue;
      }
      const recall = {};
      for (const [name, item] of Object.entries(value)) {
        if (item === null || item === undefined) continue;
        recall[name] = item;
      }
      section.autoRecall = recall;
      continue;
    }
    if (key === "bypassSessionPatterns") {
      if (!Array.isArray(value)) {
        errors.push("bypassSessionPatterns 必须是数组");
        continue;
      }
      section.bypassSessionPatterns = value.map(String);
      continue;
    }
    section[key] = value;
  }
  return { section, errors };
}

/**
 * 注册设置页路由。loader 并发挂载条目，插件 apply 时 webServer 可能
 * 尚未就绪：先尝试一次，再监听 internal/service 事件补注册。
 * headless 组装没有 webServer，永远不注册。
 * @param {object} deps - { ctx, pluginRoot, entryConfig, sharedConfig }
 * @returns 路由 disposer（无 webServer 的组装返回 null）。
 */
export function registerConfigRoutes({ ctx, pluginRoot, entryConfig, sharedConfig }) {
  const handler = async (req, res) => {
    try {
      if (!guarded(req, res)) return;
      if (req.method === "GET" || req.method === "HEAD") {
        const payload = JSON.stringify({ ok: true, config: sanitizeConfig(sharedConfig) });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : payload);
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (body === null) {
          sendJson(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
          return;
        }

        const errors = [];
        if (body.url !== undefined && body.url !== "") {
          try {
            const parsed = new URL(body.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") errors.push("url 必须以 http:// 或 https:// 开头");
          } catch {
            errors.push("url 格式无效");
          }
        }
        for (const key of ["account", "user", "apiKey"]) {
          if (body[key] !== undefined && typeof body[key] !== "string") errors.push(`${key} 必须是字符串`);
        }
        const { section: behavior, errors: behaviorErrors } = extractBehavior(body);
        errors.push(...behaviorErrors);
        if (errors.length > 0) {
          sendJson(res, 400, { ok: false, errors });
          return;
        }

        const credentialFields = ["url", "apiKey", "account", "user"];
        if (credentialFields.some((key) => body[key] !== undefined)) {
          saveCredentials({
            url: body.url,
            apiKey: body.apiKey,
            account: body.account,
            user: body.user,
          });
          log("INFO", "config", "Credentials saved via settings page", {
            url: body.url === undefined ? "(unchanged)" : body.url,
            apiKey: body.apiKey === undefined ? "(unchanged)" : Boolean(body.apiKey) ? "(set)" : "(cleared)",
          });
        }
        if (Object.keys(behavior).length > 0) {
          saveBehaviorConfig(behavior);
          log("INFO", "config", "Behavior config saved via settings page", {
            fields: Object.keys(behavior),
          });
        }

        reloadSharedConfig(sharedConfig, pluginRoot, entryConfig);
        sendJson(res, 200, { ok: true, config: sanitizeConfig(sharedConfig) });
        return;
      }

      sendJson(res, 405, { ok: false, error: "method not allowed" });
    } catch (error) {
      log("ERROR", "config", "Config HTTP route failed", { error: error?.message ?? String(error) });
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
      } else {
        res.destroy();
      }
    }
  };

  let disposer = null;
  let registered = false;
  let stopped = false;
  const timers = [];

  const tryRegister = () => {
    if (registered || stopped) return;
    const webServer = ctx.get("webServer");
    if (!webServer) return;
    registered = true;
    disposer = webServer.register({ kind: "exact", path: ROUTE, handler });
    log("INFO", "config", "Registered config HTTP route", { route: ROUTE });
  };

  // loader 并发挂载条目，apply 时 webServer 可能尚未激活。
  // 无条件启动短间隔重试；几轮后（树已 settle）若配置树里仍没有
  // webserver 条目（headless 组装），则停止重试。
  const hasWebServerRow = () => {
    const loader = ctx.get("loader");
    if (!loader) return false;
    for (const entry of loader.entries()) {
      if (entry.options.name === "@deepseek-ai/dsh-host-webserver") return true;
    }
    return false;
  };

  let attempts = 0;
  const MAX_ATTEMPTS = 40; // 40 × 250ms = 10s
  const TREE_SETTLE_ATTEMPTS = 4; // 约 1s 后 loader 树已挂完
  const scheduleRetry = () => {
    if (stopped) return;
    const timer = setTimeout(() => {
      if (stopped) return;
      tryRegister();
      if (!registered) {
        attempts += 1;
        if (attempts >= TREE_SETTLE_ATTEMPTS && !hasWebServerRow()) {
          log("INFO", "config", "Composition has no web server row; config HTTP route not registered");
          return;
        }
        if (attempts < MAX_ATTEMPTS) scheduleRetry();
        else log("WARN", "config", "webServer did not become available; config HTTP route not registered");
      }
    }, 250);
    timers.push(timer);
  };

  tryRegister();
  scheduleRetry();

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    if (disposer) {
      disposer();
      disposer = null;
    }
  };
}
