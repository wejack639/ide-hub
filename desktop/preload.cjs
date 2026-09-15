const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "ideHub",
  Object.freeze({
    scan: () => ipcRenderer.invoke("ide-hub:scan"),
    scanMcp: (input = {}) => ipcRenderer.invoke("ide-hub:mcp-scan", input),
    chooseMcpWorkspace: () => ipcRenderer.invoke("ide-hub:mcp-choose-workspace"),
    planMcp: (request) => ipcRenderer.invoke("ide-hub:mcp-plan", request),
    applyMcp: (plan) => ipcRenderer.invoke("ide-hub:mcp-apply", plan),
    rollbackMcp: (mcpMigrationId) => ipcRenderer.invoke("ide-hub:mcp-rollback", String(mcpMigrationId)),
    listMcpJobs: () => ipcRenderer.invoke("ide-hub:mcp-jobs"),
    exportMcp: (input) => ipcRenderer.invoke("ide-hub:mcp-export", input),
    importMcp: () => ipcRenderer.invoke("ide-hub:mcp-import"),
    prepareDsh: () => ipcRenderer.invoke("ide-hub:prepare-dsh"),
    previewZcode: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-zcode", String(sourceThreadId)),
    previewPi: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-pi", String(sourceThreadId)),
    previewClaude: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-claude", String(sourceThreadId)),
    previewCodeBuddy: (sourceThreadId, targetProduct) => ipcRenderer.invoke("ide-hub:preview-codebuddy", String(sourceThreadId), String(targetProduct)),
    revealCodeBuddyArchive: (migrationId) => ipcRenderer.invoke("ide-hub:reveal-codebuddy-archive", String(migrationId)),
    cancelCodeBuddyMigration: (migrationId) => ipcRenderer.invoke("ide-hub:cancel-codebuddy-migration", String(migrationId)),
    prepareCodeBuddyRollback: (workspace, targetProduct, archiveId, targetSessionId, allowDeleteContinuation) => ipcRenderer.invoke(
      "ide-hub:prepare-codebuddy-rollback",
      String(workspace),
      String(targetProduct),
      String(archiveId),
      String(targetSessionId),
      allowDeleteContinuation === true,
    ),
    confirmCodeBuddyRollback: (workspace, targetProduct, archiveId, targetSessionId) => ipcRenderer.invoke(
      "ide-hub:confirm-codebuddy-rollback",
      String(workspace),
      String(targetProduct),
      String(archiveId),
      String(targetSessionId),
    ),
    rollbackClaude: (workspace, targetSessionId) => ipcRenderer.invoke("ide-hub:rollback-claude", String(workspace), String(targetSessionId)),
    migrate: (sourceThreadId, targetProduct) =>
      ipcRenderer.invoke(
        "ide-hub:migrate",
        String(sourceThreadId),
        String(targetProduct),
      ),
    openTarget: (workspace, targetProduct, targetSessionId) =>
      ipcRenderer.invoke(
        "ide-hub:open-target",
        String(workspace),
        String(targetProduct),
        targetSessionId === null || targetSessionId === undefined
          ? null
          : String(targetSessionId),
      ),
  }),
);
