import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import readline from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { runStdioServer } from "../../apps/gks-server/src/server.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-c0-transport-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const server = runStdioServer({
    env: { GKS_DB_PATH: path.join(dir, "gks.sqlite") },
    input,
    output,
  });
  const lines = readline.createInterface({ input: output, crlfDelay: Infinity });
  const waiting = [];
  lines.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
  cleanups.push(() => {
    server.close();
    lines.close();
    input.destroy();
    output.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    nextResponse() {
      return new Promise((resolve) => waiting.push(resolve));
    },
    sendRaw(value) {
      input.write(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
    },
  };
}

function request(id, params, extra = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params, ...extra });
}

describe("C0 bounded stdio transport", () => {
  it("rejects duplicate keys before service dispatch", async () => {
    const server = startServer();
    const response = server.nextResponse();
    server.sendRaw('{"jsonrpc":"2.0","id":1,"method":"initialize","method":"tools/list"}\n');

    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { message: expect.stringContaining("Duplicate JSON object key") },
    });
  });

  // GKS-API-002: only JSON-RPC 2.0 frames are accepted. The refusal echoes a
  // usable id so the caller can correlate it, and the server keeps serving.
  it("rejects frames whose JSON-RPC version is not 2.0", async () => {
    const server = startServer();
    const invalid = { code: -32600, message: 'JSON-RPC version must be "2.0".' };
    const frames = [
      [{ jsonrpc: "1.0", id: 1, method: "tools/list" }, 1],
      [{ jsonrpc: 2, id: "two", method: "tools/list" }, "two"],
      [{ id: 3, method: "tools/call", params: { name: "gks_health", arguments: {} } }, 3],
      // An id that is not a valid JSON-RPC id is not echoed.
      [{ jsonrpc: "1.0", id: { nested: true }, method: "tools/list" }, null],
      // Without a version a frame is not a valid notification either.
      [{ method: "notifications/initialized" }, null],
    ];
    for (const [frame, id] of frames) {
      const response = server.nextResponse();
      server.sendRaw(`${JSON.stringify(frame)}\n`);
      await expect(response).resolves.toEqual({ jsonrpc: "2.0", id, error: invalid });
    }
    const alive = server.nextResponse();
    server.sendRaw(`${request(9, { name: "gks_health", arguments: {} })}\n`);
    await expect(alive).resolves.toMatchObject({ jsonrpc: "2.0", id: 9, result: { structuredContent: { state: "ready" } } });
  });

  it("rejects unsupported JSON-RPC batches", async () => {
    const server = startServer();
    const response = server.nextResponse();
    server.sendRaw(`${JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize" }])}\n`);

    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { message: "JSON-RPC batch requests are unsupported." },
    });
  });

  it("rejects JSON deeper than the configured limit", async () => {
    const server = startServer();
    let nested = "0";
    for (let index = 0; index < 33; index += 1) nested = `[${nested}]`;
    const response = server.nextResponse();
    server.sendRaw(`${request(1, { name: "gks_health", arguments: JSON.parse(nested) })}\n`);

    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { message: "JSON depth exceeds the configured limit." },
    });
  });

  it("rejects an oversized normal request without dispatch", async () => {
    const server = startServer();
    const response = server.nextResponse();
    const frame = `${request(1, { name: "gks_health", arguments: { padding: "x".repeat(1_048_576) } })}\n`;
    expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(1_048_576);
    server.sendRaw(frame);

    await expect(response).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "Request frame exceeds the configured limit." },
    });
  });
});
