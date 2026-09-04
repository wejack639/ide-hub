import { randomUUID } from "node:crypto";
import { MigrationError } from "./errors.js";
import type {
  NormalizedMessage,
  QoderConversationProjection,
  QoderHistoryMessage,
  QoderProjectedTurn,
} from "./types.js";

type PendingTurn = {
  sourceTurnIds: Set<string>;
  sourceItemIds: Array<string | null>;
  sourceMessageCount: number;
  user: string | null;
  assistants: string[];
};

export function projectConversationToQoder(
  sourceMessages: NormalizedMessage[],
  createRequestId: () => string = randomUUID,
): QoderConversationProjection {
  if (sourceMessages.length === 0) {
    throw new MigrationError(
      "SOURCE_CONVERSATION_EMPTY",
      "Codex thread contains no visible user or assistant messages",
    );
  }

  const turns: QoderProjectedTurn[] = [];
  let pending: PendingTurn | null = null;

  const flush = (): void => {
    if (pending === null) return;
    const messages: QoderHistoryMessage[] = [];
    if (pending.user !== null) {
      messages.push({ role: "user", content: pending.user });
    }
    if (pending.assistants.length > 0) {
      messages.push({
        role: "assistant",
        content: pending.assistants.join("\n\n"),
      });
    }
    turns.push({
      requestId: createRequestId(),
      sourceTurnIds: [...pending.sourceTurnIds],
      sourceItemIds: pending.sourceItemIds,
      sourceMessageCount: pending.sourceMessageCount,
      messages,
    });
    pending = null;
  };

  for (const message of sourceMessages) {
    if (message.role === "user") {
      flush();
      pending = {
        sourceTurnIds: new Set([message.turnId]),
        sourceItemIds: [message.itemId],
        sourceMessageCount: 1,
        user: message.text,
        assistants: [],
      };
      continue;
    }
    if (pending === null) {
      pending = {
        sourceTurnIds: new Set(),
        sourceItemIds: [],
        sourceMessageCount: 0,
        user: null,
        assistants: [],
      };
    }
    pending.sourceTurnIds.add(message.turnId);
    pending.sourceItemIds.push(message.itemId);
    pending.sourceMessageCount += 1;
    pending.assistants.push(message.text);
  }
  flush();

  return {
    schemaVersion: "ide-hub-qoder-conversation-projection-v1",
    sourceMessageCount: sourceMessages.length,
    projectedMessageCount: turns.reduce(
      (count, turn) => count + turn.messages.length,
      0,
    ),
    turns,
  };
}
