import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  matchCodeBuddyNativeLog,
  matchNativeCliOutput,
  verifyNativeMcpRecognition,
} from "../src/mcp/native-verification.js";
import { verifyStdioHandshake } from "../src/mcp/handshake.js";

test("native CLI matching distinguishes exact server names", () => {
  const result = matchNativeCliOutput("alpha: connected\nalphabet: connected\n", ["alpha", "beta"]);
  assert.equal(result.alpha, true);
  assert.equal(result.beta, false);
  assert.equal(matchNativeCliOutput("alphabet: connected\n", ["alpha"]).alpha, false);
});

test("CodeBuddy native log proof requires a post-write reload and fetched tools", () => {
  const path = "/Users/test/.codebuddy/mcp.json";
  const log = [
    `2026-09-15 10:37:44.612 [info] watchFilePath path: ${path}; changed`,
    "2026-09-15 10:37:45.995 [info] [MCP] asyncUpdateServerTools mysql-dev: fetched 32 tools, 0 prompts, 0 resources",
  ].join("\n");
  const notBefore = new Date("2026-09-15T10:37:40").getTime();
  assert.equal(matchCodeBuddyNativeLog(log, path, "mysql-dev", notBefore), true);
  assert.equal(matchCodeBuddyNativeLog(log, path, "mysql-dev", new Date("2026-09-15T10:38:00").getTime()), false);
});

test("deterministic native migration probe completes initialize and tools/list", async () => {
  const result = await verifyStdioHandshake({
    id: "a".repeat(64),
    name: "ide-hub-native-probe",
    scope: "user",
    sourcePath: "/tmp/config.toml",
    overrides: [],
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/native-mcp-probe.cjs", import.meta.url))],
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
  }, 5_000);
  assert.equal(result.passed, true);
  assert.match(result.detail, /发现 1 个工具/u);
});

test("Qoder CN recognition uses the desktop IDE effective cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "ide-hub-qodercn-native-"));
  const cachePath = join(home, "Library/Application Support/QoderCN/SharedClientCache/extension/local/mcp.json");
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, '{"mcpServers":{"ide-hub-native-probe":{"command":"node"}}}\n');
  const result = await verifyNativeMcpRecognition({
    targetProduct: "qoder-cn",
    targetScope: "user",
    workspace: null,
    targetConfigPath: join(home, ".qoder-cn/mcp.json"),
    serverNames: ["ide-hub-native-probe"],
    homeDir: home,
    notBeforeEpochMs: 0,
  }, 100);
  assert.equal(result.servers["ide-hub-native-probe"]?.status, "passed");
});
