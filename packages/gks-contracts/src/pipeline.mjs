// @req FR-109, FR-110 — validate and hash the frozen GenesisRAG17 wire contract.
// @spec ADR-GKS-GENESISRAG17.md, docs/plans/GENESISRAG17-CONTRACT.md
// @tested tests/contract/pipeline-genesisrag17.test.mjs, tests/contract/server-dispatch.test.mjs

import crypto from "node:crypto";

import {
  GksBackendUnconfiguredError,
  GksInvalidRequestError,
  GksScopeDeniedError,
} from "./errors.mjs";

export const PIPELINE_SCHEMA_VERSION = "genesisrag17.v1";
export const PIPELINE_ONTOLOGY_VERSION = "ontology_v1";
export const PIPELINE_VERSION = PIPELINE_SCHEMA_VERSION;
export const PIPELINE_SCOPE_KEYS = Object.freeze([
  "portfolioId",
  "tenantId",
  "businessId",
  "workspaceId",
  "agentId",
  "visibility",
]);
export const PIPELINE_ROLES = Object.freeze({ source: "source", worker: "worker" });
export const PIPELINE_REQUIRED_METRICS = Object.freeze([
  "records_in",
  "records_out",
  "records_quarantined",
  "error_count",
  "retry_count",
  "duration_ms",
]);
export const PIPELINE_STAGE_CATALOG = Object.freeze([
  Object.freeze({ stageNumber: 9, pipelineStageId: "DPS-KI-ENTITY-RESOLVE" }),
  Object.freeze({ stageNumber: 10, pipelineStageId: "DPS-KI-FACT-EXTRACT" }),
  Object.freeze({ stageNumber: 11, pipelineStageId: "DPS-KI-ONTOLOGY-MAP" }),
  Object.freeze({ stageNumber: 12, pipelineStageId: "DPS-KI-TEMPORAL-MAP" }),
  Object.freeze({ stageNumber: 13, pipelineStageId: "DPS-KI-GRAPH-BUILD" }),
  Object.freeze({ stageNumber: 14, pipelineStageId: "DPS-KI-ENRICH" }),
  Object.freeze({ stageNumber: 15, pipelineStageId: "DPS-KI-EMBED" }),
  Object.freeze({ stageNumber: 16, pipelineStageId: "DPS-KI-INDEX" }),
  Object.freeze({ stageNumber: 17, pipelineStageId: "DPS-KI-QUALITY-GATE" }),
]);
export const PIPELINE_STAGE_BY_NUMBER = Object.freeze(
  Object.fromEntries(PIPELINE_STAGE_CATALOG.map((stage) => [stage.stageNumber, stage])),
);
export const PIPELINE_CONFIDENCE = Object.freeze({
  explicit: 0.9,
  structured: 0.85,
  inferredMax: 0.7,
  writeFloor: 0.8,
});
export const PIPELINE_MODEL = Object.freeze({
  id: "intfloat/multilingual-e5-small",
  revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  dimensions: 384,
  metric: "cosine",
});
export const PIPELINE_QUALITY_THRESHOLDS = Object.freeze({
  recallAt5: 0.8,
  mrr: 0.65,
  citationCorrectness: 1,
  crossTenantLeaks: 0,
});
export const PIPELINE_LANES = Object.freeze([
  "vector",
  "lexical",
  "graph",
  "sqlite",
  "bitemporal",
  "provenance",
]);
export const PIPELINE_OUTCOMES = Object.freeze(["SUCCEEDED", "FAILED"]);

const HASH = /^[a-f0-9]{64}$/;
const SOURCE_ID_FIELDS = Object.freeze(["sourceId", "rawArtifactId", "parsedArtifactId", "documentId", "version"]);

function invalid(message) {
  throw new GksInvalidRequestError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Return a JSON-safe clone whose object keys are sorted recursively. Arrays
 * deliberately retain their input order because source occurrence order is
 * part of the GenesisRAG17 batch identity.
 */
export function canonicalJson(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite JSON numbers.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJson(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key], `${path}.${key}`)]),
    );
  }
  invalid(`${path} must contain only JSON-compatible values.`);
}

