---
version: "0.1.5b"
created_at: "2026-08-31T15:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T22:00:00+07:00,Claude Fable 5"
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
(0.2.0b, accepted): that ADR fixes how every remaining owned stage's evidence
reaches zuri-ai's FR-071 ledger, decided once for all six stages so Stage 10
does not invent its own transport. Question 7 below answers in those terms
rather than re-arguing them. The ledger ADR's acceptance opens `GKS-PORT-CONTRACT.md`
port version 3 for `gks_stage_evidence_export`/`stage_evidence`; this document's
own Q4 still governs when `transactFactExtraction` lands on that same version
— upon this ADR's own acceptance, which has not yet happened.

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

**The tool surface, named now.** This input contract arrives through one
registry-registered tool, `gks_fact_extract`, taking the chunk plus the
Stage 9 resolution set (above) as its input.

- **The tool is registry-registered.** `gks_fact_extract` goes through
  `packages/gks-contracts`' tool registry like every other public GKS tool,
  per `CLAUDE.md`'s hard rule — it is never wired directly onto
  `apps/gks-server` on its own.
- **The tool is scope-enveloped.** It takes an explicit `KnowledgeScope` (per
  `GKS-PORT-CONTRACT.md`'s scope contract) exactly like `gks_knowledge_promote`
  and `gks_stage_evidence_export` do; there is no implicit or default scope,
  and `GKS_DEFAULT_PORTFOLIO_ID` is not a substitute for one — that variable
  exists only for legacy API-010 compatibility and this new tool has no
  legacy callers to be compatible with.

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
          source_version, content_hash, idempotency_key, fact_index,
          review_status,
          decided_at)
