/**
 * dsh-openviking — 会话管理（DeepSeek Harness 版）。
 *
 * 与官方 OpenCode/Codex 插件行为对齐：
 *   - 每个 DSH 会话派生一个 OpenViking 会话 id：`ds-<session-id>`；
 *   - 通过 session/event 火线增量捕获 user/assistant/tool 消息；
 *   - 每轮结束（turn/end）与阈值触发 flush；
 *   - compaction/start 与插件卸载时强制 commit（提交给记忆抽取器）；
 *   - OpenViking 不可达时写入 ~/.openviking/pending/ 落盘队列。
 */

import fs from "node:fs";
import path from "node:path";
import {
  extractPartsFromPayload,
  extractTextFromPayload,
  shouldCaptureText,
} from "./shared/capture-utils.mjs";
import { deriveHarnessSessionId, isBypassed } from "./shared/session-model.mjs";
import { enqueue, replayPending } from "./shared/pending-queue.mjs";
import { sendSessionMessages } from "./shared/batch-send.mjs";
import { effectivePeerFor } from "./config.js";
import { fetchJSON, log, safeStringify } from "./utils.js";

/** 插件注入的合成消息（召回上下文）不参与捕获。 */
function isSyntheticMessage(message) {
  return message?.source?.kind === "plugin" && message.source.plugin === "dsh-openviking";
}