function canonicalSerialize(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite JSON numbers.`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalSerialize(item, `${path}[${index}]`)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key], `${path}.${key}`)}`).join(",")}}`;
  }
  invalid(`${path} must contain only JSON-compatible values.`);
}

export function canonicalJsonString(value) {
  return canonicalSerialize(value);
}

export function sha256Text(value) {
  if (typeof value !== "string") invalid("text to hash must be a string.");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value) {
  return sha256Text(canonicalJsonString(value));
}

export function validatePipelineScope(input, label = "scope") {
  if (!isPlainObject(input)) invalid(`${label} is required.`);
  for (const key of PIPELINE_SCOPE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || typeof input[key] !== "string") {
      invalid(`${label}.${key} must be an explicit string.`);
    }
  }
  for (const key of ["portfolioId", "tenantId", "businessId"]) {
    if (!input[key]) invalid(`${label}.${key} must be a non-empty string.`);
  }
  if (input.visibility !== "private") invalid(`${label}.visibility must be private.`);
  const extras = Object.keys(input).filter((key) => !PIPELINE_SCOPE_KEYS.includes(key));
  if (extras.length) invalid(`${label} contains unsupported keys: ${extras.join(", ")}.`);
  return Object.fromEntries(PIPELINE_SCOPE_KEYS.map((key) => [key, input[key]]));
}

export function pipelineScopeKey(scope) {
  const normalized = validatePipelineScope(scope);
  return canonicalJsonString(PIPELINE_SCOPE_KEYS.map((key) => normalized[key]));
}

export function samePipelineScope(left, right) {
  try {
    const a = validatePipelineScope(left);
    const b = validatePipelineScope(right);
    return PIPELINE_SCOPE_KEYS.every((key) => a[key] === b[key]);
  } catch {
    return false;
  }
}

export function requirePipelineString(value, label) {
  if (typeof value !== "string" || !value.trim()) invalid(`${label} is required.`);
  return value;
}

export function validatePipelinePrincipal(input, expectedRole, expectedScope) {
  if (!isPlainObject(input)) throw new GksScopeDeniedError("Authenticated MSP principal is required.");
  if (typeof input.principalId !== "string" || !input.principalId) {
    throw new GksScopeDeniedError("Authenticated MSP principal is invalid.");
  }
  if (input.role !== expectedRole) throw new GksScopeDeniedError("Authenticated MSP principal role is not permitted.");
  const principalScope = validatePipelineScope(input.scope, "authenticatedPrincipal.scope");
  const scope = validatePipelineScope(expectedScope);
  if (!samePipelineScope(principalScope, scope)) throw new GksScopeDeniedError("Authenticated MSP principal scope does not match the request.");
  return { principalId: input.principalId, role: input.role, scope: principalScope };
}

export function authorizePipelineRequest(input, { relayCredential, role, scope } = {}) {
  if (typeof relayCredential !== "string" || !relayCredential) {
    throw new GksBackendUnconfiguredError("GKS_PIPELINE_RELAY_CREDENTIAL is not configured.");
  }
  const suppliedCredential = isPlainObject(input) && typeof input.relayCredential === "string" ? input.relayCredential : null;
  const credentialMatches = suppliedCredential && Buffer.byteLength(suppliedCredential, "utf8") === Buffer.byteLength(relayCredential, "utf8")
    ? crypto.timingSafeEqual(Buffer.from(suppliedCredential, "utf8"), Buffer.from(relayCredential, "utf8"))
    : false;
  if (!credentialMatches) {
    throw new GksScopeDeniedError("Pipeline relay credential is invalid.");
  }
  const principal = validatePipelinePrincipal(input.authenticatedPrincipal, role, scope);
  return Object.freeze({ principalId: principal.principalId, role: principal.role, scope: principal.scope });
}

export function validateStageIdentities(input, runId, label = "stages") {
  if (!Array.isArray(input) || input.length !== PIPELINE_STAGE_CATALOG.length) invalid(`${label} must contain exactly the nine stage identities.`);
  const seen = new Set();
  const normalized = input.map((stage, index) => {
    if (!isPlainObject(stage)) invalid(`${label}[${index}] must be an object.`);
    const stageNumber = stage.stageNumber;
    if (!Number.isInteger(stageNumber) || !PIPELINE_STAGE_BY_NUMBER[stageNumber]) invalid(`${label}[${index}].stageNumber is invalid.`);
    const expected = PIPELINE_STAGE_BY_NUMBER[stageNumber];
    if (stage.pipelineStageId !== expected.pipelineStageId) invalid(`${label}[${index}].pipelineStageId does not match stage ${stageNumber}.`);
    if (seen.has(stageNumber)) invalid(`${label} contains duplicate stage ${stageNumber}.`);
    seen.add(stageNumber);
    for (const key of ["runId", "executionStepId", "attemptId"]) requirePipelineString(stage[key], `${label}[${index}].${key}`);
    if (stage.runId !== runId) invalid(`${label}[${index}].runId must match runId.`);
    return {
      stageNumber,
      pipelineStageId: stage.pipelineStageId,
      runId: stage.runId,
      executionStepId: stage.executionStepId,
      attemptId: stage.attemptId,
    };
  });
  if (seen.size !== PIPELINE_STAGE_CATALOG.length) invalid(`${label} must contain every stage from 9 through 17.`);
  return normalized;
}

function validateHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) invalid(`${label} must be a lower-case SHA-256 hash.`);
  return value;
}

function validateOffset(value, label, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) invalid(`${label} must be an integer between 0 and ${max}.`);
  return value;
}

function validateSource(source) {
  if (!isPlainObject(source)) invalid("source is required.");
  for (const field of SOURCE_ID_FIELDS) requirePipelineString(source[field], `source.${field}`);
  requirePipelineString(source.content, "source.content");
  validateHash(source.contentHash, "source.contentHash");
  if (sha256Text(source.content) !== source.contentHash) invalid("source.contentHash does not match source.content.");
  return {
    sourceId: source.sourceId,
    rawArtifactId: source.rawArtifactId,
    parsedArtifactId: source.parsedArtifactId,
    documentId: source.documentId,
    version: source.version,
    contentHash: source.contentHash,
    content: source.content,
  };
}

function validateChunks(chunks, source) {
  if (!Array.isArray(chunks) || chunks.length < 1) invalid("chunks must contain at least one chunk.");
  const ids = new Set();
  const normalized = chunks.map((chunk, index) => {
    if (!isPlainObject(chunk)) invalid(`chunks[${index}] must be an object.`);
    for (const field of ["chunkId", "parsedArtifactId", "text"]) requirePipelineString(chunk[field], `chunks[${index}].${field}`);
    if (chunk.parsedArtifactId !== source.parsedArtifactId) invalid(`chunks[${index}].parsedArtifactId must match source.parsedArtifactId.`);
    if (ids.has(chunk.chunkId)) invalid(`chunks contains duplicate chunkId ${chunk.chunkId}.`);
    ids.add(chunk.chunkId);
    if (!Number.isInteger(chunk.ordinal) || chunk.ordinal < 0) invalid(`chunks[${index}].ordinal must be a non-negative integer.`);
    const startOffset = validateOffset(chunk.startOffset, `chunks[${index}].startOffset`, source.content.length);
    const endOffset = validateOffset(chunk.endOffset, `chunks[${index}].endOffset`, source.content.length);
    if (endOffset <= startOffset) invalid(`chunks[${index}] must have a positive source span.`);
    if (source.content.slice(startOffset, endOffset) !== chunk.text) invalid(`chunks[${index}].text does not match its source offsets.`);
    validateHash(chunk.contentHash, `chunks[${index}].contentHash`);
    if (sha256Text(chunk.text) !== chunk.contentHash) invalid(`chunks[${index}].contentHash does not match chunk.text.`);
    return { chunkId: chunk.chunkId, parsedArtifactId: chunk.parsedArtifactId, ordinal: chunk.ordinal, text: chunk.text, contentHash: chunk.contentHash, startOffset, endOffset };
  });
  return { ids, chunks: normalized };
}

function validateMentions(mentions, chunksById) {
  if (!Array.isArray(mentions)) invalid("mentions must be an array.");
  const ids = new Set();
  return mentions.map((mention, index) => {
    if (!isPlainObject(mention)) invalid(`mentions[${index}] must be an object.`);
    for (const field of ["sourceMentionId", "resolutionKey", "semanticType", "name", "chunkId"]) requirePipelineString(mention[field], `mentions[${index}].${field}`);
    if (ids.has(mention.sourceMentionId)) invalid(`mentions contains duplicate sourceMentionId ${mention.sourceMentionId}.`);
    ids.add(mention.sourceMentionId);
    const chunk = chunksById.get(mention.chunkId);
    if (!chunk) invalid(`mentions[${index}].chunkId does not reference a chunk.`);
    const startOffset = validateOffset(mention.startOffset, `mentions[${index}].startOffset`, chunk.text.length);
    const endOffset = validateOffset(mention.endOffset, `mentions[${index}].endOffset`, chunk.text.length);
    if (endOffset <= startOffset) invalid(`mentions[${index}] must have a positive chunk span.`);
    if (chunk.text.slice(startOffset, endOffset) !== mention.name) invalid(`mentions[${index}].name does not match its chunk offsets.`);
    return { sourceMentionId: mention.sourceMentionId, resolutionKey: mention.resolutionKey, semanticType: mention.semanticType, name: mention.name, chunkId: mention.chunkId, startOffset, endOffset };
  });
}

export function validatePipelineBatch(input) {
  if (!isPlainObject(input)) invalid("pipeline batch is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const batchId = requirePipelineString(input.batchId, "batchId");
  const idempotencyKey = requirePipelineString(input.idempotencyKey, "idempotencyKey");
  const runId = requirePipelineString(input.runId, "runId");
  const scope = validatePipelineScope(input.scope);
  const stages = validateStageIdentities(input.stages, runId);
  const source = validateSource(input.source);
  const { chunks } = validateChunks(input.chunks, source);
  const mentions = validateMentions(input.mentions, new Map(chunks.map((chunk) => [chunk.chunkId, chunk])));
  if (!isPlainObject(input.policy) || typeof input.policy.allowEmbedding !== "boolean" || typeof input.policy.allowPublication !== "boolean") {
    invalid("policy.allowEmbedding and policy.allowPublication must be booleans.");
  }
  const policy = { allowEmbedding: input.policy.allowEmbedding, allowPublication: input.policy.allowPublication };
  const normalized = { schemaVersion: PIPELINE_SCHEMA_VERSION, batchId, idempotencyKey, scope, runId, stages, source, policy, chunks, mentions };
  return { ...normalized, batchHash: sha256Json(normalized) };
}

export function validatePipelineClaimRequest(input) {
  if (!isPlainObject(input)) invalid("pipeline claim request is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const scope = validatePipelineScope(input.scope);
  if (input.limit !== undefined && input.limit !== 1) invalid("pipeline claim limit must be 1.");
  return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope, limit: 1 };
}

function validateNonNegativeNumber(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) invalid(`${label} must be a non-negative finite number${integer ? " integer" : ""}.`);
  return value;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function validateIsoTimestamp(value, label) {
  requirePipelineString(value, label);
  if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO UTC timestamp.`);
  return value;
}

