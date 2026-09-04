import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { MigrationError } from "../errors.js";
import type { QoderTargetProduct } from "../types.js";

export type QoderIdeRuntime = {
  dataRoot: string;
  infoPath: string;
  socketPath: string;
  databasePath: string;
  pid: number;
};

export type QoderChatRecord = {
  requestId?: string;
  question?: string;
  answer?: string;
  reasoningContent?: string;
  sessionType?: string;
  finishStatus?: number;
  errorResult?: string;
};

export type QoderIdeSession = {
  sessionId?: string;
  sessionTitle?: string;
  projectId?: string;
  projectUri?: string;
  projectName?: string;
  sessionType?: string;
  mode?: string;
  chatRecords?: QoderChatRecord[];
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

export function qoderIdeClientIdentity(targetProduct: QoderTargetProduct) {
  return targetProduct === "qoder-cn"
    ? {
        idePlatform: "QoderCN IDE" as const,
        ideSeries: "QoderCN IDE" as const,
        pluginPublisher: "QoderCN" as const,
        pluginName: "QoderCN" as const,
      }
    : {
        idePlatform: "Qoder IDE" as const,
        ideSeries: "Qoder IDE" as const,
        pluginPublisher: "Qoder" as const,
        pluginName: "Qoder" as const,
      };
}

export class QoderIdeRpcClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<
    (method: string, params: unknown) => void
  >();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    readonly runtime: QoderIdeRuntime,
    private readonly requestTimeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => this.handleTerminalError(error));
    socket.on("close", () => {
      this.closed = true;
      this.handleTerminalError(new Error("Qoder IDE IPC connection closed"));
    });
  }

  static async connect(
    runtime: QoderIdeRuntime,
    workspace: string,
    qoderIdeVersion: string,
    options: {
      connectTimeoutMs?: number;
      requestTimeoutMs?: number;
      targetProduct?: QoderTargetProduct;
    } = {},
  ): Promise<QoderIdeRpcClient> {
    const socket = createConnection(runtime.socketPath);
    const client = new QoderIdeRpcClient(
      socket,
      runtime,
      options.requestTimeoutMs ?? 10_000,
    );
    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        rejectConnect(
          new MigrationError(
            "QODER_RUNTIME_UNAVAILABLE",
            `Timed out connecting to Qoder IDE after ${connectTimeoutMs} ms`,
          ),
        );
      }, connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolveConnect();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        rejectConnect(
          new MigrationError(
            "QODER_RUNTIME_UNAVAILABLE",
            "Could not connect to the running Qoder IDE backend",
            undefined,
            { cause: error },
          ),
        );
      });
    });

    try {
      const clientIdentity = qoderIdeClientIdentity(
        options.targetProduct ?? "qoder-international",
      );
      await client.request("initialize", {
        workspaceFolders: [{ name: basename(workspace), uri: workspace }],
        ideVersion: qoderIdeVersion,
        ideWindowType: "editor",
        ...clientIdentity,
        pluginVersion: qoderIdeVersion,
        allowStatistics: false,
        preferredLanguage: "zh-cn",
        isEnableAutoMemory: true,
        isEnableMemoryRetrieval: true,
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      throw new MigrationError(
        "QODER_RUNTIME_UNAVAILABLE",
        `Qoder IDE IPC is closed before ${method}`,
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(
          new MigrationError(
            "QODER_RUNTIME_UNAVAILABLE",
            `Qoder IDE did not answer ${method} within ${this.requestTimeoutMs} ms`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timeout,
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  onNotification(
    listener: (method: string, params: unknown) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
    this.handleTerminalError(new Error("Qoder IDE IPC client closed"));
  }

  private write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.socket.write(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.socket.write(body);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separatorIndex = this.buffer.indexOf(HEADER_SEPARATOR);
      if (separatorIndex < 0) return;
      const header = this.buffer.subarray(0, separatorIndex).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (lengthMatch?.[1] === undefined) {
        this.handleTerminalError(new Error("Qoder IDE IPC frame has no Content-Length"));
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = separatorIndex + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(body) as JsonRpcResponse;
      } catch (error) {
        this.handleTerminalError(new Error("Qoder IDE IPC returned invalid JSON", { cause: error }));
        return;
      }
      if (typeof message.id !== "number") {
        if (typeof message.method === "string") {
          for (const listener of this.notificationListeners) {
            listener(message.method, message.params);
          }
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(
          new MigrationError(
            "QODER_RUNTIME_UNAVAILABLE",
            `Qoder IDE ${pending.method} failed: ${message.error.message ?? "unknown error"}`,
            { rpcCode: message.error.code ?? null },
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleTerminalError(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(
        new MigrationError(
          "QODER_RUNTIME_UNAVAILABLE",
          `Qoder IDE IPC ended during ${pending.method}`,
          undefined,
          { cause: error },
        ),
      );
    }
  }
}

export async function waitForQoderIdeRuntime(
  options: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<QoderIdeRuntime> {
  const dataRoot = resolve(
    options.dataRoot ??
      join(homedir(), "Library", "Application Support", "Qoder", "SharedClientCache"),
  );
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const socketName = options.socketName ?? "qoder.sock";
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return await readQoderIdeRuntime(dataRoot, socketName);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  } while (Date.now() <= deadline);

  throw new MigrationError(
    "QODER_RUNTIME_UNAVAILABLE",
    `Qoder IDE backend was not ready after ${timeoutMs} ms`,
    undefined,
    { cause: lastError },
  );
}

export async function readQoderIdeRuntime(
  dataRoot: string,
  socketName: "qoder.sock" | "qodercn.sock" = "qoder.sock",
): Promise<QoderIdeRuntime> {
  const resolvedRoot = await realpath(resolve(dataRoot));
  const infoPath = join(resolvedRoot, ".info.json");
  const raw = JSON.parse(await readFile(infoPath, "utf8")) as {
    pid?: unknown;
    ipcServerPath?: unknown;
  };
  if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
    throw new Error("Qoder IDE runtime info has an invalid pid");
  }
  if (typeof raw.ipcServerPath !== "string" || !isAbsolute(raw.ipcServerPath)) {
    throw new Error("Qoder IDE runtime info has an invalid IPC socket path");
  }
  const socketPath = await realpath(raw.ipcServerPath);
  const expectedSocket = resolve(resolvedRoot, socketName);
  if (socketPath !== expectedSocket) {
    throw new Error(`Qoder IDE IPC socket is outside the expected runtime path: ${socketPath}`);
  }
  try {
    process.kill(raw.pid as number, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  const databasePath = join(resolvedRoot, "cache", "db", "local.db");
  await access(databasePath, constants.R_OK | constants.W_OK);
  return {
    dataRoot: resolvedRoot,
    infoPath,
    socketPath,
    databasePath,
    pid: raw.pid as number,
  };
}
