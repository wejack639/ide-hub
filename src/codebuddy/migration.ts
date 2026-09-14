import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { MigrationArtifacts } from "../artifacts.js";
import { MigrationError } from "../errors.js";
import type {
  CodeBuddyInstallation,
  CodeBuddyTargetProduct,
  McpFingerprint,
  MigrationResult,
  SourceSnapshot,
} from "../types.js";
import { atomicWrite, defaultDataRoot } from "../util/fs.js";
import { stablePrettyJson } from "../util/stable-json.js";
import { assertSameWorkspace } from "../workspace.js";
import {
  discoverCodeBuddy,
  openCodeBuddyWorkspace,
  revealCodeBuddyArchive,
} from "./discovery.js";
import {
  type CodeBuddyArchive,
  type CodeBuddyProjection,
  CODEBUDDY_ARCHIVE_MAX_BYTES,
  CODEBUDDY_PROTOCOL_VERSION,
  buildCodeBuddyArchive,
  codeBuddyMigrationKey,
  projectCodeBuddyHistory,
  serializeCodeBuddyArchive,
} from "./protocol.js";
import {
  type CodeBuddyImportVerification,
  codeBuddyWorkspaceHash,
  findCodeBuddyImportedConversation,
  verifyCodeBuddyConversationAt,
} from "./storage.js";

type CodeBuddyMapping = {
  schemaVersion: "ide-hub-codebuddy-mapping-v1";
  migrationKey: string;
  targetProduct: CodeBuddyTargetProduct;
  archiveId: string;
  targetSessionId: string;
  workspace: string;
  historyWorkspaceRoot: string;
  targetHistoryPath: string;
  sourceThreadId: string;
  sourceFileSha256: string;
  targetVersion: string;
  extensionSha256: string;
  importedRequestCount?: number;
  importedMessageCount?: number;
  createdAt: string;
};

export type CodeBuddyRollbackInspection = {
  status: "WAITING_OFFICIAL_DELETE";
  targetProduct: CodeBuddyTargetProduct;
  targetSessionId: string;
  archiveId: string;
  workspace: string;
  importedRequestCount: number;
  importedMessageCount: number;
  continuationRequestCount: number;
  continuationMessageCount: number;
  continuationWillBeDeleted: boolean;
};

export type CodeBuddyMigrationOutcome = {
  status: "DRY_RUN" | "WAITING_TARGET_IMPORT" | "COMPLETED";
  targetSessionId: string | null;
  archive: CodeBuddyArchive;
  archivePath: string;
  archiveBytes: number;
  workspaceHash: string;
  projection: CodeBuddyProjection;
  verification: CodeBuddyImportVerification | null;
  reused: boolean;
};

