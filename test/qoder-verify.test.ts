import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MigrationError } from "../src/errors.js";
import {
  verifyQoderSessionWithClient,
  type QoderSessionReader,
} from "../src/qoder/verify.js";
import type { QoderIdeSession } from "../src/qoder/ide-rpc.js";
import { resolveWorkspace } from "../src/workspace.js";

function reader(session: QoderIdeSession, listed = true): QoderSessionReader {
  return {
    runtime: { socketPath: "/tmp/qoder.sock" },
    async request<T>(method: string): Promise<T> {
      if (method === "chat/getSessionById") return session as T;
      if (method === "chat/listAllSessions") {
        return (listed ? [session] : []) as T;
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
}

test("Qoder IDE verification requires exact native user/assistant turns and history visibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-verify-"));
  const workspace = join(root, "A");
  await mkdir(workspace);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const expected = await resolveWorkspace(workspace);
  const verified = await verifyQoderSessionWithClient(
    reader({
      sessionId,
      projectUri: workspace,
      sessionType: "assistant",
      chatRecords: [
        {
          requestId: "request-1",
          question: "Build the feature",
          answer: "Implemented and tested.",
        },
      ],
    }),
    sessionId,
    expected,
    [
      {
        requestId: "request-1",
        sourceTurnIds: ["turn-1"],
        sourceItemIds: ["user-1", "assistant-1"],
        sourceMessageCount: 2,
        messages: [
          { role: "user", content: "Build the feature" },
          { role: "assistant", content: "Implemented and tested." },
        ],
      },
    ],
  );
  assert.equal(verified.workspace, expected.workspaceCanonical);
  assert.equal(verified.projectedTurnCount, 1);
  assert.equal(verified.projectedMessageCount, 2);
  assert.equal(verified.historyVisible, true);
});

test("Qoder IDE verification rejects assistant history that differs from the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-answer-"));
  const workspace = join(root, "A");
  await mkdir(workspace);
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const expected = await resolveWorkspace(workspace);
  await assert.rejects(
    () =>
      verifyQoderSessionWithClient(
        reader({
          sessionId,
          projectUri: workspace,
          sessionType: "assistant",
          chatRecords: [
            {
              requestId: "request-2",
              question: "source question",
              answer: "different answer",
            },
          ],
        }),
        sessionId,
        expected,
        [
          {
            requestId: "request-2",
            sourceTurnIds: ["turn-1"],
            sourceItemIds: ["user-1", "assistant-1"],
            sourceMessageCount: 2,
            messages: [
              { role: "user", content: "source question" },
              { role: "assistant", content: "source answer" },
            ],
          },
        ],
      ),
    (error: unknown) =>
      error instanceof MigrationError && error.code === "TARGET_SESSION_NOT_PERSISTED",
  );
});

test("Qoder IDE verification rejects a persisted session hidden from Chat History", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-hidden-"));
  const workspace = join(root, "A");
  await mkdir(workspace);
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const expected = await resolveWorkspace(workspace);
  await assert.rejects(
    () =>
      verifyQoderSessionWithClient(
        reader(
          {
            sessionId,
            projectUri: workspace,
            sessionType: "assistant",
            chatRecords: [
              { requestId: "request-3", question: "source question", answer: "" },
            ],
          },
          false,
        ),
        sessionId,
        expected,
        [
          {
            requestId: "request-3",
            sourceTurnIds: ["turn-1"],
            sourceItemIds: ["user-1"],
            sourceMessageCount: 1,
            messages: [{ role: "user", content: "source question" }],
          },
        ],
      ),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
  );
});
