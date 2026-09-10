// 单独在真正的 Electron main 进程运行，覆盖 .asar 虚拟文件系统与 Node 的差异。
const { app } = require("electron");
const assert = require("node:assert/strict");
app.whenReady().then(async () => {
  try {
    const { inspectZcode, ZCODE_FINGERPRINTS } = await import("../dist/src/zcode/discovery.js");
    const installation = await inspectZcode();
    assert.equal(installation.compatible, true, installation.compatibilityError);
    assert.equal(installation.fingerprints.archive, ZCODE_FINGERPRINTS.archive);
    console.log("PASS: Electron main reads the physical ZCode archive and accepts the pinned installation");
    // 显式传入真实源 ID 才允许触及本机目标库；不做任何模型续聊。
    if (process.env.IDE_HUB_ZCODE_REAL_THREAD) {
      const { runMigration } = await import("../dist/src/migration.js");
      const { validateMigrationRequest } = await import("../dist/src/request.js");
      const { readFile } = require("node:fs/promises");
      const { join } = require("node:path");
      const input = { sourceProduct: "codex", targetProduct: "zcode",
        sourceThreadId: process.env.IDE_HUB_ZCODE_REAL_THREAD, contextPolicy: "goal-recent-plan-v1" };
      const preview = await runMigration(validateMigrationRequest({ ...input, dryRun: true }));
      const projection = JSON.parse(await readFile(join(preview.details.artifactsDir, "zcode-history.json"), "utf8"));
      assert.ok(projection.history.messages.length > 0);
      const result = await runMigration(validateMigrationRequest({ ...input, dryRun: false }));
      const readback = JSON.parse(await readFile(join(result.details.artifactsDir, "zcode-native-readback.json"), "utf8"));
      assert.equal(readback.verification.importedCount, projection.history.messages.length);
      console.log(JSON.stringify({ electronMigration: "PASS", result, messageCount: projection.history.messages.length }));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
