import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { MigrationError } from "./errors.js";
import type { WorkspaceIdentity } from "./types.js";

export async function resolveWorkspace(sourceRaw: string): Promise<WorkspaceIdentity> {
  if (!isAbsolute(sourceRaw)) {
    throw new MigrationError(
      "SOURCE_WORKSPACE_NOT_ABSOLUTE",
      `Codex thread cwd must be absolute: ${sourceRaw}`,
    );
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourceRaw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MigrationError(
        "SOURCE_WORKSPACE_NOT_FOUND",
        `Codex thread cwd does not exist: ${sourceRaw}`,
      );
    }
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new MigrationError(
      "SOURCE_WORKSPACE_NOT_DIRECTORY",
      `Codex thread cwd is not a directory: ${sourceRaw}`,
    );
  }

  const canonical = await realpath(sourceRaw);
  const canonicalStat = await stat(canonical);
  return {
    sourceWorkspaceRaw: sourceRaw,
    workspaceCanonical: canonical,
    workspaceIdentity: {
      device: canonicalStat.dev,
      inode: canonicalStat.ino,
    },
  };
}

export async function assertSameWorkspace(
  expected: WorkspaceIdentity,
  targetPath: string,
): Promise<void> {
  const target = await resolveWorkspace(targetPath);
  const sameIdentity =
    target.workspaceIdentity.device === expected.workspaceIdentity.device &&
    target.workspaceIdentity.inode === expected.workspaceIdentity.inode;
  if (!sameIdentity || target.workspaceCanonical !== expected.workspaceCanonical) {
    throw new MigrationError(
      "TARGET_WORKSPACE_MISMATCH",
      `目标工作区必须为 ${expected.workspaceCanonical}，实际为 ${target.workspaceCanonical}`,
      { expected, actual: target },
    );
  }
}
