import { createHash, randomUUID } from "node:crypto";
import { release } from "node:os";
import { basename } from "node:path";
import { MigrationError } from "../errors.js";
import type {
  CursorChatExport,
  QoderConversationProjection,
  QoderHistoryMessage,
} from "../types.js";

type WireField = {
  field: number;
  wire: number;
  bytes?: Buffer;
  value?: number;
};

export const CURSOR_PROTOCOL_VERSION = "cursor-chat-json-v1-blob-roots-v3";

export type CursorRootPromptInspection = {
  rootMessageCount: number;
  systemPromptRootCount: number;
  systemPromptRootFirst: boolean;
  historyMessages: QoderHistoryMessage[];
};

type CursorRootPromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  id?: string;
};

export function buildCursorChatExport(
  projection: QoderConversationProjection,
  title: string,
  options: {
    workspace: string;
    exportedAt?: number;
    createId?: () => string;
  },
): CursorChatExport {
  if (projection.turns.length === 0 || projection.projectedMessageCount === 0) {
    throw new MigrationError(
      "SOURCE_CONVERSATION_EMPTY",
      "Codex thread contains no visible messages for Cursor",
    );
  }
  const createId = options.createId ?? randomUUID;
  const stateFields: Buffer[] = [];
  const blobs: Record<string, string> = {};

  // ConversationState field 1 stores 32-byte content-addressed BlobIDs. The
  // first blob must be an actual role=system root; <user_info> is a separate
  // role=user context message. Inline JSON is accepted by the importer but is
  // rejected by the Agent backend when a new turn starts.
  stateFields.push(bytesField(1, putBlob(blobs, cursorSystemPromptRoot())));
  stateFields.push(
    bytesField(
      1,
      putBlob(
        blobs,
        cursorWorkspaceContextRoot(
          options.workspace,
          options.exportedAt ?? Date.now(),
          createId(),
        ),
      ),
    ),
  );

  for (const turn of projection.turns) {
    for (const message of turn.messages) {
      stateFields.push(
        bytesField(1, putBlob(blobs, modelHistoryMessage(message, createId()))),
      );
    }
    const user = turn.messages.find((message) => message.role === "user");
    const agentFields: Buffer[] = [];
    if (user !== undefined) {
      const userMessage = Buffer.concat([
        stringField(1, user.content),
        stringField(2, createId()),
        varintField(4, 1),
      ]);
      agentFields.push(bytesField(1, putBlob(blobs, userMessage)));
    }
    for (const assistant of turn.messages.filter(
      (message) => message.role === "assistant",
    )) {
      const assistantMessage = stringField(1, assistant.content);
      const step = bytesField(1, assistantMessage);
      agentFields.push(bytesField(2, putBlob(blobs, step)));
    }
    agentFields.push(stringField(3, turn.requestId));
    const turnStructure = bytesField(1, Buffer.concat(agentFields));
    stateFields.push(bytesField(8, putBlob(blobs, turnStructure)));
  }
  // Cursor 3.18.9 persists local Agent conversations with this mode marker.
  stateFields.push(varintField(10, 1));

  return {
    version: 1,
    conversationState: Buffer.concat(stateFields).toString("base64"),
    blobs,
    name: title,
    exportedAt: options.exportedAt ?? Date.now(),
  };
}

export function inspectCursorRootPromptHistory(
  encodedConversationState: string,
  blobs: Record<string, string>,
): CursorRootPromptInspection {
  const state = decodeConversationState(encodedConversationState);
  const messages = readFields(state)
    .filter(
      (field) => field.field === 1 && field.wire === 2 && field.bytes !== undefined,
    )
    .map((field) => deserializeRootPromptMessage(field.bytes as Buffer, blobs));
  const systemPromptRoots = messages.filter(isCursorSystemPromptRoot);
  const historyMessages: QoderHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      historyMessages.push({ role: "assistant", content: message.content });
      continue;
    }
    const match = /^<user_query>\n([\s\S]*)\n<\/user_query>$/u.exec(message.content);
    if (match?.[1] !== undefined) {
      historyMessages.push({ role: "user", content: match[1] });
    }
  }
  return {
    rootMessageCount: messages.length,
    systemPromptRootCount: systemPromptRoots.length,
    systemPromptRootFirst: messages[0] !== undefined && isCursorSystemPromptRoot(messages[0]),
    historyMessages,
  };
}

