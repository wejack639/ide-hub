import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";
import type {
  McpScope,
  McpServer,
  McpServerSummary,
  McpSourceSnapshot,
} from "./types.js";

const execFileAsync = promisify(execFile);

type RawCodexMcp = {
  name?: unknown;
  enabled?: unknown;
  startup_timeout_sec?: unknown;
  tool_timeout_sec?: unknown;
  transport?: {
    type?: unknown;
    command?: unknown;
    args?: unknown;
    cwd?: unknown;
    env?: unknown;
    env_vars?: unknown;
    url?: unknown;
    bearer_token_env_var?: unknown;
    http_headers?: unknown;
    env_http_headers?: unknown;
  };
};

export type ReadCodexMcpOptions = {
  scope: McpScope;
  workspace?: string;
  homeDir?: string;
  codexBinary?: string;
  commandRunner?: (context: { cwd: string }) => Promise<unknown>;
};

export async function readCodexMcpSnapshot(
  options: ReadCodexMcpOptions,
): Promise<McpSourceSnapshot> {
  const home = options.homeDir ?? homedir();
  if (options.scope === "project" && (!options.workspace || !isAbsolute(options.workspace))) {
    throw new MigrationError(
      "MCP_INVALID_REQUEST",
      "project scope requires an absolute workspace path",
    );
  }
  const binary = options.codexBinary ?? process.env.IDE_HUB_CODEX_BIN ?? "codex";
  const userPath = join(home, ".codex", "config.toml");
  const effectivePath = options.scope === "project"
    ? join(options.workspace!, ".codex", "config.toml")
    : userPath;
  const run = async (cwd: string): Promise<unknown> => options.commandRunner
    ? options.commandRunner({ cwd })
    : runCodexMcpList(binary, cwd);
  const raw = await run(options.scope === "project" ? options.workspace! : home);
  if (!Array.isArray(raw)) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", "Codex MCP list did not return an array");
  }
  let userServersByName = new Map<string, McpServer>();
  if (options.scope === "project") {
    const userRaw = await run(home);
    if (!Array.isArray(userRaw)) {
      throw new MigrationError("MCP_SOURCE_UNAVAILABLE", "Codex user MCP list did not return an array");
    }
    userServersByName = new Map(userRaw.map((entry, index) => {
      const server = normalizeCodexServer(entry, "user", userPath, index);
      return [server.name, server];
    }));
  }
  const servers = raw.map((entry, index) => {
    const projectServer = normalizeCodexServer(entry, options.scope, effectivePath, index);
    const userServer = userServersByName.get(projectServer.name);
    if (userServer && sameEffectiveServer(userServer, projectServer)) return userServer;
    return userServer ? { ...projectServer, overrides: [userServer.sourcePath] } : projectServer;
  });
  const identities = new Set(servers.map((server) => server.id));
  if (identities.size !== servers.length) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", "Codex MCP list contains duplicate server names");
  }
  const workspace = options.scope === "project" ? options.workspace ?? null : null;
  const sourcePath = effectivePath;
  const sourceFingerprint = sha256Text(stableJson({ scope: options.scope, workspace, servers }));
  return {
    schemaVersion: "ide-hub-mcp-source-v1",
    sourceProduct: "codex",
    sourceKind: "codex-effective",
    sourcePath,
    sourceFingerprint,
    capturedAt: new Date().toISOString(),
    scope: options.scope,
    workspace,
    servers,
  };
}

export function summarizeMcpSnapshot(snapshot: McpSourceSnapshot): McpServerSummary[] {
  return snapshot.servers.map((server) => ({
    id: server.id,
    name: server.name,
    scope: server.scope,
    sourcePath: server.sourcePath,
    overrides: [...server.overrides],
    transport: server.transport,
    command: server.command,
    args: maskArgs(server.args),
    cwd: server.cwd,
    envVars: [...server.envVars],
    url: maskUrl(server.url),
    enabled: server.enabled,
    startupTimeoutSec: server.startupTimeoutSec,
    toolTimeoutSec: server.toolTimeoutSec,
    unmappedFields: [...server.unmappedFields],
    envKeys: Object.keys(server.env).sort(),
    headerKeys: Object.keys(server.headers).sort(),
    envHeaderKeys: Object.keys(server.envHeaders).sort(),
    bearerTokenEnvVar: server.bearerTokenEnvVar,
  }));
}

