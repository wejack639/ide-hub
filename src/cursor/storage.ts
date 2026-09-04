import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import type {
  CursorInstallation,
  CursorStoredComposer,
  CursorVerification,
  QoderConversationProjection,
} from "../types.js";
import { stableJson } from "../util/stable-json.js";
import {
  cursorConversationRootBlobIds,
  cursorConversationTurnBlobIds,
  cursorTurnChildBlobIds,
  decodeCursorVisibleTurns,
  inspectCursorRootPromptHistory,
} from "./protocol.js";

const execFileAsync = promisify(execFile);

type HeaderRow = {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number | null;
  isArchived: number;
  value: string;
};

type DiskRow = { value: string };
type BlobRow = { valueHex: string };

export async function waitForCursorWorkspaceId(
  installation: CursorInstallation,
  canonicalWorkspace: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await findCursorWorkspaceIds(
      installation.workspaceStorageRoot,
      canonicalWorkspace,
    );
    if (matches.length > 1) {
      throw new MigrationError(
        "CURSOR_TARGET_AMBIGUOUS",
        `Cursor has multiple workspaceStorage identities for ${canonicalWorkspace}`,
        { workspaceIds: matches },
      );
    }
    const match = matches[0];
    if (match !== undefined) return match;
    await delay(250);
  }
  throw new MigrationError(
    "TARGET_WORKSPACE_MISMATCH",
    `Cursor did not create a workspace identity for ${canonicalWorkspace}`,
  );
}

export async function findCursorWorkspaceIds(
  workspaceStorageRoot: string,
  canonicalWorkspace: string,
): Promise<string[]> {
  const expectedWorkspace = await realpath(canonicalWorkspace);
  let entries;
  try {
    entries = await readdir(workspaceStorageRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceFile = join(workspaceStorageRoot, entry.name, "workspace.json");
    try {
      const value = JSON.parse(await readFile(workspaceFile, "utf8")) as {
        folder?: unknown;
      };
      if (typeof value.folder !== "string" || !value.folder.startsWith("file:")) {
        continue;
      }
      const folder = await realpath(fileURLToPath(value.folder));
      if (folder === expectedWorkspace) matches.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SyntaxError || error instanceof TypeError) continue;
      throw error;
    }
  }
  return matches.sort();
}

export async function listCursorComposers(
  installation: CursorInstallation,
  workspaceId: string,
): Promise<CursorStoredComposer[]> {
  assertWorkspaceId(workspaceId);
  const rows = await sqliteJson<HeaderRow>(
    installation.globalStorageDatabase,
    `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value
       FROM composerHeaders
      WHERE workspaceId = '${workspaceId.replaceAll("'", "''")}'
      ORDER BY createdAt DESC, composerId ASC`,
  );
  const composers: CursorStoredComposer[] = [];
  for (const row of rows) {
    const header = parseJsonObject(row.value, `Cursor composer header ${row.composerId}`);
    const composer = await hydrateCursorComposer(installation, row, header);
    if (composer !== null) composers.push(composer);
  }
  return composers;
}

export async function listCursorComposerIds(
  installation: CursorInstallation,
  workspaceId: string,
): Promise<string[]> {
  assertWorkspaceId(workspaceId);
  const rows = await sqliteJson<{ composerId: string }>(
    installation.globalStorageDatabase,
    `SELECT composerId
       FROM composerHeaders
      WHERE workspaceId = '${workspaceId.replaceAll("'", "''")}'
        AND isArchived = 0
      ORDER BY composerId ASC`,
  );
  return rows.map((row) => row.composerId);
}

