import assert from "node:assert/strict";
import test from "node:test";
import { buildSeedContext } from "../src/seed-context.js";
import { snapshot, threadItem, turn } from "./fixtures.js";

const options = {
  migrationId: "11111111-1111-4111-8111-111111111111",
  sourceSnapshotSha256: "b".repeat(64),
  capsulePath: "/tmp/capsule.jsonl",
  capsuleSha256: "c".repeat(64),
};

test("seed context is deterministic and contains source-visible markers", () => {
  const source = snapshot("/tmp/A", [
    turn("turn-1", [
      threadItem("userMessage", {
        id: "user-1",
        content: [{ type: "text", text: "Inspect mosonlab/anneal" }],
      }),
      threadItem("agentMessage", {
        id: "assistant-1",
        text: "A good spec is a Product Contract.",
        phase: "final_answer",
      }),
      threadItem("plan", { id: "plan-1", text: "Continue with acceptance tests." }),
      threadItem("reasoning", { id: "reasoning-1", summary: [], content: [] }),
    ]),
  ]);
  const first = buildSeedContext(source, options);
  const second = buildSeedContext(source, options);
  assert.deepEqual(first, second);
  assert.match(first.content, /mosonlab\/anneal/u);
  assert.match(first.content, /Product Contract/u);
  assert.doesNotMatch(first.content, /reasoning-1/u);
});

test("seed context keeps newest complete messages under 128 KiB and reports loss", () => {
  const items = [];
  for (let index = 0; index < 30; index += 1) {
    items.push(
      threadItem(index % 2 === 0 ? "userMessage" : "agentMessage", {
        id: `item-${index}`,
        ...(index % 2 === 0
          ? { content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }] }
          : { text: `${index}:${"y".repeat(10_000)}`, phase: "final_answer" }),
      }),
    );
  }
  const built = buildSeedContext(snapshot("/tmp/A", [turn("turn-1", items)]), options);
  assert.ok(built.bytes <= 128 * 1024);
  assert.ok(built.lossReport.omittedMessageCount > 0);
  assert.ok(built.lossReport.omittedMessageBytes > 0);
  assert.match(built.content, /29:/u);
});
