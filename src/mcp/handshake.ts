import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { McpServer } from "./types.js";

export async function verifyStdioHandshake(
  server: McpServer,
  timeoutMs: number,
): Promise<{ passed: boolean; detail: string }> {
  if (server.transport !== "stdio" || !server.command) {
    return { passed: false, detail: "不是可执行的 stdio MCP" };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...server.env };
  for (const name of server.envVars) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const useSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  const executable = useSandbox ? "/usr/bin/sandbox-exec" : server.command;
  const args = useSandbox
    ? ["-p", "(version 1)(allow default)(deny network*)", server.command, ...server.args]
    : server.args;

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: server.cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let initialized = false;
    const finish = (passed: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve({ passed, detail });
    };
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as { id?: unknown; result?: unknown; error?: unknown };
      if (value.id === 1) {
        if (value.error) return finish(false, "initialize 返回错误");
        initialized = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (value.id === 2) {
        if (value.error) return finish(false, "tools/list 返回错误");
        const tools = (value.result as { tools?: unknown } | undefined)?.tools;
        if (!initialized || !Array.isArray(tools)) return finish(false, "tools/list 响应结构无效");
        finish(true, `initialize + tools/list 成功，发现 ${tools.length} 个工具`);
      }
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
          onMessage(JSON.parse(line));
        } catch {
          // Ignore non-protocol stdout while waiting for a JSON-RPC response.
        }
      }
    });
    child.once("error", (error) => finish(false, `启动失败：${error.message}`));
    child.once("exit", (code, signal) => {
      if (!settled) finish(false, `进程提前退出：${signal ?? code ?? "unknown"}`);
    });
    const timer = setTimeout(() => finish(false, `握手超时（${timeoutMs}ms）`), timeoutMs);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ide-hub", version: "0.1.0" },
      },
    });
  });
}
