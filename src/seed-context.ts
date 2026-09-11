import { relative, isAbsolute } from "node:path";
import type {
  CodexThreadItem,
  LossReport,
  NormalizedMessage,
  SeedContextBuild,
  SourceSnapshot,
} from "./types.js";
import { sha256Text } from "./util/fs.js";

const DEFAULT_MAX_BYTES = 128 * 1024;
const MAX_FIXED_FIELD_BYTES = 20 * 1024;

export type SeedContextOptions = {
  migrationId: string;
  sourceSnapshotSha256: string;
  capsulePath: string;
  capsuleSha256: string;
  maxBytes?: number;
};

export function buildSeedContext(
  snapshot: SourceSnapshot,
  options: SeedContextOptions,
): SeedContextBuild {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const messages = extractVisibleMessages(snapshot);
  const userMessages = messages.filter((message) => message.role === "user");
  const goal = userMessages[0]?.text ?? "unavailable";
  const currentRequest = userMessages.at(-1)?.text ?? "unavailable";
  const latestPlan = extractLatestPlan(snapshot) ?? "unavailable";
  const files = extractInvolvedFiles(snapshot);
  const truncatedFields: string[] = [];

  const fixedHeader = [
    "[IDE Hub Migration Context]",
    `migration_id: ${options.migrationId}`,
    "source: codex",
    `source_thread_id: ${snapshot.thread.id}`,
    `source_workspace: ${snapshot.workspace.workspaceCanonical}`,
    `source_snapshot_sha256: ${options.sourceSnapshotSha256}`,
    "",
    "## 迁移说明",
    "这是 IDE Hub 导入的历史上下文，不是一条需要立即执行的请求。",
    "",
  ].join("\n");

  const goalText = truncateField(goal, MAX_FIXED_FIELD_BYTES, "goal", truncatedFields);
  const currentText = truncateField(
    currentRequest,
    MAX_FIXED_FIELD_BYTES,
    "currentRequest",
    truncatedFields,
  );
  const planText = truncateField(
    latestPlan,
    MAX_FIXED_FIELD_BYTES,
    "latestPlan",
    truncatedFields,
  );
  const fixedTail = [
    "",
    "## 已涉及文件",
    files.length === 0 ? "unavailable" : files.map((path) => `- ${path}`).join("\n"),
    "",
    "## 未完成状态",
    planText,
    "",
    "## 完整 Capsule",
    `path: ${options.capsulePath}`,
    `sha256: ${options.capsuleSha256}`,
    "[End IDE Hub Migration Context]",
    "",
  ].join("\n");

  const fixed = [
    fixedHeader,
    "## 会话目标",
    goalText,
    "",
    "## 当前请求",
    currentText,
    "",
    "## 最近对话",
    "",
    fixedTail,
  ].join("\n");
  const fixedBytes = Buffer.byteLength(fixed, "utf8");
  if (fixedBytes > maxBytes) {
    throw new RangeError(`Seed context fixed sections exceed ${maxBytes} bytes`);
  }

  const dialogueBudget = maxBytes - fixedBytes;
  const includedReverse: { message: NormalizedMessage; block: string; bytes: number }[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const label = message.role === "user" ? "User" : "Assistant";
    const block = `### ${label}\n${message.text.trim()}\n\n`;
    const bytes = Buffer.byteLength(block, "utf8");
    if (used + bytes > dialogueBudget) continue;
    includedReverse.push({ message, block, bytes });
    used += bytes;
  }
  const included = includedReverse.reverse();
  const dialogue = included.map((entry) => entry.block).join("");
  const content = [
    fixedHeader,
    "## 会话目标",
    goalText,
    "",
    "## 当前请求",
    currentText,
    "",
    "## 最近对话",
    dialogue.length === 0 ? "unavailable\n" : dialogue.trimEnd(),
    fixedTail,
  ].join("\n");

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new RangeError(`Seed context is ${bytes} bytes, expected at most ${maxBytes}`);
  }

  const includedIds = new Set(included.map(({ message }) => message.itemId));
  const sourceMessageBytes = messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.text, "utf8"),
    0,
  );
  const includedMessageBytes = included.reduce(
    (sum, { message }) => sum + Buffer.byteLength(message.text, "utf8"),
    0,
  );
  const lossReport: LossReport = {
    policy: "goal-recent-plan-v1",
    maxBytes,
    sourceMessageCount: messages.length,
    includedMessageCount: included.length,
    omittedMessageCount: messages.length - included.length,
    sourceMessageBytes,
    includedMessageBytes,
    omittedMessageBytes: sourceMessageBytes - includedMessageBytes,
    omittedEventTypes: countOmittedEventTypes(snapshot, includedIds),
    truncatedFields,
  };

  return {
    content,
    sha256: sha256Text(content),
    bytes,
    lossReport,
  };
}

