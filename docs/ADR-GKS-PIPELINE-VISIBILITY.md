---
version: "0.1.0"
created_at: "2026-09-27T10:00:00+07:00,Claude,working-tree"
last_update: "2026-09-27T10:00:00+07:00,Claude"
status: "proposed"
approval_owner: "Boss (บอส)"
approval_recorded_at: null
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "legacy-read visibility of GenesisRAG17 canonical entities before publication"
---

# ADR: GenesisRAG17 entities stay invisible to legacy reads until published

## Decision status

**Proposed, awaiting owner approval.** The implementation lands in the same
pull request so the decision can be judged against working code and tests,
but it must not merge before approval is recorded here. It changes the
observable read behaviour of four frozen C0 tools, and
[`ADR-GKS-C0-QUALIFICATION.md`](ADR-GKS-C0-QUALIFICATION.md) does not
authorize that on its own.

## Context

`transactPipelineSubmit` writes each GenesisRAG17 decision entity into the
shared canonical `entities` table at submit time, before Stage 13 has written
anything and before Stage 17 has gated anything. The legacy read tools
(`gks_search`, `gks_entity_get`, `gks_relations_get`, `gks_artifact_link`)
read that table with no notion of publication. So an entity that exists only
because of a `PENDING`, `REJECTED` or `FAILED_STAGE` run is returned as
canonical knowledge. The legacy resolver's pool reads the same table, so a
legacy promote can also resolve `MATCHED` onto such an entity, or use
`resolveTo` to probe whether an unpublished entity exists.

A first attempt to fix this (withdrawn from the P0 pull request after
architecture review) keyed on `metadata.pipelineVersion`. That key is caller
data on the legacy promote path, so a caller could hide its own entities, and
the attempt left the resolution pool, D9 BIND/MERGE and relations
inconsistent with the read tools.

Requirements this addresses from the proposed SRS blueprint:
`GKS-GOV-002` (promotion is not publication) and the legacy-read half of
`GKS-RET-002` (published-only default). It does not implement K2 retrieval.

## Decision

### D1 — Visibility rule

A canonical entity is **visible to legacy reads** when it is:

- of legacy origin, or
- of pipeline origin and mentioned by at least one GenesisRAG17 run whose
  batch status is `PUBLISHED`.

Every other pipeline-origin entity is **hidden**. Publication is monotonic in
C0: there is no unpublish, so once visible an entity stays visible, and a later
`REJECTED` run that mentions it does not hide it again.

### D2 — Origin is a GKS-owned column, never caller data

Migration `0007_pipeline_entity_origin.sql` adds
`entities.origin TEXT NOT NULL DEFAULT 'legacy' CHECK (origin IN ('legacy', 'pipeline'))`.

- Only `insertPipelineEntity` writes `'pipeline'`. The legacy promote path
  never sets the column. No request field, metadata key, candidate string or
  norm key can change it.
- **Backfill** marks an existing row `'pipeline'` only when both of these hold:
  - a GenesisRAG17 run recorded it as a decision entity (a `pipeline_mentions`
    row names it);
  - the legacy path never created it (no `entity_mentions` row with outcome
    `CREATED` names it).
- Every legacy creation writes a `CREATED` mention, including the 0002
  backfill of pre-Stage-9 entities, so a legacy entity that a pipeline run
  later reused stays `'legacy'`. Norm-key shape is deliberately not used:
  `norm_v1` keeps U+0000, so a legacy candidate could imitate the typed
  pipeline key.
- The migration also adds `idx_pipeline_mentions_entity_ref (entity_id,
  scope_key, batch_id)`, so the visibility check is an index lookup, not a
  scan of every mention.

### D3 — Legacy resolution pool excludes hidden entities; the pipeline pool does not

`lookupResolutionCandidates` excludes hidden entities by default, so neither
the legacy ladder nor `resolveTo` can match or probe them. A hidden
`resolveTo` target answers exactly like a missing one (`REJECTED`).

The GenesisRAG17 Stage 9 reuse lookup passes
`includeUnpublishedPipeline: true`. Two runs of the same entity must still
converge on one identity whether or not the first run was published.

Consequence: while a pipeline entity is hidden, a legacy promote of the same
real-world thing creates its own legacy entity. If the pipeline entity is
published later, the duplicate is repaired the sanctioned way, by a D9
`MERGE` **with the pipeline entity as the survivor**. This trades a repairable
over-split for never serving unpublished knowledge.

GenesisRAG17 Stage 9 reuse does not follow supersession: a superseded
pipeline entity drops out of both pools, and a later run would reuse the
superseded row by its deterministic id. That gap predates this ADR. Until
reuse follows supersession, a repair must not supersede a pipeline entity.

**Norm-key collisions.** Usually the typed pipeline key
(`norm_v1(resolutionKey) + U+0000 + TYPE`) and a legacy `norm_v1` key differ.
They can coincide, though:

- `norm_v1` keeps U+0000;
- a semantic type with no letter case (digits, Thai) is unchanged by
  upper-casing.

