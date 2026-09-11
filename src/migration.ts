import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MigrationArtifacts } from "./artifacts.js";
import { buildCapsule } from "./capsule.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { readCodexThread, readCodexThreadMetadata } from "./codex/reader.js";
import { projectConversationToQoder } from "./conversation-projection.js";
import {
  CURSOR_BRIDGE_VERSION,
  ensureCursorBridge,
  invokeCursorBridge,
  removeCursorBridgeRequestFiles,
} from "./cursor/bridge.js";
import { discoverCursor, openCursorWorkspace } from "./cursor/discovery.js";
import {
  cursorMigrationKey,
  readCursorMigrationMapping,
  writeCursorMigrationMapping,
} from "./cursor/idempotency.js";
import {
  buildCursorChatExport,
  CURSOR_PROTOCOL_VERSION,
  decodeCursorVisibleTurns,
  inspectCursorRootPromptHistory,
} from "./cursor/protocol.js";
import {
  listCursorComposerIds,
  readCursorComposer,
  waitForCursorComposerVerification,
  waitForCursorWorkspaceId,
  waitForNewCursorComposer,
} from "./cursor/storage.js";
import {
  ensureDshRuntime,
  invokeDshBridge,
  openDshWeb,
  type DshBridgeInspection,
} from "./dsh/bridge.js";
import {
  DSH_BRIDGE_VERSION,
  discoverDsh,
  ensureDshBridge,
  inspectDsh,
} from "./dsh/discovery.js";
import {
  dshMigrationKey,
  dshTargetSessionId,
} from "./dsh/idempotency.js";
import { buildDshSessionSeed } from "./dsh/protocol.js";
import { verifyDshInspection } from "./dsh/verify.js";
import { MigrationError, asMigrationError } from "./errors.js";
import { computeMcpFingerprint } from "./mcp-fingerprint.js";
import { discoverQoder, openQoderWorkspace } from "./qoder/discovery.js";
import { createQoderProjectedSession, deleteQoderIdeSession } from "./qoder/seed.js";
import { verifyQoderSession } from "./qoder/verify.js";
import { buildSeedContext, extractVisibleMessages } from "./seed-context.js";
import type {
  FileFingerprint,
  MigrationRequest,
  MigrationResult,
  SourceSnapshot,
} from "./types.js";
import { fingerprintFile, sha256Text } from "./util/fs.js";
import { stableJson } from "./util/stable-json.js";
import { resolveWorkspace } from "./workspace.js";
import { migrateZcode } from "./zcode/migration.js";
import { migratePi } from "./pi/migration.js";
import { PI_PACKAGE } from "./pi/discovery.js";

