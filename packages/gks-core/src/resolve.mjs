// Stage 9 (DPS-KI-ENTITY-RESOLVE): the resolver ladder.
//
// Source of truth: docs/ADR-GKS-ENTITY-RESOLUTION.md (0.3.0b, accepted) —
// decision 1 (the rungs, their fixed confidences, the contradiction overlay),
// decision 2 (the floor; below it never merge, D3), decision 3 (resolveTo is
// a claim to be verified, never trusted), D2 (the digest is the CREATED
// branch, not the whole function).
//
// This module is PURE: it receives the candidate pool through `lookup` and
// never queries — the adapter queries, filtered on every scope dimension in
// SQL (D5). That is what keeps the layering diamond intact and what makes
// the ladder testable as a function.

import { createHash } from "node:crypto";
import {
  CONTRADICTION_CONFIDENCE,
  DEFAULT_AUTOMERGE_FLOOR,
  FUZZY_CONFIDENCE_CEILING,
  STRATEGY_CONFIDENCE,
  normKey,
  scopeKey,
  surfaceKey,
} from "@freshair129/gks-contracts";

export function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "knowledge";
}

/**
 * D2: the digest becomes the CREATED branch. Deterministic, scope-bound,
 * restart-stable — correct for the one case where nothing matched, because a
 * new entity's canonical ref may as well be a function of itself.
 */
export function canonicalEntityRef(scopeKeyValue, candidateRef) {
  return `gks:entity/${slug(candidateRef)}-${digest(`${scopeKeyValue}\u0000${candidateRef}`)}`;
}

// FUZZY near-match threshold — a resolver implementation detail, NOT contract
// vocabulary (which is why it lives here and not in gks-contracts). FUZZY is
// detect-only and structurally below the floor, so this number can only move
// rows between "reviewed" and "created", never merge anything. Similarity is
// normalized Levenshtein over norm_v1 keys.
const FUZZY_NEAR_THRESHOLD = 0.8;

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

// Decision 1's contradiction overlay: "materially conflicting" titles are
// titles that still differ after norm_v1 folding — case, separators and
// legal-form scaffolding are immaterial (the four ACME spellings must not
// contradict each other), a different name is material (two companies both
// literally named "acme" are separated by exactly this evidence, which the
// old ON CONFLICT ... DO UPDATE used to destroy).
function titlesMateriallyConflict(stored, incoming) {
  return normKey(stored) !== normKey(incoming);
}

function decideStringRung(strategy, hits, candidate, floor) {
  if (hits.length > 1) {
    // One string-level criterion, several distinct stored entities (possible
    // across the pool's ancestor scopes, where UNIQUE(scope_key, norm_key)
    // does not span). No single merge target exists: AMBIGUOUS, no binding.
    return { canonicalRef: null, outcome: "AMBIGUOUS", strategy, confidence: null };
  }
  const entity = hits[0];
  // The contradiction check overlays every rung except CANONICAL_REF. A type
  // mismatch is a contradiction of the same kind as a conflicting title:
  // same name, different kind of thing — and merging across it (or creating
  // a duplicate norm_key the constraint would reject) are both wrong.
  if (entity.type !== candidate.type || titlesMateriallyConflict(entity.title, candidate.title)) {
    return { canonicalRef: null, outcome: "REVIEW_REQUIRED", strategy, confidence: CONTRADICTION_CONFIDENCE };
  }
  const confidence = STRATEGY_CONFIDENCE[strategy];
  // D3: the floor decides what may merge without a human. Below it, refuse —
  // record the rung and its confidence honestly, bind nothing, touch nothing.
  if (confidence < floor) {
    return { canonicalRef: null, outcome: "REVIEW_REQUIRED", strategy, confidence };
  }
  return { canonicalRef: entity.canonicalRef, outcome: "MATCHED", strategy, confidence };
}

