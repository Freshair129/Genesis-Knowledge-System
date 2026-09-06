import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGksPersistencePort } from "@freshair129/gks-contracts";
import { openSqlitePersistence } from "@freshair129/gks-persistence";

// Port version 2 (docs/GKS-PORT-CONTRACT.md, ADR-GKS-ENTITY-RESOLUTION D8).
// This list previously had seven operations; Stage 9 adds
// lookupResolutionCandidates and the break is taken openly HERE, in the test
// every adapter author runs, rather than discovered by one of them.
// D9 (decision 6: inside Stage 9) adds listUnresolvedMentions and
// transactHumanResolution to the same port version, for the same D8 reason:
// optional would mean an adapter can ship the refusal half of the safety
// valve with no repair half.
const PORT_V2_OPERATIONS = [
  "health",
  "transactPromotion",
  "search",
  "getEntity",
  "getRelations",
  "transactArtifactLink",
  "lookupResolutionCandidates",
  "listUnresolvedMentions",
  "transactHumanResolution",
  "close",
];

// Port version 3 (docs/GKS-PORT-CONTRACT.md, ADR-GKS-LEDGER-REPORTING D4):
// exportStageEvidence joins the required surface. The break is taken here,
// openly, for the same reason the lookup's was: an adapter without it can
// report no Tier-3 evidence at all.
const PORT_V3_OPERATIONS = [...PORT_V2_OPERATIONS.slice(0, -1), "exportStageEvidence", "close"];

