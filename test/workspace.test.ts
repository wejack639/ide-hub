import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MigrationError } from "../src/errors.js";
import { assertSameWorkspace, resolveWorkspace } from "../src/workspace.js";

test("workspace resolves symlinks to one file identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-workspace-"));
  const real = join(root, "A");
  const alias = join(root, "alias-A");
  await mkdir(real);
  await symlink(real, alias);
  const identity = await resolveWorkspace(alias);
  assert.equal(identity.sourceWorkspaceRaw, alias);
  assert.equal(identity.workspaceCanonical, await realpath(real));
  await assertSameWorkspace(identity, real);
});

test("workspace rejects a different target directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-workspace-mismatch-"));
  const first = join(root, "A");
  const second = join(root, "B");
  await mkdir(first);
  await mkdir(second);
  const identity = await resolveWorkspace(first);
  await assert.rejects(
    () => assertSameWorkspace(identity, second),
    (error: unknown) =>
      error instanceof MigrationError && error.code === "TARGET_WORKSPACE_MISMATCH",
  );
});

test("workspace rejects relative source paths", async () => {
  await assert.rejects(
    () => resolveWorkspace("relative/A"),
    (error: unknown) =>
      error instanceof MigrationError &&
      error.code === "SOURCE_WORKSPACE_NOT_ABSOLUTE",
  );
});
