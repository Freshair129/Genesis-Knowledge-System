---
version: "1.0.1"
created_at: "2026-08-29T16:45:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-30T05:30:00+07:00,Claude Opus 5"
status: "beta"
approval_owner: null
approval_recorded_at: null
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "versioned-rule-table"
  scope: "norm_v1 — the frozen normalization rules behind norm_key and the DETERMINISTIC resolution rung"
---

# `norm_v1` — normalization rule table

**Version string: `norm_v1`.** This exact string is written to
`entities.norm_version` on every row it produces.

## Why this is a document and not a constant in the resolver

Two separate decisions in
[ADR-GKS-ENTITY-RESOLUTION.md](ADR-GKS-ENTITY-RESOLUTION.md) depend on this
table, and they depend on it differently:

- **Decision 1** uses it for the `DETERMINISTIC` rung, which is the only rung
  permitted to auto-merge below an exact match. What this table folds together
  *is* what gets merged without a human.
- **Decision 5** uses it for `UNIQUE(scope_key, norm_key)`, which closes the
  concurrent-creation race. The constraint is enforced by the database, so the
  normalizer's output is **stored**, not merely computed.

That second use is what makes this a frozen artifact. A change to these rules
changes `norm_key` values that are already persisted under a unique constraint —
so the rules cannot be edited, only superseded by a new version, and the version
travels with every row.

Authoring it before the resolver was a recording step in the ADR's own approval
gate, for exactly this reason: a rule list improvised during implementation is a
rule list nobody reviewed, sitting under a uniqueness constraint.

## The pipeline, in order

Order matters — step 5 assumes the casing and spacing of steps 1–4.

