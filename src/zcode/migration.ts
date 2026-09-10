import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MigrationArtifacts } from "../artifacts.js";
import { MigrationError } from "../errors.js";
import type { SourceSnapshot } from "../types.js";
import { atomicWrite, defaultDataRoot } from "../util/fs.js";
import { resolveWorkspace } from "../workspace.js";
import { ZcodeClient } from "./client.js";
import { discoverZcode, type ZcodeInstallation } from "./discovery.js";
import { projectZcodeHistory, verifyZcodeMessages, zcodeMigrationKey, type ZcodeNativeMessage, type ZcodeSnapshot } from "./protocol.js";
import { backupZcodeDatabase, readZcodeSession, readZcodeTask, registerZcodeTask } from "./storage.js";

/** 原生消息写入 → 新进程恢复和全量回读 → 精确登记桌面索引；中断后从本目标继续。 */
export async function migrateZcode(input: { snapshot: SourceSnapshot; artifacts: MigrationArtifacts; dryRun: boolean;
  installation?: ZcodeInstallation; stateRoot?: string; afterHistoryVerified?: () => Promise<void> }) {
  const installation = input.installation ?? await discoverZcode();
  if (!installation.compatible) throw new MigrationError("ZCODE_VERSION_UNSUPPORTED", installation.compatibilityError ?? "ZCode 不兼容");
  const workspace = (await resolveWorkspace(input.snapshot.workspace.workspaceCanonical)).workspaceCanonical;
  if (workspace !== (await resolveWorkspace(input.snapshot.thread.cwd)).workspaceCanonical) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "源和目标工作区不是同一目录");
  const projection = projectZcodeHistory(input.snapshot);
  const key = zcodeMigrationKey(input.snapshot);
  const targetSessionId = `sess_idehub_${key}`;
  const lineage = { migrationKey: key, sourceThreadId: input.snapshot.thread.id, sourceFileSha256: input.snapshot.sourceFile.sha256, sourceProduct: "codex" as const };
  await input.artifacts.writeJson("zcode-history.json", projection);
  await input.artifacts.writeJson("loss-report.json", projection.lossReport);
  await input.artifacts.writeJson("target-plan.json", { targetProduct: "zcode", targetSessionId, workspace,
    version: installation.version, fingerprints: installation.fingerprints, compatibilityNote: projection.compatibilityNote,
    backendMethods: ["session/create", "session/resume", "session/messages"],
    offline: "sandbox-exec deny network*; isolated config; no child executables; no model credentials",
    taskRegistration: "exact tasks index INSERT; no core message SQL writes", modelInvoked: false, mcpChanged: false,
    openMode: "project-only; locate native task by title and Session ID" });
  if (input.dryRun) return { targetSessionId: null, projection, reused: false };

  const stateRoot = input.stateRoot ?? join(defaultDataRoot(), "zcode");
  await mkdir(stateRoot, { recursive: true });
  // SQLite 只用于本适配器的进程间互斥；崩溃由 SQLite 自动释放锁，不留下阻断恢复的锁文件。
  const coordination = new DatabaseSync(join(stateRoot, "migration-lock.sqlite"));
  try { coordination.exec("BEGIN IMMEDIATE"); }
  catch (error) { coordination.close(); throw new MigrationError("ZCODE_TARGET_CONFLICT", "另一个 ZCode 迁移正在执行，请等待完成", undefined, { cause: error }); }
  const ledgerPath = join(stateRoot, `${key}.json`);
  const calls: string[] = [];
  let client: ZcodeClient | null = null;
  try {
    const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, "utf8")) : null;
    const before = readZcodeSession(installation.sessionDb, targetSessionId);
    if (before && !ledger) throw new MigrationError("ZCODE_TARGET_CONFLICT", "目标 ID 已存在但没有 IDE Hub 来源记录，未覆盖");
    if (ledger && (ledger.migrationKey !== key || ledger.targetSessionId !== targetSessionId || ledger.workspace !== workspace)) throw new MigrationError("ZCODE_TARGET_CONFLICT", "ZCode 迁移来源记录不一致");
    const saveLedger = async (phase: string) => atomicWrite(ledgerPath, JSON.stringify({ ...lineage, targetSessionId, workspace, phase }));
    if (!ledger) {
      await backupZcodeDatabase(installation.sessionDb, join(input.artifacts.directory, "zcode-session-before.sqlite"));
      await backupZcodeDatabase(installation.taskDb, join(input.artifacts.directory, "zcode-tasks-before.sqlite"));
      await saveLedger("intent");
    }
    await input.artifacts.appendJournal("ZCODE_IMPORT_INTENT", { targetSessionId, ledgerPath, reused: !!before });
    const params = { sessionId: targetSessionId, workspace: { workspacePath: workspace, workspaceKey: workspace } };
    client = new ZcodeClient(installation, workspace, join(input.artifacts.directory, "create"));
    await client.start();
    if (before) {
      assertNativeWorkspace(before, workspace);
      await client.request("session/resume", params);
      const existing = await client.request<{ messages: ZcodeNativeMessage[] }>("session/messages", { sessionId: targetSessionId });
      try { verifyZcodeMessages(existing.messages, projection.history.messages, targetSessionId); }
      catch (error) {
        // 只修复尚未发布到桌面的本次半成品；一旦回读已验证或出现续聊，绝不重导入。
        const canRepair = ledger?.phase === "intent" && !readZcodeTask(installation.taskDb, targetSessionId, workspace) &&
          existing.messages.length <= projection.history.messages.length && existing.messages.every((m, i) => {
            const expected = projection.history.messages[i];
            const text = m.parts.map(p => p.type === "text" ? p.text ?? "" : "").join("");
            return expected && m.info.id === `msg_${targetSessionId}_import_${i}` && m.info.role === expected.role &&
              (text === expected.content || (i === existing.messages.length - 1 && m.parts.length === 0));
          });
        if (!canRepair) throw error;
        await client.close(); calls.push(...client.calls);
        client = new ZcodeClient(installation, workspace, join(input.artifacts.directory, "repair"));
        await client.start();
        await client.request("session/create", { ...params, persistence: "immediate", titleGenerationEnabled: false, importedHistory: projection.history });
        await input.artifacts.appendJournal("ZCODE_PARTIAL_IMPORT_RECOVERED", { targetSessionId });
      }
    } else {
      await client.request("session/create", { ...params, persistence: "immediate", titleGenerationEnabled: false, importedHistory: projection.history });
    }
    await client.close(); calls.push(...client.calls);
    // 第二个原生进程从磁盘恢复，而不是验证同一个进程的内存快照。
    client = new ZcodeClient(installation, workspace, join(input.artifacts.directory, "reopen"));
    await client.start();
    const native = await client.request<ZcodeSnapshot>("session/resume", params);
    const readback = await client.request<{ messages: ZcodeNativeMessage[] }>("session/messages", { sessionId: targetSessionId });
    const verification = verifyZcodeMessages(readback.messages, projection.history.messages, targetSessionId);
    if (native.session.sessionId !== targetSessionId || native.session.workspace.workspacePath !== workspace || native.session.workspace.workspaceKey !== workspace) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "ZCode 原生 Workspace 不一致");
    assertNativeWorkspace(readZcodeSession(installation.sessionDb, targetSessionId), workspace);
    await input.artifacts.writeJson("zcode-native-readback.json", { native, ...readback, verification });
    await saveLedger("history-verified");
    await input.afterHistoryVerified?.();
    await registerZcodeTask(installation.taskDb, native, lineage, true);
    const task = readZcodeTask(installation.taskDb, targetSessionId, workspace);
    if (!task || task.workspace_path !== workspace || task.provider !== "glm" || task.deleted !== 0 || task.archived !== 0) throw new MigrationError("TARGET_SESSION_NOT_VISIBLE_IN_IDE", "ZCode 桌面任务登记回读失败");
    await input.artifacts.writeJson("zcode-task-readback.json", task);
    await saveLedger("completed");
    await input.artifacts.appendJournal("TARGET_VERIFIED", { targetSessionId, workspace, ...verification, reused: !!before, desktopIndexVerified: true, uiContinuation: "not-checked-by-migration" });
    return { targetSessionId, projection, reused: !!before };
  } finally {
    try {
      if (client) { await client.close(); calls.push(...client.calls); }
      await input.artifacts.writeJson("zcode-rpc-calls.json", { networkPolicy: "deny network*", methods: calls, modelInvoked: false });
    } finally {
      try { if (coordination.isTransaction) coordination.exec("ROLLBACK"); }
      finally { coordination.close(); }
    }
  }
}

function assertNativeWorkspace(row: ReturnType<typeof readZcodeSession>, workspace: string) {
  if (!row || row.directory !== workspace || row.path !== workspace || row.time_archived !== null) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "ZCode session.directory/path 或归档状态不一致");
}
