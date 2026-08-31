---
version: "0.1.0b"
created_at: "2026-08-31T12:00:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T12:00:00+07:00,Claude Fable 5"
status: "proposed"
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "how Tier-3/4 stage evidence for DPS-KI-FACT-EXTRACT (10) through DPS-KI-QUALITY-GATE (17) reaches zuri-ai's FR-071 execution ledger without violating the GKS call-direction rule"
---

# ADR: Ledger Reporting — Tier-3/4 stage evidence reaches FR-071 (AC-109.12)

## Decision status

Proposed. This document authorizes no implementation, migration, or new tool by
itself. It exists to be decided **before** Stage 10 (`DPS-KI-FACT-EXTRACT`) is
built, because every one of GKS's remaining six owned stages — 10, 11, 12, 13,
14, 17 — needs an answer to "how does this stage's evidence reach zuri-ai" and
none of them should each invent their own answer. This ADR is that answer, once,
for all six. Task 3's implementation follow-on is gated on this document: Stage
10 must not ship un-reportable.

Three options are argued below. Option B is recommended and is what Task 3
should build against. Options A and C are recorded in full because the brief
that produced this document requires all three to be argued on their merits,
not merely named and dismissed.

## Context

zuri-ai's acceptance criterion **AC-109.12** requires that Tier-3 and Tier-4
stage work be reportable as evidence on zuri-ai's own execution ledger, FR-071
— the `PipelineRun` / `PipelineStep` / `PipelineRecordEvent` model. Nothing in
GKS today writes, or has ever written, a row to that ledger, and nothing in
zuri-ai reads from GKS on a schedule. The two systems have no evidence-transport
relationship at all yet.

`ADR-050` (zuri-ai) authorizes no GKS client inside zuri-ai — there is no
approved code path for zuri-ai to open a connection toward GKS and call it as a
service. `ADR-GKS-BOUNDARY.md` states the same prohibition from the other side:
GKS never calls outward to GenesisBlockDB, GoVibe, or MSP, and by extension
never calls outward to zuri-ai. Put the two together and neither side may open
a connection toward the other today, in either direction, as a standing rule
rather than a gap waiting to be filled by whichever side gets there first.

The one connection that is lawful, and already exists, is `Zuri / GoVibe -> MSP
-> GKS` — the call direction `CLAUDE.md` and `ADR-GKS-BOUNDARY.md` both fix as
the sole path into GKS. Any transport this ADR proposes has to be a shape that
rides that existing direction; it cannot add a new one, however convenient a
direct zuri-ai-to-GKS or GKS-to-zuri-ai call would be.

`docs/TIER-BOUNDARY-17-STAGE.md` already fixes what GKS owns and what each
stage must be able to report: stages 9 through 14 and 17, each with a fixed
evidence catalog, and NFR-020's six per-stage metrics —
`records_in`, `records_out`, `records_failed`, `records_quarantined`,
`processing_time`, `retry_count` — required on every stage execution. Stage 9
is done and its evidence rides the existing `gks_knowledge_promote` response,
per `ADR-GKS-ENTITY-RESOLUTION.md` D7: "Per-entity evidence is an additive
field on `canonical_mappings`, which already exists as the per-entity channel."
That precedent is real, it shipped, and it is the strongest argument for Option
A below.

It is also incomplete, and Task 1 found the incompleteness: Stage 9's own
evidence does not ride one channel. Seven of the nine reportable strategy
values (`CANONICAL_REF` through `CREATED`, the resolver ladder) ride
`canonical_mappings` on the promote response, exactly as D7 describes. The
other two — `HUMAN`, written by a D9 human-review bind, and `BACKFILL`, written
once by the migration — live on `entity_mentions` only and are never returned
by any promote response; `transactPromotion` explicitly refuses to record
`strategy HUMAN`. A caller that reads only the promote response, as D7's design
assumes every caller does, never sees either value. Stage 9 evidence already
flows on more than one channel today, silently, because "ride the response"
only covers evidence produced by the operation that returns the response — it
has no answer for evidence produced by a different write path (a human
decision, a migration backfill) that never returns anything to a caller at all.
That gap is part of why a uniform, independently queryable export is worth
having rather than continuing to extend the per-tool-response pattern six more
times.

