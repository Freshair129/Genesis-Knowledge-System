import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { GKS_MSP_AUTH_VERSION, mspScopeDigest } from "@freshair129/gks-contracts";
import { scope } from "../fixtures/candidates.mjs";
import { runHttpServer } from "../../apps/gks-server/src/http-server.mjs";

const running = [];

afterEach(async () => {
  while (running.length) {
    const item = running.pop();
    await item.app.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-http-transport-"));
  const app = runHttpServer({
    env: {
      GKS_DB_PATH: path.join(dir, "gks.sqlite"),
      GKS_MSP_AUTH_REQUIRED: "1",
      GKS_MSP_RELAY_CREDENTIAL: "http-relay-secret",
      GKS_PIPELINE_RELAY_CREDENTIAL: "http-pipeline-secret",
    },
    host: "127.0.0.1",
    port: 0,
  });
  await app.ready;
  const address = app.server.address();
  running.push({ app, dir });
  return `http://127.0.0.1:${address.port}`;
}

async function post(base, payload, { authorization = "Bearer http-relay-secret", contentType = "application/json" } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

function authMeta(requestScope) {
  return {
    gksMspAuth: {
      version: GKS_MSP_AUTH_VERSION,
      principalId: "msp-runtime",
      role: "msp",
      scopeDigest: mspScopeDigest(requestScope),
    },
  };
}

describe("private HTTP JSON-RPC transport", () => {
  it("serves bounded readiness and liveness without exposing knowledge", async () => {
    const base = await startServer();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ service: "gks", status: "ok" });

    const initialize = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { authorization: null });
    expect(initialize.response.status).toBe(200);
    expect(initialize.body.result.serverInfo).toEqual({ name: "gks-knowledge-graph-service", version: "0.1.0" });

    const listed = await post(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { authorization: null });
    expect(listed.response.status).toBe(200);
    expect(listed.body.result.tools.map((tool) => tool.name)).toContain("gks_knowledge_promote");
  });

  it("maps the bearer credential into the existing scoped MSP envelope", async () => {
    const base = await startServer();
    const requestScope = scope();
    const result = await post(base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "gks_search",
        arguments: { query: "missing", scope: requestScope },
        _meta: authMeta(requestScope),
      },
    });
    expect(result.response.status).toBe(200);
    expect(result.body.result.structuredContent).toEqual([]);
  });

  it("denies absent or forged network credentials before service dispatch", async () => {
    const base = await startServer();
    const requestScope = scope();
    const absent = await post(base, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "gks_search", arguments: { query: "missing", scope: requestScope }, _meta: authMeta(requestScope) },
    }, { authorization: null });
    expect(absent.response.status).toBe(401);
    expect(absent.body.result.structuredContent.code).toBe("gks_scope_denied");

    const forged = await post(base, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "gks_search", arguments: { query: "missing", scope: requestScope }, _meta: authMeta(requestScope) },
    }, { authorization: "Bearer forged" });
    expect(forged.response.status).toBe(401);
    expect(forged.body.result.structuredContent.code).toBe("gks_scope_denied");
    expect(JSON.stringify(forged.body)).not.toContain("http-relay-secret");
  });

  it("keeps scope-digest denial inside the structured service error contract", async () => {
    const base = await startServer();
    const requestScope = scope();
    const mismatched = await post(base, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "gks_search",
        arguments: { query: "missing", scope: requestScope },
        _meta: authMeta(scope({ tenantId: "other-tenant" })),
      },
    });
    expect(mismatched.response.status).toBe(200);
    expect(mismatched.body.result).toMatchObject({ isError: true, structuredContent: { code: "gks_scope_denied" } });
  });

  it("rejects non-JSON bodies and normal frames above the bounded limit", async () => {
    const base = await startServer();
    const wrongType = await post(base, { jsonrpc: "2.0", id: 7, method: "initialize", params: {} }, { authorization: null, contentType: "text/plain" });
    expect(wrongType.response.status).toBe(415);

    const huge = await post(base, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "gks_search", arguments: { query: "x".repeat(1_100_000), scope: scope() } },
    });
    expect(huge.response.status).toBe(413);
    expect(huge.body.error.message).toContain("Request frame exceeds");
  });
});