/** 生成官方 archive；只有目标产品官方 Import 的日志与原生磁盘回读同时通过才完成。 */
export async function migrateCodeBuddy(input: {
  snapshot: SourceSnapshot;
  artifacts: MigrationArtifacts;
  targetProduct: CodeBuddyTargetProduct;
  dryRun: boolean;
  mcpFingerprintBefore?: McpFingerprint;
  installation?: CodeBuddyInstallation;
  stateRoot?: string;
  openWorkspace?: (installation: CodeBuddyInstallation, workspace: string) => void;
  revealArchive?: (path: string) => Promise<void>;
}): Promise<CodeBuddyMigrationOutcome> {
  const installation = input.installation ?? await discoverCodeBuddy(input.targetProduct);
  assertTargetInstallation(installation, input.targetProduct);
  const workspace = input.snapshot.workspace.workspaceCanonical;
  await assertSameWorkspace(input.snapshot.workspace, input.snapshot.thread.cwd);
  const projection = projectCodeBuddyHistory(input.snapshot, input.targetProduct);
  const archive = buildCodeBuddyArchive(input.snapshot, projection, input.targetProduct);
  const archiveText = serializeCodeBuddyArchive(archive);
  const archiveBytes = Buffer.byteLength(archiveText, "utf8");
  const archivePath = await input.artifacts.writeText(
    `codebuddy-import/${input.targetProduct}-${archive.data.conversations[0].id}.json`,
    archiveText,
  );
  await input.artifacts.writeJson("codebuddy-projection.json", projection);
  await input.artifacts.writeJson("loss-report.json", projection.lossReport);
  const migrationKey = codeBuddyMigrationKey(input.snapshot, input.targetProduct);
  const workspaceHash = codeBuddyWorkspaceHash(workspace);
  await input.artifacts.writeJson("target-plan.json", {
    targetProduct: input.targetProduct,
    targetBundleId: installation.bundleId,
    targetAppPath: installation.appPath,
    targetVersion: installation.version,
    targetProductCommit: installation.productCommit,
    targetExtensionVersion: installation.extensionVersion,
    targetExtensionSha256: installation.extensionSha256,
    sourceWorkspace: workspace,
    targetWorkspace: workspace,
    workspaceHash,
    targetSessionId: null,
    archiveId: archive.data.conversations[0].id,
    archivePath,
    archiveBytes,
    archiveMaxBytes: CODEBUDDY_ARCHIVE_MAX_BYTES,
    migrationKey,
    protocolVersion: CODEBUDDY_PROTOCOL_VERSION,
    operation: "codebuddy-conversation-v1-official-history-import",
    importMode: "user-confirms-target-history-file-dialog",
    openArgv: ["--reuse-window", workspace],
    modelMethodsForbidden: ["buddy chat", "buddycn chat"],
    modelInvoked: false,
    mcpChanged: false,
    ...(input.mcpFingerprintBefore === undefined
      ? {}
      : { mcpFingerprintBefore: input.mcpFingerprintBefore }),
  });
  await input.artifacts.appendJournal("ARCHIVE_READY", {
    targetProduct: input.targetProduct,
    archiveId: archive.data.conversations[0].id,
    archivePath,
    archiveBytes,
    workspace,
    workspaceHash,
  });

  if (input.dryRun) {
    return {
      status: "DRY_RUN",
      targetSessionId: null,
      archive,
      archivePath,
      archiveBytes,
      workspaceHash,
      projection,
      verification: null,
      reused: false,
    };
  }

  const stateRoot = input.stateRoot ?? join(defaultDataRoot(), "codebuddy");
  const existing = await readMapping(stateRoot, input.targetProduct, migrationKey);
  if (existing !== null) {
    assertMapping(existing, input.snapshot, installation, migrationKey);
    assertUnderRoot(existing.historyWorkspaceRoot, installation.historyDataRoot);
    const verification = await verifyCodeBuddyConversationAt({
      workspace,
      historyWorkspaceRoot: existing.historyWorkspaceRoot,
      targetSessionId: existing.targetSessionId,
      expectedConversation: archive.data.conversations[0],
    });
    await writeMapping(stateRoot, input.snapshot, installation, migrationKey, verification);
    await input.artifacts.appendJournal("TARGET_REUSED", verification);
    return completed(archive, archivePath, archiveBytes, workspaceHash, projection, verification, true);
  }

  const imported = await findCodeBuddyImportedConversation({
    installation,
    workspace,
    expectedConversation: archive.data.conversations[0],
  });
  if (imported !== null) {
    await writeMapping(stateRoot, input.snapshot, installation, migrationKey, imported);
    await input.artifacts.appendJournal("TARGET_VERIFIED", imported);
    return completed(archive, archivePath, archiveBytes, workspaceHash, projection, imported, false);
  }

  const openWorkspace = input.openWorkspace ?? openCodeBuddyWorkspace;
  const revealArchive = input.revealArchive ?? revealCodeBuddyArchive;
  openWorkspace(installation, workspace);
  await input.artifacts.appendJournal("CODEBUDDY_OPEN_REQUESTED", {
    targetProduct: input.targetProduct,
    bundleId: installation.bundleId,
    launcherPath: installation.launcherPath,
    argv: ["--reuse-window", workspace],
    workspace,
    prompt: null,
  });
  await revealArchive(archivePath);
  await input.artifacts.appendJournal("WAITING_TARGET_IMPORT", {
    targetProduct: input.targetProduct,
    archiveId: archive.data.conversations[0].id,
    archivePath,
    workspace,
    instruction: "在当前 CodeBuddy 工作区的 History 中选择 Import，并选择该 JSON 文件",
  });
  return {
    status: "WAITING_TARGET_IMPORT",
    targetSessionId: null,
    archive,
    archivePath,
    archiveBytes,
    workspaceHash,
    projection,
    verification: null,
    reused: false,
  };
}

