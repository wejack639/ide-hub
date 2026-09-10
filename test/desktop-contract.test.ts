import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop shell uses the prototype renderer and exposes a narrow IPC bridge", async () => {
  const [html, renderer, main, preload] = await Promise.all([
    readFile(new URL("../prototype/index.html", import.meta.url), "utf8"),
    readFile(new URL("../prototype/app.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(html, /connect-src 'none'/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.doesNotMatch(html, /class="traffic"/u);
  assert.match(main, /"prototype", "index\.html"/u);
  assert.match(renderer, /window\.ideHub\.scan\(\)/u);
  assert.match(renderer, /window\.ideHub\.migrate\(thread\.id, targetProduct\)/u);
  assert.match(
    renderer,
    /window\.ideHub\.openTarget\(workspace, targetProduct, targetSessionId\)/u,
  );
  assert.match(renderer, /"qoder-cn"/u);
  assert.match(renderer, /"cursor"/u);
  assert.match(renderer, /"deepseek-harness"/u);
  assert.match(main, /discoverQoderCn/u);
  assert.match(main, /inspectCursor/u);
  assert.match(main, /inspectDsh/u);
  assert.match(main, /inspectZcode/u);
  assert.match(main, /preview-zcode/u);
  assert.match(renderer, /window\.ideHub\.previewZcode/u);
  assert.match(html, /data-target="zcode">\s*<span[^>]*>ZCode<\/span>\s*<span[^>]*>原生历史 · 已实现/u);
  assert.match(renderer, /全部可见消息 · 保留原顺序与独立角色/u);
  assert.match(main, /ensureDshBridge/u);
  assert.match(main, /cursor\/bridge\.js/u);
  assert.match(main, /com\.aliyun\.lingma\.ide/u);
  assert.match(main, /@deepseek-ai\/dsh/u);
  assert.match(renderer, /MCP 扫描尚未实现/u);
  assert.match(renderer, /ZIP 导出/u);
  assert.match(renderer, /ZIP 导入/u);
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /backgroundThrottling:\s*false/u);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/u);
  assert.match(preload, /scan:/u);
  assert.match(preload, /prepareDsh:/u);
  assert.match(preload, /migrate:/u);
  assert.match(preload, /openTarget:/u);
  assert.doesNotMatch(preload, /ipcRenderer\.send\s*[,}]/u);
});
