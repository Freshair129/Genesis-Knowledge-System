// Shared GenesisRAG17 fixtures: a deterministic batch builder, the MSP-forwarded
// relay envelope, and frozen Tier-4 receipts shaped like the worker's.
import { PIPELINE_MODEL, PIPELINE_SCHEMA_VERSION, PIPELINE_STAGE_CATALOG, sha256Text } from "@freshair129/gks-contracts";
import { pipelineReadbackExpectations } from "@freshair129/gks-core";

export const RELAY_SECRET = "relay-ki17-secret";

export const scope = (overrides = {}) => ({
  portfolioId: "portfolio-ki17",
  tenantId: "tenant-ki17",
  businessId: "business-ki17",
  workspaceId: "",
  agentId: "agent-ki17",
  visibility: "private",
  ...overrides,
});

export const defaultEntries = [
  { text: "Alice works for Acme Ltd.", mentions: [["Alice", "alice", "Person"], ["Acme Ltd.", "acme", "Organization"]] },
  { text: "Alice purchased Atlas.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
  { text: "Bob works for Beacon Ltd.", mentions: [["Bob", "bob", "Person"], ["Beacon Ltd.", "beacon", "Organization"]] },
  { text: "Bob purchased Nimbus.", mentions: [["Bob", "bob", "Person"], ["Nimbus", "nimbus", "Product"]] },
  { text: "Carol works for Cedar Ltd.", mentions: [["Carol", "carol", "Person"], ["Cedar Ltd.", "cedar", "Organization"]] },
];

export function makeBatch({ id = "batch-ki17-1", entries = defaultEntries, scope: batchScope = scope(), policy = { allowEmbedding: true, allowPublication: true } } = {}) {
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

export const auth = (requestScope, role = "source") => ({
  relayCredential: RELAY_SECRET,
  authenticatedPrincipal: { principalId: `${role}-principal`, role, scope: requestScope },
});

export function metric(overrides = {}) {
  return { records_in: 1, records_out: 1, records_quarantined: 0, error_count: 0, retry_count: 0, duration_ms: 1, ...overrides };
}

export function graphReceiptFor(decision) {
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

export function receiptFor(decision, graphResult, graphReceipt, overrides = {}) {
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

export async function submitAndClaim(service, batch) {
  const submitted = await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...auth(batch.scope) });
  const claimed = await service.pipelineClaim({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...auth(batch.scope, "worker") });
  return { submitted, decision: claimed.decisions.find((candidate) => candidate.batchId === batch.batchId) };
}
