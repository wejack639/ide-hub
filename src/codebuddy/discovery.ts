import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import type {
  CodeBuddyBundleId,
  CodeBuddyInstallation,
  CodeBuddyTargetProduct,
} from "../types.js";
import { sha256File } from "../util/fs.js";

const execFileAsync = promisify(execFile);

export type CodeBuddyProfile = {
  targetProduct: CodeBuddyTargetProduct;
  appName: CodeBuddyInstallation["appName"];
  bundleId: CodeBuddyBundleId;
  version: string;
  productCommit: string;
  applicationName: CodeBuddyInstallation["applicationName"];
  userDataDirectory: "CodeBuddy" | "CodeBuddy CN";
  extensionSha256: string;
  notInstalledCode:
    | "CODEBUDDY_INTERNATIONAL_NOT_INSTALLED"
    | "CODEBUDDY_CN_NOT_INSTALLED";
};

export const CODEBUDDY_PROFILES: Record<CodeBuddyTargetProduct, CodeBuddyProfile> = {
  "codebuddy-international": {
    targetProduct: "codebuddy-international",
    appName: "CodeBuddy.app",
    bundleId: "com.tencent.codebuddy",
    version: "4.12.0",
    productCommit: "b4c35ed08ffb428910211608831a314565c1256e",
    applicationName: "buddy",
    userDataDirectory: "CodeBuddy",
    extensionSha256: "96485062235e7fd75e364e3c742c7fcd289a521e4c3952ad3873b9b0a89b7cb9",
    notInstalledCode: "CODEBUDDY_INTERNATIONAL_NOT_INSTALLED",
  },
  "codebuddy-cn": {
    targetProduct: "codebuddy-cn",
    appName: "CodeBuddy CN.app",
    bundleId: "com.tencent.codebuddycn",
    version: "4.11.2",
    productCommit: "74e2511a9221f313959fc19c58e81bcd78a85950",
    applicationName: "buddycn",
    userDataDirectory: "CodeBuddy CN",
    extensionSha256: "a3276eb57db50f7ffc6249788f73fd8e1c14e64ca834e98f864b432b879eed08",
    notInstalledCode: "CODEBUDDY_CN_NOT_INSTALLED",
  },
};

type CodeBuddyObservedBuild = {
  version: string;
  productCommit: string;
  applicationName: string;
  extensionName: string;
  extensionPublisher: string;
  extensionVersion: string;
  extensionSha256: string;
};

/** 只有经过归档导入与续聊回归的两个本机构建可写入。 */
export function codeBuddyCompatibilityError(
  profile: CodeBuddyProfile,
  observed: CodeBuddyObservedBuild,
): string | null {
  if (observed.version !== profile.version) {
    return `CodeBuddy 版本 ${observed.version} 未验证；当前仅支持 ${profile.version}`;
  }
  if (
    observed.productCommit !== profile.productCommit ||
    observed.applicationName !== profile.applicationName
  ) {
    return `CodeBuddy ${observed.version} 产品构建身份未验证`;
  }
  if (
    observed.extensionName !== "coding-copilot" ||
    observed.extensionPublisher !== "Tencent-Cloud" ||
    observed.extensionVersion !== "3.10.0"
  ) {
    return `CodeBuddy ${observed.version} 内置会话扩展版本未验证`;
  }
  if (observed.extensionSha256 !== profile.extensionSha256) {
    return `CodeBuddy ${observed.version} 内置会话扩展指纹未验证`;
  }
  return null;
}

