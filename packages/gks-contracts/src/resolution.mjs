// Stage 9 (DPS-KI-ENTITY-RESOLVE) shared resolution vocabulary.
//
// Source of truth: docs/ADR-GKS-ENTITY-RESOLUTION.md (0.3.0b, accepted) —
// decision 1 (the ladder and its fixed per-rung confidences), decision 2
// (the 0.85 floor, deployment-overridable), decision 3 (the resolveTo
// shape), and D6 (the DPS-KI-* pipeline id travels as a string in its own
// field; `stage` keeps meaning GoVibe Deep Scan 1-12).
//
// These values are contract, not tuning knobs: the floor is structural — it
// sits so DETERMINISTIC (0.88) may auto-merge and FUZZY (capped 0.84) never
// can. Changing any of them is an ADR amendment, not an edit here.

/** FR-109 resolution outcomes, exactly five. */
export const RESOLUTION_OUTCOMES = Object.freeze([
  "MATCHED",
  "CREATED",
  "AMBIGUOUS",
  "REVIEW_REQUIRED",
  "REJECTED",
]);

/**
 * The nine reportable strategies. The first seven are the resolver ladder in
 * rung order (first decisive rung wins). HUMAN is recorded by a D9 bind,
 * never executed by the resolver; BACKFILL marks the migration's one
 * CREATED-mention-per-existing-entity rows (confidence null).
 */
export const RESOLUTION_STRATEGIES = Object.freeze([
  "CANONICAL_REF",
  "EXTERNAL_REF",
  "EXACT",
  "ALIAS",
  "DETERMINISTIC",
  "FUZZY",
  "CREATED",
  "HUMAN",
  "BACKFILL",
]);

/**
 * Fixed per-rung confidences (decision 1). FUZZY is deliberately absent: it
 * is detect-only with a ceiling, not a fixed value. HUMAN and BACKFILL are
 * not resolver rungs and carry no resolver-assigned confidence.
 */
export const STRATEGY_CONFIDENCE = Object.freeze({
  CANONICAL_REF: 1,
  EXTERNAL_REF: 0.98,
  EXACT: 0.95,
  ALIAS: 0.92,
  DETERMINISTIC: 0.88,
  CREATED: 1,
});

/** FUZZY is structurally below the floor: it can never produce MATCHED. */
export const FUZZY_CONFIDENCE_CEILING = 0.84;

/**
 * The contradiction-check overlay (decision 1): a string-level match whose
 * stored title materially conflicts with the incoming title drops to this
 * and becomes REVIEW_REQUIRED.
 */
export const CONTRADICTION_CONFIDENCE = 0.6;

/** Decision 2: the global auto-merge policy floor. */
export const DEFAULT_AUTOMERGE_FLOOR = 0.85;

/**
 * Decision 2: the floor defaults in code and is overridable only by
 * deployment config (GKS_AUTOMERGE_FLOOR), set by the owner. An unset or
 * empty variable means the default; a set-but-invalid one fails closed at
 * startup rather than silently merging under a floor nobody chose.
 */
export function automergeFloor(env = process.env) {
  const raw = env?.GKS_AUTOMERGE_FLOOR;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_AUTOMERGE_FLOOR;
  const floor = Number(raw);
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error("GKS_AUTOMERGE_FLOOR must be a finite number in [0,1].");
  }
  return floor;
}

/**
 * Decision 3: the one exemption to the gks: rejection — `resolveTo` on a
 * candidate entity must name an existing canonical entity in exactly this
 * shape. A claim to be verified by the CANONICAL_REF rung, never trusted.
 */
export const RESOLVE_TO_PATTERN = /^gks:entity\/[a-z0-9-]+-[a-f0-9]{32}$/;

/**
 * D6: the pipeline stage id travels as a string in its own additive field.
 * `stage` stays the integer 1-12 and keeps meaning GoVibe Deep Scan stage —
 * the two vocabularies never share a field.
 */
export const PIPELINE_STAGE_ID_PATTERN = /^DPS-KI-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
