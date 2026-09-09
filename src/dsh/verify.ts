import { MigrationError } from "../errors.js";
import type {
  DshVerification,
  QoderConversationProjection,
  QoderHistoryMessage,
} from "../types.js";
import { stableJson } from "../util/stable-json.js";
import type { DshBridgeInspection } from "./bridge.js";
import {
  inspectDshSeed,
  type DshSessionSeed,
} from "./protocol.js";

export function verifyDshInspection(
  inspection: DshBridgeInspection,
  expected: {
    sessionId: string;
    workspace: string;
    agentPreset: "standard";
    seed: DshSessionSeed;
    projection: QoderConversationProjection;
  },
): DshVerification {
  const expectedMessages = expected.projection.turns.flatMap(
    (turn) => turn.messages,
  );
  if (
    inspection.sessionId !== expected.sessionId ||
    inspection.header.id !== expected.sessionId ||
    inspection.header.version !== 0 ||
    inspection.header.cwd !== expected.workspace ||
    inspection.workspace.path !== expected.workspace ||
    inspection.header.agentPreset !== expected.agentPreset ||
    inspection.header.seedLength !== expected.seed.events.length
  ) {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      "DSH native readback did not preserve the requested session identity, cwd, seed boundary, and preset",
      { inspection, expectedSessionId: expected.sessionId, expectedWorkspace: expected.workspace },
    );
  }
  inspectDshSeed(inspection.seedEvents);
  if (stableJson(inspection.seedEvents) !== stableJson(expected.seed.events)) {
    throw new MigrationError(
      "DSH_PROTOCOL_UNSUPPORTED",
      "DSH native readback seed differs from the generated SessionEvent projection",
    );
  }
  const actualPrefix = inspection.messages.slice(0, expectedMessages.length);
  if (stableJson(actualPrefix) !== stableJson(expectedMessages)) {
    throw new MigrationError(
      "DSH_IMPORT_FAILED",
      "DSH native derived message history differs from the Codex projection",
      {
        expectedMessageCount: expectedMessages.length,
        actualMessageCount: inspection.messages.length,
      },
    );
  }
  if (
    !inspection.historyVisible ||
    !inspection.workspace.sessionAttached ||
    inspection.eventTypes[expected.seed.events.length] !== "session/end-seed"
  ) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
      "DSH session is not attached to the expected workspace with a valid seed boundary",
    );
  }
  return {
    sessionId: inspection.sessionId,
    workspace: inspection.workspace.path,
    workspaceId: inspection.workspace.workspaceId,
    agentPreset: expected.agentPreset,
    seedLength: expected.seed.events.length,
    eventCount: inspection.eventCount,
    projectedTurnCount: expected.projection.turns.length,
    projectedMessageCount: expectedMessages.length,
    historyVisible: true,
    reused: inspection.reused === true,
  };
}

export function hasDshMessagePrefix(
  actual: readonly QoderHistoryMessage[],
  expected: readonly QoderHistoryMessage[],
): boolean {
  return stableJson(actual.slice(0, expected.length)) === stableJson(expected);
}
