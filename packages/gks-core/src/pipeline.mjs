// @req FR-109, FR-110 — implement the approved GenesisRAG17 GKS stages and quality authority.
// @spec ADR-GKS-GENESISRAG17.md, ADR-GKS-FACT-EXTRACT.md, ADR-GKS-TEMPORAL-MAP.md
// @tested tests/contract/pipeline-genesisrag17.test.mjs, tests/contract/temporal-engine-parity.test.mjs

import {
  PIPELINE_CONFIDENCE,
  PIPELINE_ONTOLOGY_VERSION,
  PIPELINE_QUALITY_THRESHOLDS,
  PIPELINE_STAGE_BY_NUMBER,
  PIPELINE_SCHEMA_VERSION,
  canonicalJson,
  hashPipelineDecision,
  requirePipelineString,
  sha256Json,
  validatePipelineBatch,
  validatePipelineReceipt,
} from "@freshair129/gks-contracts";
import { compareTemporalOrder } from "./temporal.mjs";

const RELATION_ALIASES = new Map([
  ["works for", "WORKS_FOR"],
  ["employed by", "WORKS_FOR"],
  ["works_for", "WORKS_FOR"],
  ["purchased", "PURCHASED"],
  ["bought", "PURCHASED"],
  ["purchased from", "PURCHASED"],
  ["purchased_from", "PURCHASED"],
]);
const OPTIONAL_TEMPORAL_UNSUPPORTED_REASONS = new Set([
  "native_temporal_query_api_unavailable",
  "native_temporal_traverse_unavailable",
]);
const ENDPOINT_TYPES = Object.freeze({ PERSON: "PERSON", ORGANIZATION: "ORGANIZATION", PRODUCT: "PRODUCT" });

function normalizedLabel(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function normalizeType(value) {
  return normalizedLabel(value).replace(/ /g, "_").toUpperCase();
}

function normalizePredicate(value) {
  const normalized = normalizedLabel(value);
  return RELATION_ALIASES.get(normalized) ?? null;
}

function slug(value) {
  const result = normalizedLabel(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "entity";
}

function entityId(scope, resolutionKey) {
  const digest = sha256Json({ scope, resolutionKey });
  return `gks:entity/${slug(resolutionKey)}-${digest.slice(0, 32)}`;
}

function factId(scope, batchId, candidate) {
  return `gks:fact/${sha256Json({ scope, batchId, chunkId: candidate.chunkId, sourceMentionIds: candidate.sourceMentionIds, rawPredicate: candidate.rawPredicate ?? null, subjectId: candidate.subjectId ?? null, objectId: candidate.objectId ?? null }).slice(0, 32)}`;
}

function sourceReferences(source, chunkId, sourceMentionIds) {
  return {
    sourceId: source.sourceId,
    rawArtifactId: source.rawArtifactId,
    parsedArtifactId: source.parsedArtifactId,
    chunkId,
    sourceMentionIds: [...new Set(sourceMentionIds)],
  };
}

function occurrenceMatches(mentions, text, value) {
  const normalized = normalizedLabel(value);
  return mentions.filter((mention) => normalizedLabel(mention.name) === normalized && text.slice(mention.startOffset, mention.endOffset).toLowerCase() === mention.name.toLowerCase());
}

function nearestMention(mentions, boundary, direction) {
  const eligible = mentions.filter((mention) => direction === "before" ? mention.endOffset <= boundary : mention.startOffset >= boundary);
  eligible.sort((left, right) => direction === "before" ? right.endOffset - left.endOffset : left.startOffset - right.startOffset);
  return eligible[0] ?? null;
}

function parseStructuredClaim(text, mentions) {
  let value = null;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object" && typeof parsed.subject === "string" && typeof parsed.predicate === "string" && (typeof parsed.object === "string" || typeof parsed.value === "string")) {
      value = { subject: parsed.subject, predicate: parsed.predicate, object: parsed.object ?? parsed.value };
    }
  } catch {
    // The structured form may be a line emitted by a parser rather than JSON.
  }
  if (!value) {
    const match = text.match(/subject\s*[:=]\s*["']?([^,;|]+)["']?\s*[,;|]\s*predicate\s*[:=]\s*["']?([^,;|]+)["']?\s*[,;|]\s*(?:object|value)\s*[:=]\s*["']?([^,;|]+)["']?/i);
    if (match) value = { subject: match[1].trim(), predicate: match[2].trim(), object: match[3].trim() };
  }
  if (!value || /[?]/.test(text) || /\b(?:does not|did not|didn't|doesn't|never)\b/i.test(text)) return null;
  const subject = occurrenceMatches(mentions, text, value.subject)[0] ?? null;
  const object = occurrenceMatches(mentions, text, value.object)[0] ?? null;
  return { ...value, subject, object };
}