None of stages 10–14 or 17 have a promote-response precedent to extend even if
Option A were chosen outright: they are unbuilt, and the tools that will carry
their primary work have not been designed. This ADR fixes the evidence-transport
shape *before* that design happens, so the primary-work tools and the evidence
transport are not designed twice.

## Decision

### D1 — Option A: push via MSP relay (evidence rides existing tool responses)

Each of the six remaining owned stages returns its evidence as an additive
field on whatever tool response its primary work already produces — the exact
pattern D7 used for Stage 9. The *caller* — MSP, then zuri-ai — is responsible
for landing that evidence on the FR-071 ledger; GKS's obligation ends at
including the fields in the response payload.

**In favor:** no new table, no new tool, no new port method. It is proven —
Stage 9 shipped this way and passed RKOI's review with zero code findings. It
keeps the evidence physically attached to the operation that produced it, so
there is never a question of which run a row belongs to.

**Against:** every intermediate hop between GKS and the FR-071 write must
forward the evidence faithfully — MSP must not drop or reshape the additive
fields, and zuri-ai must consume them synchronously with the call that produced
them, because there is no second chance to retrieve evidence for a specific run
after the fact. A push has no query surface: if MSP's forward fails, or
zuri-ai's write to FR-071 fails, or the two are simply out of order (zuri-ai
briefly unavailable while GKS is being called for other reasons), that
evidence is gone unless the caller happens to retry the entire original
operation, which is not guaranteed and, for a read-shaped stage like
`DPS-KI-QUALITY-GATE`, might not be idempotent in a way that reproduces the
same evidence twice. zuri-ai also needs a bespoke writer per tool response
shape — six stages, potentially six different response payloads to map into
one FR-071 model, rather than one importer against one contract. And Task 1's
finding above generalizes: any stage whose evidence is produced off the
primary-tool write path (a later correction, a re-run, a partial retry) has the
same "orphaned evidence" problem Stage 9 already has for `HUMAN` and
`BACKFILL` — Option A has no general answer for it, only a per-case one each
time it recurs.

### D2 — Option B (recommended): cursor pull via `gks_stage_evidence_export`

GKS persists one evidence row per stage execution in a new `stage_evidence`
table — new, because none exists today; Stage 9's evidence rides
`canonical_mappings` and `entity_mentions`, not a dedicated evidence table —
and exposes exactly one read-only registry tool:

```
gks_stage_evidence_export({ scope, since_cursor, limit })
  -> {
       rows: [{
         cursor,
         pipeline_stage_id,
         pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1",
         execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1",
         evidence: { /* per-stage catalog fields, per TIER-BOUNDARY-17-STAGE.md */ },
         metrics: {
           records_in, records_out, records_failed, records_quarantined,
           processing_time_ms, retry_count
         },
         produced_at
       }],
       next_cursor
     }
```

`evidence` carries the fields `TIER-BOUNDARY-17-STAGE.md`'s "What each owned
stage must be able to report" table already fixes per stage — subject /
predicate / object and confidence for Stage 10, canonical predicate and
`ontology_version` for Stage 11, and so on; this ADR does not re-derive them,
it fixes the envelope they travel in. `metrics.processing_time_ms` is the one
deliberate renaming in this shape: NFR-020 names the metric `processing_time`;
the export row spells it `processing_time_ms` so the unit is in the field name
rather than left to six separate stage implementers to assume or disagree
about. It is the same metric NFR-020 requires, named more precisely at the one
point where ambiguity would otherwise be free to creep in six times.

`stage_evidence` rows are append-only and immutable once written — a row is
never edited or deleted, only ever added — which is what makes them safe to
re-read from any earlier cursor at any later time. The underlying schema sketch
(illustrative; Task 3 owns the migration):

```
stage_evidence(evidence_id PK, scope_key,
                portfolio_id, tenant_id, business_id, workspace_id,
                project_id, sharing,
                pipeline_stage_id, pipeline_definition_id, execution_contract_id,
                run_id, provenance_ref,
                evidence_json, metrics_json,
                cursor, produced_at)
```

