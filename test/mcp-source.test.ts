import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexMcpSnapshot, summarizeMcpSnapshot } from "../src/mcp/codex.js";

test("Codex MCP scanner normalizes effective CLI output without exposing values in summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-source-"));
  const fixture = join(root, "codex-mcp.json");
  await writeFile(fixture, JSON.stringify([
    {
      name: "local-tools",
      enabled: true,
      startup_timeout_sec: 12,
      tool_timeout_sec: 30,
      transport: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["server.js"],
        cwd: root,
        env: { PRIVATE_TOKEN: "never-render-me" },
        env_vars: ["AMBIENT_TOKEN"],
      },
    },
    {
      name: "remote-tools",
      enabled: false,
      transport: {
        type: "streamable_http",
        url: "https://example.test/mcp?secret=value",
        bearer_token_env_var: "BEARER_TOKEN",
        http_headers: { "X-Private": "hidden" },
        env_http_headers: { Authorization: "MCP_AUTH" },
      },
    },
  ]));

  const snapshot = await readCodexMcpSnapshot({
    scope: "user",
    commandRunner: async () => JSON.parse(await (await import("node:fs/promises")).readFile(fixture, "utf8")),
    homeDir: root,
  });

  assert.equal(snapshot.servers.length, 2);
  assert.equal(snapshot.servers[0]?.transport, "stdio");
  assert.deepEqual(snapshot.servers[0]?.env, { PRIVATE_TOKEN: "never-render-me" });
  assert.deepEqual(snapshot.servers[1]?.envHeaders, { Authorization: "MCP_AUTH" });
  assert.equal(snapshot.servers[1]?.bearerTokenEnvVar, "BEARER_TOKEN");
  assert.equal(new Set(snapshot.servers.map((server) => server.id)).size, 2);

  const summaries = summarizeMcpSnapshot(snapshot);
  assert.deepEqual(summaries[0]?.envKeys, ["PRIVATE_TOKEN"]);
  assert.deepEqual(summaries[1]?.headerKeys, ["X-Private"]);
  assert.doesNotMatch(JSON.stringify(summaries), /never-render-me|secret=value|hidden/u);
});

test("Codex project scan uses the selected cwd and attributes inherited user servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-project-source-"));
  const workspace = join(root, "project");
  const calls: string[] = [];
  const inherited = {
    name: "inherited",
    enabled: true,
    transport: { type: "stdio", command: "/usr/bin/true", args: [] },
  };
  const overriddenUser = {
    name: "overridden",
    enabled: true,
    transport: { type: "stdio", command: "/usr/bin/false", args: [] },
  };
  const overriddenProject = {
    name: "overridden",
    enabled: true,
    transport: { type: "stdio", command: "/usr/bin/true", args: ["project"] },
  };

  const snapshot = await readCodexMcpSnapshot({
    scope: "project",
    workspace,
    homeDir: root,
    commandRunner: async ({ cwd }) => {
      calls.push(cwd);
      return cwd === workspace
        ? [inherited, overriddenProject]
        : [inherited, overriddenUser];
    },
  });

  assert.deepEqual(calls, [workspace, root]);
  assert.equal(snapshot.servers.find((server) => server.name === "inherited")?.scope, "user");
  assert.equal(snapshot.servers.find((server) => server.name === "overridden")?.scope, "project");
  assert.deepEqual(snapshot.servers.find((server) => server.name === "overridden")?.overrides, [join(root, ".codex", "config.toml")]);
  assert.equal(snapshot.workspace, workspace);
});

test("Codex MCP scanner rejects unsupported transport shapes", async () => {
  await assert.rejects(
    readCodexMcpSnapshot({
      scope: "user",
      commandRunner: async () => [{ name: "bad", enabled: true, transport: { type: "websocket" } }],
    }),
    /unsupported transport/u,
  );
});
