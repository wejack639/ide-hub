import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CODEBUDDY_PROFILES,
  codeBuddyCompatibilityError,
} from "../src/codebuddy/discovery.js";

test("CodeBuddy editions have independent installation and compatibility identities", () => {
  const international = CODEBUDDY_PROFILES["codebuddy-international"];
  const cn = CODEBUDDY_PROFILES["codebuddy-cn"];
  assert.equal(international.bundleId, "com.tencent.codebuddy");
  assert.equal(cn.bundleId, "com.tencent.codebuddycn");
  assert.notEqual(international.appName, cn.appName);
  assert.notEqual(international.version, cn.version);
  assert.notEqual(international.productCommit, cn.productCommit);
  assert.notEqual(international.extensionSha256, cn.extensionSha256);

  assert.equal(codeBuddyCompatibilityError(international, {
    version: international.version,
    productCommit: international.productCommit,
    applicationName: international.applicationName,
    extensionName: "coding-copilot",
    extensionPublisher: "Tencent-Cloud",
    extensionVersion: "3.10.0",
    extensionSha256: international.extensionSha256,
  }), null);
  assert.match(codeBuddyCompatibilityError(international, {
    version: "9.9.9",
    productCommit: international.productCommit,
    applicationName: international.applicationName,
    extensionName: "coding-copilot",
    extensionPublisher: "Tencent-Cloud",
    extensionVersion: "3.10.0",
    extensionSha256: international.extensionSha256,
  }) ?? "", /版本/u);
  assert.match(codeBuddyCompatibilityError(cn, {
    version: cn.version,
    productCommit: cn.productCommit,
    applicationName: cn.applicationName,
    extensionName: "coding-copilot",
    extensionPublisher: "Tencent-Cloud",
    extensionVersion: "3.10.0",
    extensionSha256: "bad",
  }) ?? "", /指纹/u);
});

test("CodeBuddy workspace launcher uses only the supported reuse-window argument", async () => {
  const source = await readFile(new URL("../src/codebuddy/discovery.ts", import.meta.url), "utf8");
  assert.match(source, /\["--reuse-window", canonicalWorkspace\]/u);
  assert.doesNotMatch(source, /suppress-popups-on-startup/u);
});
