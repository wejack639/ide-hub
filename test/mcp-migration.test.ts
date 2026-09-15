import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, open, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  applyMcpMigration,
  listMcpJobs,
  planMcpMigration,
  rollbackMcpMigration,
} from "../src/mcp/migration.js";
import type { McpSourceSnapshot } from "../src/mcp/types.js";
import type { McpMigrationRequest, McpTargetProduct } from "../src/mcp/types.js";
import { sha256Text } from "../src/util/fs.js";

function sourceSnapshot(root: string): McpSourceSnapshot {
  const servers = ["selected", "not-selected"].map((name) => ({
    id: sha256Text(`user:${name}`),
    name,
    scope: "user" as const,
    sourcePath: join(root, ".codex/config.toml"),
    overrides: [],
    transport: "stdio" as const,
    command: "/usr/bin/printf",
    args: [name],
    cwd: root,
    env: name === "selected" ? { TOKEN: "private-value" } : {},
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
  return {
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
}

test("single-target migration writes only checked MCP and preserves JSONC comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-apply-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `{
  // keep this comment
  "mcpServers": {
    "existing": { "command": "/usr/bin/true" }
  },
  "unrelated": true
}\n`);
  await chmod(targetPath, 0o640);
  const metadataBefore = await stat(targetPath);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);

  assert.equal(plan.canApply, true);
  assert.equal(plan.selectedServerCount, 1);
  const receipt = await applyMcpMigration(plan, options, source);
  assert.equal(receipt.status, "COMPLETED_WITH_WARNINGS");
  assert.equal(receipt.verification[0]?.nativeRecognition, "pending");
  assert.match(receipt.verification[0]?.nativeDetail ?? "", /目标应用/u);
  const updatedText = await readFile(targetPath, "utf8");
  const updated = parse(updatedText) as Record<string, unknown>;
  const servers = updated.mcpServers as Record<string, unknown>;
  assert.match(updatedText, /keep this comment/u);
  assert.ok(servers.selected);
  assert.ok(servers.existing);
  assert.equal(servers["not-selected"], undefined);
  assert.equal(updated.unrelated, true);
  const metadataAfter = await stat(targetPath);
  assert.equal(metadataAfter.mode & 0o777, metadataBefore.mode & 0o777);
  assert.equal(metadataAfter.uid, metadataBefore.uid);
  assert.equal(metadataAfter.gid, metadataBefore.gid);
  assert.equal((await listMcpJobs(options))[0]?.canRollback, true);

  const rolledBack = await rollbackMcpMigration(receipt.mcpMigrationId, options);
  assert.equal(rolledBack.status, "ROLLED_BACK");
  assert.doesNotMatch(await readFile(targetPath, "utf8"), /"selected"/u);
  assert.equal((await stat(targetPath)).mode & 0o777, metadataBefore.mode & 0o777);
  assert.equal((await listMcpJobs(options))[0]?.canRollback, false);
});

test("native loader rejection rolls back instead of returning a successful receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-native-reject-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await mkdir(dirname(targetPath), { recursive: true });
  const original = '{"mcpServers":{}}\n';
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
    nativeRecognitionVerifier: async (input: { serverNames: string[] }) => ({
      method: "fixture-native-loader",
      servers: Object.fromEntries(input.serverNames.map((name) => [name, {
        status: "failed" as const,
        detail: "目标原生列表未发现该 MCP",
      }])),
    }),
  };
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);

  await assert.rejects(applyMcpMigration(plan, options, source), /目标原生列表未发现/u);
  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("rollback removes only the migrated server after a target rewrites unrelated JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-selective-rollback-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await mkdir(dirname(targetPath), { recursive: true });
  const original = '{"mcpServers":{"existing":{"command":"/usr/bin/true"}},"before":true}\n';
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  const receipt = await applyMcpMigration(plan, options, source);
  const rewritten = parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
  rewritten.after = true;
  await writeFile(targetPath, `${JSON.stringify(rewritten, null, 4)}\n`);

  const rolledBack = await rollbackMcpMigration(receipt.mcpMigrationId, options);
  const result = parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
  assert.equal(rolledBack.status, "ROLLED_BACK");
  assert.equal(rolledBack.rollbackMode, "selected-only");
  assert.equal(result.after, true);
  assert.equal((result.mcpServers as Record<string, unknown>).selected, undefined);
  assert.ok((result.mcpServers as Record<string, unknown>).existing);
});

test("rollback still refuses an external edit to the migrated server itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-selected-conflict-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, '{"mcpServers":{}}\n');
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  const receipt = await applyMcpMigration(plan, options, source);
  const changed = parse(await readFile(targetPath, "utf8")) as { mcpServers: Record<string, unknown> };
  changed.mcpServers.selected = { command: "/externally/changed" };
  await writeFile(targetPath, `${JSON.stringify(changed)}\n`);

  await assert.rejects(
    rollbackMcpMigration(receipt.mcpMigrationId, options),
    /migrated MCP server changed/u,
  );
});

test("migration refuses an empty selection and a target changed after preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-stale-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "{\"mcpServers\":{}}\n");
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;

  await assert.rejects(
    planMcpMigration({
      sourceProduct: "codex",
      targetProduct: "cursor",
      selectedServerIds: [],
      scope: "user",
      targetScope: "user",
      resolutions: {},
    }, options, source),
    /at least one MCP server/u,
  );

  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  await writeFile(targetPath, "{\"mcpServers\":{},\"external\":true}\n");
  await assert.rejects(applyMcpMigration(plan, options, source), /changed after preview/u);
});

test("same-name conflicts require an explicit strategy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-conflict-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "{\"mcpServers\":{\"selected\":{\"command\":\"other\"}}}\n");
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;

  const unresolved = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  assert.equal(unresolved.canApply, false);
  assert.equal(unresolved.diffs[0]?.status, "conflict");

  const replace = await planMcpMigration({
    ...unresolved.request,
    resolutions: { [source.servers[0]!.id]: { strategy: "replace" } },
  }, options, source);
  assert.equal(replace.canApply, true);
  assert.equal(replace.diffs[0]?.status, "replace");
});

test("skip, rename, merge and replace produce only their declared target changes", async () => {
  const strategies = ["skip", "rename", "merge", "replace"] as const;
  for (const strategy of strategies) {
    const root = await mkdtemp(join(tmpdir(), `ide-hub-mcp-${strategy}-`));
    const targetPath = join(root, ".cursor/mcp.json");
    await mkdir(dirname(targetPath), { recursive: true });
    const original = `{
  "mcpServers": {
    "selected": {
      "command": "/usr/bin/printf",
      "args": ["target"],
      "description": "keep-on-merge"
    },
    "unrelated": { "command": "/usr/bin/true" }
  },
  "topLevel": true
}\n`;
    await writeFile(targetPath, original);
    const source = sourceSnapshot(root);
    const resolution = strategy === "rename"
      ? { strategy, renameTo: "selected-from-codex" }
      : strategy === "merge"
        ? { strategy, fieldChoices: { args: "source" as const } }
        : { strategy };
    const options = {
      homeDir: root,
      dataRoot: join(root, "ide-hub-data"),
      targetPathOverrides: { cursor: targetPath },
      installedTargetOverrides: { cursor: true },
      skipStdioHandshake: true,
    } as const;
    const plan = await planMcpMigration({
      sourceProduct: "codex",
      targetProduct: "cursor",
      selectedServerIds: [source.servers[0]!.id],
      scope: "user",
      targetScope: "user",
      resolutions: { [source.servers[0]!.id]: resolution },
    }, options, source);
    assert.equal(plan.canApply, true, strategy);
    assert.equal(plan.diffs[0]?.status, strategy, strategy);

    const receipt = await applyMcpMigration(plan, options, source);
    const appliedText = await readFile(targetPath, "utf8");
    const applied = parse(appliedText) as {
      mcpServers: Record<string, Record<string, unknown>>;
      topLevel: boolean;
    };
    assert.ok(applied.mcpServers.unrelated, strategy);
    assert.equal(applied.topLevel, true, strategy);
    if (strategy === "skip") {
      assert.equal(appliedText, original);
    } else if (strategy === "rename") {
      assert.deepEqual(applied.mcpServers.selected?.args, ["target"]);
      assert.deepEqual(applied.mcpServers["selected-from-codex"]?.args, ["selected"]);
    } else if (strategy === "merge") {
      assert.deepEqual(applied.mcpServers.selected?.args, ["selected"]);
      assert.equal(applied.mcpServers.selected?.description, "keep-on-merge");
      assert.deepEqual(applied.mcpServers.selected?.env, { TOKEN: "private-value" });
    } else {
      assert.deepEqual(applied.mcpServers.selected?.args, ["selected"]);
      assert.equal(applied.mcpServers.selected?.description, undefined);
    }
    await rollbackMcpMigration(receipt.mcpMigrationId, options);
    assert.equal(await readFile(targetPath, "utf8"), original, strategy);
  }
});

test("merge is unavailable when transport or endpoint identity differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-endpoint-conflict-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, '{"mcpServers":{"selected":{"url":"https://example.test/mcp"}}}\n');
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const conflict = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  assert.equal(conflict.canApply, false);
  assert.equal(conflict.diffs[0]?.availableStrategies.includes("merge"), false);

  const invalidMerge = await planMcpMigration({
    ...conflict.request,
    resolutions: { [source.servers[0]!.id]: { strategy: "merge" } },
  }, options, source);
  assert.equal(invalidMerge.canApply, false);
  assert.equal(invalidMerge.diffs[0]?.status, "unsupported");
});

test("an already identical selection is a no-op and does not rewrite the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-noop-"));
  const targetPath = join(root, ".cursor/mcp.json");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  const original = `{
  // byte-for-byte stable on no-op
  "mcpServers": {
    "selected": {
      "command": "/usr/bin/printf",
      "args": ["selected"],
      "cwd": ${JSON.stringify(root)},
      "env": { "TOKEN": "private-value" }
    }
  }
}\n`;
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  assert.equal(plan.diffs[0]?.status, "same");
  const receipt = await applyMcpMigration(plan, options, source);
  assert.equal(receipt.changed, false);
  assert.equal(receipt.backupPath, null);
  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("all JSON/JSONC target editions preserve unrelated content and roll back independently", async () => {
  const targets: McpTargetProduct[] = [
    "qoder-international",
    "qoder-cn",
    "cursor",
    "zcode",
    "claude-code",
    "codebuddy-international",
    "codebuddy-cn",
  ];
  for (const targetProduct of targets) {
    const root = await mkdtemp(join(tmpdir(), `ide-hub-mcp-${targetProduct}-`));
    const targetPath = join(root, targetProduct, "config.json");
    await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
    const container = targetProduct === "zcode"
      ? '"mcp":{"servers":{"existing":{"command":"/usr/bin/true"}}}'
      : '"mcpServers":{"existing":{"command":"/usr/bin/true"}}';
    const original = `{\n  // preserve target comment\n  "unrelated": true,\n  ${container}\n}\n`;
    await writeFile(targetPath, original);
    const source = sourceSnapshot(root);
    const options = {
      homeDir: root,
      dataRoot: join(root, "ide-hub-data"),
      targetPathOverrides: { [targetProduct]: targetPath },
      installedTargetOverrides: { [targetProduct]: true },
      skipStdioHandshake: true,
    };
    const plan = await planMcpMigration({
      sourceProduct: "codex",
      targetProduct,
      selectedServerIds: [source.servers[0]!.id],
      scope: "user",
      targetScope: "user",
      resolutions: {},
    }, options, source);
    assert.equal(plan.canApply, true, targetProduct);
    const receipt = await applyMcpMigration(plan, options, source);
    const applied = await readFile(targetPath, "utf8");
    assert.match(applied, /preserve target comment/u, targetProduct);
    assert.match(applied, /"selected"/u, targetProduct);
    assert.doesNotMatch(applied, /not-selected/u, targetProduct);
    await rollbackMcpMigration(receipt.mcpMigrationId, options);
    assert.equal(await readFile(targetPath, "utf8"), original, targetProduct);
  }
});

test("source scope and target local scope stay independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-local-scope-"));
  const workspace = join(root, "workspace");
  const targetPath = join(root, ".claude.json");
  await mkdir(workspace, { recursive: true });
  const original = `{
  // keep unrelated Claude project state
  "projects": {
    ${JSON.stringify(workspace)}: { "hasTrustDialogAccepted": false }
  },
  "unrelated": true
}\n`;
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    installedTargetOverrides: { "claude-code": true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "claude-code",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "local",
    workspace,
    resolutions: {},
  }, options, source);

  assert.equal(plan.canApply, true);
  assert.equal(plan.request.scope, "user");
  assert.equal(plan.request.targetScope, "local");
  const receipt = await applyMcpMigration(plan, options, source);
  assert.equal(receipt.sourceScope, "user");
  assert.equal(receipt.targetScope, "local");
  const applied = parse(await readFile(targetPath, "utf8")) as {
    projects: Record<string, { hasTrustDialogAccepted?: boolean; mcpServers?: Record<string, unknown> }>;
    unrelated: boolean;
  };
  assert.ok(applied.projects[workspace]?.mcpServers?.selected);
  assert.equal(applied.projects[workspace]?.hasTrustDialogAccepted, false);
  assert.equal(applied.unrelated, true);

  await rollbackMcpMigration(receipt.mcpMigrationId, options);
  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("ZCode project migration refuses a server name shadowed by user scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-zcode-shadow-"));
  const workspace = join(root, "workspace");
  const userPath = join(root, ".zcode", "cli", "config.json");
  const projectPath = join(workspace, ".zcode", "config.json");
  await mkdir(dirname(userPath), { recursive: true });
  await mkdir(dirname(projectPath), { recursive: true });
  const userOriginal = '{"mcp":{"servers":{"selected":{"command":"/usr/bin/true"}}}}\n';
  const projectOriginal = '{"mcp":{"servers":{}},"projectField":true}\n';
  await writeFile(userPath, userOriginal);
  await writeFile(projectPath, projectOriginal);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    installedTargetOverrides: { zcode: true },
    skipStdioHandshake: true,
  } as const;
  const request = {
    sourceProduct: "codex" as const,
    targetProduct: "zcode" as const,
    selectedServerIds: [source.servers[0]!.id],
    scope: "user" as const,
    targetScope: "project" as const,
    workspace,
    resolutions: {},
  };

  const shadowed = await planMcpMigration(request, options, source);
  assert.equal(shadowed.canApply, false);
  assert.equal(shadowed.diffs[0]?.status, "conflict");
  assert.deepEqual(shadowed.diffs[0]?.availableStrategies, ["skip", "rename"]);
  assert.match(shadowed.diffs[0]?.reason ?? "", /user scope.*遮蔽/u);

  const invalidReplace = await planMcpMigration({
    ...request,
    resolutions: { [source.servers[0]!.id]: { strategy: "replace" } },
  }, options, source);
  assert.equal(invalidReplace.canApply, false);
  assert.equal(invalidReplace.diffs[0]?.status, "unsupported");

  const renamed = await planMcpMigration({
    ...request,
    resolutions: { [source.servers[0]!.id]: { strategy: "rename", renameTo: "selected-project" } },
  }, options, source);
  assert.equal(renamed.canApply, true);
  const receipt = await applyMcpMigration(renamed, options, source);
  const project = parse(await readFile(projectPath, "utf8")) as { mcp: { servers: Record<string, unknown> }; projectField: boolean };
  assert.ok(project.mcp.servers["selected-project"]);
  assert.equal(project.mcp.servers.selected, undefined);
  assert.equal(project.projectField, true);
  assert.equal(await readFile(userPath, "utf8"), userOriginal);
  await rollbackMcpMigration(receipt.mcpMigrationId, options);
  assert.equal(await readFile(projectPath, "utf8"), projectOriginal);
});

