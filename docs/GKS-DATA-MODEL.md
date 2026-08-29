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
  doc_type: "data-model"
  scope: "canonical knowledge semantics"
---

# GKS Data Model

## Model rule

GKS models semantic knowledge, canonical identity, and relations. It does not
copy Zuri business rows or MSP conversational/context records.

The physical backend may use graph records, relational projections, or other
engine-owned structures. Those structures must not leak into the public GKS
contract.

## Canonical entity

```ts
type KnowledgeEntityType =
  | "IDEA" | "CONCEPT" | "ALGO" | "ENTITY" | "API" | "ENDPOINT"
  | "ENTRYPOINT" | "FLOW" | "FEAT" | "PARAMS" | "FRAME" | "BLUEPRINT"
  | "TASK_REF" | "SOURCE" | "AUDIT_REF" | "OPS";

type KnowledgeEntity = {
  id: string;
  canonicalRef: `gks:entity/${string}`;
  type: KnowledgeEntityType;
  title: string;
  summary: string;
  sourceRef?: string;
  confidence?: number;
  scope: KnowledgeScope;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  graphVersion: string;
};
```

Entity types remain vocabulary values, not one table or collection per type.

## Canonical relation

```ts
type KnowledgeRelationType =
  | "DEPENDS_ON" | "IMPLEMENTS" | "CALLS" | "READS" | "WRITES"
  | "TOUCHES" | "DESCRIBED_BY" | "DERIVED_FROM" | "RELATED_TO"
  | "BELONGS_TO" | "AFFECTS" | "VALIDATED_BY";

type KnowledgeRelation = {
  id: string;
  canonicalRef: `gks:relation/${string}`;
  fromRef: string;
  relationType: KnowledgeRelationType;
  toRef: string;
  confidence?: number;
  evidenceRef: `msp:proof/${string}`;
  scope: KnowledgeScope;
  metadata: Record<string, unknown>;
  createdAt: string;
  graphVersion: string;
};
```

A backlink is a reverse projection of an existing forward relation. It must not
create a second semantic edge or lose the original relation/provenance ID.

## Candidate ownership

Candidate lifecycle is not duplicated inside GKS:

```text
GoVibe/external producer -> candidate payload
MSP -> PROPOSED | REVIEWED | APPROVED | REJECTED | SUPERSEDED
GKS -> validate approved request, canonicalize, persist, return mapping
```

GKS may retain an immutable `PromotionAttempt` audit record, but MSP remains the
authority for candidate review state.

```ts
type PromotionAttempt = {
  id: string;
  idempotencyKey: string;
  sourceSnapshotHash: string;
  provenanceRef: `msp:proof/${string}`;
  candidateRef: string;
  scope: KnowledgeScope;
  outcome: "COMMITTED" | "REJECTED" | "CONFLICT";
  canonicalMappings: CanonicalMapping[];
  graphVersion?: string;
  createdAt: string;
};

type CanonicalMapping = {
  candidateRef: string;
  canonicalRef: string;
  canonicalType: "ENTITY" | "RELATION" | "ARTIFACT_LINK";
};
```

## Cross-system references

References are identifiers, not copied records:

```text
project:PRJ-ZURI-V2
workstream:WST-ID-LINE
gate:GATE-DATA-ID
repo:REP-ZURI
spec:SPEC-IDENTITY-001
msp:proof/...
gks:entity/...
gks:relation/...
```

Zuri may store opaque `gks:` and `msp:` references. GKS may store the Zuri
identifier and relation metadata, but never the full Project, Task, CRM, deal,
invoice, metric, or migration-run row.

## Artifact link

```ts
type KnowledgeArtifactLink = {
  id: string;
  canonicalRef: `gks:artifact-link/${string}`;
  knowledgeRef: string;
  artifactRef: string;
  relationType: "DESCRIBED_BY" | "IMPLEMENTS" | "VALIDATED_BY" | "RELATED_TO";
  evidenceRef: `msp:proof/${string}`;
  scope: KnowledgeScope;
  graphVersion: string;
};
```

## Scope and sharing invariants

- Every canonical entity, relation, mapping, and link has a portfolio scope.
- Tenant, business, workspace, and project scope are optional dimensions but
  must be preserved when supplied.
- Reads and relation expansion are intersection-scoped, never union-scoped by
  default.
- Cross-tenant access is denied unless both records are explicitly
  `portfolio-shared` and MSP supplies authorization evidence.
- Deduplication runs within the authorized sharing boundary. Similar objects in
  isolated tenants are not silently merged.

## Graph versioning

- Every successful mutation returns one committed graph version.
- Promotion mapping, entity/relation writes, and artifact links for one request
  commit atomically or fail without a partial canonical result.
- Historical source hash and provenance remain immutable.
- Semantic changes create new versions/supersession records rather than
  destructive overwrite where the backend supports bitemporal history.

## Non-goals

- MSP memory storage
- Zuri transactional persistence
- autonomous low-confidence promotion
- unrestricted ontology inference
- embedding schema in the public model
- a table per knowledge type
- multiple production stores claiming canonical GKS truth

## Implementation evidence

The MVP persists promotions, canonical entities, canonical relations, artifact
links, scope dimensions, candidate-to-canonical mappings, and graph versions.
Candidate review status remains absent by design because MSP owns that lifecycle.
Cross-tenant reads fail closed, including portfolio-shared records until an MSP
authorization-evidence contract is added.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-08-12 | beta | Recorded implemented canonical records, mapping/version transactions, MSP-owned candidate lifecycle, and fail-closed scope behavior. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the canonical knowledge data model for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Removed the implied GenesisBlockDB persistence relationship and retained a single GKS-owned canonical store invariant. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed neutral entities, relations, mappings, artifact links, scope invariants, and MSP-owned candidate lifecycle. | working-tree | ATHER |
