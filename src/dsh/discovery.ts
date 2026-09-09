import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import type { DshCoreFingerprints, DshInstallation } from "../types.js";
import { atomicWrite, sha256File } from "../util/fs.js";

const execFileAsync = promisify(execFile);

export const DSH_RUNTIME_ID = "@deepseek-ai/dsh" as const;
export const SUPPORTED_DSH_VERSION = "0.1.0-rc.6";
export const DSH_BRIDGE_PACKAGE = "@ide-hub/dsh-session-bridge";
export const DSH_BRIDGE_VERSION = "0.3.0";
export const SUPPORTED_DSH_FINGERPRINTS: DshCoreFingerprints = {
  cli: "c0226687bb20f45c603ec6fe50f3de16d1c3510c3a803304ec575ef9bc366c62",
  session: "9270186b579bc8a4c6c53c256e4471d3f134e94308462c6a413a722e9c7556fb",
  agent: "e7e40c5ca66d9827a5084c5c0c68983f9685842bb9b6d604803d4cb4642bb263",
  persistence: "8b6ebc4509a3e969ab3ad6e0dfb553ae4861e5b101831afed23e593d148d97f3",
  workspace: "d53e71d931937066ff20440afcff911ced09cefb8a0f3d024348b0e5248d4c74",
};

type DshProfileManifest = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
  [key: string]: unknown;
};

export async function inspectDsh(): Promise<DshInstallation> {
  const executablePath = await findDshExecutable();
  const executableRealPath = await realpath(executablePath);
  const packageRoot = resolve(dirname(executableRealPath), "..");
  const version = await dshVersion(executablePath);
  const fingerprints = await readDshFingerprints(packageRoot);
  const compatibilityError = dshCompatibilityError(version, fingerprints);
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const webProfileRoot = join(dshHome, "profiles", "web");
  await access(join(webProfileRoot, "package.json"), constants.R_OK);
  const bridge = await inspectBridge(dshHome, webProfileRoot);
  return {
    targetProduct: "deepseek-harness",
    runtimeId: DSH_RUNTIME_ID,
    executablePath,
    packageRoot,
    version,
    compatible: compatibilityError === null,
    compatibilityError,
    fingerprints,
    dshHome,
    webProfileRoot,
    bridgeInstalled: bridge.installed,
    bridgeVersion: bridge.version,
    bridgeCompatible: bridge.compatible,
  };
}

export async function discoverDsh(): Promise<DshInstallation> {
  const installation = await inspectDsh();
  if (!installation.compatible) {
    throw new MigrationError(
      "DSH_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "DeepSeek Harness is unsupported",
      {
        executablePath: installation.executablePath,
        version: installation.version,
        fingerprints: installation.fingerprints,
      },
    );
  }
  if (!installation.bridgeInstalled || !installation.bridgeCompatible) {
    throw new MigrationError(
      "DSH_BRIDGE_INSTALL_FAILED",
      "The IDE Hub DSH bridge is not enabled in the web profile",
      { webProfileRoot: installation.webProfileRoot },
    );
  }
  return installation;
}

export function dshCompatibilityError(
  version: string,
  fingerprints: DshCoreFingerprints,
): string | null {
  if (version !== SUPPORTED_DSH_VERSION) {
    return `DeepSeek Harness ${version} is not supported; required ${SUPPORTED_DSH_VERSION}`;
  }
  for (const key of Object.keys(SUPPORTED_DSH_FINGERPRINTS) as Array<
    keyof DshCoreFingerprints
  >) {
    if (fingerprints[key] !== SUPPORTED_DSH_FINGERPRINTS[key]) {
      return `DeepSeek Harness ${version} ${key} package fingerprint is not supported`;
    }
  }
  return null;
}

export function updateDshProfileManifest(
  manifest: DshProfileManifest,
): DshProfileManifest & {
  dependencies: Record<string, string>;
  dsh: { profile: { bundles: string[] } };
} {
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    [DSH_BRIDGE_PACKAGE]: DSH_BRIDGE_VERSION,
  };
  const existingBundles = manifest.dsh?.profile?.bundles ?? [];
  const bundles = existingBundles.includes(DSH_BRIDGE_PACKAGE)
    ? [...existingBundles]
    : [...existingBundles, DSH_BRIDGE_PACKAGE];
  return {
    ...manifest,
    dependencies,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles,
      },
    },
  };
}

