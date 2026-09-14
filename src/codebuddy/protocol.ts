import { MigrationError } from "../errors.js";
import { extractVisibleMessages } from "../seed-context.js";
import type {
  CodeBuddyTargetProduct,
  LossReport,
  SourceSnapshot,
} from "../types.js";
import { sha256Text } from "../util/fs.js";
import { stableJson, stablePrettyJson } from "../util/stable-json.js";

export const CODEBUDDY_ARCHIVE_SCHEMA = "codebuddy.conversation" as const;
export const CODEBUDDY_ARCHIVE_VERSION = 1 as const;
export const CODEBUDDY_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
export const CODEBUDDY_PROTOCOL_VERSION = "codebuddy-conversation-v1-idehub-v1";

export type CodeBuddyCoreMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  providerOptions?: Record<string, unknown>;
};

export type CodeBuddyArchiveMessage = {
  id: string;
  role: CodeBuddyCoreMessage["role"];
  message: string;
  createdAt?: string;
  status?: "active" | "deprecate" | "deleted";
  extra?: string;
  isNewFile?: boolean;
  references?: Array<Record<string, unknown>>;
};

export type CodeBuddyArchiveRequest = {
  id: string;
  type: string;
  state: "running" | "complete" | "aborted" | "canceled";
  messages: CodeBuddyArchiveMessage[];
  startedAt?: number;
  usage?: Record<string, number | null>;
};

export type CodeBuddyArchiveConversation = {
  id: string;
  type: string;
  name: string;
  createdAt: string;
  lastMessageAt: string;
  requests: CodeBuddyArchiveRequest[];
  originalId?: string;
  modelMap?: Record<string, string>;
  maxModeMap?: Record<string, boolean>;
  effortMap?: Record<string, string>;
  nameSource?: "user" | "auto";
};

export type CodeBuddyArchive = {
  schema: typeof CODEBUDDY_ARCHIVE_SCHEMA;
  schemaVersion: typeof CODEBUDDY_ARCHIVE_VERSION;
  exportedAt: string;
  data: {
    lastMessageAt: string;
    conversations: [CodeBuddyArchiveConversation];
  };
};

export type CodeBuddyProjection = {
  schemaVersion: typeof CODEBUDDY_PROTOCOL_VERSION;
  targetProduct: CodeBuddyTargetProduct;
  title: string;
  sourceMessageCount: number;
  projectedMessageCount: number;
  turns: Array<{
    requestId: string;
    sourceTurnIds: string[];
    sourceItemIds: Array<string | null>;
    sourceMessageCount: number;
    messages: Array<{ role: "user" | "assistant"; content: string; messageId: string }>;
  }>;
  lossReport: LossReport;
};

const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REQUEST_STATES = new Set(["running", "complete", "aborted", "canceled"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "tool", "system"]);
const MESSAGE_STATUSES = new Set(["active", "deprecate", "deleted"]);
const TOKEN_USAGE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "lastTokens",
  "cacheTokens",
  "cachedWriteTokens",
  "cachedMissTokens",
  "credit",
]);

export function codeBuddyMigrationKey(
  source: SourceSnapshot,
  targetProduct: CodeBuddyTargetProduct,
): string {
  return sha256Text(stableJson({
    protocol: CODEBUDDY_PROTOCOL_VERSION,
    targetProduct,
    sourceThreadId: source.thread.id,
    sourceFileSha256: source.sourceFile.sha256,
    workspace: source.workspace.workspaceCanonical,
  }));
}

export function codeBuddyArchiveId(
  source: SourceSnapshot,
  targetProduct: CodeBuddyTargetProduct,
): string {
  const edition = targetProduct === "codebuddy-international" ? "intl" : "cn";
  return `idehub_cb_${edition}_${codeBuddyMigrationKey(source, targetProduct)}`;
}

