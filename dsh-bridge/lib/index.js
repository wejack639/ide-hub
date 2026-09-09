import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const name = "ide-hub-dsh-session-bridge";
const inject = [
  "agents",
  "sessions",
  "sessionPersistence",
  "workspaceRegistry",
  "sessionTitle",
  "agentPresets",
];
const BRIDGE_VERSION = "0.3.0";
const DSH_VERSION = "0.1.0-rc.6";
const PROTOCOL_VERSION = "dsh-session-event-v0-rc6-ide-hub-v3";

function apply(ctx, config) {
  const root = config?.root;
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error("ide-hub DSH bridge requires an absolute config.root");
  }
  const queue = join(root, "requests-v1");
  const handles = new Map();
  let disposed = false;
  let active = Promise.resolve();
  let timer;

  const scan = () => {
    active = active.then(async () => {
      if (disposed) return;
      await mkdir(queue, { recursive: true, mode: 0o700 });
      const entries = (await readdir(queue))
        .filter((entry) => entry.endsWith(".request.json"))
        .sort();
      for (const entry of entries) {
        if (disposed) return;
        await handleFile(ctx, handles, join(queue, entry));
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`ide-hub DSH bridge scan failed: ${renderError(error)}`);
    });
  };

  ctx.effect(() => {
    void mkdir(queue, { recursive: true, mode: 0o700 }).then(scan);
    timer = setInterval(scan, 100);
    return async () => {
      disposed = true;
      clearInterval(timer);
      await active;
      handles.clear();
    };
  }, "ide-hub-dsh-session-bridge.queue");
}

async function handleFile(ctx, handles, requestPath) {
  let request;
  try {
    request = JSON.parse(await readFile(requestPath, "utf8"));
    validateEnvelope(request);
    const result = await execute(ctx, handles, request);
    await writeResponse(request.responsePath, {
      ok: true,
      nonce: request.nonce,
      bridgeVersion: BRIDGE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      result,
    });
  } catch (error) {
    if (request?.responsePath && isAbsolute(request.responsePath)) {
      await writeResponse(request.responsePath, {
        ok: false,
        nonce: typeof request.nonce === "string" ? request.nonce : "invalid",
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        error: {
          code: typeof error?.code === "string" ? error.code : "DSH_IMPORT_FAILED",
          message: renderError(error),
        },
      });
    }
  } finally {
    await unlink(requestPath).catch(() => {});
  }
}

async function execute(ctx, handles, request) {
  if (request.operation === "probe") {
    return {
      dshVersion: DSH_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      services: {
        agents: true,
        sessions: true,
        sessionPersistence: true,
        workspaceRegistry: true,
        sessionTitle: true,
        agentPresets: true,
      },
    };
  }
  if (request.operation === "create") {
    return await createOrReuse(ctx, handles, request);
  }
  if (request.operation === "inspect") {
    const agent = await ensureLive(ctx, handles, request.sessionId, request.workspace, request.agentPreset);
    return await inspectSession(ctx, agent.session, request.workspace, request.expectedSeed);
  }
  throw codedError("DSH_PROTOCOL_UNSUPPORTED", `unsupported operation ${String(request.operation)}`);
}

async function createOrReuse(ctx, handles, request) {
  validateCreateRequest(request);
  const canonical = await canonicalDirectory(request.workspace);
  if (canonical !== request.workspace) {
    throw codedError(
      "TARGET_WORKSPACE_MISMATCH",
      `bridge canonical workspace ${canonical} does not equal ${request.workspace}`,
    );
  }

  const stored = (await ctx.sessionPersistence.list()).find(
    (header) => header.id === request.sessionId,
  );
  let agent;
  let reused = false;
  if (stored !== undefined || ctx.agents.get(request.sessionId) !== undefined) {
    agent = await ensureLive(
      ctx,
      handles,
      request.sessionId,
      canonical,
      request.agentPreset,
    );
    reused = true;
  } else {
    const handle = await ctx.agents.create({
      sessionId: request.sessionId,
      seed: request.seed,
      meta: {
        cwd: canonical,
        seedLength: request.seed.length,
        agentPreset: request.agentPreset,
      },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, request.agentPreset);
      },
    });
    handles.set(request.sessionId, handle);
    agent = handle.agent;
  }

  assertSessionIdentity(agent.session, request.sessionId, canonical, request.agentPreset);
  assertSeedPrefix(agent.session.events, request.seed);
  if (!await ctx.sessions.flush(agent.session)) {
    throw codedError("DSH_IMPORT_FAILED", "no DSH persistence listener accepted the session flush");
  }
  const workspace =
    await ctx.workspaceRegistry.resolveByPath(canonical) ??
    await ctx.workspaceRegistry.create(canonical);
  await workspace.attachSession(request.sessionId);
  if (!reused || ctx.sessionTitle.get(agent.session) === undefined) {
    ctx.sessionTitle.rename(agent.session, truncateUtf8(request.title, 80));
    if (!await ctx.sessions.flush(agent.session)) {
      throw codedError("DSH_IMPORT_FAILED", "DSH title flush was not accepted");
    }
  }
  const inspection = await inspectSession(ctx, agent.session, canonical, request.seed);
  return { ...inspection, reused };
}

