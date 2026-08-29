-- Stage 9 (DPS-KI-ENTITY-RESOLVE), ADR-GKS-ENTITY-RESOLUTION D10.1:
-- a relation whose endpoint resolved WITHOUT a canonical ref
-- (REVIEW_REQUIRED / AMBIGUOUS / REJECTED) is recorded as pending, never
-- thrown — the envelope's resolved entities still promote, and the relation
-- is held with its mention endpoints so it can materialize when the endpoint
-- resolves (a D9 bind; D10 consequence 1). Aborting the whole envelope
-- because one mention was ambiguous would make D3's safe refusal more
-- destructive than an unsafe merge.
--
-- The row keeps the CANDIDATE refs and both mention ids: a pending relation
-- has no canonical endpoints yet by definition, so its identity is the
-- occurrence (same uniqueness discipline as entity_mentions, D1) and its
-- payload is everything needed to mint the canonical relation later.
--
-- status is 'PENDING' until the D9 step materializes it ('MATERIALIZED') —
-- rows are never deleted; like entity_mentions they are the audit trail.

CREATE TABLE pending_relations (
  pending_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  from_candidate_ref TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  to_candidate_ref TEXT NOT NULL,
  from_mention_id TEXT NOT NULL,
  to_mention_id TEXT NOT NULL,
  confidence REAL,
  metadata_json TEXT NOT NULL,
  provenance_ref TEXT NOT NULL,
  promotion_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  UNIQUE (scope_key, promotion_idempotency_key, from_candidate_ref, relation_type, to_candidate_ref)
);

CREATE INDEX idx_pending_relations_status ON pending_relations (portfolio_id, tenant_id, status);
CREATE INDEX idx_pending_relations_mentions ON pending_relations (from_mention_id, to_mention_id);
