// 独立 Node helper；只调用官方 SDK 的磁盘读取函数，不启动 query/startup。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const before = await readFile(input.path, "utf8");
  if (createHash("sha256").update(before).digest("hex") !== input.expectedSha256) throw new Error("Claude 会话在回读前发生变化");
  const sdk = await import(pathToFileURL(input.sdkPath).href);
  const info = await sdk.getSessionInfo(input.sessionId, { dir: input.workspace });
  const list = await sdk.listSessions({ dir: input.workspace, includeWorktrees: false });
  const messages = await sdk.getSessionMessages(input.sessionId, { dir: input.workspace });
  if (await readFile(input.path, "utf8") !== before) throw new Error("Claude 回读期间会话发生变化");
  return { sessionId: info?.sessionId, cwd: info?.cwd, title: info?.customTitle,
    listed: list.some((s: any) => s.sessionId === input.sessionId && s.cwd === input.workspace),
    messages: messages.map((m: any) => ({ uuid: m.uuid, role: m.type, content: m.message.content })), modelInvoked: false };
}
main().then(result => process.stdout.write(JSON.stringify({ ok: true, result }))).catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
