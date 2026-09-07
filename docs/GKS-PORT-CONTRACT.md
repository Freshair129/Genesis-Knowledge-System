---
version: "0.7.1b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-09-08T00:30:00+07:00,RWANG"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-08-12T10:16:19+07:00"
superseded_by: null
attributes:
  domain: "gks-service-extraction"
  doc_type: "api-contract"
  scope: "MSP-to-GKS and GKS-owned persistence ports"
---

# GKS Port Contract

## Purpose

Define stable boundaries so MSP can call a standalone GKS service and GKS can
replace its persistence backend without changes to MSP, GoVibe, or Zuri domain
code.

## External service port

Only MSP may use this port in the governed runtime path.

```ts
interface GksServicePort {
  health(): Promise<GksHealthResult>;
  promoteCandidate(input: KnowledgePromotionRequest): Promise<KnowledgePromotionResult>;
  search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResult[]>;
  getEntity(input: KnowledgeEntityRequest): Promise<KnowledgeEntity | null>;
  getRelations(input: KnowledgeRelationsRequest): Promise<KnowledgeRelation[]>;
  linkArtifact(input: KnowledgeArtifactLinkRequest): Promise<KnowledgeArtifactLinkResult>;
  // Stage 9 D9: the unresolved-mention consumer.
  listUnresolvedMentions(input: UnresolvedMentionsRequest): Promise<UnresolvedMention[]>;
  applyHumanResolution(input: HumanResolutionRequest): Promise<HumanResolutionResult>;
  // Port version 3 (ledger ADR D2, implemented 2026-09-07): the read-only,
  // scope-enveloped, cursor-paginated evidence export MSP relays for zuri-ai.
  exportStageEvidence(input: { scope: KnowledgeScope; since_cursor?: number; limit?: number }): Promise<StageEvidencePage>;
}
```

### Transport

- MVP transport: MCP-compatible JSON-RPC 2.0, newline-delimited over stdio.
- Initialization protocol: preserve the existing MSP provider behavior.
- Every request is bounded and returns structured content.
- Network deployment is deferred. A future HTTP/gRPC adapter must implement
  the same service port and conformance fixtures.
- The server has no implicit database path, credential, tenant, or workspace.

### MVP tool mapping

| Port method | MCP tool | Phase |
|---|---|---|
| `health` | `gks_health` | foundation |
| `promoteCandidate` | `gks_knowledge_promote` | compatibility-critical |
| `search` | `gks_search` | scoped retrieval |
| `getEntity` | `gks_entity_get` | scoped retrieval |
| `getRelations` | `gks_relations_get` | scoped retrieval |
| `linkArtifact` | `gks_artifact_link` | governed linking |
| `listUnresolvedMentions` | `gks_review_list` | entity resolution (Stage 9 D9) |
| `applyHumanResolution` | `gks_review_apply` | entity resolution (Stage 9 D9) |
| `exportStageEvidence` | `gks_stage_evidence_export` | ledger reporting (port v3, implemented) |

`gks_knowledge_promote` must preserve GoVibe API-010 v1:

```ts
type KnowledgePromotionRequest = {
  schema_version: "govibe-knowledge-candidate/v1";
  idempotency_key: string;
  run_id: string;
  stage: number; // 1..12
  source_snapshot_hash: string; // 64 lower-case hex
  provenance_ref: `msp:proof/${string}`;
  candidate: Record<string, unknown>;
  scope: KnowledgeScope;
};

type KnowledgePromotionResult = {
  knowledge_ref: `gks:knowledge/${string}`;
  source_hash: string;
  idempotent: boolean;
  graph_version: string;
};
```

During the compatibility phase, `scope` may be supplied by the MSP envelope
rather than changing the literal API-010 payload. The implementation must
normalize it before domain execution and must not silently use a global scope.

## GenesisRAG17 v1 tool surface