/** 取消只结束本次等待任务并保留审计归档，不触碰 Codex 或 CodeBuddy History。 */
export async function cancelCodeBuddyWaitingMigration(
  migrationId: string,
  dataRoot = defaultDataRoot(),
): Promise<MigrationResult> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(migrationId)) {
    throw new MigrationError("CODEBUDDY_MIGRATION_NOT_FOUND", "CodeBuddy migration ID 无效");
  }
  const artifacts = new MigrationArtifacts(migrationId, dataRoot);
  const resultPath = join(artifacts.directory, "target-result.json");
  let result: MigrationResult;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8")) as MigrationResult;
  } catch (error) {
    throw new MigrationError(
      "CODEBUDDY_MIGRATION_NOT_FOUND",
      "没有找到等待中的 CodeBuddy 迁移任务",
      { migrationId },
      { cause: error },
    );
  }
  if (
    result.migrationId !== migrationId ||
    (result.continuation.product !== "codebuddy-international" && result.continuation.product !== "codebuddy-cn") ||
    result.status !== "WAITING_TARGET_IMPORT" ||
    result.targetSessionId !== null ||
    result.details.codeBuddy === undefined ||
    result.details.codeBuddy.importVerified
  ) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_CONFLICT",
      "只有尚未完成官方 Import 的 CodeBuddy 等待任务可以取消",
      { migrationId, status: result.status },
    );
  }
  const cancelled: MigrationResult = { ...result, status: "CANCELLED" };
  await artifacts.writeJson("target-result.json", cancelled);
  await artifacts.appendJournal("CANCELLED", {
    targetProduct: result.continuation.product,
    archiveId: result.details.codeBuddy.archiveId,
    archivePreserved: true,
    sourceChanged: false,
    targetChanged: false,
  });
  return cancelled;
}

/**
 * 回滚只做只读预检并打开正确产品的 A；会话删除必须由用户在官方 History 中确认。
 * 默认拒绝删除已经产生续聊的会话。
 */
export async function prepareCodeBuddyRollback(input: {
  targetProduct: CodeBuddyTargetProduct;
  workspace: string;
  archiveId: string;
  targetSessionId: string;
  allowDeleteContinuation: boolean;
  installation?: CodeBuddyInstallation;
  stateRoot?: string;
  openWorkspace?: (installation: CodeBuddyInstallation, workspace: string) => void;
}): Promise<CodeBuddyRollbackInspection> {
  const installation = input.installation ?? await discoverCodeBuddy(input.targetProduct);
  assertTargetInstallation(installation, input.targetProduct);
  const mapping = await readRollbackMapping(input, installation, input.stateRoot);
  const counts = await readMappedNativeCounts(mapping, installation);
  const hasContinuation = counts.continuationRequestCount > 0 || counts.continuationMessageCount > 0;
  if (hasContinuation && !input.allowDeleteContinuation) {
    throw new MigrationError(
      "CODEBUDDY_ROLLBACK_HAS_CONTINUATION",
      "该 CodeBuddy 会话已经产生目标端新增聊天，默认保留；如需连同新增聊天删除，必须再次明确确认",
      counts,
    );
  }
  (input.openWorkspace ?? openCodeBuddyWorkspace)(installation, mapping.workspace);
  return {
    status: "WAITING_OFFICIAL_DELETE",
    targetProduct: mapping.targetProduct,
    targetSessionId: mapping.targetSessionId,
    archiveId: mapping.archiveId,
    workspace: mapping.workspace,
    ...counts,
    continuationWillBeDeleted: hasContinuation,
  };
}

/** 官方 History 删除完成后，只撤销本次 Hub 映射；归档、源会话及其他目标不删除。 */
export async function confirmCodeBuddyRollbackDeleted(input: {
  targetProduct: CodeBuddyTargetProduct;
  workspace: string;
  archiveId: string;
  targetSessionId: string;
  installation?: CodeBuddyInstallation;
  stateRoot?: string;
}): Promise<{ status: "ROLLED_BACK"; targetProduct: CodeBuddyTargetProduct; targetSessionId: string }> {
  const installation = input.installation ?? await discoverCodeBuddy(input.targetProduct);
  assertTargetInstallation(installation, input.targetProduct);
  const mapping = await readRollbackMapping(input, installation, input.stateRoot);
  assertUnderRoot(mapping.historyWorkspaceRoot, installation.historyDataRoot);
  const expectedTargetIndex = resolve(mapping.historyWorkspaceRoot, mapping.targetSessionId, "index.json");
  if (resolve(mapping.targetHistoryPath) !== expectedTargetIndex) {
    throw new MigrationError("CODEBUDDY_TARGET_CONFLICT", "CodeBuddy 回滚映射中的目标路径不一致");
  }
  const workspaceIndexPath = resolve(mapping.historyWorkspaceRoot, "index.json");
  let stillListed = false;
  if (existsSync(workspaceIndexPath)) {
    const workspaceIndex = await readJsonRecord(workspaceIndexPath, "CodeBuddy 工作区 History 索引损坏");
    if (!Array.isArray(workspaceIndex.conversations)) {
      throw new MigrationError("CODEBUDDY_HISTORY_INVALID", "CodeBuddy 工作区 History 索引结构无效");
    }
    stillListed = workspaceIndex.conversations.some((value) =>
      isRecord(value) && value.id === mapping.targetSessionId,
    );
  }
  const targetRootExists = existsSync(resolve(mapping.historyWorkspaceRoot, mapping.targetSessionId));
  if (stillListed || targetRootExists) {
    throw new MigrationError(
      "CODEBUDDY_ROLLBACK_PENDING",
      "目标会话仍存在；请先在所选 CodeBuddy 版本的官方 History 中删除确切会话，再回来检查",
      { targetSessionId: mapping.targetSessionId, stillListed, targetRootExists },
    );
  }
  await unlink(mappingPath(input.stateRoot ?? join(defaultDataRoot(), "codebuddy"), mapping.targetProduct, mapping.migrationKey));
  return { status: "ROLLED_BACK", targetProduct: mapping.targetProduct, targetSessionId: mapping.targetSessionId };
}

