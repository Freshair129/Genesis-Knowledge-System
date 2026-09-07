// @req FR-109, FR-110 — durably store scoped GenesisRAG17 decisions, receipts and evidence.
// @spec ADR-GKS-GENESISRAG17.md, ADR-GKS-LEDGER-REPORTING.md, docs/plans/GENESISRAG17-CONTRACT.md
// @tested tests/contract/pipeline-genesisrag17.test.mjs, tests/contract/persistence-port-conformance.test.mjs

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GksBackendUnavailableError, GksConflictError, GksInvalidRequestError, GksNormKeyConflictError, GksScopeDeniedError } from "@freshair129/gks-contracts/errors";
import { NORM_VERSION, normKey } from "@freshair129/gks-contracts/norm-v1";
import { RESOLUTION_OUTCOMES, RESOLUTION_STRATEGIES, UNRESOLVED_OUTCOMES } from "@freshair129/gks-contracts/resolution";
import { ENTITY_RESOLVE_STAGE_ID, KNOWLEDGE_INGESTION_CONTRACT_ID, KNOWLEDGE_INGESTION_DEFINITION_ID, zeroMetrics } from "@freshair129/gks-contracts/stage-evidence";
import { PIPELINE_REQUIRED_METRICS, PIPELINE_SCHEMA_VERSION, canonicalJsonString, hashPipelineDecision, hashPipelinePublicationReceipt, hashPipelineReceipt, pipelineScopeKey, sha256Json } from "@freshair129/gks-contracts/pipeline";

const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function requireAbsolutePath(dbPath) {
  if (typeof dbPath !== "string" || !path.isAbsolute(dbPath)) throw new GksBackendUnavailableError("GKS_DB_PATH must be an absolute path.");
  return dbPath;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// The U+0000 join used by digest inputs below — the same byte the scope key
// and mention ids already join on.
const SEP = String.fromCharCode(0);

// Mention ids are a pure function of the row's own uniqueness triple
// (UNIQUE(scope_key, promotion_idempotency_key, candidate_ref), ADR D1), so
// one occurrence always mints one id, deterministically across restarts.
function mentionId(scopeKeyValue, idempotencyKey, candidateRef) {
  return `gks:mention/${digest(`${scopeKeyValue}\u0000${idempotencyKey}\u0000${candidateRef}`)}`;
}

// ---------------------------------------------------------------------------
// Migration 0002 backfill (ADR-GKS-ENTITY-RESOLUTION decision 4).
//
// The SQL half of 0002 creates entity_mentions and the rebuilt entities table
// (entities_stage9); SQL cannot call the frozen norm_v1 module, so this hook
// — running in the SAME transaction as the DDL — copies every entity across
// with its computed norm key, writes one CREATED mention per existing entity
// (strategy BACKFILL, confidence NULL, decided_at = the entity's created_at),
// then drops the old table and renames the rebuilt one into place. No
// canonical ref is rewritten, ever.
//
// Collisions are expected: pre-Stage-9 stores hold historical over-splits
// (four spellings of one company, four digest refs), and all of them must
// stay insertable under UNIQUE(scope_key, norm_key). The first row in a
// scope (by created_at, then canonical_ref) keeps the plain key; each later
// collider takes the human-distinct discriminator form from D2 —
// `norm_key + '#' + mention_id` — leaving it reachable only by the
// canonical-ref, external-ref and alias rungs until a D9 merge repairs it.
// ---------------------------------------------------------------------------
function backfillEntityResolution(db) {
  const before = db.prepare("SELECT COUNT(*) AS n FROM entities").get().n;
  // (scope_key, graph_version) identifies the promotion whose transaction
  // last wrote the entity — every entity write and its promotions row share
  // one transaction and one graph version, so the join is total; the
  // fallback marker is defensive only.
  const rows = db.prepare(`
    SELECT e.*, p.idempotency_key AS promotion_key, p.provenance_ref AS promotion_provenance
    FROM entities e
    LEFT JOIN promotions p ON p.scope_key = e.scope_key AND p.graph_version = e.graph_version
    ORDER BY e.scope_key, e.created_at, e.canonical_ref
  `).all();
  const copyEntity = db.prepare(`
    INSERT INTO entities_stage9 (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, aliases_json, external_refs_json, norm_key, norm_version, created_at, updated_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @candidate_ref, @type, @title, @summary, @source_ref, @confidence, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @metadata_json, '[]', '[]', @norm_key, @norm_version, @created_at, @updated_at, @graph_version)
  `);
  const insertBackfillMention = db.prepare(`
    INSERT INTO entity_mentions (mention_id, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, candidate_ref, norm_key, provenance_ref, promotion_idempotency_key, canonical_ref, outcome, strategy, confidence, decided_at, field_diffs_json)
    VALUES (@mention_id, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @candidate_ref, @norm_key, @provenance_ref, @promotion_idempotency_key, @canonical_ref, 'CREATED', 'BACKFILL', NULL, @decided_at, NULL)
  `);

  const taken = new Set();
  for (const row of rows) {
    const baseKey = normKey(row.candidate_ref);
    const promotionKey = row.promotion_key ?? "gks:backfill/0002";
    const id = mentionId(row.scope_key, promotionKey, row.candidate_ref);
    const scopedKey = `${row.scope_key}\u0000${baseKey}`;
    const assignedKey = taken.has(scopedKey) ? `${baseKey}#${id}` : baseKey;
    taken.add(scopedKey);
    copyEntity.run({
      canonical_ref: row.canonical_ref,
      scope_key: row.scope_key,
      candidate_ref: row.candidate_ref,
      type: row.type,
      title: row.title,
      summary: row.summary,
      source_ref: row.source_ref,
      confidence: row.confidence,
      portfolio_id: row.portfolio_id,
      tenant_id: row.tenant_id,
      business_id: row.business_id,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      sharing: row.sharing,
      metadata_json: row.metadata_json,
      norm_key: assignedKey,
      norm_version: NORM_VERSION,
      created_at: row.created_at,
      updated_at: row.updated_at,
      graph_version: row.graph_version,
    });
    insertBackfillMention.run({
      mention_id: id,
      scope_key: row.scope_key,
      portfolio_id: row.portfolio_id,
      tenant_id: row.tenant_id,
      business_id: row.business_id,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      sharing: row.sharing,
      candidate_ref: row.candidate_ref,
      norm_key: baseKey,
      provenance_ref: row.promotion_provenance ?? "gks:backfill/0002",
      promotion_idempotency_key: promotionKey,
      canonical_ref: row.canonical_ref,
      decided_at: row.created_at,
    });
  }

  db.exec(`
    DROP TABLE entities;
    ALTER TABLE entities_stage9 RENAME TO entities;
    CREATE INDEX idx_entities_search ON entities (portfolio_id, type, title, canonical_ref);
    CREATE INDEX idx_entities_pool ON entities (portfolio_id, tenant_id, business_id, workspace_id, project_id);
  `);

  const copied = db.prepare("SELECT COUNT(*) AS n FROM entities").get().n;
  const mentions = db.prepare("SELECT COUNT(*) AS n FROM entity_mentions").get().n;
  if (copied !== before || mentions !== before) {
    throw new GksBackendUnavailableError(`Migration 0002 backfill mismatch: ${before} entities, ${copied} copied, ${mentions} mentions.`);
  }
}

// ---------------------------------------------------------------------------
// Stage 9 evidence: what a promotion's canonical_mappings say about the
// execution, as NFR-020 metrics plus execution-level evidence. Used by the
// live write in transactPromotion and by migration 0005's backfill, so the
// two can never disagree about what a Stage 9 row means.
// ---------------------------------------------------------------------------
function countBy(values, vocabulary) {
  const counts = Object.fromEntries(vocabulary.map((name) => [name, 0]));
  for (const value of values) if (value in counts) counts[value] += 1;
  return counts;
}

function stage9Evidence(canonicalMappings, extra = {}) {
  const resolutions = canonicalMappings.map((mapping) => mapping.resolution ?? {});
  const outcomes = countBy(resolutions.map((resolution) => resolution.outcome), RESOLUTION_OUTCOMES);
  const strategies = countBy(resolutions.map((resolution) => resolution.strategy), RESOLUTION_STRATEGIES);
  return {
    evidence: { outcomes, strategies, ...extra },
    metrics: zeroMetrics({
      records_in: canonicalMappings.length,
      records_out: outcomes.MATCHED + outcomes.CREATED,
      records_failed: outcomes.REJECTED,
      records_quarantined: outcomes.REVIEW_REQUIRED + outcomes.AMBIGUOUS,
    }),
  };
}

function scopeFromKey(scopeKeyValue) {
  const [portfolioId, tenantId, businessId, workspaceId, projectId, sharing] = scopeKeyValue.split(SEP);
  return { portfolioId, tenantId, businessId, workspaceId, projectId, sharing };
}

// ---------------------------------------------------------------------------
// Migration 0005 backfill (ADR-GKS-LEDGER-REPORTING D2, Task 1 finding).
//
// Every promotion and every human resolution that happened before the
// stage_evidence table existed gets its Stage 9 row now, in the order it
// happened, with a cursor assigned in that order. A backfilled row has
// run_id NULL -- promotions never persisted run_id before this migration --
// which a puller sees as "evidence of an execution no ledger run of mine
// owns", not as a row to drop: it is exported, and attribution is the
// puller's to decide.
// ---------------------------------------------------------------------------
function backfillStageEvidence(db) {
  const insert = db.prepare(`
    INSERT INTO stage_evidence (evidence_id, cursor, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, pipeline_stage_id, pipeline_definition_id, execution_contract_id, run_id, provenance_ref, evidence_json, metrics_json, records_json, produced_at)
    VALUES (@evidence_id, @cursor, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @pipeline_stage_id, @pipeline_definition_id, @execution_contract_id, NULL, @provenance_ref, @evidence_json, @metrics_json, '[]', @produced_at)
  `);
  const promotions = db.prepare("SELECT * FROM promotions").all().map((row) => {
    const { evidence, metrics } = stage9Evidence(JSON.parse(row.canonical_mappings_json), {
      knowledge_ref: row.knowledge_ref,
      graph_version: row.graph_version,
      backfilled_from: "promotions",
    });
    return {
      evidence_id: `gks:evidence/${digest(["promotion", row.scope_key, row.idempotency_key].join(SEP))}`,
      scope_key: row.scope_key,
      provenance_ref: row.provenance_ref,
      produced_at: row.created_at,
      evidence,
      metrics,
    };
  });
  const decisions = db.prepare("SELECT * FROM human_resolutions").all().map((row) => ({
    evidence_id: `gks:evidence/${digest(["human", row.decision_id].join(SEP))}`,
    scope_key: row.scope_key,
    provenance_ref: row.provenance_ref,
    produced_at: row.created_at,
    evidence: {
      action: row.action,
      strategy: "HUMAN",
      outcome: "MATCHED",
      canonical_ref: row.canonical_ref,
      superseded_ref: row.superseded_ref,
      decision_id: row.decision_id,
      graph_version: row.graph_version,
      backfilled_from: "human_resolutions",
    },
    metrics: zeroMetrics({ records_in: 1, records_out: 1 }),
  }));
  const rows = [...promotions, ...decisions].sort((left, right) => left.produced_at.localeCompare(right.produced_at) || left.evidence_id.localeCompare(right.evidence_id));
  let cursor = 0;
  for (const row of rows) {
    cursor += 1;
    const scope = scopeFromKey(row.scope_key);
    insert.run({
      evidence_id: row.evidence_id,
      cursor,
      scope_key: row.scope_key,
      portfolio_id: scope.portfolioId,
      tenant_id: scope.tenantId,
      business_id: scope.businessId,
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      sharing: scope.sharing,
      pipeline_stage_id: ENTITY_RESOLVE_STAGE_ID,
      pipeline_definition_id: KNOWLEDGE_INGESTION_DEFINITION_ID,
      execution_contract_id: KNOWLEDGE_INGESTION_CONTRACT_ID,
      provenance_ref: row.provenance_ref,
      evidence_json: JSON.stringify(row.evidence),
      metrics_json: JSON.stringify(row.metrics),
      produced_at: row.produced_at,
    });
  }
  db.prepare("UPDATE graph_state SET evidence_cursor = ? WHERE singleton = 1").run(cursor);
  const written = db.prepare("SELECT COUNT(*) AS n FROM stage_evidence").get().n;
  if (written !== rows.length) {
    throw new GksBackendUnavailableError(`Migration 0005 backfill mismatch: ${rows.length} executions, ${written} evidence rows.`);
  }
}

// Data movement that a plain .sql file cannot express (it needs the frozen
// norm_v1 module) runs here, keyed by migration file name, inside the same
// transaction that applies the file and records it as applied.
const MIGRATION_HOOKS = {
  "0002_entity_resolution.sql": backfillEntityResolution,
  "0005_stage_evidence.sql": backfillStageEvidence,
};

function runMigrations(db, migrationsDir) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name);
  const appliedSet = new Set(applied);
  const apply = db.transaction((name, sql) => {
    db.exec(sql);
    MIGRATION_HOOKS[name]?.(db);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
  });
  for (const name of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    if (!appliedSet.has(name)) apply(name, readFileSync(path.join(migrationsDir, name), "utf8"));
  }
}

