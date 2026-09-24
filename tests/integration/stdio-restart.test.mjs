import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { buildGksChildEnv, GksStdioClient } from "@freshair129/gks-client-js";
import { PIPELINE_SCHEMA_VERSION, PIPELINE_STAGE_CATALOG, sha256Text } from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";

const PIPELINE_RELAY_CREDENTIAL = "c0-lost-response-relay";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function isolatedGksEnv(dbPath) {
  const env = buildGksChildEnv(process.env);
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GKS_")) delete env[name];
  }
  env.GKS_DB_PATH = dbPath;
  env.GKS_DEFAULT_PORTFOLIO_ID = "portfolio-zuri";
  env.GKS_PIPELINE_RELAY_CREDENTIAL = PIPELINE_RELAY_CREDENTIAL;
  return env;
}

function pipelineSubmission() {
  const batchId = "c0-lost-response";
  const runId = `${batchId}-run`;
  const scope = {
    portfolioId: "c0-portfolio",
    tenantId: "c0-tenant",
    businessId: "c0-business",
    workspaceId: "",
    agentId: "c0-agent",
    visibility: "private",
  };
  const text = "Alice works for Acme Ltd.";
  const chunkId = `${batchId}-chunk-1`;
  const parsedArtifactId = `${batchId}-parsed`;
  const batch = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    batchId,
    idempotencyKey: `${batchId}-idempotency`,
    scope,
    runId,
    stages: PIPELINE_STAGE_CATALOG.map((stage) => ({
      ...stage,
      runId,
      executionStepId: `${batchId}-step-${stage.stageNumber}`,
      attemptId: `${batchId}-attempt-${stage.stageNumber}`,
    })),
    source: {
      sourceId: `${batchId}-source`,
      rawArtifactId: `${batchId}-raw`,
      parsedArtifactId,
      documentId: `${batchId}-document`,
      version: "1",
      contentHash: sha256Text(text),
      content: text,
    },
    policy: { allowEmbedding: true, allowPublication: true },
    chunks: [{ chunkId, parsedArtifactId, ordinal: 0, text, contentHash: sha256Text(text), startOffset: 0, endOffset: text.length }],
    mentions: [
      { sourceMentionId: `${batchId}-mention-alice`, resolutionKey: "alice", semanticType: "Person", name: "Alice", chunkId, startOffset: 0, endOffset: 5 },
      { sourceMentionId: `${batchId}-mention-acme`, resolutionKey: "acme", semanticType: "Organization", name: "Acme Ltd.", chunkId, startOffset: text.indexOf("Acme Ltd."), endOffset: text.length },
    ],
  };
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope,
    batch,
    relayCredential: PIPELINE_RELAY_CREDENTIAL,
    authenticatedPrincipal: { principalId: `${batchId}-source`, role: "source", scope },
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timeout));
}

