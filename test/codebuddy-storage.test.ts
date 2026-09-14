import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { CodeBuddyInstallation } from "../src/types.js";
import {
  buildCodeBuddyArchive,
  projectCodeBuddyHistory,
} from "../src/codebuddy/protocol.js";
import {
  findCodeBuddyImportedConversation,
  codeBuddyWorkspaceHash,
  hasCodeBuddyPersistedContinuationRounds,
} from "../src/codebuddy/storage.js";
import { snapshot, threadItem, turn } from "./fixtures.js";

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function installation(dataRoot: string, logsRoot: string): CodeBuddyInstallation {
  return {
    targetProduct: "codebuddy-international",
    appPath: "/Applications/CodeBuddy.app",
    appName: "CodeBuddy.app",
    bundleId: "com.tencent.codebuddy",
    version: "4.12.0",
    compatible: true,
    compatibilityError: null,
    productCommit: "b4c35ed08ffb428910211608831a314565c1256e",
    applicationName: "buddy",
    extensionVersion: "3.10.0",
    extensionSha256: "hash",
    launcherPath: "/Applications/CodeBuddy.app/Contents/Resources/app/bin/code",
    userDataRoot: dirname(logsRoot),
    logsRoot,
    historyDataRoot: dataRoot,
  };
}

test("CodeBuddy readback requires target-edition log evidence and exact A workspace prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "idehub-codebuddy-"));
  const dataRoot = join(root, "Data");
  const logsRoot = join(root, "CodeBuddy", "logs");
  const workspace = "/tmp/A";
  const source = snapshot(workspace, [turn("t1", [
    threadItem("userMessage", { id: "u", content: [{ type: "text", text: "question" }] }),
    threadItem("agentMessage", { id: "a", text: "answer" }),
  ])]);
  const projection = projectCodeBuddyHistory(source, "codebuddy-international");
  const archive = buildCodeBuddyArchive(source, projection, "codebuddy-international");
  const expected = archive.data.conversations[0]!;
  const targetId = "native_target_1";
  const historyRoot = join(dataRoot, "account", "CodeBuddyIDE", "uid", "history");
  const workspaceRoot = join(historyRoot, codeBuddyWorkspaceHash(workspace));
  await json(join(workspaceRoot, "index.json"), {
    conversations: [{ id: targetId, originalId: expected.id, type: "craft", name: expected.name, createdAt: expected.createdAt, lastMessageAt: expected.lastMessageAt }],
    current: "",
  });
  await json(join(workspaceRoot, targetId, "index.json"), {
    messages: expected.requests.flatMap((request) => request.messages.map((message) => ({ id: message.id, type: "text", role: message.role, isComplete: true }))),
    requests: expected.requests.map((request) => ({ id: request.id, type: request.type, messages: request.messages.map((message) => message.id), state: request.state })),
  });
  for (const request of expected.requests) for (const message of request.messages) {
    await json(join(workspaceRoot, targetId, "messages", `${message.id}.json`), message);
  }
  const logPath = join(logsRoot, "run", "window1", "exthost", "Tencent-Cloud.coding-copilot", "Tencent Cloud CodeBuddy.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, [
    `History Base Path: ${workspaceRoot}/`,
    `[ConversationManager] Imported conversation: originalId=${expected.id}, id=${targetId}`,
  ].join("\n"));

  const found = await findCodeBuddyImportedConversation({
    installation: installation(dataRoot, logsRoot),
    workspace,
    expectedConversation: expected,
  });
  assert.equal(found?.targetSessionId, targetId);
  assert.equal(found?.importedMessageCount, 2);
  assert.equal(found?.continuationMessageCount, 0);

  const extraId = "target_added_message";
  const indexPath = join(workspaceRoot, targetId, "index.json");
  const index = JSON.parse(await (await import("node:fs/promises")).readFile(indexPath, "utf8"));
  index.messages.push({ id: extraId, type: "text", role: "user", isComplete: true });
  index.requests.push({ id: "target_added_request", type: "craft", messages: [extraId], state: "complete" });
  await json(indexPath, index);
  await json(join(workspaceRoot, targetId, "messages", `${extraId}.json`), {
    id: extraId,
    role: "user",
    message: JSON.stringify({ role: "user", content: "continue" }),
  });
  const continued = await findCodeBuddyImportedConversation({
    installation: installation(dataRoot, logsRoot),
    workspace,
    expectedConversation: expected,
  });
  assert.equal(continued?.continuationMessageCount, 1);
  assert.equal(continued?.continuationCompletedRoundCount, 0);
  assert.equal(continued === null ? false : hasCodeBuddyPersistedContinuationRounds(continued), false);

  const firstAssistantId = "target_added_assistant";
  index.messages.push({ id: firstAssistantId, type: "text", role: "assistant", isComplete: false });
  index.requests.at(-1).messages.push(firstAssistantId);
  const secondUserId = "target_second_user";
  const secondAssistantId = "target_second_assistant";
  index.messages.push(
    { id: secondUserId, type: "text", role: "user", isComplete: true },
    { id: secondAssistantId, type: "text", role: "assistant", isComplete: false },
  );
  index.requests.push({
    id: "target_second_request",
    type: "craft",
    messages: [secondUserId, secondAssistantId],
    state: "complete",
  });
  await json(indexPath, index);
  await json(join(workspaceRoot, targetId, "messages", `${firstAssistantId}.json`), {
    id: firstAssistantId,
    role: "assistant",
    message: JSON.stringify({ role: "assistant", content: "continued answer" }),
  });
  await json(join(workspaceRoot, targetId, "messages", `${secondUserId}.json`), {
    id: secondUserId,
    role: "user",
    message: JSON.stringify({ role: "user", content: "next" }),
  });
  await json(join(workspaceRoot, targetId, "messages", `${secondAssistantId}.json`), {
    id: secondAssistantId,
    role: "assistant",
    message: JSON.stringify({ role: "assistant", content: "next answer" }),
  });
  const twoRounds = await findCodeBuddyImportedConversation({
    installation: installation(dataRoot, logsRoot),
    workspace,
    expectedConversation: expected,
  });
  assert.equal(twoRounds?.continuationCompletedRoundCount, 2);
  assert.equal(twoRounds === null ? false : hasCodeBuddyPersistedContinuationRounds(twoRounds), true);
});