export async function runMigration(request: MigrationRequest): Promise<MigrationResult> {
  const migrationId = randomUUID();
  const artifacts = new MigrationArtifacts(migrationId);
  const codex = new CodexAppServerClient({ networkDisabled: ["zcode", "pi"].includes(request.targetProduct) && process.platform === "darwin" });
  await artifacts.initialize();
  await artifacts.appendJournal("CREATED", { migrationId });
  await artifacts.writeJson("request.json", request);

  try {
    await codex.start();
    await artifacts.appendJournal("SOURCE_DISCOVERED", {
      sourceThreadId: request.sourceThreadId,
    });

    const metadata = await readCodexThreadMetadata(codex, request.sourceThreadId);
    if (metadata.path === null) {
      throw new MigrationError(
        "SOURCE_THREAD_NOT_FOUND",
        `Codex thread has no local rollout path: ${request.sourceThreadId}`,
      );
    }
    const sourceBeforeRead = await fingerprintFile(metadata.path);
    const workspace = await resolveWorkspace(metadata.cwd);
    await artifacts.appendJournal("WORKSPACE_RESOLVED", workspace);

    const read = await readCodexThread(codex, request.sourceThreadId);
    const sourceAfterRead = await fingerprintFile(metadata.path);
    assertFingerprintUnchanged(sourceBeforeRead, sourceAfterRead, "snapshot read");
    await artifacts.appendJournal("SOURCE_STABLE", {
      sourceSha256: sourceAfterRead.sha256,
      sourceSize: sourceAfterRead.size,
      sourceMtimeMs: sourceAfterRead.mtimeMs,
    });

    const snapshot: SourceSnapshot = {
      schemaVersion: "ide-hub-source-snapshot-v1",
      capturedAt: new Date().toISOString(),
      thread: read.thread,
      sourceFile: sourceAfterRead,
      workspace,
      reader: read.reader,
    };
    const snapshotCanonical = stableJson(snapshot);
    const sourceSnapshotSha256 = sha256Text(snapshotCanonical);
    await artifacts.writeJson("source-snapshot.json", snapshot);
    await artifacts.appendJournal("SOURCE_SNAPSHOTTED", {
      sourceSnapshotSha256,
      reader: read.reader,
    });

    const capsule = buildCapsule(snapshot);
    const capsulePath = await artifacts.writeText("capsule.jsonl", capsule.content);
    const seed = buildSeedContext(snapshot, {
      migrationId,
      sourceSnapshotSha256,
      capsulePath,
      capsuleSha256: capsule.sha256,
    });
    await artifacts.writeText("seed-context.md", seed.content);
    await artifacts.writeJson("loss-report.json", seed.lossReport);
    await artifacts.appendJournal("SEED_CONTEXT_BUILT", {
      capsuleSha256: capsule.sha256,
      capsuleEvents: capsule.eventCount,
      seedContextSha256: seed.sha256,
      seedContextBytes: seed.bytes,
      lossReport: seed.lossReport,
    });
    if (request.targetProduct === "pi") {
      const mcpBefore = await computeMcpFingerprint(codex, workspace.workspaceCanonical, "pi");
      await artifacts.appendJournal("MCP_BASELINE_CAPTURED", mcpBefore);
      const target = await migratePi({ snapshot, artifacts, dryRun: request.dryRun });
      const postConditions = await assertPostConditions(codex, metadata.path, sourceAfterRead, workspace.workspaceCanonical, mcpBefore, "pi");
      await artifacts.appendJournal("POST_CONDITIONS_VERIFIED", postConditions);
      const result = makeResult({ migrationId, status: request.dryRun ? "DRY_RUN" : "COMPLETED",
        sourceThreadId: request.sourceThreadId, targetSessionId: target.targetSessionId,
        workspace: workspace.workspaceCanonical, artifacts, sourceSnapshotSha256,
        seed: { ...seed, lossReport: target.projection.lossReport },
        projectionSha256: sha256Text(stableJson(target.projection)), projection: target.projection,
        targetProduct: "pi", targetBundleId: PI_PACKAGE });
      await artifacts.writeJson("target-result.json", result);
      await artifacts.appendJournal(result.status, { targetSessionId: target.targetSessionId, reused: target.reused, continuationVerified: false });
      return result;
    }
    if (request.targetProduct === "zcode") {
      const mcpBefore = await computeMcpFingerprint(codex, workspace.workspaceCanonical, "zcode");
      await artifacts.appendJournal("MCP_BASELINE_CAPTURED", mcpBefore);
      const target = await migrateZcode({ snapshot, artifacts, dryRun: request.dryRun });
      const postConditions = await assertPostConditions(codex, metadata.path, sourceAfterRead, workspace.workspaceCanonical, mcpBefore, "zcode");
      await artifacts.appendJournal("POST_CONDITIONS_VERIFIED", postConditions);
      const result = makeResult({ migrationId, status: request.dryRun ? "DRY_RUN" : "COMPLETED",
        sourceThreadId: request.sourceThreadId, targetSessionId: target.targetSessionId,
        workspace: workspace.workspaceCanonical, artifacts, sourceSnapshotSha256,
        seed: { ...seed, lossReport: target.projection.lossReport },
        projectionSha256: sha256Text(stableJson(target.projection)), projection: target.projection,
        targetProduct: "zcode", targetBundleId: "dev.zcode.app" });
      await artifacts.writeJson("target-result.json", result);
      await artifacts.appendJournal(result.status, { targetSessionId: target.targetSessionId, reused: target.reused });
      return result;
    }

    const projection = projectConversationToQoder(extractVisibleMessages(snapshot));
    const projectionCanonical = stableJson(projection);
    const projectionSha256 = sha256Text(projectionCanonical);
    await artifacts.writeJson("conversation-projection.json", projection);
    await artifacts.appendJournal("CONVERSATION_PROJECTED", {
      projectionSha256,
      sourceMessageCount: projection.sourceMessageCount,
      projectedMessageCount: projection.projectedMessageCount,
      projectedTurnCount: projection.turns.length,
    });

    if (request.targetProduct === "cursor") {
      return await runCursorTarget({
        request,
        migrationId,
        artifacts,
        codex,
        metadataPath: metadata.path,
        sourceFingerprint: sourceAfterRead,
        sourceSnapshotSha256,
        workspace: workspace.workspaceCanonical,
        threadName: read.thread.name,
        threadPreview: read.thread.preview,
        seed,
        projection,
        projectionSha256,
      });
    }

    if (request.targetProduct === "deepseek-harness") {
      return await runDshTarget({
        request,
        migrationId,
        artifacts,
        codex,
        metadataPath: metadata.path,
        sourceFingerprint: sourceAfterRead,
        sourceSnapshotSha256,
        workspace: workspace.workspaceCanonical,
        threadName: read.thread.name,
        threadPreview: read.thread.preview,
        threadCreatedAt: read.thread.createdAt,
        seed,
        projection,
        projectionSha256,
      });
    }

    const qoderInstallation = await discoverQoder(request.targetProduct);
    const mcpBefore = await computeMcpFingerprint(
      codex,
      workspace.workspaceCanonical,
      request.targetProduct,
    );
    await artifacts.writeJson("target-plan.json", {
      targetProduct: request.targetProduct,
      targetBundleId: qoderInstallation.bundleId,
      targetVersion: qoderInstallation.version,
      targetSessionId: null,
      targetWorkspace: workspace.workspaceCanonical,
      operation: "qoder-ide-native-turn-projection",
      backendMethods: ["session/new", "session/appendHistoryTurn"],
      appendStrategy: "one-session-appendHistoryTurn-call-per-conversation-turn",
      modelMethodsForbidden: ["session/prompt", "chat/ask"],
      modelInvoked: false,
      mcpFingerprintBefore: mcpBefore,
    });

    if (request.dryRun) {
      const result = makeResult({
        migrationId,
        status: "DRY_RUN",
        sourceThreadId: request.sourceThreadId,
        targetSessionId: null,
        workspace: workspace.workspaceCanonical,
        artifacts,
        sourceSnapshotSha256,
        seed,
        projectionSha256,
        projection,
        targetProduct: request.targetProduct,
        targetBundleId: qoderInstallation.bundleId,
      });
      await artifacts.writeJson("target-result.json", result);
      await artifacts.appendJournal("DRY_RUN_COMPLETED", {
        targetSessionIdPlanned: null,
      });
      return result;
    }

    openQoderWorkspace(qoderInstallation, workspace.workspaceCanonical);
    await artifacts.appendJournal("QODER_OPEN_REQUESTED", {
      bundleId: qoderInstallation.bundleId,
      workspace: workspace.workspaceCanonical,
    });

    let targetSessionId: string | null = null;
    try {
      const qoderProjection = await createQoderProjectedSession({
        canonicalWorkspace: workspace.workspaceCanonical,
        projection,
        title: targetSessionTitle(read.thread.name, read.thread.preview),
        migrationId,
        sourceThreadId: request.sourceThreadId,
        qoderIdeVersion: qoderInstallation.version,
        dataRoot: qoderInstallation.dataRoot,
        socketName: qoderInstallation.socketName,
        targetProduct: request.targetProduct,
      });
      targetSessionId = qoderProjection.targetSessionId;
      await artifacts.appendJournal("TARGET_SESSION_CREATED", qoderProjection);
      const verification = await verifyQoderSession(
        targetSessionId,
        workspace,
        projection.turns,
        qoderInstallation.version,
        {
          dataRoot: qoderInstallation.dataRoot,
          socketName: qoderInstallation.socketName,
          targetProduct: request.targetProduct,
        },
      );
      await artifacts.appendJournal("TARGET_VERIFIED", {
        sessionId: verification.sessionId,
        workspace: verification.workspace,
        projectedTurnCount: verification.projectedTurnCount,
        projectedMessageCount: verification.projectedMessageCount,
        historyVisible: verification.historyVisible,
        backendSocketPath: verification.backendSocketPath,
      });
    } catch (error) {
      const migrationError = asMigrationError(error);
      if (targetSessionId !== null) {
        let cleanupSucceeded = false;
        try {
          await deleteQoderIdeSession(
            targetSessionId,
            workspace.workspaceCanonical,
            qoderInstallation.version,
            {
              dataRoot: qoderInstallation.dataRoot,
              socketName: qoderInstallation.socketName,
              targetProduct: request.targetProduct,
            },
          );
          cleanupSucceeded = true;
        } catch {
          // The exact target id remains in the journal for a later retry.
        }
        await artifacts.appendJournal("CLEANUP_REQUIRED", {
          code: migrationError.code,
          message: migrationError.message,
          targetSessionId,
          cleanupSucceeded,
        });
      }
      throw migrationError;
    }

    if (targetSessionId === null) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        "Qoder IDE did not create a target session",
      );
    }

    await assertPostConditions(
      codex,
      metadata.path,
      sourceAfterRead,
      workspace.workspaceCanonical,
      mcpBefore,
      request.targetProduct,
    );
    await artifacts.appendJournal("QODER_OPENED", {
      bundleId: qoderInstallation.bundleId,
      workspace: workspace.workspaceCanonical,
    });
    const result = makeResult({
      migrationId,
      status: "COMPLETED",
      sourceThreadId: request.sourceThreadId,
      targetSessionId,
      workspace: workspace.workspaceCanonical,
      artifacts,
      sourceSnapshotSha256,
      seed,
      projectionSha256,
      projection,
      targetProduct: request.targetProduct,
      targetBundleId: qoderInstallation.bundleId,
    });
    await artifacts.writeJson("target-result.json", result);
    await artifacts.appendJournal("COMPLETED", {
      targetSessionId,
      workspace: workspace.workspaceCanonical,
    });
    return result;
  } catch (error) {
    const migrationError = asMigrationError(error);
    await artifacts.appendJournal("FAILED", {
      code: migrationError.code,
      message: migrationError.message,
    });
    throw migrationError;
  } finally {
    await codex.close();
  }
}

