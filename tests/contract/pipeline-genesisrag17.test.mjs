import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import {
  PIPELINE_MODEL,
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_STAGE_CATALOG,
  canonicalJsonString,
  pipelineScopeKey,
  sha256Text,
} from "@freshair129/gks-contracts";
import { pipelineReadbackExpectations } from "@freshair129/gks-core";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

const scope = (overrides = {}) => ({
  portfolioId: "portfolio-ki17",
  tenantId: "tenant-ki17",
  businessId: "business-ki17",
  workspaceId: "",
  agentId: "agent-ki17",
  visibility: "private",
  ...overrides,
});

const defaultEntries = [
  { text: "Alice works for Acme Ltd.", mentions: [["Alice", "alice", "Person"], ["Acme Ltd.", "acme", "Organization"]] },
  { text: "Alice purchased Atlas.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
  { text: "Bob works for Beacon Ltd.", mentions: [["Bob", "bob", "Person"], ["Beacon Ltd.", "beacon", "Organization"]] },
  { text: "Bob purchased Nimbus.", mentions: [["Bob", "bob", "Person"], ["Nimbus", "nimbus", "Product"]] },
  { text: "Carol works for Cedar Ltd.", mentions: [["Carol", "carol", "Person"], ["Cedar Ltd.", "cedar", "Organization"]] },
];

function makeBatch({ id = "batch-ki17-1", entries = defaultEntries, scope: batchScope = scope(), policy = { allowEmbedding: true, allowPublication: true } } = {}) {
  const content = entries.map((entry) => entry.text).join("\n");
  let sourceOffset = 0;
  const chunks = [];
  const mentions = [];
  for (const [ordinal, entry] of entries.entries()) {
    const chunkId = `${id}-chunk-${ordinal + 1}`;
    chunks.push({
      chunkId,
      parsedArtifactId: `${id}-parsed`,
      ordinal,
      text: entry.text,
      contentHash: sha256Text(entry.text),
      startOffset: sourceOffset,
      endOffset: sourceOffset + entry.text.length,
    });
    for (const [mentionIndex, [name, resolutionKey, semanticType]] of entry.mentions.entries()) {
      const startOffset = entry.text.indexOf(name);
      mentions.push({
        sourceMentionId: `${id}-mention-${ordinal + 1}-${mentionIndex + 1}`,
        resolutionKey,
        semanticType,
        name,
        chunkId,
        startOffset,
        endOffset: startOffset + name.length,
      });
    }
    sourceOffset += entry.text.length + 1;
  }
  const runId = `${id}-run`;
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    batchId: id,
    idempotencyKey: `${id}-idempotency`,
    scope: batchScope,
    runId,
    stages: PIPELINE_STAGE_CATALOG.map((stage) => ({ ...stage, runId, executionStepId: `${id}-step-${stage.stageNumber}`, attemptId: `${id}-attempt-${stage.stageNumber}` })),
    source: { sourceId: `${id}-source`, rawArtifactId: `${id}-raw`, parsedArtifactId: `${id}-parsed`, documentId: `${id}-document`, version: "1", contentHash: sha256Text(content), content },
    policy,
    chunks,
    mentions,
  };
}

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "gks-genesisrag17-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(directory, "gks.sqlite") });
  const service = createGksService({ persistence, pipelineRelayCredential: "relay-ki17-secret" });
  cleanups.push(() => {
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, persistence, directory };
}

const auth = (requestScope, role = "source") => ({
  relayCredential: "relay-ki17-secret",
  authenticatedPrincipal: { principalId: `${role}-principal`, role, scope: requestScope },
});

function metric(overrides = {}) {
  return { records_in: 1, records_out: 1, records_quarantined: 0, error_count: 0, retry_count: 0, duration_ms: 1, ...overrides };
}

