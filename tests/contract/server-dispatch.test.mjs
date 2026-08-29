// Dispatch-boundary proof for the public tool surface.
//
// GHOST QA finding (2026-08-30): every tool was proven at the service layer,
// but only gks_knowledge_promote ever crossed the real tools/call dispatch in
// apps/gks-server/src/server.mjs -- swapping two entries in the toolHandler
// map left the whole suite green. This file drives EVERY registered tool
// through the real stdio server dispatch against a spy service, so a crossed
// map entry, a dropped tool, or mangled arguments fails here.
//
// Only what sits BEHIND the service port is replaced; the JSON-RPC framing,
// the toolHandler map and the error-to-structuredContent mapping under test
// are the production code paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import readline from "node:readline";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { GKS_TOOL_DEFINITIONS, GksScopeDeniedError } from "@freshair129/gks-contracts";

const dispatchSpy = vi.hoisted(() => {
  const state = { calls: [], failWith: null, persistenceClosed: 0 };
  const service = {};
  for (const method of ["health", "promoteCandidate", "search", "getEntity", "getRelations", "linkArtifact"]) {
    service[method] = async (args) => {
      state.calls.push({ method, args });
      if (state.failWith) {
        const error = state.failWith;
        state.failWith = null;
        throw error;
      }
      return { reachedServiceMethod: method, receivedArgs: args };
    };
  }
  return { state, service };
});

vi.mock("@freshair129/gks-core", () => ({
  createGksService: () => dispatchSpy.service,
}));
vi.mock("@freshair129/gks-persistence", () => ({
  openSqlitePersistence: () => ({
    close: () => {
      dispatchSpy.state.persistenceClosed += 1;
    },
  }),
}));

const { runStdioServer } = await import("../../apps/gks-server/src/server.mjs");

// The one map this file exists to defend. If a tool is added to the registry
// without a row here, the sync assertion below fails rather than the new tool
// silently escaping dispatch coverage.
const EXPECTED_DISPATCH = {
  gks_health: "health",
  gks_knowledge_promote: "promoteCandidate",
  gks_search: "search",
  gks_entity_get: "getEntity",
  gks_relations_get: "getRelations",
  gks_artifact_link: "linkArtifact",
};

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});
beforeEach(() => {
  dispatchSpy.state.calls = [];
  dispatchSpy.state.failWith = null;
});

function startServer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = runStdioServer({
    // The path is never opened -- persistence is mocked above -- but the
    // runtime's own precondition (explicit absolute GKS_DB_PATH) still runs.
    env: { GKS_DB_PATH: path.join(tmpdir(), "gks-dispatch-spy.sqlite") },
    input,
    output,
  });
  const lines = readline.createInterface({ input: output, crlfDelay: Infinity });
  const waiting = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
  });
  cleanups.push(() => {
    lines.close();
    server.close();
  });
  let nextId = 0;
  return {
    call(params) {
      const id = ++nextId;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`);
      return reply;
    },
  };
}

describe("stdio tools/call dispatch boundary", () => {
  it("everyRegisteredTool_reachesItsOwnServiceMethodWithItsOwnArguments", async () => {
    const registered = GKS_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect([...registered].sort()).toEqual(Object.keys(EXPECTED_DISPATCH).sort());

    const server = startServer();
    for (const name of registered) {
      const args = { probe: `arguments-for-${name}`, nested: { forTool: name } };
      const before = dispatchSpy.state.calls.length;

      const response = await server.call({ name, arguments: args });

      expect(response.error).toBeUndefined();
      expect(response.result.isError).toBeUndefined();
      expect(response.result.structuredContent).toEqual({
        reachedServiceMethod: EXPECTED_DISPATCH[name],
        receivedArgs: args,
      });
      expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent);
      expect(dispatchSpy.state.calls.slice(before)).toEqual([{ method: EXPECTED_DISPATCH[name], args }]);
    }
  });

  it("omittedArguments_reachTheServiceAsAnEmptyObject", async () => {
    const server = startServer();

    const response = await server.call({ name: "gks_health" });

    expect(response.result.structuredContent).toEqual({ reachedServiceMethod: "health", receivedArgs: {} });
    expect(dispatchSpy.state.calls).toEqual([{ method: "health", args: {} }]);
  });

  it("unknownTool_isRejectedWithoutTouchingTheService", async () => {
    const server = startServer();

    const response = await server.call({ name: "gks_definitely_not_registered", arguments: {} });

    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent).toEqual({ code: "gks_invalid_request", message: "Unknown GKS tool." });
    expect(response.result.content).toEqual([{ type: "text", text: "Unknown GKS tool." }]);
    expect(dispatchSpy.state.calls).toEqual([]);
  });

  it("serviceErrorWithCode_surfacesThatCodeInStructuredContent", async () => {
    const server = startServer();
    dispatchSpy.state.failWith = new GksScopeDeniedError("tenant-b may not read tenant-a knowledge");

    const response = await server.call({ name: "gks_entity_get", arguments: { ref: "gks:entity/foreign" } });

    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent).toEqual({
      code: "gks_scope_denied",
      message: "tenant-b may not read tenant-a knowledge",
    });
    expect(response.result.content).toEqual([{ type: "text", text: "tenant-b may not read tenant-a knowledge" }]);
  });

  it("serviceErrorWithoutCode_fallsBackToBackendUnavailable", async () => {
    const server = startServer();
    dispatchSpy.state.failWith = new Error("sqlite disk I/O error");

    const response = await server.call({ name: "gks_search", arguments: { query: "LINE" } });

    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent).toEqual({
      code: "gks_backend_unavailable",
      message: "sqlite disk I/O error",
    });
  });
});
