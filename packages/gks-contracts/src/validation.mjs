import { GksInvalidBackendResponseError, GksInvalidRequestError } from "./errors.mjs";
import { HUMAN_RESOLUTION_ACTIONS, MENTION_REF_PATTERN, PIPELINE_STAGE_ID_PATTERN, RESOLVE_TO_PATTERN } from "./resolution.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ENTITY_TYPES = new Set(["IDEA", "CONCEPT", "ALGO", "ENTITY", "API", "ENDPOINT", "ENTRYPOINT", "FLOW", "FEAT", "PARAMS", "FRAME", "BLUEPRINT", "TASK_REF", "SOURCE", "AUDIT_REF", "OPS"]);
const RELATION_TYPES = new Set(["DEPENDS_ON", "IMPLEMENTS", "CALLS", "READS", "WRITES", "TOUCHES", "DESCRIBED_BY", "DERIVED_FROM", "RELATED_TO", "BELONGS_TO", "AFFECTS", "VALIDATED_BY"]);
const SHARING = new Set(["private", "workspace", "portfolio-shared"]);
const CANONICAL_KEYS = new Set(["canonicalRef", "canonical_ref", "knowledgeRef", "knowledge_ref", "relationId", "relation_id", "entityId", "entity_id", "graphVersion", "graph_version"]);
// Port version 2 (docs/GKS-PORT-CONTRACT.md, ADR-GKS-ENTITY-RESOLUTION D8):
// lookupResolutionCandidates is REQUIRED, not optional. An adapter without it
// falls back to digest-only identity -- the defect Stage 9 exists to fix --
// so the replacement contract breaks here deliberately and openly.
//
// listUnresolvedMentions and transactHumanResolution are D9's two halves
// (decision 6 puts D9 inside Stage 9, so they land in the same port
// version). They are required for the same D8 reason the lookup is: an
// adapter without the consumer would ship the refusal half of the safety
// valve with no repair half -- the "system that can only refuse" the ADR
// warns D3 and D7 would jointly describe.
const PERSISTENCE_OPERATIONS = ["health", "transactPromotion", "search", "getEntity", "getRelations", "transactArtifactLink", "lookupResolutionCandidates", "listUnresolvedMentions", "transactHumanResolution", "close"];

export function assertGksPersistencePort(adapter) {
  if (!adapter || typeof adapter !== "object") throw new GksInvalidBackendResponseError("GksPersistencePort adapter is required.");
  const missing = PERSISTENCE_OPERATIONS.filter((name) => typeof adapter[name] !== "function");
  if (missing.length) throw new GksInvalidBackendResponseError(`GksPersistencePort is missing operations: ${missing.join(", ")}.`);
  return adapter;
}

export function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new GksInvalidRequestError(`${label} is required.`);
  return value.trim();
}

// ADR-GKS-ENTITY-RESOLUTION decision 2: confidence is a finite number in
// [0, 1] or gks_invalid_request. Bare Number() let NaN land silently on the
// no-merge path AND in a REAL column -- wrong twice. Callers sending junk
// now fail closed.
function optionalConfidence(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new GksInvalidRequestError(`${label} must be a finite number between 0 and 1.`);
  }
  return value;
}

// ADR-GKS-ENTITY-RESOLUTION decision 3: resolveTo is a claim to be verified
// by the CANONICAL_REF rung, never trusted. If the key is present its value
// must be exactly a canonical entity reference; anything else fails closed.
export function validateResolveTo(value, label = "resolveTo") {
  if (typeof value !== "string" || !RESOLVE_TO_PATTERN.test(value)) {
    throw new GksInvalidRequestError(`${label} must be a canonical entity reference matching gks:entity/<slug>-<32 hex>.`);
  }
  return value;
}

const ENTITY_CANDIDATE_PATH = /^candidate[.]entities[[][0-9]+]$/;

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new GksInvalidRequestError(`${label} must be a string.`);
  return value.trim();
}

