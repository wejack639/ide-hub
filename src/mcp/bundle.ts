import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MigrationError } from "../errors.js";
import { atomicWrite, sha256Text } from "../util/fs.js";
import { stableJson, stablePrettyJson } from "../util/stable-json.js";
import type { McpServer, McpSourceSnapshot } from "./types.js";

type McpBundleManifest = {
  schemaVersion: "ide-hub-mcp-bundle-v1";
  bundleId: string;
  createdAt: string;
  sourceProduct: "codex";
  scope: McpSourceSnapshot["scope"];
  workspace: string | null;
  serverCount: number;
  registrySha256: string;
};

const MANIFEST_PATH = "mcp-bundle-manifest.json";
const REGISTRY_PATH = "registry.json";
const SOURCE_PATH = "source-configs/codex-effective.json";
const CHECKSUMS_PATH = "checksums.sha256";
const ALLOWED_PATHS = new Set([MANIFEST_PATH, REGISTRY_PATH, SOURCE_PATH, CHECKSUMS_PATH]);

export async function exportMcpBundle(
  snapshot: McpSourceSnapshot,
  selectedServerIds: string[],
  outputPath: string,
): Promise<{ bundleId: string; outputPath: string; serverCount: number; sha256: string }> {
  const selected = selectServers(snapshot.servers, selectedServerIds);
  const registry = stablePrettyJson({
    schemaVersion: "ide-hub-mcp-registry-v1",
    sourceProduct: "codex",
    scope: snapshot.scope,
    workspace: snapshot.workspace,
    servers: selected,
  });
  const manifest: McpBundleManifest = {
    schemaVersion: "ide-hub-mcp-bundle-v1",
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    sourceProduct: "codex",
    scope: snapshot.scope,
    workspace: snapshot.workspace,
    serverCount: selected.length,
    registrySha256: sha256Text(registry),
  };
  const manifestText = stablePrettyJson(manifest);
  const sourceText = stablePrettyJson({
    sourcePath: snapshot.sourcePath,
    sourceFingerprint: snapshot.sourceFingerprint,
    selectedServerIds,
  });
  const checksums = [
    `${sha256Text(manifestText)}  ${MANIFEST_PATH}`,
    `${sha256Text(registry)}  ${REGISTRY_PATH}`,
    `${sha256Text(sourceText)}  ${SOURCE_PATH}`,
  ].join("\n") + "\n";
  const archive = zipSync({
    [MANIFEST_PATH]: strToU8(manifestText),
    [REGISTRY_PATH]: strToU8(registry),
    [SOURCE_PATH]: strToU8(sourceText),
    [CHECKSUMS_PATH]: strToU8(checksums),
  }, { level: 6 });
  await atomicWrite(outputPath, Buffer.from(archive));
  return {
    bundleId: manifest.bundleId,
    outputPath,
    serverCount: selected.length,
    sha256: sha256Text(Buffer.from(archive)),
  };
}

export async function importMcpBundle(
  path: string,
  workspaceOverride?: string,
): Promise<McpSourceSnapshot> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await readFile(path)));
  } catch (error) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP configuration bundle is not a valid ZIP", undefined, { cause: error });
  }
  for (const name of Object.keys(entries)) {
    if (!ALLOWED_PATHS.has(name)) {
      throw new MigrationError("MCP_BUNDLE_INVALID", `MCP bundle contains an unexpected entry: ${name}`);
    }
  }
  for (const required of ALLOWED_PATHS) {
    if (!entries[required]) throw new MigrationError("MCP_BUNDLE_INVALID", `MCP bundle is missing ${required}`);
  }
  const manifestText = strFromU8(entries[MANIFEST_PATH]!);
  const registryText = strFromU8(entries[REGISTRY_PATH]!);
  const sourceText = strFromU8(entries[SOURCE_PATH]!);
  const checksumText = strFromU8(entries[CHECKSUMS_PATH]!);
  verifyChecksums(checksumText, {
    [MANIFEST_PATH]: manifestText,
    [REGISTRY_PATH]: registryText,
    [SOURCE_PATH]: sourceText,
  });
  let manifestValue: unknown;
  let registryValue: unknown;
  let sourceValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
    registryValue = JSON.parse(registryText);
    sourceValue = JSON.parse(sourceText);
  } catch (error) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle JSON is invalid", undefined, { cause: error });
  }
  const manifest = validateManifest(manifestValue);
  const registry = validateRegistry(registryValue);
  const sourceMetadata = validateSourceMetadata(sourceValue);
  if (
    manifest.scope !== registry.scope ||
    manifest.workspace !== registry.workspace ||
    manifest.registrySha256 !== sha256Text(registryText) ||
    manifest.serverCount !== registry.servers.length
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle manifest and registry do not match");
  }
  const servers = registry.servers.map(validateBundledServer);
  if (
    sourceMetadata.selectedServerIds.length !== servers.length ||
    sourceMetadata.selectedServerIds.some((id, index) => id !== servers[index]!.id)
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle source metadata does not match the registry");
  }
  const mappedWorkspace = resolveImportedWorkspace(registry.scope, registry.workspace, workspaceOverride);
  const mappedServers = servers.map((server) => remapBundledServer(server, registry.workspace, mappedWorkspace));
  return {
    schemaVersion: "ide-hub-mcp-source-v1",
    sourceProduct: "codex",
    sourceKind: "mcp-bundle",
    sourcePath: path,
    sourceFingerprint: sha256Text(stableJson({ bundleId: manifest.bundleId, workspace: mappedWorkspace, servers: mappedServers })),
    capturedAt: new Date().toISOString(),
    scope: registry.scope,
    workspace: mappedWorkspace,
    servers: mappedServers,
  };
}