UNIQUE(scope_key, idempotency_key, fact_index)
```

Notes on the shape, each one a decision:

- **`subject_ref` and `object_ref` are `canonical_ref`-shaped identifiers**
  (`gks:entity/...`) or a pending-mention reference (Q1), never bare strings.
  **`object_value`** is the literal-value alternative to `object_ref` for
  facts whose object is a value rather than an entity (the spec's own
  example: `quantity = 100`, `amount = 25,000 THB`) — exactly one of
  `object_ref` / `object_value` is populated per row, mirroring the FR-109
  evidence list's "object or value" phrasing directly in the schema rather
  than collapsing it into one ambiguous column. One column carrying two kinds
  of *ref* (canonical vs. pending-mention) is not the same shape as one
  column carrying a ref-or-a-literal, and it is why the two are decided
  oppositely below: `gks:entity/...` and `gks:mention/...` are self-describing
  prefixes — a reader determines which kind of ref a value is from the value
  itself, no side channel needed — whereas a bare literal (`25,000` or
  `"THB"`) carries no such marker and would need an added type tag to say
  what it even is.
- **`review_status`** distinguishes `WRITTEN` from `HELD` (values, exactly
  those two). It is not a derived or optional field: Q5's write gate assigns
  it on every row, Q7's evidence export reports it on every `records` entry,
  and two of the acceptance criteria below (the seven-field criterion, "HELD
  rows included"; and the held-fact-has-a-consumer criterion) are untestable
  without a column to query it from. Its omission from the schema block
  above in an earlier draft was an error the rest of this ADR already
  depended on it not being.
- **`source_version`, `content_hash`, `idempotency_key`, `fact_index`** give
  Q6's idempotency key a storage surface — the key decided in prose there had
  no column to live in. `content_hash` is `sha256(chunk_content)` (Q6);
  `idempotency_key` is the derived tuple `(source_chunk_id, source_version,
  content_hash, extractor_version)`; `fact_index` is the extracted fact's
  ordinal position within one extraction call's output, needed because one
  chunk extraction can produce several fact rows that all share the same
  `idempotency_key` — the key identifies the *extraction*, not any one fact
  inside it. `UNIQUE(scope_key, idempotency_key, fact_index)` is this ADR's
  answer, following Stage 9's precedent on both halves: `promotions` carries
  the idempotency key and a content hash (`source_hash`) checked against it on
  replay (`packages/gks-persistence/src/index.mjs:333-336`), and
  `entity_mentions`' `UNIQUE(scope_key, promotion_idempotency_key,
  candidate_ref)` (D1) is the same composite-uniqueness shape — one shared key
  column plus a per-row discriminator — reused here as `fact_index` in place
  of `candidate_ref`. Replaying the same chunk against the same extractor
  version, unchanged, recomputes the same `idempotency_key` for the same set
  of `fact_index` values and the write is a no-op against the existing rows,
  matching the acceptance criterion "replaying the same chunk + extractor
  version produces no duplicate facts" below.
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
- **`source_chunk_id` is an opaque, caller-supplied reference — not a foreign
  key to any GKS table.** GKS holds no chunk table and never fetches a chunk:
  doing so would mean GKS reaching upstream to retrieve content, breaking the
  `Zuri / GoVibe -> MSP -> GKS` call direction `CLAUDE.md` fixes as the one
  that must not invert. The chunk content Stage 10 extracts from arrives
  **inline**, in the Stage 10 input payload MSP hands over through
  `gks_fact_extract` (Q1), alongside `source_chunk_id` and `source_version` —
  Stage 10 is handed the content, not a pointer it must go resolve. This
  forecloses the one latent reason Stage 10 might otherwise read outward:
  fetching a chunk it was not handed is explicitly not GKS's job under this
  decision, the same explicit foreclosure `docs/ADR-GKS-LEDGER-REPORTING.md`
  D4 gives GenesisBlockDB's joint-stage half of Stage 13/17 by name. This
  ADR's acceptance criteria (below) key the provenance-refusal rule on
  `source_chunk_id` accordingly: not "does this id resolve to something GKS
  can go get," but "does the payload's own inline chunk content hash to what
  its `source_chunk_id`/provenance claims" — checked against the same
  `sha256(chunk_content)` Q6's idempotency key already computes from that
  same inline content. A write whose payload fails that check is refused at
  write time, never persisted with an unverifiable source.
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
itself rather than requiring every reader to branch on a tag field first —
see the `subject_ref`/`object_ref` note above for why that reasoning does
*not* also require splitting canonical-ref from pending-mention-ref into two
columns: those two are both refs, self-distinguishing by prefix, where a
ref and a literal are not.

### Q4 — Storage / port impact: a new migration, and port version 3 together with the ledger ADR

**Proposed.** `fact_rows` is a new table added by a new migration in the
top-level `migrations/` directory (`D:\gks\migrations\`) — the directory
`packages/gks-persistence` resolves at runtime via `DEFAULT_MIGRATIONS_DIR =
path.resolve(...,  "../../../migrations")`
(`packages/gks-persistence/src/index.mjs:10`), not a directory inside the
package itself — following `0001_init.sql` … `0004_human_resolution.sql`'s
numbering. **The next free number, not a hard-claimed `0005`, is what this
migration takes.** `docs/ADR-GKS-LEDGER-REPORTING.md` also owes a migration
for `stage_evidence` and names no number for it (its schema sketch there is
"illustrative; Task 3 owns the migration"). Both migrations are Task 3 work;
whichever lands first in implementation takes `0005_*.sql` and the other
takes `0006_*.sql` — migration numbers are assigned in acceptance-and-
implementation order, at implementation time, not reserved in advance by
either ADR's prose. Writing a fact row requires a new persistence port
operation, named now: **`transactFactExtraction`**, mirroring `transactPromotion`'s
shape (a single transactional write keyed on scope and idempotency key,
returning the idempotent-replay result described in Q6 when the key already
exists), added to `PERSISTENCE_OPERATIONS`, the same class of required
addition Stage 9's `lookupResolutionCandidates` was. Its exact parameter and
return shape is implementation detail Task 3 fixes; its name and its
transactional, idempotency-keyed contract are fixed here.

**This does require a port version bump, and it is the same bump the ledger
ADR already commits to, not a second one.** `docs/ADR-GKS-LEDGER-REPORTING.md`
D4 states that adding `gks_stage_evidence_export` and its `stage_evidence`
persistence operation is "a required addition to `GksServicePort` and
`GksPersistencePort`, incrementing the documented port version in
`GKS-PORT-CONTRACT.md`" to **port version 3**. The two triggers are unified,
not competing: the ledger ADR's acceptance records port version 3 with its
`gks_stage_evidence_export` / `stage_evidence` operation; this ADR's
acceptance adds `transactFactExtraction` to that same version 3, not a
version 4 of its own. Both additions are required operations that break the
same port-conformance contract
(`tests/contract/persistence-port-conformance.test.mjs`) in the same way, and
recording them as two separate version bumps for two changes that ship
together in one implementation branch would fragment one adapter-facing break
into two numbers for no reader's benefit. `GKS-PORT-CONTRACT.md` records port
version 3 with both operations named — `gks_stage_evidence_export` /
`stage_evidence` from the ledger ADR, `transactFactExtraction` from this
one — once both ADRs are accepted, since the edit must describe a port
surface both agree exists.

**Consequence.** Every current and future persistence adapter must implement
the fact-write operation once this ships, the same "every adapter that will
ever exist" consequence Stage 9's D8 named openly rather than working around
with an optional-operation escape hatch (rejected there for the same reason
it would be rejected here: an adapter without fact-writing support would
silently degrade Stage 10 to a no-op, not a documented configuration).

### Q5 — Confidence model: per-extraction-path confidence, `REVIEW_REQUIRED`-style holding state below a floor

**Proposed.** Confidence is assigned per extraction path, fixed structurally
by rule class — decided now, not deferred to a runtime knob or an
implementation-time default the way an earlier draft of this question left
it:

- **Explicit-statement rules** — a rule matching an unambiguous, explicit
  assertion in the source text (a labeled field stating the fact directly,
  not inferred from surrounding shape) — report a fixed confidence of
  **0.90**.
- **Structured / table-derived rules** — a rule matching a well-formed
  structural shape whose fields are positionally or structurally determined
  rather than read from prose (a well-formed invoice line, a key-value pair
  with an unambiguous key) — report a fixed confidence of **0.85**.
- **Pattern-inferred rules** — a rule matching a looser, inferential
  natural-language pattern (a free-text `"X purchased Y"` clause, a broader
  regex over unstructured prose) — report a confidence **capped at 0.70**.

Each rule's exact confidence is fixed in the rule table alongside
`extractor_version` (Q2), not invented at runtime — the same discipline
Stage 9's `STRATEGY_CONFIDENCE` table gives its rungs.

**The write gate is fixed at 0.80, structurally, not tuned.** This mirrors
Stage 9's own structural placement — `DETERMINISTIC` fixed at 0.88 sits above
the 0.85 auto-merge floor, `FUZZY` capped at 0.84 sits below it — applied here
to Stage 10's three rule classes instead of Stage 9's rungs: explicit-
statement (0.90) and structured (0.85) both clear the 0.80 gate, so their
facts write (`review_status = WRITTEN`); pattern-inferred is capped at 0.70,
structurally below the gate, so a pattern-inferred fact is *always* held
(`review_status = HELD`) — never a runtime toss-up between the two states for
that class. The gate's job is to place those three classes on those two sides
by construction, the same job Stage 9's floor does for its rungs; it is not a
value tuned against a validation set, and revisiting it later is a decision
about which rule classes reclassify, not a knob turned for accuracy.

**Extraction has no auto-merge floor, because there is nothing to merge — a
fact is either written or held.** Stage 9's floor exists to gate a
*resolution* decision (does this candidate become the same entity as an
existing one); Stage 10 has no analogous merge decision, since each extracted
fact is its own row, not a candidate being reconciled against a prior fact.
What Stage 10 needs instead is the write gate above: below it, the fact is
not silently discarded and not silently written at full trust — it is written
in a `REVIEW_REQUIRED`-style holding state, the `review_status` column (Q3)
distinguishing `WRITTEN` from `HELD`, and it does not participate in
downstream Stage 11/12/13 processing until a human or a later, more
confident extraction pass resolves it.

**This reuses Stage 9's D9 consumer pattern rather than inventing a second
one, and it is named now.** `ADR-GKS-ENTITY-RESOLUTION.md` D9 establishes the
precedent this ADR follows directly: "D3 produces `REVIEW_REQUIRED` and
`AMBIGUOUS` rows. Nothing in GKS can read them ... So Stage 9 ships with a
minimum consumption path: a read tool listing unresolved mentions within
scope, and one write operation applying a human decision." A held
low-confidence fact is the same shape of problem D9 names — "an unresolved
mention has a consumer, or D3 is a dead end" applies verbatim with "fact"
substituted for "mention": a held fact with no consumer is a system that can
only refuse. Stage 10 therefore ships its own minimum consumption path in the
same shape, through two registry-registered tools mirroring Stage 9's D9
naming (`gks_review_list` / `gks_review_apply`): **`gks_fact_review_list`**,
a read tool listing held facts within scope, and **`gks_fact_review_resolve`**,
a write operation applying a human decision (accept as written, reject, or
correct and re-write). Both are registry-registered through
`packages/gks-contracts` per `CLAUDE.md`'s hard rule, both take an explicit
scope envelope exactly like `gks_fact_extract` (Q1), and neither may rely on
`GKS_DEFAULT_PORTFOLIO_ID` — that variable is legacy API-010 compatibility
only, and this consumer has no legacy callers. This consumer is Stage 10's
own D9-equivalent step in its implementation plan's task breakdown, sequenced
last within Stage 10 for the same reason D9 was sequenced last within Stage
9 — the acceptance criteria below are untestable without it.

### Q6 — Idempotency: source identity + source version + content hash + extractor version

**Proposed**, per BR-021's philosophy as the brief states it: the idempotency
key is the tuple **source identity + source version + content hash +
extractor version**, taken together — not any one alone. Concretely, a fact
write's idempotency key is derived from `(source_chunk_id, source_version,
sha256(chunk_content), extractor_version)`. Replaying the same chunk against
the same extractor version, unchanged, produces the same key and therefore no
duplicate `fact_rows` entries — the write is a no-op against an existing key,
mirroring `transactPromotion`'s existing idempotency-row pattern — the
`selectPromotion` lookup and its source-hash conflict check
(`packages/gks-persistence/src/index.mjs:333-336`) — rather than inventing a
different replay mechanism for one stage. The storage surface for this key is
fixed in Q3's schema: `source_version`, `content_hash`, `idempotency_key`,
and `fact_index` (the last needed because `idempotency_key` alone identifies
one extraction call, not one fact within it).

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
  evidence Stage 10 has. Stage 10 has none beyond the metrics themselves —
  its catalog evidence is per-fact, not per-execution — but the row's
  `evidence` field is still always an **object**, `{}` in Stage 10's case,
  never `null` and never an omitted key. This is the same discipline the
  ledger ADR gives `records` (§D2: "never omitted, so an importer branches on
  one shape, not two") applied to `evidence` instead: one representation for
  "nothing here," not two an importer has to distinguish.
- **A `records` child array, one entry per extracted fact** — the ledger ADR
  (0.1.3b) names Stage 10 by name as one of three stages (with Stage 12 and
  Stage 13, Stage 12 added in that revision) whose catalog evidence is
  inherently per-record rather than per-execution: "Stage
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
  rather than only seeing it once a human resolves it. The lesson runs the
  opposite direction from how an earlier draft framed it: the ledger ADR's
  Task 1 finding showed that Stage 9's `HUMAN`/`BACKFILL` evidence does
  *not* ride any promote-response channel — it lives on `entity_mentions`
  only and is invisible to a caller reading just the response, evidence
  orphaned on a side channel by omission, not by design. A `HELD` fact left
  reachable only through `fact_rows` and the D9-style review tools (Q5) would
  repeat exactly that orphaning. Putting `HELD` facts on the `stage_evidence`
  export path deliberately — rather than leaving them to be rediscovered as a
  gap the way `HUMAN`/`BACKFILL` were — is what this bullet decides.
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

### Q8 — Tenant wall: the same hard wall as Stage 9's D5/D3

**Proposed.** Fact extraction pools and any deduplication of facts never
cross `tenant_id`, applied with the identical discipline Stage 9's D5 and D3
established: `tenant_id` is a tenant of its own, not a wildcard, and an
empty `tenant_id` matches only an empty-tenant fact, never "any tenant" (D5).
Crossing that wall to merge would be exactly the unrecoverable direction D3
names — "a merge is a write and is not recoverable" — applied here to a
cross-tenant write instead of a cross-candidate one: refuse, never merge. A
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
- **A fact whose source chunk fails provenance verification is refused.**
  Per spec §3.2's provenance rule, a write attempt whose inline chunk content
  (Q1's input contract — GKS never fetches a chunk) does not hash to what its
  `source_chunk_id`/provenance claims fails closed — no `fact_rows` row is
  persisted, and the caller receives a structured rejection, not a
  best-effort write with an unverifiable source.
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
| 0.1.5b | 2026-08-31 | proposed | Cascade from `ADR-GKS-LEDGER-REPORTING.md`'s acceptance (0.2.0b): the Decision status preamble's citation corrected from "(0.1.3b, proposed)" to "(0.2.0b, accepted)". This document's own status is unchanged by that acceptance — Stage 10 remains `proposed` and separately gated; only the transport ADR it depends on moved. | working-tree | Claude Fable 5 |
| 0.1.4b | 2026-08-31 | proposed | Final whole-branch review's BLOCKER-1: the Decision status preamble cited `ADR-GKS-LEDGER-REPORTING.md` as "(0.1.2b, proposed)" while that ADR was already at 0.1.3b at HEAD (this file's own Q7 already said so) — corrected the pointer to 0.1.3b. Fold-in: reordered this CHANGELOG table to descending (newest first), matching `ADR-GKS-TEMPORAL-MAP.md`, `ADR-GKS-LEDGER-REPORTING.md`, and `TIER-BOUNDARY-17-STAGE.md`, which were already descending while this table was still ascending. | working-tree | Claude Fable 5 |
| 0.1.3b | 2026-08-31 | proposed | Collateral from `ADR-GKS-LEDGER-REPORTING.md` 0.1.3b: that ADR moved Stage 12 into its per-record evidence set, making Q7's "exactly two stages (with Stage 13)" claim stale the moment it landed — corrected to name three stages (10, 12, 13). | working-tree | Claude Fable 5 |
| 0.1.2b | 2026-08-31 | proposed | Two corrections from RKOI's re-review: the Q6 replay note names its acceptance criterion instead of a line-number reference that had already drifted, and the tier-boundary pointer to this document was bumped to the revision it actually describes. | working-tree | Claude Fable 5 |
| 0.1.1b | 2026-08-31 | proposed | RKOI's review folded in: 3 critical, 5 important. Critical — Q3's schema now lists `review_status` (it was omitted while Q5/Q7 and two acceptance criteria already depended on it); the provenance-refusal wording no longer reads as GKS fetching a chunk (`source_chunk_id` is an opaque caller-supplied ref, never a foreign key — chunk content arrives inline in the Stage 10 input payload, and refusal validates the payload's content hash against provenance, mirroring the ledger ADR D4's outward-read foreclosure by name); Q6's idempotency key now has a storage surface (`source_version`, `content_hash`, `idempotency_key`, `fact_index`, `UNIQUE(scope_key, idempotency_key, fact_index)`, following Stage 9's `promotions`/`entity_mentions` precedent). Important — the write-gate and per-rule-class confidences are decided structurally now (explicit-statement 0.90, structured 0.85, pattern-inferred capped 0.70, gate fixed 0.80 — pattern-inferred always lands `HELD`), the same structural-not-tuned framing Stage 9's 0.85 floor uses; the persistence write operation is named `transactFactExtraction`, mirroring `transactPromotion`; the tool surface is named (`gks_fact_extract`, `gks_fact_review_list`, `gks_fact_review_resolve`, all registry-registered, scope-enveloped, none relying on `GKS_DEFAULT_PORTFOLIO_ID`); the two port-v3 triggers are unified (ledger ADR's acceptance records port version 3 with its export operation, this ADR's acceptance adds `transactFactExtraction` to the same version, "whichever accepted second" removed); execution-level `evidence` is always an object, `{}` when empty, never null or omitted. Minor — migrations path corrected to the top-level `migrations/` directory GKS's `DEFAULT_MIGRATIONS_DIR` actually resolves; the `transactPromotion` citation corrected to `index.mjs:333-336`; the tenant-wall citation corrected to D5 (+D3, +`cross-tenant-deny.security.mjs`), not D8; migration numbering states the assign-in-implementation-order rule instead of hard-claiming `0005`; the `HELD`-fact-export rationale's attribution inversion fixed (Task 1 showed `HUMAN`/`BACKFILL` evidence does *not* ride the promote response — it is `entity_mentions`-only and was orphaned there, which is why `HELD` facts are put on the export path deliberately); and a sentence added on why `subject_ref`/`object_ref` sharing one column across canonical/pending-mention refs is consistent with rejecting a tagged `object` column (self-describing prefixes vs. an untagged literal). | working-tree | Claude Fable 5 |
| 0.1.0b | 2026-08-31 | proposed | Initial draft. All eight open questions decided in full Proposed prose: chunk + Stage 9 resolution set as input (Stage 10 never re-resolves); rule-first extraction with a named, versioned extractor id, model-assist deferred; the `fact_rows` schema with `predicate_raw` staying raw for Stage 11 and `object_ref`/`object_value` as two columns; storage via a new migration and a port operation folded into the same port version 3 the ledger ADR already commits to, not a separate bump; a per-extraction-path confidence model with a `HELD`/`WRITTEN` write gate reusing Stage 9 D9's unresolved-mention consumer pattern; a four-component idempotency key (source identity, source version, content hash, extractor version) per BR-021's philosophy; evidence exported through `stage_evidence`/`gks_stage_evidence_export` at the ledger ADR's two-tier grain with Stage 10 named there as per-fact child records, plus the commit-time cursor ordering guarantee recorded as a conformance case when port version 3 lands; and the same tenant hard wall Stage 9's D5/D8 established, applied to fact pools and dedup. Pre-wrote the acceptance-criteria section for the future step-6 gate suite. | working-tree | Claude Fable 5 |
