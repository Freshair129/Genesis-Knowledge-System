---
version: "0.1.2b"
created_at: "2026-08-31T17:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T20:00:00+07:00,Claude Fable 5"
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

- `docs/ADR-GKS-LEDGER-REPORTING.md` (0.1.3b, proposed) fixes evidence
  transport for every remaining owned stage, Stage 12 included by name — it
  names Stage 12 explicitly as one of the stages whose catalog evidence is
  **per-record**, alongside Stage 10 and Stage 13, carrying per-fact child
  entries in `records` in the `stage_evidence` export's two-tier grain. D5
  below answers in those terms.
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

**The same consequence applies to the parity test's fixture file, not only
`temporal.mjs`.** `packages/gks-core/test/temporal.parity.test.mjs` (D1,
above) and the fixture data file it loads both live under `packages/` and
are scanned by the same boundary test — an implementer documenting where
the recorded fixture values came from is the second natural place, after
`temporal.mjs` itself, to reach for `G:\\govibe` or
`temporal-engine.mjs`'s path in a header comment, because "these numbers
came from running the source at commit `79f339e`" is exactly the kind of
provenance a fixture file invites. That provenance line does not go there
either, for the identical reason: it lives in this ADR (D1's fixture
paragraph, above, which already names the commit and the ten source cases),
and the fixture file's own header points back to `ADR-GKS-TEMPORAL-MAP.md`
by name instead, the same pattern `temporal.mjs`'s header takes.

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

**`isTemporalVisible` and `compareTemporalOrder` take a neutral shape and
know nothing about `fact_rows`.** Both ported functions' own logic —
comparing `asOfValidAt` against `validFrom`/`validTo` and `asOfRecordedAt`
against `recordedAt`/`supersededAt` for the first; validating internal
ordering for the second — is unchanged by the port (D1). Their exported
signatures accept the **neutral** `{validFrom, validTo, recordedAt,
supersededAt}` shape msp-runtime's own source uses — the same shape the
parity test's fixtures (D1) are already expressed in. Neither function has
ever heard of `fact_rows`, `tx_from`, or `tx_to`, and the port does not
teach them those names; the *column* names at the `fact_rows` read/write
boundary are a separate concern, handled entirely by the adapter below.

**`temporalFromFactRow`, the row-to-shape adapter, lives beside the port in
the same module — never in `packages/gks-persistence`.** Reading a
`fact_rows` row and producing the neutral shape above is a small, pure
function, `temporalFromFactRow(row)` (implementation-time name), exported
from `packages/gks-core/src/temporal.mjs` alongside `isTemporalVisible` and
`compareTemporalOrder` — not from `gks-persistence`. This corrects the
initial draft's placement, which put the adapter in `gks-persistence` by
analogy to `entityFromRow`'s precedent there. That analogy does not hold:
unlike `entityFromRow`, an adapter living in `gks-persistence` would have to
call *into* `gks-core` to reach the ported functions it exists to feed, and
`gks-persistence` importing `gks-core` is exactly the edge
`tests/contract/dependency-boundaries.test.mjs`'s
`packages_followContractsCorePersistenceServerDirection` case rejects
(`expect(persistence).not.toMatch(/gks-core|gks-server/)`, line 47). The
layering these checks encode is a diamond — `gks-core` and `gks-persistence`
are siblings, neither importing the other, with `apps/gks-server` composing
both above them — and `gks-persistence` reaching sideways into `gks-core`
inverts that shape regardless of which direction the initial draft imagined
the call going. Keeping the whole adapter — pure port and row-shape
translation both — inside `gks-core` avoids the inversion entirely:
`temporalFromFactRow` takes the `fact_rows` row as a **plain data
argument**, with no `import` of `gks-persistence` anywhere in `gks-core`.
`apps/gks-server` is what composes the call in practice — it holds the row
(read through the persistence port) and passes it through
`temporalFromFactRow` into `isTemporalVisible`/`compareTemporalOrder`, the
same composition-at-the-top shape the server already uses elsewhere to join
`gks-core` logic to `gks-persistence` reads without either package depending
on the other. The mapping table above (`tx_from -> recordedAt`, `tx_to ->
supersededAt`, `valid_from -> validFrom` and `valid_to -> validTo` 1:1) is
exactly what `temporalFromFactRow` implements; the rename happens once,
inside this one function, not scattered through either ported function's
body — which is what keeps the parity test (D1) comparing the ported
functions like-for-like against fixtures expressed in msp-runtime's own
neutral field names, the same guarantee the initial draft described, now
with the adapter on the correct side of the boundary.
`tests/contract/dependency-boundaries.test.mjs`'s layering case reads only
the `gks-core`/`gks-persistence` `index.mjs` entrypoints, not every file
transitively reachable from them, so it cannot by itself stop a future file
from being added in the wrong package — placement discipline for
`temporalFromFactRow` is review-enforced, not test-enforced, the same as
D1's port-location rule above.

