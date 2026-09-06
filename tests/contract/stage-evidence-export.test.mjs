// ADR-GKS-LEDGER-REPORTING (0.2.0b, accepted) D2/D4 and GKS-PORT-CONTRACT
// port version 3: the acceptance suite for gks_stage_evidence_export and the
// stage_evidence rows Stage 9 now writes.
//
// Every obligation the ADR and the port contract state becomes a test here:
// one row per execution (a replay is not one), the six NFR-020 metrics zero
// not absent, evidence always an object and records always an array, the
// scope predicate in SQL, per-scope cursors with no wildcard, commit-time
// cursor assignment, the run_id binding a puller attributes by, HUMAN and
// BACKFILL evidence on the same export path (the ADR's Task 1 finding), and
// the migration-0005 backfill of every pre-existing promotion and decision.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ENTITY_RESOLVE_STAGE_ID,
  KNOWLEDGE_INGESTION_CONTRACT_ID,
  KNOWLEDGE_INGESTION_DEFINITION_ID,
  STAGE_EVIDENCE_METRICS,
  scopeKey,
} from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

const MIGRATIONS_DIR = path.resolve("migrations");
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-evidence-"));
  const dbPath = path.join(dir, "gks.sqlite");
  const persistence = openSqlitePersistence({ dbPath });
  cleanups.push(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service: createGksService({ persistence }), persistence, dbPath, dir };
}

let hashCounter = 0x7000;
function envelope(idempotencyKey, entities, overrides = {}) {
  hashCounter += 1;
  return promotion({
    idempotency_key: idempotencyKey,
    provenance_ref: `msp:proof/${idempotencyKey}`,
    source_snapshot_hash: hashCounter.toString(16).padStart(64, "0"),
    candidate: { entities },
    ...overrides,
  });
}

const entity = (candidateRef, overrides = {}) => ({ candidateRef, type: "ENTITY", title: candidateRef, ...overrides });

