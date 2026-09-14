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
  assert.match(main, /inspectPi/u);
  assert.match(main, /inspectClaude/u);
  assert.match(main, /preview-claude/u);
  assert.match(main, /resolveClaudeTarget/u);
  assert.match(main, /scanCodeBuddy/u);
  assert.match(main, /preview-codebuddy/u);
  assert.match(main, /reveal-codebuddy-archive/u);
  assert.match(main, /cancel-codebuddy-migration/u);
  assert.match(main, /prepare-codebuddy-rollback/u);
  assert.match(main, /confirm-codebuddy-rollback/u);
  assert.match(renderer, /window\.ideHub\.previewClaude/u);
  assert.match(renderer, /window\.ideHub\.previewCodeBuddy/u);
  assert.match(renderer, /window\.ideHub\.revealCodeBuddyArchive/u);
  assert.match(renderer, /window\.ideHub\.cancelCodeBuddyMigration/u);
  assert.match(renderer, /window\.ideHub\.prepareCodeBuddyRollback/u);
  assert.match(renderer, /window\.ideHub\.confirmCodeBuddyRollback/u);
  assert.match(preload, /previewClaude:/u);
  assert.match(preload, /previewCodeBuddy:/u);
  assert.match(preload, /revealCodeBuddyArchive:/u);
  assert.match(preload, /cancelCodeBuddyMigration:/u);
  assert.match(preload, /prepareCodeBuddyRollback:/u);
  assert.match(preload, /confirmCodeBuddyRollback:/u);
  assert.match(preload, /rollbackClaude:/u);
  assert.match(renderer, /projection\.lossReport\.omittedEventTypes/u);
  assert.doesNotMatch(renderer, /omittedNonTextItems/u);
  assert.match(renderer, /在终端中打开 Claude Code 会话/u);
  assert.match(html, /data-target="claude-code">\s*<span[^>]*>Claude Code<\/span>\s*<span[^>]*>原生历史 · 已实现/u);
  assert.match(main, /preview-pi/u);
  assert.match(renderer, /window\.ideHub\.previewPi/u);
  assert.match(preload, /previewPi:/u);
  assert.match(renderer, /在终端中打开 Pi 会话/u);
  assert.match(html, /data-target="pi">\s*<span[^>]*>Pi<\/span>\s*<span[^>]*>原生历史 · 已实现/u);
  assert.match(renderer, /window\.ideHub\.previewZcode/u);
  assert.match(html, /data-target="zcode">\s*<span[^>]*>ZCode<\/span>\s*<span[^>]*>原生历史 · 已实现/u);
  assert.match(html, /data-target="codebuddy-international">\s*<span[^>]*>CodeBuddy 国际版<\/span>\s*<span[^>]*>官方 History Import · 已实现/u);
  assert.match(html, /data-target="codebuddy-cn">\s*<span[^>]*>CodeBuddy CN<\/span>\s*<span[^>]*>官方 History Import · 已实现/u);
  assert.doesNotMatch(html, /data-target="codebuddy"/u);
  assert.doesNotMatch(html, /CodeBuddy CLI 不在 PATH/u);
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
