import type { MigrationTargetProduct } from "../types.js";

export const MCP_TARGET_PRODUCTS = [
  "qoder-international",
  "qoder-cn",
  "cursor",
  "deepseek-harness",
  "zcode",
  "pi",
  "claude-code",
  "codebuddy-international",
  "codebuddy-cn",
] as const satisfies readonly MigrationTargetProduct[];

export type McpTargetProduct = (typeof MCP_TARGET_PRODUCTS)[number];
export type McpScope = "user" | "project";
export type McpTargetScope = McpScope | "local";
export type McpTransport = "stdio" | "streamable-http";
export type McpConflictStrategy = "skip" | "rename" | "merge" | "replace";
export type McpFieldChoice = "source" | "target";

export type McpServer = {
  id: string;
  name: string;
  scope: McpScope;
  sourcePath: string;
  overrides: string[];
  transport: McpTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  envVars: string[];
  url: string | null;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
  bearerTokenEnvVar: string | null;
  enabled: boolean;
  startupTimeoutSec: number | null;
  toolTimeoutSec: number | null;
  unmappedFields: string[];
};

export type McpServerSummary = Omit<
  McpServer,
  "env" | "headers" | "envHeaders"
> & {
  envKeys: string[];
  headerKeys: string[];
  envHeaderKeys: string[];
};

export type McpSourceSnapshot = {
  schemaVersion: "ide-hub-mcp-source-v1";
  sourceProduct: "codex";
  sourceKind: "codex-effective" | "mcp-bundle";
  sourcePath: string;
  sourceFingerprint: string;
  capturedAt: string;
  scope: McpScope;
  workspace: string | null;
  servers: McpServer[];
};

export type McpTargetAvailability = {
  targetProduct: McpTargetProduct;
  targetScope: McpTargetScope;
  displayName: string;
  installed: boolean;
  supported: boolean;
  reason: string | null;
  targetConfigPath: string | null;
};

export type McpScanResult = {
  sourceProduct: "codex";
  sourceKind: McpSourceSnapshot["sourceKind"];
  sourcePath: string;
  sourceFingerprint: string;
  scope: McpScope;
  targetScope: McpTargetScope;
  sourceWorkspace: string | null;
  workspace: string | null;
  scannedAt: string;
  servers: McpServerSummary[];
  targets: McpTargetAvailability[];
};

export type McpConflictResolution = {
  strategy: McpConflictStrategy;
  renameTo?: string;
  fieldChoices?: Record<string, McpFieldChoice>;
};

export type McpMigrationRequest = {
  sourceProduct: "codex";
  targetProduct: McpTargetProduct;
  selectedServerIds: string[];
  scope: McpScope;
  targetScope: McpTargetScope;
  workspace?: string;
  sourceBundlePath?: string;
  resolutions: Record<string, McpConflictResolution>;
};

export type McpDiffStatus =
  | "add"
  | "same"
  | "conflict"
  | "skip"
  | "rename"
  | "merge"
  | "replace"
  | "unsupported";

export type McpFieldDiff = {
  field: string;
  conflict: boolean;
  sourcePreview: string;
  targetPreview: string;
};

export type McpServerDiff = {
  serverId: string;
  sourceName: string;
  targetName: string;
  transport: McpTransport;
  status: McpDiffStatus;
  reason: string | null;
  availableStrategies: McpConflictStrategy[];
  fields: McpFieldDiff[];
};

export type McpMigrationPlan = {
  schemaVersion: "ide-hub-mcp-plan-v1";
  planId: string;
  createdAt: string;
  request: McpMigrationRequest;
  sourceFingerprint: string;
  targetFingerprint: string;
  targetConfigPath: string;
  targetExisted: boolean;
  selectedServerCount: number;
  diffs: McpServerDiff[];
  manualActions: string[];
  canApply: boolean;
};

export type McpServerVerification = {
  serverId: string;
  name: string;
  configRoundTrip: boolean;
  handshake: "passed" | "failed" | "skipped";
  nativeRecognition?: "passed" | "failed" | "pending" | "skipped";
  nativeDetail?: string;
  detail: string;
};

export type McpNativeRecognitionProbeInput = {
  targetProduct: McpTargetProduct;
  targetScope: McpTargetScope;
  workspace: string | null;
  targetConfigPath: string;
  serverNames: string[];
  homeDir: string;
  notBeforeEpochMs: number;
};

export type McpNativeRecognitionProbeResult = {
  method: string;
  servers: Record<string, {
    status: "passed" | "failed" | "pending";
    detail: string;
  }>;
};

export type McpMigrationReceipt = {
  schemaVersion: "ide-hub-mcp-receipt-v1" | "ide-hub-mcp-receipt-v2";
  mcpMigrationId: string;
  planId: string;
  status: "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "ROLLED_BACK";
  sourceProduct: "codex";
  targetProduct: McpTargetProduct;
  sourceScope: McpScope;
  targetScope: McpTargetScope;
  selectedServerIds: string[];
  targetConfigPath: string;
  targetBeforeSha256: string;
  targetAfterSha256: string;
  backupPath: string | null;
  createdTargetFile: boolean;
  changed: boolean;
  completedAt: string;
  verification: McpServerVerification[];
  rollbackMode?: "exact" | "selected-only";
  rollbackTargetSha256?: string;
};

export type McpJobSummary = {
  mcpMigrationId: string;
  status: McpMigrationReceipt["status"] | "ROLLED_BACK_AFTER_FAILURE" | "RECOVERED_NO_CHANGE" | "RECOVERED_ROLLBACK" | "RECOVERY_CONFLICT";
  targetProduct: McpTargetProduct;
  targetScope: McpTargetScope;
  selectedServerCount: number;
  changed: boolean;
  canRollback: boolean;
  targetConfigPath: string;
  completedAt: string;
  failure: McpFailureDetail | null;
};

export type McpFailureDetail = {
  stage: "target-write" | "target-readback" | "verification" | "rollback" | "recovery";
  code: string;
  message: string;
};

export type McpRuntimeOptions = {
  homeDir?: string;
  dataRoot?: string;
  codexBinary?: string;
  targetPathOverrides?: Partial<Record<McpTargetProduct, string>>;
  installedTargetOverrides?: Partial<Record<McpTargetProduct, boolean>>;
  dshClientInstalled?: boolean;
  dshClientVersion?: string;
  skipStdioHandshake?: boolean;
  handshakeTimeoutMs?: number;
  nativeRecognitionTimeoutMs?: number;
  nativeRecognitionVerifier?: (
    input: McpNativeRecognitionProbeInput,
  ) => Promise<McpNativeRecognitionProbeResult>;
};
