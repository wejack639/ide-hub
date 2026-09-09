import { createHash } from "node:crypto";
import { MigrationError } from "../errors.js";
import type {
  QoderConversationProjection,
  QoderHistoryMessage,
} from "../types.js";

export const DSH_SESSION_EVENT_PROTOCOL_VERSION =
  "dsh-session-event-v0-rc6-ide-hub-v3";

export type DshTextBlock = { type: "text"; text: string };

export type DshMessage = {
  id: string;
  role: "user" | "assistant";
  content: DshTextBlock[];
  source:
    | { kind: "user" }
    | { kind: "model"; provider: "codex-import"; model: "codex-visible-history" };
};

export type DshSessionEvent = {
  type:
    | "turn/start"
    | "step/start"
    | "user/message"
    | "assistant/message"
    | "step/end"
    | "turn/end";
  seq: number;
  time: number;
  data: {
    turn?: number;
    step?: number;
    reason?: { kind: "completed" };
    id?: string;
    role?: "user";
    content?: DshTextBlock[];
    source?: { kind: "user" };
    message?: DshMessage;
  };
  surfaceOp?: "append";
};

export type DshSessionSeed = {
  schemaVersion: "ide-hub-dsh-session-seed-v1";
  protocolVersion: typeof DSH_SESSION_EVENT_PROTOCOL_VERSION;
  events: DshSessionEvent[];
  summary: ReturnType<typeof inspectDshSeed>;
};

