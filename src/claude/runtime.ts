import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { sha256Text } from "../util/fs.js";
import { CLAUDE_OFFLINE_POLICY, type ClaudeInstallation } from "./discovery.js";
import { isClaudeUuid, parseClaudeSession } from "./protocol.js";

export async function readClaudeNative(installation: ClaudeInstallation, workspace: string, path: string, sessionId: string): Promise<any> {
  if (!installation.compatible) throw new MigrationError("CLAUDE_VERSION_UNSUPPORTED", installation.compatibilityError ?? "Claude 不兼容");
  const content = await readFile(path, "utf8");
  parseClaudeSession(content, sessionId, workspace);
  let helper = fileURLToPath(new URL("./helper.js", import.meta.url)).replace("/app.asar/", "/app.asar.unpacked/");
  if (!existsSync(helper)) helper = helper.replace(/\.js$/, ".ts");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", CLAUDE_OFFLINE_POLICY, installation.nodePath, helper], {
      cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: `${dirname(installation.nodePath)}:/usr/bin:/bin`, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), CLAUDE_CONFIG_DIR: installation.configDir },
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => output.push(b));
    child.stderr.on("data", (b: Buffer) => errors.push(b));
    child.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => {
      try {
        const response = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (code !== 0 || !response.ok) throw new Error(response.error ?? "Claude helper failed");
        resolve(response.result);
      } catch (error) { reject(new MigrationError("CLAUDE_RUNTIME_FAILED", error instanceof Error ? error.message : String(error), { stderr: Buffer.concat(errors).toString("utf8") })); }
    });
    child.stdin.end(JSON.stringify({ workspace, path, sessionId, sdkPath: installation.sdkPath, expectedSha256: sha256Text(content) }));
  });
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
export function claudeTerminalCommand(installation: Pick<ClaudeInstallation, "cliPath" | "configDir" | "configDirExplicit">, workspace: string, sessionId: string): string {
  if (!isClaudeUuid(sessionId)) throw new MigrationError("CLAUDE_TARGET_CONFLICT", "Claude 目标 ID 无效");
  // 默认目录也强设变量会改变 Claude 全局状态文件的选址，触发新的 onboarding/认证状态。
  // 只读 SDK helper 可显式指定会话目录，但真正打开必须保留用户正常启动的配置语义。
  const config = installation.configDirExplicit ? `CLAUDE_CONFIG_DIR=${quote(installation.configDir)}` : "-u CLAUDE_CONFIG_DIR";
  return `cd ${quote(workspace)} && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${config} ${quote(installation.cliPath)} --resume ${quote(sessionId)}`;
}

/** 只打开确切已验证会话，不传 prompt、不切换模型或批准工具。 */
export async function openClaudeSession(installation: ClaudeInstallation, workspace: string, path: string, sessionId: string): Promise<void> {
  const native = await readClaudeNative(installation, workspace, path, sessionId);
  if (native.cwd !== workspace || !native.listed || native.sessionId !== sessionId) throw new MigrationError("TARGET_SESSION_NOT_PERSISTED", "Claude 原生会话回读失败");
  await promisify(execFile)("/usr/bin/osascript", ["-e", 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run', claudeTerminalCommand(installation, workspace, sessionId)]);
}
