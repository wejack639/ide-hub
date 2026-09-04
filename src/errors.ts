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
  | "MODEL_CALL_DETECTED"
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