test("DeepSeek Harness writes one managed Cordis plugin row and rolls it back", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-dsh-"));
  const targetPath = join(root, ".dsh/profiles/web/cordis.patch.yml");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  const original = "# profile patch comments stay intact\n# empty before migration\n[]\n";
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { "deepseek-harness": targetPath },
    installedTargetOverrides: { "deepseek-harness": true },
    dshClientInstalled: true,
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "deepseek-harness",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  assert.equal(plan.canApply, true);
  const receipt = await applyMcpMigration(plan, options, source);
  const applied = await readFile(targetPath, "utf8");
  assert.match(applied, /@deepseek-ai\/dsh-mcp-client/u);
  assert.match(applied, /serverName: "selected"/u);
  assert.doesNotMatch(applied, /not-selected/u);
  await rollbackMcpMigration(receipt.mcpMigrationId, options);
  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("DeepSeek Harness rejects an unknown Cordis patch schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-dsh-invalid-"));
  const targetPath = join(root, ".dsh/profiles/web/cordis.patch.yml");
  await (await import("node:fs/promises")).mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "unknown: schema\n");
  const source = sourceSnapshot(root);
  await assert.rejects(planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "deepseek-harness",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, {
    homeDir: root,
    targetPathOverrides: { "deepseek-harness": targetPath },
    installedTargetOverrides: { "deepseek-harness": true },
    dshClientInstalled: true,
  }, source), /schema is not recognized/u);
});

