import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { snapshot, turn, threadItem } from "./fixtures.js";
import { projectZcodeHistory, verifyZcodeMessages, zcodeMigrationKey } from "../src/zcode/protocol.js";
import { offlineModelConfig, offlineSandboxProfile } from "../src/zcode/client.js";
import { registerZcodeTask, readZcodeTask } from "../src/zcode/storage.js";

test("ZCode 按源顺序保留连续 Assistant、长历史并报告非文本损失", () => {
  const source = snapshot("/tmp/A", [turn("t", [
    threadItem("userMessage", { content: [{ type: "text", text: "question" }, { type: "image", url: "x" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { text: `answer ${i}` })),
    threadItem("commandExecution", { command: "pwd" }),
  ])]);
  const p = projectZcodeHistory(source);
  assert.equal(p.history.messages.length, 131);
  assert.equal(p.history.messages[130]?.content, "answer 129");
  assert.equal(p.lossReport.omittedEventTypes.commandExecution, 1);
  assert.equal(p.lossReport.omittedEventTypes["attachment:image"], 1);
  assert.equal(p.lossReport.omittedMessageCount, 0);
  assert.equal(p.history.source, "claudeCode");
  assert.match(p.history.title, /^Codex · /);
  const readback = p.history.messages.map((m, i) => ({ info: { id: `msg_sess_test_import_${i}`, sessionID: "sess_test", role: m.role }, parts: [{ type: "text", text: m.content }] }));
  assert.equal(verifyZcodeMessages(readback, p.history.messages, "sess_test").importedCount, 131);
  assert.throws(() => verifyZcodeMessages(readback.slice(-100), p.history.messages, "sess_test"));
  readback.push({ info: { id: "next", sessionID: "sess_test", role: "user" }, parts: [{ type: "text", text: "continue" }] });
  assert.equal(verifyZcodeMessages(readback, p.history.messages, "sess_test").continuationCount, 1);
  assert.equal(zcodeMigrationKey(source), zcodeMigrationKey({ ...source, capturedAt: "later" }));
  assert.notEqual(zcodeMigrationKey(source), zcodeMigrationKey({ ...source, sourceFile: { ...source.sourceFile, sha256: "b".repeat(64) } }));
});

test("离线配置只提取实际 ZCode 模型引用，不复制凭据或启用 MCP / 插件", () => {
  const config = offlineModelConfig({ provider: { native: { kind: "anthropic", options: { apiKey: "private-key", baseURL: "https://secret.invalid" }, models: { actual: {} } } } });
  assert.equal(config.model.main, "native/actual");
  assert.equal(config.features.mcp, false);
  assert.equal(config.plugins.enabled, false);
  assert.equal(JSON.stringify(config).includes("private-key"), false);
  assert.equal(JSON.stringify(config).includes("secret.invalid"), false);
  assert.throws(() => offlineModelConfig({ provider: {} }), /model|模型/i);
  const profile = offlineSandboxProfile("/Applications/ZCode.app/Contents/MacOS/ZCode", "/tmp/A");
  assert.match(profile, /deny network\*/);
  assert.match(profile, /deny process-exec/);
  assert.match(profile, /\/tmp\/A\/\.zcode\/config.json/);
});

test("桌面登记只插入目标任务，重复执行保留用户续聊状态，拒绝同 ID 冲突", async () => {
  const dir = await mkdtemp(join(tmpdir(), "idehub-zcode-index-"));
  const path = join(dir, "tasks.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE tasks (workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,title TEXT,task_status TEXT,provider TEXT,mode TEXT,model TEXT,migration_source TEXT,created_at INTEGER,updated_at INTEGER,deleted INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,meta_json TEXT,searchable_text TEXT,PRIMARY KEY(workspace_key,task_id))`);
  db.close();
  const native = { session: { sessionId: "sess_idehub_test", traceId: "native-trace", workspace: { workspacePath: "/tmp/A", workspaceKey: "/tmp/A" }, title: "Codex · test", createdAt: 1, updatedAt: 2, mode: "build", model: { providerId: "native", modelId: "actual" }, status: "idle" } };
  const lineage = { migrationKey: "key", sourceThreadId: "thread", sourceFileSha256: "hash", sourceProduct: "codex" as const };
  await registerZcodeTask(path, native, lineage);
  assert.equal(JSON.parse(String(readZcodeTask(path, "sess_idehub_test", "/tmp/A")?.meta_json)).traceId, "native-trace");
  await assert.rejects(registerZcodeTask(path, { session: { ...native.session, traceId: "" } }, lineage), /traceId/);
  const edit = new DatabaseSync(path);
  edit.prepare("UPDATE tasks SET title='user renamed',updated_at=99").run();
  const legacyMeta = JSON.parse(String(edit.prepare("SELECT meta_json FROM tasks").get()!.meta_json));
  delete legacyMeta.traceId;
  edit.prepare("UPDATE tasks SET meta_json=?").run(JSON.stringify(legacyMeta));
  edit.close();
  await registerZcodeTask(path, native, lineage);
  assert.equal(readZcodeTask(path, "sess_idehub_test", "/tmp/A")?.title, "user renamed");
  assert.equal(JSON.parse(String(readZcodeTask(path, "sess_idehub_test", "/tmp/A")?.meta_json)).traceId, "native-trace");
  await assert.rejects(registerZcodeTask(path, native, { ...lineage, migrationKey: "different" }));
  await assert.rejects(registerZcodeTask(path, { session: { ...native.session, workspace: { workspacePath: "/tmp/B", workspaceKey: "/tmp/B" } } }, lineage));
});
