/** 真实 UI 续聊的只读取证工具；不发送模型请求，不创建/改写目标历史。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverZcode } from "../src/zcode/discovery.js";
import { ZcodeClient } from "../src/zcode/client.js";
import { verifyZcodeMessages, type ZcodeNativeMessage, type ZcodeSnapshot } from "../src/zcode/protocol.js";
import { readZcodeSession, readZcodeTask } from "../src/zcode/storage.js";
import { atomicWrite, sha256Text } from "../src/util/fs.js";

const [directory, stage] = process.argv.slice(2);
assert.ok(directory && stage && /^[a-z-]+$/.test(stage), "需要证据目录和阶段名");
const workspace = "/Users/domino/develop/IdeaProjects/temp";
const sessionId = "sess_idehub_3d23d31cadaa63b5f29182b1a896d2181942c779243e901c9ade0f044d819f8a";
const installation = await discoverZcode();
const client = new ZcodeClient(installation, workspace, join(directory, stage));
try {
  await client.start();
  const native = await client.request<ZcodeSnapshot>("session/resume", { sessionId, workspace: { workspacePath: workspace, workspaceKey: workspace } });
  const { messages } = await client.request<{ messages: ZcodeNativeMessage[] }>("session/messages", { sessionId });
  const projection = JSON.parse(await readFile(join(directory, "../migrations/cf701981-b819-4790-8c3d-08d6c3916cb9/zcode-history.json"), "utf8"));
  const verification = verifyZcodeMessages(messages, projection.history.messages, sessionId);
  const rows = messages.map(m => ({ id: m.info.id, role: m.info.role,
    text: m.parts.filter(p => p.type === "text").map(p => p.text ?? "").join(""),
    finish: m.info.finish ?? null, error: m.info.error ?? null }));
  const core = readZcodeSession(installation.sessionDb, sessionId);
  const task = readZcodeTask(installation.taskDb, sessionId, workspace);
  assert.equal(core?.directory, workspace); assert.equal(core?.path, workspace);
  assert.equal(task?.workspace_path, workspace); assert.equal(native.session.sessionId, sessionId);
  const report = { capturedAt: new Date().toISOString(), sessionId, workspace, verification,
    messagesSha256: sha256Text(JSON.stringify(rows)), rows, native, core, task, calls: client.calls };
  await atomicWrite(join(directory, `${stage}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage, sessionId, verification, messagesSha256: report.messagesSha256,
    messages: rows.map(m => ({ ...m, text: m.text.slice(0, 180) })) }));
} finally { await client.close(); }