function completed(
  archive: CodeBuddyArchive,
  archivePath: string,
  archiveBytes: number,
  workspaceHash: string,
  projection: CodeBuddyProjection,
  verification: CodeBuddyImportVerification,
  reused: boolean,
): CodeBuddyMigrationOutcome {
  return {
    status: "COMPLETED",
    targetSessionId: verification.targetSessionId,
    archive,
    archivePath,
    archiveBytes,
    workspaceHash,
    projection,
    verification,
    reused,
  };
}

function mappingPath(
  stateRoot: string,
  targetProduct: CodeBuddyTargetProduct,
  migrationKey: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(migrationKey)) {
    throw new MigrationError("CODEBUDDY_TARGET_CONFLICT", "CodeBuddy 迁移键无效");
  }
  return join(stateRoot, targetProduct, `${migrationKey}.json`);
}

async function readMapping(
  stateRoot: string,
  targetProduct: CodeBuddyTargetProduct,
  migrationKey: string,
): Promise<CodeBuddyMapping | null> {
  const path = mappingPath(stateRoot, targetProduct, migrationKey);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as CodeBuddyMapping;
  } catch (error) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_CONFLICT",
      "CodeBuddy 幂等映射损坏，未重新导入或覆盖目标",
      { path },
      { cause: error },
    );
  }
}

async function writeMapping(
  stateRoot: string,
  source: SourceSnapshot,
  installation: CodeBuddyInstallation,
  migrationKey: string,
  verification: CodeBuddyImportVerification,
): Promise<void> {
  const mapping: CodeBuddyMapping = {
    schemaVersion: "ide-hub-codebuddy-mapping-v1",
    migrationKey,
    targetProduct: installation.targetProduct,
    archiveId: verification.archiveId,
    targetSessionId: verification.targetSessionId,
    workspace: verification.workspace,
    historyWorkspaceRoot: verification.historyRoot,
    targetHistoryPath: verification.targetHistoryPath,
    sourceThreadId: source.thread.id,
    sourceFileSha256: source.sourceFile.sha256,
    targetVersion: installation.version,
    extensionSha256: installation.extensionSha256,
    importedRequestCount: verification.importedRequestCount,
    importedMessageCount: verification.importedMessageCount,
    createdAt: new Date().toISOString(),
  };
  await atomicWrite(
    mappingPath(stateRoot, installation.targetProduct, migrationKey),
    stablePrettyJson(mapping),
  );
}

async function readRollbackMapping(
  input: {
    targetProduct: CodeBuddyTargetProduct;
    workspace: string;
    archiveId: string;
    targetSessionId: string;
  },
  installation: CodeBuddyInstallation,
  stateRoot?: string,
): Promise<CodeBuddyMapping> {
  const migrationKey = migrationKeyFromArchiveId(input.targetProduct, input.archiveId);
  const root = stateRoot ?? join(defaultDataRoot(), "codebuddy");
  const mapping = await readMapping(root, input.targetProduct, migrationKey);
  if (mapping === null) {
    throw new MigrationError("CODEBUDDY_MIGRATION_NOT_FOUND", "没有找到这次 CodeBuddy 迁移的幂等映射");
  }
  if (
    mapping.archiveId !== input.archiveId ||
    mapping.targetSessionId !== input.targetSessionId ||
    mapping.targetProduct !== input.targetProduct ||
    mapping.workspace !== input.workspace ||
    mapping.targetVersion !== installation.version ||
    mapping.extensionSha256 !== installation.extensionSha256
  ) {
    throw new MigrationError("CODEBUDDY_TARGET_CONFLICT", "CodeBuddy 回滚请求与本次迁移的目标、版本或工作区不一致");
  }
  return mapping;
}