function validateIsoInterval(startedAt, finishedAt, label) {
  validateIsoTimestamp(startedAt, `${label}.startedAt`);
  validateIsoTimestamp(finishedAt, `${label}.finishedAt`);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) invalid(`${label}.finishedAt must not precede startedAt.`);
  return { startedAt, finishedAt };
}

export function validatePipelineMetrics(metrics, label = "metrics") {
  if (!isPlainObject(metrics)) invalid(`${label} is required.`);
  const keys = Object.keys(metrics).sort();
  if (keys.join("\u0000") !== [...PIPELINE_REQUIRED_METRICS].sort().join("\u0000")) invalid(`${label} must contain exactly the six required metric keys.`);
  return Object.fromEntries(PIPELINE_REQUIRED_METRICS.map((key) => [key, validateNonNegativeNumber(metrics[key], `${label}.${key}`)]));
}

function validateModel(model) {
  if (!isPlainObject(model)) invalid("receipt.model is required.");
  if (model.id !== PIPELINE_MODEL.id || model.revision !== PIPELINE_MODEL.revision || model.dimensions !== PIPELINE_MODEL.dimensions || model.metric !== PIPELINE_MODEL.metric) invalid("receipt.model does not match the frozen embedding model pin.");
  if (!isPlainObject(model.artifactHashes) || !Object.keys(model.artifactHashes).length) invalid("receipt.model.artifactHashes is required.");
  for (const [path, hash] of Object.entries(model.artifactHashes)) {
    requirePipelineString(path, "receipt.model.artifactHashes path");
    validateHash(hash, `receipt.model.artifactHashes.${path}`);
  }
  return { id: model.id, revision: model.revision, dimensions: model.dimensions, metric: model.metric, artifactHashes: { ...model.artifactHashes } };
}

