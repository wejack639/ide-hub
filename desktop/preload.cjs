const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "ideHub",
  Object.freeze({
    scan: () => ipcRenderer.invoke("ide-hub:scan"),
    prepareDsh: () => ipcRenderer.invoke("ide-hub:prepare-dsh"),
    previewZcode: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-zcode", String(sourceThreadId)),
    previewPi: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-pi", String(sourceThreadId)),
    previewClaude: (sourceThreadId) => ipcRenderer.invoke("ide-hub:preview-claude", String(sourceThreadId)),
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
