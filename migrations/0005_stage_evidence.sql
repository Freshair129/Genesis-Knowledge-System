-- ADR-GKS-LEDGER-REPORTING (0.2.0b, accepted 2026-08-31) D2 / D4 and
-- GKS-PORT-CONTRACT port version 3: the evidence table every owned stage
-- reports through, read by gks_stage_evidence_export as a cursor pull.
--
-- One row per stage EXECUTION. Rows are append-only and immutable once
-- written -- never edited, never deleted -- which is what makes any earlier
-- cursor safe to re-read at any later time. evidence_json is always an
-- object ({} when the stage has no execution-level catalog fields beyond the
-- metrics); records_json is always an array ([] for every stage whose
-- catalog evidence is execution-level; populated for Stages 10, 12, 13 only).
-- metrics_json carries NFR-020's six metrics, every one present, zero not
-- absent.
--
-- cursor is assigned at COMMIT time from graph_state.evidence_cursor inside
-- the same transaction that writes the row, so a puller that has advanced
-- past cursor N can never permanently skip a row that commits later with a
-- lower cursor: a row that has not committed yet has no cursor yet. A rolled
-- back transaction rolls the counter back with it, so there are no holes for
-- a puller to wait on.
--
-- run_id is the zuri-ai pipeline_job_id the execution belonged to, when the
-- caller named one (gks_knowledge_promote carries run_id; a D9 human decision
-- names none and records NULL -- it is not a pipeline run). scope columns
-- are discrete so the export's scope predicate runs in SQL, never in the
-- caller (port contract v3 behavioural requirement).
--
-- The migration hook (packages/gks-persistence, MIGRATION_HOOKS) backfills
-- one row per existing promotion and one per existing human resolution --
-- the Stage 9 evidence that, until this table existed, rode canonical_mappings
-- (ladder strategies) or entity_mentions only (HUMAN, BACKFILL): the ledger
-- ADR's own Task 1 finding, closed here.

ALTER TABLE graph_state ADD COLUMN evidence_cursor INTEGER NOT NULL DEFAULT 0;

CREATE TABLE stage_evidence (
  evidence_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  pipeline_stage_id TEXT NOT NULL,
  pipeline_definition_id TEXT NOT NULL,
  execution_contract_id TEXT NOT NULL,
  run_id TEXT,
  provenance_ref TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  records_json TEXT NOT NULL,
  produced_at TEXT NOT NULL
);

CREATE INDEX idx_stage_evidence_scope_cursor ON stage_evidence (portfolio_id, tenant_id, cursor);
CREATE INDEX idx_stage_evidence_run ON stage_evidence (run_id);
