import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GksBackendUnavailableError, GksConflictError, GksInvalidRequestError, GksNormKeyConflictError } from "@freshair129/gks-contracts/errors";
import { NORM_VERSION, normKey } from "@freshair129/gks-contracts/norm-v1";

const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function requireAbsolutePath(dbPath) {
  if (typeof dbPath !== "string" || !path.isAbsolute(dbPath)) throw new GksBackendUnavailableError("GKS_DB_PATH must be an absolute path.");
  return dbPath;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

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

// Data movement that a plain .sql file cannot express (it needs the frozen
// norm_v1 module) runs here, keyed by migration file name, inside the same
// transaction that applies the file and records it as applied.
const MIGRATION_HOOKS = {
  "0002_entity_resolution.sql": backfillEntityResolution,
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
  const insertPromotion = db.prepare(`
    INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
    VALUES (@scope_key, @idempotency_key, @knowledge_ref, @source_hash, @provenance_ref, @candidate_json, @canonical_mappings_json, @graph_version, @created_at)
  `);

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
      const stored = selectEntityByRef.get(entity.canonicalRef);
      let fieldDiffs = null;
      if (stored) {
        const diffs = fillExistingEntity(stored, entity, now, graphVersion);
        if (diffs.length) fieldDiffs = JSON.stringify(diffs);
      } else {
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
        canonical_ref: entity.canonicalRef,
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
  const selectResolutionPool = db.prepare(`
    SELECT * FROM entities
    WHERE portfolio_id = @portfolioId
      AND tenant_id = @tenantId
      AND (business_id = '' OR business_id = @businessId)
      AND (workspace_id = '' OR workspace_id = @workspaceId)
      AND (project_id = '' OR project_id = @projectId)
    ORDER BY created_at, canonical_ref
  `);

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
    transactArtifactLink,
    close() {
      db.close();
    },
  };
}
