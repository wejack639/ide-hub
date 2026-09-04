import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCursorChatExport,
  decodeCursorVisibleTurns,
  inspectCursorRootPromptHistory,
} from "../src/cursor/protocol.js";
import type { QoderConversationProjection } from "../src/types.js";

const projection: QoderConversationProjection = {
  schemaVersion: "ide-hub-qoder-conversation-projection-v1",
  sourceMessageCount: 4,
  projectedMessageCount: 4,
  turns: [
    {
      requestId: "request-1",
      sourceTurnIds: ["turn-1"],
      sourceItemIds: ["user-1", "assistant-1"],
      sourceMessageCount: 2,
      messages: [
        { role: "user", content: "CURSOR_SENTINEL_ALPHA" },
        { role: "assistant", content: "Continue with nextAction one." },
      ],
    },
    {
      requestId: "request-2",
      sourceTurnIds: ["turn-2"],
      sourceItemIds: ["user-2", "assistant-2"],
      sourceMessageCount: 2,
      messages: [
        { role: "user", content: "第二轮问题" },
        { role: "assistant", content: "第二轮回答" },
      ],
    },
  ],
};

test("Cursor Chat v1 projection preserves visible turns exactly", () => {
  let id = 0;
  const payload = buildCursorChatExport(projection, "Codex · Fixture", {
    workspace: "/tmp/cursor-fixture",
    exportedAt: 123,
    createId: () => `message-${++id}`,
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.name, "Codex · Fixture");
  assert.equal(payload.exportedAt, 123);
  const state = Buffer.from(payload.conversationState, "base64");
  const firstFieldLength = decodeVarint(state, 1);
  assert.equal(firstFieldLength.value, 32);
  assert.equal(Object.keys(payload.blobs).length, 12);
  const firstBlobId = state.subarray(firstFieldLength.offset, firstFieldLength.offset + firstFieldLength.value);
  const systemRoot = JSON.parse(
    Buffer.from(payload.blobs[firstBlobId.toString("hex")] as string, "base64").toString("utf8"),
  ) as { content: Array<{ text: string; type: string }>; id: string; role: string };
  assert.equal(systemRoot.role, "system");
  assert.equal(systemRoot.id, "system");
  assert.equal(systemRoot.content[0]?.type, "text");
  assert.deepEqual(inspectCursorRootPromptHistory(payload.conversationState, payload.blobs), {
    rootMessageCount: 6,
    systemPromptRootCount: 1,
    systemPromptRootFirst: true,
    historyMessages: projection.turns.flatMap((turn) => turn.messages),
  });
  assert.deepEqual(decodeCursorVisibleTurns(payload.conversationState, payload.blobs), [
    projection.turns[0]?.messages,
    projection.turns[1]?.messages,
  ]);
  assert.deepEqual(
    decodeCursorVisibleTurns(`~${payload.conversationState}`, payload.blobs),
    [
    projection.turns[0]?.messages,
    projection.turns[1]?.messages,
    ],
  );
});

test("Cursor root history rejects the old payload shape without a system root", () => {
  const payload = buildCursorChatExport(projection, "Codex · Fixture", {
    workspace: "/tmp/cursor-fixture",
    exportedAt: 123,
    createId: () => "message-id",
  });
  const state = Buffer.from(payload.conversationState, "base64");
  const firstFieldLength = decodeVarint(state, 1);
  const oldShape = state.subarray(firstFieldLength.offset + firstFieldLength.value);
  assert.deepEqual(inspectCursorRootPromptHistory(oldShape.toString("base64"), payload.blobs), {
    rootMessageCount: 5,
    systemPromptRootCount: 0,
    systemPromptRootFirst: false,
    historyMessages: projection.turns.flatMap((turn) => turn.messages),
  });
});

test("Cursor root history rejects inline JSON where a 32-byte BlobID is required", () => {
  const payload = buildCursorChatExport(projection, "Codex · Fixture", {
    workspace: "/tmp/cursor-fixture",
    exportedAt: 123,
    createId: () => "message-id",
  });
  const state = Buffer.from(payload.conversationState, "base64");
  const firstFieldLength = decodeVarint(state, 1);
  const firstBlobId = state.subarray(firstFieldLength.offset, firstFieldLength.offset + firstFieldLength.value);
  const firstBlob = Buffer.from(payload.blobs[firstBlobId.toString("hex")] as string, "base64");
  const invalidState = Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(firstBlob.length),
    firstBlob,
    state.subarray(firstFieldLength.offset + firstFieldLength.value),
  ]);

  assert.throws(
    () => inspectCursorRootPromptHistory(invalidState.toString("base64"), payload.blobs),
    /BlobID must be 32 bytes/u,
  );
});

function decodeVarint(buffer: Buffer, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset] as number;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Truncated varint");
}

function encodeVarint(value: number): Buffer {
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