function rowScope(row) {
  return {
    portfolioId: row.portfolio_id,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sharing: row.sharing,
  };
}

function entityFromRow(row) {
  if (!row) return null;
  return {
    canonicalRef: row.canonical_ref,
    candidateRef: row.candidate_ref,
    type: row.type,
    title: row.title,
    summary: row.summary,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    scope: rowScope(row),
    metadata: JSON.parse(row.metadata_json),
    aliases: JSON.parse(row.aliases_json),
    externalRefs: JSON.parse(row.external_refs_json),
    normKey: row.norm_key,
    normVersion: row.norm_version,
    supersededBy: row.superseded_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    graphVersion: row.graph_version,
  };
}

// D9's review queue rows -- one per unresolved occurrence, carrying the
// field diffs decision 7 recorded as proposed edits for a human to apply.
function mentionFromRow(row) {
  return {
    mentionId: row.mention_id,
    candidateRef: row.candidate_ref,
    normKey: row.norm_key,
    outcome: row.outcome,
    strategy: row.strategy,
    confidence: row.confidence,
    canonicalRef: row.canonical_ref,
    provenanceRef: row.provenance_ref,
    promotionIdempotencyKey: row.promotion_idempotency_key,
    scope: rowScope(row),
    fieldDiffs: row.field_diffs_json ? JSON.parse(row.field_diffs_json) : [],
    decidedAt: row.decided_at,
  };
}

function relationFromRow(row) {
  return {
    canonicalRef: row.canonical_ref,
    fromRef: row.from_ref,
    relationType: row.relation_type,
    toRef: row.to_ref,
    confidence: row.confidence,
    evidenceRef: row.evidence_ref,
    scope: rowScope(row),
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
    graphVersion: row.graph_version,
  };
}

function isNormKeyUniqueViolation(error) {
  return typeof error?.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT") && /entities\.norm_key/.test(error.message ?? "");
}

