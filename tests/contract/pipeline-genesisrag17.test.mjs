import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
  hashPipelineDecision,
  pipelineScopeKey,
  sha256Text,
  validatePipelineBatch,
} from "@freshair129/gks-contracts";
import { buildPipelineDecision, pipelineReadbackExpectations } from "@freshair129/gks-core";
import { promotion } from "../fixtures/candidates.mjs";

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
    const occurrenceOffsets = new Map();
    for (const [mentionIndex, [name, resolutionKey, semanticType]] of entry.mentions.entries()) {
      const startOffset = entry.text.indexOf(name, occurrenceOffsets.get(name) ?? 0);
      occurrenceOffsets.set(name, startOffset + name.length);
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
    expect(decision).toMatchObject({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batchId: batch.batchId, ontologyVersion: "ontology_v2", pipelineVersion: PIPELINE_SCHEMA_VERSION, derived: [] });
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

  it("applies rule_v1 confidence floors and the ontology_v1 aliases/endpoints that ontology_v2 keeps", async () => {
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

  it("keeps same resolution keys separate when semantic types conflict", async () => {
    const { service, persistence } = harness();
    const batch = makeBatch({
      id: "batch-typed-identity",
      entries: [{ text: "Atlas purchased Atlas.", mentions: [["Atlas", "atlas", "Person"], ["Atlas", "atlas", "Product"]] }],
    });
    const { decision } = await submitAndClaim(service, batch);
    expect(decision.entities).toHaveLength(2);
    expect(decision.entities.map((entity) => entity.semanticType).sort()).toEqual(["Person", "Product"]);
    expect(decision.entities.every((entity) => entity.mentions)).toBe(true);
    expect(decision.entities.flatMap((entity) => entity.mentions)).toEqual(batch.mentions.map((mention) => mention.sourceMentionId));
    expect(decision.facts).toHaveLength(1);
    expect(decision.facts[0]).toMatchObject({ predicate: "PURCHASED" });
    expect(decision.facts[0].subjectId).not.toBe(decision.facts[0].objectId);
    // Stage 9 reuse reads the pipeline pool, which includes unpublished runs.
    const rows = persistence.lookupResolutionCandidates({ scope: { ...batch.scope, projectId: "" }, includeUnpublishedPipeline: true });
    expect(rows.map((row) => row.type).sort()).toEqual(["Person", "Product"]);
    expect(new Set(rows.map((row) => row.normKey)).size).toBe(2);

    const sameTypeBatch = makeBatch({
      id: "batch-typed-reuse",
      scope: scope({ agentId: "agent-typed-reuse" }),
      entries: [{ text: "Atlas purchased Widget.", mentions: [["Atlas", "atlas", "Person"], ["Widget", "widget", "Product"]] }],
    });
    const { decision: sameTypeDecision } = await submitAndClaim(service, sameTypeBatch);
    expect(sameTypeDecision.entities.find((entity) => entity.metadata.resolutionKey === "atlas").id)
      .toBe(decision.entities.find((entity) => entity.semanticType === "Person").id);
  });

  it("measures canonical lookup inside Stage 9", async () => {
    const { service, persistence } = harness();
    const batch = makeBatch({ id: "batch-stage9-timing" });
    const lookup = persistence.lookupResolutionCandidates;
    persistence.lookupResolutionCandidates = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return lookup(input);
    };
    await submitAndClaim(service, batch);
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.find((row) => row.stageNumber === 9).metrics.duration_ms).toBeGreaterThanOrEqual(25);
  });

  it("binds coordinated clauses to the grammatical subject and rejects negated relations", async () => {
    const { service } = harness();
    const compound = makeBatch({
      id: "batch-coordinated-subject",
      scope: scope({ agentId: "agent-coordinated" }),
      entries: [{ text: "Alice works for Acme Limited and purchased Atlas.", mentions: [["Alice", "alice", "Person"], ["Acme Limited", "acme", "Organization"], ["Atlas", "atlas", "Product"]] }],
    });
    const { decision: compoundDecision } = await submitAndClaim(service, compound);
    const alice = compoundDecision.entities.find((entity) => entity.name === "Alice");
    expect(compoundDecision.facts).toHaveLength(2);
    expect(compoundDecision.facts.every((fact) => fact.subjectId === alice.id)).toBe(true);

    for (const [id, text] of [[
      "batch-ambiguous-but",
      "Alice works for Acme Limited but purchased Atlas.",
    ], [
      "batch-ambiguous-comma",
      "Alice works for Acme Limited, purchased Atlas.",
    ]]) {
      const ambiguous = makeBatch({
        id,
        scope: scope({ agentId: id }),
        entries: [{ text, mentions: [["Alice", `${id}-alice`, "Person"], ["Acme Limited", `${id}-acme`, "Organization"], ["Atlas", `${id}-atlas`, "Product"]] }],
      });
      const { decision: ambiguousDecision } = await submitAndClaim(service, ambiguous);
      expect(ambiguousDecision.facts).toHaveLength(1);
      expect(ambiguousDecision.facts[0].predicate).toBe("WORKS_FOR");
      expect(ambiguousDecision.held).toContainEqual(expect.objectContaining({
        reason: "ambiguous_subject_binding",
        sourceReferences: expect.objectContaining({ chunkId: ambiguous.chunks[0].chunkId }),
      }));
    }

    const negated = makeBatch({
      id: "batch-negated-neither",
      scope: scope({ agentId: "agent-negated" }),
      entries: [{ text: "Alice works for neither Acme Limited nor Beacon Limited.", mentions: [["Alice", "alice-negated", "Person"], ["Acme Limited", "acme-negated", "Organization"], ["Beacon Limited", "beacon-negated", "Organization"]] }],
    });
    const { decision: negatedDecision } = await submitAndClaim(service, negated);
    expect(negatedDecision.facts).toEqual([]);
    expect(negatedDecision.held.every((record) => record.reason !== "invalid_endpoint")).toBe(true);
  });

  it("distinguishes no temporal claim, open-ended dates, unmapped dates and invalid intervals", async () => {
    const { service } = harness();
    const makeTemporal = (id, text) => makeBatch({ id, scope: scope({ agentId: id }), entries: [{ text, mentions: [["Alice", `${id}-alice`, "Person"], ["Atlas", `${id}-atlas`, "Product"]] }] });

    const noClaim = (await submitAndClaim(service, makeTemporal("batch-temporal-na", "Alice purchased Atlas."))).decision;
    expect(noClaim.facts[0].temporal).toMatchObject({ validFrom: "not_applicable", validTo: "not_applicable" });
    expect(noClaim.stageMetrics[12]).toMatchObject({ unmapped: 0 });

    const openEnded = (await submitAndClaim(service, makeTemporal("batch-temporal-open", "Alice purchased Atlas on 2026-09-07T00:00:00.000Z."))).decision;
    expect(openEnded.facts[0].temporal).toMatchObject({ validFrom: "2026-09-07T00:00:00.000Z", validTo: null });

    const unmapped = (await submitAndClaim(service, makeTemporal("batch-temporal-unmapped", "Alice purchased Atlas on 7 September 2026."))).decision;
    expect(unmapped.facts).toEqual([]);
    expect(unmapped.held).toContainEqual(expect.objectContaining({ reason: "temporal_unmapped", sourceReferences: expect.objectContaining({ chunkId: unmapped.chunks[0].chunkId }) }));
    expect(unmapped.stageMetrics[12]).toMatchObject({ records_out: 0, records_quarantined: 1, unmapped: 1 });
    expect(unmapped.chunks[0].text).toContain("7 September 2026");

    for (const [id, text] of [["batch-temporal-relative", "Alice purchased Atlas yesterday."], ["batch-temporal-numeric", "Alice purchased Atlas on 07/09/2026."]]) {
      const unsupported = (await submitAndClaim(service, makeTemporal(id, text))).decision;
      expect(unsupported.facts).toEqual([]);
      expect(unsupported.held).toContainEqual(expect.objectContaining({ reason: "temporal_unmapped" }));
      expect(unsupported.stageMetrics[12]).toMatchObject({ records_out: 0, records_quarantined: 1, unmapped: 1 });
    }

    const reversedBatch = makeTemporal("batch-temporal-reversed", "Alice purchased Atlas from 2026-09-08 to 2026-09-01.");
    const { decision: reversed } = await submitAndClaim(service, reversedBatch);
    expect(reversed.facts).toEqual([]);
    expect(reversed.held).toContainEqual(expect.objectContaining({ reason: "invalid_temporal_order" }));
    expect(reversed.stageMetrics[12]).toMatchObject({ records_in: 1, records_out: 0, records_quarantined: 1, unmapped: 0 });
  });

  it("counts chunks actually processed and rejects unsupported structured temporal metadata", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-stage10-empty", entries: [{ text: "No relation here.", mentions: [] }] });
    await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) });
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.find((row) => row.stageNumber === 10).metrics).toMatchObject({ records_in: 1, records_out: 0 });

    const metadataBatch = makeBatch({ id: "batch-temporal-metadata" });
    metadataBatch.source = { ...metadataBatch.source, temporalMetadata: { validFrom: "2026-09-01T00:00:00.000Z" } };
    await expect(service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: metadataBatch.scope, batch: metadataBatch, ...auth(metadataBatch.scope) })).rejects.toMatchObject({ code: "gks_invalid_request" });
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

  it("expects a bitemporal object only for facts that carry valid time, so a mixed generation passes the graph dimension", async () => {
    const { service } = harness();
    const batch = makeBatch({
      id: "batch-temporal-mixed",
      entries: [
        { text: "Alice purchased Atlas on 2026-09-07T00:00:00.000Z.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
        { text: "Bob purchased Nimbus.", mentions: [["Bob", "bob", "Person"], ["Nimbus", "nimbus", "Product"]] },
      ],
    });
    const { decision } = await submitAndClaim(service, batch);
    expect(decision.held).toEqual([]);
    expect(decision.facts).toHaveLength(2);
    const dated = decision.facts.filter((fact) => !(fact.temporal?.validFrom === "not_applicable" && fact.temporal?.validTo === "not_applicable"));
    expect(dated).toHaveLength(1);
    expect(pipelineReadbackExpectations(decision).expectedLaneObjects.bitemporal).toBe(dated.length);

    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const receipt = receiptFor(decision, graphResult, graphReceipt);
    // The GenesisBlock worker's verifyTemporalLane reports only rows that carry valid time
    // (objects: mapped.length), never one object per fact. Model that receipt, not GKS's own expectation.
    receipt.laneManifest = { ...receipt.laneManifest, bitemporal: { status: "ready", reason: "native_query_ir_temporal_readback", objects: dated.length } };
    await service.pipelineWriteReceipt({ receipt, ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(JSON.stringify(gate.verdict)).not.toContain("bitemporal lane object count");
    expect(gate.verdict).toMatchObject({ verdict: "PASS", allowPublication: true });
  });

  it("keeps uniform generations unchanged: every dated fact counts, an all-undated generation expects none", async () => {
    const { service } = harness();
    const allDatedBatch = makeBatch({
      id: "batch-temporal-all-dated",
      scope: scope({ agentId: "agent-all-dated" }),
      entries: [
        { text: "Alice purchased Atlas on 2026-09-07T00:00:00.000Z.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
        { text: "Bob purchased Nimbus on 2026-09-08T00:00:00.000Z.", mentions: [["Bob", "bob", "Person"], ["Nimbus", "nimbus", "Product"]] },
      ],
    });
    const allDated = (await submitAndClaim(service, allDatedBatch)).decision;
    expect(allDated.facts).toHaveLength(2);
    expect(pipelineReadbackExpectations(allDated).expectedLaneObjects.bitemporal).toBe(2);

    const allUndated = (await submitAndClaim(service, makeBatch({ id: "batch-temporal-all-undated", scope: scope({ agentId: "agent-all-undated" }) }))).decision;
    expect(allUndated.facts.length).toBeGreaterThan(0);
    expect(allUndated.facts.every((fact) => fact.temporal?.validFrom === "not_applicable" && fact.temporal?.validTo === "not_applicable")).toBe(true);
    expect(pipelineReadbackExpectations(allUndated).expectedLaneObjects.bitemporal).toBe(0);
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

  it("treats WARN as a terminal failed gate and never publishes it", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-warn-gate", scope: scope({ agentId: "agent-warn" }), entries: [{ text: "Alice and Atlas", mentions: [["Alice", "warn-alice", "Person"], ["Atlas", "warn-atlas", "Product"]] }] });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const written = await service.pipelineWriteReceipt({ receipt: receiptFor(decision, graphResult, graphReceipt), ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate).toMatchObject({ verdict: { verdict: "WARN", allowPublication: false, receiptHash: written.receiptHash } });
    const evidence = (await service.pipelineEvidence({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...auth(batch.scope) })).rows;
    expect(evidence.at(-1)).toMatchObject({ stageNumber: 17, outcome: "FAILED", details: { verdict: expect.objectContaining({ verdict: "WARN", allowPublication: false }), publicationReceipt: null } });
    await expect(service.pipelinePublicationReceipt({ receipt: { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash, snapshotId: "s", generation: "g", receiptHash: written.receiptHash, publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "b".repeat(64), modelRevision: PIPELINE_MODEL.revision, transactionFrontier: "f", readback: { ok: true } }, ...worker })).rejects.toMatchObject({ code: "gks_conflict" });
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

  it("produces ontology_v2 catalog facts through submit and claim, and gates them PASS", async () => {
    const { service } = harness();
    const pkg = "PKG-XMAS-2026-SIGNATURE-CLEVEL";
    const claim = (subject, subjectType, predicate, object, objectType) => ({ text: JSON.stringify({ subject, predicate, object }), mentions: [[subject, subject, subjectType], [object, object, objectType]] });
    const batch = makeBatch({
      id: "batch-ontology-v2-catalog",
      scope: scope({ agentId: "agent-ontology-v2" }),
      entries: [
        { text: `Smart Executive Set (${pkg})`, mentions: [[pkg, pkg, "PACKAGE"]] },
        claim(pkg, "PACKAGE", "HAS_COMPONENT", "PM-NB", "Product"),
        claim("PM-BOTTLE-LED", "Product", "PRICED_AT", "PM-BOTTLE-LED:qty100:20000", "PRICE_TIER"),
        claim(pkg, "PACKAGE", "IN_CATEGORY", "cat:gift-set", "CATEGORY"),
      ],
    });
    const { decision } = await submitAndClaim(service, batch);
    expect(decision).toMatchObject({ ontologyVersion: "ontology_v2", held: [] });
    expect(decision.facts.map((fact) => [fact.predicate, fact.confidence, fact.basis])).toEqual([["HAS_COMPONENT", 0.85, "structured"], ["PRICED_AT", 0.85, "structured"], ["IN_CATEGORY", 0.85, "structured"]]);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    await service.pipelineWriteReceipt({ receipt: receiptFor(decision, graphResult, graphReceipt), ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate.verdict).toMatchObject({ verdict: "PASS", allowPublication: true, ontologyVersion: "ontology_v2" });
  });

  it("completes a decision persisted under ontology_v1 before the upgrade", async () => {
    const { service, persistence } = harness();
    const batch = validatePipelineBatch(makeBatch({ id: "batch-ontology-v1-inflight", scope: scope({ agentId: "agent-ontology-v1-inflight" }) }));
    // What the pre-upgrade code stored: the same decision with ontologyVersion
    // "ontology_v1" and the decisionHash that implies. decisionId hashes
    // {scope, batchId, batchHash}, never the version.
    const built = buildPipelineDecision(batch);
    const stageExecutionTimes = built.stageExecutionTimes;
    const { decisionHash: ignored, ...withoutHash } = built;
    const stored = { ...structuredClone(withoutHash), ontologyVersion: "ontology_v1" };
    stored.decisionHash = hashPipelineDecision(stored);
    persistence.transactPipelineSubmit({ scope: batch.scope, batch, batchHash: batch.batchHash, decision: stored, stageExecutionTimes });

    const claimed = await service.pipelineClaim({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...auth(batch.scope, "worker") });
    const decision = claimed.decisions.find((candidate) => candidate.batchId === batch.batchId);
    expect(decision).toMatchObject({ ontologyVersion: "ontology_v1", decisionHash: stored.decisionHash });
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    await service.pipelineWriteReceipt({ receipt: receiptFor(decision, graphResult, graphReceipt), ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate.verdict).toMatchObject({ verdict: "PASS", allowPublication: true, ontologyVersion: "ontology_v1" });
    expect(gate.verdict.dimensions.knowledge).toEqual({ result: "PASS", critical: false, reasons: [] });
  });
});

// ADR-GKS-PIPELINE-VISIBILITY: a GenesisRAG17 entity written at submit is not
// canonical knowledge for the legacy tools until a run that mentions it is
// PUBLISHED. The legacy view of a pipeline scope drops agentId and projectId.
describe("GenesisRAG17 entities before publication (ADR-GKS-PIPELINE-VISIBILITY)", () => {
  const legacyView = (pipelineScope) => ({ portfolioId: pipelineScope.portfolioId, tenantId: pipelineScope.tenantId, businessId: pipelineScope.businessId, workspaceId: pipelineScope.workspaceId, projectId: "", sharing: pipelineScope.visibility });

  async function publishRun(service, batch) {
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const receipt = receiptFor(decision, graphResult, graphReceipt);
    const written = await service.pipelineWriteReceipt({ receipt, ...worker });
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...worker });
    expect(gate.verdict.verdict).toBe("PASS");
    await service.pipelinePublicationReceipt({ receipt: { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash, snapshotId: receipt.snapshotId, generation: receipt.generation, receiptHash: written.receiptHash, publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "c".repeat(64), modelRevision: receipt.model.revision, transactionFrontier: receipt.transaction.frontier, readback: { ok: true } }, ...worker });
    return decision;
  }

  // No Tier-4 receipt: the gate FAILs and the batch is REJECTED.
  async function rejectRun(service, batch) {
    const { decision } = await submitAndClaim(service, batch);
    const gate = await service.pipelineGate({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash: decision.decisionHash, ...auth(batch.scope, "worker") });
    expect(gate.verdict.verdict).toBe("FAIL");
    return decision;
  }

  async function legacyRead(service, pipelineScope, entity) {
    const view = legacyView(pipelineScope);
    return {
      entity: await service.getEntity({ ref: entity.id, scope: view }),
      searchHit: (await service.search({ query: entity.name, scope: view })).some((row) => row.canonicalRef === entity.id),
      relations: await service.getRelations({ ref: entity.id, scope: view }),
    };
  }

  const hidden = { entity: null, searchHit: false, relations: [] };

  let legacyCounter = 0;
  function legacyPromotion(pipelineScope, entities, overrides = {}) {
    legacyCounter += 1;
    return promotion({
      idempotency_key: `visibility-${legacyCounter}`,
      provenance_ref: `msp:proof/visibility-${legacyCounter}`,
      source_snapshot_hash: legacyCounter.toString(16).padStart(64, "0"),
      scope: legacyView(pipelineScope),
      candidate: { entities, relations: [] },
      ...overrides,
    });
  }

  it("hides entities of a pending or rejected run from every legacy read and reveals them on publication", async () => {
    const { service } = harness();
    const pending = makeBatch({ id: "batch-visibility-pending" });
    const { decision } = await submitAndClaim(service, pending);
    for (const entity of decision.entities) expect(await legacyRead(service, pending.scope, entity)).toEqual(hidden);
    await expect(service.linkArtifact({ knowledgeRef: decision.entities[0].id, artifactRef: "project:PRJ-1", relationType: "RELATED_TO", evidenceRef: "msp:proof/link-hidden", scope: legacyView(pending.scope) }))
      .rejects.toMatchObject({ code: "gks_invalid_request" });

    const rejected = makeBatch({ id: "batch-visibility-rejected", scope: scope({ agentId: "agent-rejected" }), entries: [{ text: "Dana works for Delta Ltd.", mentions: [["Dana", "dana", "Person"], ["Delta Ltd.", "delta", "Organization"]] }] });
    const rejectedDecision = await rejectRun(service, rejected);
    for (const entity of rejectedDecision.entities) expect(await legacyRead(service, rejected.scope, entity)).toEqual(hidden);

    const published = makeBatch({ id: "batch-visibility-published", scope: scope({ agentId: "agent-published" }), entries: [{ text: "Erin works for Echo Ltd.", mentions: [["Erin", "erin", "Person"], ["Echo Ltd.", "echo", "Organization"]] }] });
    const publishedDecision = await publishRun(service, published);
    for (const entity of publishedDecision.entities) {
      const read = await legacyRead(service, published.scope, entity);
      expect(read.entity).toMatchObject({ canonicalRef: entity.id });
      expect(read.searchHit).toBe(true);
    }
  });

  it("reveals an entity first seen by a rejected run once a later run that reuses it is published", async () => {
    const { service } = harness();
    const entries = [{ text: "Frank works for Foxtrot Ltd.", mentions: [["Frank", "frank", "Person"], ["Foxtrot Ltd.", "foxtrot", "Organization"]] }];
    const first = await rejectRun(service, makeBatch({ id: "batch-reuse-rejected", scope: scope({ agentId: "agent-reuse-1" }), entries }));
    const frank = first.entities.find((entity) => entity.metadata.resolutionKey === "frank");
    expect(await legacyRead(service, scope(), frank)).toEqual(hidden);

    const second = await publishRun(service, makeBatch({ id: "batch-reuse-published", scope: scope({ agentId: "agent-reuse-2" }), entries }));
    expect(second.entities.find((entity) => entity.metadata.resolutionKey === "frank").id).toBe(frank.id);
    expect((await legacyRead(service, scope(), frank)).entity).toMatchObject({ canonicalRef: frank.id });
  });

  it("never lets a legacy promote match or resolveTo-probe a hidden entity", async () => {
    const { service } = harness();
    const { decision } = await submitAndClaim(service, makeBatch({ id: "batch-visibility-pool" }));
    const alice = decision.entities.find((entity) => entity.metadata.resolutionKey === "alice");

    const same = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "alice", type: "ENTITY", title: "Alice" }]));
    const sameMapping = same.canonical_mappings.find((item) => item.candidateRef === "alice");
    expect(sameMapping.resolution.outcome).toBe("CREATED");
    expect(sameMapping.canonicalRef).not.toBe(alice.id);

    const probe = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "alice probe", type: "ENTITY", title: "Alice probe", resolveTo: alice.id }]));
    expect(probe.canonical_mappings.find((item) => item.candidateRef === "alice probe").resolution.outcome).toBe("REJECTED");
  });

  it("refuses D9 bind and merge on a hidden entity exactly as on a missing one", async () => {
    const { service } = harness();
    const { decision } = await submitAndClaim(service, makeBatch({ id: "batch-visibility-d9" }));
    const hiddenRef = decision.entities[0].id;
    const view = legacyView(scope());

    const created = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "Beta Co", type: "ENTITY", title: "Beta Industrial Holdings" }]));
    const betaRef = created.canonical_mappings[0].canonicalRef;
    await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "Beta Co", type: "ENTITY", title: "Totally Different Name" }]));
    const [reviewRow] = await service.listUnresolvedMentions({ scope: view });
    expect(reviewRow).toMatchObject({ candidateRef: "Beta Co", outcome: "REVIEW_REQUIRED" });

    const notResolving = { code: "gks_invalid_request", message: expect.stringContaining("does not resolve") };
    await expect(service.applyHumanResolution({ action: "BIND", mentionId: reviewRow.mentionId, canonicalRef: hiddenRef, provenanceRef: "msp:proof/bind-hidden", scope: view })).rejects.toMatchObject(notResolving);
    await expect(service.applyHumanResolution({ action: "MERGE", survivorRef: betaRef, supersededRef: hiddenRef, provenanceRef: "msp:proof/merge-hidden-loser", scope: view })).rejects.toMatchObject(notResolving);
    await expect(service.applyHumanResolution({ action: "MERGE", survivorRef: hiddenRef, supersededRef: betaRef, provenanceRef: "msp:proof/merge-hidden-survivor", scope: view })).rejects.toMatchObject(notResolving);
  });

  it("omits a relation whose endpoint is hidden and keeps a legacy entity that carries metadata.pipelineVersion", async () => {
    const { service, directory } = harness();
    const { decision } = await submitAndClaim(service, makeBatch({ id: "batch-visibility-relations" }));
    const hiddenRef = decision.entities[0].id;
    const view = legacyView(scope());

    const promoted = await service.promoteCandidate(legacyPromotion(scope(), [
      { candidateRef: "Gamma Co", type: "ENTITY", title: "Gamma Co", metadata: { pipelineVersion: PIPELINE_SCHEMA_VERSION } },
      { candidateRef: "Delta Co", type: "ENTITY", title: "Delta Co" },
    ], {}));
    const gammaRef = promoted.canonical_mappings.find((item) => item.candidateRef === "Gamma Co").canonicalRef;
    const deltaRef = promoted.canonical_mappings.find((item) => item.candidateRef === "Delta Co").canonicalRef;
    // A caller-supplied metadata key cannot make a legacy entity pipeline-origin.
    expect(await service.getEntity({ ref: gammaRef, scope: view })).toMatchObject({ canonicalRef: gammaRef });

    // Relations written before the upgrade can still name a hidden entity.
    const raw = new Database(path.join(directory, "gks.sqlite"));
    try {
      const insertRelation = raw.prepare(`INSERT INTO relations (canonical_ref, scope_key, from_ref, relation_type, to_ref, confidence, evidence_ref, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, graph_version)
        VALUES (?, ?, ?, 'RELATED_TO', ?, NULL, 'msp:proof/pre-upgrade', ?, ?, ?, ?, '', 'private', '{}', '2026-09-01T00:00:00.000Z', 'gks:graph/1')`);
      const legacyKey = [view.portfolioId, view.tenantId, view.businessId, view.workspaceId, "", "private"].join("\u0000");
      insertRelation.run(`gks:relation/${"1".repeat(32)}`, legacyKey, gammaRef, hiddenRef, view.portfolioId, view.tenantId, view.businessId, view.workspaceId);
      insertRelation.run(`gks:relation/${"2".repeat(32)}`, legacyKey, gammaRef, deltaRef, view.portfolioId, view.tenantId, view.businessId, view.workspaceId);
    } finally {
      raw.close();
    }
    expect((await service.getRelations({ ref: gammaRef, scope: view })).map((relation) => relation.toRef)).toEqual([deltaRef]);
    expect(await service.getRelations({ ref: hiddenRef, scope: view })).toEqual([]);
  });

  it("creates a legacy entity instead of conflicting when its norm key imitates a hidden typed pipeline key", async () => {
    const { service } = harness();
    // A caseless semantic type keeps the typed key reachable by a norm_v1
    // string: normKey("acme\u0000123") === pipelineEntityNormKey("acme", "123").
    const { decision } = await submitAndClaim(service, makeBatch({ id: "batch-visibility-normkey", entries: [{ text: "Acme and Atlas", mentions: [["Acme", "acme", "123"], ["Atlas", "atlas", "Product"]] }] }));
    const hiddenAcme = decision.entities.find((entity) => entity.metadata.resolutionKey === "acme");

    const first = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "acme\u0000123", type: "ENTITY", title: "Acme imitation" }]));
    const created = first.canonical_mappings[0];
    expect(created.resolution.outcome).toBe("CREATED");
    expect(created.canonicalRef).not.toBe(hiddenAcme.id);
    expect(await legacyRead(service, scope(), hiddenAcme)).toEqual(hidden);

    // The same string later reaches the legacy entity, not a new split.
    const again = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "acme\u0000123", type: "ENTITY", title: "Acme imitation" }]));
    expect(again.canonical_mappings[0]).toMatchObject({ canonicalRef: created.canonicalRef, resolution: { outcome: "MATCHED" } });
  });

  it("lets a published pipeline entity survive a repair merge but never be superseded", async () => {
    const { service } = harness();
    const view = legacyView(scope());
    // The legacy spelling is promoted first, under a type the pipeline reuse
    // cannot claim, so publication leaves two identities to repair (D3).
    const duplicateRef = (await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "alice legacy", type: "ENTITY", title: "Alice" }]))).canonical_mappings[0].canonicalRef;
    const decision = await publishRun(service, makeBatch({ id: "batch-visibility-merge" }));
    const aliceRef = decision.entities.find((entity) => entity.metadata.resolutionKey === "alice").id;
    expect((await service.getEntity({ ref: aliceRef, scope: view })).canonicalRef).toBe(aliceRef);

    await expect(service.applyHumanResolution({ action: "MERGE", survivorRef: duplicateRef, supersededRef: aliceRef, provenanceRef: "msp:proof/merge-pipeline-away", scope: view }))
      .rejects.toMatchObject({ code: "gks_conflict", message: expect.stringContaining("GenesisRAG17") });
    expect((await service.getEntity({ ref: aliceRef, scope: view })).supersededBy ?? null).toBeNull();

    await service.applyHumanResolution({ action: "MERGE", survivorRef: aliceRef, supersededRef: duplicateRef, provenanceRef: "msp:proof/merge-into-pipeline", scope: view });
    expect((await service.getEntity({ ref: duplicateRef, scope: view })).supersededBy).toBe(aliceRef);
  });

  it("keeps a FAILED_STAGE run hidden", async () => {
    const { service } = harness();
    const batch = makeBatch({ id: "batch-visibility-failed-stage" });
    const { decision } = await submitAndClaim(service, batch);
    const worker = auth(batch.scope, "worker");
    await service.pipelineGraphReceipt({ receipt: graphReceiptFor(decision), ...worker });
    await service.pipelineStageFailure({
      schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash: decision.decisionHash,
      stage: decision.stages.find((stage) => stage.stageNumber === 15), startedAt: "2026-09-07T15:00:01.000Z", finishedAt: "2026-09-07T15:00:01.100Z",
      metrics: metric({ records_in: batch.chunks.length, records_out: 0, error_count: 1 }), error: { code: "INDEX_WRITE_FAILED", message: "pinned Tier4 index rejected the candidate generation" }, ...worker,
    });
    for (const entity of decision.entities) expect(await legacyRead(service, batch.scope, entity)).toEqual(hidden);
  });

  it("backfills origin from GKS's own records, never from caller metadata", async () => {
    const { persistence, service, directory } = harness();
    // A legacy entity that GenesisRAG17 Stage 9 reuses (its metadata carries the
    // typed identity) is named by pipeline_mentions but was legacy-created.
    const reused = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "alice", type: "ENTITY", title: "Alice", metadata: { semanticType: "Person", resolutionKey: "alice" } }]));
    const reusedRef = reused.canonical_mappings[0].canonicalRef;
    const { decision } = await submitAndClaim(service, makeBatch({ id: "batch-visibility-backfill" }));
    expect(decision.entities.find((entity) => entity.metadata.resolutionKey === "alice").id).toBe(reusedRef);
    const pipelineCreated = decision.entities.filter((entity) => entity.id !== reusedRef);
    const promoted = await service.promoteCandidate(legacyPromotion(scope(), [{ candidateRef: "Kilo Co", type: "ENTITY", title: "Kilo Co", metadata: { pipelineVersion: PIPELINE_SCHEMA_VERSION } }]));
    const kiloRef = promoted.canonical_mappings[0].canonicalRef;
    persistence.close();

    // Rewind the store to before 0007: no origin column, no 0007 record.
    const dbPath = path.join(directory, "gks.sqlite");
    const raw = new Database(dbPath);
    try {
      raw.exec("DROP INDEX idx_pipeline_mentions_entity_ref; ALTER TABLE entities DROP COLUMN origin; DELETE FROM schema_migrations WHERE name = '0007_pipeline_entity_origin.sql';");
    } finally {
      raw.close();
    }

    const reopened = openSqlitePersistence({ dbPath });
    try {
      const check = new Database(dbPath, { readonly: true });
      try {
        const origins = Object.fromEntries(check.prepare("SELECT canonical_ref, origin FROM entities").all().map((row) => [row.canonical_ref, row.origin]));
        for (const entity of pipelineCreated) expect(origins[entity.id]).toBe("pipeline");
        expect(origins[reusedRef]).toBe("legacy");
        expect(origins[kiloRef]).toBe("legacy");
      } finally {
        check.close();
      }
      expect(reopened.getEntity(pipelineCreated[0].id)).toBeNull();
      expect(reopened.getEntity(reusedRef)).toMatchObject({ canonicalRef: reusedRef });
      expect(reopened.getEntity(kiloRef)).toMatchObject({ canonicalRef: kiloRef });
    } finally {
      reopened.close();
    }
    // harness cleanup closes the original handle again; better-sqlite3 tolerates it.
  });
});