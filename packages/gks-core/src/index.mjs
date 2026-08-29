// Stage 9 (DPS-KI-ENTITY-RESOLVE): the frozen norm_v1 normalizer behind
// norm_key and the DETERMINISTIC rung. See docs/NORM-V1-RULE-TABLE.md.
// The module lives in gks-contracts (migration 0002's backfill needs it on
// the persistence side of the layering diamond); re-exported here so the
// domain package keeps offering the resolver's own vocabulary.
export { NORM_VERSION, normKey } from "@freshair129/gks-contracts";
// The resolver ladder (ADR-GKS-ENTITY-RESOLUTION decision 1) — a pure
// function: it receives the candidate pool, it never queries.
export { resolveEntity } from "./resolve.mjs";
import {
  GksInvalidRequestError,
  GksNormKeyConflictError,
  GksScopeDeniedError,
  NORM_VERSION,
  assertGksPersistencePort,
  automergeFloor,
  normKey,
  requireString,
  scopeKey,
  validateEntityCandidate,
  validatePromotionRequest,
  validateRelationCandidate,
  validateRelationType,
  validateScope,
} from "@freshair129/gks-contracts";
import { canonicalEntityRef, digest, resolveEntity } from "./resolve.mjs";

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

export function createGksService({ persistence, defaultPortfolioId, automergeFloor: floorOption } = {}) {
  assertGksPersistencePort(persistence);
  // Decision 2: the floor defaults in code and is overridable only by
  // deployment config (GKS_AUTOMERGE_FLOOR) — the server passes
  // automergeFloor(env); a per-request floor deliberately does not exist.
  const floor = floorOption === undefined ? automergeFloor() : floorOption;
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error("automergeFloor must be a finite number in [0,1].");
  }

  return {
    async health() {
      return { service: "gks", ...persistence.health() };
    },

    async promoteCandidate(rawInput) {
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
