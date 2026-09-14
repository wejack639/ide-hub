import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { MigrationError } from "../errors.js";
import type { CodeBuddyInstallation } from "../types.js";
import {
  type CodeBuddyArchiveConversation,
  type CodeBuddyArchiveMessage,
  parseCoreMessage,
} from "./protocol.js";

export type CodeBuddyImportVerification = {
  targetSessionId: string;
  archiveId: string;
  workspace: string;
  workspaceHash: string;
  historyRoot: string;
  targetHistoryPath: string;
  importedRequestCount: number;
  importedMessageCount: number;
  continuationRequestCount: number;
  continuationMessageCount: number;
  continuationCompletedRoundCount: number;
  historyVisible: true;
};

export const CODEBUDDY_CONTINUATION_GATE_ROUNDS = 2;

/** 两轮都必须是已经持久化完成、同时包含可见 User 和 Assistant 的原生 request。 */
export function hasCodeBuddyPersistedContinuationRounds(
  verification: CodeBuddyImportVerification,
): boolean {
  return verification.continuationCompletedRoundCount >= CODEBUDDY_CONTINUATION_GATE_ROUNDS;
}

type ImportEvidence = {
  logPath: string;
  historyWorkspaceRoot: string;
  workspaceHash: string;
  targetSessionId: string;
};

export function codeBuddyWorkspaceHash(canonicalWorkspace: string): string {
  return createHash("md5").update(canonicalWorkspace.normalize("NFC")).digest("hex");
}

/**
 * 只接受所选产品日志中由官方 Import 产生的 originalId 记录，再回读其工作区分区。
 * 这样中央 History 根即使被两版共享，也不会把另一版的导入认领为当前产品。
 */
export async function findCodeBuddyImportedConversation(input: {
  installation: CodeBuddyInstallation;
  workspace: string;
  expectedConversation: CodeBuddyArchiveConversation;
}): Promise<CodeBuddyImportVerification | null> {
  const expectedHash = codeBuddyWorkspaceHash(input.workspace);
  const evidence = await collectImportEvidence(
    input.installation.logsRoot,
    input.expectedConversation.id,
  );
  if (evidence.length === 0) return null;

  const unique = new Map<string, ImportEvidence>();
  for (const item of evidence) {
    unique.set(`${item.historyWorkspaceRoot}\0${item.targetSessionId}`, item);
  }
  const occurrences: ImportEvidence[] = [];
  for (const item of unique.values()) {
    if (await hasLiveImportEvidence(item, input.expectedConversation.id)) occurrences.push(item);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length > 1) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_AMBIGUOUS",
      "同一 CodeBuddy 归档被当前目标版本导入了多次；请在官方 History 中只保留一份后重试",
      { archiveId: input.expectedConversation.id, occurrences },
    );
  }
  const found = occurrences[0]!;
  assertUnderDataRoot(found.historyWorkspaceRoot, input.installation.historyDataRoot);
  if (found.workspaceHash !== expectedHash) {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      `CodeBuddy 归档导入到了工作区 ${found.workspaceHash}，预期 A 的工作区键为 ${expectedHash}`,
      {
        expectedWorkspace: input.workspace,
        expectedWorkspaceHash: expectedHash,
        actualWorkspaceHash: found.workspaceHash,
        logPath: found.logPath,
      },
    );
  }
  return verifyCodeBuddyConversationAt({
    workspace: input.workspace,
    historyWorkspaceRoot: found.historyWorkspaceRoot,
    targetSessionId: found.targetSessionId,
    expectedConversation: input.expectedConversation,
  });
}

async function hasLiveImportEvidence(
  evidence: ImportEvidence,
  archiveId: string,
): Promise<boolean> {
  if (existsSync(resolve(evidence.historyWorkspaceRoot, evidence.targetSessionId, "index.json"))) {
    return true;
  }
  const workspaceIndexPath = resolve(evidence.historyWorkspaceRoot, "index.json");
  if (!existsSync(workspaceIndexPath)) return false;
  try {
    const workspaceIndex: unknown = JSON.parse(await readFile(workspaceIndexPath, "utf8"));
    return isRecord(workspaceIndex) &&
      Array.isArray(workspaceIndex.conversations) &&
      workspaceIndex.conversations.some((value) =>
        isRecord(value) &&
        value.id === evidence.targetSessionId &&
        (value.originalId === archiveId || value.id === archiveId),
      );
  } catch {
    // 有官方 Import 日志但索引损坏时保留证据，让后续严格回读返回明确错误。
    return true;
  }
}