function graphReceiptFor(decision) {
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope: decision.scope,
    runId: decision.runId,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
    stages: decision.stages,
    transaction: { id: `${decision.batchId}-graph-tx`, frontier: `${decision.batchId}-graph-frontier`, checkpoint: `${decision.batchId}-graph-checkpoint` },
    readback: { ok: true, nodeCount: decision.expectedGraphReadback.nodeCount, edgeCount: decision.expectedGraphReadback.edgeCount },
    metrics: metric({ records_in: decision.expectedGraphReadback.nodeCount, records_out: decision.expectedGraphReadback.edgeCount }),
    startedAt: "2026-09-07T15:00:00.000Z",
    finishedAt: "2026-09-07T15:00:00.100Z",
  };
}

function receiptFor(decision, graphResult, graphReceipt, overrides = {}) {
  const { expectedReadback, expectedLaneObjects: laneObjects } = pipelineReadbackExpectations(decision, graphResult.derived);
  const laneManifest = Object.fromEntries(Object.keys(laneObjects).map((lane) => [lane, { status: lane === "bitemporal" && laneObjects[lane] === 0 ? "not_applicable" : "ready", reason: "frozen-fixture", objects: laneObjects[lane] }]));
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope: decision.scope,
    runId: decision.runId,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
    stages: decision.stages,
    graphReceiptHash: graphResult.graphReceiptHash,
    derivedHash: graphResult.derivedHash,
    executionTimes: {
      13: { startedAt: graphReceipt.startedAt, finishedAt: graphReceipt.finishedAt },
      15: { startedAt: "2026-09-07T15:00:01.000Z", finishedAt: "2026-09-07T15:00:01.100Z" },
      16: { startedAt: "2026-09-07T15:00:02.000Z", finishedAt: "2026-09-07T15:00:02.100Z" },
    },
    snapshotId: `${decision.batchId}-snapshot`,
    generation: `${decision.batchId}-generation`,
    model: { ...PIPELINE_MODEL, artifactHashes: { "model.safetensors": "a".repeat(64) } },
    transaction: { id: `${decision.batchId}-final-tx`, frontier: `${decision.batchId}-final-frontier`, checkpoint: `${decision.batchId}-final-checkpoint` },
    readback: { ok: true, ...expectedReadback },
    laneManifest,
    metrics: {
      13: graphReceipt.metrics,
      15: metric({ records_in: decision.chunks.length, records_out: decision.chunks.length }),
      16: metric({ records_in: expectedReadback.nodeCount + expectedReadback.edgeCount, records_out: expectedReadback.nodeCount + expectedReadback.edgeCount }),
    },
    benchmark: { fixtureVersion: "ki17-corpus-v1", queryCount: 5, recallAt5: 1, mrr: 1, citationCorrectness: 1, crossTenantLeaks: 0 },
    ...overrides,
  };
}

async function submitAndClaim(service, batch) {
  const submitted = await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) });
  const claimed = await service.pipelineClaim({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...auth(batch.scope, "worker") });
  return { submitted, decision: claimed.decisions.find((candidate) => candidate.batchId === batch.batchId) };
}

