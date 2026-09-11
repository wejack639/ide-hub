export type MigrationErrorCode =
  | "INVALID_REQUEST"
  | "CODEX_APP_SERVER_UNAVAILABLE"
  | "SOURCE_THREAD_NOT_FOUND"
  | "SOURCE_CONVERSATION_EMPTY"
  | "SOURCE_TURN_RUNNING"
  | "SOURCE_CHANGED_DURING_SNAPSHOT"
  | "SOURCE_WORKSPACE_NOT_FOUND"
  | "SOURCE_WORKSPACE_NOT_DIRECTORY"
  | "SOURCE_WORKSPACE_NOT_ABSOLUTE"
  | "MULTI_ROOT_WORKSPACE_UNSUPPORTED"
  | "QODER_INTERNATIONAL_NOT_INSTALLED"
  | "QODER_CN_NOT_INSTALLED"
  | "QODER_CN_SELECTED"
  | "QODER_RUNTIME_UNAVAILABLE"
  | "QODER_AUTH_EXPIRED"
  | "CURSOR_NOT_INSTALLED"
  | "CURSOR_VERSION_UNSUPPORTED"
  | "CURSOR_PROTOCOL_UNSUPPORTED"
  | "CURSOR_BRIDGE_INSTALL_FAILED"
  | "CURSOR_BRIDGE_RELOAD_REQUIRED"
  | "CURSOR_BRIDGE_UNAVAILABLE"
  | "CURSOR_IMPORT_FAILED"
  | "CURSOR_TARGET_AMBIGUOUS"
  | "DSH_NOT_INSTALLED"
  | "DSH_VERSION_UNSUPPORTED"
  | "DSH_PROTOCOL_UNSUPPORTED"
  | "DSH_BRIDGE_INSTALL_FAILED"
  | "DSH_BRIDGE_RESTART_REQUIRED"
  | "DSH_BRIDGE_UNAVAILABLE"
  | "DSH_IMPORT_FAILED"
  | "MODEL_CALL_DETECTED"
  | "CLAUDE_NOT_INSTALLED"
  | "CLAUDE_VERSION_UNSUPPORTED"
  | "CLAUDE_RUNTIME_FAILED"
  | "CLAUDE_HISTORY_INVALID"
  | "CLAUDE_TARGET_CONFLICT"
  | "PI_NOT_INSTALLED"
  | "PI_VERSION_UNSUPPORTED"
  | "PI_RUNTIME_FAILED"
  | "PI_HISTORY_INVALID"
  | "PI_TARGET_CONFLICT"
  | "ZCODE_NOT_INSTALLED"
  | "ZCODE_VERSION_UNSUPPORTED"
  | "ZCODE_MODEL_METADATA_MISSING"
  | "ZCODE_IMPORT_FAILED"
  | "ZCODE_TARGET_CONFLICT"
  | "TARGET_SESSION_NOT_PERSISTED"
  | "TARGET_WORKSPACE_MISMATCH"
  | "TARGET_SESSION_NOT_VISIBLE_IN_IDE"
  | "MCP_CHANGED_DURING_SESSION_MIGRATION"
  | "CONTINUITY_GATE_FAILED"
  | "INTERNAL_ERROR";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MigrationErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asMigrationError(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MigrationError("INTERNAL_ERROR", message, undefined, {
    cause: error,
  });
}
