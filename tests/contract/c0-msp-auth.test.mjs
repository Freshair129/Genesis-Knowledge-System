import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import readline from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { GKS_MSP_AUTH_VERSION, mspScopeDigest } from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";
import { runStdioServer } from "../../apps/gks-server/src/server.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-c0-msp-auth-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const server = runStdioServer({
    env: {
      GKS_DB_PATH: path.join(dir, "gks.sqlite"),
      GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri",
      GKS_MSP_AUTH_REQUIRED: "1",
      GKS_MSP_RELAY_CREDENTIAL: "c0-relay-secret",
    },
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
    nextResponse() { return new Promise((resolve) => waiting.push(resolve)); },
    send(request) { input.write(`${JSON.stringify(request)}\n`); },
  };
}

const defaultScope = {
  portfolioId: "portfolio-zuri",
  tenantId: "",
  businessId: "",
  workspaceId: "",
  projectId: "",
  sharing: "private",
};

function authMeta(scope = defaultScope, relayCredential = "c0-relay-secret") {
  return {
    gksMspAuth: {
      version: GKS_MSP_AUTH_VERSION,
      principalId: "msp-runtime",
      role: "msp",
      relayCredential,
      scopeDigest: mspScopeDigest(scope),
    },
  };
}

function promoteArgs(idempotencyKey) {
  const { scope: _scope, ...legacy } = promotion({ idempotency_key: idempotencyKey });
  return legacy;
}

describe("C0 MSP transport authentication", () => {
  it("accepts the approved envelope without changing the API-010 inner payload", async () => {
    const server = startServer();
    const response = server.nextResponse();
    server.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gks_knowledge_promote", arguments: promoteArgs("c0-auth-accept"), _meta: authMeta() } });

    const result = await response;
    expect(result.result.structuredContent).toMatchObject({
      knowledge_ref: expect.stringMatching(/^gks:knowledge\//),
      source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotent: false,
    });
    expect(JSON.stringify(result)).not.toContain("c0-relay-secret");
  });

  it("denies missing, forged, and scope-mismatched auth before persistence", async () => {
    const server = startServer();
    const cases = [
      { id: 2, params: { name: "gks_knowledge_promote", arguments: promoteArgs("c0-auth-missing") } },
      { id: 3, params: { name: "gks_knowledge_promote", arguments: promoteArgs("c0-auth-forged"), _meta: authMeta(defaultScope, "wrong-secret") } },
      { id: 4, params: { name: "gks_knowledge_promote", arguments: promoteArgs("c0-auth-scope"), _meta: authMeta({ ...defaultScope, tenantId: "tenant-a" }) } },
      { id: 5, params: { name: "gks_knowledge_promote", arguments: promoteArgs("c0-auth-principal"), _meta: { gksMspAuth: { ...authMeta().gksMspAuth, principalId: "forged-runtime" } } } },
    ];
    for (const request of cases) {
      const response = server.nextResponse();
      server.send({ jsonrpc: "2.0", method: "tools/call", ...request });
      const result = await response;
      expect(result.result).toMatchObject({ isError: true, structuredContent: { code: "gks_scope_denied" } });
    }
  });

  it("keeps initialize and health available for liveness without exposing knowledge", async () => {
    const server = startServer();
    const initialize = server.nextResponse();
    server.send({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
    await expect(initialize).resolves.toMatchObject({ id: 5, result: { serverInfo: { name: "gks-server" } } });

    const health = server.nextResponse();
    server.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gks_health", arguments: {} } });
    await expect(health).resolves.toMatchObject({ id: 6, result: { structuredContent: { service: "gks", state: "ready" } } });
  });

  it("requires the envelope for every protected legacy tool", async () => {
    const server = startServer();
    for (const [index, name] of [
      "gks_knowledge_promote",
      "gks_search",
      "gks_entity_get",
      "gks_relations_get",
      "gks_artifact_link",
      "gks_review_list",
      "gks_review_apply",
      "gks_stage_evidence_export",
    ].entries()) {
      const response = server.nextResponse();
      server.send({ jsonrpc: "2.0", id: index + 10, method: "tools/call", params: { name, arguments: {} } });
      await expect(response).resolves.toMatchObject({ result: { isError: true, structuredContent: { code: "gks_scope_denied" } } });
    }
  });
});
