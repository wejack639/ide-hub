import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  buildDshSessionSeed,
  decodeDshVisibleMessages,
  DSH_SESSION_EVENT_PROTOCOL_VERSION,
  inspectDshSeed,
} from "../src/dsh/protocol.js";
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
        { role: "user", content: "DSH_SENTINEL_ALPHA" },
        { role: "assistant", content: "The sentinel is DSH_SENTINEL_ALPHA." },
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

test("DSH seed uses contiguous balanced native SessionEvent v0 history", () => {
  const seed = buildDshSessionSeed(projection, {
    sourceIdentitySha256: "a".repeat(64),
    baseTime: 1_700_000_000_000,
  });

  assert.equal(seed.protocolVersion, DSH_SESSION_EVENT_PROTOCOL_VERSION);
  assert.deepEqual(
    seed.events.map((event) => event.seq),
    seed.events.map((_, index) => index),
  );
  assert.deepEqual(inspectDshSeed(seed.events), {
    eventCount: 12,
    turnCount: 2,
    stepCount: 2,
    userMessageCount: 2,
    assistantMessageCount: 2,
    balanced: true,
    danglingToolCallCount: 0,
  });
  assert.deepEqual(
    decodeDshVisibleMessages(seed.events),
    projection.turns.flatMap((turn) => turn.messages),
  );
  const assistant = seed.events.find(
    (event) => event.type === "assistant/message",
  )?.data.message;
  assert.equal(assistant?.source.kind, "model");
  assert.equal(
    assistant?.source.kind === "model" ? assistant.source.provider : undefined,
    "codex-import",
  );
});

test("DSH message ids ignore nondeterministic projection request ids", () => {
  const first = buildDshSessionSeed(projection, {
    sourceIdentitySha256: "a".repeat(64),
    baseTime: 1_700_000_000_000,
  });
  const second = buildDshSessionSeed(
    {
      ...projection,
      turns: projection.turns.map((turn, index) => ({
        ...turn,
        requestId: `different-runtime-request-${index}`,
      })),
    },
    {
      sourceIdentitySha256: "a".repeat(64),
      baseTime: 1_700_000_000_000,
    },
  );

  assert.deepEqual(second.events, first.events);
});

test("DSH seed passes the installed rc.6 detached native Session validator", async (t) => {
  const sessionModule =
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
  try {
    await access(sessionModule);
  } catch {
    t.skip("DeepSeek Harness rc.6 is not installed on this machine");
    return;
  }
  const native = await import(pathToFileURL(sessionModule).href) as {
    Session: {
      create(id: string, events: unknown[], header: Record<string, unknown>): {
        events: Array<{ type: string }>;
        deriveMessages(): Array<{ role: string; content: Array<{ text?: string }> }>;
      };
    };
  };
  const seed = buildDshSessionSeed(projection, {
    sourceIdentitySha256: "a".repeat(64),
    baseTime: 1_700_000_000_000,
  });
  const sessionId = "session-ide-hub-native-fixture";
  const session = native.Session.create(sessionId, seed.events, {
    version: 0,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: "/tmp",
    seedLength: seed.events.length,
    agentPreset: "standard",
  });

  assert.equal(session.events.at(-1)?.type, "session/end-seed");
  assert.equal(session.deriveMessages().length, projection.projectedMessageCount);
});