/** CodeBuddy request 支持逐条消息；这里不复用会合并连续 Assistant 的 Qoder 投影。 */
export function projectCodeBuddyHistory(
  source: SourceSnapshot,
  targetProduct: CodeBuddyTargetProduct,
): CodeBuddyProjection {
  const visible = extractVisibleMessages(source, { preserveWhitespace: true });
  if (visible.length === 0) {
    throw new MigrationError(
      "SOURCE_CONVERSATION_EMPTY",
      "Codex 会话没有可迁移的 User / Assistant 正文",
    );
  }
  const key = codeBuddyMigrationKey(source, targetProduct);
  const turns: CodeBuddyProjection["turns"] = [];
  let messageIndex = 0;
  for (const sourceTurn of source.thread.turns) {
    const messages = visible.filter((message) => message.turnId === sourceTurn.id);
    if (messages.length === 0) continue;
    const turnIndex = turns.length;
    turns.push({
      requestId: `cbreq_${key.slice(0, 24)}_${turnIndex}`,
      sourceTurnIds: [sourceTurn.id],
      sourceItemIds: messages.map((message) => message.itemId),
      sourceMessageCount: messages.length,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.text,
        messageId: `cbmsg_${key.slice(0, 24)}_${messageIndex++}`,
      })),
    });
  }
  const bytes = visible.reduce(
    (total, message) => total + Buffer.byteLength(message.text, "utf8"),
    0,
  );
  const omittedEventTypes: Record<string, number> = {};
  const omit = (type: string): void => {
    omittedEventTypes[type] = (omittedEventTypes[type] ?? 0) + 1;
  };
  for (const turn of source.thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage" && item.type !== "agentMessage") omit(item.type);
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type !== "text"
          ) {
            omit(`attachment:${String((block as { type?: unknown }).type)}`);
          }
        }
      }
    }
  }
  return {
    schemaVersion: CODEBUDDY_PROTOCOL_VERSION,
    targetProduct,
    title: `[IDE Hub · Codex] ${source.thread.name?.trim() || source.thread.preview.trim() || source.thread.id}`
      .replace(/\s+/gu, " ")
      .slice(0, 100),
    sourceMessageCount: visible.length,
    projectedMessageCount: visible.length,
    turns,
    lossReport: {
      policy: "goal-recent-plan-v1",
      maxBytes: bytes,
      sourceMessageCount: visible.length,
      includedMessageCount: visible.length,
      omittedMessageCount: 0,
      sourceMessageBytes: bytes,
      includedMessageBytes: bytes,
      omittedMessageBytes: 0,
      omittedEventTypes: Object.fromEntries(
        Object.entries(omittedEventTypes).sort(([left], [right]) => left.localeCompare(right)),
      ),
      truncatedFields: [],
    },
  };
}

export function buildCodeBuddyArchive(
  source: SourceSnapshot,
  projection: CodeBuddyProjection,
  targetProduct: CodeBuddyTargetProduct,
): CodeBuddyArchive {
  if (projection.targetProduct !== targetProduct) {
    throw new MigrationError(
      "CODEBUDDY_ARCHIVE_INVALID",
      "CodeBuddy 归档目标版本与投影不一致",
    );
  }
  const createdAt = epochIso(source.thread.createdAt);
  const lastMessageAt = epochIso(source.thread.updatedAt);
  const sourceTurns = new Map(source.thread.turns.map((turn) => [turn.id, turn]));
  const conversation: CodeBuddyArchiveConversation = {
    id: codeBuddyArchiveId(source, targetProduct),
    type: "craft",
    name: projection.title,
    createdAt,
    lastMessageAt,
    requests: projection.turns.map((turn) => {
      const sourceTurn = sourceTurns.get(turn.sourceTurnIds[0] ?? "");
      const messageTime = epochIso(sourceTurn?.startedAt ?? source.thread.createdAt);
      return {
        id: turn.requestId,
        type: "craft",
        state: "complete",
        messages: turn.messages.map((message) => ({
          id: message.messageId,
          role: message.role,
          message: stableJson({ role: message.role, content: message.content }),
          createdAt: messageTime,
          status: "active",
        })),
      };
    }),
    nameSource: "user",
  };
  const archive: CodeBuddyArchive = {
    schema: CODEBUDDY_ARCHIVE_SCHEMA,
    schemaVersion: CODEBUDDY_ARCHIVE_VERSION,
    exportedAt: lastMessageAt,
    data: { lastMessageAt, conversations: [conversation] },
  };
  parseCodeBuddyArchive(stableJson(archive));
  return archive;
}

export function serializeCodeBuddyArchive(archive: CodeBuddyArchive): string {
  const serialized = stablePrettyJson(archive);
  assertArchiveSize(serialized);
  parseCodeBuddyArchive(serialized);
  return serialized;
}

