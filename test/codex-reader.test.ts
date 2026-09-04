import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerRequester } from "../src/codex/app-server-client.js";
import { listCodexThreads, readCodexThread } from "../src/codex/reader.js";
import { thread, threadItem, turn } from "./fixtures.js";

test("Codex thread listing consumes every page in stable server order", async () => {
  const calls: Record<string, unknown>[] = [];
  const first = thread("/tmp/A", []);
  const second = { ...thread("/tmp/B", []), id: "thread-2", sessionId: "thread-2" };
  const requester: AppServerRequester = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      assert.equal(method, "thread/list");
      calls.push(params);
      return (params.cursor === null
        ? { data: [first], nextCursor: "next", backwardsCursor: null }
        : { data: [second], nextCursor: null, backwardsCursor: null }) as T;
    },
  };

  const result = await listCodexThreads(requester);
  assert.deepEqual(result.map(({ id }) => id), ["thread-1", "thread-2"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.sortKey, "updated_at");
  assert.equal(calls[0]?.sortDirection, "desc");
});

test("paginated reader consumes turn and item cursors to completion", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const metadata = thread("/tmp/A", [], "paginated");
  const requester: AppServerRequester = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: metadata } as T;
      if (method === "thread/turns/list") {
        return (params.cursor === null
          ? { data: [turn("turn-1")], nextCursor: "turn-next", backwardsCursor: null }
          : { data: [turn("turn-2")], nextCursor: null, backwardsCursor: null }) as T;
      }
      if (method === "thread/items/list") {
        return (params.cursor === null
          ? {
              data: [
                {
                  turnId: "turn-1",
                  item: threadItem("userMessage", {
                    id: "user-1",
                    content: [{ type: "text", text: "hello" }],
                  }),
                },
              ],
              nextCursor: "item-next",
              backwardsCursor: null,
            }
          : {
              data: [
                {
                  turnId: "turn-2",
                  item: threadItem("agentMessage", {
                    id: "assistant-1",
                    text: "world",
                  }),
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            }) as T;
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };

  const result = await readCodexThread(requester, "thread-1");
  assert.equal(result.reader.turnPages, 2);
  assert.equal(result.reader.itemPages, 2);
  assert.equal(result.reader.turnCount, 2);
  assert.equal(result.reader.itemCount, 2);
  assert.equal(result.thread.turns[0]?.items[0]?.type, "userMessage");
  assert.equal(result.thread.turns[1]?.items[0]?.type, "agentMessage");
  assert.equal(
    calls.some(
      (call) =>
        call.method === "thread/read" && call.params.includeTurns === true,
    ),
    false,
  );
});

test("legacy reader uses one full thread read", async () => {
  const metadata = thread("/tmp/A", [], "legacy");
  const hydrated = thread("/tmp/A", [turn("turn-1")], "legacy");
  let fullReads = 0;
  const requester: AppServerRequester = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      assert.equal(method, "thread/read");
      if (params.includeTurns === true) {
        fullReads += 1;
        return { thread: hydrated } as T;
      }
      return { thread: metadata } as T;
    },
  };
  const result = await readCodexThread(requester, "thread-1");
  assert.equal(fullReads, 1);
  assert.equal(result.reader.historyMode, "legacy");
  assert.equal(result.reader.turnCount, 1);
});
