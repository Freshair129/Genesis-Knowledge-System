import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-knowledge-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  cleanups.push(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return createGksService({ persistence });
}

describe("canonical knowledge contract", () => {
  it("promotion_entitiesAndRelations_materializesDeduplicatedGraph", async () => {
    const service = runtime();
    const first = await service.promoteCandidate(promotion());
    const feature = first.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");
    const identity = first.canonical_mappings.find((item) => item.candidateRef === "ENTITY-CUSTOMER-IDENTITY");

    const relations = await service.getRelations({ ref: feature.canonicalRef, scope: scope() });
    expect(relations).toEqual([
      expect.objectContaining({ fromRef: feature.canonicalRef, relationType: "DEPENDS_ON", toRef: identity.canonicalRef }),
    ]);

    const second = await service.promoteCandidate(promotion({ idempotency_key: "promotion-2", source_snapshot_hash: "c".repeat(64) }));
    expect(second.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING")?.canonicalRef).toBe(feature.canonicalRef);
    await expect(service.search({ query: "LINE", scope: scope() })).resolves.toHaveLength(1);
  });

  it("artifactLink_validatedByCanonicalKnowledge_isSearchableByReference", async () => {
    const service = runtime();
    const promoted = await service.promoteCandidate(promotion());
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    const link = await service.linkArtifact({
      knowledgeRef: feature.canonicalRef,
      artifactRef: "project:PRJ-ZURI-V2",
      relationType: "RELATED_TO",
      evidenceRef: "msp:proof/artifact-1",
      scope: scope(),
    });

    expect(link).toMatchObject({ canonicalRef: expect.stringMatching(/^gks:artifact-link\//), knowledgeRef: feature.canonicalRef });
  });
});

// GHOST QA finding (2026-08-30): gks_entity_get had only reject coverage and
// gks_health had no behavioural coverage at all.
describe("entity and health read contract", () => {
  it("entityGet_ownScope_returnsTheCanonicalEntity", async () => {
    const service = runtime();
    const promoted = await service.promoteCandidate(promotion());
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    const entity = await service.getEntity({ ref: feature.canonicalRef, scope: scope() });

    expect(entity).toMatchObject({
      canonicalRef: feature.canonicalRef,
      candidateRef: "FEAT-LINE-LINKING",
      type: "FEAT",
      title: "LINE account linking",
      summary: "Links LINE accounts to customer identity.",
      scope: expect.objectContaining({ portfolioId: "portfolio-zuri", tenantId: "tenant-a" }),
      graphVersion: expect.stringMatching(/^gks:graph\//),
    });

    // An unknown ref is null, not an error -- the absence branch callers
    // must handle before trusting a lookup.
    await expect(service.getEntity({ ref: "gks:entity/never-promoted", scope: scope() })).resolves.toBeNull();
  });

  it("health_reportsReadyStateAndGraphVersionThatAdvancesOnlyOnNewWrites", async () => {
    const service = runtime();

    await expect(service.health()).resolves.toEqual({ service: "gks", state: "ready", graphVersion: "gks:graph/0" });

    await service.promoteCandidate(promotion());
    await expect(service.health()).resolves.toEqual({ service: "gks", state: "ready", graphVersion: "gks:graph/1" });

    // An idempotent replay is not a new write and must not move the graph.
    await service.promoteCandidate(promotion());
    await expect(service.health()).resolves.toEqual({ service: "gks", state: "ready", graphVersion: "gks:graph/1" });
  });
});