async function runDshTarget(input: {
  request: MigrationRequest;
  migrationId: string;
  artifacts: MigrationArtifacts;
  codex: CodexAppServerClient;
  metadataPath: string;
  sourceFingerprint: FileFingerprint;
  sourceSnapshotSha256: string;
  workspace: string;
  threadName: string | null;
  threadPreview: string;
  threadCreatedAt: number;
  seed: ReturnType<typeof buildSeedContext>;
  projection: ReturnType<typeof projectConversationToQoder>;
  projectionSha256: string;
}): Promise<MigrationResult> {
  let installation = await inspectDsh();
  if (!installation.compatible) {
    throw new MigrationError(
      "DSH_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "DeepSeek Harness is unsupported",
      { version: installation.version, fingerprints: installation.fingerprints },
    );
  }
  const dshSeed = buildDshSessionSeed(input.projection, {
    sourceIdentitySha256: input.sourceFingerprint.sha256,
    baseTime: sourceEpochMilliseconds(input.threadCreatedAt),
  });
  await input.artifacts.writeJson("dsh-session-seed.json", dshSeed);
  const key = dshMigrationKey({
    sourceThreadId: input.request.sourceThreadId,
    sourceFileSha256: input.sourceFingerprint.sha256,
    workspace: input.workspace,
    dshVersion: installation.version,
  });
  const targetSessionId = dshTargetSessionId(key);
  await input.artifacts.writeJson("target-plan.json", {
    targetProduct: "deepseek-harness",
    targetRuntimeId: installation.runtimeId,
    targetVersion: installation.version,
    targetFingerprints: installation.fingerprints,
    sourceWorkspace: input.workspace,
    targetWorkspace: input.workspace,
    targetSessionId,
    operation: "dsh-native-session-event-v0-seed",
    protocolVersion: dshSeed.protocolVersion,
    agentPreset: "standard",
    bridgeVersion: DSH_BRIDGE_VERSION,
    backendMethods: [
      "ctx.agents.create",
      "ctx.sessions.flush",
      "ctx.workspaceRegistry.create",
      "workspace.attachSession",
      "ctx.sessionPersistence.inspect",
    ],
    modelMethodsForbidden: ["agent.followup", "agent.steer", "session.prompt"],
    modelInvoked: false,
    mcpChanged: false,
  });

  if (input.request.dryRun) {
    const result = makeResult({
      migrationId: input.migrationId,
      status: "DRY_RUN",
      sourceThreadId: input.request.sourceThreadId,
      targetSessionId: null,
      workspace: input.workspace,
      artifacts: input.artifacts,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      seed: input.seed,
      projectionSha256: input.projectionSha256,
      projection: input.projection,
      targetProduct: "deepseek-harness",
      targetBundleId: "@deepseek-ai/dsh",
    });
    await input.artifacts.writeJson("target-result.json", result);
    await input.artifacts.appendJournal("DRY_RUN_COMPLETED", {
      targetSessionIdPlanned: targetSessionId,
      dshVersion: installation.version,
      bridgeInstalled: installation.bridgeInstalled,
      protocolVersion: dshSeed.protocolVersion,
    });
    return result;
  }

  const bridge = await ensureDshBridge(installation);
  installation = await discoverDsh();
  await input.artifacts.appendJournal("DSH_BRIDGE_READY", bridge);
  const runtime = await ensureDshRuntime(
    installation,
    input.workspace,
    input.artifacts.directory,
  );
  await input.artifacts.appendJournal("DSH_RUNTIME_READY", runtime);
  const mcpBefore = await computeMcpFingerprint(
    input.codex,
    input.workspace,
    "deepseek-harness",
  );
  await input.artifacts.appendJournal("MCP_BASELINE_CAPTURED", mcpBefore);

  const created = await invokeDshBridge<DshBridgeInspection>(
    installation,
    {
      operation: "create",
      sessionId: targetSessionId,
      migrationKey: key,
      workspace: input.workspace,
      agentPreset: "standard",
      title: targetSessionTitle(input.threadName, input.threadPreview),
      seed: dshSeed.events,
    },
    input.artifacts.directory,
  );
  await input.artifacts.appendJournal(
    created.reused ? "TARGET_REUSED" : "TARGET_SESSION_CREATED",
    {
      targetSessionId,
      workspaceId: created.workspace.workspaceId,
      targetWorkspace: created.workspace.path,
      seedLength: created.header.seedLength,
      modelInvoked: false,
    },
  );
  const readback = await invokeDshBridge<DshBridgeInspection>(
    installation,
    {
      operation: "inspect",
      sessionId: targetSessionId,
      workspace: input.workspace,
      agentPreset: "standard",
      expectedSeed: dshSeed.events,
    },
    input.artifacts.directory,
  );
  readback.reused = created.reused === true;
  await input.artifacts.writeJson("dsh-native-readback.json", readback);
  const verification = verifyDshInspection(readback, {
    sessionId: targetSessionId,
    workspace: input.workspace,
    agentPreset: "standard",
    seed: dshSeed,
    projection: input.projection,
  });
  await input.artifacts.appendJournal("TARGET_VERIFIED", verification);
  await assertPostConditions(
    input.codex,
    input.metadataPath,
    input.sourceFingerprint,
    input.workspace,
    mcpBefore,
    "deepseek-harness",
  );
  await openDshWeb();
  await input.artifacts.appendJournal("DSH_OPENED", {
    targetSessionId,
    workspace: input.workspace,
    url: "http://127.0.0.1:3080",
  });
  const result = makeResult({
    migrationId: input.migrationId,
    status: "COMPLETED",
    sourceThreadId: input.request.sourceThreadId,
    targetSessionId,
    workspace: input.workspace,
    artifacts: input.artifacts,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    seed: input.seed,
    projectionSha256: input.projectionSha256,
    projection: input.projection,
    targetProduct: "deepseek-harness",
    targetBundleId: "@deepseek-ai/dsh",
  });
  await input.artifacts.writeJson("target-result.json", result);
  await input.artifacts.appendJournal("COMPLETED", {
    targetSessionId,
    workspace: input.workspace,
    reused: verification.reused,
  });
  return result;
}

function sourceEpochMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value);
}

async function runCursorTarget(input: {
  request: MigrationRequest;
  migrationId: string;
  artifacts: MigrationArtifacts;
  codex: CodexAppServerClient;
  metadataPath: string;
  sourceFingerprint: FileFingerprint;
  sourceSnapshotSha256: string;
  workspace: string;
  threadName: string | null;
  threadPreview: string;
  seed: ReturnType<typeof buildSeedContext>;
  projection: ReturnType<typeof projectConversationToQoder>;
  projectionSha256: string;
}): Promise<MigrationResult> {
  const installation = await discoverCursor();
  const mcpBefore = await computeMcpFingerprint(
    input.codex,
    input.workspace,
    "cursor",
  );
  const title = targetSessionTitle(input.threadName, input.threadPreview);
  const payload = buildCursorChatExport(input.projection, title, {
    workspace: input.workspace,
  });
  const decoded = decodeCursorVisibleTurns(
    payload.conversationState,
    payload.blobs,
  );
  if (
    stableJson(decoded) !==
    stableJson(input.projection.turns.map((turn) => turn.messages))
  ) {
    throw new MigrationError(
      "CURSOR_PROTOCOL_UNSUPPORTED",
      "Generated Cursor Chat v1 payload failed its local round-trip check",
    );
  }
  const rootHistory = inspectCursorRootPromptHistory(
    payload.conversationState,
    payload.blobs,
  );
  if (
    rootHistory.systemPromptRootCount !== 1 ||
    !rootHistory.systemPromptRootFirst ||
    stableJson(rootHistory.historyMessages) !==
      stableJson(input.projection.turns.flatMap((turn) => turn.messages))
  ) {
    throw new MigrationError(
      "CURSOR_PROTOCOL_UNSUPPORTED",
      "Generated Cursor root prompt history failed its local structure check",
      rootHistory,
    );
  }
  const importPath = await input.artifacts.writeJson(
    "cursor-import/session.json",
    payload,
  );
  await input.artifacts.writeJson("target-plan.json", {
    targetProduct: "cursor",
    targetBundleId: installation.bundleId,
    targetVersion: installation.version,
    targetWorkbenchSha256: installation.workbenchSha256,
    targetSessionId: null,
    sourceWorkspace: input.workspace,
    targetWorkspace: input.workspace,
    operation: "cursor-native-chat-json-v1-blob-roots-v3-import",
    protocolVersion: CURSOR_PROTOCOL_VERSION,
    backendMethods: ["developer.bulkImportChats", "composer.openComposer"],
    bridgeVersion: CURSOR_BRIDGE_VERSION,
    importPath,
    modelMethodsForbidden: ["composer.startComposerPrompt", "composer.sendToAgent"],
    cursorAgentCliUsed: false,
    modelInvoked: false,
    mcpFingerprintBefore: mcpBefore,
  });

  if (input.request.dryRun) {
    const result = makeResult({
      migrationId: input.migrationId,
      status: "DRY_RUN",
      sourceThreadId: input.request.sourceThreadId,
      targetSessionId: null,
      workspace: input.workspace,
      artifacts: input.artifacts,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      seed: input.seed,
      projectionSha256: input.projectionSha256,
      projection: input.projection,
      targetProduct: "cursor",
      targetBundleId: installation.bundleId,
    });
    await input.artifacts.writeJson("target-result.json", result);
    await input.artifacts.appendJournal("DRY_RUN_COMPLETED", {
      targetSessionIdPlanned: null,
      protocol: CURSOR_PROTOCOL_VERSION,
    });
    return result;
  }

  try {
    const bridge = await ensureCursorBridge(installation);
    await input.artifacts.appendJournal("CURSOR_BRIDGE_READY", bridge);
    openCursorWorkspace(installation, input.workspace);
    await input.artifacts.appendJournal("CURSOR_OPEN_REQUESTED", {
      bundleId: installation.bundleId,
      workspace: input.workspace,
    });
    const workspaceId = await waitForCursorWorkspaceId(
      installation,
      input.workspace,
    );
    let probe: {
      bridgeVersion: string;
      importCommand: boolean;
      openCommand: boolean;
    };
    try {
      probe = await invokeCursorBridge(
        installation,
        input.workspace,
        { operation: "probe" },
        input.artifacts.directory,
        { timeoutMs: bridge.installedNow ? 15_000 : 45_000 },
      );
    } catch (error) {
      const migrationError = asMigrationError(error);
      if (
        bridge.installedNow &&
        migrationError.code === "CURSOR_BRIDGE_UNAVAILABLE"
      ) {
        throw new MigrationError(
          "CURSOR_BRIDGE_RELOAD_REQUIRED",
          "Cursor bridge was installed. Reload or restart Cursor once, then retry the migration.",
          { extensionId: bridge.extensionId, version: bridge.version },
        );
      }
      throw migrationError;
    }
    if (
      probe.bridgeVersion !== CURSOR_BRIDGE_VERSION ||
      !probe.importCommand ||
      !probe.openCommand
    ) {
      throw new MigrationError(
        "CURSOR_PROTOCOL_UNSUPPORTED",
        "Cursor bridge could not invoke the required native commands",
      );
    }
    await input.artifacts.appendJournal("CURSOR_PROTOCOL_VERIFIED", {
      workspaceId,
      bridgeVersion: probe.bridgeVersion,
      importCommand: "developer.bulkImportChats",
      openCommand: "composer.openComposer",
    });

    const key = cursorMigrationKey({
      sourceThreadId: input.request.sourceThreadId,
      sourceFileSha256: input.sourceFingerprint.sha256,
      workspace: input.workspace,
      cursorVersion: installation.version,
    });
    const existing = await readCursorMigrationMapping(key);
    if (existing !== null) {
      const composer = await readCursorComposer(
        installation,
        workspaceId,
        existing.targetSessionId,
      );
      if (composer !== null) {
        const settled = await waitForCursorComposerVerification(
          installation,
          input.workspace,
          workspaceId,
          composer.composerId,
          input.projection,
        );
        await invokeCursorBridge(
          installation,
          input.workspace,
          { operation: "open", composerId: composer.composerId },
          input.artifacts.directory,
        );
        await assertPostConditions(
          input.codex,
          input.metadataPath,
          input.sourceFingerprint,
          input.workspace,
          mcpBefore,
          "cursor",
        );
        await input.artifacts.appendJournal(
          "TARGET_REUSED",
          settled.verification,
        );
        return completeCursorResult(input, installation.bundleId, composer.composerId);
      }
    }

    const beforeIds = new Set(
      await listCursorComposerIds(installation, workspaceId),
    );
    let targetSessionId: string | null = null;
    try {
      const imported = await invokeCursorBridge<{ imported: number; failed: number }>(
        installation,
        input.workspace,
        {
          operation: "import",
          importDirectory: join(input.artifacts.directory, "cursor-import"),
        },
        input.artifacts.directory,
      );
      await input.artifacts.appendJournal("CURSOR_NATIVE_IMPORT_COMPLETED", imported);
      const composer = await waitForNewCursorComposer(
        installation,
        workspaceId,
        beforeIds,
      );
      targetSessionId = composer.composerId;
      await input.artifacts.appendJournal("TARGET_SESSION_CREATED", {
        targetSessionId,
        workspaceId,
        targetWorkspace: input.workspace,
        backendMethod: "developer.bulkImportChats",
        modelInvoked: false,
      });
      const settled = await waitForCursorComposerVerification(
        installation,
        input.workspace,
        workspaceId,
        composer.composerId,
        input.projection,
      );
      await input.artifacts.appendJournal(
        "TARGET_VERIFIED",
        settled.verification,
      );
      await assertPostConditions(
        input.codex,
        input.metadataPath,
        input.sourceFingerprint,
        input.workspace,
        mcpBefore,
        "cursor",
      );
      await writeCursorMigrationMapping({
        schemaVersion: "ide-hub-cursor-mapping-v2",
        key,
        sourceThreadId: input.request.sourceThreadId,
        sourceFileSha256: input.sourceFingerprint.sha256,
        workspace: input.workspace,
        cursorVersion: installation.version,
        bridgeVersion: CURSOR_BRIDGE_VERSION,
        protocolVersion: CURSOR_PROTOCOL_VERSION,
        targetSessionId,
        createdAt: new Date().toISOString(),
      });
      await invokeCursorBridge(
        installation,
        input.workspace,
        { operation: "open", composerId: targetSessionId },
        input.artifacts.directory,
      );
      await input.artifacts.appendJournal("CURSOR_OPENED", {
        targetSessionId,
        workspace: input.workspace,
      });
    } catch (error) {
      const migrationError = asMigrationError(error);
      if (targetSessionId !== null) {
        await input.artifacts.appendJournal("CLEANUP_REQUIRED", {
          code: migrationError.code,
          message: migrationError.message,
          targetSessionId,
          cleanupSucceeded: false,
          reason: "Cursor 3.18.9 exposes no exact public delete-by-id command",
        });
      }
      throw migrationError;
    }

    if (targetSessionId === null) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        "Cursor native importer did not create a target session",
      );
    }
    return completeCursorResult(input, installation.bundleId, targetSessionId);
  } finally {
    await removeCursorBridgeRequestFiles(input.artifacts.directory);
  }
}

