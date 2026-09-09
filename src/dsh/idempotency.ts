import { DSH_BRIDGE_VERSION } from "./discovery.js";
import { DSH_SESSION_EVENT_PROTOCOL_VERSION } from "./protocol.js";
import { sha256Text } from "../util/fs.js";
import { stableJson } from "../util/stable-json.js";

export function dshMigrationKey(input: {
  sourceThreadId: string;
  sourceFileSha256: string;
  workspace: string;
  dshVersion: string;
}): string {
  return sha256Text(
    stableJson({
      adapter: `dsh-native-seed-${DSH_SESSION_EVENT_PROTOCOL_VERSION}-${DSH_BRIDGE_VERSION}`,
      dshVersion: input.dshVersion,
      sourceFileSha256: input.sourceFileSha256,
      sourceThreadId: input.sourceThreadId,
      workspace: input.workspace,
    }),
  );
}

export function dshTargetSessionId(migrationKey: string): string {
  if (!/^[a-f0-9]{64}$/u.test(migrationKey)) {
    throw new Error("Invalid DSH migration key");
  }
  return `session-idehub-${migrationKey.slice(0, 32)}`;
}
