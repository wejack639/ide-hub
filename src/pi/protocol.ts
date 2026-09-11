import { MigrationError } from "../errors.js";
import { extractVisibleMessages } from "../seed-context.js";
import type { LossReport, SourceSnapshot } from "../types.js";
import { sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";

export const PI_PROTOCOL = "pi-0.85.1-jsonl-v3-codex-v1";
export type PiMessage = { role: "user" | "assistant"; content: string; timestamp: number };
export type PiRecord = { type: string; id: string; parentId?: string | null; [key: string]: any };
export const PI_IMPORT_NOTE = "历史 provider ide-hub/codex-history 仅标明 Codex 导入，usage=0 表示用量未知。Pi 会选择自己的已配置模型；如提示无法恢复此历史模型，无需为 ide-hub 配置 provider。迁移不调用模型；真实续聊未由本次迁移验证。";

export function piMigrationKey(source: SourceSnapshot, sessionDir: string): string {
  return sha256Text(stableJson({ protocol: PI_PROTOCOL, sourceThreadId: source.thread.id,
    sourceFileSha256: source.sourceFile.sha256, workspace: source.workspace.workspaceCanonical, sessionDir }));
}

export function projectPiHistory(source: SourceSnapshot) {
  const visible = extractVisibleMessages(source, { preserveWhitespace: true });
  if (!visible.length) throw new MigrationError("SOURCE_CONVERSATION_EMPTY", "Codex 会话没有可迁移的正文");
  const provenance = visible.map(m => {
    const turn = source.thread.turns.find(t => t.id === m.turnId)!;
    const item = m.itemId === null ? undefined : turn.items.find(i => i.id === m.itemId);
    const raw = item?.timestamp ?? item?.createdAt;
    const itemTime = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
    const time = Number.isFinite(itemTime) ? itemTime : turn.startedAt ?? source.thread.createdAt;
    const sourceModel = item?.model ?? ("model" in turn ? turn.model : undefined) ?? source.thread.model;
    return { turnId: m.turnId, itemId: m.itemId, sourceStatus: turn.status,
      sourceModel: typeof sourceModel === "string" ? sourceModel : null,
      timestamp: Math.trunc(time < 1e12 ? time * 1000 : time), timestampSource: Number.isFinite(itemTime) ? "item" : turn.startedAt != null ? "turn" : "thread" };
  });
  const messages: PiMessage[] = visible.map((m, i) => ({ role: m.role, content: m.text, timestamp: provenance[i]!.timestamp }));
  const omittedEventTypes: Record<string, number> = {};
  let sourceMessageCount = 0;
  const omit = (type: string) => { omittedEventTypes[type] = (omittedEventTypes[type] ?? 0) + 1; };
  for (const turn of source.thread.turns) for (const item of turn.items) {
    if (item.type === "userMessage" || item.type === "agentMessage") sourceMessageCount++;
    else omit(item.type);
    if (Array.isArray(item.content)) for (const block of item.content) if (block?.type !== "text") omit(`attachment:${String(block?.type)}`);
  }
  const bytes = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0);
  const lossReport: LossReport = { policy: "goal-recent-plan-v1", maxBytes: bytes, sourceMessageCount,
    includedMessageCount: messages.length, omittedMessageCount: sourceMessageCount - messages.length,
    sourceMessageBytes: bytes, includedMessageBytes: bytes, omittedMessageBytes: 0, omittedEventTypes, truncatedFields: [] };
  return { schemaVersion: PI_PROTOCOL, messages, provenance, lossReport, compatibilityNote: PI_IMPORT_NOTE,
    title: `Codex · ${source.thread.name?.trim() || source.thread.preview.trim() || source.thread.id}`.replace(/\s+/g, " "),
    projectedMessageCount: messages.length, sourceMessageCount,
    turns: source.thread.turns.filter(t => visible.some(m => m.turnId === t.id)).map(t => ({ requestId: t.id })) };
}

/** SDK loader 容错会吞坏行，因此先独立严格校验完整文件，再允许原生恢复。 */
export function parsePiSession(content: string, sessionId: string, workspace: string): { header: PiRecord; entries: PiRecord[] } {
  const fail = (reason: string): never => { throw new MigrationError("PI_HISTORY_INVALID", `Pi 历史损坏：${reason}`); };
  if (!content.endsWith("\n")) fail("缺少尾换行");
  let records: PiRecord[];
  try { records = content.slice(0, -1).split("\n").map(line => JSON.parse(line)); }
  catch { return fail("JSON 行解析失败"); }
  const [header, ...entries] = records;
  if (!header || header.type !== "session" || header.version !== 3 || header.id !== sessionId) fail("header/version/session ID 不一致");
  if (header!.cwd !== workspace) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "Pi 工作区与源目录不一致");
  if (!Number.isFinite(Date.parse(header!.timestamp))) fail("header 时间无效");
  const ids = new Set<string>();
  const types = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  for (const e of entries) {
    if (!e || !types.has(e.type) || typeof e.id !== "string" || !e.id || ids.has(e.id) || e.id === sessionId) fail("entry 类型/ID 重复或无效");
    if (e.parentId !== null && (typeof e.parentId !== "string" || !ids.has(e.parentId))) fail("父子链缺失或成环");
    if (!Number.isFinite(Date.parse(e.timestamp))) fail("entry 时间无效");
    if (e.type === "message") {
      const m = e.message;
      if (!m || typeof m.role !== "string" || !Number.isFinite(m.timestamp)) fail("message 必需字段缺失");
      if (m.role === "user" && typeof m.content !== "string" && !Array.isArray(m.content)) fail("user content 无效");
      if (m.role === "assistant") {
        if (!Array.isArray(m.content) || typeof m.api !== "string" || typeof m.provider !== "string" || typeof m.model !== "string" || !m.usage || !["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(m.stopReason)) fail("assistant 必需字段缺失或仍在运行");
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) if (!Number.isFinite(m.usage[field]) || m.usage[field] < 0) fail("assistant usage 无效");
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) if (!Number.isFinite(m.usage.cost?.[field]) || m.usage.cost[field] < 0) fail("assistant cost 无效");
      }
      if (Array.isArray(m.content)) for (const block of m.content) {
        if (!block || typeof block.type !== "string" || (block.type === "text" && typeof block.text !== "string")) fail("message content block 无效");
      }
    }
    ids.add(e.id);
  }
  return { header: header!, entries };
}