test("planner rejects malformed target JSON without writing a migration job", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-invalid-json-"));
  const targetPath = join(root, ".cursor/mcp.json");
  const dataRoot = join(root, "ide-hub-data");
  await mkdir(dirname(targetPath), { recursive: true });
  const malformed = "{\"mcpServers\": {\n";
  await writeFile(targetPath, malformed);
  const source = sourceSnapshot(root);

  await assert.rejects(planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, {
    homeDir: root,
    dataRoot,
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
  }, source), /JSON\/JSONC/u);
  assert.equal(await readFile(targetPath, "utf8"), malformed);
  assert.deepEqual(await listMcpJobs({ dataRoot }), []);
});

test("MCP request schema rejects session fields and multi-target input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-request-schema-"));
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    targetPathOverrides: { cursor: join(root, ".cursor/mcp.json") },
    installedTargetOverrides: { cursor: true },
  } as const;
  const base: McpMigrationRequest = {
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  };
  await assert.rejects(
    planMcpMigration({ ...base, sessionId: "cross-domain" } as McpMigrationRequest, options, source),
    /unsupported fields: sessionId/u,
  );
  await assert.rejects(
    planMcpMigration({ ...base, targetProducts: ["cursor", "zcode"] } as McpMigrationRequest, options, source),
    /unsupported fields: targetProducts/u,
  );
  await assert.rejects(
    planMcpMigration({ ...base, targetScope: undefined } as unknown as McpMigrationRequest, options, source),
    /targetScope must be user, project, or local/u,
  );
  await assert.rejects(
    planMcpMigration({ ...base, targetScope: "local" } as McpMigrationRequest, options, source),
    /requires an absolute workspace path/u,
  );
});

