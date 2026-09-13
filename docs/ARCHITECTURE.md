---
version: "0.2.2b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-13T18:30:00+07:00,KIN"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-service"
  doc_type: "architecture"
  scope: "standalone-repository"
---

# Standalone GKS architecture

## Authority boundary

```text
GoVibe/Zuri -> MSP -> GKS
```

GoVibe creates governed candidates. MSP owns memory, context, scope, candidate
review, authorization, and promotion receipts. GKS assigns canonical knowledge
identity and relations. GKS does not store Zuri transaction rows or MSP memory.

## Runtime boundary

```text
MSP provider
  -> NDJSON JSON-RPC stdio
  -> gks-server (composition root)
       -> gks-contracts
       -> gks-core
       -> gks-persistence
            -> GKS-owned SQLite
```

The current server is process-local and offline-first. A future transport must
preserve the same public contract and cannot widen callers beyond MSP without a
new authority decision.

## GenesisRAG17 execution boundary

The `genesisrag17.v1` pipeline is an additive authority boundary inside the
same composition root:

```text
MSP source/worker principal
  -> gks_pipeline_* JSON-RPC tools
  -> gks-core pipeline decision and quality authority
  -> gks-persistence pipeline_batches / receipts / evidence
  -> MSP
  -> Tier 4 worker and publication receipts, supplied through MSP
```

GKS owns stages 9, 10, 11, 12, 13's graph decision, 14, and 17. Tier 4 owns
the physical graph, embedding, and index writes. GKS never opens a connection
to Tier 4 and never treats GenesisBlockDB as its persistence backend. The
worker's authenticated receipts are the evidence boundary for physical work.

Submission creates one immutable batch and decision keyed by the exact six
scope fields plus `idempotencyKey`. The decision contains the resolved entity
set, every source occurrence, raw fact candidates, ontology-filtered facts,
temporal values, held rows, graph decision, and stage metrics. Stage 13 and 14
are one ordered boundary: a valid physical graph receipt is persisted first,
then GKS computes and persists the separate `enrich_v1` payload. The later
worker receipt covers stages 15 and 16, and Stage 17 evaluates the immutable
decision against those receipts and the retrieval benchmark. A passing Stage
17 is terminal only after publication; a failed gate writes failed terminal
evidence with its verdict.

The implementation seam is deliberately narrow. Stage 9 resolution uses the
existing canonical identity store through `lookupResolutionCandidates`; it
does not create a second identity universe. Stage 10–12 are pure decision
steps in `packages/gks-core/src/pipeline.mjs`, Stage 12's temporal helper is
`packages/gks-core/src/temporal.mjs`, and the versioned envelope and hashes are
in `packages/gks-contracts/src/pipeline.mjs`. Future extensions add a new
versioned contract or an approved rule/ontology/temporal artifact and preserve
old stage ids, attempt identities, hashes, and port-v3 behavior. Query-time
orchestration after publication remains retrieval behavior, not Stage 18.

## Dependency direction

```text
gks-contracts <- gks-core
gks-contracts <- gks-persistence
{gks-contracts, gks-core, gks-persistence} <- gks-server
gks-client-js -> Node built-ins only
```

- `gks-core` never imports persistence or server packages.
- `gks-persistence` never imports core or server packages.
- `gks-client-js` never imports runtime implementation packages.
- Runtime source contains no GoVibe, MSP repository, or GenesisBlock import.

## Scope behavior

Every canonical record stores portfolio, tenant, business, workspace, project,
and sharing dimensions. Reads are intersection-scoped. Cross-tenant access is
denied by default, including `portfolio-shared` records until a future contract
adds explicit MSP authorization evidence.

## Canonicalization

- Entity identity is deterministic within the exact GKS scope and candidate
  reference.
- Relations resolve only between entities in the same authorized promotion
  envelope for this MVP.
- Promotion idempotency is `(scope, idempotency_key)` with source-hash conflict
  rejection.
- Each successful mutation advances one graph version.
- Backlinks remain projections of the original stored relation.

## Compatibility

`gks_knowledge_promote` retains API-010's required request fields and response
fields. Scope-aware callers supply `scope`; legacy API-010 calls use an operator
configured `GKS_DEFAULT_PORTFOLIO_ID` and remain private by default.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.2b | 2026-09-13 | beta | The publishable client ships a README and CHANGELOG, so a consumer upgrading past the 0.2.0 break — where the child environment became an allowlist instead of a copy of the caller's process.env — learns of it from the tarball rather than from this repository. Client Node floor moved to 22 to match the service it starts. No runtime change. | docs/client-release-notes | KIN |
| 0.2.1b | 2026-09-13 | beta | Two call-path hardenings, no contract change. `GksStdioClient` builds its child environment from an explicit allowlist (`GKS_*` + OS basics) instead of defaulting to a copy of the caller's `process.env` — breaking for `@freshair129/gks-client-js` consumers that relied on other variables reaching the child; client 0.1.0 -> 0.2.0. And a failed store open no longer republishes the value of `GKS_DB_PATH`: `mkdirSync` moved inside the guarded block and the path is redacted from the message, which crosses to MSP callers through stderr. | fix/client-env-and-persistence-error | KIN |
| 0.2.0b | 2026-09-08 | beta | Added the implemented GenesisRAG17 Tier-3/4 boundary, immutable decision and receipt ordering, quality-gate authority, and extension rules. | 9279cfe | RWANG |
| 0.1.0b | 2026-08-12 | beta | Initial implemented architecture and dependency rules. | working-tree | ATHER |