function selectServers(servers: McpServer[], selectedServerIds: string[]): McpServer[] {
  if (selectedServerIds.length === 0 || new Set(selectedServerIds).size !== selectedServerIds.length) {
    throw new MigrationError("MCP_INVALID_REQUEST", "Select at least one unique MCP server for export");
  }
  const selected = new Set(selectedServerIds);
  const result = servers.filter((server) => selected.has(server.id));
  if (result.length !== selected.size) {
    throw new MigrationError("MCP_INVALID_REQUEST", "MCP export selection contains an unknown server ID");
  }
  return result.map((server) => structuredClone(server));
}

function verifyChecksums(checksums: string, values: Record<string, string>): void {
  const lines = checksums.trim().split(/\r?\n/u);
  if (lines.length !== Object.keys(values).length) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle checksum entry count is invalid");
  }
  const parsed = new Map(lines.map((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle checksum file is invalid");
    return [match[2]!, match[1]!] as const;
  }));
  if (parsed.size !== lines.length || [...parsed.keys()].some((path) => !(path in values))) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle checksum paths are invalid");
  }
  for (const [path, value] of Object.entries(values)) {
    if (parsed.get(path) !== sha256Text(value)) {
      throw new MigrationError("MCP_BUNDLE_INVALID", `MCP bundle checksum failed for ${path}`);
    }
  }
}

function validateBundledServer(value: unknown): McpServer {
  if (!isRecord(value)) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle contains an invalid server");
  }
  assertExactKeys(value, [
    "id",
    "name",
    "scope",
    "sourcePath",
    "overrides",
    "transport",
    "command",
    "args",
    "cwd",
    "env",
    "envVars",
    "url",
    "headers",
    "envHeaders",
    "bearerTokenEnvVar",
    "enabled",
    "startupTimeoutSec",
    "toolTimeoutSec",
    "unmappedFields",
  ], "MCP bundle server");
  const server = value as Partial<McpServer>;
  if (
    typeof server.id !== "string" || !/^[a-f0-9]{64}$/iu.test(server.id) ||
    typeof server.name !== "string" || server.name.length === 0 ||
    (server.scope !== "user" && server.scope !== "project") ||
    typeof server.sourcePath !== "string" || server.sourcePath.length === 0 ||
    !isStringArray(server.overrides) ||
    (server.transport !== "stdio" && server.transport !== "streamable-http") ||
    !isNullableString(server.command) ||
    !isStringArray(server.args) ||
    !isNullableString(server.cwd) ||
    !isStringArray(server.envVars) ||
    !isNullableString(server.url) ||
    !isNullableString(server.bearerTokenEnvVar) ||
    typeof server.enabled !== "boolean" ||
    !isNullableFiniteNumber(server.startupTimeoutSec) ||
    !isNullableFiniteNumber(server.toolTimeoutSec) ||
    !isStringArray(server.unmappedFields) ||
    !isStringRecord(server.env) ||
    !isStringRecord(server.headers) ||
    !isStringRecord(server.envHeaders)
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", `MCP bundle server ${String(server.name)} has an invalid schema`);
  }
  if (
    (server.transport === "stdio" && (typeof server.command !== "string" || server.command.length === 0 || server.url !== null || server.bearerTokenEnvVar !== null)) ||
    (server.transport === "streamable-http" && (server.command !== null || server.args.length > 0 || server.cwd !== null || typeof server.url !== "string" || server.url.length === 0))
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", `MCP bundle server ${server.name} has an invalid transport shape`);
  }
  return structuredClone(server as McpServer);
}