test("planner rejects a target that escapes through a symlinked config parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "ide-hub-mcp-symlink-outside-"));
  await symlink(outside, join(root, ".cursor"), "dir");
  const source = sourceSnapshot(root);
  await assert.rejects(planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, {
    homeDir: root,
    targetPathOverrides: { cursor: join(root, ".cursor", "mcp.json") },
    installedTargetOverrides: { cursor: true },
  }, source), /symlinked parent/u);
});

test("job discovery restores an interrupted apply from its durable MCP journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-recovery-"));
  const dataRoot = join(root, "ide-hub-data");
  const targetPath = join(root, ".cursor/mcp.json");
  await mkdir(dirname(targetPath), { recursive: true });
  const before = "{\n  \"mcpServers\": {}\n}\n";
  const after = "{\n  \"mcpServers\": {\"selected\": {\"command\": \"/usr/bin/printf\"}}\n}\n";
  await writeFile(targetPath, before);
  await chmod(targetPath, 0o640);
  const beforeMetadata = await stat(targetPath);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot,
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  const mcpMigrationId = randomUUID();
  const jobDir = join(dataRoot, "mcp", "jobs", mcpMigrationId);
  const backupPath = join(dataRoot, "mcp", "backups", `${sha256Text(before)}.config`);
  await mkdir(jobDir, { recursive: true });
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(join(jobDir, "plan.json"), JSON.stringify(plan));
  await writeFile(backupPath, before);
  await writeFile(join(jobDir, "journal.json"), JSON.stringify({
    schemaVersion: "ide-hub-mcp-journal-v1",
    mcpMigrationId,
    planId: plan.planId,
    status: "APPLYING",
    targetProduct: "cursor",
    targetScope: "user",
    selectedServerIds: [source.servers[0]!.id],
    targetConfigPath: targetPath,
    targetBeforeSha256: sha256Text(before),
    expectedTargetAfterSha256: sha256Text(after),
    targetAfterSha256: null,
    backupPath,
    createdTargetFile: false,
    changed: true,
    beforeMode: beforeMetadata.mode & 0o777,
    beforeUid: beforeMetadata.uid,
    beforeGid: beforeMetadata.gid,
    startedAt: "2026-09-14T01:00:00.000Z",
    completedAt: null,
  }));
  await writeFile(targetPath, after);

  const jobs = await listMcpJobs(options);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "RECOVERED_ROLLBACK");
  assert.equal(jobs[0]?.canRollback, false);
  assert.equal(await readFile(targetPath, "utf8"), before);
  assert.equal((await stat(targetPath)).mode & 0o777, beforeMetadata.mode & 0o777);
  const recoveredJournal = JSON.parse(await readFile(join(jobDir, "journal.json"), "utf8")) as Record<string, unknown>;
  assert.equal(recoveredJournal.status, "RECOVERED_ROLLBACK");
  assert.doesNotMatch(JSON.stringify(recoveredJournal), /sessionId|hubSessionId|conversation|handoff/iu);
});

