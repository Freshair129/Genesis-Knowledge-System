-- @req FR-109, FR-110 — persist immutable GenesisRAG17 batch, receipt and evidence state.
-- @spec ADR-GKS-GENESISRAG17.md, docs/plans/GENESISRAG17-CONTRACT.md
-- @tested tests/contract/pipeline-genesisrag17.test.mjs, tests/contract/stage9-migration.test.mjs
-- GenesisRAG17 durable pipeline state. This migration is additive and keeps
-- the legacy stage_evidence export untouched. Payloads are immutable JSON
-- snapshots; mutable status columns only describe lifecycle/replay state.

ALTER TABLE graph_state ADD COLUMN pipeline_evidence_cursor INTEGER NOT NULL DEFAULT 0;

CREATE TABLE pipeline_batches (
  batch_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  batch_hash TEXT NOT NULL,
  batch_json TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, idempotency_key)
);

CREATE INDEX idx_pipeline_batches_pending ON pipeline_batches (scope_key, status, created_at);
CREATE INDEX idx_pipeline_batches_run ON pipeline_batches (scope_key, run_id);

CREATE TABLE pipeline_mentions (
  scope_key TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_mention_id TEXT NOT NULL,
  resolution_key TEXT NOT NULL,
  semantic_type TEXT NOT NULL,
  name TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, batch_id, source_mention_id)
);

CREATE INDEX idx_pipeline_mentions_entity ON pipeline_mentions (scope_key, entity_id);

CREATE TABLE pipeline_receipts (
  scope_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, decision_id)
);

-- Stage 13 is acknowledged before the worker begins enrichment, embedding, or
-- indexing.  The derived payload is stored beside that acknowledgement so a
-- replay cannot regenerate a different Stage 14 result or duplicate evidence.
CREATE TABLE pipeline_graph_receipts (
  scope_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  graph_receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  derived_json TEXT NOT NULL,
  derived_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, decision_id)
);

CREATE TABLE pipeline_gates (
  scope_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  receipt_hash TEXT,
  verdict_hash TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, decision_id)
);

CREATE TABLE pipeline_publication_receipts (
  scope_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  publication_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, decision_id, snapshot_id, generation)
);

CREATE TABLE pipeline_evidence (
  cursor INTEGER PRIMARY KEY,
  schema_version TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pipeline_stage_id TEXT NOT NULL,
  execution_step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  stage_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_key, run_id, pipeline_stage_id, execution_step_id, attempt_id)
);

CREATE INDEX idx_pipeline_evidence_scope_cursor ON pipeline_evidence (scope_key, cursor);
CREATE INDEX idx_pipeline_evidence_run ON pipeline_evidence (scope_key, run_id, cursor);