async function ensureLive(ctx, handles, sessionId, workspace, agentPreset) {
  const live = ctx.agents.get(sessionId);
  if (live !== undefined) return live;
  const inspection = await ctx.sessionPersistence.inspect(sessionId);
  assertSessionIdentity(inspection, sessionId, workspace, agentPreset);
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, agentPreset);
    },
  });
  handles.set(sessionId, handle);
  return handle.agent;
}

async function inspectSession(ctx, session, workspacePath, expectedSeed) {
  assertSessionIdentity(session, session.id, workspacePath, session.header.agentPreset);
  assertSeedPrefix(session.events, expectedSeed);
  const workspace = await ctx.workspaceRegistry.resolveByPath(workspacePath);
  if (workspace === undefined || !workspace.sessionIds.includes(session.id)) {
    throw codedError(
      "TARGET_SESSION_NOT_VISIBLE_IN_IDE",
      `session ${session.id} is not attached to workspace ${workspacePath}`,
    );
  }
  const messages = session.deriveMessages().map((message) => ({
    role: message.role,
    content: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
  })).filter((message) => message.role === "user" || message.role === "assistant");
  return {
    sessionId: session.id,
    header: {
      version: session.header.version,
      id: session.header.id,
      createdAt: session.header.createdAt,
      cwd: session.header.cwd,
      seedLength: session.header.seedLength,
      agentPreset: session.header.agentPreset,
    },
    workspace: {
      workspaceId: workspace.id,
      path: workspace.path,
      sessionAttached: true,
    },
    eventCount: session.events.length,
    eventTypes: session.events.map((event) => event.type),
    seedEvents: session.events.slice(0, expectedSeed.length),
    messages,
    historyVisible: true,
  };
}

function validateEnvelope(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.nonce !== "string" ||
    request.nonce.length === 0 ||
    typeof request.responsePath !== "string" ||
    !isAbsolute(request.responsePath) ||
    request.bridgeVersion !== BRIDGE_VERSION ||
    request.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw codedError("DSH_PROTOCOL_UNSUPPORTED", "invalid IDE Hub DSH bridge request envelope");
  }
}

function validateCreateRequest(request) {
  if (
    typeof request.sessionId !== "string" ||
    !request.sessionId.startsWith("session-idehub-") ||
    typeof request.workspace !== "string" ||
    !isAbsolute(request.workspace) ||
    request.agentPreset !== "standard" ||
    typeof request.title !== "string" ||
    request.title.trim().length === 0 ||
    !Array.isArray(request.seed) ||
    request.seed.length === 0
  ) {
    throw codedError("DSH_PROTOCOL_UNSUPPORTED", "invalid DSH native session creation request");
  }
}

function assertSessionIdentity(session, sessionId, workspace, agentPreset) {
  const header = session.header ?? session.meta;
  if (
    header?.version !== 0 ||
    header?.id !== sessionId ||
    header?.cwd !== workspace ||
    header?.agentPreset !== agentPreset
  ) {
    throw codedError(
      "TARGET_WORKSPACE_MISMATCH",
      `DSH session ${sessionId} does not match the requested workspace/preset`,
    );
  }
}

function assertSeedPrefix(events, expectedSeed) {
  if (!Array.isArray(expectedSeed) || events.length < expectedSeed.length + 1) {
    throw codedError("DSH_PROTOCOL_UNSUPPORTED", "DSH session is shorter than its imported seed");
  }
  for (let index = 0; index < expectedSeed.length; index += 1) {
    if (!isDeepStrictEqual(events[index], expectedSeed[index])) {
      throw codedError(
        "DSH_PROTOCOL_UNSUPPORTED",
        `DSH persisted seed differs at event seq ${index}`,
      );
    }
  }
  const marker = events[expectedSeed.length];
  if (marker?.type !== "session/end-seed" || marker.seq !== expectedSeed.length) {
    throw codedError("DSH_PROTOCOL_UNSUPPORTED", "DSH session/end-seed boundary is missing");
  }
}

async function canonicalDirectory(path) {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) {
    throw codedError("TARGET_WORKSPACE_MISMATCH", `${canonical} is not a directory`);
  }
  return canonical;
}

function truncateUtf8(value, limit) {
  let result = "";
  for (const character of value.trim().replace(/\s+/gu, " ")) {
    if (Buffer.byteLength(result + character, "utf8") > limit) break;
    result += character;
  }
  return result || "Codex imported session";
}

async function writeResponse(path, response) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(response)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function renderError(error) {
  return error instanceof Error ? error.message : String(error);
}

export { apply, inject, name };
