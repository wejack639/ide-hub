import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationError, type MigrationErrorCode } from "../errors.js";
import type { CursorInstallation } from "../types.js";
import { atomicWrite, defaultDataRoot } from "../util/fs.js";

const execFileAsync = promisify(execFile);

export const CURSOR_BRIDGE_EXTENSION_ID = "ide-hub.cursor-session-bridge";
export const CURSOR_BRIDGE_VERSION = "0.7.0";

export type CursorBridgeOperation =
  | { operation: "probe" }
  | { operation: "import"; importDirectory: string }
  | { operation: "open"; composerId: string };

type BridgeResponse<T> = {
  ok: boolean;
  nonce: string;
  workspace?: string;
  result?: T;
  error?: { code?: string; message?: string };
};

export async function ensureCursorBridge(
  installation: CursorInstallation,
): Promise<{
  extensionId: string;
  version: string;
  vsixPath: string;
  installedNow: boolean;
}> {
  const expected = `${CURSOR_BRIDGE_EXTENSION_ID}@${CURSOR_BRIDGE_VERSION}`;
  if ((await listExtensions(installation)).includes(expected)) {
    return {
      extensionId: CURSOR_BRIDGE_EXTENSION_ID,
      version: CURSOR_BRIDGE_VERSION,
      vsixPath: await bridgeVsixPath(),
      installedNow: false,
    };
  }

  const vsixPath = await packageBridgeVsix();
  try {
    await execFileAsync(
      installation.cliPath,
      ["--install-extension", vsixPath, "--force"],
      { encoding: "utf8", timeout: 30_000 },
    );
  } catch (error) {
    throw new MigrationError(
      "CURSOR_BRIDGE_INSTALL_FAILED",
      "Failed to install the bundled local Cursor session bridge",
      { extensionId: CURSOR_BRIDGE_EXTENSION_ID, vsixPath },
      { cause: error },
    );
  }
  if (!(await listExtensions(installation)).includes(expected)) {
    throw new MigrationError(
      "CURSOR_BRIDGE_INSTALL_FAILED",
      `Cursor did not report ${expected} after local installation`,
      { vsixPath },
    );
  }
  return {
    extensionId: CURSOR_BRIDGE_EXTENSION_ID,
    version: CURSOR_BRIDGE_VERSION,
    vsixPath,
    installedNow: true,
  };
}

export async function invokeCursorBridge<T>(
  installation: CursorInstallation,
  expectedWorkspace: string,
  operation: CursorBridgeOperation,
  requestDirectory: string,
  options: { timeoutMs?: number; nonce?: string } = {},
): Promise<T> {
  const nonce = options.nonce ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const operationName = operation.operation;
  const queueDirectory = join(
    homedir(),
    "Library",
    "Application Support",
    "IDE Hub",
    "cursor",
    `bridge-requests-v${CURSOR_BRIDGE_VERSION}`,
  );
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
  const requestPath = join(queueDirectory, `${nonce}.request.json`);
  const responsePath = join(requestDirectory, `cursor-${operationName}-${nonce}.response.json`);
  const request = {
    ...operation,
    nonce,
    bridgeVersion: CURSOR_BRIDGE_VERSION,
    expectedWorkspace,
    expectedUserDataRoot: installation.userDataRoot,
    responsePath,
  };
  await atomicWrite(requestPath, `${JSON.stringify(request)}\n`);
  await wakeCursorBridge(installation, requestPath, nonce);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(
        await readFile(responsePath, "utf8"),
      ) as BridgeResponse<T>;
      if (response.nonce !== nonce) {
        throw new MigrationError(
          "CURSOR_BRIDGE_UNAVAILABLE",
          "Cursor bridge returned a response with the wrong nonce",
        );
      }
      if (!response.ok) {
        throw bridgeError(response.error, operationName);
      }
      if (response.workspace !== expectedWorkspace) {
        throw new MigrationError(
          "TARGET_WORKSPACE_MISMATCH",
          `Cursor bridge used ${response.workspace ?? "an unknown workspace"}; expected ${expectedWorkspace}`,
        );
      }
      await rm(requestPath, { force: true });
      return response.result as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(200);
  }
  await rm(requestPath, { force: true });
  throw new MigrationError(
    "CURSOR_BRIDGE_UNAVAILABLE",
    `Cursor bridge did not answer the ${operationName} request within ${timeoutMs}ms`,
    { requestPath, responsePath },
  );
}