/** 已验证映射的后续幂等检查不再依赖日志保留期，但仍严格回读原生前缀。 */
export async function verifyCodeBuddyConversationAt(input: {
  workspace: string;
  historyWorkspaceRoot: string;
  targetSessionId: string;
  expectedConversation: CodeBuddyArchiveConversation;
}): Promise<CodeBuddyImportVerification> {
  const workspaceHash = codeBuddyWorkspaceHash(input.workspace);
  if (resolve(input.historyWorkspaceRoot).split(sep).at(-1) !== workspaceHash) {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      "CodeBuddy 映射中的原生 History 工作区键与源目录 A 不一致",
    );
  }
  const workspaceIndexPath = resolve(input.historyWorkspaceRoot, "index.json");
  const workspaceIndex = await readJson(workspaceIndexPath, "CodeBuddy 工作区 History 索引不存在或损坏");
  if (!isRecord(workspaceIndex) || !Array.isArray(workspaceIndex.conversations)) {
    throw historyInvalid("CodeBuddy 工作区 History 索引结构无效");
  }
  const archiveMetadata = workspaceIndex.conversations.filter((value) => {
    if (!isRecord(value)) return false;
    return value.originalId === input.expectedConversation.id || value.id === input.expectedConversation.id;
  });
  if (archiveMetadata.length > 1) {
    throw new MigrationError(
      "CODEBUDDY_TARGET_AMBIGUOUS",
      "同一 CodeBuddy 归档在 A 的官方 History 中存在多份，拒绝选择任意一份",
      { archiveId: input.expectedConversation.id, targetSessionId: input.targetSessionId },
    );
  }
  const matchingMetadata = archiveMetadata.filter((value) => {
    if (!isRecord(value)) return false;
    return value.id === input.targetSessionId &&
      (value.originalId === input.expectedConversation.id || value.id === input.expectedConversation.id);
  });
  if (matchingMetadata.length !== 1) {
    throw historyInvalid("CodeBuddy 工作区索引没有确切的 imported originalId / id");
  }

  const conversationRoot = resolve(input.historyWorkspaceRoot, input.targetSessionId);
  const conversationIndex = await readJson(
    resolve(conversationRoot, "index.json"),
    "CodeBuddy 目标会话索引不存在或损坏",
  );
  if (
    !isRecord(conversationIndex) ||
    !Array.isArray(conversationIndex.requests) ||
    !Array.isArray(conversationIndex.messages)
  ) {
    throw historyInvalid("CodeBuddy 目标会话索引结构无效");
  }
  const expectedRequests = input.expectedConversation.requests;
  if (conversationIndex.requests.length < expectedRequests.length) {
    throw historyInvalid("CodeBuddy 目标会话 request 数量少于导入归档");
  }
  const expectedMessages = expectedRequests.flatMap((request) => request.messages);
  if (conversationIndex.messages.length < expectedMessages.length) {
    throw historyInvalid("CodeBuddy 目标会话 message 数量少于导入归档");
  }

  for (const [requestIndex, expectedRequest] of expectedRequests.entries()) {
    const actual = conversationIndex.requests[requestIndex];
    if (
      !isRecord(actual) ||
      actual.id !== expectedRequest.id ||
      actual.type !== expectedRequest.type ||
      actual.state !== "complete" ||
      !Array.isArray(actual.messages) ||
      actual.messages.length !== expectedRequest.messages.length ||
      actual.messages.some((id, index) => id !== expectedRequest.messages[index]?.id)
    ) {
      throw historyInvalid(`CodeBuddy 第 ${requestIndex + 1} 个 request 的 ID、关系或终态不一致`);
    }
  }

  for (const [messageIndex, expectedMessage] of expectedMessages.entries()) {
    const metadata = conversationIndex.messages[messageIndex];
    if (
      !isRecord(metadata) ||
      metadata.id !== expectedMessage.id ||
      metadata.role !== expectedMessage.role ||
      metadata.isComplete !== true
    ) {
      throw historyInvalid(`CodeBuddy 第 ${messageIndex + 1} 条消息索引不一致`);
    }
    const messagePath = resolve(conversationRoot, "messages", `${expectedMessage.id}.json`);
    const actualMessage = await readJson(messagePath, `CodeBuddy 第 ${messageIndex + 1} 条消息文件缺失或损坏`);
    if (!isRecord(actualMessage)) throw historyInvalid(`CodeBuddy 第 ${messageIndex + 1} 条消息不是对象`);
    const actual = actualMessage as unknown as CodeBuddyArchiveMessage;
    if (actual.id !== expectedMessage.id || actual.role !== expectedMessage.role || typeof actual.message !== "string") {
      throw historyInvalid(`CodeBuddy 第 ${messageIndex + 1} 条消息 ID 或角色不一致`);
    }
    const expectedCore = parseCoreMessage(expectedMessage);
    const actualCore = parseCoreMessage(actual);
    if (
      actualCore.role !== expectedCore.role ||
      textFromCore(actualCore.content) !== textFromCore(expectedCore.content)
    ) {
      throw historyInvalid(`CodeBuddy 第 ${messageIndex + 1} 条消息正文或换行不一致`);
    }
  }

  const continuationRequests = conversationIndex.requests.slice(expectedRequests.length);
  const continuationMetadata = conversationIndex.messages.slice(expectedMessages.length);
  const continuationMessageIds = new Set(expectedMessages.map((message) => message.id));
  const metadataById = new Map<string, Record<string, unknown>>();
  for (const [index, metadata] of continuationMetadata.entries()) {
    if (
      !isRecord(metadata) ||
      typeof metadata.id !== "string" ||
      continuationMessageIds.has(metadata.id) ||
      typeof metadata.role !== "string" ||
      typeof metadata.isComplete !== "boolean"
    ) {
      throw historyInvalid(`CodeBuddy 续聊第 ${index + 1} 条消息索引无效`);
    }
    continuationMessageIds.add(metadata.id);
    metadataById.set(metadata.id, metadata);
  }

  let continuationCompletedRoundCount = 0;
  const continuationRequestIds = new Set(expectedRequests.map((request) => request.id));
  const referencedContinuationMessageIds = new Set<string>();
  for (const [requestIndex, request] of continuationRequests.entries()) {
    if (
      !isRecord(request) ||
      typeof request.id !== "string" ||
      continuationRequestIds.has(request.id) ||
      typeof request.type !== "string" ||
      request.state !== "complete" ||
      !Array.isArray(request.messages) ||
      request.messages.length === 0
    ) {
      throw historyInvalid(`CodeBuddy 续聊第 ${requestIndex + 1} 个 request 未完整持久化`);
    }
    continuationRequestIds.add(request.id);
    const roles = new Set<string>();
    for (const messageId of request.messages) {
      if (typeof messageId !== "string" || !metadataById.has(messageId)) {
        throw historyInvalid(`CodeBuddy 续聊第 ${requestIndex + 1} 个 request 的消息关系无效`);
      }
      if (referencedContinuationMessageIds.has(messageId)) {
        throw historyInvalid(`CodeBuddy 续聊消息 ${messageId} 被重复引用`);
      }
      referencedContinuationMessageIds.add(messageId);
      const metadata = metadataById.get(messageId)!;
      const messagePath = resolve(conversationRoot, "messages", `${messageId}.json`);
      const raw = await readJson(messagePath, `CodeBuddy 续聊消息 ${messageId} 缺失或损坏`);
      if (!isRecord(raw)) throw historyInvalid(`CodeBuddy 续聊消息 ${messageId} 不是对象`);
      const message = raw as unknown as CodeBuddyArchiveMessage;
      if (message.id !== messageId || message.role !== metadata.role) {
        throw historyInvalid(`CodeBuddy 续聊消息 ${messageId} 的 ID 或角色不一致`);
      }
      const core = parseCoreMessage(message);
      if (core.role !== metadata.role || textFromCore(core.content).trim().length === 0) {
        throw historyInvalid(`CodeBuddy 续聊消息 ${messageId} 的正文或角色无效`);
      }
      roles.add(core.role);
    }
    if (roles.has("user") && roles.has("assistant")) continuationCompletedRoundCount += 1;
  }
  if (referencedContinuationMessageIds.size !== continuationMetadata.length) {
    throw historyInvalid("CodeBuddy 续聊消息索引存在未归属 request 的记录");
  }

  return {
    targetSessionId: input.targetSessionId,
    archiveId: input.expectedConversation.id,
    workspace: input.workspace,
    workspaceHash,
    historyRoot: input.historyWorkspaceRoot,
    targetHistoryPath: resolve(conversationRoot, "index.json"),
    importedRequestCount: expectedRequests.length,
    importedMessageCount: expectedMessages.length,
    continuationRequestCount: conversationIndex.requests.length - expectedRequests.length,
    continuationMessageCount: conversationIndex.messages.length - expectedMessages.length,
    continuationCompletedRoundCount,
    historyVisible: true,
  };
}

