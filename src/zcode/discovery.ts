import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { MigrationError } from "../errors.js";
import { sha256File, sha256Text } from "../util/fs.js";

const exec = promisify(execFile);
export const ZCODE_FINGERPRINTS = {
  backend: "3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc",
  archive: "95ba9f23c40a45821494a3d0168f3fb8a3ef5fab9b36ee1ae22cdb9a8f98f804",
  sessionSchema: "959f9fa8d56eb57a0398bcaef6d3b2b67fb2d4b1c7291fae3fc864bc605890f3",
  taskSchema: "f4ba383f4f962e2d7485ab2861420a60123f65014da93db03cde46ab1f310e5b",
};
export type ZcodeInstallation = {
  installed: true; appPath: string; executable: string; backend: string; version: string;
  bundleId: "dev.zcode.app"; dataRoot: string; sessionDb: string; taskDb: string; configPath: string;
  compatible: boolean; compatibilityError: string | null;
  fingerprints: Record<string, string>;
};

export function zcodeSchemaFingerprint(path: string, tables: string[]): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return sha256Text(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN (${tables.map(() => "?").join(",")}) AND type IN ('table','trigger') ORDER BY type,name`).all(...tables))); }
  finally { db.close(); }
}

export async function inspectZcode(): Promise<ZcodeInstallation> {
  const appPath = "/Applications/ZCode.app";
  if (process.platform !== "darwin" || !existsSync(appPath)) throw new MigrationError("ZCODE_NOT_INSTALLED", "未发现 macOS ZCode 桌面应用");
  const dataRoot = join(homedir(), ".zcode");
  const backend = join(appPath, "Contents/Resources/glm/zcode.cjs");
  const sessionDb = join(dataRoot, "cli/db/db.sqlite");
  const taskDb = join(dataRoot, "v2/tasks-index.sqlite");
  const { stdout } = await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents/Info.plist")]);
  const version = stdout.trim();
  const fingerprints: Record<string, string> = {};
  let compatibilityError: string | null = null;
  try {
    if (version !== "3.10.2") throw new Error(`目前仅支持 ZCode 3.10.2，发现 ${version}`);
    fingerprints.backend = await sha256File(backend);
    fingerprints.archive = await hashZcodeArchive(join(appPath, "Contents/Resources/app.asar"));
    if (!existsSync(sessionDb) || !existsSync(taskDb)) throw new Error("请先启动 ZCode 完成本地存储初始化，再重新扫描");
    fingerprints.sessionSchema = zcodeSchemaFingerprint(sessionDb, ["session", "message", "part"]);
    fingerprints.taskSchema = zcodeSchemaFingerprint(taskDb, ["tasks"]);
    for (const [key, expected] of Object.entries(ZCODE_FINGERPRINTS)) if (fingerprints[key] !== expected) throw new Error(`ZCode ${key} 指纹不兼容，未开放写入`);
    if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("系统离线进程隔离工具不可用");
  } catch (error) { compatibilityError = error instanceof Error ? error.message : String(error); }
  return { installed: true, appPath, executable: join(appPath, "Contents/MacOS/ZCode"), backend, version,
    bundleId: "dev.zcode.app", dataRoot, sessionDb, taskDb, configPath: join(dataRoot, "v2/config.json"),
    compatible: compatibilityError === null, compatibilityError, fingerprints };
}

export async function discoverZcode(): Promise<ZcodeInstallation> {
  const installation = await inspectZcode();
  if (!installation.compatible) throw new MigrationError("ZCODE_VERSION_UNSUPPORTED", installation.compatibilityError ?? "ZCode 不兼容");
  return installation;
}

/** Electron 的 fs 会把 .asar 当虚拟目录；只对此安装包指纹使用物理文件读取，不切换全局 noAsar。 */
export async function hashZcodeArchive(path: string): Promise<string> {
  const fs: typeof import("node:fs") = process.versions.electron
    ? createRequire(import.meta.url)("original-fs")
    : await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 当前只承诺打开项目；会话由标题和 ID 在项目列表中定位。 */
export async function openZcodeWorkspace(installation: ZcodeInstallation, workspace: string): Promise<void> {
  // -n 让参数进入 ZCode 的 single-instance 转发；仅 -a 时已运行应用会吞掉 --args。
  await exec("/usr/bin/open", ["-n", "-a", installation.appPath, "--args", "--open-workspace", workspace]);
}