describe("stage_evidence: one row per Stage 9 execution, bound to the caller's run", () => {
  it("promotion_writesOneEvidenceRow_withTheSixMetricsAndTheRunId", async () => {
    const { service } = runtime();
    const tenant = scope({ tenantId: "tenant-ev" });
    await service.promoteCandidate(envelope("ev-1", [entity("ACME Corp"), entity("ACME Industrial Corp")], {
      scope: tenant,
      run_id: "run-zuri-0001",
      pipeline_stage_id: "DPS-KI-ENTITY-RESOLVE",
    }));
    // A second execution whose one candidate contradicts a stored title is
    // held for review: its row counts it quarantined, not written.
    await service.promoteCandidate(envelope("ev-2", [entity("ACME Corp", { title: "A Different Company" })], {
      scope: tenant,
      run_id: "run-zuri-0002",
    }));

    const page = await service.exportStageEvidence({ scope: tenant });
    expect(page.rows).toHaveLength(2);
    expect(page.next_cursor).toBe(2);
    const [row, held] = page.rows;
    expect(row).toMatchObject({
      cursor: 1,
      pipeline_stage_id: ENTITY_RESOLVE_STAGE_ID,
      pipeline_definition_id: KNOWLEDGE_INGESTION_DEFINITION_ID,
      execution_contract_id: KNOWLEDGE_INGESTION_CONTRACT_ID,
      run_id: "run-zuri-0001",
      provenance_ref: "msp:proof/ev-1",
      scope: tenant,
      records: [],
    });
    expect(row.evidence_id).toMatch(/^gks:evidence\/[a-f0-9]{32}$/);
    expect(Object.keys(row.metrics).sort()).toEqual([...STAGE_EVIDENCE_METRICS].sort());
    for (const name of STAGE_EVIDENCE_METRICS) expect(typeof row.metrics[name]).toBe("number");
    expect(row.metrics).toMatchObject({ records_in: 2, records_out: 2, records_quarantined: 0, records_failed: 0, retry_count: 0 });
    expect(row.evidence.outcomes).toMatchObject({ CREATED: 2, REVIEW_REQUIRED: 0 });
    expect(row.evidence.strategies.CREATED).toBe(2);
    expect(row.evidence.automerge_floor).toBe(0.85);
    expect(row.evidence.requested_pipeline_stage_id).toBe("DPS-KI-ENTITY-RESOLVE");
    expect(row.evidence.knowledge_ref).toMatch(/^gks:knowledge\//);
    expect(typeof row.produced_at).toBe("string");

    expect(held).toMatchObject({ cursor: 2, run_id: "run-zuri-0002", provenance_ref: "msp:proof/ev-2" });
    expect(held.metrics).toMatchObject({ records_in: 1, records_out: 0, records_quarantined: 1, records_failed: 0 });
    expect(held.evidence.outcomes).toMatchObject({ REVIEW_REQUIRED: 1 });
    expect(held.evidence.requested_pipeline_stage_id).toBeNull();
  });

  it("idempotentReplay_isNotAnExecution_andWritesNoSecondRow", async () => {
    const { service } = runtime();
    const tenant = scope({ tenantId: "tenant-replay" });
    const request = envelope("ev-replay", [entity("Replay Co")], { scope: tenant, run_id: "run-replay" });
    await service.promoteCandidate(request);
    const again = await service.promoteCandidate(request);
    expect(again.idempotent).toBe(true);

    const page = await service.exportStageEvidence({ scope: tenant });
    expect(page.rows).toHaveLength(1);
  });

  it("metricsReportZero_neverAbsent_evenWhenEveryCandidateIsRejected", async () => {
    const { service } = runtime();
    const tenant = scope({ tenantId: "tenant-zero" });
    // A resolveTo claim naming an entity that does not exist in the pool is
    // REJECTED by the CANONICAL_REF rung: an execution with nothing written.
    await service.promoteCandidate(envelope("ev-zero", [entity("Nobody", { resolveTo: "gks:entity/nobody-00000000000000000000000000000000" })], { scope: tenant, run_id: "run-zero" }));
    const [row] = (await service.exportStageEvidence({ scope: tenant })).rows;
    expect(row.metrics).toEqual({ records_in: 1, records_out: 0, records_failed: 1, records_quarantined: 0, processing_time_ms: row.metrics.processing_time_ms, retry_count: 0 });
    expect(row.evidence).toEqual(expect.any(Object));
    expect(row.records).toEqual([]);
  });

  it("humanDecisions_bindAndMerge_writeEvidenceRowsOnTheSameExportPath", async () => {
    const { service } = runtime();
    const tenant = scope({ tenantId: "tenant-human" });
    const first = await service.promoteCandidate(envelope("h-1", [entity("ACME Corp"), entity("ACME Industrial Corp")], { scope: tenant, run_id: "run-h1" }));
    const [refA, refB] = first.canonical_mappings.map((mapping) => mapping.canonicalRef);
    await service.promoteCandidate(envelope("h-2", [entity("ACME Corp", { title: "A Different Company" })], { scope: tenant, run_id: "run-h2" }));
    const [mention] = await service.listUnresolvedMentions({ scope: tenant });

    await service.applyHumanResolution({ action: "BIND", mentionId: mention.mentionId, canonicalRef: refA, provenanceRef: "msp:proof/h-bind", scope: tenant });
    await service.applyHumanResolution({ action: "MERGE", survivorRef: refA, supersededRef: refB, provenanceRef: "msp:proof/h-merge", scope: tenant });

    const rows = (await service.exportStageEvidence({ scope: tenant })).rows;
    expect(rows.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);
    const [, , bind, merge] = rows;
    expect(bind).toMatchObject({
      pipeline_stage_id: ENTITY_RESOLVE_STAGE_ID,
      run_id: null,
      provenance_ref: "msp:proof/h-bind",
      evidence: { action: "BIND", strategy: "HUMAN", outcome: "MATCHED", canonical_ref: refA, mention_id: mention.mentionId },
      metrics: expect.objectContaining({ records_in: 1, records_out: 1 }),
    });
    expect(merge).toMatchObject({
      run_id: null,
      provenance_ref: "msp:proof/h-merge",
      evidence: { action: "MERGE", strategy: "HUMAN", canonical_ref: refA, superseded_ref: refB },
      metrics: expect.objectContaining({ records_in: 2, records_out: 1 }),
    });
    expect(merge.evidence.decision_id).toMatch(/^gks:decision\//);
  });
});

describe("gks_stage_evidence_export: scope in SQL, per-scope cursors, bounded pages", () => {
  it("scopePredicateRunsInSql_foreignTenantSeesNothing_tenantlessIsATenantOfItsOwn", async () => {
    const { service, persistence } = runtime();
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const tenantless = scope({ tenantId: "" });
    await service.promoteCandidate(envelope("s-a", [entity("Scope A")], { scope: tenantA, run_id: "run-a" }));
    await service.promoteCandidate(envelope("s-none", [entity("Scope None")], { scope: tenantless, run_id: "run-none" }));

    expect((await service.exportStageEvidence({ scope: tenantB })).rows).toEqual([]);
    expect((await service.exportStageEvidence({ scope: tenantA })).rows.map((row) => row.run_id)).toEqual(["run-a"]);
    expect((await service.exportStageEvidence({ scope: tenantless })).rows.map((row) => row.run_id)).toEqual(["run-none"]);
    // The adapter itself answers the same way: the predicate is not a
    // service-layer filter over a broader read.
    expect(persistence.exportStageEvidence({ scope: tenantB }).rows).toEqual([]);
  });

  it("broaderScopeRowsAreVisibleToANarrowerRequest_neverTheReverse", async () => {
    const { service } = runtime();
    const business = scope({ tenantId: "tenant-w", businessId: "", workspaceId: "", projectId: "" });
    const project = scope({ tenantId: "tenant-w" });
    await service.promoteCandidate(envelope("w-broad", [entity("Tenant Wide")], { scope: business, run_id: "run-broad" }));
    await service.promoteCandidate(envelope("w-narrow", [entity("Project Only")], { scope: project, run_id: "run-narrow" }));

    expect((await service.exportStageEvidence({ scope: project })).rows.map((row) => row.run_id)).toEqual(["run-broad", "run-narrow"]);
    expect((await service.exportStageEvidence({ scope: business })).rows.map((row) => row.run_id)).toEqual(["run-broad"]);
  });

  it("pagesAreBounded_cursorsAreMonotonic_andAnyEarlierCursorRereadsTheSameRows", async () => {
    const { service } = runtime();
    const tenant = scope({ tenantId: "tenant-page" });
    for (let index = 1; index <= 5; index += 1) {
      await service.promoteCandidate(envelope(`p-${index}`, [entity(`Page ${index}`)], { scope: tenant, run_id: `run-p${index}` }));
    }
    const first = await service.exportStageEvidence({ scope: tenant, limit: 2 });
    expect(first.rows.map((row) => row.cursor)).toEqual([1, 2]);
    expect(first.next_cursor).toBe(2);
    const second = await service.exportStageEvidence({ scope: tenant, since_cursor: first.next_cursor, limit: 2 });
    expect(second.rows.map((row) => row.cursor)).toEqual([3, 4]);
    const third = await service.exportStageEvidence({ scope: tenant, since_cursor: second.next_cursor, limit: 2 });
    expect(third.rows.map((row) => row.cursor)).toEqual([5]);
    expect(third.next_cursor).toBe(5);
    const done = await service.exportStageEvidence({ scope: tenant, since_cursor: 5 });
    expect(done).toEqual({ rows: [], next_cursor: 5 });
    expect(await service.exportStageEvidence({ scope: tenant, limit: 2 })).toEqual(first);
  });

  it("requestValidation_failsClosed_onMissingScopeBadCursorOrOversizedLimit", async () => {
    const { service } = runtime();
    await expect(service.exportStageEvidence({})).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    await expect(service.exportStageEvidence({ scope: { tenantId: "no-portfolio" } })).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    await expect(service.exportStageEvidence({ scope: scope(), since_cursor: -1 })).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    await expect(service.exportStageEvidence({ scope: scope(), since_cursor: 1.5 })).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    await expect(service.exportStageEvidence({ scope: scope(), limit: 0 })).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    await expect(service.exportStageEvidence({ scope: scope(), limit: 501 })).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });
});

describe("migration 0005: every pre-existing promotion and decision is backfilled, in order", () => {
  it("storeWrittenBeforeTheTable_gainsOneRowPerExecution_onUpgrade", async () => {
    // Build a pre-0005 store exactly the way the adapter's own runMigrations
    // would have on 2026-09-06: apply 0001-0004 raw (0002's hook, with zero
    // entities to copy, reduces to its DDL tail) and record them applied.
    // The current adapter cannot open a pre-0005 store itself -- it prepares
    // the stage_evidence statements eagerly -- which is the point: the
    // upgrade below is what makes that store openable again.
    const dir = mkdtempSync(path.join(tmpdir(), "gks-backfill-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "gks.sqlite");
    const tenant = scope({ tenantId: "tenant-legacy" });
    const legacyScopeKey = scopeKey(tenant);
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const name of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql") && entry < "0005").sort()) {
      raw.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      if (name === "0002_entity_resolution.sql") {
        raw.exec("DROP TABLE entities; ALTER TABLE entities_stage9 RENAME TO entities; CREATE INDEX idx_entities_search ON entities (portfolio_id, type, title, canonical_ref); CREATE INDEX idx_entities_pool ON entities (portfolio_id, tenant_id, business_id, workspace_id, project_id);");
      }
      raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, "2026-09-06T00:00:00.000Z");
    }
    raw.prepare(`INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
      VALUES (@scope_key, 'legacy-1', 'gks:knowledge/legacy', @hash, 'msp:proof/legacy-1', '{}', @mappings, 'gks:graph/1', '2026-08-30T00:00:00.000Z')`).run({
      scope_key: legacyScopeKey,
      hash: "a".repeat(64),
      mappings: JSON.stringify([
        { candidateRef: "Legacy One", canonicalRef: "gks:entity/legacy-one-00000000000000000000000000000000", canonicalType: "ENTITY", resolution: { outcome: "CREATED", strategy: "CREATED", confidence: 1 } },
        { candidateRef: "Legacy Two", canonicalRef: null, canonicalType: "ENTITY", resolution: { outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null } },
      ]),
    });
    raw.prepare(`INSERT INTO human_resolutions (decision_id, action, scope_key, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, mention_id, canonical_ref, superseded_ref, provenance_ref, graph_version, created_at)
      VALUES ('gks:decision/legacy', 'MERGE', @scope_key, @portfolio, @tenant, @business, @workspace, @project, @sharing, NULL, 'gks:entity/legacy-one-00000000000000000000000000000000', 'gks:entity/legacy-two-00000000000000000000000000000000', 'msp:proof/legacy-merge', 'gks:graph/2', '2026-08-30T01:00:00.000Z')`).run({
      scope_key: legacyScopeKey,
      portfolio: tenant.portfolioId, tenant: tenant.tenantId, business: tenant.businessId, workspace: tenant.workspaceId, project: tenant.projectId, sharing: tenant.sharing,
    });
    raw.close();

    // Upgrade: the current migration set applies 0005 and its hook.
    const upgraded = openSqlitePersistence({ dbPath });
    cleanups.push(() => upgraded.close());
    const service = createGksService({ persistence: upgraded });
    const page = await service.exportStageEvidence({ scope: tenant });
    expect(page.rows.map((row) => [row.cursor, row.run_id, row.evidence.backfilled_from])).toEqual([
      [1, null, "promotions"],
      [2, null, "human_resolutions"],
    ]);
    expect(page.rows[0].metrics).toMatchObject({ records_in: 2, records_out: 1, records_failed: 1, records_quarantined: 0, processing_time_ms: 0, retry_count: 0 });
    expect(page.rows[0].evidence.strategies).toMatchObject({ CREATED: 1, CANONICAL_REF: 1 });
    expect(page.rows[1].evidence).toMatchObject({ action: "MERGE", strategy: "HUMAN" });

    // The live counter continues after the backfilled cursors, so a new
    // execution never reuses one.
    await service.promoteCandidate(envelope("after-upgrade", [entity("After Upgrade")], { scope: tenant, run_id: "run-after" }));
    const after = await service.exportStageEvidence({ scope: tenant, since_cursor: 2 });
    expect(after.rows.map((row) => [row.cursor, row.run_id])).toEqual([[3, "run-after"]]);
  });
});