The implemented pipeline surface is eight `gks_pipeline_*` tools plus the
legacy `gks_stage_evidence_export` reader. Those nine related tool contracts
are intentionally visible together so a caller does not confuse the new
immutable pipeline ledger with port-v3 legacy stage evidence.

### Common pipeline envelope

Every new pipeline request includes this outer shape. MSP removes any caller
actor, relay credential or unauthenticated principal and inserts the configured
runtime identity before forwarding it:

```ts
type PipelineEnvelope = {
  schemaVersion: "genesisrag17.v1";
  scope: {
    portfolioId: string; tenantId: string; businessId: string;
    workspaceId: string; agentId: string; visibility: "private";
  };
  relayCredential: string; // MSP-injected; never persisted or logged by GKS
  authenticatedPrincipal: {
    principalId: string;
    role: "source" | "worker";
    scope: PipelineScope; // exact equality with the outer scope
  };
};
```

`gks_pipeline_submit` and `gks_pipeline_evidence` require the `source` role.
`gks_pipeline_claim`, `gks_pipeline_graph_receipt`,
`gks_pipeline_stage_failure`, `gks_pipeline_write_receipt`,
`gks_pipeline_gate`, and `gks_pipeline_publication_receipt` require the
`worker` role. GKS compares the relay credential in constant time and checks
the principal's exact six-field scope before any pipeline persistence call.

### Tool contracts

| Tool | Request payload | Result and durable effect |
|---|---|---|
| `gks_pipeline_submit` | `batch`: `batchId`, `idempotencyKey`, `runId`, all nine stage identities, source identity/content/hash, ordered chunks with source offsets/content hashes, occurrence mentions with `sourceMentionId`/`semanticType`, and `{allowEmbedding, allowPublication}` policy. | `{schemaVersion, scope, batchId, decisionId, status, idempotent}`. Validates provenance and builds one immutable decision; persists entities, occurrences, and terminal evidence for stages 9–12. |
| `gks_pipeline_claim` | No payload beyond the envelope; optional `limit` is exactly `1`. | `{schemaVersion, scope, decisions}`. Returns one pending decision without destructive dequeue; resumable statuses are `PENDING`, `GRAPH_RECEIPTED`, `RECEIPT_WRITTEN`, and `GATED`. |
| `gks_pipeline_graph_receipt` | `receipt`: decision/run identity, all stage identities, Tier-4 transaction `{id, frontier, checkpoint}`, `readback:{ok,nodeCount,edgeCount}`, six metrics, and UTC `startedAt`/`finishedAt`. | `{schemaVersion, scope, accepted, idempotent, graphReceiptHash, derived, derivedHash}`. Requires matching physical graph counts, stores the immutable Stage 13 receipt, then computes/stores actual `enrich_v1` Stage 14 summaries. |
| `gks_pipeline_stage_failure` | Top-level `runId`, `decisionId`, `decisionHash`, exact `stage` identity, interval, six metrics, and `{error:{code,message}}`. Worker stages are limited to 13, 15, and 16. | `{schemaVersion, scope, accepted, idempotent, stage, failureHash}`. Writes one `FAILED` terminal for the actual attempt and blocks synthetic later success evidence. |
| `gks_pipeline_write_receipt` | `receipt`: all stage identities, decision identity, `graphReceiptHash`, `derivedHash`, execution intervals for 13/15/16, snapshot/generation, frozen model pin and artifact hashes, Tier-4 transaction, physical readback, six-lane manifest, per-stage metrics, and retrieval benchmark. | `{schemaVersion, scope, accepted, idempotent, receiptHash}`. Requires the graph receipt, checks Stage 13 parity, persists the actual worker receipt, and closes Stage 15/16 evidence. |
| `gks_pipeline_gate` | `decisionId` and `decisionHash`. GKS reads the immutable decision, graph receipt, final worker receipt and derived payload. | `{schemaVersion, scope, verdict, verdictHash}`. `verdict` contains the five dimensions, `statistics`, `ontologyVersion`, `pipelineVersion`, receipt identity and `allowPublication`. A failure writes terminal Stage 17 evidence; a pass waits for publication. |
| `gks_pipeline_publication_receipt` | `receipt`: run/decision identity, snapshot/generation, worker `receiptHash`, publication time/pointer hash, model revision, transaction frontier, and `readback:{ok:true}`. | `{schemaVersion, scope, accepted, idempotent, publicationHash}`. Requires a passing gate and matching worker snapshot/model/frontier, then writes successful terminal Stage 17 evidence. |
| `gks_pipeline_evidence` | `runId`, `afterCursor` (default `0`) and bounded `limit` (`1..500`). | `{schemaVersion, scope, rows, nextCursor}`. Source-role, exact-scope, append-only read of terminal rows with stage identity, outcome, timestamps, six pipeline metrics and aggregate details. |
| `gks_stage_evidence_export` (legacy port v3) | `scope`, `since_cursor` and bounded `limit` using the legacy snake_case shape. | `{rows, next_cursor}` from the separate `stage_evidence` ledger. It remains read-only and unchanged; it is not a substitute for `gks_pipeline_evidence`. |

