---
version: "0.3.0b"
created_at: "2026-08-12T10:05:34+07:00,ATHER,working-tree"
last_update: "2026-08-31T09:00:00+07:00,Claude Fable 5"
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
  // What search()/getEntity() actually return today (entityFromRow,
  // packages/gks-persistence/src/index.mjs:166-187) has no separate `id` —
  // canonicalRef is the identity — and does return candidateRef, the
  // original mention string the entity was first created from.
  canonicalRef: `gks:entity/${string}`;
  candidateRef: string;
  type: KnowledgeEntityType;
  title: string;
  summary: string;
  sourceRef?: string;
  confidence?: number;
  scope: KnowledgeScope;
  metadata: Record<string, unknown>;
  // Stage 9 (DPS-KI-ENTITY-RESOLVE) additions — see "Entity resolution
  // schema" below. normKey/normVersion are the identity the resolver
  // matches on; aliases/externalRefs are additive evidence accumulated by
  // MATCHED writes and D9 human binds; supersededBy is non-null only after
  // a D9 merge retires this row in favor of another canonical entity.
  normKey: string;
  normVersion: string;
  aliases: string[];
  externalRefs: string[];
  supersededBy?: string | null;
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

## Entity resolution schema (Stage 9 — `DPS-KI-ENTITY-RESOLVE`)

GKS owns Stage 9 of zuri-ai's seventeen-stage knowledge ingestion pipeline
(`docs/TIER-BOUNDARY-17-STAGE.md`). The schema below is what backs it, added
by migrations `0002_entity_resolution.sql`, `0003_pending_relations.sql`, and
`0004_human_resolution.sql`; the semantics are decided in full in
`docs/ADR-GKS-ENTITY-RESOLUTION.md`. **`canonicalEntityRef` hashing is not
Stage 9** — that digest is deduplication by identity (two spellings of one
entity hash apart and stay apart) and remains only the `CREATED` fallback
below. Stage 9 is the resolver that decides two mentions are the same entity,
names the strategy it used, and reports a confidence.

### `entities` — the additive columns

`entities` keeps canonical identity (one row per real-world thing), but its
uniqueness constraint changed: `UNIQUE(scope_key, candidate_ref)` is gone —
the mention string is no longer the identity — replaced by
`UNIQUE(scope_key, norm_key)`. Four new/changed columns:

- `norm_key` (`TEXT NOT NULL`) — the frozen `norm_v1` normalization of the
  entity's candidate string (`docs/NORM-V1-RULE-TABLE.md`). `NOT NULL`
  deliberately: SQLite treats `NULL` as distinct under `UNIQUE`, so a
  nullable `norm_key` would let a writer bug recreate unlimited silent
  duplicates — the exact defect class Stage 9 removes. A human ruling that
  two same-named entities are genuinely distinct discriminates the second's
  key as `norm_key + '#' + mention_id`, keeping it insertable but reachable
  only by the `CANONICAL_REF`, `EXTERNAL_REF`, and `ALIAS` rungs.
- `norm_version` (`TEXT NOT NULL`) — pins the normalizer that produced
  `norm_key`; changing normalization rules is a versioned event (a future
  `norm_v2`), never a silent re-key of everything.
- `aliases_json` / `external_refs_json` (`TEXT NOT NULL DEFAULT '[]'`) —
  additive identity evidence. A `MATCHED` write unions the mention's
  normalized form and any candidate external refs into these sets; a D9
  `BIND` adds the bound mention's `norm_key`; a D9 `MERGE` unions the loser's
  aliases and external refs onto the survivor. Never overwritten, only grown.
- `superseded_by` (`TEXT`, nullable, added by `0004_human_resolution.sql`) —
  the one sanctioned way an entity stops being a live identity: set only by a
  D9 `MERGE`, on the losing entity, naming the survivor. The row is never
  deleted and its `canonical_ref` is never rewritten. The resolution pool
  excludes any row with `superseded_by IS NOT NULL`, so a repaired
  over-split can never be matched — or reported `AMBIGUOUS` — against its
  own ghost; its spellings stay reachable through the aliases the merge
  copied onto the survivor.

