import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { snapshot, turn, threadItem } from "./fixtures.js";
import { MigrationArtifacts } from "../src/artifacts.js";
import { discoverZcode } from "../src/zcode/discovery.js";
import { ZcodeClient } from "../src/zcode/client.js";
import { migrateZcode } from "../src/zcode/migration.js";

test("安装包原生离线 Gate：131 条消息、重开、索引中断恢复、幂等不重导入", { skip: process.env.IDE_HUB_ZCODE_INTEGRATION !== "1" }, async () => {
  const installed = await discoverZcode();
  const root = await realpath(await mkdtemp(join(tmpdir(), "idehub-zcode-runtime-")));
  const workspace = join(root, "A"); await mkdir(workspace);
  const installation = { ...installed, sessionDb: join(root, "session.sqlite"), taskDb: join(root, "tasks.sqlite") };
  const original = new DatabaseSync(installed.taskDb, { readOnly: true });
  const ddl = original.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get()!.sql as string;
  original.close();
  const tasks = new DatabaseSync(installation.taskDb); tasks.exec(ddl); tasks.close();
  const bootstrap = new ZcodeClient(installation, workspace, join(root, "bootstrap"));
  await bootstrap.start();
  try { await bootstrap.request("session/list", {}); } finally { await bootstrap.close(); }
  const source = snapshot(workspace, [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "keep all" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { text: `native-${i}` }))])]);
  const rejectArtifacts = new MigrationArtifacts("rejected", root); await rejectArtifacts.initialize();
  await assert.rejects(migrateZcode({ snapshot: source, artifacts: rejectArtifacts, dryRun: false,
    installation: { ...installation, compatible: false, compatibilityError: "unknown version" } }), /unknown version/);
  const other = join(root, "B"); await mkdir(other);
  await assert.rejects(migrateZcode({ snapshot: { ...source, thread: { ...source.thread, cwd: other } },
    artifacts: rejectArtifacts, dryRun: false, installation }), /同一目录/);
  const run = async (id: string, fail = false, dryRun = false) => {
    const artifacts = new MigrationArtifacts(id, root); await artifacts.initialize();
    return migrateZcode({ snapshot: source, artifacts, dryRun, installation, stateRoot: join(root, "state"),
      ...(fail ? { afterHistoryVerified: async () => { throw new Error("injected index failure"); } } : {}) });
  };
  const dry = await run("preview", false, true); assert.equal(dry.targetSessionId, null);
  const before = new DatabaseSync(installation.sessionDb, { readOnly: true });
  assert.equal(before.prepare("SELECT count(*) AS n FROM session").get()!.n, 0); before.close();
  await assert.rejects(run("failure", true), /injected index failure/);
  const recovered = await run("recovered"); assert.equal(recovered.reused, true);
  // 隔离数据库中的续聊形状 fixture，不是模型续聊 Gate；验证真实适配器复跑不会重写后缀。
  const suffixDb = new DatabaseSync(installation.sessionDb);
  suffixDb.prepare("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)").run(
    "msg_fixture_next", recovered.targetSessionId, 200000, 200000, JSON.stringify({ role: "user", time: { created: 200000 }, agent: "zcode-agent", model: { providerID: "builtin:bigmodel", modelID: "GLM-5.3" } }));
  suffixDb.prepare("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)").run(
    "part_fixture_next", "msg_fixture_next", recovered.targetSessionId, 200000, 200000, JSON.stringify({ type: "text", text: "fixture continuation, not a model call" }));
  suffixDb.close();
  const renamed = new DatabaseSync(installation.taskDb);
  renamed.prepare("UPDATE tasks SET title='user title',meta_json='{}' WHERE task_id=?").run(recovered.targetSessionId); renamed.close();
  const again = await run("again"); assert.equal(again.targetSessionId, recovered.targetSessionId);
  const calls = JSON.parse(await readFile(join(root, "migrations/again/zcode-rpc-calls.json"), "utf8"));
  assert.equal(calls.methods.includes("session/create"), false);
  const readback = JSON.parse(await readFile(join(root, "migrations/again/zcode-native-readback.json"), "utf8"));
  assert.equal(readback.messages.length, 132);
  assert.equal(readback.verification.continuationCount, 1);
  assert.equal(readback.messages[130].parts[0].text, "native-129");
  const preserved = new DatabaseSync(installation.taskDb, { readOnly: true });
  assert.equal(preserved.prepare("SELECT title FROM tasks WHERE task_id=?").get(recovered.targetSessionId)!.title, "user title"); preserved.close();
  console.log(`ZCode offline native Gate evidence: ${root}`);
});
