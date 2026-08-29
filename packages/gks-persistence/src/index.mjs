import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GksBackendUnavailableError, GksConflictError } from "@freshair129/gks-contracts/errors";

const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function requireAbsolutePath(dbPath) {
  if (typeof dbPath !== "string" || !path.isAbsolute(dbPath)) throw new GksBackendUnavailableError("GKS_DB_PATH must be an absolute path.");
  return dbPath;
}

function runMigrations(db, migrationsDir) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name);
  const appliedSet = new Set(applied);
  const apply = db.transaction((name, sql) => {
    db.exec(sql);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    graphVersion: row.graph_version,
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
  const upsertEntity = db.prepare(`
    INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, updated_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @candidate_ref, @type, @title, @summary, @source_ref, @confidence, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @metadata_json, @created_at, @updated_at, @graph_version)
    ON CONFLICT(scope_key, candidate_ref) DO UPDATE SET title = excluded.title, summary = excluded.summary, source_ref = excluded.source_ref, confidence = excluded.confidence, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, graph_version = excluded.graph_version
  `);
  const insertRelation = db.prepare(`
    INSERT INTO relations (canonical_ref, scope_key, from_ref, relation_type, to_ref, confidence, evidence_ref, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @from_ref, @relation_type, @to_ref, @confidence, @evidence_ref, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, @metadata_json, @created_at, @graph_version)
    ON CONFLICT(scope_key, from_ref, relation_type, to_ref) DO NOTHING
  `);
  const insertPromotion = db.prepare(`
    INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
    VALUES (@scope_key, @idempotency_key, @knowledge_ref, @source_hash, @provenance_ref, @candidate_json, @canonical_mappings_json, @graph_version, @created_at)
  `);

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
      upsertEntity.run({
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
        created_at: now,
        updated_at: now,
        graph_version: graphVersion,
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
    return { idempotent: false, knowledgeRef: input.knowledgeRef, sourceHash: input.sourceHash, graphVersion, canonicalMappings: input.canonicalMappings };
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
    transactArtifactLink,
    close() {
      db.close();
    },
  };
}