zuri-ai pulls through MSP — `zuri-ai -> MSP -> gks_stage_evidence_export` — on
its own schedule, exactly the lawful direction fixed in Context. zuri-ai owns
its own cursor and its own idempotent apply against FR-071, which is **the
exact mirror of its own FR-100 decision-export pattern**: FR-100 is a pull
zuri-ai already operates elsewhere in its own system, cursor-owned by the
puller, replay-tolerant by design. A zuri-ai engineer building this importer is
building a second instance of a pattern they already have working code for,
not inventing one. Because every row is immutable and keyed by its own
monotonic `cursor`, a replayed page — the same `since_cursor` requested twice,
whether from a retry, a crash, or an at-least-once delivery guarantee anywhere
in the MSP hop — returns the same rows and applying it twice is harmless by
construction, provided zuri-ai's apply is itself idempotent per row (which
FR-100's existing pattern already requires of it).

**In favor:** durable and queryable independent of the operation that produced
it — a `HUMAN`-class or `BACKFILL`-class evidence write (Task 1's finding) gets
the same export path as everything else, because the export reads a table, not
a response. One schema across six stages means zuri-ai writes one importer, not
six response-shape mappings. Cursor ownership sits where FR-071's own replay
tolerance already has to live — with the puller — rather than being invented
fresh for this one integration. GKS stays strictly passive: the tool is a
read, called only through the existing lawful direction, on zuri-ai's schedule,
not GKS's.

**Against:** a new table and a new port method — the same class of
port-contract break Stage 9's `lookupResolutionCandidates` was (recorded in
`GKS-PORT-CONTRACT.md` as port version 2), which means every current and
future persistence adapter must implement one more operation. zuri-ai must
build a new importer rather than extending an existing consumer, which Option
A would have let it avoid for a little longer. Evidence lags its production by
however long zuri-ai's pull interval is, which Option A's synchronous push
would not.

### D3 — Option C: do nothing until zuri-ai decides — rejected

Leave the transport shape undecided and let zuri-ai propose one when it needs
Tier-3 evidence for its own reporting.

**Rejected.** This is not a neutral default — it is the exact failure
`TIER-BOUNDARY-17-STAGE.md` was written to correct: "Work could not be reported
against stages nobody here knew existed" was true of the seven-stage
assignment itself before that document existed, and it would be true again,
stage by stage, of every evidence field on 10–14 and 17 if this decision is
deferred. Stage 10 would ship its primary logic with no fixed answer for how
its evidence leaves GKS, and whatever answer got improvised under deadline
pressure for Stage 10 would then either bind Stages 11–14 and 17 to a shape
nobody argued for, or each stage would improvise its own — recreating Option
A's six-different-response-shapes problem deliberately instead of by omission.
Deferring this decision does not remove it; it just moves it to whichever
engineer is under the most pressure when Stage 10 is due, which is the worst
time to make it.

### D4 — Decision consequences

- **The tool is registry-registered.** `gks_stage_evidence_export` goes through
  `packages/gks-contracts`' tool registry like every other public GKS tool, per
  `CLAUDE.md`'s hard rule — it is never wired directly onto
  `apps/gks-server` on its own.
