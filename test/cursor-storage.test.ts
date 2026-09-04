import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { buildCursorChatExport } from "../src/cursor/protocol.js";
import {
  findCursorWorkspaceIds,
  listCursorComposerIds,
  readCursorComposer,
  verifyCursorComposer,
  waitForCursorComposerVerification,
} from "../src/cursor/storage.js";
import type { CursorInstallation, QoderConversationProjection } from "../src/types.js";

const execFileAsync = promisify(execFile);

test("Cursor native readback resolves exact workspace and verifies blob graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-cursor-storage-"));
  const workspace = join(root, "workspace");
  const workspaceStorageRoot = join(root, "workspaceStorage");
  const workspaceId = "0123456789abcdef0123456789abcdef";
  const composerId = "01234567-89ab-cdef-0123-456789abcdef";
  const database = join(root, "state.vscdb");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
  await writeFile(
    join(workspaceStorageRoot, workspaceId, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(workspace).href }),
  );

  const projection: QoderConversationProjection = {
    schemaVersion: "ide-hub-qoder-conversation-projection-v1",
    sourceMessageCount: 2,
    projectedMessageCount: 2,
    turns: [
      {
        requestId: "request-1",
        sourceTurnIds: ["turn-1"],
        sourceItemIds: ["user-1", "assistant-1"],
        sourceMessageCount: 2,
        messages: [
          { role: "user", content: "fixture user" },
          { role: "assistant", content: "fixture assistant" },
        ],
      },
    ],
  };
  const payload = buildCursorChatExport(projection, "Codex · fixture", {
    workspace,
    exportedAt: 1,
    createId: () => "message-1",
  });
  const header = JSON.stringify({
    composerId,
    name: "(1) Codex · fixture",
    isArchived: false,
    workspaceIdentifier: {
      id: workspaceId,
      uri: { fsPath: workspace },
    },
  });
  const body = JSON.stringify({
    composerId,
    name: "(1) Codex · fixture",
    conversationState: `~${payload.conversationState}`,
  });
  const statements = [
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);",
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT INTO composerHeaders VALUES (${sql(composerId)}, ${sql(workspaceId)}, 10, NULL, 0, 0, 10, NULL, ${sql(header)});`,
    `INSERT INTO cursorDiskKV VALUES (${sql(`composerData:${composerId}`)}, ${sql(body)});`,
    ...Object.entries(payload.blobs).map(
      ([id, value]) =>
        `INSERT INTO cursorDiskKV VALUES (${sql(`agentKv:blob:${id}`)}, X'${Buffer.from(value, "base64").toString("hex")}');`,
    ),
  ];
  await execFileAsync("/usr/bin/sqlite3", [database, statements.join("\n")]);

  const installation: CursorInstallation = {
    targetProduct: "cursor",
    appPath: "/Applications/Cursor.app",
    bundleId: "com.todesktop.230313mzl4w4u92",
    version: "3.18.9",
    compatible: true,
    compatibilityError: null,
    workbenchPath: "/tmp/workbench.js",
    workbenchSha256: "fixture",
    cliPath: "/tmp/cursor",
    userDataRoot: root,
    workspaceStorageRoot,
    globalStorageDatabase: database,
  };

  assert.deepEqual(
    await findCursorWorkspaceIds(workspaceStorageRoot, workspace),
    [workspaceId],
  );
  assert.deepEqual(await listCursorComposerIds(installation, workspaceId), [composerId]);
  const composer = await readCursorComposer(installation, workspaceId, composerId);
  assert.ok(composer);
  assert.deepEqual(
    verifyCursorComposer(composer, workspace, workspaceId, projection),
    {
      sessionId: composerId,
      workspace,
      workspaceId,
      projectedTurnCount: 1,
      projectedMessageCount: 2,
      historyVisible: true,
      systemPromptRootCount: 1,
      rootHistoryValid: true,
    },
  );

  const incompleteBody = JSON.stringify({
    composerId,
    name: "(1) Codex · fixture",
    conversationState: "~UAE=",
  });
  await execFileAsync("/usr/bin/sqlite3", [
    database,
    `UPDATE cursorDiskKV SET value = ${sql(incompleteBody)} WHERE key = ${sql(`composerData:${composerId}`)};`,
  ]);
  const restore = new Promise<void>((resolveRestore, rejectRestore) => {
    setTimeout(() => {
      void execFileAsync("/usr/bin/sqlite3", [
        database,
        `UPDATE cursorDiskKV SET value = ${sql(body)} WHERE key = ${sql(`composerData:${composerId}`)};`,
      ]).then(() => resolveRestore(), rejectRestore);
    }, 50);
  });
  const settled = await waitForCursorComposerVerification(
    installation,
    workspace,
    workspaceId,
    composerId,
    projection,
    2_000,
  );
  await restore;
  assert.equal(settled.verification.sessionId, composerId);
});

test("Cursor verification preserves user continuation after the migrated prefix", () => {
  const workspace = "/tmp/cursor-continuation";
  const workspaceId = "0123456789abcdef0123456789abcdef";
  const composerId = "01234567-89ab-cdef-0123-456789abcdef";
  const sourceProjection: QoderConversationProjection = {
    schemaVersion: "ide-hub-qoder-conversation-projection-v1",
    sourceMessageCount: 2,
    projectedMessageCount: 2,
    turns: [
      {
        requestId: "source-request",
        sourceTurnIds: ["source-turn"],
        sourceItemIds: ["source-user", "source-assistant"],
        sourceMessageCount: 2,
        messages: [
          { role: "user", content: "source question" },
          { role: "assistant", content: "source answer" },
        ],
      },
    ],
  };
  const continuedProjection: QoderConversationProjection = {
    ...sourceProjection,
    sourceMessageCount: 4,
    projectedMessageCount: 4,
    turns: [
      ...sourceProjection.turns,
      {
        requestId: "cursor-request",
        sourceTurnIds: ["cursor-turn"],
        sourceItemIds: ["cursor-user", "cursor-assistant"],
        sourceMessageCount: 2,
        messages: [
          { role: "user", content: "continued question" },
          { role: "assistant", content: "continued answer" },
        ],
      },
    ],
  };
  const payload = buildCursorChatExport(continuedProjection, "Codex · fixture", {
    workspace,
    exportedAt: 1,
    createId: () => "message-1",
  });

  assert.deepEqual(
    verifyCursorComposer(
      {
        composerId,
        workspaceId,
        createdAt: 1,
        lastUpdatedAt: 2,
        isArchived: false,
        name: "Codex · fixture",
        conversationState: payload.conversationState,
        blobs: payload.blobs,
      },
      workspace,
      workspaceId,
      sourceProjection,
    ),
    {
      sessionId: composerId,
      workspace,
      workspaceId,
      projectedTurnCount: 2,
      projectedMessageCount: 4,
      historyVisible: true,
      systemPromptRootCount: 1,
      rootHistoryValid: true,
    },
  );
});

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
