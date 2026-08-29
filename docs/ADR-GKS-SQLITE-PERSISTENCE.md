---
version: "0.1.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:29:29+07:00,ATHER"
status: "beta"
approval_owner: "Boss (บอส)"
approval_recorded_at: "2026-08-12T10:16:19+07:00"
superseded_by: null
attributes:
  domain: "gks-persistence"
  doc_type: "architecture-decision"
  scope: "D:/gks"
---

# ADR: GKS-owned SQLite persistence for the local-first MVP

## Context

The approved extraction requires a complete standalone GKS abstraction and an
offline-first local persistence implementation. GenesisBlockDB is a separate
repository and system, not the GKS extraction source or an implied adapter.

## Decision

Use one SQLite database owned exclusively by GKS for the MVP. The concrete
adapter implements `GksPersistencePort` and remains private to `gks-server`.

```text
MSP -> GKS service -> GksPersistencePort -> GKS-owned SQLite
```

- `GKS_DB_PATH` must be an explicit absolute path.
- WAL and foreign-key enforcement are enabled at startup.
- `migrations/` is the canonical schema owner.
- Promotions, entity/relation materialization, canonical mappings, and graph
  version updates commit atomically.
- No in-memory runtime fallback exists.
- GenesisBlockDB integration is outside this decision.

## Consequences

- Local operation and restart testing require no network service.
- One process owns schema migration and canonical writes.
- A future adapter replacement must pass the executable
  `GksPersistencePort` conformance contract and requires its own ADR.
- SQLite file availability is not evidence of GKS health; startup opens,
  migrates, and queries the graph-state record before reporting ready.

## Risk

`HIGH` at extraction level; the persistence implementation itself is isolated
and local. Primary mitigations are transactions, idempotency constraints,
explicit scoping, fail-closed startup, and restart/security tests.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Recorded the owner-approved SQLite implementation for the standalone local-first GKS MVP. | working-tree | Boss (บอส) / ATHER |