function parseExplicitClaims(text, mentions) {
  const claims = [];
  const relationPattern = /\b(works\s+for|employed\s+by|works_for|purchased|bought|purchased_from)\b/gi;
  for (const match of text.matchAll(relationPattern)) {
    const sentenceStart = Math.max(text.lastIndexOf(".", match.index - 1), text.lastIndexOf("!", match.index - 1), text.lastIndexOf("?", match.index - 1)) + 1;
    const sentenceEndMark = [text.indexOf(".", match.index + match[0].length), text.indexOf("!", match.index + match[0].length), text.indexOf("?", match.index + match[0].length)].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? text.length;
    const sentenceEnd = sentenceEndMark < text.length ? sentenceEndMark + 1 : text.length;
    const sentence = text.slice(sentenceStart, sentenceEnd).trim();
    if (sentence.includes("?") || /^(?:no|not|never|nobody|nothing)\b/i.test(sentence) || /\b(?:does not|did not|didn't|doesn't|never)\b/i.test(sentence)) continue;
    const sentenceMentions = mentions.filter((mention) => mention.startOffset >= sentenceStart && mention.endOffset <= sentenceEnd);
    const subject = nearestMention(sentenceMentions, match.index, "before");
    const object = nearestMention(sentenceMentions, match.index + match[0].length, "after");
    if (subject && object) claims.push({ subject, object, predicate: match[0], confidence: PIPELINE_CONFIDENCE.explicit, basis: "explicit" });
  }
  return claims;
}

function temporalClaim(text, now) {
  const dates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?\b/g)].map((match) => match[0]);
  let validFrom = "not_applicable";
  let validTo = "not_applicable";
  if (dates.length) {
    validFrom = dates[0];
    validTo = dates.length > 1 ? dates[1] : null;
  } else if (/\b(?:not[ -]applicable|no temporal claim|timeless)\b/i.test(text)) {
    validFrom = "not_applicable";
    validTo = "not_applicable";
  }
  const temporal = { validFrom, validTo, txFrom: now, txTo: null };
  const order = compareTemporalOrder({ validFrom: validFrom === "not_applicable" ? undefined : validFrom, validTo: validTo === "not_applicable" ? undefined : validTo, recordedAt: now, supersededAt: undefined });
  return order.length ? { temporal, errors: order } : { temporal, errors: [] };
}

function chooseEntity(mentionsByName, name) {
  return mentionsByName.get(normalizedLabel(name))?.[0] ?? null;
}

function heldRecord(candidate, reason) {
  return {
    id: candidate.factId,
    reason,
    predicate: candidate.rawPredicate ?? candidate.predicate ?? null,
    confidence: candidate.confidence,
    sourceReferences: candidate.sourceReferences,
  };
}

function distinctSourceReferences(facts, source, fallbackChunkId, fallbackMentionIds = []) {
  const byKey = new Map();
  for (const fact of facts) {
    const ref = fact.sourceReferences;
    byKey.set(JSON.stringify(ref), ref);
  }
  if (!byKey.size) {
    const ref = sourceReferences(source, fallbackChunkId, fallbackMentionIds);
    byKey.set(JSON.stringify(ref), ref);
  }
  return [...byKey.values()];
}

