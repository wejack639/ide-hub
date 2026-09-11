import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, turn, threadItem } from "./fixtures.js";
import { projectClaudeHistory, buildClaudeSession, parseClaudeSession, claudeMigrationKey } from "../src/claude/protocol.js";
import { claudeProjectKey, inspectClaude } from "../src/claude/discovery.js";
import { claudeTerminalCommand } from "../src/claude/runtime.js";

test("Claude 原生投影保留全部正文、连续角色和来源，非文本/工具只记录损失", () => {
  const source = snapshot("/tmp/A", [turn("t", [
    threadItem("userMessage", { content: [{ type: "text", text: "  问题\n🙂 " }, { type: "image" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { text: `${i} ${"历史".repeat(800)}` })),
    threadItem("commandExecution", { command: "never execute" }),
  ])]);
  const projection = projectClaudeHistory(source);
  assert.equal(projection.messages.length, 131);
  assert.equal(projection.messages[0]?.content, "  问题\n🙂 ");
  assert.ok(projection.lossReport.includedMessageBytes > 128 * 1024);
  assert.equal(projection.lossReport.omittedEventTypes["attachment:image"], 1);
  assert.equal(projection.lossReport.omittedEventTypes.commandExecution, 1);
  const id = randomUUID();
  const parsed = parseClaudeSession(buildClaudeSession(projection, id, "/tmp/A"), id, "/tmp/A");
  assert.equal(parsed.messages.length, 131);
  assert.deepEqual(parsed.messages.map(m => m.type), projection.messages.map(m => m.role));
  assert.equal(parsed.messages[0]?.parentUuid, null);
  assert.equal(parsed.messages[130]?.parentUuid, parsed.messages[129]?.uuid);
  assert.equal(claudeMigrationKey(source, "/config"), claudeMigrationKey({ ...source, capturedAt: "later" }, "/config"));
  assert.notEqual(claudeMigrationKey(source, "/config"), claudeMigrationKey(source, "/other"));
  assert.throws(() => projectClaudeHistory(snapshot("/tmp/A", [])), /没有可迁移/);
});

test("Claude 严格检查坏行、断链、重复 ID 和工作区，不让宽松 SDK 静默少读", () => {
  const id = randomUUID();
  const projection = projectClaudeHistory(snapshot("/tmp/A", [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "only user" }] })])]));
  const text = buildClaudeSession(projection, id, "/tmp/A");
  const rows = text.trimEnd().split("\n").map(s => JSON.parse(s));
  const encode = (r: unknown[]) => r.map(e => JSON.stringify(e)).join("\n") + "\n";
  assert.equal(parseClaudeSession(text, id, "/tmp/A").messages.length, 1);
  for (const bad of [text.trimEnd(), text + "bad\n", encode([rows[0], rows[0]]),
    encode([{ ...rows[0], parentUuid: randomUUID() }]), encode([{ ...rows[0], sessionId: randomUUID() }]),
    encode([{ ...rows[0], message: { role: "assistant", content: "wrong role" } }])]) {
    assert.throws(() => parseClaudeSession(bad, id, "/tmp/A"));
  }
  assert.throws(() => parseClaudeSession(text, id, "/tmp/B"), /工作区/);
});

test("Claude 目录键覆盖特殊字符及长路径，打开精确 UUID 而非最近会话", () => {
  assert.equal(claudeProjectKey("/Users/a/project_A 中文"), "-Users-a-project-A---");
  const long = "/" + "x".repeat(250);
  let hash = 0; for (let i = 0; i < long.length; i++) hash = ((hash << 5) - hash + long.charCodeAt(i)) | 0;
  assert.equal(claudeProjectKey(long), `${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-${Math.abs(hash).toString(36)}`);
  const id = randomUUID();
  const command = claudeTerminalCommand({ cliPath: "/cli path/claude", configDir: "/config's dir", configDirExplicit: true }, "/project/A's path", id);
  assert.ok(command.includes("'\\''"));
  assert.ok(command.includes(`--resume '${id}'`));
  assert.doesNotMatch(command, /--continue|--fork-session|--print|--dangerously/);
});

test("Claude 默认打开不注入配置根，保留正常全局状态；仅自定义根显式传入", () => {
  const id = randomUUID();
  const installation = { cliPath: "/cli/claude", configDir: join(homedir(), ".claude"), configDirExplicit: false };
  const normal = claudeTerminalCommand(installation, "/tmp/A", id);
  assert.match(normal, /-u CLAUDE_CONFIG_DIR/);
  assert.doesNotMatch(normal, /CLAUDE_CONFIG_DIR=/);
  const explicit = claudeTerminalCommand({ ...installation, configDirExplicit: true }, "/tmp/A", id);
  assert.match(explicit, /CLAUDE_CONFIG_DIR=/);
  for (const command of [normal, explicit]) assert.doesNotMatch(command, /ANTHROPIC_|--model|--settings|--bare|--permission/);
});

test("Claude 不存在或未知版本不可写，发现阶段不创建配置目录", async () => {
  await assert.rejects(inspectClaude({ executablePath: "/not-installed/claude" }), /未发现/);
  const root = await mkdtemp(join(tmpdir(), "idehub-claude-discover-"));
  await mkdir(join(root, "bin"));
  const executablePath = join(root, "bin/claude");
  await writeFile(executablePath, '#!/bin/sh\necho "99.0.0 (Claude Code)"\n', { mode: 0o700 });
  const installation = await inspectClaude({ executablePath, configDir: join(root, "absent") });
  assert.equal(installation.compatible, false);
  assert.match(installation.compatibilityError!, /99.0.0/);
  await assert.rejects(stat(installation.configDir), { code: "ENOENT" });
});
