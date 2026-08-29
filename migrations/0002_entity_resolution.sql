-- Stage 9 (DPS-KI-ENTITY-RESOLVE) schema split.
-- ADR-GKS-ENTITY-RESOLUTION.md (0.3.0b, accepted):
--   D1          entity_mentions is per-occurrence, with six discrete scope
--               columns (the opaque scope_key can express equality and
--               nothing else; the pool predicate and the review listing are
--               SQL over individual dimensions).
--   D2 / dec 5  entities gains norm_key + norm_version under
--               UNIQUE(scope_key, norm_key); concurrent creation is closed
--               by the constraint, not by adapter convention.
--   dec 4       migrate in place, backfill one CREATED mention per existing
--               entity, never rewrite a canonical ref.
--   dec 7       MATCHED writes are additive: aliases and external refs
--               accumulate on the entity (aliases_json / external_refs_json),
--               and a conflicting non-empty field diff is recorded on the
--               mention (field_diffs_json), never written to the entity.
--
-- This migration is completed by a paired JS hook in the migration runner
-- (packages/gks-persistence), inside the SAME transaction: SQL cannot call
-- the frozen norm_v1 module, so the hook copies entities into the rebuilt
-- table with their computed norm keys, backfills the mentions, then drops
-- the old table and renames the new one into place. entities loses
-- UNIQUE(scope_key, candidate_ref) there — the mention string is no longer
-- the identity — and SQLite cannot drop a table-level UNIQUE in place,
-- which is why this is a rebuild and not an ALTER.

CREATE TABLE entity_mentions (
  mention_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  norm_key TEXT NOT NULL,
  provenance_ref TEXT NOT NULL,
  promotion_idempotency_key TEXT NOT NULL,
  canonical_ref TEXT,
  outcome TEXT NOT NULL,
  strategy TEXT NOT NULL,
  confidence REAL,
  decided_at TEXT NOT NULL,
  field_diffs_json TEXT,
  UNIQUE (scope_key, promotion_idempotency_key, candidate_ref)
);

-- canonical_ref is NULLABLE by design: an unresolved mention
-- (REVIEW_REQUIRED / AMBIGUOUS / REJECTED) is a real state, not a missing
-- value (D3). field_diffs_json is decision 7's record of a conflicting
-- non-empty field the additive write refused to overwrite; D9's review tool
-- surfaces it as a proposed edit.

CREATE INDEX idx_mentions_review ON entity_mentions (portfolio_id, tenant_id, outcome);
CREATE INDEX idx_mentions_canonical ON entity_mentions (canonical_ref);
CREATE INDEX idx_mentions_norm ON entity_mentions (scope_key, norm_key);

-- The rebuilt entities table, in its final shape. norm_key is NOT NULL:
-- SQLite treats NULLs as distinct under UNIQUE, so a nullable norm_key
-- would let a writer bug recreate unlimited silent duplicates — the exact
-- defect class Stage 9 removes. The hook fills it during the copy.
CREATE TABLE entities_stage9 (
  canonical_ref TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_ref TEXT,
  confidence REAL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  external_refs_json TEXT NOT NULL DEFAULT '[]',
  norm_key TEXT NOT NULL,
  norm_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  UNIQUE (scope_key, norm_key)
);
