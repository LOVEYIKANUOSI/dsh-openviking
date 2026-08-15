/**
 * dsh-openviking 端到端验证脚本（临时，验证后删除或保留为 tests/）。
 * 驱动 memory-session 与 memory-recall 的真实 HTTP 路径：
 *   1. 捕获 user/assistant/tool 消息到 OpenViking 会话；
 *   2. flush + commit；
 *   3. 召回注入。
 */
import { loadConfig } from "../lib/config.js";
import { createMemorySessionManager } from "../lib/memory-session.js";
import { createMemoryRecall } from "../lib/memory-recall.js";
import { initLogger } from "../lib/utils.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(pluginRoot, {});
config.runtime.dataDir = join(tmpdir(), "dsh-openviking-verify");
initLogger(config.runtime.dataDir, true);

const TEST_SESSION = "verify-e2e-session";

function makeSession(id) {
  return { id, header: { cwd: "C:\\verify-workspace" } };
}

function makeMessageEvent(session, seq, type, message) {
  if (type === "user/message") return { type, seq, data: message, surfaceOp: "append" };
  if (type === "tool/result") return { type, seq, data: { message }, surfaceOp: "append", sourceEventSeqs: [seq - 1] };
  return { type, seq, data: { message, usage: { inputTokens: 10, outputTokens: 20 } }, surfaceOp: "append" };
}

const manager = createMemorySessionManager({ config, dataDir: config.runtime.dataDir });
const recall = createMemoryRecall({ config });

await manager.init();

// 1. 会话启动
await manager.handleSessionStart(TEST_SESSION);
const ovSessionId = manager.getMappedSessionId(TEST_SESSION);
console.log(`[1] OV session derived: ${ovSessionId}`);

// 2. 捕获 user 消息
await manager.handleSessionEvent(
  makeSession(TEST_SESSION),
  makeMessageEvent(null, 1, "user/message", {
    role: "user",
    content: [{ type: "text", text: "请记住：我的项目偏好用双空格缩进。" }],
  }),
);
console.log("[2] user message captured");

// 3. 捕获 assistant 消息（含 tool-call）
await manager.handleSessionEvent(
  makeSession(TEST_SESSION),
  makeMessageEvent(null, 2, "assistant/message", {
    role: "assistant",
    content: [
      { type: "text", text: "收到，我会记住你的缩进偏好。" },
      { type: "tool-call", id: "call-1", name: "remember", arguments: "{\"content\":\"偏好双空格缩进\"}" },
    ],
  }),
);
console.log("[3] assistant message captured");

// 4. 工具结果（user 侧）
await manager.handleSessionEvent(
  makeSession(TEST_SESSION),
  makeMessageEvent(null, 3, "tool/result", {
    role: "user",
    content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "stored ok" }] }],
  }),
);
console.log("[4] tool result captured");

// 5. flush（turn/end 触发）
await manager.handleSessionEvent(makeSession(TEST_SESSION), { type: "turn/end", seq: 4, data: { turn: 1 } });
console.log("[5] flushed at turn/end");

// 6. 验证消息已到远程（读取会话详情）
const { fetchJSON } = await import("../lib/utils.js");
const meta = await fetchJSON(config, `/api/v1/sessions/${encodeURIComponent(ovSessionId)}`, {});
console.log(`[6] remote session meta: ok=${meta.ok} pending_tokens=${meta.result?.pending_tokens ?? "?"}`);

// 7. commit（compaction/start 触发）
await manager.handleSessionEvent(makeSession(TEST_SESSION), {
  type: "compaction/start",
  seq: 5,
  data: { sourceCommandId: "verify" },
});
console.log("[7] committed at compaction/start");

// 8. 召回
const fakePayload = {
  agent: { id: TEST_SESSION, session: { header: { cwd: "C:\\verify-workspace" } } },
  turn: 1,
  step: 1,
  signal: undefined,
};
const fakeMessages = [{ role: "user", content: [{ type: "text", text: "缩进偏好是什么？" }] }];
const block = await recall.recallForStep(fakePayload, fakeMessages, undefined);
console.log(`[8] recall block (${block ? block.length : 0} chars):`);
console.log(block ? block.slice(0, 300) : "(none)");

// 9. 清理：flushAll（不 commit，避免污染）
console.log("[done] e2e verify finished");
