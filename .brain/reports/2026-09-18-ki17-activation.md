---
version: "1.0.0"
created_at: "2026-09-18T02:00:00+07:00"
last_update: "2026-09-18T02:00:00+07:00"
status: "active"
superseded_by: null
attributes:
  domain: "genesisrag17"
  doc_type: "deployment-evidence"
  scope: "production-runtime"
---

# GenesisRAG17 production activation evidence

## Approved scope

Knowledge activation is enabled for the SmartGift business only:

- portfolio: `5c621811-7e7a-42dd-ac39-ea9e8416ba98`
- tenant: `77cdbe70-3111-4a04-922a-8059be99a8b0`
- business: `834fa869-62f3-431c-a287-e9a95e91175b`
- workspace: `c49de37b-3d88-44c8-8d60-8a4e88b45973`
- agent: empty
- visibility: `private`
- policy: `allowEmbedding=true`, `allowPublication=true`

LINE Phase 4 cutover and thread-memory activation were not included. The
thread-memory variables are unset.

## Candidate and pins

- zuri web candidate: `0c7fd88418b8be40a78f1fb8bc743b34c5a52c39`
- MSP: `49fe7de7d5603a4a75b279bcd72b16619fdc0046`
- GKS: `ecf1e4de269e949406a6a5f791f9ff8fe30c9578`
- GenesisBlock: `7c9261c4a4d4193af4e2613db48896533eb28072`

Images used by the live stack:

- `zuri-ai-web:release-ki17-0c7fd884`, digest `sha256:2a042eb9bd0749b735cdfdf3e74e580ab8cd0c378bcc0cc524d3d2ae543d3991`
- `zuri-ai-genesis-worker:release-ki17-0c7fd884`, digest `sha256:eb0f2a86c8324fe0eed92de7946682839870c970bd601d4c3f96402515c3833e`

The exact pin receipt is present in the worker image. The multilingual-e5-small
model volume was populated and host/volume hashes matched for its required
artifacts.

## Verification

- GenesisRAG17 acceptance: `36/36` tests passed, `0` failed, `0` skipped.
- Web container: healthy.
- Genesis worker: healthy, restart count `0`, loopback endpoint `127.0.0.1:19417`.
- Line worker: running on the same approved web image.
- P-5 read-only relay smoke: both checks passed (`empty_page` and typed
  `pipeline_worker_query_failed`).
- Production migration/read-only schema evidence: required Knowledge,
  GenesisRAG17, inventory, and pricing tables exist; migration ledger and RLS
  checks were already verified during the rollout.

## Current production data state

Read-only counts for the exact SmartGift scope are all zero:

`FileAsset`, `ProductMaster`, `Product`, `InventoryCatalogIntake`,
`PricingRuleSet`, `PricingCalculation`, `KnowledgeCorpus`,
`KnowledgeIngestion`, `GenesisRag17Batch`, and
`GenesisRag17PublicationReceipt`.

Therefore no production 17-stage run or publication receipt exists yet. The
public source file at `business-01-smart-gift/public/data/pricelist_public.json`
is an identified candidate source, but it has not been admitted into production.
Admission still requires the governed authenticated catalog/pricing path and
active production inventory and pricing records.

## Backup and rollback limitation

The requested full and scoped data-backup attempts were stopped by automatic
approval review because they would copy potentially sensitive production data
to temporary storage. No production data was written by the rollout, the
SmartGift scope was empty, and the database changes are additive. Strict G-6
backup evidence remains unavailable and is a release limitation.

Rollback is configuration/image based: disable the SmartGift Knowledge flag and
binding, stop the Genesis worker, and restore the prior web image. The state,
model, and Genesis store volumes must be preserved; do not use `down -v`.

## Incident and recovery

During activation, a concurrent Compose invocation replaced the web container
with an older image and removed the worker's shared network namespace. Restoring
the approved project configuration exposed a stale worker lock whose PID `1`
was reused by the replacement container. After the worker was stopped and only
the proven stale `genesisrag17/worker.lock` was removed, the worker restarted
healthy and remained stable. The detailed RCA is recorded in
`.brain/rca/2026-09-18-ki17-compose-race-and-stale-lock.md`.

## Changelog

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 1.0.0 | 2026-09-18 | active | Production runtime activation evidence for SmartGift scope | pending | RWANG |
