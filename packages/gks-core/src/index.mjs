// Stage 9 (DPS-KI-ENTITY-RESOLVE): the frozen norm_v1 normalizer behind
// norm_key and the DETERMINISTIC rung. See docs/NORM-V1-RULE-TABLE.md.
// The module lives in gks-contracts (migration 0002's backfill needs it on
// the persistence side of the layering diamond); re-exported here so the
// domain package keeps offering the resolver's own vocabulary.
export { NORM_VERSION, normKey } from "@freshair129/gks-contracts";
// The resolver ladder (ADR-GKS-ENTITY-RESOLUTION decision 1) — a pure
// function: it receives the candidate pool, it never queries.
export { resolveEntity } from "./resolve.mjs";
export * from "./pipeline.mjs";
export * from "./temporal.mjs";
import {
  ENTITY_RESOLVE_STAGE_ID,
  GksConflictError,
  GksInvalidRequestError,
  GksInvalidBackendResponseError,
  GksNormKeyConflictError,
  GksScopeDeniedError,
  NORM_VERSION,
  assertGksPersistencePort,
  automergeFloor,
  normKey,
  requireString,
  scopeKey,
  validateEntityCandidate,
  validateHumanResolutionRequest,
  validatePromotionRequest,
  validateRelationCandidate,
  validateRelationType,
  validateScope,
  validateStageEvidenceExportRequest,
  PIPELINE_SCHEMA_VERSION,
  authorizePipelineRequest,
  hashPipelineDecision,
  hashPipelineGraphReceipt,
  hashPipelineReceipt,
  pipelineScopeKey,
  pipelineEntityNormKey,
  sha256Json,
  validatePipelineBatch,
  validatePipelineClaimRequest,
  validatePipelineEvidenceRequest,
  validatePipelineGateRequest,
  validatePipelineGraphReceipt,
  validatePipelinePublicationReceipt,
  validatePipelineReceipt,
  validatePipelineStageFailureRequest,
  validatePipelineScope,
} from "@freshair129/gks-contracts";
import { canonicalEntityRef, digest, resolveEntity } from "./resolve.mjs";
import { buildPipelineDecision, derivePipelineSummaries, evaluatePipelineQuality } from "./pipeline.mjs";

// The U+0000 join used by every digest input — the same byte scopeKey() uses,
// named so no digest input can drift to a printable separator.
const SEP = String.fromCharCode(0);

function visible(recordScope, requestScope) {
  if (recordScope.portfolioId !== requestScope.portfolioId) return false;
  for (const key of ["tenantId", "businessId", "workspaceId", "projectId"]) {
    if (recordScope[key] && recordScope[key] !== requestScope[key]) return false;
  }
  return true;
}

// Decision 5: losing the UNIQUE(scope_key, norm_key) race is retried by
// re-reading the pool — the winner is visible on the second pass, so the
// ladder returns MATCHED against it instead of over-splitting. Within one
// envelope the convergence happens in memory (a CREATED candidate joins the
// working pool before the next candidate resolves), so a conflict here means
// a genuinely concurrent writer. The count is bounded because an unbounded
// loop would spin forever on any bug that made the conflict deterministic.
const NORM_KEY_CONFLICT_RETRIES = 3;

