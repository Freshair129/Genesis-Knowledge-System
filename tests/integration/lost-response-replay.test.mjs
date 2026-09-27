// @req GKS-NFR-001, GKS-PIP-005, C0.4-LOST-RESPONSE-REPLAY — a response lost
// after the durable commit is recovered by replaying the same request against
// a fresh process: the caller gets the committed result, never a second write,
// and a changed payload under the same key is a conflict, not an overwrite.
//
// The harness kills the server process with SIGKILL once the write is visible
// in SQLite and never reads the first process's stdout, so the first response
// is lost from the caller's point of view whether or not it was flushed.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PIPELINE_SCHEMA_VERSION } from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";
import { RELAY_SECRET, auth, graphReceiptFor, makeBatch } from "../fixtures/genesisrag17.mjs";

const SERVER = path.resolve("apps/gks-server/bin/gks-server.mjs");
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function storePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-lost-response-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return path.join(dir, "gks.sqlite");
}

function startServer(dbPath) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.resolve("."),
    env: { ...process.env, GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri", GKS_PIPELINE_RELAY_CREDENTIAL: RELAY_SECRET },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return { child, exited };
}

function send(child, id, name, args) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
}

function nextResponse(child) {
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  return new Promise((resolve) => lines.once("line", (line) => {
    lines.close();
    resolve(JSON.parse(line));
  }));
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the durable write");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readStore(dbPath, sql, ...params) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).get(...params);
    } finally {
      db.close();
    }
  } catch {
    return undefined; // the store or table does not exist yet
  }
}

function committedPromotion(dbPath, idempotencyKey) {
  return readStore(dbPath, "SELECT knowledge_ref, source_hash, canonical_mappings_json, graph_version FROM promotions WHERE idempotency_key = ?", idempotencyKey);
}

// Send one request to a fresh process, wait until its write is durable, then
// kill the process without ever reading its stdout.
async function commitThenLoseResponse(dbPath, name, args, committed) {
  const server = startServer(dbPath);
  send(server.child, 1, name, args);
  const row = await waitFor(committed);
  server.child.kill("SIGKILL");
  await server.exited;
  return row;
}

async function call(child, id, name, args) {
  const response = nextResponse(child);
  send(child, id, name, args);
  return response;
}

function resultOf(response) {
  expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
  return response.result.structuredContent;
}

describe("lost response after durable commit", () => {
  it("replays gks_knowledge_promote to the committed result and refuses a changed payload", async () => {
    const dbPath = storePath();
    const request = promotion({ idempotency_key: "lost-response-1" });

    const first = startServer(dbPath);
    send(first.child, 1, "gks_knowledge_promote", request);
    const committed = await waitFor(() => committedPromotion(dbPath, "lost-response-1"));
    first.child.kill("SIGKILL");
    await first.exited;

    const second = startServer(dbPath);
    const replayed = nextResponse(second.child);
    send(second.child, 2, "gks_knowledge_promote", request);
    const result = resultOf(await replayed);
    expect(result).toMatchObject({
      knowledge_ref: committed.knowledge_ref,
      source_hash: committed.source_hash,
      graph_version: committed.graph_version,
      idempotent: true,
    });
    expect(result.canonical_mappings).toEqual(JSON.parse(committed.canonical_mappings_json));

    const conflicting = nextResponse(second.child);
    send(second.child, 3, "gks_knowledge_promote", { ...request, source_snapshot_hash: "b".repeat(64) });
    expect((await conflicting).result).toMatchObject({ isError: true, structuredContent: { code: "gks_conflict" } });

    // Exactly one committed write for the key.
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM promotions WHERE idempotency_key = ?").get("lost-response-1").n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("replays gks_pipeline_submit to the committed batch and refuses a changed batch under the same key", async () => {
    const dbPath = storePath();
    const batch = makeBatch({ id: "batch-lost-submit" });
    const submit = { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) };
    const committed = await commitThenLoseResponse(dbPath, "gks_pipeline_submit", submit,
      () => readStore(dbPath, "SELECT batch_id, decision_id, decision_hash FROM pipeline_batches WHERE idempotency_key = ?", batch.idempotencyKey));

    const second = startServer(dbPath);
    const replayed = resultOf(await call(second.child, 2, "gks_pipeline_submit", submit));
    expect(replayed).toMatchObject({ batchId: committed.batch_id, decisionId: committed.decision_id, status: "PENDING", idempotent: true });

    // GKS-ING-008: the same idempotency key with different content is a conflict.
    const changed = makeBatch({ id: "batch-lost-submit", entries: [{ text: "Zed works for Zulu Ltd.", mentions: [["Zed", "zed", "Person"], ["Zulu Ltd.", "zulu", "Organization"]] }] });
    const conflicting = await call(second.child, 3, "gks_pipeline_submit", { ...submit, batch: changed });
    expect(conflicting.result).toMatchObject({ isError: true, structuredContent: { code: "gks_conflict" } });
    expect(readStore(dbPath, "SELECT COUNT(*) AS n FROM pipeline_batches WHERE idempotency_key = ?", batch.idempotencyKey).n).toBe(1);
  });

  it("replays a lost Tier-4 graph receipt without a second Stage 13/14 terminal", async () => {
    const dbPath = storePath();
    const batch = makeBatch({ id: "batch-lost-graph" });
    const worker = auth(batch.scope, "worker");
    const setup = startServer(dbPath);
    resultOf(await call(setup.child, 1, "gks_pipeline_submit", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) }));
    const { decisions } = resultOf(await call(setup.child, 2, "gks_pipeline_claim", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...worker }));
    const decision = decisions.find((candidate) => candidate.batchId === batch.batchId);
    setup.child.kill("SIGKILL");
    await setup.exited;

    const receipt = graphReceiptFor(decision);
    const committed = await commitThenLoseResponse(dbPath, "gks_pipeline_graph_receipt", { receipt, ...worker },
      () => readStore(dbPath, "SELECT graph_receipt_hash, derived_hash FROM pipeline_graph_receipts WHERE decision_id = ?", decision.decisionId));

    const second = startServer(dbPath);
    const replayed = resultOf(await call(second.child, 3, "gks_pipeline_graph_receipt", { receipt, ...worker }));
    expect(replayed).toMatchObject({ accepted: true, idempotent: true, graphReceiptHash: committed.graph_receipt_hash, derivedHash: committed.derived_hash });
    const terminals = readStore(dbPath, "SELECT COUNT(*) AS n FROM pipeline_evidence WHERE run_id = ? AND stage_number IN (13, 14)", batch.runId);
    expect(terminals.n).toBe(2);
  });
});