test("job discovery does not overwrite an externally changed target during recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-recovery-conflict-"));
  const dataRoot = join(root, "ide-hub-data");
  const targetPath = join(root, ".cursor/mcp.json");
  await mkdir(dirname(targetPath), { recursive: true });
  const before = "{\"mcpServers\":{}}\n";
  const expectedAfter = "{\"mcpServers\":{\"selected\":{\"command\":\"/usr/bin/printf\"}}}\n";
  const external = "{\"mcpServers\":{},\"externalChange\":true}\n";
  await writeFile(targetPath, before);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot,
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);
  const mcpMigrationId = randomUUID();
  const jobDir = join(dataRoot, "mcp", "jobs", mcpMigrationId);
  const backupPath = join(dataRoot, "mcp", "backups", `${sha256Text(before)}.config`);
  await mkdir(jobDir, { recursive: true });
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(join(jobDir, "plan.json"), JSON.stringify(plan));
  await writeFile(backupPath, before);
  await writeFile(join(jobDir, "journal.json"), JSON.stringify({
    schemaVersion: "ide-hub-mcp-journal-v1",
    mcpMigrationId,
    planId: plan.planId,
    status: "APPLYING",
    targetProduct: "cursor",
    targetScope: "user",
    selectedServerIds: [source.servers[0]!.id],
    targetConfigPath: targetPath,
    targetBeforeSha256: sha256Text(before),
    expectedTargetAfterSha256: sha256Text(expectedAfter),
    targetAfterSha256: null,
    backupPath,
    createdTargetFile: false,
    changed: true,
    beforeMode: 0o600,
    beforeUid: null,
    beforeGid: null,
    startedAt: "2026-09-14T01:00:00.000Z",
    completedAt: null,
  }));
  await writeFile(targetPath, external);

  const jobs = await listMcpJobs(options);

  assert.equal(jobs[0]?.status, "RECOVERY_CONFLICT");
  assert.equal(jobs[0]?.canRollback, false);
  assert.equal(await readFile(targetPath, "utf8"), external);
});

