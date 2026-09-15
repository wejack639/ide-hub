import { constants, existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { parse } from "jsonc-parser";
import type {
  McpRuntimeOptions,
  McpServer,
  McpTargetAvailability,
  McpTargetProduct,
  McpTargetScope,
} from "./types.js";
import { MCP_TARGET_PRODUCTS } from "./types.js";

export type McpTargetProfile = {
  targetProduct: McpTargetProduct;
  displayName: string;
  targetScope: McpTargetScope;
  configPath: string | null;
  format: "jsonc" | "dsh-yaml" | "unsupported";
  jsonPath: string[];
};

export type RenderedMcpServer = {
  supported: boolean;
  reason: string | null;
  value: Record<string, unknown> | null;
};

const DISPLAY_NAMES: Record<McpTargetProduct, string> = {
  "qoder-international": "Qoder 国际版",
  "qoder-cn": "Qoder CN",
  cursor: "Cursor",
  "deepseek-harness": "DeepSeek Harness",
  zcode: "ZCode",
  pi: "Pi",
  "claude-code": "Claude Code",
  "codebuddy-international": "CodeBuddy 国际版",
  "codebuddy-cn": "CodeBuddy CN",
};

const execFileAsync = promisify(execFile);
const SUPPORTED_DSH_MCP_CLIENT_VERSIONS = new Set(["0.1.0-rc.6"]);

export function resolveMcpTarget(
  targetProduct: McpTargetProduct,
  scope: McpTargetScope,
  workspace: string | null,
  options: McpRuntimeOptions = {},
): McpTargetProfile {
  const home = options.homeDir ?? homedir();
  if (scope !== "user" && (!workspace || !isAbsolute(workspace))) {
    throw new MigrationError("MCP_INVALID_REQUEST", `${scope} target scope requires an absolute workspace path`);
  }
  const overridden = options.targetPathOverrides?.[targetProduct];
  const userPaths: Record<Exclude<McpTargetProduct, "pi">, string> = {
    // The desktop IDE's MCP settings page opens these files directly. The
    // standalone Qoder CLI uses settings.json, but that does not prove the IDE
    // has loaded a migrated server.
    "qoder-international": join(home, ".qoder", "mcp.json"),
    "qoder-cn": join(home, ".qoder-cn", "mcp.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    "deepseek-harness": join(home, ".dsh", "profiles", "web", "cordis.patch.yml"),
    zcode: join(home, ".zcode", "cli", "config.json"),
    "claude-code": join(home, ".claude.json"),
    // CodeBuddy 4.12.0 and CodeBuddy CN 4.12.0 both report this exact
    // user-scope path from their native MCP extension. Product identity is
    // separate, but the user MCP store is shared by the two editions.
    "codebuddy-international": join(home, ".codebuddy", "mcp.json"),
    "codebuddy-cn": join(home, ".codebuddy", "mcp.json"),
  };
  if (targetProduct === "pi") {
    return {
      targetProduct,
      displayName: DISPLAY_NAMES[targetProduct],
      targetScope: scope,
      configPath: null,
      format: "unsupported",
      jsonPath: [],
    };
  }
  if (scope === "local" && !supportsLocalScope(targetProduct)) {
    return {
      targetProduct,
      displayName: DISPLAY_NAMES[targetProduct],
      targetScope: scope,
      configPath: null,
      format: "unsupported",
      jsonPath: [],
    };
  }
  const projectPaths = workspace === null ? null : {
    "qoder-international": join(workspace, ".mcp.json"),
    "qoder-cn": join(workspace, ".mcp.json"),
    cursor: join(workspace, ".cursor", "mcp.json"),
    "deepseek-harness": join(workspace, ".dsh", "cordis.patch.yml"),
    zcode: resolveZcodeProjectPath(workspace),
    "claude-code": join(workspace, ".mcp.json"),
    "codebuddy-international": resolveFirstExisting([
      join(workspace, ".mcp.json"),
      join(workspace, "mcp.json"),
    ]),
    "codebuddy-cn": resolveFirstExisting([
      join(workspace, ".mcp.json"),
      join(workspace, "mcp.json"),
    ]),
  } satisfies Record<Exclude<McpTargetProduct, "pi">, string>;
  const localPaths = workspace === null ? null : {
    "claude-code": join(home, ".claude.json"),
  } satisfies Record<"claude-code", string>;
  let configPath = overridden ?? (
    scope === "user"
      ? userPaths[targetProduct]
      : scope === "project"
        ? projectPaths![targetProduct]
        : localPaths![targetProduct as keyof typeof localPaths]
  );
  let jsonPath = targetProduct === "zcode" ? ["mcp", "servers"] : ["mcpServers"];
  if (!overridden && targetProduct === "zcode") {
    const fallbackPath = scope === "user"
      ? join(home, ".agents", "mcp.json")
      : join(workspace!, ".agents", "mcp.json");
    if (!hasZcodeServers(configPath) && existsSync(fallbackPath)) {
      configPath = fallbackPath;
      jsonPath = ["mcpServers"];
    }
  }
  if (scope === "local" && targetProduct === "claude-code") {
    jsonPath = ["projects", workspace!, "mcpServers"];
  }
  if (targetProduct === "deepseek-harness") {
    return {
      targetProduct,
      displayName: DISPLAY_NAMES[targetProduct],
      targetScope: scope,
      configPath,
      format: "dsh-yaml",
      jsonPath: [],
    };
  }
  return {
    targetProduct,
    displayName: DISPLAY_NAMES[targetProduct],
    targetScope: scope,
    configPath,
    format: "jsonc",
    jsonPath,
  };
}

export async function discoverMcpTargets(
  scope: McpTargetScope,
  workspace: string | null,
  options: McpRuntimeOptions = {},
): Promise<McpTargetAvailability[]> {
  return Promise.all(MCP_TARGET_PRODUCTS.map(async (targetProduct) => {
    const profile = resolveMcpTarget(targetProduct, scope, workspace, options);
    const overridden = options.installedTargetOverrides?.[targetProduct];
    const installed = overridden ?? await detectInstallation(targetProduct, options.homeDir ?? homedir());
    if (targetProduct === "pi") {
      return {
        targetProduct,
        targetScope: scope,
        displayName: profile.displayName,
        installed,
        supported: false,
        reason: installed
          ? "Pi 核心不提供 MCP；未发现已受信任的兼容 adapter"
          : "Pi 未安装，且核心不提供 MCP adapter",
        targetConfigPath: null,
      };
    }
    if (profile.format === "unsupported") {
      return {
        targetProduct,
        targetScope: scope,
        displayName: profile.displayName,
        installed,
        supported: false,
        reason: `${profile.displayName} 没有已验证的 ${scope} MCP scope`,
        targetConfigPath: null,
      };
    }
    if (!installed) {
      return {
        targetProduct,
        targetScope: scope,
        displayName: profile.displayName,
        installed: false,
        supported: false,
        reason: `${profile.displayName} 未安装`,
        targetConfigPath: profile.configPath,
      };
    }
    if (targetProduct === "deepseek-harness") {
      const dshHome = options.homeDir ?? homedir();
      const detectedClient = detectDshClient(dshHome);
      const clientInstalled = options.dshClientInstalled ?? detectedClient.installed;
      const clientVersion = options.dshClientVersion ?? detectedClient.version;
      if (!clientInstalled) {
        return {
          targetProduct,
          targetScope: scope,
          displayName: profile.displayName,
          installed: true,
          supported: false,
          reason: "未安装受信任的 @deepseek-ai/dsh-mcp-client，IDE Hub 不自动安装第三方包",
          targetConfigPath: profile.configPath,
        };
      }
      if (clientVersion && !SUPPORTED_DSH_MCP_CLIENT_VERSIONS.has(clientVersion)) {
        return {
          targetProduct,
          targetScope: scope,
          displayName: profile.displayName,
          installed: true,
          supported: false,
          reason: `@deepseek-ai/dsh-mcp-client ${clientVersion} 未验证，当前仅支持 0.1.0-rc.6`,
          targetConfigPath: profile.configPath,
        };
      }
    }
    return {
      targetProduct,
      targetScope: scope,
      displayName: profile.displayName,
      installed: true,
      supported: true,
      reason: null,
      targetConfigPath: profile.configPath,
    };
  }));
}

function supportsLocalScope(targetProduct: McpTargetProduct): boolean {
  return targetProduct === "claude-code";
}

function detectDshClient(home: string): { installed: boolean; version: string | null } {
  const candidates = [
    join(home, ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-mcp-client", "package.json"),
    join(home, ".dsh", "profiles", "web", "node_modules", "@deepseek-ai", "dsh-mcp-client", "package.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
      if (value.name === "@deepseek-ai/dsh-mcp-client" && typeof value.version === "string") {
        return { installed: true, version: value.version };
      }
    } catch {
      return { installed: true, version: "unknown" };
    }
    return { installed: true, version: "unknown" };
  }
  return { installed: false, version: null };
}

export function renderMcpServer(
  server: McpServer,
  targetProduct: McpTargetProduct,
): RenderedMcpServer {
  if (targetProduct === "pi") {
    return { supported: false, reason: "Pi 核心没有 MCP adapter", value: null };
  }
  if (server.unmappedFields.length > 0) {
    return {
      supported: false,
      reason: `Codex 配置包含目标尚未映射的字段：${server.unmappedFields.join(", ")}`,
      value: null,
    };
  }
  if (!server.enabled && targetProduct === "claude-code") {
    return {
      supported: false,
      reason: "Claude Code 的禁用状态按项目保存在 disabledMcpServers，不能作为 server 字段直接迁移",
      value: null,
    };
  }
  if (
    !server.enabled &&
    (targetProduct === "cursor" ||
      targetProduct === "codebuddy-international" ||
      targetProduct === "codebuddy-cn")
  ) {
    return {
      supported: false,
      reason: `${DISPLAY_NAMES[targetProduct]} 没有已验证的 server 内禁用字段，不能把已禁用 Codex MCP 伪装为启用配置`,
      value: null,
    };
  }
  const value: Record<string, unknown> = {};
  const reference = (name: string) => environmentReference(targetProduct, name);
  if (server.transport === "stdio") {
    value.command = server.command;
    if (server.args.length > 0) value.args = [...server.args];
    if (server.cwd) value.cwd = server.cwd;
    const overlappingEnv = server.envVars.find((name) => name in server.env);
    if (overlappingEnv) {
      return { supported: false, reason: `Codex env 与 ambient env 同时定义 ${overlappingEnv}，无法确定目标优先级`, value: null };
    }
    const ambientEnv = Object.fromEntries(server.envVars.map((name) => [name, reference(name)]));
    if (Object.values(ambientEnv).some((entry) => entry === null)) {
      return { supported: false, reason: `目标没有已验证的 ambient env 引用映射：${server.envVars.join(", ")}`, value: null };
    }
    const env = { ...ambientEnv, ...server.env };
    if (Object.keys(env).length > 0) value.env = env;
  } else {
    value.url = server.url;
    if (
      targetProduct === "qoder-international" ||
      targetProduct === "qoder-cn" ||
      targetProduct === "claude-code" ||
      targetProduct === "codebuddy-international" ||
      targetProduct === "codebuddy-cn"
    ) {
      value.type = "http";
    }
    const dynamicHeaders = Object.fromEntries(
      Object.entries(server.envHeaders).map(([header, name]) => [header, reference(name)]),
    );
    if (Object.values(dynamicHeaders).some((entry) => entry === null)) {
      return { supported: false, reason: `目标没有已验证的动态 header 引用映射：${Object.keys(server.envHeaders).join(", ")}`, value: null };
    }
    const overlappingHeader = Object.keys(dynamicHeaders).find((name) => name in server.headers);
    if (overlappingHeader) {
      return { supported: false, reason: `Codex literal 与动态 header 同时定义 ${overlappingHeader}`, value: null };
    }
    if (server.bearerTokenEnvVar && ("Authorization" in server.headers || "Authorization" in dynamicHeaders)) {
      return { supported: false, reason: "Codex bearer token 与 Authorization header 同时存在，无法安全合并", value: null };
    }
    const bearer = server.bearerTokenEnvVar === null
      ? null
      : reference(server.bearerTokenEnvVar);
    if (server.bearerTokenEnvVar && bearer === null) {
      return { supported: false, reason: "目标没有已验证的 bearer token 环境变量映射", value: null };
    }
    const headers = {
      ...dynamicHeaders,
      ...server.headers,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    };
    if (Object.keys(headers).length > 0) value.headers = headers;
  }
  const timeoutError = applyTimeoutMapping(server, targetProduct, value);
  if (timeoutError) return { supported: false, reason: timeoutError, value: null };
  if (targetProduct === "zcode") {
    value.type = server.transport === "stdio" ? "stdio" : "http";
    if (!server.enabled) value.enable = false;
  } else if (targetProduct === "claude-code") {
    // Claude Code stores per-project disabled state outside the server object.
  } else if (targetProduct === "qoder-international" || targetProduct === "qoder-cn") {
    if (!server.enabled) value.disabled = true;
  }
  return { supported: true, reason: null, value };
}

function environmentReference(targetProduct: McpTargetProduct, name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return null;
  if (targetProduct === "cursor") return `\${env:${name}}`;
  if (
    targetProduct === "zcode" ||
    targetProduct === "claude-code" ||
    targetProduct === "codebuddy-international" ||
    targetProduct === "codebuddy-cn"
  ) {
    return `\${${name}}`;
  }
  return null;
}

function applyTimeoutMapping(
  server: McpServer,
  targetProduct: McpTargetProduct,
  value: Record<string, unknown>,
): string | null {
  const startup = server.startupTimeoutSec;
  const tool = server.toolTimeoutSec;
  if (startup === null && tool === null) return null;
  if (targetProduct === "qoder-international" || targetProduct === "qoder-cn") {
    if (startup !== null && tool !== null && startup !== tool) {
      return "Qoder 只有单一 timeout 字段，无法无损表示不同的启动与工具超时";
    }
    value.timeout = Math.round((tool ?? startup!) * 1_000);
    return null;
  }
  if (targetProduct === "zcode") {
    if (startup !== null) return "ZCode 没有已验证的单 server 启动超时字段";
    value.timeoutMs = Math.round(tool! * 1_000);
    return null;
  }
  return "目标没有已验证的单 server 启动/工具超时映射";
}

function resolveFirstExisting(paths: string[], defaultPath = paths[0]!): string {
  return paths.find((path) => existsSync(path)) ?? defaultPath;
}

function resolveZcodeProjectPath(workspace: string): string {
  return join(workspace, ".zcode", "config.json");
}

function hasZcodeServers(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const root = parse(readFileSync(path, "utf8"), undefined, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as { mcp?: { servers?: unknown } } | undefined;
    return Boolean(
      root?.mcp?.servers &&
      typeof root.mcp.servers === "object" &&
      !Array.isArray(root.mcp.servers) &&
      Object.keys(root.mcp.servers).length > 0,
    );
  } catch {
    // The migration planner will report the malformed higher-priority file.
    return true;
  }
}

async function detectInstallation(targetProduct: McpTargetProduct, home: string): Promise<boolean> {
  const candidates: Record<McpTargetProduct, string[]> = {
    "qoder-international": [join(home, "Applications", "Qoder IDE.app"), "/Applications/Qoder IDE.app", "/Applications/Qoder.app"],
    "qoder-cn": [join(home, "Applications", "Qoder CN IDE.app"), "/Applications/Qoder CN IDE.app"],
    cursor: [join(home, "Applications", "Cursor.app"), "/Applications/Cursor.app"],
    "deepseek-harness": [join(home, ".dsh", "profiles", "web", "package.json"), "/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"],
    zcode: [join(home, "Applications", "ZCode.app"), "/Applications/ZCode.app"],
    pi: [join(home, ".pi", "agent"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"],
    "claude-code": [join(home, ".claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
    "codebuddy-international": [join(home, "Applications", "CodeBuddy.app"), "/Applications/CodeBuddy.app"],
    "codebuddy-cn": [join(home, "Applications", "CodeBuddy CN.app"), "/Applications/CodeBuddy CN.app"],
  };
  const expectedBundleIds: Partial<Record<McpTargetProduct, string>> = {
    "qoder-international": "com.qoder.ide",
    "qoder-cn": "com.aliyun.lingma.ide",
    cursor: "com.todesktop.230313mzl4w4u92",
    zcode: "dev.zcode.app",
    "codebuddy-international": "com.tencent.codebuddy",
    "codebuddy-cn": "com.tencent.codebuddycn",
  };
  for (const candidate of candidates[targetProduct]) {
    try {
      await access(candidate, constants.R_OK);
      const expectedBundleId = expectedBundleIds[targetProduct];
      if (expectedBundleId && candidate.endsWith(".app")) {
        const { stdout } = await execFileAsync(
          "/usr/bin/plutil",
          ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(candidate, "Contents", "Info.plist")],
          { encoding: "utf8" },
        );
        if (stdout.trim() !== expectedBundleId) continue;
      }
      return true;
    } catch {
      // Continue through known local installation locations.
    }
  }
  return false;
}