export function validateScope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError("scope is required.");
  const scope = {
    portfolioId: requireString(input.portfolioId, "scope.portfolioId"),
    tenantId: optionalString(input.tenantId, "scope.tenantId"),
    businessId: optionalString(input.businessId, "scope.businessId"),
    workspaceId: optionalString(input.workspaceId, "scope.workspaceId"),
    projectId: optionalString(input.projectId, "scope.projectId"),
    sharing: input.sharing ?? "private",
  };
  if (!SHARING.has(scope.sharing)) throw new GksInvalidRequestError("scope.sharing is invalid.");
  return scope;
}

export function scopeKey(scope) {
  return [scope.portfolioId, scope.tenantId, scope.businessId, scope.workspaceId, scope.projectId, scope.sharing].join("\u0000");
}

export function resolvePromotionScope(input, defaultPortfolioId) {
  if (input.scope) return validateScope(input.scope);
  if (!defaultPortfolioId) throw new GksInvalidRequestError("scope is required when GKS_DEFAULT_PORTFOLIO_ID is not configured.");
  return validateScope({
    portfolioId: defaultPortfolioId,
    tenantId: input.tenant_id,
    businessId: input.business_id,
    workspaceId: input.workspace_id,
    projectId: input.project_id,
    sharing: "private",
  });
}

