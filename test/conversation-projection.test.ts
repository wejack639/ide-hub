import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationToQoder } from "../src/conversation-projection.js";
import { MigrationError } from "../src/errors.js";
import type { NormalizedMessage } from "../src/types.js";

function ids(): () => string {
  let value = 0;
  return () => `request-${++value}`;
}

test("conversation projection creates one native Qoder record per user turn", () => {
  const messages: NormalizedMessage[] = [
    { role: "user", text: "USER_1", turnId: "turn-1", itemId: "u1" },
    { role: "assistant", text: "ASSISTANT_1", turnId: "turn-1", itemId: "a1" },
    { role: "user", text: "USER_2", turnId: "turn-2", itemId: "u2" },
    { role: "assistant", text: "ASSISTANT_2", turnId: "turn-2", itemId: "a2" },
  ];
  const projection = projectConversationToQoder(messages, ids());
  assert.equal(projection.turns.length, 2);
  assert.deepEqual(
    projection.turns.map((turn) => turn.messages),
    [
      [
        { role: "user", content: "USER_1" },
        { role: "assistant", content: "ASSISTANT_1" },
      ],
      [
        { role: "user", content: "USER_2" },
        { role: "assistant", content: "ASSISTANT_2" },
      ],
    ],
  );
  assert.deepEqual(
    projection.turns.map((turn) => turn.requestId),
    ["request-1", "request-2"],
  );
});

test("conversation projection preserves consecutive assistant messages in source order", () => {
  const projection = projectConversationToQoder(
    [
      { role: "user", text: "question", turnId: "turn-1", itemId: "u1" },
      { role: "assistant", text: "progress one", turnId: "turn-1", itemId: "a1" },
      { role: "assistant", text: "final answer", turnId: "turn-1", itemId: "a2" },
    ],
    ids(),
  );
  assert.deepEqual(projection.turns[0]?.messages, [
    { role: "user", content: "question" },
    { role: "assistant", content: "progress one\n\nfinal answer" },
  ]);
  assert.equal(projection.sourceMessageCount, 3);
  assert.equal(projection.projectedMessageCount, 2);
  assert.equal(projection.turns[0]?.sourceMessageCount, 3);
  assert.ok(
    projection.turns.flatMap((turn) => turn.messages).every(
      (message) => !message.content.includes("[IDE Hub Migration Context]"),
    ),
  );
});

test("conversation projection keeps user-only turns separate", () => {
  const projection = projectConversationToQoder(
    [
      { role: "user", text: "first", turnId: "turn-1", itemId: "u1" },
      { role: "user", text: "second", turnId: "turn-2", itemId: "u2" },
    ],
    ids(),
  );
  assert.deepEqual(
    projection.turns.map((turn) => turn.messages),
    [
      [{ role: "user", content: "first" }],
      [{ role: "user", content: "second" }],
    ],
  );
});

test("conversation projection rejects a source without visible chat messages", () => {
  assert.throws(
    () => projectConversationToQoder([], ids()),
    (error: unknown) =>
      error instanceof MigrationError && error.code === "SOURCE_CONVERSATION_EMPTY",
  );
});
