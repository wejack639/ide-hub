import { randomUUID } from "node:crypto";
import { MigrationError } from "../errors.js";
import { extractVisibleMessages } from "../seed-context.js";
import type { SourceSnapshot, LossReport } from "../types.js";
import { sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";
import { CLAUDE_VERSION } from "./discovery.js";

export const CLAUDE_PROTOCOL = "claude-2.1.170-codex-jsonl-v1";
export const CLAUDE_IMPORT_NOTE = "逐条导入 Codex 可见文本；历史 model=ide-hub/codex-history 和 usage=0 仅为来源/未知用量占位，不是模型配置。工具与附件只归档，不重放。迁移不调用模型；请使用 Claude Code 自己的认证和模型续聊。本次迁移不自动验证真实续聊。";
export type ClaudeRecord = { type: string; uuid?: string; parentUuid?: string | null; sessionId?: string; cwd?: string; [key: string]: any };
export const isClaudeUuid = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);

export function claudeMigrationKey(source: SourceSnapshot, configDir: string): string {
  return sha256Text(stableJson({ protocol: CLAUDE_PROTOCOL, sourceThreadId: source.thread.id,
    sourceFileSha256: source.sourceFile.sha256, workspace: source.workspace.workspaceCanonical, configDir }));
}

export function projectClaudeHistory(source: SourceSnapshot) {
  const visible = extractVisibleMessages(source, { preserveWhitespace: true });
  if (!visible.length) throw new MigrationError("SOURCE_CONVERSATION_EMPTY", "Codex 会话没有可迁移的正文");
  const messages = visible.map(m => ({ role: m.role, content: m.text }));
  const provenance = visible.map(m => ({ sourceTurnId: m.turnId, sourceItemId: m.itemId }));
  let sourceMessageCount = 0;
  const omittedEventTypes: Record<string, number> = {};
  const omit = (type: string) => { omittedEventTypes[type] = (omittedEventTypes[type] ?? 0) + 1; };
  for (const t of source.thread.turns) for (const item of t.items) {
    if (["userMessage", "agentMessage"].includes(item.type)) sourceMessageCount++; else omit(item.type);
    if (Array.isArray(item.content)) for (const block of item.content) if (block?.type !== "text") omit(`attachment:${String(block?.type)}`);
  }
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  const lossReport: LossReport = { policy: "goal-recent-plan-v1", maxBytes: bytes, sourceMessageCount,
    includedMessageCount: messages.length, omittedMessageCount: sourceMessageCount - messages.length,
    sourceMessageBytes: bytes, includedMessageBytes: bytes, omittedMessageBytes: 0, omittedEventTypes, truncatedFields: [] };
  return { schemaVersion: CLAUDE_PROTOCOL, messages, provenance, lossReport, compatibilityNote: CLAUDE_IMPORT_NOTE,
    title: `Codex · ${source.thread.name?.trim() || source.thread.preview.trim() || source.thread.id}`.replace(/\s+/g, " "),
    sourceMessageCount, projectedMessageCount: messages.length,
    turns: source.thread.turns.filter(t => visible.some(m => m.turnId === t.id)).map(t => ({ requestId: t.id })) };
}

/** 仅新建历史；来源信息在 Hub 迁移产物中，不伪装成一条用户交接提示。 */
export function buildClaudeSession(projection: ReturnType<typeof projectClaudeHistory>, sessionId: string, workspace: string): string {
  if (!isClaudeUuid(sessionId)) throw new MigrationError("CLAUDE_HISTORY_INVALID", "Claude 会话 ID 必须为 UUID");
  let parentUuid: string | null = null;
  const timestamp = new Date().toISOString();
  const records: ClaudeRecord[] = projection.messages.map(m => {
    const uuid = randomUUID();
    const message = m.role === "user" ? { role: m.role, content: m.content } : {
      id: `msg_${uuid.replaceAll("-", "")}`, type: "message", role: m.role, model: "ide-hub/codex-history",
      content: [{ type: "text", text: m.content }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    const record = { type: m.role, uuid, parentUuid, sessionId, cwd: workspace, timestamp,
      isSidechain: false, userType: "external", entrypoint: "cli", version: CLAUDE_VERSION, message };
    parentUuid = uuid;
    return record;
  });
  records.push({ type: "custom-title", customTitle: projection.title, sessionId });
  return records.map(r => JSON.stringify(r)).join("\n") + "\n";
}

/** 先验证全部行/父链，随后才交给可能静默丢弃坏行的官方 reader。 */
export function parseClaudeSession(content: string, sessionId: string, workspace: string): { records: ClaudeRecord[]; messages: ClaudeRecord[] } {
  const fail = (reason: string): never => { throw new MigrationError("CLAUDE_HISTORY_INVALID", `Claude 历史损坏：${reason}`); };
  if (!isClaudeUuid(sessionId) || !content.endsWith("\n")) fail("会话 ID 或尾换行无效");
  let records: ClaudeRecord[];
  try { records = content.slice(0, -1).split("\n").map(line => JSON.parse(line)); } catch { return fail("JSON 行解析失败"); }
  const ids = new Set<string>();
  const messages: ClaudeRecord[] = [];
  for (const r of records) {
    if (!r || typeof r.type !== "string") fail("记录类型无效");
    if (r.sessionId !== undefined && r.sessionId !== sessionId) fail("sessionId 不一致");
    if (r.cwd !== undefined && r.cwd !== workspace) throw new MigrationError("TARGET_WORKSPACE_MISMATCH", "Claude 工作区与源目录不一致");
    if (r.uuid !== undefined) {
      if (!isClaudeUuid(r.uuid) || ids.has(r.uuid)) fail("消息 UUID 无效或重复");
      if (r.parentUuid != null && !ids.has(r.parentUuid)) fail("父子链缺失或成环");
      ids.add(r.uuid);
    }
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (!r.uuid || r.parentUuid === undefined || r.sessionId !== sessionId || r.cwd !== workspace) fail("消息必需字段缺失");
    if (!Number.isFinite(Date.parse(r.timestamp)) || r.isSidechain !== false) fail("消息时间或主会话标记无效");
    if (r.message?.role !== r.type) fail("角色不一致");
    const body = r.message.content;
    if (typeof body !== "string" && !Array.isArray(body)) fail("消息正文无效");
    if (Array.isArray(body)) for (const b of body) if (!b || typeof b.type !== "string" || (b.type === "text" && typeof b.text !== "string")) fail("content block 无效");
    messages.push(r);
  }
  if (!messages.length) fail("没有原生消息");
  return { records, messages };
}