function rejectCanonicalAssignments(value, path = "candidate") {
  if (typeof value === "string" && value.startsWith("gks:")) throw new GksInvalidRequestError(`${path} must not assign a canonical GKS reference.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCanonicalAssignments(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (CANONICAL_KEYS.has(key)) throw new GksInvalidRequestError(`${path}.${key} is assigned by GKS.`);
    // Decision 3: the ONE exemption -- resolveTo on a candidate entity, and
    // only in the canonical entity-reference shape. A resolveTo anywhere
    // else, and any other gks:-prefixed string at any depth, stays rejected.
    if (key === "resolveTo" && ENTITY_CANDIDATE_PATH.test(path)) {
      validateResolveTo(item, `${path}.resolveTo`);
      continue;
    }
    rejectCanonicalAssignments(item, `${path}.${key}`);
  }
}

export function validatePromotionRequest(input, { defaultPortfolioId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError("Knowledge candidate is required.");
  if (input.schema_version !== "govibe-knowledge-candidate/v1") throw new GksInvalidRequestError("Invalid knowledge candidate schema version.");
  const normalized = {
    ...input,
    idempotency_key: requireString(input.idempotency_key, "idempotency_key"),
    run_id: requireString(input.run_id, "run_id"),
    provenance_ref: requireString(input.provenance_ref, "provenance_ref"),
    scope: resolvePromotionScope(input, defaultPortfolioId),
  };
  if (!Number.isInteger(input.stage) || input.stage < 1 || input.stage > 12) throw new GksInvalidRequestError("stage must be 1-12.");
  // ADR-GKS-ENTITY-RESOLUTION D6: the DPS-KI-* pipeline id travels as a
  // string in its own additive field. stage stays 1-12 and keeps meaning
  // GoVibe Deep Scan stage -- the two vocabularies never share a field.
  if (input.pipeline_stage_id !== undefined && (typeof input.pipeline_stage_id !== "string" || !PIPELINE_STAGE_ID_PATTERN.test(input.pipeline_stage_id))) {
    throw new GksInvalidRequestError("pipeline_stage_id must be a DPS-KI-* pipeline stage id string.");
  }
  if (typeof input.source_snapshot_hash !== "string" || !HASH.test(input.source_snapshot_hash)) throw new GksInvalidRequestError("source_snapshot_hash must be 64 lower-case hexadecimal characters.");
  if (!normalized.provenance_ref.startsWith("msp:proof/")) throw new GksInvalidRequestError("provenance_ref must be an msp:proof reference.");
  if (!input.candidate || typeof input.candidate !== "object" || Array.isArray(input.candidate)) throw new GksInvalidRequestError("candidate must be an object.");
  rejectCanonicalAssignments(input.candidate);
  return normalized;
}

export function validateEntityCandidate(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError(`candidate.entities[${index}] must be an object.`);
  const type = requireString(input.type, `candidate.entities[${index}].type`).toUpperCase();
  if (!ENTITY_TYPES.has(type)) throw new GksInvalidRequestError(`candidate.entities[${index}].type is invalid.`);
  return {
    candidateRef: requireString(input.candidateRef, `candidate.entities[${index}].candidateRef`),
    type,
    title: requireString(input.title, `candidate.entities[${index}].title`),
    summary: typeof input.summary === "string" ? input.summary.trim() : "",
    sourceRef: optionalString(input.sourceRef, `candidate.entities[${index}].sourceRef`) || null,
    confidence: optionalConfidence(input.confidence, `candidate.entities[${index}].confidence`),
    resolveTo: input.resolveTo === undefined ? null : validateResolveTo(input.resolveTo, `candidate.entities[${index}].resolveTo`),
    externalRefs: optionalExternalRefs(input.externalRefs, `candidate.entities[${index}].externalRefs`),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

// ADR-GKS-ENTITY-RESOLUTION decision 1: external references are the
// EXTERNAL_REF rung's evidence. Optional, an array of non-empty strings,
// deduplicated. gks:-prefixed values never get here — rejectCanonicalAssignments
// runs over the whole candidate first, and an external ref is external by
// definition.
function optionalExternalRefs(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new GksInvalidRequestError(`${label} must be an array of strings.`);
  const refs = value.map((item, index) => requireString(item, `${label}[${index}]`));
  return [...new Set(refs)];
}

export function validateRelationCandidate(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError(`candidate.relations[${index}] must be an object.`);
  const relationType = requireString(input.relationType, `candidate.relations[${index}].relationType`).toUpperCase();
  if (!RELATION_TYPES.has(relationType)) throw new GksInvalidRequestError(`candidate.relations[${index}].relationType is invalid.`);
  return {
    fromRef: requireString(input.fromRef, `candidate.relations[${index}].fromRef`),
    relationType,
    toRef: requireString(input.toRef, `candidate.relations[${index}].toRef`),
    confidence: optionalConfidence(input.confidence, `candidate.relations[${index}].confidence`),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

export function validateRelationType(value, label = "relationType") {
  const relationType = requireString(value, label).toUpperCase();
  if (!RELATION_TYPES.has(relationType)) throw new GksInvalidRequestError(`${label} is invalid.`);
  return relationType;
}

// ADR-GKS-ENTITY-RESOLUTION D9: the one human-authorized write, validated
// fail-closed. Every request names its action, carries the caller's scope
// envelope, and carries its OWN provenance ref -- the decision's evidence is
// separate from any promotion's. The canonical references here are inputs by
// design (a human names what to bind or merge); they are still claims the
// adapter verifies against stored rows inside the transaction, never trusted
// shapes-only.
export function validateHumanResolutionRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError("Human resolution request is required.");
  const action = requireString(input.action, "action").toUpperCase();
  if (!HUMAN_RESOLUTION_ACTIONS.includes(action)) throw new GksInvalidRequestError(`action must be one of ${HUMAN_RESOLUTION_ACTIONS.join(", ")}.`);
  const scope = validateScope(input.scope);
  const provenanceRef = requireString(input.provenanceRef, "provenanceRef");
  if (!provenanceRef.startsWith("msp:proof/")) throw new GksInvalidRequestError("provenanceRef must be an msp:proof reference.");
  if (action === "BIND") {
    const mentionId = requireString(input.mentionId, "mentionId");
    if (!MENTION_REF_PATTERN.test(mentionId)) throw new GksInvalidRequestError("mentionId must be a mention reference matching gks:mention/<32 hex>.");
    return { action, scope, provenanceRef, mentionId, canonicalRef: validateResolveTo(input.canonicalRef, "canonicalRef") };
  }
  const survivorRef = validateResolveTo(input.survivorRef, "survivorRef");
  const supersededRef = validateResolveTo(input.supersededRef, "supersededRef");
  if (survivorRef === supersededRef) throw new GksInvalidRequestError("survivorRef and supersededRef must name two different entities.");
  return { action, scope, provenanceRef, survivorRef, supersededRef };
}
