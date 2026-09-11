// 显式提供真实源 ID；操作正式打包 renderer/IPC，不伪造扫描、预览或迁移结果。
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, writeFile, readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");

(async () => {
  const threadId = process.env.IDE_HUB_CLAUDE_REAL_THREAD;
  assert.match(threadId ?? "", /^[a-f0-9-]+$/i, "必须显式设置 IDE_HUB_CLAUDE_REAL_THREAD");
  const artifacts = await mkdtemp(join(tmpdir(), "idehub-claude-desktop-"));
  console.log(`Desktop evidence: ${artifacts}`);
  const binary = resolve("release/IDE Hub-darwin-arm64/IDE Hub.app/Contents/MacOS/IDE Hub");
  const child = spawn(binary, ["--remote-debugging-port=0", `--user-data-dir=${join(artifacts, "profile")}`], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", socket;
  try {
    const browserUrl = await new Promise((done, fail) => {
      child.once("error", fail); child.once("exit", code => fail(new Error(`Desktop exited ${code}`)));
      child.stderr.on("data", chunk => { stderr += chunk; const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) done(found[1]); });
    });
    let targets = [];
    const port = new URL(browserUrl).port;
    const deadline = Date.now() + 300000;
    while (!targets.some(t => t.type === "page")) {
      assert.ok(Date.now() < deadline, "没有 renderer");
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      await new Promise(r => setTimeout(r, 200));
    }
    socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
    let id = 0; const pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data), callback = pending.get(message.id);
      if (!callback) return; pending.delete(message.id);
      message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); socket.send(JSON.stringify({ id: seq, method, params })); });
    const evaluate = async expression => {
      const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value;
    };
    const until = async expression => {
      const end = Date.now() + 300000;
      while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 300)); }
      throw new Error(`UI condition timed out: ${expression}`);
    };
    const snap = async name => { const r = await call("Page.captureScreenshot", { format: "png" }); await writeFile(join(artifacts, name), Buffer.from(r.data, "base64")); };
    await until('typeof state !== "undefined" && !state.scanning && !!state.claude');
    assert.equal(await evaluate("state.claude.compatible"), true, JSON.stringify(await evaluate("state.claude")));
    await evaluate(`document.querySelector('.sess-row[data-sid="${threadId}"]').click(); document.querySelector('#detailMigrateClaude').click()`);
    for (let step = 1; step <= 3; step++) await evaluate("document.querySelector('#ovMigration [data-wiz-next]').click()");
    await until("!!state.claudePreview || !!state.lastError");
    const preview = await evaluate("state.claudePreview"); assert.ok(preview); assert.ok(preview.projection.messages.length);
    assert.equal(preview.result.workspace, "/Users/domino/develop/IdeaProjects/temp");
    assert.equal(preview.result.targetSessionId, null);
    assert.match(await evaluate("document.querySelector('#ovMigration [data-pane=\"5\"]').innerText"), /不重放工具/);
    const targetExisted = existsSync(preview.plan.sessionPath);
    const digest = async () => createHash("sha256").update(await readFile(preview.plan.sessionPath)).digest("hex");
    const beforeHash = targetExisted ? await digest() : null;
    await snap("preview.png");
    for (let step = 4; step <= 5; step++) await evaluate("document.querySelector('#ovMigration [data-wiz-next]').click()");
    await snap("write-plan.png");
    await evaluate("document.querySelector('#migConfirm').click(); document.querySelector('#ovMigration [data-wiz-next]').click()");
    await until("!state.migrating && (!!state.lastResult || !!state.lastError)");
    const outcome = await evaluate("({ result: state.lastResult, error: state.lastError })");
    assert.equal(outcome.error, null, JSON.stringify(outcome.error)); assert.equal(outcome.result.continuation.product, "claude-code");
    const afterHash = await digest(); if (beforeHash) assert.equal(afterHash, beforeHash, "复跑改变了已有目标");
    await snap("result.png");
    let opened = false;
    if (process.env.IDE_HUB_CLAUDE_OPEN === "1") {
      await evaluate("document.querySelector('#migOpenTarget').click()");
      await until('document.body.innerText.includes("已请求 Claude Code 打开工作区和迁移会话")');
      opened = true;
    }
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ ...outcome, opened, previewCount: preview.projection.messages.length, targetExisted, beforeHash, afterHash }, null, 2));
    console.log(JSON.stringify({ desktopGate: "PASS", artifacts, targetSessionId: outcome.result.targetSessionId, migrationId: outcome.result.migrationId, opened }));
  } finally { socket?.close(); child.kill("SIGTERM"); }
})().catch(error => { console.error(error); process.exitCode = 1; });
