// 显式提供真实源 ID 才运行；通过打包应用的真实 renderer + IPC 完成七步向导。
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, writeFile, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

(async () => {
  const threadId = process.env.IDE_HUB_PI_REAL_THREAD;
  assert.ok(threadId, "必须显式设置 IDE_HUB_PI_REAL_THREAD");
  const artifacts = await mkdtemp(join(tmpdir(), "idehub-pi-desktop-"));
  const binary = resolve("release/IDE Hub-darwin-arm64/IDE Hub.app/Contents/MacOS/IDE Hub");
  const child = spawn(binary, ["--remote-debugging-port=0", `--user-data-dir=${join(artifacts, "electron-profile")}`], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; let socket;
  try {
    const browserUrl = await new Promise((done, fail) => {
      child.once("error", fail); child.once("exit", code => fail(new Error(`Desktop exited ${code}: ${stderr}`)));
      child.stderr.on("data", chunk => { stderr += chunk; const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) done(found[1]); });
    });
    const port = new URL(browserUrl).port;
    let targets = [];
    while (!targets.some(t => t.type === "page")) { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); await new Promise(r => setTimeout(r, 200)); }
    socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
    let id = 0; const pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data); const callback = pending.get(message.id);
      if (!callback) return; pending.delete(message.id);
      message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); socket.send(JSON.stringify({ id: seq, method, params })); });
    const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    const until = async expression => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 500)); }
      throw new Error(`UI condition timed out: ${expression}`);
    };
    await until('typeof state !== "undefined" && !state.scanning && !!state.pi');
    assert.equal(await evaluate("state.pi.compatible"), true);
    await evaluate(`document.querySelector('.sess-row[data-sid="${threadId}"]').click(); document.querySelector('#detailMigratePi').click()`);
    for (let step = 1; step <= 3; step++) await evaluate("document.querySelector('#ovMigration [data-wiz-next]').click()");
    await until("!!state.piPreview || !!state.lastError");
    const preview = await evaluate("state.piPreview"); assert.ok(preview); assert.ok(preview.projection.messages.length);
    assert.equal(preview.result.workspace, "/Users/domino/develop/IdeaProjects/temp");
    await mkdir(join(artifacts, "screenshots"));
    const snap = async name => { const page = await call("Page.captureScreenshot", { format: "png" }); await writeFile(join(artifacts, "screenshots", name), Buffer.from(page.data, "base64")); };
    await snap("preview.png");
    for (let step = 4; step <= 5; step++) await evaluate("document.querySelector('#ovMigration [data-wiz-next]').click()");
    await evaluate("document.querySelector('#migConfirm').click(); document.querySelector('#ovMigration [data-wiz-next]').click()");
    await until("!state.migrating && (!!state.lastResult || !!state.lastError)");
    const outcome = await evaluate("({ result: state.lastResult, error: state.lastError })");
    assert.equal(outcome.error, null, JSON.stringify(outcome.error)); assert.equal(outcome.result.continuation.product, "pi");
    await snap("result.png");
    const opened = await evaluate("window.ideHub.openTarget(state.lastResult.workspace, 'pi', state.lastResult.targetSessionId)");
    assert.equal(opened.ok, true, JSON.stringify(opened.error)); assert.equal(opened.data.openMode, "terminal-session");
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ ...outcome, opened, previewCount: preview.projection.messages.length }, null, 2));
    console.log(JSON.stringify({ desktopGate: "PASS", artifacts, result: outcome.result, opened }));
  } finally { socket?.close(); child.kill("SIGTERM"); }
})().catch(error => { console.error(error); process.exitCode = 1; });
