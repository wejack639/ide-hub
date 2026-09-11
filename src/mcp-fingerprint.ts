import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import type { AppServerRequester } from "./codex/app-server-client.js";
import type { McpFingerprint, MigrationTargetProduct } from "./types.js";
import { readTextIfExists, sha256Text } from "./util/fs.js";
import { stableJson } from "./util/stable-json.js";
import { piAbsolutePath } from "./pi/discovery.js";
import { claudeConfigDirectory } from "./claude/discovery.js";

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
    targetProduct === "claude-code"
      ? await readClaudeConfigurationFingerprints(workspace)
      : targetProduct === "pi"
      ? await readPiConfigurationFingerprints(workspace)
      : targetProduct === "cursor"
      ? await readEffectiveCursorMcp(workspace)
      : targetProduct === "deepseek-harness"
        ? await readEffectiveDshMcp()
      : targetProduct === "zcode"
        ? await readEffectiveZcodeMcp(workspace)
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

/** Claude 只核对配置指纹；不读取或复制认证正文到迁移产物。 */
export async function readClaudeConfigurationFingerprints(workspace: string): Promise<Record<string, string | null>> {
  const configDir = claudeConfigDirectory();
  const candidates = [join(homedir(), ".claude.json"), join(configDir, ".claude.json"),
    join(configDir, "settings.json"), join(configDir, "settings.local.json"),
    join(workspace, ".mcp.json"), join(workspace, ".claude/settings.json"), join(workspace, ".claude/settings.local.json")];
  const files: Record<string, string | null> = {};
  for (const path of new Set(candidates)) {
    const content = await readTextIfExists(path);
    files[path] = content === null ? null : sha256Text(content);
  }
  return files;
}

/** Pi 核心不引入 MCP；只校验已有配置及凭据内容指纹，不输出/迁移配置正文。 */
export async function readPiConfigurationFingerprints(workspace: string): Promise<Record<string, string | null>> {
  const agentDir = piAbsolutePath(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
  const codexRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const candidates = [join(codexRoot, "auth.json"), join(codexRoot, "config.toml"),
    ...["settings.json", "models.json", "auth.json", "mcp.json"].map(file => join(agentDir, file)),
    join(workspace, ".pi/settings.json"), join(workspace, ".pi/mcp.json"), join(workspace, ".mcp.json")];
  const files: Record<string, string | null> = {};
  for (const path of candidates) {
    const content = await readTextIfExists(path);
    files[path] = content === null ? null : sha256Text(content);
  }
  return files;
}

async function readEffectiveDshMcp(): Promise<Record<string, unknown>> {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const candidates = [
    join(dshHome, "settings.yaml"),
    join(dshHome, "profiles", "web", "cordis.patch.yml"),
    join(dshHome, "profiles", "web", "package.json"),
  ];
  const files: Record<string, string> = {};
  for (const path of candidates) {
    const content = await readTextIfExists(path);
    if (content !== null) files[path] = sha256Text(content);
  }
  return files;
}

async function readEffectiveZcodeMcp(workspace: string): Promise<Record<string, string>> {
  const candidates = [join(homedir(), ".zcode/cli/config.json"), join(homedir(), ".zcode/v2/config.json"), join(homedir(), ".zcode/v2/mcp.json")];
  for (let path = workspace; ; path = dirname(path)) {
    candidates.push(join(path, "zcode.json"), join(path, ".zcode/config.json"));
    if (dirname(path) === path) break;
  }
  const files: Record<string, string> = {};
  for (const path of new Set(candidates)) {
    const content = await readTextIfExists(path);
    if (content !== null) files[path] = sha256Text(content);
  }
  return files;
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
