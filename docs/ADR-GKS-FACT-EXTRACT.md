---
version: "0.1.0b"
created_at: "2026-08-31T15:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T15:00:00+07:00,Claude Fable 5"
status: "proposed"
approval_owner: null
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "Stage 10 DPS-KI-FACT-EXTRACT — the fact schema, extraction method, storage, confidence gating, idempotency, and evidence transport, decided before any code task is written"
---

# ADR: Fact Extraction (Stage 10 — `DPS-KI-FACT-EXTRACT`)

## Decision status

Proposed. This document authorizes no implementation, migration, or new tool
by itself. Per `docs/TIER-BOUNDARY-17-STAGE.md`, "owning a stage is not
authorization to build it — each one needs its own design pass"; this is
Stage 10's. The follow-on implementation plan,
`docs/superpowers/plans/2026-09-XX-stage-10-fact-extract.md`, is written only
after the Boss accepts this ADR — the same order Stage 9 followed (ADR
accepted → contracts → persistence → core → consumer → acceptance-criteria
suite as the gate).

All eight open questions below have a **Proposed** answer written in full, so
acceptance is an approval of concrete text, not a request for homework —
mirroring the bar `ADR-GKS-ENTITY-RESOLUTION.md` set for Stage 9's eight
decisions.

This document is also binding-downstream of `docs/ADR-GKS-LEDGER-REPORTING.md`
(0.1.2b, proposed): that ADR fixes how every remaining owned stage's evidence
reaches zuri-ai's FR-071 ledger, decided once for all six stages so Stage 10
does not invent its own transport. Question 7 below answers in those terms
rather than re-arguing them.

## Context

### What exists today

Stage 9 (`DPS-KI-ENTITY-RESOLVE`) is accepted and shipped: `canonical_mappings`
and `entity_mentions` give GKS a canonical entity identity per scope, produced
by a resolver ladder with a policy floor
(`packages/gks-contracts/src/resolution.mjs`). Nothing downstream of that
exists. There is no fact store, no relation-beyond-`pending_relations`
extraction path, and no tool that reads a chunk of source text and produces a
structured assertion. `gks_knowledge_promote` accepts entities and relations a
caller already asserts; it does not extract anything from unstructured
content. Stage 10 is the first GKS-owned stage whose primary job is
extraction rather than resolution of caller-asserted structure.

zuri-ai's FR-109 stage catalog fixes what Stage 10 must be able to report:

> fact `subject` / `predicate` / `object` or value, `confidence`, `evidence`,
> `valid_time`, `provenance`

— restated in `docs/TIER-BOUNDARY-17-STAGE.md`'s evidence table, row 10. The
underlying spec (`KNOWLEDGE-INGESTION-17-STAGE-SPEC.md` §15) frames the Fact
as a first-class object with exactly those seven properties (subject,
predicate, object/value, confidence, evidence, valid_time, provenance), built
from raw source data such as an invoice line: `PurchaseFact { product,
quantity, amount, valid_at, source }`. Stage 11 (`DPS-KI-ONTOLOGY-MAP`, spec
§16) is explicitly the stage that collapses predicate synonyms
(`WORKS_FOR` / `EMPLOYED_BY` / `IS_EMPLOYEE_OF` / `STAFF_OF`) onto one
canonical predicate "ต้อง map เป็น canonical" ("must map to canonical") — a
job the spec assigns to Stage 11 by name, not Stage 10. Any Stage 10 design
that canonicalizes predicates pre-empts Stage 11's decision before Stage 11
has one.

Spec §3.2 fixes a cross-stage invariant Stage 10 inherits along with every
other knowledge object: "Entity, Fact, Relation, Chunk และ Derived Knowledge
ต้องสามารถตอบได้ว่า: มาจากไหน? มาจาก source version ไหน? ถูก extract เมื่อไร?
extract ด้วย pipeline version ไหน? confidence เท่าไร?" — every knowledge
object must answer where it came from, from what source version, when it was
extracted, with what pipeline version, and at what confidence. A fact with no
traceable source chunk fails this invariant structurally, not as a quality
defect; it is the acceptance-criteria basis for "a fact whose source chunk
cannot be reached is refused" below.