test("a newly created target is removed by rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-created-target-"));
  const targetPath = join(root, ".cursor/mcp.json");
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);

  assert.equal(plan.targetExisted, false);
  const receipt = await applyMcpMigration(plan, options, source);
  assert.equal(receipt.createdTargetFile, true);
  assert.equal(receipt.backupPath, null);
  assert.match(await readFile(targetPath, "utf8"), /"selected"/u);

  await rollbackMcpMigration(receipt.mcpMigrationId, options);
  await assert.rejects(access(targetPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("a target held open by another process remains atomically migratable and rollback-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-open-target-"));
  const targetPath = join(root, ".cursor/mcp.json");
  const original = "{\n  \"mcpServers\": {},\n  \"heldOpen\": true\n}\n";
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, original);
  const heldDescriptor = await open(targetPath, "r");
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;

  try {
    const plan = await planMcpMigration({
      sourceProduct: "codex",
      targetProduct: "cursor",
      selectedServerIds: [source.servers[0]!.id],
      scope: "user",
      targetScope: "user",
      resolutions: {},
    }, options, source);
    const receipt = await applyMcpMigration(plan, options, source);
    assert.match(await readFile(targetPath, "utf8"), /"selected"/u);
    assert.equal(await heldDescriptor.readFile("utf8"), original);
    await rollbackMcpMigration(receipt.mcpMigrationId, options);
    assert.equal(await readFile(targetPath, "utf8"), original);
  } finally {
    await heldDescriptor.close();
  }
});

