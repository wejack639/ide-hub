import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  QoderIdeRpcClient,
  qoderIdeClientIdentity,
  readQoderIdeRuntime,
  type QoderIdeRuntime,
} from "../src/qoder/ide-rpc.js";
import {
  appendProjectedTurns,
  normalizeImportedSession,
  removeImportedSessionRows,
  removeQoderRecordRows,
} from "../src/qoder/seed.js";

const execFileAsync = promisify(execFile);

test("Qoder international and CN use isolated IDE client identities", () => {
  assert.deepEqual(qoderIdeClientIdentity("qoder-international"), {
    idePlatform: "Qoder IDE",
    ideSeries: "Qoder IDE",
    pluginPublisher: "Qoder",
    pluginName: "Qoder",
  });
  assert.deepEqual(qoderIdeClientIdentity("qoder-cn"), {
    idePlatform: "QoderCN IDE",
    ideSeries: "QoderCN IDE",
    pluginPublisher: "QoderCN",
    pluginName: "QoderCN",
  });
});

test("Qoder CN runtime accepts its isolated qodercn socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qodercn-runtime-"));
  const socketPath = join(root, "qodercn.sock");
  const databasePath = join(root, "cache", "db", "local.db");
  await mkdir(join(root, "cache", "db"), { recursive: true });
  await execFileAsync("/usr/bin/sqlite3", [databasePath, "vacuum;"]);
  await writeFile(
    join(root, ".info.json"),
    JSON.stringify({ pid: process.pid, ipcServerPath: socketPath }),
  );
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const runtime = await readQoderIdeRuntime(root, "qodercn.sock");
    assert.equal(runtime.socketPath, await realpath(socketPath));
    assert.equal(runtime.databasePath, await realpath(databasePath));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Qoder history import makes one append call per projected conversation turn", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const turns = ["one", "two", "three"].map((value) => ({
    requestId: `request-${value}`,
    sourceTurnIds: [`turn-${value}`],
    sourceItemIds: [`user-${value}`, `assistant-${value}`],
    sourceMessageCount: 2,
    messages: [
      { role: "user" as const, content: `USER_${value}` },
      { role: "assistant" as const, content: `ASSISTANT_${value}` },
    ],
  }));
  await appendProjectedTurns(
    {
      async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        return { appendedMessageIds: ["user-id", "assistant-id"] } as T;
      },
    },
    "session-1",
    turns,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "session/appendHistoryTurn",
      "session/appendHistoryTurn",
      "session/appendHistoryTurn",
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.params.requestId),
    ["request-one", "request-two", "request-three"],
  );
});

test("Qoder IDE RPC uses framed JSON-RPC and initializes before session requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-rpc-"));
  const socketPath = join(root, "qoder.sock");
  const methods: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      for (;;) {
        const separator = buffer.indexOf("\r\n\r\n");
        if (separator < 0) return;
        const header = buffer.subarray(0, separator).toString("ascii");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        assert.ok(match?.[1]);
        const length = Number(match[1]);
        const start = separator + 4;
        if (buffer.length < start + length) return;
        const request = JSON.parse(
          buffer.subarray(start, start + length).toString("utf8"),
        ) as { id?: number; method: string };
        buffer = buffer.subarray(start + length);
        methods.push(request.method);
        if (request.id === undefined) continue;
        const result =
          request.method === "chat/listAllSessions"
            ? [{ sessionId: "session-1", sessionType: "assistant" }]
            : { protocolVersion: 1 };
        const body = Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        );
        socket.write(`Content-Length: ${body.length}\r\n\r\n`);
        socket.write(body);
        if (request.method === "chat/listAllSessions") {
          const notification = Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "session-1", update: { sessionUpdate: "done" } },
            }),
          );
          socket.write(`Content-Length: ${notification.length}\r\n\r\n`);
          socket.write(notification);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const runtime: QoderIdeRuntime = {
    dataRoot: root,
    infoPath: join(root, ".info.json"),
    socketPath,
    databasePath: join(root, "local.db"),
    pid: process.pid,
  };
  const client = await QoderIdeRpcClient.connect(runtime, root, "1.27.1");
  try {
    const notification = new Promise<{ method: string; params: unknown }>((resolve) => {
      client.onNotification((method, params) => resolve({ method, params }));
    });
    const sessions = await client.request<Array<{ sessionId: string }>>(
      "chat/listAllSessions",
      { workspacePath: root },
    );
    assert.equal(sessions[0]?.sessionId, "session-1");
    assert.deepEqual(await notification, {
      method: "session/update",
      params: { sessionId: "session-1", update: { sessionUpdate: "done" } },
    });
    assert.deepEqual(methods, ["initialize", "initialized", "chat/listAllSessions"]);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Qoder imported-session normalization changes only the exact native rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-db-"));
  const databasePath = join(root, "local.db");
  const workspace = join(root, "A");
  await mkdir(workspace);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const escapedWorkspace = workspace.replaceAll("'", "''");
  await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    [
      "create table chat_session(session_id text primary key, project_uri text, session_type text, extra text);",
      "create table chat_record(request_id text primary key, session_id text, session_type text, extra text);",
      `insert into chat_session values('${sessionId}','${escapedWorkspace}','voice','{}');`,
      `insert into chat_record values('r1','${sessionId}','voice','{}');`,
      `insert into chat_session values('${otherId}','${escapedWorkspace}','voice','{}');`,
    ].join("\n"),
  ]);
  const runtime: QoderIdeRuntime = {
    dataRoot: root,
    infoPath: join(root, ".info.json"),
    socketPath: join(root, "qoder.sock"),
    databasePath,
    pid: process.pid,
  };
  const result = await normalizeImportedSession(runtime, sessionId, workspace);
  assert.deepEqual(result, { sessionRows: 1, recordRows: 1 });
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    `select session_id || ':' || session_type from chat_session order by session_id;`,
  ]);
  assert.match(stdout, new RegExp(`${sessionId}:assistant`));
  assert.match(stdout, new RegExp(`${otherId}:voice`));
});

