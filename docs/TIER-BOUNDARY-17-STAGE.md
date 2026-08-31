---
version: "0.1.4b"
created_at: "2026-08-29T14:40:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-31T15:00:00+07:00,Claude Fable 5"
status: "beta"
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "cross-repository-boundary"
  scope: "the stages GKS owns in zuri-ai's seventeen-stage knowledge ingestion pipeline, and where their completion is reported"
---

# Tier boundary — the seventeen-stage knowledge ingestion pipeline

**Why this file exists.** GKS was assigned ownership of seven stages of a
pipeline defined in another repository, and until 2026-08-29 nothing in this
repository said so. A grep for `DPS-KI`, `17-stage`, `FR-109` or `ADR-050`
returned zero hits. Work could not be reported against stages nobody here knew
existed, and the number tracking them could not move.

This file is the record of that assignment. It is **not** a plan, a schedule, or
an authorization to build: it states what GKS owns, what each stage must be able
to report, and where completion is recorded.

## The pipeline, and who owns what

A separate system, **zuri-ai**, governs one logical pipeline from a raw source
artifact to published, retrieval-ready knowledge. Its ADR-050 assigns each stage
to a tier. GKS is **Tier 3 — Knowledge**.

| Stage | `pipelineStageId` | Owner |
|---:|---|---|
| 1–8 | `DPS-KI-INGEST` … `DPS-KI-ENTITY-EXTRACT` | zuri-ai (Tier 1) — **shipped** |
| **9** | **`DPS-KI-ENTITY-RESOLVE`** | **GKS** |
| **10** | **`DPS-KI-FACT-EXTRACT`** | **GKS** |
| **11** | **`DPS-KI-ONTOLOGY-MAP`** | **GKS** |
| **12** | **`DPS-KI-TEMPORAL-MAP`** | **GKS** |
| **13** | **`DPS-KI-GRAPH-BUILD`** | **GKS decides the graph; GenesisBlockDB writes it** |
| **14** | **`DPS-KI-ENRICH`** | **GKS** |
| 15 | `DPS-KI-EMBED` | GenesisBlockDB (Tier 4) |
| 16 | `DPS-KI-INDEX` | GenesisBlockDB (Tier 4) |
| **17** | **`DPS-KI-QUALITY-GATE`** | **GKS and GenesisBlockDB execute all five dimensions; zuri-ai holds the evidence and the decision** |

**The stage id is the key, not the number.** Sequence is documentation. An id
never changes meaning and is never renumbered — the same discipline this
repository already applies to its own contracts.

## What each owned stage must be able to report

A stage is not done when its logic runs. It is done when it can **report the
evidence its definition requires**. These are zuri-ai's requirements, restated
here so they are readable without leaving this repository:

| Stage | Required evidence |
|---|---|
| 9 — Entity Resolution | resolution outcome (`MATCHED` / `CREATED` / `AMBIGUOUS` / `REVIEW_REQUIRED` / `REJECTED`), strategy used, canonical entity id, confidence against the auto-merge policy floor |
| 10 — Relation / Fact Extraction | fact `subject` / `predicate` / `object` or value, `confidence`, `evidence`, `valid_time`, `provenance` |
| 11 — Schema / Ontology Mapping | canonical predicate, `ontology_version`, validation result, ontology-violation rejections |
| 12 — Temporal Mapping | `valid_from` / `valid_to` and `tx_from` / `tx_to` where applicable, or an explicit not-applicable |
| 13 — Graph Construction | node/edge counts by class, and for every business-assertion edge: provenance, confidence, temporal semantics, scope |
| 14 — Enrichment | `derivation_method`, `source_objects`, `confidence`, `generated_at`, `pipeline_version` — derived knowledge kept separate from verified source fact |
| 17 — Quality Gate | gate result across five dimensions, returned to zuri-ai which holds the decision |

**Stage 10** — Design pass in progress: [`ADR-GKS-FACT-EXTRACT.md`](ADR-GKS-FACT-EXTRACT.md)
(proposed, 0.1.0b). All eight of its open questions have a decided Proposed
answer; the approval gate is not yet open, so nothing in Stage 10 may be
built. This document's own evidence table above does not yet list NFR-020's
six cross-stage metrics — `ADR-GKS-LEDGER-REPORTING.md` records that as a
follow-up obligation, not fixed by this edit.

Stage 9 has an accepted ADR: [`ADR-GKS-ENTITY-RESOLUTION.md`](ADR-GKS-ENTITY-RESOLUTION.md)
(accepted 0.3.0b, errata 0.3.1b; gate open). All eight of its open questions were decided on
2026-08-29, so the shape of the work is settled: a mention/entity schema split,
a seven-rung resolver ladder whose FUZZY rung is capped structurally below the
0.85 auto-merge floor, additive-only MATCHED writes, and a tenant hard wall in
the lookup SQL. Read it before proposing Stage 9 work — the work is larger than
it looks, and the two supporting artifacts it depends on
([`GKS-PORT-CONTRACT.md`](GKS-PORT-CONTRACT.md) port version 2 and
[`NORM-V1-RULE-TABLE.md`](NORM-V1-RULE-TABLE.md)) are already written.

