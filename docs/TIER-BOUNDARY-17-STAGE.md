---
version: "0.1.0b"
created_at: "2026-08-29T14:40:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-08-29T14:40:00+07:00,Claude Opus 5"
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

Stage 9 has an ADR in draft: `docs/ADR-GKS-ENTITY-RESOLUTION.md`. It is not
approved and authorizes nothing; read it before proposing Stage 9 work, because
the shape of that work is already known to be larger than it looks.

**A deterministic digest of a candidate string is not resolution.** Two spellings
of the same real-world entity hash to two different canonical refs and stay apart
forever. Stage 9 is the stage that decides they are the same thing, says by which
strategy, and says how confident it is. Whether the existing `canonicalEntityRef`
scheme is a foundation for that or something it replaces is an open architectural
question, not a settled one.

## Where completion is reported

Two places, and both are outside this repository.

1. **`PRJ-KNOWLEDGE-17S`** — a Project in the zuri-ai application
   (Wannapa Workspace → TNT-EtohGroup → SmartGift → Development domain). Its
   single workstream `WST-KI-PIPELINE` holds one task per stage, each weight 1,
   named by the `DPS-KI-*` id above. Completing a stage means moving its task to
   `DONE` there. The project reads **8/17 = 47.1%** and **cannot move until a GKS
   stage lands** — every remaining task belongs to GKS or GenesisBlockDB.

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
| 0.1.0b | 2026-08-29 | beta | Recorded the seven stages GKS owns in zuri-ai's seventeen-stage pipeline, the evidence each must report, and where completion is reported — none of which was written anywhere in this repository before. | working-tree | Claude Opus 5 |