test("Qoder failed-import cleanup removes only rows marked by IDE Hub", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-cleanup-"));
  const databasePath = join(root, "local.db");
  const workspace = join(root, "A");
  await mkdir(workspace);
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const otherId = "44444444-4444-4444-8444-444444444444";
  const escapedWorkspace = workspace.replaceAll("'", "''");
  await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    [
      "create table chat_session(session_id text primary key, project_uri text, extra text);",
      "create table chat_record(request_id text primary key, session_id text, extra text);",
      `insert into chat_session values('${sessionId}','${escapedWorkspace}','{\"sessionCreateSource\":\"ide-hub-import\"}');`,
      `insert into chat_record values('r1','${sessionId}','{\"sessionCreateSource\":\"ide-hub-import\"}');`,
      `insert into chat_session values('${otherId}','${escapedWorkspace}','{}');`,
      `insert into chat_record values('r2','${otherId}','{}');`,
    ].join("\n"),
  ]);
  const runtime: QoderIdeRuntime = {
    dataRoot: root,
    infoPath: join(root, ".info.json"),
    socketPath: join(root, "qoder.sock"),
    databasePath,
    pid: process.pid,
  };
  assert.deepEqual(
    await removeImportedSessionRows(runtime, sessionId, workspace),
    { sessionRows: 1, recordRows: 1 },
  );
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    "select session_id from chat_session union all select session_id from chat_record;",
  ]);
  assert.equal(stdout.trim(), `${otherId}\n${otherId}`);
});

test("Qoder continuity cleanup removes only exact generated request ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "ide-hub-qoder-record-cleanup-"));
  const databasePath = join(root, "local.db");
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const otherSessionId = "66666666-6666-4666-8666-666666666666";
  const requestId = "77777777-7777-4777-8777-777777777777";
  const untouchedRequestId = "88888888-8888-4888-8888-888888888888";
  await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    [
      "create table chat_record(request_id text primary key, session_id text);",
      `insert into chat_record values('${requestId}','${sessionId}');`,
      `insert into chat_record values('${untouchedRequestId}','${sessionId}');`,
      `insert into chat_record values('99999999-9999-4999-8999-999999999999','${otherSessionId}');`,
    ].join("\n"),
  ]);
  const runtime: QoderIdeRuntime = {
    dataRoot: root,
    infoPath: join(root, ".info.json"),
    socketPath: join(root, "qoder.sock"),
    databasePath,
    pid: process.pid,
  };
  assert.equal(await removeQoderRecordRows(runtime, sessionId, [requestId]), 1);
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", [
    databasePath,
    "select request_id from chat_record order by request_id;",
  ]);
  assert.equal(
    stdout.trim(),
    `${untouchedRequestId}\n99999999-9999-4999-8999-999999999999`,
  );
});
