import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationError } from "../errors.js";
import { sha256Text } from "../util/fs.js";
import type { PiInstallation } from "./discovery.js";
import { parsePiSession } from "./protocol.js";

export const PI_OFFLINE_POLICY = "(version 1)(allow default)(deny network*)";

/** 模型/扩展运行时不参与导入；内核禁网覆盖 SDK 的整个 import、构造和回读过程。 */
export async function piRuntime(installation: PiInstallation, operation: Record<string, unknown>): Promise<any> {
  if (!installation.compatible) throw new MigrationError("PI_VERSION_UNSUPPORTED", installation.compatibilityError ?? "Pi 不兼容");
  let helperPath = fileURLToPath(new URL("./helper.js", import.meta.url)).replace("/app.asar/", "/app.asar.unpacked/");
  if (!existsSync(helperPath)) helperPath = helperPath.replace(/\.js$/, ".ts");
  let expectedSha256: string | undefined;
  if (operation.operation === "inspect") {
    const text = await readFile(String(operation.path), "utf8");
    parsePiSession(text, String(operation.sessionId), String(operation.workspace));
    expectedSha256 = sha256Text(text);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", PI_OFFLINE_POLICY, installation.nodePath, helperPath], {
      stdio: ["pipe", "pipe", "pipe"], cwd: String(operation.workspace),
      env: { PATH: `${dirname(installation.nodePath)}:/usr/bin:/bin`, ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        PI_CODING_AGENT_DIR: installation.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => output.push(b));
    child.stderr.on("data", (b: Buffer) => errors.push(b));
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) => {
      try {
        const response = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (code !== 0 || !response.ok) throw new Error(response.error ?? "Pi helper failed");
        resolve(response.result);
      } catch (error) { reject(new MigrationError("PI_RUNTIME_FAILED", error instanceof Error ? error.message : String(error), { stderr: Buffer.concat(errors).toString("utf8") })); }
    });
    child.stdin.end(JSON.stringify({ ...operation, expectedSha256, packageRoot: installation.packageRoot }));
  });
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function piTerminalCommand(installation: Pick<PiInstallation, "nodePath" | "cliPath" | "agentDir">, workspace: string, sessionPath: string, sessionDir: string): string {
  return `cd ${quote(workspace)} && env PI_CODING_AGENT_DIR=${quote(installation.agentDir)} PI_CODING_AGENT_SESSION_DIR=${quote(sessionDir)} ${quote(installation.nodePath)} ${quote(installation.cliPath)} --session ${quote(sessionPath)} --session-dir ${quote(sessionDir)}`;
}

export async function openPiSession(installation: PiInstallation, workspace: string, sessionPath: string, sessionId: string): Promise<void> {
  const native = await piRuntime(installation, { operation: "inspect", workspace, path: sessionPath, sessionId });
  if (native.cwd !== workspace || !native.listed) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "Pi 目标会话/工作区回读失败");
  const command = piTerminalCommand(installation, workspace, sessionPath, dirname(sessionPath));
  // argv 传递 AppleScript 参数，命令中的所有路径逐个做 shell 引用。
  await promisify(execFile)("/usr/bin/osascript", ["-e", 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run', command]);
}