FR-111's sensitivity lattice adds a hard constraint on *how* Stage 10 may run:
`RESTRICTED` knowledge carrying `cloud_processing_allowed = false` forces all
seventeen stages, Stage 10 included, onto local execution — a data-classified
boundary, not a deployment choice, and not something a topology change may
override. Stage 10's extraction method must therefore work with zero
dependency on an external model call, at least for the path RESTRICTED data
takes; whatever method is chosen must not silently assume a cloud endpoint is
reachable.

### What must be decided before any code task is written

Eight questions, each requiring a decided answer at the bar Stage 9 set —
concrete Proposed text, not a placeholder for later research:

1. Input contract
2. Extraction method
3. Fact schema
4. Storage / port impact
5. Confidence model
6. Idempotency
7. Evidence & reporting
8. Tenant wall

## Decision

### Q1 — Input contract: chunk plus the Stage 9 resolution set; Stage 10 never re-resolves

**Proposed.** MSP hands Stage 10 a source chunk together with the Stage 9
resolution set already produced for that chunk — the resolved
`canonical_ref`s (and, for endpoints still `REVIEW_REQUIRED` or `AMBIGUOUS`,
the pending-mention identifiers) for every entity mention Stage 9 found in it.
Stage 10 never re-resolves an entity and never mints or looks up a
`canonical_ref` on its own initiative; it treats the incoming resolution set
as authoritative for identity and confines its own decision to what relation
or value holds between the entities and literals the chunk expresses.

**Why not raw candidates.** Handing Stage 10 raw, unresolved candidate strings
would require it to either re-run resolution itself — duplicating Stage 9's
ladder inside a stage whose job is extraction, and risking a second,
divergent answer to "who is this" for the same mention — or extract facts
whose `subject`/`object` are unresolved strings, which fails spec §3.2's
provenance-and-identity chain at the first hop. Stage 9 already owns entity
identity (`ADR-GKS-ENTITY-RESOLUTION.md`); Stage 10 consuming its output
rather than re-deriving it is the same separation-of-concerns argument that
keeps Stage 11 from being pre-empted at Q3 below.

**Consequence.** A fact whose subject or object mention is still unresolved
(`REVIEW_REQUIRED` / `AMBIGUOUS`) at the time its chunk is processed cannot be
written with a `canonical_ref` on that side. Stage 10 records the fact with a
reference to the *pending mention*, not a bare string, and the fact
materializes its `subject_ref`/`object_ref` when Stage 9's D9 consumer later
resolves that mention — the same pending/materialize shape D10 gave
`pending_relations` for Stage 9's own relation endpoints, reused here rather
than reinvented.

### Q2 — Extraction method: rule-first with a named, versioned extractor id

**Proposed.** Stage 10's extraction method is a deterministic, pattern-based
rule engine — regular-expression and structural pattern matching over the
chunk (e.g., invoice-line shapes, `X purchased Y` clause patterns, key-value
pairs in structured source formats) — identified by a named, versioned
extractor id (`extractor_version`, e.g. `"rule_v1"`) exactly as Stage 9's
`norm_v1` rule table is named and versioned
(`docs/NORM-V1-RULE-TABLE.md`). Model-assisted extraction (`LLM_ASSISTED`,
an inference call against a local or remote model) is explicitly **not**
decided here — it is a separate, later ADR decision, not smuggled into this
one under the extraction umbrella. This mirrors Stage 9's own omission of
`LLM_ASSISTED` from its ladder for the same reason: a model call inside the
canonical-authority path makes it latency-unbounded and nondeterministic, and
`ADR-GKS-BOUNDARY.md` puts model governance with MSP, not GKS.

