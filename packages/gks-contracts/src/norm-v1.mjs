// norm_v1 — the frozen normalizer behind `norm_key` and the DETERMINISTIC rung.
//
// Implements docs/NORM-V1-RULE-TABLE.md (version 1.0.0) exactly. These rules
// are frozen infrastructure: their output is stored under
// UNIQUE(scope_key, norm_key) (ADR-GKS-ENTITY-RESOLUTION.md, decisions 2 and 5),
// so a change here is a new version (`norm_v2`, its own table, its own module),
// never an edit to this file's rules.
//
// Pure module by design: no I/O, no imports. `gks-core` receives rows through
// a lookup and never queries (ADR decision 2); the normalizer is the purest
// part of that seam.
//
// It lives in `gks-contracts` because two packages on opposite sides of the
// layering diamond consume it and neither may import the other: the resolver's
// DETERMINISTIC rung in `gks-core`, and migration 0002's backfill in
// `gks-persistence` (ADR decision 4 populates `entities.norm_key` at
// migration time). Frozen, versioned vocabulary is exactly what this package
// holds — `resolution.mjs` for the ladder, this module for the key it stores.

/**
 * The exact string written to `entities.norm_version` for every key this
 * module produces.
 */
export const NORM_VERSION = "norm_v1";

// Step 3 — separator folding: each of these characters becomes a single
// space. The list is the rule table's, verbatim: _ - . , / \ & +
const SEPARATORS = /[_\-.,/\\&+]/g;

// ---------------------------------------------------------------------------
// Removable tokens (rule table §Removable tokens).
//
// Only legal-form or grammatical scaffolding — descriptive words ("group",
// "holdings", "trading", "international" and their Thai equivalents) are
// never removed: folding them would be an over-merge performed by the
// normalizer itself, beneath the floor and beneath review.
//
// Each list is kept in longest-first order per the table's matching rules.
// Matching is whole-token equality (a token standing alone between separators
// after step 4 — never a substring), so with these single-token entries the
// order cannot change the result; it is preserved as the table's stated
// discipline so a future multi-word entry cannot silently regress it.
// ---------------------------------------------------------------------------

// Thai legal forms. Thai names carry their legal form as a circumfix
// (บริษัท X จำกัด), so these are removable at ANY token position — both ends
// must be removable independently, and removal is one pass over the token
// stream.
const THAI_LEGAL_FORMS = [
  "ห้างหุ้นส่วนจำกัด", // limited partnership, written out — before หจก, longest first
  "ห้างหุ้นส่วนสามัญ", // ordinary partnership, written out
  "บริษัท", // prefix; "company"
  "จำกัด", // suffix; "limited"
  "มหาชน", // "public", as in the public-company form
  "หจก", // abbreviation of the limited-partnership form
];

// English and international legal forms. These are suffixes: removed only in
// TRAILING position, repeatedly ("ACME Group Co., Ltd." pops "ltd" then "co").
// The position restriction is what keeps "as" from stripping out of "as one" —
// a whole token, but not a trailing legal form.
const INTERNATIONAL_LEGAL_FORMS = [
  "incorporated",
  "corporation",
  "limited",
  "corp",
  "gmbh",
  "llc",
  "llp",
  "plc",
  "pcl", // Thai public companies render "Public Company Limited" both ways
  "pte",
  "pty",
  "inc",
  "ltd",
  "srl",
  "spa",
  "ab",
  "ag",
  "as",
  "bv",
  "co",
  "kk",
  "lp",
  "nv",
  "oy",
  "sa",
];

// Articles — LEADING position only, deliberately: "a" and "an" are frequent
// inside real names, and removing them everywhere would fold distinct names
// together.
const ARTICLES = ["the", "an", "a"];

// The constants above are already NFKC-lowercase, but fold them through the
// same steps 1-2 the input takes so source-file encoding can never diverge
// from matching behavior.
const fold = (token) => token.normalize("NFKC").toLowerCase();
const THAI_SET = new Set(THAI_LEGAL_FORMS.map(fold));
const INTERNATIONAL_SET = new Set(INTERNATIONAL_LEGAL_FORMS.map(fold));
const ARTICLE_SET = new Set(ARTICLES.map(fold));

// Step 5 — token removal, repeated until stable. Repetition matters because a
// removal can expose a new leading article or a new trailing legal form
// (e.g. "บริษัท the acme จำกัด": stripping the circumfix makes "the" leading).
function removeTokens(collapsed) {
  if (collapsed === "") return "";
  let tokens = collapsed.split(" ");
  let changed = true;
  while (changed) {
    changed = false;
    // Thai legal forms: whole-token, any position, one pass over the stream.
    const filtered = tokens.filter((token) => !THAI_SET.has(token));
    if (filtered.length !== tokens.length) {
      tokens = filtered;
      changed = true;
    }
    // International legal forms: whole-token, trailing only, repeated.
    while (tokens.length > 0 && INTERNATIONAL_SET.has(tokens[tokens.length - 1])) {
      tokens.pop();
      changed = true;
    }
    // Articles: whole-token, leading only, repeated.
    while (tokens.length > 0 && ARTICLE_SET.has(tokens[0])) {
      tokens.shift();
      changed = true;
    }
  }
  return tokens.join(" ");
}

/**
 * Produce the `norm_v1` normalization key for a candidate name.
 *
 * Pipeline, in order (the order is the rule — step 5 assumes the casing and
 * spacing of steps 1-4):
 *   1. Unicode normalization: NFKC
 *   2. Case folding: toLowerCase
 *   3. Separator folding: _ - . , / \ & +  → single space
 *   4. Whitespace: collapse runs to one space; trim ends
 *   5. Token removal: §Removable tokens, whole-token, repeated until stable
 *   6. Empty guard: if the result is empty, fall back to the step-4 output —
 *      a name made purely of scaffolding (e.g. "Co., Ltd.") must not produce
 *      the empty key that would merge every such entity into one under
 *      UNIQUE(scope_key, norm_key).
 *
 * @param {string} input
 * @returns {string}
 */
export function normKey(input) {
  if (typeof input !== "string") {
    throw new TypeError(`normKey expects a string, got ${input === null ? "null" : typeof input}`);
  }
  const unicodeNormalized = input.normalize("NFKC"); // step 1
  const lowered = unicodeNormalized.toLowerCase(); // step 2
  const separated = lowered.replace(SEPARATORS, " "); // step 3
  const collapsed = separated.replace(/\s+/g, " ").trim(); // step 4
  const stripped = removeTokens(collapsed); // step 5
  return stripped === "" ? collapsed : stripped; // step 6
}