function validateManifest(value: unknown): McpBundleManifest {
  if (!isRecord(value)) throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle manifest is invalid");
  assertExactKeys(value, [
    "schemaVersion",
    "bundleId",
    "createdAt",
    "sourceProduct",
    "scope",
    "workspace",
    "serverCount",
    "registrySha256",
  ], "MCP bundle manifest");
  if (
    value.schemaVersion !== "ide-hub-mcp-bundle-v1" ||
    typeof value.bundleId !== "string" || !/^[a-f0-9-]{36}$/iu.test(value.bundleId) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    value.sourceProduct !== "codex" ||
    (value.scope !== "user" && value.scope !== "project") ||
    !isScopeWorkspace(value.scope, value.workspace) ||
    typeof value.serverCount !== "number" || !Number.isInteger(value.serverCount) || value.serverCount < 1 ||
    typeof value.registrySha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(value.registrySha256)
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle manifest schema is invalid");
  }
  return value as McpBundleManifest;
}

function validateRegistry(value: unknown): {
  schemaVersion: "ide-hub-mcp-registry-v1";
  sourceProduct: "codex";
  scope: McpSourceSnapshot["scope"];
  workspace: string | null;
  servers: unknown[];
} {
  if (!isRecord(value)) throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle registry is invalid");
  assertExactKeys(value, ["schemaVersion", "sourceProduct", "scope", "workspace", "servers"], "MCP bundle registry");
  if (
    value.schemaVersion !== "ide-hub-mcp-registry-v1" ||
    value.sourceProduct !== "codex" ||
    (value.scope !== "user" && value.scope !== "project") ||
    !isScopeWorkspace(value.scope, value.workspace) ||
    !Array.isArray(value.servers) || value.servers.length === 0
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle registry schema is invalid");
  }
  return value as ReturnType<typeof validateRegistry>;
}

function validateSourceMetadata(value: unknown): {
  sourcePath: string;
  sourceFingerprint: string;
  selectedServerIds: string[];
} {
  if (!isRecord(value)) throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle source metadata is invalid");
  assertExactKeys(value, ["sourcePath", "sourceFingerprint", "selectedServerIds"], "MCP bundle source metadata");
  if (
    typeof value.sourcePath !== "string" || value.sourcePath.length === 0 ||
    typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sourceFingerprint) ||
    !isStringArray(value.selectedServerIds) ||
    value.selectedServerIds.some((id) => !/^[a-f0-9]{64}$/iu.test(id)) ||
    new Set(value.selectedServerIds).size !== value.selectedServerIds.length
  ) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "MCP bundle source metadata schema is invalid");
  }
  return value as ReturnType<typeof validateSourceMetadata>;
}

function resolveImportedWorkspace(
  scope: McpSourceSnapshot["scope"],
  bundledWorkspace: string | null,
  workspaceOverride?: string,
): string | null {
  if (scope === "user") {
    if (workspaceOverride !== undefined) {
      throw new MigrationError("MCP_BUNDLE_INVALID", "A user-scope MCP bundle cannot be mapped to a project workspace");
    }
    return null;
  }
  const workspace = workspaceOverride ?? bundledWorkspace;
  if (!workspace || !isAbsolute(workspace)) {
    throw new MigrationError("MCP_BUNDLE_INVALID", "A project-scope MCP bundle requires an absolute workspace mapping");
  }
  return workspace;
}

function remapBundledServer(
  server: McpServer,
  bundledWorkspace: string | null,
  mappedWorkspace: string | null,
): McpServer {
  if (!bundledWorkspace || !mappedWorkspace || bundledWorkspace === mappedWorkspace) {
    return server;
  }
  return {
    ...server,
    sourcePath: remapPath(server.sourcePath, bundledWorkspace, mappedWorkspace),
    overrides: server.overrides.map((path) => remapPath(path, bundledWorkspace, mappedWorkspace)),
    cwd: server.cwd === null ? null : remapPath(server.cwd, bundledWorkspace, mappedWorkspace),
  };
}

function remapPath(value: string, fromRoot: string, toRoot: string): string {
  if (!isAbsolute(value)) return value;
  const child = relative(fromRoot, value);
  if (child === "") return toRoot;
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return value;
  return join(toRoot, child);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0 || allowed.some((key) => !(key in value))) {
    throw new MigrationError("MCP_BUNDLE_INVALID", `${label} contains missing or unsupported fields`);
  }
}

function isScopeWorkspace(scope: unknown, workspace: unknown): boolean {
  return scope === "user"
    ? workspace === null
    : typeof workspace === "string" && isAbsolute(workspace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
}