async function runCodexMcpList(binary: string, cwd: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(binary, ["mcp", "list", "--json"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new MigrationError(
      "MCP_SOURCE_UNAVAILABLE",
      "Codex effective MCP configuration could not be read",
      { binary, cwd },
      { cause: error },
    );
  }
}

function normalizeCodexServer(
  raw: unknown,
  scope: McpScope,
  sourcePath: string,
  index: number,
): McpServer {
  if (!isRecord(raw)) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", `Codex MCP entry ${index} is invalid`);
  }
  const entry = raw as RawCodexMcp;
  const name = requiredString(entry.name, `Codex MCP entry ${index} name`);
  const transport = isRecord(entry.transport) ? entry.transport : {};
  const rawTransport = transport.type;
  const common = {
    id: sha256Text(`${scope}:${name}`),
    name,
    scope,
    sourcePath,
    overrides: [],
    env: stringRecord(transport.env, `${name}.transport.env`),
    envVars: stringArray(transport.env_vars, `${name}.transport.env_vars`),
    headers: stringRecord(transport.http_headers, `${name}.transport.http_headers`),
    envHeaders: stringRecord(transport.env_http_headers, `${name}.transport.env_http_headers`),
    bearerTokenEnvVar: null,
    enabled: entry.enabled !== false,
    startupTimeoutSec: nullableNumber(entry.startup_timeout_sec),
    toolTimeoutSec: nullableNumber(entry.tool_timeout_sec),
    unmappedFields: collectUnmappedFields(raw, transport),
  };
  if (rawTransport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: requiredString(transport.command, `${name}.transport.command`),
      args: stringArray(transport.args, `${name}.transport.args`),
      cwd: nullableString(transport.cwd),
      url: null,
    };
  }
  if (rawTransport === "streamable_http") {
    const bearer = nullableString(transport.bearer_token_env_var);
    return {
      ...common,
      transport: "streamable-http",
      command: null,
      args: [],
      cwd: null,
      url: requiredString(transport.url, `${name}.transport.url`),
      bearerTokenEnvVar: bearer,
    };
  }
  throw new MigrationError(
    "MCP_SOURCE_UNAVAILABLE",
    `Codex MCP server ${name} uses unsupported transport ${String(rawTransport)}`,
  );
}

function sameEffectiveServer(left: McpServer, right: McpServer): boolean {
  const withoutOrigin = (server: McpServer) => {
    const { id: _id, scope: _scope, sourcePath: _sourcePath, ...value } = server;
    return value;
  };
  return stableJson(withoutOrigin(left)) === stableJson(withoutOrigin(right));
}

function collectUnmappedFields(
  raw: Record<string, unknown>,
  transport: Record<string, unknown>,
): string[] {
  const knownEntry = new Set([
    "name",
    "enabled",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "transport",
    // These two are runtime status fields emitted by `codex mcp list --json`.
    "auth_status",
    "disabled_reason",
  ]);
  const knownTransport = new Set([
    "type",
    "command",
    "args",
    "cwd",
    "env",
    "env_vars",
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
  ]);
  return [
    ...Object.keys(raw).filter((key) => !knownEntry.has(key)).map((key) => key),
    ...Object.entries(transport)
      .filter(([key, value]) => !knownTransport.has(key) && value !== null && value !== undefined)
      .map(([key]) => `transport.${key}`),
  ].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", `${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", `${field} must be a string array`);
  }
  return [...value];
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new MigrationError("MCP_SOURCE_UNAVAILABLE", `${field} must contain string values`);
  }
  return { ...(value as Record<string, string>) };
}

function maskUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.search) url.search = "?masked=***";
    if (url.hash) url.hash = "#***";
    return url.toString();
  } catch {
    return value.includes("?") ? `${value.slice(0, value.indexOf("?"))}?***` : value;
  }
}

function maskArgs(args: string[]): string[] {
  let maskNext = false;
  return args.map((argument) => {
    if (maskNext) {
      maskNext = false;
      return "***";
    }
    if (/^--?(?:api[-_]?key|token|password|secret|authorization)$/iu.test(argument)) {
      maskNext = true;
      return argument;
    }
    if (/^--?(?:api[-_]?key|token|password|secret|authorization)=/iu.test(argument)) {
      return `${argument.slice(0, argument.indexOf("=") + 1)}***`;
    }
    return maskUrl(argument) ?? argument;
  });
}
