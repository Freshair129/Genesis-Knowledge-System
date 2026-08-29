---
version: "0.1.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:29:29+07:00,ATHER"
status: "beta"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "repository-readme"
  scope: "standalone-repository"
---

# Genesis Knowledge System (GKS)

Standalone local-first service for canonical knowledge identity, relations,
deduplication, scoped retrieval, and artifact linking.

GKS is a separate system from both GoVibe and GenesisBlockDB. The governed
runtime path is:

```text
Zuri / GoVibe -> MSP -> GKS
```

Zuri and GoVibe call MSP. MSP is the sole caller of GKS in this path.

## Workspace

- `apps/gks-server` — NDJSON JSON-RPC stdio service.
- `packages/gks-core` — canonicalization and scope-aware domain service.
- `packages/gks-contracts` — errors, validation, tool registry, and persistence
  conformance boundary.
- `packages/gks-client-js` — publishable Node.js stdio client.
- `packages/gks-persistence` — GKS-owned SQLite adapter.
- `migrations` — canonical GKS schema ownership.
- `tests` — contract, security, integration, restart, and external MSP proof.

## Local verification

```powershell
npm install
npm test
$env:MSP_REPO_ROOT = 'D:\msp'
npm run test:integration
npm run pack:client
```

The external MSP tests skip when `MSP_REPO_ROOT` is absent. They run against
the actual MSP provider and MSP service when the variable is present.

## Start

GKS never chooses an implicit canonical database path:

```powershell
$env:GKS_DB_PATH = Join-Path $env:TEMP 'gks.sqlite'
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
npm start
```

`GKS_DEFAULT_PORTFOLIO_ID` exists only for API-010 compatibility calls that do
not yet carry the approved scope envelope. New search/entity/relation/link
calls must carry scope explicitly.

## Public tools

- `gks_health`
- `gks_knowledge_promote`
- `gks_search`
- `gks_entity_get`
- `gks_relations_get`
- `gks_artifact_link`
- `gks_review_list`
- `gks_review_apply`

## Status

Beta implementation. Standalone tests and MSP compatibility evidence are local
verification, not production deployment or Zuri cutover evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Initial standalone GKS repository implementation. | working-tree | ATHER |
