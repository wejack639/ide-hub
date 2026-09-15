import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { exportMcpBundle, importMcpBundle } from "../src/mcp/bundle.js";
import { scanMcpConfiguration } from "../src/mcp/service.js";
import type { McpSourceSnapshot } from "../src/mcp/types.js";
import { sha256Text } from "../src/util/fs.js";
import { stablePrettyJson } from "../src/util/stable-json.js";

test("MCP bundle exports only selected servers and round-trips independently of sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-bundle-"));
  const servers = ["included", "excluded"].map((name) => ({
    id: sha256Text(`user:${name}`),
    name,
    scope: "user" as const,
    sourcePath: join(root, ".codex/config.toml"),
    overrides: [],
    transport: "stdio" as const,
    command: "/usr/bin/true",
    args: [],
    cwd: null,
    env: name === "included" ? { TOKEN: "portable-secret" } : {},
    envVars: [],
    url: null,
    headers: {},
    envHeaders: {},
    bearerTokenEnvVar: null,
    enabled: true,
    startupTimeoutSec: null,
    toolTimeoutSec: null,
    unmappedFields: [],
  }));
  const source: McpSourceSnapshot = {
    schemaVersion: "ide-hub-mcp-source-v1",
    sourceProduct: "codex",
    sourceKind: "codex-effective",
    sourcePath: join(root, ".codex/config.toml"),
    sourceFingerprint: sha256Text(JSON.stringify(servers)),
    capturedAt: "2026-09-14T00:00:00.000Z",
    scope: "user",
    workspace: null,
    servers,
  };
  const archivePath = join(root, "mcp.zip");

  const exported = await exportMcpBundle(source, [servers[0]!.id], archivePath);
  assert.equal(exported.serverCount, 1);
  const imported = await importMcpBundle(archivePath);
  assert.equal(imported.sourceKind, "mcp-bundle");
  assert.equal(imported.servers.length, 1);
  assert.equal(imported.servers[0]?.name, "included");
  assert.deepEqual(imported.servers[0]?.env, { TOKEN: "portable-secret" });
  assert.doesNotMatch(JSON.stringify(imported), /sessionId|Capsule|Handoff/u);

  const targetWorkspace = join(root, "target-project");
  await mkdir(targetWorkspace);
  const scan = await scanMcpConfiguration({
    sourceBundlePath: archivePath,
    targetScope: "local",
    workspace: targetWorkspace,
  }, {
    homeDir: root,
    installedTargetOverrides: {
      "claude-code": true,
      cursor: true,
    },
  });
  assert.equal(scan.scope, "user");
  assert.equal(scan.sourceWorkspace, null);
  assert.equal(scan.targetScope, "local");
  assert.equal(scan.workspace, targetWorkspace);
  assert.equal(scan.targets.find((target) => target.targetProduct === "claude-code")?.supported, true);
  assert.equal(scan.targets.find((target) => target.targetProduct === "cursor")?.supported, false);
});

test("project MCP bundle remaps workspace-local cwd on another computer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-project-bundle-"));
  const oldWorkspace = join(root, "old", "project");
  const newWorkspace = join(root, "new", "project");
  const sourcePath = join(oldWorkspace, ".codex", "config.toml");
  const server: McpSourceSnapshot["servers"][number] = {
    id: sha256Text("project:portable"),
    name: "portable",
    scope: "project",
    sourcePath,
    overrides: [],
    transport: "stdio",
    command: "/usr/bin/true",
    args: [],
    cwd: join(oldWorkspace, "tools"),
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
    sourcePath,
    sourceFingerprint: sha256Text(JSON.stringify(server)),
    capturedAt: "2026-09-14T00:00:00.000Z",
    scope: "project",
    workspace: oldWorkspace,
    servers: [server],
  };
  const archivePath = join(root, "project-mcp.zip");
  await exportMcpBundle(source, [server.id], archivePath);

  const first = await importMcpBundle(archivePath, newWorkspace);
  const repeated = await importMcpBundle(archivePath, newWorkspace);
  assert.equal(first.workspace, newWorkspace);
  assert.equal(first.servers[0]?.cwd, join(newWorkspace, "tools"));
  assert.equal(first.servers[0]?.sourcePath, join(newWorkspace, ".codex", "config.toml"));
  assert.equal(first.sourceFingerprint, repeated.sourceFingerprint);
});

test("MCP bundle rejects session-domain fields even when checksums are valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-invalid-bundle-"));
  const server = {
    id: sha256Text("user:strict"),
    name: "strict",
    scope: "user" as const,
    sourcePath: join(root, ".codex", "config.toml"),
    overrides: [],
    transport: "stdio" as const,
    command: "/usr/bin/true",
    args: [],
    cwd: null,
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
    capturedAt: "2026-09-14T00:00:00.000Z",
    scope: "user",
    workspace: null,
    servers: [server],
  };
  const archivePath = join(root, "invalid-mcp.zip");
  await exportMcpBundle(source, [server.id], archivePath);
  const entries = unzipSync(new Uint8Array(await readFile(archivePath)));
  const registry = JSON.parse(strFromU8(entries["registry.json"]!));
  registry.servers[0].sessionId = "must-not-cross-domain";
  const registryText = stablePrettyJson(registry);
  const manifest = JSON.parse(strFromU8(entries["mcp-bundle-manifest.json"]!));
  manifest.registrySha256 = sha256Text(registryText);
  const manifestText = stablePrettyJson(manifest);
  const sourceText = strFromU8(entries["source-configs/codex-effective.json"]!);
  const checksums = [
    `${sha256Text(manifestText)}  mcp-bundle-manifest.json`,
    `${sha256Text(registryText)}  registry.json`,
    `${sha256Text(sourceText)}  source-configs/codex-effective.json`,
  ].join("\n") + "\n";
  await writeFile(archivePath, Buffer.from(zipSync({
    "mcp-bundle-manifest.json": strToU8(manifestText),
    "registry.json": strToU8(registryText),
    "source-configs/codex-effective.json": strToU8(sourceText),
    "checksums.sha256": strToU8(checksums),
  })));

  await assert.rejects(importMcpBundle(archivePath), /missing or unsupported fields/u);
});
