import { realpath } from "node:fs/promises";
import { MigrationError } from "../errors.js";
import type {
  QoderProjectedTurn,
  QoderTargetProduct,
  QoderVerification,
  WorkspaceIdentity,
} from "../types.js";
import { assertSameWorkspace } from "../workspace.js";
import {
  QoderIdeRpcClient,
  type QoderIdeRuntime,
  type QoderIdeSession,
  waitForQoderIdeRuntime,
} from "./ide-rpc.js";

export type QoderSessionReader = {
  runtime: Pick<QoderIdeRuntime, "socketPath">;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export async function verifyQoderSession(
  targetSessionId: string,
  expectedWorkspace: WorkspaceIdentity,
  expectedTurns: QoderProjectedTurn[],
  qoderIdeVersion: string,
  options: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
    targetProduct?: QoderTargetProduct;
  } = {},
): Promise<QoderVerification> {
  const runtimeOptions: {
    dataRoot?: string;
    socketName?: "qoder.sock" | "qodercn.sock";
  } = {};
  if (options.dataRoot !== undefined) runtimeOptions.dataRoot = options.dataRoot;
  if (options.socketName !== undefined) runtimeOptions.socketName = options.socketName;
  const runtime = await waitForQoderIdeRuntime(runtimeOptions);
  const client = await QoderIdeRpcClient.connect(
    runtime,
    expectedWorkspace.workspaceCanonical,
    qoderIdeVersion,
    options.targetProduct === undefined
      ? {}
      : { targetProduct: options.targetProduct },
  );
  try {
    return await verifyQoderSessionWithClient(
      client,
      targetSessionId,
      expectedWorkspace,
      expectedTurns,
    );
  } finally {
    client.close();
  }
}

export async function verifyQoderSessionWithClient(
  client: QoderSessionReader,
  targetSessionId: string,
  expectedWorkspace: WorkspaceIdentity,
  expectedTurns: QoderProjectedTurn[],
): Promise<QoderVerification> {
  const session = await client.request<QoderIdeSession | null>("chat/getSessionById", {
    sessionId: targetSessionId,
  });
  if (session?.sessionId !== targetSessionId) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_PERSISTED",
      `Qoder IDE cannot read imported session ${targetSessionId}`,
    );
  }
  if (typeof session.projectUri !== "string") {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      `Qoder IDE session has no workspace metadata: ${targetSessionId}`,
    );
  }
  const workspace = await realpath(session.projectUri);
  await assertSameWorkspace(expectedWorkspace, workspace);

  const records = Array.isArray(session.chatRecords) ? session.chatRecords : [];
  if (records.length !== expectedTurns.length) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_PERSISTED",
      `Qoder IDE session contains ${records.length} of ${expectedTurns.length} projected turns`,
    );
  }
  const recordsByRequestId = new Map(records.map((record) => [record.requestId, record]));
  for (const turn of expectedTurns) {
    const record = recordsByRequestId.get(turn.requestId);
    const expectedQuestion =
      turn.messages.find((message) => message.role === "user")?.content ?? "";
    const expectedAnswer =
      turn.messages.find((message) => message.role === "assistant")?.content ?? "";
    if (
      record === undefined ||
      (record.question ?? "") !== expectedQuestion ||
      (record.answer ?? "") !== expectedAnswer
    ) {
      throw new MigrationError(
        "TARGET_SESSION_NOT_PERSISTED",
        `Qoder IDE projected turn does not match source history: ${turn.requestId}`,
        {
          requestId: turn.requestId,
          recordFound: record !== undefined,
          questionMatches: (record?.question ?? "") === expectedQuestion,
          answerMatches: (record?.answer ?? "") === expectedAnswer,
        },
      );
    }
  }

  const listed = await client.request<QoderIdeSession[] | null>("chat/listAllSessions", {
    workspacePath: expectedWorkspace.workspaceCanonical,
  });
  const visible = Array.isArray(listed)
    ? listed.find((item) => item.sessionId === targetSessionId)
    : undefined;
  if (
    session.sessionType !== "assistant" ||
    visible === undefined ||
    visible.sessionType !== "assistant"
  ) {
    throw new MigrationError(
      "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
      `Imported Qoder session is not visible in IDE Chat History: ${targetSessionId}`,
      {
        storedSessionType: session.sessionType ?? null,
        listedSessionType: visible?.sessionType ?? null,
      },
    );
  }

  return {
    backendSocketPath: client.runtime.socketPath,
    sessionId: targetSessionId,
    workspace,
    projectedTurnCount: expectedTurns.length,
    projectedMessageCount: expectedTurns.reduce(
      (count, turn) => count + turn.messages.length,
      0,
    ),
    historyVisible: true,
  };
}
