import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, turn, threadItem } from "./fixtures.js";
import { projectPiHistory, parsePiSession, piMigrationKey } from "../src/pi/protocol.js";
import { piSessionDirectory, inspectPi } from "../src/pi/discovery.js";
import { piTerminalCommand } from "../src/pi/runtime.js";

test("Pi 保留连续角色和超过种子窗口的正文，记录附件与工具损失及时间精度", () => {
  const source = snapshot("/tmp/A", [turn("t", [
    threadItem("userMessage", { id: "u", content: [{ type: "text", text: "  问题\n " }, { type: "image" }] }),
    ...Array.from({ length: 130 }, (_, i) => threadItem("agentMessage", { id: `a${i}`, text: `${i} ${"内容".repeat(800)}` })),
    threadItem("userMessage", { content: [{ type: "image" }] }),
    threadItem("commandExecution", { command: "rm should-not-execute" }),
  ])]);
  const p = projectPiHistory(source);
  assert.equal(p.messages.length, 131);
  assert.equal(p.messages[0]?.content, "  问题\n ");
  assert.equal(p.messages[130]?.content, `129 ${"内容".repeat(800)}`);
  assert.equal(p.messages[0]?.timestamp, 1000);
  assert.equal(p.provenance[0]?.timestampSource, "turn");
  assert.equal(p.lossReport.omittedEventTypes["attachment:image"], 2);
  assert.equal(p.lossReport.omittedEventTypes.commandExecution, 1);
  assert.equal(p.lossReport.omittedMessageCount, 1);
  assert.ok(p.lossReport.includedMessageBytes > 128 * 1024);
  assert.equal(p.lossReport.omittedMessageBytes, 0);
  assert.equal(p.lossReport.truncatedFields.length, 0);
  assert.equal(piMigrationKey(source, "/pi/sessions"), piMigrationKey({ ...source, capturedAt: "later" }, "/pi/sessions"));
  assert.notEqual(piMigrationKey(source, "/pi/sessions"), piMigrationKey(source, "/pi/other"));
  assert.throws(() => projectPiHistory(snapshot("/tmp/A", [])), /没有可迁移/);
});

test("Pi 严格解析拒绝坏行、重复 ID、断链、缺换行和错误工作区，不交给容错 loader 吞掉", () => {
  const header = { type: "session", version: 3, id: "session", cwd: "/tmp/A", timestamp: "2026-09-10T00:00:00.000Z" };
  const entry = { type: "message", id: "u", parentId: null, timestamp: header.timestamp, message: { role: "user", content: "test", timestamp: 1 } };
  const encode = (entries: unknown[]) => entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  const text = encode([header, entry]);
  assert.equal(parsePiSession(text, "session", "/tmp/A").entries.length, 1);
  for (const invalid of [text.trimEnd(), text + "bad-json\n", encode([header, entry, entry]),
    encode([header, { ...entry, parentId: "missing" }]), encode([{ ...header, version: 2 }, entry]),
    encode([header, { ...entry, message: { role: "assistant", content: "wrong" } }])]) {
    assert.throws(() => parsePiSession(invalid, "session", "/tmp/A"));
  }
  assert.throws(() => parsePiSession(text, "session", "/tmp/B"), /工作区/);
});

test("Pi 默认和自定义会话目录与打开参数一致，终端路径使用逐参数引用", () => {
  assert.equal(piSessionDirectory("/project/A", "/agent"), "/agent/sessions/--project-A--");
  assert.equal(piSessionDirectory("/project/A", "/agent", "/custom"), "/custom");
  const command = piTerminalCommand({ nodePath: "/node", cliPath: "/pi/cli.js", agentDir: "/agent's data" }, "/project/A's space", "/custom/session.jsonl", "/custom");
  assert.match(command, /--session /);
  assert.match(command, /--session-dir /);
  assert.match(command, /cd '/);
  assert.ok(command.includes("'\\''"));
  assert.doesNotMatch(command, /--continue|--session-id|--print/);
});

test("Pi 未安装或未知包版本只报告不可用，发现阶段不创建数据目录", async () => {
  await assert.rejects(inspectPi({ executablePath: "/not-installed/pi" }), /未发现/);
  const root = await mkdtemp(join(tmpdir(), "idehub-pi-discovery-"));
  const executablePath = join(root, "dist/pi.js");
  await mkdir(join(root, "dist"));
  await writeFile(executablePath, "// unknown package fixture");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "99.0.0" }));
  const result = await inspectPi({ executablePath, agentDir: join(root, "must-not-create") });
  assert.equal(result.installed, true);
  assert.equal(result.compatible, false);
  assert.match(result.compatibilityError!, /99.0.0/);
  await assert.rejects(stat(result.agentDir), { code: "ENOENT" });
});
