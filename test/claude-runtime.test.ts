import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, readFile, appendFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MigrationArtifacts } from "../src/artifacts.js";
import { inspectClaude } from "../src/claude/discovery.js";
import { migrateClaude, rollbackClaudeMigration, resolveClaudeTarget } from "../src/claude/migration.js";
import { readClaudeNative } from "../src/claude/runtime.js";
import { parseClaudeSession } from "../src/claude/protocol.js";
import { resolveWorkspace } from "../src/workspace.js";
import { snapshot, turn, threadItem } from "./fixtures.js";

test("Claude 禁网原生 Gate：全量磁盘回读、无模型、同目录、只有 user、中断恢复、续聊后幂等与回滚", { skip: process.env.IDE_HUB_CLAUDE_INTEGRATION !== "1" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "idehub-claude-native-")));
  const workspace = join(root, "A's 中文"); await mkdir(workspace);
  const installation = await inspectClaude({ configDir: join(root, "claude-config") });
  assert.equal(installation.compatible, true, installation.compatibilityError ?? "");
  const source = snapshot(workspace, [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "旧问题" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { text: `第${i}条 ${"完整历史".repeat(400)}` }))])]);
  source.workspace = await resolveWorkspace(workspace);
  const stateRoot = join(root, "state");
  const run = async (id: string, options = {}) => {
    const artifacts = new MigrationArtifacts(id, root); await artifacts.initialize();
    return migrateClaude({ snapshot: source, installation, stateRoot, artifacts, dryRun: false, ...options });
  };
  assert.equal((await run("preview", { dryRun: true })).targetSessionId, null);
  await assert.rejects(stat(installation.configDir), { code: "ENOENT" });
  await assert.rejects(run("unknown", { installation: { ...installation, compatible: false, compatibilityError: "unknown" } }), /unknown/);
  await assert.rejects(run("wrong-cwd", { snapshot: { ...source, thread: { ...source.thread, cwd: root } } }), /工作区/);
  await assert.rejects(run("interrupted", { afterPublished: async () => { throw new Error("injected interruption"); } }), /injected/);
  const first = await run("recovered");
  assert.equal(first.reused, true);
  assert.ok(first.targetSessionId && first.sessionPath);
  const native = await readClaudeNative(installation, workspace, first.sessionPath!, first.targetSessionId!);
  assert.equal(native.messages.length, 131);
  assert.equal(native.listed, true);
  assert.equal(native.cwd, workspace);
  const alias = join(root, "alias"); await symlink(workspace, alias);
  assert.equal((await run("alias", { snapshot: { ...source, thread: { ...source.thread, cwd: alias } } })).targetSessionId, first.targetSessionId);
  const before = await readFile(first.sessionPath!, "utf8");
  const parsed = parseClaudeSession(before, first.targetSessionId!, workspace);
  // 此后缀仅为文件回归 fixture，不是模型连续性证据。
  await appendFile(first.sessionPath!, JSON.stringify({ ...parsed.messages[0], uuid: randomUUID(), parentUuid: parsed.messages.at(-1)!.uuid,
    message: { role: "user", content: "fixture next" } }) + "\n");
  const continued = await readFile(first.sessionPath!, "utf8");
  assert.equal((await run("repeated")).targetSessionId, first.targetSessionId);
  assert.equal(await readFile(first.sessionPath!, "utf8"), continued);
  await assert.rejects(rollbackClaudeMigration(first.targetSessionId!, stateRoot), /续聊|变化/);
  await appendFile(first.sessionPath!, "bad json\n");
  await assert.rejects(run("damaged"), /JSON|损坏/);
  await assert.rejects(resolveClaudeTarget(installation, workspace, randomUUID(), stateRoot));

  const one = snapshot(workspace, [turn("one", [threadItem("userMessage", { content: [{ type: "text", text: "只有问题" }] })])]);
  one.workspace = source.workspace; one.thread.id = "only-user";
  const userOnly = await run("user-only", { snapshot: one });
  assert.equal((await readClaudeNative(installation, workspace, userOnly.sessionPath!, userOnly.targetSessionId!)).messages.length, 1);
  await rollbackClaudeMigration(userOnly.targetSessionId!, stateRoot);
  await assert.rejects(stat(userOnly.sessionPath!), { code: "ENOENT" });
  assert.equal(await readFile(first.sessionPath!, "utf8"), continued + "bad json\n");
  const customInstall = await inspectClaude({ configDir: join(root, "second-config") });
  const custom = await run("custom", { snapshot: one, installation: customInstall });
  assert.ok(custom.sessionPath!.startsWith(customInstall.configDir));
  assert.equal(await resolveClaudeTarget(customInstall, workspace, custom.targetSessionId!, stateRoot), custom.sessionPath);
  await assert.rejects(resolveClaudeTarget(installation, workspace, custom.targetSessionId!, stateRoot), /目录|数据根/);
  console.log(`Claude native offline evidence: ${root}`);
});
