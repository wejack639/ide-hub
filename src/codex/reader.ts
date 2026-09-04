import { MigrationError } from "../errors.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexTurn,
  ReaderStats,
} from "../types.js";
import type { AppServerRequester } from "./app-server-client.js";

type ThreadReadResponse = { thread: CodexThread };
type ThreadListPage = {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};
type TurnsPage = {
  data: CodexTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};
type ItemEntry = { turnId: string; item: CodexThreadItem };
type ItemsPage = {
  data: ItemEntry[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

export type ReadCodexThreadResult = {
  thread: CodexThread;
  reader: ReaderStats;
};

export async function listCodexThreads(
  client: AppServerRequester,
): Promise<CodexThread[]> {
  const threads: CodexThread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.request<ThreadListPage>("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    threads.push(...page.data);
    cursor = nextCursor(page.nextCursor, seenCursors, "thread");
  } while (cursor !== null);
  return threads;
}

export async function readCodexThreadMetadata(
  client: AppServerRequester,
  threadId: string,
): Promise<CodexThread> {
  try {
    const response = await client.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: false,
    });
    assertThreadStable(response.thread);
    return response.thread;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (String(error).toLowerCase().includes("not found")) {
      throw new MigrationError(
        "SOURCE_THREAD_NOT_FOUND",
        `Codex thread not found: ${threadId}`,
        undefined,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function readCodexThread(
  client: AppServerRequester,
  threadId: string,
): Promise<ReadCodexThreadResult> {
  const metadataThread = await readCodexThreadMetadata(client, threadId);
  const metadata: ThreadReadResponse = { thread: metadataThread };
  if (metadata.thread.historyMode === "legacy") {
    const hydrated = await client.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: true,
    });
    assertTurnsStable(hydrated.thread.turns);
    return {
      thread: hydrated.thread,
      reader: {
        historyMode: "legacy",
        turnPages: 1,
        itemPages: 1,
        turnCount: hydrated.thread.turns.length,
        itemCount: hydrated.thread.turns.reduce(
          (count, turn) => count + turn.items.length,
          0,
        ),
        finalTurnCursor: null,
        finalItemCursor: null,
      },
    };
  }

  const turnsResult = await readAllTurns(client, threadId);
  const itemsResult = await readAllItems(client, threadId);
  const itemsByTurn = new Map<string, CodexThreadItem[]>();
  for (const entry of itemsResult.entries) {
    const items = itemsByTurn.get(entry.turnId) ?? [];
    items.push(entry.item);
    itemsByTurn.set(entry.turnId, items);
  }
  const turns = turnsResult.turns.map((turn) => ({
    ...turn,
    items: itemsByTurn.get(turn.id) ?? [],
    itemsView: "full",
  }));
  assertTurnsStable(turns);

  return {
    thread: { ...metadata.thread, turns },
    reader: {
      historyMode: "paginated",
      turnPages: turnsResult.pages,
      itemPages: itemsResult.pages,
      turnCount: turns.length,
      itemCount: itemsResult.entries.length,
      finalTurnCursor: null,
      finalItemCursor: null,
    },
  };
}

async function readAllTurns(
  client: AppServerRequester,
  threadId: string,
): Promise<{ turns: CodexTurn[]; pages: number }> {
  const turns: CodexTurn[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const seenCursors = new Set<string>();
  do {
    const page = await client.request<TurnsPage>("thread/turns/list", {
      threadId,
      cursor,
      limit: 100,
      sortDirection: "asc",
      itemsView: "notLoaded",
    });
    pages += 1;
    turns.push(...page.data);
    cursor = nextCursor(page.nextCursor, seenCursors, "turn");
  } while (cursor !== null);
  return { turns, pages };
}

async function readAllItems(
  client: AppServerRequester,
  threadId: string,
): Promise<{ entries: ItemEntry[]; pages: number }> {
  const entries: ItemEntry[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const seenCursors = new Set<string>();
  do {
    const page = await client.request<ItemsPage>("thread/items/list", {
      threadId,
      cursor,
      limit: 500,
      sortDirection: "asc",
    });
    pages += 1;
    entries.push(...page.data);
    cursor = nextCursor(page.nextCursor, seenCursors, "item");
  } while (cursor !== null);
  return { entries, pages };
}

function nextCursor(
  candidate: string | null,
  seen: Set<string>,
  kind: string,
): string | null {
  if (candidate === null) return null;
  if (seen.has(candidate)) {
    throw new Error(`Codex ${kind} pagination returned a repeated cursor`);
  }
  seen.add(candidate);
  return candidate;
}

function assertThreadStable(thread: CodexThread): void {
  if (thread.status.type === "active") {
    throw new MigrationError(
      "SOURCE_TURN_RUNNING",
      `Codex thread has an active turn: ${thread.id}`,
      { status: thread.status },
    );
  }
  if (thread.ephemeral || thread.path === null) {
    throw new MigrationError(
      "SOURCE_THREAD_NOT_FOUND",
      `Codex thread is not a durable local session: ${thread.id}`,
    );
  }
}

function assertTurnsStable(turns: CodexTurn[]): void {
  const running = turns.find((turn) => turn.status === "inProgress");
  if (running !== undefined) {
    throw new MigrationError(
      "SOURCE_TURN_RUNNING",
      `Codex thread has an in-progress turn: ${running.id}`,
    );
  }
}
