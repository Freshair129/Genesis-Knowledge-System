// Tier-3 stage evidence vocabulary — ADR-GKS-LEDGER-REPORTING (0.2.0b,
// accepted) D2/D4 and docs/GKS-PORT-CONTRACT.md port version 3.
//
// The identifiers below are zuri-ai's (FR-109's catalog, FR-071's ledger):
// GKS reports evidence against them and never redefines them. They are
// repeated here as constants so a row this repository writes cannot drift
// from the definition the puller validates against.
import { GksInvalidRequestError } from "./errors.mjs";
import { PIPELINE_STAGE_ID_PATTERN } from "./resolution.mjs";
import { validateScope } from "./validation.mjs";

export const KNOWLEDGE_INGESTION_DEFINITION_ID = "DPL-KNOWLEDGE-INGEST-V1";
export const KNOWLEDGE_INGESTION_CONTRACT_ID = "EXC-KNOWLEDGE-INGEST-V1";

/** The stage every promotion executes (ADR-GKS-ENTITY-RESOLUTION). */
export const ENTITY_RESOLVE_STAGE_ID = "DPS-KI-ENTITY-RESOLVE";

/**
 * NFR-020's six per-stage metrics, in the export row's spelling: the one
 * deliberate renaming is processing_time -> processing_time_ms, so the unit
 * lives in the field name (ledger ADR D2).
 */
export const STAGE_EVIDENCE_METRICS = Object.freeze([
  "records_in",
  "records_out",
  "records_failed",
  "records_quarantined",
  "processing_time_ms",
  "retry_count",
]);

/** "A metric a stage did not produce is 0, never omitted" (ledger ADR D4). */
export function zeroMetrics(overrides = {}) {
  const metrics = Object.fromEntries(STAGE_EVIDENCE_METRICS.map((name) => [name, 0]));
  for (const [name, value] of Object.entries(overrides)) {
    if (!STAGE_EVIDENCE_METRICS.includes(name)) throw new GksInvalidRequestError(`${name} is not an NFR-020 metric.`);
    if (!Number.isFinite(value) || value < 0) throw new GksInvalidRequestError(`${name} must be a finite non-negative number.`);
    metrics[name] = value;
  }
  return metrics;
}

export const STAGE_EVIDENCE_EXPORT_DEFAULT_LIMIT = 100;
export const STAGE_EVIDENCE_EXPORT_MAX_LIMIT = 500;

function nonNegativeInteger(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new GksInvalidRequestError(`${label} must be a non-negative integer.`);
  return value;
}

/**
 * gks_stage_evidence_export({ scope, since_cursor, limit }) — the request
 * half of the export tool. Scope is mandatory and explicit (no wildcard, no
 * GKS_DEFAULT_PORTFOLIO_ID); since_cursor defaults to 0 (everything); limit
 * is bounded so a page is always a page.
 */
export function validateStageEvidenceExportRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GksInvalidRequestError("Stage evidence export request is required.");
  const scope = validateScope(input.scope);
  const sinceCursor = nonNegativeInteger(input.since_cursor, "since_cursor", 0);
  const limit = nonNegativeInteger(input.limit, "limit", STAGE_EVIDENCE_EXPORT_DEFAULT_LIMIT);
  if (limit < 1 || limit > STAGE_EVIDENCE_EXPORT_MAX_LIMIT) {
    throw new GksInvalidRequestError(`limit must be between 1 and ${STAGE_EVIDENCE_EXPORT_MAX_LIMIT}.`);
  }
  return { scope, sinceCursor, limit };
}

/** Every row a stage writes names a DPS-KI-* stage id. */
export function validatePipelineStageId(value, label = "pipelineStageId") {
  if (typeof value !== "string" || !PIPELINE_STAGE_ID_PATTERN.test(value)) {
    throw new GksInvalidRequestError(`${label} must be a DPS-KI-* pipeline stage id string.`);
  }
  return value;
}
