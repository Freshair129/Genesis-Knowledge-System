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