export async function readCursorComposer(
  installation: CursorInstallation,
  workspaceId: string,
  composerId: string,
): Promise<CursorStoredComposer | null> {
  assertWorkspaceId(workspaceId);
  assertComposerId(composerId);
  const rows = await sqliteJson<HeaderRow>(
    installation.globalStorageDatabase,
    `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value
       FROM composerHeaders
      WHERE workspaceId = '${workspaceId.replaceAll("'", "''")}'
        AND composerId = '${composerId.replaceAll("'", "''")}'`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return hydrateCursorComposer(
    installation,
    row,
    parseJsonObject(row.value, `Cursor composer header ${row.composerId}`),
  );
}

export async function waitForNewCursorComposer(
  installation: CursorInstallation,
  workspaceId: string,
  beforeIds: ReadonlySet<string>,
  timeoutMs = 30_000,
): Promise<CursorStoredComposer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = await listCursorComposerIds(installation, workspaceId);
    const createdIds = ids.filter((composerId) => !beforeIds.has(composerId));
    if (createdIds.length > 1) {
      throw new MigrationError(
        "CURSOR_TARGET_AMBIGUOUS",
        "More than one Cursor conversation appeared during one native import",
        { composerIds: createdIds },
      );
    }
    const result = createdIds[0];
    if (result !== undefined) {
      try {
        const composer = await readCursorComposer(installation, workspaceId, result);
        if (composer !== null) return composer;
      } catch (error) {
        if (
          !(error instanceof MigrationError) ||
          error.code !== "CURSOR_IMPORT_FAILED"
        ) {
          throw error;
        }
        // Cursor persists the header, body and referenced blobs separately.
        // A read between those writes is transient, so keep polling.
      }
    }
    await delay(200);
  }
  throw new MigrationError(
    "TARGET_SESSION_NOT_PERSISTED",
    "Cursor native importer did not persist a new conversation",
  );
}

export async function waitForCursorComposerVerification(
  installation: CursorInstallation,
  canonicalWorkspace: string,
  workspaceId: string,
  composerId: string,
  projection: QoderConversationProjection,
  timeoutMs = 30_000,
): Promise<{ composer: CursorStoredComposer; verification: CursorVerification }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: MigrationError | null = null;
  while (Date.now() < deadline) {
    try {
      const composer = await readCursorComposer(
        installation,
        workspaceId,
        composerId,
      );
      if (composer !== null) {
        return {
          composer,
          verification: verifyCursorComposer(
            composer,
            canonicalWorkspace,
            workspaceId,
            projection,
          ),
        };
      }
    } catch (error) {
      if (
        !(error instanceof MigrationError) ||
        error.code !== "CURSOR_IMPORT_FAILED"
      ) {
        throw error;
      }
      lastError = error;
    }
    await delay(200);
  }
  throw new MigrationError(
    "CURSOR_IMPORT_FAILED",
    `Cursor conversation ${composerId} did not settle to the expected visible history`,
    { lastError: lastError?.message ?? null },
  );
}

export function verifyCursorComposer(
  composer: CursorStoredComposer,
  canonicalWorkspace: string,
  workspaceId: string,
  projection: QoderConversationProjection,
): CursorVerification {
  if (composer.workspaceId !== workspaceId) {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      `Cursor conversation ${composer.composerId} is bound to ${composer.workspaceId}; expected ${workspaceId}`,
    );
  }
  if (composer.isArchived) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
      `Cursor conversation ${composer.composerId} is archived`,
    );
  }
  const actualTurns = decodeCursorVisibleTurns(
    composer.conversationState,
    composer.blobs,
  );
  const expectedTurns = projection.turns.map((turn) => turn.messages);
  const rootHistory = inspectCursorRootPromptHistory(
    composer.conversationState,
    composer.blobs,
  );
  if (rootHistory.systemPromptRootCount === 0 || !rootHistory.systemPromptRootFirst) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor conversation has no leading system prompt root",
      {
        rootMessageCount: rootHistory.rootMessageCount,
        systemPromptRootCount: rootHistory.systemPromptRootCount,
        systemPromptRootFirst: rootHistory.systemPromptRootFirst,
      },
    );
  }
  const expectedRootHistory = expectedTurns.flat();
  if (
    rootHistory.historyMessages.length < expectedRootHistory.length ||
    stableJson(rootHistory.historyMessages.slice(0, expectedRootHistory.length)) !==
      stableJson(expectedRootHistory)
  ) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor root prompt history does not preserve the Codex visible-message prefix",
      {
        expectedMessageCount: projection.projectedMessageCount,
        actualMessageCount: rootHistory.historyMessages.length,
      },
    );
  }
  if (
    actualTurns.length < expectedTurns.length ||
    stableJson(actualTurns.slice(0, expectedTurns.length)) !== stableJson(expectedTurns)
  ) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor native conversation body does not preserve the Codex visible-turn prefix",
      {
        expectedTurnCount: expectedTurns.length,
        actualTurnCount: actualTurns.length,
        expectedMessageCount: projection.projectedMessageCount,
        actualMessageCount: actualTurns.flat().length,
      },
    );
  }
  return {
    sessionId: composer.composerId,
    workspace: canonicalWorkspace,
    workspaceId,
    projectedTurnCount: actualTurns.length,
    projectedMessageCount: actualTurns.flat().length,
    historyVisible: true,
    systemPromptRootCount: rootHistory.systemPromptRootCount,
    rootHistoryValid: true,
  };
}

