import type { SourceSnapshot } from "./types.js";
import { sha256Text } from "./util/fs.js";
import { stableJson } from "./util/stable-json.js";

export type CapsuleBuild = {
  content: string;
  sha256: string;
  eventCount: number;
};

export function buildCapsule(snapshot: SourceSnapshot): CapsuleBuild {
  const records: unknown[] = [
    {
      type: "capsule-header",
      schemaVersion: "ide-hub-capsule-v1",
      sourceProduct: "codex",
      sourceThreadId: snapshot.thread.id,
      sourceWorkspace: snapshot.workspace.workspaceCanonical,
      sourceFile: snapshot.sourceFile,
      reader: snapshot.reader,
    },
  ];

  for (const turn of snapshot.thread.turns) {
    records.push({
      type: "turn",
      id: turn.id,
      status: turn.status,
      error: turn.error ?? null,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      durationMs: turn.durationMs ?? null,
    });
    for (const item of turn.items) {
      records.push({
        type: "item",
        turnId: turn.id,
        item,
      });
    }
  }

  const content = `${records.map((record) => stableJson(record)).join("\n")}\n`;
  return {
    content,
    sha256: sha256Text(content),
    eventCount: records.length,
  };
}