function adapterWith(names) {
  return Object.fromEntries(names.map((name) => [name, () => undefined]));
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe("GksPersistencePort replacement contract", () => {
  it("adapter_missingRequiredOperation_isRejectedBeforeServiceUse", () => {
    expect(() => assertGksPersistencePort({ health() {} })).toThrowError(expect.objectContaining({ code: "gks_invalid_backend_response" }));
  });

  // The deliberate port v2 break: a port-v1 adapter -- complete yesterday --
  // is rejected today. Making the lookup optional would reintroduce
  // digest-only identity as a supported configuration named "degraded",
  // which is precisely the defect Stage 9 exists to fix.
  it("adapter_portV1SurfaceWithoutResolutionLookup_isRejected", () => {
    const portV1 = adapterWith(PORT_V2_OPERATIONS.filter((name) => name !== "lookupResolutionCandidates"));

    expect(() => assertGksPersistencePort(portV1)).toThrowError(
      expect.objectContaining({ code: "gks_invalid_backend_response", message: expect.stringContaining("lookupResolutionCandidates") })
    );
  });

  // Same deliberate break for D9: a resolver-only adapter (port v2 as first
  // recorded, without the unresolved-mention consumer) is rejected -- it
  // could refuse merges but never repair them.
  it("adapter_resolverOnlySurfaceWithoutTheD9Consumer_isRejected", () => {
    const resolverOnly = adapterWith(PORT_V2_OPERATIONS.filter((name) => name !== "listUnresolvedMentions" && name !== "transactHumanResolution"));

    expect(() => assertGksPersistencePort(resolverOnly)).toThrowError(
      expect.objectContaining({ code: "gks_invalid_backend_response", message: expect.stringContaining("transactHumanResolution") })
    );
  });

  // The deliberate port v3 break: a port-v2 adapter -- complete yesterday --
  // is rejected today, naming the operation it lacks.
  it("adapter_portV2SurfaceWithoutEvidenceExport_isRejected", () => {
    const portV2 = adapterWith(PORT_V2_OPERATIONS);

    expect(() => assertGksPersistencePort(portV2)).toThrowError(
      expect.objectContaining({ code: "gks_invalid_backend_response", message: expect.stringContaining("exportStageEvidence") })
    );
  });

  it("adapter_completeSurface_isAcceptedWithoutNamingItsTechnology", () => {
    const adapter = adapterWith(PORT_V3_OPERATIONS);

    expect(assertGksPersistencePort(adapter)).toBe(adapter);
  });

  // The shipped SQLite adapter satisfies port v2: the Stage 9 schema step
  // landed its pool SQL, so the lookup answers a scoped query -- and still
  // fails closed on a scopeless one, because a pool with no scope is the
  // cross-tenant merge surface the operation exists to prevent.
  it("sqliteAdapter_satisfiesPortV2_andLookupRequiresAScope", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-port-"));
    const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
    cleanups.push(() => {
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    });

    expect(assertGksPersistencePort(persistence)).toBe(persistence);
    expect(() => persistence.lookupResolutionCandidates({})).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => persistence.lookupResolutionCandidates()).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(persistence.lookupResolutionCandidates({ scope: { portfolioId: "portfolio-empty" } })).toEqual([]);
    // The D9 review listing fails closed the same way: a scopeless listing
    // would be a cross-tenant review queue.
    expect(() => persistence.listUnresolvedMentions({})).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => persistence.listUnresolvedMentions()).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(persistence.listUnresolvedMentions({ scope: { portfolioId: "portfolio-empty" } })).toEqual([]);
    // Port v3: the evidence export fails closed the same way -- a scopeless
    // page would be a cross-tenant export -- and an empty scope pages to
    // nothing with the cursor unchanged.
    expect(() => persistence.exportStageEvidence({})).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => persistence.exportStageEvidence()).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(persistence.exportStageEvidence({ scope: { portfolioId: "portfolio-empty" }, sinceCursor: 7 })).toEqual({ rows: [], nextCursor: 7 });
  });

  // Port v3 behavioural requirement (GKS-PORT-CONTRACT, ledger ADR D2):
  // cursors are assigned at commit time, in commit order, and a transaction
  // that never commits leaves no cursor behind -- so a puller that advanced
  // past N can never later meet a row below N, and never waits on a hole.
  it("sqliteAdapter_assignsEvidenceCursorsAtCommitTime_monotonicAndHoleFree", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-port-cursor-"));
    const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
    cleanups.push(() => {
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const { createGksService } = await import("@freshair129/gks-core");
    const { promotion, scope } = await import("../fixtures/candidates.mjs");
    const { scopeKey } = await import("@freshair129/gks-contracts");
    const Database = (await import("better-sqlite3")).default;
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-cursor" });
    const envelope = (key, entities) => promotion({ idempotency_key: key, provenance_ref: `msp:proof/${key}`, scope: tenantA, candidate: { entities } });
    const counter = () => {
      const raw = new Database(path.join(dir, "gks.sqlite"), { readonly: true });
      try { return raw.prepare("SELECT evidence_cursor FROM graph_state WHERE singleton = 1").get().evidence_cursor; } finally { raw.close(); }
    };

    await service.promoteCandidate(envelope("cur-1", [{ candidateRef: "Cursor One", type: "ENTITY", title: "Cursor One" }]));
    expect(counter()).toBe(1);

    // A write that takes its cursor inside its transaction and then fails
    // before commit: the evidence write itself rejects an impossible metric
    // (retry_count -1) AFTER the counter moved. The transaction rolls back,
    // the counter with it -- no row, no hole, and the next execution gets
    // exactly the number this one gave back.
    await expect(Promise.resolve().then(() => persistence.transactPromotion({
      scope: tenantA,
      scopeKey: scopeKey(tenantA),
      idempotencyKey: "cur-rollback",
      knowledgeRef: "gks:knowledge/cur-rollback",
      sourceHash: "b".repeat(64),
      provenanceRef: "msp:proof/cur-rollback",
      candidate: {},
      entities: [],
      relations: [],
      pendingRelations: [],
      canonicalMappings: [],
      stageEvidence: { pipelineStageId: "DPS-KI-ENTITY-RESOLVE", runId: "run-rollback", startedAt: Date.now(), retryCount: -1 },
    }))).rejects.toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(counter()).toBe(1);
    expect(persistence.exportStageEvidence({ scope: tenantA, sinceCursor: 0, limit: 10 }).rows.map((row) => row.cursor)).toEqual([1]);

    await service.promoteCandidate(envelope("cur-2", [{ candidateRef: "Cursor Three", type: "ENTITY", title: "Cursor Three" }]));
    // An idempotent replay is not an execution and takes no cursor.
    await service.promoteCandidate(envelope("cur-2", [{ candidateRef: "Cursor Three", type: "ENTITY", title: "Cursor Three" }]));
    expect(counter()).toBe(2);

    const page = persistence.exportStageEvidence({ scope: tenantA, sinceCursor: 0, limit: 10 });
    expect(page.rows.map((row) => row.cursor)).toEqual([1, 2]);
    expect(page.nextCursor).toBe(2);
    // Re-reading any earlier cursor returns the same rows in the same order.
    expect(persistence.exportStageEvidence({ scope: tenantA, sinceCursor: 1, limit: 10 }).rows.map((row) => row.cursor)).toEqual([2]);
    expect(persistence.exportStageEvidence({ scope: tenantA, sinceCursor: 2, limit: 10 })).toEqual({ rows: [], nextCursor: 2 });
  });
});