async function hydrateCursorComposer(
  installation: CursorInstallation,
  row: HeaderRow,
  header: Record<string, unknown>,
): Promise<CursorStoredComposer | null> {
  const body = await readCursorComposerBody(installation, row.composerId);
  if (body === null) return null;
  const conversationState = body.conversationState;
  if (typeof conversationState !== "string") return null;
  return {
    composerId: row.composerId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    isArchived: row.isArchived !== 0 || header.isArchived === true,
    name:
      typeof body.name === "string"
        ? body.name
        : typeof header.name === "string"
          ? header.name
          : "",
    conversationState,
    blobs: await readCursorConversationBlobs(installation, conversationState),
  };
}

async function readCursorConversationBlobs(
  installation: CursorInstallation,
  conversationState: string,
): Promise<Record<string, string>> {
  const blobs: Record<string, string> = {};
  const rootIds = cursorConversationRootBlobIds(conversationState);
  for (const id of rootIds) blobs[id] = await readCursorBlob(installation, id);
  for (const turnId of cursorConversationTurnBlobIds(conversationState)) {
    const turn = blobs[turnId];
    if (turn === undefined) continue;
    for (const childId of cursorTurnChildBlobIds(turn)) {
      blobs[childId] = await readCursorBlob(installation, childId);
    }
  }
  return blobs;
}

async function readCursorBlob(
  installation: CursorInstallation,
  blobId: string,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(blobId)) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `Unexpected Cursor blob id: ${blobId}`,
    );
  }
  const rows = await sqliteJson<BlobRow>(
    installation.globalStorageDatabase,
    `SELECT HEX(value) AS valueHex
       FROM cursorDiskKV
      WHERE key = 'agentKv:blob:${blobId}'`,
  );
  const valueHex = rows[0]?.valueHex;
  if (typeof valueHex !== "string") {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `Cursor native blob is missing after import: ${blobId}`,
    );
  }
  return Buffer.from(valueHex, "hex").toString("base64");
}

async function readCursorComposerBody(
  installation: CursorInstallation,
  composerId: string,
): Promise<Record<string, unknown> | null> {
  assertComposerId(composerId);
  const rows = await sqliteJson<DiskRow>(
    installation.globalStorageDatabase,
    `SELECT CAST(value AS TEXT) AS value
       FROM cursorDiskKV
      WHERE key = 'composerData:${composerId.replaceAll("'", "''")}'`,
  );
  const row = rows[0];
  return row === undefined
    ? null
    : parseJsonObject(row.value, `Cursor composer body ${composerId}`);
}

async function sqliteJson<T>(database: string, query: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", "-cmd", ".timeout 5000", database, query],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (stdout.trim() === "") return [];
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("sqlite3 JSON output is not an array");
    return parsed as T[];
  } catch (error) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `Failed to read Cursor native storage ${basename(database)}`,
      { database },
      { cause: error },
    );
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function assertWorkspaceId(value: string): void {
  if (!/^[a-f0-9]{32}$/u.test(value)) {
    throw new MigrationError(
      "CURSOR_TARGET_AMBIGUOUS",
      `Unexpected Cursor workspace id: ${value}`,
    );
  }
}

function assertComposerId(value: string): void {
  if (!/^[a-f0-9-]{20,64}$/u.test(value)) {
    throw new MigrationError(
      "CURSOR_TARGET_AMBIGUOUS",
      `Unexpected Cursor composer id: ${value}`,
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
