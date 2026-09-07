---
version: "0.2.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-07T23:55:00+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-extraction"
  doc_type: "migration-guide"
  scope: "MSP consumer cutover"
---

# MSP consumer migration guide

## Configure standalone GKS

MSP retains its provider bridge. Repoint configuration only:

```powershell
$env:MSP_GKS_COMMAND = (Get-Command node).Source
$env:MSP_GKS_ARGS = '["D:/gks/apps/gks-server/bin/gks-server.mjs"]'
$env:MSP_GKS_CWD = 'D:/gks'
$env:GKS_DB_PATH = (Join-Path $env:TEMP 'gks.sqlite')
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
```

The GKS child inherits `GKS_*` variables from MSP. GoVibe and Zuri receive no
GKS command, database path, or credentials.

## Compatibility proof

```powershell
$env:MSP_REPO_ROOT = 'D:\msp'
npm run test:integration
```

This executes both the actual MSP provider against standalone GKS and the full
standalone MSP service -> standalone GKS promotion chain.

## Cutover boundary

- Extraction does not remove GoVibe GKS/MSP compatibility surfaces.
- Cutover changes MSP deployment configuration, not GoVibe domain code.
- Zuri integration remains a later MSP-client task.
- Retirement of old fixtures/shims requires separate usage and rollback proof.

## GenesisRAG17 pipeline schema (migration 0006)

Migration `0006_genesisrag17_pipeline.sql` adds the isolated
`genesisrag17.v1` batch, occurrence, graph receipt, final receipt, gate,
publication receipt and cursor evidence tables. It does not rewrite legacy
entities, relations or port-v3 stage evidence. Apply it through the existing
SQLite migration runner before enabling the MSP `gks_pipeline_*` relay.

The batch and decision rows are immutable by scope and idempotency key. A
transport retry reuses the same key and receipt payload; a real execution
retry receives a new stage attempt. Graph receipt replay returns the stored
Stage 13/14 result, while final receipt replay returns its original hash even
after publication. A failed Tier-4 stage leaves later stages without success
evidence; a failed Stage 17 gate records terminal failure evidence without a
publication receipt.

## Rollback

Unset `MSP_GKS_COMMAND` to return MSP to named fail-closed behavior, or repoint
it to the previously verified provider. Never fall back to an in-memory or
GoVibe-local canonical store. Do not delete the GKS SQLite file during rollback.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.0b | 2026-09-07 | beta | Added the GenesisRAG17 migration 0006 schema, immutable attempt/replay rules, receipt ordering and non-destructive rollback guidance. | working-tree | RWANG |
| 0.1.0b | 2026-08-12 | beta | Initial MSP-to-standalone-GKS cutover and rollback guide. | working-tree | ATHER |