So a legacy candidate such as `"acme\u0000123"` produces exactly the key of a
pipeline entity `acme` of type `123`. When a legacy insert loses
`UNIQUE(scope_key, norm_key)` to a hidden pipeline row, the adapter does not
surface `gks_conflict`, which would reveal the hidden row. It creates the
legacy entity under the existing D2 human-distinct discriminator
(`norm_key#mention_id`). Later promotes of the same string reach that entity
through the EXACT rung, which compares candidate strings, so the split does
not repeat. A collision with a *visible* row keeps the decision-5 retry.

### D4 — D9 BIND/MERGE operate only on visible entities

`transactHumanResolution` resolves its `canonicalRef`, `survivorRef` and
`supersededRef` with the same visibility rule. A hidden ref answers with the
existing "does not resolve to a canonical entity" error. It is never
`gks_scope_denied`, which would confirm that the entity exists.

### D5 — Relations never expose a hidden endpoint

`getRelations` omits any relation whose `from_ref` or `to_ref` names a hidden
entity. After D3 no new legacy relation can point at a hidden entity. This
covers rows written before the upgrade.

### D6 — What does not change

- No row, ref, hash, receipt, cursor or ledger entry is deleted or rewritten.
- Response shapes are unchanged: `origin` is not added to any tool output.
- The GenesisRAG17 tools (submit, claim, receipts, gate, publication,
  evidence) and their scope rules are unchanged. The worker still receives
  every decision entity through `gks_pipeline_claim`.
- The legacy scope mapping that drops `agentId` (`GKS-SCP-004` / `GKS-SCP-005`)
  is out of scope. A published entity is visible to the whole legacy scope, as
  before.
- **The rule is enforced on reads and resolution, not on every write.**
  Promotion's fill of an existing row, supersession following, and pipeline
  submit still look entities up by ref without the visibility predicate. That
  is safe because core only hands those paths refs taken from the visible pool
  or computed from the caller's own scope and candidate string, never a
  caller-chosen ref. A future write path that accepts a caller ref must use the
  visible lookup.

## Observable changes after upgrade

For an entity that exists only through unpublished runs:

| Tool | Before | After |
|---|---|---|
| `gks_search` | returned | omitted |
| `gks_entity_get` | returned (or `gks_scope_denied` from a foreign scope) | `null` from any scope |
| `gks_relations_get` on it | relations returned (or `gks_scope_denied`) | `[]` |
| `gks_relations_get` on a neighbour | relation to it returned | relation omitted |
| `gks_artifact_link` to it | link written | `gks_invalid_request` ("does not resolve") |
| `gks_knowledge_promote` | may resolve `MATCHED` / `resolveTo` onto it | never resolves onto it; may create a separate entity (D3) |
| D9 BIND/MERGE naming it | accepted | refused as not resolving |
| Earlier promote snapshots and `gks_stage_evidence_export` rows that name it | ref resolved | the ref is kept unchanged (D6), but reads it as `null` until publication |

No accepted request shape is rejected at validation, so no versioned wire
rollout is needed. The change is recorded here and in the C0 qualification
ADR's revision history instead.

## Rollback

- Migration 0007 is additive.
- A binary that includes the schema-ahead guard (`GKS_SCHEMA_AHEAD`) refuses to
  open a 0007 store with an older artifact. Rollback is then restoring the
  pre-migration backup, as the production runbook requires.
- An older binary without the guard would open the store, ignore `origin`, and
  show unpublished entities again. No data is lost either way.

## Alternatives rejected

- **Stage pipeline entities in a separate table until publication.** This is
  the cleanest end state, but it rewrites Stage 9 reuse, the decision payload
  and every receipt check that joins `entities`. It is disproportionate for a
  visibility rule. Revisit with K1 revisions.
- **Filter in `gks-core` instead of SQL.** The pool, D9 and relations
  predicates live in the adapter's SQL by design (`GKS-PORT-CONTRACT`: caller
  filtering is a repairable leak). Filtering in core would split one rule
  across two layers.
- **Key on `metadata.pipelineVersion` or on norm-key shape.** Both are
  reachable by a legacy caller (D2).
- **Let legacy promote keep matching hidden entities.** The caller then holds a
  canonical ref that `gks_entity_get` reports as `null`, and `resolveTo`
  becomes an existence oracle for unpublished content.

## Acceptance criteria

- Pipeline entities are hidden from all four legacy read tools while their run
  is `PENDING`, `REJECTED` or `FAILED_STAGE`, and appear after publication.
- An entity first mentioned by a `REJECTED` run becomes visible when a later
  run that reuses it is `PUBLISHED`.
- A legacy entity whose metadata carries `pipelineVersion` stays visible.
- A legacy promote neither matches nor `resolveTo`-probes a hidden entity. A
  legacy string whose norm key imitates a hidden typed key is created, not
  refused, and a repeat of that string matches the entity it created.
- A `FAILED_STAGE` run stays hidden.
- D9 BIND/MERGE refuse hidden refs with the not-resolving error.
- Relations touching a hidden entity are omitted.
- A foreign-tenant caller learns nothing about a hidden entity.
- The backfill marks pre-existing rows exactly as D2 states.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0 | 2026-09-27 | proposed | Proposed hiding unpublished GenesisRAG17 entities from legacy reads through a GKS-owned `origin` column, with consistent resolution-pool, D9 and relation rules. | working-tree | Claude |
