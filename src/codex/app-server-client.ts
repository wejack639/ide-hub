import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { MigrationError } from "../errors.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
};

export type CodexAppServerOptions = {
  executable?: string;
  requestTimeoutMs?: number;
  networkDisabled?: boolean;
};

export interface AppServerRequester {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export class CodexAppServerClient {
  readonly executable: string;
  readonly requestTimeoutMs: number;
  readonly networkDisabled: boolean;
  #process: ChildProcessWithoutNullStreams | null = null;
  #reader: Interface | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #stderr = "";
  #started = false;

  constructor(options: CodexAppServerOptions = {}) {
    this.executable = options.executable ?? defaultCodexExecutable();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.networkDisabled = options.networkDisabled ?? false;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const process = spawn(this.networkDisabled ? "/usr/bin/sandbox-exec" : this.executable,
      this.networkDisabled ? ["-p", "(version 1)(allow default)(deny network*)", this.executable, "app-server", "--stdio"] : ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: processEnvWithoutModelKeys(),
    });
    this.#process = process;
    this.#reader = createInterface({ input: process.stdout, crlfDelay: Infinity });
    this.#reader.on("line", (line) => this.#onLine(line));
    process.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-32_768);
    });
    process.once("error", (error) => this.#rejectAll(error));
    process.once("exit", (code, signal) => {
      if (this.#pending.size > 0) {
        this.#rejectAll(
          new Error(
            `Codex App Server exited before responding (code=${String(code)}, signal=${String(signal)}): ${this.#stderr}`,
          ),
        );
      }
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "ide_hub",
          title: "IDE Hub",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: false },
      });
      this.notify("initialized", {});
      this.#started = true;
    } catch (error) {
      await this.close();
      throw new MigrationError(
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Unable to initialize Codex App Server",
        { stderr: this.#stderr },
        { cause: error },
      );
    }
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.#process === null) {
      throw new MigrationError(
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex App Server is not started",
      );
    }
    const id = this.#nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.#write({ id, method, params });
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#write({ method, params });
  }

  async close(): Promise<void> {
    const process = this.#process;
    if (process === null) return;
    this.#process = null;
    this.#started = false;
    this.#reader?.close();
    this.#reader = null;
    this.#rejectAll(new Error("Codex App Server client closed"));
    process.stdin.end();
    if (process.exitCode === null && process.signalCode === null) {
      const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      await Promise.race([exited, timeout]);
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
    }
  }

  #write(message: Record<string, unknown>): void {
    const process = this.#process;
    if (process === null || process.stdin.destroyed) {
      throw new MigrationError(
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex App Server stdin is unavailable",
      );
    }
    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new Error(
          `Codex App Server error ${String(message.error.code)}: ${message.error.message ?? "unknown error"}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function defaultCodexExecutable(): string {
  const configured = process.env.CODEX_EXECUTABLE?.trim();
  if (configured) return configured;
  for (const candidate of [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".local", "bin", "codex"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
}

function processEnvWithoutModelKeys(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "QODER_PERSONAL_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}
