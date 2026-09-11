export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type QoderTargetProduct = "qoder-international" | "qoder-cn";
export type QoderBundleId = "com.qoder.ide" | "com.aliyun.lingma.ide";
export type CursorTargetProduct = "cursor";
export type DshTargetProduct = "deepseek-harness";
export type MigrationTargetProduct =
  | QoderTargetProduct
  | CursorTargetProduct
  | DshTargetProduct
  | "zcode"
  | "pi";
export type CursorBundleId = "com.todesktop.230313mzl4w4u92";
export type DshRuntimeId = "@deepseek-ai/dsh";
export type MigrationTargetBundleId =
  | QoderBundleId
  | CursorBundleId
  | DshRuntimeId
  | "dev.zcode.app"
  | "@earendil-works/pi-coding-agent";

export type MigrationRequest = {
  sourceProduct: "codex";
  targetProduct: MigrationTargetProduct;
  sourceThreadId: string;
  contextPolicy: "goal-recent-plan-v1";
  dryRun: boolean;
};

export type MigrationStatus = "DRY_RUN" | "COMPLETED";

export type MigrationResult = {
  migrationId: string;
  status: MigrationStatus;
  sourceThreadId: string;
  targetSessionId: string | null;
  workspace: string;
  modelInvoked: false;
  mcpChanged: false;
  continuation: {
    product: MigrationTargetProduct;
    bundleId: MigrationTargetBundleId;
  };
  details: {
    artifactsDir: string;
    sourceSnapshotSha256: string;
    seedContextSha256: string;
    seedContextBytes: number;
    projectionSha256: string;
    projectedTurnCount: number;
    projectedMessageCount: number;
    lossReport: LossReport;
  };
};

export type WorkspaceIdentity = {
  sourceWorkspaceRaw: string;
  workspaceCanonical: string;
  workspaceIdentity: {
    device: number;
    inode: number;
  };
};

export type FileFingerprint = {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
};

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export type CodexThreadItem = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  itemsView?: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
};

export type CodexThread = {
  id: string;
  sessionId: string;
  preview: string;
  ephemeral: boolean;
  historyMode: "legacy" | "paginated";
  cwd: string;
  path: string | null;
  status: CodexThreadStatus;
  createdAt: number;
  updatedAt: number;
  name: string | null;
  source: string;
  cliVersion: string;
  turns: CodexTurn[];
  [key: string]: unknown;
};

export type ReaderStats = {
  historyMode: "legacy" | "paginated";
  turnPages: number;
  itemPages: number;
  turnCount: number;
  itemCount: number;
  finalTurnCursor: null;
  finalItemCursor: null;
};

export type SourceSnapshot = {
  schemaVersion: "ide-hub-source-snapshot-v1";
  capturedAt: string;
  thread: CodexThread;
  sourceFile: FileFingerprint;
  workspace: WorkspaceIdentity;
  reader: ReaderStats;
};

export type NormalizedMessage = {
  role: "user" | "assistant";
  text: string;
  turnId: string;
  itemId: string | null;
};

export type QoderHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type QoderProjectedTurn = {
  requestId: string;
  sourceTurnIds: string[];
  sourceItemIds: Array<string | null>;
  sourceMessageCount: number;
  messages: QoderHistoryMessage[];
};

export type QoderConversationProjection = {
  schemaVersion: "ide-hub-qoder-conversation-projection-v1";
  sourceMessageCount: number;
  projectedMessageCount: number;
  turns: QoderProjectedTurn[];
};

export type LossReport = {
  policy: "goal-recent-plan-v1";
  maxBytes: number;
  sourceMessageCount: number;
  includedMessageCount: number;
  omittedMessageCount: number;
  sourceMessageBytes: number;
  includedMessageBytes: number;
  omittedMessageBytes: number;
  omittedEventTypes: Record<string, number>;
  truncatedFields: string[];
};

export type SeedContextBuild = {
  content: string;
  sha256: string;
  bytes: number;
  lossReport: LossReport;
};

export type McpFingerprint = {
  sha256: string;
  codexSha256: string;
  targetSha256: string;
  targetProduct: MigrationTargetProduct;
};

export type QoderInstallation = {
  targetProduct: QoderTargetProduct;
  appPath: string;
  bundleId: QoderBundleId;
  version: string;
  dataRoot: string;
  socketName: "qoder.sock" | "qodercn.sock";
};

export type QoderProjectionResult = {
  targetSessionId: string;
  requestIds: string[];
  projectedTurnCount: number;
  projectedMessageCount: number;
  qoderIdeVersion: string;
  runtimePid: number;
  backendMethod: "session/appendHistoryTurn";
  sessionRowsNormalized: 1;
  recordRowsNormalized: number;
  modelInvoked: false;
};

export type QoderVerification = {
  backendSocketPath: string;
  sessionId: string;
  workspace: string;
  projectedTurnCount: number;
  projectedMessageCount: number;
  historyVisible: true;
};

export type CursorInstallation = {
  targetProduct: "cursor";
  appPath: string;
  bundleId: CursorBundleId;
  version: string;
  compatible: boolean;
  compatibilityError: string | null;
  workbenchPath: string;
  workbenchSha256: string;
  cliPath: string;
  userDataRoot: string;
  workspaceStorageRoot: string;
  globalStorageDatabase: string;
};

export type CursorChatExport = {
  version: 1;
  conversationState: string;
  blobs: Record<string, string>;
  name: string;
  exportedAt: number;
};

export type CursorStoredComposer = {
  composerId: string;
  workspaceId: string;
  createdAt: number;
  lastUpdatedAt: number | null;
  isArchived: boolean;
  name: string;
  conversationState: string;
  blobs: Record<string, string>;
};

export type CursorVerification = {
  sessionId: string;
  workspace: string;
  workspaceId: string;
  projectedTurnCount: number;
  projectedMessageCount: number;
  historyVisible: true;
  systemPromptRootCount: number;
  rootHistoryValid: true;
};

export type DshCoreFingerprints = {
  cli: string;
  session: string;
  agent: string;
  persistence: string;
  workspace: string;
};

export type DshInstallation = {
  targetProduct: "deepseek-harness";
  runtimeId: DshRuntimeId;
  executablePath: string;
  packageRoot: string;
  version: string;
  compatible: boolean;
  compatibilityError: string | null;
  fingerprints: DshCoreFingerprints;
  dshHome: string;
  webProfileRoot: string;
  bridgeInstalled: boolean;
  bridgeVersion: string | null;
  bridgeCompatible: boolean;
};

export type DshVerification = {
  sessionId: string;
  workspace: string;
  workspaceId: string;
  agentPreset: string;
  seedLength: number;
  eventCount: number;
  projectedTurnCount: number;
  projectedMessageCount: number;
  historyVisible: true;
  reused: boolean;
};