export function decodeCursorVisibleTurns(
  encodedConversationState: string,
  blobs: Record<string, string>,
): QoderHistoryMessage[][] {
  const state = decodeConversationState(encodedConversationState);
  const turns: QoderHistoryMessage[][] = [];
  for (const field of readFields(state)) {
    if (field.field !== 8 || field.wire !== 2 || field.bytes === undefined) continue;
    const turnBlob = requiredBlob(blobs, field.bytes);
    const turnEnvelope = requiredBytesField(turnBlob, 1, "Cursor turn envelope");
    const agentFields = readFields(turnEnvelope);
    const messages: QoderHistoryMessage[] = [];
    const user = agentFields.find(
      (item) => item.field === 1 && item.wire === 2 && item.bytes !== undefined,
    );
    if (user?.bytes !== undefined) {
      const text = optionalStringField(requiredBlob(blobs, user.bytes), 1);
      if (text !== null && text.length > 0) {
        messages.push({ role: "user", content: text });
      }
    }
    for (const step of agentFields) {
      if (step.field !== 2 || step.wire !== 2 || step.bytes === undefined) continue;
      const stepBlob = requiredBlob(blobs, step.bytes);
      const assistantMessage = readFields(stepBlob).find(
        (item) => item.field === 1 && item.wire === 2 && item.bytes !== undefined,
      )?.bytes;
      if (assistantMessage === undefined) continue;
      const text = optionalStringField(assistantMessage, 1);
      if (text !== null && text.length > 0) {
        messages.push({ role: "assistant", content: text });
      }
    }
    if (messages.length > 0) turns.push(messages);
  }
  return turns;
}

export function cursorConversationTurnBlobIds(
  encodedConversationState: string,
): string[] {
  const normalized = encodedConversationState.startsWith("~")
    ? encodedConversationState.slice(1)
    : encodedConversationState;
  const state = Buffer.from(normalized, "base64");
  return readFields(state)
    .filter(
      (field) => field.field === 8 && field.wire === 2 && field.bytes !== undefined,
    )
    .map((field) => blobIdHex(field.bytes as Buffer, "Cursor turn BlobID"));
}

export function cursorConversationRootBlobIds(
  encodedConversationState: string,
): string[] {
  const normalized = encodedConversationState.startsWith("~")
    ? encodedConversationState.slice(1)
    : encodedConversationState;
  const state = Buffer.from(normalized, "base64");
  return readFields(state)
    .filter(
      (field) =>
        (field.field === 1 || field.field === 8) &&
        field.wire === 2 &&
        field.bytes !== undefined,
    )
    .map((field) =>
      blobIdHex(
        field.bytes as Buffer,
        field.field === 1 ? "Cursor root prompt BlobID" : "Cursor turn BlobID",
      ),
    );
}

function decodeConversationState(encodedConversationState: string): Buffer {
  const normalized = encodedConversationState.startsWith("~")
    ? encodedConversationState.slice(1)
    : encodedConversationState;
  try {
    return Buffer.from(normalized, "base64");
  } catch (error) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor conversationState is not valid Base64",
      undefined,
      { cause: error },
    );
  }
}

export function cursorTurnChildBlobIds(encodedTurnBlob: string): string[] {
  const turnEnvelope = requiredBytesField(
    Buffer.from(encodedTurnBlob, "base64"),
    1,
    "Cursor turn envelope",
  );
  return readFields(turnEnvelope)
    .filter(
      (field) =>
        (field.field === 1 || field.field === 2) &&
        field.wire === 2 &&
        field.bytes !== undefined,
    )
    .map((field) => blobIdHex(field.bytes as Buffer, "Cursor turn child BlobID"));
}

function putBlob(blobs: Record<string, string>, content: Buffer): Buffer {
  const digest = createHash("sha256").update(content).digest();
  blobs[digest.toString("hex")] = content.toString("base64");
  return digest;
}

function requiredBlob(blobs: Record<string, string>, id: Buffer): Buffer {
  const key = blobIdHex(id, "Cursor BlobID");
  const value = blobs[key];
  if (value === undefined) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `Cursor conversation blob is missing: ${key}`,
    );
  }
  const content = Buffer.from(value, "base64");
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== key) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `Cursor conversation blob hash mismatch: ${key}`,
    );
  }
  return content;
}

