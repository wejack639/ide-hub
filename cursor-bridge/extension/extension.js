"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const IMPORT_COMMAND = "developer.bulkImportChats";
const OPEN_COMMAND = "composer.openComposer";
const BRIDGE_VERSION = "0.7.0";

async function activate(context) {
  const userDataRoot = path.resolve(context.globalStorageUri.fsPath, "../../..");
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        await handleUriRequest(uri, userDataRoot);
      },
    }),
  );
  const queueDirectory = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "IDE Hub",
    "cursor",
    `bridge-requests-v${BRIDGE_VERSION}`,
  );
  await fs.mkdir(queueDirectory, { recursive: true, mode: 0o700 });
  const scan = () => void processQueue(queueDirectory, userDataRoot);
  const watcher = fsSync.watch(queueDirectory, scan);
  context.subscriptions.push({ dispose: () => watcher.close() });
  scan();
}

async function handleUriRequest(uri, userDataRoot) {
  const query = new URLSearchParams(uri.query);
  const requestPath = query.get("request");
  const nonce = query.get("nonce");
  if (!requestPath || !path.isAbsolute(requestPath) || !nonce) return;

  let request;
  try {
    request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  } catch {
    return;
  }
  if (
    request.nonce !== nonce ||
    request.bridgeVersion !== BRIDGE_VERSION ||
    request.expectedUserDataRoot !== userDataRoot
  ) {
    return;
  }
  const claimedPath = `${requestPath}.processing-${process.pid}`;
  try {
    await fs.rename(requestPath, claimedPath);
  } catch {
    return;
  }
  try {
    await handleRequestFile(claimedPath, request);
  } finally {
    await fs.rm(claimedPath, { force: true });
  }
}

async function processQueue(queueDirectory, userDataRoot) {
  let names;
  try {
    names = await fs.readdir(queueDirectory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".request.json")) continue;
    const requestPath = path.join(queueDirectory, name);
    let request;
    try {
      request = JSON.parse(await fs.readFile(requestPath, "utf8"));
      if (
        request.bridgeVersion !== BRIDGE_VERSION ||
        request.expectedUserDataRoot !== userDataRoot
      ) {
        continue;
      }
      if ((await currentWorkspace()) !== request.expectedWorkspace) continue;
    } catch {
      continue;
    }
    const claimedPath = `${requestPath}.processing-${process.pid}`;
    try {
      await fs.rename(requestPath, claimedPath);
    } catch {
      continue;
    }
    try {
      await handleRequestFile(claimedPath, request);
    } finally {
      await fs.rm(claimedPath, { force: true });
    }
  }
}

async function handleRequestFile(requestPath, request) {
  const nonce = request.nonce;
  if (
    typeof nonce !== "string" ||
    typeof request.responsePath !== "string" ||
    !path.isAbsolute(request.responsePath)
  ) {
    return;
  }

  try {
    const workspace = await currentWorkspace();
    if (workspace !== request.expectedWorkspace) {
      throw codedError(
        "TARGET_WORKSPACE_MISMATCH",
        `Cursor workspace is ${workspace}; expected ${request.expectedWorkspace}`,
      );
    }
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(IMPORT_COMMAND) || !commands.includes(OPEN_COMMAND)) {
      throw codedError(
        "CURSOR_PROTOCOL_UNSUPPORTED",
        "Cursor native import/open commands are unavailable",
      );
    }

    let result;
    if (request.operation === "probe") {
      result = {
        bridgeVersion: BRIDGE_VERSION,
        importCommand: true,
        openCommand: true,
        relevantCommands: commands.filter(
          (command) =>
            command.includes("Composer") ||
            command.includes("composer") ||
            command.includes("importChat") ||
            command.includes("deleteOldChats") ||
            /(^|\.)chat(\.|$)/i.test(command) ||
            /submit|send/i.test(command),
        ),
      };
    } else if (request.operation === "import") {
      if (typeof request.importDirectory !== "string") {
        throw codedError("CURSOR_IMPORT_FAILED", "importDirectory is missing");
      }
      const imported = await vscode.commands.executeCommand(
        IMPORT_COMMAND,
        request.importDirectory,
      );
      if (
        !imported ||
        imported.imported !== 1 ||
        imported.failed !== 0
      ) {
        throw codedError(
          "CURSOR_IMPORT_FAILED",
          `Cursor native importer returned ${JSON.stringify(imported)}`,
        );
      }
      result = imported;
    } else if (request.operation === "open") {
      if (typeof request.composerId !== "string") {
        throw codedError("CURSOR_IMPORT_FAILED", "composerId is missing");
      }
      await vscode.commands.executeCommand(OPEN_COMMAND, request.composerId);
      result = { opened: true, composerId: request.composerId };
    } else {
      throw codedError("CURSOR_IMPORT_FAILED", "Unknown bridge operation");
    }
    await writeResponse(request.responsePath, {
      ok: true,
      nonce,
      workspace,
      result,
    });
  } catch (error) {
    await writeResponse(request.responsePath, {
      ok: false,
      nonce,
      error: {
        code: typeof error?.code === "string" ? error.code : "CURSOR_BRIDGE_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function currentWorkspace() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length !== 1 || folders[0].uri.scheme !== "file") {
    throw codedError(
      "TARGET_WORKSPACE_MISMATCH",
      "Cursor must have exactly one local folder open",
    );
  }
  return fs.realpath(folders[0].uri.fsPath);
}

async function writeResponse(responsePath, value) {
  if (!path.isAbsolute(responsePath)) return;
  const temporary = `${responsePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(responsePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, responsePath);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deactivate() {}

module.exports = { activate, deactivate };