describe("GenesisRAG17 pipeline contract", () => {
  it("submits atomically, preserves repeated occurrences, and replays graph enrichment without duplicate terminals", async () => {
    const { service, persistence } = harness();
    const batch = makeBatch({ id: "batch-occurrences" });
    const { submitted, decision } = await submitAndClaim(service, batch);
    expect(submitted).toMatchObject({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batchId: batch.batchId, status: "PENDING", idempotent: false });
    expect(decision).toMatchObject({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batchId: batch.batchId, ontologyVersion: "ontology_v1", pipelineVersion: PIPELINE_SCHEMA_VERSION, derived: [] });
    expect(decision).not.toHaveProperty("expectedReadback");
    expect(decision).not.toHaveProperty("expectedLaneObjects");
    expect(decision.entities.find((entity) => entity.metadata.resolutionKey === "alice")).toMatchObject({ semanticType: "Person", mentions: [`${batch.batchId}-mention-1-1`, `${batch.batchId}-mention-2-1`] });
    expect(decision.facts).toHaveLength(5);
    expect(decision.facts.every((fact) => fact.id && !Object.prototype.hasOwnProperty.call(fact, "factId"))).toBe(true);
    expect(decision.facts.every((fact) => fact.sourceReferences.sourceId === batch.source.sourceId && batch.chunks.some((chunk) => chunk.chunkId === fact.sourceReferences.chunkId))).toBe(true);
    expect((await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12]);

    const replay = await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) });
    expect(replay).toMatchObject({ batchId: batch.batchId, decisionId: submitted.decisionId, status: "PENDING", idempotent: true });
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    expect(graphResult).toMatchObject({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, accepted: true, idempotent: false });
    expect(graphResult.derived).toHaveLength(decision.entities.length);
    expect(graphResult.derived.every((row) => Array.isArray(row.sourceReferences) && row.documentCount === 1)).toBe(true);
    expect(await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker })).toMatchObject({ accepted: true, idempotent: true, derivedHash: graphResult.derivedHash });
    const evidenceAfterGraph = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidenceAfterGraph.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(evidenceAfterGraph.at(-1).metrics).toMatchObject({ records_in: decision.entities.length, records_out: decision.entities.length, duration_ms: expect.any(Number) });
    expect(persistence.getPipelineDecision({ scope: batch.scope, decisionId: submitted.decisionId }).decisionHash).toBe(decision.decisionHash);
  });

  it("enforces content provenance, exact scope identity, and MSP role forwarding", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-auth" });
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch: { ...batch, source: { ...batch.source, contentHash: "b".repeat(64) } }, ...auth(batch.scope) })).rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope, "worker") })).rejects.toMatchObject({ code: "gks_scope_denied" });
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(scope({ tenantId: "other-tenant" })) })).rejects.toMatchObject({ code: "gks_scope_denied" });
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: scope({ tenantId: "other-tenant" }), batch, ...auth(batch.scope) })).rejects.toMatchObject({ code: "gks_scope_denied" });
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope), relayCredential: "wrong" })).rejects.toMatchObject({ code: "gks_scope_denied" });
    expect(pipelineScopeKey(scope({ workspaceId: "a", agentId: "b" }))).not.toBe(pipelineScopeKey(scope({ workspaceId: "a\u0000b", agentId: "" })));
    expect(canonicalJsonString({ stageMetrics: { 9: "nine", 10: "ten" } })).toBe('{"stageMetrics":{"10":"ten","9":"nine"}}');
  });

  it("applies rule_v1 confidence floors and ontology_v1 aliases/endpoints", async () => {
    const { service } = harness();
    const make = (text, mentionRows, id) => makeBatch({ id, scope: scope({ agentId: id }), entries: [{ text, mentions: mentionRows }] });
    const explicitBatch = make("Alice works for Acme", [["Alice", "alice-explicit", "Person"], ["Acme", "acme-explicit", "Organization"]], "confidence-explicit");
    const { decision: explicitDecision } = await submitAndClaim(service, explicitBatch);
    expect(explicitDecision.facts[0]).toMatchObject({ predicate: "WORKS_FOR", confidence: 0.9 });

    const structuredText = '{"subject":"Alice","predicate":"purchased_from","object":"Atlas"}';
    const structuredBatch = make(structuredText, [["Alice", "alice-structured", "Person"], ["Atlas", "atlas-structured", "Product"]], "confidence-structured");
    const { decision: structuredDecision } = await submitAndClaim(service, structuredBatch);
    expect(structuredDecision.facts[0]).toMatchObject({ predicate: "PURCHASED", confidence: 0.85 });

    const inferredBatch = make("Alice and Atlas", [["Alice", "alice-inferred", "Person"], ["Atlas", "atlas-inferred", "Product"]], "confidence-inferred");
    const { decision: inferredDecision } = await submitAndClaim(service, inferredBatch);
    expect(inferredDecision.facts).toEqual([]);
    expect(inferredDecision.held).toContainEqual(expect.objectContaining({ confidence: 0.7, reason: "confidence_below_write_floor" }));

    const unknownText = '{"subject":"Alice","predicate":"supervises","object":"Acme"}';
    const unknownBatch = make(unknownText, [["Alice", "alice-unknown", "Person"], ["Acme", "acme-unknown", "Organization"]], "predicate-unknown");
    const { decision: unknownDecision } = await submitAndClaim(service, unknownBatch);
    expect(unknownDecision.held).toContainEqual(expect.objectContaining({ reason: "unknown_predicate" }));
  });

  it("requires graph receipt before enrichment and final receipt, then gates five dimensions before publication", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-ordered" });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    await expect(service.pipelineWriteReceipt({ receipt: receiptFor(decision, { graphReceiptHash: "a".repeat(64), derivedHash: "b".repeat(64) }, graphReceipt), ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const receipt = receiptFor(decision, graphResult, graphReceipt);
    const written = await service.pipelineWriteReceipt({ receipt, ...worker });
    expect(written).toMatchObject({ accepted: true, schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope });
    expect((await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(await service.pipelineWriteReceipt({ receipt, ...worker })).toMatchObject({ accepted: true, idempotent: true, receiptHash: written.receiptHash });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate).toMatchObject({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, verdict: { verdict: "PASS", allowPublication: true, receiptHash: written.receiptHash, statistics: { documents: 1, chunks: batch.chunks.length, entities: decision.entities.length, facts: decision.facts.length, relations: decision.facts.length } } });
    const replayedGate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(replayedGate).toMatchObject({ verdictHash: gate.verdictHash, verdict: { verdict: "PASS" } });
    expect(replayedGate.verdict).not.toHaveProperty("metrics");
    expect(replayedGate.verdict).not.toHaveProperty("gateStartedAt");
    expect(replayedGate.verdict).not.toHaveProperty("gateFinishedAt");
    const publication = { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash, snapshotId: receipt.snapshotId, generation: receipt.generation, receiptHash: written.receiptHash, publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "c".repeat(64), modelRevision: receipt.model.revision, transactionFrontier: receipt.transaction.frontier, readback: { ok: true } };
    const published = await service.pipelinePublicationReceipt({ receipt: publication, ...worker });
    expect(published).toMatchObject({ accepted: true, schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope });
    expect((await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(await service.pipelineWriteReceipt({ receipt, ...worker })).toMatchObject({ accepted: true, idempotent: true, receiptHash: written.receiptHash });
    expect(await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker })).toMatchObject({ accepted: true, idempotent: true, graphReceiptHash: graphResult.graphReceiptHash });
    expect(await service.pipelinePublicationReceipt({ receipt: publication, ...worker })).toMatchObject({ idempotent: true, accepted: true });
    await expect(service.pipelinePublicationReceipt({ receipt: { ...publication, pointerHash: "d".repeat(64) }, ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
    await expect(service.pipelinePublicationReceipt({ receipt: { ...publication, modelRevision: "different-model" }, ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
  });

  it("records a terminal FAILED Stage 17 decision with verdict details when the receipt is missing", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-failure" });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate).toMatchObject({ verdict: { verdict: "FAIL", allowPublication: false, receiptHash: null } });
    expect(gate.verdict.dimensions.graph.reasons).toContain("actual Tier4 graph receipt is missing.");
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 17]);
    expect(evidence.at(-1)).toMatchObject({ stageNumber: 17, outcome: "FAILED", details: { verdict: expect.objectContaining({ verdict: "FAIL" }), publicationReceipt: null } });
    await expect(service.pipelinePublicationReceipt({ receipt: { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash, snapshotId: "s", generation: "g", receiptHash: "a".repeat(64), publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "b".repeat(64), modelRevision: PIPELINE_MODEL.revision, transactionFrontier: "f", readback: { ok: true } }, ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
  });

  it("persists one resumable worker failure and prevents later stages from becoming green", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-stage-failure" });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    await expect(service.pipelineStageFailure({
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      scope: batch.scope,
      runId: batch.runId,
      decisionId: decision.decisionId,
      decisionHash: decision.decisionHash,
      stage: decision.stages.find((stage) => stage.stageNumber === 9),
      startedAt: "2026-09-07T15:00:01.000Z",
      finishedAt: "2026-09-07T15:00:01.100Z",
      metrics: metric({ error_count: 1 }),
      error: { code: "INVALID_WORKER_STAGE", message: "worker must not close a GKS-owned stage" },
      ...worker,
    })).rejects.toMatchObject({ code: "gks_invalid_request" });
    const failure = {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      scope: batch.scope,
      runId: batch.runId,
      decisionId: decision.decisionId,
      decisionHash: decision.decisionHash,
      stage: decision.stages.find((stage) => stage.stageNumber === 15),
      startedAt: "2026-09-07T15:00:01.000Z",
      finishedAt: "2026-09-07T15:00:01.100Z",
      metrics: metric({ records_in: batch.chunks.length, records_out: 0, error_count: 1 }),
      error: { code: "INDEX_WRITE_FAILED", message: "pinned Tier4 index rejected the candidate generation" },
    };
    const recorded = await service.pipelineStageFailure({ ...failure, ...worker });
    expect(recorded).toMatchObject({ accepted: true, idempotent: false, stage: failure.stage });
    expect(await service.pipelineStageFailure({ ...failure, ...worker })).toMatchObject({ accepted: true, idempotent: true, failureHash: recorded.failureHash });
    await expect(service.pipelineWriteReceipt({ receipt: receiptFor(decision, graphResult, graphReceipt), ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(evidence.at(-1)).toMatchObject({ stageNumber: 15, outcome: "FAILED", metrics: failure.metrics, details: { error: failure.error } });
  });

  it("records an embedding policy denial as a terminal Stage 15 failure", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-policy-denied", policy: { allowEmbedding: false, allowPublication: true } });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    expect(graphResult).toMatchObject({ accepted: true, derivedHash: expect.any(String) });
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.map((row) => row.stageNumber)).toEqual([9, 10, 11, 12, 13, 14]);
    const failure = {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      scope: batch.scope,
      runId: batch.runId,
      decisionId: decision.decisionId,
      decisionHash: decision.decisionHash,
      stage: decision.stages.find((stage) => stage.stageNumber === 15),
      startedAt: "2026-09-07T15:00:01.000Z",
      finishedAt: "2026-09-07T15:00:01.100Z",
      metrics: metric({ records_in: batch.chunks.length, records_out: 0, records_quarantined: batch.chunks.length, error_count: 1 }),
      error: { code: "EMBEDDING_POLICY_DENIED", message: "batch policy does not allow embedding" },
    };
    await expect(service.pipelineStageFailure({ ...failure, ...worker })).resolves.toMatchObject({ accepted: true, stage: failure.stage });
    const failedEvidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(failedEvidence.at(-1)).toMatchObject({ stageNumber: 15, outcome: "FAILED", details: { error: { code: "EMBEDDING_POLICY_DENIED" } } });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate).toMatchObject({ verdict: { verdict: "FAIL", allowPublication: false } });
    const gatedEvidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(gatedEvidence.at(-1)).toMatchObject({ stageNumber: 17, outcome: "FAILED", details: { verdict: expect.objectContaining({ verdict: "FAIL" }) } });
  });

  it("pages immutable evidence by exact scope and survives restart", async () => {
    const { service, persistence, directory } = harness();
    const batch = makeBatch({ id: "batch-cursor" });
    await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) });
    const first = await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, afterCursor: 0, limit: 2, ...auth(batch.scope) });
    expect(first.rows).toHaveLength(2);
    expect(first.rows.every((row) => row.schemaVersion === PIPELINE_SCHEMA_VERSION && JSON.stringify(row.scope) === JSON.stringify(batch.scope))).toBe(true);
    const second = await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, afterCursor: first.nextCursor, limit: 20, ...auth(batch.scope) });
    expect(second.rows).toHaveLength(2);
    await expect(service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, afterCursor: 999, ...auth(batch.scope) })).rejects.toMatchObject({ code: "gks_invalid_request" });
    expect((await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: scope({ tenantId: "other" }), runId: batch.runId, ...auth(scope({ tenantId: "other" })) })).rows).toEqual([]);
    persistence.close();
    const reopened = openSqlitePersistence({ dbPath: path.join(directory, "gks.sqlite") });
    cleanups.push(() => reopened.close());
    expect(reopened.exportPipelineEvidence({ scope: batch.scope, runId: batch.runId, afterCursor: 0, limit: 20 }).rows).toHaveLength(4);
  });
});