export function createMemorySessionManager({ config, dataDir }) {
  const sessions = new Map();
  const statePath = path.join(dataDir, "openviking-session-state.json");
  let saveTimer = null;

  async function init() {
    await loadState();
    const health = await fetchJSON(config, "/health", {}, { timeoutMs: 5000 });
    if (health.ok) {
      await replayPending(
        (endpoint, init = {}, options = {}) => fetchJSON(config, endpoint, init, options),
        (stage, data) => log("DEBUG", "pending", stage, data),
      );
    }
  }

  async function loadState() {
    try {
      if (!fs.existsSync(statePath)) return;
      const data = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
      if (data.version !== 1) {
        log("ERROR", "persistence", "Unsupported session map version", { version: data.version });
        return;
      }
      for (const [dshSessionId, persisted] of Object.entries(data.sessions ?? {})) {
        sessions.set(dshSessionId, deserializeSessionState(persisted));
      }
      log("INFO", "persistence", "Session state loaded", { count: sessions.size });
    } catch (error) {
      log("ERROR", "persistence", "Failed to load session state", { error: error?.message });
      if (fs.existsSync(statePath)) {
        await fs.promises.rename(statePath, `${statePath}.corrupted.${Date.now()}`);
      }
    }
  }

  async function saveState() {
    try {
      const persisted = {};
      for (const [dshSessionId, state] of sessions.entries()) {
        persisted[dshSessionId] = serializeSessionState(state);
      }
      const tempPath = `${statePath}.tmp`;
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify({ version: 1, sessions: persisted, lastSaved: Date.now() }, null, 2),
        "utf8",
      );
      await fs.promises.rename(tempPath, statePath);
    } catch (error) {
      log("ERROR", "persistence", "Failed to save session state", { error: error?.message });
    }
  }

  function debouncedSaveState() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveState().catch((error) => {
        log("ERROR", "persistence", "Debounced save failed", { error: error?.message });
      });
    }, 300);
  }

  function serializeSessionState(state) {
    return {
      ovSessionId: state.ovSessionId,
      createdAt: state.createdAt,
      lastActivityAt: state.lastActivityAt,
      lastCommitTime: state.lastCommitTime,
      compactedAt: state.compactedAt,
      messages: Array.from(state.messages.entries()).map(([seq, message]) => [
        seq,
        { role: message.role, captured: message.captured, body: message.body },
      ]),
    };
  }

  function deserializeSessionState(persisted) {
    return {
      ovSessionId: persisted.ovSessionId,
      createdAt: persisted.createdAt,
      lastActivityAt: persisted.lastActivityAt,
      lastCommitTime: persisted.lastCommitTime,
      compactedAt: persisted.compactedAt,
      messages: new Map((persisted.messages ?? []).map(([seq, message]) => [
        seq,
        { role: message.role, captured: Boolean(message.captured), body: message.body },
      ])),
    };
  }

  function createSessionState(dshSessionId) {
    return {
      ovSessionId: deriveHarnessSessionId("ds-", dshSessionId),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastCommitTime: undefined,
      compactedAt: undefined,
      messages: new Map(),
    };
  }

  function getOrCreateSession(dshSessionId) {
    let state = sessions.get(dshSessionId);
    if (!state) {
      state = createSessionState(dshSessionId);
      sessions.set(dshSessionId, state);
      debouncedSaveState();
      log("INFO", "session", "OpenViking session derived", {
        dsh_session: dshSessionId,
        openviking_session: state.ovSessionId,
      });
    }
    return state;
  }

  /** agent/session-start：确保映射存在，并在服务器健康时重放落盘队列。 */
  async function handleSessionStart(dshSessionId) {
    if (!dshSessionId) return;
    getOrCreateSession(dshSessionId);
    const health = await fetchJSON(config, "/health", {}, { timeoutMs: 5000 });
    if (health.ok) {
      await replayPending(
        (endpoint, init = {}, options = {}) => fetchJSON(config, endpoint, init, options),
        (stage, data) => log("DEBUG", "pending", stage, data),
      );
    }
  }

  /** session/event 火线入口；由主插件转发。 */
  async function handleSessionEvent(session, event) {
    if (!event || typeof event !== "object") return;
    if (!config.autoCapture && event.type !== "compaction/start") return;

    const dshSessionId = session?.id;
    const cwd = session?.header?.cwd;
    const bypassed = isBypassed(config, { sessionId: dshSessionId, cwd });
    switch (event.type) {
      case "user/message": {
        if (!config.autoCapture || bypassed || !dshSessionId) return;
        if (isSyntheticMessage(event.data)) return;
        recordMessage(dshSessionId, event.seq, event.data, "user", cwd);
        await flushSession(dshSessionId, { commit: false, reason: "user/message" });
        break;
      }
      case "assistant/message": {
        if (!config.autoCapture || bypassed || !dshSessionId) return;
        const message = event.data?.message;
        if (!message || isSyntheticMessage(message)) return;
        recordMessage(dshSessionId, event.seq, message, "assistant", cwd);
        break;
      }
      case "tool/result": {
        if (!config.autoCapture || bypassed || !dshSessionId) return;
        const message = event.data?.message;
        if (!message) return;
        // 工具结果按 user 侧捕获（与官方插件一致）。
        recordMessage(dshSessionId, event.seq, message, "user", cwd);
        break;
      }
      case "turn/end": {
        if (!bypassed && dshSessionId) {
          await flushSession(dshSessionId, { commit: false, reason: "turn/end" });
        }
        break;
      }
      case "compaction/start": {
        if (!dshSessionId) return;
        const state = sessions.get(dshSessionId);
        if (!state) return;
        state.compactedAt = Date.now();
        await flushSession(dshSessionId, { commit: true, reason: "compaction/start" });
        break;
      }
      default: break;
    }
  }

  function recordMessage(dshSessionId, seq, message, role, cwd) {
    const state = getOrCreateSession(dshSessionId);
    if (state.messages.has(seq)) return;
    if (role === "assistant" && !config.captureAssistantTurns) return;
    const body = buildCapturePayload(message, role, cwd);
    state.messages.set(seq, { role, captured: false, body });
    state.lastActivityAt = Date.now();
    debouncedSaveState();
  }

  function buildCapturePayload(message, role, cwd) {
    if (!message || typeof message !== "object") return null;
    if (role === "assistant" && !config.captureAssistantTurns) return null;

    const rawText = extractTextFromPayload(message, { toolMaxChars: config.captureToolMaxChars });
    const captureParts = extractPartsFromPayload(message, {
      toolMaxChars: config.captureToolMaxChars,
    });
    const decision = shouldCaptureText(rawText, role, config);
    if (!decision.shouldCapture && captureParts.length === 0) return null;
    const body = captureParts.length > 0
      ? { role, parts: captureParts }
      : { role, content: decision.text };
    const peerId = effectivePeerFor(config, cwd);
    if (peerId) body.peer_id = peerId;
    return body;
  }

  async function flushSession(dshSessionId, { commit = false, reason = "manual" } = {}) {
    if (!dshSessionId) return false;
    const state = sessions.get(dshSessionId);
    if (!state) return false;

    const added = await flushPendingMessages(dshSessionId, state);
    if (commit && config.autoCapture) {
      await commitOvSession(state.ovSessionId, { force: true, reason });
    } else if (added > 0) {
      await maybeCommitByThreshold(state);
    }
    await saveState();
    return true;
  }

  async function flushAll({ commit = false } = {}) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    for (const dshSessionId of sessions.keys()) {
      await flushSession(dshSessionId, { commit, reason: "flushAll" });
    }
    await saveState();
  }

  async function flushPendingMessages(dshSessionId, state) {
    if (!config.autoCapture) return 0;
    const toSend = [];
    for (const [seq, entry] of state.messages.entries()) {
      if (entry.captured) continue;
      if (!entry.body) {
        entry.captured = true;
        continue;
      }
      toSend.push({ seq, entry });
    }
    if (toSend.length === 0) return 0;

    let added = 0;
    const health = await fetchJSON(config, "/health", {}, { timeoutMs: 5000 });
    if (!health.ok) {
      for (const item of toSend) {
        const queued = await enqueue("addMessage", state.ovSessionId, item.entry.body);
        if (!queued.ok) break;
        item.entry.captured = true;
        added += 1;
      }
    } else {
      const res = await sendSessionMessages(
        (endpoint, init = {}, options = {}) => fetchJSON(config, endpoint, init, { timeoutMs: 10000, ...options }),
        state.ovSessionId,
        toSend.map((item) => item.entry.body),
        { enqueueOnRetryable: true },
      );
      added = res.sent + res.queued;
      for (const item of toSend.slice(0, added)) {
        item.entry.captured = true;
      }
      if (res.failed > 0 || res.enqueueFailed > 0) {
        log("ERROR", "message", "Failed to add message to OpenViking session", {
          openviking_session: state.ovSessionId,
          status: res.lastError?.status,
          failed: res.failed,
          enqueueFailed: res.enqueueFailed,
        });
      }
    }
    if (added > 0) {
      state.lastActivityAt = Date.now();
      debouncedSaveState();
    }
    return added;
  }

  async function maybeCommitByThreshold(state) {
    if (config.commitTokenThreshold <= 0) return { committed: false };
    const meta = await fetchJSON(config, `/api/v1/sessions/${encodeURIComponent(state.ovSessionId)}`, {}, {
      timeoutMs: 5000,
    });
    const pendingTokens = Number(meta.result?.pending_tokens || 0);
    log("DEBUG", "session", "Pending token check", {
      openviking_session: state.ovSessionId,
      pendingTokens,
      threshold: config.commitTokenThreshold,
    });
    if (!meta.ok || pendingTokens < config.commitTokenThreshold) return { committed: false, pendingTokens };
    return commitOvSession(state.ovSessionId, { force: true, reason: "threshold" });
  }

  async function commitOvSession(ovSessionId, { force = false, reason = "manual", abortSignal } = {}) {
    if (!force && config.commitTokenThreshold <= 0) return { status: "skipped" };
    const body = { keep_recent_count: config.commitKeepRecentCount };
    const res = await fetchJSON(config, `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/commit`, {
      method: "POST",
      body: JSON.stringify(body),
    }, { timeoutMs: 30000, abortSignal });
    if (res.ok) {
      for (const state of sessions.values()) {
        if (state.ovSessionId === ovSessionId) state.lastCommitTime = Date.now();
      }
      log("INFO", "session", "Committed OpenViking session", { openviking_session: ovSessionId, reason });
      return { status: "accepted", result: res.result };
    }
    if (isRetryableFailure(res)) {
      await enqueue("commitSession", ovSessionId, body);
      log("WARN", "session", "Queued OpenViking session commit", { openviking_session: ovSessionId, reason });
      return { status: "queued" };
    }
    log("ERROR", "session", "Failed to commit OpenViking session", {
      openviking_session: ovSessionId,
      error: safeStringify(res.error),
    });
    throw new Error(`Failed to commit OpenViking session ${ovSessionId}: ${res.error?.message || res.status}`);
  }

  function isRetryableFailure(res) {
    if (!res || res.ok) return false;
    const status = Number(res.status || 0);
    return !status || status >= 500 || status === 408 || status === 429;
  }

  return {
    init,
    handleSessionStart,
    handleSessionEvent,
    flushAll,
    flushSession,
    getMappedSessionId: (dshSessionId) => getOrCreateSession(dshSessionId).ovSessionId,
  };
}
