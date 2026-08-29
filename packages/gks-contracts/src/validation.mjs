import { GksInvalidBackendResponseError, GksInvalidRequestError } from "./errors.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ENTITY_TYPES = new Set(["IDEA", "CONCEPT", "ALGO", "ENTITY", "API", "ENDPOINT", "ENTRYPOINT", "FLOW", "FEAT", "PARAMS", "FRAME", "BLUEPRINT", "TASK_REF", "SOURCE", "AUDIT_REF", "OPS"]);
const RELATION_TYPES = new Set(["DEPENDS_ON", "IMPLEMENTS", "CALLS", "READS", "WRITES", "TOUCHES", "DESCRIBED_BY", "DERIVED_FROM", "RELATED_TO", "BELONGS_TO", "AFFECTS", "VALIDATED_BY"]);
const SHARING = new Set(["private", "workspace", "portfolio-shared"]);
const CANONICAL_KEYS = new Set(["canonicalRef", "canonical_ref", "knowledgeRef", "knowledge_ref", "relationId", "relation_id", "entityId", "entity_id", "graphVersion", "graph_version"]);
const PERSISTENCE_OPERATIONS = ["health", "transactPromotion", "search", "getEntity", "getRelations", "transactArtifactLink", "close"];

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
    confidence: input.confidence === undefined ? null : Number(input.confidence),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

export function validateRelationCandidate(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError(`candidate.relations[${index}] must be an object.`);
  const relationType = requireString(input.relationType, `candidate.relations[${index}].relationType`).toUpperCase();
  if (!RELATION_TYPES.has(relationType)) throw new GksInvalidRequestError(`candidate.relations[${index}].relationType is invalid.`);
  return {
    fromRef: requireString(input.fromRef, `candidate.relations[${index}].fromRef`),
    relationType,
    toRef: requireString(input.toRef, `candidate.relations[${index}].toRef`),
    confidence: input.confidence === undefined ? null : Number(input.confidence),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {},
  };
}

export function validateRelationType(value, label = "relationType") {
  const relationType = requireString(value, label).toUpperCase();
  if (!RELATION_TYPES.has(relationType)) throw new GksInvalidRequestError(`${label} is invalid.`);
  return relationType;
}