export function parseCodeBuddyArchive(value: string | unknown): CodeBuddyArchive {
  let parsed: unknown = value;
  if (typeof value === "string") {
    assertArchiveSize(value);
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw archiveInvalid("CodeBuddy 归档不是有效 JSON", error);
    }
  }
  if (!isRecord(parsed)) throw archiveInvalid("CodeBuddy 归档根节点必须是对象");
  if (parsed.schema !== CODEBUDDY_ARCHIVE_SCHEMA) throw archiveInvalid("CodeBuddy archive schema 不匹配");
  if (parsed.schemaVersion !== CODEBUDDY_ARCHIVE_VERSION) throw archiveInvalid("CodeBuddy archive schemaVersion 不支持");
  assertIsoString(parsed.exportedAt, "exportedAt");
  if (!isRecord(parsed.data)) throw archiveInvalid("CodeBuddy archive data 必须是对象");
  assertIsoString(parsed.data.lastMessageAt, "data.lastMessageAt");
  if (!Array.isArray(parsed.data.conversations) || parsed.data.conversations.length !== 1) {
    throw archiveInvalid("CodeBuddy 归档必须且只能包含一个 conversation");
  }
  const conversation = parsed.data.conversations[0];
  validateConversation(conversation);
  return parsed as unknown as CodeBuddyArchive;
}

export function decodeCodeBuddyArchiveMessages(
  archive: CodeBuddyArchive,
): Array<{ role: CodeBuddyCoreMessage["role"]; content: string }> {
  return archive.data.conversations[0].requests.flatMap((request) =>
    request.messages.map((message) => ({
      role: message.role,
      content: textFromCoreMessage(parseCoreMessage(message)),
    })),
  );
}

export function parseCoreMessage(message: CodeBuddyArchiveMessage): CodeBuddyCoreMessage {
  let core: unknown;
  try {
    core = JSON.parse(message.message);
  } catch (error) {
    throw archiveInvalid(`CodeBuddy 消息 ${message.id} 的 core message 不是 JSON`, error);
  }
  if (!isRecord(core) || core.role !== message.role) {
    throw archiveInvalid(`CodeBuddy 消息 ${message.id} 的外层与 core 角色不一致`);
  }
  if (typeof core.content !== "string" && !Array.isArray(core.content)) {
    throw archiveInvalid(`CodeBuddy 消息 ${message.id} 的 core content 无效`);
  }
  if (Array.isArray(core.content)) {
    for (const block of core.content) {
      if (!isRecord(block) || typeof block.type !== "string") {
        throw archiveInvalid(`CodeBuddy 消息 ${message.id} 的 content block 无效`);
      }
      if (block.type === "text" && typeof block.text !== "string") {
        throw archiveInvalid(`CodeBuddy 消息 ${message.id} 的文本 block 无效`);
      }
    }
  }
  return core as CodeBuddyCoreMessage;
}

