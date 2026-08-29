---
version: "0.4.0b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-08-30T04:00:00+07:00,KIN"
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

The eight service methods are exposed as versioned tool definitions in
`@freshair129/gks-contracts`. `assertGksPersistencePort` enforces the executable
replacement surface before the domain service starts. SQLite is the approved
MVP adapter; no implementation package name appears in the client.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.4.0b | 2026-08-30 | beta | Recorded D9's delivered surface (ADR-GKS-ENTITY-RESOLUTION D9, D10.2, decision 6): two new public tools -- `gks_review_list` (unresolved mentions within scope) and `gks_review_apply` (ONE human-authorized write: bind a mention to an existing canonical entity, or merge two canonical entities with supersession and relation re-pointing in the same transaction). Port version 2 gains `listUnresolvedMentions` and `transactHumanResolution` -- in the SAME version as the lookup, because decision 6 places D9 inside Stage 9 and an optional consumer would ship refusal with no repair. The lookup now excludes superseded entities. This is not the rejected `gks_resolve`: the write is human-authorized repair carrying its own provenance, not caller resolution-without-promotion (D7). | working-tree | KIN |
| 0.3.0b | 2026-08-29 | beta | Corrected the persistence port to what the code has always enforced -- seven operations with `transactArtifactLink` and `close`, not six with `linkArtifact`; the document had described a surface no adapter ever had to satisfy. Recorded port version 2 ahead of implementation: Stage 9 requires a `lookupResolutionCandidates` operation that filters every scope dimension in SQL, plus atomic unique-constraint detection in `transactPromotion`. Both break the replacement contract deliberately -- an optional lookup would reintroduce digest-only identity as a supported configuration, and caller-side scope filtering is safe for a read but not for a merge. | working-tree | Claude Opus 5 |
| 0.2.0b | 2026-08-12 | beta | Recorded the implemented tool registry, API-010 compatibility, client isolation, and executable persistence conformance gate. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the service and persistence port contracts for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Renamed the internal boundary to GksPersistencePort and left production persistence unresolved; no GenesisBlockDB dependency is implied. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed MSP-only GKS service port, scoped operations, API-010 compatibility, and a replaceable persistence port. | working-tree | ATHER |