export function buildPipelineDecision(input, { now = new Date().toISOString(), canonicalRefs = new Map() } = {}) {
  const batch = input?.batchHash ? input : validatePipelineBatch(input);
  const chunks = [...batch.chunks].sort((left, right) => left.ordinal - right.ordinal);
  const mentionsByChunk = new Map();
  const mentionsByName = new Map();
  const entityByResolution = new Map();
  const mentionsById = new Map();
  const stageExecutionTimes = {};
  const stage9StartedMs = Date.now();
  for (const mention of batch.mentions) {
    const resolutionIdentity = normalizedLabel(mention.resolutionKey);
    mentionsByChunk.set(mention.chunkId, [...(mentionsByChunk.get(mention.chunkId) ?? []), mention]);
    mentionsByName.set(normalizedLabel(mention.name), [...(mentionsByName.get(normalizedLabel(mention.name)) ?? []), mention]);
    mentionsById.set(mention.sourceMentionId, mention);
    if (!entityByResolution.has(resolutionIdentity)) {
      entityByResolution.set(resolutionIdentity, {
        id: canonicalRefs.get(mention.resolutionKey) ?? canonicalRefs.get(resolutionIdentity) ?? entityId(batch.scope, resolutionIdentity),
        name: mention.name,
        semanticType: mention.semanticType,
        mentions: [],
        metadata: { semanticType: mention.semanticType, resolutionKey: resolutionIdentity },
      });
    }
    entityByResolution.get(resolutionIdentity).mentions.push(mention.sourceMentionId);
  }
  const entityByMentionId = new Map();
  for (const mention of batch.mentions) entityByMentionId.set(mention.sourceMentionId, entityByResolution.get(normalizedLabel(mention.resolutionKey)));
  stageExecutionTimes[9] = { startedAt: new Date(stage9StartedMs).toISOString(), finishedAt: new Date().toISOString() };

  const candidates = [];
  const stage10Held = [];
  let stage10In = 0;
  let stage10Inferred = 0;
  const stage10StartedMs = Date.now();
  for (const chunk of chunks) {
    const chunkMentions = mentionsByChunk.get(chunk.chunkId) ?? [];
    stage10In += chunkMentions.length;
    const structured = parseStructuredClaim(chunk.text, chunkMentions);
    let claims = structured?.subject && structured?.object
      ? [{ ...structured, confidence: PIPELINE_CONFIDENCE.structured, basis: "structured" }]
      : parseExplicitClaims(chunk.text, chunkMentions);
    if (!claims.length && chunkMentions.length >= 2) {
      claims = [{ subject: chunkMentions[0], object: chunkMentions[1], predicate: "INFERRED", confidence: PIPELINE_CONFIDENCE.inferredMax, basis: "inferred" }];
      stage10Inferred += 1;
    }
    for (const claim of claims) {
      const subjectMention = claim.subject?.sourceMentionId ? claim.subject : chooseEntity(mentionsByName, claim.subject);
      const objectMention = claim.object?.sourceMentionId ? claim.object : chooseEntity(mentionsByName, claim.object);
      const sourceMentionIds = [subjectMention?.sourceMentionId, objectMention?.sourceMentionId].filter(Boolean);
      const sourceRefs = sourceReferences(batch.source, chunk.chunkId, sourceMentionIds);
      const candidate = {
        chunkId: chunk.chunkId,
        sourceMentionIds,
        rawPredicate: claim.predicate,
        confidence: claim.confidence,
        basis: claim.basis,
        subjectId: subjectMention ? entityByMentionId.get(subjectMention.sourceMentionId)?.id : null,
        objectId: objectMention ? entityByMentionId.get(objectMention.sourceMentionId)?.id : null,
        sourceReferences: sourceRefs,
      };
      candidate.factId = factId(batch.scope, batch.batchId, candidate);
      if (candidate.confidence < PIPELINE_CONFIDENCE.writeFloor) stage10Held.push(heldRecord(candidate, "confidence_below_write_floor"));
      candidates.push(candidate);
    }
  }
  stageExecutionTimes[10] = { startedAt: new Date(stage10StartedMs).toISOString(), finishedAt: new Date().toISOString() };

  const facts = [];
  const held = [...stage10Held];
  let stage12Unmapped = 0;
  let stage12Invalid = 0;
  const ontologyCandidates = [];
  const stage11StartedMs = Date.now();
  for (const candidate of candidates) {
    const predicate = normalizePredicate(candidate.rawPredicate);
    if (!predicate) {
      if (candidate.confidence >= PIPELINE_CONFIDENCE.writeFloor) held.push(heldRecord(candidate, "unknown_predicate"));
      continue;
    }
    if (candidate.confidence < PIPELINE_CONFIDENCE.writeFloor) continue;
    const subject = [...entityByResolution.values()].find((entity) => entity.id === candidate.subjectId);
    const object = [...entityByResolution.values()].find((entity) => entity.id === candidate.objectId);
    const subjectType = normalizeType(subject?.semanticType);
    const objectType = normalizeType(object?.semanticType);
    const validEndpoint = predicate === "WORKS_FOR"
      ? subjectType === ENDPOINT_TYPES.PERSON && objectType === ENDPOINT_TYPES.ORGANIZATION
      : (subjectType === ENDPOINT_TYPES.PERSON || subjectType === ENDPOINT_TYPES.ORGANIZATION) && objectType === ENDPOINT_TYPES.PRODUCT;
    if (!validEndpoint) {
      held.push(heldRecord({ ...candidate, predicate }, "invalid_endpoint"));
      continue;
    }
    ontologyCandidates.push({ ...candidate, predicate });
  }
  stageExecutionTimes[11] = { startedAt: new Date(stage11StartedMs).toISOString(), finishedAt: new Date().toISOString() };
  const stage12StartedMs = Date.now();
  for (const candidate of ontologyCandidates) {
    const { temporal, errors } = temporalClaim(chunks.find((chunk) => chunk.chunkId === candidate.chunkId)?.text ?? "", now);
    if (temporal.validFrom === "not_applicable") stage12Unmapped += 1;
    if (errors.length) {
      stage12Invalid += 1;
      held.push(heldRecord({ ...candidate, predicate }, "invalid_temporal_order"));
      continue;
    }
    facts.push({
      id: candidate.factId,
      subjectId: candidate.subjectId,
      predicate: candidate.predicate,
      objectId: candidate.objectId,
      confidence: candidate.confidence,
      temporal,
      sourceReferences: candidate.sourceReferences,
      basis: candidate.basis,
      pipelineVersion: PIPELINE_SCHEMA_VERSION,
    });
  }
  stageExecutionTimes[12] = { startedAt: new Date(stage12StartedMs).toISOString(), finishedAt: new Date().toISOString() };

  const entityList = [...entityByResolution.values()].map((entity) => ({
    id: entity.id,
    name: entity.name,
    semanticType: entity.semanticType,
    metadata: entity.metadata,
    mentions: [...new Set(entity.mentions)],
  }));
  const graph = {
    nodes: entityList.map((entity) => ({ id: entity.id, semanticType: entity.semanticType, metadata: entity.metadata })),
    edges: facts.map((fact) => ({ id: fact.id, from: fact.subjectId, predicate: fact.predicate, to: fact.objectId, confidence: fact.confidence, temporal: fact.temporal, sourceReferences: fact.sourceReferences })),
  };
  const expectedGraphReadback = {
    nodeCount: 2 + chunks.length + entityList.length + facts.length + held.length,
    edgeCount: 1 + chunks.length + batch.mentions.length + (2 * facts.length) + held.length,
  };
  const decision = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    decisionId: `gks:decision/${sha256Json({ scope: batch.scope, batchId: batch.batchId, batchHash: batch.batchHash }).slice(0, 32)}`,
    batchId: batch.batchId,
    scope: batch.scope,
    runId: batch.runId,
    stages: [...batch.stages].sort((left, right) => left.stageNumber - right.stageNumber),
    source: batch.source,
    chunks,
    entities: entityList,
    facts,
    held,
    // Enrichment is committed only after the worker's graph receipt. Keeping
    // this initial field empty makes the decision immutable while the actual
    // derived rows receive their own receipt/hash at Stage 14.
    derived: [],
    mentions: batch.mentions,
    graph,
    expectedGraphReadback,
    stageMetrics: {
      9: { records_in: batch.mentions.length, records_out: entityList.length, records_quarantined: 0 },
      10: { records_in: stage10In, records_out: candidates.length, records_quarantined: stage10Inferred },
      11: { records_in: candidates.length, records_out: ontologyCandidates.length, records_quarantined: Math.max(0, candidates.length - ontologyCandidates.length) },
      12: { records_in: ontologyCandidates.length, records_out: facts.length, records_quarantined: stage12Invalid, unmapped: stage12Unmapped },
      13: { records_in: entityList.length + facts.length, records_out: graph.edges.length, records_quarantined: 0 },
      // Stage 14 runs only after the worker acknowledges the graph receipt.
      // Its output count is measured from that committed enrichment payload.
      14: { records_in: entityList.length, records_out: 0, records_quarantined: 0 },
    },
    policy: batch.policy,
    ontologyVersion: PIPELINE_ONTOLOGY_VERSION,
    pipelineVersion: PIPELINE_SCHEMA_VERSION,
  };
  decision.decisionHash = hashPipelineDecision(decision);
  const normalizedDecision = canonicalJson(decision);
  Object.defineProperty(normalizedDecision, "stageExecutionTimes", { value: stageExecutionTimes, enumerable: false });
  return normalizedDecision;
}