Indexes: `idx_entities_search (portfolio_id, type, title, canonical_ref)`
(unchanged), `idx_entities_pool (portfolio_id, tenant_id, business_id,
workspace_id, project_id)` (new, created by migration 0002's backfill hook),
`idx_entities_superseded (superseded_by)` (new, migration 0004).

### `entity_mentions` — one row per occurrence, not per string

```text
entity_mentions(mention_id PK,
  scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing,
  candidate_ref, norm_key, provenance_ref, promotion_idempotency_key,
  canonical_ref NULLABLE, outcome, strategy, confidence, decided_at,
  field_diffs_json NULLABLE)
UNIQUE (scope_key, promotion_idempotency_key, candidate_ref)
```

This is the schema split at the center of Stage 9: `entities` is the
canonical identity, `entity_mentions` is what a producer asserted about one
occurrence and what was decided about it. The six discrete scope columns
duplicate what `scope_key` already encodes, deliberately — `scope_key` is an
opaque `\u0000`-join and can express equality and nothing else, while the
resolution pool's ancestor-scope predicate and the D9 review listing are both
SQL over individual dimensions.

- `canonical_ref` is nullable by design: an unresolved mention
  (`REVIEW_REQUIRED` / `AMBIGUOUS` / `REJECTED`) is a real state, not a
  missing value.
- `outcome` is one of the five FR-109 outcomes (`MATCHED`, `CREATED`,
  `AMBIGUOUS`, `REVIEW_REQUIRED`, `REJECTED`); `strategy` is one of the nine
  reportable strategies below.
- `field_diffs_json` is decision 7's record of a conflicting non-empty field
  a `MATCHED` write refused to overwrite on the entity; D9's review tool
  surfaces it as a proposed edit for a human to accept.
- The unique constraint is per-occurrence, not per-string:
  `UNIQUE(scope_key, candidate_ref)` was rejected for this table because it
  reproduces the exact over-merge Stage 9 exists to fix — two different
  entities asserting the same candidate string in one scope would collide
  and the second would be forced onto the first's resolution. The
  uniqueness that actually holds is *per promotion*: one envelope may assert
  a given mention string once.

Indexes: `idx_mentions_review (portfolio_id, tenant_id, outcome)` (the D9
review-queue listing), `idx_mentions_canonical (canonical_ref)`,
`idx_mentions_norm (scope_key, norm_key)`.

### `pending_relations` — a relation whose endpoint isn't resolved yet

```text
pending_relations(pending_id PK,
  scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing,
  from_candidate_ref, relation_type, to_candidate_ref,
  from_mention_id, to_mention_id, confidence, metadata_json,
  provenance_ref, promotion_idempotency_key,
  status DEFAULT 'PENDING', created_at, materialized_ref NULLABLE)
UNIQUE (scope_key, promotion_idempotency_key, from_candidate_ref, relation_type, to_candidate_ref)
```

A relation whose endpoint resolved without a canonical ref
(`REVIEW_REQUIRED` / `AMBIGUOUS` / `REJECTED`) is recorded here instead of
aborting the envelope — the envelope's resolved entities still promote, and
the relation is held with both mention endpoints so it can materialize once
the endpoint resolves. Rows are never deleted; like `entity_mentions` they
are the audit trail: `status` moves from `'PENDING'` to `'MATERIALIZED'`,
never back, and `materialized_ref` (added by `0004_human_resolution.sql`)
records which canonical relation the pending row became — the join from
"held" to "materialized" stays auditable in both directions. Materialization
happens only inside a D9 `BIND` transaction, since that is the only
mechanism by which an unresolved endpoint later resolves.

Indexes: `idx_pending_relations_status (portfolio_id, tenant_id, status)`,
`idx_pending_relations_mentions (from_mention_id, to_mention_id)`.

### `human_resolutions` — the audit trail of the one human-authorized write

```text
human_resolutions(decision_id PK, action,
  scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing,
  mention_id NULLABLE, canonical_ref, superseded_ref NULLABLE,
  provenance_ref, graph_version, created_at)
```

One row per D9 decision (`action` is `BIND` or `MERGE`), carrying its own
`provenance_ref` — separate from the mention's original promotion
provenance. `mention_id` is populated for `BIND` and null for `MERGE`;
`superseded_ref` is populated for `MERGE` (the losing entity) and null for
`BIND`. Rows are never deleted.

Index: `idx_human_resolutions_scope (portfolio_id, tenant_id, created_at)`.

### Resolution strategies, and which rows may write which

The nine reportable strategies
(`packages/gks-contracts/src/resolution.mjs:23-38`) are `CANONICAL_REF`,
`EXTERNAL_REF`, `EXACT`, `ALIAS`, `DETERMINISTIC`, `FUZZY`, `CREATED` — the
seven-rung resolver ladder, first decisive rung wins — plus two that are not
resolver rungs:

- **`HUMAN`** is written only by a D9 `BIND`, onto `entity_mentions`, under
  its own `human_resolutions` provenance. `transactPromotion` refuses it
  outright at the write — a promotion asserting `strategy: "HUMAN"`, from
  any resolver present or future, is rejected — because the resolver has no
  path to it: `resolveEntity` is pure and `promoteCandidate` reaches only
  `transactPromotion` (`packages/gks-core/src/index.mjs:216-219`), which
  enforces the refusal at the write itself with an explicit check and throw
  (`packages/gks-persistence/src/index.mjs:353-355`).
- **`BACKFILL`** is migration-only. Migration `0002`'s backfill hook inserts
  exactly one `outcome: 'CREATED', strategy: 'BACKFILL'` mention per
  pre-Stage-9 entity, `confidence` `NULL`, `decided_at` copied from the
  entity's `created_at` (`packages/gks-persistence/src/index.mjs:69`). No
  code path outside that one migration hook ever writes it.

### The pool: a tenant hard wall, ancestors below it

Both the resolver's lookup (`lookupResolutionCandidates`) and the D9 review
listing (`listUnresolvedMentions`) filter every scope dimension in SQL, never
in a caller-side filter, because the failure mode a leak here produces is a
cross-tenant merge — an unrecoverable write, not a read that a later filter
fix repairs. `portfolio_id` and `tenant_id` match by exact equality: an
empty `tenant_id` is a tenant of its own, never a wildcard, so tenant-less
and tenanted knowledge can never pool together in either direction. Below
the tenant wall, `business_id` / `workspace_id` / `project_id` use `dim = ''
OR dim = requested_dim` — an entity at the same or a broader scope, matching
an ancestor, never a narrower one. `sharing` is not a pooling dimension:
nothing in GKS grants runtime meaning to it today, so the pool cannot
inherit a distinction the code does not make. The same rule governs the D9
write itself — a `BIND` target must sit in the mention's pool, and a `MERGE`
refuses cross-tenant operands outright, the empty tenant included.

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
  // Stage 9's evidence surface on the promote response — per-entity
  // resolution outcome/strategy/confidence, added on this existing channel
  // rather than a new tool (D7). See "Entity resolution schema" above.
  resolution?: { outcome: string; strategy: string; confidence: number | null };
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

Stage 9 (`DPS-KI-ENTITY-RESOLVE`) additionally persists per-occurrence mention
records, relations pending on an unresolved endpoint, and an audit trail of
human resolution decisions — see "Entity resolution schema" above for the
tables and write rules.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.0b | 2026-08-31 | beta | Closes the Stage 9 schema-doc debt found during the 2026-08-31 branch review: documents `entity_mentions`, `pending_relations`, `human_resolutions`, and the additive `entities` columns (`norm_key`, `norm_version`, `aliases_json`, `external_refs_json`, `superseded_by`) added by migrations 0002-0004, names `DPS-KI-ENTITY-RESOLVE` (Stage 9) as the owning pipeline stage, and records the write rules that govern them (additive-only `MATCHED` writes, `HUMAN` written only by a D9 bind and refused by `transactPromotion`, `BACKFILL` as migration-only, the nine reportable strategies, and the tenant-hard-wall pool rule). ather's audit of the first pass found the initial `CanonicalMapping` and `KnowledgeEntity` types stale against the actual runtime shape and one citation incomplete; fixed in the same revision: `CanonicalMapping` gains Stage 9's `resolution` field (the evidence channel D7 rides on the promote response), `KnowledgeEntity` drops the `id` field `entityFromRow` never returns and adds the `candidateRef` field it does return, and the `HUMAN`-refusal citation gains the enforcing throw (`gks-persistence/src/index.mjs:353-355`) alongside the rationale comment. No code changed. | working-tree | Claude Fable 5 |
| 0.2.0b | 2026-08-12 | beta | Recorded implemented canonical records, mapping/version transactions, MSP-owned candidate lifecycle, and fail-closed scope behavior. | working-tree | ATHER |
| 0.1.2b | 2026-08-12 | beta | Owner approved the canonical knowledge data model for implementation. | working-tree | Boss (บอส) / ATHER |
| 0.1.1b | 2026-08-12 | draft | Removed the implied GenesisBlockDB persistence relationship and retained a single GKS-owned canonical store invariant. | working-tree | ATHER |
| 0.1.0b | 2026-08-12 | draft | Proposed neutral entities, relations, mappings, artifact links, scope invariants, and MSP-owned candidate lifecycle. | working-tree | ATHER |