**Why rule-first, not merely rule-only.** FR-111's `cloud_processing_allowed
= false` requirement (Context) means whatever ships first must be runnable
with zero external dependency — a rule engine satisfies that trivially, a
model-assist path does not unless it is a local model, which is itself a
decision this ADR is not making. Rule-first is also consistent with the
`extractor_version` field Q3 fixes on every fact row: the schema is designed
so a second extraction method, once decided, is a new versioned extractor
value, not a schema change.

**Consequence.** Extraction recall is bounded by what the rule table covers,
the same recall-vs-safety tradeoff Stage 9 accepted for its `DETERMINISTIC`
rung. A chunk containing a fact no rule matches produces no fact row for that
chunk — silently, in the sense that nothing is written, but not silently in
the metrics sense: `records_in` counts the chunk, `records_out` does not
count an unmatched fact, and the gap is visible in Stage 10's NFR-020 metrics
(Q7) rather than only in a downstream absence.

### Q3 — Fact schema: `fact_rows`, predicate stays raw

**Proposed.** The fact record, referred to in every later task and plan as
`fact_rows`, has exactly these columns:

```
fact_rows(fact_id PK, scope_key,
          portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing,
          subject_ref, predicate_raw, object_ref, object_value,
          confidence, evidence_span, source_chunk_id,
          valid_from, valid_to, tx_from, tx_to,
          provenance, extractor_version,
          decided_at)
