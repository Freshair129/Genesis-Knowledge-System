// Migration 0002 (Stage 9, ADR-GKS-ENTITY-RESOLUTION decision 4): applies to
// a COPY of a populated pre-Stage-9 store, backfills one CREATED mention per
// existing entity (strategy BACKFILL, confidence NULL, decided_at = the
// entity's created_at), populates entities.norm_key via the frozen norm_v1
// module with D2's human-distinct discriminator for collisions, swaps
// UNIQUE(scope_key, candidate_ref) for UNIQUE(scope_key, norm_key), and never
// rewrites a canonical ref.
//
// The seed below reproduces the old store byte-for-byte: schema 0001, old
// entity/promotion rows exactly as the pre-Stage-9 adapter wrote them —
// including the ADR's four-ACME over-split, which is precisely the data
// shape whose norm keys must collide during backfill.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scopeKey } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { HASH_A, scope } from "../fixtures/candidates.mjs";

const SCOPE_A = scope();
const SCOPE_B = scope({ tenantId: "tenant-b" });
const KEY_A = scopeKey(SCOPE_A);
const KEY_B = scopeKey(SCOPE_B);

// The ADR's over-split: four spellings of one company, four digest refs,
// one scope. All norm to "acme". A fifth row in tenant-b proves collision
// tracking is per scope: it keeps the plain key in its own scope.
const SEEDED = [
  { candidateRef: "ACME Corp", canonicalRef: `gks:entity/acme-corp-${"a1".repeat(16)}`, scopeKeyValue: KEY_A, scope: SCOPE_A, idempotencyKey: "acme-1", createdAt: "2026-08-01T00:00:01.000Z" },
  { candidateRef: "Acme Corp.", canonicalRef: `gks:entity/acme-corp-${"b2".repeat(16)}`, scopeKeyValue: KEY_A, scope: SCOPE_A, idempotencyKey: "acme-2", createdAt: "2026-08-01T00:00:02.000Z" },
  { candidateRef: "acme corporation", canonicalRef: `gks:entity/acme-corporation-${"c3".repeat(16)}`, scopeKeyValue: KEY_A, scope: SCOPE_A, idempotencyKey: "acme-3", createdAt: "2026-08-01T00:00:03.000Z" },
  { candidateRef: "ACME_CORP", canonicalRef: `gks:entity/acme-corp-${"d4".repeat(16)}`, scopeKeyValue: KEY_A, scope: SCOPE_A, idempotencyKey: "acme-4", createdAt: "2026-08-01T00:00:04.000Z" },
  { candidateRef: "ACME Corp", canonicalRef: `gks:entity/acme-corp-${"e5".repeat(16)}`, scopeKeyValue: KEY_B, scope: SCOPE_B, idempotencyKey: "acme-b-1", createdAt: "2026-08-01T00:00:05.000Z" },
];

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function seedPreStage9Store() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-migration-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "gks.sqlite");
  const db = new Database(dbPath);
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-08-01T00:00:00.000Z')").run();
  const insertEntity = db.prepare(`
    INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, updated_at, graph_version)
    VALUES (@canonical_ref, @scope_key, @candidate_ref, 'ENTITY', @title, 'Seeded summary.', NULL, NULL, @portfolio_id, @tenant_id, @business_id, @workspace_id, @project_id, @sharing, '{}', @created_at, @created_at, @graph_version)
  `);
  const insertPromotion = db.prepare(`
    INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
    VALUES (@scope_key, @idempotency_key, @knowledge_ref, @source_hash, @provenance_ref, @candidate_json, @canonical_mappings_json, @graph_version, @created_at)
  `);
  SEEDED.forEach((row, index) => {
    const graphVersion = `gks:graph/${index + 1}`;
    insertEntity.run({
      canonical_ref: row.canonicalRef,
      scope_key: row.scopeKeyValue,
      candidate_ref: row.candidateRef,
      title: `Title of ${row.candidateRef}`,
      portfolio_id: row.scope.portfolioId,
      tenant_id: row.scope.tenantId,
      business_id: row.scope.businessId,
      workspace_id: row.scope.workspaceId,
      project_id: row.scope.projectId,
      sharing: row.scope.sharing,
      created_at: row.createdAt,
      graph_version: graphVersion,
    });
    insertPromotion.run({
      scope_key: row.scopeKeyValue,
      idempotency_key: row.idempotencyKey,
      knowledge_ref: `gks:knowledge/gks_knowledge_${row.idempotencyKey}`,
      source_hash: HASH_A,
      provenance_ref: `msp:proof/${row.idempotencyKey}`,
      candidate_json: JSON.stringify({ entities: [{ candidateRef: row.candidateRef, type: "ENTITY", title: `Title of ${row.candidateRef}` }] }),
      canonical_mappings_json: JSON.stringify([{ candidateRef: row.candidateRef, canonicalRef: row.canonicalRef, canonicalType: "ENTITY" }]),
      graph_version: graphVersion,
      created_at: row.createdAt,
    });
  });
  db.prepare("UPDATE graph_state SET version = ? WHERE singleton = 1").run(SEEDED.length);
  db.close();
  return dbPath;
}

