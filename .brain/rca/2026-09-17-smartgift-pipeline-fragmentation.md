---
version: "0.1.0b"
created_at: "2026-09-17T02:40:48+07:00,RWANG,uncommitted"
last_update: "2026-09-17T02:40:48+07:00,RWANG"
status: "draft"
superseded_by: null
attributes:
  domain: "knowledge-integration"
  doc_type: "root-cause-analysis"
  scope: "Read-only source inspection of SmartGift catalog and pricing pipeline separation"
---

# SmartGift catalog and pricing pipeline separation

## Symptom

Product and price data are exposed through several prepared/public files and
separate business-vault and Edge ingestion paths. The user asks why these are
not managed through one data pipeline.

## Evidence

Inspected current local source on 2026-09-17; no ingestion, deployment, database
query, or production freshness verification was performed.

- `C:/Users/pc/workspace/business-01-smart-gift/run_pipeline.py` invokes
  `pipeline.master_orchestrator.run_master_pipeline`.
- That orchestrator invokes normalization, review enrichment, audit, public
  manifest generation and local vault sync, but not `export_pricelist_master.py`.
- `docs/DATA_PIPELINE_AND_VAULT_STRUCTURE.md:64-89` in the SmartGift repository
  explicitly documents the pricing exporter as a separate manual operation.
- `docs/decisions/ADR-002-PRICELIST-MASTER-SQL-SNAPSHOT.md:47-59` distinguishes
  the canonical catalog from the 427-model SQL source projection and prohibits
  merging their identity, price and BOM by name alone. A separate review-only
  projection preserves this unresolved identity boundary.
- `pipeline/export_pricelist_master.py:1467-1503` builds both the internal master
  and its public allowlisted projection. They share a generator, not independent
  price authority.
- `docs/decisions/ADR-004-CUSTOMER-SAFE-PRICELIST-ENDPOINT.md:24-45` explains the
  public/internal split and requires export, privacy checks and redeployment when
  the master changes. `api/_public_data.js:1` loads the public JSON snapshot.
- `pipeline/05_sync_edge_vaults.py:15` uses `smartgift_catalog_master.json`.
- `C:/Users/pc/workspace/zuri-ai/apps/edge/src/rag/v4/paths.ts` separately resolves
  an upstream `pricelist_master.json`, a FlowAccount source, and a generated
  `genesis_smartgift_store_v4` store. Configuration does not prove a live run.

## Root Cause

The inspected SmartGift entrypoint does not orchestrate the pricing export
dependency. Catalog/vault preparation, pricing export/publication, and Edge v4
ingestion have separate entrypoints and outputs. Running the named master
pipeline therefore does not itself rebuild and publish all product/price views.
The internal/public file split is an intentional access boundary, not itself a
defect; the missing shared execution chain is the integration gap. A second
intentional boundary separates supplier-source projections from canonical
products pending reviewed identity mapping; orchestration must not bypass it.

## Why the issue escaped detection

The top-level command describes itself as unified/end-to-end while its documented
scope excludes the pricing exporter. Git merge/cleanliness checks measure pending
changes, not business-data lineage or freshness. The earlier branch audit therefore
did not establish that the catalog-to-RAG integration is complete. No historical
claim about test execution or production incidents is made here.

## Proposed prevention

Propose a cross-repository specification for one governed execution chain with
explicit dependencies and shared source/run identity. Retain separate internal,
public and retrieval projections; require downstream outputs to identify their
source version and verify their consistency before publication. Preserve approved
price authority, human review gates, MSP/GKS boundaries and Tier-4 receipt gates.
This is a proposal only; no implementation or production activation is authorized
by this RCA. Exact orchestration ownership and migration require architecture review.

## Version diff / CHANGELOG

New document -> `0.1.0b`: records source-backed orchestration gap and evidence limits.

| Version | Date | Status | Summary | Commit Hash | Agent |
|---------|------|--------|---------|-------------|-------|
| 0.1.0b | 2026-09-17 | draft | Initial static RCA; no code or data changes | uncommitted | RWANG |