async function completeCursorResult(
  input: {
    migrationId: string;
    request: MigrationRequest;
    artifacts: MigrationArtifacts;
    sourceSnapshotSha256: string;
    workspace: string;
    seed: ReturnType<typeof buildSeedContext>;
    projectionSha256: string;
    projection: ReturnType<typeof projectConversationToQoder>;
  },
  bundleId: MigrationResult["continuation"]["bundleId"],
  targetSessionId: string,
): Promise<MigrationResult> {
  const result = makeResult({
    migrationId: input.migrationId,
    status: "COMPLETED",
    sourceThreadId: input.request.sourceThreadId,
    targetSessionId,
    workspace: input.workspace,
    artifacts: input.artifacts,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    seed: input.seed,
    projectionSha256: input.projectionSha256,
    projection: input.projection,
    targetProduct: "cursor",
    targetBundleId: bundleId,
  });
  await input.artifacts.writeJson("target-result.json", result);
  await input.artifacts.appendJournal("COMPLETED", {
    targetSessionId,
    workspace: input.workspace,
  });
  return result;
}

function targetSessionTitle(name: string | null, preview: string): string {
  const candidate = name?.trim() || preview.trim() || "Imported Codex session";
  return `Codex · ${candidate}`.replace(/\s+/g, " ").slice(0, 100);
}