export async function ensureDshBridge(
  installation: DshInstallation,
): Promise<{
  packageName: typeof DSH_BRIDGE_PACKAGE;
  version: typeof DSH_BRIDGE_VERSION;
  installedNow: boolean;
  profileRestartRequired: boolean;
}> {
  if (!installation.compatible) {
    throw new MigrationError(
      "DSH_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "DeepSeek Harness is unsupported",
    );
  }
  if (installation.bridgeInstalled && installation.bridgeCompatible) {
    return {
      packageName: DSH_BRIDGE_PACKAGE,
      version: DSH_BRIDGE_VERSION,
      installedNow: false,
      profileRestartRequired: false,
    };
  }

  const source = await dshBridgeSourceDirectory();
  const target = join(
    installation.dshHome,
    "profiles",
    "node_modules",
    "@ide-hub",
    "dsh-session-bridge",
  );
  const files = ["package.json", "cordis.patch.yml", join("lib", "index.js")];
  try {
    for (const relativePath of files) {
      const content = await readFile(join(source, relativePath));
      await atomicWrite(join(target, relativePath), content);
    }
    const profileManifestPath = join(installation.webProfileRoot, "package.json");
    const profileManifest = JSON.parse(
      await readFile(profileManifestPath, "utf8"),
    ) as DshProfileManifest;
    const updated = updateDshProfileManifest(profileManifest);
    await atomicWrite(profileManifestPath, `${JSON.stringify(updated, null, 2)}\n`);
    await mkdir(join(installation.dshHome, "ide-hub-bridge", "requests-v1"), {
      recursive: true,
      mode: 0o700,
    });
  } catch (error) {
    throw new MigrationError(
      "DSH_BRIDGE_INSTALL_FAILED",
      "Failed to install the bundled IDE Hub bridge into the DSH web profile",
      { source, target, webProfileRoot: installation.webProfileRoot },
      { cause: error },
    );
  }

  const verified = await inspectDsh();
  if (!verified.bridgeInstalled || !verified.bridgeCompatible) {
    throw new MigrationError(
      "DSH_BRIDGE_INSTALL_FAILED",
      "DSH web profile did not report the exact bundled bridge after installation",
      { target, webProfileRoot: installation.webProfileRoot },
    );
  }
  return {
    packageName: DSH_BRIDGE_PACKAGE,
    version: DSH_BRIDGE_VERSION,
    installedNow: true,
    profileRestartRequired: true,
  };
}

async function findDshExecutable(): Promise<string> {
  const candidates = [
    process.env.IDE_HUB_DSH_BIN,
    "/opt/homebrew/bin/dsh",
    "/usr/local/bin/dsh",
  ].filter((candidate): candidate is string => typeof candidate === "string");
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next known local installation path.
    }
  }
  throw new MigrationError(
    "DSH_NOT_INSTALLED",
    "DeepSeek Harness executable was not found",
    { candidates },
  );
}

async function dshVersion(executablePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return stdout.trim();
  } catch (error) {
    throw new MigrationError(
      "DSH_NOT_INSTALLED",
      "DeepSeek Harness version could not be read",
      { executablePath },
      { cause: error },
    );
  }
}

async function readDshFingerprints(
  packageRoot: string,
): Promise<DshCoreFingerprints> {
  const packageFile = (name: string) =>
    join(packageRoot, "node_modules", "@deepseek-ai", name, "lib", "index.js");
  try {
    return {
      cli: await sha256File(join(packageRoot, "lib", "bin.js")),
      session: await sha256File(packageFile("dsh-session")),
      agent: await sha256File(packageFile("dsh-agent")),
      persistence: await sha256File(packageFile("dsh-session-persistence-jsonl")),
      workspace: await sha256File(packageFile("dsh-workspace")),
    };
  } catch (error) {
    throw new MigrationError(
      "DSH_VERSION_UNSUPPORTED",
      "DeepSeek Harness rc.6 package graph is incomplete",
      { packageRoot },
      { cause: error },
    );
  }
}

async function inspectBridge(
  dshHome: string,
  webProfileRoot: string,
): Promise<{ installed: boolean; version: string | null; compatible: boolean }> {
  const target = join(
    dshHome,
    "profiles",
    "node_modules",
    "@ide-hub",
    "dsh-session-bridge",
  );
  try {
    const [profile, installedPackage, source] = await Promise.all([
      readFile(join(webProfileRoot, "package.json"), "utf8"),
      readFile(join(target, "package.json"), "utf8"),
      dshBridgeSourceDirectory(),
    ]);
    const profileManifest = JSON.parse(profile) as DshProfileManifest;
    const bridgeManifest = JSON.parse(installedPackage) as { version?: string };
    const enabled =
      profileManifest.dsh?.profile?.bundles?.includes(DSH_BRIDGE_PACKAGE) === true;
    const [sourceCode, installedCode, sourcePatch, installedPatch] =
      await Promise.all([
        sha256File(join(source, "lib", "index.js")),
        sha256File(join(target, "lib", "index.js")),
        sha256File(join(source, "cordis.patch.yml")),
        sha256File(join(target, "cordis.patch.yml")),
      ]);
    return {
      installed: enabled,
      version: bridgeManifest.version ?? null,
      compatible:
        enabled &&
        bridgeManifest.version === DSH_BRIDGE_VERSION &&
        sourceCode === installedCode &&
        sourcePatch === installedPatch,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { installed: false, version: null, compatible: false };
    }
    throw error;
  }
}

async function dshBridgeSourceDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.IDE_HUB_DSH_BRIDGE_DIR,
    resolve(process.cwd(), "dsh-bridge"),
    resolve(moduleDirectory, "../../dsh-bridge"),
    resolve(moduleDirectory, "../../../dsh-bridge"),
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .flatMap((candidate) => [
      candidate,
      candidate.replace("app.asar", "app.asar.unpacked"),
    ]);
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "package.json"), constants.R_OK);
      await access(join(candidate, "cordis.patch.yml"), constants.R_OK);
      await access(join(candidate, "lib", "index.js"), constants.R_OK);
      return candidate;
    } catch {
      // Continue to the next development or packaged bridge directory.
    }
  }
  throw new MigrationError(
    "DSH_BRIDGE_INSTALL_FAILED",
    "Bundled DSH session bridge assets are missing",
    { candidates },
  );
}
