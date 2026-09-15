import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { MCP_TARGET_PRODUCTS } from "../src/mcp/types.js";
import { discoverMcpTargets, renderMcpServer, resolveMcpTarget } from "../src/mcp/targets.js";
import type { McpServer } from "../src/mcp/types.js";
import { sha256Text } from "../src/util/fs.js";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: sha256Text("user:example"),
    name: "example",
    scope: "user",
    sourcePath: "/tmp/.codex/config.toml",
    overrides: [],
    transport: "stdio",
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
    ...overrides,
  };
}

test("all supported IDE products have target profiles and Pi stays unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-targets-"));
  const overrides = Object.fromEntries(
    MCP_TARGET_PRODUCTS.filter((target) => target !== "pi").map((target) => [target, join(root, target, "config.json")]),
  );
  for (const path of Object.values(overrides)) {
    await (await import("node:fs/promises")).mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}\n");
  }
  const installed = Object.fromEntries(MCP_TARGET_PRODUCTS.map((target) => [target, true]));
  const options = {
    homeDir: root,
    targetPathOverrides: overrides,
    installedTargetOverrides: installed,
    dshClientInstalled: true,
  };

  const targets = await discoverMcpTargets("user", null, options);
  assert.deepEqual(targets.map((target) => target.targetProduct), [...MCP_TARGET_PRODUCTS]);
  assert.equal(new Set(targets.filter((target) => target.targetConfigPath).map((target) => target.targetConfigPath)).size, 8);
  assert.equal(targets.find((target) => target.targetProduct === "pi")?.supported, false);
  assert.match(targets.find((target) => target.targetProduct === "pi")?.reason ?? "", /adapter/u);
  assert.equal(targets.find((target) => target.targetProduct === "deepseek-harness")?.supported, true);
});

test("ZCode renderer uses mcp.servers and CodeBuddy editions share the native user store", () => {
  const root = "/tmp/ide-hub-mcp-profile";
  assert.deepEqual(resolveMcpTarget("zcode", "user", null, { homeDir: root }).jsonPath, ["mcp", "servers"]);
  assert.deepEqual(resolveMcpTarget("cursor", "user", null, { homeDir: root }).jsonPath, ["mcpServers"]);
  assert.notEqual(
    resolveMcpTarget("qoder-international", "user", null, { homeDir: root }).configPath,
    resolveMcpTarget("qoder-cn", "user", null, { homeDir: root }).configPath,
  );
  assert.equal(
    resolveMcpTarget("codebuddy-international", "user", null, { homeDir: root }).configPath,
    resolveMcpTarget("codebuddy-cn", "user", null, { homeDir: root }).configPath,
  );
  assert.equal(
    resolveMcpTarget("codebuddy-cn", "user", null, { homeDir: root }).configPath,
    join(root, ".codebuddy", "mcp.json"),
  );
});

test("target discovery follows current Qoder, CodeBuddy and ZCode precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-precedence-"));
  const workspace = join(root, "project");
  await (await import("node:fs/promises")).mkdir(join(root, ".codebuddy"), { recursive: true });
  await (await import("node:fs/promises")).mkdir(join(root, ".agents"), { recursive: true });
  await writeFile(join(root, ".codebuddy", "mcp.json"), "{}\n");
  await writeFile(join(root, ".agents", "mcp.json"), '{"mcpServers":{"fallback":{"command":"true"}}}\n');

  assert.equal(resolveMcpTarget("qoder-international", "user", null, { homeDir: root }).configPath, join(root, ".qoder", "mcp.json"));
  assert.equal(resolveMcpTarget("qoder-cn", "user", null, { homeDir: root }).configPath, join(root, ".qoder-cn", "mcp.json"));
  assert.equal(resolveMcpTarget("qoder-international", "project", workspace, { homeDir: root }).configPath, join(workspace, ".mcp.json"));
  assert.equal(resolveMcpTarget("qoder-international", "local", workspace, { homeDir: root }).configPath, null);
  assert.equal(resolveMcpTarget("codebuddy-international", "user", null, { homeDir: root }).configPath, join(root, ".codebuddy", "mcp.json"));
  assert.equal(resolveMcpTarget("codebuddy-cn", "user", null, { homeDir: root }).configPath, join(root, ".codebuddy", "mcp.json"));
  assert.equal(resolveMcpTarget("zcode", "user", null, { homeDir: root }).configPath, join(root, ".agents", "mcp.json"));

  await (await import("node:fs/promises")).mkdir(join(root, ".zcode", "cli"), { recursive: true });
  await writeFile(join(root, ".zcode", "cli", "config.json"), '{"mcp":{"servers":{"native":{"command":"true"}}}}\n');
  const zcode = resolveMcpTarget("zcode", "user", null, { homeDir: root });
  assert.equal(zcode.configPath, join(root, ".zcode", "cli", "config.json"));
  assert.deepEqual(zcode.jsonPath, ["mcp", "servers"]);
});

