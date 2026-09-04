import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import type {
  QoderConversationProjection,
  QoderProjectionResult,
  QoderProjectedTurn,
  QoderTargetProduct,
} from "../types.js";
import {
  QoderIdeRpcClient,
  type QoderIdeRuntime,
  type QoderIdeSession,
  waitForQoderIdeRuntime,
} from "./ide-rpc.js";

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CreateQoderProjectedSessionOptions = {
  canonicalWorkspace: string;
  projection: QoderConversationProjection;
  title: string;
  migrationId: string;
  sourceThreadId: string;
  qoderIdeVersion: string;
  runtimeTimeoutMs?: number;
  requestTimeoutMs?: number;
  dataRoot?: string;
  socketName?: "qoder.sock" | "qodercn.sock";
  targetProduct?: QoderTargetProduct;
};

export async function createQoderProjectedSession(
  options: CreateQoderProjectedSessionOptions,
): Promise<QoderProjectionResult> {
  const runtimeOptions: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
    timeoutMs?: number;
  } = {};
  if (options.dataRoot !== undefined) runtimeOptions.dataRoot = options.dataRoot;
  if (options.socketName !== undefined) runtimeOptions.socketName = options.socketName;
  if (options.runtimeTimeoutMs !== undefined) {
    runtimeOptions.timeoutMs = options.runtimeTimeoutMs;
  }
  const runtime = await waitForQoderIdeRuntime(runtimeOptions);
  const connectionOptions: { requestTimeoutMs?: number } = {};
  if (options.requestTimeoutMs !== undefined) {
    connectionOptions.requestTimeoutMs = options.requestTimeoutMs;
  }
  const targetConnectionOptions = {
    ...connectionOptions,
    ...(options.targetProduct === undefined
      ? {}
      : { targetProduct: options.targetProduct }),
  };
  const client = await QoderIdeRpcClient.connect(
    runtime,
    options.canonicalWorkspace,
    options.qoderIdeVersion,
    targetConnectionOptions,
  );
  let targetSessionId: string | null = null;
  try {
    const created = await client.request<{ sessionId?: unknown }>("session/new", {
      cwd: options.canonicalWorkspace,
      mcpServers: [],
      _meta: {
        "ai-coding/mode": "agent",
        "ai-coding/workspace-path": options.canonicalWorkspace,
      },
      timestamp: Date.now(),
    });
    if (typeof created.sessionId !== "string" || !UUID_PATTERN.test(created.sessionId)) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        "Qoder IDE did not return a valid native session id",
      );
    }
    targetSessionId = created.sessionId;

    await appendProjectedTurns(client, targetSessionId, options.projection.turns);

    const persisted = await client.request<QoderIdeSession | null>("chat/getSessionById", {
      sessionId: targetSessionId,
    });
    if (persisted?.sessionId !== targetSessionId) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        `Qoder IDE could not read back imported session ${targetSessionId}`,
      );
    }
    if (persisted.chatRecords?.length !== options.projection.turns.length) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        `Qoder IDE persisted ${persisted.chatRecords?.length ?? 0} of ${options.projection.turns.length} projected turns`,
      );
    }

    const normalized = await normalizeImportedSession(
      runtime,
      targetSessionId,
      options.canonicalWorkspace,
      {
        migrationId: options.migrationId,
        sourceThreadId: options.sourceThreadId,
      },
    );
    await client.request("chat/renameSession", {
      sessionId: targetSessionId,
      newTitle: normalizeTitle(options.title),
    });

    return {
      targetSessionId,
      requestIds: options.projection.turns.map((turn) => turn.requestId),
      projectedTurnCount: options.projection.turns.length,
      projectedMessageCount: options.projection.projectedMessageCount,
      qoderIdeVersion: options.qoderIdeVersion,
      runtimePid: runtime.pid,
      backendMethod: "session/appendHistoryTurn",
      sessionRowsNormalized: normalized.sessionRows,
      recordRowsNormalized: normalized.recordRows,
      modelInvoked: false,
    };
  } catch (error) {
    if (targetSessionId !== null) {
      await client
        .request("chat/deleteSessionById", { sessionId: targetSessionId })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    client.close();
  }
}

export type QoderHistoryWriter = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export async function appendProjectedTurns(
  client: QoderHistoryWriter,
  targetSessionId: string,
  turns: QoderProjectedTurn[],
): Promise<void> {
  for (const turn of turns) {
    const appended = await client.request<{
      appendedMessageIds?: unknown;
      createdSession?: unknown;
    }>("session/appendHistoryTurn", {
      sessionId: targetSessionId,
      requestId: turn.requestId,
      messages: turn.messages,
    });
    if (
      !Array.isArray(appended.appendedMessageIds) ||
      appended.appendedMessageIds.length !== turn.messages.length
    ) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        `Qoder IDE did not persist projected turn ${turn.requestId}`,
      );
    }
  }
}

export async function deleteQoderIdeSession(
  targetSessionId: string,
  canonicalWorkspace: string,
  qoderIdeVersion: string,
  options: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
    targetProduct?: QoderTargetProduct;
  } = {},
): Promise<void> {
  const runtimeOptions: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
  } = {};
  if (options.dataRoot !== undefined) runtimeOptions.dataRoot = options.dataRoot;
  if (options.socketName !== undefined) runtimeOptions.socketName = options.socketName;
  const runtime = await waitForQoderIdeRuntime(runtimeOptions);
  const client = await QoderIdeRpcClient.connect(
    runtime,
    canonicalWorkspace,
    qoderIdeVersion,
    options.targetProduct === undefined
      ? {}
      : { targetProduct: options.targetProduct },
  );
  let rpcError: unknown;
  try {
    await client.request("chat/deleteSessionById", { sessionId: targetSessionId });
  } catch (error) {
    rpcError = error;
  } finally {
    client.close();
  }
  const removed = await removeImportedSessionRows(
    runtime,
    targetSessionId,
    canonicalWorkspace,
  );
  if (rpcError !== undefined && removed.sessionRows === 0 && removed.recordRows === 0) {
    throw rpcError;
  }
}

