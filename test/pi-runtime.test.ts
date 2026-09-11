import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, readFile, appendFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MigrationArtifacts } from "../src/artifacts.js";
import { inspectPi } from "../src/pi/discovery.js";
import { migratePi, rollbackPiMigration } from "../src/pi/migration.js";
import { piRuntime } from "../src/pi/runtime.js";
import { resolveWorkspace } from "../src/workspace.js";
import { snapshot, turn, threadItem } from "./fixtures.js";

test("Pi 官方 SDK 禁网落盘 Gate：长历史、原生列表/重开、只有 user、中断恢复和续聊后幂等", { skip: process.env.IDE_HUB_PI_INTEGRATION !== "1" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "idehub-pi-native-")));
  const workspace = join(root, "A"); await mkdir(workspace);
  const installation = await inspectPi({ agentDir: join(root, "pi-agent") });
  assert.equal(installation.compatible, true, installation.compatibilityError ?? "");
  const source = snapshot(workspace, [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "上下文问题" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { text: `第${i}条 ${"完整历史".repeat(400)}` }))])]);
  source.workspace = await resolveWorkspace(workspace);
  const stateRoot = join(root, "state");
  const run = async (id: string, options = {}) => {
    const artifacts = new MigrationArtifacts(id, root); await artifacts.initialize();
    return migratePi({ snapshot: source, installation, stateRoot, artifacts, dryRun: false, ...options });
  };
  const dry = await run("preview", { dryRun: true });
  assert.equal(dry.targetSessionId, null);
  await assert.rejects(stat(installation.agentDir), { code: "ENOENT" });
  await assert.rejects(run("incompatible", { installation: { ...installation, compatible: false, compatibilityError: "unknown version" } }), /unknown version/);
  await assert.rejects(run("wrong-workspace", { snapshot: { ...source, thread: { ...source.thread, cwd: root } } }), /工作区/);
  await assert.rejects(run("interrupted", { afterPublished: async () => { throw new Error("injected publication interruption"); } }), /injected/);
  const first = await run("recovered");
  assert.equal(first.reused, true);
  assert.ok(first.targetSessionId);
  const alias = join(root, "alias-A"); await symlink(workspace, alias);
  assert.equal((await run("symlink", { snapshot: { ...source, thread: { ...source.thread, cwd: alias } } })).targetSessionId, first.targetSessionId);
  const before = await readFile(first.sessionPath!, "utf8");
  const inspected = await piRuntime(installation, { operation: "inspect", path: first.sessionPath, sessionId: first.targetSessionId, workspace });
  assert.equal(inspected.messages.length, 131);
  assert.equal(inspected.listed, true);
  assert.equal(inspected.cwd, workspace);
  // 仅隔离数据中的后缀 fixture；不将其作为真实模型续聊证据。
  const entries = before.trimEnd().split("\n").map(line => JSON.parse(line));
  const suffix = { type: "message", id: "fixture-next", parentId: entries.at(-1).id, timestamp: new Date().toISOString(),
    message: { role: "user", content: "fixture continuation", timestamp: Date.now() } };
  await appendFile(first.sessionPath!, JSON.stringify(suffix) + "\n");
  const continued = await readFile(first.sessionPath!, "utf8");
  assert.equal((await run("repeat")).targetSessionId, first.targetSessionId);
  assert.equal(await readFile(first.sessionPath!, "utf8"), continued);
  await assert.rejects(rollbackPiMigration(first.targetSessionId!, stateRoot), /续聊|变化/);
  await appendFile(first.sessionPath!, "bad json\n");
  await assert.rejects(run("damaged"), /JSON|损坏/);

  const one = snapshot(workspace, [turn("only-user", [threadItem("userMessage", { content: [{ type: "text", text: "只有问题" }] })])]);
  one.workspace = source.workspace; one.thread.id = "only-user";
  const userOnly = await run("user-only", { snapshot: one });
  const reopened = await piRuntime(installation, { operation: "inspect", path: userOnly.sessionPath, workspace, sessionId: userOnly.targetSessionId });
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.listed, true);
  await rollbackPiMigration(userOnly.targetSessionId!, stateRoot);
  await assert.rejects(stat(userOnly.sessionPath!), { code: "ENOENT" });
  assert.equal(await readFile(first.sessionPath!, "utf8"), continued + "bad json\n");
  const custom = await run("custom-directory", { snapshot: one, installation: { ...installation, sessionDir: join(root, "custom-sessions") } });
  assert.ok(custom.sessionPath?.startsWith(join(root, "custom-sessions")));
  const customNative = await piRuntime(installation, { operation: "inspect", path: custom.sessionPath, workspace, sessionId: custom.targetSessionId });
  assert.equal(customNative.listed, true);
  assert.equal(customNative.cwd, workspace);
  console.log(`Pi native offline Gate evidence: ${root}`);
});
