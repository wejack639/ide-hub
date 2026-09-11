const { app, BrowserWindow, ipcMain, session } = require("electron");
const { mkdir, realpath, stat, readFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_ROOT = path.resolve(__dirname, "..");
const RENDERER_PATH = path.join(APP_ROOT, "prototype", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href;
let mainWindow = null;
let migrationRunning = false;

function coreModule(relativePath) {
  return import(pathToFileURL(path.join(APP_ROOT, "dist", "src", relativePath)).href);
}

function assertTrustedSender(event) {
  if (event.senderFrame?.url !== RENDERER_URL) {
    throw new Error("Rejected IPC request from an untrusted renderer");
  }
}

function serializeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details:
      typeof error?.details === "object" && error.details !== null
        ? error.details
        : null,
  };
}

function handle(channel, operation) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return { ok: true, data: await operation(...args) };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  });
}

handle("ide-hub:scan", async () => {
  const [{ CodexAppServerClient }, { listCodexThreads }, qoderDiscovery, cursorDiscovery, dshDiscovery, zcodeDiscovery, piDiscovery] =
    await Promise.all([
      coreModule("codex/app-server-client.js"),
      coreModule("codex/reader.js"),
      coreModule("qoder/discovery.js"),
      coreModule("cursor/discovery.js"),
      coreModule("dsh/discovery.js"),
      coreModule("zcode/discovery.js"),
      coreModule("pi/discovery.js"),
    ]);
  const codex = new CodexAppServerClient({ networkDisabled: process.platform === "darwin" });
  let threads;
  try {
    await codex.start();
    threads = await listCodexThreads(codex);
  } finally {
    await codex.close();
  }

  async function scanQoder(discover, bundleId) {
    try {
      const installation = await discover();
      return {
        installed: true,
        version: installation.version,
        bundleId: installation.bundleId,
        appPath: installation.appPath,
      };
    } catch (error) {
      return {
        installed: false,
        version: null,
        bundleId,
        appPath: null,
        error: serializeError(error),
      };
    }
  }
  async function scanCursor() {
    try {
      const installation = await cursorDiscovery.inspectCursor();
      return {
        installed: true,
        compatible: installation.compatible,
        compatibilityError: installation.compatibilityError,
        version: installation.version,
        bundleId: installation.bundleId,
        appPath: installation.appPath,
        workbenchSha256: installation.workbenchSha256,
      };
    } catch (error) {
      return {
        installed: false,
        compatible: false,
        compatibilityError: error instanceof Error ? error.message : String(error),
        version: null,
        bundleId: "com.todesktop.230313mzl4w4u92",
        appPath: null,
        workbenchSha256: null,
        error: serializeError(error),
      };
    }
  }
  async function scanDsh() {
    try {
      const installation = await dshDiscovery.inspectDsh();
      return {
        installed: true,
        compatible: installation.compatible,
        compatibilityError: installation.compatibilityError,
        version: installation.version,
        runtimeId: installation.runtimeId,
        executablePath: installation.executablePath,
        bridgeInstalled: installation.bridgeInstalled,
        bridgeVersion: installation.bridgeVersion,
        bridgeCompatible: installation.bridgeCompatible,
      };
    } catch (error) {
      return {
        installed: false,
        compatible: false,
        compatibilityError: error instanceof Error ? error.message : String(error),
        version: null,
        runtimeId: "@deepseek-ai/dsh",
        executablePath: null,
        bridgeInstalled: false,
        bridgeVersion: null,
        bridgeCompatible: false,
        error: serializeError(error),
      };
    }
  }
  const [qoder, qoderCn, cursor, dsh, zcode, pi] = await Promise.all([
    scanQoder(qoderDiscovery.discoverQoderInternational, "com.qoder.ide"),
    scanQoder(qoderDiscovery.discoverQoderCn, "com.aliyun.lingma.ide"),
    scanCursor(),
    scanDsh(),
    zcodeDiscovery.inspectZcode().catch(error => ({ installed: false, compatible: false, compatibilityError: error.message, error: serializeError(error) })),
    piDiscovery.inspectPi().catch(error => ({ installed: false, compatible: false, compatibilityError: error.message, error: serializeError(error) })),
  ]);

  return {
    scannedAt: new Date().toISOString(),
    qoder,
    qoderCn,
    cursor,
    dsh,
    zcode,
    pi,
    threads: threads.map((thread) => ({
      id: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      path: thread.path,
      status: thread.status,
      historyMode: thread.historyMode,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      source: thread.source,
      cliVersion: thread.cliVersion,
      migratable:
        !thread.ephemeral &&
        thread.path !== null &&
        thread.status?.type !== "active",
    })),
  };
});

handle("ide-hub:prepare-dsh", async () => {
  const { inspectDsh, ensureDshBridge } = await coreModule("dsh/discovery.js");
  const installation = await inspectDsh();
  const bridge = await ensureDshBridge(installation);
  const verified = await inspectDsh();
  return {
    installed: true,
    compatible: verified.compatible,
    compatibilityError: verified.compatibilityError,
    version: verified.version,
    runtimeId: verified.runtimeId,
    executablePath: verified.executablePath,
    bridgeInstalled: verified.bridgeInstalled,
    bridgeVersion: verified.bridgeVersion,
    bridgeCompatible: verified.bridgeCompatible,
    installedNow: bridge.installedNow,
    profileRestartRequired: bridge.profileRestartRequired,
  };
});

handle("ide-hub:preview-zcode", async (sourceThreadId) => {
  const [{ runMigration }, { validateMigrationRequest }] = await Promise.all([coreModule("migration.js"), coreModule("request.js")]);
  const result = await runMigration(validateMigrationRequest({ sourceProduct: "codex", targetProduct: "zcode", sourceThreadId,
    contextPolicy: "goal-recent-plan-v1", dryRun: true }));
  const projection = JSON.parse(await readFile(path.join(result.details.artifactsDir, "zcode-history.json"), "utf8"));
  return { result, projection };
});