function modelHistoryMessage(message: QoderHistoryMessage, id: string): Buffer {
  const text =
    message.role === "user"
      ? `<user_query>\n${message.content}\n</user_query>`
      : message.content;
  return Buffer.from(
    JSON.stringify({
      content: [{ text, type: "text" }],
      id,
      role: message.role,
    }),
    "utf8",
  );
}

function cursorSystemPromptRoot(): Buffer {
  return Buffer.from(
    JSON.stringify({
      content: [
        {
          text: "You are an AI coding assistant operating in Cursor. Follow the user's instructions and use the prior conversation history as context.",
          type: "text",
        },
      ],
      id: "system",
      role: "system",
    }),
    "utf8",
  );
}

function cursorWorkspaceContextRoot(
  workspace: string,
  timestamp: number,
  id: string,
): Buffer {
  const shell = basename(process.env.SHELL ?? "unknown");
  const text = [
    "<user_info>",
    `OS Version: ${process.platform} ${release()}`,
    "",
    `Shell: ${shell}`,
    "",
    `Workspace Path: ${workspace}`,
    "",
    `Today's date: ${formatCursorDate(new Date(timestamp))}`,
    "</user_info>",
    "",
    "<system_reminder>",
    "This conversation was imported from Codex by IDE Hub. The following user and assistant messages are prior conversation history for this workspace.",
    "</system_reminder>",
  ].join("\n");
  return Buffer.from(
    JSON.stringify({
      content: [{ text, type: "text" }],
      id,
      role: "user",
    }),
    "utf8",
  );
}

function formatCursorDate(date: Date): string {
  const weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function deserializeRootPromptMessage(
  encoded: Buffer,
  blobs: Record<string, string>,
): CursorRootPromptMessage {
  const bytes = requiredBlob(blobs, encoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor root prompt history contains invalid JSON",
      undefined,
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("role" in parsed) ||
    !("content" in parsed) ||
    (parsed.role !== "system" && parsed.role !== "user" && parsed.role !== "assistant")
  ) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor root prompt history contains an invalid message",
    );
  }
  const content = cursorRootText(parsed.content);
  if (content === null) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      "Cursor root prompt history contains unsupported content",
    );
  }
  return {
    role: parsed.role,
    content,
    ...("id" in parsed && typeof parsed.id === "string" ? { id: parsed.id } : {}),
  };
}

function cursorRootText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part !== "object" ||
      part === null ||
      !("type" in part) ||
      part.type !== "text" ||
      !("text" in part) ||
      typeof part.text !== "string"
    ) {
      continue;
    }
    texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function isCursorSystemPromptRoot(message: CursorRootPromptMessage): boolean {
  return message.role === "system" && message.id === "system";
}

function blobIdHex(id: Buffer, label: string): string {
  if (id.length !== 32) {
    throw new MigrationError(
      "CURSOR_IMPORT_FAILED",
      `${label} must be 32 bytes, got ${id.length}`,
    );
  }
  return id.toString("hex");
}

function stringField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value, "utf8"));
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(value.length), value]);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid protobuf varint: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function readFields(buffer: Buffer): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    if (field <= 0) throw new Error("Invalid protobuf field number");
    if (wire === 0) {
      const decoded = decodeVarint(buffer, offset);
      fields.push({ field, wire, value: decoded.value });
      offset = decoded.offset;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      if (offset > buffer.length) throw new Error("Truncated protobuf fixed64");
      fields.push({ field, wire });
      continue;
    }
    if (wire === 2) {
      const length = decodeVarint(buffer, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > buffer.length) throw new Error("Truncated protobuf bytes field");
      fields.push({ field, wire, bytes: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      if (offset > buffer.length) throw new Error("Truncated protobuf fixed32");
      fields.push({ field, wire });
      continue;
    }
    throw new Error(`Unsupported protobuf wire type: ${wire}`);
  }
  return fields;
}

function requiredBytesField(buffer: Buffer, field: number, label: string): Buffer {
  const value = readFields(buffer).find(
    (item) => item.field === field && item.wire === 2 && item.bytes !== undefined,
  )?.bytes;
  if (value === undefined) throw new Error(`${label} is missing field ${field}`);
  return value;
}

function optionalStringField(buffer: Buffer, field: number): string | null {
  const value = readFields(buffer).find(
    (item) => item.field === field && item.wire === 2 && item.bytes !== undefined,
  )?.bytes;
  return value === undefined ? null : value.toString("utf8");
}

function decodeVarint(
  buffer: Buffer,
  start: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset];
    if (byte === undefined) break;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Invalid or truncated protobuf varint");
}
