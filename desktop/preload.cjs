const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "ideHub",
  Object.freeze({
    scan: () => ipcRenderer.invoke("ide-hub:scan"),
    prepareDsh: () => ipcRenderer.invoke("ide-hub:prepare-dsh"),
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