```

Notes on the shape, each one a decision:

- **`subject_ref` and `object_ref` are `canonical_ref`-shaped identifiers**
  (`gks:entity/...`) or a pending-mention reference (Q1), never bare strings.
  **`object_value`** is the literal-value alternative to `object_ref` for
  facts whose object is a value rather than an entity (the spec's own
  example: `quantity = 100`, `amount = 25,000 THB`) — exactly one of
  `object_ref` / `object_value` is populated per row, mirroring the FR-109
  evidence list's "object or value" phrasing directly in the schema rather
  than collapsing it into one ambiguous column.
- **`predicate_raw` stays raw at Stage 10.** It carries whatever string or
  rule-tag the extractor produced (`"purchased"`, `"works_for"`,
  `"WORKS_FOR"`, `"employed_by"` — whatever the rule table or source chunk's
  own vocabulary yields), with **no canonicalization applied**. Predicate
  canonicalization — folding `WORKS_FOR` / `EMPLOYED_BY` / `IS_EMPLOYEE_OF`
  onto one canonical predicate — is Stage 11's (`DPS-KI-ONTOLOGY-MAP`) job by
  the spec's own §16 framing (Context), and pre-empting it here would mean
  Stage 11 either re-derives a canonicalization Stage 10 already guessed at,
  or is stuck reconciling two disagreeing canonicalizations. `predicate_raw`
  is named with the `_raw` suffix specifically so no later reader mistakes it
  for a canonical predicate by omission of a qualifier.
- **`evidence_span`** is the fact's `evidence` field from FR-109's list,
  named for what it holds (a locator into the source chunk — offsets or a
  quoted excerpt — not a free-form evidence blob) so a later `evidence`-named
  column belonging to a different concept (Q7's stage-level evidence export)
  is never confused with this per-fact field by name collision.
- **`valid_from` / `valid_to`** are FR-109's `valid_time` fields, split into
  the two-column shape Stage 9's and the ledger ADR's schemas already use for
  temporal ranges, consistent with how Stage 12 (`DPS-KI-TEMPORAL-MAP`) will
  later interpret them.
- **`tx_from` / `tx_to`** are the transaction-time pair FR-109's evidence
  list does not name directly but `TIER-BOUNDARY-17-STAGE.md` row 12 requires
  ("`valid_from`/`valid_to` and `tx_from`/`tx_to` where applicable, or an
  explicit not-applicable"). Stage 10 populates them at write time
  (`tx_from` = the write's own commit time, `tx_to` = open/null until
  superseded) so Stage 12's bitemporal mapping has a transaction axis to
  refine rather than one it must retrofit. A fact with no bitemporal claim at
  all still gets `tx_from` at write time — transaction time is a property of
  the write, not of the source content, so it is never "not applicable" the
  way `valid_time` can be.
- **`source_chunk_id`** is the FK this ADR's acceptance criteria (below) key
  the provenance-refusal rule on: a fact whose `source_chunk_id` does not
  resolve to a reachable chunk is refused at write time, never persisted with
  a dangling reference.
- **`provenance`** carries the same provenance-ref shape Stage 9's mentions
  and the ledger ADR's `stage_evidence` rows use — pipeline run/step
  identifiers, source version, and (per spec §3.2) the extraction timestamp —
  so a fact can answer every one of §3.2's five questions from its own row.
- **`extractor_version`** names the rule table or method version that
  produced the row (Q2), the same discipline `norm_version` gives Stage 9's
  normalizer: changing the rule table is a versioned event, not a silent
  re-extraction of history.
- **The six scope columns** (`portfolio_id`, `tenant_id`, `business_id`,
  `workspace_id`, `project_id`, `sharing`) are discrete, not folded into
  `scope_key` alone — the same reasoning `entity_mentions` (D1) gives: SQL
  needs to filter on individual dimensions (the tenant wall, Q8; the
  ancestor-scope pool a later stage might need), and an opaque joined key
  cannot express that.

**Rejected:** a schema with a single `object` column that sometimes holds a
ref and sometimes a literal, disambiguated by a type tag. Two columns, one
populated at a time, makes "which kind of object" visible in the schema
itself rather than requiring every reader to branch on a tag field first.

### Q4 — Storage / port impact: a new migration, and port version 3 together with the ledger ADR

**Proposed.** `fact_rows` is a new table added by a new migration in
`packages/gks-persistence` (following `0001_init.sql` … `0004_human_resolution.sql`'s
numbering — the next migration is `0005_fact_extraction.sql`). Writing a fact
row requires a new persistence port operation (a `transactFactExtraction`-
shaped write, exact name and signature fixed at implementation time) added to
`PERSISTENCE_OPERATIONS`, the same class of required addition Stage 9's
`lookupResolutionCandidates` was.

**This does require a port version bump, and it is the same bump the ledger
ADR already commits to, not a second one.** `docs/ADR-GKS-LEDGER-REPORTING.md`
D4 states that adding `gks_stage_evidence_export` and its `stage_evidence`
persistence operation is "a required addition to `GksServicePort` and
`GksPersistencePort`, incrementing the documented port version in
`GKS-PORT-CONTRACT.md`" to **port version 3**, recorded on that ADR's
acceptance, before Task 3 (this ADR's implementation) writes code. Stage 10's
own persistence addition — the fact-write operation this question decides —
lands in the same port version, not a version 4 of its own: both additions
(the evidence export read, and the fact write) are required operations that
break the same port-conformance contract
(`tests/contract/persistence-port-conformance.test.mjs`) in the same way, and
recording them as two separate version bumps for two changes that ship
together in one implementation branch would fragment one adapter-facing break
into two numbers for no reader's benefit. `GKS-PORT-CONTRACT.md` records port
version 3 with both operations named, on this ADR's acceptance and the
ledger ADR's acceptance together — whichever is accepted second is what
triggers the actual document edit, since the edit must describe a port
surface both ADRs agree exists.

**Consequence.** Every current and future persistence adapter must implement
the fact-write operation once this ships, the same "every adapter that will
ever exist" consequence Stage 9's D8 named openly rather than working around
with an optional-operation escape hatch (rejected there for the same reason
it would be rejected here: an adapter without fact-writing support would
silently degrade Stage 10 to a no-op, not a documented configuration).

### Q5 — Confidence model: per-extraction-path confidence, `REVIEW_REQUIRED`-style holding state below a floor

**Proposed.** Confidence is assigned per extraction path, not globally:

- A rule that matches a fully-structured, unambiguous source shape (a
  well-formed invoice line, a key-value pair with an unambiguous key) reports
  a high fixed confidence for that rule, analogous to Stage 9's per-rung
  fixed confidences (`STRATEGY_CONFIDENCE`).
- A rule that matches a looser, more inferential pattern (a natural-language
  clause matched by a broader pattern, e.g. free-text `"X purchased Y"`
  extraction) reports a lower confidence, and the exact per-rule values are
  fixed in the rule table alongside `extractor_version`, not invented at
  runtime.

**Extraction has no auto-merge floor, because there is nothing to merge — a
fact is either written or held.** Stage 9's floor exists to gate a
*resolution* decision (does this candidate become the same entity as an
existing one); Stage 10 has no analogous merge decision, since each extracted
fact is its own row, not a candidate being reconciled against a prior fact.
What Stage 10 needs instead is a **write gate**: below a confidence threshold
(deployment-configurable, defaulting to a value set at implementation time
and recorded in the same place `GKS_AUTOMERGE_FLOOR` is today), the fact is
not silently discarded and not silently written at full trust — it is written
in a `REVIEW_REQUIRED`-style holding state, an additive `review_status`
distinguishing `WRITTEN` from `HELD`, and it does not participate in
downstream Stage 11/12/13 processing until a human or a later, more
confident extraction pass resolves it.

**This reuses Stage 9's D9 consumer pattern rather than inventing a second
one.** `ADR-GKS-ENTITY-RESOLUTION.md` D9 establishes the precedent this ADR
follows directly: "D3 produces `REVIEW_REQUIRED` and `AMBIGUOUS` rows.
Nothing in GKS can read them ... So Stage 9 ships with a minimum consumption
path: a read tool listing unresolved mentions within scope, and one write
operation applying a human decision." A held low-confidence fact is the same
shape of problem D9 names — "an unresolved mention has a consumer, or D3 is a
dead end" applies verbatim with "fact" substituted for "mention": a held
fact with no consumer is a system that can only refuse. Stage 10 therefore
ships its own minimum consumption path in the same shape: a read tool listing
held facts within scope, and a write operation applying a human decision
(accept as written, reject, or correct and re-write). This consumer is
Stage 10's own D9-equivalent step in its implementation plan's task
breakdown, sequenced last within Stage 10 for the same reason D9 was
sequenced last within Stage 9 — the acceptance criteria below are untestable
without it.

### Q6 — Idempotency: source identity + source version + content hash + extractor version

**Proposed**, per BR-021's philosophy as the brief states it: the idempotency
key is the tuple **source identity + source version + content hash +
extractor version**, taken together — not any one alone. Concretely, a fact
write's idempotency key is derived from `(source_chunk_id, source_version,
sha256(chunk_content), extractor_version)`. Replaying the same chunk against
the same extractor version, unchanged, produces the same key and therefore no
duplicate `fact_rows` entries — the write is a no-op against an existing key,
mirroring `transactPromotion`'s existing idempotency-row pattern
(`packages/gks-persistence/src/index.mjs:104-113`) rather than inventing a
different replay mechanism for one stage.

**Why all four components, not fewer.** Source identity alone is not enough:
the same chunk re-ingested after a source edit (a new `source_version`) is a
legitimately different extraction input and must be allowed to produce a new
fact, not be silently deduplicated against stale content. Content hash alone
is not enough: two different chunks that happen to hash identically after
normalization (rare, but not impossible for short chunks) must not collide
across unrelated sources. Extractor version is required for exactly the
concurrency-of-change reason Q2 and Q3 already name: re-running the same
chunk through a newer rule table (`rule_v2`) is a deliberate re-extraction
that should produce its own facts alongside — not instead of, and not
colliding with — the `rule_v1` facts already on record, so the rule-table
version history stays inspectable rather than each version overwriting the
last.

**Consequence.** A chunk re-extracted under a new `extractor_version`
produces a second, independent set of `fact_rows` rows rather than replacing
the first. Reconciling or superseding facts across extractor versions is not
decided here — it is out of Stage 10's initial scope, the same way D9's
"KEEP SEPARATE" action was named as future work rather than decided in Stage
9's original scope.

### Q7 — Evidence & reporting: the Stage 10 evidence row through `stage_evidence`, per-fact child records, all six NFR-020 metrics

**Proposed**, in the exact terms `docs/ADR-GKS-LEDGER-REPORTING.md` D2 fixed:
Stage 10 emits its evidence through the `stage_evidence` table and the
`gks_stage_evidence_export` cursor-pull tool that ADR defines, at the
two-tier grain that ADR decided — **not** a bespoke evidence channel of its
own, and **not** riding a promote-response the way Stage 9's evidence does
(D7's pattern is Stage 9-specific and the ledger ADR explicitly does not
extend it to the remaining six stages).

- **One parent row per stage execution**, carrying the six NFR-020 metrics
  (`records_in`, `records_out`, `records_failed`, `records_quarantined`,
  `processing_time_ms`, `retry_count`) plus whatever execution-level catalog
  evidence Stage 10 has (none beyond the metrics themselves — Stage 10's
  catalog evidence is per-fact, not per-execution).
- **A `records` child array, one entry per extracted fact** — the ledger ADR
  names Stage 10 by name as one of exactly two stages (with Stage 13) whose
  catalog evidence is inherently per-record rather than per-execution: "Stage
  10 (`DPS-KI-FACT-EXTRACT`, per-fact: `subject`/`predicate`/`object`,
  `confidence`, `evidence`, `valid_time`, `provenance`)." Each `records`
  entry carries exactly those FR-109 fields for one extracted fact, sourced
  directly from that fact's `fact_rows` row — `subject` from `subject_ref`,
  `predicate` from `predicate_raw` (still raw here; the evidence export does
  not canonicalize what the fact row does not), `object` from whichever of
  `object_ref` / `object_value` is populated, `confidence`, `evidence` from
  `evidence_span`, `valid_time` from `valid_from`/`valid_to`, and
  `provenance` from `provenance`.
- **A `HELD` fact (Q5) is exported too**, with its `review_status` visible in
  the record entry, so a puller can see a fact exists and is pending review
  rather than only seeing it once a human resolves it — the same
  "evidence rides even the not-yet-finished path" principle the ledger ADR's
  Task 1 finding establishes for Stage 9's `HUMAN`/`BACKFILL` strategies.
- **Metrics report zero, not absent.** A Stage 10 execution over a chunk
  batch that extracts zero facts (every rule missed) still emits
  `records_out: 0`, not an omitted key — the ledger ADR's D4 "zero, not
  absent" rule applied here explicitly rather than left to be rediscovered at
  Stage 10's implementation time.
- **Cursor ordering is commit-time, per the ledger ADR's ordering guarantee.**
  A Stage 10 evidence row's `cursor` is assigned when the write commits, not
  when extraction starts, so a slow extraction that starts before a faster
  one but commits after it cannot be permanently skipped by a puller that
  has already advanced past the faster one's cursor — the exact hazard the
  ledger ADR's D2 "replay-safety is not completeness" section names. This
  ordering requirement is recorded as a **behavioural requirement with a
  conformance case**: when `GKS-PORT-CONTRACT.md` records port version 3
  (Q4), it records commit-time cursor assignment as binding, and
  `tests/contract/persistence-port-conformance.test.mjs` (or the
  `stage_evidence`-specific suite the ledger ADR's implementation adds) gains
  a case asserting a later-committing, earlier-started write is never
  assigned a cursor lower than one already exported — proving the guarantee
  holds rather than merely stating it.

### Q8 — Tenant wall: the same hard wall as Stage 9's D5/D8

**Proposed.** Fact extraction pools and any deduplication of facts never
cross `tenant_id`, applied with the identical discipline Stage 9's D5 and D8
established: `tenant_id` is a tenant of its own, not a wildcard, and an
empty `tenant_id` matches only an empty-tenant fact, never "any tenant." A
fact extracted from a chunk in tenant B's scope must never resolve its
`subject_ref`/`object_ref` against, be deduplicated against, or in any way
merge with a fact or entity in tenant A's scope, tenant-less entities
included. The extraction pool query — wherever Stage 10 needs to read prior
facts, for instance to avoid re-extracting a fact idempotency already
covers, or to detect a contradicting prior fact for the same subject/
predicate — applies every scope dimension **in SQL**, the same rule
`ADR-GKS-ENTITY-RESOLUTION.md` D5 states for the resolution lookup and the
ledger ADR restates for `gks_stage_evidence_export`'s scope predicate:
caller-side filtering is a repairable leak for a read, but a cross-tenant
write (a fact merged or deduplicated across tenants) is the unrecoverable
direction, and it must never be reachable by relying on a filter applied
after the SQL read rather than inside it.

`tests/security/cross-tenant-deny.security.mjs` gains a Stage 10 case
alongside the pool-level and merge-level cases Stage 9 already added there:
a fact whose subject or object resolves in tenant B must never be writable
against, or readable as belonging to, tenant A's scope — proving the wall
denies a foreign scope for fact writes specifically, not only for entity
resolution and evidence export.

## Acceptance criteria for the implementation branch

Written to be failable, at the same bar Stage 9's acceptance criteria were
held to — an implementation that extracts one obvious fact and does nothing
else must **not** pass this list. The future step-6 gate suite (per the
implementation plan's task breakdown) must show:

- **A fact row carries all seven FR-109 evidence fields.** `subject` (via
  `subject_ref`), `predicate` (via `predicate_raw`), `object`-or-value (via
  `object_ref` xor `object_value`), `confidence`, `evidence` (via
  `evidence_span`), `valid_time` (via `valid_from`/`valid_to`), and
  `provenance` are all present and non-null (or explicitly not-applicable
  where the schema allows it) on every written fact row, `HELD` rows
  included.
- **A fact whose source chunk cannot be reached is refused.** Per spec
  §3.2's provenance rule, a write attempt whose `source_chunk_id` does not
  resolve to a chunk GKS can retrieve fails closed — no `fact_rows` row is
  persisted, and the caller receives a structured rejection, not a
  best-effort write with a dangling reference.
- **Cross-tenant extraction is unwritable, not merely forbidden.** A test
  attempts a fact write whose subject or object resolves in a foreign
  tenant's scope and asserts the write does not persist — proven at the SQL
  layer (Q8), not only rejected by an application-level check that a future
  code path could bypass.
- **The stage's evidence row exports with metrics reporting zero-not-
  absent.** A Stage 10 execution that extracts zero facts still produces a
  `stage_evidence` parent row via `gks_stage_evidence_export` with every
  NFR-020 metric present and numeric (zero where nothing occurred), and an
  empty-but-present `records` array, never an omitted metric key.
- **Replaying the same chunk+extractor version produces no duplicate
  facts.** The same `(source_chunk_id, source_version, content_hash,
  extractor_version)` idempotency key, submitted twice, yields exactly the
  same `fact_rows` rows on the second call — no new rows, no error, the same
  no-op-on-replay guarantee `transactPromotion` already gives Stage 9's
  promotion path.
- **A held (`REVIEW_REQUIRED`-style) fact has a consumer.** At least one
  real input produces a `HELD` fact, the read tool lists it, and the human
  write operation resolves it — an unreachable `HELD` state is a vocabulary
  that lies, the same standard Stage 9's acceptance criteria held
  `AMBIGUOUS`/`REJECTED` to.
- **A pending-mention-endpoint fact materializes when Stage 9 resolves the
  mention.** A fact recorded against a still-unresolved Stage 9 mention
  (Q1) gains its `subject_ref`/`object_ref` once that mention is later
  bound or created, without requiring the original chunk to be
  re-extracted.
- **The commit-time cursor ordering guarantee holds under concurrent
  writes.** A conformance case (Q7) proves a later-committing write is
  never assigned a cursor value lower than one already exported.

## Alternatives rejected

1. **Model-assisted extraction as the primary method.** Rejected at Q2:
   FR-111's `cloud_processing_allowed = false` requirement means the primary
   path must run with zero external dependency, and a model call inside a
   stage whose evidence must be deterministic and replay-stable (Q6)
   introduces exactly the nondeterminism-and-latency problem Stage 9 rejected
   `LLM_ASSISTED` for. Not foreclosed forever — named as a separate, later
   decision, not folded into this one.
2. **Canonicalizing `predicate` at Stage 10.** Rejected at Q3: the spec
   assigns predicate canonicalization to Stage 11 by name (§16); doing it
   here would mean Stage 11 either redundantly re-derives a canonicalization
   already guessed at, or must reconcile two possibly-disagreeing answers to
   the same question. `predicate_raw` is named to make the omission visible
   in the schema, not merely in this document.
3. **A single `object` column with a type-discriminator tag.** Rejected at
   Q3 in favor of `object_ref` / `object_value` as two columns, exactly one
   populated — visible in the schema itself, not requiring a reader to
   branch on a separate tag field first.
4. **An auto-merge-style confidence floor identical to Stage 9's.** Rejected
   at Q5: extraction has no merge decision analogous to resolution's
   candidate-vs-existing-entity choice, so a floor framed as "merge or
   don't" does not fit; a write-gate framed as "write or hold" does, and it
   reuses Stage 9's D9 consumer pattern rather than inventing a differently-
   shaped gate.
5. **A bespoke evidence channel for Stage 10, independent of
   `stage_evidence`.** Rejected at Q7: `docs/ADR-GKS-LEDGER-REPORTING.md`
   already decided the transport for every remaining owned stage, Stage 10
   included by name; inventing a second transport here would be the exact
   six-different-response-shapes failure that ADR's D1 (Option A) argues
   against, recreated by one stage acting alone.
6. **A separate port-version bump for Stage 10's fact-write operation.**
   Rejected at Q4: both this ADR's fact-write addition and the ledger ADR's
   evidence-export addition are required persistence operations that break
   the same port-conformance contract in the same implementation window;
   recording them as two version numbers instead of one port version 3 with
   two named operations would fragment one adapter-facing break for no
   reader's benefit.
7. **Idempotency keyed on content hash alone.** Rejected at Q6: a re-edited
   source (new `source_version`) or a re-run under a newer extractor version
   are both legitimate reasons to produce new facts from what might hash
   identically or near-identically; keying on content hash alone would
   silently suppress those legitimate re-extractions.

## Change classification

- Complexity: `C-3`
- Risk: `MEDIUM`
- Primary risks: a new required persistence operation breaks the port
  replacement contract for every current and future adapter (shared with,
  not independent of, the ledger ADR's own port-3 risk); a `HELD` fact with
  no consumer recreates Stage 9's "system that can only refuse" failure if
  the human write operation ships late or is skipped under schedule
  pressure; predicate-raw facts with no Stage 11 in place yet mean Stage
  10's output is not directly queryable by canonical predicate until Stage
  11 ships, which is expected but should not be mistaken for a Stage 10
  defect; and idempotency-key collisions across near-identical chunks with
  a coincidentally matching content hash, though the four-component key
  (Q6) is specifically designed to make this unreachable in practice.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-31 | proposed | Initial draft. All eight open questions decided in full Proposed prose: chunk + Stage 9 resolution set as input (Stage 10 never re-resolves); rule-first extraction with a named, versioned extractor id, model-assist deferred; the `fact_rows` schema with `predicate_raw` staying raw for Stage 11 and `object_ref`/`object_value` as two columns; storage via a new migration and a port operation folded into the same port version 3 the ledger ADR already commits to, not a separate bump; a per-extraction-path confidence model with a `HELD`/`WRITTEN` write gate reusing Stage 9 D9's unresolved-mention consumer pattern; a four-component idempotency key (source identity, source version, content hash, extractor version) per BR-021's philosophy; evidence exported through `stage_evidence`/`gks_stage_evidence_export` at the ledger ADR's two-tier grain with Stage 10 named there as per-fact child records, plus the commit-time cursor ordering guarantee recorded as a conformance case when port version 3 lands; and the same tenant hard wall Stage 9's D5/D8 established, applied to fact pools and dedup. Pre-wrote the acceptance-criteria section for the future step-6 gate suite. | working-tree | Claude Fable 5 |
