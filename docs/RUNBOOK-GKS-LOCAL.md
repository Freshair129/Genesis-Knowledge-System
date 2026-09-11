---
version: "0.2.2b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-11T12:30:00+07:00,Claude Opus 5"
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
npm ci
npm test
```

The package declares Node `>=22`, the floor of `better-sqlite3` 13.
`.github/workflows/test.yml` runs `npm ci` and `npm test` on Node 22 and 24
(ubuntu-latest) for every pull request and push to `main`; the external MSP
suite skips there because `MSP_REPO_ROOT` is unset. `npm ci` must report no
unresolved security advisories before release consideration.

`better-sqlite3` 13 runs on N-API and ships its prebuilt binaries inside the
package, so it no longer has to be rebuilt against the headers of the running
Node. Do not move it back to 11.x or 12.x: those are `node::ObjectWrap` addons,
and a copy compiled against Node 24.19.0 or later 24.x headers (every source
build on those runtimes, including 11.10.0, which has no Node 24 prebuild)
aborts the process when the garbage collector frees a prepared statement:
`node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`.
Node 24.19.0 backported the `ObjectWrap` cleanup hooks without the global hook
registry that makes removal safe without a live `Environment`
([nodejs/node#65446](https://github.com/nodejs/node/issues/65446); backport of
the registry pending in [nodejs/node#65943](https://github.com/nodejs/node/pull/65943)).

The GenesisRAG17 acceptance profile was verified on Node 24.18.x. Record the
runtime and the checked-out commit with every compatibility result; do not treat
a different local Node patch level as equivalent evidence.

## Clone, paths, and grants

Use an explicit checkout and an explicit database path. The service does not
derive a database location from the current directory, and a credential is
never stored in this repository or printed in a runbook transcript.

```powershell
$gksRoot = 'C:\workspace\gks-ki17'
$dbPath = 'C:\workspace\gks-ki17-data\gks.sqlite'
git clone --branch codex/ki17-integration --single-branch `
  https://github.com/Freshair129/Genesis-Knowledge-System.git $gksRoot
Set-Location $gksRoot
New-Item -ItemType Directory -Force (Split-Path -Parent $dbPath) | Out-Null
if (-not [IO.Path]::IsPathFullyQualified($dbPath)) { throw 'GKS_DB_PATH must be absolute' }
```

MSP is the sole caller. It authenticates the runtime role and scope, then
forwards the relay credential and `authenticatedPrincipal` to GKS. A source
principal may submit a batch and pull evidence; a worker principal may claim a
batch, write the Stage 13 graph receipt, report worker failures for stages 13,
15, or 16, write the Stage 15/16 receipt, evaluate Stage 17, and submit the
publication receipt. Pipeline scope always carries
`portfolioId`, `tenantId`, `businessId`, `workspaceId`, `agentId`, and
`visibility`; the first three are non-empty and the current profile uses
`visibility: "private"`. GKS rejects caller-supplied actor identity in place of
the MSP-forwarded principal.

## Start and health

```powershell
$env:GKS_DB_PATH = $dbPath
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
if ([string]::IsNullOrWhiteSpace($env:GKS_PIPELINE_RELAY_CREDENTIAL)) {
  throw 'MSP must inject GKS_PIPELINE_RELAY_CREDENTIAL out of band before start'
}
npm start
```

The process speaks newline-delimited JSON-RPC on stdin/stdout. Send
`initialize`, `notifications/initialized`, then call `gks_health`. Configuration
presence alone is not a health result.

For a GenesisRAG17 run, MSP launches GKS with the relay credential available
out of band and forwards the authenticated source or worker principal on each
request. The source submits a durable batch and the worker calls the contracts
in this order: `gks_pipeline_submit`, `gks_pipeline_claim`, physical Tier-4
graph write/readback, then `gks_pipeline_graph_receipt` (which verifies the
worker's physical Stage 13 receipt, closes Stage 13, and commits GKS's Stage 14
derived summaries),
`gks_pipeline_write_receipt`, `gks_pipeline_gate`, and, only after a passing
gate with `allowPublication: true` and the actual publication pointer/snapshot
switch, `gks_pipeline_publication_receipt`. The source can then call
`gks_pipeline_evidence`. The legacy `gks_stage_evidence_export` remains a
separate port-v3 contract; it is not a substitute for the eight
`gks_pipeline_*` contracts and post-publication query orchestration is not a
Stage 18.

## Stop and retry

Stop a foreground service with `Ctrl+C` after callers have stopped. For a
managed process, use its graceful stop operation and confirm the process has
exited before touching the data files. Keep the SQLite database, `-wal`, and
`-shm` files together as one recovery unit.

Retry a lost response with the identical request, idempotency key, and payload
hash. A matching persisted identity returns the original result. If processing
must be re-run, start a new FR071 materialized replay from the Tier-1 raw
entrypoint; that replay creates a new batch, decision, run, and stage-attempt
identity. A worker cannot mutate an existing immutable decision by changing
only `attemptId`, and it must never overwrite a terminal evidence row or
fabricate later stage success. Resume pending work by claiming it and pulling
evidence with its cursor. Denied embedding policy records the actual Stage 15
failure; denied publication or quality policy records terminal Stage 17 failure
evidence. Neither failure receives a publication receipt.

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
$mspRoot = 'C:\workspace\msp-ki17'
$env:MSP_REPO_ROOT = $mspRoot
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
| 0.2.2b | 2026-09-11 | beta | Node floor raised to `>=22` for `better-sqlite3` 13 (N-API); replaced the "rebuild against 24.18.x headers" step with the Node 24.19+ `ObjectWrap` abort it now avoids (nodejs/node#65446); named the CI workflow. | working-tree | Claude Opus 5 |
| 0.2.1b | 2026-09-08 | beta | Corrected graph receipt ownership and materialized replay semantics, added MSP-injected relay credential validation, and required `allowPublication: true` with the actual pointer/snapshot switch before publication. | 9279cfe | RWANG |
| 0.2.0b | 2026-09-08 | beta | Documented explicit clone/runtime/path grants, the nine GenesisRAG17-related tool contracts, physical Stage 13 to Stage 14 ordering, and retry/stop recovery rules. | 9279cfe | RWANG |
| 0.1.0b | 2026-08-12 | beta | Initial local start, health, evidence, failure, and recovery procedure. | working-tree | ATHER |
