import { createHash } from "node:crypto";

// Stage 9 (DPS-KI-ENTITY-RESOLVE): the frozen norm_v1 normalizer behind
// norm_key and the DETERMINISTIC rung. See docs/NORM-V1-RULE-TABLE.md.
// The module lives in gks-contracts (migration 0002's backfill needs it on
// the persistence side of the layering diamond); re-exported here so the
// domain package keeps offering the resolver's own vocabulary.
export { NORM_VERSION, normKey } from "@freshair129/gks-contracts";
import {
  GksInvalidRequestError,
  GksScopeDeniedError,
  NORM_VERSION,
  STRATEGY_CONFIDENCE,
  assertGksPersistencePort,
  normKey,
  requireString,
  scopeKey,
  validateEntityCandidate,
  validatePromotionRequest,
  validateRelationCandidate,
  validateRelationType,
  validateScope,
} from "@freshair129/gks-contracts";

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "knowledge";
}

function visible(recordScope, requestScope) {
  if (recordScope.portfolioId !== requestScope.portfolioId) return false;
  for (const key of ["tenantId", "businessId", "workspaceId", "projectId"]) {
    if (recordScope[key] && recordScope[key] !== requestScope[key]) return false;
  }
  return true;
}

function canonicalEntityRef(scopeKeyValue, candidateRef) {
  return `gks:entity/${slug(candidateRef)}-${digest(`${scopeKeyValue}\u0000${candidateRef}`)}`;
}

export function createGksService({ persistence, defaultPortfolioId } = {}) {
  assertGksPersistencePort(persistence);

  return {
    async health() {
      return { service: "gks", ...persistence.health() };
    },

    async promoteCandidate(rawInput) {
      const input = validatePromotionRequest(rawInput, { defaultPortfolioId });
      const normalizedScope = input.scope;
      const normalizedScopeKey = scopeKey(normalizedScope);
      const candidateEntities = Array.isArray(input.candidate.entities) ? input.candidate.entities.map(validateEntityCandidate) : [];
      const seen = new Map();
      const entities = candidateEntities.map((entity) => {
        const previous = seen.get(entity.candidateRef);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entity)) throw new GksInvalidRequestError(`Conflicting duplicate entity candidateRef: ${entity.candidateRef}`);
        seen.set(entity.candidateRef, entity);
        return {
          ...entity,
          canonicalRef: canonicalEntityRef(normalizedScopeKey, entity.candidateRef),
          // Stage 9 (ADR-GKS-ENTITY-RESOLUTION D1/D2): every occurrence is
          // recorded as a mention with its normalization key. Until the
          // resolver ladder lands, every promotion takes D2's digest CREATED
          // branch, and the mention records that claim honestly — the ladder
          // step replaces this fixed resolution with read-then-decide.
          normKey: normKey(entity.candidateRef),
          normVersion: NORM_VERSION,
          resolution: { outcome: "CREATED", strategy: "CREATED", confidence: STRATEGY_CONFIDENCE.CREATED },
        };
      }).filter((entity, index, list) => list.findIndex((item) => item.candidateRef === entity.candidateRef) === index);
      const refs = new Map(entities.map((entity) => [entity.candidateRef, entity.canonicalRef]));
      const relations = (Array.isArray(input.candidate.relations) ? input.candidate.relations.map(validateRelationCandidate) : []).map((relation) => {
        const fromRef = refs.get(relation.fromRef);
        const toRef = refs.get(relation.toRef);
        if (!fromRef || !toRef) throw new GksInvalidRequestError("Relation endpoints must refer to entities in the same candidate envelope.");
        return {
          ...relation,
          fromRef,
          toRef,
          canonicalRef: `gks:relation/${digest(`${normalizedScopeKey}\u0000${fromRef}\u0000${relation.relationType}\u0000${toRef}`)}`,
        };
      });
      const canonicalMappings = entities.map((entity) => ({ candidateRef: entity.candidateRef, canonicalRef: entity.canonicalRef, canonicalType: "ENTITY" }));
      const knowledgeRef = `gks:knowledge/gks_knowledge_${digest(`${normalizedScopeKey}\u0000${input.idempotency_key}`)}`;
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
        canonicalMappings,
      });
      return {
        knowledge_ref: result.knowledgeRef,
        source_hash: result.sourceHash,
        idempotent: result.idempotent,
        graph_version: result.graphVersion,
        canonical_mappings: result.canonicalMappings,
      };
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
      const canonicalRef = `gks:artifact-link/${digest(`${normalizedScopeKey}\u0000${knowledgeRef}\u0000${artifactRef}\u0000${relationType}`)}`;
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
