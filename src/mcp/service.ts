import { homedir } from "node:os";
import { exportMcpBundle, importMcpBundle } from "./bundle.js";
import { readCodexMcpSnapshot, summarizeMcpSnapshot } from "./codex.js";
import { discoverMcpTargets } from "./targets.js";
import type {
  McpRuntimeOptions,
  McpScanResult,
  McpScope,
  McpSourceSnapshot,
  McpTargetScope,
} from "./types.js";

export async function scanMcpConfiguration(
  input: { scope?: McpScope; targetScope?: McpTargetScope; workspace?: string; sourceBundlePath?: string } = {},
  options: McpRuntimeOptions = {},
): Promise<McpScanResult> {
  const scope = input.scope ?? "user";
  const source = input.sourceBundlePath
    ? await readImportedMcpSource(input.sourceBundlePath, input.workspace)
    : await readCodexMcpSnapshot({
      scope,
      ...(scope === "project" && input.workspace ? { workspace: input.workspace } : {}),
      homeDir: options.homeDir ?? homedir(),
      ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
    });
  const targetScope = input.targetScope ?? source.scope;
  const workspace = input.workspace ?? source.workspace;
  const targets = await discoverMcpTargets(
    targetScope,
    workspace,
    options,
  );
  return {
    sourceProduct: "codex",
    sourceKind: source.sourceKind,
    sourcePath: source.sourcePath,
    sourceFingerprint: source.sourceFingerprint,
    scope: source.scope,
    targetScope,
    sourceWorkspace: source.workspace,
    workspace,
    scannedAt: new Date().toISOString(),
    servers: summarizeMcpSnapshot(source),
    targets,
  };
}

export async function readMcpSource(
  input: { scope?: McpScope; workspace?: string; sourceBundlePath?: string },
  options: McpRuntimeOptions = {},
): Promise<McpSourceSnapshot> {
  if (input.sourceBundlePath) return readImportedMcpSource(input.sourceBundlePath, input.workspace);
  return readCodexMcpSnapshot({
    scope: input.scope ?? "user",
    ...(input.scope === "project" && input.workspace ? { workspace: input.workspace } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
  });
}

export async function exportSelectedMcpBundle(
  input: { selectedServerIds: string[]; outputPath: string; scope?: McpScope; workspace?: string; sourceBundlePath?: string },
  options: McpRuntimeOptions = {},
): Promise<{ bundleId: string; outputPath: string; serverCount: number; sha256: string }> {
  const source = await readMcpSource(input, options);
  return exportMcpBundle(source, input.selectedServerIds, input.outputPath);
}

async function readImportedMcpSource(path: string, workspace?: string): Promise<McpSourceSnapshot> {
  const source = await importMcpBundle(path);
  if (source.scope === "project" && workspace && workspace !== source.workspace) {
    return importMcpBundle(path, workspace);
  }
  return source;
}
