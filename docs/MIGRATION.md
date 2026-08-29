---
version: "0.1.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:29:29+07:00,ATHER"
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

## Rollback

Unset `MSP_GKS_COMMAND` to return MSP to named fail-closed behavior, or repoint
it to the previously verified provider. Never fall back to an in-memory or
GoVibe-local canonical store. Do not delete the GKS SQLite file during rollback.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Initial MSP-to-standalone-GKS cutover and rollback guide. | working-tree | ATHER |