**A deterministic digest of a candidate string is not resolution** — and that
question is now settled and shipped, not open. Per the ADR's D2, the digest
became the `CREATED` branch of a read-then-decide resolver: promotion looks up
candidates in a scope-filtered pool, walks a seven-rung ladder, and only mints a
fresh digest ref when nothing matched. **Stage 9 shipped on 2026-08-30**, with
all four evidence fields (outcome, strategy, canonical entity id, confidence
against the 0.85 floor) riding `canonical_mappings`, verified against the real
MSP provider chain and reviewed by RKOI (two documentation errata, no code
findings).

## Where completion is reported

Two places, and both are outside this repository.

1. **`PRJ-KNOWLEDGE-17S`** — a Project in the zuri-ai application
   (Wannapa Workspace → TNT-EtohGroup → SmartGift → Development domain). Its
   single workstream `WST-KI-PIPELINE` holds one task per stage, each weight 1,
   named by the `DPS-KI-*` id above. Completing a stage means moving its task to
   `DONE` there. The project read **8/17 = 47.1%** when this file was written;
   **`DPS-KI-ENTITY-RESOLVE` shipped on 2026-08-30** and was reported per the
   protocol below, so the task move to 9/17 = 52.9% is zuri-ai's holder's to
   make against that evidence. The remaining eight tasks belong to GKS
   (10-14, 17) and GenesisBlockDB (15-16).

2. **`docs/roadmap/ROADMAP.md`** in the zuri-ai repository, row
   `PHASE-ZAI-KNOWLEDGE`. This is the delivery record GoVibe Mission Control
   reads directly.

GKS has no write access to either and should not acquire any. **Report the
completion; do not update the tracker.** The report belongs in the pull request
that ships the stage, naming the `DPS-KI-*` id and the evidence fields it now
produces, so whoever holds write authority on the zuri-ai side can move the task
against real evidence rather than a claim.

## What this does not change

- **The call direction is unchanged**: `Zuri / GoVibe -> MSP -> GKS`. MSP remains
  the sole caller. Owning a pipeline stage does not make GKS call outward, and it
  does not let zuri-ai call GKS directly.
- **`docs/ADR-GKS-BOUNDARY.md` still governs.** API-010 wire compatibility, the
  single canonical store, and the no-production-fallback rule all hold. A stage
  that breaks one of them is not shipped, whatever it does for the count.
- **Owning a stage is not authorization to build it.** Each one needs its own
  design pass; Stage 9 in particular is a substantial piece of work, not an
  addition to what exists.

## Source of truth

The definitions live in zuri-ai and are authoritative there:

- `docs/decisions/ADR-050-KNOWLEDGE-INGESTION-TIER-BOUNDARY.md` — the tier assignment
- `docs/domains/knowledge/features/FR-109-knowledge-ingestion-stage-catalog.md` — the catalog and per-stage evidence
- `docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md` — the specification underneath both

If this file and those disagree, those win, and this file is the thing to fix.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.4b | 2026-08-31 | beta | Added a Stage 10 design-pass pointer: `ADR-GKS-FACT-EXTRACT.md` (proposed, 0.1.0b), all eight open questions decided, approval gate not yet open. This edit does not add NFR-020's six cross-stage metrics to the evidence table above — that remains the follow-up obligation `ADR-GKS-LEDGER-REPORTING.md` recorded, out of this edit's scope; the table above is still incomplete on that point. | working-tree | Claude Fable 5 |
| 0.1.3b | 2026-08-31 | beta | Two stale statements corrected: the ADR citation still read "revision 0.3.0b, gate open" after `4a79bf7` raised the ADR to 0.3.1b via errata — now "accepted 0.3.0b, errata 0.3.1b; gate open"; and both mentions of "a six-rung resolver ladder" undercounted the ADR's ladder table, which has always had seven rungs (`CANONICAL_REF` through `CREATED`). This file's third staleness — the same failure mode as 0.1.1b and 0.1.2b, prose describing another artifact going stale the moment that artifact moves, this time caught before a stale copy propagated into `docs/reports/2026-08-31-stage-9-tracker-handoff.md`. | working-tree | Claude Fable 5 |
| 0.1.2b | 2026-08-30 | beta | Stage 9 shipped; the digest-vs-resolution question this file still called open was settled by ADR D2 and implemented. Flagged by RKOI's branch review as this file's second staleness in two days — prose describing another artifact goes stale the moment that artifact moves, and this file describes seven of them. | working-tree | Claude Opus 5 |
| 0.1.1b | 2026-08-29 | beta | Stage 9's ADR was accepted (0.3.0b, gate open, all eight questions decided) hours after this file called it an unapproved draft. The stale line said the ADR authorizes nothing, which by then was the opposite of true -- the exact failure this file exists to prevent, in the file that exists to prevent it. | working-tree | Claude Opus 5 |
| 0.1.0b | 2026-08-29 | beta | Recorded the seven stages GKS owns in zuri-ai's seventeen-stage pipeline, the evidence each must report, and where completion is reported — none of which was written anywhere in this repository before. | working-tree | Claude Opus 5 |
