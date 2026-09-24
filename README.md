---
version: "0.5.0b"
created_at: "2026-08-12T10:29:29+07:00,ATHER,working-tree"
last_update: "2026-09-24T10:06:32+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "genesis-knowledge-system"
  doc_type: "repository-readme"
  scope: "standalone-repository"
---

# Genesis Knowledge System (GKS)

Standalone local-first Knowledge Graph Service for canonical knowledge
identity, relations, deduplication, graph revision, scoped retrieval, and
artifact linking.

GKS is a separate system from both GoVibe and GenesisBlockDB. The governed
runtime path is:

```text
Zuri / GoVibe -> MSP -> GKS
```

Zuri and GoVibe call MSP. MSP is the sole caller of GKS in this path.

## Knowledge Graph Service boundary

GKS is the logical authority for canonical entities and relations, resolution,
deduplication, graph revisions, candidate-to-canonical mappings, and
scope-aware knowledge queries. Its core service contract is exposed through
the stdio compatibility adapter and the private HTTP adapter.

GKS is not a physical graph/vector database engine, a conversational-memory
store, or the owner of MSP session context, policy, approval, or promotion
receipts. GenesisBlockDB remains a separate product. MSP remains the only
governed caller for promotion, review, pipeline and receipts. An explicitly
granted direct read-only client profile is implemented in the private HTTP
adapter when a valid grants file is configured, as specified in
[`ADR-GKS-CLIENT-ACCESS.md`](docs/ADR-GKS-CLIENT-ACCESS.md). No grants or
production access are enabled by default. This does not make GKS a broader
cross-system Semantic Layer or replace MSP's governance features.

## Workspace

- `apps/gks-server` — NDJSON JSON-RPC stdio and private HTTP JSON-RPC service.
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

Evidence refresh (2026-09-20): with `MSP_REPO_ROOT` set to the clean
`Memory-and-Soul-Passport` checkout at branch `codex/ki17-integration`, commit
`7778cfd594dfa8da0e9c86cc73745c1970c88dca`, `npm run test:integration`
executed 5 files and 8 tests with zero skips. The same MSP checkout passed its
full local acceptance under the documented Node `v24.18.0` runtime: 24 Vitest
files / 186 tests, 45 security tests, and `npm audit` with zero vulnerabilities.
This is local cross-repository evidence only; it does not establish production
deployment, runtime activation, or Zuri cutover readiness.

Toolchain: GKS declares Node `>=22`. `.github/workflows/test.yml` runs
independent contract, integration, security, unit, and client-pack slices in
parallel on Node 22 and 24 for every pull request and push to `main`, with an
aggregate required status. The workflow does not set `MSP_REPO_ROOT` or use
secrets. The MSP acceptance profile is separate and uses its explicit Node
`v24.18.x` runtime plus a native binding rebuilt against matching headers; see
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
`rule_v1` facts, maps them under `ontology_v2`, and records explicit temporal
states. The Stage 17 gate accepts decisions stored under either `ontology_v1`
or `ontology_v2`, each checked against its own version's endpoint table.

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
| 0.5.0b | 2026-09-24 | beta | Implements optional hash-backed, scoped direct read-only clients over private HTTP; no default grants or production activation. | working-tree | RWANG |
| 0.4.0b | 2026-09-24 | beta | Records the approved direct read-only client profile while keeping MSP as the governed write/pipeline/receipt path; direct auth is not yet implemented. | working-tree | RWANG |
| 0.3.0b | 2026-09-24 | beta | Defines GKS as the Knowledge Graph Service while preserving MSP-only governed ingress and separating GKS from a physical graph database or broader Semantic Layer. | working-tree | RWANG |
| 0.2.8b | 2026-09-20 | beta | Reconciled MSP evidence to commit 7778cfd and recorded the pinned Node 24.18 native-runtime gate plus full local MSP acceptance; production and Zuri cutover evidence remain open. | working-tree | RWANG |
| 0.2.7b | 2026-09-20 | beta | Recorded real MSP provider/service-chain integration evidence: 5 files and 8 tests passed with zero skips against Memory-and-Soul-Passport commit 6c34b8b6; production and Zuri cutover evidence remain open. | working-tree | RWANG |
| 0.2.6b | 2026-09-19 | beta | CI now runs contract, integration, security, unit, and client-pack validation as independent Node 22/24 matrix lanes with an aggregate required status; local and production evidence boundaries remain unchanged. | working-tree | RWANG |
| 0.2.5b | 2026-09-11 | beta | GenesisRAG17 section: Stage 11 now produces `ontology_v2` and the gate accepts `{ontology_v1, ontology_v2}` (ADR-075 Phase 2, contract revision 2). | working-tree | Claude Opus 5 |
| 0.2.4b | 2026-09-11 | beta | Toolchain note: Node `>=22` for `better-sqlite3` 13 (N-API), the CI workflow, and why 11.x/12.x must not return on Node 24.19+ (nodejs/node#65446). Numbered 0.2.4b because open PR #7 takes 0.2.3b. | working-tree | Claude Opus 5 |
| 0.2.1b | 2026-09-08 | beta | Aligned the local verification/start examples with the Node 24.18.x acceptance profile, explicit parameterized roots, and MSP-injected relay credential setup. | 9279cfe | RWANG |
| 0.2.0b | 2026-09-08 | beta | Documented the authenticated GenesisRAG17 stage 9–14/17 surface, nine related tool contracts, immutable receipt order, and extension boundary. | 9279cfe | RWANG |
| 0.1.1b | 2026-09-07 | beta | `gks_stage_evidence_export` (port version 3, migration 0005): Stage 9 evidence rows on every promotion and human decision, backfilled for every earlier execution, exported by cursor for zuri-ai's pull through MSP. | working-tree | Claude Fable 5.1 |
| 0.1.0b | 2026-08-12 | beta | Initial standalone GKS repository implementation. | working-tree | ATHER |

## Reference version diff — 2026-09-08

"0.2.1b → 0.2.2b: follow zuri's pre-merge ADR-071 → ADR-073 collision repair because published main owns ADR-071 for CRM. Historical revision rows and pinned acceptance reports retain their original identifiers. Protocol and runtime behavior are unchanged.
