import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import type { AppServerRequester } from "./codex/app-server-client.js";
import type { McpFingerprint, MigrationTargetProduct } from "./types.js";
import { readTextIfExists, sha256Text } from "./util/fs.js";
import { stableJson } from "./util/stable-json.js";

type ConfigReadResponse = { config: Record<string, unknown> };

export async function computeMcpFingerprint(
  codex: AppServerRequester,
  workspace: string,
  targetProduct: MigrationTargetProduct = "qoder-international",
): Promise<McpFingerprint> {
  const codexConfig = await codex.request<ConfigReadResponse>("config/read", {
    cwd: workspace,
    includeLayers: false,
  });
  const codexMcp =
    codexConfig.config.mcp_servers ?? codexConfig.config.mcpServers ?? {};
  const targetMcp =
    targetProduct === "cursor"
      ? await readEffectiveCursorMcp(workspace)
      : await readEffectiveQoderMcp(workspace);
  const codexSha256 = sha256Text(stableJson(codexMcp));
  const targetSha256 = sha256Text(stableJson(targetMcp));
  return {
    codexSha256,
    targetSha256,
    targetProduct,
    sha256: sha256Text(
      stableJson({ codexSha256, targetProduct, targetSha256 }),
    ),
  };
}

async function readEffectiveQoderMcp(workspace: string): Promise<Record<string, unknown>> {
  const userRoot = join(homedir(), ".qoder");
  const candidates = [
    join(userRoot, "mcp.json"),
    join(userRoot, "settings.json"),
    join(workspace, ".qoder", "settings.json"),
    join(workspace, ".mcp.json"),
    join(workspace, ".qoder", "settings.local.json"),
  ];
  const merged: Record<string, unknown> = {};
  for (const path of candidates) {
    const content = await readTextIfExists(path);
    if (content === null) continue;
    const parsed = JSON5.parse(content) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (servers === undefined) continue;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) continue;
    Object.assign(merged, servers as Record<string, unknown>);
  }
  return merged;
}

async function readEffectiveCursorMcp(
  workspace: string,
): Promise<Record<string, unknown>> {
  const candidates = [
    join(homedir(), ".cursor", "mcp.json"),
    join(workspace, ".cursor", "mcp.json"),
  ];
  const merged: Record<string, unknown> = {};
  for (const path of candidates) {
    const content = await readTextIfExists(path);
    if (content === null) continue;
    const parsed = JSON5.parse(content) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (servers === undefined) continue;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      continue;
    }
    Object.assign(merged, servers as Record<string, unknown>);
  }
  return merged;
}