export async function inspectCodeBuddy(
  targetProduct: CodeBuddyTargetProduct,
): Promise<CodeBuddyInstallation> {
  const profile = CODEBUDDY_PROFILES[targetProduct];
  const candidates = [
    join(homedir(), "Applications", profile.appName),
    join("/Applications", profile.appName),
    ...(await spotlightCandidates(profile.bundleId)),
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
    if (bundleId !== profile.bundleId) continue;
    const extensionRoot = join(
      appPath,
      "Contents",
      "Resources",
      "app",
      "extensions",
      "genie",
    );
    const productPath = join(appPath, "Contents", "Resources", "app", "product.json");
    const extensionPackagePath = join(extensionRoot, "package.json");
    const extensionEntryPath = join(extensionRoot, "out", "extension", "index.js");
    const launcherPath = join(appPath, "Contents", "Resources", "app", "bin", "code");
    let observed: CodeBuddyObservedBuild;
    try {
      const [version, productText, extensionPackageText, extensionSha256] = await Promise.all([
        plistValue(infoPath, "CFBundleShortVersionString"),
        readFile(productPath, "utf8"),
        readFile(extensionPackagePath, "utf8"),
        sha256File(extensionEntryPath),
        access(launcherPath, constants.X_OK),
      ]);
      const product = JSON.parse(productText) as Record<string, unknown>;
      const extensionPackage = JSON.parse(extensionPackageText) as Record<string, unknown>;
      observed = {
        version,
        productCommit: typeof product.commit === "string" ? product.commit : "",
        applicationName: typeof product.applicationName === "string" ? product.applicationName : "",
        extensionName: typeof extensionPackage.name === "string" ? extensionPackage.name : "",
        extensionPublisher: typeof extensionPackage.publisher === "string" ? extensionPackage.publisher : "",
        extensionVersion: typeof extensionPackage.version === "string" ? extensionPackage.version : "",
        extensionSha256,
      };
    } catch (error) {
      observed = {
        version: "unknown",
        productCommit: "",
        applicationName: "",
        extensionName: "",
        extensionPublisher: "",
        extensionVersion: "",
        extensionSha256: "",
      };
      const reason = error instanceof Error ? error.message : String(error);
      return makeInstallation(profile, appPath, observed, `CodeBuddy 安装不完整：${reason}`);
    }
    return makeInstallation(
      profile,
      appPath,
      observed,
      codeBuddyCompatibilityError(profile, observed),
    );
  }
  throw new MigrationError(
    profile.notInstalledCode,
    `${profile.appName} (${profile.bundleId}) 未安装`,
  );
}

export async function discoverCodeBuddy(
  targetProduct: CodeBuddyTargetProduct,
): Promise<CodeBuddyInstallation> {
  const installation = await inspectCodeBuddy(targetProduct);
  if (!installation.compatible) {
    throw new MigrationError(
      "CODEBUDDY_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "CodeBuddy 构建未验证",
      {
        targetProduct,
        appPath: installation.appPath,
        version: installation.version,
        productCommit: installation.productCommit,
        extensionSha256: installation.extensionSha256,
      },
    );
  }
  return installation;
}

/** 使用所选 App 自带 desktop launcher，在当前目标窗口精确打开目录，不传 chat prompt。 */
export function openCodeBuddyWorkspace(
  installation: CodeBuddyInstallation,
  canonicalWorkspace: string,
): void {
  assertInstallation(installation);
  const child = spawn(
    installation.launcherPath,
    ["--reuse-window", canonicalWorkspace],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export async function revealCodeBuddyArchive(path: string): Promise<void> {
  await execFileAsync("/usr/bin/open", ["-R", path]);
}

function makeInstallation(
  profile: CodeBuddyProfile,
  appPath: string,
  observed: CodeBuddyObservedBuild,
  compatibilityError: string | null,
): CodeBuddyInstallation {
  const userDataRoot = join(
    homedir(),
    "Library",
    "Application Support",
    profile.userDataDirectory,
  );
  return {
    targetProduct: profile.targetProduct,
    appPath,
    appName: profile.appName,
    bundleId: profile.bundleId,
    version: observed.version,
    compatible: compatibilityError === null,
    compatibilityError,
    productCommit: observed.productCommit,
    applicationName: profile.applicationName,
    extensionVersion: observed.extensionVersion,
    extensionSha256: observed.extensionSha256,
    launcherPath: join(appPath, "Contents", "Resources", "app", "bin", "code"),
    userDataRoot,
    logsRoot: join(userDataRoot, "logs"),
    historyDataRoot: join(
      homedir(),
      "Library",
      "Application Support",
      "CodeBuddyExtension",
      "Data",
    ),
  };
}

function assertInstallation(installation: CodeBuddyInstallation): void {
  const profile = CODEBUDDY_PROFILES[installation.targetProduct];
  if (
    !installation.compatible ||
    installation.bundleId !== profile.bundleId ||
    installation.applicationName !== profile.applicationName
  ) {
    throw new MigrationError(
      "CODEBUDDY_VERSION_UNSUPPORTED",
      installation.compatibilityError ?? "CodeBuddy 安装身份不匹配",
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

async function spotlightCandidates(bundleId: CodeBuddyBundleId): Promise<string[]> {
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