export function buildDshSessionSeed(
  projection: QoderConversationProjection,
  options: { sourceIdentitySha256: string; baseTime: number },
): DshSessionSeed {
  if (!Number.isSafeInteger(options.baseTime) || options.baseTime < 0) {
    throw new MigrationError(
      "DSH_PROTOCOL_UNSUPPORTED",
      "DSH seed baseTime must be a non-negative epoch millisecond integer",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(options.sourceIdentitySha256)) {
    throw new MigrationError(
      "DSH_PROTOCOL_UNSUPPORTED",
      "DSH seed source identity must be a sha256 digest",
    );
  }
  const events: DshSessionEvent[] = [];
  const append = (
    type: DshSessionEvent["type"],
    data: DshSessionEvent["data"],
    surface = false,
  ): void => {
    const seq = events.length;
    events.push({
      type,
      seq,
      time: options.baseTime + seq,
      data,
      ...(surface ? { surfaceOp: "append" as const } : {}),
    });
  };

  projection.turns.forEach((projectedTurn, turnIndex) => {
    const turn = turnIndex + 1;
    const step = 1;
    append("turn/start", { turn });
    append("step/start", { turn, step });
    projectedTurn.messages.forEach((message, messageIndex) => {
      const id = stableMessageId(
        options.sourceIdentitySha256,
        projectedTurn.sourceTurnIds,
        turnIndex,
        messageIndex,
        message,
      );
      if (message.role === "user") {
        append(
          "user/message",
          {
            id,
            role: "user",
            content: [{ type: "text", text: message.content }],
            source: { kind: "user" },
          },
          true,
        );
      } else {
        append(
          "assistant/message",
          {
            turn,
            step,
            message: {
              id,
              role: "assistant",
              content: [{ type: "text", text: message.content }],
              source: {
                kind: "model",
                provider: "codex-import",
                model: "codex-visible-history",
              },
            },
          },
          true,
        );
      }
    });
    append("step/end", { turn, step });
    append("turn/end", { turn, reason: { kind: "completed" } });
  });

  const summary = inspectDshSeed(events);
  return {
    schemaVersion: "ide-hub-dsh-session-seed-v1",
    protocolVersion: DSH_SESSION_EVENT_PROTOCOL_VERSION,
    events,
    summary,
  };
}

export function inspectDshSeed(events: readonly DshSessionEvent[]): {
  eventCount: number;
  turnCount: number;
  stepCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  balanced: true;
  danglingToolCallCount: 0;
} {
  let openTurn: number | null = null;
  let openStep: { turn: number; step: number } | null = null;
  let turnCount = 0;
  let stepCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  events.forEach((event, index) => {
    if (event.seq !== index || !Number.isFinite(event.time)) {
      invalidSeed(`event ${index} does not have a contiguous seq/time envelope`);
    }
    switch (event.type) {
      case "turn/start":
        if (openTurn !== null || openStep !== null || event.data.turn === undefined) {
          invalidSeed(`invalid turn/start at seq ${event.seq}`);
        }
        openTurn = event.data.turn;
        turnCount += 1;
        break;
      case "step/start":
        if (
          openTurn === null ||
          openStep !== null ||
          event.data.turn !== openTurn ||
          event.data.step === undefined
        ) {
          invalidSeed(`invalid step/start at seq ${event.seq}`);
        }
        openStep = { turn: event.data.turn, step: event.data.step };
        stepCount += 1;
        break;
      case "user/message":
        if (openStep === null || event.surfaceOp !== "append") {
          invalidSeed(`user/message at seq ${event.seq} is outside an open step`);
        }
        assertTextMessage(event.data, "user", event.seq);
        userMessageCount += 1;
        break;
      case "assistant/message":
        if (
          openStep === null ||
          event.surfaceOp !== "append" ||
          event.data.turn !== openStep.turn ||
          event.data.step !== openStep.step ||
          event.data.message === undefined
        ) {
          invalidSeed(`assistant/message at seq ${event.seq} is outside its open step`);
        }
        assertTextMessage(event.data.message, "assistant", event.seq);
        assistantMessageCount += 1;
        break;
      case "step/end":
        if (
          openStep === null ||
          event.data.turn !== openStep.turn ||
          event.data.step !== openStep.step
        ) {
          invalidSeed(`invalid step/end at seq ${event.seq}`);
        }
        openStep = null;
        break;
      case "turn/end":
        if (
          openTurn === null ||
          openStep !== null ||
          event.data.turn !== openTurn ||
          event.data.reason?.kind !== "completed"
        ) {
          invalidSeed(`invalid turn/end at seq ${event.seq}`);
        }
        openTurn = null;
        break;
    }
  });
  if (openTurn !== null || openStep !== null || turnCount === 0) {
    invalidSeed("DSH seed has an unclosed or empty turn sequence");
  }
  return {
    eventCount: events.length,
    turnCount,
    stepCount,
    userMessageCount,
    assistantMessageCount,
    balanced: true,
    danglingToolCallCount: 0,
  };
}

export function decodeDshVisibleMessages(
  events: readonly DshSessionEvent[],
): QoderHistoryMessage[] {
  const messages: QoderHistoryMessage[] = [];
  for (const event of events) {
    if (event.type === "user/message") {
      assertTextMessage(event.data, "user", event.seq);
      messages.push({
        role: "user",
        content: event.data.content?.map((block) => block.text).join("") ?? "",
      });
    }
    if (event.type === "assistant/message" && event.data.message !== undefined) {
      assertTextMessage(event.data.message, "assistant", event.seq);
      messages.push({
        role: "assistant",
        content: event.data.message.content.map((block) => block.text).join(""),
      });
    }
  }
  return messages;
}

function stableMessageId(
  sourceIdentitySha256: string,
  sourceTurnIds: readonly string[],
  turnIndex: number,
  messageIndex: number,
  message: QoderHistoryMessage,
): string {
  return `idehub-${createHash("sha256")
    .update(`${sourceIdentitySha256}\0${sourceTurnIds.join("\0")}\0${turnIndex}\0${messageIndex}\0${message.role}\0${message.content}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function assertTextMessage(
  message: DshSessionEvent["data"] | DshMessage,
  role: "user" | "assistant",
  seq: number,
): void {
  if (
    message.role !== role ||
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    !Array.isArray(message.content) ||
    message.content.length === 0 ||
    message.content.some(
      (block) => block.type !== "text" || typeof block.text !== "string",
    )
  ) {
    invalidSeed(`invalid ${role} text message at seq ${seq}`);
  }
}

function invalidSeed(message: string): never {
  throw new MigrationError("DSH_PROTOCOL_UNSUPPORTED", message);
}
