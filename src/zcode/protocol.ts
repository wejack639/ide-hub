import { MigrationError } from "../errors.js";
import { extractVisibleMessages } from "../seed-context.js";
import type { LossReport, SourceSnapshot } from "../types.js";
import { sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";

export const ZCODE_PROTOCOL_VERSION = "zcode-3.10.2-imported-history-v1";
export type ZcodeMessage = { role: "user" | "assistant"; content: string; timestamp?: number };
export type ZcodeNativeMessage = {
  info: { id: string; sessionID: string; role: string; [key: string]: unknown };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
};
export type ZcodeSnapshot = {
  session: {
    sessionId: string;
    workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
    title: string; traceId: string; createdAt: number; updatedAt: number; mode: string; status: string;
    model: { providerId: string; modelId: string };
  };
};

export function zcodeMigrationKey(source: SourceSnapshot): string {
  return sha256Text(stableJson({ protocol: ZCODE_PROTOCOL_VERSION, sourceThreadId: source.thread.id,
    sourceFileSha256: source.sourceFile.sha256, workspace: source.workspace.workspaceCanonical }));
}

/** ZCode 原生入口支持逐条消息，不使用 Qoder 的 Assistant 合并规则。 */
export function projectZcodeHistory(source: SourceSnapshot) {
  const visible = extractVisibleMessages(source);
  if (!visible.length) throw new MigrationError("SOURCE_CONVERSATION_EMPTY", "Codex 会话没有可迁移的正文");
  const epoch = (v: number) => Math.trunc(v < 1e12 ? v * 1000 : v);
  const messages: ZcodeMessage[] = visible.map(m => {
    const turn = source.thread.turns.find(t => t.id === m.turnId);
    const time = turn?.startedAt ?? source.thread.createdAt;
    return { role: m.role, content: m.text, timestamp: epoch(time) };
  });
  const omittedEventTypes: Record<string, number> = {};
  const omit = (type: string) => { omittedEventTypes[type] = (omittedEventTypes[type] ?? 0) + 1; };
  for (const turn of source.thread.turns) for (const item of turn.items) {
    if (item.type !== "userMessage" && item.type !== "agentMessage") omit(item.type);
    if (Array.isArray(item.content)) for (const block of item.content) {
      if (block && typeof block === "object" && block.type !== "text") omit(`attachment:${String(block.type)}`);
    }
  }
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  const lossReport: LossReport = { policy: "goal-recent-plan-v1", maxBytes: bytes,
    sourceMessageCount: messages.length, includedMessageCount: messages.length, omittedMessageCount: 0,
    sourceMessageBytes: bytes, includedMessageBytes: bytes, omittedMessageBytes: 0, omittedEventTypes, truncatedFields: [] };
  return {
    schemaVersion: ZCODE_PROTOCOL_VERSION,
    sourceMessageCount: messages.length,
    projectedMessageCount: messages.length,
    turns: source.thread.turns.filter(t => visible.some(m => m.turnId === t.id)).map(t => ({
      requestId: t.id, sourceTurnIds: [t.id], sourceItemIds: visible.filter(m => m.turnId === t.id).map(m => m.itemId),
      sourceMessageCount: visible.filter(m => m.turnId === t.id).length,
      messages: visible.filter(m => m.turnId === t.id).map(m => ({ role: m.role, content: m.text })),
    })),
    history: { source: "claudeCode" as const,
      title: `Codex · ${source.thread.name?.trim() || source.thread.preview.trim() || source.thread.id}`.replace(/\s+/g, " ").slice(0, 100),
      createdAt: epoch(source.thread.createdAt), updatedAt: epoch(source.thread.updatedAt), messages },
    lossReport,
    compatibilityNote: "当前 ZCode 原生导入接口仅接受 claudeCode 协议标签；实际来源始终是 Codex。这不是官方 Codex 导入支持。",
  };
}

/** 回读全部原生 messages/parts，允许迁移历史之后追加真实续聊，但不允许前缀被改写。 */
export function verifyZcodeMessages(actual: ZcodeNativeMessage[], expected: ZcodeMessage[], sessionId: string) {
  if (actual.length < expected.length) throw new MigrationError("TARGET_SESSION_NOT_PERSISTED", "ZCode 历史缺失或被窗口截断");
  for (const [i, message] of expected.entries()) {
    const found = actual[i];
    if (found?.info.id !== `msg_${sessionId}_import_${i}` || found.info.sessionID !== sessionId ||
      found.info.role !== message.role || found.parts.map(p => p.type === "text" ? p.text ?? "" : "").join("") !== message.content) {
      throw new MigrationError("TARGET_SESSION_NOT_PERSISTED", `ZCode 第 ${i + 1} 条历史的 ID、角色或正文不一致`);
    }
  }
  return { importedCount: expected.length, continuationCount: actual.length - expected.length };
}
