---
version: "0.1.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:29:29+07:00,ATHER"
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
| 0.1.0b | 2026-08-12 | beta | Initial implemented architecture and dependency rules. | working-tree | ATHER |