function validateReceiptMetrics(metrics) {
  if (!isPlainObject(metrics)) invalid("receipt.metrics is required.");
  const expected = [13, 15, 16];
  const keys = Object.keys(metrics).sort();
  if (keys.join("\u0000") !== expected.map(String).sort().join("\u0000")) invalid("receipt.metrics must contain stages 13, 15, and 16 only.");
  return Object.fromEntries(expected.map((stage) => [stage, validatePipelineMetrics(metrics[stage], `receipt.metrics.${stage}`)]));
}

function validateLaneManifest(manifest) {
  if (!isPlainObject(manifest)) invalid("receipt.laneManifest is required.");
  const keys = Object.keys(manifest).sort();
  if (keys.join("\u0000") !== [...PIPELINE_LANES].sort().join("\u0000")) invalid("receipt.laneManifest must contain all six Tier4 lanes.");
  return Object.fromEntries(PIPELINE_LANES.map((lane) => {
    const item = manifest[lane];
    if (!isPlainObject(item) || !["ready", "not_applicable", "unsupported"].includes(item.status) || typeof item.reason !== "string") invalid(`receipt.laneManifest.${lane} is invalid.`);
    if (!Number.isInteger(item.objects) || item.objects < 0) invalid(`receipt.laneManifest.${lane}.objects must be a non-negative integer count.`);
    return [lane, { status: item.status, reason: item.reason, objects: item.objects }];
  }));
}