function openRaw(dbPath) {
  const raw = new Database(dbPath);
  cleanups.push(() => raw.close());
  return raw;
}

function migrated(dbPath) {
  const persistence = openSqlitePersistence({ dbPath });
  cleanups.push(() => persistence.close());
  return persistence;
}

describe("migration 0002 on a populated pre-Stage-9 store", () => {
  it("backfill_oneCreatedMentionPerEntity_withPromotionProvenanceAndCounts", () => {
    const dbPath = seedPreStage9Store();
    migrated(dbPath).close();
    cleanups.pop();
    const raw = openRaw(dbPath);

    // 0001 + 0002 + 0003 (pending_relations, D10.1 — empty on a fresh
    // migration: pre-Stage-9 stores cannot hold unresolved endpoints).
    expect(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n).toBe(4);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(SEEDED.length);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions").get().n).toBe(SEEDED.length);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM pending_relations").get().n).toBe(0);

    for (const row of SEEDED) {
      const mention = raw.prepare("SELECT * FROM entity_mentions WHERE canonical_ref = ?").get(row.canonicalRef);
      expect(mention).toMatchObject({
        scope_key: row.scopeKeyValue,
        candidate_ref: row.candidateRef,
        norm_key: "acme",
        outcome: "CREATED",
        strategy: "BACKFILL",
        confidence: null,
        decided_at: row.createdAt,
        promotion_idempotency_key: row.idempotencyKey,
        provenance_ref: `msp:proof/${row.idempotencyKey}`,
        field_diffs_json: null,
        portfolio_id: row.scope.portfolioId,
        tenant_id: row.scope.tenantId,
      });
      expect(mention.mention_id.startsWith("gks:mention/")).toBe(true);
    }
  });

  it("backfill_normKeyCollisions_takeTheHumanDistinctDiscriminator_perScope", () => {
    const dbPath = seedPreStage9Store();
    migrated(dbPath).close();
    cleanups.pop();
    const raw = openRaw(dbPath);

    const scopeARows = raw.prepare("SELECT * FROM entities WHERE scope_key = ? ORDER BY created_at").all(KEY_A);
    expect(scopeARows).toHaveLength(4);
    // First arrival keeps the plain key; every later collider is
    // discriminated with ITS OWN backfilled mention's id (D2), so all four
    // historical over-splits stay insertable under UNIQUE(scope_key,
    // norm_key) and no canonical ref changes.
    expect(scopeARows[0].norm_key).toBe("acme");
    for (const collider of scopeARows.slice(1)) {
      const ownMention = raw.prepare("SELECT mention_id FROM entity_mentions WHERE canonical_ref = ?").get(collider.canonical_ref);
      expect(collider.norm_key).toBe(`acme#${ownMention.mention_id}`);
    }
    expect(new Set(scopeARows.map((row) => row.canonical_ref))).toEqual(new Set(SEEDED.filter((row) => row.scopeKeyValue === KEY_A).map((row) => row.canonicalRef)));
    for (const row of scopeARows) expect(row.norm_version).toBe("norm_v1");

    // Collision tracking is per scope: tenant-b's only "acme" keeps the
    // plain key in its own scope.
    const scopeBRow = raw.prepare("SELECT * FROM entities WHERE scope_key = ?").get(KEY_B);
    expect(scopeBRow.norm_key).toBe("acme");
    expect(scopeBRow.norm_version).toBe("norm_v1");
  });

  it("rebuild_dropsCandidateRefUniqueness_andEnforcesNormKeyUniqueness", () => {
    const dbPath = seedPreStage9Store();
    migrated(dbPath).close();
    cleanups.pop();
    const raw = openRaw(dbPath);
    const probe = raw.prepare(`
      INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, aliases_json, external_refs_json, norm_key, norm_version, created_at, updated_at, graph_version)
      VALUES (@canonical_ref, @scope_key, @candidate_ref, 'ENTITY', 'Probe', '', NULL, NULL, 'portfolio-zuri', 'tenant-a', 'business-a', 'workspace-a', 'project-a', 'private', '{}', '[]', '[]', @norm_key, 'norm_v1', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'gks:graph/99')
    `);

    raw.exec("BEGIN");
    try {
      // The old UNIQUE(scope_key, candidate_ref) is gone: a second row with
      // the SAME mention string in the SAME scope inserts cleanly — the
      // mention string is no longer the identity (D1).
      probe.run({ canonical_ref: "gks:entity/probe-1", scope_key: KEY_A, candidate_ref: "ACME Corp", norm_key: "probe one" });
      // The new UNIQUE(scope_key, norm_key) holds: duplicating an existing
      // norm key in the same scope fails.
      expect(() => probe.run({ canonical_ref: "gks:entity/probe-2", scope_key: KEY_A, candidate_ref: "probe two", norm_key: "acme" }))
        .toThrowError(new RegExp("UNIQUE constraint failed: entities.scope_key, entities.norm_key"));
      // And norm_key cannot be NULL — a nullable key under SQLite UNIQUE
      // would readmit unlimited silent duplicates.
      expect(() => probe.run({ canonical_ref: "gks:entity/probe-3", scope_key: KEY_A, candidate_ref: "probe three", norm_key: null }))
        .toThrowError(new RegExp("NOT NULL constraint failed: entities.norm_key"));
    } finally {
      raw.exec("ROLLBACK");
    }
  });

  it("replayAfterMigration_returnsTheFrozenPromotionSnapshot_andReopenIsIdempotent", async () => {
    const dbPath = seedPreStage9Store();
    const persistence = migrated(dbPath);
    const service = createGksService({ persistence });

    // D4: replay reads the promotion snapshot, not the mention table — the
    // pre-migration envelope replays byte-identical after 0002.
    const replay = await service.promoteCandidate({
      schema_version: "govibe-knowledge-candidate/v1",
      idempotency_key: "acme-1",
      run_id: "run-acme-1",
      stage: 1,
      source_snapshot_hash: HASH_A,
      provenance_ref: "msp:proof/acme-1",
      scope: SCOPE_A,
      candidate: { entities: [{ candidateRef: "ACME Corp", type: "ENTITY", title: "Title of ACME Corp" }] },
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.canonical_mappings).toEqual([{ candidateRef: "ACME Corp", canonicalRef: SEEDED[0].canonicalRef, canonicalType: "ENTITY" }]);

    persistence.close();
    cleanups.pop();

    // Reopening does not reapply the migration or duplicate the backfill.
    const reopened = migrated(dbPath);
    expect(reopened.getEntity(SEEDED[0].canonicalRef)).toMatchObject({ normKey: "acme", normVersion: "norm_v1" });
    reopened.close();
    cleanups.pop();
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions").get().n).toBe(SEEDED.length);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n).toBe(4);
  });
});