export function createGksService({ persistence, defaultPortfolioId, automergeFloor: floorOption, pipelineRelayCredential } = {}) {
  assertGksPersistencePort(persistence);
  // Decision 2: the floor defaults in code and is overridable only by
  // deployment config (GKS_AUTOMERGE_FLOOR) — the server passes
  // automergeFloor(env); a per-request floor deliberately does not exist.
  const floor = floorOption === undefined ? automergeFloor() : floorOption;
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error("automergeFloor must be a finite number in [0,1].");
  }
  const pipelineCredential = pipelineRelayCredential;

  function requirePipelinePersistence(operation) {
    if (typeof persistence[operation] !== "function") throw new GksInvalidBackendResponseError(`GksPersistencePort is missing pipeline operation ${operation}.`);
  }

  function pipelineLegacyScope(scope) {
    return { portfolioId: scope.portfolioId, tenantId: scope.tenantId, businessId: scope.businessId, workspaceId: scope.workspaceId, projectId: "", sharing: scope.visibility };
  }

  async function existingPipelineCanonicalRefs(scope, mentions) {
    requirePipelinePersistence("lookupResolutionCandidates");
    const candidates = await persistence.lookupResolutionCandidates({ scope: pipelineLegacyScope(scope) });
    const wanted = new Set(mentions.map((mention) => pipelineEntityNormKey(mention.resolutionKey, mention.semanticType)));
    const refs = new Map();
    for (const candidate of candidates) {
      const semanticType = candidate.metadata?.semanticType;
      const resolutionKey = candidate.metadata?.resolutionKey ?? candidate.candidateRef;
      if (typeof semanticType !== "string" || !semanticType.trim() || typeof resolutionKey !== "string" || !resolutionKey.trim()) continue;
      const identity = pipelineEntityNormKey(resolutionKey, semanticType);
      if (wanted.has(identity)) refs.set(identity, candidate.canonicalRef);
    }
    return refs;
  }

  function pipelineEnvelope(rawInput, payload) {
    const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
    const scope = payload?.scope ?? raw.scope;
    if (raw.scope !== undefined && scope && pipelineScopeKey(raw.scope) !== pipelineScopeKey(scope)) throw new GksScopeDeniedError("pipeline envelope scope does not match its payload scope.");
    return { ...raw, scope };
  }

  function pipelineQualityMetrics(decision, quality, durationMs) {
    return {
      records_in: (decision.entities?.length ?? 0) + (decision.facts?.length ?? 0) + (decision.graph?.nodes?.length ?? 0) + (decision.graph?.edges?.length ?? 0),
      records_out: quality.verdict === "PASS" ? 1 : 0,
      records_quarantined: decision.held?.length ?? 0,
      error_count: quality.verdict === "FAIL" ? 1 : 0,
      retry_count: 0,
      duration_ms: durationMs,
    };
  }

  function pipelineGateResult(scope, verdict, verdictHash) {
    return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope, verdict, verdictHash };
  }

  return {
    async health() {
      return { service: "gks", ...persistence.health() };
    },

    async promoteCandidate(rawInput) {
      // Ledger ADR D4: processing_time_ms is measured from here, the moment
      // the stage started executing, not from the moment its row is read.
      const startedAt = Date.now();
      const input = validatePromotionRequest(rawInput, { defaultPortfolioId });
      const normalizedScope = input.scope;
      const normalizedScopeKey = scopeKey(normalizedScope);
      const seen = new Map();
      const candidateEntities = (Array.isArray(input.candidate.entities) ? input.candidate.entities.map(validateEntityCandidate) : [])
        .filter((entity) => {
          const previous = seen.get(entity.candidateRef);
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(entity)) throw new GksInvalidRequestError(`Conflicting duplicate entity candidateRef: ${entity.candidateRef}`);
            return false;
          }
          seen.set(entity.candidateRef, entity);
          return true;
        });
      const relationCandidates = Array.isArray(input.candidate.relations) ? input.candidate.relations.map(validateRelationCandidate) : [];
      const knowledgeRef = `gks:knowledge/gks_knowledge_${digest(`${normalizedScopeKey}${SEP}${input.idempotency_key}`)}`;

      // Read-then-decide (D2): the pool is the adapter's scope-filtered
      // lookup (D5); the ladder itself is pure. Re-running the whole
      // read-resolve-write cycle is also the decision-5 retry: after a lost
      // uniqueness race the winner is in the pool and the ladder matches it.
      for (let attempt = 1; ; attempt += 1) {
        const pool = await persistence.lookupResolutionCandidates({ scope: normalizedScope });
        const working = [...pool];
        const entities = candidateEntities.map((candidate) => {
          const resolution = resolveEntity(candidate, normalizedScope, working, { floor });
          const key = normKey(candidate.candidateRef);
          if (resolution.outcome === "CREATED") {
            // A CREATED candidate joins the working pool immediately, so a
            // later spelling of it in the SAME envelope resolves MATCHED in
            // memory instead of colliding on UNIQUE(scope_key, norm_key).
            working.push({
              canonicalRef: resolution.canonicalRef,
              candidateRef: candidate.candidateRef,
              type: candidate.type,
              title: candidate.title,
              summary: candidate.summary,
              aliases: [],
              externalRefs: candidate.externalRefs ?? [],
              normKey: key,
            });
          }
          return {
            ...candidate,
            canonicalRef: resolution.canonicalRef,
            normKey: key,
            normVersion: NORM_VERSION,
            resolution: { outcome: resolution.outcome, strategy: resolution.strategy, confidence: resolution.confidence },
          };
        });
        const byCandidateRef = new Map(entities.map((entity) => [entity.candidateRef, entity]));
        const relations = [];
        const pendingRelations = [];
        for (const relation of relationCandidates) {
          const from = byCandidateRef.get(relation.fromRef);
          const to = byCandidateRef.get(relation.toRef);
          // Still a hard error: an endpoint absent from the envelope
          // entirely is a malformed candidate, not an unresolved one.
          if (!from || !to) throw new GksInvalidRequestError("Relation endpoints must refer to entities in the same candidate envelope.");
          if (from.canonicalRef && to.canonicalRef) {
            relations.push({
              ...relation,
              fromRef: from.canonicalRef,
              toRef: to.canonicalRef,
              canonicalRef: `gks:relation/${digest(`${normalizedScopeKey}${SEP}${from.canonicalRef}${SEP}${relation.relationType}${SEP}${to.canonicalRef}`)}`,
            });
          } else {
            // D10.1: an endpoint that resolved without a canonical ref
            // (REVIEW_REQUIRED / AMBIGUOUS / REJECTED) does not abort the
            // envelope — the relation is held with its mention endpoints
            // and materializes when the endpoint resolves (a D9 bind).
            pendingRelations.push({
              fromCandidateRef: relation.fromRef,
              relationType: relation.relationType,
              toCandidateRef: relation.toRef,
              confidence: relation.confidence,
              metadata: relation.metadata,
            });
          }
        }
        // D7: per-entity resolution evidence rides canonical_mappings — the
        // channel the promotion snapshot freezes, which is what makes replay
        // byte-identical (D4) even after later envelopes re-decide mentions.
        const canonicalMappings = entities.map((entity) => ({
          candidateRef: entity.candidateRef,
          canonicalRef: entity.canonicalRef,
          canonicalType: "ENTITY",
          resolution: entity.resolution,
        }));
        try {
          const result = persistence.transactPromotion({
            scope: normalizedScope,
            scopeKey: normalizedScopeKey,
            idempotencyKey: input.idempotency_key,
            knowledgeRef,
            sourceHash: input.source_snapshot_hash,
            provenanceRef: input.provenance_ref,
            candidate: input.candidate,
            entities,
            relations,
            pendingRelations,
            canonicalMappings,
            // Stage 9's evidence row (ledger ADR D2): the execution this
            // promotion IS, bound to the caller's run and provenance. The
            // stage executed is always entity resolution -- a requested
            // pipeline_stage_id (D6) is recorded as what was asked, never as
            // what ran. retry_count is the decision-5 uniqueness retries.
            stageEvidence: {
              pipelineStageId: ENTITY_RESOLVE_STAGE_ID,
              requestedPipelineStageId: input.pipeline_stage_id ?? null,
              runId: input.run_id,
              automergeFloor: floor,
              startedAt,
              retryCount: attempt - 1,
            },
          });
          return {
            knowledge_ref: result.knowledgeRef,
            source_hash: result.sourceHash,
            idempotent: result.idempotent,
            graph_version: result.graphVersion,
            canonical_mappings: result.canonicalMappings,
          };
        } catch (error) {
          if (!(error instanceof GksNormKeyConflictError) || attempt >= NORM_KEY_CONFLICT_RETRIES) throw error;
        }
      }
    },

    async search(input = {}) {
      const query = requireString(input.query, "query");
      const requestScope = validateScope(input.scope);
      return persistence.search({ query, portfolioId: requestScope.portfolioId }).filter((entity) => visible(entity.scope, requestScope));
    },

    async getEntity(input = {}) {
      const ref = requireString(input.ref, "ref");
      const requestScope = validateScope(input.scope);
      const entity = persistence.getEntity(ref);
      if (!entity) return null;
      if (!visible(entity.scope, requestScope)) throw new GksScopeDeniedError();
      return entity;
    },

    async getRelations(input = {}) {
      const ref = requireString(input.ref, "ref");
      const requestScope = validateScope(input.scope);
      const entity = persistence.getEntity(ref);
      if (entity && !visible(entity.scope, requestScope)) throw new GksScopeDeniedError();
      return persistence.getRelations(ref).filter((relation) => visible(relation.scope, requestScope));
    },

    // D9's read half: the review queue. The unresolved rows D3 produces have
    // a consumer, or D3 is a dead end -- this is the listing that consumer
    // reads. Scope filtering happens in the adapter's SQL, like the lookup.
    async listUnresolvedMentions(input = {}) {
      const requestScope = validateScope(input.scope);
      return persistence.listUnresolvedMentions({ scope: requestScope });
    },

    // D9's write half: ONE human-authorized decision -- bind an unresolved
    // mention to an existing canonical entity, or merge two canonical
    // entities with supersession and relation re-pointing in the same
    // transaction (D10.2). It records strategy HUMAN under its own
    // provenance ref. The resolver has no path here: resolveEntity is pure
    // and promoteCandidate reaches only transactPromotion, which itself
    // refuses to record strategy HUMAN.
    async applyHumanResolution(input = {}) {
      const request = validateHumanResolutionRequest(input);
      return persistence.transactHumanResolution({ ...request, scopeKey: scopeKey(request.scope) });
    },

    // ADR-GKS-LEDGER-REPORTING D2 (Option B): the read-only cursor pull
    // zuri-ai calls through MSP. GKS stays passive -- it returns rows, on the
    // caller's schedule, and never opens a connection toward anyone. The
    // scope predicate is the adapter's SQL (port v3), so a caller with a
    // foreign scope gets an empty page, not a filtered one.
    async exportStageEvidence(input = {}) {
      const request = validateStageEvidenceExportRequest(input);
      const page = persistence.exportStageEvidence(request);
      return {
        rows: page.rows.map((row) => ({
          cursor: row.cursor,
          evidence_id: row.evidenceId,
          pipeline_stage_id: row.pipelineStageId,
          pipeline_definition_id: row.pipelineDefinitionId,
          execution_contract_id: row.executionContractId,
          run_id: row.runId,
          provenance_ref: row.provenanceRef,
          scope: row.scope,
          evidence: row.evidence,
          metrics: row.metrics,
          records: row.records,
          produced_at: row.producedAt,
        })),
        next_cursor: page.nextCursor,
      };
    },

    // GenesisRAG17 stays passive: MSP is the sole caller and forwards the
    // configured relay identity. The principal's exact pipeline scope is
    // checked before any persistence read or write.
    async pipelineSubmit(rawInput = {}) {
      const candidateBatch = rawInput.batch ?? rawInput;
      const batch = validatePipelineBatch(candidateBatch);
      const envelope = pipelineEnvelope(rawInput, batch);
      authorizePipelineRequest(envelope, { relayCredential: pipelineCredential, role: "source", scope: batch.scope });
      const stage9StartedMs = Date.now();
      const canonicalRefs = await existingPipelineCanonicalRefs(batch.scope, batch.mentions);
      const decision = buildPipelineDecision(batch, { canonicalRefs, stage9StartedMs });
      requirePipelinePersistence("transactPipelineSubmit");
      const result = persistence.transactPipelineSubmit({
        scope: batch.scope,
        batch,
        batchHash: batch.batchHash,
        decision,
        stageExecutionTimes: decision.stageExecutionTimes,
      });
      return {
        schemaVersion: PIPELINE_SCHEMA_VERSION,
        scope: batch.scope,
        batchId: result.batchId,
        decisionId: result.decisionId,
        status: result.status,
        idempotent: result.idempotent,
      };
    },

    async pipelineClaim(rawInput = {}) {
      const request = validatePipelineClaimRequest(rawInput);
      authorizePipelineRequest(rawInput, { relayCredential: pipelineCredential, role: "worker", scope: request.scope });
      requirePipelinePersistence("claimPipelineDecisions");
      const decisions = persistence.claimPipelineDecisions(request).map((decision) => ({ ...decision }));
      return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: request.scope, decisions };
    },

    async pipelineGraphReceipt(rawInput = {}) {
      const receiptInput = rawInput.receipt ?? rawInput;
      const receipt = validatePipelineGraphReceipt(receiptInput);
      const envelope = pipelineEnvelope(rawInput, receipt);
      authorizePipelineRequest(envelope, { relayCredential: pipelineCredential, role: "worker", scope: receipt.scope });
      requirePipelinePersistence("getPipelineDecision");
      requirePipelinePersistence("getPipelineGraphReceipt");
      requirePipelinePersistence("transactPipelineGraphReceipt");
      const graphReceiptHash = hashPipelineGraphReceipt(receipt);
      const existing = persistence.getPipelineGraphReceipt({ scope: receipt.scope, decisionId: receipt.decisionId });
      if (existing) {
        if (existing.graphReceiptHash !== graphReceiptHash) throw new GksConflictError("decision already has a different graph receipt.");
        return {
          schemaVersion: PIPELINE_SCHEMA_VERSION,
          scope: receipt.scope,
          accepted: true,
          idempotent: true,
          graphReceiptHash,
          derived: existing.derived,
          derivedHash: existing.derivedHash,
        };
      }
      const decision = persistence.getPipelineDecision({ scope: receipt.scope, decisionId: receipt.decisionId });
      if (!decision) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
      if (decision.decisionHash !== receipt.decisionHash) throw new GksInvalidRequestError("graph receipt decisionHash does not match the stored decision.");
      const enrichmentStartedMs = Date.now();
      const derived = derivePipelineSummaries(decision, { now: new Date(enrichmentStartedMs).toISOString() });
      const enrichmentFinishedMs = Date.now();
      const enrichmentTimes = { startedAt: new Date(enrichmentStartedMs).toISOString(), finishedAt: new Date(enrichmentFinishedMs).toISOString() };
      const derivedHash = sha256Json(derived);
      const result = persistence.transactPipelineGraphReceipt({ scope: receipt.scope, receipt, graphReceiptHash, derived, derivedHash, enrichmentTimes });
      return {
        schemaVersion: PIPELINE_SCHEMA_VERSION,
        scope: receipt.scope,
        accepted: true,
        idempotent: result.idempotent,
        graphReceiptHash: result.graphReceiptHash,
        derived: result.derived,
        derivedHash: result.derivedHash,
      };
    },

    async pipelineStageFailure(rawInput = {}) {
      const request = validatePipelineStageFailureRequest(rawInput);
      authorizePipelineRequest(rawInput, { relayCredential: pipelineCredential, role: "worker", scope: request.scope });
      requirePipelinePersistence("transactPipelineStageFailure");
      const result = persistence.transactPipelineStageFailure(request);
      return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: request.scope, accepted: true, idempotent: result.idempotent, stage: request.stage, failureHash: result.failureHash };
    },

    async pipelineWriteReceipt(rawInput = {}) {
      const receiptInput = rawInput.receipt ?? rawInput;
      const receipt = validatePipelineReceipt(receiptInput);
      const envelope = pipelineEnvelope(rawInput, receipt);
      authorizePipelineRequest(envelope, { relayCredential: pipelineCredential, role: "worker", scope: receipt.scope });
      requirePipelinePersistence("transactPipelineWriteReceipt");
      const result = persistence.transactPipelineWriteReceipt({ scope: receipt.scope, receipt });
      return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: receipt.scope, accepted: true, idempotent: result.idempotent, receiptHash: result.receiptHash };
    },

    async pipelineGate(rawInput = {}) {
      const request = validatePipelineGateRequest(rawInput);
      authorizePipelineRequest(rawInput, { relayCredential: pipelineCredential, role: "worker", scope: request.scope });
      requirePipelinePersistence("getPipelineDecision");
      requirePipelinePersistence("getPipelineGraphReceipt");
      requirePipelinePersistence("getPipelineReceipt");
      requirePipelinePersistence("getPipelineGate");
      requirePipelinePersistence("transactPipelineGate");
      const decision = persistence.getPipelineDecision(request);
      if (!decision) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
      if (decision.decisionHash !== request.decisionHash) throw new GksScopeDeniedError("decisionHash does not match the stored decision.");
      const existingGate = persistence.getPipelineGate(request);
      if (existingGate) return pipelineGateResult(request.scope, existingGate, existingGate.verdictHash);
      const qualityStartedMs = Date.now();
      const qualityStartedAt = new Date(qualityStartedMs).toISOString();
      const graphReceipt = persistence.getPipelineGraphReceipt(request);
      const receipt = persistence.getPipelineReceipt(request);
      const quality = evaluatePipelineQuality(decision, receipt, { graphReceipt, derived: graphReceipt?.derived ?? [], policy: decision.policy });
      const qualityFinishedMs = Date.now();
      const qualityFinishedAt = new Date(qualityFinishedMs).toISOString();
      const verdict = {
        schemaVersion: PIPELINE_SCHEMA_VERSION,
        scope: request.scope,
        runId: decision.runId,
        decisionId: decision.decisionId,
        decisionHash: decision.decisionHash,
        snapshotId: receipt?.snapshotId ?? "",
        generation: receipt?.generation ?? "",
        receiptHash: receipt?.receiptHash ?? null,
        verdict: quality.verdict,
        allowPublication: quality.allowPublication,
        dimensions: quality.dimensions,
        statistics: {
          documents: new Set([decision.source?.documentId]).size,
          chunks: decision.chunks?.length ?? 0,
          entities: decision.entities?.length ?? 0,
          facts: decision.facts?.length ?? 0,
          relations: decision.graph?.edges?.length ?? 0,
        },
        ontologyVersion: decision.ontologyVersion,
        pipelineVersion: decision.pipelineVersion,
      };
      const result = persistence.transactPipelineGate({ ...request, verdict, metrics: pipelineQualityMetrics(decision, quality, qualityFinishedMs - qualityStartedMs), startedAt: qualityStartedAt, finishedAt: qualityFinishedAt });
      return pipelineGateResult(request.scope, verdict, result.verdictHash);
    },

    async pipelinePublicationReceipt(rawInput = {}) {
      const receiptInput = rawInput.receipt ?? rawInput;
      const receipt = validatePipelinePublicationReceipt(receiptInput);
      const envelope = pipelineEnvelope(rawInput, receipt);
      authorizePipelineRequest(envelope, { relayCredential: pipelineCredential, role: "worker", scope: receipt.scope });
      requirePipelinePersistence("transactPipelinePublicationReceipt");
      const result = persistence.transactPipelinePublicationReceipt({ scope: receipt.scope, receipt });
      return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: receipt.scope, accepted: true, idempotent: result.idempotent, publicationHash: result.publicationHash };
    },

    async pipelineEvidence(rawInput = {}) {
      const request = validatePipelineEvidenceRequest(rawInput);
      authorizePipelineRequest(rawInput, { relayCredential: pipelineCredential, role: "source", scope: request.scope });
      requirePipelinePersistence("exportPipelineEvidence");
      const page = persistence.exportPipelineEvidence(request);
      return { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: request.scope, rows: page.rows, nextCursor: page.nextCursor };
    },

    async linkArtifact(input = {}) {
      const knowledgeRef = requireString(input.knowledgeRef, "knowledgeRef");
      const artifactRef = requireString(input.artifactRef, "artifactRef");
      const evidenceRef = requireString(input.evidenceRef, "evidenceRef");
      if (!evidenceRef.startsWith("msp:proof/")) throw new GksInvalidRequestError("evidenceRef must be an msp:proof reference.");
      const relationType = validateRelationType(input.relationType);
      const normalizedScope = validateScope(input.scope);
      const entity = persistence.getEntity(knowledgeRef);
      if (!entity) throw new GksInvalidRequestError("knowledgeRef does not resolve to a canonical entity.");
      if (!visible(entity.scope, normalizedScope)) throw new GksScopeDeniedError();
      const normalizedScopeKey = scopeKey(normalizedScope);
      const canonicalRef = `gks:artifact-link/${digest(`${normalizedScopeKey}${SEP}${knowledgeRef}${SEP}${artifactRef}${SEP}${relationType}`)}`;
      const row = persistence.transactArtifactLink({ canonicalRef, scopeKey: normalizedScopeKey, scope: normalizedScope, knowledgeRef, artifactRef, relationType, evidenceRef });
      return {
        canonicalRef: row.canonical_ref,
        knowledgeRef: row.knowledge_ref,
        artifactRef: row.artifact_ref,
        relationType: row.relation_type,
        evidenceRef: row.evidence_ref,
        graphVersion: row.graph_version,
      };
    },
  };
}
