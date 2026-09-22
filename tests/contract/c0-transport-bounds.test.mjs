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
