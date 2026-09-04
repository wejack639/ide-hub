import { randomUUID } from "node:crypto";
import { MigrationError } from "../errors.js";
import { sha256Text } from "../util/fs.js";
import {
  QoderIdeRpcClient,
  type QoderIdeSession,
  waitForQoderIdeRuntime,
} from "./ide-rpc.js";
import { discoverQoder } from "./discovery.js";
import type { QoderTargetProduct } from "../types.js";
import { removeQoderRecordRows } from "./seed.js";

export const ANNEAL_CONTINUITY_PROMPT = [
  "连续性验证：请只根据本会话已经存在的历史，用三行回答以下问题，不要搜索、不要调用工具：",
  "1. 之前分析的项目名称是什么？",
  "2. 原回答把好 spec 定义成什么？",
  "3. 原回答建议的两种任务链分别叫什么？",
].join("\n");

export type ContinuitySignal = {
  label: string;
  pattern: RegExp;
};

export type QoderContinuityResult = {
  targetProduct: QoderTargetProduct;
  sessionId: string;
  requestId: string;
  workspace: string;
  prompt: string;
  answer: string;
  answerSha256: string;
  matchedSignals: string[];
  modelKey: string;
  modelInvoked: true;
  passed: true;
};

const ANNEAL_SIGNALS: ContinuitySignal[] = [
  { label: "Anneal", pattern: /\banneal\b/iu },
  { label: "Product Contract", pattern: /product\s+contract/iu },
  { label: "Direct", pattern: /\bdirect\b/iu },
  { label: "Full Assurance", pattern: /full\s+assurance/iu },
];

export function evaluateContinuityAnswer(
  answer: string,
  signals: ContinuitySignal[] = ANNEAL_SIGNALS,
): { passed: boolean; matchedSignals: string[]; missingSignals: string[] } {
  const matchedSignals = signals
    .filter((signal) => signal.pattern.test(answer))
    .map((signal) => signal.label);
  const matchedSet = new Set(matchedSignals);
  return {
    passed: matchedSignals.length === signals.length,
    matchedSignals,
    missingSignals: signals
      .map((signal) => signal.label)
      .filter((label) => !matchedSet.has(label)),
  };
}

