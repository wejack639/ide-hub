import assert from "node:assert/strict";
import test from "node:test";
import { MigrationError } from "../src/errors.js";
import {
  CODEBUDDY_ARCHIVE_MAX_BYTES,
  buildCodeBuddyArchive,
  codeBuddyArchiveId,
  decodeCodeBuddyArchiveMessages,
  parseCodeBuddyArchive,
  projectCodeBuddyHistory,
  serializeCodeBuddyArchive,
} from "../src/codebuddy/protocol.js";
import { snapshot, threadItem, turn } from "./fixtures.js";

function source(sourceSha = "a".repeat(64)) {
  return {
    ...snapshot("/tmp/A", [
      turn("turn-1", [
        threadItem("userMessage", { id: "u1", content: [{ type: "text", text: "你好 👋\n第二行" }] }),
        threadItem("agentMessage", { id: "a1", text: "第一段回答" }),
        threadItem("agentMessage", { id: "a2", text: "连续 Assistant 必须独立" }),
        threadItem("commandExecution", { id: "tool-1", command: "pwd" }),
      ]),
      turn("turn-2", [threadItem("userMessage", { id: "u2", content: [{ type: "text", text: "最后只有 user" }] })]),
    ]),
    sourceFile: { ...snapshot("/tmp/A", []).sourceFile, sha256: sourceSha },
  };
}

test("CodeBuddy archive v1 preserves every visible message without fake roles", () => {
  const input = source();
  const projection = projectCodeBuddyHistory(input, "codebuddy-international");
  const archive = buildCodeBuddyArchive(input, projection, "codebuddy-international");
  const serialized = serializeCodeBuddyArchive(archive);
  const parsed = parseCodeBuddyArchive(serialized);

  assert.deepEqual(decodeCodeBuddyArchiveMessages(parsed), [
    { role: "user", content: "你好 👋\n第二行" },
    { role: "assistant", content: "第一段回答" },
    { role: "assistant", content: "连续 Assistant 必须独立" },
    { role: "user", content: "最后只有 user" },
  ]);
  assert.equal(parsed.data.conversations[0]?.requests.every((request) => request.state === "complete"), true);
  assert.equal(serialized.includes('"role": "system"'), false);
  assert.equal(serialized.includes('"role": "tool"'), false);
  assert.equal(serialized.includes('"usage"'), false);
  assert.equal(serialized.includes('"model"'), false);
  assert.equal(projection.lossReport.omittedEventTypes.commandExecution, 1);
});

test("CodeBuddy IDs are deterministic per source snapshot and isolated per edition", () => {
  const input = source();
  const international = codeBuddyArchiveId(input, "codebuddy-international");
  const cn = codeBuddyArchiveId(input, "codebuddy-cn");
  assert.match(international, /^[A-Za-z0-9_-]+$/u);
  assert.match(cn, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(international, cn);
  assert.equal(international, codeBuddyArchiveId(input, "codebuddy-international"));
  assert.notEqual(international, codeBuddyArchiveId(source("b".repeat(64)), "codebuddy-international"));
});

test("CodeBuddy archive validator rejects duplicate IDs, invalid core messages, and over-limit JSON", () => {
  const input = source();
  const projection = projectCodeBuddyHistory(input, "codebuddy-cn");
  const archive = buildCodeBuddyArchive(input, projection, "codebuddy-cn");
  const conversation = archive.data.conversations[0]!;
  const first = conversation.requests[0]!.messages[0]!;
  conversation.requests[1]!.messages[0]!.id = first.id;
  assert.throws(
    () => parseCodeBuddyArchive(JSON.stringify(archive)),
    (error: unknown) => error instanceof MigrationError && error.code === "CODEBUDDY_ARCHIVE_INVALID",
  );

  const rebuilt = buildCodeBuddyArchive(input, projection, "codebuddy-cn");
  rebuilt.data.conversations[0]!.requests[0]!.messages[0]!.message = JSON.stringify({ role: "assistant", content: "wrong role" });
  assert.throws(() => parseCodeBuddyArchive(JSON.stringify(rebuilt)), /角色/u);

  const tooLarge = "x".repeat(CODEBUDDY_ARCHIVE_MAX_BYTES + 1);
  assert.throws(
    () => parseCodeBuddyArchive(tooLarge),
    (error: unknown) => error instanceof MigrationError && error.code === "CODEBUDDY_ARCHIVE_TOO_LARGE",
  );
});

test("CodeBuddy validator reads official international and CN native export suffix shapes", () => {
  const exportedAt = "2026-09-14T08:25:52.774Z";
  const archive = {
    schema: "codebuddy.conversation",
    schemaVersion: 1,
    exportedAt,
    data: {
      lastMessageAt: exportedAt,
      conversations: [{
        id: "official_export_fixture",
        originalId: "idehub_cb_cn_fixture",
        type: "craft",
        name: "脱敏原生导出结构",
        createdAt: exportedAt,
        lastMessageAt: exportedAt,
        requests: [
          {
            id: "native_request_international",
            type: "craft",
            state: "complete",
            startedAt: Date.parse(exportedAt),
            usage: {
              inputTokens: 12,
              outputTokens: 8,
              totalTokens: 20,
              lastTokens: 8,
              cacheTokens: 0,
              cachedWriteTokens: 0,
              cachedMissTokens: 12,
              credit: null,
            },
            messages: [
              {
                id: "native_user_international",
                role: "user",
                message: JSON.stringify({ role: "user", content: [{ type: "text", text: "继续" }] }),
                createdAt: exportedAt,
                extra: "{}",
                references: [],
              },
              {
                id: "native_assistant_international",
                role: "assistant",
                message: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "国际版回答" }] }),
                createdAt: exportedAt,
                extra: "{}",
              },
            ],
          },
          {
            id: "native_request_cn",
            type: "craft",
            state: "complete",
            startedAt: Date.parse(exportedAt),
            messages: [
              {
                id: "native_user_cn",
                role: "user",
                message: JSON.stringify({ role: "user", content: "下一步" }),
                createdAt: exportedAt,
              },
              {
                id: "native_assistant_cn",
                role: "assistant",
                message: JSON.stringify({
                  role: "assistant",
                  providerOptions: { codebuddy: { model: "redacted" } },
                  content: [
                    { type: "reasoning", text: "脱敏推理" },
                    { type: "text", text: "CN 回答" },
                  ],
                }),
                createdAt: exportedAt,
                extra: "{}",
              },
            ],
          },
        ],
      }],
    },
  };

  const parsed = parseCodeBuddyArchive(JSON.stringify(archive));
  assert.deepEqual(decodeCodeBuddyArchiveMessages(parsed), [
    { role: "user", content: "继续" },
    { role: "assistant", content: "国际版回答" },
    { role: "user", content: "下一步" },
    { role: "assistant", content: "CN 回答" },
  ]);

  archive.data.conversations[0]!.requests[0]!.startedAt = -1;
  assert.throws(() => parseCodeBuddyArchive(JSON.stringify(archive)), /request\.startedAt/u);
});
