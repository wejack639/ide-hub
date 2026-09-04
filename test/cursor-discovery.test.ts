import assert from "node:assert/strict";
import test from "node:test";
import {
  CURSOR_IMPORT_COMMAND,
  CURSOR_OPEN_COMPOSER_COMMAND,
  SUPPORTED_CURSOR_VERSION,
  SUPPORTED_CURSOR_WORKBENCH_SHA256,
  cursorCompatibilityError,
} from "../src/cursor/discovery.js";

const commands = `${CURSOR_IMPORT_COMMAND}\n${CURSOR_OPEN_COMPOSER_COMMAND}`;

test("Cursor compatibility gate requires exact version, fingerprint, and commands", () => {
  assert.equal(
    cursorCompatibilityError(
      SUPPORTED_CURSOR_VERSION,
      SUPPORTED_CURSOR_WORKBENCH_SHA256,
      commands,
    ),
    null,
  );
  assert.match(
    cursorCompatibilityError("3.19.0", SUPPORTED_CURSOR_WORKBENCH_SHA256, commands) ?? "",
    /not supported/u,
  );
  assert.match(
    cursorCompatibilityError(SUPPORTED_CURSOR_VERSION, "bad", commands) ?? "",
    /fingerprint/u,
  );
  assert.match(
    cursorCompatibilityError(
      SUPPORTED_CURSOR_VERSION,
      SUPPORTED_CURSOR_WORKBENCH_SHA256,
      CURSOR_OPEN_COMPOSER_COMMAND,
    ) ?? "",
    /bulkImportChats/u,
  );
});
