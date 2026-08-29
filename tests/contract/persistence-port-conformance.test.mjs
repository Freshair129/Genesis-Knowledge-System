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
const PORT_V2_OPERATIONS = [
  "health",
  "transactPromotion",
  "search",
  "getEntity",
  "getRelations",
  "transactArtifactLink",
  "lookupResolutionCandidates",
  "close",
];

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

  it("adapter_completeSurface_isAcceptedWithoutNamingItsTechnology", () => {
    const adapter = adapterWith(PORT_V2_OPERATIONS);

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
  });
});
