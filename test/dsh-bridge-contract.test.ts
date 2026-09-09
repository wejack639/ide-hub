import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DSH bridge compares persisted seed events structurally", async () => {
  const bridge = await readFile(
    new URL("../dsh-bridge/lib/index.js", import.meta.url),
    "utf8",
  );

  assert.match(bridge, /isDeepStrictEqual\(events\[index\], expectedSeed\[index\]\)/u);
  assert.doesNotMatch(
    bridge,
    /JSON\.stringify\(events\[index\]\).*JSON\.stringify\(expectedSeed\[index\]\)/u,
  );
});

test("DSH runtime refuses an already-running stale web profile", async () => {
  const runtime = await readFile(
    new URL("../src/dsh/bridge.ts", import.meta.url),
    "utf8",
  );

  assert.match(runtime, /DSH_BRIDGE_RESTART_REQUIRED/u);
  assert.match(runtime, /isDshWebReachable\(\)/u);
});