async function collectImportEvidence(logsRoot: string, archiveId: string): Promise<ImportEvidence[]> {
  const files = await listFiles(logsRoot);
  const evidence: ImportEvidence[] = [];
  const escapedId = escapeRegex(archiveId);
  const imported = new RegExp(
    `Imported conversation: originalId=${escapedId}, id=([A-Za-z0-9_-]+)`,
    "u",
  );
  for (const path of files) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let currentHistoryRoot: { path: string; hash: string } | null = null;
    for (const line of content.split("\n")) {
      const history = line.match(/History Base Path:\s+(.+\/history\/([a-f0-9]{32}))\/?\s*$/u);
      if (history?.[1] && history[2]) {
        currentHistoryRoot = { path: history[1], hash: history[2] };
      }
      const match = line.match(imported);
      if (match?.[1] && currentHistoryRoot !== null) {
        evidence.push({
          logPath: path,
          historyWorkspaceRoot: currentHistoryRoot.path,
          workspaceHash: currentHistoryRoot.hash,
          targetSessionId: match[1],
        });
      }
    }
  }
  return evidence;
}

async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const pending = [root];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".log")) {
        const metadata = await stat(path);
        files.push({ path, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).map((entry) => entry.path);
}

async function readJson(path: string, message: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new MigrationError("CODEBUDDY_HISTORY_INVALID", message, { path }, { cause: error });
  }
}

function assertUnderDataRoot(path: string, dataRoot: string): void {
  const candidate = resolve(path);
  const root = resolve(dataRoot);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith(sep)) {
    throw historyInvalid("CodeBuddy 日志返回了数据根之外的 History 路径");
  }
}

function textFromCore(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

function historyInvalid(message: string): MigrationError {
  return new MigrationError("CODEBUDDY_HISTORY_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
