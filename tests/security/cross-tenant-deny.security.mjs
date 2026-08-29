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

// Stage 9 (ADR-GKS-ENTITY-RESOLUTION D5, decision 8): the resolution pool is
// the read whose consumer is a MERGE, so the tenant wall must hold inside
// the SQL predicate itself -- portfolio and tenant by exact equality, with
// an empty tenant_id a tenant of its own, never a wildcard. This is the
// pool-level half of the ADR's security case; the resolver-level half ("a
// candidate in tenant B never RESOLVES to tenant A's entity") lands with
// the ladder.
test("resolutionPool_tenantWallHoldsInSql_includingTheTenantlessPool", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-pool-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantless = scope({ tenantId: "" });
    await service.promoteCandidate(promotion({ scope: tenantA }));
    await service.promoteCandidate(promotion({ idempotency_key: "promotion-tenantless", scope: tenantless }));

    // A third tenant's pool is empty: neither tenant A's entities nor the
    // tenant-less ones leak in. A wildcard reading of tenant_id = '' is
    // exactly the visible() hazard the ADR forbids the pool to inherit.
    assert.deepEqual(persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "tenant-b" }) }), []);

    // Tenant A pools only tenant A rows -- the tenant-less entity with the
    // same candidateRefs never appears.
    const poolA = persistence.lookupResolutionCandidates({ scope: tenantA });
    assert.equal(poolA.length, 2);
    assert.ok(poolA.every((entity) => entity.scope.tenantId === "tenant-a"));

    // The tenant-less pool holds only tenant-less rows: empty matches
    // empty, in both directions.
    const poolNone = persistence.lookupResolutionCandidates({ scope: tenantless });
    assert.equal(poolNone.length, 2);
    assert.ok(poolNone.every((entity) => entity.scope.tenantId === ""));
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Stage 9 (ADR-GKS-ENTITY-RESOLUTION D5, acceptance criteria): the
// resolver-level half of the pool test above — a candidate in tenant B never
// RESOLVES to a canonical entity from tenant A, including a tenant-less one,
// and an explicit resolveTo claim naming a foreign entity is REJECTED rather
// than honored. This is the merge-side wall: by the time a read-side filter
// could catch it, the cross-tenant merge would already be written.
test("resolverLadder_neverMatchesAcrossTheTenantWall_andRejectsForeignResolveTo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-ladder-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const tenantless = scope({ tenantId: "" });
    const envelope = (idempotencyKey, promotionScope, entities) => promotion({
      idempotency_key: idempotencyKey,
      provenance_ref: `msp:proof/${idempotencyKey}`,
      scope: promotionScope,
      candidate: { entities },
    });

    const promotedA = await service.promoteCandidate(envelope("wall-a", tenantA, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]));
    const refA = promotedA.canonical_mappings[0].canonicalRef;
    await service.promoteCandidate(envelope("wall-none", tenantless, [
      { candidateRef: "ACME Holdings", type: "ENTITY", title: "ACME Holdings" },
    ]));

    // Tenant B asserts spellings that would MATCH inside tenant A (EXACT and
    // DETERMINISTIC rungs) and near the tenant-less entity (FUZZY) — every
    // one of them resolves CREATED in tenant B's own canonical space,
    // because the foreign entities are simply not in its pool.
    const promotedB = await service.promoteCandidate(envelope("wall-b", tenantB, [
      { candidateRef: "Acme Corp.", type: "ENTITY", title: "ACME Corp" },
      { candidateRef: "acme holdings", type: "ENTITY", title: "acme holdings" },
    ]));
    for (const mapping of promotedB.canonical_mappings) {
      assert.equal(mapping.resolution.outcome, "CREATED");
      assert.equal(mapping.resolution.strategy, "CREATED");
      assert.notEqual(mapping.canonicalRef, refA);
    }

    // Naming tenant A's canonical ref outright is a claim the CANONICAL_REF
    // rung verifies against tenant B's pool: out-of-pool means REJECTED —
    // no binding, no entity, no information about why beyond the outcome.
    const rejected = await service.promoteCandidate(envelope("wall-claim", tenantB, [
      { candidateRef: "acme intake", type: "ENTITY", title: "Acme Intake", resolveTo: refA },
    ]));
    assert.deepEqual(rejected.canonical_mappings[0], {
      candidateRef: "acme intake",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null },
    });

    // Tenant A's entity was never touched by any of it.
    const entityA = await service.getEntity({ ref: refA, scope: tenantA });
    assert.equal(entityA.title, "ACME Corp");
    assert.deepEqual(entityA.aliases, []);
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Stage 9 D9 (ADR-GKS-ENTITY-RESOLUTION D9, decision 8): the human bind is
// a WRITE that creates a binding, so its tenant wall must hold on the
// operands inside the transaction -- a bind target in another tenant, or in
// the tenant-less pool, is refused outright before anything is written.
// The tenant-less case is the visible() hazard the ADR names: an empty
// tenant_id is a tenant of its own, never a wildcard, in BOTH directions.
test("d9Bind_crossTenantTarget_refusedOutright_includingTheTenantlessCase", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-d9-bind-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const tenantless = scope({ tenantId: "" });
    const envelope = (idempotencyKey, promotionScope, entities) => promotion({
      idempotency_key: idempotencyKey,
      provenance_ref: `msp:proof/${idempotencyKey}`,
      scope: promotionScope,
      candidate: { entities },
    });

    const promotedA = await service.promoteCandidate(envelope("d9b-a", tenantA, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]));
    const refA = promotedA.canonical_mappings[0].canonicalRef;
    const promotedB = await service.promoteCandidate(envelope("d9b-b", tenantB, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]));
    const refB = promotedB.canonical_mappings[0].canonicalRef;
    const promotedNone = await service.promoteCandidate(envelope("d9b-none", tenantless, [
      { candidateRef: "ACME Holdings", type: "ENTITY", title: "ACME Holdings" },
    ]));
    const refNone = promotedNone.canonical_mappings[0].canonicalRef;

    // One unresolved mention in tenant-a and one in the tenant-less pool
    // (contradicting titles refuse to merge and land in the review queue).
    await service.promoteCandidate(envelope("d9b-a2", tenantA, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "A Different Company" },
    ]));
    await service.promoteCandidate(envelope("d9b-none2", tenantless, [
      { candidateRef: "ACME Holdings", type: "ENTITY", title: "A Different Holding" },
    ]));
    const [mentionA] = await service.listUnresolvedMentions({ scope: tenantA });
    const [mentionNone] = await service.listUnresolvedMentions({ scope: tenantless });

    // A tenant-a mention never binds across the wall: not to another
    // tenant's entity, not to a tenant-less one.
    await assert.rejects(service.applyHumanResolution({
      action: "BIND", mentionId: mentionA.mentionId, canonicalRef: refB, provenanceRef: "msp:proof/d9b-1", scope: tenantA,
    }), { code: "gks_scope_denied" });
    await assert.rejects(service.applyHumanResolution({
      action: "BIND", mentionId: mentionA.mentionId, canonicalRef: refNone, provenanceRef: "msp:proof/d9b-2", scope: tenantA,
    }), { code: "gks_scope_denied" });

    // The reverse direction of the tenant-less wall: a tenant-less mention
    // never binds to tenanted knowledge.
    await assert.rejects(service.applyHumanResolution({
      action: "BIND", mentionId: mentionNone.mentionId, canonicalRef: refA, provenanceRef: "msp:proof/d9b-3", scope: tenantless,
    }), { code: "gks_scope_denied" });

    // A tenant-b caller cannot act on tenant-a's mention at all -- an
    // out-of-scope mention answers exactly like an absent one.
    await assert.rejects(service.applyHumanResolution({
      action: "BIND", mentionId: mentionA.mentionId, canonicalRef: refB, provenanceRef: "msp:proof/d9b-4", scope: tenantB,
    }), { code: "gks_invalid_request" });

    // Nothing was written by any refusal: both mentions are still queued
    // unresolved, and no entity gained a binding alias.
    const listedA = await service.listUnresolvedMentions({ scope: tenantA });
    assert.equal(listedA.length, 1);
    assert.equal(listedA[0].canonicalRef, null);
    const listedNone = await service.listUnresolvedMentions({ scope: tenantless });
    assert.equal(listedNone.length, 1);
    assert.deepEqual(persistence.getEntity(refB).aliases, []);
    assert.deepEqual(persistence.getEntity(refNone).aliases, []);

    // Positive control: the same request shape inside the wall succeeds,
    // so the denials above are scope decisions, not validation.
    const bound = await service.applyHumanResolution({
      action: "BIND", mentionId: mentionA.mentionId, canonicalRef: refA, provenanceRef: "msp:proof/d9b-5", scope: tenantA,
    });
    assert.equal(bound.outcome, "MATCHED");
    assert.equal(bound.strategy, "HUMAN");
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// D9's merge is the single most dangerous write in the system: it is the
// unrecoverable direction performed deliberately, so a cross-tenant operand
// -- tenanted or tenant-less, on either side, from any caller scope -- is
// refused outright, and a refusal writes nothing.
test("d9Merge_crossTenantOperands_refusedOutright_includingTheTenantlessCase", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-d9-merge-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const tenantless = scope({ tenantId: "" });
    const envelope = (idempotencyKey, promotionScope, entities) => promotion({
      idempotency_key: idempotencyKey,
      provenance_ref: `msp:proof/${idempotencyKey}`,
      scope: promotionScope,
      candidate: { entities },
    });

    const promotedA = await service.promoteCandidate(envelope("d9m-a", tenantA, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
      { candidateRef: "ACME Industrial Corp", type: "ENTITY", title: "ACME Industrial Corp" },
    ]));
    const refA1 = promotedA.canonical_mappings[0].canonicalRef;
    const refA2 = promotedA.canonical_mappings[1].canonicalRef;
    const promotedB = await service.promoteCandidate(envelope("d9m-b", tenantB, [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]));
    const refB = promotedB.canonical_mappings[0].canonicalRef;
    const promotedNone = await service.promoteCandidate(envelope("d9m-none", tenantless, [
      { candidateRef: "ACME Holdings", type: "ENTITY", title: "ACME Holdings" },
    ]));
    const refNone = promotedNone.canonical_mappings[0].canonicalRef;

    const deniedMerges = [
      // Another tenant's entity on either side of the merge.
      { survivorRef: refA1, supersededRef: refB, mergeScope: tenantA },
      { survivorRef: refB, supersededRef: refA1, mergeScope: tenantA },
      // The tenant-less pool on either side: an empty tenant_id is a tenant
      // of its own, and the merge wall refuses the operands outright.
      { survivorRef: refA1, supersededRef: refNone, mergeScope: tenantA },
      { survivorRef: refNone, supersededRef: refA1, mergeScope: tenantless },
      // A foreign caller scope over same-tenant operands.
      { survivorRef: refA1, supersededRef: refA2, mergeScope: tenantB },
    ];
    for (const [index, attempt] of deniedMerges.entries()) {
      await assert.rejects(service.applyHumanResolution({
        action: "MERGE",
        survivorRef: attempt.survivorRef,
        supersededRef: attempt.supersededRef,
        provenanceRef: `msp:proof/d9m-deny-${index}`,
        scope: attempt.mergeScope,
      }), { code: "gks_scope_denied" }, `merge attempt ${index} must be denied`);
    }

    // No refusal wrote anything: every entity is still live and untouched.
    for (const ref of [refA1, refA2, refB, refNone]) {
      const entity = persistence.getEntity(ref);
      assert.equal(entity.supersededBy, null);
      assert.deepEqual(entity.aliases, []);
    }

    // Positive control: the same-tenant merge succeeds with the identical
    // request shape, so the five denials are scope decisions.
    const merged = await service.applyHumanResolution({
      action: "MERGE", survivorRef: refA1, supersededRef: refA2, provenanceRef: "msp:proof/d9m-ok", scope: tenantA,
    });
    assert.equal(merged.survivorRef, refA1);
    assert.equal(persistence.getEntity(refA2).supersededBy, refA1);
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
