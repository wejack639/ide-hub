import type {
  CodexThread,
  CodexThreadItem,
  CodexTurn,
  SourceSnapshot,
} from "../src/types.js";

export function threadItem(
  type: string,
  fields: Record<string, unknown> = {},
): CodexThreadItem {
  return { type, ...fields };
}

export function turn(
  id: string,
  items: CodexThreadItem[] = [],
  status: CodexTurn["status"] = "completed",
): CodexTurn {
  return {
    id,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

export function thread(
  workspace: string,
  turns: CodexTurn[],
  historyMode: CodexThread["historyMode"] = "paginated",
): CodexThread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    preview: "Build the feature",
    ephemeral: false,
    historyMode,
    cwd: workspace,
    path: "/tmp/source.jsonl",
    status: { type: "notLoaded" },
    createdAt: 1,
    updatedAt: 2,
    name: "Fixture thread",
    source: "vscode",
    cliVersion: "0.151.0",
    turns,
  };
}

export function snapshot(
  workspace: string,
  turns: CodexTurn[],
): SourceSnapshot {
  return {
    schemaVersion: "ide-hub-source-snapshot-v1",
    capturedAt: "2026-09-02T00:00:00.000Z",
    thread: thread(workspace, turns),
    sourceFile: {
      path: "/tmp/source.jsonl",
      size: 100,
      mtimeMs: 1,
      sha256: "a".repeat(64),
    },
    workspace: {
      sourceWorkspaceRaw: workspace,
      workspaceCanonical: workspace,
      workspaceIdentity: { device: 1, inode: 2 },
    },
    reader: {
      historyMode: "paginated",
      turnPages: 1,
      itemPages: 1,
      turnCount: turns.length,
      itemCount: turns.reduce((sum, value) => sum + value.items.length, 0),
      finalTurnCursor: null,
      finalItemCursor: null,
    },
  };
}
