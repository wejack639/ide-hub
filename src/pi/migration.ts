import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MigrationArtifacts } from "../artifacts.js";
import { MigrationError } from "../errors.js";
import type { SourceSnapshot } from "../types.js";
import { atomicWrite, defaultDataRoot, sha256Text } from "../util/fs.js";
import { assertSameWorkspace, resolveWorkspace } from "../workspace.js";
import { inspectPi, piSessionDirectory, PI_VERSION, type PiInstallation } from "./discovery.js";
import { parsePiSession, piMigrationKey, projectPiHistory, PI_PROTOCOL } from "./protocol.js";
import { piRuntime } from "./runtime.js";

type PiLedger = { protocol: string; sessionId: string; workspace: string; sessionPath: string; payloadPath: string;
  sha256: string; bytes: number; phase: "intent" | "completed"; sourceThreadId: string; sourceFileSha256: string };
const defaultStateRoot = () => join(defaultDataRoot(), "pi");

/** 独占、完整发布：目标已存在时不覆盖，临时文件不进入 Pi 的 JSONL 列表。 */
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

function ledgerPath(id: string, stateRoot: string): string {
  if (!/^idehub-[a-f0-9]{64}$/.test(id)) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 迁移 Session ID 无效");
  return join(stateRoot, `${id}.json`);
}

async function readLedger(id: string, stateRoot: string): Promise<PiLedger> {
  const ledger = JSON.parse(await readFile(ledgerPath(id, stateRoot), "utf8")) as PiLedger;
  if (ledger.protocol !== PI_PROTOCOL || ledger.sessionId !== id || !ledger.sessionPath.endsWith(`_${id}.jsonl`)) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 来源记录不一致，未修改目标");
  return ledger;
}

async function verifyPrefix(ledger: PiLedger): Promise<string> {
  const target = await readFile(ledger.sessionPath);
  const text = target.toString("utf8");
  parsePiSession(text, ledger.sessionId, ledger.workspace);
  if (target.length < ledger.bytes || sha256Text(target.subarray(0, ledger.bytes)) !== ledger.sha256) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 已导入历史前缀发生变化，未复用或覆盖");
  return text;
}