The executable schemas and registry names are in
[`pipeline-tools.mjs`](../packages/gks-contracts/src/pipeline-tools.mjs#L1-L63);
the field validators and hash functions are in
[`pipeline.mjs`](../packages/gks-contracts/src/pipeline.mjs#L13-L562), and the
stdio dispatcher maps each name in
[`apps/gks-server/src/server.mjs`](../apps/gks-server/src/server.mjs#L31-L47).
All new results keep the outer `schemaVersion` and `scope`, including
idempotent replies. A same identity with a different hash is a conflict.

### Stage identity and receipt ordering

The nine stage identities in a batch are fixed to stages 9 through 17 and their
`DPS-KI-*` ids. They are carried into receipts and evidence unchanged. The
physical order is:

```text
submit -> claim -> graph receipt (Stage 13) -> GKS enrich_v1 (Stage 14)
       -> worker receipt (Stages 15 and 16) -> gate (Stage 17)
       -> publication receipt (successful Stage 17)
```

The graph receipt is terminal evidence for Stage 13 and the commit point that
authorizes Stage 14. The final worker receipt is not accepted before it. A
failed gate is terminal even without publication; a successful gate is not.
Transport retries replay the same payload and return the stored hash. A
processing retry starts a new FR071 materialized replay from the Tier-1 raw
entrypoint, so it receives a new batch, decision, run and stage-attempt
identity; changing only `attemptId` cannot mutate an existing immutable
decision. The new replay must report its own interval and metrics.

## Scope contract

```ts
type KnowledgeScope = {
  portfolioId: string;
  tenantId?: string;
  businessId?: string;
  workspaceId?: string;
  projectId?: string;
  sharing: "private" | "workspace" | "portfolio-shared";
};
```

- `crossTenantDefault = "DENY"`.
- A missing `portfolioId` is invalid.
- `portfolio-shared` requires explicit MSP authorization evidence.
- Search, entity, relation, and artifact-link operations must apply the same
  scope rules as promotion.

## Promotion rules

- MSP supplies approval/provenance evidence; GKS never invents it.
- GKS rejects caller-assigned canonical `knowledge_ref`, entity ID, relation ID,
  or graph version unless the value is an existing canonical reference being
  resolved.
- Same idempotency key plus same source hash returns the original mapping.
- Same idempotency key plus different source hash fails closed.
- Canonical state is written only after validation, deduplication, scope checks,
  and backend persistence succeed.
- MSP mints its own `msp:promotion/` receipt only after validating the GKS
  result; GKS must not mint MSP receipts.

## Internal backend port

### Port version 1 — as implemented today

```ts
interface GksPersistencePort {
  health(): Promise<KnowledgeStoreHealth>;
  transactPromotion(input: CanonicalPromotionTransaction): Promise<CanonicalPromotionCommit>;
  search(input: ScopedKnowledgeQuery): Promise<StoredKnowledgeHit[]>;
  getEntity(input: ScopedCanonicalRef): Promise<StoredKnowledgeEntity | null>;
  getRelations(input: ScopedRelationQuery): Promise<StoredKnowledgeRelation[]>;
  transactArtifactLink(input: ScopedArtifactLink): Promise<StoredArtifactLink>;
  close(): void;
}
```

**Corrected 2026-08-29.** Revisions 0.1.1b–0.2.0b documented six operations
including `linkArtifact`, while `PERSISTENCE_OPERATIONS`
(`packages/gks-contracts/src/validation.mjs:8`) has enforced seven —
`transactArtifactLink` and `close` among them — since implementation. The
document described a surface no adapter ever had to satisfy: the executable gate
was right and the contract was stale. This block now states what
`assertGksPersistencePort` actually enforces.

### Port version 2 — required by Stage 9 (implemented on the Stage 9 branch)

[ADR-GKS-ENTITY-RESOLUTION.md](ADR-GKS-ENTITY-RESOLUTION.md) (accepted
2026-08-29) requires additional operations and one behavioural guarantee.
They were recorded here **before** implementation, because they break the
replacement contract below, and that break has to be visible to every adapter
author rather than discovered by one of them.

```ts
interface GksPersistencePortV2 extends GksPersistencePort {
  // Stage 9 blocking lookup: the candidate rows a resolver may consider.
  // MUST filter every scope dimension in SQL, never in the caller.
  // Excludes superseded entities: a D9-merged row is not a live identity.
  lookupResolutionCandidates(input: ScopedResolutionQuery): Promise<StoredKnowledgeEntity[]>;
  // D9 read: unresolved mentions (REVIEW_REQUIRED / AMBIGUOUS, canonical
  // ref NULL) within scope. Same SQL scope predicate as the lookup.
  listUnresolvedMentions(input: ScopedReviewQuery): Promise<StoredUnresolvedMention[]>;
  // D9 write, ONE transaction: BIND an unresolved mention to an existing
  // canonical entity (materializing pending relations whose endpoint just
  // resolved), or MERGE two canonical entities -- supersession recorded on
  // the loser, relations re-pointed to the survivor in the SAME
  // transaction (D10.2). Refuses cross-tenant operands outright, an empty
  // tenant being a tenant of its own. Records strategy HUMAN under the
  // decision's own provenance ref; never reachable from the resolver, and
  // the promotion write itself refuses to record strategy HUMAN.
  transactHumanResolution(input: HumanResolutionTransaction): Promise<HumanResolutionCommit>;
}
```

D9's two operations sit in the same port version as the lookup because
decision 6 puts D9 inside Stage 9's scope, and for the same D8 reason the
lookup is required: an adapter without the consumer would ship the refusal
half of the safety valve with no repair half.

**Why it may not be optional.** An adapter without this operation falls back to
digest-only identity — precisely the defect Stage 9 exists to fix, reintroduced
as a supported configuration under the name "degraded". The operation is
required, the port version increments, and the conformance suite changes with
it.

**Why the filtering may not move to the caller.** `search` filters
`portfolio_id` in SQL and leaves tenant filtering to `visible()` in the domain
service. That is safe for a read — a leak is repairable by fixing the filter. It
is not safe for resolution, because the result of resolution is a **merge**, and
a cross-tenant merge has already overwritten one tenant's entity by the time
anyone notices. The pool rule is therefore a SQL predicate, including its
treatment of an empty `tenant_id` as a tenant of its own rather than a wildcard.

**Additional behavioural requirement — atomic uniqueness.**
`transactPromotion` must execute where unique-constraint violations are detected
atomically, because Stage 9 closes the concurrent-creation race with
`UNIQUE(scope_key, norm_key)` and a conflict-retry that returns `MATCHED`
against the winner. Every serious database provides this and no adapter-level
global lock is required; an adapter that cannot is not a candidate.
Serialization by convention was rejected for the same reason an optional lookup
was — an unenforced guarantee is not a guarantee.

The production adapter is intentionally unresolved until a separate GKS
persistence decision is approved. GenesisBlockDB is not selected by this
contract. An in-memory adapter may exist only for deterministic contract tests
and must never activate as a runtime fallback.

### Port version 3 — required by the ledger ADR (recorded 2026-08-31, implemented 2026-09-07)

[ADR-GKS-LEDGER-REPORTING.md](ADR-GKS-LEDGER-REPORTING.md) (accepted
2026-08-31) requires one additional operation and a set of behavioural
guarantees. They were recorded here **before** implementation, following the
same precedent port version 2 set: a break has to be visible to every adapter
author, rather than discovered by one of them.

**Implemented 2026-09-07.** `exportStageEvidence` is in
`PERSISTENCE_OPERATIONS` (a port-v2 adapter is now rejected by name),
migration `0005_stage_evidence.sql` creates the table and
`graph_state.evidence_cursor`, the SQLite adapter writes one row per Stage 9
execution inside the execution's own transaction (`transactPromotion` binds
the caller's `run_id`; `transactHumanResolution` writes BIND/MERGE rows with
strategy `HUMAN`, `run_id` NULL — the ledger ADR's Task 1 finding, closed),
the migration hook backfills every pre-existing promotion and decision in
order, and the service port gains `exportStageEvidence` (above), dispatched as
`gks_stage_evidence_export`. Every behavioural requirement below has its
case: commit-time cursors and hole-free rollback in
`persistence-port-conformance.test.mjs`, the SQL scope predicate in
`cross-tenant-deny.security.mjs`, zero-not-absent metrics and paging in
`stage-evidence-export.test.mjs`, and the whole path through the real MSP in
`msp-service-chain.test.mjs` (with `MSP_REPO_ROOT`). The companion zuri-ai
importer — the ask in `docs/reports/2026-08-31-cr-draft-ledger-pull.md` —
exists (zuri-ai ADR-068) and has pulled a Stage 9 row from this adapter onto
its ledger live. The GenesisRAG17 decision path does not add
`transactFactExtraction` or `transactTemporalMap` to the persistence port:
Stages 10 and 12 are evaluated inside the immutable pipeline decision and are
stored by the pipeline operations described below. Those names remain
extension candidates only for a future, separately approved direct-stage API;
they are not shipped operations in port version 3.

```ts
interface GksPersistencePortV3 extends GksPersistencePortV2 {
  // Ledger ADR D2: cursor-paginated, replay-safe read of one evidence row
  // per stage execution (plus per-record child entries for stages 10, 12,
  // and 13), scoped by every KnowledgeScope dimension in SQL. Cursor values
  // are assigned at commit time -- never at write start -- so a puller can
  // lag behind the watermark but never permanently skip a row that commits
  // later with a numerically lower cursor.
  exportStageEvidence(input: ScopedStageEvidenceQuery): Promise<StageEvidenceExportPage>;
}
```

`GksPersistencePortV3` records the adapter half of the legacy evidence export,
while `GksServicePort` above and the tool table in this document record its
implemented external shape. The GenesisRAG17 `gks_pipeline_*` methods are
separate service operations and do not change the legacy port-v3 row shape.

The paired external tool is **`gks_stage_evidence_export`**, registry-
registered through `packages/gks-contracts` exactly like every other public
GKS tool, scope-enveloped like `search`/`getEntity`/`getRelations`, and
read-only — it writes nothing, to GKS's own store or anywhere else:

```
gks_stage_evidence_export({ scope, since_cursor, limit })
  -> {
       rows: [{
         cursor,
         pipeline_stage_id,
         pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1",
         execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1",
         evidence,   // always an object; {} when the stage has no
                     // execution-level catalog fields beyond the metrics
         metrics: {
           records_in, records_out, records_failed, records_quarantined,
           // processing_time_ms is the one deliberate renaming of an
           // NFR-020 metric: NFR-020 names it processing_time; the export
           // row spells it processing_time_ms so the unit lives in the
           // field name rather than being assumed or disagreed on by six
           // separate stage implementers.
           processing_time_ms, retry_count
         },
         records,    // always an array; empty (never omitted) for every
                     // stage whose catalog evidence is execution-level;
                     // populated for Stage 10 (per-fact), Stage 12
                     // (per-fact temporal mapping), and Stage 13
                     // (per-business-assertion-edge) only
         produced_at
       }],
       next_cursor
     }
```

`stage_evidence` is the new table `exportStageEvidence` reads from:

```
stage_evidence(evidence_id PK, scope_key,
                portfolio_id, tenant_id, business_id, workspace_id,
                project_id, sharing,
                pipeline_stage_id, pipeline_definition_id, execution_contract_id,
                run_id, provenance_ref,
                evidence_json, metrics_json, records_json,
                cursor, produced_at)
```

Rows are append-only and immutable once written — never edited, never
deleted — which is what makes any earlier cursor safe to re-read at any later
time.

**Behavioural requirement — commit-time cursor assignment, with a required
conformance case.** A row's `cursor` is assigned at commit time, not at the
start of the write that produces it: a puller that has advanced past cursor
`N` can never permanently skip a row that commits later with a lower cursor
than one it has already consumed. This is the ledger ADR's D2 ordering
guarantee, restated here as a binding requirement on every adapter, the same
way port version 2 restated Stage 9's atomic-uniqueness requirement rather
than merely cross-referencing it. **Recorded as binding here per a review
carry-forward from the ledger ADR's own review** (RKOI Minor 2 on that ADR's
task review, not a condition attached to Boss's acceptance — the ADR was
approved unconditionally, and the requirement is carried forward as a note
this contract now makes binding rather than as a gate Boss's acceptance
itself imposed): `tests/contract/persistence-port-conformance.test.mjs`, or
the `stage_evidence`-specific suite the implementation adds, gains a
conformance case proving this guarantee — a later-committing, earlier-started
write is never assigned a cursor lower than one already exported — before any
adapter may ship `exportStageEvidence`. An adapter without an enforced answer
to this is not a candidate, the same standard port version 2 already set for
atomic uniqueness. This wording matches `ADR-GKS-FACT-EXTRACT.md` Q7 and
`ADR-GKS-TEMPORAL-MAP.md` D5's own phrasing for the same conformance case, so
the three documents agree rather than describing the same requirement three
different ways.

**Behavioural requirement — cursors are per-scope; no wildcard scope exists.**
`since_cursor` orders rows within one `KnowledgeScope`, never across every
scope GKS holds. A caller with visibility into multiple scopes pulls each one
on its own `since_cursor` and gets each scope's own cursor sequence back.
Enumerating which scopes to pull is the caller's problem, not something
`exportStageEvidence` or `gks_stage_evidence_export` solves on the caller's
behalf — the same rule that forecloses `GKS_DEFAULT_PORTFOLIO_ID` from being
recreated under a new name inside this tool.

**Behavioural requirement — the scope predicate is applied in SQL.**
`exportStageEvidence` filters `portfolio_id`, `tenant_id`, and every other
scope dimension in the SQL query against `stage_evidence`, never in
application code after the read, for the same reason stated above for
`lookupResolutionCandidates`: caller-side filtering is a repairable leak for a
read, but this export is durable, cursor-addressable evidence a puller may
already have consumed by the time a filtering bug is found. An empty
`tenant_id` is a tenant of its own here exactly as it is everywhere else in
this port — never a wildcard. The tool gains a case in
`tests/security/cross-tenant-deny.security.mjs` alongside the pool-level and
merge-level cases Stage 9 already added there.

**Behavioural requirement — a metric a stage did not produce is `0`, never
omitted.** NFR-020's "zero, not absent" framing is binding on every row this
operation returns: a stage with no natural `retry_count` concept still emits
`retry_count: 0`, not a missing key.

**This version remains additive and is extended incrementally, not reopened.**
The accepted Stage 10 and Stage 12 semantics are implemented inside the
GenesisRAG17 decision builder and persist through the pipeline operations;
`transactFactExtraction` and `transactTemporalMap` are not part of the current
`GksPersistencePortV3`. If a future direct-stage API needs either operation,
its ADR must add the exact method and conformance cases here before an adapter
implements it. The existing legacy evidence export and its port-v3 shape stay
unchanged.

**Why it may not be optional.** An adapter without `exportStageEvidence`
cannot report Tier-3/4 stage evidence at all — exactly the "system that can
only refuse" the ledger ADR's D3 argues against for Option C. The operation
is required, the port version increments, and the conformance suite changes
with it.

The production adapter remains unresolved, per port version 1's note above;
nothing in this section selects one.

## Error contract

| Code | Meaning |
|---|---|
| `gks_invalid_request` | schema, hash, reference, or scope is invalid |
| `gks_scope_denied` | requested tenant/workspace/project scope is not authorized |
| `gks_conflict` | idempotency, canonical identity, or relation conflict |
| `gks_backend_unconfigured` | no production backend is configured |
| `gks_backend_unavailable` | configured backend cannot complete the operation |
| `gks_invalid_backend_response` | backend result violates the port contract |
| `gks_not_found` | requested canonical object is absent within the authorized scope |

No error response may contain a fabricated canonical reference, graph version,
or successful promotion result.

## Replacement contract

The same conformance suite must run against:

1. deterministic test adapter;
2. the separately approved production persistence adapter;
3. any future replacement adapter.

MSP depends only on `GksServicePort` wire behavior. GoVibe and Zuri depend only
on MSP contracts.

## Implementation evidence

The legacy service methods and the eight pipeline methods are exposed as
versioned tool definitions in `@freshair129/gks-contracts`.
`assertGksPersistencePort` enforces the executable replacement surface before
the domain service starts. SQLite is the approved MVP adapter; no
implementation package name appears in the client.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.7.1b | 2026-09-08 | beta | Clarified that processing retries are new FR071 materialized batches/decisions, while transport retries replay the existing hash; the immutable pipeline and legacy port-v3 boundaries remain separate. | 9279cfe | RWANG |
| 0.7.0b | 2026-09-08 | beta | Documented the eight authenticated GenesisRAG17 tools plus the separate legacy evidence reader, exact payload/result shapes, role boundary, and receipt ordering from the executable registry. | 9279cfe | RWANG |
| 0.6.0b | 2026-09-07 | beta | Port version 3 implemented: `exportStageEvidence` required in `PERSISTENCE_OPERATIONS`, `stage_evidence` + `graph_state.evidence_cursor` (migration 0005 with backfill), Stage 9 evidence rows on every promotion (run-bound) and every human decision, `gks_stage_evidence_export` registered and dispatched, the service port gains `exportStageEvidence`; conformance, security, acceptance and MSP-chain cases added. Owner-instructed on 2026-09-07 as one third of the zuri-ai → MSP → GKS pull chain (zuri-ai ADR-068). | working-tree | Claude Fable 5.1 |
| 0.5.1b | 2026-08-31 | beta | RKOI's review of the acceptance cascade — 3 Important, 4 Minor, this document carrying I2/M3/M4. (I2) Fixed a misattribution: the commit-time-cursor conformance-case obligation was labeled "an explicit RKOI condition on acceptance" — it was in fact RKOI Minor 2 on the ledger ADR's own task review, carried forward as a note; Boss's acceptance of the ADR was unconditional. The requirement itself is unchanged and still binding, now correctly attributed as a review carry-forward. (M3) Restored two details 0.5.0b's row-shape block had dropped from the ADR's own JSON shape: the literal `pipeline_definition_id: "DPL-KNOWLEDGE-INGEST-V1"` / `execution_contract_id: "EXC-KNOWLEDGE-INGEST-V1"` values, and the one-clause explanation for why `metrics.processing_time_ms` renames NFR-020's `processing_time` (the unit lives in the field name). (M4) Aligned the conformance-case wording with `ADR-GKS-FACT-EXTRACT.md` Q7 and `ADR-GKS-TEMPORAL-MAP.md` D5's own phrasing — "`persistence-port-conformance.test.mjs`, or the `stage_evidence`-specific suite the implementation adds" — so the three documents describe the same requirement identically instead of three ways; changing this one contract instead of re-bumping both sibling ADRs. Added a sentence stating deliberately that port version 3 records only the persistence half (`GksPersistencePortV3`) as a typed interface; the service-port half (`GksServicePort`) stays prose until Task 3's implementation fixes its exact shape. | working-tree | Claude Fable 5 |
| 0.5.0b | 2026-08-31 | beta | Recorded port version 3 ahead of implementation, per `ADR-GKS-LEDGER-REPORTING.md`'s acceptance (accepted 2026-08-31) and that ADR's own D4 consequence: `exportStageEvidence` (paired external tool `gks_stage_evidence_export`), reading a new `stage_evidence` table, cursor-paginated and scope-enveloped. Four behavioural requirements recorded as binding: commit-time cursor assignment with a required `persistence-port-conformance.test.mjs` case (an explicit RKOI condition on acceptance), per-scope cursors with no wildcard scope, the scope predicate applied in SQL with a required `cross-tenant-deny.security.mjs` case, and a metric a stage did not produce exported as `0`, never omitted. States the version-3 extension story: `transactFactExtraction` (`ADR-GKS-FACT-EXTRACT.md`) and `transactTemporalMap` (`ADR-GKS-TEMPORAL-MAP.md`) land on this same port version 3 upon each of those ADRs' own acceptance, never a version 4/5 of their own — neither is part of `GksPersistencePortV3` as recorded today, since neither ADR is accepted yet. | working-tree | Claude Fable 5 |
| 0.4.0b | 2026-08-30 | beta | Recorded D9's delivered surface (ADR-GKS-ENTITY-RESOLUTION D9, D10.2, decision 6): two new public tools -- `gks_review_list` (unresolved mentions within scope) and `gks_review_apply` (ONE human-authorized write: bind a mention to an existing canonical entity, or merge two canonical entities with supersession and relation re-pointing in the same transaction). Port version 2 gains `listUnresolvedMentions` and `transactHumanResolution` -- in the SAME version as the lookup, because decision 6 places D9 inside Stage 9 and an optional consumer would ship refusal with no repair. The lookup now excludes superseded entities. This is not the rejected `gks_resolve`: the write is human-authorized repair carrying its own provenance, not caller resolution-without-promotion (D7). | working-tree | KIN |
| 0.3.0b | 2026-08-29 | beta | Corrected the persistence port to what the code has always enforced -- seven operations with `transactArtifactLink` and `close`, not six with `linkArtifact`; the document had described a surface no adapter ever had to satisfy. Recorded port version 2 ahead of implementation: Stage 9 requires a `lookupResolutionCandidates` operation that filters every scope dimension in SQL, plus atomic unique-constraint detection in `transactPromotion`. Both break the replacement contract deliberately -- an optional lookup would reintroduce digest-only identity as a supported configuration, and caller-side scope filtering is safe for a read but not for a merge. | working-tree | Claude Opus 5 |
| 0.2.0b | 2026-08-12 | beta | Recorded the implemented tool registry, API-010 compatibility, client isolation, and executable persistence conformance gate. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the service and persistence port contracts for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Renamed the internal boundary to GksPersistencePort and left production persistence unresolved; no GenesisBlockDB dependency is implied. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed MSP-only GKS service port, scoped operations, API-010 compatibility, and a replaceable persistence port. | working-tree | ATHER |