/**
 * Compute physical final readback expectations from the immutable decision
 * and the separately committed Stage 14 payload. The decision itself cannot
 * contain a final projection because enrichment has not run at submission.
 */
export function pipelineReadbackExpectations(decision, derived = []) {
  const rows = Array.isArray(derived) ? derived : [];
  const facts = decision.facts ?? [];
  const held = decision.held ?? [];
  const chunks = decision.chunks ?? [];
  const mentions = decision.mentions ?? [];
  const entities = decision.entities ?? [];
  const graph = decision.expectedGraphReadback ?? {
    nodeCount: 2 + chunks.length + entities.length + facts.length + held.length,
    edgeCount: 1 + chunks.length + mentions.length + (2 * facts.length) + held.length,
  };
  const derivedChunkEdges = rows.reduce((sum, row) => sum + new Set((row?.sourceReferences ?? []).map((reference) => reference.chunkId)).size, 0);
  const expectedReadback = {
    nodeCount: graph.nodeCount + rows.length,
    edgeCount: graph.edgeCount + rows.length + derivedChunkEdges,
    vectorCount: decision.policy?.allowEmbedding ? chunks.length : 0,
    citationCount: chunks.length,
  };
  const allFactsNotApplicable = facts.every((fact) => fact.temporal?.validFrom === "not_applicable" && fact.temporal?.validTo === "not_applicable");
  const expectedLaneObjects = {
    vector: expectedReadback.vectorCount,
    lexical: chunks.length,
    graph: expectedReadback.edgeCount,
    sqlite: expectedReadback.nodeCount,
    bitemporal: allFactsNotApplicable ? 0 : facts.length,
    provenance: chunks.length,
  };
  return { expectedReadback, expectedLaneObjects };
}