/** 同源快照创建一次；已有目标只读回验，不重新导入，因此不会抹掉后续聊天。 */
export async function migratePi(input: { snapshot: SourceSnapshot; artifacts: MigrationArtifacts; dryRun: boolean;
  installation?: PiInstallation; stateRoot?: string; afterPublished?: () => Promise<void> }) {
  const installation = input.installation ?? await inspectPi();
  if (!installation.compatible) throw new MigrationError("PI_VERSION_UNSUPPORTED", installation.compatibilityError ?? "Pi 不兼容");
  if (input.snapshot.thread.status.type === "active" || input.snapshot.thread.turns.some(t => t.status === "inProgress")) throw new MigrationError("SOURCE_TURN_RUNNING", "源会话仍在运行");
  const workspace = (await resolveWorkspace(input.snapshot.thread.cwd)).workspaceCanonical;
  await assertSameWorkspace(input.snapshot.workspace, workspace);
  const sessionDir = piSessionDirectory(workspace, installation.agentDir, installation.sessionDir);
  const key = piMigrationKey(input.snapshot, sessionDir);
  const sessionId = `idehub-${key}`;
  const projection = projectPiHistory(input.snapshot);
  const epoch = input.snapshot.thread.createdAt < 1e12 ? input.snapshot.thread.createdAt * 1000 : input.snapshot.thread.createdAt;
  const sessionPath = join(sessionDir, `${new Date(epoch).toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const lineage = { protocol: PI_PROTOCOL, migrationKey: key, sourceProduct: "codex", sourceThreadId: input.snapshot.thread.id,
    sourceFileSha256: input.snapshot.sourceFile.sha256, sourceWorkspace: input.snapshot.thread.cwd, workspace,
    usageUnavailable: true, messages: projection.provenance };
  await input.artifacts.writeJson("pi-history.json", projection);
  await input.artifacts.writeJson("loss-report.json", projection.lossReport);
  await input.artifacts.writeJson("target-plan.json", { targetProduct: "pi", version: PI_VERSION, sessionId, sessionPath, workspace,
    fingerprints: installation.fingerprints, modelInvoked: false, mcpChanged: false, offline: "sandbox-exec deny network*",
    operation: "SessionManager.inMemory -> public entries -> exclusive JSONL publish -> native open/list/context",
    compatibilityNote: projection.compatibilityNote, continuationVerified: false });
  if (input.dryRun) return { targetSessionId: null, sessionPath: null, projection, reused: false };

  const stateRoot = input.stateRoot ?? defaultStateRoot();
  const recordPath = ledgerPath(sessionId, stateRoot);
  if (!existsSync(recordPath)) {
    if (existsSync(sessionPath)) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 目标存在但没有迁移记录，未覆盖");
    const built = await piRuntime(installation, { operation: "build", workspace, sessionId, title: projection.title, messages: projection.messages, lineage });
    const parsed = parsePiSession(built.content, sessionId, workspace);
    const body = parsed.entries.filter(e => e.type === "message").map(e => e.message);
    verifyMessages(body, projection.messages);
    const payloadPath = await input.artifacts.writeText("pi-session.jsonl", built.content);
    const ledger: PiLedger = { protocol: PI_PROTOCOL, sessionId, workspace, sessionPath, payloadPath, sha256: sha256Text(built.content),
      bytes: Buffer.byteLength(built.content), phase: "intent", sourceThreadId: input.snapshot.thread.id, sourceFileSha256: input.snapshot.sourceFile.sha256 };
    await publishExclusive(recordPath, JSON.stringify(ledger));
  }
  const ledger = await readLedger(sessionId, stateRoot);
  if (ledger.workspace !== workspace || ledger.sessionPath !== sessionPath || ledger.sourceFileSha256 !== input.snapshot.sourceFile.sha256 || ledger.sourceThreadId !== input.snapshot.thread.id) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 迁移来源与目标不一致");
  await input.artifacts.appendJournal("PI_IMPORT_INTENT", { sessionId, sessionPath, recordPath });
  let reused = existsSync(sessionPath);
  if (!reused) {
    if (ledger.phase === "completed") throw new MigrationError("PI_TARGET_CONFLICT", "已迁移的 Pi 会话被移除，未自动重建");
    const payload = await readFile(ledger.payloadPath, "utf8");
    if (sha256Text(payload) !== ledger.sha256) throw new MigrationError("PI_HISTORY_INVALID", "Pi 待发布产物校验失败");
    parsePiSession(payload, sessionId, workspace);
    reused = !await publishExclusive(sessionPath, payload);
  }
  await input.afterPublished?.();
  const stable = await verifyPrefix(ledger);
  const native = await piRuntime(installation, { operation: "inspect", path: sessionPath, workspace, sessionId });
  if (native.cwd !== workspace || native.sessionId !== sessionId || !native.listed) throw new MigrationError("TARGET_SESSION_NOT_PERSISTED", "Pi 原生列表/目录/ID 校验失败");
  // 第一次发布要求完整上下文一致；已续聊的 Pi 可以原生分支/压缩，但磁盘导入前缀必须保留。
  if (Buffer.byteLength(stable) === ledger.bytes) verifyMessages(native.messages, projection.messages);
  if (await readFile(sessionPath, "utf8") !== stable) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 验证期间目标发生变化，请在会话空闲后重试");
  await input.artifacts.writeJson("pi-native-readback.json", { ...native, importedMessages: projection.messages.length, reused,
    sessionPath, originalPrefixSha256: ledger.sha256, continuationVerified: false });
  await atomicWrite(recordPath, JSON.stringify({ ...ledger, phase: "completed" }));
  await input.artifacts.appendJournal("TARGET_VERIFIED", { sessionId, sessionPath, workspace, reused, nativeListed: true, continuationVerified: false });
  return { targetSessionId: sessionId, sessionPath, projection, reused };
}

function verifyMessages(actual: any[], expected: ReturnType<typeof projectPiHistory>["messages"]) {
  if (actual.length !== expected.length) throw new MigrationError("PI_HISTORY_INVALID", "Pi 原生上下文消息数量不一致");
  for (const [i, message] of expected.entries()) {
    const found = actual[i];
    const text = typeof found?.content === "string" ? found.content : found?.content?.map((c: any) => c.type === "text" ? c.text : "").join("");
    if (found?.role !== message.role || text !== message.content) throw new MigrationError("PI_HISTORY_INVALID", `Pi 第 ${i + 1} 条原生上下文正文或角色不一致`);
  }
}

/** 打开只解析本次迁移记录，不接受 renderer 传入任意会话文件路径。 */
export async function resolvePiTarget(installation: PiInstallation, workspace: string, sessionId: string, stateRoot = defaultStateRoot()): Promise<string> {
  const ledger = await readLedger(sessionId, stateRoot);
  if (ledger.workspace !== workspace || dirname(ledger.sessionPath) !== piSessionDirectory(workspace, installation.agentDir, installation.sessionDir)) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "Pi 目标工作区或数据根已变化");
  await verifyPrefix(ledger);
  return ledger.sessionPath;
}

/** 仅清理本次未产生续聊的原生文件；保留 Hub 产物，绝不删除整个 cwd 会话目录。 */
export async function rollbackPiMigration(sessionId: string, stateRoot = defaultStateRoot()): Promise<void> {
  const ledger = await readLedger(sessionId, stateRoot);
  if (existsSync(ledger.sessionPath)) {
    const text = await verifyPrefix(ledger);
    if (Buffer.byteLength(text) !== ledger.bytes || sha256Text(text) !== ledger.sha256) throw new MigrationError("PI_TARGET_CONFLICT", "Pi 已有续聊或原生状态变化，拒绝删除");
    await unlink(ledger.sessionPath);
  }
  await unlink(ledgerPath(sessionId, stateRoot));
}
