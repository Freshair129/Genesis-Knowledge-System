---
version: "0.1.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-08-12T10:29:29+07:00,ATHER"
status: "beta"
superseded_by: null
attributes:
  domain: "gks-operations"
  doc_type: "runbook"
  scope: "local-first-MVP"
---

# Runbook: Local GKS service

## Preflight

```powershell
node --version
npm install
npm test
```

Node 20 or newer is required. `npm install` must report no unresolved security
advisories before release consideration.

## Start and health

```powershell
$env:GKS_DB_PATH = Join-Path $env:TEMP 'gks.sqlite'
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
npm start
```

The process speaks newline-delimited JSON-RPC on stdin/stdout. Send
`initialize`, `notifications/initialized`, then call `gks_health`. Configuration
presence alone is not a health result.

## Failure behavior

- Missing/non-absolute `GKS_DB_PATH`: startup exits before serving.
- Invalid candidate/scope: `gks_invalid_request`.
- Unauthorized lookup: `gks_scope_denied`.
- Idempotency/hash collision: `gks_conflict`.
- SQLite open/migration failure: `gks_backend_unavailable`.
- No error returns a fabricated canonical reference or graph version.

## Evidence collection

```powershell
npm test
$env:MSP_REPO_ROOT = 'D:\msp'
npm run test:integration
npm run pack:client
```

Record command, exit code, test counts, Node version, package version, and the
exact MSP/GKS source revisions before claiming compatibility.

## Recovery

Stop callers before copying or restoring the SQLite file. Preserve the database,
`-wal`, and `-shm` files as one recovery unit. Restart and run `gks_health` plus
an idempotent known promotion. Do not create a replacement empty database and
call it recovered canonical state.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-08-12 | beta | Initial local start, health, evidence, failure, and recovery procedure. | working-tree | ATHER |
