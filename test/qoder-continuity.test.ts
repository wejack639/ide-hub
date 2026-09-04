import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContinuityAnswer } from "../src/qoder/continuity.js";

test("Qoder continuity gate accepts the required migrated-history facts", () => {
  const evaluated = evaluateContinuityAnswer(
    "1. Anneal\n2. 好 spec 是可冻结、可验证的 Product Contract。\n3. Direct 与 Full Assurance。",
  );
  assert.equal(evaluated.passed, true);
  assert.deepEqual(evaluated.missingSignals, []);
});

test("Qoder continuity gate rejects a generic answer without source facts", () => {
  const evaluated = evaluateContinuityAnswer(
    "我知道这是一个代码项目，建议继续完善需求文档。",
  );
  assert.equal(evaluated.passed, false);
  assert.deepEqual(evaluated.matchedSignals, []);
});