function validateBenchmark(benchmark) {
  if (!isPlainObject(benchmark)) invalid("receipt.benchmark is required.");
  requirePipelineString(benchmark.fixtureVersion, "receipt.benchmark.fixtureVersion");
  validateNonNegativeNumber(benchmark.queryCount, "receipt.benchmark.queryCount", true);
  for (const key of ["recallAt5", "mrr", "citationCorrectness"]) {
    validateNonNegativeNumber(benchmark[key], `receipt.benchmark.${key}`);
    if (benchmark[key] > 1) invalid(`receipt.benchmark.${key} must be at most 1.`);
  }
  validateNonNegativeNumber(benchmark.crossTenantLeaks, "receipt.benchmark.crossTenantLeaks", true);
  return {
    fixtureVersion: benchmark.fixtureVersion,
    queryCount: benchmark.queryCount,
    recallAt5: benchmark.recallAt5,
    mrr: benchmark.mrr,
    citationCorrectness: benchmark.citationCorrectness,
    crossTenantLeaks: benchmark.crossTenantLeaks,
  };
}

export function validatePipelineReceipt(input) {
  if (!isPlainObject(input)) invalid("pipeline receipt is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const scope = validatePipelineScope(input.scope);
  const runId = requirePipelineString(input.runId, "receipt.runId");
  const decisionId = requirePipelineString(input.decisionId, "receipt.decisionId");
  const decisionHash = validateHash(input.decisionHash, "receipt.decisionHash");
  const stages = validateStageIdentities(input.stages, runId, "receipt.stages");
  const graphReceiptHash = validateHash(input.graphReceiptHash, "receipt.graphReceiptHash");
  const derivedHash = validateHash(input.derivedHash, "receipt.derivedHash");
  if (!isPlainObject(input.executionTimes)) invalid("receipt.executionTimes is required.");
  const executionTimes = {};
  for (const stageNumber of [13, 15, 16]) {
    const times = input.executionTimes[stageNumber] ?? input.executionTimes[String(stageNumber)];
    if (!isPlainObject(times)) invalid(`receipt.executionTimes.${stageNumber} is required.`);
    executionTimes[stageNumber] = validateIsoInterval(times.startedAt, times.finishedAt, `receipt.executionTimes.${stageNumber}`);
  }
  if (Object.keys(input.executionTimes).some((key) => !["13", "15", "16"].includes(key))) invalid("receipt.executionTimes must contain stages 13, 15, and 16 only.");
  if (Date.parse(executionTimes[15].startedAt) < Date.parse(executionTimes[13].finishedAt) || Date.parse(executionTimes[16].startedAt) < Date.parse(executionTimes[15].finishedAt)) invalid("receipt.executionTimes must preserve Stage 13, 15, and 16 order.");
  requirePipelineString(input.snapshotId, "receipt.snapshotId");
  requirePipelineString(input.generation, "receipt.generation");
  const model = validateModel(input.model);
  if (!isPlainObject(input.transaction)) invalid("receipt.transaction is required.");
  for (const field of ["id", "frontier", "checkpoint"]) requirePipelineString(input.transaction[field], `receipt.transaction.${field}`);
  if (!isPlainObject(input.readback) || typeof input.readback.ok !== "boolean") invalid("receipt.readback is invalid.");
  const readback = { ok: input.readback.ok };
  for (const field of ["nodeCount", "edgeCount", "vectorCount", "citationCount"]) readback[field] = validateNonNegativeNumber(input.readback[field], `receipt.readback.${field}`, true);
  const laneManifest = validateLaneManifest(input.laneManifest);
  const metrics = validateReceiptMetrics(input.metrics);
  const benchmark = validateBenchmark(input.benchmark);
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope,
    runId,
    decisionId,
    decisionHash,
    stages,
    graphReceiptHash,
    derivedHash,
    executionTimes,
    snapshotId: input.snapshotId,
    generation: input.generation,
    model,
    transaction: { id: input.transaction.id, frontier: input.transaction.frontier, checkpoint: input.transaction.checkpoint },
    readback,
    laneManifest,
    metrics,
    benchmark,
  };
}

