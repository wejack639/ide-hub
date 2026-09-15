import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chown,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { MigrationError } from "../errors.js";
import { defaultDataRoot, readTextIfExists, sha256Text } from "../util/fs.js";
import { stableJson, stablePrettyJson } from "../util/stable-json.js";
import { verifyStdioHandshake } from "./handshake.js";
import {
  shouldRunNativeMcpProbe,
  verifyNativeMcpRecognition,
} from "./native-verification.js";
import {
  discoverMcpTargets,
  renderMcpServer,
  resolveMcpTarget,
  type McpTargetProfile,
} from "./targets.js";
import type {
  McpConflictResolution,
  McpFailureDetail,
  McpFieldChoice,
  McpFieldDiff,
  McpJobSummary,
  McpMigrationPlan,
  McpMigrationReceipt,
  McpMigrationRequest,
  McpNativeRecognitionProbeResult,
  McpRuntimeOptions,
  McpServer,
  McpServerDiff,
  McpSourceSnapshot,
  McpTargetProduct,
  McpTargetScope,
} from "./types.js";
import { MCP_TARGET_PRODUCTS } from "./types.js";

const MISSING_FINGERPRINT = sha256Text("ide-hub:mcp:missing-target-v1");
const DSH_START = "# ide-hub:mcp:start";
const DSH_END = "# ide-hub:mcp:end";
const TARGET_AFTER_SNAPSHOT = "target-after.config";

type TargetState = {
  profile: McpTargetProfile;
  text: string | null;
  fingerprint: string;
  servers: Record<string, unknown>;
  managedDshBlocks: Record<string, { hash: string; block: string }>;
  unmanagedDshNames: Set<string>;
  shadowedNames: Map<string, string>;
};

type PlannedOperation = {
  server: McpServer;
  targetName: string;
  action: "noop" | "skip" | "set";
  value: Record<string, unknown> | null;
  dshBlock: string | null;
};

type TargetFileMetadata = {
  mode: number;
  uid: number;
  gid: number;
};

type BuiltPlan = {
  plan: McpMigrationPlan;
  source: McpSourceSnapshot;
  target: TargetState;
  operations: PlannedOperation[];
};

type McpJournalStatus =
  | "APPLYING"
  | McpJobSummary["status"];

type McpMigrationJournal = {
  schemaVersion: "ide-hub-mcp-journal-v1";
  mcpMigrationId: string;
  planId: string;
  status: McpJournalStatus;
  targetProduct: McpTargetProduct;
  targetScope: McpTargetScope;
  selectedServerIds: string[];
  targetConfigPath: string;
  targetBeforeSha256: string;
  expectedTargetAfterSha256: string;
  targetAfterSha256: string | null;
  backupPath: string | null;
  createdTargetFile: boolean;
  changed: boolean;
  beforeMode: number | null;
  beforeUid: number | null;
  beforeGid: number | null;
  startedAt: string;
  completedAt: string | null;
  failure?: McpFailureDetail | null;
};

const ACTIVE_MCP_JOB_IDS = new Set<string>();

export async function planMcpMigration(
  request: McpMigrationRequest,
  options: McpRuntimeOptions = {},
  providedSource?: McpSourceSnapshot,
): Promise<McpMigrationPlan> {
  return (await buildPlan(request, options, providedSource)).plan;
}