async function assertPostConditions(
  codex: CodexAppServerClient,
  sourcePath: string,
  sourceBaseline: FileFingerprint,
  workspace: string,
  mcpBaseline: Awaited<ReturnType<typeof computeMcpFingerprint>>,
  targetProduct: MigrationRequest["targetProduct"],
): Promise<{ sourceAfter: FileFingerprint; mcpAfter: Awaited<ReturnType<typeof computeMcpFingerprint>> }> {
  const sourceAfter = await fingerprintFile(sourcePath);
  assertFingerprintUnchanged(sourceBaseline, sourceAfter, "target migration");
  const mcpAfter = await computeMcpFingerprint(codex, workspace, targetProduct);
  if (mcpAfter.sha256 !== mcpBaseline.sha256) {
    throw new MigrationError(
      "MCP_CHANGED_DURING_SESSION_MIGRATION",
      `Effective Codex/${targetProduct} MCP configuration changed during session migration`,
      { before: mcpBaseline, after: mcpAfter },
    );
  }
  return { sourceAfter, mcpAfter };
}

function assertFingerprintUnchanged(
  before: FileFingerprint,
  after: FileFingerprint,
  stage: string,
): void {
  if (
    before.sha256 !== after.sha256 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new MigrationError(
      "SOURCE_CHANGED_DURING_SNAPSHOT",
      `Codex source rollout changed during ${stage}`,
      { before, after },
    );
  }
}

