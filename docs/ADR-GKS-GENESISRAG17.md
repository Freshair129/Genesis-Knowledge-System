---
version: "0.4.1b"
created_at: "2026-09-07T23:30:00+07:00,RWANG,working-tree"
last_update: "2026-09-08T20:00:00+07:00,RWANG"
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
records the GKS side of the frozen `genesisrag17.v1` contract and its current
implementation. MSP remains the sole caller and supplies the relay
credential plus the authenticated source or worker principal. GKS never calls
MSP, zuri-ai, GenesisBlockDB or a source store.

## Authority and lineage

Tier 1 owns raw-artifact, parsed-artifact and chunk persistence. MSP
authenticates and relays. GKS owns canonical entity resolution, deterministic
fact extraction, ontology mapping, temporal mapping, graph decisions,
enrichment and the final quality decision. Tier 4 owns physical graph,
embedding and index writes and returns receipts through MSP.

Every batch is immutable and keyed by `(scope, idempotencyKey)`. A delivery
retry reuses the same batch and stage attempt identities. A processing retry
starts a new FR071 materialized replay from the Tier-1 raw entrypoint and
therefore receives new batch, decision, run and stage-attempt identities. A
source mention occurrence keeps its own
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

- Stage 9 resolves each distinct typed identity once while retaining every
  source mention occurrence. Its internal identity is the ordered pair
  `[norm_v1(resolutionKey), normalizeSemanticType(semanticType)]`, serialized
  as a canonical JSON array for map/digest inputs. The pair is never exposed
  as a replacement for `resolutionKey`; `ENTITY` metadata carries the
  supplied `semanticType`, and incompatible types remain separate identities.
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
  `not_applicable` states remain distinct. In the text-only profile, no
  temporal claim writes `validFrom`/`validTo` as `not_applicable`; a temporal
  expression that the ISO parser cannot map is HELD with
  `temporal_unmapped` and its source references; it never becomes a verified
  fact with `null`/`null` bounds. A supported dated claim with no end writes
  `validTo: null` (open-ended). Reversed intervals are HELD with
  `invalid_temporal_order`, never a builder exception. Structured temporal
  metadata on the frozen source/chunk wire is rejected as unsupported so it
  cannot be silently discarded.
- Stage 13 stores an immutable graph decision. Its terminal evidence is not
  emitted until the worker has written the physical Tier-4 graph, returned a
  matching graph receipt, and GKS has durably accepted it. The
  physical Stage 13 projection is `2 + chunks + entities + facts + held`
  nodes and `1 + chunks + mentions + 2*facts + held` edges; these are checked
  against the actual worker readback before the stage closes.
- Stage 14 runs only after that receipt and emits separate `enrich_v1`
  derived summaries with actual distinct counts of documents, chunks and
  verified facts, plus source references. Final physical readback expectations
  are computed from the immutable decision and the committed derived payload;
  derived objects never replace verified facts.
- Stage 17 evaluates data, graph, knowledge, security and retrieval from the
  immutable decision and actual Tier-4 receipts; Tier 4 supplies physical lane
  and readback evidence while GKS computes and owns the five-dimension verdict.
  Retrieval requires
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

## Audit remediation amendment (0.4.0b)

The 2026-09-08 code-flow audit found counterexamples outside the original
positive corpus. This amendment records the GKS-owned corrections under the
already-approved `genesisrag17.v1` wire shape; it adds no new predicate, LLM,
production path, or temporal source field.

Stage 9 uses the typed identity pair described above for both the in-memory
decision map and the persisted entity uniqueness key. The persistence key is
`norm_v1(resolutionKey) + U+0000 + normalizeSemanticType(semanticType)`;
the semantic type is also stored in `entities.type` and
`metadata.semanticType`. Existing rows are eligible for reuse only when their
stored semantic type matches. Every mention keeps its original
`sourceMentionId`, `resolutionKey`, `semanticType`, name, and offsets, so a
same-name Person/Product pair produces two entities and two occurrence
bindings rather than a merged occurrence list.

Stage 10 keeps the frozen scores and aliases, but resolves coordinated
clauses against the grammatical subject only for the supported `and`/`&` form
when no new subject mention occurs. Unsupported coordination such as `but
purchased` or a bare comma before the next predicate is held with
`ambiguous_subject_binding` rather than binding the previous object as a new
subject. A negated relation, including `neither ... nor`, is never emitted as
a verified fact; the conservative path leaves only a held or no candidate.
Stage 10 metrics count the chunks actually processed, and Stage 9 timing
starts before the canonical lookup and ends after typed identity construction.

Stage 12 has three observable valid-time outcomes using the existing decision
fields: `not_applicable`/`not_applicable` means the source makes no temporal
claim; an ISO start with `null` end means a mapped open interval; and an
unsupported temporal claim is unmapped and held with reason
`temporal_unmapped`. The held row's source references retain the original
claim, so no verified fact can expose `null`/`null` bounds that a downstream
reader could mistake for not-applicable. Invalid ordering is recorded in
`held` with `invalid_temporal_order`. Structured temporal metadata supplied
outside the frozen source/chunk fields is rejected by validation.

Stage 17 remains fail-closed: a `WARN` verdict is stored as terminal FAILED
evidence with `allowPublication: false`, and publication accepts only a
matching `PASS` verdict and worker receipt.

## Cross-repository references

The authoritative zuri-ai definitions are the
[`17-stage specification`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-SPEC.md)
and its
[`17-stage flow`](https://github.com/Freshair129/zuri-ai/blob/codex/ki17-integration/docs/KNOWLEDGE-INGESTION-17-STAGE-FLOW.md).
The current isolated execution and publication decision is [ADR-073 —
GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md).
The GKS contract proof is
`tests/contract/pipeline-genesisrag17.test.mjs`; the temporal parity proof is
`tests/contract/temporal-engine-parity.test.mjs`, implemented beside
`packages/gks-core/src/temporal.mjs`. These links identify the current
`codex/ki17-integration` profile and do not authorize a direct GKS-to-zuri or
GKS-to-MSP import.

## Acceptance and limits

The implementation is tested with synthetic, isolated input and databases.
Tests cover hash and offset validation, repeated mentions, all Stage 10 rule
classes, ontology holds, temporal parity, immutable decisions, receipt-required
Stage 13/17 terminals, exact scope and role denial, cursor resume and
conflicting retries. This ADR makes no production, deployment or native
GenesisBlockDB claim; those require actual external receipts and publication
evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.4.0b | 2026-09-08 | active | Recorded audit remediation: typed Stage 9 identity, supported-only coordinated Stage 10 subject carry with `ambiguous_subject_binding` holds, conservative negation, measured Stage 9/10 evidence, three-state temporal mapping and PASS-only publication. | working-tree | RWANG |
| 0.3.0b | 2026-09-08 | accepted | Reconciled the frozen ADR with the implemented receipt order, Tier-4 evidence ownership, materialized replay identity, exact contract/parity tests, and zuri-ai spec/flow links. | 9279cfe | RWANG |
| 0.2.0b | 2026-09-07 | accepted | Added physical Stage 13 projection counts, post-receipt Stage 14 enrichment accounting, optional temporal-lane rules, nested gate statistics, and authenticated Tier-4 failure/replay behavior. | working-tree | RWANG |
| 0.1.0b | 2026-09-07 | accepted | Recorded the owner-approved GenesisRAG17 GKS boundary, authentication, immutable batch/replay semantics, Stage 9-14 decisions, Tier-4 receipt gates and Stage 17 quality authority before implementation. | working-tree | RWANG |

## Reference version diff — 2026-09-08

"0.4.0b → 0.4.1b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.
