---
version: "0.2.0b"
created_at: "2026-09-07T23:30:00+07:00,RWANG,working-tree"
last_update: "2026-09-07T23:55:00+07:00,RWANG"
status: "accepted"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-09-07T23:00:00+07:00"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "architecture-decision"
  scope: "GenesisRAG17 GKS stages 9-14 and Stage 17 quality authority"
---

# ADR: GenesisRAG17 GKS execution contract

## Decision status

Accepted by the owner in the implementation task on 2026-09-07. This ADR
records the GKS side of the frozen `genesisrag17.v1` contract before code and
migrations are changed. MSP remains the sole caller and supplies the relay
credential plus the authenticated source or worker principal. GKS never calls
MSP, zuri-ai, GenesisBlockDB or a source store.

## Authority and lineage

Tier 1 owns raw-artifact, parsed-artifact and chunk persistence. MSP
authenticates and relays. GKS owns canonical entity resolution, deterministic
fact extraction, ontology mapping, temporal mapping, graph decisions,
enrichment and the final quality decision. Tier 4 owns physical graph,
embedding and index writes and returns receipts through MSP.

Every batch is immutable and keyed by `(scope, idempotencyKey)`. A delivery
retry reuses the same batch and stage attempt identities. A real retry receives
a new attempt identity. A source mention occurrence keeps its own
`sourceMentionId`, name, offsets and `semanticType`; it is never replaced by
the canonical resolution key. The canonical entity stores `semanticType` in
its metadata and the decision exposes the occurrence ids separately.

## Wire and authentication

New pipeline calls use camelCase and `schemaVersion: "genesisrag17.v1"`.
JSON hashes use recursively sorted object keys, preserve array order, hash
UTF-8, and reject non-JSON numbers. Text hashes cover the exact UTF-8 content.
Pipeline scope is the explicit six-string shape
`portfolioId`, `tenantId`, `businessId`, `workspaceId`, `agentId` and
`visibility`; equality is exact across all six fields.

The GKS runtime requires `GKS_PIPELINE_RELAY_CREDENTIAL`. Each request also
carries `authenticatedPrincipal: { principalId, role, scope }`, supplied by
MSP after it has removed caller credentials and actor fields. Source role is
required for submit and evidence export. Worker role is required for claim,
Tier-4 receipt, quality gate and publication receipt. The principal scope must
equal the request scope. No identity or authorization decision uses a caller
`actor` value.

## Stage decisions

- Stage 9 resolves each distinct `resolutionKey` once while retaining every
  source mention occurrence. `ENTITY` metadata carries the supplied
  `semanticType`.
- Stage 10 runs deterministic `rule_v1`. Explicit natural-language
  `works for` and `purchased` statements score `0.90`; structured equivalents
  score `0.85`; broad inferred or co-occurrence matches are capped at `0.70`
  and are `HELD`. The write floor is `0.80`. Stage 10 retains the raw
  predicate until Stage 11.
- Stage 11 runs frozen `ontology_v1`: `works for`, `employed by` and
  `works_for` map to `WORKS_FOR`; `purchased`, `bought` and `purchased_from`
  map to `PURCHASED`. `WORKS_FOR` requires `Person -> Organization` and
  `PURCHASED` requires `Person|Organization -> Product`. Unknown predicates
  and invalid endpoints are held with a reason.
- Stage 12 maps the accepted temporal semantics onto facts. Its pure port is
  pinned to Memory-and-Soul-Passport commit
  `8b8667dadf01fd7f421260af8b8b260f6cac267f`,
  `packages/msp-core/src/domain/temporal-engine.mjs`. Parity is fixture based;
  GKS does not import MSP at runtime. Unmapped, open-ended and explicit
  `not_applicable` states remain distinct.
- Stage 13 stores an immutable graph decision. Its terminal evidence is not
  emitted until a matching Tier-4 graph receipt is durably accepted. The
  physical Stage 13 projection is `2 + chunks + entities + facts + held`
  nodes and `1 + chunks + mentions + 2*facts + held` edges; these are checked
  against the actual worker readback before the stage closes.
- Stage 14 runs only after that receipt and emits separate `enrich_v1`
  derived summaries with actual distinct counts of documents, chunks and
  verified facts, plus source references. Final physical readback expectations
  are computed from the immutable decision and the committed derived payload;
  derived objects never replace verified facts.
- Stage 17 evaluates data, graph, knowledge, security and retrieval from the
  immutable decision and an actual Tier-4 receipt. Retrieval requires
  `recallAt5 >= 0.80`, `mrr >= 0.65`, `citationCorrectness == 1` and
  `crossTenantLeaks == 0`. Missing or unsupported receipt evidence cannot
  pass. The optional bitemporal lane may be `not_applicable` when every fact
  explicitly carries `not_applicable`, or `unsupported` only for the frozen
  native temporal API-unavailable reasons; required vector, lexical, graph,
  SQLite and provenance lanes must be ready. A failed gate writes terminal
  Stage 17 `FAILED` evidence with its verdict; a passing gate emits terminal
  Stage 17 evidence only after an accepted publication receipt.

## Evidence and recovery

The new `gks_pipeline_evidence` export is a separate, append-only ledger for
the frozen pipeline contract; the legacy port-v3
`gks_stage_evidence_export` remains readable and unchanged. New rows carry
the complete stage identity, one terminal outcome per stage and attempt, the
six exact metrics (`records_in`, `records_out`, `records_quarantined`,
`error_count`, `retry_count`, `duration_ms`) and stage details. Cursor progress
advances only after the row commits. Batch, decision, receipts and evidence
are durable in GKS-owned SQLite and replay returns the original canonical
hashes. Duplicate receipts are idempotent; a different payload for the same
identity is rejected.

Worker failures are limited to Tier-4 stages 13, 15 and 16. Each failure
retains its exact stage attempt, metrics and error, prevents later success
evidence, and can be replayed idempotently after transport loss. A graph or
final receipt replay after publication returns the stored receipt rather than
creating a second terminal row.

## Acceptance and limits

The implementation is tested with synthetic, isolated input and databases.
Tests cover hash and offset validation, repeated mentions, all Stage 10 rule
classes, ontology holds, temporal parity, immutable decisions, receipt-required
Stage 13/17 terminals, exact scope and role denial, cursor resume and
conflicting retries. This ADR makes no production, deployment or native
GenesisBlockDB claim; those require actual external receipts and publication
evidence.

## CHANGELOG

| Version | Date | Status | Summary | Agent |
|---|---|---|---|---|
| 0.2.0b | 2026-09-07 | accepted | Added physical Stage 13 projection counts, post-receipt Stage 14 enrichment accounting, optional temporal-lane rules, nested gate statistics, and authenticated Tier-4 failure/replay behavior. | RWANG |
| 0.1.0b | 2026-09-07 | accepted | Recorded the owner-approved GenesisRAG17 GKS boundary, authentication, immutable batch/replay semantics, Stage 9-14 decisions, Tier-4 receipt gates and Stage 17 quality authority before implementation. | RWANG |
