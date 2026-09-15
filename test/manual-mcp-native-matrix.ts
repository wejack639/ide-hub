import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMcpMigration,
  planMcpMigration,
  rollbackMcpMigration,
} from "../src/mcp/migration.js";
import { MCP_TARGET_PRODUCTS } from "../src/mcp/types.js";
import type {
  McpMigrationReceipt,
  McpSourceSnapshot,
  McpTargetProduct,
} from "../src/mcp/types.js";
import { sha256Text } from "../src/util/fs.js";

if (process.env.IDE_HUB_ALLOW_NATIVE_MCP_MATRIX !== "1") {
  throw new Error("Set IDE_HUB_ALLOW_NATIVE_MCP_MATRIX=1 to run the temporary native target mutation gate");
}

const supportedTargets = MCP_TARGET_PRODUCTS.filter((target) => target !== "pi");
const requestedTargets = process.argv.slice(2);
const targets = (requestedTargets.length > 0 ? requestedTargets : supportedTargets) as McpTargetProduct[];
const supportedTargetNames = new Set<string>(supportedTargets);
if (targets.some((target) => !supportedTargetNames.has(target))) {
  throw new Error(`Targets must be one of: ${supportedTargets.join(", ")}`);
}

const workspace = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const fixture = fileURLToPath(new URL("./fixtures/native-mcp-probe.cjs", import.meta.url));
const dataRoot = await mkdtemp(join(tmpdir(), "ide-hub-native-mcp-matrix-"));
let hasUnresolvedRollback = false;
let hasGateFailure = false;

try {
  for (const targetProduct of targets) {
    // CodeBuddy editions share one user config and both watch it. A fresh name
    // per target prevents the first edition's load/delete cycle from causing
    // the second edition to de-duplicate a same-name probe.
    const probeName = `ide-hub-native-probe-${randomUUID().slice(0, 8)}`;
    const probeId = sha256Text(`user:${probeName}`);
    const server = {
      id: probeId,
      name: probeName,
      scope: "user" as const,
      sourcePath: join(workspace, "test", "fixtures", "codex-native-probe.toml"),
      overrides: [],
      transport: "stdio" as const,
      command: process.execPath,
      args: [fixture],
      cwd: workspace,
      env: {},
      envVars: [],
      url: null,
      headers: {},
      envHeaders: {},
      bearerTokenEnvVar: null,
      enabled: true,
      startupTimeoutSec: null,
      toolTimeoutSec: null,
      unmappedFields: [],
    };
    const source: McpSourceSnapshot = {
      schemaVersion: "ide-hub-mcp-source-v1",
      sourceProduct: "codex",
      sourceKind: "codex-effective",
      sourcePath: server.sourcePath,
      sourceFingerprint: sha256Text(JSON.stringify(server)),
      capturedAt: new Date().toISOString(),
      scope: "user",
      workspace: null,
      servers: [server],
    };
    let receipt: McpMigrationReceipt | null = null;
    try {
      const plan = await planMcpMigration({
        sourceProduct: "codex",
        targetProduct,
        selectedServerIds: [probeId],
        scope: "user",
        targetScope: "user",
        resolutions: {},
      }, { dataRoot }, source);
      receipt = await applyMcpMigration(plan, { dataRoot }, source);
      const verification = receipt.verification[0];
      process.stdout.write(`${JSON.stringify({
        mcpMigrationId: receipt.mcpMigrationId,
        targetProduct,
        targetConfig: abbreviateHome(receipt.targetConfigPath),
        status: receipt.status,
        nativeRecognition: verification?.nativeRecognition,
        nativeDetail: verification?.nativeDetail,
        handshake: verification?.handshake,
        changed: receipt.changed,
      })}\n`);
      if (
        receipt.status !== "COMPLETED" ||
        verification?.nativeRecognition !== "passed" ||
        verification.handshake !== "passed"
      ) {
        hasGateFailure = true;
      }
    } catch (error) {
      hasGateFailure = true;
      process.stdout.write(`${JSON.stringify({
        targetProduct,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    } finally {
      if (receipt?.changed) {
        try {
          const rollback = await rollbackMcpMigration(receipt.mcpMigrationId, { dataRoot });
          process.stdout.write(`${JSON.stringify({
            targetProduct,
            rollback: rollback.status,
            rollbackMode: rollback.rollbackMode,
          })}\n`);
          if (rollback.status !== "ROLLED_BACK") hasGateFailure = true;
        } catch (error) {
          hasUnresolvedRollback = true;
          hasGateFailure = true;
          process.stdout.write(`${JSON.stringify({
            targetProduct,
            rollback: "FAILED",
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      }
    }
  }
} finally {
  if (hasUnresolvedRollback) {
    process.stdout.write(`${JSON.stringify({ retainedEvidenceRoot: dataRoot })}\n`);
  } else {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

if (hasGateFailure) process.exitCode = 1;

function abbreviateHome(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : basename(path);
}