test("target user, project and local scopes resolve independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-scopes-"));
  const workspace = join(root, "project");
  await (await import("node:fs/promises")).mkdir(workspace, { recursive: true });

  const claudeLocal = resolveMcpTarget("claude-code", "local", workspace, { homeDir: root });
  assert.equal(claudeLocal.configPath, join(root, ".claude.json"));
  assert.deepEqual(claudeLocal.jsonPath, ["projects", workspace, "mcpServers"]);
  assert.equal(resolveMcpTarget("claude-code", "project", workspace, { homeDir: root }).configPath, join(workspace, ".mcp.json"));

  const codeBuddyLocal = resolveMcpTarget("codebuddy-international", "local", workspace, { homeDir: root });
  assert.equal(codeBuddyLocal.configPath, null);
  assert.equal(codeBuddyLocal.format, "unsupported");
  const qoderLocal = resolveMcpTarget("qoder-cn", "local", workspace, { homeDir: root });
  assert.equal(qoderLocal.configPath, null);
  assert.equal(qoderLocal.format, "unsupported");

  const installed = Object.fromEntries(MCP_TARGET_PRODUCTS.map((target) => [target, true]));
  const localTargets = await discoverMcpTargets("local", workspace, {
    homeDir: root,
    installedTargetOverrides: installed,
    dshClientInstalled: true,
  });
  for (const target of ["cursor", "deepseek-harness", "zcode"] as const) {
    const availability = localTargets.find((item) => item.targetProduct === target);
    assert.equal(availability?.supported, false);
    assert.match(availability?.reason ?? "", /local/u);
  }
  assert.equal(localTargets.find((target) => target.targetProduct === "claude-code")?.supported, true);
  assert.equal(localTargets.find((target) => target.targetProduct === "codebuddy-international")?.supported, false);
  assert.equal(localTargets.find((target) => target.targetProduct === "codebuddy-cn")?.supported, false);
  assert.equal(localTargets.find((target) => target.targetProduct === "qoder-international")?.supported, false);
  assert.equal(localTargets.find((target) => target.targetProduct === "qoder-cn")?.supported, false);
});

test("renderers preserve remote type, environment references and bearer semantics", () => {
  const remote = server({
    transport: "streamable-http",
    command: null,
    url: "https://example.test/mcp",
    envHeaders: { "X-Token": "DYNAMIC_TOKEN" },
    bearerTokenEnvVar: "BEARER_TOKEN",
  });
  assert.deepEqual(renderMcpServer(remote, "claude-code").value, {
    type: "http",
    url: "https://example.test/mcp",
    headers: {
      "X-Token": "${DYNAMIC_TOKEN}",
      Authorization: "Bearer ${BEARER_TOKEN}",
    },
  });
  assert.deepEqual(renderMcpServer(remote, "cursor").value, {
    url: "https://example.test/mcp",
    headers: {
      "X-Token": "${env:DYNAMIC_TOKEN}",
      Authorization: "Bearer ${env:BEARER_TOKEN}",
    },
  });
});

test("renderer refuses fields that a target cannot represent without loss", () => {
  assert.equal(renderMcpServer(server({ startupTimeoutSec: 5 }), "cursor").supported, false);
  assert.equal(renderMcpServer(server({ unmappedFields: ["transport.http_headers_helper"] }), "qoder-international").supported, false);
  assert.deepEqual(renderMcpServer(server({ toolTimeoutSec: 9 }), "zcode").value, {
    command: "/usr/bin/true",
    timeoutMs: 9_000,
    type: "stdio",
  });
  assert.deepEqual(renderMcpServer(server({ enabled: false }), "zcode").value, {
    command: "/usr/bin/true",
    type: "stdio",
    enable: false,
  });
  assert.deepEqual(renderMcpServer(server({ enabled: false }), "qoder-international").value, {
    command: "/usr/bin/true",
    disabled: true,
  });
  assert.equal(renderMcpServer(server({ enabled: false }), "cursor").supported, false);
  assert.equal(renderMcpServer(server({ enabled: false }), "codebuddy-international").supported, false);
});

test("DeepSeek Harness rejects an unverified MCP client version", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-dsh-version-"));
  const targets = await discoverMcpTargets("user", null, {
    homeDir: root,
    installedTargetOverrides: { "deepseek-harness": true },
    dshClientInstalled: true,
    dshClientVersion: "9.9.9",
  });
  const dsh = targets.find((target) => target.targetProduct === "deepseek-harness");
  assert.equal(dsh?.supported, false);
  assert.match(dsh?.reason ?? "", /未验证/u);
});