export async function removeImportedSessionRows(
  runtime: QoderIdeRuntime,
  sessionId: string,
  canonicalWorkspace: string,
): Promise<{ sessionRows: number; recordRows: number }> {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new MigrationError("INTERNAL_ERROR", `Invalid Qoder session id: ${sessionId}`);
  }
  const escapedWorkspace = canonicalWorkspace.replaceAll("'", "''");
  const escapedSessionId = sessionId.replaceAll("'", "''");
  const marker = "json_extract(extra, '$.sessionCreateSource') = 'ide-hub-import'";
  const sql = [
    "BEGIN IMMEDIATE;",
    "DELETE FROM chat_record",
    `WHERE session_id = '${escapedSessionId}'`,
    `  AND ${marker};`,
    "SELECT changes();",
    "DELETE FROM chat_session",
    `WHERE session_id = '${escapedSessionId}'`,
    `  AND project_uri = '${escapedWorkspace}'`,
    `  AND ${marker};`,
    "SELECT changes();",
    "COMMIT;",
  ].join("\n");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/sqlite3", [runtime.databasePath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    throw new MigrationError(
      "QODER_RUNTIME_UNAVAILABLE",
      `Could not clean imported Qoder IDE session ${sessionId}`,
      undefined,
      { cause: error },
    );
  }
  const counts = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  return {
    recordRows: counts[0] ?? 0,
    sessionRows: counts[1] ?? 0,
  };
}

export async function removeQoderRecordRows(
  runtime: QoderIdeRuntime,
  sessionId: string,
  requestIds: string[],
): Promise<number> {
  if (!UUID_PATTERN.test(sessionId) || requestIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new MigrationError(
      "INTERNAL_ERROR",
      `Invalid Qoder record cleanup identity for session ${sessionId}`,
    );
  }
  const uniqueRequestIds = [...new Set(requestIds)];
  if (uniqueRequestIds.length === 0) return 0;
  const escapedSessionId = sessionId.replaceAll("'", "''");
  const requestIdList = uniqueRequestIds
    .map((id) => `'${id.replaceAll("'", "''")}'`)
    .join(", ");
  const sql = [
    "BEGIN IMMEDIATE;",
    "DELETE FROM chat_record",
    `WHERE session_id = '${escapedSessionId}'`,
    `  AND request_id IN (${requestIdList});`,
    "SELECT changes();",
    "COMMIT;",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/sqlite3",
      [runtime.databasePath, sql],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    return Number(stdout.trim()) || 0;
  } catch (error) {
    throw new MigrationError(
      "QODER_RUNTIME_UNAVAILABLE",
      `Could not clean Qoder IDE records for session ${sessionId}`,
      undefined,
      { cause: error },
    );
  }
}

export async function normalizeImportedSession(
  runtime: QoderIdeRuntime,
  sessionId: string,
  canonicalWorkspace: string,
  metadata?: { migrationId: string; sourceThreadId: string },
): Promise<{ sessionRows: 1; recordRows: number }> {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new MigrationError("INTERNAL_ERROR", `Invalid Qoder session id: ${sessionId}`);
  }
  const escapedWorkspace = canonicalWorkspace.replaceAll("'", "''");
  const escapedSessionId = sessionId.replaceAll("'", "''");
  const metadataAssignments = metadata === undefined
    ? "'$.sessionCreateSource', 'ide-hub-import'"
    : [
        "'$.sessionCreateSource', 'ide-hub-import'",
        `'$.ideHubMigrationId', '${metadata.migrationId.replaceAll("'", "''")}'`,
        "'$.ideHubSourceProduct', 'codex'",
        `'$.ideHubSourceThreadId', '${metadata.sourceThreadId.replaceAll("'", "''")}'`,
      ].join(", ");
  const sql = [
    "BEGIN IMMEDIATE;",
    "UPDATE chat_session",
    "SET session_type = 'assistant',",
    `    extra = json_set(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, ${metadataAssignments})`,
    `WHERE session_id = '${escapedSessionId}'`,
    `  AND project_uri = '${escapedWorkspace}'`,
    "  AND session_type = 'voice';",
    "SELECT changes();",
    "UPDATE chat_record",
    "SET session_type = 'assistant',",
    `    extra = json_set(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, ${metadataAssignments})`,
    `WHERE session_id = '${escapedSessionId}'`,
    "  AND session_type = 'voice';",
    "SELECT changes();",
    "COMMIT;",
  ].join("\n");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/sqlite3", [runtime.databasePath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    throw new MigrationError(
      "QODER_RUNTIME_UNAVAILABLE",
      `Could not normalize imported Qoder IDE session ${sessionId}`,
      undefined,
      { cause: error },
    );
  }
  const counts = stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const sessionRows = counts[0];
  const recordRows = counts[1];
  if (sessionRows !== 1 || recordRows === undefined || recordRows < 1) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
      `Qoder IDE session metadata normalization was incomplete: ${sessionId}`,
      { sessionRows: sessionRows ?? null, recordRows: recordRows ?? null },
    );
  }
  return { sessionRows: 1, recordRows };
}

function normalizeTitle(title: string): string {
  const singleLine = title.replace(/\s+/g, " ").trim();
  return (singleLine.length > 0 ? singleLine : "Imported Codex session").slice(0, 100);
}
