-- Stage 9 (DPS-KI-ENTITY-RESOLVE), ADR-GKS-ENTITY-RESOLUTION D9 / D10.2:
-- the unresolved-mention consumer's write surface.
--
-- entities.superseded_by records a D9 merge's supersession on the losing
-- entity: the row is never deleted and its canonical ref is never rewritten
-- (decision 4) -- the column is the one sanctioned way an entity stops being
-- a live identity. The resolution pool excludes superseded rows, so a
-- repaired over-split can never be matched, or reported AMBIGUOUS, against
-- its own ghost.
--
-- human_resolutions is the audit trail of the D9 write itself: one row per
-- human decision (BIND or MERGE), carrying its own provenance ref, separate
-- from the mention's original promotion provenance. Rows are never deleted.
--
-- pending_relations.materialized_ref records which canonical relation a
-- pending row became when its endpoint resolved (D10 consequence 1) -- the
-- join from "held" to "materialized" stays auditable in both directions.

ALTER TABLE entities ADD COLUMN superseded_by TEXT;
CREATE INDEX idx_entities_superseded ON entities (superseded_by);

ALTER TABLE pending_relations ADD COLUMN materialized_ref TEXT;

CREATE TABLE human_resolutions (
  decision_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  mention_id TEXT,
  canonical_ref TEXT NOT NULL,
  superseded_ref TEXT,
  provenance_ref TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_human_resolutions_scope ON human_resolutions (portfolio_id, tenant_id, created_at);
