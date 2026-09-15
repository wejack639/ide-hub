"use strict";

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // The probe intentionally ignores non-JSON startup input.
    }
  }
});

function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "ide-hub-native-probe", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: "ide_hub_probe",
        description: "Deterministic local MCP migration probe",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    return;
  }
  if (message.method === "prompts/list") {
    respond(message.id, { prompts: [] });
    return;
  }
  if (message.method === "resources/list") {
    respond(message.id, { resources: [] });
    return;
  }
  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  })}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
