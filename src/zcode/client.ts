import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { MigrationError } from "../errors.js";
import { atomicWrite } from "../util/fs.js";
import type { ZcodeInstallation } from "./discovery.js";

/** 只选取 ZCode 已存在的模型名称和协议种类。Key、URL、headers、MCP 均不进入隔离配置。 */
export function offlineModelConfig(input: Record<string, any>) {
  const providers = input.provider ?? {};
  const selected = typeof input.model?.main === "string" ? input.model.main : null;
  const candidates = Object.entries(providers).flatMap(([providerId, value]) => {
    const p = value as Record<string, any>;
    return Object.keys(p.models ?? {}).map(modelId => ({ providerId, modelId, kind: p.kind }));
  });
  const model = candidates.find(m => `${m.providerId}/${m.modelId}` === selected) ?? candidates[0];
  if (!model || !["anthropic", "openai", "openai-compatible", "google"].includes(model.kind)) {
    throw new MigrationError("ZCODE_MODEL_METADATA_MISSING", "ZCode 中没有可识别的模型描述。请先在 ZCode 选择模型；迁移不需要 IDE Hub API Key");
  }
  return { model: { main: `${model.providerId}/${model.modelId}` },
    provider: { [model.providerId]: { kind: model.kind, models: { [model.modelId]: {} } } },
    features: { mcp: false, memory: false, skill: false, subagent: false },
    plugins: { enabled: false }, skills: { enabled: false }, hooks: { enabled: false }, memory: { use: false } };
}

export function offlineSandboxProfile(executable: string, workspace: string): string {
  // 本机支持版本的 project config 优先级高于 user config，必须隔离它们以免启动 MCP/插件。
  const paths: string[] = [];
  for (let path = workspace; ; path = dirname(path)) {
    paths.push(join(path, "zcode.json"), join(path, ".zcode/config.json"));
    if (dirname(path) === path) break;
  }
  // 3.10.2 即使 plugins.enabled=false 也会先复制 bundled plugins；让隔离进程看不到这些可选插件。
  const bundledPlugins = join(dirname(executable), "../Resources/glm/packages");
  return `(version 1)(allow default)(deny network*)\n(deny process-exec (require-not (literal ${JSON.stringify(executable)})))\n` +
    `(deny file-read* file-test-existence (subpath ${JSON.stringify(bundledPlugins)}))\n` +
    paths.map(path => `(deny file-read* (literal ${JSON.stringify(path)}))`).join("\n");
}

const METHODS = new Set(["session/create", "session/resume", "session/read", "session/messages", "session/list", "session/close"]);
export class ZcodeClient {
  #process: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #sequence = 0;
  #stderr = "";
  readonly calls: string[] = [];
  constructor(readonly installation: ZcodeInstallation, readonly workspace: string, readonly directory: string,
    readonly sessionDb = installation.sessionDb) {}

  async start(): Promise<void> {
    const isolatedHome = join(this.directory, "offline-home");
    await mkdir(isolatedHome, { recursive: true });
    const config = offlineModelConfig(JSON.parse(await readFile(this.installation.configPath, "utf8")));
    await atomicWrite(join(isolatedHome, ".zcode/cli/config.json"), JSON.stringify(config));
    const profile = offlineSandboxProfile(this.installation.executable, this.workspace);
    await atomicWrite(join(this.directory, "offline.sb"), profile);
    // HOME 仅在独立目标子进程中指向其隔离配置目录，不改变父进程或用户全局配置。
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, this.installation.executable,
      this.installation.backend, "app-server", "--stdio"], {
      cwd: isolatedHome, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: isolatedHome, ELECTRON_RUN_AS_NODE: "1",
        ZCODE_STORAGE_DIR: join(isolatedHome, ".zcode"), ZCODE_SESSION_DB_PATH: this.sessionDb,
        ZCODE_DATA_BASE_DIR: join(isolatedHome, ".zcode"), ZCODE_MODEL_TELEMETRY_ENABLED: "0" },
    });
    this.#process = child;
    child.stderr.on("data", (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096); });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on("line", line => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && m.method) {
        this.calls.push(`client:${m.method}`);
        // 原生协议对此响应有明确离线默认值；不响应工具、权限或模型请求。
        child.stdin.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: "Offline history importer does not execute client operations" } })}\n`);
        return;
      }
      const pending = this.#pending.get(String(m.id));
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(String(m.id));
      if (m.error) pending.reject(new MigrationError("ZCODE_IMPORT_FAILED", String(m.error.message)));
      else pending.resolve(m.result);
    });
    child.stdin.on("error", error => this.#rejectAll(error));
    child.once("error", error => this.#rejectAll(error));
    child.once("exit", (code, signal) => { reader.close(); this.#rejectAll(new MigrationError("ZCODE_IMPORT_FAILED", `ZCode app-server exited (${code}/${signal}): ${this.#stderr}`)); });
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!METHODS.has(method)) throw new MigrationError("MODEL_CALL_DETECTED", `离线迁移禁止调用 ${method}`);
    const child = this.#process;
    if (!child || child.exitCode !== null || child.signalCode !== null) throw new MigrationError("ZCODE_IMPORT_FAILED", "ZCode 离线后端未运行");
    const id = String(++this.#sequence);
    this.calls.push(method);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new MigrationError("ZCODE_IMPORT_FAILED", `ZCode ${method} 超时`)); }, 60_000);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    this.#process = null;
    this.#rejectAll(new Error("ZCode importer closed"));
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => child.kill("SIGTERM"), 2000);
      // 已观察到此版本完成协议 shutdown 后仍保留后台定时器，并拦截 SIGTERM。
      const forceExit = setTimeout(() => child.kill("SIGKILL"), 4000);
      child.once("exit", () => { clearTimeout(timeout); clearTimeout(forceExit); resolve(); });
    });
  }
  #rejectAll(error: Error) { for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error); } this.#pending.clear(); }
}
