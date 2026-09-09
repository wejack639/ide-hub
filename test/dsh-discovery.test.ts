import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_BRIDGE_VERSION,
  SUPPORTED_DSH_FINGERPRINTS,
  SUPPORTED_DSH_VERSION,
  dshCompatibilityError,
  updateDshProfileManifest,
} from "../src/dsh/discovery.js";

test("DSH compatibility gate requires the exact rc.6 package graph", () => {
  assert.equal(
    dshCompatibilityError(SUPPORTED_DSH_VERSION, SUPPORTED_DSH_FINGERPRINTS),
    null,
  );
  assert.match(
    dshCompatibilityError("0.1.2-rc.1", SUPPORTED_DSH_FINGERPRINTS) ?? "",
    /not supported/u,
  );
  assert.match(
    dshCompatibilityError(SUPPORTED_DSH_VERSION, {
      ...SUPPORTED_DSH_FINGERPRINTS,
      session: "bad",
    }) ?? "",
    /fingerprint/u,
  );
});

test("DSH bridge profile registration is additive and idempotent", () => {
  const original = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { existing: "1.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  };
  const updated = updateDshProfileManifest(original);
  assert.deepEqual(updated.dependencies, {
    existing: "1.0.0",
    "@ide-hub/dsh-session-bridge": DSH_BRIDGE_VERSION,
  });
  assert.deepEqual(updated.dsh.profile.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@ide-hub/dsh-session-bridge",
  ]);
  assert.deepEqual(updateDshProfileManifest(updated), updated);
  assert.deepEqual(original.dependencies, { existing: "1.0.0" });
});