export function openSqlitePersistence({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR }) {
  const resolved = requireAbsolutePath(dbPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  let db;
  try {
    db = new Database(resolved);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    runMigrations(db, migrationsDir);
  } catch (error) {
    db?.close();
    throw new GksBackendUnavailableError(`Unable to open GKS persistence: ${error.message}`);
  }

  const selectPromotion = db.prepare("SELECT * FROM promotions WHERE scope_key = ? AND idempotency_key = ?");
  const nextVersion = db.prepare("UPDATE graph_state SET version = version + 1 WHERE singleton = 1 RETURNING version");
  const selectEntityByRef = db.prepare("SELECT * FROM entities WHERE canonical_ref = ?");
  const selectEntityByNormKey = db.prepare("SELECT * FROM entities WHERE scope_key = ? AND norm_key = ?");
  // ADR-GKS-ENTITY-RESOLUTION decisions 5 and 7: the pre-Stage-9
  // `ON CONFLICT(scope_key, candidate_ref) DO UPDATE` upsert is gone. A new
  // identity is a plain INSERT under UNIQUE(scope_key, norm_key) — losing
  // that race surfaces as GksNormKeyConflictError so the domain layer can
  // retry to MATCHED — and writes to an existing identity go through the
  // additive fill below, never through an overwrite.
  const insertEntity = db.prepare(`
    INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, aliases_json, external_refs_json, norm_key, norm_version, created_at, updated_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @candidate_ref, @type, @title, @summary, @source_ref, @confidence, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @metadata_json, @aliases_json, @external_refs_json, @norm_key, @norm_version, @created_at, @updated_at, @graph_version)
  `);
  const fillEntity = db.prepare(`
    UPDATE entities SET summary = @summary, source_ref = @source_ref, aliases_json = @aliases_json, external_refs_json = @external_refs_json, updated_at = @updated_at, graph_version = @graph_version
    WHERE canonical_ref = @canonical_ref
  `);
  const insertMention = db.prepare(`
    INSERT INTO entity_mentions (mention_id, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, candidate_ref, norm_key, provenance_ref, promotion_idempotency_key, canonical_ref, outcome, strategy, confidence, decided_at, field_diffs_json)
    VALUES (@mention_id, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @candidate_ref, @norm_key, @provenance_ref, @promotion_idempotency_key, @canonical_ref, @outcome, @strategy, @confidence, @decided_at, @field_diffs_json)
  `);
  const insertRelation = db.prepare(`
    INSERT INTO relations (canonical_ref, scope_key, from_ref, relation_type, to_ref, confidence, evidence_ref, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @from_ref, @relation_type, @to_ref, @confidence, @evidence_ref, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @metadata_json, @created_at, @graph_version)
    ON CONFLICT(scope_key, from_ref, relation_type, to_ref) DO NOTHING
  `);
  // D10.1: a relation whose endpoint resolved without a canonical ref is
  // held with its mention endpoints instead of aborting the envelope. Like
  // entity_mentions, its identity is the occurrence.
  const insertPendingRelation = db.prepare(`
    INSERT INTO pending_relations (pending_id, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, from_candidate_ref, relation_type, to_candidate_ref, from_mention_id, to_mention_id, confidence, metadata_json, provenance_ref, promotion_idempotency_key, status, created_at)
    VALUES (@pending_id, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @from_candidate_ref, @relation_type, @to_candidate_ref, @from_mention_id, @to_mention_id, @confidence, @metadata_json, @provenance_ref, @promotion_idempotency_key, 'PENDING', @created_at)
  `);
  const insertPromotion = db.prepare(`
    INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
    VALUES (@scope_key, @idempotency_key, @knowledge_ref, @source_hash, @provenance_ref, @candidate_json, @canonical_mappings_json, @graph_version, @created_at)
  `);

  // -------------------------------------------------------------------------
  // Port version 3 (ADR-GKS-LEDGER-REPORTING D2/D4): the stage_evidence
  // writer and reader. The writer is internal -- called only from inside a
  // write transaction that just executed a stage -- so the row and the
  // stage's own rows commit or roll back together, and the cursor is taken
  // from graph_state in that same transaction: assigned at commit time, in
  // commit order, with no hole left behind by a rollback.
  // -------------------------------------------------------------------------
  const nextEvidenceCursor = db.prepare("UPDATE graph_state SET evidence_cursor = evidence_cursor + 1 WHERE singleton = 1 RETURNING evidence_cursor");
  const insertStageEvidence = db.prepare(`
    INSERT INTO stage_evidence (evidence_id, cursor, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, pipeline_stage_id, pipeline_definition_id, execution_contract_id, run_id, provenance_ref, evidence_json, metrics_json, records_json, produced_at)
    VALUES (@evidence_id, @cursor, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @pipeline_stage_id, @pipeline_definition_id, @execution_contract_id, @run_id, @provenance_ref, @evidence_json, @metrics_json, @records_json, @produced_at)
  `);

  function recordStageEvidence({ evidenceId, scope, scopeKey: scopeKeyValue, pipelineStageId, runId, provenanceRef, evidence, metrics, records, producedAt }) {
    const cursor = nextEvidenceCursor.get().evidence_cursor;
    insertStageEvidence.run({
      evidence_id: evidenceId,
      cursor,
      scope_key: scopeKeyValue,
      portfolio_id: scope.portfolioId,
      tenant_id: scope.tenantId,
      business_id: scope.businessId,
      workspace_id: scope.workspaceId,
      project_id: scope.projectId,
      sharing: scope.sharing,
      pipeline_stage_id: pipelineStageId,
      pipeline_definition_id: KNOWLEDGE_INGESTION_DEFINITION_ID,
      execution_contract_id: KNOWLEDGE_INGESTION_CONTRACT_ID,
      run_id: runId ?? null,
      provenance_ref: provenanceRef,
      // Always an object and always an array: one representation for
      // "nothing here", so a puller branches on one shape (ledger ADR D2).
      evidence_json: JSON.stringify(evidence ?? {}),
      metrics_json: JSON.stringify(zeroMetrics(metrics ?? {})),
      records_json: JSON.stringify(Array.isArray(records) ? records : []),
      produced_at: producedAt,
    });
    return cursor;
  }

  // The scope predicate in SQL, never in the caller: exact portfolio and
  // tenant (an empty tenant_id is a tenant of its own), same-or-broader
  // below the tenant wall -- the same shape the resolution pool uses, for
  // the same reason: this is durable, cursor-addressed evidence a puller may
  // already have consumed by the time a caller-side filter bug is found.
  const selectStageEvidencePage = db.prepare(`
    SELECT * FROM stage_evidence
    WHERE portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND (business_id = '' OR business_id = @businessId)
      AND (workspace_id = '' OR workspace_id = @workspaceId)
      AND (project_id = '' OR project_id = @projectId)
      AND cursor > @sinceCursor
    ORDER BY cursor ASC
    LIMIT @limit
  `);

  function stageEvidenceFromRow(row) {
    return {
      evidenceId: row.evidence_id,
      cursor: row.cursor,
      pipelineStageId: row.pipeline_stage_id,
      pipelineDefinitionId: row.pipeline_definition_id,
      executionContractId: row.execution_contract_id,
      runId: row.run_id,
      provenanceRef: row.provenance_ref,
      scope: rowScope(row),
      evidence: JSON.parse(row.evidence_json),
      metrics: JSON.parse(row.metrics_json),
      records: JSON.parse(row.records_json),
      producedAt: row.produced_at,
    };
  }

  // Decision 7: writes against an existing entity are additive only. An
  // empty stored field (empty summary, null source_ref) is filled; aliases
  // and external refs are unioned (the mention's normalized form joins the
  // aliases, which is what lets the ALIAS and EXTERNAL_REF rungs improve
  // over time); a conflicting NON-empty difference writes nothing to the
  // entity and is returned as a field diff for the mention row, where D9's
  // review tool surfaces it as a proposed edit.
  function fillExistingEntity(existing, entity, now, graphVersion) {
    const diffs = [];
    let changed = false;
    let summary = existing.summary;
    if (entity.summary) {
      if (existing.summary === "") {
        summary = entity.summary;
        changed = true;
      } else if (entity.summary !== existing.summary) {
        diffs.push({ field: "summary", stored: existing.summary, incoming: entity.summary });
      }
    }
    let sourceRef = existing.source_ref;
    if (entity.sourceRef != null) {
      if (existing.source_ref == null) {
        sourceRef = entity.sourceRef;
        changed = true;
      } else if (entity.sourceRef !== existing.source_ref) {
        diffs.push({ field: "source_ref", stored: existing.source_ref, incoming: entity.sourceRef });
      }
    }
    if (entity.title && entity.title !== existing.title) {
      diffs.push({ field: "title", stored: existing.title, incoming: entity.title });
    }
    const aliases = new Set(JSON.parse(existing.aliases_json));
    const externalRefs = new Set(JSON.parse(existing.external_refs_json));
    const sizeBefore = aliases.size + externalRefs.size;
    if (entity.normKey) aliases.add(entity.normKey);
    for (const alias of entity.aliases ?? []) aliases.add(alias);
    for (const ref of entity.externalRefs ?? []) externalRefs.add(ref);
    if (aliases.size + externalRefs.size !== sizeBefore) changed = true;
    if (changed) {
      fillEntity.run({
        canonical_ref: existing.canonical_ref,
        summary,
        source_ref: sourceRef,
        aliases_json: JSON.stringify([...aliases].sort()),
        external_refs_json: JSON.stringify([...externalRefs].sort()),
        updated_at: now,
        graph_version: graphVersion,
      });
    }
    return diffs;
  }

  const transactPromotion = db.transaction((input) => {
    const existing = selectPromotion.get(input.scopeKey, input.idempotencyKey);
    if (existing) {
      if (existing.source_hash !== input.sourceHash) throw new GksConflictError("idempotency_key is already bound to a different source_snapshot_hash.");
      return {
        idempotent: true,
        knowledgeRef: existing.knowledge_ref,
        sourceHash: existing.source_hash,
        graphVersion: existing.graph_version,
        canonicalMappings: JSON.parse(existing.canonical_mappings_json),
      };
    }
    const version = nextVersion.get().version;
    const graphVersion = `gks:graph/${version}`;
    const now = new Date().toISOString();
    const scope = input.scope;
    for (const entity of input.entities) {
      // D9: HUMAN is recorded only by transactHumanResolution, under its own
      // provenance. A promotion asserting it -- from any resolver, present or
      // future -- is refused at the write, not by convention.
      if (entity.resolution?.strategy === "HUMAN") {
        throw new GksInvalidRequestError("strategy HUMAN is recorded only by a human resolution decision, never by promotion.");
      }
      let fieldDiffs = null;
      // D3: an unresolved mention (REVIEW_REQUIRED / AMBIGUOUS / REJECTED)
      // has a null canonicalRef — it writes its own mention row below and
      // NOTHING to the entity table: no near-match is modified, no entity
      // is created for a rejected claim.
      const stored = entity.canonicalRef ? selectEntityByRef.get(entity.canonicalRef) : undefined;
      if (stored) {
        const diffs = fillExistingEntity(stored, entity, now, graphVersion);
        if (diffs.length) fieldDiffs = JSON.stringify(diffs);
      } else if (entity.canonicalRef) {
        try {
          insertEntity.run({
            canonical_ref: entity.canonicalRef,
            scope_key: input.scopeKey,
            candidate_ref: entity.candidateRef,
            type: entity.type,
            title: entity.title,
            summary: entity.summary,
            source_ref: entity.sourceRef,
            confidence: entity.confidence,
            portfolio_id: scope.portfolioId,
            tenant_id: scope.tenantId,
            business_id: scope.businessId,
            workspace_id: scope.workspaceId,
            project_id: scope.projectId,
            sharing: scope.sharing,
            metadata_json: JSON.stringify(entity.metadata),
            aliases_json: JSON.stringify([...(entity.aliases ?? [])].sort()),
            external_refs_json: JSON.stringify([...(entity.externalRefs ?? [])].sort()),
            norm_key: entity.normKey,
            norm_version: entity.normVersion,
            created_at: now,
            updated_at: now,
            graph_version: graphVersion,
          });
        } catch (error) {
          if (isNormKeyUniqueViolation(error)) {
            // Decision 5: surface the loss of the UNIQUE(scope_key, norm_key)
            // race with the winning row attached. The whole envelope rolls
            // back; the domain layer retries and returns MATCHED against the
            // winner rather than over-splitting or silently merging.
            const winner = selectEntityByNormKey.get(input.scopeKey, entity.normKey);
            throw new GksNormKeyConflictError(
              `An entity with norm_key "${entity.normKey}" already exists in this scope.`,
              { candidateRef: entity.candidateRef, normKey: entity.normKey, winner: entityFromRow(winner) },
            );
          }
          throw error;
        }
      }
      // D1: one mention row per occurrence — the audit trail promotion
      // replay never reads (D4 replays the promotion snapshot instead).
      insertMention.run({
        mention_id: mentionId(input.scopeKey, input.idempotencyKey, entity.candidateRef),
        scope_key: input.scopeKey,
        portfolio_id: scope.portfolioId,
        tenant_id: scope.tenantId,
        business_id: scope.businessId,
        workspace_id: scope.workspaceId,
        project_id: scope.projectId,
        sharing: scope.sharing,
        candidate_ref: entity.candidateRef,
        norm_key: entity.normKey,
        provenance_ref: input.provenanceRef,
        promotion_idempotency_key: input.idempotencyKey,
        canonical_ref: entity.canonicalRef ?? null,
        outcome: entity.resolution?.outcome,
        strategy: entity.resolution?.strategy,
        confidence: entity.resolution?.confidence ?? null,
        decided_at: now,
        field_diffs_json: fieldDiffs,
      });
    }
    for (const relation of input.relations) {
      insertRelation.run({
        canonical_ref: relation.canonicalRef,
        scope_key: input.scopeKey,
        from_ref: relation.fromRef,
        relation_type: relation.relationType,
        to_ref: relation.toRef,
        confidence: relation.confidence,
        evidence_ref: input.provenanceRef,
        portfolio_id: scope.portfolioId,
        tenant_id: scope.tenantId,
        business_id: scope.businessId,
        workspace_id: scope.workspaceId,
        project_id: scope.projectId,
        sharing: scope.sharing,
        metadata_json: JSON.stringify(relation.metadata),
        created_at: now,
        graph_version: graphVersion,
      });
    }
    // D10.1: pending relations are recorded with their mention endpoints —
    // the ids are the same pure function of (scope, promotion, candidateRef)
    // the mention rows above were written under, so the join is total.
    for (const pending of input.pendingRelations ?? []) {
      insertPendingRelation.run({
        pending_id: `gks:pending-relation/${digest([input.scopeKey, input.idempotencyKey, pending.fromCandidateRef, pending.relationType, pending.toCandidateRef].join(SEP))}`,
        scope_key: input.scopeKey,
        portfolio_id: scope.portfolioId,
        tenant_id: scope.tenantId,
        business_id: scope.businessId,
        workspace_id: scope.workspaceId,
        project_id: scope.projectId,
        sharing: scope.sharing,
        from_candidate_ref: pending.fromCandidateRef,
        relation_type: pending.relationType,
        to_candidate_ref: pending.toCandidateRef,
        from_mention_id: mentionId(input.scopeKey, input.idempotencyKey, pending.fromCandidateRef),
        to_mention_id: mentionId(input.scopeKey, input.idempotencyKey, pending.toCandidateRef),
        confidence: pending.confidence ?? null,
        metadata_json: JSON.stringify(pending.metadata ?? {}),
        provenance_ref: input.provenanceRef,
        promotion_idempotency_key: input.idempotencyKey,
        created_at: now,
      });
    }
    insertPromotion.run({
      scope_key: input.scopeKey,
      idempotency_key: input.idempotencyKey,
      knowledge_ref: input.knowledgeRef,
      source_hash: input.sourceHash,
      provenance_ref: input.provenanceRef,
      candidate_json: JSON.stringify(input.candidate),
      canonical_mappings_json: JSON.stringify(input.canonicalMappings),
      graph_version: graphVersion,
      created_at: now,
    });
    // Stage 9's evidence row, in the same transaction as the execution it
    // describes. Only a FIRST write is an execution -- the idempotent replay
    // above returned before reaching here, because a replay ran nothing.
    if (input.stageEvidence) {
      const { evidence, metrics } = stage9Evidence(input.canonicalMappings, {
        knowledge_ref: input.knowledgeRef,
        graph_version: graphVersion,
        automerge_floor: input.stageEvidence.automergeFloor ?? null,
        requested_pipeline_stage_id: input.stageEvidence.requestedPipelineStageId ?? null,
      });
      recordStageEvidence({
        evidenceId: `gks:evidence/${digest(["promotion", input.scopeKey, input.idempotencyKey].join(SEP))}`,
        scope,
        scopeKey: input.scopeKey,
        pipelineStageId: input.stageEvidence.pipelineStageId ?? ENTITY_RESOLVE_STAGE_ID,
        runId: input.stageEvidence.runId ?? null,
        provenanceRef: input.provenanceRef,
        evidence,
        metrics: {
          ...metrics,
          processing_time_ms: typeof input.stageEvidence.startedAt === "number" ? Math.max(0, Date.now() - input.stageEvidence.startedAt) : 0,
          retry_count: input.stageEvidence.retryCount ?? 0,
        },
        records: [],
        producedAt: now,
      });
    }
    return { idempotent: false, knowledgeRef: input.knowledgeRef, sourceHash: input.sourceHash, graphVersion, canonicalMappings: input.canonicalMappings };
  });

  // ADR-GKS-ENTITY-RESOLUTION decisions 5 and 8: the Stage 9 pool, filtered
  // on EVERY scope dimension in SQL — never in the caller — because the
  // result of resolution is a merge, and a cross-tenant merge has already
  // overwritten one tenant's entity by the time a caller-side filter would
  // have caught it. portfolio and tenant match by exact equality: an empty
  // tenant_id is a tenant of its own, never a wildcard, so tenant-less and
  // tenanted knowledge can never pool together in either direction. Below
  // the tenant wall, an empty dimension IS the wanted ancestor semantics
  // (same or broader scope, never narrower). sharing is not a pooling
  // dimension: it grants nothing at runtime today, and the pool cannot
  // inherit a distinction the code does not make.
  // superseded_by IS NULL: a D9-merged entity is no longer a live identity
  // (D9, decision 4's supersession record). Excluding it here is what makes
  // the merge a repair -- a repaired over-split can never be MATCHED, or
  // reported AMBIGUOUS, against its own ghost. Its spellings stay reachable
  // through the aliases the merge copied onto the survivor.
  const selectResolutionPool = db.prepare(`
    SELECT * FROM entities
    WHERE portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND (business_id = '' OR business_id = @businessId)
      AND (workspace_id = '' OR workspace_id = @workspaceId)
      AND (project_id = '' OR project_id = @projectId)
      AND superseded_by IS NULL
    ORDER BY created_at, canonical_ref
  `);

  // -------------------------------------------------------------------------
  // D9: the unresolved-mention consumer (ADR-GKS-ENTITY-RESOLUTION D9, D10.2,
  // decision 6). The review listing filters every scope dimension in SQL for
  // the same reason the pool does; the one human-authorized write runs as a
  // single transaction whose refusal checks read the SAME rows it writes, so
  // the tenant wall cannot be raced between a check and a write.
  // -------------------------------------------------------------------------
  const selectUnresolvedMentions = db.prepare(`
    SELECT * FROM entity_mentions
    WHERE portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND (business_id = '' OR business_id = @businessId)
      AND (workspace_id = '' OR workspace_id = @workspaceId)
      AND (project_id = '' OR project_id = @projectId)
      AND canonical_ref IS NULL
      AND outcome IN (${UNRESOLVED_OUTCOMES.map((outcome) => `'${outcome}'`).join(", ")})
    ORDER BY decided_at, mention_id
  `);
  const selectMentionById = db.prepare("SELECT * FROM entity_mentions WHERE mention_id = ?");
  const updateMentionDecision = db.prepare(`
    UPDATE entity_mentions SET canonical_ref = @canonical_ref, outcome = 'MATCHED', strategy = 'HUMAN', confidence = NULL, decided_at = @decided_at
    WHERE mention_id = @mention_id
  `);
  const updateEntityIdentityEvidence = db.prepare(`
    UPDATE entities SET aliases_json = @aliases_json, external_refs_json = @external_refs_json, updated_at = @updated_at, graph_version = @graph_version
    WHERE canonical_ref = @canonical_ref
  `);
  const markSuperseded = db.prepare(`
    UPDATE entities SET superseded_by = @superseded_by, updated_at = @updated_at, graph_version = @graph_version
    WHERE canonical_ref = @canonical_ref
  `);
  const selectRelationsTouching = db.prepare("SELECT * FROM relations WHERE from_ref = ? OR to_ref = ? ORDER BY canonical_ref");
  const selectRelationByEndpoints = db.prepare("SELECT * FROM relations WHERE scope_key = ? AND from_ref = ? AND relation_type = ? AND to_ref = ?");
  const deleteRelationByRef = db.prepare("DELETE FROM relations WHERE canonical_ref = ?");
  const repointRelation = db.prepare(`
    UPDATE relations SET canonical_ref = @canonical_ref, from_ref = @from_ref, to_ref = @to_ref, graph_version = @graph_version
    WHERE canonical_ref = @old_canonical_ref
  `);
  const selectPendingByMention = db.prepare("SELECT * FROM pending_relations WHERE status = 'PENDING' AND (from_mention_id = ? OR to_mention_id = ?) ORDER BY pending_id");
  const markPendingMaterialized = db.prepare("UPDATE pending_relations SET status = 'MATERIALIZED', materialized_ref = @materialized_ref WHERE pending_id = @pending_id");
  const insertHumanResolution = db.prepare(`
    INSERT INTO human_resolutions (decision_id, action, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, mention_id, canonical_ref, superseded_ref, provenance_ref, graph_version, created_at)
    VALUES (@decision_id, @action, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @mention_id, @canonical_ref, @superseded_ref, @provenance_ref, @graph_version, @created_at)
  `);

  // The review-listing predicate as a row check: the write may act on
  // exactly what the read tool lists for the caller's scope -- portfolio and
  // tenant by exact equality (an empty tenant_id is a tenant of its own),
  // same-or-broader below the tenant wall.
  function withinRequestScope(row, scope) {
    return row.portfolio_id === scope.portfolioId
      && row.tenant_id === scope.tenantId
      && (row.business_id === "" || row.business_id === scope.businessId)
      && (row.workspace_id === "" || row.workspace_id === scope.workspaceId)
      && (row.project_id === "" || row.project_id === scope.projectId);
  }

  // The pool rule (D5, decision 8), directional: the entity must sit at the
  // mention's scope or broader, inside the same portfolio and tenant.
  function inMentionPool(entityRow, mentionRow) {
    return entityRow.portfolio_id === mentionRow.portfolio_id
      && entityRow.tenant_id === mentionRow.tenant_id
      && (entityRow.business_id === "" || entityRow.business_id === mentionRow.business_id)
      && (entityRow.workspace_id === "" || entityRow.workspace_id === mentionRow.workspace_id)
      && (entityRow.project_id === "" || entityRow.project_id === mentionRow.project_id);
  }

  // Decision 4: a canonical ref, once minted, changes only via a D9 merge
  // with supersession recorded -- so a stored ref may point at a superseded
  // row, and any consumer minting NEW state from it follows the chain to the
  // live head first. Bounded by a visited set: a supersession cycle would be
  // a corrupt store, and looping on it forever helps nobody.
  function followSupersession(ref) {
    const visited = new Set();
    let current = ref;
    while (!visited.has(current)) {
      visited.add(current);
      const row = selectEntityByRef.get(current);
      if (!row || row.superseded_by === null) return current;
      current = row.superseded_by;
    }
    throw new GksBackendUnavailableError(`Supersession chain for ${ref} is cyclic.`);
  }

  function relationCanonicalRef(scopeKeyValue, fromRef, relationType, toRef) {
    return `gks:relation/${digest([scopeKeyValue, fromRef, relationType, toRef].join(SEP))}`;
  }

  function unionIdentityEvidence(entityRow, aliasAdds, externalRefAdds, now, graphVersion) {
    const aliases = new Set(JSON.parse(entityRow.aliases_json));
    const externalRefs = new Set(JSON.parse(entityRow.external_refs_json));
    for (const alias of aliasAdds) if (alias) aliases.add(alias);
    for (const ref of externalRefAdds) if (ref) externalRefs.add(ref);
    updateEntityIdentityEvidence.run({
      canonical_ref: entityRow.canonical_ref,
      aliases_json: JSON.stringify([...aliases].sort()),
      external_refs_json: JSON.stringify([...externalRefs].sort()),
      updated_at: now,
      graph_version: graphVersion,
    });
  }

  // D10 consequence 1: a pending relation materializes when its unresolved
  // endpoint resolves -- and the only mechanism by which that happens is the
  // D9 bind, so this runs inside the bind's transaction. Endpoint refs are
  // taken from the mention rows and followed through supersession, so a
  // relation held across an intervening merge lands on the survivor.
  function materializePendingFor(mentionIdValue, now, graphVersion) {
    const materialized = [];
    for (const row of selectPendingByMention.all(mentionIdValue, mentionIdValue)) {
      const fromMention = selectMentionById.get(row.from_mention_id);
      const toMention = selectMentionById.get(row.to_mention_id);
      if (!fromMention?.canonical_ref || !toMention?.canonical_ref) continue;
      const fromRef = followSupersession(fromMention.canonical_ref);
      const toRef = followSupersession(toMention.canonical_ref);
      const canonicalRef = relationCanonicalRef(row.scope_key, fromRef, row.relation_type, toRef);
      insertRelation.run({
        canonical_ref: canonicalRef,
        scope_key: row.scope_key,
        from_ref: fromRef,
        relation_type: row.relation_type,
        to_ref: toRef,
        confidence: row.confidence,
        evidence_ref: row.provenance_ref,
        portfolio_id: row.portfolio_id,
        tenant_id: row.tenant_id,
        business_id: row.business_id,
        workspace_id: row.workspace_id,
        project_id: row.project_id,
        sharing: row.sharing,
        metadata_json: row.metadata_json,
        created_at: now,
        graph_version: graphVersion,
      });
      markPendingMaterialized.run({ pending_id: row.pending_id, materialized_ref: canonicalRef });
      materialized.push({ pendingId: row.pending_id, canonicalRef, fromRef, relationType: row.relation_type, toRef });
    }
    return materialized;
  }

  // The one human-authorized write (D9). BIND resolves one unresolved
  // mention onto an existing canonical entity; MERGE records supersession on
  // the losing entity and re-points its relations to the survivor in the
  // SAME transaction (D10.2). This is the most dangerous write in the
  // system: every refusal below happens inside the transaction, against the
  // rows it would write, and a cross-tenant operand is refused outright --
  // an empty tenant_id being a tenant of its own, never a wildcard.
  const transactHumanResolution = db.transaction((input) => {
    const now = new Date().toISOString();
    if (input.action === "BIND") {
      const mention = selectMentionById.get(input.mentionId);
      // An absent mention and one outside the caller's scope answer
      // identically: mention ids are unguessable digests, and the review
      // listing is the sanctioned way to learn them.
      if (!mention || !withinRequestScope(mention, input.scope)) {
        throw new GksInvalidRequestError("mentionId does not name a mention within scope.");
      }
      if (mention.canonical_ref !== null || !UNRESOLVED_OUTCOMES.includes(mention.outcome)) {
        throw new GksInvalidRequestError("mentionId does not name an unresolved mention.");
      }
      const target = selectEntityByRef.get(input.canonicalRef);
      if (!target) throw new GksInvalidRequestError("canonicalRef does not resolve to a canonical entity.");
      if (!inMentionPool(target, mention)) {
        throw new GksScopeDeniedError("bind target is outside the mention's resolution pool.");
      }
      if (target.superseded_by !== null) {
        throw new GksConflictError("canonicalRef names a superseded entity; bind to the surviving entity instead.");
      }
      const graphVersion = `gks:graph/${nextVersion.get().version}`;
      updateMentionDecision.run({ mention_id: mention.mention_id, canonical_ref: target.canonical_ref, decided_at: now });
      // Decision 1's ALIAS rung matches "an alias recorded by a prior D9
      // human bind" -- this write is that recording.
      unionIdentityEvidence(target, [mention.norm_key], [], now, graphVersion);
      const materializedRelations = materializePendingFor(mention.mention_id, now, graphVersion);
      const bindDecisionId = `gks:decision/${digest([input.scopeKey, "BIND", mention.mention_id, target.canonical_ref, input.provenanceRef].join(SEP))}`;
      // The ledger ADR's Task 1 finding: strategy HUMAN never rode a promote
      // response and was invisible to every caller. It has an evidence row
      // now, in the decision's own transaction, under its own provenance.
      recordStageEvidence({
        evidenceId: `gks:evidence/${digest(["human", bindDecisionId].join(SEP))}`,
        scope: input.scope,
        scopeKey: input.scopeKey,
        pipelineStageId: ENTITY_RESOLVE_STAGE_ID,
        runId: null,
        provenanceRef: input.provenanceRef,
        evidence: { action: "BIND", strategy: "HUMAN", outcome: "MATCHED", mention_id: mention.mention_id, canonical_ref: target.canonical_ref, decision_id: bindDecisionId, graph_version: graphVersion, materialized_relations: materializedRelations.length },
        metrics: { records_in: 1, records_out: 1 },
        records: [],
        producedAt: now,
      });
      insertHumanResolution.run({
        decision_id: bindDecisionId,
        action: "BIND",
        scope_key: input.scopeKey,
        portfolio_id: input.scope.portfolioId,
        tenant_id: input.scope.tenantId,
        business_id: input.scope.businessId,
        workspace_id: input.scope.workspaceId,
        project_id: input.scope.projectId,
        sharing: input.scope.sharing,
        mention_id: mention.mention_id,
        canonical_ref: target.canonical_ref,
        superseded_ref: null,
        provenance_ref: input.provenanceRef,
        graph_version: graphVersion,
        created_at: now,
      });
      return {
        action: "BIND",
        mentionId: mention.mention_id,
        canonicalRef: target.canonical_ref,
        outcome: "MATCHED",
        strategy: "HUMAN",
        graphVersion,
        materializedRelations,
      };
    }

    const survivor = selectEntityByRef.get(input.survivorRef);
    if (!survivor) throw new GksInvalidRequestError("survivorRef does not resolve to a canonical entity.");
    const loser = selectEntityByRef.get(input.supersededRef);
    if (!loser) throw new GksInvalidRequestError("supersededRef does not resolve to a canonical entity.");
    if (!withinRequestScope(survivor, input.scope) || !withinRequestScope(loser, input.scope)) {
      throw new GksScopeDeniedError("merge operands must both be within the request scope.");
    }
    // Redundant with the request-scope check by construction, and kept
    // anyway: this is the unrecoverable write, and the tenant wall on the
    // operands themselves must not depend on an inference.
    if (survivor.portfolio_id !== loser.portfolio_id || survivor.tenant_id !== loser.tenant_id) {
      throw new GksScopeDeniedError("cross-tenant merge is refused outright.");
    }
    if (survivor.superseded_by !== null) {
      throw new GksConflictError("survivorRef names a superseded entity; merge onto the surviving entity instead.");
    }
    if (loser.superseded_by !== null) {
      throw new GksConflictError("supersededRef names an entity that is already superseded.");
    }
    const graphVersion = `gks:graph/${nextVersion.get().version}`;
    markSuperseded.run({ canonical_ref: loser.canonical_ref, superseded_by: survivor.canonical_ref, updated_at: now, graph_version: graphVersion });
    // The survivor absorbs the loser's identity evidence: its base norm key
    // (a D2 discriminator's "#" suffix stripped), its aliases and its
    // external refs. This is what keeps every spelling that used to reach
    // the loser resolving -- via the ALIAS and EXTERNAL_REF rungs -- now
    // that the pool excludes the superseded row.
    unionIdentityEvidence(
      survivor,
      [loser.norm_key.split("#")[0], ...JSON.parse(loser.aliases_json)],
      JSON.parse(loser.external_refs_json),
      now,
      graphVersion,
    );
    // D10.2: relations follow entity identity in the same transaction. Each
    // re-pointed row keeps the digest invariant (ref = f(scope, endpoints));
    // a row whose re-pointed twin already exists is removed, because the
    // same semantic relation already stands on the survivor and
    // UNIQUE(scope_key, from_ref, relation_type, to_ref) is the constraint
    // saying so.
    const repointedRelations = [];
    const removedDuplicateRelations = [];
    for (const relation of selectRelationsTouching.all(loser.canonical_ref, loser.canonical_ref)) {
      const fromRef = relation.from_ref === loser.canonical_ref ? survivor.canonical_ref : relation.from_ref;
      const toRef = relation.to_ref === loser.canonical_ref ? survivor.canonical_ref : relation.to_ref;
      const twin = selectRelationByEndpoints.get(relation.scope_key, fromRef, relation.relation_type, toRef);
      if (twin && twin.canonical_ref !== relation.canonical_ref) {
        deleteRelationByRef.run(relation.canonical_ref);
        removedDuplicateRelations.push(relation.canonical_ref);
        continue;
      }
      const canonicalRef = relationCanonicalRef(relation.scope_key, fromRef, relation.relation_type, toRef);
      repointRelation.run({ old_canonical_ref: relation.canonical_ref, canonical_ref: canonicalRef, from_ref: fromRef, to_ref: toRef, graph_version: graphVersion });
      repointedRelations.push({ canonicalRef, fromRef, relationType: relation.relation_type, toRef });
    }
    const mergeDecisionId = `gks:decision/${digest([input.scopeKey, "MERGE", survivor.canonical_ref, loser.canonical_ref, input.provenanceRef].join(SEP))}`;
    recordStageEvidence({
      evidenceId: `gks:evidence/${digest(["human", mergeDecisionId].join(SEP))}`,
      scope: input.scope,
      scopeKey: input.scopeKey,
      pipelineStageId: ENTITY_RESOLVE_STAGE_ID,
      runId: null,
      provenanceRef: input.provenanceRef,
      evidence: { action: "MERGE", strategy: "HUMAN", outcome: "MATCHED", canonical_ref: survivor.canonical_ref, superseded_ref: loser.canonical_ref, decision_id: mergeDecisionId, graph_version: graphVersion, repointed_relations: repointedRelations.length, removed_duplicate_relations: removedDuplicateRelations.length },
      metrics: { records_in: 2, records_out: 1 },
      records: [],
      producedAt: now,
    });
    insertHumanResolution.run({
      decision_id: mergeDecisionId,
      action: "MERGE",
      scope_key: input.scopeKey,
      portfolio_id: input.scope.portfolioId,
      tenant_id: input.scope.tenantId,
      business_id: input.scope.businessId,
      workspace_id: input.scope.workspaceId,
      project_id: input.scope.projectId,
      sharing: input.scope.sharing,
      mention_id: null,
      canonical_ref: survivor.canonical_ref,
      superseded_ref: loser.canonical_ref,
      provenance_ref: input.provenanceRef,
      graph_version: graphVersion,
      created_at: now,
    });
    return {
      action: "MERGE",
      survivorRef: survivor.canonical_ref,
      supersededRef: loser.canonical_ref,
      graphVersion,
      repointedRelations,
      removedDuplicateRelations,
    };
  });

  const insertArtifactLink = db.prepare(`
    INSERT INTO artifact_links (canonical_ref, scope_key, knowledge_ref, artifact_ref, relation_type, evidence_ref, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, graph_version, created_at)
    VALUES (@canonical_ref, @scope_key, @knowledge_ref, @artifact_ref, @relation_type, @evidence_ref, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @graph_version, @created_at)
    ON CONFLICT(scope_key, knowledge_ref, artifact_ref, relation_type) DO NOTHING
  `);
  const selectArtifactLink = db.prepare("SELECT * FROM artifact_links WHERE scope_key = ? AND knowledge_ref = ? AND artifact_ref = ? AND relation_type = ?");
  const transactArtifactLink = db.transaction((input) => {
    const existing = selectArtifactLink.get(input.scopeKey, input.knowledgeRef, input.artifactRef, input.relationType);
    if (existing) return existing;
    const graphVersion = `gks:graph/${nextVersion.get().version}`;
    const now = new Date().toISOString();
    insertArtifactLink.run({
      canonical_ref: input.canonicalRef,
      scope_key: input.scopeKey,
      knowledge_ref: input.knowledgeRef,
      artifact_ref: input.artifactRef,
      relation_type: input.relationType,
      evidence_ref: input.evidenceRef,
      portfolio_id: input.scope.portfolioId,
      tenant_id: input.scope.tenantId,
      business_id: input.scope.businessId,
      workspace_id: input.scope.workspaceId,
      project_id: input.scope.projectId,
      sharing: input.scope.sharing,
      graph_version: graphVersion,
      created_at: now,
    });
    return selectArtifactLink.get(input.scopeKey, input.knowledgeRef, input.artifactRef, input.relationType);
  });

  // -------------------------------------------------------------------------
  // GenesisRAG17 pipeline persistence. This is deliberately separate from
  // stage_evidence: the v1 pipeline has its own six-field scope, immutable
  // stage identity, replay key, and receipt gates. No caller credentials are
  // stored in these tables.
  // -------------------------------------------------------------------------
  const selectPipelineBatchByIdempotency = db.prepare("SELECT * FROM pipeline_batches WHERE scope_key = ? AND idempotency_key = ?");
  const selectPipelineBatchById = db.prepare("SELECT * FROM pipeline_batches WHERE scope_key = ? AND batch_id = ?");
  const selectPipelineDecisionById = db.prepare("SELECT * FROM pipeline_batches WHERE scope_key = ? AND decision_id = ?");
  const selectPipelinePending = db.prepare(`
    SELECT * FROM pipeline_batches
    WHERE scope_key = @scopeKey
      AND portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND business_id = @businessId
      AND workspace_id = @workspaceId
      AND agent_id = @agentId
      AND visibility = @visibility
      AND status IN ('PENDING', 'GRAPH_RECEIPTED', 'RECEIPT_WRITTEN', 'GATED')
    ORDER BY created_at, batch_id
    LIMIT @limit
  `);
  const selectPipelineReceiptByDecision = db.prepare("SELECT * FROM pipeline_receipts WHERE scope_key = ? AND decision_id = ?");
  const selectPipelineGraphReceiptByDecision = db.prepare("SELECT * FROM pipeline_graph_receipts WHERE scope_key = ? AND decision_id = ?");
  const selectPipelineGateByDecision = db.prepare("SELECT * FROM pipeline_gates WHERE scope_key = ? AND decision_id = ?");
  const selectPipelinePublication = db.prepare("SELECT * FROM pipeline_publication_receipts WHERE scope_key = ? AND decision_id = ? AND snapshot_id = ? AND generation = ?");
  const insertPipelineBatch = db.prepare(`
    INSERT INTO pipeline_batches (batch_id, scope_key, portfolio_id, tenant_id, business_id, workspace_id, agent_id, visibility, idempotency_key, batch_hash, batch_json, decision_id, decision_hash, decision_json, policy_json, run_id, status, created_at, updated_at)
    VALUES (@batch_id, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @agent_id, @visibility, @idempotency_key, @batch_hash, @batch_json, @decision_id, @decision_hash, @decision_json, @policy_json, @run_id, @status, @created_at, @updated_at)
  `);
  const insertPipelineMention = db.prepare(`
    INSERT INTO pipeline_mentions (scope_key, batch_id, source_mention_id, resolution_key, semantic_type, name, chunk_id, start_offset, end_offset, entity_id, metadata_json, created_at)
    VALUES (@scope_key, @batch_id, @source_mention_id, @resolution_key, @semantic_type, @name, @chunk_id, @start_offset, @end_offset, @entity_id, @metadata_json, @created_at)
  `);
  const insertPipelineReceipt = db.prepare(`
    INSERT INTO pipeline_receipts (scope_key, decision_id, run_id, decision_hash, receipt_hash, receipt_json, created_at)
    VALUES (@scope_key, @decision_id, @run_id, @decision_hash, @receipt_hash, @receipt_json, @created_at)
  `);
  const insertPipelineGraphReceipt = db.prepare(`
    INSERT INTO pipeline_graph_receipts (scope_key, decision_id, run_id, decision_hash, graph_receipt_hash, receipt_json, derived_json, derived_hash, created_at)
    VALUES (@scope_key, @decision_id, @run_id, @decision_hash, @graph_receipt_hash, @receipt_json, @derived_json, @derived_hash, @created_at)
  `);
  const insertPipelineGate = db.prepare(`
    INSERT INTO pipeline_gates (scope_key, decision_id, decision_hash, receipt_hash, verdict_hash, verdict_json, created_at)
    VALUES (@scope_key, @decision_id, @decision_hash, @receipt_hash, @verdict_hash, @verdict_json, @created_at)
  `);
  const insertPipelinePublication = db.prepare(`
    INSERT INTO pipeline_publication_receipts (scope_key, decision_id, run_id, snapshot_id, generation, publication_hash, receipt_json, created_at)
    VALUES (@scope_key, @decision_id, @run_id, @snapshot_id, @generation, @publication_hash, @receipt_json, @created_at)
  `);
  const nextPipelineEvidenceCursor = db.prepare("UPDATE graph_state SET pipeline_evidence_cursor = pipeline_evidence_cursor + 1 WHERE singleton = 1 RETURNING pipeline_evidence_cursor");
  const currentPipelineEvidenceCursor = db.prepare("SELECT pipeline_evidence_cursor FROM graph_state WHERE singleton = 1");
  const insertPipelineEvidence = db.prepare(`
    INSERT INTO pipeline_evidence (cursor, schema_version, scope_key, portfolio_id, tenant_id, business_id, workspace_id, agent_id, visibility, run_id, pipeline_stage_id, execution_step_id, attempt_id, stage_number, outcome, started_at, finished_at, metrics_json, details_json, created_at)
    VALUES (@cursor, @schema_version, @scope_key, @portfolio_id, @tenant_id, @business_id, @workspace_id, @agent_id, @visibility, @run_id, @pipeline_stage_id, @execution_step_id, @attempt_id, @stage_number, @outcome, @started_at, @finished_at, @metrics_json, @details_json, @created_at)
  `);
  const selectPipelineEvidenceByIdentity = db.prepare(`
    SELECT * FROM pipeline_evidence
    WHERE scope_key = ? AND run_id = ? AND pipeline_stage_id = ? AND execution_step_id = ? AND attempt_id = ?
  `);
  const selectPipelineEvidencePage = db.prepare(`
    SELECT * FROM pipeline_evidence
    WHERE scope_key = @scopeKey
      AND portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND business_id = @businessId
      AND workspace_id = @workspaceId
      AND agent_id = @agentId
      AND visibility = @visibility
      AND run_id = @runId
      AND cursor > @afterCursor
    ORDER BY cursor ASC
    LIMIT @limit
  `);
  const updatePipelineBatchStatus = db.prepare("UPDATE pipeline_batches SET status = @status, updated_at = @updated_at WHERE scope_key = @scope_key AND decision_id = @decision_id");
  const insertPipelineEntity = db.prepare(`
    INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, aliases_json, external_refs_json, norm_key, norm_version, created_at, updated_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @candidate_ref, 'ENTITY', @title, '', @source_ref, NULL, @portfolio_id, @tenant_id, @business_id, @workspace_id, '', 'private', @metadata_json, '[]', '[]', @norm_key, @norm_version, @created_at, @updated_at, @graph_version)
  `);

  function pipelineLegacyScope(scope) {
    return {
      portfolioId: scope.portfolioId,
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      workspaceId: scope.workspaceId,
      projectId: "",
      sharing: scope.visibility,
    };
  }

  function pipelineLegacyScopeKey(scope) {
    const legacy = pipelineLegacyScope(scope);
    return [legacy.portfolioId, legacy.tenantId, legacy.businessId, legacy.workspaceId, legacy.projectId, legacy.sharing].join(SEP);
  }

  function pipelineStageMetrics(decision, stageNumber, { durationMs = 0, errorCount = 0, retryCount = 0, recordsIn, recordsOut, recordsQuarantined } = {}) {
    const measured = decision.stageMetrics?.[stageNumber] ?? decision.stageMetrics?.[String(stageNumber)] ?? {};
    return Object.fromEntries(PIPELINE_REQUIRED_METRICS.map((key) => [
      key,
      key === "records_in" ? (recordsIn ?? (Number.isFinite(measured[key]) && measured[key] >= 0 ? measured[key] : 0)) : key === "records_out" ? (recordsOut ?? (Number.isFinite(measured[key]) && measured[key] >= 0 ? measured[key] : 0)) : key === "records_quarantined" ? (recordsQuarantined ?? (Number.isFinite(measured[key]) && measured[key] >= 0 ? measured[key] : 0)) : key === "error_count" ? errorCount : key === "retry_count" ? retryCount : key === "duration_ms" ? durationMs : 0,
    ]));
  }

  function durationMs(times) {
    if (!times) return 0;
    const started = Date.parse(times.startedAt);
    const finished = Date.parse(times.finishedAt);
    return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
  }

  function pipelineEvidenceRow(scope, identity, outcome, startedAt, finishedAt, metrics, details) {
    const cursor = nextPipelineEvidenceCursor.get().pipeline_evidence_cursor;
    insertPipelineEvidence.run({
      cursor,
      schema_version: PIPELINE_SCHEMA_VERSION,
      scope_key: pipelineScopeKey(scope),
      portfolio_id: scope.portfolioId,
      tenant_id: scope.tenantId,
      business_id: scope.businessId,
      workspace_id: scope.workspaceId,
      agent_id: scope.agentId,
      visibility: scope.visibility,
      run_id: identity.runId,
      pipeline_stage_id: identity.pipelineStageId,
      execution_step_id: identity.executionStepId,
      attempt_id: identity.attemptId,
      stage_number: identity.stageNumber,
      outcome,
      started_at: startedAt,
      finished_at: finishedAt,
      metrics_json: JSON.stringify(metrics),
      details_json: JSON.stringify(details ?? {}),
      created_at: finishedAt,
    });
    return cursor;
  }

  function pipelineDecisionFromRow(row) {
    return row ? JSON.parse(row.decision_json) : null;
  }

  function sameStageIdentity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const normalize = (stages) => stages.map((stage) => ({ stageNumber: stage.stageNumber, pipelineStageId: stage.pipelineStageId, runId: stage.runId, executionStepId: stage.executionStepId, attemptId: stage.attemptId })).sort((a, b) => a.stageNumber - b.stageNumber);
    return canonicalJsonString(normalize(left)) === canonicalJsonString(normalize(right));
  }

  const transactPipelineSubmit = db.transaction((input) => {
    const batch = input.batch ?? input;
    if (pipelineScopeKey(input.scope) !== pipelineScopeKey(batch.scope)) throw new GksScopeDeniedError("pipeline scope does not match the batch scope.");
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const existingByKey = selectPipelineBatchByIdempotency.get(scopeKeyValue, batch.idempotencyKey);
    if (existingByKey) {
      if (existingByKey.batch_hash !== input.batchHash) throw new GksConflictError("pipeline idempotencyKey was reused with a different batch.");
      return { idempotent: true, batchId: existingByKey.batch_id, decisionId: existingByKey.decision_id, status: existingByKey.status, decisionHash: existingByKey.decision_hash };
    }
    const existingById = selectPipelineBatchById.get(scopeKeyValue, batch.batchId);
    if (existingById) {
      if (existingById.batch_hash !== input.batchHash) throw new GksConflictError("batchId was reused with a different batch.");
      return { idempotent: true, batchId: existingById.batch_id, decisionId: existingById.decision_id, status: existingById.status, decisionHash: existingById.decision_hash };
    }
    const decision = input.decision;
    const decisionHash = hashPipelineDecision(decision);
    if (decisionHash !== decision.decisionHash) throw new GksInvalidRequestError("decisionHash does not match the immutable decision payload.");
    const now = new Date().toISOString();
    const legacyScopeKey = pipelineLegacyScopeKey(input.scope);
    const graphVersion = `gks:graph/${nextVersion.get().version}`;
    for (const entity of decision.entities ?? []) {
      const existing = selectEntityByRef.get(entity.id);
      if (existing) {
        if (existing.scope_key !== legacyScopeKey) throw new GksScopeDeniedError("pipeline entity reference is outside the pipeline scope.");
      } else {
        const resolutionKey = entity.metadata?.resolutionKey ?? entity.name;
        const existingByNorm = selectEntityByNormKey.get(legacyScopeKey, normKey(resolutionKey));
        if (existingByNorm && existingByNorm.canonical_ref !== entity.id) {
          throw new GksConflictError(`pipeline canonical entity ${entity.name} already exists under ${existingByNorm.canonical_ref}.`);
        }
        insertPipelineEntity.run({
          canonical_ref: entity.id,
          scope_key: legacyScopeKey,
          candidate_ref: resolutionKey,
          title: entity.name,
          source_ref: decision.source.sourceId,
          portfolio_id: input.scope.portfolioId,
          tenant_id: input.scope.tenantId,
          business_id: input.scope.businessId,
          workspace_id: input.scope.workspaceId,
          metadata_json: JSON.stringify({ ...(entity.metadata ?? {}), semanticType: entity.semanticType, pipelineVersion: PIPELINE_SCHEMA_VERSION }),
          norm_key: normKey(resolutionKey),
          norm_version: NORM_VERSION,
          created_at: now,
          updated_at: now,
          graph_version: graphVersion,
        });
      }
    }
    insertPipelineBatch.run({
      batch_id: batch.batchId,
      scope_key: scopeKeyValue,
      portfolio_id: input.scope.portfolioId,
      tenant_id: input.scope.tenantId,
      business_id: input.scope.businessId,
      workspace_id: input.scope.workspaceId,
      agent_id: input.scope.agentId,
      visibility: input.scope.visibility,
      idempotency_key: batch.idempotencyKey,
      batch_hash: input.batchHash,
      batch_json: JSON.stringify(input.batch),
      decision_id: decision.decisionId,
      decision_hash: decision.decisionHash,
      decision_json: JSON.stringify(decision),
      policy_json: JSON.stringify(decision.policy),
      run_id: decision.runId,
      status: "PENDING",
      created_at: now,
      updated_at: now,
    });
    for (const mention of input.batch.mentions) {
      const entity = decision.entities.find((candidate) => candidate.mentions.includes(mention.sourceMentionId));
      insertPipelineMention.run({
        scope_key: scopeKeyValue,
        batch_id: input.batch.batchId,
        source_mention_id: mention.sourceMentionId,
        resolution_key: mention.resolutionKey,
        semantic_type: mention.semanticType,
        name: mention.name,
        chunk_id: mention.chunkId,
        start_offset: mention.startOffset,
        end_offset: mention.endOffset,
        entity_id: entity?.id ?? "",
        metadata_json: JSON.stringify({ semanticType: mention.semanticType }),
        created_at: now,
      });
    }
    for (const stageNumber of [9, 10, 11, 12]) {
      const identity = decision.stages.find((stage) => stage.stageNumber === stageNumber);
      const times = input.stageExecutionTimes?.[stageNumber] ?? input.stageExecutionTimes?.[String(stageNumber)];
      if (!times) throw new GksInvalidRequestError(`pipeline stage ${stageNumber} execution times are required.`);
      pipelineEvidenceRow(input.scope, identity, "SUCCEEDED", times.startedAt, times.finishedAt, pipelineStageMetrics(decision, stageNumber, { durationMs: durationMs(times) }), {
        batchId: batch.batchId,
        decisionHash: decision.decisionHash,
        stageNumber,
        records: decision.stageMetrics?.[stageNumber]?.records_out ?? decision.stageMetrics?.[String(stageNumber)]?.records_out ?? (stageNumber === 9 ? decision.entities.length : decision.facts.length),
      });
    }
    return { idempotent: false, batchId: batch.batchId, decisionId: decision.decisionId, status: "PENDING", decisionHash: decision.decisionHash };
  });

  const transactPipelineStageFailure = db.transaction((input) => {
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const batchRow = selectPipelineDecisionById.get(scopeKeyValue, input.decisionId);
    if (!batchRow) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
    if (batchRow.decision_hash !== input.decisionHash) throw new GksConflictError("stage failure decisionHash does not match the stored decision.");
    if (batchRow.run_id !== input.runId) throw new GksConflictError("stage failure runId does not match the stored decision.");
    const decision = pipelineDecisionFromRow(batchRow);
    const expectedIdentity = decision.stages.find((stage) => stage.stageNumber === input.stage.stageNumber);
    if (!expectedIdentity || canonicalJsonString(expectedIdentity) !== canonicalJsonString(input.stage)) throw new GksConflictError("stage failure identity does not match the immutable decision.");
    const failureHash = sha256Json(input);
    const existing = selectPipelineEvidenceByIdentity.get(scopeKeyValue, input.runId, input.stage.pipelineStageId, input.stage.executionStepId, input.stage.attemptId);
    if (existing) {
      const details = JSON.parse(existing.details_json);
      if (existing.outcome !== "FAILED" || details.failureHash !== failureHash) throw new GksConflictError("stage attempt already has different terminal evidence.");
      return { idempotent: true, failureHash };
    }
    if (["FAILED_STAGE", "REJECTED", "PUBLISHED"].includes(batchRow.status)) throw new GksConflictError("pipeline execution is already terminal and cannot accept another stage failure.");
    const details = { failureHash, error: input.error };
    pipelineEvidenceRow(input.scope, input.stage, "FAILED", input.startedAt, input.finishedAt, input.metrics, details);
    updatePipelineBatchStatus.run({ status: "FAILED_STAGE", updated_at: input.finishedAt, scope_key: scopeKeyValue, decision_id: input.decisionId });
    return { idempotent: false, failureHash };
  });

  const transactPipelineGraphReceipt = db.transaction((input) => {
    if (pipelineScopeKey(input.scope) !== pipelineScopeKey(input.receipt.scope)) throw new GksScopeDeniedError("graph receipt scope does not match the request scope.");
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const batchRow = selectPipelineDecisionById.get(scopeKeyValue, input.receipt.decisionId);
    if (!batchRow) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
    const graphReceiptHash = sha256Json(input.receipt);
    const derivedHash = sha256Json(input.derived);
    const existing = selectPipelineGraphReceiptByDecision.get(scopeKeyValue, input.receipt.decisionId);
    if (existing) {
      if (existing.graph_receipt_hash !== graphReceiptHash || existing.derived_hash !== derivedHash) throw new GksConflictError("decision already has a different graph receipt or enrichment result.");
      return { idempotent: true, graphReceiptHash, derivedHash, derived: JSON.parse(existing.derived_json) };
    }
    if (["FAILED_STAGE", "REJECTED", "PUBLISHED"].includes(batchRow.status)) throw new GksConflictError("pipeline execution is already terminal and cannot accept a graph receipt.");
    if (batchRow.decision_hash !== input.receipt.decisionHash) throw new GksConflictError("graph receipt decisionHash does not match the stored decision.");
    if (batchRow.run_id !== input.receipt.runId) throw new GksConflictError("graph receipt runId does not match the stored decision.");
    const decision = pipelineDecisionFromRow(batchRow);
    if (!sameStageIdentity(decision.stages, input.receipt.stages)) throw new GksConflictError("graph receipt stage identities do not match the stored decision.");
    if (input.receipt.readback.ok !== true) throw new GksConflictError("graph receipt readback must be ok before Stage 13 can terminate.");
    for (const field of ["nodeCount", "edgeCount"]) {
      if (input.receipt.readback[field] !== decision.expectedGraphReadback?.[field]) throw new GksConflictError(`graph receipt ${field} does not match the immutable decision.`);
    }
    if (input.graphReceiptHash !== graphReceiptHash) throw new GksInvalidRequestError("graphReceiptHash does not match the graph receipt payload.");
    if (input.derivedHash !== derivedHash) throw new GksInvalidRequestError("derivedHash does not match the enrichment payload.");
    const now = new Date().toISOString();
    insertPipelineGraphReceipt.run({
      scope_key: scopeKeyValue,
      decision_id: input.receipt.decisionId,
      run_id: input.receipt.runId,
      decision_hash: input.receipt.decisionHash,
      graph_receipt_hash: graphReceiptHash,
      receipt_json: JSON.stringify(input.receipt),
      derived_json: JSON.stringify(input.derived),
      derived_hash: derivedHash,
      created_at: now,
    });
    const graphIdentity = decision.stages.find((stage) => stage.stageNumber === 13);
    pipelineEvidenceRow(input.scope, graphIdentity, "SUCCEEDED", input.receipt.startedAt, input.receipt.finishedAt, input.receipt.metrics, {
      decisionId: decision.decisionId,
      graphReceiptHash,
      nodeCount: input.receipt.readback.nodeCount,
      edgeCount: input.receipt.readback.edgeCount,
    });
    const enrichmentIdentity = decision.stages.find((stage) => stage.stageNumber === 14);
    const enrichmentTimes = input.enrichmentTimes ?? { startedAt: now, finishedAt: now };
    pipelineEvidenceRow(input.scope, enrichmentIdentity, "SUCCEEDED", enrichmentTimes.startedAt, enrichmentTimes.finishedAt, pipelineStageMetrics(decision, 14, {
      durationMs: durationMs(enrichmentTimes),
      recordsIn: decision.entities?.length ?? 0,
      recordsOut: input.derived.length,
      recordsQuarantined: 0,
    }), {
      decisionId: decision.decisionId,
      derivedHash,
      derivedCount: input.derived.length,
      documentCount: input.derived.reduce((sum, row) => sum + row.documentCount, 0),
      chunkCount: input.derived.reduce((sum, row) => sum + row.chunkCount, 0),
      factCount: input.derived.reduce((sum, row) => sum + row.factCount, 0),
    });
    updatePipelineBatchStatus.run({ status: "GRAPH_RECEIPTED", updated_at: now, scope_key: scopeKeyValue, decision_id: decision.decisionId });
    return { idempotent: false, graphReceiptHash, derivedHash, derived: input.derived, status: "GRAPH_RECEIPTED" };
  });

  const transactPipelineWriteReceipt = db.transaction((input) => {
    if (pipelineScopeKey(input.scope) !== pipelineScopeKey(input.receipt.scope)) throw new GksScopeDeniedError("receipt scope does not match the request scope.");
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const batchRow = selectPipelineDecisionById.get(scopeKeyValue, input.receipt.decisionId);
    if (!batchRow) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
    const receiptHash = hashPipelineReceipt(input.receipt);
    const existing = selectPipelineReceiptByDecision.get(scopeKeyValue, input.receipt.decisionId);
    if (existing) {
      if (existing.receipt_hash !== receiptHash) throw new GksConflictError("decision already has a different worker receipt.");
      return { idempotent: true, receiptHash };
    }
    if (["FAILED_STAGE", "REJECTED", "PUBLISHED"].includes(batchRow.status)) throw new GksConflictError("pipeline execution is already terminal and cannot accept a final worker receipt.");
    if (batchRow.decision_hash !== input.receipt.decisionHash) throw new GksConflictError("receipt decisionHash does not match the stored decision.");
    if (batchRow.run_id !== input.receipt.runId) throw new GksConflictError("receipt runId does not match the stored decision.");
    const decision = pipelineDecisionFromRow(batchRow);
    if (!sameStageIdentity(decision.stages, input.receipt.stages)) throw new GksConflictError("receipt stage identities do not match the stored decision.");
    const graphRow = selectPipelineGraphReceiptByDecision.get(scopeKeyValue, input.receipt.decisionId);
    if (!graphRow) throw new GksConflictError("graph receipt is required before the final worker receipt.");
    if (input.receipt.graphReceiptHash !== graphRow.graph_receipt_hash) throw new GksConflictError("receipt graphReceiptHash does not match the stored graph receipt.");
    if (input.receipt.derivedHash !== graphRow.derived_hash) throw new GksConflictError("receipt derivedHash does not match the stored enrichment.");
    const graphReceipt = JSON.parse(graphRow.receipt_json);
    const execution13 = input.receipt.executionTimes[13] ?? input.receipt.executionTimes["13"];
    if (execution13.startedAt !== graphReceipt.startedAt || execution13.finishedAt !== graphReceipt.finishedAt) throw new GksConflictError("receipt executionTimes.13 does not match the graph receipt interval.");
    if (canonicalJsonString(input.receipt.metrics[13]) !== canonicalJsonString(graphReceipt.metrics)) throw new GksConflictError("receipt metrics.13 does not match the graph receipt metrics.");
    const now = new Date().toISOString();
    insertPipelineReceipt.run({ scope_key: scopeKeyValue, decision_id: input.receipt.decisionId, run_id: input.receipt.runId, decision_hash: input.receipt.decisionHash, receipt_hash: receiptHash, receipt_json: JSON.stringify(input.receipt), created_at: now });
    for (const stageNumber of [15, 16]) {
      const identity = input.receipt.stages.find((stage) => stage.stageNumber === stageNumber);
      const execution = input.receipt.executionTimes[stageNumber] ?? input.receipt.executionTimes[String(stageNumber)];
      pipelineEvidenceRow(input.scope, identity, "SUCCEEDED", execution.startedAt, execution.finishedAt, input.receipt.metrics[stageNumber], {
        decisionId: decision.decisionId,
        receiptHash,
        stageNumber,
        readback: input.receipt.readback,
        laneStatuses: Object.fromEntries(Object.entries(input.receipt.laneManifest).map(([lane, value]) => [lane, value.status])),
      });
    }
    updatePipelineBatchStatus.run({ status: "RECEIPT_WRITTEN", updated_at: now, scope_key: scopeKeyValue, decision_id: decision.decisionId });
    return { idempotent: false, receiptHash };
  });

  function claimPipelineDecisions({ scope, limit = 1 } = {}) {
    const rows = selectPipelinePending.all({ scopeKey: pipelineScopeKey(scope), portfolioId: scope.portfolioId, tenantId: scope.tenantId, businessId: scope.businessId, workspaceId: scope.workspaceId, agentId: scope.agentId, visibility: scope.visibility, limit });
    return rows.map((row) => pipelineDecisionFromRow(row));
  }

  function getPipelineDecision({ scope, decisionId }) {
    const row = selectPipelineDecisionById.get(pipelineScopeKey(scope), decisionId);
    return pipelineDecisionFromRow(row);
  }

  function getPipelineReceipt({ scope, decisionId }) {
    const row = selectPipelineReceiptByDecision.get(pipelineScopeKey(scope), decisionId);
    return row ? { ...JSON.parse(row.receipt_json), receiptHash: row.receipt_hash } : null;
  }

  function getPipelineGraphReceipt({ scope, decisionId }) {
    const row = selectPipelineGraphReceiptByDecision.get(pipelineScopeKey(scope), decisionId);
    return row ? {
      ...JSON.parse(row.receipt_json),
      graphReceiptHash: row.graph_receipt_hash,
      derived: JSON.parse(row.derived_json),
      derivedHash: row.derived_hash,
    } : null;
  }

  function getPipelineGate({ scope, decisionId }) {
    const row = selectPipelineGateByDecision.get(pipelineScopeKey(scope), decisionId);
    if (!row) return null;
    // Metrics and timing are persistence bookkeeping used to write the
    // terminal evidence row. They are intentionally kept out of the frozen
    // wire verdict returned on an idempotent gate replay.
    const payload = JSON.parse(row.verdict_json);
    const { metrics: _metrics, gateStartedAt: _startedAt, gateFinishedAt: _finishedAt, ...verdict } = payload;
    return { ...verdict, verdictHash: row.verdict_hash };
  }

  const transactPipelineGate = db.transaction((input) => {
    if (pipelineScopeKey(input.scope) !== pipelineScopeKey(input.verdict.scope)) throw new GksScopeDeniedError("gate verdict scope does not match the request scope.");
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const batchRow = selectPipelineDecisionById.get(scopeKeyValue, input.decisionId);
    if (!batchRow) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
    if (batchRow.decision_hash !== input.decisionHash) throw new GksConflictError("gate decisionHash does not match the stored decision.");
    if (batchRow.status === "FAILED_STAGE" && input.verdict.verdict === "PASS") throw new GksConflictError("pipeline execution has a terminal failed stage.");
    if (input.verdict.receiptHash && selectPipelineReceiptByDecision.get(scopeKeyValue, input.decisionId)?.receipt_hash !== input.verdict.receiptHash) throw new GksConflictError("gate receiptHash does not match the stored worker receipt.");
    const graphReceipt = selectPipelineGraphReceiptByDecision.get(scopeKeyValue, input.decisionId);
    const workerReceipt = selectPipelineReceiptByDecision.get(scopeKeyValue, input.decisionId);
    if (input.verdict.verdict === "PASS" && (!graphReceipt || !workerReceipt || !input.verdict.receiptHash)) throw new GksConflictError("a passing quality gate requires graph and final worker receipts.");
    const verdictPayload = {
      ...input.verdict,
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.startedAt ? { gateStartedAt: input.startedAt } : {}),
      ...(input.finishedAt ? { gateFinishedAt: input.finishedAt } : {}),
    };
    const verdictHash = sha256Json(verdictPayload);
    const existing = selectPipelineGateByDecision.get(scopeKeyValue, input.decisionId);
    if (existing) {
      if (existing.verdict_hash !== verdictHash) throw new GksConflictError("decision already has a different quality gate verdict.");
      return { idempotent: true, verdictHash };
    }
    const now = new Date().toISOString();
    insertPipelineGate.run({ scope_key: scopeKeyValue, decision_id: input.decisionId, decision_hash: input.decisionHash, receipt_hash: input.verdict.receiptHash, verdict_hash: verdictHash, verdict_json: JSON.stringify(verdictPayload), created_at: now });
    const decision = pipelineDecisionFromRow(batchRow);
    if (verdictPayload.allowPublication !== true) {
      const identity = decision.stages.find((stage) => stage.stageNumber === 17);
      pipelineEvidenceRow(input.scope, identity, "FAILED", input.startedAt ?? now, input.finishedAt ?? now, input.metrics ?? pipelineStageMetrics(decision, 17), {
        verdict: verdictPayload,
        publicationReceipt: null,
      });
    }
    updatePipelineBatchStatus.run({ status: input.verdict.allowPublication ? "GATED" : "REJECTED", updated_at: now, scope_key: scopeKeyValue, decision_id: input.decisionId });
    return { idempotent: false, verdictHash };
  });

  const transactPipelinePublicationReceipt = db.transaction((input) => {
    if (pipelineScopeKey(input.scope) !== pipelineScopeKey(input.receipt.scope)) throw new GksScopeDeniedError("publication receipt scope does not match the request scope.");
    const scopeKeyValue = pipelineScopeKey(input.scope);
    const batchRow = selectPipelineDecisionById.get(scopeKeyValue, input.receipt.decisionId);
    if (!batchRow) throw new GksInvalidRequestError("decisionId does not resolve within scope.");
    if (["FAILED_STAGE", "REJECTED"].includes(batchRow.status)) throw new GksConflictError("pipeline execution does not allow publication.");
    if (batchRow.decision_hash !== input.receipt.decisionHash) throw new GksConflictError("publication decisionHash does not match the stored decision.");
    if (batchRow.run_id !== input.receipt.runId) throw new GksConflictError("publication runId does not match the stored decision.");
    const workerReceipt = selectPipelineReceiptByDecision.get(scopeKeyValue, input.receipt.decisionId);
    if (!workerReceipt || workerReceipt.receipt_hash !== input.receipt.receiptHash) throw new GksConflictError("publication receipt does not match the stored worker receipt.");
    const workerPayload = workerReceipt ? JSON.parse(workerReceipt.receipt_json) : null;
    if (workerPayload && (input.receipt.snapshotId !== workerPayload.snapshotId || input.receipt.generation !== workerPayload.generation || input.receipt.modelRevision !== workerPayload.model.revision || input.receipt.transactionFrontier !== workerPayload.transaction.frontier)) throw new GksConflictError("publication receipt does not match the worker snapshot, model or transaction frontier.");
    const gate = selectPipelineGateByDecision.get(scopeKeyValue, input.receipt.decisionId);
    if (!gate) throw new GksConflictError("quality gate is required before publication.");
    const verdict = JSON.parse(gate.verdict_json);
    if (verdict.verdict !== "PASS" || verdict.allowPublication !== true) throw new GksConflictError("quality gate does not allow publication.");
    const publicationHash = hashPipelinePublicationReceipt(input.receipt);
    const existing = selectPipelinePublication.get(scopeKeyValue, input.receipt.decisionId, input.receipt.snapshotId, input.receipt.generation);
    if (existing) {
      if (existing.publication_hash !== publicationHash) throw new GksConflictError("publication identity was reused with a different receipt.");
      return { idempotent: true, publicationHash };
    }
    const now = new Date().toISOString();
    insertPipelinePublication.run({ scope_key: scopeKeyValue, decision_id: input.receipt.decisionId, run_id: input.receipt.runId, snapshot_id: input.receipt.snapshotId, generation: input.receipt.generation, publication_hash: publicationHash, receipt_json: JSON.stringify(input.receipt), created_at: now });
    const decision = pipelineDecisionFromRow(batchRow);
    const identity = decision.stages.find((stage) => stage.stageNumber === 17);
    pipelineEvidenceRow(input.scope, identity, "SUCCEEDED", verdict.gateStartedAt ?? gate.created_at, verdict.gateFinishedAt ?? gate.created_at, verdict.metrics ?? pipelineStageMetrics(decision, 17), { verdict, publicationReceipt: input.receipt });
    updatePipelineBatchStatus.run({ status: "PUBLISHED", updated_at: now, scope_key: scopeKeyValue, decision_id: decision.decisionId });
    return { idempotent: false, publicationHash };
  });

  function exportPipelineEvidence({ scope, runId, afterCursor = 0, limit = 100 } = {}) {
    const scopeKeyValue = pipelineScopeKey(scope);
    const current = currentPipelineEvidenceCursor.get().pipeline_evidence_cursor;
    if (afterCursor > current) throw new GksInvalidRequestError("afterCursor is ahead of the pipeline evidence cursor.");
    const rows = selectPipelineEvidencePage.all({ scopeKey: scopeKeyValue, portfolioId: scope.portfolioId, tenantId: scope.tenantId, businessId: scope.businessId, workspaceId: scope.workspaceId, agentId: scope.agentId, visibility: scope.visibility, runId, afterCursor, limit }).map((row) => ({
      cursor: row.cursor,
      schemaVersion: row.schema_version,
      scope: { portfolioId: row.portfolio_id, tenantId: row.tenant_id, businessId: row.business_id, workspaceId: row.workspace_id, agentId: row.agent_id, visibility: row.visibility },
      runId: row.run_id,
      pipelineStageId: row.pipeline_stage_id,
      executionStepId: row.execution_step_id,
      attemptId: row.attempt_id,
      stageNumber: row.stage_number,
      outcome: row.outcome,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      metrics: JSON.parse(row.metrics_json),
      details: JSON.parse(row.details_json),
    }));
    return { rows, nextCursor: rows.length ? rows[rows.length - 1].cursor : afterCursor };
  }

  return {
    kind: "sqlite",
    health() {
      const row = db.prepare("SELECT version FROM graph_state WHERE singleton = 1").get();
      return { state: "ready", graphVersion: `gks:graph/${row.version}` };
    },
    transactPromotion,
    search({ query, portfolioId }) {
      const pattern = `%${query.toLowerCase()}%`;
      return db.prepare(`SELECT * FROM entities WHERE portfolio_id = ? AND (lower(canonical_ref) LIKE ? OR lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(type) LIKE ?) ORDER BY canonical_ref`).all(portfolioId, pattern, pattern, pattern, pattern).map(entityFromRow);
    },
    getEntity(ref) {
      return entityFromRow(db.prepare("SELECT * FROM entities WHERE canonical_ref = ?").get(ref));
    },
    getRelations(ref) {
      return db.prepare("SELECT * FROM relations WHERE from_ref = ? OR to_ref = ? ORDER BY canonical_ref").all(ref, ref).map(relationFromRow);
    },
    lookupResolutionCandidates({ scope } = {}) {
      if (!scope || typeof scope !== "object" || typeof scope.portfolioId !== "string" || !scope.portfolioId) {
        throw new GksInvalidRequestError("lookupResolutionCandidates requires a scope with a portfolioId.");
      }
      return selectResolutionPool.all({
        portfolioId: scope.portfolioId,
        tenantId: scope.tenantId ?? "",
        businessId: scope.businessId ?? "",
        workspaceId: scope.workspaceId ?? "",
        projectId: scope.projectId ?? "",
      }).map(entityFromRow);
    },
    // D9's read half: the review queue, scope-filtered in SQL exactly like
    // the lookup -- exact portfolio and tenant, same-or-broader below.
    listUnresolvedMentions({ scope } = {}) {
      if (!scope || typeof scope !== "object" || typeof scope.portfolioId !== "string" || !scope.portfolioId) {
        throw new GksInvalidRequestError("listUnresolvedMentions requires a scope with a portfolioId.");
      }
      return selectUnresolvedMentions.all({
        portfolioId: scope.portfolioId,
        tenantId: scope.tenantId ?? "",
        businessId: scope.businessId ?? "",
        workspaceId: scope.workspaceId ?? "",
        projectId: scope.projectId ?? "",
      }).map(mentionFromRow);
    },
    transactHumanResolution,
    transactArtifactLink,
    // Port version 3: the replay-safe, scope-enveloped cursor page. A
    // scopeless call fails closed for the same reason the pool's does -- an
    // unscoped evidence page would be a cross-tenant export.
    exportStageEvidence({ scope, sinceCursor = 0, limit = 100 } = {}) {
      if (!scope || typeof scope !== "object" || typeof scope.portfolioId !== "string" || !scope.portfolioId) {
        throw new GksInvalidRequestError("exportStageEvidence requires a scope with a portfolioId.");
      }
      if (!Number.isInteger(sinceCursor) || sinceCursor < 0) throw new GksInvalidRequestError("sinceCursor must be a non-negative integer.");
      if (!Number.isInteger(limit) || limit < 1) throw new GksInvalidRequestError("limit must be a positive integer.");
      const rows = selectStageEvidencePage.all({
        portfolioId: scope.portfolioId,
        tenantId: scope.tenantId ?? "",
        businessId: scope.businessId ?? "",
        workspaceId: scope.workspaceId ?? "",
        projectId: scope.projectId ?? "",
        sinceCursor,
        limit,
      }).map(stageEvidenceFromRow);
      return { rows, nextCursor: rows.length ? rows[rows.length - 1].cursor : sinceCursor };
    },
    // GenesisRAG17 port operations. The service performs authentication and
    // payload validation; this adapter enforces durable scope/idempotency and
    // receipt ordering inside SQLite transactions.
    transactPipelineSubmit,
    claimPipelineDecisions,
    transactPipelineStageFailure,
    transactPipelineGraphReceipt,
    transactPipelineWriteReceipt,
    transactPipelineGate,
    transactPipelinePublicationReceipt,
    getPipelineDecision,
    getPipelineGraphReceipt,
    getPipelineReceipt,
    getPipelineGate,
    exportPipelineEvidence,
    close() {
      db.close();
    },
  };
}
