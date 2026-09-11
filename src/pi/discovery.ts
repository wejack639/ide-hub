import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { sha256File } from "../util/fs.js";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "0.85.1";
export const PI_FINGERPRINTS: Record<string, string> = {
  "dist/core/session-manager.js": "ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3",
  "dist/core/messages.js": "a4e4865e343bf87f8078f75ff179a2a77cd7c2700cf8473476bd4dc5ed36adb6",
  "dist/core/sdk.js": "6969bd56ba8e1628cd033bb15cb15fe38299f00b5ad84f4f8ef37a33a98681c9",
  "node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js": "e51975857b2fefa7e9cc108850ddab5a2fd1753a399f3cde00d76cd700ce6d10",
};
export type PiInstallation = {
  installed: true; compatible: boolean; compatibilityError: string | null;
  version: string; runtimeId: typeof PI_PACKAGE; packageRoot: string; cliPath: string; nodePath: string;
  agentDir: string; sessionDir?: string; fingerprints: Record<string, string>;
};

export function piAbsolutePath(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new MigrationError("PI_VERSION_UNSUPPORTED", "Pi 配置目录必须是绝对路径");
  return resolve(expanded);
}

/** 纯路径计算，不调用 SDK 中会 mkdir 的目录 helper。 */
export function piSessionDirectory(workspace: string, agentDir: string, override?: string): string {
  return override ? piAbsolutePath(override) : join(agentDir, "sessions", `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

function findExecutable(name: string): string | undefined {
  const directories = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  return directories.filter(p => isAbsolute(p)).map(p => join(p, name)).find(existsSync);
}

/** 仅检查本地安装与指纹；未知版本/缺少 Node 不自动安装或升级。 */
export async function inspectPi(options: { executablePath?: string; agentDir?: string; sessionDir?: string } = {}): Promise<PiInstallation> {
  const executable = options.executablePath ?? findExecutable("pi");
  if (!executable || !existsSync(executable)) throw new MigrationError("PI_NOT_INSTALLED", "未发现 Pi，请先安装官方 @earendil-works/pi-coding-agent");
  const cliPath = await realpath(executable);
  let packageRoot = dirname(cliPath);
  let pkg: { name?: string; version?: string } = {};
  for (;;) {
    const path = join(packageRoot, "package.json");
    if (existsSync(path)) {
      pkg = JSON.parse(await readFile(path, "utf8"));
      if (pkg.name?.endsWith("/pi-coding-agent")) break;
    }
    if (dirname(packageRoot) === packageRoot) throw new MigrationError("PI_NOT_INSTALLED", "未发现命令对应的 Pi npm 安装包");
    packageRoot = dirname(packageRoot);
  }
  const nodePath = findExecutable("node") ?? (!process.versions.electron ? process.execPath : "");
  const agentDir = piAbsolutePath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
  const sessionDir = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  const fingerprints: Record<string, string> = {};
  let compatibilityError: string | null = null;
  try {
    if (pkg.name !== PI_PACKAGE || pkg.version !== PI_VERSION) throw new Error(`当前支持 ${PI_PACKAGE}@${PI_VERSION}，发现 ${pkg.name}@${pkg.version}`);
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new Error("当前 Pi writer 需要 macOS 离线进程隔离运行时");
    if (!nodePath) throw new Error("未发现 Node ≥22.19.0，不能启动 Pi SDK");
    const { stdout } = await promisify(execFile)(nodePath, ["--version"]);
    const [major = 0, minor = 0] = stdout.trim().replace(/^v/, "").split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error(`Pi 需要 Node ≥22.19.0，发现 ${stdout.trim()}`);
    for (const [path, expected] of Object.entries(PI_FINGERPRINTS)) {
      fingerprints[path] = await sha256File(join(packageRoot, path));
      if (fingerprints[path] !== expected) throw new Error(`Pi ${path} 指纹不兼容，未开放写入`);
    }
  } catch (error) { compatibilityError = error instanceof Error ? error.message : String(error); }
  return { installed: true, compatible: compatibilityError === null, compatibilityError, version: pkg.version ?? "unknown",
    runtimeId: PI_PACKAGE, packageRoot, cliPath, nodePath, agentDir,
    ...(sessionDir ? { sessionDir: piAbsolutePath(sessionDir) } : {}), fingerprints };
}
