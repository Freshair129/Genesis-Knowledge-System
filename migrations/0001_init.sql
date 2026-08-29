CREATE TABLE graph_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL
);

INSERT INTO graph_state (singleton, version) VALUES (1, 0);

CREATE TABLE promotions (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  knowledge_ref TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provenance_ref TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  canonical_mappings_json TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE TABLE entities (
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  UNIQUE (scope_key, candidate_ref)
);

CREATE INDEX idx_entities_search ON entities (portfolio_id, type, title, canonical_ref);

CREATE TABLE relations (
  canonical_ref TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  confidence REAL,
  evidence_ref TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  UNIQUE (scope_key, from_ref, relation_type, to_ref)
);

CREATE INDEX idx_relations_from ON relations (portfolio_id, from_ref);
CREATE INDEX idx_relations_to ON relations (portfolio_id, to_ref);

CREATE TABLE artifact_links (
  canonical_ref TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  knowledge_ref TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sharing TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_key, knowledge_ref, artifact_ref, relation_type)
);
