---
version: "0.2.0b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:31:21+07:00,ATHER"
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

```ts
interface GksPersistencePort {
  health(): Promise<KnowledgeStoreHealth>;
  transactPromotion(input: CanonicalPromotionTransaction): Promise<CanonicalPromotionCommit>;
  search(input: ScopedKnowledgeQuery): Promise<StoredKnowledgeHit[]>;
  getEntity(input: ScopedCanonicalRef): Promise<StoredKnowledgeEntity | null>;
  getRelations(input: ScopedRelationQuery): Promise<StoredKnowledgeRelation[]>;
  linkArtifact(input: ScopedArtifactLink): Promise<StoredArtifactLink>;
}
```

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

The six service methods are exposed as versioned tool definitions in
`@freshair129/gks-contracts`. `assertGksPersistencePort` enforces the executable
replacement surface before the domain service starts. SQLite is the approved
MVP adapter; no implementation package name appears in the client.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-08-12 | beta | Recorded the implemented tool registry, API-010 compatibility, client isolation, and executable persistence conformance gate. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the service and persistence port contracts for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Renamed the internal boundary to GksPersistencePort and left production persistence unresolved; no GenesisBlockDB dependency is implied. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed MSP-only GKS service port, scoped operations, API-010 compatibility, and a replaceable persistence port. | working-tree | ATHER |