**The `not_applicable` sentinel must not reach either ported function as a
string.** Both `isTemporalVisible`'s `Date.parse(item.validFrom ??
item.recordedAt ?? ...)` and `compareTemporalOrder`'s own
`item.validFrom ? Date.parse(item.validFrom) : undefined`-style checks
(unchanged by the port, D1; `temporal-engine.mjs:28` and the corresponding
lines in `compareTemporalOrder`'s body in the source) choke on the literal
string `"not_applicable"` the same way: it is truthy, so `Date.parse` runs
and returns `NaN`, and each function's own `NaN` guard then treats the
value as invalid — `isTemporalVisible` returning `false` unconditionally
for every `asOfValidAt` (permanent invisibility, the exact silent data loss
D3's sentinel exists to prevent), `compareTemporalOrder` pushing a spurious
"not a valid ISO timestamp" error for a fact that was never claiming an
order in the first place. **Decided:** `temporalFromFactRow` maps
`valid_from: "not_applicable"` to `validFrom: undefined` and
`valid_to: "not_applicable"` to `validTo: undefined` **before calling
either ported function** — not just `isTemporalVisible`, and not by
special-casing either function's result afterward — so both see the same
neutral shape and neither has to special-case the sentinel itself. With
`validFrom` `undefined`, `isTemporalVisible`'s own fallback,
`item.validFrom ?? item.recordedAt` (unchanged from the source), takes
over and the fact becomes visible from its `tx_from` (mapped to
`recordedAt`, above) onward; `compareTemporalOrder` simply has nothing to
validate for an `undefined` `validFrom`/`validTo` (its own `item.validFrom
?` truthiness check short-circuits to `undefined` before `Date.parse` ever
runs) and reports no error for that pair — correct, since a fact with no
valid-time claim has no valid-time ordering to violate. This is a semantic
decision, not a mechanical mapping detail: a fact with no valid-time axis
is still knowledge that existed from the moment it was recorded, and the
sentinel that marks it `not_applicable` must resolve to "visible from
`tx_from`, no ordering violation," never to "never visible" or "always
invalid" — either of the latter would make writing the sentinel explicit
(D3) actively worse than leaving `valid_from` unmapped, which is not a
trade this ADR authorizes.

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

**Three states, not two — `valid_from` disambiguates all of them in storage
terms.** `NULL` does not carry one meaning; which meaning it carries depends
on whether `valid_from` itself is populated:

1. **`valid_from IS NULL`** — Stage 12 has not yet mapped this fact.
   Stage 10's write (`ADR-GKS-FACT-EXTRACT.md` Q3) populates `tx_from`/
   `tx_to` at write time but leaves `valid_from`/`valid_to` unset; a row in
   this state has simply not reached Stage 12 yet, or Stage 12 has not yet
   committed a decision for it. This is a processing gap, not a terminal
   value, and must never be read as either of the two states below.
2. **`valid_from = "not_applicable"`** — Stage 12 has decided this fact has
   no valid-time axis (above). `valid_to` carries the same literal string.
   This is a terminal, correct answer, permanent unless a later write
   revises the fact itself.
3. **`valid_from` populated with a real timestamp, and `valid_to IS NULL`**
   — an open-ended valid-time interval: the fact is known to hold from
   `valid_from` onward, with no known end. `NULL` means "open-ended" for
   `valid_to` **only in this state — only once `valid_from` itself carries a
   real value**. A `NULL` `valid_to` paired with a `NULL` `valid_from` is
   state 1 (not yet mapped), not an open-ended claim with an unknown start;
   the two must not be conflated by a reader who checks `valid_to IS NULL`
   alone without also checking `valid_from`.

The export boundary (D5) reduces state 1 out of existence before a puller
ever sees it — `gks_stage_evidence_export` only reports on facts Stage 12
has already processed, so states 2 and 3 are the only two an external
reader encounters. Inside `fact_rows` itself, all three states coexist for
as long as any fact remains unprocessed, which is why this disambiguation is
stated in storage terms here, not only restated at the export boundary
below.

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
ported `compareTemporalOrder` (D1) — which returns an **array of error
strings, not a boolean**; the write gate's pass condition is that array
being **empty**, and the write is rejected with the returned messages
otherwise — before the write is accepted; and (2) if
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

### D5 — Evidence row: aggregate counts on the parent row, per-fact detail in `records`

**Proposed**, amended from this ADR's initial draft to match
`docs/ADR-GKS-LEDGER-REPORTING.md` 0.1.3b, which moved Stage 12 from that
ADR's execution-only set into its per-record set alongside Stage 10 and
Stage 13 (D2 there). The reason: `TIER-BOUNDARY-17-STAGE.md` row 12's
catalog requirement — "`valid_from` / `valid_to` and `tx_from` / `tx_to`
where applicable, or an explicit not-applicable" — names **per-fact
fields**, not a count, and an execution-level aggregate never carries a
mapped value any single puller could attribute to any single fact. The
initial draft's execution-only answer substituted a count for that per-fact
requirement silently; this revision corrects it. Stage 12 still emits its
evidence through the `stage_evidence` table and the
`gks_stage_evidence_export` cursor-pull tool, at the two-tier grain that ADR
decides, now with Stage 12 carrying a `records` array the way Stage 10 and
Stage 13 already do.

**`records`, one entry per fact touched this execution.** Each entry names
the fact and its mapped columns — the exact per-fact catalog fields
`TIER-BOUNDARY-17-STAGE.md` row 12 requires, carried on the record rather
than aggregated away:

```
records: [{
  fact_id,
  valid_from,   // a timestamp, or "not_applicable" (D3) — never NULL/omitted
  valid_to,     // a timestamp, NULL (open-ended, D3), or "not_applicable"
  tx_from,      // always a timestamp (D3, D4) — never not_applicable
  tx_to         // a timestamp, or NULL (open, D4) until superseded
}]
```

This satisfies "where applicable, or an explicit not-applicable" at the
grain the requirement is actually stated at — per fact — rather than at the
execution grain the initial draft used. `records` is never omitted for
Stage 12, exactly as `ADR-GKS-LEDGER-REPORTING.md` D2 requires of Stage 10
and Stage 13's `records` arrays: an execution touching zero facts emits
`records: []`, not a missing key.

**The parent row's `evidence` object keeps the aggregate counts —
additive, not replaced.** A puller aggregating across many executions still
wants per-execution totals without re-summing every `records` entry itself,
the same reason Stage 10 and Stage 13 keep NFR-020's six metrics on the
parent row alongside their own `records` arrays. Stage 12's parent-row
`evidence` object is unchanged from the initial draft:

```
evidence: {
  facts_temporally_mapped: <count>,   // valid_from/valid_to populated from an evidence-span claim
  facts_not_applicable: <count>,      // valid_from/valid_to written as "not_applicable" (D3)
  facts_tx_time_only: <count>         // tx_from/tx_to advanced (D4 supersession) with no valid-time claim this execution
}
```

This is never `{}` for Stage 12 — an execution that processes zero facts
still emits all three keys at `0` (the zero-not-absent rule, restated
below), but an execution that processes at least one fact always has at
least one non-zero key, because every fact takes exactly one of the three
paths above, and that same fact contributes exactly one entry to `records`.
The counts in `evidence` and the entry count in `records` must always agree
— `facts_temporally_mapped + facts_not_applicable + facts_tx_time_only`
equals `records.length` for every row; the aggregate is a sum over the
detail, never an independent measurement that could drift from it.

- **One parent row per stage execution**, carrying the six NFR-020 metrics
  (`records_in`, `records_out`, `records_failed`, `records_quarantined`,
  `processing_time_ms`, `retry_count`) alongside the `evidence` object and
  the `records` array above. `records_in` counts facts considered for
  temporal mapping in the execution; `records_out` counts facts that
  received a `tx_from`/`tx_to` write (D4) whether that write was a
  claim-derived mapping or a not-applicable/tx-only pass-through — every
  fact Stage 12 touches gets written, so `records_out` is not expected to
  diverge from `records_in` the way Stage 10's rule-miss gap can
  (`ADR-GKS-FACT-EXTRACT.md` Q2). `records_out` and `records.length` are the
  same count for Stage 12, by the same one-fact-one-entry rule above.
- **Metrics and evidence report zero, not absent.** A Stage 12 execution
  over a fact batch with no temporal claims anywhere still emits
  `facts_temporally_mapped: 0`, `facts_not_applicable: <n>`,
  `facts_tx_time_only: 0` (or whichever combination is true), `records`
  populated with one entry per fact, and all six NFR-020 metrics numeric —
  never an omitted key, the same `ADR-GKS-LEDGER-REPORTING.md` D4 rule
  `ADR-GKS-FACT-EXTRACT.md` Q7 already restates for Stage 10, restated here
  for Stage 12 rather than left to be rediscovered at implementation time.
- **Cursor ordering is commit-time, per the ledger ADR's ordering
  guarantee.** A Stage 12 evidence row's `cursor` is assigned when the
  write commits, not when mapping starts — the identical requirement
  `ADR-GKS-FACT-EXTRACT.md` Q7 already states for Stage 10's evidence rows,
  applying to Stage 12's for the same reason: a slow mapping pass that
  starts before a faster one but commits after it must never be
  permanently skippable by a puller that has already advanced past the
  faster one's cursor. `records` entries share the parent row's cursor
  exactly as `ADR-GKS-LEDGER-REPORTING.md` D2 fixes for every stage with a
  `records` array — there is no separate cursor sequence for a fact-level
  entry to be reconciled against. This is the same conformance case
  (`tests/contract/persistence-port-conformance.test.mjs` or the
  `stage_evidence`-specific suite) recorded once against port version 3
  when it lands, not a Stage-12-specific test of the same guarantee.

## Alternatives rejected

1. **Importing `msp-runtime` as a dependency.** Rejected outright at D1:
   `msp-runtime` is not a published package, and even if it were, a runtime
   import would invert the `GoVibe -> MSP -> GKS` call direction at the
   dependency-graph level. This prohibition is enforced by **review**, and by
   `msp-runtime`'s absence from every GKS `package.json` — not by
   `tests/contract/dependency-boundaries.test.mjs`.
   `runtime_hasNoGenesisBlockOrGoVibeImports` matches the literal path
   strings `/GenesisBlock|G:\\GenesisBlock_Dev|G:\\govibe|D:\\msp/` against
   every file under `apps/` and `packages/`; a bare
   `import ... from "msp-runtime"`, naming only the package with no
   `G:\\govibe` or `D:\\msp` path string in it, would **not** match that
   regex and would **not** be caught by this test. The test's guarantee
   covers literal path strings only — it is not a general import linter, and
   claiming otherwise overstates what it enforces.
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
6. **Giving Stage 12 an execution-only evidence row with no `records` child
   array.** This was the initial draft's answer, rejected in D5's revision:
   `TIER-BOUNDARY-17-STAGE.md` row 12's catalog requirement names per-fact
   fields, not a count, and `docs/ADR-GKS-LEDGER-REPORTING.md` 0.1.3b moved
   Stage 12 into its per-record set to match. An execution-level aggregate
   answers "how many facts," never "what did Stage 12 decide for fact X" —
   the latter is what the requirement actually asks for, and only a
   `records` array can carry it.

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
| 0.1.2b | 2026-08-31 | proposed | RKOI's re-review: 7 of 8 findings from 0.1.1b closed cleanly; the MINOR-8 fix (placing `temporalFromFactRow` in `packages/gks-persistence`) introduced a layering inversion — `gks-persistence` calling into `gks-core` to reach the ported functions, which `tests/contract/dependency-boundaries.test.mjs:47` rejects (`persistence` must not import `gks-core`/`gks-server`; the diamond is `gks-core` and `gks-persistence` as siblings depending on nothing sideways, `apps/gks-server` composing both). D2's two adapter paragraphs are rewritten to a single two-function story: `isTemporalVisible`/`compareTemporalOrder` stay pure and neutral-shaped, knowing nothing of `fact_rows`; `temporalFromFactRow` moves into `packages/gks-core/src/temporal.mjs` itself, beside the port, taking the row as a plain data argument with no import of `gks-persistence` anywhere in `gks-core` — `apps/gks-server` composes the read-then-map-then-call sequence. The sentinel paragraph is rewritten to match: `temporalFromFactRow` maps `"not_applicable"` to `undefined` before calling *either* ported function, not just `isTemporalVisible` — `compareTemporalOrder`'s own `Date.parse` would choke on the raw sentinel identically, a free fix folded in on the same edit. | working-tree | Claude Fable 5 |
| 0.1.1b | 2026-08-31 | proposed | RKOI's review folded in — 5 important, 3 minor. Important — the Alternatives-rejected claim that `dependency-boundaries.test.mjs` would catch a bare `import ... from "msp-runtime"` was false (the test's regex matches literal path strings only, not the package name); reworded to attribute the prohibition to review plus `msp-runtime`'s absence from `package.json`. D2 now decides that the `fact_rows`-to-ported-function adapter maps the `not_applicable` sentinel to `undefined` *before* calling the ported `isTemporalVisible`, activating the source's own `validFrom ?? recordedAt` fallback so a timeless fact is visible from `tx_from` onward — closing the "sentinel string hits `Date.parse` → `NaN` → permanently invisible" gap the initial draft left open. D3 now names three storage states for `valid_from`/`valid_to`, not two: `valid_from IS NULL` (not yet mapped by Stage 12), `valid_from = "not_applicable"` (decided no-time-axis), and `valid_from` populated with `valid_to IS NULL` (open-ended — that meaning applies only once `valid_from` itself is populated). D5 reverses the initial draft's execution-only answer: Stage 12 moves into `ADR-GKS-LEDGER-REPORTING.md`'s per-record set (that ADR bumped to 0.1.3b in the same review), gaining a `records` array with one entry per fact naming its mapped `valid_from`/`valid_to`/`tx_from`/`tx_to` or the explicit `not_applicable`, while keeping the aggregate counts on the parent row's `evidence` object. Minor — D1's boundary-test consequence now also names the parity test and its fixture file as a place the forbidden path string must not appear; D4 states `compareTemporalOrder`'s pass condition explicitly (an empty error array, not a boolean); D2 names the adapter's package (`packages/gks-persistence`) and notes the layering test reads only `index.mjs` entrypoints, so placement is review-enforced. | working-tree | Claude Fable 5 |
| 0.1.0b | 2026-08-31 | proposed | Initial draft. All five required decisions written in full Proposed prose: port (not import) `isTemporalVisible`/`compareTemporalOrder` into `packages/gks-core`, pinned to GoVibe commit `79f339e`, proven by a fixture-based parity test (a live cross-repo import is rejected as the exact dependency the boundary test forbids); the `recorded_at`/`superseded_at` -> `tx_from`/`tx_to` column-mapping table, `valid_from`/`valid_to` mapping 1:1, `version` not ported; `not_applicable` as an explicit written value for `valid_from`/`valid_to`, distinct from `NULL`'s open-ended meaning, never an absence; Stage 12 as a mapping-only stage reading Stage 10's `fact_rows` and evidence spans, writing the four columns via a new `gks_temporal_map` tool and `transactTemporalMap` port operation folded into the same port version 3 the ledger ADR and Stage 10 ADR already commit to, with the tenant wall restated from Stage 9's D5/D3 precedent (not D8); and the Stage 12 evidence row through `stage_evidence`/`gks_stage_evidence_export` at the ledger ADR's execution-level-only grain for this stage — no `records` child array, with the per-fact catalog requirement aggregated onto the parent row's `evidence` object instead. | working-tree | Claude Fable 5 |
