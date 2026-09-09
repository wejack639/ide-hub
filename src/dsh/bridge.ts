import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MigrationError, type MigrationErrorCode } from "../errors.js";
import type { DshInstallation, QoderHistoryMessage } from "../types.js";
import { atomicWrite, defaultDataRoot } from "../util/fs.js";
import { DSH_BRIDGE_VERSION, SUPPORTED_DSH_VERSION } from "./discovery.js";
import {
  DSH_SESSION_EVENT_PROTOCOL_VERSION,
  type DshSessionEvent,
} from "./protocol.js";

const execFileAsync = promisify(execFile);

export type DshBridgeOperation =
  | { operation: "probe" }
  | {
      operation: "create";
      sessionId: string;
      migrationKey: string;
      workspace: string;
      agentPreset: "standard";
      title: string;
      seed: DshSessionEvent[];
    }
  | {
      operation: "inspect";
      sessionId: string;
      workspace: string;
      agentPreset: "standard";
      expectedSeed: DshSessionEvent[];
    };

export type DshBridgeProbe = {
  dshVersion: string;
  bridgeVersion: string;
  protocolVersion: string;
  services: Record<string, boolean>;
};

export type DshBridgeInspection = {
  sessionId: string;
  header: {
    version: number;
    id: string;
    createdAt: number;
    cwd?: string;
    seedLength?: number;
    agentPreset?: string;
  };
  workspace: {
    workspaceId: string;
    path: string;
    sessionAttached: boolean;
  };
  eventCount: number;
  eventTypes: string[];
  seedEvents: DshSessionEvent[];
  messages: QoderHistoryMessage[];
  historyVisible: true;
  reused?: boolean;
};

type BridgeResponse<T> = {
  ok: boolean;
  nonce: string;
  bridgeVersion: string;
  protocolVersion: string;
  result?: T;
  error?: { code?: string; message?: string };
};

export async function invokeDshBridge<T>(
  installation: DshInstallation,
  operation: DshBridgeOperation,
  responseDirectory: string,
  options: { timeoutMs?: number; nonce?: string } = {},
): Promise<T> {
  const nonce = options.nonce ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const queueDirectory = join(
    installation.dshHome,
    "ide-hub-bridge",
    "requests-v1",
  );
  const requestPath = join(queueDirectory, `${nonce}.request.json`);
  const responsePath = join(
    responseDirectory,
    `dsh-${operation.operation}-${nonce}.response.json`,
  );
  await atomicWrite(
    requestPath,
    `${JSON.stringify({
      ...operation,
      nonce,
      bridgeVersion: DSH_BRIDGE_VERSION,
      protocolVersion: DSH_SESSION_EVENT_PROTOCOL_VERSION,
      responsePath,
    })}\n`,
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(
        await readFile(responsePath, "utf8"),
      ) as BridgeResponse<T>;
      if (
        response.nonce !== nonce ||
        response.bridgeVersion !== DSH_BRIDGE_VERSION ||
        response.protocolVersion !== DSH_SESSION_EVENT_PROTOCOL_VERSION
      ) {
        throw new MigrationError(
          "DSH_PROTOCOL_UNSUPPORTED",
          "DSH bridge returned a mismatched protocol envelope",
        );
      }
      if (!response.ok) throw dshBridgeError(response.error, operation.operation);
      await rm(requestPath, { force: true });
      return response.result as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  await rm(requestPath, { force: true });
  throw new MigrationError(
    "DSH_BRIDGE_UNAVAILABLE",
    `DSH bridge did not answer the ${operation.operation} request within ${timeoutMs}ms`,
    { requestPath, responsePath },
  );
}

export async function ensureDshRuntime(
  installation: DshInstallation,
  workspace: string,
  artifactsDirectory: string,
): Promise<{ startedNow: boolean; probe: DshBridgeProbe; logPath: string }> {
  const logPath = join(artifactsDirectory, "dsh-web.log");
  try {
    const probe = await invokeDshBridge<DshBridgeProbe>(
      installation,
      { operation: "probe" },
      artifactsDirectory,
      { timeoutMs: 800 },
    );
    assertProbe(probe);
    return { startedNow: false, probe, logPath };
  } catch (error) {
    if (
      error instanceof MigrationError &&
      error.code === "DSH_PROTOCOL_UNSUPPORTED"
    ) {
      throw new MigrationError(
        "DSH_BRIDGE_RESTART_REQUIRED",
        "DeepSeek Harness Web is running an older IDE Hub bridge; close that DSH Web process and retry",
        { causeCode: error.code },
        { cause: error },
      );
    }
    if (
      !(error instanceof MigrationError) ||
      error.code !== "DSH_BRIDGE_UNAVAILABLE"
    ) {
      throw error;
    }
  }

  if (await isDshWebReachable()) {
    throw new MigrationError(
      "DSH_BRIDGE_RESTART_REQUIRED",
      "DeepSeek Harness Web is already running without the enabled IDE Hub bridge; close that DSH Web process and retry",
    );
  }

  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawn(
      installation.executablePath,
      ["web", "--host", "127.0.0.1", "--port", "3080"],
      {
        cwd: workspace,
        detached: true,
        env: {
          ...process.env,
          DSH_HOME: installation.dshHome,
          DSH_TELEMETRY_MODE: "DISABLED",
        },
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    child.unref();
  } finally {
    await log.close();
  }
  const probe = await invokeDshBridge<DshBridgeProbe>(
    installation,
    { operation: "probe" },
    artifactsDirectory,
    { timeoutMs: 25_000 },
  );
  assertProbe(probe);
  return { startedNow: true, probe, logPath };
}

export async function openDshWeb(): Promise<void> {
  await execFileAsync("/usr/bin/open", ["http://127.0.0.1:3080"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function assertProbe(probe: DshBridgeProbe): void {
  const services = [
    "agents",
    "sessions",
    "sessionPersistence",
    "workspaceRegistry",
    "sessionTitle",
    "agentPresets",
  ];
  if (
    probe.dshVersion !== SUPPORTED_DSH_VERSION ||
    probe.bridgeVersion !== DSH_BRIDGE_VERSION ||
    probe.protocolVersion !== DSH_SESSION_EVENT_PROTOCOL_VERSION ||
    services.some((service) => probe.services[service] !== true)
  ) {
    throw new MigrationError(
      "DSH_PROTOCOL_UNSUPPORTED",
      "DSH bridge runtime does not expose the required rc.6 services",
      { probe },
    );
  }
}

function dshBridgeError(
  error: BridgeResponse<unknown>["error"],
  operation: string,
): MigrationError {
  const supported = new Set<MigrationErrorCode>([
    "DSH_PROTOCOL_UNSUPPORTED",
    "DSH_BRIDGE_UNAVAILABLE",
    "DSH_IMPORT_FAILED",
    "TARGET_WORKSPACE_MISMATCH",
    "TARGET_SESSION_NOT_PERSISTED",
    "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
  ]);
  const requestedCode = error?.code as MigrationErrorCode | undefined;
  const code = requestedCode !== undefined && supported.has(requestedCode)
    ? requestedCode
    : "DSH_IMPORT_FAILED";
  return new MigrationError(
    code,
    error?.message ?? `DSH bridge ${operation} failed`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function isDshWebReachable(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:3080/", {
      method: "HEAD",
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function defaultDshBridgeQueueRoot(): string {
  return join(
    process.env.DSH_HOME ?? join(homedir(), ".dsh"),
    "ide-hub-bridge",
    "requests-v1",
  );
}

export function defaultDshRuntimeLogRoot(): string {
  return join(defaultDataRoot(), "dsh");
}