async function readMappedNativeCounts(
  mapping: CodeBuddyMapping,
  installation: CodeBuddyInstallation,
): Promise<{
  importedRequestCount: number;
  importedMessageCount: number;
  continuationRequestCount: number;
  continuationMessageCount: number;
}> {
  const importedRequestCount = mapping.importedRequestCount;
  const importedMessageCount = mapping.importedMessageCount;
  if (
    typeof importedRequestCount !== "number" ||
    !Number.isInteger(importedRequestCount) ||
    importedRequestCount < 0 ||
    typeof importedMessageCount !== "number" ||
    !Number.isInteger(importedMessageCount) ||
    importedMessageCount < 0
  ) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_CONFLICT",
      "CodeBuddy 迁移映射缺少回滚基线；请先重新执行同一迁移以刷新原生回读",
    );
  }
  assertUnderRoot(mapping.historyWorkspaceRoot, installation.historyDataRoot);
  const expectedTargetIndex = resolve(mapping.historyWorkspaceRoot, mapping.targetSessionId, "index.json");
  if (resolve(mapping.targetHistoryPath) !== expectedTargetIndex) {
    throw new MigrationError("CODEBUDDY_TARGET_CONFLICT", "CodeBuddy 回滚映射中的目标路径不一致");
  }
  const index = await readJsonRecord(expectedTargetIndex, "CodeBuddy 目标会话不存在或索引损坏");
  if (!Array.isArray(index.requests) || !Array.isArray(index.messages)) {
    throw new MigrationError("CODEBUDDY_HISTORY_INVALID", "CodeBuddy 目标会话索引结构无效");
  }
  const continuationRequestCount = index.requests.length - importedRequestCount;
  const continuationMessageCount = index.messages.length - importedMessageCount;
  if (continuationRequestCount < 0 || continuationMessageCount < 0) {
    throw new MigrationError("CODEBUDDY_HISTORY_INVALID", "CodeBuddy 目标会话比导入基线更短，拒绝恢复");
  }
  return {
    importedRequestCount,
    importedMessageCount,
    continuationRequestCount,
    continuationMessageCount,
  };
}

function migrationKeyFromArchiveId(
  targetProduct: CodeBuddyTargetProduct,
  archiveId: string,
): string {
  const prefix = targetProduct === "codebuddy-international" ? "idehub_cb_intl_" : "idehub_cb_cn_";
  const migrationKey = archiveId.startsWith(prefix) ? archiveId.slice(prefix.length) : "";
  if (!/^[a-f0-9]{64}$/u.test(migrationKey)) {
    throw new MigrationError("CODEBUDDY_TARGET_CONFLICT", "CodeBuddy archive ID 与目标版本不匹配");
  }
  return migrationKey;
}

async function readJsonRecord(path: string, message: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("JSON root is not an object");
    return value;
  } catch (error) {
    throw new MigrationError("CODEBUDDY_HISTORY_INVALID", message, { path }, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMapping(
  mapping: CodeBuddyMapping,
  source: SourceSnapshot,
  installation: CodeBuddyInstallation,
  migrationKey: string,
): void {
  if (
    mapping.schemaVersion !== "ide-hub-codebuddy-mapping-v1" ||
    mapping.migrationKey !== migrationKey ||
    mapping.targetProduct !== installation.targetProduct ||
    mapping.workspace !== source.workspace.workspaceCanonical ||
    mapping.sourceThreadId !== source.thread.id ||
    mapping.sourceFileSha256 !== source.sourceFile.sha256 ||
    mapping.targetVersion !== installation.version ||
    mapping.extensionSha256 !== installation.extensionSha256 ||
    !/^[A-Za-z0-9_-]+$/u.test(mapping.targetSessionId)
  ) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_CONFLICT",
      "CodeBuddy 已有幂等映射与当前源快照、目标版本或工作区不一致",
    );
  }
}

function assertTargetInstallation(
  installation: CodeBuddyInstallation,
  targetProduct: CodeBuddyTargetProduct,
): void {
  if (!installation.compatible || installation.targetProduct !== targetProduct) {
    throw new MigrationError(
      "CODEBUDDY_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "CodeBuddy 目标安装身份不匹配",
    );
  }
}

function assertUnderRoot(path: string, root: string): void {
  const child = resolve(path);
  const parent = resolve(root);
  const childRelative = relative(parent, child);
  if (childRelative.startsWith("..") || childRelative.startsWith(sep) || childRelative === "") {
    throw new MigrationError(
      "CODEBUDDY_TARGET_CONFLICT",
      "CodeBuddy 幂等映射指向目标数据根之外",
    );
  }
}
