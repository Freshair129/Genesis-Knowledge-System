---
version: "0.1.1"
created_at: "2026-08-31T12:30:00+07:00,Claude Fable 5,working-tree"
last_update: "2026-08-31T13:30:00+07:00,Claude Fable 5"
status: "draft"
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "cross-repository-change-request-draft"
  scope: "proposes a zuri-ai-side scheduled pull importer that closes AC-109.12 by consuming GKS's gks_stage_evidence_export tool"
---

# CR draft: scheduled ledger-pull importer for GKS Tier-3/4 stage evidence

**Target repository:** zuri-ai
**Requesting repository:** GKS (`D:\gks`)
**Closes:** AC-109.12
**Depends on (GKS side):** `docs/ADR-GKS-LEDGER-REPORTING.md` (Option B, status
`proposed` as of this draft) — this CR is written against that ADR's decision
and should not be submitted ahead of that ADR being accepted, since the tool
name and row shape below are only provisional until then.

This is a ready-to-submit change-request body. It is written from the GKS side
because GKS cannot open the corresponding ticket in zuri-ai's own tracker —
GKS has no write access there, per `docs/TIER-BOUNDARY-17-STAGE.md` ("GKS has
no write access to zuri-ai's tracker... and should not gain any"). Submitting
it, and deciding whether to submit it, is zuri-ai's call.

## Problem

AC-109.12 requires that Tier-3 and Tier-4 stage work — the seven stages GKS
owns (9 through 14, 17) — be reportable as evidence on zuri-ai's own FR-071
execution ledger (`PipelineRun` / `PipelineStep` / `PipelineRecordEvent`).
Today nothing writes that evidence into FR-071. GKS cannot write it directly:
`ADR-050` authorizes no GKS client inside zuri-ai, so there is no code path by
which zuri-ai could call out to GKS as a service even if it wanted to, and GKS
independently never calls outward to zuri-ai under its own boundary rule
(`ADR-GKS-BOUNDARY.md`). Both constraints point the same direction: the only
lawful connection is `zuri-ai -> MSP -> GKS`, initiated from zuri-ai's side,
not GKS's.

## Proposed change

Add a scheduled pull on the zuri-ai side:

```
zuri-ai -> MSP -> gks_stage_evidence_export({ scope, since_cursor, limit })
```

`gks_stage_evidence_export` is a read-only, scope-enveloped GKS registry tool
(per `docs/ADR-GKS-LEDGER-REPORTING.md` Option B) returning:

```
{
  rows: [{
    cursor,
    pipeline_stage_id,
    pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1",
    execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1",
    evidence: { /* per-stage, execution-level catalog fields */ },
    metrics: {
      records_in, records_out, records_failed, records_quarantined,
      processing_time_ms, retry_count
    },
    records: [ /* per-record catalog fields, Stage 10 (per-fact) and
                   Stage 13 (per-business-assertion-edge) only; empty or
                   omitted for every other stage */ ],
    produced_at
  }],
  next_cursor
}
```

The row grain is decided in `docs/ADR-GKS-LEDGER-REPORTING.md` D2: one parent
row per stage execution (carrying the six metrics and execution-level
evidence), plus one child entry in `records` per catalog item for the two
stages whose catalog evidence is inherently per-record. Child entries share
their parent row's `cursor` — they are not separately paginated.

The requested zuri-ai-side change is an importer that:

1. Calls `gks_stage_evidence_export` through MSP on a schedule (interval left
   to zuri-ai's own operational judgment — this CR does not prescribe one),
   starting from its own last-stored `since_cursor`.
2. For each row returned, writes `PipelineRecordEvent` rows under
   `pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1"` and
   `execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1"` at the grain the row
   itself carries: one `PipelineRecordEvent` from the row's `evidence` and
   `metrics` for a row with no `records`, or one `PipelineRecordEvent` per
   entry of `records` (still carrying the parent row's `metrics`) for a row
   that has them — mapping onto whatever `PipelineRecordEvent` fields
   zuri-ai's own FR-071 model expects for that `pipeline_stage_id`. This CR
   asks zuri-ai to confirm this is in fact `PipelineRecordEvent`'s intended
   grain before submission — see "Two assumptions this CR asks zuri-ai to
   confirm" below.
3. Applies each write idempotently, keyed on `cursor` for a row with no
   `records` (or on `(pipeline_stage_id, cursor)` if zuri-ai's ledger
   partitions by stage), and on `(cursor, record_index)` — the entry's
   position within `records` — for each child entry, so a repeat of the same
   page produces the same keys and re-applying it is a no-op, not a
   duplicate ledger entry.
4. Advances its stored cursor to the response's `next_cursor` only after the
   batch's writes are durably committed, so a crash mid-batch replays from the
   last durably-committed cursor rather than skipping rows.

## Cursor ownership and replay safety — stated explicitly

**Cursor ownership is zuri-ai's.** GKS does not track, store, or expose which
rows any particular caller has already consumed; `since_cursor` is supplied by
the caller on every call, exactly as `FR-100`'s existing decision-export
pattern already works on the zuri-ai side. This CR asks zuri-ai to operate a
second instance of a pattern it already has working code for, not to invent a
new one.

**Cursors are per-scope; there is no wildcard scope.** The importer's
`since_cursor` orders rows within one `KnowledgeScope` (mandatory
`portfolioId`, per `docs/GKS-PORT-CONTRACT.md`'s scope contract), not across
every scope GKS holds. If zuri-ai needs evidence from more than one scope, the
importer pulls each scope on its own `since_cursor` and stores each scope's
cursor separately — there is no scope value that means "every portfolio," and
enumerating which scopes to pull is the importer's problem, not something
`gks_stage_evidence_export` resolves on its behalf. This forecloses a specific
failure mode on the importer side: building a wildcard or "admin" scope so the
importer can pull every portfolio in one call would recreate
`GKS_DEFAULT_PORTFOLIO_ID` — the legacy compatibility shortcut GKS's own
`CLAUDE.md` forbids a new caller from relying on — under a new name, on the
zuri-ai side of the same boundary.

**GKS guarantees replay-safety of any exported page.** Rows in GKS's
`stage_evidence` table are append-only and immutable once written — never
edited, never deleted. Calling `gks_stage_evidence_export` twice with the same
`since_cursor` returns the same rows in the same order, whether the repeat
call is a genuine retry, a crash-recovery replay, or an at-least-once delivery
duplicate anywhere in the MSP hop. GKS's side of idempotency ends there: the
guarantee is that a replayed page is harmless to *re-read*. Whether re-reading
it is harmless to *re-apply* is step 3 above, and that half of idempotency is
zuri-ai's to build and to own — the same division of responsibility FR-100
already assumes for its own puller.

## Why this does not violate ADR-050

`ADR-050` authorizes no GKS client inside zuri-ai. This proposal does not add
one. The call `zuri-ai -> MSP -> gks_stage_evidence_export` reuses the MSP
client zuri-ai already has, per `FR-057` — MSP is the thing zuri-ai is
authorized to call, and MSP already knows how to reach GKS. Nothing here asks
zuri-ai to add a new dependency, open a new connection type, or call GKS
directly at any layer. The importer is new; the client it runs on top of is
not.

## Acceptance criteria (zuri-ai side)

- A scheduled job calls `gks_stage_evidence_export` through MSP and persists
  its own cursor, per scope pulled, across restarts.
- Every row returned is written as one or more `PipelineRecordEvent` rows
  under `DPL-KNOWLEDGE-INGEST-V1` / `EXC-KNOWLEDGE-INGEST-V1` at the grain the
  row carries — one event for a row with no `records`, one event per `records`
  entry for a row that has them; no row and no record entry is dropped
  silently on a mapping failure — an unmappable one is logged and blocks
  cursor advancement past it, not skipped.
- Replaying the same page (same `since_cursor`) twice produces no duplicate
  `PipelineRecordEvent` rows.
- A metric field present as `0` in the export row is stored as `0` in FR-071,
  not coerced to null or omitted — this is NFR-020's "zero, not absent" rule,
  and it only holds end-to-end if the importer preserves it on the write side
  as faithfully as GKS preserves it on the read side.
- AC-109.12 is satisfied for the first of Stages 10–14/17 to ship after this
  importer exists, before this CR is considered closed. (A Stage 9 backfill
  through this same export path is out of scope for this CR — it is unplanned
  work; if zuri-ai wants Stage 9's already-shipped evidence backfilled this
  way, that is a separate, not-yet-planned task, not part of this CR's
  acceptance.)

## Two assumptions this CR asks zuri-ai to confirm

This CR is written from GKS's reading of zuri-ai's own artifacts (`FR-100`,
`FR-071`, `FR-109`), not from access to zuri-ai's codebase — GKS has no read
or write path into zuri-ai under any option in the companion ADR. Before this
CR is submitted, it asks zuri-ai to confirm two load-bearing assumptions this
draft makes about systems GKS cannot itself inspect:

1. **That `FR-100`'s export is in fact cursor-owned-by-the-puller and
   replay-tolerant**, as this draft assumes throughout — the mirror this CR
   leans on to argue zuri-ai is building a second instance of a pattern it
   already has working code for, not a first one.
2. **`PipelineRecordEvent`'s intended grain** — specifically, whether one
   event per catalog record (this draft's assumption, following the row-grain
   decision in `docs/ADR-GKS-LEDGER-REPORTING.md` D2) is correct, or whether
   `PipelineRecordEvent` is intended to represent one execution regardless of
   how many catalog records it produced, in which case step 2 of "Proposed
   change" above needs to fold `records` into a single event's payload
   instead of emitting one event per entry.

## What GKS is not asking

GKS is not asking for write access to FR-071, `PRJ-KNOWLEDGE-17S`, or
`ROADMAP.md`. This CR asks zuri-ai to build a reader against a GKS-exposed,
read-only, replay-safe export — the write into zuri-ai's own ledger stays
entirely zuri-ai's, on zuri-ai's own schedule, using zuri-ai's own MSP client.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.1 | 2026-08-31 | draft | RKOI's review folded in. Aligned the `PipelineRecordEvent` mapping and the row shape with the ADR's decided row grain (parent row per execution plus per-record `records` entries for Stage 10/13), updating step 2/3 of "Proposed change" and the acceptance criteria accordingly. Stated cursors as per-scope with no wildcard scope, naming the `GKS_DEFAULT_PORTFOLIO_ID`-under-a-new-name failure mode it forecloses. Dropped the Stage-9-backfill option from the AC-109.12 acceptance criterion as unplanned work. Added a section asking zuri-ai to confirm two load-bearing assumptions before submission: FR-100's export being cursor-owned-by-the-puller and replay-tolerant, and `PipelineRecordEvent`'s intended grain. | working-tree | Claude Fable 5 |
| 0.1.0 | 2026-08-31 | draft | Initial companion CR draft, written against `docs/ADR-GKS-LEDGER-REPORTING.md` Option B: proposes a zuri-ai-side scheduled pull importer consuming `gks_stage_evidence_export` through the existing MSP client (FR-057), writing `PipelineRecordEvent` rows under `DPL-KNOWLEDGE-INGEST-V1` / `EXC-KNOWLEDGE-INGEST-V1`. States cursor ownership as zuri-ai's and replay-safety of exported pages as GKS's guarantee, mirroring FR-100's existing decision-export pattern. | working-tree | Claude Fable 5 |