export async function runQoderContinuityGate(options: {
  targetProduct?: QoderTargetProduct;
  sessionId: string;
  workspace: string;
  qoderIdeVersion: string;
  modelKey: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<QoderContinuityResult> {
  const targetProduct = options.targetProduct ?? "qoder-international";
  const installation = await discoverQoder(targetProduct);
  const prompt = options.prompt ?? ANNEAL_CONTINUITY_PROMPT;
  const requestId = randomUUID();
  const runtime = await waitForQoderIdeRuntime({
    dataRoot: installation.dataRoot,
    socketName: installation.socketName,
  });
  const client = await QoderIdeRpcClient.connect(
    runtime,
    options.workspace,
    options.qoderIdeVersion,
    { requestTimeoutMs: 15_000, targetProduct },
  );
  let disposeNotifications: (() => void) | undefined;
  let passed = false;
  try {
    const before = await client.request<QoderIdeSession | null>("chat/getSessionById", {
      sessionId: options.sessionId,
    });
    if (before?.sessionId !== options.sessionId || !before.chatRecords?.length) {
      throw new MigrationError(
        "CONTINUITY_GATE_FAILED",
        `Qoder session has no imported history: ${options.sessionId}`,
      );
    }

    const streamed = collectContinuityStream(
      client,
      options.sessionId,
      requestId,
      options.timeoutMs ?? 180_000,
    );
    disposeNotifications = streamed.dispose;

    await client.request("session/prompt", {
      sessionId: options.sessionId,
      prompt: [{ type: "text", text: prompt }],
      _meta: {
        "ai-coding/mode": "agent",
        "ai-coding/model": options.modelKey,
        "ai-coding/request-id": requestId,
        "ai-coding/session-id": options.sessionId,
        "ai-coding/workspace-path": options.workspace,
      },
    });
    const completed = await streamed.result;
    const answer = completed.answer.trim();
    if (!completed.success || answer.length === 0) {
      throw new MigrationError(
        "CONTINUITY_GATE_FAILED",
        completed.timedOut
          ? `Qoder did not complete the continuity response within ${options.timeoutMs ?? 180_000} ms`
          : `Qoder continuity response failed: ${completed.reason || "empty answer"}`,
        { requestId, statusCode: completed.statusCode },
      );
    }

    const evaluated = evaluateContinuityAnswer(answer);
    await client.request("session/appendHistoryTurn", {
      sessionId: options.sessionId,
      requestId,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: answer },
      ],
    });
    const persisted = await client.request<QoderIdeSession | null>("chat/getSessionById", {
      sessionId: options.sessionId,
    });
    const persistedRecord = persisted?.chatRecords?.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (
      persistedRecord?.question !== prompt ||
      persistedRecord.answer?.trim() !== answer
    ) {
      throw new MigrationError(
        "CONTINUITY_GATE_FAILED",
        "Qoder continuity response streamed successfully but was not persisted",
        { requestId },
      );
    }
    if (!evaluated.passed) {
      throw new MigrationError(
        "CONTINUITY_GATE_FAILED",
        `Qoder answered but missed migrated-history signals: ${evaluated.missingSignals.join(", ")}`,
        {
          requestId,
          answerSha256: sha256Text(answer),
          matchedSignals: evaluated.matchedSignals,
          missingSignals: evaluated.missingSignals,
        },
      );
    }
    const result: QoderContinuityResult = {
      targetProduct,
      sessionId: options.sessionId,
      requestId,
      workspace: options.workspace,
      prompt,
      answer,
      answerSha256: sha256Text(answer),
      matchedSignals: evaluated.matchedSignals,
      modelKey: options.modelKey,
      modelInvoked: true,
      passed: true,
    };
    passed = true;
    return result;
  } finally {
    disposeNotifications?.();
    client.close();
    if (!passed) {
      await removeQoderRecordRows(runtime, options.sessionId, [requestId]);
    }
  }
}

type ContinuityStreamResult = {
  answer: string;
  reason: string;
  statusCode: number | null;
  success: boolean;
  timedOut: boolean;
};

function collectContinuityStream(
  client: QoderIdeRpcClient,
  sessionId: string,
  requestId: string,
  timeoutMs: number,
): { result: Promise<ContinuityStreamResult>; dispose: () => void } {
  let answer = "";
  let settled = false;
  let resolveResult!: (result: ContinuityStreamResult) => void;
  const result = new Promise<ContinuityStreamResult>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (value: Omit<ContinuityStreamResult, "answer">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveResult({ answer, ...value });
  };
  const disposeListener = client.onNotification((method, params) => {
    if (method !== "session/update" || !isRecord(params)) return;
    if (params.sessionId !== sessionId || !isRecord(params._meta)) return;
    if (params._meta["ai-coding/request-id"] !== requestId) return;
    const update = params.update;
    if (!isRecord(update)) return;
    if (update.sessionUpdate === "agent_message_chunk" && isRecord(update.content)) {
      if (typeof update.content.text === "string") answer += update.content.text;
      return;
    }
    if (
      update.sessionUpdate === "notification" &&
      update.type === "chat_finish" &&
      isRecord(update.data)
    ) {
      const reason = typeof update.data.reason === "string" ? update.data.reason : "";
      const statusCode =
        typeof update.data.statusCode === "number" ? update.data.statusCode : null;
      finish({
        reason,
        statusCode,
        success: reason === "success" && statusCode === 200,
        timedOut: false,
      });
    }
  });
  const timeout = setTimeout(() => {
    finish({
      reason: "timeout",
      statusCode: null,
      success: false,
      timedOut: true,
    });
  }, timeoutMs);
  return {
    result,
    dispose: () => {
      disposeListener();
      if (!settled) clearTimeout(timeout);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
