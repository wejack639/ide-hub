import { DatabaseSync, backup } from "node:sqlite";
import type { ZcodeSnapshot } from "./protocol.js";
import { MigrationError } from "../errors.js";

export type ZcodeLineage = { migrationKey: string; sourceThreadId: string; sourceFileSha256: string; sourceProduct: "codex" };

export async function backupZcodeDatabase(path: string, destination: string): Promise<void> {
  const db = new DatabaseSync(path, { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
}

export function readZcodeSession(path: string, sessionId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT id,directory,path,title,time_archived FROM session WHERE id=?").get(sessionId); }
  finally { db.close(); }
}

export function readZcodeTask(path: string, taskId: string, workspace: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT * FROM tasks WHERE task_id=? AND workspace_key=?").get(taskId, workspace); }
  finally { db.close(); }
}

/** 新增一个任务索引；复跑保留标题和续聊状态，只修复本适配器旧索引缺失的原生 traceId。 */
export async function registerZcodeTask(path: string, native: ZcodeSnapshot, lineage: ZcodeLineage, verifiedExisting = false): Promise<void> {
  const s = native.session;
  if (!s.traceId?.trim()) throw new MigrationError("ZCODE_IMPORT_FAILED", "ZCode 原生 snapshot 缺少任务必需的 traceId，未写入索引");
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    const rows = db.prepare("SELECT * FROM tasks WHERE task_id=?").all(s.sessionId);
    if (rows.length) {
      const existing = rows[0]!;
      const meta = JSON.parse(String(existing.meta_json));
      if (rows.length !== 1 || existing.workspace_key !== s.workspace.workspaceKey || existing.workspace_path !== s.workspace.workspacePath ||
        existing.provider !== "glm" || existing.deleted !== 0 || existing.archived !== 0 ||
        (meta.ideHub?.migrationKey !== lineage.migrationKey && !(verifiedExisting && !meta.ideHub))) {
        throw new MigrationError("ZCODE_TARGET_CONFLICT", "ZCode 目标任务已存在但来源/目录/状态不一致，未覆盖");
      }
      if (!meta.traceId && meta.ideHub?.migrationKey === lineage.migrationKey) {
        db.prepare("UPDATE tasks SET meta_json=? WHERE task_id=? AND workspace_key=?").run(
          JSON.stringify({ ...meta, traceId: s.traceId }), s.sessionId, s.workspace.workspaceKey);
      }
    } else {
      const model = `${s.model.providerId}/${s.model.modelId}`;
      const meta = { taskId: s.sessionId, traceId: s.traceId, title: s.title, workspacePath: s.workspace.workspacePath,
        createdAt: s.createdAt, updatedAt: s.updatedAt, provider: "glm", mode: s.mode, model, status: "completed", ideHub: lineage };
      db.prepare(`INSERT INTO tasks (workspace_key,workspace_path,task_id,title,task_status,provider,mode,model,created_at,updated_at,meta_json,searchable_text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.workspace.workspaceKey, s.workspace.workspacePath, s.sessionId, s.title,
        "completed", "glm", s.mode, model, s.createdAt, s.updatedAt, JSON.stringify(meta), s.title);
    }
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}
