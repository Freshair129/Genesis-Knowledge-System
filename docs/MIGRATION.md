---
version: "0.3.1b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-08T00:30:00+07:00,RWANG"
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
$gksRoot = 'C:\workspace\gks-ki17'
$mspRoot = 'C:\workspace\msp-ki17'
$dbPath = 'C:\workspace\gks-ki17-data\gks.sqlite'
$entrypoint = Join-Path $gksRoot 'apps/gks-server/bin/gks-server.mjs'
$env:MSP_GKS_COMMAND = (Get-Command node).Source
$env:MSP_GKS_ARGS = ConvertTo-Json -InputObject @($entrypoint) -Compress
$env:MSP_GKS_CWD = $gksRoot
$env:GKS_DB_PATH = $dbPath
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
if ([string]::IsNullOrWhiteSpace($env:GKS_PIPELINE_RELAY_CREDENTIAL)) {
  throw 'MSP must inject GKS_PIPELINE_RELAY_CREDENTIAL out of band'
}
```

The GKS child inherits `GKS_*` variables from MSP. GoVibe and Zuri receive no
GKS command, database path, or credentials.

## Compatibility proof

```powershell
$env:MSP_REPO_ROOT = $mspRoot
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

The migration adds `pipeline_batches`, `pipeline_mentions`,
`pipeline_graph_receipts`, `pipeline_receipts`, `pipeline_gates`,
`pipeline_publication_receipts`, and `pipeline_evidence`, plus the
`graph_state.pipeline_evidence_cursor` counter. JSON payloads are immutable;
the batch `status` is lifecycle bookkeeping for resumable claims and terminal
outcomes. The tables contain all six pipeline scope fields and never store the
relay credential or authenticated principal.

The batch and decision rows are immutable by scope and idempotency key. A
transport retry reuses the same key and payload; a processing retry starts a
new FR071 materialized replay from the Tier-1 raw entrypoint and receives new
batch, decision, run and stage-attempt identities. Graph receipt replay returns
the stored Stage 13/14 result, while final receipt replay returns its original
hash even after publication. A failed Tier-4 stage leaves later stages without
success evidence; a failed Stage 17 gate records terminal failure evidence
without a publication receipt. Applying 0006 is therefore safe only through
the existing single-writer SQLite migration runner, before enabling the MSP
relay.

## GenesisRAG17 migration sequence

1. Stop the MSP worker that would claim the target scope and make a recovery
   copy of the selected database unit (`.sqlite`, `-wal`, and `-shm` together).
2. Set `GKS_DB_PATH` to the explicit absolute database path and run the normal
   GKS startup once. The startup migration runner applies 0006 in order and
   fails closed on an invalid path or schema error.
3. Run `gks_health` and inspect the migration/version result before enabling
   the relay. Do not create an empty replacement database and call it a
   migration.
4. Start the MSP relay with the same database path and the out-of-band relay
   credential. Submit/claim a known test batch, then verify cursor evidence
   and receipt hashes before allowing production traffic.

Migration 0006 is additive and does not backfill or rewrite the legacy
`stage_evidence` ledger. A rollback stops callers and restores the complete
SQLite recovery unit; it does not delete pipeline rows or downgrade the schema
in place. A future schema change gets a new migration and must preserve the
legacy port-v3 reader and all existing GenesisRAG17 hashes.

## Rollback

Unset `MSP_GKS_COMMAND` to return MSP to named fail-closed behavior, or repoint
it to the previously verified provider. Never fall back to an in-memory or
GoVibe-local canonical store. Do not delete the GKS SQLite file during rollback.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.3.1b | 2026-09-08 | beta | Clarified parameterized MSP/GKS roots, PowerShell JSON argument construction, out-of-band relay credential setup, and materialized replay identity for migration 0006. | 9279cfe | RWANG |
| 0.3.0b | 2026-09-08 | beta | Added the exact migration 0006 table/cursor inventory, single-writer apply order, status/replay semantics, and recovery boundary for GenesisRAG17. | 9279cfe | RWANG |
| 0.2.0b | 2026-09-07 | beta | Added the GenesisRAG17 migration 0006 schema, immutable attempt/replay rules, receipt ordering and non-destructive rollback guidance. | working-tree | RWANG |
| 0.1.0b | 2026-08-12 | beta | Initial MSP-to-standalone-GKS cutover and rollback guide. | working-tree | ATHER |
