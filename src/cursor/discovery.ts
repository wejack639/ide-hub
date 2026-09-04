import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import type { CursorInstallation } from "../types.js";
import { sha256File } from "../util/fs.js";

const execFileAsync = promisify(execFile);

export const CURSOR_BUNDLE_ID = "com.todesktop.230313mzl4w4u92" as const;
export const SUPPORTED_CURSOR_VERSION = "3.18.9";
export const SUPPORTED_CURSOR_WORKBENCH_SHA256 =
  "519a4800d3a3f6f7ab228681a202ef26cfe07ef991dd460aa82ca8145ecbb4eb";
export const CURSOR_IMPORT_COMMAND = "developer.bulkImportChats";
export const CURSOR_OPEN_COMPOSER_COMMAND = "composer.openComposer";

export async function inspectCursor(): Promise<CursorInstallation> {
  const candidates = [
    join(homedir(), "Applications", "Cursor.app"),
    join("/Applications", "Cursor.app"),
    ...(await spotlightCandidates()),
  ];
  const seen = new Set<string>();
  for (const appPath of candidates) {
    if (seen.has(appPath)) continue;
    seen.add(appPath);
    const infoPath = join(appPath, "Contents", "Info.plist");
    try {
      await access(infoPath, constants.R_OK);
    } catch {
      continue;
    }
    const bundleId = await plistValue(infoPath, "CFBundleIdentifier");
    if (bundleId !== CURSOR_BUNDLE_ID) continue;
    const version = await plistValue(infoPath, "CFBundleShortVersionString");
    const workbenchPath = join(
      appPath,
      "Contents",
      "Resources",
      "app",
      "out",
      "vs",
      "workbench",
      "workbench.desktop.main.js",
    );
    const cliPath = join(appPath, "Contents", "Resources", "app", "bin", "cursor");
    await access(workbenchPath, constants.R_OK);
    await access(cliPath, constants.R_OK);
    const [workbenchSha256, workbench] = await Promise.all([
      sha256File(workbenchPath),
      readFile(workbenchPath, "utf8"),
    ]);
    const compatibilityError = cursorCompatibilityError(
      version,
      workbenchSha256,
      workbench,
    );
    const userDataRoot = join(homedir(), "Library", "Application Support", "Cursor");
    return {
      targetProduct: "cursor",
      appPath,
      bundleId: CURSOR_BUNDLE_ID,
      version,
      compatible: compatibilityError === null,
      compatibilityError,
      workbenchPath,
      workbenchSha256,
      cliPath,
      userDataRoot,
      workspaceStorageRoot: join(userDataRoot, "User", "workspaceStorage"),
      globalStorageDatabase: join(
        userDataRoot,
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    };
  }
  throw new MigrationError(
    "CURSOR_NOT_INSTALLED",
    `Cursor (${CURSOR_BUNDLE_ID}) is not installed`,
  );
}

export async function discoverCursor(): Promise<CursorInstallation> {
  const installation = await inspectCursor();
  if (!installation.compatible) {
    throw new MigrationError(
      "CURSOR_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "Cursor version is unsupported",
      {
        appPath: installation.appPath,
        version: installation.version,
        workbenchSha256: installation.workbenchSha256,
      },
    );
  }
  return installation;
}

export function cursorCompatibilityError(
  version: string,
  workbenchSha256: string,
  workbench: string,
): string | null {
  if (version !== SUPPORTED_CURSOR_VERSION) {
    return `Cursor ${version} is not supported; required ${SUPPORTED_CURSOR_VERSION}`;
  }
  if (workbenchSha256 !== SUPPORTED_CURSOR_WORKBENCH_SHA256) {
    return `Cursor ${version} workbench fingerprint is not supported`;
  }
  if (!workbench.includes(CURSOR_IMPORT_COMMAND)) {
    return `Cursor ${version} does not expose ${CURSOR_IMPORT_COMMAND}`;
  }
  if (!workbench.includes(CURSOR_OPEN_COMPOSER_COMMAND)) {
    return `Cursor ${version} does not expose ${CURSOR_OPEN_COMPOSER_COMMAND}`;
  }
  return null;
}

export function openCursorWorkspace(
  installation: CursorInstallation,
  canonicalWorkspace: string,
): void {
  assertCompatible(installation);
  const child = spawn(
    installation.cliPath,
    ["--new-window", "--suppress-popups-on-startup", canonicalWorkspace],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export async function openCursorUri(
  installation: CursorInstallation,
  uri: string,
): Promise<void> {
  assertCompatible(installation);
  await execFileAsync("/usr/bin/open", ["-a", installation.appPath, uri]);
}

function assertCompatible(installation: CursorInstallation): void {
  if (installation.bundleId !== CURSOR_BUNDLE_ID || !installation.compatible) {
    throw new MigrationError(
      "CURSOR_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "Cursor installation is not compatible",
    );
  }
}

async function plistValue(path: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", path],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

async function spotlightCandidates(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${CURSOR_BUNDLE_ID}'`],
      { encoding: "utf8" },
    );
    return stdout
      .split("\n")
      .map((path) => path.trim())
      .filter((path) => path.endsWith(".app"));
  } catch {
    return [];
  }
}
