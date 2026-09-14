import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { MigrationArtifacts } from "../src/artifacts.js";
import {
  cancelCodeBuddyWaitingMigration,
  confirmCodeBuddyRollbackDeleted,
  migrateCodeBuddy,
  prepareCodeBuddyRollback,
} from "../src/codebuddy/migration.js";
import type { MigrationResult } from "../src/types.js";
import { codeBuddyWorkspaceHash } from "../src/codebuddy/storage.js";
import type { CodeBuddyInstallation } from "../src/types.js";
import { snapshot, threadItem, turn } from "./fixtures.js";

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

test("CodeBuddy migration waits for official Import, then adopts and idempotently reuses exact native history", async () => {
  const root = await mkdtemp(join(tmpdir(), "idehub-codebuddy-flow-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "idehub-codebuddy-workspace-")));
  const dataRoot = join(root, "CodeBuddyExtension", "Data");
  const logsRoot = join(root, "CodeBuddy", "logs");
  const installation: CodeBuddyInstallation = {
    targetProduct: "codebuddy-international",
    appPath: "/Applications/CodeBuddy.app",
    appName: "CodeBuddy.app",
    bundleId: "com.tencent.codebuddy",
    version: "4.12.0",
    compatible: true,
    compatibilityError: null,
    productCommit: "b4c35ed08ffb428910211608831a314565c1256e",
    applicationName: "buddy",
    extensionVersion: "3.10.0",
    extensionSha256: "fixture",
    launcherPath: "/Applications/CodeBuddy.app/Contents/Resources/app/bin/code",
    userDataRoot: join(root, "CodeBuddy"),
    logsRoot,
    historyDataRoot: dataRoot,
  };
  const source = snapshot(workspace, [turn("turn", [
    threadItem("userMessage", { id: "u", content: [{ type: "text", text: "question" }] }),
    threadItem("agentMessage", { id: "a", text: "answer" }),
  ])]);
  source.thread.cwd = workspace;
  source.workspace.workspaceCanonical = workspace;
  source.workspace.sourceWorkspaceRaw = workspace;
  const workspaceStat = await stat(workspace);
  source.workspace.workspaceIdentity = { device: workspaceStat.dev, inode: workspaceStat.ino };
  let opens = 0;
  let reveals = 0;
  const firstArtifacts = new MigrationArtifacts("11111111-1111-4111-8111-111111111111", root);
  await firstArtifacts.initialize();
  const first = await migrateCodeBuddy({
    snapshot: source,
    artifacts: firstArtifacts,
    targetProduct: "codebuddy-international",
    dryRun: false,
    installation,
    stateRoot: join(root, "state"),
    openWorkspace: () => { opens += 1; },
    revealArchive: async () => { reveals += 1; },
  });
  assert.equal(first.status, "WAITING_TARGET_IMPORT");
  assert.equal(first.targetSessionId, null);
  assert.equal(opens, 1);
  assert.equal(reveals, 1);

  const expected = first.archive.data.conversations[0];
  const targetId = "native_imported";
  const workspaceRoot = join(dataRoot, "uid", "CodeBuddyIDE", "uid", "history", codeBuddyWorkspaceHash(workspace));
  await json(join(workspaceRoot, "index.json"), { conversations: [{ id: targetId, originalId: expected.id }], current: "" });
  await json(join(workspaceRoot, targetId, "index.json"), {
    messages: expected.requests.flatMap((request) => request.messages.map((message) => ({ id: message.id, role: message.role, type: "text", isComplete: true }))),
    requests: expected.requests.map((request) => ({ id: request.id, type: request.type, state: request.state, messages: request.messages.map((message) => message.id) })),
  });
  for (const request of expected.requests) for (const message of request.messages) {
    await json(join(workspaceRoot, targetId, "messages", `${message.id}.json`), message);
  }
  const logPath = join(logsRoot, "run", "window", "extension.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `History Base Path: ${workspaceRoot}/\n[ConversationManager] Imported conversation: originalId=${expected.id}, id=${targetId}\n`);

  const secondArtifacts = new MigrationArtifacts("22222222-2222-4222-8222-222222222222", root);
  await secondArtifacts.initialize();
  const completed = await migrateCodeBuddy({
    snapshot: source,
    artifacts: secondArtifacts,
    targetProduct: "codebuddy-international",
    dryRun: false,
    installation,
    stateRoot: join(root, "state"),
    openWorkspace: () => { opens += 1; },
    revealArchive: async () => { reveals += 1; },
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.targetSessionId, targetId);
  assert.equal(opens, 1);

  const thirdArtifacts = new MigrationArtifacts("33333333-3333-4333-8333-333333333333", root);
  await thirdArtifacts.initialize();
  const reused = await migrateCodeBuddy({
    snapshot: source,
    artifacts: thirdArtifacts,
    targetProduct: "codebuddy-international",
    dryRun: false,
    installation,
    stateRoot: join(root, "state"),
    openWorkspace: () => { opens += 1; },
    revealArchive: async () => { reveals += 1; },
  });
  assert.equal(reused.status, "COMPLETED");
  assert.equal(reused.reused, true);
  assert.equal(reused.targetSessionId, targetId);
  assert.equal(opens, 1);

  const nativeIndexPath = join(workspaceRoot, targetId, "index.json");
  const nativeIndex = JSON.parse(await readFile(nativeIndexPath, "utf8"));
  nativeIndex.requests.push({ id: "continued", type: "craft", state: "complete", messages: ["continued-user"] });
  nativeIndex.messages.push({ id: "continued-user", type: "text", role: "user", isComplete: true });
  await json(nativeIndexPath, nativeIndex);
  await json(join(workspaceRoot, targetId, "messages", "continued-user.json"), {
    id: "continued-user",
    role: "user",
    message: JSON.stringify({ role: "user", content: "continued" }),
  });

  await assert.rejects(
    prepareCodeBuddyRollback({
      targetProduct: "codebuddy-international",
      workspace,
      archiveId: expected.id,
      targetSessionId: targetId,
      allowDeleteContinuation: false,
      installation,
      stateRoot: join(root, "state"),
      openWorkspace: () => { opens += 1; },
    }),
    (error: unknown) => (error as { code?: string }).code === "CODEBUDDY_ROLLBACK_HAS_CONTINUATION",
  );
  const rollback = await prepareCodeBuddyRollback({
    targetProduct: "codebuddy-international",
    workspace,
    archiveId: expected.id,
    targetSessionId: targetId,
    allowDeleteContinuation: true,
    installation,
    stateRoot: join(root, "state"),
    openWorkspace: () => { opens += 1; },
  });
  assert.equal(rollback.continuationWillBeDeleted, true);
  assert.equal(rollback.continuationMessageCount, 1);
  await assert.rejects(
    confirmCodeBuddyRollbackDeleted({
      targetProduct: "codebuddy-international",
      workspace,
      archiveId: expected.id,
      targetSessionId: targetId,
      installation,
      stateRoot: join(root, "state"),
    }),
    (error: unknown) => (error as { code?: string }).code === "CODEBUDDY_ROLLBACK_PENDING",
  );

  await json(join(workspaceRoot, "index.json"), { conversations: [], current: "" });
  await rm(join(workspaceRoot, targetId), { recursive: true });
  const rolledBack = await confirmCodeBuddyRollbackDeleted({
    targetProduct: "codebuddy-international",
    workspace,
    archiveId: expected.id,
    targetSessionId: targetId,
    installation,
    stateRoot: join(root, "state"),
  });
  assert.equal(rolledBack.status, "ROLLED_BACK");
  await assert.rejects(
    prepareCodeBuddyRollback({
      targetProduct: "codebuddy-international",
      workspace,
      archiveId: expected.id,
      targetSessionId: targetId,
      allowDeleteContinuation: true,
      installation,
      stateRoot: join(root, "state"),
      openWorkspace: () => { opens += 1; },
    }),
    (error: unknown) => (error as { code?: string }).code === "CODEBUDDY_MIGRATION_NOT_FOUND",
  );
});

test("CodeBuddy waiting task can be cancelled without deleting its audit archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "idehub-codebuddy-cancel-"));
  const migrationId = "44444444-4444-4444-8444-444444444444";
  const artifacts = new MigrationArtifacts(migrationId, root);
  await artifacts.initialize();
  const archivePath = await artifacts.writeText("codebuddy-import/archive.json", "{}\n");
  const result: MigrationResult = {
    migrationId,
    status: "WAITING_TARGET_IMPORT",
    sourceThreadId: "source",
    targetSessionId: null,
    workspace: "/tmp/A",
    modelInvoked: false,
    mcpChanged: false,
    continuation: { product: "codebuddy-cn", bundleId: "com.tencent.codebuddycn" },
    details: {
      artifactsDir: artifacts.directory,
      sourceSnapshotSha256: "a".repeat(64),
      seedContextSha256: "b".repeat(64),
      seedContextBytes: 1,
      projectionSha256: "c".repeat(64),
      projectedTurnCount: 1,
      projectedMessageCount: 1,
      lossReport: {
        policy: "goal-recent-plan-v1",
        maxBytes: 1,
        sourceMessageCount: 1,
        includedMessageCount: 1,
        omittedMessageCount: 0,
        sourceMessageBytes: 1,
        includedMessageBytes: 1,
        omittedMessageBytes: 0,
        omittedEventTypes: {},
        truncatedFields: [],
      },
      codeBuddy: {
        archiveId: `idehub_cb_cn_${"d".repeat(64)}`,
        archivePath,
        archiveBytes: 3,
        workspaceHash: "e".repeat(32),
        importVerified: false,
        continuationVerified: false,
        continuationRequestCount: 0,
        continuationMessageCount: 0,
        continuationCompletedRoundCount: 0,
        targetHistoryPath: null,
      },
    },
  };
  await artifacts.writeJson("target-result.json", result);

  const cancelled = await cancelCodeBuddyWaitingMigration(migrationId, root);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(await readFile(archivePath, "utf8"), "{}\n");
  assert.match(await readFile(artifacts.journalPath, "utf8"), /"state":"CANCELLED"/u);
  await assert.rejects(
    cancelCodeBuddyWaitingMigration(migrationId, root),
    (error: unknown) => (error as { code?: string }).code === "CODEBUDDY_TARGET_CONFLICT",
  );
});