| # | Step | Rule |
|---|---|---|
| 1 | Unicode normalization | `NFKC` |
| 2 | Case folding | lowercase (`toLowerCase`) |
| 3 | Separator folding | `_`, `-`, `.`, `,`, `/`, `\`, `&`, `+` → single space |
| 4 | Whitespace | collapse runs to one space; trim ends |
| 5 | Token removal | drop the tokens in §Removable tokens, then re-collapse whitespace |
| 6 | Empty guard | if the result is empty, fall back to the step-4 output |

`NFKC` before lowercasing, because it is what folds full-width and compatibility
forms into the characters the later steps expect. Thai text carries no case, so
step 2 is a no-op for it and harmless.

**Step 6 exists because the removals can consume everything.** A name that is
nothing but scaffolding — `"Co., Ltd."`, or `"บริษัท จำกัด"` — normalizes to the
empty string without it, and an empty `norm_key` under a unique constraint would
merge every such entity into one. Falling back to the step-4 output keeps them
distinct. (Corrected at 1.0.1: the original example here was `"The Company"`,
which cannot reach the empty string — `company` is in no removal list, and
worked example 7 requires it not to be; `normKey("The Company")` is `company`.)

Two properties of the fallback, pinned by tests rather than left implicit: it
is the **step-4** output, so it is post-NFKC — Thai `SARA AM` (U+0E33)
decomposes under NFKC, so the fallback for a pure-scaffolding Thai name is not
byte-identical to the raw input; and it retains the leading article a normal
pass would strip, because the fallback exists to preserve distinctness, not to
be pretty.

## Removable tokens

Only tokens that are **legal-form or grammatical scaffolding** are removed.
Descriptive words are never removed, however common — `"group"`, `"holdings"`,
`"trading"`, `"international"` and their Thai equivalents distinguish real,
different companies, and folding them together would be an over-merge performed
by the normalizer itself, beneath the floor and beneath review.

### Thai legal forms

| Token | Note |
|---|---|
| `บริษัท` | prefix; "company" |
| `จำกัด` | suffix; "limited" |
| `มหาชน` | "public", as in the public-company form |
| `หจก` | abbreviation of the limited-partnership form |
| `ห้างหุ้นส่วนจำกัด` | limited partnership, written out |
| `ห้างหุ้นส่วนสามัญ` | ordinary partnership, written out |

Thai company names carry their legal form as a **circumfix** — `บริษัท X จำกัด`
— so both ends must be removable independently, and removing one without the
other must still produce a usable key.

`ห้างหุ้นส่วนจำกัด` is listed before `หจก` in matching order because the written
form contains no space and the abbreviation is a prefix of nothing; matching the
longer form first avoids a partial strip.

### English and international legal forms

`co`, `ltd`, `limited`, `inc`, `incorporated`, `corp`, `corporation`, `llc`,
`llp`, `lp`, `plc`, `pcl`, `gmbh`, `ag`, `sa`, `nv`, `bv`, `pte`, `pty`, `kk`,
`ab`, `as`, `oy`, `srl`, `spa`.

`pcl` is included alongside `plc` because Thai public companies are commonly
rendered `Public Company Limited` and abbreviated both ways in the same corpus.

### Articles

`the`, `a`, `an` — **leading position only.**

Position-restricted deliberately: `"a"` and `"an"` are frequent inside real
names (`"bank a"`, `"an son trading"`), and removing them everywhere would fold
distinct names together.

### Matching rules for removal

**Corrected at 1.0.1.** The original statement of the first rule was
self-contradictory: it declared whole-token removal at *any position* for every
list, while its own example required that `"as"` must not strip out of
`"as one"` — which any-position removal would do, since `as` stands alone
between separators there. The shipped normalizer implements the
position-restricted form below; all seven worked examples pass unchanged, and
no stored `norm_key` is affected. **This erratum corrects the description, not
the behavior** — the never-edit-only-supersede rule governs behavior changes,
and this is not one.

- A token is removed only when it stands alone between separators after
  step 4 — never as a substring. `"incorporated"` must not strip out of
  `"incorporation services"`.
- **Position is part of the rule, per list:**
  - Thai legal forms — any position: the circumfix `บริษัท X จำกัด` requires
    both ends removable independently.
  - International legal forms — **trailing position only**, popped repeatedly
    until stable: `ACME Group Co., Ltd.` → pop `ltd`, pop `co` → `acme group`.
    This is what keeps `"as"` inside `"as one"` while still stripping it from
    `"One AS"`.
  - Articles — leading position only, as already stated.
- Longest match first within a list.
- Removal is repeated until stable, so `บริษัท เอ บี ซี จำกัด (มหาชน)` reduces
  in one pass over the token stream rather than needing a fixed number of runs.

## Worked examples

The ADR's acceptance criterion 1 requires the first four to converge:

| Input | `norm_key` |
|---|---|
| `ACME Corp` | `acme` |
| `Acme Corp.` | `acme` |
| `acme corporation` | `acme` |
| `ACME_CORP` | `acme` |
| `บริษัท เอซีเอ็มอี จำกัด` | `เอซีเอ็มอี` |
| `ACME Group Co., Ltd.` | `acme group` |
| `The Acme Company` | `acme company` |

The last two are the point of the removal discipline. `"ACME Group"` does **not**
fold to `"acme"` — a group holding company is a different entity from its
operating company, and treating them as one would be an over-merge the resolver
never got to review. `"The Acme Company"` keeps `company` because only the
leading article is an article; `company` is not in any removal list.

## What this table does not do

- **It does not decide identity.** It produces a key. `MATCHED` still requires
  the `DETERMINISTIC` rung's confidence (0.88) to clear the floor (0.85), and
  the contradiction check can still drop a keyed match to `REVIEW_REQUIRED`
  when the stored title conflicts.
- **It does not do fuzzy matching.** No edit distance, no phonetics, no token
  overlap. Those live in the `FUZZY` rung, which is capped below the floor and
  cannot auto-merge.
- **It does not normalize across scripts.** `ACME` and `เอซีเอ็มอี` produce
  different keys and stay separate entities. Transliteration is a matching
  strategy, not a normalization rule, and it belongs above the floor only with
  evidence this table does not have.

## Changing these rules

A change is a **new version** (`norm_v2`), never an edit to this one:

1. Author the new table as its own document with its own version string.
2. New resolutions write `norm_version = "norm_v2"`.
3. Existing rows keep `norm_v1` keys and are **not** re-keyed — re-keying would
   change values already under `UNIQUE(scope_key, norm_key)`, and per the ADR's
   decision 4 a canonical ref changes only through a human-authorized D9 merge.
4. Entities separated only because they were keyed under different versions
   converge through D9, like any other over-split.

This is deliberately inconvenient. The alternative — editing the list in place —
silently re-partitions stored identity, which is the failure this whole ADR
exists to prevent.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.1 | 2026-08-30 | beta | Erratum, description only — behavior and every stored `norm_key` unchanged, so this is not a `norm_v2` event. RKOI's review found §Matching-rules self-contradictory: it stated any-position removal for every list while its own example forbade stripping `as` from `as one`. The shipped normalizer implements the position-restricted form (Thai forms any-position, international forms trailing-only, articles leading-only) and the document now says so. Also corrected the empty-guard rationale example (`The Company` cannot reach the empty string — `company` is in no removal list) and recorded that the fallback is the post-NFKC step-4 output, per the step-1 builder's findings. | working-tree | Claude Opus 5 (RKOI critical 1; findings from KIN step 1) |
| 1.0.0 | 2026-08-29 | beta | First frozen normalization table, authored before the resolver because two ADR decisions depend on it and one of them stores its output under a unique constraint. Removes legal-form scaffolding (Thai circumfix and international suffixes) and leading articles only; descriptive words such as "group" and "holdings" are deliberately kept, because folding them would be an over-merge performed beneath the floor and beneath review. | working-tree | Claude Opus 5 |
