---
version: "0.1.17b"
created_at: "2026-08-29T14:40:00+07:00,Claude Opus 5,working-tree"
last_update: "2026-09-11T21:00:00+07:00,Claude Opus 5"
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

This file is the record of that assignment and the current GKS contract. It is
not a schedule or a new authorization: the GenesisRAG17 baseline is implemented
under its approved contract, and future stage changes still require an
amended/versioned decision.

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
| **17** | **`DPS-KI-QUALITY-GATE`** | **GKS evaluates the five dimensions and owns the verdict; GenesisBlockDB supplies physical lane/readback evidence; zuri-ai holds the evidence and decision** |

The physical terminal order is strict. A Tier-4 graph receipt closes Stage 13
and authorizes GKS's actual `enrich_v1` operation, which closes Stage 14. The
later receipt closes Stages 15 and 16. A passing Stage 17 gate is closed only
by a publication receipt; a failed gate records terminal `FAILED` evidence
without publication. A worker failure records one `FAILED` terminal for its
exact Tier-4 stage and attempt; downstream stages never receive success
evidence.

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
| **every stage** | NFR-020's six per-stage metrics, on every execution, zero not absent: `records_in`, `records_out`, `records_failed`, `records_quarantined`, `processing_time_ms`, `retry_count` (`ADR-GKS-LEDGER-REPORTING.md` D2/D4 — the follow-up that ADR owed this table, paid 2026-09-07) |

**How legacy evidence leaves (implemented 2026-09-07).** Every row from the
legacy promotion path travels one way: a `stage_evidence` row written inside
the stage's own transaction, exported by `gks_stage_evidence_export` (port
version 3, read-only, scope-enveloped, cursor-paginated), relayed by MSP as
`msp_knowledge_evidence_export`, and pulled by zuri-ai's importer on its
schedule. Stage 9 writes its row on every promotion — bound to the `run_id` the
caller named — and on every D9 bind or merge; the migration backfilled every
execution that predated the table. zuri-ai has pulled a live Stage 9 row from
this repository onto its ledger (zuri-ai ADR-068, its
`fr110-knowledge-evidence-chain` test).

The GenesisRAG17 `gks_pipeline_evidence` stream is separate and carries the
immutable batch and receipt chain for stages 9–17. Its pipeline metric names,
stage identities and cursor are not legacy `stage_evidence` rows. Nothing in
either path gives GKS an outbound connection.

The two evidence ledgers are deliberately separate. The legacy
`gks_stage_evidence_export` reader keeps port-v3/NFR-020 names such as
`records_failed` and `processing_time_ms`. The new `genesisrag17.v1`
`gks_pipeline_evidence` reader keeps its frozen six-key metric shape:
`records_in`, `records_out`, `records_quarantined`, `error_count`,
`retry_count`, and `duration_ms`. An MSP or zuri-ai adapter must not silently
translate one ledger into the other or treat a legacy row as a pipeline
terminal.

**Stage 10** (`DPS-KI-FACT-EXTRACT`) — Implemented under the accepted
[`ADR-GKS-FACT-EXTRACT.md`](ADR-GKS-FACT-EXTRACT.md) amendment. The isolated
`rule_v1` evaluator records explicit, structured and held inferred candidates;
its evidence travels in `pipeline_evidence` with the six fixed metrics.

**Stage 12** (`DPS-KI-TEMPORAL-MAP`) — Implemented under the accepted
[`ADR-GKS-TEMPORAL-MAP.md`](ADR-GKS-TEMPORAL-MAP.md) amendment. Its bitemporal
semantics are a port, not an import, of the pinned MSP source at commit
`8b8667dadf01fd7f421260af8b8b260f6cac267f`, re-implemented in
`packages/gks-core` with the committed fixture-based parity test.

Stage 9 has an accepted ADR: [`ADR-GKS-ENTITY-RESOLUTION.md`](ADR-GKS-ENTITY-RESOLUTION.md)
(current 0.4.0b; gate open). All eight of its open questions were decided on
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

## Current GenesisRAG17 stage contract and extension points

The following is the implemented GKS baseline for `genesisrag17.v1`. The
authoritative cross-repository definitions are zuri-ai's
[`KNOWLEDGE-INGESTION-17-STAGE-SPEC.md`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md)
and
[`KNOWLEDGE-INGESTION-17-STAGE-FLOW.md`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-FLOW.md).
The current isolated execution and publication decision is [ADR-073 —
GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md).
GKS records the service-side input, output, terminal evidence, failure rule,
and extension seam below. Source line references are intentionally precise so
a future implementer can check the running contract before editing a document.

