import { MigrationError } from "./errors.js";
import type { MigrationRequest } from "./types.js";

const REQUEST_KEYS = new Set([
  "sourceProduct",
  "targetProduct",
  "sourceThreadId",
  "contextPolicy",
  "dryRun",
]);

export function validateMigrationRequest(value: unknown): MigrationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MigrationError("INVALID_REQUEST", "Migration request must be an object");
  }
  const request = value as Record<string, unknown>;
  const unknown = Object.keys(request).filter((key) => !REQUEST_KEYS.has(key));
  if (unknown.length > 0) {
    throw new MigrationError(
      "INVALID_REQUEST",
      `Unknown migration request field(s): ${unknown.join(", ")}`,
    );
  }
  if (request.sourceProduct !== "codex") {
    throw new MigrationError("INVALID_REQUEST", "sourceProduct must be codex");
  }
  if (
    request.targetProduct !== "qoder-international" &&
    request.targetProduct !== "qoder-cn" &&
    request.targetProduct !== "cursor" &&
    request.targetProduct !== "deepseek-harness" &&
    request.targetProduct !== "zcode" &&
    request.targetProduct !== "pi" &&
    request.targetProduct !== "claude-code" &&
    request.targetProduct !== "codebuddy-international" &&
    request.targetProduct !== "codebuddy-cn"
  ) {
    throw new MigrationError(
      "INVALID_REQUEST",
      "targetProduct must be qoder-international, qoder-cn, cursor, deepseek-harness, zcode, pi, claude-code, codebuddy-international, or codebuddy-cn",
    );
  }
  if (typeof request.sourceThreadId !== "string" || request.sourceThreadId.length === 0) {
    throw new MigrationError("INVALID_REQUEST", "sourceThreadId is required");
  }
  if (request.contextPolicy !== "goal-recent-plan-v1") {
    throw new MigrationError(
      "INVALID_REQUEST",
      "contextPolicy must be goal-recent-plan-v1",
    );
  }
  if (typeof request.dryRun !== "boolean") {
    throw new MigrationError("INVALID_REQUEST", "dryRun must be boolean");
  }
  return request as MigrationRequest;
}
