import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { MigrationError } from "../errors.js";
import type {
  QoderBundleId,
  QoderInstallation,
  QoderTargetProduct,
} from "../types.js";

const execFileAsync = promisify(execFile);

type QoderTargetDescriptor = {
  product: QoderTargetProduct;
  bundleId: QoderBundleId;
  appNames: string[];
  dataDirectory: "Qoder" | "QoderCN";
  socketName: "qoder.sock" | "qodercn.sock";
  notInstalledCode: "QODER_INTERNATIONAL_NOT_INSTALLED" | "QODER_CN_NOT_INSTALLED";
  displayName: string;
};

const TARGETS: Record<QoderTargetProduct, QoderTargetDescriptor> = {
  "qoder-international": {
    product: "qoder-international",
    bundleId: "com.qoder.ide",
    appNames: ["Qoder IDE.app", "Qoder.app"],
    dataDirectory: "Qoder",
    socketName: "qoder.sock",
    notInstalledCode: "QODER_INTERNATIONAL_NOT_INSTALLED",
    displayName: "Qoder IDE International",
  },
  "qoder-cn": {
    product: "qoder-cn",
    bundleId: "com.aliyun.lingma.ide",
    appNames: ["Qoder CN IDE.app"],
    dataDirectory: "QoderCN",
    socketName: "qodercn.sock",
    notInstalledCode: "QODER_CN_NOT_INSTALLED",
    displayName: "Qoder CN IDE",
  },
};

export async function discoverQoderInternational(): Promise<QoderInstallation> {
  return discoverQoder("qoder-international");
}

export async function discoverQoderCn(): Promise<QoderInstallation> {
  return discoverQoder("qoder-cn");
}

export async function discoverQoder(
  product: QoderTargetProduct,
): Promise<QoderInstallation> {
  const target = TARGETS[product];
  const candidates = [
    ...target.appNames.map((name) => join(homedir(), "Applications", name)),
    ...target.appNames.map((name) => join("/Applications", name)),
    ...(await spotlightCandidates(target.bundleId)),
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
    if (bundleId !== target.bundleId) continue;
    const version = await plistValue(infoPath, "CFBundleShortVersionString");
    return {
      targetProduct: target.product,
      appPath,
      bundleId: target.bundleId,
      version,
      dataRoot: join(
        homedir(),
        "Library",
        "Application Support",
        target.dataDirectory,
        "SharedClientCache",
      ),
      socketName: target.socketName,
    };
  }

  throw new MigrationError(
    target.notInstalledCode,
    `${target.displayName} (${target.bundleId}) is not installed`,
  );
}

export function openQoderWorkspace(
  installation: QoderInstallation,
  canonicalWorkspace: string,
): void {
  const target = TARGETS[installation.targetProduct];
  if (installation.bundleId !== target.bundleId) {
    throw new MigrationError(
      "QODER_CN_SELECTED",
      `Refusing to launch mismatched Qoder bundle: ${installation.bundleId}`,
    );
  }
  const child = spawn("/usr/bin/open", ["-a", installation.appPath, canonicalWorkspace], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function plistValue(path: string, key: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", path],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

async function spotlightCandidates(bundleId: QoderBundleId): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
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
