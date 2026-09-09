#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { asMigrationError } from "./errors.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { listCodexThreads } from "./codex/reader.js";
import { runMigration } from "./migration.js";
import { validateMigrationRequest } from "./request.js";
import { stablePrettyJson } from "./util/stable-json.js";

const USAGE = `Usage:
  ide-hub session list --source codex
  ide-hub session migrate --source codex --target <qoder-international|qoder-cn|cursor|deepseek-harness> --thread <thread-id> [--dry-run]

The target workspace is always derived from the Codex thread cwd. There is no target cwd option.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    if (argv[0] === "session" && argv[1] === "list") {
      return await listSourceSessions(argv.slice(2));
    }
    const request = parseArguments(argv);
    const result = await runMigration(request);
    process.stdout.write(stablePrettyJson(result));
    return 0;
  } catch (error) {
    const migrationError = asMigrationError(error);
    process.stderr.write(
      stablePrettyJson({
        status: "FAILED",
        error: {
          code: migrationError.code,
          message: migrationError.message,
          details: migrationError.details ?? null,
        },
      }),
    );
    return 1;
  }
}

async function listSourceSessions(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--source" || argv[1] !== "codex") {
    throw new Error("Usage: ide-hub session list --source codex");
  }
  const codex = new CodexAppServerClient();
  try {
    await codex.start();
    const threads = await listCodexThreads(codex);
    process.stdout.write(
      stablePrettyJson({
        sourceProduct: "codex",
        threads: threads.map((thread) => ({
          id: thread.id,
          cwd: thread.cwd,
          name: thread.name,
          preview: thread.preview,
          status: thread.status,
          historyMode: thread.historyMode,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        })),
      }),
    );
    return 0;
  } finally {
    await codex.close();
  }
}

function parseArguments(argv: string[]) {
  if (argv[0] !== "session" || argv[1] !== "migrate") {
    throw new Error(USAGE.trim());
  }
  const values: Record<string, string | boolean> = { dryRun: false };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (argument === "--source" || argument === "--target" || argument === "--thread") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      const key = argument.slice(2);
      values[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(argument)}`);
  }
  return validateMigrationRequest({
    sourceProduct: values.source,
    targetProduct: values.target,
    sourceThreadId: values.thread,
    contextPolicy: "goal-recent-plan-v1",
    dryRun: values.dryRun,
  });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