export function validatePipelineGraphReceipt(input) {
  if (!isPlainObject(input)) invalid("pipeline graph receipt is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const scope = validatePipelineScope(input.scope);
  const runId = requirePipelineString(input.runId, "graphReceipt.runId");
  const decisionId = requirePipelineString(input.decisionId, "graphReceipt.decisionId");
  const decisionHash = validateHash(input.decisionHash, "graphReceipt.decisionHash");
  const stages = validateStageIdentities(input.stages, runId, "graphReceipt.stages");
  if (!isPlainObject(input.transaction)) invalid("graphReceipt.transaction is required.");
  for (const field of ["id", "frontier", "checkpoint"]) requirePipelineString(input.transaction[field], `graphReceipt.transaction.${field}`);
  if (!isPlainObject(input.readback) || typeof input.readback.ok !== "boolean") invalid("graphReceipt.readback is invalid.");
  const readback = { ok: input.readback.ok };
  for (const field of ["nodeCount", "edgeCount"]) readback[field] = validateNonNegativeNumber(input.readback[field], `graphReceipt.readback.${field}`, true);
  const metrics = validatePipelineMetrics(input.metrics, "graphReceipt.metrics");
  const times = validateIsoInterval(input.startedAt, input.finishedAt, "graphReceipt");
  return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope, runId, decisionId, decisionHash, stages, transaction: { id: input.transaction.id, frontier: input.transaction.frontier, checkpoint: input.transaction.checkpoint }, readback, metrics, ...times };
}

