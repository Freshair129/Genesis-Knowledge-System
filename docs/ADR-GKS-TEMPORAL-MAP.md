---
version: "0.1.0b"
created_at: "2026-08-31T17:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T17:00:00+07:00,Claude Fable 5"
status: "proposed"
approval_owner: null
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "Stage 12 DPS-KI-TEMPORAL-MAP — bitemporal semantics ported from msp-runtime, the column mapping onto fact_rows, and evidence transport, decided before any code task is written"
---

# ADR: Temporal Mapping (Stage 12 — `DPS-KI-TEMPORAL-MAP`)

## Decision status

Proposed. This document authorizes no implementation, migration, or new tool
by itself. Per `docs/TIER-BOUNDARY-17-STAGE.md`, "owning a stage is not
authorization to build it — each one needs its own design pass"; this is
Stage 12's. The follow-on implementation plan,
`docs/superpowers/plans/2026-09-XX-stage-12-temporal-map.md`, is written only
after the Boss accepts this ADR — the same order Stage 9 and the Stage 10
design pass followed.

All five decisions below have a **Proposed** answer written in full concrete
prose, at the bar `ADR-GKS-ENTITY-RESOLUTION.md` and `ADR-GKS-FACT-EXTRACT.md`
both set: acceptance is an approval of concrete text, not a request for
homework.

This document is binding-downstream of two accepted-in-principle documents
already proposed ahead of it:

- `docs/ADR-GKS-LEDGER-REPORTING.md` (0.1.2b, proposed) fixes evidence
  transport for every remaining owned stage, Stage 12 included by name — it
  names Stage 12 explicitly as one of the stages whose catalog evidence is
  execution-level only, with **no per-record child entries** in the
  `stage_evidence` export's two-tier grain. D5 below answers in those terms.
- `docs/ADR-GKS-FACT-EXTRACT.md` (0.1.2b, proposed) already decided the
  `fact_rows` schema Stage 12 writes into — `valid_from`, `valid_to`,
  `tx_from`, `tx_to` are columns that ADR's Q3 already put on `fact_rows`,
  populated by Stage 10 at write time for the transaction-time pair
  (`tx_from` = the write's own commit time, `tx_to` = open/null until
  superseded) with the explicit note that this leaves "Stage 12's bitemporal
  mapping ... a transaction axis to refine rather than one it must
  retrofit." This ADR does **not** re-decide those four columns; it decides
  their semantics and which stage fills them under what rule, citing
  `ADR-GKS-FACT-EXTRACT.md` Q3 as the schema of record.

## Context

### What exists today

Stage 9 and the Stage 10 design pass are the only prior art. Stage 9 is
shipped; `ADR-GKS-FACT-EXTRACT.md` is proposed but not yet accepted, and
already carries the bitemporal columns Stage 12 needs — `fact_rows.valid_from
/ valid_to / tx_from / tx_to`, per that ADR's Q3. Nothing in GKS today reads
or writes those four columns with temporal semantics; Stage 10, as decided,
populates `tx_from`/`tx_to` mechanically at write time and leaves
`valid_from`/`valid_to` for Stage 12 to interpret. No fact has ever been
temporally mapped by anything in this repository, because no fact has ever
existed — Stage 10 is itself still proposed.

`docs/TIER-BOUNDARY-17-STAGE.md` row 12 fixes what Stage 12 must be able to
report: "`valid_from` / `valid_to` and `tx_from` / `tx_to` where applicable,
**or an explicit not-applicable**." That "or" is load-bearing — it is the
source of D3 below, and it is phrased as a requirement on the stage's
reporting, not a suggestion.

### The port source