async function wakeCursorBridge(
  installation: CursorInstallation,
  requestPath: string,
  nonce: string,
): Promise<void> {
  const uri =
    `cursor://${CURSOR_BRIDGE_EXTENSION_ID}/request` +
    `?request=${encodeURIComponent(requestPath)}` +
    `&nonce=${encodeURIComponent(nonce)}`;
  try {
    await execFileAsync("/usr/bin/open", ["-b", installation.bundleId, uri], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    // An already-active bridge will still claim the filesystem queue request.
  }
}

export async function removeCursorBridgeRequestFiles(
  requestDirectory: string,
): Promise<void> {
  // Full conversations live only in the short-lived import payload. Request and
  // response files contain paths/ids only and are retained in the journal folder.
  await rm(join(requestDirectory, "cursor-import"), { recursive: true, force: true });
}

async function listExtensions(installation: CursorInstallation): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      installation.cliPath,
      ["--list-extensions", "--show-versions"],
      { encoding: "utf8", timeout: 30_000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
  } catch (error) {
    throw new MigrationError(
      "CURSOR_BRIDGE_INSTALL_FAILED",
      "Cursor desktop CLI could not list installed IDE extensions",
      { cliPath: installation.cliPath },
      { cause: error },
    );
  }
}

async function packageBridgeVsix(): Promise<string> {
  const source = await bridgeSourceDirectory();
  const output = await bridgeVsixPath();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await rm(output, { force: true });
  try {
    await execFileAsync(
      "/usr/bin/zip",
      [
        "-q",
        "-r",
        output,
        "extension",
        "extension.vsixmanifest",
        "[Content_Types].xml",
      ],
      { cwd: source, encoding: "utf8", timeout: 30_000 },
    );
  } catch (error) {
    throw new MigrationError(
      "CURSOR_BRIDGE_INSTALL_FAILED",
      "Failed to package the bundled Cursor session bridge",
      { source, output },
      { cause: error },
    );
  }
  return output;
}

async function bridgeSourceDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.IDE_HUB_CURSOR_BRIDGE_DIR,
    resolve(process.cwd(), "cursor-bridge"),
    resolve(moduleDirectory, "../../cursor-bridge"),
    resolve(moduleDirectory, "../../../cursor-bridge"),
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .flatMap((candidate) => [
      candidate,
      candidate.replace("app.asar", "app.asar.unpacked"),
    ]);
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "extension", "package.json"));
      await access(join(candidate, "extension.vsixmanifest"));
      return candidate;
    } catch {
      // Continue to the next packaged/development location.
    }
  }
  throw new MigrationError(
    "CURSOR_BRIDGE_INSTALL_FAILED",
    "Bundled Cursor session bridge assets are missing",
    { candidates },
  );
}

async function bridgeVsixPath(): Promise<string> {
  return join(
    defaultDataRoot(),
    "cursor",
    "bridge",
    `${CURSOR_BRIDGE_EXTENSION_ID}-${CURSOR_BRIDGE_VERSION}.vsix`,
  );
}

function bridgeError(
  error: BridgeResponse<unknown>["error"],
  operation: string,
): MigrationError {
  const supportedCodes = new Set<MigrationErrorCode>([
    "CURSOR_PROTOCOL_UNSUPPORTED",
    "CURSOR_BRIDGE_UNAVAILABLE",
    "CURSOR_IMPORT_FAILED",
    "TARGET_WORKSPACE_MISMATCH",
    "TARGET_SESSION_NOT_PERSISTED",
  ]);
  const requestedCode = error?.code as MigrationErrorCode | undefined;
  const code =
    requestedCode !== undefined && supportedCodes.has(requestedCode)
      ? requestedCode
      : "CURSOR_BRIDGE_UNAVAILABLE";
  return new MigrationError(
    code,
    error?.message ?? `Cursor bridge ${operation} failed`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
