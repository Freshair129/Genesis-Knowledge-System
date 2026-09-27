// C0 acceptance obligations from the SRS blueprint that the gap analysis found
// implemented but unproven. Each case names the requirement it closes; none of
// them changes behaviour -- they pin what C0 already does.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { createJsonRpcToolErrorResponse } from "../../apps/gks-server/src/server.mjs";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { PIPELINE_MODEL, PIPELINE_SCHEMA_VERSION, sha256Text } from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";
import { RELAY_SECRET, auth, graphReceiptFor, makeBatch, receiptFor, scope, submitAndClaim } from "../fixtures/genesisrag17.mjs";

const cleanups = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()();
});

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "gks-c0-acceptance-"));
  const dbPath = path.join(directory, "gks.sqlite");
  const persistence = openSqlitePersistence({ dbPath });
  const service = createGksService({ persistence, pipelineRelayCredential: RELAY_SECRET });
  cleanups.push(() => {
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, persistence, dbPath };
}

function rawRow(dbPath, sql, ...params) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

const submitArgs = (batch, envelopeScope = batch.scope) => ({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(envelopeScope) });

describe("C0 scope and intake acceptance", () => {
  // GKS-SCP-002: every one of the six pipeline scope fields is exact, and a
  // mismatch is denied before any persistence read or write.
  it.each(["portfolioId", "tenantId", "businessId", "workspaceId", "agentId", "visibility"])("denies a principal whose %s differs, before persistence", async (field) => {
    const { service, persistence } = harness();
    const batch = makeBatch({ id: `batch-scope-${field}` });
    const reads = vi.spyOn(persistence, "lookupResolutionCandidates");
    const writes = vi.spyOn(persistence, "transactPipelineSubmit");
    const foreign = { ...batch.scope, [field]: `other-${field}` };
    // visibility has one legal value (private), so any other value is invalid
    // input rather than a foreign scope -- refused just as early.
    const expected = field === "visibility" ? "gks_invalid_request" : "gks_scope_denied";
    await expect(service.pipelineSubmit(submitArgs(batch, foreign))).rejects.toMatchObject({ code: expected });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  // GKS-ING-001: the stored source envelope is GKS's normalized copy, so a
  // caller mutating its own object after submit changes nothing stored.
  it("stores an immutable copy of the source envelope", async () => {
    const { service, dbPath } = harness();
    const batch = makeBatch({ id: "batch-immutable-source" });
    const expected = JSON.stringify(batch.source);
    await service.pipelineSubmit(submitArgs(batch));
    batch.source.content = "tampered after submit";
    batch.chunks[0].text = "tampered";
    const stored = JSON.parse(rawRow(dbPath, "SELECT batch_json FROM pipeline_batches WHERE batch_id = ?", batch.batchId).batch_json);
    expect(JSON.stringify(stored.source)).toBe(expected);
  });

  // GKS-ING-002: three occurrences of one mention are three rows, not one.
  it("retains every occurrence of a repeated mention", async () => {
    const { service, dbPath } = harness();
    const batch = makeBatch({
      id: "batch-three-occurrences",
      entries: [
        { text: "Alice works for Acme Ltd.", mentions: [["Alice", "alice", "Person"], ["Acme Ltd.", "acme", "Organization"]] },
        { text: "Alice purchased Atlas.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
        { text: "Alice purchased Nimbus.", mentions: [["Alice", "alice", "Person"], ["Nimbus", "nimbus", "Product"]] },
      ],
    });
    const { decision } = await submitAndClaim(service, batch);
    const alice = decision.entities.find((entity) => entity.metadata.resolutionKey === "alice");
    expect(alice.mentions).toHaveLength(3);
    expect(rawRow(dbPath, "SELECT COUNT(*) AS n FROM pipeline_mentions WHERE batch_id = ? AND resolution_key = 'alice'", batch.batchId).n).toBe(3);
  });

  // GKS-ING-005 / GKS-SYS-003: source identifiers that look like URLs or
  // paths are opaque labels. A full submit-to-publication run opens no socket
  // and calls no fetch.
  it("never fetches content or opens a connection, even for URL-shaped source ids", async () => {
    const { service } = harness();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("GKS must not fetch"); });
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw new Error("GKS must not connect"); });
    const batch = makeBatch({ id: "batch-opaque-source" });
    batch.source = { ...batch.source, sourceId: "https://attacker.example/secret", rawArtifactId: "file:///etc/passwd", documentId: "\\\\host\\share\\doc" };
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const receipt = receiptFor(decision, graphResult, graphReceipt);
    const written = await service.pipelineWriteReceipt({ receipt, ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate.verdict.verdict).toBe("PASS");
    await service.pipelinePublicationReceipt({ receipt: { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash, snapshotId: receipt.snapshotId, generation: receipt.generation, receiptHash: written.receiptHash, publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "c".repeat(64), modelRevision: PIPELINE_MODEL.revision, transactionFrontier: receipt.transaction.frontier, readback: { ok: true } }, ...worker });
    await service.promoteCandidate(promotion({ scope: { portfolioId: "portfolio-zuri", tenantId: "tenant-a", businessId: "", workspaceId: "", projectId: "", sharing: "private" } }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  // GKS-ING-004: the hash covers the exact content; a whitespace-only or
  // line-ending change is a different source, never normalized away.
  it("rejects content whose hash was taken before a whitespace or line-ending change", async () => {
    const { service } = harness();
    for (const [label, mutate] of [["trailing space", (text) => `${text} `], ["CRLF", (text) => text.replace(/\n/g, "\r\n")]]) {
      const batch = makeBatch({ id: `batch-hash-${label.replace(/\s/g, "-")}` });
      const content = mutate(batch.source.content);
      expect(sha256Text(content)).not.toBe(batch.source.contentHash);
      await expect(service.pipelineSubmit(submitArgs({ ...batch, source: { ...batch.source, content } }))).rejects.toMatchObject({ code: "gks_invalid_request" });
    }
  });
});

describe("C0 identity and pipeline acceptance", () => {
  // GKS-IDN-004: one resolution key under two semantic types is two entities.
  it("keeps Person and Organization with the same resolution key apart", async () => {
    const { service } = harness();
    const { decision } = await submitAndClaim(service, makeBatch({
      id: "batch-person-organization",
      entries: [{ text: "Jordan works for Jordan.", mentions: [["Jordan", "jordan", "Person"], ["Jordan", "jordan", "Organization"]] }],
    }));
    const jordans = decision.entities.filter((entity) => entity.metadata.resolutionKey === "jordan");
    expect(jordans.map((entity) => entity.semanticType).sort()).toEqual(["Organization", "Person"]);
    expect(new Set(jordans.map((entity) => entity.id)).size).toBe(2);
  });

  // GKS-PIP-001: exactly the nine stage identities, each once, each under its
  // own DPS-KI id.
  it.each([
    ["a duplicated stage", (stages) => [...stages.slice(0, 8), stages[0]]],
    ["a missing stage", (stages) => stages.slice(0, 8)],
    ["a stage under the wrong DPS-KI id", (stages) => stages.map((stage, index) => (index === 0 ? { ...stage, pipelineStageId: stages[1].pipelineStageId } : stage))],
    ["stages out of catalog order", (stages) => [stages[0], stages[2], stages[1], ...stages.slice(3)]],
    ["stages in reverse order", (stages) => [...stages].reverse()],
  ])("rejects %s", async (_label, mutate) => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-stage-identities" });
    await expect(service.pipelineSubmit(submitArgs({ ...batch, stages: mutate(batch.stages) }))).rejects.toMatchObject({ code: "gks_invalid_request" });
  });

  it("names the first stage that breaks catalog order", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-stage-order" });
    const swapped = [batch.stages[0], batch.stages[2], batch.stages[1], ...batch.stages.slice(3)];
    await expect(service.pipelineSubmit(submitArgs({ ...batch, stages: swapped }))).rejects.toMatchObject({
      code: "gks_invalid_request",
      message: "stages[1] must be stage 10: stages are listed in catalog order, 9 through 17.",
    });
  });

  // Receipts are matched to the stored decision without regard to order: a
  // decision stored before the order rule keeps its submitted order, and the
  // worker echoes whatever the decision carries.
  it("still accepts a graph receipt whose stage identities are listed out of order", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-receipt-stage-order" });
    const { decision } = await submitAndClaim(service, batch);
    const receipt = graphReceiptFor(decision);
    const result = await service.pipelineGraphReceipt({ receipt: { ...receipt, stages: [...receipt.stages].reverse() }, ...auth(batch.scope, "worker") });
    expect(result).toMatchObject({ accepted: true, idempotent: false });
  });

  // GKS-PIP-003: claim is non-destructive -- two workers can see one decision,
  // and the second worker's identical receipt is an idempotent replay while a
  // different one is a conflict.
  it("lets two workers claim one decision without a second graph terminal", async () => {
    const { service, dbPath } = harness();
    const batch = makeBatch({ id: "batch-two-workers" });
    await service.pipelineSubmit(submitArgs(batch));
    const claim = (principalId) => service.pipelineClaim({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, relayCredential: RELAY_SECRET, authenticatedPrincipal: { principalId, role: "worker", scope: batch.scope } });
    const first = (await claim("worker-a")).decisions.find((item) => item.batchId === batch.batchId);
    const second = (await claim("worker-b")).decisions.find((item) => item.batchId === batch.batchId);
    expect(second.decisionHash).toBe(first.decisionHash);

    const worker = auth(batch.scope, "worker");
    const receipt = graphReceiptFor(first);
    const accepted = await service.pipelineGraphReceipt({ receipt, ...worker });
    expect(await service.pipelineGraphReceipt({ receipt: graphReceiptFor(second), ...worker })).toMatchObject({ idempotent: true, graphReceiptHash: accepted.graphReceiptHash });
    await expect(service.pipelineGraphReceipt({ receipt: { ...receipt, transaction: { ...receipt.transaction, id: "worker-b-tx" } }, ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
    expect(rawRow(dbPath, "SELECT COUNT(*) AS n FROM pipeline_evidence WHERE run_id = ? AND stage_number = 13", batch.runId).n).toBe(1);
  });

  // GKS-PIP-008: the legacy stage-evidence ledger and the GenesisRAG17
  // evidence ledger keep separate cursors; writing one never moves the other.
  it("keeps the legacy and GenesisRAG17 evidence cursors independent", async () => {
    const { service } = harness();
    const legacyScope = { portfolioId: "portfolio-zuri", tenantId: "tenant-a", businessId: "", workspaceId: "", projectId: "", sharing: "private" };
    const legacyCursor = async () => (await service.exportStageEvidence({ scope: legacyScope, since_cursor: 0, limit: 500 })).next_cursor;

    await service.promoteCandidate(promotion({ idempotency_key: "ledger-1", scope: legacyScope }));
    const legacyAfterPromote = await legacyCursor();
    expect(legacyAfterPromote).toBeGreaterThan(0);

    const batch = makeBatch({ id: "batch-ledger-separation" });
    await service.pipelineSubmit(submitArgs(batch));
    expect(await legacyCursor()).toBe(legacyAfterPromote);
    const pipelineRows = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(pipelineRows.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);

    await service.promoteCandidate(promotion({ idempotency_key: "ledger-2", source_snapshot_hash: "c".repeat(64), scope: legacyScope }));
    const pipelineAfter = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(pipelineAfter.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);
  });
});

describe("C0 persistence concurrency and error discipline", () => {
  // GKS-IDN-005 / GKS-STO-001, deterministic: another process holds the write
  // lock and commits while GKS waits. A DEFERRED transaction would read first,
  // find its snapshot stale after that commit, and fail with SQLITE_BUSY; an
  // IMMEDIATE one queues behind the lock under busy_timeout and succeeds.
  it("queues a write behind another process's lock instead of failing SQLITE_BUSY", async () => {
    const { service, dbPath } = harness();
    await service.promoteCandidate(promotion({ idempotency_key: "lock-warmup" }));
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma("busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE graph_state SET version = version + 1 WHERE singleton = 1").run();
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 1000);
    `], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    cleanups.push(() => { if (holder.exitCode === null) holder.kill(); });
    await new Promise((resolve) => readline.createInterface({ input: holder.stdout }).once("line", resolve));

    const startedMs = Date.now();
    const result = await service.promoteCandidate(promotion({ idempotency_key: "lock-queued", source_snapshot_hash: "d".repeat(64) }));
    const waitedMs = Date.now() - startedMs;
    expect(result).toMatchObject({ idempotent: false, knowledge_ref: expect.stringMatching(/^gks:knowledge\//) });
    // The promote must have queued behind the held lock. If a slow runner let
    // it start after the holder's commit, this fails loudly instead of passing
    // without having tested anything.
    expect(waitedMs).toBeGreaterThanOrEqual(200);
    expect(await exited).toBe(0);
  });

  // GKS-API-005: a driver or runtime error code never becomes a public code.
  it("maps non-GKS error codes to gks_backend_unavailable on the wire", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(createJsonRpcToolErrorResponse(1, busy).result.structuredContent).toEqual({ code: "gks_backend_unavailable", message: "database is locked" });
    const scopeDenied = Object.assign(new Error("denied"), { code: "gks_scope_denied" });
    expect(createJsonRpcToolErrorResponse(2, scopeDenied).result.structuredContent.code).toBe("gks_scope_denied");
    expect(createJsonRpcToolErrorResponse(3, new TypeError("boom")).result.structuredContent.code).toBe("gks_backend_unavailable");
  });
});