/**
 * Resolve one entity candidate against the scope's candidate pool.
 *
 * Ladder (decision 1), first decisive rung wins:
 *   CANONICAL_REF → EXTERNAL_REF → EXACT → ALIAS → DETERMINISTIC →
 *   FUZZY (detect-only) → CREATED
 *
 * @param {object} candidate  a validated entity candidate
 *   ({ candidateRef, type, title, resolveTo, externalRefs, ... })
 * @param {object} scope      the validated promotion scope (CREATED digests
 *   against its scope key)
 * @param {Array}  lookup     the candidate pool rows the adapter's
 *   lookupResolutionCandidates returned for this scope — core never queries
 * @param {object} [options]
 * @param {number} [options.floor]  the auto-merge policy floor (decision 2)
 * @returns {{ canonicalRef: string|null, outcome: string, strategy: string, confidence: number|null }}
 */
export function resolveEntity(candidate, scope, lookup, { floor = DEFAULT_AUTOMERGE_FLOOR } = {}) {
  const pool = Array.isArray(lookup) ? lookup : [];

  // CANONICAL_REF (decision 3): resolveTo is a claim, verified against the
  // pool — which already embodies the tenant wall and ancestor rule (D5), so
  // an out-of-pool entity is indistinguishable from a nonexistent one:
  // REJECTED, no binding, no entity created. Always decisive; the one rung
  // with no contradiction overlay.
  if (candidate.resolveTo) {
    const target = pool.find((entity) => entity.canonicalRef === candidate.resolveTo);
    if (!target) {
      return { canonicalRef: null, outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null };
    }
    return { canonicalRef: target.canonicalRef, outcome: "MATCHED", strategy: "CANONICAL_REF", confidence: STRATEGY_CONFIDENCE.CANONICAL_REF };
  }

  const surface = surfaceKey(candidate.candidateRef);
  const key = normKey(candidate.candidateRef);
  const externalRefs = new Set(candidate.externalRefs ?? []);

  // The string rungs, in rung order. EXACT matches the spelling that created
  // the entity (steps 1-4 only — same string modulo case, separators and
  // whitespace); ALIAS matches the normalized forms accumulated by decision 7
  // fills and D9 human binds; DETERMINISTIC is the full norm_v1 key, the same
  // key UNIQUE(scope_key, norm_key) stores. A D2-discriminated key
  // (`norm_key#mention_id`) never equals a fresh norm key, which is exactly
  // what keeps a human-ruled-distinct entity out of this rung.
  const rungs = [
    ["EXTERNAL_REF", (entity) => externalRefs.size > 0 && (entity.externalRefs ?? []).some((ref) => externalRefs.has(ref))],
    ["EXACT", (entity) => surfaceKey(entity.candidateRef) === surface],
    ["ALIAS", (entity) => (entity.aliases ?? []).includes(key)],
    ["DETERMINISTIC", (entity) => entity.normKey === key],
  ];
  for (const [strategy, matches] of rungs) {
    const hits = pool.filter(matches);
    if (hits.length > 0) return decideStringRung(strategy, hits, candidate, floor);
  }

  // FUZZY — detect-only, ceiling 0.84, structurally below the floor: it can
  // never produce MATCHED. One near match is a reviewable suggestion; several
  // are an ambiguity a human has to break. Same-type only: a near-name of a
  // different kind is not evidence of identity.
  const near = pool
    .filter((entity) => entity.type === candidate.type)
    .map((entity) => similarity(key, entity.normKey))
    .filter((score) => score >= FUZZY_NEAR_THRESHOLD);
  if (near.length === 1) {
    return { canonicalRef: null, outcome: "REVIEW_REQUIRED", strategy: "FUZZY", confidence: Math.min(near[0], FUZZY_CONFIDENCE_CEILING) };
  }
  if (near.length > 1) {
    return { canonicalRef: null, outcome: "AMBIGUOUS", strategy: "FUZZY", confidence: null };
  }

  // CREATED — D2's digest fallback: a mention nothing matched is a new entity.
  return {
    canonicalRef: canonicalEntityRef(scopeKey(scope), candidate.candidateRef),
    outcome: "CREATED",
    strategy: "CREATED",
    confidence: STRATEGY_CONFIDENCE.CREATED,
  };
}