function makeResult(input: {
  migrationId: string;
  status: MigrationResult["status"];
  sourceThreadId: string;
  targetSessionId: string | null;
  workspace: string;
  artifacts: MigrationArtifacts;
  sourceSnapshotSha256: string;
  seed: ReturnType<typeof buildSeedContext>;
  projectionSha256: string;
  projection: { turns: unknown[]; projectedMessageCount: number };
  targetProduct: MigrationResult["continuation"]["product"];
  targetBundleId: MigrationResult["continuation"]["bundleId"];
}): MigrationResult {
  return {
    migrationId: input.migrationId,
    status: input.status,
    sourceThreadId: input.sourceThreadId,
    targetSessionId: input.targetSessionId,
    workspace: input.workspace,
    modelInvoked: false,
    mcpChanged: false,
    continuation: {
      product: input.targetProduct,
      bundleId: input.targetBundleId,
    },
    details: {
      artifactsDir: input.artifacts.directory,
      sourceSnapshotSha256: input.sourceSnapshotSha256,
      seedContextSha256: input.seed.sha256,
      seedContextBytes: input.seed.bytes,
      projectionSha256: input.projectionSha256,
      projectedTurnCount: input.projection.turns.length,
      projectedMessageCount: input.projection.projectedMessageCount,
      lossReport: input.seed.lossReport,
    },
  };
}
