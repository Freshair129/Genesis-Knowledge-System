---
version: "0.2.4b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-11T12:30:00+07:00,Claude Opus 5"
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
- `tests` — contract, security, integration, restart, and external MSP proof,
  including the GenesisRAG17 stage and receipt chain.

## Local verification

```powershell
$gksRoot = 'C:\workspace\gks-ki17'
$mspRoot = 'C:\workspace\msp-ki17'
Set-Location $gksRoot
node --version  # GenesisRAG17 acceptance profile: 24.18.x
npm ci
npm test
$env:MSP_REPO_ROOT = $mspRoot
npm run test:integration
npm run pack:client
```

The external MSP tests skip when `MSP_REPO_ROOT` is absent. They run against
the actual MSP provider and MSP service when the variable is present.

Toolchain: Node `>=22` (the floor of `better-sqlite3` 13, which runs on N-API
and ships its prebuilt binaries, so nothing is rebuilt against local Node
headers). `.github/workflows/test.yml` runs `npm ci` and `npm test` on Node 22
and 24 for every pull request and push to `main`, without `MSP_REPO_ROOT` and
without secrets. Do not pin `better-sqlite3` back to 11.x/12.x: a copy compiled
against Node 24.19+ headers aborts on garbage collection
([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)); see
[`docs/RUNBOOK-GKS-LOCAL.md`](docs/RUNBOOK-GKS-LOCAL.md#preflight).

## Start

GKS never chooses an implicit canonical database path. Use the same explicit
path for the service and the MSP launch configuration:

```powershell
$dbPath = 'C:\workspace\gks-ki17-data\gks.sqlite'
$env:GKS_DB_PATH = $dbPath
$env:GKS_DEFAULT_PORTFOLIO_ID = 'portfolio-local'
if ([string]::IsNullOrWhiteSpace($env:GKS_PIPELINE_RELAY_CREDENTIAL)) {
  throw 'MSP must inject GKS_PIPELINE_RELAY_CREDENTIAL out of band before start'
}
npm start
```

`GKS_DEFAULT_PORTFOLIO_ID` exists only for API-010 compatibility calls that do
not yet carry the approved scope envelope. New search/entity/relation/link and
GenesisRAG17 calls must carry scope explicitly. Pipeline calls also require
the MSP-injected `GKS_PIPELINE_RELAY_CREDENTIAL`; the value is never committed
or printed by this repository.

## Public tools

- `gks_health`
- `gks_knowledge_promote`
- `gks_search`
- `gks_entity_get`
- `gks_relations_get`
- `gks_artifact_link`
- `gks_review_list`
- `gks_review_apply`
- `gks_stage_evidence_export` — read-only, scope-enveloped, cursor-paginated
  Tier-3 stage evidence (`docs/ADR-GKS-LEDGER-REPORTING.md`, port version 3);
  relayed by MSP as `msp_knowledge_evidence_export` and pulled by zuri-ai.
- `gks_pipeline_submit`
- `gks_pipeline_claim`
- `gks_pipeline_graph_receipt`
- `gks_pipeline_stage_failure`
- `gks_pipeline_write_receipt`
- `gks_pipeline_gate`
- `gks_pipeline_publication_receipt`
- `gks_pipeline_evidence`

The eight `gks_pipeline_*` tools implement the authenticated
`genesisrag17.v1` surface. Together with the legacy `gks_stage_evidence_export`
compatibility reader, these are the nine GenesisRAG17-related tool contracts;
the legacy reader and its port-v3 ledger remain separate from the immutable
pipeline ledger. See [`docs/GKS-PORT-CONTRACT.md`](docs/GKS-PORT-CONTRACT.md)
for request and result shapes, and [`docs/GKS-INTEGRATION-FLOW.md`](docs/GKS-INTEGRATION-FLOW.md)
for the call and receipt order.

## GenesisRAG17 pipeline

GKS is the passive Tier-3 authority for stages 9–14 and 17. MSP is the sole
caller and forwards an authenticated `source` or `worker` principal whose
six-field private scope exactly matches the request. The pipeline accepts
inline source and chunk content, validates UTF-16 offsets and SHA-256 hashes,
preserves each `sourceMentionId`, resolves canonical entities, extracts
`rule_v1` facts, maps `ontology_v1`, and records explicit temporal states.

The immutable decision is persisted before Tier-4 execution. Stage 13 closes
only after a physical graph receipt; that receipt authorizes the actual
`enrich_v1` Stage 14 payload. A later receipt covers Tier-4 stages 15 and 16.
Stage 17 evaluates the five quality dimensions and closes successfully only
after a publication receipt. Query-time retrieval orchestration after Stage 17
is a consumer flow, not a new Stage 18.

The current isolated execution and publication decision is zuri-ai's [ADR-073 — GenesisRAG17 isolated execution and publication](https://github.com/Freshair129/zuri.ai/blob/codex/ki17-integration/docs/decisions/ADR-073-GENESISRAG17-ISOLATED-EXECUTION-AND-PUBLICATION.md).

## Status

Beta implementation. Standalone tests and MSP compatibility evidence are local
verification, not production deployment or Zuri cutover evidence.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.2.4b | 2026-09-11 | beta | Toolchain note: Node `>=22` for `better-sqlite3` 13 (N-API), the CI workflow, and why 11.x/12.x must not return on Node 24.19+ (nodejs/node#65446). Numbered 0.2.4b because open PR #7 takes 0.2.3b. | working-tree | Claude Opus 5 |
| 0.2.1b | 2026-09-08 | beta | Aligned the local verification/start examples with the Node 24.18.x acceptance profile, explicit parameterized roots, and MSP-injected relay credential setup. | 9279cfe | RWANG |
| 0.2.0b | 2026-09-08 | beta | Documented the authenticated GenesisRAG17 stage 9–14/17 surface, nine related tool contracts, immutable receipt order, and extension boundary. | 9279cfe | RWANG |
| 0.1.1b | 2026-09-07 | beta | `gks_stage_evidence_export` (port version 3, migration 0005): Stage 9 evidence rows on every promotion and human decision, backfilled for every earlier execution, exported by cursor for zuri-ai's pull through MSP. | working-tree | Claude Fable 5.1 |
| 0.1.0b | 2026-08-12 | beta | Initial standalone GKS repository implementation. | working-tree | ATHER |

## Reference version diff — 2026-09-08

"0.2.1b → 0.2.2b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.
