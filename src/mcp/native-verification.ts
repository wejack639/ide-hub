import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  McpNativeRecognitionProbeInput,
  McpNativeRecognitionProbeResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

type CommandSpec = {
  executable: string;
  args: string[];
  method: string;
};

export async function verifyNativeMcpRecognition(
  input: McpNativeRecognitionProbeInput,
  timeoutMs = 15_000,
): Promise<McpNativeRecognitionProbeResult> {
  if (input.serverNames.length === 0) {
    return { method: "none", servers: {} };
  }
  if (input.targetProduct === "qoder-international" || input.targetProduct === "qoder-cn") {
    return verifyWithQoderCache(input, timeoutMs);
  }
  if (input.targetProduct === "claude-code") {
    const executable = firstExisting([
      join(input.homeDir, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    if (executable) {
      return verifyEachWithGet(input, executable, ["mcp", "get"], "claude mcp get", timeoutMs);
    }
  }
  const command = nativeListCommand(input);
  if (command) return verifyWithCli(input, command, timeoutMs);
  if (input.targetProduct === "zcode") return verifyWithZcodeProtocol(input, timeoutMs);
  if (input.targetProduct === "codebuddy-international" || input.targetProduct === "codebuddy-cn") {
    return verifyWithCodeBuddyLog(input, timeoutMs);
  }
  return pendingResult(
    input,
    "目标应用当前安装没有可调用的原生 MCP list 接口；配置已写入，需由目标 MCP 页确认识别",
  );
}

export function matchCodeBuddyNativeLog(
  log: string,
  targetConfigPath: string,
  serverName: string,
  notBeforeEpochMs: number,
): boolean {
  let observedTargetReload = false;
  for (const line of log.split(/\r?\n/u)) {
    const timestamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/u.exec(line);
    if (!timestamp) continue;
    const epoch = new Date(`${timestamp[1]}T${timestamp[2]}`).getTime();
    if (!Number.isFinite(epoch) || epoch < notBeforeEpochMs) continue;
    if (line.includes(`watchFilePath path: ${targetConfigPath}; changed`)) observedTargetReload = true;
    if (
      observedTargetReload &&
      line.includes(`asyncUpdateServerTools ${serverName}: fetched`) &&
      /fetched \d+ tools/u.test(line)
    ) {
      return true;
    }
  }
  return false;
}

export function matchNativeCliOutput(
  output: string,
  serverNames: string[],
): Record<string, boolean> {
  const normalized = output.replace(ANSI_PATTERN, "");
  return Object.fromEntries(serverNames.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const exactName = new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:[^A-Za-z0-9_.-]|$)`, "mu");
    return [name, exactName.test(normalized)];
  }));
}

function nativeListCommand(input: McpNativeRecognitionProbeInput): CommandSpec | null {
  const home = input.homeDir;
  switch (input.targetProduct) {
    case "cursor": {
      const executable = firstExisting([
        join(home, "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor"),
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        "/opt/homebrew/bin/cursor",
        "/usr/local/bin/cursor",
      ]);
      return executable ? { executable, args: ["agent", "mcp", "list"], method: "cursor agent mcp list" } : null;
    }
    case "deepseek-harness": {
      const executable = firstExisting(["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"]);
      return executable ? { executable, args: ["--profile", "web", "--dump-config"], method: "dsh --profile web --dump-config" } : null;
    }
    default:
      return null;
  }
}

async function verifyEachWithGet(
  input: McpNativeRecognitionProbeInput,
  executable: string,
  argsPrefix: string[],
  method: string,
  timeoutMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  const entries = await Promise.all(input.serverNames.map(async (name) => {
    let output = "";
    try {
      const result = await execFileAsync(executable, [...argsPrefix, name], {
        cwd: input.workspace ?? input.homeDir,
        encoding: "utf8",
        env: { ...process.env, HOME: input.homeDir },
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
      });
      output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      return [name, {
        status: "passed" as const,
        detail: `${method} 已读取该 MCP 的最终有效配置`,
      }] as const;
    } catch (error) {
      const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
      const explicitlyMissing = /not found|does not exist|未找到|不存在/iu.test(output);
      return [name, explicitlyMissing
        ? { status: "failed" as const, detail: `${method} 未发现该 MCP` }
        : { status: "pending" as const, detail: `${method} 当前不可用或超时；目标应用识别尚未确认` }] as const;
    } finally {
      // Keep potentially sensitive native config output in memory only.
      output = "";
    }
  }));
  return { method, servers: Object.fromEntries(entries) };
}

async function verifyWithCli(
  input: McpNativeRecognitionProbeInput,
  command: CommandSpec,
  timeoutMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  const cwd = input.workspace ?? input.homeDir;
  let output = "";
  let exitedSuccessfully = false;
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: input.homeDir },
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    exitedSuccessfully = true;
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
  }
  const matches = matchNativeCliOutput(output, input.serverNames);
  const servers = Object.fromEntries(input.serverNames.map((name) => {
    if (matches[name]) {
      return [name, { status: "passed" as const, detail: `${command.method} 已发现该 MCP` }];
    }
    if (exitedSuccessfully) {
      return [name, { status: "failed" as const, detail: `${command.method} 未发现该 MCP` }];
    }
    return [name, {
      status: "pending" as const,
      detail: `${command.method} 当前不可用或超时；配置已写入，但目标应用识别尚未确认`,
    }];
  }));
  return { method: command.method, servers };
}

async function verifyWithZcodeProtocol(
  input: McpNativeRecognitionProbeInput,
  timeoutMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  const script = firstExisting([
    join(input.homeDir, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  ]);
  if (!script) return pendingResult(input, "ZCode 原生 app-server 不可用；目标应用识别尚未确认");
  const workspace = input.workspace ?? input.homeDir;
  const method = "ZCode app-server mcp/list";
  try {
    const names = await requestZcodeMcpList(script, workspace, input.homeDir, timeoutMs);
    return {
      method,
      servers: Object.fromEntries(input.serverNames.map((name) => [name, names.has(name)
        ? { status: "passed" as const, detail: `${method} 已发现该 MCP` }
        : { status: "failed" as const, detail: `${method} 未发现该 MCP` }])),
    };
  } catch {
    return pendingResult(input, `${method} 当前不可用或超时；配置已写入，但目标应用识别尚未确认`, method);
  }
}

async function verifyWithCodeBuddyLog(
  input: McpNativeRecognitionProbeInput,
  timeoutMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  const editionDirectory = input.targetProduct === "codebuddy-cn" ? "CodeBuddy CN" : "CodeBuddy";
  const logsRoot = join(input.homeDir, "Library", "Application Support", editionDirectory, "logs");
  const method = `${editionDirectory} native extension log`;
  const deadline = Date.now() + timeoutMs;
  do {
    const logPath = await newestNamedFile(logsRoot, "Tencent Cloud CodeBuddy.log");
    if (logPath) {
      try {
        const log = await readFile(logPath, "utf8");
        const servers = Object.fromEntries(input.serverNames.map((name) => [name,
          matchCodeBuddyNativeLog(log, input.targetConfigPath, name, input.notBeforeEpochMs)
            ? { status: "passed" as const, detail: `${method} 已确认重新加载并发现该 MCP 的工具` }
            : { status: "pending" as const, detail: `${method} 尚未确认重新加载该 MCP` },
        ]));
        if (Object.values(servers).every((server) => server.status === "passed")) {
          return { method, servers };
        }
      } catch {
        // The active extension host may rotate its log while polling.
      }
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return pendingResult(input, `${method} 在 ${timeoutMs}ms 内未确认目标 MCP；请在 IDE MCP 页确认`, method);
}

async function verifyWithQoderCache(
  input: McpNativeRecognitionProbeInput,
  timeoutMs: number,
): Promise<McpNativeRecognitionProbeResult> {
  if (input.targetScope !== "user") {
    return pendingResult(input, "Qoder 当前安装未提供该 scope 的可调用原生识别接口");
  }
  const dataDirectory = input.targetProduct === "qoder-cn" ? "QoderCN" : "Qoder";
  const cachePath = join(
    input.homeDir,
    "Library",
    "Application Support",
    dataDirectory,
    "SharedClientCache",
    "extension",
    "local",
    "mcp.json",
  );
  const method = `${dataDirectory} native effective MCP cache`;
  const deadline = Date.now() + timeoutMs;
  let observedReload = false;
  do {
    try {
      const metadata = await stat(cachePath);
      if (metadata.mtimeMs >= input.notBeforeEpochMs) {
        observedReload = true;
        const value = JSON.parse(await readFile(cachePath, "utf8")) as { mcpServers?: Record<string, unknown> };
        const names = new Set(Object.keys(value.mcpServers ?? {}));
        if (input.serverNames.every((name) => names.has(name))) {
          return {
            method,
            servers: Object.fromEntries(input.serverNames.map((name) => [name, {
              status: "passed" as const,
              detail: `${method} 已在写入后更新并发现该 MCP`,
            }])),
          };
        }
      }
    } catch {
      // The IDE may not have created or refreshed its effective cache yet.
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (observedReload) {
    return {
      method,
      servers: Object.fromEntries(input.serverNames.map((name) => [name, {
        status: "failed" as const,
        detail: `${method} 已在写入后更新，但未发现该 MCP`,
      }])),
    };
  }
  return pendingResult(input, `${method} 在 ${timeoutMs}ms 内没有更新；请打开 IDE MCP 页确认`, method);
}

function requestZcodeMcpList(
  script: string,
  workspace: string,
  home: string,
  timeoutMs: number,
): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "app-server", "--stdio"], {
      cwd: workspace,
      env: { ...process.env, HOME: home, ZCODE_MODEL_TELEMETRY_ENABLED: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    const finish = (error: Error | null, names?: Set<string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(names ?? new Set());
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as {
            id?: unknown;
            result?: { statuses?: Record<string, unknown> };
            error?: { message?: unknown };
          };
          if (String(message.id) !== "1") continue;
          if (message.error) return finish(new Error(String(message.error.message ?? "ZCode mcp/list failed")));
          const statuses = message.result?.statuses;
          if (!statuses || typeof statuses !== "object") return finish(new Error("ZCode mcp/list returned no statuses"));
          return finish(null, new Set(Object.keys(statuses)));
        } catch {
          // Ignore native startup output that is not a protocol response.
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`ZCode app-server exited (${signal ?? code ?? "unknown"})`));
    });
    const timer = setTimeout(() => finish(new Error("ZCode mcp/list timed out")), timeoutMs);
    child.stdin.write(`${JSON.stringify({
      id: "1",
      method: "mcp/list",
      params: {
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        mode: "status",
      },
    })}\n`);
  });
}

function pendingResult(
  input: McpNativeRecognitionProbeInput,
  detail: string,
  method = "target IDE MCP page",
): McpNativeRecognitionProbeResult {
  return {
    method,
    servers: Object.fromEntries(input.serverNames.map((name) => [name, {
      status: "pending" as const,
      detail,
    }])),
  };
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

async function newestNamedFile(root: string, name: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0 && candidates.length < 64) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 5) queue.push({ path, depth: current.depth + 1 });
      if (!entry.isFile() || entry.name !== name) continue;
      try {
        candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // Ignore a log rotated between readdir and stat.
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRunNativeMcpProbe(input: {
  homeDir?: string;
  hasTargetPathOverride: boolean;
}): boolean {
  return !input.hasTargetPathOverride && (!input.homeDir || input.homeDir === homedir());
}
