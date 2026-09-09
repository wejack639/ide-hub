import assert from "node:assert/strict";
import test from "node:test";
import { buildDshSessionSeed } from "../src/dsh/protocol.js";
import { verifyDshInspection } from "../src/dsh/verify.js";
import type { DshBridgeInspection } from "../src/dsh/bridge.js";
import type { QoderConversationProjection } from "../src/types.js";

test("DSH verification preserves a continuation after the imported prefix", () => {
  const projection: QoderConversationProjection = {
    schemaVersion: "ide-hub-qoder-conversation-projection-v1",
    sourceMessageCount: 2,
    projectedMessageCount: 2,
    turns: [
      {
        requestId: "runtime-random-id",
        sourceTurnIds: ["source-turn-1"],
        sourceItemIds: ["source-user-1", "source-assistant-1"],
        sourceMessageCount: 2,
        messages: [
          { role: "user", content: "sentinel question" },
          { role: "assistant", content: "sentinel answer" },
        ],
      },
    ],
  };
  const seed = buildDshSessionSeed(projection, {
    sourceIdentitySha256: "a".repeat(64),
    baseTime: 1_700_000_000_000,
  });
  const sessionId = "session-idehub-verification-fixture";
  const workspace = "/tmp/dsh-verification-fixture";
  const inspection: DshBridgeInspection = {
    sessionId,
    header: {
      version: 0,
      id: sessionId,
      createdAt: 1_700_000_000_000,
      cwd: workspace,
      seedLength: seed.events.length,
      agentPreset: "standard",
    },
    workspace: {
      workspaceId: "workspace-fixture",
      path: workspace,
      sessionAttached: true,
    },
    eventCount: seed.events.length + 7,
    eventTypes: [
      ...seed.events.map((event) => event.type),
      "session/end-seed",
      "turn/start",
      "step/start",
      "user/message",
      "assistant/message",
      "step/end",
      "turn/end",
    ],
    seedEvents: seed.events,
    messages: [
      ...projection.turns.flatMap((turn) => turn.messages),
      { role: "user", content: "continuation question" },
      { role: "assistant", content: "continuation answer" },
    ],
    historyVisible: true,
    reused: true,
  };

  const verification = verifyDshInspection(inspection, {
    sessionId,
    workspace,
    agentPreset: "standard",
    seed,
    projection,
  });

  assert.equal(verification.reused, true);
  assert.equal(verification.eventCount, seed.events.length + 7);
  assert.equal(inspection.messages.at(-1)?.content, "continuation answer");
});
