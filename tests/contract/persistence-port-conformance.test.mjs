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
    // The D9 review listing fails closed the same way: a scopeless listing
    // would be a cross-tenant review queue.
    expect(() => persistence.listUnresolvedMentions({})).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => persistence.listUnresolvedMentions()).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(persistence.listUnresolvedMentions({ scope: { portfolioId: "portfolio-empty" } })).toEqual([]);
  });
});
