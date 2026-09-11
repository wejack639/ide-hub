// 独立 Node helper：仅依赖 Node 和用户已安装 Pi 的公开 SDK；打包后从 asar.unpacked 执行。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { SessionManager, convertToLlm, CURRENT_SESSION_VERSION } = await import(pathToFileURL(join(input.packageRoot, "dist/index.js")).href);
  if (CURRENT_SESSION_VERSION !== 3) throw new Error("Pi SDK session version 不兼容");
  if (input.operation === "build") {
    const manager = SessionManager.inMemory(input.workspace, { id: input.sessionId });
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const m of input.messages) manager.appendMessage(m.role === "user" ? m : {
      role: "assistant", content: [{ type: "text", text: m.content }], timestamp: m.timestamp,
      api: "ide-hub-import", provider: "ide-hub", model: "codex-history", usage, stopReason: "stop",
    });
    manager.appendCustomEntry("ide-hub-migration", input.lineage);
    manager.appendSessionInfo(input.title);
    return { content: [manager.getHeader(), ...manager.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n" };
  }
  if (input.operation !== "inspect") throw new Error("不支持的 Pi helper 操作");
  const before = await readFile(input.path, "utf8");
  if (hash(before) !== input.expectedSha256 || !before.endsWith("\n")) throw new Error("Pi 会话在原生回读前发生变化");
  // 父进程已严格验证；再次检查不可修复输入，防止 open 自动补换行/升级旧版本。
  const entries = before.trimEnd().split("\n").map((line: string) => JSON.parse(line));
  if (entries[0].version !== 3 || entries[0].cwd !== input.workspace || entries[0].id !== input.sessionId) throw new Error("Pi header 不一致");
  const manager = SessionManager.open(input.path, dirname(input.path));
  const list = await SessionManager.list(input.workspace, dirname(input.path));
  if (await readFile(input.path, "utf8") !== before) throw new Error("Pi 原生回读修改了目标文件");
  return { sessionId: manager.getSessionId(), cwd: manager.getCwd(), title: manager.getSessionName(),
    messages: convertToLlm(manager.buildSessionContext().messages), entryCount: manager.getEntries().length,
    listed: list.some((s: any) => s.id === input.sessionId && s.path === input.path), modelInvoked: false };
}
main().then(result => process.stdout.write(JSON.stringify({ ok: true, result }))).catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