export async function applyMcpMigration(
  preview: McpMigrationPlan,
  options: McpRuntimeOptions = {},
  providedSource?: McpSourceSnapshot,
): Promise<McpMigrationReceipt> {
  validatePlanShape(preview);
  const built = await buildPlan(preview.request, options, providedSource);
  if (built.source.sourceFingerprint !== preview.sourceFingerprint) {
    throw new MigrationError("MCP_TARGET_CHANGED", "Codex MCP source changed after preview; regenerate the diff");
  }
  if (built.target.fingerprint !== preview.targetFingerprint) {
    throw new MigrationError("MCP_TARGET_CHANGED", "Target MCP configuration changed after preview; regenerate the diff");
  }
  if (!built.plan.canApply) {
    throw new MigrationError("MCP_CONFLICT_UNRESOLVED", "MCP plan still contains conflicts or unsupported servers");
  }

  const migrationId = randomUUID();
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const jobDir = join(dataRoot, "mcp", "jobs", migrationId);
  const backupDir = join(dataRoot, "mcp", "backups");
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(jobDir, "plan.json"), preview);

  const targetPath = built.target.profile.configPath!;
  const beforeText = built.target.text;
  const beforeMetadata = await fileMetadataIfExists(targetPath);
  const changed = built.operations.some((operation) => operation.action === "set");
  const backupPath = !changed || beforeText === null
    ? null
    : join(backupDir, `${sha256Text(beforeText)}.config`);
  if (backupPath) {
    try {
      await access(backupPath, constants.R_OK);
      if (sha256Text(await readFile(backupPath, "utf8")) !== sha256Text(beforeText!)) {
        await atomicWritePreservingMode(backupPath, beforeText!, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWritePreservingMode(backupPath, beforeText!, 0o600);
    }
  }

  const nextText = built.target.profile.format === "dsh-yaml"
    ? applyDshOperations(beforeText ?? "", built.operations)
    : applyJsonOperations(beforeText ?? "{}\n", built.target.profile, built.operations);
  let journal: McpMigrationJournal = {
    schemaVersion: "ide-hub-mcp-journal-v1",
    mcpMigrationId: migrationId,
    planId: preview.planId,
    status: "APPLYING",
    targetProduct: preview.request.targetProduct,
    targetScope: preview.request.targetScope,
    selectedServerIds: [...preview.request.selectedServerIds],
    targetConfigPath: targetPath,
    targetBeforeSha256: built.target.fingerprint,
    expectedTargetAfterSha256: changed ? sha256Text(nextText) : built.target.fingerprint,
    targetAfterSha256: null,
    backupPath,
    createdTargetFile: changed && beforeText === null,
    changed,
    beforeMode: beforeMetadata?.mode ?? null,
    beforeUid: beforeMetadata?.uid ?? null,
    beforeGid: beforeMetadata?.gid ?? null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    failure: null,
  };
  const journalPath = join(jobDir, "journal.json");
  const receiptPath = join(jobDir, "receipt.json");
  ACTIVE_MCP_JOB_IDS.add(migrationId);
  try {
    // The applying journal is durable before the target can change, so a restart can classify it by hash.
    await writePrivateJson(journalPath, journal);
    let receipt: McpMigrationReceipt;
    let failureStage: McpFailureDetail["stage"] = "target-write";
    try {
      if (changed) {
        await assertNotSymlink(targetPath);
        await atomicWritePreservingMode(targetPath, nextText, beforeMetadata?.mode ?? 0o600, beforeMetadata ?? undefined);
      }
      failureStage = "target-readback";
      const reread = await readTargetState(built.target.profile);
      if (changed && reread.text !== null) {
        await atomicWritePreservingMode(join(jobDir, TARGET_AFTER_SNAPSHOT), reread.text, 0o600);
      }
      failureStage = "verification";
      const nativeRecognition = await runNativeRecognitionProbe(
        preview.request,
        targetPath,
        built.operations,
        options,
        Date.parse(journal.startedAt),
      );
      const verification = await verifyAppliedOperations(reread, built.operations, options, nativeRecognition);
      const failedRoundTrip = verification.some((item) => !item.configRoundTrip);
      if (failedRoundTrip) {
        throw new MigrationError("MCP_VERIFY_FAILED", "Target MCP configuration failed semantic round-trip verification");
      }
      const failedNativeRecognition = verification.find((item) => item.nativeRecognition === "failed");
      if (failedNativeRecognition) {
        throw new MigrationError(
          "MCP_VERIFY_FAILED",
          failedNativeRecognition.nativeDetail ?? `Target application did not recognize ${failedNativeRecognition.name}`,
        );
      }
      const hasWarnings = verification.some((item) =>
        item.handshake !== "passed" || item.nativeRecognition !== "passed"
      );
      receipt = {
        schemaVersion: "ide-hub-mcp-receipt-v2",
        mcpMigrationId: migrationId,
        planId: preview.planId,
        status: hasWarnings ? "COMPLETED_WITH_WARNINGS" : "COMPLETED",
        sourceProduct: "codex",
        targetProduct: preview.request.targetProduct,
        sourceScope: preview.request.scope,
        targetScope: preview.request.targetScope,
        selectedServerIds: [...preview.request.selectedServerIds],
        targetConfigPath: targetPath,
        targetBeforeSha256: built.target.fingerprint,
        targetAfterSha256: reread.fingerprint,
        backupPath,
        createdTargetFile: changed && beforeText === null,
        changed,
        completedAt: new Date().toISOString(),
        verification,
      };
      await writePrivateJson(receiptPath, receipt);
    } catch (error) {
      let rollbackFailure: unknown = null;
      try {
        // A failed temporary write leaves the target untouched. Avoid turning the original
        // permission/disk error into a false rollback conflict by rewriting an unchanged file.
        if (changed && await currentTargetFingerprint(targetPath) !== built.target.fingerprint) {
          await restoreTarget(targetPath, beforeText, beforeMetadata);
        }
        if (await currentTargetFingerprint(targetPath) !== built.target.fingerprint) {
          throw new Error("restored target fingerprint does not match the pre-migration fingerprint");
        }
      } catch (restoreError) {
        rollbackFailure = restoreError;
      }
      journal = {
        ...journal,
        status: rollbackFailure ? "RECOVERY_CONFLICT" : "ROLLED_BACK_AFTER_FAILURE",
        completedAt: new Date().toISOString(),
        failure: rollbackFailure
          ? failureDetail("rollback", rollbackFailure, error)
          : failureDetail(failureStage, error),
      };
      await writePrivateJson(journalPath, journal).catch(() => undefined);
      if (rollbackFailure) {
        throw new MigrationError(
          "MCP_VERIFY_FAILED",
          "MCP migration failed and the automatic rollback could not be verified",
          undefined,
          { cause: rollbackFailure },
        );
      }
      throw error;
    }
    journal = {
      ...journal,
      status: receipt.status,
      targetAfterSha256: receipt.targetAfterSha256,
      completedAt: receipt.completedAt,
    };
    // A completed receipt is authoritative if the final journal refresh itself is interrupted.
    await writePrivateJson(journalPath, journal).catch(() => undefined);
    return receipt;
  } finally {
    ACTIVE_MCP_JOB_IDS.delete(migrationId);
  }
}

export async function rollbackMcpMigration(
  migrationId: string,
  options: McpRuntimeOptions = {},
): Promise<McpMigrationReceipt> {
  if (!/^[a-f0-9-]{36}$/iu.test(migrationId)) {
    throw new MigrationError("MCP_INVALID_REQUEST", "mcpMigrationId is invalid");
  }
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const jobDir = join(dataRoot, "mcp", "jobs", migrationId);
  let receipt: McpMigrationReceipt;
  let journal: McpMigrationJournal;
  let plan: McpMigrationPlan;
  try {
    receipt = JSON.parse(await readFile(join(jobDir, "receipt.json"), "utf8")) as McpMigrationReceipt;
    journal = JSON.parse(await readFile(join(jobDir, "journal.json"), "utf8")) as McpMigrationJournal;
    plan = JSON.parse(await readFile(join(jobDir, "plan.json"), "utf8")) as McpMigrationPlan;
  } catch (error) {
    throw new MigrationError("MCP_JOB_NOT_FOUND", `MCP migration ${migrationId} was not found`, undefined, { cause: error });
  }
  if (receipt.status === "ROLLED_BACK") return receipt;
  validatePlanShape(plan);
  if (
    receipt.mcpMigrationId !== migrationId ||
    journal.mcpMigrationId !== migrationId ||
    receipt.planId !== plan.planId ||
    receipt.targetConfigPath !== journal.targetConfigPath ||
    plan.targetConfigPath !== journal.targetConfigPath
  ) {
    throw new MigrationError("MCP_JOB_NOT_FOUND", "MCP migration artifacts do not describe the same target");
  }
  const boundary = targetBoundary(plan.request, options);
  await assertSafeTargetPath(journal.targetConfigPath, boundary);
  if (!journal.changed) {
    receipt = { ...receipt, status: "ROLLED_BACK" };
    await writePrivateJson(join(jobDir, "receipt.json"), receipt);
    await writePrivateJson(join(jobDir, "journal.json"), {
      ...journal,
      status: "ROLLED_BACK",
      completedAt: new Date().toISOString(),
    });
    return receipt;
  }
  const currentFingerprint = await currentTargetFingerprint(journal.targetConfigPath);
  let rollbackMode: "exact" | "selected-only" = "exact";
  if (currentFingerprint === journal.targetAfterSha256) {
    await restoreTargetFromJournal(journal, dataRoot);
    if (await currentTargetFingerprint(journal.targetConfigPath) !== receipt.targetBeforeSha256) {
      throw new MigrationError("MCP_VERIFY_FAILED", "MCP rollback fingerprint does not match the pre-migration target");
    }
  } else {
    await restoreSelectedServersPreservingExternalChanges(plan, journal, jobDir, dataRoot, options);
    rollbackMode = "selected-only";
  }
  receipt = {
    ...receipt,
    status: "ROLLED_BACK",
    rollbackMode,
    rollbackTargetSha256: await currentTargetFingerprint(journal.targetConfigPath),
  };
  await writePrivateJson(join(jobDir, "receipt.json"), receipt);
  await writePrivateJson(join(jobDir, "journal.json"), {
    ...journal,
    status: "ROLLED_BACK",
    completedAt: new Date().toISOString(),
  });
  return receipt;
}

export async function listMcpJobs(options: McpRuntimeOptions = {}): Promise<McpJobSummary[]> {
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const jobsRoot = join(dataRoot, "mcp", "jobs");
  let entries: string[];
  try {
    entries = await readdir(jobsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: McpJobSummary[] = [];
  for (const entry of entries) {
    if (ACTIVE_MCP_JOB_IDS.has(entry)) continue;
    const jobDir = join(jobsRoot, entry);
    try {
      const receipt = JSON.parse(await readFile(join(jobDir, "receipt.json"), "utf8")) as McpMigrationReceipt;
      jobs.push(jobSummaryFromReceipt(receipt));
      await synchronizeCompletedJournal(jobDir, receipt);
    } catch {
      const recovered = await recoverInterruptedJob(entry, jobDir, dataRoot, options).catch(() => null);
      if (recovered) jobs.push(recovered);
    }
  }
  return jobs.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function jobSummaryFromReceipt(receipt: McpMigrationReceipt): McpJobSummary {
  return {
    mcpMigrationId: receipt.mcpMigrationId,
    status: receipt.status,
    targetProduct: receipt.targetProduct,
    targetScope: receipt.targetScope ?? "user",
    selectedServerCount: receipt.selectedServerIds.length,
    changed: receipt.changed,
    canRollback: receipt.changed && receipt.status !== "ROLLED_BACK",
    targetConfigPath: receipt.targetConfigPath,
    completedAt: receipt.completedAt,
    failure: null,
  };
}

async function synchronizeCompletedJournal(jobDir: string, receipt: McpMigrationReceipt): Promise<void> {
  try {
    const path = join(jobDir, "journal.json");
    const journal = JSON.parse(await readFile(path, "utf8")) as McpMigrationJournal;
    if (journal.status !== "APPLYING") return;
    await writePrivateJson(path, {
      ...journal,
      status: receipt.status,
      targetAfterSha256: receipt.targetAfterSha256,
      completedAt: receipt.completedAt,
      failure: null,
    } satisfies McpMigrationJournal);
  } catch {
    // The completed receipt remains authoritative even if an older/stale journal cannot be refreshed.
  }
}

async function recoverInterruptedJob(
  entry: string,
  jobDir: string,
  dataRoot: string,
  options: McpRuntimeOptions,
): Promise<McpJobSummary | null> {
  const journalPath = join(jobDir, "journal.json");
  const value = JSON.parse(await readFile(journalPath, "utf8")) as unknown;
  if (!isMcpMigrationJournal(value) || value.mcpMigrationId !== entry) return null;
  let journal = value;
  if (journal.status !== "APPLYING") {
    if (journal.status === "COMPLETED" || journal.status === "COMPLETED_WITH_WARNINGS") {
      journal = await finishRecoveryJournal(journalPath, journal, "RECOVERY_CONFLICT");
    }
    return jobSummaryFromJournal(journal);
  }

  try {
    const plan = JSON.parse(await readFile(join(jobDir, "plan.json"), "utf8")) as McpMigrationPlan;
    validatePlanShape(plan);
    if (
      plan.planId !== journal.planId ||
      plan.request.targetProduct !== journal.targetProduct ||
      plan.targetConfigPath !== journal.targetConfigPath ||
      stableJson(plan.request.selectedServerIds) !== stableJson(journal.selectedServerIds)
    ) {
      throw new Error("journal does not match its migration plan");
    }
    const boundary = targetBoundary(plan.request, options);
    await assertSafeTargetPath(journal.targetConfigPath, boundary);

    const currentFingerprint = await currentTargetFingerprint(journal.targetConfigPath);
    if (currentFingerprint === journal.targetBeforeSha256) {
      journal = await finishRecoveryJournal(journalPath, journal, "RECOVERED_NO_CHANGE", currentFingerprint);
      return jobSummaryFromJournal(journal);
    }
    if (currentFingerprint !== journal.expectedTargetAfterSha256) {
      journal = await finishRecoveryJournal(journalPath, journal, "RECOVERY_CONFLICT", currentFingerprint);
      return jobSummaryFromJournal(journal);
    }

    await restoreTargetFromJournal(journal, dataRoot);
    const restoredFingerprint = await currentTargetFingerprint(journal.targetConfigPath);
    if (restoredFingerprint !== journal.targetBeforeSha256) {
      throw new Error("recovered target fingerprint does not match the pre-migration fingerprint");
    }
    journal = await finishRecoveryJournal(journalPath, journal, "RECOVERED_ROLLBACK", currentFingerprint);
    return jobSummaryFromJournal(journal);
  } catch (error) {
    journal = await finishRecoveryJournal(
      journalPath,
      { ...journal, failure: failureDetail("recovery", error) },
      "RECOVERY_CONFLICT",
    ).catch(() => journal);
    return jobSummaryFromJournal(journal.status === "APPLYING"
      ? { ...journal, status: "RECOVERY_CONFLICT", completedAt: new Date().toISOString() }
      : journal);
  }
}

async function finishRecoveryJournal(
  path: string,
  journal: McpMigrationJournal,
  status: Extract<McpJobSummary["status"], "RECOVERED_NO_CHANGE" | "RECOVERED_ROLLBACK" | "RECOVERY_CONFLICT">,
  targetAfterSha256: string | null = journal.targetAfterSha256,
): Promise<McpMigrationJournal> {
  const completed: McpMigrationJournal = {
    ...journal,
    status,
    targetAfterSha256,
    completedAt: new Date().toISOString(),
  };
  await writePrivateJson(path, completed);
  return completed;
}

function jobSummaryFromJournal(journal: McpMigrationJournal): McpJobSummary {
  return {
    mcpMigrationId: journal.mcpMigrationId,
    status: journal.status === "APPLYING" ? "RECOVERY_CONFLICT" : journal.status,
    targetProduct: journal.targetProduct,
    targetScope: journal.targetScope,
    selectedServerCount: journal.selectedServerIds.length,
    changed: journal.changed,
    canRollback: false,
    targetConfigPath: journal.targetConfigPath,
    completedAt: journal.completedAt ?? journal.startedAt,
    failure: journal.failure ?? null,
  };
}

function isMcpMigrationJournal(value: unknown): value is McpMigrationJournal {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "schemaVersion",
    "mcpMigrationId",
    "planId",
    "status",
    "targetProduct",
    "targetScope",
    "selectedServerIds",
    "targetConfigPath",
    "targetBeforeSha256",
    "expectedTargetAfterSha256",
    "targetAfterSha256",
    "backupPath",
    "createdTargetFile",
    "changed",
    "beforeMode",
    "beforeUid",
    "beforeGid",
    "startedAt",
    "completedAt",
    "failure",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const statuses: McpJournalStatus[] = [
    "APPLYING",
    "COMPLETED",
    "COMPLETED_WITH_WARNINGS",
    "ROLLED_BACK",
    "ROLLED_BACK_AFTER_FAILURE",
    "RECOVERED_NO_CHANGE",
    "RECOVERED_ROLLBACK",
    "RECOVERY_CONFLICT",
  ];
  return value.schemaVersion === "ide-hub-mcp-journal-v1" &&
    typeof value.mcpMigrationId === "string" && /^[a-f0-9-]{36}$/iu.test(value.mcpMigrationId) &&
    typeof value.planId === "string" &&
    statuses.includes(value.status as McpJournalStatus) &&
    MCP_TARGET_PRODUCTS.includes(value.targetProduct as McpTargetProduct) &&
    (value.targetScope === "user" || value.targetScope === "project" || value.targetScope === "local") &&
    Array.isArray(value.selectedServerIds) && value.selectedServerIds.length > 0 &&
    value.selectedServerIds.every((id) => typeof id === "string" && id.length > 0) &&
    typeof value.targetConfigPath === "string" && isAbsolute(value.targetConfigPath) &&
    typeof value.targetBeforeSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.targetBeforeSha256) &&
    typeof value.expectedTargetAfterSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.expectedTargetAfterSha256) &&
    (value.targetAfterSha256 === null ||
      (typeof value.targetAfterSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.targetAfterSha256))) &&
    (value.backupPath === null || (typeof value.backupPath === "string" && isAbsolute(value.backupPath))) &&
    typeof value.createdTargetFile === "boolean" &&
    typeof value.changed === "boolean" &&
    (value.beforeMode === null || typeof value.beforeMode === "number") &&
    (value.beforeUid === null || typeof value.beforeUid === "number") &&
    (value.beforeGid === null || typeof value.beforeGid === "number") &&
    typeof value.startedAt === "string" &&
    (value.completedAt === null || typeof value.completedAt === "string") &&
    (value.failure === undefined || value.failure === null || isMcpFailureDetail(value.failure));
}

function isMcpFailureDetail(value: unknown): value is McpFailureDetail {
  if (!isRecord(value) || Object.keys(value).some((key) => !["stage", "code", "message"].includes(key))) {
    return false;
  }
  return ["target-write", "target-readback", "verification", "rollback", "recovery"].includes(String(value.stage)) &&
    typeof value.code === "string" && value.code.length > 0 &&
    typeof value.message === "string" && value.message.length > 0;
}

function failureDetail(
  stage: McpFailureDetail["stage"],
  error: unknown,
  originalError?: unknown,
): McpFailureDetail {
  const value = error as { code?: unknown; message?: unknown } | null;
  const original = originalError as { message?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : String(error);
  const originalMessage = typeof original?.message === "string" ? original.message : null;
  return {
    stage,
    code: typeof value?.code === "string" ? value.code : "INTERNAL_ERROR",
    message: originalMessage ? `${originalMessage}; rollback: ${message}` : message,
  };
}

async function buildPlan(
  request: McpMigrationRequest,
  options: McpRuntimeOptions,
  providedSource?: McpSourceSnapshot,
): Promise<BuiltPlan> {
  validateRequest(request);
  const source = providedSource ?? await loadSource(request, options);
  if (source.scope !== request.scope || source.sourceProduct !== "codex") {
    throw new MigrationError("MCP_INVALID_REQUEST", "MCP source does not match the requested scope");
  }
  const selectedIds = new Set(request.selectedServerIds);
  const selected = source.servers.filter((server) => selectedIds.has(server.id));
  if (selected.length !== selectedIds.size) {
    throw new MigrationError("MCP_INVALID_REQUEST", "Selected MCP list contains an unknown server ID");
  }
  const availability = (await discoverMcpTargets(
    request.targetScope,
    request.workspace ?? null,
    options,
  )).find((target) => target.targetProduct === request.targetProduct)!;
  if (!availability.supported || !availability.targetConfigPath) {
    throw new MigrationError(
      "MCP_TARGET_UNSUPPORTED",
      availability.reason ?? `${availability.displayName} MCP target is unavailable`,
    );
  }
  const profile = resolveMcpTarget(request.targetProduct, request.targetScope, request.workspace ?? null, options);
  await assertSafeTargetPath(
    profile.configPath!,
    targetBoundary(request, options),
  );
  const target = await readTargetState(profile);
  target.shadowedNames = await discoverHigherPrecedenceNames(request, options);
  const diffs: McpServerDiff[] = [];
  const operations: PlannedOperation[] = [];
  for (const server of selected) {
    const built = buildServerOperation(server, request.targetProduct, target, request.resolutions[server.id]);
    diffs.push(built.diff);
    operations.push(built.operation);
  }
  const plan: McpMigrationPlan = {
    schemaVersion: "ide-hub-mcp-plan-v1",
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    request: structuredClone(request),
    sourceFingerprint: source.sourceFingerprint,
    targetFingerprint: target.fingerprint,
    targetConfigPath: profile.configPath!,
    targetExisted: target.text !== null,
    selectedServerCount: selected.length,
    diffs,
    manualActions: buildManualActions(request, selected),
    canApply: diffs.every((diff) => diff.status !== "conflict" && diff.status !== "unsupported"),
  };
  return { plan, source, target, operations };
}

function buildManualActions(request: McpMigrationRequest, selected: McpServer[]): string[] {
  const actions: string[] = [];
  if (
    (request.targetScope === "project" || request.targetScope === "local") &&
    (request.targetProduct === "qoder-international" || request.targetProduct === "qoder-cn")
  ) {
    actions.push("Qoder 首次加载项目/本机项目 MCP 时仍需信任目录并批准；已运行实例请执行 /mcp reload 或重启");
  }
  if (request.targetScope === "project" && request.targetProduct === "claude-code") {
    actions.push("Claude Code 首次使用项目 .mcp.json 时仍会要求批准，IDE Hub 不迁移批准状态");
  }
  if (request.targetScope === "local" && request.targetProduct === "claude-code") {
    actions.push("Claude Code local MCP 仍受项目目录信任规则约束，IDE Hub 不迁移信任状态");
  }
  if (
    request.targetScope === "project" &&
    (request.targetProduct === "codebuddy-international" || request.targetProduct === "codebuddy-cn")
  ) {
    actions.push("CodeBuddy 首次连接项目 MCP 时仍需在目标应用中批准");
  }
  if (
    request.targetScope === "user" &&
    (request.targetProduct === "codebuddy-international" || request.targetProduct === "codebuddy-cn")
  ) {
    actions.push("当前 CodeBuddy 国际版与 CN 4.12.0 共用 ~/.codebuddy/mcp.json；迁移任一版本的 user scope 会同时影响另一版本");
  }
  if (selected.some((server) => server.transport === "streamable-http")) {
    actions.push("远程 MCP 只验证配置结构，不联网探活；登录、OAuth 或服务可用性请在目标应用中确认");
  }
  return actions;
}

async function discoverHigherPrecedenceNames(
  request: McpMigrationRequest,
  options: McpRuntimeOptions,
): Promise<Map<string, string>> {
  if (request.targetScope !== "project" || !request.workspace) return new Map();
  const higherScope = request.targetProduct === "zcode"
    ? "user"
    : request.targetProduct === "qoder-international" ||
        request.targetProduct === "qoder-cn" ||
        request.targetProduct === "claude-code" ||
        request.targetProduct === "codebuddy-international" ||
        request.targetProduct === "codebuddy-cn"
      ? "local"
      : null;
  if (!higherScope) return new Map();
  const { targetPathOverrides: _selectedScopeOverride, ...higherScopeOptions } = options;
  const profile = resolveMcpTarget(request.targetProduct, higherScope, request.workspace, higherScopeOptions);
  if (profile.format === "unsupported" || !profile.configPath) return new Map();
  const higherState = await readTargetState(profile);
  const label = higherScope === "user" ? "user" : "local";
  return new Map(Object.keys(higherState.servers).map((name) => [
    name,
    `${profile.displayName} ${label} scope 中存在同名 MCP，会遮蔽所选 project scope；只能跳过或重命名`,
  ]));
}

async function loadSource(request: McpMigrationRequest, options: McpRuntimeOptions): Promise<McpSourceSnapshot> {
  if (request.sourceBundlePath) {
    const { importMcpBundle } = await import("./bundle.js");
    return importMcpBundle(
      request.sourceBundlePath,
      request.scope === "project" ? request.workspace : undefined,
    );
  }
  const { readCodexMcpSnapshot } = await import("./codex.js");
  return readCodexMcpSnapshot({
    scope: request.scope,
    ...(request.scope === "project" && request.workspace ? { workspace: request.workspace } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
  });
}

function buildServerOperation(
  server: McpServer,
  targetProduct: McpTargetProduct,
  target: TargetState,
  resolution?: McpConflictResolution,
): { diff: McpServerDiff; operation: PlannedOperation } {
  const rendered = target.profile.format === "dsh-yaml"
    ? renderDshServer(server)
    : renderMcpServer(server, targetProduct);
  if (!rendered.supported || !rendered.value) {
    return {
      diff: makeDiff(server, server.name, "unsupported", rendered.reason, [], null, null),
      operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
    };
  }
  const dshBlock = target.profile.format === "dsh-yaml"
    ? String(rendered.value.__dshBlock ?? "")
    : null;
  const comparable = target.profile.format === "dsh-yaml"
    ? { __dshHash: rendered.value.__dshHash }
    : rendered.value;
  const shadowedBy = target.shadowedNames.get(server.name);
  if (shadowedBy) {
    const strategies: McpConflictResolution["strategy"][] = ["skip", "rename"];
    if (!resolution) {
      return {
        diff: makeDiff(server, server.name, "conflict", shadowedBy, strategies, comparable, undefined, []),
        operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    if (resolution.strategy === "skip") {
      return {
        diff: makeDiff(server, server.name, "skip", shadowedBy, strategies, comparable, undefined, []),
        operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    if (resolution.strategy !== "rename") {
      return {
        diff: makeDiff(server, server.name, "unsupported", "高优先级 scope 不能从当前目标 scope 合并或替换", strategies, comparable, undefined, []),
        operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    const renameTo = resolution.renameTo?.trim() ?? "";
    if (!isValidTargetName(renameTo, target.profile) || target.servers[renameTo] !== undefined || target.shadowedNames.has(renameTo)) {
      return {
        diff: makeDiff(server, renameTo || server.name, "conflict", "重命名必须合法，且不能与目标或高优先级 scope 中的名称重复", strategies, comparable, undefined, []),
        operation: { server, targetName: renameTo || server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    return {
      diff: makeDiff(server, renameTo, "rename", shadowedBy, strategies, comparable, undefined, []),
      operation: { server, targetName: renameTo, action: "set", value: comparable, dshBlock: null },
    };
  }
  const existing = target.servers[server.name];
  if (existing === undefined) {
    return {
      diff: makeDiff(server, server.name, "add", null, [], comparable, undefined),
      operation: { server, targetName: server.name, action: "set", value: comparable, dshBlock },
    };
  }
  if (stableJson(existing) === stableJson(comparable)) {
    return {
      diff: makeDiff(server, server.name, "same", null, [], comparable, existing),
      operation: { server, targetName: server.name, action: "noop", value: comparable, dshBlock },
    };
  }
  const managedDsh = target.managedDshBlocks[server.name] !== undefined;
  const strategies: McpConflictResolution["strategy"][] = target.profile.format === "dsh-yaml"
    ? managedDsh ? ["skip", "rename", "replace"] : ["skip", "rename"]
    : endpointsMatchForMerge(comparable, existing)
      ? ["skip", "rename", "merge", "replace"]
      : ["skip", "rename", "replace"];
  const fields = fieldDiffs(comparable, existing);
  if (!resolution) {
    return {
      diff: makeDiff(server, server.name, "conflict", "目标存在同名但不同的 MCP", strategies, comparable, existing, fields),
      operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
    };
  }
  if (!strategies.includes(resolution.strategy)) {
    return {
      diff: makeDiff(server, server.name, "unsupported", "该目标现有配置不能安全执行所选冲突策略", strategies, comparable, existing, fields),
      operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
    };
  }
  if (resolution.strategy === "skip") {
    return {
      diff: makeDiff(server, server.name, "skip", null, strategies, comparable, existing, fields),
      operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
    };
  }
  if (resolution.strategy === "rename") {
    const renameTo = resolution.renameTo?.trim() ?? "";
    if (!isValidTargetName(renameTo, target.profile) || target.servers[renameTo] !== undefined || target.shadowedNames.has(renameTo)) {
      return {
        diff: makeDiff(server, renameTo || server.name, "conflict", "重命名必须合法且不能与目标现有名称重复", strategies, comparable, existing, fields),
        operation: { server, targetName: renameTo || server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    const renamedDsh = target.profile.format === "dsh-yaml" ? renderDshServer(server, renameTo) : null;
    const renamedValue = renamedDsh?.value
      ? { __dshHash: renamedDsh.value.__dshHash }
      : comparable;
    return {
      diff: makeDiff(server, renameTo, "rename", null, strategies, comparable, existing, fields),
      operation: {
        server,
        targetName: renameTo,
        action: "set",
        value: renamedValue,
        dshBlock: renamedDsh ? String(renamedDsh.value?.__dshBlock ?? "") : dshBlock,
      },
    };
  }
  if (resolution.strategy === "merge") {
    const merged = mergeValues(comparable, existing, "", resolution.fieldChoices ?? {});
    if (merged.unresolved.length > 0) {
      return {
        diff: makeDiff(
          server,
          server.name,
          "conflict",
          `合并仍有未选择字段：${merged.unresolved.join(", ")}`,
          strategies,
          comparable,
          existing,
          fields,
        ),
        operation: { server, targetName: server.name, action: "skip", value: null, dshBlock: null },
      };
    }
    return {
      diff: makeDiff(server, server.name, "merge", null, strategies, comparable, existing, fields),
      operation: { server, targetName: server.name, action: "set", value: merged.value as Record<string, unknown>, dshBlock },
    };
  }
  return {
    diff: makeDiff(server, server.name, "replace", null, strategies, comparable, existing, fields),
    operation: { server, targetName: server.name, action: "set", value: comparable, dshBlock },
  };
}

function isValidTargetName(name: string, profile: McpTargetProfile): boolean {
  return profile.format === "dsh-yaml"
    ? /^[A-Za-z0-9_-]{1,32}$/u.test(name)
    : /^[^\u0000-\u001f]{1,128}$/u.test(name);
}

function endpointsMatchForMerge(source: unknown, target: unknown): boolean {
  if (!isRecord(source) || !isRecord(target)) return false;
  const sourceKind = typeof source.url === "string" ? "remote" : typeof source.command === "string" ? "stdio" : "unknown";
  const targetKind = typeof target.url === "string" ? "remote" : typeof target.command === "string" ? "stdio" : "unknown";
  if (sourceKind === "unknown" || targetKind === "unknown" || sourceKind !== targetKind) return false;
  return sourceKind === "remote"
    ? source.url === target.url
    : source.command === target.command;
}

function makeDiff(
  server: McpServer,
  targetName: string,
  status: McpServerDiff["status"],
  reason: string | null,
  strategies: McpConflictResolution["strategy"][],
  source: unknown,
  target: unknown,
  fields = fieldDiffs(source, target),
): McpServerDiff {
  return {
    serverId: server.id,
    sourceName: server.name,
    targetName,
    transport: server.transport,
    status,
    reason,
    availableStrategies: strategies,
    fields,
  };
}

async function readTargetState(profile: McpTargetProfile): Promise<TargetState> {
  const text = await readTextIfExists(profile.configPath!);
  const fingerprint = text === null ? MISSING_FINGERPRINT : sha256Text(text);
  if (profile.format === "dsh-yaml") {
    validateDshPatch(text ?? "");
    const parsed = parseDshState(text ?? "");
    return { profile, text, fingerprint, ...parsed, shadowedNames: new Map<string, string>() };
  }
  const source = text ?? "{}";
  const errors: ParseError[] = [];
  const root = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(root)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${profile.displayName} MCP 配置不是有效 JSON/JSONC`);
  }
  let current: unknown = root;
  for (const segment of profile.jsonPath) {
    if (!isRecord(current)) {
      throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${profile.displayName} MCP 配置层结构无效`);
    }
    current = current[segment];
    if (current === undefined) break;
  }
  if (current !== undefined && !isRecord(current)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${profile.displayName} MCP server 容器必须是对象`);
  }
  return {
    profile,
    text,
    fingerprint,
    servers: current === undefined ? {} : { ...(current as Record<string, unknown>) },
    managedDshBlocks: {},
    unmanagedDshNames: new Set<string>(),
    shadowedNames: new Map<string, string>(),
  };
}

function applyJsonOperations(
  original: string,
  profile: McpTargetProfile,
  operations: PlannedOperation[],
): string {
  let text = original.trim().length > 0 ? original : "{}\n";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = text.match(/\n([ \t]+)["}]/u);
  const indent = indentMatch?.[1] ?? "  ";
  const formattingOptions = {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : Math.max(2, indent.length),
    eol,
  };
  for (const operation of operations) {
    if (operation.action !== "set" || !operation.value) continue;
    const value = stripInternalFields(operation.value);
    text = applyEdits(text, modify(
      text,
      [...profile.jsonPath, operation.targetName],
      value,
      { formattingOptions },
    ));
  }
  return text.endsWith(eol) ? text : `${text}${eol}`;
}

function applyDshOperations(original: string, operations: PlannedOperation[]): string {
  let text = normalizeEmptyDshPatch(original);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  for (const operation of operations) {
    if (operation.action !== "set" || !operation.dshBlock) continue;
    const block = operation.dshBlock.replaceAll("\n", eol);
    const existing = managedDshBlockRegex(operation.targetName).exec(text);
    if (existing) {
      text = `${text.slice(0, existing.index)}${block}${text.slice(existing.index + existing[0].length)}`;
    } else {
      if (text.length > 0 && !text.endsWith(eol)) text += eol;
      if (text.length > 0 && !text.endsWith(`${eol}${eol}`)) text += eol;
      text += block;
    }
  }
  return text.endsWith(eol) ? text : `${text}${eol}`;
}

function validateDshPatch(text: string): void {
  const lines = text.split(/\r?\n/u);
  const significant = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (significant.length === 0 || (significant.length === 1 && significant[0] === "[]")) return;
  const roots = lines.filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#") && !/^\s/u.test(line));
  if (
    significant[0] === "[]" ||
    roots.length === 0 ||
    roots.some((line) => !/^-\s+(?:insert|id|disable|remove|patch):/u.test(line))
  ) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", "DeepSeek Harness Cordis patch schema is not recognized");
  }
}

function normalizeEmptyDshPatch(text: string): string {
  const lines = text.split(/(?<=\n)/u);
  const significant = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  if (significant.length === 1 && significant[0]!.trim() === "[]") {
    return lines.filter((line) => line.trim() !== "[]").join("");
  }
  return text;
}

async function verifyAppliedOperations(
  target: TargetState,
  operations: PlannedOperation[],
  options: McpRuntimeOptions,
  nativeRecognition: McpNativeRecognitionProbeResult,
): Promise<McpMigrationReceipt["verification"]> {
  const verification: McpMigrationReceipt["verification"] = [];
  for (const operation of operations) {
    if (operation.action === "skip") {
      verification.push({
        serverId: operation.server.id,
        name: operation.targetName,
        configRoundTrip: true,
        handshake: "skipped",
        nativeRecognition: "skipped",
        nativeDetail: "按用户选择跳过，未调用目标原生 loader",
        detail: "按用户选择跳过",
      });
      continue;
    }
    const actual = target.servers[operation.targetName];
    const configRoundTrip = stableJson(actual) === stableJson(operation.value);
    if (!configRoundTrip || operation.server.transport !== "stdio") {
      verification.push({
        serverId: operation.server.id,
        name: operation.targetName,
        configRoundTrip,
        handshake: "skipped",
        nativeRecognition: nativeRecognition.servers[operation.targetName]?.status ?? "pending",
        nativeDetail: nativeRecognition.servers[operation.targetName]?.detail ?? "目标应用识别尚未确认",
        detail: configRoundTrip ? "目标配置重读一致；远程 transport 默认不联网探活" : "目标配置重读不一致",
      });
      continue;
    }
    if (options.skipStdioHandshake) {
      verification.push({
        serverId: operation.server.id,
        name: operation.targetName,
        configRoundTrip: true,
        handshake: "skipped",
        nativeRecognition: nativeRecognition.servers[operation.targetName]?.status ?? "pending",
        nativeDetail: nativeRecognition.servers[operation.targetName]?.detail ?? "目标应用识别尚未确认",
        detail: "测试环境跳过 stdio handshake",
      });
      continue;
    }
    const handshake = await verifyStdioHandshake(operation.server, options.handshakeTimeoutMs ?? 10_000);
    verification.push({
      serverId: operation.server.id,
      name: operation.targetName,
      configRoundTrip: true,
      handshake: handshake.passed ? "passed" : "failed",
      nativeRecognition: nativeRecognition.servers[operation.targetName]?.status ?? "pending",
      nativeDetail: nativeRecognition.servers[operation.targetName]?.detail ?? "目标应用识别尚未确认",
      detail: handshake.detail,
    });
  }
  return verification;
}

async function runNativeRecognitionProbe(
  request: McpMigrationRequest,
  targetConfigPath: string,
  operations: PlannedOperation[],
  options: McpRuntimeOptions,
  notBeforeEpochMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  const serverNames = operations
    .filter((operation) => operation.action !== "skip")
    .map((operation) => operation.targetName);
  const input = {
    targetProduct: request.targetProduct,
    targetScope: request.targetScope,
    workspace: request.workspace ?? null,
    targetConfigPath,
    serverNames,
    homeDir: options.homeDir ?? homedir(),
    notBeforeEpochMs,
  };
  if (options.nativeRecognitionVerifier) return options.nativeRecognitionVerifier(input);
  if (!shouldRunNativeMcpProbe({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    hasTargetPathOverride: options.targetPathOverrides?.[request.targetProduct] !== undefined,
  })) {
    return {
      method: "fixture",
      servers: Object.fromEntries(serverNames.map((name) => [name, {
        status: "pending" as const,
        detail: "目标应用原生识别未在隔离测试目录中执行",
      }])),
    };
  }
  const defaultTimeoutMs = request.targetProduct === "cursor" ? 60_000 : 15_000;
  return verifyNativeMcpRecognition(input, options.nativeRecognitionTimeoutMs ?? defaultTimeoutMs);
}

function renderDshServer(server: McpServer, targetName = server.name): {
  supported: boolean;
  reason: string | null;
  value: Record<string, unknown> | null;
} {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(targetName)) {
    return { supported: false, reason: "DSH serverName 必须匹配 [A-Za-z0-9_-]{1,32}", value: null };
  }
  if (server.unmappedFields.length > 0) {
    return { supported: false, reason: `Codex 配置包含 DSH 尚未映射的字段：${server.unmappedFields.join(", ")}`, value: null };
  }
  if (!server.enabled) {
    return { supported: false, reason: "DSH MCP client 没有已验证的禁用字段；请只迁移已启用 MCP", value: null };
  }
  if (server.startupTimeoutSec !== null) {
    return { supported: false, reason: "DSH MCP client 使用固定启动超时，无法无损映射 Codex startup_timeout_sec", value: null };
  }
  const lines = [
    `- insert:`,
    `    - id: ${yamlString(`ide-hub-mcp-${targetName}`)}`,
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    `      config:`,
    `        serverName: ${yamlString(targetName)}`,
    `        transport: ${yamlString(server.transport)}`,
  ];
  if (server.transport === "stdio") {
    lines.push(`        command: ${yamlString(server.command ?? "")}`);
    if (server.args.length > 0) lines.push(`        args: ${yamlInlineArray(server.args)}`);
    if (server.cwd) lines.push(`        cwd: ${yamlString(server.cwd)}`);
    const overlappingEnv = server.envVars.find((name) => name in server.env);
    if (overlappingEnv) {
      return { supported: false, reason: `Codex env 与 ambient env 同时定义 ${overlappingEnv}，无法确定 DSH 优先级`, value: null };
    }
    const envKeys = [...new Set([...Object.keys(server.env), ...server.envVars])].sort();
    if (envKeys.length > 0) {
      lines.push("        env:");
      for (const key of envKeys) {
        const value = server.env[key];
        lines.push(`          ${yamlKey(key)}: ${value === undefined ? yamlEnvReference(key) : yamlString(value)}`);
      }
    }
  } else {
    lines.push(`        url: ${yamlString(server.url ?? "")}`);
    const overlappingHeader = Object.keys(server.envHeaders).find((name) => name in server.headers);
    if (overlappingHeader) {
      return { supported: false, reason: `Codex literal 与动态 header 同时定义 ${overlappingHeader}`, value: null };
    }
    if (server.bearerTokenEnvVar && ("Authorization" in server.headers || "Authorization" in server.envHeaders)) {
      return { supported: false, reason: "Codex bearer token 与 Authorization header 同时存在，无法安全合并", value: null };
    }
    const headerKeys = [...new Set([
      ...Object.keys(server.headers),
      ...Object.keys(server.envHeaders),
      ...(server.bearerTokenEnvVar ? ["Authorization"] : []),
    ])].sort();
    if (headerKeys.length > 0) {
      lines.push("        headers:");
      for (const key of headerKeys) {
        const envName = server.envHeaders[key];
        const value = key === "Authorization" && server.bearerTokenEnvVar
          ? yamlBearerReference(server.bearerTokenEnvVar)
          : envName ? yamlEnvReference(envName) : yamlString(server.headers[key] ?? "");
        lines.push(`          ${yamlKey(key)}: ${value}`);
      }
    }
  }
  if (server.toolTimeoutSec !== null) lines.push(`        toolCallTimeoutMs: ${Math.round(server.toolTimeoutSec * 1_000)}`);
  const body = `${lines.join("\n")}\n`;
  const hash = sha256Text(body);
  const block = `${DSH_START} ${targetName} ${hash}\n${body}${DSH_END} ${targetName}\n`;
  return { supported: true, reason: null, value: { __dshHash: hash, __dshBlock: block } };
}

function parseDshState(text: string): Pick<TargetState, "servers" | "managedDshBlocks" | "unmanagedDshNames"> {
  const servers: Record<string, unknown> = {};
  const managedDshBlocks: Record<string, { hash: string; block: string }> = {};
  const managedNames = new Set<string>();
  const marker = /^# ide-hub:mcp:start ([A-Za-z0-9_-]+) ([a-f0-9]{64})\r?\n[\s\S]*?^# ide-hub:mcp:end \1(?:\r?\n)?/gmu;
  for (const match of text.matchAll(marker)) {
    const name = match[1]!;
    const hash = match[2]!;
    managedNames.add(name);
    managedDshBlocks[name] = { hash, block: match[0] };
    servers[name] = { __dshHash: hash };
  }
  const unmanagedDshNames = new Set<string>();
  const serverNamePattern = /^\s*serverName:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gmu;
  for (const match of text.matchAll(serverNamePattern)) {
    const name = match[1]!;
    if (!managedNames.has(name)) {
      unmanagedDshNames.add(name);
      servers[name] = { __dshUnmanaged: true };
    }
  }
  return { servers, managedDshBlocks, unmanagedDshNames };
}

function managedDshBlockRegex(name: string): RegExp {
  return new RegExp(`^${escapeRegex(DSH_START)} ${escapeRegex(name)} [a-f0-9]{64}\\r?\\n[\\s\\S]*?^${escapeRegex(DSH_END)} ${escapeRegex(name)}(?:\\r?\\n)?`, "mu");
}

function mergeValues(
  source: unknown,
  target: unknown,
  path: string,
  choices: Record<string, McpFieldChoice>,
): { value: unknown; unresolved: string[] } {
  if (stableJson(source) === stableJson(target)) return { value: source, unresolved: [] };
  if (source === undefined) return { value: target, unresolved: [] };
  if (target === undefined) return { value: source, unresolved: [] };
  if (isRecord(source) && isRecord(target)) {
    const output: Record<string, unknown> = {};
    const unresolved: string[] = [];
    for (const key of new Set([...Object.keys(target), ...Object.keys(source)])) {
      const childPath = path ? `${path}.${key}` : key;
      const merged = mergeValues(source[key], target[key], childPath, choices);
      if (merged.value !== undefined) output[key] = merged.value;
      unresolved.push(...merged.unresolved);
    }
    return { value: output, unresolved };
  }
  const choice = choices[path];
  if (choice === "source") return { value: source, unresolved: [] };
  if (choice === "target") return { value: target, unresolved: [] };
  return { value: target, unresolved: [path || "value"] };
}

function fieldDiffs(source: unknown, target: unknown): McpFieldDiff[] {
  const sourceFields = flattenFields(source);
  const targetFields = flattenFields(target);
  const fields: McpFieldDiff[] = [];
  for (const field of [...new Set([...Object.keys(sourceFields), ...Object.keys(targetFields)])].sort()) {
    const sourceValue = sourceFields[field];
    const targetValue = targetFields[field];
    if (stableJson(sourceValue) === stableJson(targetValue)) continue;
    fields.push({
      field,
      conflict: sourceValue !== undefined && targetValue !== undefined,
      sourcePreview: previewField(field, sourceValue),
      targetPreview: previewField(field, targetValue),
    });
  }
  return fields;
}

function flattenFields(value: unknown, path = "", output: Record<string, unknown> = {}): Record<string, unknown> {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenFields(child, path ? `${path}.${key}` : key, output);
    }
  } else {
    output[path || "value"] = value;
  }
  return output;
}

function previewField(field: string, value: unknown): string {
  if (value === undefined) return "—";
  if (/(?:args|env|header|token|password|secret|authorization)/iu.test(field)) return "••••";
  if (typeof value === "string" && /^https?:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.search) url.search = "?masked=***";
      return url.toString().slice(0, 160);
    } catch {
      return "URL（已遮罩）";
    }
  }
  const preview = typeof value === "string" ? value : stableJson(value);
  return preview.length > 160 ? `${preview.slice(0, 157)}…` : preview;
}

function targetBoundary(request: McpMigrationRequest, options: McpRuntimeOptions): string {
  if (
    request.targetScope === "user" ||
    (request.targetScope === "local" && (
      request.targetProduct === "claude-code" ||
      request.targetProduct === "codebuddy-international" ||
      request.targetProduct === "codebuddy-cn"
    ))
  ) {
    return options.homeDir ?? homedir();
  }
  if (!request.workspace) {
    throw new MigrationError("MCP_INVALID_REQUEST", `${request.targetScope} target scope requires an absolute workspace path`);
  }
  return request.workspace;
}

function validateRequest(request: McpMigrationRequest): void {
  if (!request || request.sourceProduct !== "codex") {
    throw new MigrationError("MCP_INVALID_REQUEST", "sourceProduct must be codex");
  }
  if (!MCP_TARGET_PRODUCTS.includes(request.targetProduct)) {
    throw new MigrationError("MCP_INVALID_REQUEST", "targetProduct is invalid");
  }
  if (!Array.isArray(request.selectedServerIds) || request.selectedServerIds.length === 0) {
    throw new MigrationError("MCP_INVALID_REQUEST", "Select at least one MCP server before migration");
  }
  if (new Set(request.selectedServerIds).size !== request.selectedServerIds.length || request.selectedServerIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/iu.test(id))) {
    throw new MigrationError("MCP_INVALID_REQUEST", "selectedServerIds must contain unique MCP server IDs");
  }
  if (request.scope !== "user" && request.scope !== "project") {
    throw new MigrationError("MCP_INVALID_REQUEST", "scope must be user or project");
  }
  if (request.targetScope !== "user" && request.targetScope !== "project" && request.targetScope !== "local") {
    throw new MigrationError("MCP_INVALID_REQUEST", "targetScope must be user, project, or local");
  }
  if (
    (request.scope === "project" || request.targetScope !== "user") &&
    (!request.workspace || !isAbsolute(request.workspace))
  ) {
    throw new MigrationError("MCP_INVALID_REQUEST", "project/local MCP scope requires an absolute workspace path");
  }
  if (request.workspace !== undefined && !isAbsolute(request.workspace)) {
    throw new MigrationError("MCP_INVALID_REQUEST", "workspace must be an absolute path");
  }
  if (request.scope === "user" && request.targetScope === "user" && request.workspace !== undefined) {
    throw new MigrationError("MCP_INVALID_REQUEST", "user-to-user MCP migration must not contain a workspace path");
  }
  if (request.sourceBundlePath !== undefined && (
    typeof request.sourceBundlePath !== "string" || !isAbsolute(request.sourceBundlePath)
  )) {
    throw new MigrationError("MCP_INVALID_REQUEST", "sourceBundlePath must be an absolute path");
  }
  const allowedKeys = new Set([
    "sourceProduct",
    "targetProduct",
    "selectedServerIds",
    "scope",
    "targetScope",
    "workspace",
    "sourceBundlePath",
    "resolutions",
  ]);
  const unexpected = Object.keys(request).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new MigrationError("MCP_INVALID_REQUEST", `MCP request contains unsupported fields: ${unexpected.join(", ")}`);
  }
  if (!request.resolutions || typeof request.resolutions !== "object" || Array.isArray(request.resolutions)) {
    throw new MigrationError("MCP_INVALID_REQUEST", "resolutions must be an object");
  }
  const selected = new Set(request.selectedServerIds);
  for (const [serverId, resolution] of Object.entries(request.resolutions)) {
    if (!selected.has(serverId) || !resolution || typeof resolution !== "object") {
      throw new MigrationError("MCP_INVALID_REQUEST", "resolutions may only reference selected MCP servers");
    }
    if (Object.keys(resolution).some((key) => !["strategy", "renameTo", "fieldChoices"].includes(key))) {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} contains unsupported fields`);
    }
    if (!["skip", "rename", "merge", "replace"].includes(resolution.strategy)) {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} has an invalid strategy`);
    }
    if (resolution.renameTo !== undefined && typeof resolution.renameTo !== "string") {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} renameTo must be a string`);
    }
    if (resolution.renameTo !== undefined && resolution.strategy !== "rename") {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} renameTo is only valid for rename`);
    }
    if (resolution.fieldChoices !== undefined && (
      !resolution.fieldChoices ||
      typeof resolution.fieldChoices !== "object" ||
      Array.isArray(resolution.fieldChoices) ||
      Object.values(resolution.fieldChoices).some((choice) => choice !== "source" && choice !== "target")
    )) {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} fieldChoices are invalid`);
    }
    if (resolution.fieldChoices !== undefined && resolution.strategy !== "merge") {
      throw new MigrationError("MCP_INVALID_REQUEST", `MCP resolution ${serverId} fieldChoices are only valid for merge`);
    }
  }
}

function validatePlanShape(plan: McpMigrationPlan): void {
  if (
    !plan ||
    plan.schemaVersion !== "ide-hub-mcp-plan-v1" ||
    typeof plan.planId !== "string" || !/^[a-f0-9-]{36}$/iu.test(plan.planId) ||
    typeof plan.createdAt !== "string" || !Number.isFinite(Date.parse(plan.createdAt)) ||
    typeof plan.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/iu.test(plan.sourceFingerprint) ||
    typeof plan.targetFingerprint !== "string" || !/^[a-f0-9]{64}$/iu.test(plan.targetFingerprint) ||
    typeof plan.targetConfigPath !== "string" || !isAbsolute(plan.targetConfigPath) ||
    typeof plan.targetExisted !== "boolean" ||
    typeof plan.selectedServerCount !== "number" || !Number.isInteger(plan.selectedServerCount) || plan.selectedServerCount < 1 ||
    !Array.isArray(plan.diffs) ||
    !Array.isArray(plan.manualActions) || plan.manualActions.some((item) => typeof item !== "string") ||
    typeof plan.canApply !== "boolean"
  ) {
    throw new MigrationError("MCP_INVALID_REQUEST", "MCP migration plan is invalid");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "planId",
    "createdAt",
    "request",
    "sourceFingerprint",
    "targetFingerprint",
    "targetConfigPath",
    "targetExisted",
    "selectedServerCount",
    "diffs",
    "manualActions",
    "canApply",
  ]);
  const unexpected = Object.keys(plan).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new MigrationError("MCP_INVALID_REQUEST", `MCP plan contains unsupported fields: ${unexpected.join(", ")}`);
  }
  validateRequest(plan.request);
  if (plan.selectedServerCount !== plan.request.selectedServerIds.length) {
    throw new MigrationError("MCP_INVALID_REQUEST", "MCP migration plan selection count is invalid");
  }
}

async function restoreTarget(path: string, before: string | null, metadata: TargetFileMetadata | null): Promise<void> {
  if (before === null) {
    await unlinkTargetIfExists(path);
  } else {
    await atomicWritePreservingMode(path, before, metadata?.mode ?? 0o600, metadata ?? undefined);
  }
}

async function restoreTargetFromJournal(journal: McpMigrationJournal, dataRoot: string): Promise<void> {
  if (journal.createdTargetFile) {
    await unlinkTargetIfExists(journal.targetConfigPath);
    return;
  }
  if (!journal.backupPath) {
    throw new MigrationError("MCP_JOB_NOT_FOUND", "MCP migration backup metadata is incomplete");
  }
  await assertSafeTargetPath(journal.backupPath, join(dataRoot, "mcp", "backups"));
  const backup = await readFile(journal.backupPath, "utf8");
  if (sha256Text(backup) !== journal.targetBeforeSha256) {
    throw new MigrationError("MCP_VERIFY_FAILED", "MCP migration backup fingerprint is invalid");
  }
  const ownership = journal.beforeUid === null || journal.beforeUid === undefined ||
    journal.beforeGid === null || journal.beforeGid === undefined
    ? undefined
    : {
        mode: journal.beforeMode ?? 0o600,
        uid: journal.beforeUid,
        gid: journal.beforeGid,
      };
  await atomicWritePreservingMode(
    journal.targetConfigPath,
    backup,
    journal.beforeMode ?? 0o600,
    ownership,
  );
}

async function restoreSelectedServersPreservingExternalChanges(
  plan: McpMigrationPlan,
  journal: McpMigrationJournal,
  jobDir: string,
  dataRoot: string,
  options: McpRuntimeOptions,
): Promise<void> {
  const resolved = resolveMcpTarget(
    plan.request.targetProduct,
    plan.request.targetScope,
    plan.request.workspace ?? null,
    options,
  );
  const profile = { ...resolved, configPath: journal.targetConfigPath };
  if (profile.format !== "jsonc") {
    throw new MigrationError(
      "MCP_ROLLBACK_CONFLICT",
      "Target MCP configuration changed after migration; selective rollback is unavailable for this target format",
    );
  }
  const expectedAfter = await readTextIfExists(join(jobDir, TARGET_AFTER_SNAPSHOT));
  const current = await readTextIfExists(journal.targetConfigPath);
  if (expectedAfter === null || sha256Text(expectedAfter) !== journal.targetAfterSha256 || current === null) {
    throw new MigrationError(
      "MCP_ROLLBACK_CONFLICT",
      "Target MCP configuration changed after migration and the verified after-snapshot is unavailable",
    );
  }
  const before = await readBeforeText(journal, dataRoot);
  const expectedServers = jsonServersFromText(expectedAfter, profile);
  const currentServers = jsonServersFromText(current, profile);
  const beforeServers = before === null ? {} : jsonServersFromText(before, profile);
  const changedNames = plan.diffs
    .filter((diff) => ["add", "rename", "merge", "replace"].includes(diff.status))
    .map((diff) => diff.targetName);
  for (const name of changedNames) {
    if (stableJson(currentServers[name]) !== stableJson(expectedServers[name])) {
      throw new MigrationError(
        "MCP_ROLLBACK_CONFLICT",
        `The migrated MCP server changed after migration: ${name}`,
      );
    }
  }

  let patched = current;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  for (const name of changedNames) {
    patched = applyEdits(patched, modify(
      patched,
      [...profile.jsonPath, name],
      beforeServers[name],
      { formattingOptions: { insertSpaces: true, tabSize: 2, eol } },
    ));
  }
  const patchedRoot = parseJsonRoot(patched, profile.displayName);
  const metadata = await fileMetadataIfExists(journal.targetConfigPath);
  if (before !== null && stableJson(patchedRoot) === stableJson(parseJsonRoot(before, profile.displayName))) {
    await restoreTargetFromJournal(journal, dataRoot);
  } else if (before === null && containsOnlyEmptyJsonPath(patchedRoot, profile.jsonPath)) {
    await unlinkTargetIfExists(journal.targetConfigPath);
  } else {
    await atomicWritePreservingMode(
      journal.targetConfigPath,
      patched.endsWith(eol) ? patched : `${patched}${eol}`,
      metadata?.mode ?? journal.beforeMode ?? 0o600,
      metadata ?? undefined,
    );
  }

  const restoredText = await readTextIfExists(journal.targetConfigPath);
  const restoredServers = restoredText === null ? {} : jsonServersFromText(restoredText, profile);
  for (const name of changedNames) {
    if (stableJson(restoredServers[name]) !== stableJson(beforeServers[name])) {
      throw new MigrationError("MCP_VERIFY_FAILED", `Selective MCP rollback did not restore ${name}`);
    }
  }
}

async function readBeforeText(journal: McpMigrationJournal, dataRoot: string): Promise<string | null> {
  if (journal.createdTargetFile) return null;
  if (!journal.backupPath) {
    throw new MigrationError("MCP_JOB_NOT_FOUND", "MCP migration backup metadata is incomplete");
  }
  await assertSafeTargetPath(journal.backupPath, join(dataRoot, "mcp", "backups"));
  const backup = await readFile(journal.backupPath, "utf8");
  if (sha256Text(backup) !== journal.targetBeforeSha256) {
    throw new MigrationError("MCP_VERIFY_FAILED", "MCP migration backup fingerprint is invalid");
  }
  return backup;
}

function jsonServersFromText(text: string, profile: McpTargetProfile): Record<string, unknown> {
  let current: unknown = parseJsonRoot(text, profile.displayName);
  for (const segment of profile.jsonPath) {
    if (!isRecord(current)) {
      throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${profile.displayName} MCP 配置层结构无效`);
    }
    current = current[segment];
    if (current === undefined) return {};
  }
  if (!isRecord(current)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${profile.displayName} MCP server 容器必须是对象`);
  }
  return current;
}

function parseJsonRoot(text: string, displayName: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(value)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", `${displayName} MCP 配置不是有效 JSON/JSONC`);
  }
  return value;
}

function containsOnlyEmptyJsonPath(root: Record<string, unknown>, jsonPath: string[]): boolean {
  let current: unknown = root;
  for (const segment of jsonPath) {
    if (!isRecord(current) || Object.keys(current).length !== 1 || !(segment in current)) return false;
    current = current[segment];
  }
  return isRecord(current) && Object.keys(current).length === 0;
}

async function currentTargetFingerprint(path: string): Promise<string> {
  const current = await readTextIfExists(path);
  return current === null ? MISSING_FINGERPRINT : sha256Text(current);
}

async function unlinkTargetIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function fileMetadataIfExists(path: string): Promise<TargetFileMetadata | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new MigrationError("MCP_TARGET_UNSUPPORTED", "Refusing to write an MCP configuration through a symlink");
    }
    return { mode: metadata.mode & 0o777, uid: metadata.uid, gid: metadata.gid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  await fileMetadataIfExists(path);
}

async function assertSafeTargetPath(path: string, boundary: string): Promise<void> {
  if (!isAbsolute(path) || !isAbsolute(boundary)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", "MCP target path and scope root must be absolute");
  }
  const normalizedBoundary = resolve(boundary);
  const normalizedTarget = resolve(path);
  const child = relative(normalizedBoundary, normalizedTarget);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new MigrationError("MCP_TARGET_UNSUPPORTED", "MCP target path is outside the selected scope root");
  }
  let current = normalizedBoundary;
  for (const segment of child.split(sep).slice(0, -1)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new MigrationError("MCP_TARGET_UNSUPPORTED", "Refusing an MCP target path with a symlinked parent");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  await assertNotSymlink(normalizedTarget);
}

async function atomicWritePreservingMode(
  path: string,
  content: string,
  mode: number,
  ownership?: TargetFileMetadata,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${Date.now()}-${process.pid}-${randomUUID()}.tmp`);
  const descriptor = await open(temporary, "wx", mode);
  try {
    await descriptor.writeFile(content, "utf8");
    await descriptor.sync();
    await descriptor.close();
  } catch (error) {
    await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    if (
      ownership &&
      (ownership.uid !== process.getuid?.() || ownership.gid !== process.getgid?.())
    ) {
      await chown(temporary, ownership.uid, ownership.gid);
    }
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not support fsync on directories; the file itself is synced.
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await atomicWritePreservingMode(path, stablePrettyJson(value), 0o600);
}

function stripInternalFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("__dsh")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlInlineArray(values: string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value) ? value : yamlString(value);
}

function yamlEnvReference(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    ? `!!js process.env.${name}`
    : `!!js process.env[${JSON.stringify(name)}]`;
}

function yamlBearerReference(name: string): string {
  const expression = `\`Bearer \${process.env[${JSON.stringify(name)}]}\``;
  return `!!js ${JSON.stringify(expression)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