/**
 * Stage 14 is evaluated after the graph receipt. It consumes the immutable
 * decision and occurrence index and returns a separately hashable payload;
 * neither the original decision nor its decisionHash is mutated.
 */
export function derivePipelineSummaries(decision, { now = new Date().toISOString() } = {}) {
  const mentions = decision.mentions ?? [];
  return (decision.entities ?? []).map((entity) => {
    const entityMentionIds = new Set(entity.mentions ?? []);
    const entityFacts = (decision.facts ?? []).filter((fact) => fact.subjectId === entity.id || fact.objectId === entity.id);
    const entityChunks = new Set(mentions.filter((mention) => entityMentionIds.has(mention.sourceMentionId)).map((mention) => mention.chunkId));
    const fallbackMention = mentions.find((mention) => entityMentionIds.has(mention.sourceMentionId));
    const fallbackChunkId = fallbackMention?.chunkId ?? decision.chunks?.[0]?.chunkId;
    const references = distinctSourceReferences(entityFacts, decision.source, fallbackChunkId, fallbackMention ? [fallbackMention.sourceMentionId] : []);
    return {
      id: `gks:derived/${sha256Json({ entityId: entity.id, batchId: decision.batchId }).slice(0, 32)}`,
      entityId: entity.id,
      derivationMethod: "enrich_v1",
      documentCount: new Set([decision.source.documentId]).size,
      chunkCount: entityChunks.size,
      factCount: entityFacts.length,
      sourceReferences: references,
      pipelineVersion: PIPELINE_SCHEMA_VERSION,
      generatedAt: now,
    };
  });
}

function dimension(result, critical, reasons = []) {
  return { result, critical, reasons: [...new Set(reasons)] };
}