test("CodeBuddy readback reports import into B instead of accepting it as A", async () => {
  const root = await mkdtemp(join(tmpdir(), "idehub-codebuddy-wrong-workspace-"));
  const dataRoot = join(root, "Data");
  const logsRoot = join(root, "CodeBuddy", "logs");
  const source = snapshot("/tmp/A", [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "q" }] })])]);
  const projection = projectCodeBuddyHistory(source, "codebuddy-international");
  const expected = buildCodeBuddyArchive(source, projection, "codebuddy-international").data.conversations[0]!;
  const wrongRoot = join(dataRoot, "account", "CodeBuddyIDE", "uid", "history", codeBuddyWorkspaceHash("/tmp/B"));
  await json(join(wrongRoot, "index.json"), { conversations: [{ id: expected.id, originalId: expected.id }], current: "" });
  const logPath = join(logsRoot, "run", "window", "extension.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `History Base Path: ${wrongRoot}/\n[ConversationManager] Imported conversation: originalId=${expected.id}, id=${expected.id}\n`);
  await assert.rejects(
    findCodeBuddyImportedConversation({ installation: installation(dataRoot, logsRoot), workspace: "/tmp/A", expectedConversation: expected }),
    /工作区|workspace/iu,
  );
});

test("CodeBuddy ignores stale Import logs after the official target was deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "idehub-codebuddy-stale-log-"));
  const dataRoot = join(root, "Data");
  const logsRoot = join(root, "CodeBuddy", "logs");
  const source = snapshot("/tmp/A", [turn("t", [threadItem("userMessage", { content: [{ type: "text", text: "q" }] })])]);
  const expected = buildCodeBuddyArchive(
    source,
    projectCodeBuddyHistory(source, "codebuddy-international"),
    "codebuddy-international",
  ).data.conversations[0]!;
  const workspaceRoot = join(dataRoot, "account", "CodeBuddyIDE", "uid", "history", codeBuddyWorkspaceHash("/tmp/A"));
  const logPath = join(logsRoot, "run", "window", "extension.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `History Base Path: ${workspaceRoot}/\n[ConversationManager] Imported conversation: originalId=${expected.id}, id=deleted_target\n`);

  assert.equal(await findCodeBuddyImportedConversation({
    installation: installation(dataRoot, logsRoot),
    workspace: "/tmp/A",
    expectedConversation: expected,
  }), null);
});