function validateConversation(value: unknown): asserts value is CodeBuddyArchiveConversation {
  if (!isRecord(value)) throw archiveInvalid("CodeBuddy conversation 必须是对象");
  assertId(value.id, "conversation.id");
  for (const field of ["type", "name"] as const) {
    if (typeof value[field] !== "string") throw archiveInvalid(`conversation.${field} 必须是字符串`);
  }
  assertIsoString(value.createdAt, "conversation.createdAt");
  assertIsoString(value.lastMessageAt, "conversation.lastMessageAt");
  if (!Array.isArray(value.requests) || value.requests.length === 0) {
    throw archiveInvalid("CodeBuddy conversation 必须包含非空 requests");
  }
  const requestIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const request of value.requests) {
    if (!isRecord(request)) throw archiveInvalid("CodeBuddy request 必须是对象");
    assertId(request.id, "request.id");
    if (requestIds.has(request.id as string)) throw archiveInvalid(`CodeBuddy request ID 重复：${String(request.id)}`);
    requestIds.add(request.id as string);
    if (typeof request.type !== "string") throw archiveInvalid("CodeBuddy request.type 必须是字符串");
    if (typeof request.state !== "string" || !REQUEST_STATES.has(request.state)) {
      throw archiveInvalid("CodeBuddy request.state 无效");
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw archiveInvalid(`CodeBuddy request ${String(request.id)} 没有消息`);
    }
    if (
      request.startedAt !== undefined &&
      (
        typeof request.startedAt !== "number" ||
        !Number.isSafeInteger(request.startedAt) ||
        request.startedAt < 0
      )
    ) {
      throw archiveInvalid("request.startedAt 必须是非负毫秒时间戳");
    }
    if (request.usage !== undefined) validateUsage(request.usage);
    for (const message of request.messages) {
      validateArchiveMessage(message);
      if (messageIds.has(message.id)) throw archiveInvalid(`CodeBuddy message ID 重复：${message.id}`);
      messageIds.add(message.id);
      parseCoreMessage(message);
    }
  }
  if (value.originalId !== undefined && typeof value.originalId !== "string") throw archiveInvalid("conversation.originalId 无效");
  validateOptionalRecord(value.modelMap, "string", "conversation.modelMap");
  validateOptionalRecord(value.maxModeMap, "boolean", "conversation.maxModeMap");
  validateOptionalRecord(value.effortMap, "string", "conversation.effortMap");
  if (value.nameSource !== undefined && value.nameSource !== "user" && value.nameSource !== "auto") {
    throw archiveInvalid("conversation.nameSource 无效");
  }
}

function validateArchiveMessage(value: unknown): asserts value is CodeBuddyArchiveMessage {
  if (!isRecord(value)) throw archiveInvalid("CodeBuddy message 必须是对象");
  assertId(value.id, "message.id");
  if (typeof value.role !== "string" || !MESSAGE_ROLES.has(value.role)) throw archiveInvalid("CodeBuddy message.role 无效");
  if (typeof value.message !== "string") throw archiveInvalid("CodeBuddy message.message 必须是字符串");
  if (value.createdAt !== undefined) assertIsoString(value.createdAt, "message.createdAt");
  if (value.status !== undefined && (typeof value.status !== "string" || !MESSAGE_STATUSES.has(value.status))) {
    throw archiveInvalid("CodeBuddy message.status 无效");
  }
  if (value.extra !== undefined && typeof value.extra !== "string") throw archiveInvalid("CodeBuddy message.extra 无效");
  if (value.isNewFile !== undefined && typeof value.isNewFile !== "boolean") throw archiveInvalid("CodeBuddy message.isNewFile 无效");
  if (value.references !== undefined && !isJsonValue(value.references)) throw archiveInvalid("CodeBuddy message.references 无效");
}

function validateUsage(value: unknown): void {
  if (!isRecord(value)) throw archiveInvalid("CodeBuddy request.usage 必须是对象");
  for (const [key, tokenCount] of Object.entries(value)) {
    if (!TOKEN_USAGE_KEYS.has(key) || (tokenCount !== null && (typeof tokenCount !== "number" || !Number.isFinite(tokenCount)))) {
      throw archiveInvalid(`CodeBuddy request.usage.${key} 无效`);
    }
  }
}

function validateOptionalRecord(value: unknown, kind: "string" | "boolean", path: string): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== kind)) {
    throw archiveInvalid(`${path} 无效`);
  }
}

function textFromCoreMessage(message: CodeBuddyCoreMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function assertArchiveSize(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > CODEBUDDY_ARCHIVE_MAX_BYTES) {
    throw new MigrationError(
      "CODEBUDDY_ARCHIVE_TOO_LARGE",
      `CodeBuddy 单会话归档为 ${bytes} bytes，超过 20 MiB 上限；未截断或拆分历史`,
      { bytes, maxBytes: CODEBUDDY_ARCHIVE_MAX_BYTES },
    );
  }
}

function assertId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw archiveInvalid(`${path} 必须匹配 ${ID_PATTERN}`);
  }
}

function assertIsoString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw archiveInvalid(`${path} 必须是 ISO 时间字符串`);
  }
}

function epochIso(value: number | null | undefined): string {
  const numeric = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  return new Date(milliseconds).toISOString();
}

function archiveInvalid(message: string, cause?: unknown): MigrationError {
  return new MigrationError(
    "CODEBUDDY_ARCHIVE_INVALID",
    message,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every((item) => item === undefined || isJsonValue(item));
}
