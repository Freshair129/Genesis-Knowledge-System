import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

test("crossTenantDefault_DENY prevents search and direct lookup leakage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const promoted = await service.promoteCandidate(promotion({ scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    assert.deepEqual(await service.search({ query: "LINE", scope: tenantB }), []);
    await assert.rejects(service.getEntity({ ref: feature.canonicalRef, scope: tenantB }), { code: "gks_scope_denied" });
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("portfolioShared_withoutMspAuthorizationEvidence_stillDeniesCrossTenant", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-shared-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a", sharing: "portfolio-shared" });
    const tenantB = scope({ tenantId: "tenant-b", sharing: "private" });
    const promoted = await service.promoteCandidate(promotion({ idempotency_key: "shared-no-evidence", scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    assert.deepEqual(await service.search({ query: "LINE", scope: tenantB }), []);
    await assert.rejects(service.getEntity({ ref: feature.canonicalRef, scope: tenantB }), { code: "gks_scope_denied" });
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// GHOST QA finding (2026-08-30): gks_artifact_link is the one write path
// that takes a caller-supplied knowledgeRef, and its cross-tenant deny
// (packages/gks-core/src/index.mjs) was implemented but never tested.
test("crossTenantArtifactLink_foreignKnowledgeRef_isDenied", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-link-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const promoted = await service.promoteCandidate(promotion({ scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");
    const linkRequest = {
      knowledgeRef: feature.canonicalRef,
      artifactRef: "project:PRJ-TENANT-B",
      relationType: "RELATED_TO",
      evidenceRef: "msp:proof/cross-tenant-link",
    };

    await assert.rejects(service.linkArtifact({ ...linkRequest, scope: tenantB }), { code: "gks_scope_denied" });

    // A knowledgeRef that resolves to nothing is invalid input, not a scope
    // probe -- the caller cannot distinguish "foreign" from "absent" by
    // guessing refs that do not exist.
    await assert.rejects(
      service.linkArtifact({ ...linkRequest, knowledgeRef: "gks:entity/never-promoted-00000000", scope: tenantB }),
      { code: "gks_invalid_request" },
    );

    // Positive control: the owner scope succeeds with the same request
    // shape, so the rejections above are scope decisions, not validation.
    const owned = await service.linkArtifact({ ...linkRequest, scope: tenantA });
    assert.match(owned.canonicalRef, /^gks:artifact-link\//);
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// GHOST QA finding (2026-08-30): gks_relations_get had no deny test, and the
// branch where the ref resolves to no entity performs no denial at all --
// pin what a foreign ref and an unresolvable ref each return.
test("crossTenantRelations_foreignRefDenied_unresolvedRefStaysEmpty", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-relations-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const promoted = await service.promoteCandidate(promotion({ scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    // A ref that resolves to a foreign entity is denied outright.
    await assert.rejects(service.getRelations({ ref: feature.canonicalRef, scope: tenantB }), { code: "gks_scope_denied" });

    // A ref that resolves to no entity is NOT denied -- there is no entity to
    // anchor the deny -- so pin the actual behaviour: the per-relation
    // visibility filter leaves nothing, and the caller learns only "empty".
    assert.deepEqual(await service.getRelations({ ref: "gks:entity/never-promoted-00000000", scope: tenantB }), []);

    // Positive control: the owner still reads the relation, so the deny and
    // the empty result above are scope decisions, not a broken read path.
    const owned = await service.getRelations({ ref: feature.canonicalRef, scope: tenantA });
    assert.equal(owned.length, 1);
    assert.equal(owned[0].relationType, "DEPENDS_ON");
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// GHOST QA finding (2026-08-30): prove the by-construction property that a
// tenant-B promotion reusing tenant A's candidateRefs (and even its
// idempotency_key) salts into tenant B's own canonical space and can never
// attach relations to -- or replay against -- tenant A's graph.
test("crossTenantPromotion_sameCandidate_saltsIntoDisjointCanonicalSpaces", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-salt-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const promotedA = await service.promoteCandidate(promotion({ scope: tenantA }));
    const promotedB = await service.promoteCandidate(promotion({ scope: tenantB }));

    // Same idempotency_key, same candidate refs -- but tenant B's promotion
    // is a first write in its own scope, never a replay of tenant A's.
    assert.equal(promotedB.idempotent, false);
    assert.notEqual(promotedB.knowledge_ref, promotedA.knowledge_ref);

    const refA = Object.fromEntries(promotedA.canonical_mappings.map((m) => [m.candidateRef, m.canonicalRef]));
    const refB = Object.fromEntries(promotedB.canonical_mappings.map((m) => [m.candidateRef, m.canonicalRef]));
    for (const candidateRef of Object.keys(refA)) {
      assert.notEqual(refB[candidateRef], refA[candidateRef]);
    }

    // Tenant B's stored relation endpoints are tenant B's canonical refs --
    // the relation never touches tenant A's graph nodes.
    const relationsB = await service.getRelations({ ref: refB["FEAT-LINE-LINKING"], scope: tenantB });
    assert.equal(relationsB.length, 1);
    assert.equal(relationsB[0].fromRef, refB["FEAT-LINE-LINKING"]);
    assert.equal(relationsB[0].toRef, refB["ENTITY-CUSTOMER-IDENTITY"]);

    // Each tenant's search sees exactly its own copy.
    const searchA = await service.search({ query: "LINE", scope: tenantA });
    const searchB = await service.search({ query: "LINE", scope: tenantB });
    assert.deepEqual(searchA.map((entity) => entity.canonicalRef), [refA["FEAT-LINE-LINKING"]]);
    assert.deepEqual(searchB.map((entity) => entity.canonicalRef), [refB["FEAT-LINE-LINKING"]]);

    // And naming tenant A's canonical ref outright inside the candidate is
    // rejected before anything is written.
    await assert.rejects(
      service.promoteCandidate(promotion({
        idempotency_key: "forged-endpoint",
        scope: tenantB,
        candidate: {
          entities: [{ candidateRef: "FEAT-LINE-LINKING", type: "FEAT", title: "LINE account linking", summary: "" }],
          relations: [{ fromRef: "FEAT-LINE-LINKING", relationType: "DEPENDS_ON", toRef: refA["ENTITY-CUSTOMER-IDENTITY"] }],
        },
      })),
      { code: "gks_invalid_request" },
    );
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