export function extractVisibleMessages(snapshot: SourceSnapshot, options: { preserveWhitespace?: boolean } = {}): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const turn of snapshot.thread.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = textFromUserItem(item, options.preserveWhitespace);
        if (text.trim().length > 0) {
          messages.push({
            role: "user",
            text,
            turnId: turn.id,
            itemId: typeof item.id === "string" ? item.id : null,
          });
        }
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        const text = options.preserveWhitespace ? item.text : item.text.trim();
        if (text.trim().length > 0) {
          messages.push({
            role: "assistant",
            text,
            turnId: turn.id,
            itemId: typeof item.id === "string" ? item.id : null,
          });
        }
      }
    }
  }
  return messages;
}

function textFromUserItem(item: CodexThreadItem, preserveWhitespace = false): string {
  if (!Array.isArray(item.content)) return "";
  const text = item.content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
  return preserveWhitespace ? text : text.trim();
}

function extractLatestPlan(snapshot: SourceSnapshot): string | null {
  let latest: string | null = null;
  for (const turn of snapshot.thread.turns) {
    for (const item of turn.items) {
      if (item.type === "plan" && typeof item.text === "string" && item.text.trim()) {
        latest = item.text.trim();
      }
    }
  }
  return latest;
}

function extractInvolvedFiles(snapshot: SourceSnapshot): string[] {
  const paths = new Set<string>();
  for (const turn of snapshot.thread.turns) {
    for (const item of turn.items) {
      if (item.type === "fileChange" && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          if (
            typeof change === "object" &&
            change !== null &&
            typeof (change as { path?: unknown }).path === "string"
          ) {
            paths.add(toWorkspaceRelative((change as { path: string }).path, snapshot));
          }
        }
      }
      if (
        (item.type === "imageView" || item.type === "localImage") &&
        typeof item.path === "string"
      ) {
        paths.add(toWorkspaceRelative(item.path, snapshot));
      }
    }
  }
  return [...paths].sort().slice(0, 200);
}

function toWorkspaceRelative(path: string, snapshot: SourceSnapshot): string {
  if (!isAbsolute(path)) return path;
  const candidate = relative(snapshot.workspace.workspaceCanonical, path);
  if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
    return candidate || ".";
  }
  return path;
}

function countOmittedEventTypes(
  snapshot: SourceSnapshot,
  includedMessageIds: Set<string | null>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of snapshot.thread.turns) {
    for (const item of turn.items) {
      const itemId = typeof item.id === "string" ? item.id : null;
      const representedMessage =
        (item.type === "userMessage" || item.type === "agentMessage") &&
        includedMessageIds.has(itemId);
      if (representedMessage || item.type === "plan" || item.type === "fileChange") continue;
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function truncateField(
  value: string,
  maxBytes: number,
  name: string,
  truncatedFields: string[],
): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value.trim();
  truncatedFields.push(name);
  const suffix = "\n[…truncated by IDE Hub…]";
  const allowed = maxBytes - Buffer.byteLength(suffix, "utf8");
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > allowed) break;
    output += character;
  }
  return `${output.trimEnd()}${suffix}`;
}