test("a target directory permission failure keeps the original config and records its stage", async (context) => {
  if (process.getuid?.() === 0) {
    context.skip("root can bypass the directory permission used by this test");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ide-hub-mcp-permission-"));
  const targetDirectory = join(root, ".cursor");
  const targetPath = join(targetDirectory, "mcp.json");
  const original = "{\n  \"mcpServers\": {},\n  \"permissionFixture\": true\n}\n";
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(targetPath, original);
  const source = sourceSnapshot(root);
  const options = {
    homeDir: root,
    dataRoot: join(root, "ide-hub-data"),
    targetPathOverrides: { cursor: targetPath },
    installedTargetOverrides: { cursor: true },
    skipStdioHandshake: true,
  } as const;
  const plan = await planMcpMigration({
    sourceProduct: "codex",
    targetProduct: "cursor",
    selectedServerIds: [source.servers[0]!.id],
    scope: "user",
    targetScope: "user",
    resolutions: {},
  }, options, source);

  await chmod(targetDirectory, 0o500);
  try {
    await assert.rejects(
      applyMcpMigration(plan, options, source),
      (error: NodeJS.ErrnoException) => error.code === "EACCES",
    );
    assert.equal(await readFile(targetPath, "utf8"), original);
  } finally {
    await chmod(targetDirectory, 0o700);
  }

  const [job] = await listMcpJobs(options);
  assert.equal(job?.status, "ROLLED_BACK_AFTER_FAILURE");
  assert.equal(job?.failure?.stage, "target-write");
  assert.equal(job?.failure?.code, "EACCES");
  assert.match(job?.failure?.message ?? "", /permission denied/iu);
});