describe("standalone stdio integration", () => {
  it("server_restart_preservesPromotionAndApi010Compatibility", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-stdio-"));
    const dbPath = path.join(dir, "gks.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new GksStdioClient({
      command: process.execPath,
      args: [path.resolve("apps/gks-server/bin/gks-server.mjs")],
      cwd: path.resolve("."),
      env: { ...process.env, GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri" },
    });
    const exactApi010Request = promotion();
    delete exactApi010Request.scope;

    const first = await client.promoteCandidate(exactApi010Request);
    const afterRestart = await client.promoteCandidate(exactApi010Request);

    expect(first).toMatchObject({ knowledge_ref: expect.stringMatching(/^gks:knowledge\//), source_hash: exactApi010Request.source_snapshot_hash, idempotent: false });
    expect(afterRestart).toEqual({ ...first, idempotent: true });
  });

  it("process_loss_after_commit_replaysPipelineSubmit_withoutDuplicateWrites", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-lost-response-"));
    const dbPath = path.join(dir, "gks.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = isolatedGksEnv(dbPath);
    const request = pipelineSubmission();
    const crashHarness = path.resolve("tests/fixtures/c0-qualification/lose-response-child.mjs");
    const crashed = spawn(process.execPath, [crashHarness], {
      cwd: path.resolve("."),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stderr = "";
    crashed.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const stdout = createInterface({ input: crashed.stdout });
    const responses = [];
    stdout.on("line", (line) => responses.push(JSON.parse(line)));

    try {
      const initialized = withTimeout(once(stdout, "line").then(([line]) => JSON.parse(line)), 10_000, "Timed out waiting for GKS initialize response.");
      crashed.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c0-lost-response-test", version: "1.0.0" } } })}\n`);
      expect(await initialized).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });

      const exited = withTimeout(once(crashed, "close"), 10_000, "Timed out waiting for the simulated lost-response process to exit.");
      crashed.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      crashed.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gks_pipeline_submit", arguments: request } })}\n`);
      const [code, signal] = await exited;
      const exit = { code, signal };
      if (exit.code !== 73) throw new Error(`Expected a committed pipeline result before the simulated response loss; child=${JSON.stringify(exit)} stderr=${stderr}`);
      expect(exit.signal).toBeNull();
      expect(responses.map((message) => message.id)).toEqual([1]);
    } finally {
      stdout.close();
      if (crashed.exitCode === null) crashed.kill();
    }

    const lostResponseLine = stderr.split(/\r?\n/).find((line) => line.startsWith("C0_LOST_RESPONSE_RESULT="));
    expect(lostResponseLine).toBeDefined();
    const lostResult = JSON.parse(lostResponseLine.slice("C0_LOST_RESPONSE_RESULT=".length));
    expect(lostResult).toMatchObject({ batchId: request.batch.batchId, status: "PENDING", idempotent: false });

    const beforeDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    let beforeBatch;
    let beforeEvidenceRows;
    try {
      beforeBatch = beforeDb.prepare("SELECT batch_id, idempotency_key, decision_id, decision_hash, decision_json FROM pipeline_batches WHERE idempotency_key = ?").get(request.batch.idempotencyKey);
      beforeEvidenceRows = beforeDb.prepare("SELECT cursor, stage_number, run_id FROM pipeline_evidence WHERE run_id = ? ORDER BY cursor").all(request.batch.runId);
    } finally {
      beforeDb.close();
    }
    expect(beforeBatch).toMatchObject({ batch_id: request.batch.batchId, decision_id: lostResult.decisionId });
    expect(beforeEvidenceRows.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);

    const client = new GksStdioClient({
      command: process.execPath,
      args: [path.resolve("apps/gks-server/bin/gks-server.mjs")],
      cwd: path.resolve("."),
      env,
    });
    const replay = await client.call("gks_pipeline_submit", request);
    const evidenceRequest = {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      scope: request.scope,
      runId: request.batch.runId,
      relayCredential: PIPELINE_RELAY_CREDENTIAL,
      authenticatedPrincipal: request.authenticatedPrincipal,
    };
    const evidence = await client.call("gks_pipeline_evidence", evidenceRequest);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const batches = db.prepare("SELECT batch_id, idempotency_key, decision_id, decision_hash, decision_json FROM pipeline_batches WHERE idempotency_key = ?").all(request.batch.idempotencyKey);
      const batchCount = db.prepare("SELECT COUNT(*) AS count FROM pipeline_batches").get().count;
      const evidenceRows = db.prepare("SELECT cursor, stage_number, run_id FROM pipeline_evidence WHERE run_id = ? ORDER BY cursor").all(request.batch.runId);
      expect(batches).toHaveLength(1);
      expect(batchCount).toBe(1);
      expect(batches[0]).toEqual(beforeBatch);
      expect(JSON.parse(batches[0].decision_json).decisionHash).toBe(batches[0].decision_hash);
      expect(replay).toEqual({ ...lostResult, idempotent: true });
      expect(replay.decisionId).toBe(batches[0].decision_id);
      expect(evidenceRows).toEqual(beforeEvidenceRows);
      expect(evidenceRows.map((row) => row.stage_number)).toEqual([9, 10, 11, 12]);
      expect(evidenceRows.every((row) => row.run_id === request.batch.runId)).toBe(true);
      expect(evidence.rows.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);
      expect(evidence.rows.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12]);
      expect(evidence.nextCursor).toBe(4);
    } finally {
      db.close();
    }
  });
});