export function validatePipelineStageFailureRequest(input) {
  if (!isPlainObject(input)) invalid("pipeline stage failure request is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const scope = validatePipelineScope(input.scope);
  const runId = requirePipelineString(input.runId, "runId");
  const decisionId = requirePipelineString(input.decisionId, "decisionId");
  const decisionHash = validateHash(input.decisionHash, "decisionHash");
  if (!isPlainObject(input.stage)) invalid("stage failure stage identity is required.");
  const stageNumber = input.stage.stageNumber;
  if (![13, 15, 16].includes(stageNumber)) invalid("worker stage failure is limited to Tier4 stages 13, 15, and 16.");
  const catalog = PIPELINE_STAGE_BY_NUMBER[stageNumber];
  if (!catalog || input.stage.pipelineStageId !== catalog.pipelineStageId) invalid("stage failure stage identity is invalid.");
  if (input.stage.runId !== runId) invalid("stage failure stage.runId must match runId.");
  const executionStepId = requirePipelineString(input.stage.executionStepId, "stage.executionStepId");
  const attemptId = requirePipelineString(input.stage.attemptId, "stage.attemptId");
  const times = validateIsoInterval(input.startedAt, input.finishedAt, "stageFailure");
  const metrics = validatePipelineMetrics(input.metrics);
  if (!isPlainObject(input.error)) invalid("stage failure error is required.");
  const code = requirePipelineString(input.error.code, "error.code");
  const message = requirePipelineString(input.error.message, "error.message");
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope,
    runId,
    decisionId,
    decisionHash,
    stage: { stageNumber, pipelineStageId: catalog.pipelineStageId, runId, executionStepId, attemptId },
    ...times,
    metrics,
    error: { code, message },
  };
}

export function validatePipelineGateRequest(input) {
  if (!isPlainObject(input)) invalid("pipeline gate request is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: validatePipelineScope(input.scope), decisionId: requirePipelineString(input.decisionId, "decisionId"), decisionHash: validateHash(input.decisionHash, "decisionHash") };
}

export function validatePipelinePublicationReceipt(input) {
  if (!isPlainObject(input)) invalid("pipeline publication receipt is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const scope = validatePipelineScope(input.scope);
  const runId = requirePipelineString(input.runId, "publicationReceipt.runId");
  const decisionId = requirePipelineString(input.decisionId, "publicationReceipt.decisionId");
  const decisionHash = validateHash(input.decisionHash, "publicationReceipt.decisionHash");
  requirePipelineString(input.snapshotId, "publicationReceipt.snapshotId");
  requirePipelineString(input.generation, "publicationReceipt.generation");
  validateHash(input.receiptHash, "publicationReceipt.receiptHash");
  validateIsoTimestamp(input.publishedAt, "publicationReceipt.publishedAt");
  validateHash(input.pointerHash, "publicationReceipt.pointerHash");
  requirePipelineString(input.modelRevision, "publicationReceipt.modelRevision");
  requirePipelineString(input.transactionFrontier, "publicationReceipt.transactionFrontier");
  if (!isPlainObject(input.readback) || input.readback.ok !== true) invalid("publicationReceipt.readback.ok must be true.");
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope,
    runId,
    decisionId,
    decisionHash,
    snapshotId: input.snapshotId,
    generation: input.generation,
    receiptHash: input.receiptHash,
    publishedAt: input.publishedAt,
    pointerHash: input.pointerHash,
    modelRevision: input.modelRevision,
    transactionFrontier: input.transactionFrontier,
    readback: { ok: true },
  };
}

export function validatePipelineEvidenceRequest(input) {
  if (!isPlainObject(input)) invalid("pipeline evidence request is required.");
  if (input.schemaVersion !== PIPELINE_SCHEMA_VERSION) invalid("Invalid GenesisRAG17 schemaVersion.");
  const afterCursor = input.afterCursor ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isInteger(afterCursor) || afterCursor < 0) invalid("afterCursor must be a non-negative integer.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) invalid("limit must be an integer between 1 and 500.");
  return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: validatePipelineScope(input.scope), runId: requirePipelineString(input.runId, "runId"), afterCursor, limit };
}

export function hashPipelineDecision(decision) {
  if (!isPlainObject(decision)) invalid("decision is required.");
  const { decisionHash: ignored, ...withoutHash } = decision;
  return sha256Json(withoutHash);
}

export function hashPipelineReceipt(receipt) {
  return sha256Json(receipt);
}

export function hashPipelineGraphReceipt(receipt) {
  return sha256Json(receipt);
}

export function hashPipelinePublicationReceipt(receipt) {
  return sha256Json(receipt);
}

export function pipelineScopeFromRequest(input) {
  if (!isPlainObject(input)) invalid("pipeline request is required.");
  return input.scope ?? input.batch?.scope ?? input.receipt?.scope ?? input.publicationReceipt?.scope;
}
