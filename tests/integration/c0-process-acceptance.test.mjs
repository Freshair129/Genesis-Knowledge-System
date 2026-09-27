// C0 acceptance obligations that only a real server process can prove:
// JSON-RPC correlation under concurrency (GKS-API-002), secrets never reaching
// storage or process output (GKS-SEC-002), and atomic identity creation across
// concurrent writer processes (GKS-IDN-005).
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { GKS_MSP_AUTH_VERSION, PIPELINE_SCHEMA_VERSION, mspScopeDigest } from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";
import { makeBatch } from "../fixtures/genesisrag17.mjs";

const SERVER = path.resolve("apps/gks-server/bin/gks-server.mjs");
// Tests that start several server processes at once: spawning and migrating
// them alone can exceed vitest's 5 s default on a shared CI runner.
const MULTI_PROCESS_TIMEOUT_MS = 30_000;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function storeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-c0-process-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { cwd: path.resolve("."), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let stdout = "";
  let stderr = "";
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    stdout += `${line}\n`;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const stop = async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  cleanups.push(stop);
  return {
    call(id, name, args, meta) {
      const response = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })}\n`);
      return response;
    },
    output: () => ({ stdout, stderr }),
    stop,
  };
}

describe("C0 process acceptance", () => {
  // GKS-API-002: requests written back-to-back are answered with their own
  // ids, whatever order the responses come back in.
  it("correlates interleaved requests by JSON-RPC id", async () => {
    const dir = storeDir();
    const server = startServer({ GKS_DB_PATH: path.join(dir, "gks.sqlite"), GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri" });
    const ids = ["alpha", 7, "gamma", 9, "epsilon"];
    const responses = await Promise.all(ids.map((id, index) => (index % 2 === 0
      ? server.call(id, "gks_health", {})
      : server.call(id, "gks_knowledge_promote", promotion({ idempotency_key: `interleaved-${id}`, source_snapshot_hash: String(id).padStart(64, "0") })))));
    expect(responses.map((response) => response.id)).toEqual(ids);
    for (const [index, response] of responses.entries()) {
      expect(response.jsonrpc).toBe("2.0");
      if (index % 2 === 0) expect(response.result.structuredContent).toMatchObject({ state: "ready" });
      else expect(response.result.structuredContent).toMatchObject({ knowledge_ref: expect.stringMatching(/^gks:knowledge\//), idempotent: false });
    }
  });

  // GKS-SEC-002: relay secrets reach neither the SQLite files nor stdout or
  // stderr, across successful calls, denials and a restart.
  it("keeps canary secrets out of storage and process output", async () => {
    const dir = storeDir();
    const dbPath = path.join(dir, "gks.sqlite");
    const mspSecret = `canary-msp-${randomBytes(12).toString("hex")}`;
    const pipelineSecret = `canary-pipeline-${randomBytes(12).toString("hex")}`;
    const env = { GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri", GKS_MSP_AUTH_REQUIRED: "1", GKS_MSP_RELAY_CREDENTIAL: mspSecret, GKS_PIPELINE_RELAY_CREDENTIAL: pipelineSecret };
    const legacyScope = { portfolioId: "portfolio-zuri", tenantId: "", businessId: "", workspaceId: "", projectId: "", sharing: "private" };
    const meta = (relayCredential) => ({ gksMspAuth: { version: GKS_MSP_AUTH_VERSION, principalId: "msp-runtime", role: "msp", relayCredential, scopeDigest: mspScopeDigest(legacyScope) } });
    const { scope: _scope, ...legacyPromotion } = promotion({ idempotency_key: "canary-1" });
    const batch = makeBatch({ id: "batch-canary" });
    const pipelineArgs = (relayCredential) => ({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, relayCredential, authenticatedPrincipal: { principalId: "source-principal", role: "source", scope: batch.scope } });

    const outputs = [];
    for (const round of [1, 2]) {
      const server = startServer(env);
      const ok = await server.call(1, "gks_knowledge_promote", legacyPromotion, meta(mspSecret));
      expect(ok.result.isError).toBeUndefined();
      const denied = await server.call(2, "gks_knowledge_promote", legacyPromotion, meta(`${mspSecret}-wrong`));
      expect(denied.result).toMatchObject({ isError: true, structuredContent: { code: "gks_scope_denied" } });
      const submitted = await server.call(3, "gks_pipeline_submit", pipelineArgs(pipelineSecret));
      expect(submitted.result.structuredContent).toMatchObject({ idempotent: round === 2 });
      const pipelineDenied = await server.call(4, "gks_pipeline_submit", pipelineArgs(`${pipelineSecret}-wrong`));
      expect(pipelineDenied.result).toMatchObject({ isError: true, structuredContent: { code: "gks_scope_denied" } });
      await server.stop();
      outputs.push(server.output());
    }

    const surfaces = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).map((file) => readFileSync(file).toString("latin1"));
    for (const { stdout, stderr } of outputs) surfaces.push(stdout, stderr);
    for (const secret of [mspSecret, pipelineSecret]) {
      for (const surface of surfaces) expect(surface.includes(secret)).toBe(false);
    }
  });

  // GKS-IDN-005: concurrent writer processes promoting one entity under
  // different idempotency keys converge on one canonical row.
  it("creates one canonical entity when concurrent processes race on the same identity", async () => {
    const dir = storeDir();
    const dbPath = path.join(dir, "gks.sqlite");
    const env = { GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri" };
    // Migrate once so the racing processes contend on writes, not on schema.
    await startServer(env).stop();
    // Six processes, each pipelining four promotes of the same entity under
    // distinct keys: enough overlap that a DEFERRED read-then-write
    // transaction reliably meets another process's commit.
    const PROCESSES = 6;
    const PER_PROCESS = 4;
    const servers = Array.from({ length: PROCESSES }, () => startServer(env));
    const candidate = { entities: [{ candidateRef: "Racing Corp", type: "ENTITY", title: "Racing Corp" }], relations: [] };
    const responses = await Promise.all(servers.flatMap((server, processIndex) => Array.from({ length: PER_PROCESS }, (_, requestIndex) => {
      const key = processIndex * PER_PROCESS + requestIndex;
      return server.call(requestIndex + 1, "gks_knowledge_promote", promotion({
        idempotency_key: `race-${key}`,
        source_snapshot_hash: String(key + 1).padStart(64, "0"),
        candidate,
      }));
    })));
    const refs = responses.map((response) => {
      expect(response.result.isError, JSON.stringify(response)).toBeUndefined();
      return response.result.structuredContent.canonical_mappings[0].canonicalRef;
    });
    expect(new Set(refs).size).toBe(1);
    for (const server of servers) await server.stop();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE candidate_ref = 'Racing Corp'").get().n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM promotions WHERE idempotency_key LIKE 'race-%'").get().n).toBe(PROCESSES * PER_PROCESS);
    } finally {
      db.close();
    }
  }, MULTI_PROCESS_TIMEOUT_MS);

  // Migration re-check under the write lock: processes opening a fresh store
  // together each see "not applied", but only one applies each migration.
  it("applies each migration once when several processes open a fresh store together", async () => {
    const dir = storeDir();
    const dbPath = path.join(dir, "gks.sqlite");
    const env = { GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri" };
    const servers = Array.from({ length: 5 }, () => startServer(env));
    const health = await Promise.all(servers.map((server) => server.call(1, "gks_health", {})));
    for (const response of health) expect(response.result.structuredContent, JSON.stringify(response)).toMatchObject({ state: "ready" });
    for (const server of servers) await server.stop();
    const shipped = readdirSync(path.resolve("migrations")).filter((name) => name.endsWith(".sql"));
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row) => row.name)).toEqual([...shipped].sort());
    } finally {
      db.close();
    }
  }, MULTI_PROCESS_TIMEOUT_MS);
});