handle("ide-hub:preview-pi", async (sourceThreadId) => {
  const [{ runMigration }, { validateMigrationRequest }] = await Promise.all([coreModule("migration.js"), coreModule("request.js")]);
  const result = await runMigration(validateMigrationRequest({ sourceProduct: "codex", targetProduct: "pi", sourceThreadId,
    contextPolicy: "goal-recent-plan-v1", dryRun: true }));
  const projection = JSON.parse(await readFile(path.join(result.details.artifactsDir, "pi-history.json"), "utf8"));
  const plan = JSON.parse(await readFile(path.join(result.details.artifactsDir, "target-plan.json"), "utf8"));
  return { result, projection, plan };
});

handle("ide-hub:migrate", async (sourceThreadId, targetProduct) => {
  if (typeof sourceThreadId !== "string") {
    throw new Error("sourceThreadId must be a string");
  }
  if (migrationRunning) {
    const error = new Error("Another session migration is already running");
    error.code = "MIGRATION_ALREADY_RUNNING";
    throw error;
  }
  migrationRunning = true;
  try {
    const [{ runMigration }, { validateMigrationRequest }] = await Promise.all([
      coreModule("migration.js"),
      coreModule("request.js"),
    ]);
    const request = validateMigrationRequest({
      sourceProduct: "codex",
      targetProduct,
      sourceThreadId,
      contextPolicy: "goal-recent-plan-v1",
      dryRun: false,
    });
    return await runMigration(request);
  } finally {
    migrationRunning = false;
  }
});

handle("ide-hub:open-target", async (workspace, targetProduct, targetSessionId) => {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw new Error("workspace must be an absolute path");
  }
  const canonicalWorkspace = await realpath(workspace);
  const workspaceStat = await stat(canonicalWorkspace);
  if (!workspaceStat.isDirectory()) {
    throw new Error("workspace is not a directory");
  }
  if (targetProduct === "pi") {
    if (typeof targetSessionId !== "string") throw new Error("Pi targetSessionId is required");
    const [{ inspectPi }, { resolvePiTarget }, { openPiSession }] = await Promise.all([
      coreModule("pi/discovery.js"), coreModule("pi/migration.js"), coreModule("pi/runtime.js"),
    ]);
    const installation = await inspectPi();
    const sessionPath = await resolvePiTarget(installation, canonicalWorkspace, targetSessionId);
    await openPiSession(installation, canonicalWorkspace, sessionPath, targetSessionId);
    return { workspace: canonicalWorkspace, targetProduct, targetSessionId, openMode: "terminal-session" };
  }
  if (targetProduct === "cursor") {
    const [{ discoverCursor, openCursorWorkspace }, { invokeCursorBridge }] =
      await Promise.all([
        coreModule("cursor/discovery.js"),
        coreModule("cursor/bridge.js"),
      ]);
    const installation = await discoverCursor();
    openCursorWorkspace(installation, canonicalWorkspace);
    if (typeof targetSessionId === "string" && targetSessionId.length > 0) {
      await invokeCursorBridge(
        installation,
        canonicalWorkspace,
        { operation: "open", composerId: targetSessionId },
        path.join(app.getPath("userData"), "open-requests"),
      );
    }
    return { workspace: canonicalWorkspace, targetProduct, targetSessionId };
  }
  if (targetProduct === "zcode") {
    const { discoverZcode, openZcodeWorkspace } = await coreModule("zcode/discovery.js");
    const { readZcodeTask, readZcodeSession } = await coreModule("zcode/storage.js");
    const installation = await discoverZcode();
    if (typeof targetSessionId !== "string") throw new Error("ZCode targetSessionId is required");
    const task = readZcodeTask(installation.taskDb, targetSessionId, canonicalWorkspace);
    const native = readZcodeSession(installation.sessionDb, targetSessionId);
    if (!task || task.workspace_path !== canonicalWorkspace || native?.directory !== canonicalWorkspace || native?.path !== canonicalWorkspace) throw new Error("ZCode session/workspace does not match");
    await openZcodeWorkspace(installation, canonicalWorkspace);
    return { workspace: canonicalWorkspace, targetProduct, targetSessionId, openMode: "project-only", title: task.title };
  }
  if (targetProduct === "deepseek-harness") {
    const [{ discoverDsh }, { ensureDshRuntime, openDshWeb }] = await Promise.all([
      coreModule("dsh/discovery.js"),
      coreModule("dsh/bridge.js"),
    ]);
    const installation = await discoverDsh();
    const operationDirectory = path.join(app.getPath("userData"), "open-requests");
    await mkdir(operationDirectory, { recursive: true });
    await ensureDshRuntime(installation, canonicalWorkspace, operationDirectory);
    await openDshWeb();
    return { workspace: canonicalWorkspace, targetProduct, targetSessionId };
  }
  const { discoverQoder, openQoderWorkspace } = await coreModule(
    "qoder/discovery.js",
  );
  if (targetProduct !== "qoder-international" && targetProduct !== "qoder-cn") {
    throw new Error("targetProduct must be qoder-international, qoder-cn, cursor, or deepseek-harness");
  }
  const installation = await discoverQoder(targetProduct);
  openQoderWorkspace(installation, canonicalWorkspace);
  return { workspace: canonicalWorkspace, targetProduct };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 980,
    minHeight: 680,
    title: "IDE Hub",
    backgroundColor: "#0b0e14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 17 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(RENDERER_PATH);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
