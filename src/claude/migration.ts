import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MigrationArtifacts } from "../artifacts.js";
import { MigrationError } from "../errors.js";
import type { SourceSnapshot } from "../types.js";
import { atomicWrite, defaultDataRoot, sha256Text } from "../util/fs.js";
import { assertSameWorkspace, resolveWorkspace } from "../workspace.js";
import { inspectClaude, claudeProjectKey, type ClaudeInstallation } from "./discovery.js";
import { buildClaudeSession, parseClaudeSession, projectClaudeHistory, claudeMigrationKey, CLAUDE_PROTOCOL, isClaudeUuid } from "./protocol.js";
import { readClaudeNative } from "./runtime.js";

type Ledger = { protocol: string; key: string; sessionId: string; workspace: string; configDir: string;
  sessionPath: string; payloadPath: string; sha256: string; bytes: number; phase: "intent" | "completed";
  sourceThreadId: string; sourceFileSha256: string };
const stateDirectory = () => join(defaultDataRoot(), "claude");
const targetPath = (configDir: string, workspace: string, id: string) => join(configDir, "projects", claudeProjectKey(workspace), `${id}.jsonl`);

/** 先完整写临时文件再独占发布；不以 rename 覆盖已经存在的目标。 */
async function publishExclusive(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.idehub-${randomUUID()}.pending`);
  const fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(content); await fd.sync(); await fd.close();
    try { await link(temporary, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } finally { await fd.close(); await unlink(temporary); }
}

function ledgerPath(id: string, root: string): string {
  if (!isClaudeUuid(id)) throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 目标 UUID 无效");
  return join(root, `${id}.json`);
}
async function readLedger(id: string, root: string): Promise<Ledger> {
  const ledger = JSON.parse(await readFile(ledgerPath(id, root), "utf8")) as Ledger;
  if (ledger.protocol !== CLAUDE_PROTOCOL || ledger.sessionId !== id || !Number.isInteger(ledger.bytes) || ledger.bytes <= 0 ||
      ledger.sessionPath !== targetPath(ledger.configDir, ledger.workspace, id)) {
    throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 迁移记录或目标路径不一致");
  }
  return ledger;
}
async function verifyPrefix(ledger: Ledger): Promise<string> {
  const buffer = await readFile(ledger.sessionPath);
  const text = buffer.toString("utf8");
  parseClaudeSession(text, ledger.sessionId, ledger.workspace);
  if (buffer.length < ledger.bytes || sha256Text(buffer.subarray(0, ledger.bytes)) !== ledger.sha256) {
    throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 已导入历史前缀发生变化，未复用或覆盖");
  }
  return text;
}

/** 同源快照只新建一次；既有目标只能回验，不能抹掉目标端新增对话。 */
export async function migrateClaude(input: { snapshot: SourceSnapshot; artifacts: MigrationArtifacts; dryRun: boolean;
  installation?: ClaudeInstallation; stateRoot?: string; afterPublished?: () => Promise<void> }) {
  const installation = input.installation ?? await inspectClaude();
  if (!installation.compatible) throw new MigrationError("CLAUDE_VERSION_UNSUPPORTED", installation.compatibilityError ?? "Claude 不兼容");
  if (input.snapshot.thread.status.type === "active" || input.snapshot.thread.turns.some(t => t.status === "inProgress")) throw new MigrationError("SOURCE_TURN_RUNNING", "源会话仍在运行");
  const workspace = (await resolveWorkspace(input.snapshot.thread.cwd)).workspaceCanonical;
  await assertSameWorkspace(input.snapshot.workspace, workspace);
  const key = claudeMigrationKey(input.snapshot, installation.configDir);
  // 从完整幂等 key 派生合法 UUID；完整 key 同时写入 ledger，不能仅凭短 ID 判断来源相同。
  const sessionId = `${key.slice(0, 8)}-${key.slice(8, 12)}-8${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const sessionPath = targetPath(installation.configDir, workspace, sessionId);
  const projection = projectClaudeHistory(input.snapshot);
  await input.artifacts.writeJson("claude-history.json", projection);
  await input.artifacts.writeJson("loss-report.json", projection.lossReport);
  await input.artifacts.writeJson("target-plan.json", { targetProduct: "claude-code", version: installation.version,
    sessionId, sessionPath, workspace, fingerprints: installation.fingerprints,
    operation: "exclusive JSONL publish -> strict complete-chain validation -> official SDK disk list/read",
    modelInvoked: false, mcpChanged: false, offline: "sandbox-exec deny network*", continuationVerified: false,
    compatibilityNote: projection.compatibilityNote });
  if (input.dryRun) return { targetSessionId: null, sessionPath: null, projection, reused: false };

  const stateRoot = input.stateRoot ?? stateDirectory();
  const recordPath = ledgerPath(sessionId, stateRoot);
  if (!existsSync(recordPath)) {
    if (existsSync(sessionPath)) throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 目标存在但没有本次迁移记录，未覆盖");
    const content = buildClaudeSession(projection, sessionId, workspace);
    const parsed = parseClaudeSession(content, sessionId, workspace);
    const payloadPath = await input.artifacts.writeText("claude-session.jsonl", content);
    await input.artifacts.writeJson("claude-provenance.json", { protocol: CLAUDE_PROTOCOL, sourceThreadId: input.snapshot.thread.id,
      sourceFileSha256: input.snapshot.sourceFile.sha256, sessionId, workspace, usageUnavailable: true,
      messages: projection.provenance.map((m, i) => ({ ...m, targetUuid: parsed.messages[i]!.uuid })) });
    const ledger: Ledger = { protocol: CLAUDE_PROTOCOL, key, sessionId, workspace, configDir: installation.configDir,
      sessionPath, payloadPath, sha256: sha256Text(content), bytes: Buffer.byteLength(content), phase: "intent",
      sourceThreadId: input.snapshot.thread.id, sourceFileSha256: input.snapshot.sourceFile.sha256 };
    await publishExclusive(recordPath, JSON.stringify(ledger));
  }
  const ledger = await readLedger(sessionId, stateRoot);
  if (ledger.key !== key || ledger.workspace !== workspace || ledger.sessionPath !== sessionPath || ledger.sourceFileSha256 !== input.snapshot.sourceFile.sha256 || ledger.sourceThreadId !== input.snapshot.thread.id) {
    throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 迁移来源或工作区不一致");
  }
  await input.artifacts.appendJournal("CLAUDE_IMPORT_INTENT", { sessionId, sessionPath, recordPath });
  let reused = existsSync(sessionPath);
  if (!reused) {
    if (ledger.phase === "completed") throw new MigrationError("CLAUDE_TARGET_CONFLICT", "已迁移的 Claude 会话被移除，未自动重建");
    const payload = await readFile(ledger.payloadPath, "utf8");
    if (sha256Text(payload) !== ledger.sha256) throw new MigrationError("CLAUDE_HISTORY_INVALID", "Claude 待发布产物校验失败");
    parseClaudeSession(payload, sessionId, workspace);
    reused = !await publishExclusive(sessionPath, payload);
  }
  await input.afterPublished?.();
  const stable = await verifyPrefix(ledger);
  const native = await readClaudeNative(installation, workspace, sessionPath, sessionId);
  if (native.cwd !== workspace || native.sessionId !== sessionId || !native.listed) throw new MigrationError("TARGET_SESSION_NOT_PERSISTED", "Claude 原生列表/工作区/ID 回验失败");
  // 原生续聊可能增加压缩边界；只在原始发布态要求恢复上下文与投影全量一致，重复迁移另验原始前缀。
  if (Buffer.byteLength(stable) === ledger.bytes) {
    if (native.messages.length !== projection.messages.length) throw new MigrationError("CLAUDE_HISTORY_INVALID", "Claude 原生回读丢失消息");
    for (const [i, m] of projection.messages.entries()) {
      const actual = native.messages[i];
      const text = typeof actual?.content === "string" ? actual.content : actual?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (actual?.role !== m.role || text !== m.content) throw new MigrationError("CLAUDE_HISTORY_INVALID", `Claude 第 ${i + 1} 条正文或角色不一致`);
    }
  }
  if (await readFile(sessionPath, "utf8") !== stable) throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 回验期间会话发生变化，请在会话空闲后重试");
  await input.artifacts.writeJson("claude-native-readback.json", { ...native, sessionPath, reused, importedMessages: projection.messages.length, continuationVerified: false });
  await atomicWrite(recordPath, JSON.stringify({ ...ledger, phase: "completed" }));
  await input.artifacts.appendJournal("TARGET_VERIFIED", { sessionId, sessionPath, workspace, reused, nativeListed: true, continuationVerified: false });
  return { targetSessionId: sessionId, sessionPath, projection, reused };
}

export async function resolveClaudeTarget(installation: ClaudeInstallation, workspace: string, sessionId: string, root = stateDirectory()): Promise<string> {
  const ledger = await readLedger(sessionId, root);
  if (ledger.configDir !== installation.configDir || ledger.workspace !== workspace) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "Claude 目标工作目录或数据根已变化");
  await verifyPrefix(ledger);
  return ledger.sessionPath;
}

/** 只清理本次创建且未发生原生续聊的文件；不递归删除项目会话目录。 */
export async function rollbackClaudeMigration(sessionId: string, root = stateDirectory()): Promise<void> {
  const ledger = await readLedger(sessionId, root);
  if (existsSync(ledger.sessionPath)) {
    const content = await verifyPrefix(ledger);
    if (Buffer.byteLength(content) !== ledger.bytes || sha256Text(content) !== ledger.sha256) throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 已有续聊或原生状态变化，拒绝删除");
    await unlink(ledger.sessionPath);
  }
  await unlink(ledgerPath(sessionId, root));
}
