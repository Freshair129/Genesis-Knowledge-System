-- @req GKS-GOV-002, GKS-RET-002 (legacy-read half) — unpublished GenesisRAG17
-- entities are invisible to legacy reads.
-- @spec docs/ADR-GKS-PIPELINE-VISIBILITY.md (D1, D2)
-- @tested tests/contract/pipeline-genesisrag17.test.mjs, tests/security/cross-tenant-deny.security.mjs
--
-- entities.origin records which path created the row. Only the pipeline
-- submit writer sets 'pipeline'; no request field, metadata key or norm key
-- can reach it. Legacy rows keep the default.
ALTER TABLE entities ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK (origin IN ('legacy', 'pipeline'));

-- Backfill (D2): a row is pipeline-origin when a GenesisRAG17 run recorded it
-- as a decision entity AND the legacy path never created it. Every legacy
-- creation, including 0002's backfill of pre-Stage-9 rows, wrote a CREATED
-- mention, so a legacy entity that a pipeline run later reused stays legacy.
UPDATE entities
SET origin = 'pipeline'
WHERE EXISTS (SELECT 1 FROM pipeline_mentions m WHERE m.entity_id = entities.canonical_ref)
  AND NOT EXISTS (
    SELECT 1 FROM entity_mentions em
    WHERE em.canonical_ref = entities.canonical_ref AND em.outcome = 'CREATED'
  );

-- The visibility check looks mentions up by entity, across scopes.
CREATE INDEX idx_pipeline_mentions_entity_ref ON pipeline_mentions (entity_id, scope_key, batch_id);
