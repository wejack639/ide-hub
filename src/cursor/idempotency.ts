import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURSOR_BRIDGE_VERSION } from "./bridge.js";
import { CURSOR_PROTOCOL_VERSION } from "./protocol.js";
import { atomicWrite, defaultDataRoot, sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";

export type CursorMigrationMapping = {
  schemaVersion: "ide-hub-cursor-mapping-v2";
  key: string;
  sourceThreadId: string;
  sourceFileSha256: string;
  workspace: string;
  cursorVersion: string;
  bridgeVersion: string;
  protocolVersion: string;
  targetSessionId: string;
  createdAt: string;
};

export function cursorMigrationKey(input: {
  sourceThreadId: string;
  sourceFileSha256: string;
  workspace: string;
  cursorVersion: string;
}): string {
  return sha256Text(
    stableJson({
      adapter: `cursor-native-import-${CURSOR_PROTOCOL_VERSION}-${CURSOR_BRIDGE_VERSION}`,
      cursorVersion: input.cursorVersion,
      sourceFileSha256: input.sourceFileSha256,
      sourceThreadId: input.sourceThreadId,
      workspace: input.workspace,
    }),
  );
}

export async function readCursorMigrationMapping(
  key: string,
): Promise<CursorMigrationMapping | null> {
  try {
    return JSON.parse(await readFile(mappingPath(key), "utf8")) as CursorMigrationMapping;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCursorMigrationMapping(
  mapping: CursorMigrationMapping,
): Promise<void> {
  await atomicWrite(mappingPath(mapping.key), `${JSON.stringify(mapping, null, 2)}\n`);
}

function mappingPath(key: string): string {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid Cursor mapping key");
  return join(defaultDataRoot(), "cursor", "idempotency", `${key}.json`);
}
