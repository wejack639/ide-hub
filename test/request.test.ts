import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MigrationError } from "../src/errors.js";
import { validateMigrationRequest } from "../src/request.js";

const valid = {
  sourceProduct: "codex",
  targetProduct: "qoder-international",
  sourceThreadId: "thread-1",
  contextPolicy: "goal-recent-plan-v1",
  dryRun: true,
};

test("migration request accepts the implemented Codex target routes", () => {
  assert.equal(validateMigrationRequest({ ...valid, targetProduct: "claude-code" }).targetProduct, "claude-code");
  assert.equal(validateMigrationRequest({ ...valid, targetProduct: "pi" }).targetProduct, "pi");
  assert.equal(validateMigrationRequest({ ...valid, targetProduct: "zcode" }).targetProduct, "zcode");
  assert.deepEqual(validateMigrationRequest(valid), valid);
  assert.deepEqual(
    validateMigrationRequest({ ...valid, targetProduct: "qoder-cn" }),
    { ...valid, targetProduct: "qoder-cn" },
  );
  assert.deepEqual(
    validateMigrationRequest({ ...valid, targetProduct: "cursor" }),
    { ...valid, targetProduct: "cursor" },
  );
  assert.deepEqual(
    validateMigrationRequest({ ...valid, targetProduct: "deepseek-harness" }),
    { ...valid, targetProduct: "deepseek-harness" },
  );
});

test("migration request rejects an unsupported target product", () => {
  assert.throws(
    () => validateMigrationRequest({ ...valid, targetProduct: "unsupported-product" }),
    (error: unknown) =>
      error instanceof MigrationError && error.code === "INVALID_REQUEST",
  );
});

test("migration request rejects a target workspace override", () => {
  assert.throws(
    () => validateMigrationRequest({ ...valid, targetWorkspace: "/tmp/B" }),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === "INVALID_REQUEST" &&
      error.message.includes("targetWorkspace"),
  );
});

test("migration request rejects model and MCP fields", () => {
  for (const forbidden of ["model", "apiKey", "mcpServers", "mcpMigrationId"]) {
    assert.throws(
      () => validateMigrationRequest({ ...valid, [forbidden]: "forbidden" }),
      (error: unknown) =>
        error instanceof MigrationError && error.code === "INVALID_REQUEST",
    );
  }
});

test("migration schemas expose Cursor and DSH as native targets", async () => {
  const [requestSchema, resultSchema] = await Promise.all(
    [
      "../schemas/session-migration-request-v1.schema.json",
      "../schemas/session-migration-result-v1.schema.json",
    ].map(async (path) =>
      JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")),
    ),
  );
  assert.ok(requestSchema.properties.targetProduct.enum.includes("cursor"));
  assert.ok(requestSchema.properties.targetProduct.enum.includes("claude-code"));
  assert.ok(resultSchema.properties.continuation.properties.product.enum.includes("claude-code"));
  assert.ok(resultSchema.properties.continuation.properties.bundleId.enum.includes("@anthropic-ai/claude-code"));
  assert.ok(requestSchema.properties.targetProduct.enum.includes("pi"));
  assert.ok(resultSchema.properties.continuation.properties.product.enum.includes("pi"));
  assert.ok(resultSchema.properties.continuation.properties.bundleId.enum.includes("@earendil-works/pi-coding-agent"));
  assert.ok(requestSchema.properties.targetProduct.enum.includes("zcode"));
  assert.ok(resultSchema.properties.continuation.properties.bundleId.enum.includes("dev.zcode.app"));
  assert.ok(requestSchema.properties.targetProduct.enum.includes("deepseek-harness"));
  assert.ok(resultSchema.properties.continuation.properties.product.enum.includes("cursor"));
  assert.ok(
    resultSchema.properties.continuation.properties.product.enum.includes(
      "deepseek-harness",
    ),
  );
  assert.ok(
    resultSchema.properties.continuation.properties.bundleId.enum.includes(
      "com.todesktop.230313mzl4w4u92",
    ),
  );
  assert.ok(
    resultSchema.properties.continuation.properties.bundleId.enum.includes(
      "@deepseek-ai/dsh",
    ),
  );
});