`G:\govibe\packages\msp-runtime\src\domain\temporal-engine.mjs`, at GoVibe
commit **`79f339e`** (`79f339ec22686f4727b257ffa2c5a0167cd71212`, confirmed as
that repository's current `HEAD` at the time this ADR was drafted), is a
**vendored port**, not an import, of `scripts/mcp/temporal-versioning.mjs`'s
bitemporal semantics — the file's own header comment states this explicitly:
"This is a PORT, not a re-export: the logic below is copied from the source
module, not imported from it." `test/temporal-engine.parity.test.mjs` in that
same package asserts the two implementations stay behaviorally identical
(that file's own "AC-05"), running the vendored port and the original
`scripts/mcp/temporal-versioning.mjs` against ten shared fixture cases per
function and asserting equal results. Four functions are exported:
`createTemporalVersion`, `isTemporalVisible`, `compareTemporalOrder`, and
`nextVersion`. Their field vocabulary is `version`, `validFrom`, `validTo`,
`recordedAt`, `supersededAt` — camelCase, msp-runtime's own convention, not
GKS's `fact_rows` column names.

GKS has never had a runtime dependency on any GoVibe path, and
`tests/contract/dependency-boundaries.test.mjs`'s
`runtime_hasNoGenesisBlockOrGoVibeImports` case enforces this today by
scanning every file under `apps/` and `packages/` for the literal string
`G:\\govibe` (among others) and failing the build if it appears. Stage 12's
implementation must not defeat that test by accident — see D1's consequence
below.

### What must be decided before any code task is written

Five decisions, each requiring a decided answer at the bar the two prior ADRs
set:

1. Port, don't import
2. Column mapping
3. Not-applicable is a value
4. Where mapping runs
5. Evidence row

## Decision

### D1 — Port, don't import: re-implementation in `packages/gks-core`, pinned to commit `79f339e`, proven by a parity test

**Proposed.** Stage 12's temporal semantics — `isTemporalVisible` and
`compareTemporalOrder`, the two functions whose logic Stage 12 actually needs
— are **re-implemented** inside `packages/gks-core`, as new module
`packages/gks-core/src/temporal.mjs` (implementation-time file name; fixed
here only as "lives in `gks-core`, not `gks-persistence` or `gks-server`,"
following the same layering `resolve.mjs` already establishes for Stage 9's
resolver ladder in that package). `msp-runtime` is never added as a
dependency of any GKS package, in `package.json` or otherwise — it is not a
published package, GKS's own layering rules already forbid a `packages/*`
module reaching into another repository at runtime, and doing so would
invert the call direction `CLAUDE.md` fixes (`GoVibe -> MSP -> GKS`, never
the reverse) at the dependency-graph level even if no HTTP call were
involved.

**The same discipline the source itself uses.** msp-runtime's own
`temporal-engine.mjs` is a vendored port of `scripts/mcp/temporal-versioning.mjs`,
proven equivalent by `temporal-engine.parity.test.mjs` rather than trusted by
inspection. Stage 12 ports a second time from the same lineage — GKS's
`packages/gks-core/src/temporal.mjs` is a port of the msp-runtime port — and
inherits the identical obligation: a parity test,
`packages/gks-core/test/temporal.parity.test.mjs` (implementation-time path),
pinned to fixture inputs recorded from `temporal-engine.mjs` at commit
`79f339e`. Unlike msp-runtime's own parity test, GKS's version cannot import
the reference implementation directly — that would be exactly the runtime
GoVibe dependency this decision forbids — so the fixtures are **recorded
values**, not a live cross-repository import: the implementation plan
(Step 3) captures `isTemporalVisible`/`compareTemporalOrder`'s outputs for a
representative set of inputs (starting from the ten cases
`temporal-engine.parity.test.mjs` already exercises — boundary-inclusive
`validFrom`/`validTo`, exclusive `supersededAt`, out-of-order `recordedAt`,
invalid-timestamp handling) as static fixture data checked into GKS, and
GKS's parity test asserts its own port against those recorded values, not
against a live second implementation. This is deliberately weaker than
msp-runtime's own parity test — a fixture recorded once cannot catch drift in
the *source* if `temporal-engine.mjs` itself changes after commit `79f339e`
— which is exactly why the commit is named: drift is detected by a human
re-diffing `temporal-engine.mjs` against `79f339e` at a later date, not by
GKS's own test suite, which has no live channel to the source to detect that
kind of drift automatically.

**Which two functions, and why not all four.** `isTemporalVisible` and
`compareTemporalOrder` are the functions Stage 12 needs: the first answers
"is this fact's temporal claim visible as of a given valid-time and
transaction-time pair," the second validates a temporal claim's internal
ordering (`validFrom <= validTo`, `recordedAt <= supersededAt`) before it is
written. `createTemporalVersion` and `nextVersion` are **not** ported.
`createTemporalVersion` builds a fresh `{version, validFrom, validTo,
recordedAt, supersededAt}` object for msp-runtime's own UI-facing versioning
flow; Stage 12 has no analogous "construct a version object" step — it maps
directly onto `fact_rows`' four existing columns (D2), which already carry
the same information without an intermediate object shape. `nextVersion`
computes a UI-displayable integer version counter from a list of prior
records; `fact_rows` has no `version` column and does not need one — a
fact's temporal ordering is expressed by its `tx_from`/`tx_to` interval
directly (D2), the same way `entity_mentions` and `fact_rows` already order
history by timestamp columns rather than an incrementing integer elsewhere in
this codebase. Not porting these two is a scope decision, not an oversight:
if a later stage needs an integer version counter for display purposes, that
is a new, separate decision, not a retrofit of this one.

**Consequence — the port must not defeat the boundary test by naming its own
source.** `tests/contract/dependency-boundaries.test.mjs`'s
`runtime_hasNoGenesisBlockOrGoVibeImports` case fails the build if any file
under `apps/` or `packages/` contains the literal string `G:\\govibe`. Naming
the port source and commit in a comment inside
`packages/gks-core/src/temporal.mjs` — the natural place a reader would look
for exactly the provenance this decision cares about — would trip that test.
The provenance therefore lives **here, in this ADR** (`docs/` is outside the
scanned directories) and the ported file's own header comment points back to
this document by name (`ADR-GKS-TEMPORAL-MAP.md`) and states only that it is
a port with a parity test, the same shape `temporal-engine.mjs`'s own header
takes toward *its* source, without repeating the forbidden path string. This
is not a workaround around the boundary test; it is the correct place for
this information under the rule the test already enforces — drift-detection
provenance belongs in a design document a human re-reads, not in a runtime
comment a machine would otherwise have to be taught to ignore.

### D2 — Column mapping: `recorded_at`/`superseded_at` become `tx_from`/`tx_to`; `valid_from`/`valid_to` map 1:1

**Proposed.** The names differ between the two systems because msp-runtime's
vocabulary predates `fact_rows`' schema and FR-109's evidence list uses the
spec's names, not msp-runtime's — this table is carried explicitly for that
reason, not left to be inferred:

| msp-runtime field (`temporal-engine.mjs`) | `fact_rows` column (`ADR-GKS-FACT-EXTRACT.md` Q3) | Relationship |
|---|---|---|
| `validFrom` | `valid_from` | 1:1, camelCase → snake_case only |
| `validTo` | `valid_to` | 1:1, camelCase → snake_case only |
| `recordedAt` | `tx_from` | **Renamed.** msp-runtime's "when was this recorded" is the spec's transaction-time start. |
| `supersededAt` | `tx_to` | **Renamed.** msp-runtime's "when was this recorded-value superseded" is the spec's transaction-time end. |
| `version` (used by `createTemporalVersion`/`nextVersion` only) | *(no column)* | Not ported — D1. `tx_from`/`tx_to` interval ordering substitutes for an integer version counter. |

The rename from `recorded_at`/`superseded_at` to `tx_from`/`tx_to` is not
cosmetic: it is the same terminology `ADR-GKS-FACT-EXTRACT.md` Q3 already
uses for these two `fact_rows` columns and the same terminology
`TIER-BOUNDARY-17-STAGE.md` row 12 requires GKS to report against
(`tx_from` / `tx_to`, not `recorded_at` / `superseded_at`). A reader who
reaches `isTemporalVisible`'s ported body inside `packages/gks-core` and
then reaches `fact_rows` needs this table to know they are the same axis
under two names — without it, "transaction time" would appear to be
invented twice, independently, by two different documents that in fact agree.

**`isTemporalVisible`'s ported body keeps msp-runtime's internal field
names.** The function's own logic — comparing `asOfValidAt` against
`validFrom`/`validTo` and `asOfRecordedAt` against `recordedAt`/`supersededAt`
— is unchanged by the port; only the *column* names at the `fact_rows`
read/write boundary change. The port's exported signature (implementation
detail, fixed loosely here) accepts a `fact_rows` row, maps
`tx_from -> recordedAt` and `tx_to -> supersededAt` internally, calls the
ported logic unchanged, and returns a boolean — the rename happens once, at
the adapter boundary between `fact_rows` and the ported function, not
scattered through the ported function's body. This keeps the parity test
(D1) comparing like-for-like against the recorded fixtures, which are
expressed in msp-runtime's own field names.

### D3 — Not-applicable is a value, never an absence

**Proposed.** A fact with no temporal claim at all records `temporal:
"not_applicable"` **explicitly**, as a written value, never as an omitted
key or a `null` that could equally mean "not yet computed." This is
`TIER-BOUNDARY-17-STAGE.md` row 12's own requirement, read literally: "or an
explicit not-applicable" is not satisfied by leaving a field out — the same
zero-not-absent philosophy `NFR-020` fixes for the six cross-stage metrics
and `ADR-GKS-LEDGER-REPORTING.md` D4 restates for evidence rows generally
("A metric a stage did not produce is reported as `0`, never omitted").

**Where the value lives.** `fact_rows`' `valid_from`/`valid_to` columns are
the two columns this decision governs directly — a fact whose source chunk
carries no temporal claim (no date, no "as of," no versioned-effective-date
language in its `evidence_span`) gets `valid_from = "not_applicable"` and
`valid_to = "not_applicable"`, literal string values, not `NULL`. `NULL` is
reserved for "open-ended" (an ongoing fact whose `valid_to` is simply
unbounded going forward — a real, different semantic from "this fact has no
time axis at all") and must never be read as a synonym for not-applicable;
conflating the two would make an open-ended fact and a timeless fact
indistinguishable to any later reader filtering on `valid_to IS NULL`.
`tx_from`/`tx_to` are **never** `not_applicable`, for the reason
`ADR-GKS-FACT-EXTRACT.md` Q3 already states about `tx_from`: "transaction
time is a property of the write, not of the source content, so it is never
'not applicable' the way `valid_time` can be" — every write, temporally
mappable or not, has a commit time, and D4 below preserves that rule rather
than re-deciding it.

**Why `not_applicable` and not `null` at the export boundary too.** The
`gks_stage_evidence_export` row's aggregate evidence (D5) counts facts by
category, and one of those categories is explicitly "not-applicable," not
"unknown" or "unset." A puller aggregating Stage 12's evidence across many
executions needs to distinguish "GKS decided this fact has no valid-time
axis" from "GKS has not yet processed this fact's temporal claim" — the
first is `not_applicable`, permanent and correct; the second would be a
processing gap, a defect, not a valid terminal state. Only the first is a
value this ADR authorizes; the second must never be reported as if it were
the first.

### D4 — Where mapping runs: Stage 12 reads Stage 10's facts, extracts/normalizes temporal claims from evidence spans, and writes the four columns — it never invents time

**Proposed.** Stage 12 is a **mapping** stage, not an extraction stage in its
own right. Its input is `fact_rows` rows Stage 10 already wrote — subject,
predicate, object/value, `evidence_span`, and the `tx_from`/`tx_to` pair
Stage 10 already populated mechanically at write time (`ADR-GKS-FACT-EXTRACT.md`
Q3). Stage 12's job is confined to two things: (1) parse `evidence_span` for
a temporal claim — a date, a date range, an "as of"/"effective"/"until"
phrase in the source text the rule matched — and if one is found, populate
`valid_from`/`valid_to` from it, validated for internal ordering by the
ported `compareTemporalOrder` (D1) before the write is accepted; and (2) if
no temporal claim is found in the evidence span, write the `not_applicable`
value (D3) to both columns instead. Stage 12 **never invents a time** for a
fact whose source is silent on the matter — there is no fallback to "now,"
no inference from unrelated context, no default. A fact's absence of a
temporal claim is itself the correct, terminal answer (D3), not a gap to be
filled by a guess.

**`tx_from`/`tx_to` are not re-decided by Stage 12 for facts that pass
through unmapped.** For a fact whose `valid_from`/`valid_to` land on the
`not_applicable` path, `tx_from`/`tx_to` remain exactly what Stage 10's
write already set — Stage 12 has nothing to refine on the transaction axis
for a fact it made no temporal claim about. For a fact whose `valid_from`/
`valid_to` Stage 12 *does* populate from an evidence-span claim, that write
is itself a new transaction: following the standard bitemporal supersession
pattern the ported `isTemporalVisible`/`compareTemporalOrder` logic exists to
support (a fact's transaction-time interval closes when a later write
revises what is known about it, exactly the `recordedAt`/`supersededAt`
relationship `isTemporalVisible` checks), Stage 12's write closes the prior
row's open `tx_to` at its own commit time and opens a new row with
`tx_from` at that same commit time — the row Stage 10 wrote is not mutated
in place; a fact's temporal-mapping history stays inspectable as a sequence
of rows ordered by `tx_from`, the same "never overwritten, only
superseded" discipline `ADR-GKS-LEDGER-REPORTING.md` D2 gives
`stage_evidence` rows and Stage 9's `entity_mentions` audit trail already
follows for a different table. This is why `nextVersion`'s integer counter
(D1) is unnecessary: `tx_from` ordering already gives Stage 12's output a
total order without one.

**The tool surface, named now.** This mapping runs through one
registry-registered tool, **`gks_temporal_map`**, taking a batch of
`fact_rows` references (or the chunk-scoped set Stage 10's own extraction
call just produced, implementation detail for the plan) as its input.

- **The tool is registry-registered.** `gks_temporal_map` goes through
  `packages/gks-contracts`' tool registry like every other public GKS tool,
  per `CLAUDE.md`'s hard rule — it is never wired directly onto
  `apps/gks-server` on its own.
- **The tool is scope-enveloped.** It takes an explicit `KnowledgeScope` (per
  `GKS-PORT-CONTRACT.md`'s scope contract) exactly like `gks_fact_extract`
  and `gks_stage_evidence_export` do; there is no implicit or default scope,
  and `GKS_DEFAULT_PORTFOLIO_ID` is not a substitute for one — that variable
  exists only for legacy API-010 compatibility and this new tool has no
  legacy callers to be compatible with.

**Storage / port impact — the same port version 3, one more named
operation.** Writing a temporal mapping requires a new persistence port
operation, named now: **`transactTemporalMap`**, mirroring
`transactPromotion`'s and `transactFactExtraction`'s shape — a single
transactional write keyed on scope and the fact row(s) it maps, closing a
prior open `tx_to` and opening a new `tx_from`/`tx_to` pair per D4's
supersession rule above. `docs/ADR-GKS-LEDGER-REPORTING.md` D4 already
commits `gks_stage_evidence_export`/`stage_evidence` to **port version 3**,
and `ADR-GKS-FACT-EXTRACT.md` Q4 already adds `transactFactExtraction` to
that same version rather than opening a version 4 of its own. This ADR's
acceptance adds `transactTemporalMap` to that same port version 3, not a
version 5 of its own — a third required operation breaking the same
port-conformance contract (`tests/contract/persistence-port-conformance.test.mjs`)
in the same implementation window, recorded once against one version number
for the same reason the first two were: fragmenting one adapter-facing break
into three numbers serves no reader. `GKS-PORT-CONTRACT.md` records port
version 3 with all three operations named once all three ADRs are accepted.

**Tenant wall.** `fact_rows` reads Stage 12 performs to locate the prior open
row for a given subject/predicate/object (the row whose `tx_to` it will
close) apply every scope dimension **in SQL**, the same discipline
`ADR-GKS-ENTITY-RESOLUTION.md` **D5** (scope-filtered lookup) and **D3**
(refuse, never merge, below a floor) establish together for Stage 9's
resolver, and `tests/security/cross-tenant-deny.security.mjs` already
enforces for Stage 9's pool-level and merge-level cases and
`ADR-GKS-FACT-EXTRACT.md` Q8 restates for Stage 10's fact pool. A temporal
mapping is a write, and a write that closed tenant A's row because a
caller-side filter let tenant B's fact leak into the same lookup would be
exactly D3's "unrecoverable direction" applied to the transaction axis
instead of the entity-merge axis. This ADR does not re-argue D5/D3; it
applies the same rule to a new SQL query, following `ADR-GKS-FACT-EXTRACT.md`
Q8's precedent of restating rather than re-deriving it per stage.

### D5 — Evidence row: execution-level only, through Task 2's `stage_evidence` export, no per-record child entries

**Proposed**, in the exact terms `docs/ADR-GKS-LEDGER-REPORTING.md` D2 fixed
for Stage 12 by name: Stage 12 emits its evidence through the
`stage_evidence` table and the `gks_stage_evidence_export` cursor-pull tool,
at the two-tier grain that ADR decided — and Stage 12 is one of the stages
(9, 11, 12, 14, 17) the ledger ADR names as reporting "at execution
granularity already," meaning its parent row has **no child `records`
entries** — `records: []`, always present, never omitted, exactly as that
ADR's D2 fixes for every stage without per-record catalog evidence. Stage 12
does **not** get a `records` array the way Stage 10 and Stage 13 do; there is
no per-fact child entry for a temporal mapping, only the aggregate on the
parent row.

**Because there is no `records` channel, Stage 12's catalog evidence must
live entirely on the parent row's `evidence` object — it has nowhere else
to go.** This is the opposite of Stage 10's case: `ADR-GKS-FACT-EXTRACT.md`
Q7 gives Stage 10 an `evidence: {}` parent row precisely because Stage 10's
catalog evidence is per-fact and rides the `records` array instead. Stage 12
has no `records` array to ride, so its parent-row `evidence` object is where
`TIER-BOUNDARY-17-STAGE.md` row 12's catalog requirement — "`valid_from` /
`valid_to` and `tx_from` / `tx_to` where applicable, or an explicit
not-applicable" — must be satisfied, aggregated across the execution rather
than itemized per fact:

```
evidence: {
  facts_temporally_mapped: <count>,   // valid_from/valid_to populated from an evidence-span claim
  facts_not_applicable: <count>,      // valid_from/valid_to written as "not_applicable" (D3)
  facts_tx_time_only: <count>         // tx_from/tx_to advanced (D4 supersession) with no valid-time claim this execution
}
```

This is never `{}` for Stage 12, unlike Stage 10 — an execution that
processes zero facts still emits all three keys at `0` (the zero-not-absent
rule, restated below), but an execution that processes at least one fact
always has at least one non-zero key, because every fact takes exactly one
of the three paths above.

- **One parent row per stage execution**, carrying the six NFR-020 metrics
  (`records_in`, `records_out`, `records_failed`, `records_quarantined`,
  `processing_time_ms`, `retry_count`) alongside the `evidence` object above.
  `records_in` counts facts considered for temporal mapping in the
  execution; `records_out` counts facts that received a `tx_from`/`tx_to`
  write (D4) whether that write was a claim-derived mapping or a
  not-applicable/tx-only pass-through — every fact Stage 12 touches gets
  written, so `records_out` is not expected to diverge from `records_in`
  the way Stage 10's rule-miss gap can (`ADR-GKS-FACT-EXTRACT.md` Q2).
- **Metrics and evidence report zero, not absent.** A Stage 12 execution
  over a fact batch with no temporal claims anywhere still emits
  `facts_temporally_mapped: 0`, `facts_not_applicable: <n>`,
  `facts_tx_time_only: 0` (or whichever combination is true), and all six
  NFR-020 metrics numeric — never an omitted key, the same
  `ADR-GKS-LEDGER-REPORTING.md` D4 rule `ADR-GKS-FACT-EXTRACT.md` Q7 already
  restates for Stage 10, restated here for Stage 12 rather than left to be
  rediscovered at implementation time.
- **Cursor ordering is commit-time, per the ledger ADR's ordering
  guarantee.** A Stage 12 evidence row's `cursor` is assigned when the
  write commits, not when mapping starts — the identical requirement
  `ADR-GKS-FACT-EXTRACT.md` Q7 already states for Stage 10's evidence rows,
  applying to Stage 12's for the same reason: a slow mapping pass that
  starts before a faster one but commits after it must never be
  permanently skippable by a puller that has already advanced past the
  faster one's cursor. This is the same conformance case
  (`tests/contract/persistence-port-conformance.test.mjs` or the
  `stage_evidence`-specific suite) recorded once against port version 3
  when it lands, not a Stage-12-specific test of the same guarantee.

## Alternatives rejected

1. **Importing `msp-runtime` as a dependency.** Rejected outright at D1:
   `msp-runtime` is not a published package, and even if it were, a runtime
   import would invert the `GoVibe -> MSP -> GKS` call direction at the
   dependency-graph level and would be caught (and correctly failed) by
   `tests/contract/dependency-boundaries.test.mjs`'s
   `runtime_hasNoGenesisBlockOrGoVibeImports` case the moment the string
   `G:\\govibe` or `msp-runtime` appeared in a `require`/`import` inside
   `apps/` or `packages/`.
2. **Porting all four `temporal-engine.mjs` functions.** Rejected at D1:
   `createTemporalVersion` and `nextVersion` solve problems `fact_rows`
   does not have — an intermediate version-object shape and an integer
   version counter, respectively — both superseded by `fact_rows`' own
   four-column shape and `tx_from`-ordered history. Porting unused surface
   area would be dead code with its own parity-fixture burden and no
   consumer, the same reasoning `temporal-engine.mjs`'s own header gives
   for deliberately not vendoring `temporalColumns`/`readTemporalColumns`
   from its source.
3. **Naming the port source path and commit inside the ported source file's
   comment.** Rejected at D1's consequence: doing so would trip
   `tests/contract/dependency-boundaries.test.mjs`'s literal-string check on
   `G:\\govibe`. The provenance lives in this ADR, outside the scanned
   directories, with the ported file pointing back to the ADR by name
   instead of repeating the path.
4. **Treating `not_applicable` and `NULL` as interchangeable for
   `valid_from`/`valid_to`.** Rejected at D3: `NULL` already has a real,
   different meaning for `valid_to` specifically (open-ended, ongoing) that
   `not_applicable` must not collide with; collapsing the two would make an
   open-ended fact and a timeless fact indistinguishable to any reader
   filtering on `IS NULL`.
5. **A live cross-repository parity test importing `temporal-engine.mjs`
   directly, mirroring msp-runtime's own `temporal-engine.parity.test.mjs`
   exactly.** Rejected at D1: that shape is exactly the runtime GoVibe
   dependency this ADR forbids — msp-runtime's own parity test is sanctioned
   test-only tooling *inside that repository*, reaching sideways to its own
   `scripts/mcp/`, not a precedent for GKS reaching into a second
   repository. GKS's parity test instead runs against fixtures recorded
   once from the source at commit `79f339e`, a deliberately weaker guarantee
   whose gap (undetected drift if the source changes later) is named openly
   rather than papered over with a test shape the boundary rules forbid.
6. **Giving Stage 12 a `records` child array like Stage 10 and Stage 13.**
   Rejected at D5: `docs/ADR-GKS-LEDGER-REPORTING.md` D2 already names
   Stage 12 as execution-level-only by design — adding a `records` array
   here would contradict that ADR's own two-tier grain decision rather than
   apply it.

## Change classification

- Complexity: `C-2`
- Risk: `MEDIUM`
- Primary risks: a new required persistence operation (`transactTemporalMap`)
  breaks the port replacement contract for every current and future adapter,
  shared with, not independent of, the ledger ADR's and Stage 10 ADR's own
  port-3 risk; the parity test's fixture-based guarantee is weaker than
  msp-runtime's own live parity test and will not by itself catch drift if
  `temporal-engine.mjs` changes after commit `79f339e` — only a human
  re-diff catches that, which this ADR names as a limitation rather than a
  solved problem; and `not_applicable`-vs-`NULL` ambiguity for `valid_to`
  recurring at implementation time if the distinction (D3) is not enforced
  at the point the write path is coded, rather than only stated here.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-31 | proposed | Initial draft. All five required decisions written in full Proposed prose: port (not import) `isTemporalVisible`/`compareTemporalOrder` into `packages/gks-core`, pinned to GoVibe commit `79f339e`, proven by a fixture-based parity test (a live cross-repo import is rejected as the exact dependency the boundary test forbids); the `recorded_at`/`superseded_at` -> `tx_from`/`tx_to` column-mapping table, `valid_from`/`valid_to` mapping 1:1, `version` not ported; `not_applicable` as an explicit written value for `valid_from`/`valid_to`, distinct from `NULL`'s open-ended meaning, never an absence; Stage 12 as a mapping-only stage reading Stage 10's `fact_rows` and evidence spans, writing the four columns via a new `gks_temporal_map` tool and `transactTemporalMap` port operation folded into the same port version 3 the ledger ADR and Stage 10 ADR already commit to, with the tenant wall restated from Stage 9's D5/D3 precedent (not D8); and the Stage 12 evidence row through `stage_evidence`/`gks_stage_evidence_export` at the ledger ADR's execution-level-only grain for this stage — no `records` child array, with the per-fact catalog requirement aggregated onto the parent row's `evidence` object instead. | working-tree | Claude Fable 5 |