function sameScope(left, right) {
  return left && right && ["portfolioId", "tenantId", "businessId", "workspaceId", "agentId", "visibility"].every((key) => left[key] === right[key]);
}

function knownSourceReference(reference, decision, knownChunkIds, knownMentionIds) {
  if (!reference || reference.sourceId !== decision.source?.sourceId || reference.rawArtifactId !== decision.source?.rawArtifactId || reference.parsedArtifactId !== decision.source?.parsedArtifactId) return false;
  if (!knownChunkIds.has(reference.chunkId) || !Array.isArray(reference.sourceMentionIds) || !reference.sourceMentionIds.length) return false;
  const mentionsById = new Map((decision.mentions ?? []).map((mention) => [mention.sourceMentionId, mention]));
  return reference.sourceMentionIds.every((id) => knownMentionIds.has(id) && mentionsById.get(id)?.chunkId === reference.chunkId);
}

export function evaluatePipelineQuality(decision, receipt, { graphReceipt = null, derived = graphReceipt?.derived ?? [], policy = decision.policy } = {}) {
  const normalizedReceipt = receipt ? (receipt.model ? validatePipelineReceipt(receipt) : receipt) : null;
  const { expectedReadback, expectedLaneObjects } = pipelineReadbackExpectations(decision, derived);
  const facts = decision.facts ?? [];
  const allFactsNotApplicable = facts.every((fact) => fact.temporal?.validFrom === "not_applicable" && fact.temporal?.validTo === "not_applicable");
  const dataReasons = [];
  const knownChunkIds = new Set((decision.chunks ?? []).map((chunk) => chunk.chunkId));
  const knownMentionIds = new Set((decision.mentions ?? []).map((mention) => mention.sourceMentionId));
  if (!knownMentionIds.size) for (const entity of decision.entities ?? []) for (const mentionId of entity.mentions ?? []) knownMentionIds.add(mentionId);
  for (const fact of decision.facts ?? []) {
    if (!knownSourceReference(fact.sourceReferences, decision, knownChunkIds, knownMentionIds)) dataReasons.push(`fact ${fact.id ?? fact.factId} is missing source references.`);
  }
  for (const held of decision.held ?? []) {
    if (!knownSourceReference(held.sourceReferences, decision, knownChunkIds, knownMentionIds)) dataReasons.push(`held ${held.id ?? held.factId} is missing source references.`);
  }
  const derivedIds = new Set();
  if (!Array.isArray(derived) || derived.length !== (decision.entities ?? []).length) {
    dataReasons.push(`Stage 14 derived summary count does not match entity count (${decision.entities?.length ?? 0}).`);
  } else {
    const entities = decision.entities ?? [];
    const entityIds = new Set(entities.map((entity) => entity.id));
    for (const row of derived) {
      if (!row || typeof row.id !== "string" || derivedIds.has(row.id) || !entityIds.has(row.entityId)) {
        dataReasons.push("Stage 14 derived summary identity is invalid or duplicated.");
        continue;
      }
      derivedIds.add(row.id);
      if (!Array.isArray(row.sourceReferences) || !row.sourceReferences.length || row.sourceReferences.some((reference) => !knownSourceReference(reference, decision, knownChunkIds, knownMentionIds))) {
        dataReasons.push(`derived ${row.id} is missing source references.`);
      }
      const entity = entities.find((candidate) => candidate.id === row.entityId);
      const entityMentionIds = new Set(entity?.mentions ?? []);
      const expectedChunkCount = new Set((decision.mentions ?? []).filter((mention) => entityMentionIds.has(mention.sourceMentionId)).map((mention) => mention.chunkId)).size;
      const expectedFactCount = (decision.facts ?? []).filter((fact) => fact.subjectId === row.entityId || fact.objectId === row.entityId).length;
      const expectedCounts = { documentCount: entity ? new Set([decision.source?.documentId]).size : 0, chunkCount: expectedChunkCount, factCount: expectedFactCount };
      for (const field of ["documentCount", "chunkCount", "factCount"]) {
        if (!Number.isInteger(row[field]) || row[field] < 0) dataReasons.push(`derived ${row.id} has an invalid ${field}.`);
        else if (row[field] !== expectedCounts[field]) dataReasons.push(`derived ${row.id} ${field} ${row[field]} does not match expected ${expectedCounts[field]}.`);
      }
    }
  }
  const data = dimension(dataReasons.length ? "FAIL" : "PASS", Boolean(dataReasons.length), dataReasons);

  const graphReasons = [];
  if (!graphReceipt) graphReasons.push("actual Tier4 graph receipt is missing.");
  else {
    if (!sameScope(graphReceipt.scope, decision.scope) || graphReceipt.runId !== decision.runId || graphReceipt.decisionId !== decision.decisionId || graphReceipt.decisionHash !== decision.decisionHash) graphReasons.push("Tier4 graph receipt identity does not match the immutable decision.");
    if (!graphReceipt.readback?.ok) graphReasons.push("Tier4 graph readback is not ok.");
    else {
      const expected = decision.expectedGraphReadback ?? {};
      for (const field of ["nodeCount", "edgeCount"]) if (graphReceipt.readback[field] !== expected[field]) graphReasons.push(`Tier4 graph readback ${field} does not match expected ${expected[field]}.`);
    }
  }
  if (!normalizedReceipt) graphReasons.push("actual Tier4 final worker receipt is missing.");
  else {
    if (!sameScope(normalizedReceipt.scope, decision.scope) || normalizedReceipt.runId !== decision.runId || normalizedReceipt.decisionId !== decision.decisionId || normalizedReceipt.decisionHash !== decision.decisionHash) graphReasons.push("Tier4 final receipt identity does not match the immutable decision.");
    if (!normalizedReceipt.readback.ok) graphReasons.push("Tier4 final readback is not ok.");
    else {
      const expected = expectedReadback;
      for (const field of ["nodeCount", "edgeCount", "vectorCount", "citationCount"]) if (normalizedReceipt.readback[field] !== expected[field]) graphReasons.push(`Tier4 final readback ${field} does not match expected ${expected[field]}.`);
    }
    if (!graphReceipt || normalizedReceipt.graphReceiptHash !== graphReceipt.graphReceiptHash) graphReasons.push("final receipt graphReceiptHash does not match the graph receipt.");
    if (!graphReceipt || normalizedReceipt.derivedHash !== graphReceipt.derivedHash) graphReasons.push("final receipt derivedHash does not match the committed enrichment.");
    for (const [lane, item] of Object.entries(normalizedReceipt.laneManifest ?? {})) {
      const expectedObjects = expectedLaneObjects[lane];
      const temporalNotApplicable = lane === "bitemporal" && allFactsNotApplicable && expectedObjects === 0 && item.status === "not_applicable" && item.objects === 0;
      const temporalUnsupported = lane === "bitemporal" && item.status === "unsupported" && item.objects === 0 && [...OPTIONAL_TEMPORAL_UNSUPPORTED_REASONS].some((reason) => item.reason === reason || item.reason.startsWith(`${reason}:`));
      if (temporalNotApplicable || temporalUnsupported) continue;
      if (item.status !== "ready") graphReasons.push(`${lane} lane is ${item.status}.`);
      else if (Number.isInteger(expectedObjects) && item.objects !== expectedObjects) graphReasons.push(`${lane} lane object count ${item.objects} does not match expected ${expectedObjects}.`);
    }
  }
  const graph = dimension(graphReasons.length ? "FAIL" : "PASS", !graphReceipt || !normalizedReceipt || graphReasons.length > 0, graphReasons);

  const knowledgeReasons = [];
  if (decision.ontologyVersion !== PIPELINE_ONTOLOGY_VERSION) knowledgeReasons.push("ontology version is not ontology_v1.");
  if (!policy.allowEmbedding) knowledgeReasons.push("policy denies embedding.");
  if ((decision.held ?? []).length) knowledgeReasons.push(`${decision.held.length} fact(s) remain held for review.`);
  const knowledgeCritical = knowledgeReasons.some((reason) => reason.includes("ontology") || reason.includes("policy"));
  const knowledge = dimension(knowledgeCritical ? "FAIL" : knowledgeReasons.length ? "WARN" : "PASS", knowledgeCritical, knowledgeReasons);

  const securityReasons = [];
  if (!decision.scope?.tenantId || !decision.scope?.portfolioId || !decision.scope?.businessId) securityReasons.push("decision scope is incomplete.");
  if (normalizedReceipt?.benchmark?.crossTenantLeaks !== 0) securityReasons.push("retrieval benchmark reported a cross-tenant leak.");
  const security = dimension(securityReasons.length ? "FAIL" : "PASS", securityReasons.length > 0, securityReasons);

  const retrievalReasons = [];
  const benchmark = normalizedReceipt?.benchmark;
  if (!benchmark) retrievalReasons.push("retrieval benchmark is missing.");
  else {
    if (benchmark.queryCount <= 0) retrievalReasons.push("retrieval benchmark queryCount must be greater than zero.");
    if (benchmark.recallAt5 < PIPELINE_QUALITY_THRESHOLDS.recallAt5) retrievalReasons.push(`recallAt5 ${benchmark.recallAt5} is below ${PIPELINE_QUALITY_THRESHOLDS.recallAt5}.`);
    if (benchmark.mrr < PIPELINE_QUALITY_THRESHOLDS.mrr) retrievalReasons.push(`mrr ${benchmark.mrr} is below ${PIPELINE_QUALITY_THRESHOLDS.mrr}.`);
    if (benchmark.citationCorrectness !== PIPELINE_QUALITY_THRESHOLDS.citationCorrectness) retrievalReasons.push("citation correctness is below 1.");
    if (benchmark.crossTenantLeaks !== PIPELINE_QUALITY_THRESHOLDS.crossTenantLeaks) retrievalReasons.push("cross-tenant leak count is non-zero.");
  }
  const retrieval = dimension(retrievalReasons.length ? "FAIL" : "PASS", retrievalReasons.length > 0, retrievalReasons);
  const dimensions = { data, graph, knowledge, security, retrieval };
  const all = Object.values(dimensions);
  const verdict = all.some((item) => item.result === "FAIL") ? "FAIL" : all.some((item) => item.result === "WARN") ? "WARN" : "PASS";
  return {
    verdict,
    allowPublication: Boolean(policy.allowPublication && verdict === "PASS"),
    dimensions,
    receiptHash: normalizedReceipt ? sha256Json(normalizedReceipt) : null,
    graphReceiptHash: graphReceipt?.graphReceiptHash ?? null,
    derivedHash: graphReceipt?.derivedHash ?? null,
  };
}

