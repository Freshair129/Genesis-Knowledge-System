import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GKS_MSP_AUTH_VERSION, hashGksClientCredential, mspScopeDigest } from "@freshair129/gks-contracts";
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

async function startServer({ clientGrants, mspRelayCredential = "http-relay-secret" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-http-transport-"));
  const env = {
    GKS_DB_PATH: path.join(dir, "gks.sqlite"),
    GKS_MSP_AUTH_REQUIRED: "1",
    GKS_PIPELINE_RELAY_CREDENTIAL: "http-pipeline-secret",
  };
  if (mspRelayCredential) env.GKS_MSP_RELAY_CREDENTIAL = mspRelayCredential;
  if (clientGrants) {
    const grantsPath = path.join(dir, "client-grants.json");
    writeFileSync(grantsPath, JSON.stringify(clientGrants), "utf8");
    env.GKS_CLIENT_GRANTS_PATH = grantsPath;
  }
  const app = runHttpServer({
    env,
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

const directCredential = `gksc_${Buffer.alloc(32, 17).toString("base64url")}`;

function clientGrants(requestScope, allowedTools = ["gks_search"]) {
  return {
    schemaVersion: "gks-client-grants/v1",
    clients: [{
      clientId: "test-system",
      credentialSha256: hashGksClientCredential(directCredential),
      allowedTools,
      scopes: [requestScope],
    }],
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

  it("allows a direct client to query only its granted scope without an MSP credential", async () => {
    const requestScope = scope();
    const base = await startServer({ clientGrants: clientGrants(requestScope), mspRelayCredential: null });
    const result = await post(base, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "gks_search",
        arguments: { query: "missing", scope: requestScope },
        _meta: { gksMspAuth: { principalId: "msp-runtime", role: "msp", scopeDigest: mspScopeDigest(requestScope) } },
      },
    }, { authorization: `Bearer ${directCredential}` });
    expect(result.response.status).toBe(200);
    expect(result.body.result.structuredContent).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain(directCredential);
  });

  it("denies a direct client outside its scope and blocks governed writes even with forged MSP metadata", async () => {
    const requestScope = scope();
    const base = await startServer({ clientGrants: clientGrants(requestScope), mspRelayCredential: null });
    const outsideScope = await post(base, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "gks_search", arguments: { query: "missing", scope: scope({ tenantId: "other-tenant" }) } },
    }, { authorization: `Bearer ${directCredential}` });
    expect(outsideScope.body.result.structuredContent.code).toBe("gks_scope_denied");

    const forgedWrite = await post(base, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "gks_knowledge_promote",
        arguments: { scope: requestScope },
        _meta: authMeta(requestScope),
      },
    }, { authorization: `Bearer ${directCredential}` });
    expect(forgedWrite.body.result.structuredContent.code).toBe("gks_scope_denied");
  });

  it("rejects unknown direct-client credentials without disclosing client grants", async () => {
    const requestScope = scope();
    const base = await startServer({ clientGrants: clientGrants(requestScope), mspRelayCredential: null });
    const result = await post(base, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "gks_search", arguments: { query: "missing", scope: requestScope } },
    }, { authorization: "Bearer gksc_invalid" });
    expect(result.response.status).toBe(401);
    expect(result.body.result.structuredContent.code).toBe("gks_scope_denied");
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