Every call carries `schemaVersion: "genesisrag17.v1"`, the six explicit scope
strings (`portfolioId`, `tenantId`, `businessId`, `workspaceId`, `agentId`,
`visibility`), the MSP relay credential, and an authenticated principal. The
batch validates source and chunk SHA-256 hashes, UTF-16 offsets, and each
occurrence's `sourceMentionId`. Every terminal row carries the exact stage
identity (`runId`, `pipelineStageId`, `executionStepId`, `attemptId`) and the
six pipeline metrics. See the
[pipeline validator](../packages/gks-contracts/src/pipeline.mjs#L290-L345),
[decision builder](../packages/gks-core/src/pipeline.mjs#L152-L327), and
[pipeline migration](../migrations/0006_genesisrag17_pipeline.sql).

### Stage 9 — `DPS-KI-ENTITY-RESOLVE`

- **Input:** validated `source`, ordered `chunks`, and occurrence-level
  `mentions` (`sourceMentionId`, `resolutionKey`, `semanticType`, name, chunk
  and UTF-16 offsets).
- **Output:** one canonical entity per distinct typed identity in the exact
  scope. The internal identity pair is `[norm_v1(resolutionKey),
  normalizeSemanticType(semanticType)]`; every occurrence id remains on its
  typed entity, and `metadata.semanticType` records the supplied type. The
  existing GKS identity store is consulted through
  `lookupResolutionCandidates`, with canonical lookup included in Stage 9's
  measured interval. Same-name incompatible types remain separate.
- **Evidence:** `SUCCEEDED` terminal evidence is written at submit together
  with the immutable decision; the decision and `pipeline_mentions` retain
  occurrence ids, source references, and stage metrics. A canonical entity is
  not an occurrence and a resolution key never replaces an occurrence id.
- **Failure:** malformed source/chunk/mention hashes or offsets, scope
  mismatch, idempotency conflict, and canonical uniqueness conflict fail the
  submission atomically. A real retry uses a new attempt identity; a delivery
  retry reuses the same batch hash.
- **Extension point:** resolver strategies and a future `norm_v2` require an
  ADR and versioned artifact. Preserve the existing `entities` store and
  `sourceMentionId` rows; do not introduce a parallel pipeline identity store.
- **Code and tests:**
  [`pipeline.mjs`](../packages/gks-core/src/pipeline.mjs#L152-L184),
  [`service lookup`](../packages/gks-core/src/index.mjs#L92-L105),
  [`entity ADR`](ADR-GKS-ENTITY-RESOLUTION.md), and
  [`pipeline contract tests`](../tests/contract/pipeline-genesisrag17.test.mjs#L119-L151).

### Stage 10 — `DPS-KI-FACT-EXTRACT`

- **Input:** Stage 9's resolved occurrence set and inline chunk text. Stage 10
  does not re-resolve entities and does not read a source store.
- **Output:** raw-predicate candidates become `facts` when they meet the write
  floor, while below-floor candidates remain in `held`. Explicit positive
  `works for`/`purchased` statements score `0.90`; structured equivalents
  score `0.85`; inferred/co-occurrence candidates are capped at `0.70` and
  remain held. Coordinated clauses preserve the grammatical subject only across
  the supported `and`/`&` conjunction when no new subject mention occurs.
  Unsupported coordination, such as `but purchased` or a bare comma before
  the next predicate, is held with `ambiguous_subject_binding`; negated
  relations, including `neither ... nor`, never become verified facts.
  `sourceReferences` keeps source, artifacts, chunk and mention ids.
- **Evidence:** the submit transaction writes the Stage 10 terminal row with
  the six pipeline metrics; the immutable decision carries `facts`, `held`,
  raw predicates, confidence, basis and source references.
- **Failure:** negated/question forms are excluded, unsupported subject
  coordination is held with `ambiguous_subject_binding`, invalid source
  provenance is rejected before persistence, and unknown or below-floor
  candidates are held with a reason rather than promoted as verified facts. A
  conflicting batch hash is a terminal idempotency conflict.
- **Extension point:** a new extractor is a new named/versioned method (for
  example `rule_v2`) and must preserve raw predicate ownership for Stage 11;
  it must not silently rewrite `rule_v1` or add an unreviewed model call.
- **Code and tests:**
  [`extractor and confidence rules`](../packages/gks-core/src/pipeline.mjs#L47-L151),
  [`fact/hold path`](../packages/gks-core/src/pipeline.mjs#L199-L254),
  [`fact ADR`](ADR-GKS-FACT-EXTRACT.md), and
  [`confidence tests`](../tests/contract/pipeline-genesisrag17.test.mjs#L153-L181).

### Stage 11 — `DPS-KI-ONTOLOGY-MAP`

- **Input:** Stage 10 candidates with their raw predicate, resolved endpoint
  ids and endpoint semantic types.
- **Output:** Stage 11 produces `ontology_v2` (ADR-075 Phase 2, contract
  revision 2). The `ontology_v1` aliases still map to `WORKS_FOR` or
  `PURCHASED`; `has component`, `priced at` and `in category` map to
  `HAS_COMPONENT`, `PRICED_AT` and `IN_CATEGORY`. Endpoints come from one
  predicate -> {subject types, object types} table per version: `WORKS_FOR`
  accepts `PERSON -> ORGANIZATION` and `PURCHASED` accepts
  `PERSON|ORGANIZATION -> PRODUCT`; v2 adds `HAS_COMPONENT: PACKAGE -> PRODUCT`,
  `PRICED_AT: PRODUCT|PACKAGE -> PRICE_TIER` and
  `IN_CATEGORY: PRODUCT|PACKAGE -> CATEGORY`. Invalid endpoints and unknown
  predicates are retained in `held` with a reason.
- **Evidence:** the submit transaction writes a Stage 11 terminal row and
  metrics; the decision pins `ontologyVersion: "ontology_v2"` and carries the
  canonical predicate on accepted facts. A decision stored under `ontology_v1`
  before the upgrade keeps that version and is gated against the
  `ontology_v1` table.
- **Failure:** unknown aliases, invalid endpoint types, scope mismatch, or a
  decision hash conflict prevent a verified fact from entering later stages.
  GKS does not invent an ontology version on receipt.
- **Extension point:** aliases, endpoint types, or ontology version changes
  require a new approved ontology artifact and decision hash. Existing
  `ontology_v1` aliases remain frozen for replay.
- **Code and tests:**
  [`ontology mapping`](../packages/gks-core/src/pipeline.mjs#L226-L270),
  [`frozen constants`](../packages/gks-contracts/src/pipeline.mjs#L13-L72),
  [`ontology tests`](../tests/contract/pipeline-genesisrag17.test.mjs#L153-L181).

### Stage 12 — `DPS-KI-TEMPORAL-MAP`

- **Input:** ontology-accepted facts and the source chunk evidence span.
- **Output:** temporal fields `validFrom`, `validTo`, `txFrom`, and `txTo` on
  each fact. A source with no temporal language writes explicit
  `not_applicable` for the valid-time pair. An actual supported date with no
  end is open-ended (`validTo: null`); an unsupported temporal expression is
  unmapped and held with reason `temporal_unmapped`, retaining its original
  source references. It is never emitted as a verified `null`/`null` fact.
  These are distinct states.
- **Evidence:** submit writes the Stage 12 terminal row and metrics; temporal
  values remain in each immutable fact when mapped, while held unmapped claims
  retain their source references.
  The bitemporal parity baseline is the MSP temporal engine at commit
  `8b8667dadf01fd7f421260af8b8b260f6cac267f`, represented by the local pure
  helper and fixture test rather than a runtime MSP import.
- **Failure:** invalid temporal ordering moves the candidate to `held` with
  `invalid_temporal_order`, and unsupported temporal expressions move it to
  `held` with `temporal_unmapped`; neither path raises a builder exception.
  Structured temporal metadata outside the frozen source/chunk fields is
  rejected as unsupported.
  A hash, scope or decision identity mismatch fails the transaction.
  `not_applicable` is a terminal semantic value, not a reason to claim the
  bitemporal lane is ready when no native receipt exists.
- **Extension point:** temporal parsing changes require a new approved
  version/fixture and must preserve the three-state distinction: an unmapped
  held claim with `temporal_unmapped`, explicit `not_applicable`, and dated
  open-ended values. Do not add a
  direct MSP import or a standalone `gks_temporal_map` tool without a new
  contract decision.
- **Code and tests:**
  [`temporal claim`](../packages/gks-core/src/pipeline.mjs#L105-L125),
  [`ported temporal helper`](../packages/gks-core/src/temporal.mjs#L1-L65),
  [`temporal ADR`](ADR-GKS-TEMPORAL-MAP.md), and
  [`parity test`](../tests/contract/temporal-engine-parity.test.mjs).

### Stage 13 — `DPS-KI-GRAPH-BUILD`

- **Input:** the immutable Stage 9–12 decision and its graph projection.
- **Output:** a graph decision plus expected physical readback counts. The
  worker writes the physical graph in Tier 4 and returns a graph receipt with
  matching decision hash, transaction frontier/checkpoint, `readback.ok`, and
  node/edge counts.
- **Evidence:** `gks_pipeline_graph_receipt` durably records the graph receipt
  and only then writes the Stage 13 `SUCCEEDED` terminal. GKS's expected
  projection is `2 + chunks + entities + facts + held` nodes and
  `1 + chunks + mentions + 2*facts + held` edges; counts are checked against
  actual worker readback.
- **Failure:** a missing, malformed, mismatched, non-ok, or count-divergent
  graph receipt is rejected. A worker failure may use
  `gks_pipeline_stage_failure` for Stage 13; the exact failed attempt is
  terminal and later success evidence is not fabricated.
- **Extension point:** graph node/edge classes or projection counts require a
  new decision/receipt contract and tests. GKS remains the decision authority;
  it never writes to or reads outward from GenesisBlockDB.
- **Code and tests:**
  [`graph receipt validator`](../packages/gks-contracts/src/pipeline.mjs#L445-L461),
  [`graph receipt persistence`](../packages/gks-persistence/src/index.mjs#L1349-L1408),
  [`ordered receipt tests`](../tests/contract/pipeline-genesisrag17.test.mjs#L183-L229).

### Stage 14 — `DPS-KI-ENRICH`

- **Input:** the committed Stage 13 graph receipt and immutable decision.
- **Output:** one separate `enrich_v1` derived summary per canonical entity,
  with document/chunk/fact counts, generated time and distinct source
  references. Derived rows do not replace verified facts.
- **Evidence:** Stage 14 is emitted in the same durable graph-receipt
  transaction after Stage 13. The receipt stores `derived` and `derivedHash`,
  and its evidence details carry the derived, document, chunk and fact counts.
  A later worker receipt must reference that hash.
- **Failure:** a replay with a different graph or derived hash is a conflict;
  a missing graph receipt cannot trigger enrichment. Source references must
  resolve to the decision's actual chunks and mention occurrences.
- **Extension point:** a new derivation method gets a new versioned method and
  hash input. Keep aggregate counts distinct from verified facts and preserve
  references to actual source chunks and occurrences.
- **Code and tests:**
  [`summary derivation`](../packages/gks-core/src/pipeline.mjs#L351-L382),
  [`graph receipt and Stage 14 commit`](../packages/gks-persistence/src/index.mjs#L1372-L1407),
  [`enrichment assertions`](../tests/contract/pipeline-genesisrag17.test.mjs#L119-L151).

### Stage 17 — `DPS-KI-QUALITY-GATE`

- **Input:** immutable decision, committed graph/enrichment receipt, actual
  Tier-4 final receipt for stages 15/16, lane manifests and the retrieval
  benchmark.
- **Output:** a nested verdict with `data`, `graph`, `knowledge`, `security`,
  and `retrieval` dimensions, `statistics` for documents/chunks/entities/facts/
  relations, ontology version and pipeline version, plus `allowPublication`.
  Retrieval requires recall@5 ≥ 0.80, MRR ≥ 0.65, citation correctness 1, and
  zero cross-tenant leaks.
- **Evidence:** a failed gate writes terminal Stage 17 `FAILED` evidence with
  its verdict and no publication receipt. A passing gate is closed only by
  `gks_pipeline_publication_receipt`, which writes the Stage 17 `SUCCEEDED`
  terminal after matching snapshot, model and transaction frontier evidence.
- **Failure:** absent or mismatched receipts, required lanes not ready, bad
  readback counts, held knowledge, policy denial, missing provenance or a
  failing retrieval benchmark produces `FAIL`/`allowPublication: false`.
  Publication is rejected until a passing gate exists.
- **Extension point:** quality dimensions, lane readiness rules and thresholds
  are contract changes requiring an ADR and new evidence tests. Retrieval
  orchestration after a successful Stage 17 publication is query-time consumer
  behavior; it is not a Stage 18.
- **Code and tests:**
  [`quality evaluator`](../packages/gks-core/src/pipeline.mjs#L385-L519),
  [`gate/publication service`](../packages/gks-core/src/index.mjs#L434-L495),
  [`quality and failure tests`](../tests/contract/pipeline-genesisrag17.test.mjs#L183-L358).

The stage contract is extended by adding a versioned artifact or a new
`genesisrag17` contract revision, never by renumbering a `DPS-KI-*` id or
reusing a terminal attempt. The legacy port-v3 evidence reader stays stable.

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

The numeric progress paragraph above records the tracker state at the time of
the original assignment. The current GKS implementation now emits the
GenesisRAG17 evidence described in this document, but only the zuri-ai holder
may move tracker tasks or claim cross-repository completion.

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
- **Future extensions still need their own decision.** The current baseline is
  implemented and versioned; a new extractor, ontology, temporal rule,
  projection, enrichment method, or quality threshold must update its ADR,
  contract and tests before it can change replayed evidence.

## Source of truth

The definitions live in zuri-ai and are authoritative there:

- `docs/decisions/ADR-050-KNOWLEDGE-INGESTION-TIER-BOUNDARY.md` — the tier assignment
- [`ADR-073 GenesisRAG17 isolated execution and publication`](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md) — the current isolated execution and publication profile
- [`FR-109 knowledge-ingestion stage catalog`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/domains/knowledge/features/FR-109-knowledge-ingestion-stage-catalog.md) — the catalog and per-stage evidence
- [`KNOWLEDGE-INGESTION-17-STAGE-SPEC.md`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md) — the specification underneath both
- [`KNOWLEDGE-INGESTION-17-STAGE-FLOW.md`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-FLOW.md) — the cross-repository execution and extension flow

If this file and those disagree, those win, and this file is the thing to fix.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.17b | 2026-09-11 | beta | Stage 11 (`DPS-KI-ONTOLOGY-MAP`) now produces `ontology_v2` and its evidence pins that version; `ontology_v1` decisions stay completable at Stage 17 (ADR-075 Phase 2, contract revision 2). The ontology code/test links were re-pointed at the current lines. | working-tree | Claude Opus 5 |
| 0.1.15b | 2026-09-08 | beta | Recorded audit remediation for typed Stage 9 identities, supported-only Stage 10 subject carry with `ambiguous_subject_binding` holds, conservative negation, measured lookup timing and explicit Stage 12 unmapped versus not-applicable/open-ended states. | working-tree | RWANG |
| 0.1.14b | 2026-09-08 | beta | Clarified that legacy stage evidence and the GenesisRAG17 pipeline evidence stream are separate, assigned Stage 17 verdict ownership to GKS with Tier-4 physical evidence, and linked the zuri-ai execution flow. | 9279cfe | RWANG |
| 0.1.13b | 2026-09-08 | beta | Added the implemented per-stage GenesisRAG17 input/output/evidence/failure/extension contract for stages 9–14 and 17, separated legacy port-v3 evidence, and linked the zuri-ai specification and flow. | 9279cfe | RWANG |
| 0.1.12b | 2026-09-07 | beta | Records graph-receipt-driven Stage 13 to Stage 14 ordering, final receipt ownership for Stages 15/16, terminal worker failures and the accepted Stage 10/12 implementation status. | working-tree | RWANG |
| 0.1.11b | 2026-09-07 | beta | Paid the metrics follow-up `ADR-GKS-LEDGER-REPORTING.md` D4 recorded against this table (the six NFR-020 metrics now listed for every stage), and recorded how evidence leaves now that the ledger ADR is implemented: `stage_evidence` → `gks_stage_evidence_export` → MSP relay → zuri-ai's importer, with Stage 9 already flowing live. | working-tree | Claude Fable 5.1 |
| 0.1.10b | 2026-08-31 | beta | Final whole-branch review's CASCADE fix, to avoid this file becoming the eighth staleness: the Stage 10 pointer still cited `ADR-GKS-FACT-EXTRACT.md` at 0.1.3b after that ADR's BLOCKER-1 fix moved it to 0.1.4b, and the Stage 12 pointer still cited `ADR-GKS-TEMPORAL-MAP.md` at 0.1.2b after that ADR's BLOCKER-2 fix moved it to 0.1.3b — both pointers updated in this one edit to the versions being committed alongside it. | working-tree | Claude Fable 5 |
| 0.1.9b | 2026-08-31 | beta | The Stage 12 pointer still cited `ADR-GKS-TEMPORAL-MAP.md` at 0.1.1b after that ADR's re-review moved it to 0.1.2b — updated to cite the version being committed alongside this edit, not left as a seventh staleness one line after the sixth was fixed. | working-tree | Claude Fable 5 |
| 0.1.8b | 2026-08-31 | beta | Two pointer fixes, folded into one edit rather than left for a seventh and eighth staleness separately. The Stage 10 pointer still cited `ADR-GKS-FACT-EXTRACT.md` at 0.1.1b after that ADR moved to 0.1.2b (`a8c62d2`) — this file's sixth staleness, the same failure mode as 0.1.1b through 0.1.6b, corrected here. The Stage 12 pointer now cites `ADR-GKS-TEMPORAL-MAP.md` at 0.1.1b — the revision this same commit ships, cited at the version being committed rather than the version that was current when this line was last touched, so this edit does not repeat the mistake it just fixed one line up. | working-tree | Claude Fable 5 |
| 0.1.7b | 2026-08-31 | beta | Added a Stage 12 design-pass pointer: `ADR-GKS-TEMPORAL-MAP.md` (proposed, 0.1.0b), all five required decisions decided, approval gate not yet open. Names the port source (`G:\govibe\packages\msp-runtime\src\domain\temporal-engine.mjs`) and commit (`79f339e`) this file's own pointer line cites, matching that ADR's own citation, so a reader does not have to open the ADR to know which commit is pinned. | working-tree | Claude Fable 5 |
| 0.1.6b | 2026-08-31 | beta | The Stage 10 pointer now cites ADR revision 0.1.1b — the 0.1.5b edit updated the id in that exact paragraph while leaving the version stale, this file's fifth staleness, self-inflicted while fixing the fourth. | working-tree | Claude Fable 5 |
| 0.1.5b | 2026-08-31 | beta | The Stage 10 pointer line now names the `DPS-KI-FACT-EXTRACT` id explicitly, matching how every other owned-stage row in this file's pipeline table already names its id — RKOI's review of `ADR-GKS-FACT-EXTRACT.md` (0.1.1b) caught the omission. | working-tree | Claude Fable 5 |
| 0.1.4b | 2026-08-31 | beta | Added a Stage 10 design-pass pointer: `ADR-GKS-FACT-EXTRACT.md` (proposed, 0.1.0b), all eight open questions decided, approval gate not yet open. This edit does not add NFR-020's six cross-stage metrics to the evidence table above — that remains the follow-up obligation `ADR-GKS-LEDGER-REPORTING.md` recorded, out of this edit's scope; the table above is still incomplete on that point. | working-tree | Claude Fable 5 |
| 0.1.3b | 2026-08-31 | beta | Two stale statements corrected: the ADR citation still read "revision 0.3.0b, gate open" after `4a79bf7` raised the ADR to 0.3.1b via errata — now "accepted 0.3.0b, errata 0.3.1b; gate open"; and both mentions of "a six-rung resolver ladder" undercounted the ADR's ladder table, which has always had seven rungs (`CANONICAL_REF` through `CREATED`). This file's third staleness — the same failure mode as 0.1.1b and 0.1.2b, prose describing another artifact going stale the moment that artifact moves, this time caught before a stale copy propagated into `docs/reports/2026-08-31-stage-9-tracker-handoff.md`. | working-tree | Claude Fable 5 |
| 0.1.2b | 2026-08-30 | beta | Stage 9 shipped; the digest-vs-resolution question this file still called open was settled by ADR D2 and implemented. Flagged by RKOI's branch review as this file's second staleness in two days — prose describing another artifact goes stale the moment that artifact moves, and this file describes seven of them. | working-tree | Claude Opus 5 |
| 0.1.1b | 2026-08-29 | beta | Stage 9's ADR was accepted (0.3.0b, gate open, all eight questions decided) hours after this file called it an unapproved draft. The stale line said the ADR authorizes nothing, which by then was the opposite of true -- the exact failure this file exists to prevent, in the file that exists to prevent it. | working-tree | Claude Opus 5 |
| 0.1.0b | 2026-08-29 | beta | Recorded the seven stages GKS owns in zuri-ai's seventeen-stage pipeline, the evidence each must report, and where completion is reported — none of which was written anywhere in this repository before. | working-tree | Claude Opus 5 |

## Reference version diff — 2026-09-08

"0.1.15b → 0.1.16b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.