export function pipelineStageMetrics(decision, stageNumber, { durationMs = 0, errorCount = 0, retryCount = 0 } = {}) {
  const measured = decision.stageMetrics?.[stageNumber] ?? decision.stageMetrics?.[String(stageNumber)];
  if (measured) return {
    records_in: measured.records_in ?? 0,
    records_out: measured.records_out ?? 0,
    records_quarantined: measured.records_quarantined ?? 0,
    error_count: errorCount,
    retry_count: retryCount,
    duration_ms: durationMs,
  };
  const facts = decision.facts?.length ?? 0;
  const held = decision.held?.length ?? 0;
  const recordsIn = stageNumber === 9 ? decision.entities?.reduce((sum, entity) => sum + entity.mentions.length, 0) ?? 0 : stageNumber === 10 ? facts + held : stageNumber === 11 || stageNumber === 12 ? facts + held : stageNumber === 13 ? decision.graph?.edges?.length ?? facts : stageNumber === 14 ? decision.derived?.length ?? 0 : facts;
  const recordsOut = stageNumber === 9 ? decision.entities?.length ?? 0 : stageNumber === 10 || stageNumber === 11 || stageNumber === 12 ? facts : stageNumber === 13 ? decision.graph?.edges?.length ?? facts : stageNumber === 14 ? decision.derived?.length ?? 0 : facts;
  return { records_in: recordsIn, records_out: recordsOut, records_quarantined: held, error_count: errorCount, retry_count: retryCount, duration_ms: durationMs };
}

export function stageCatalogEntry(stageNumber) {
  return PIPELINE_STAGE_BY_NUMBER[stageNumber];
}

export function requireDecisionShape(decision) {
  requirePipelineString(decision?.decisionId, "decisionId");
  requirePipelineString(decision?.decisionHash, "decisionHash");
  return decision;
}
