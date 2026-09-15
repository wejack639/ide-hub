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
      : targetProduct === "codebuddy-international" || targetProduct === "codebuddy-cn"
        ? await readCodeBuddyConfigurationFingerprints(workspace, targetProduct)
      : targetProduct === "zcode"
        ? await readEffectiveZcodeMcp(workspace)
      : await readEffectiveQoderMcp(workspace, targetProduct);
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

/** CodeBuddy 会话迁移只记录 MCP 相关文件/设置片段的 hash，不把配置正文写入产物。 */
export async function readCodeBuddyConfigurationFingerprints(
  workspace: string,
  targetProduct: "codebuddy-international" | "codebuddy-cn",
): Promise<Record<string, string | null>> {
  const userDataDirectory = targetProduct === "codebuddy-international" ? "CodeBuddy" : "CodeBuddy CN";
  const candidates = [
    // CodeBuddy 4.12.0 and CodeBuddy CN 4.12.0 use the same native
    // user-scope MCP store even though their app data/log roots are separate.
    join(homedir(), ".codebuddy", "mcp.json"),
    join(homedir(), "Library", "Application Support", userDataDirectory, "User", "mcp.json"),
    join(workspace, ".mcp.json"),
    join(workspace, "mcp.json"),
  ];
  const files: Record<string, string | null> = {};
  for (const path of candidates) {
    const content = await readTextIfExists(path);
    files[path] = content === null ? null : sha256Text(content);
  }
  const settingsPath = join(
    homedir(),
    "Library",
    "Application Support",
    userDataDirectory,
    "User",
    "settings.json",
  );
  const settings = await readTextIfExists(settingsPath);
  if (settings === null) {
    files[`${settingsPath}#mcp`] = null;
  } else {
    try {
      const parsed = JSON5.parse(settings) as Record<string, unknown>;
      const mcpEntries = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key.toLocaleLowerCase().includes("mcp")),
      );
      files[`${settingsPath}#mcp`] = sha256Text(stableJson(mcpEntries));
    } catch {
      files[`${settingsPath}#mcp`] = sha256Text(settings);
    }
  }
  return files;
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

async function readEffectiveQoderMcp(
  workspace: string,
  targetProduct: "qoder-international" | "qoder-cn",
): Promise<Record<string, unknown>> {
  const dataFolder = targetProduct === "qoder-cn" ? ".qoder-cn" : ".qoder";
  const userRoot = join(homedir(), dataFolder);
  const candidates = [
    join(userRoot, "mcp.json"),
    join(workspace, dataFolder, "mcp.json"),
    join(workspace, ".mcp.json"),
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
