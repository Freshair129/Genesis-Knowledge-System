-- ADR-GKS-GOVERNED-CALLERS D6: every governed write records the authenticated
-- caller next to the provenance reference the caller supplied, so "who wrote
-- this" never rests on a string the writer chose.
--
-- Additive. Every row written before this migration came through MSP -- the
-- only governed caller that existed -- so the DEFAULT backfills them as
-- msp-runtime. New rows are written with an explicit caller_id by the service.
ALTER TABLE promotions ADD COLUMN caller_id TEXT NOT NULL DEFAULT 'msp-runtime';
ALTER TABLE stage_evidence ADD COLUMN caller_id TEXT NOT NULL DEFAULT 'msp-runtime';
ALTER TABLE human_resolutions ADD COLUMN caller_id TEXT NOT NULL DEFAULT 'msp-runtime';
ALTER TABLE artifact_links ADD COLUMN caller_id TEXT NOT NULL DEFAULT 'msp-runtime';
