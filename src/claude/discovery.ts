import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { sha256File } from "../util/fs.js";

export const CLAUDE_VERSION = "2.1.170";
export const CLAUDE_RUNTIME_ID = "@anthropic-ai/claude-code";
export const CLAUDE_SDK_VERSION = "0.3.170";
export const CLAUDE_BINARY_SHA256 = "e903646d8b7a31882a80ecd27569a27d8ac57b3708745f349709632c84117fdf";
export const CLAUDE_SDK_SHA256 = "df0b264f1cc6e147cf6de071a994f859b2be736fc83ff13ce54533a5328d48a9";
export const CLAUDE_OFFLINE_POLICY = "(version 1)(allow default)(deny network*)";
export type ClaudeInstallation = {
  installed: true; compatible: boolean; compatibilityError: string | null; version: string;
  runtimeId: typeof CLAUDE_RUNTIME_ID; cliPath: string; nodePath: string; configDir: string; configDirExplicit: boolean;
  sdkPath: string; fingerprints: Record<string, string>;
};

export function claudeConfigDirectory(value = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string {
  const path = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new MigrationError("CLAUDE_VERSION_UNSUPPORTED", "Claude 配置目录必须是绝对路径");
  return resolve(path).normalize("NFC");
}

/** 与固定 SDK 的 So/Oy 相同；不能套用 Pi 的目录编码。 */
export function claudeProjectKey(workspace: string): string {
  const encoded = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < workspace.length; i++) hash = ((hash << 5) - hash + workspace.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function executable(name: string): string | undefined {
  const paths = [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  return paths.filter(isAbsolute).map(p => join(p, name)).find(existsSync);
}

/** 发现只读；不运行登录、doctor、模型或安装/升级命令。 */
export async function inspectClaude(options: { executablePath?: string; configDir?: string } = {}): Promise<ClaudeInstallation> {
  const candidate = options.executablePath ?? executable("claude");
  if (!candidate || !existsSync(candidate)) throw new MigrationError("CLAUDE_NOT_INSTALLED", "未发现 Claude Code，请先安装官方 Claude Code");
  const cliPath = await realpath(candidate);
  const configDir = claudeConfigDirectory(options.configDir);
  const configDirExplicit = options.configDir !== undefined || process.env.CLAUDE_CONFIG_DIR !== undefined;
  const nodePath = executable("node") ?? "";
  let sdkPath = "", version = "unknown", compatibilityError: string | null = null;
  const fingerprints: Record<string, string> = {};
  try {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new Error("当前 Claude writer 仅支持已验证的 macOS 离线运行环境");
    const { stdout } = await promisify(execFile)("/usr/bin/sandbox-exec", ["-p", CLAUDE_OFFLINE_POLICY, cliPath, "--version"]);
    version = stdout.trim().split(/\s/)[0] ?? "unknown";
    if (version !== CLAUDE_VERSION) throw new Error(`当前支持 Claude Code ${CLAUDE_VERSION}，发现 ${version}`);
    fingerprints.cli = await sha256File(cliPath);
    if (fingerprints.cli !== CLAUDE_BINARY_SHA256) throw new Error("Claude Code 二进制指纹未验证，未开放写入");
    if (!nodePath) throw new Error("未发现 Node，不能启动 Claude 只读 SDK helper");
    sdkPath = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk").replace("/app.asar/", "/app.asar.unpacked/");
    const pkg = JSON.parse(await readFile(join(dirname(sdkPath), "package.json"), "utf8"));
    fingerprints.sdk = await sha256File(sdkPath);
    if (pkg.version !== CLAUDE_SDK_VERSION || fingerprints.sdk !== CLAUDE_SDK_SHA256) throw new Error("Claude 回读 SDK 版本/指纹不兼容");
  } catch (error) { compatibilityError = error instanceof Error ? error.message : String(error); }
  return { installed: true, compatible: compatibilityError === null, compatibilityError, version,
    runtimeId: CLAUDE_RUNTIME_ID, cliPath, configDir, configDirExplicit, nodePath, sdkPath, fingerprints };
}