- **The tool is scope-enveloped.** It takes a `KnowledgeScope` (per
  `GKS-PORT-CONTRACT.md`'s scope contract) exactly like `search`, `getEntity`,
  and `getRelations` do; there is no implicit or default scope, and
  `GKS_DEFAULT_PORTFOLIO_ID` is not a substitute for one — that variable exists
  only for legacy API-010 compatibility and this new tool has no legacy
  callers to be compatible with.
- **The tool is read-only.** It returns rows; it writes nothing, to GKS's own
  store or anywhere else. GKS remains a passive callee under this option, the
  same as under Option A and Option C: at no point does GKS open a connection
  toward zuri-ai or MSP. The call direction stays exactly
  `Zuri / GoVibe -> MSP -> GKS`, unchanged.
- **A metric a stage did not produce is reported as `0`, never omitted.**
  NFR-020's own framing — "zero, not absent" — is binding on every row this
  tool returns. A stage like `DPS-KI-ONTOLOGY-MAP` that has no natural
  `retry_count` concept still emits `retry_count: 0` in its row, not a missing
  key; an absent key is indistinguishable from "not yet computed" to whatever
  aggregates these rows on the zuri-ai side, and NFR-020 forecloses that
  ambiguity rather than leaving it to be rediscovered per stage.
- **This is a port surface change, deferred to Task 3 in its specifics.** Adding
  `gks_stage_evidence_export` and the `stage_evidence` persistence operation it
  reads from is the same class of break Stage 9's `lookupResolutionCandidates`
  was — a required addition to `GksServicePort` and `GksPersistencePort`,
  incrementing the documented port version in `GKS-PORT-CONTRACT.md` and the
  conformance suite that runs against every adapter
  (`tests/contract/persistence-port-conformance.test.mjs`). This ADR fixes the
  interface shape those changes must match; the exact port version number, the
  migration, and the conformance-suite updates are Task 3's implementation
  work, not this document's.
- **The ADR names which repo must still change.** GKS's obligation under this
  decision ends at exposing a replay-safe, scope-enveloped export. zuri-ai
  needs a scheduled pull importer that consumes
  `gks_stage_evidence_export` and writes `PipelineRecordEvent` rows under
  `DPL-KNOWLEDGE-INGEST-V1` / `EXC-KNOWLEDGE-INGEST-V1` — that importer is the
  ask in the companion change-request draft
  (`docs/reports/2026-08-31-cr-draft-ledger-pull.md`), not something GKS builds
  or can build, since GKS has no write path into zuri-ai's ledger under any
  option in this ADR.
- **This gates Task 3.** Stage 10 (`DPS-KI-FACT-EXTRACT`) must not ship without
  the ability to emit `stage_evidence` rows through this shape. Shipping Stage
  10's primary logic without its evidence transport would repeat the exact
  gap this ADR exists to close before it opens.

## Alternatives rejected

1. **Option A — push via MSP relay.** Argued in full at D1. Rejected as the
   recommendation because it has no query surface for evidence produced off
   the primary-tool write path — the exact gap Task 1 found already exists in
   shipped Stage 9 evidence (`HUMAN`, `BACKFILL`) — and because it would
   require zuri-ai to build a bespoke consumer per stage's response shape
   rather than one importer against one contract.
2. **Option C — do nothing until zuri-ai decides.** Argued in full at D3.
   Rejected because it recreates, deliberately this time, the exact failure
   `TIER-BOUNDARY-17-STAGE.md` was written to correct: work reported against
   nothing, because no one decided what "reported" means before the work
   shipped.
3. **A direct connection in either direction** — zuri-ai calling GKS as a
   service without going through MSP, or GKS calling zuri-ai to push evidence
   as it is produced. Rejected outright, not merely disfavored: `ADR-050`
   authorizes no GKS client inside zuri-ai, and `ADR-GKS-BOUNDARY.md` fixes
   `Zuri / GoVibe -> MSP -> GKS` as the only lawful call direction into GKS.
   Either direction here would require an ADR amendment to the boundary
   document itself before it could even be proposed as an option, which is a
   materially larger and separate decision this document does not make.

## Change classification

- Complexity: `C-2`
- Risk: `MEDIUM`
- Primary risks: a new required persistence operation breaks the port
  replacement contract for every current and future adapter, the same class of
  break Stage 9's `lookupResolutionCandidates` was; replay-safety on the GKS
  side is necessary but not sufficient — it depends on zuri-ai's own apply
  being idempotent per row, which this ADR states as a requirement on the
  companion CR but cannot enforce from the GKS side; and metric
  omission-vs-zero ambiguity recurring per stage if the "zero, not absent"
  rule is not enforced at the point each of the six stages is implemented,
  rather than only stated here.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-31 | proposed | Initial draft. Three options argued for how Stage 10–14/17 evidence reaches zuri-ai's FR-071 ledger under AC-109.12: push via MSP relay (Option A, Stage 9's D7 precedent), cursor pull via a new `gks_stage_evidence_export` registry tool and `stage_evidence` table (Option B, recommended), and deferring the decision (Option C, rejected). Records the nuance Task 1 found in shipped Stage 9 evidence — strategy values `HUMAN` and `BACKFILL` ride `entity_mentions` only, never the promote response, so evidence already flows on more than one channel today — as part of the case for a single uniform export surface. | working-tree | Claude Fable 5 |
