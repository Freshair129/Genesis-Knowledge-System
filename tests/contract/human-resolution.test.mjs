// Stage 9 D9: the unresolved-mention consumer, end to end through the
// service (ADR-GKS-ENTITY-RESOLUTION D9, D10.2, decisions 4, 6).
//
// The review listing shows exactly the rows D3 refused to merge
// (REVIEW_REQUIRED / AMBIGUOUS, canonical_ref NULL), scope-filtered in SQL
// like the lookup. The one human-authorized write then either BINDs an
// unresolved mention to an existing canonical entity -- materializing the
// pending relations that were held on it (acceptance criterion 5) -- or
// MERGEs two canonical entities, recording supersession on the loser and
// re-pointing its relations to the survivor in the same transaction. And
// the resolver can never reach any of it: promotion touches only
// transactPromotion, which itself refuses to record strategy HUMAN.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime(serviceOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-d9-"));
  const dbPath = path.join(dir, "gks.sqlite");
  const persistence = openSqlitePersistence({ dbPath });
  cleanups.push(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service: createGksService({ persistence, ...serviceOptions }), persistence, dbPath };
}

function openRaw(dbPath) {
  const raw = new Database(dbPath);
  cleanups.push(() => raw.close());
  return raw;
}

let hashCounter = 0;
function envelope(idempotencyKey, candidate, overrides = {}) {
  hashCounter += 1;
  return promotion({
    idempotency_key: idempotencyKey,
    provenance_ref: `msp:proof/${idempotencyKey}`,
    source_snapshot_hash: hashCounter.toString(16).padStart(64, "0"),
    candidate,
    ...overrides,
  });
}

function entity(candidateRef, overrides = {}) {
  return { candidateRef, type: "ENTITY", title: candidateRef, ...overrides };
}

function mapping(result, candidateRef) {
  return result.canonical_mappings.find((item) => item.candidateRef === candidateRef);
}

// One REVIEW_REQUIRED mention via the contradiction check: the candidateRef
// re-asserts an existing entity's mention string under a materially
// different title, so the ladder refuses to merge and records it unresolved.
async function seedReviewRequired(service, key, candidateRef, conflictingTitle) {
  const result = await service.promoteCandidate(envelope(key, {
    entities: [entity(candidateRef, { title: conflictingTitle })],
  }));
  expect(mapping(result, candidateRef).resolution.outcome).toBe("REVIEW_REQUIRED");
  return result;
}

describe("gks_review_list: the review queue (D9 read)", () => {
  it("listsExactlyTheUnresolvedOutcomes_neverCreatedMatchedOrRejected", async () => {
    const { service } = runtime();
    await service.promoteCandidate(envelope("list-1", { entities: [entity("ACME Corp")] })); // CREATED
    await service.promoteCandidate(envelope("list-2", { entities: [entity("ACME Corp")] })); // MATCHED
    await seedReviewRequired(service, "list-3", "ACME Corp", "A Wholly Different Company"); // REVIEW_REQUIRED
    // AMBIGUOUS: two stored entities near the candidate, not near each other.
    await service.promoteCandidate(envelope("list-4", { entities: [entity("companyaab")] }));
    await service.promoteCandidate(envelope("list-5", { entities: [entity("companyxxy")] }));
    const ambiguous = await service.promoteCandidate(envelope("list-6", { entities: [entity("companyaxb")] }));
    expect(mapping(ambiguous, "companyaxb").resolution.outcome).toBe("AMBIGUOUS");
    // REJECTED: a resolveTo claim naming a nonexistent entity.
    const rejected = await service.promoteCandidate(envelope("list-7", {
      entities: [entity("ghost claim", { resolveTo: `gks:entity/ghost-${"0".repeat(32)}` })],
    }));
    expect(mapping(rejected, "ghost claim").resolution.outcome).toBe("REJECTED");

    const listed = await service.listUnresolvedMentions({ scope: scope() });

    expect(listed.map((mention) => [mention.candidateRef, mention.outcome]).sort()).toEqual([
      ["ACME Corp", "REVIEW_REQUIRED"],
      ["companyaxb", "AMBIGUOUS"],
    ]);
    for (const mention of listed) {
      expect(mention.canonicalRef).toBeNull();
      expect(mention.mentionId).toMatch(/^gks:mention\/[a-f0-9]{32}$/);
      expect(mention.scope).toMatchObject({ portfolioId: "portfolio-zuri", tenantId: "tenant-a" });
      expect(mention.provenanceRef).toMatch(/^msp:proof\//);
      expect(Array.isArray(mention.fieldDiffs)).toBe(true);
    }
  });

  it("listing_isScopeFilteredLikeTheLookup_andScopeIsRequired", async () => {
    const { service } = runtime();
    await service.promoteCandidate(envelope("scope-1", { entities: [entity("ACME Corp")] }));
    await seedReviewRequired(service, "scope-2", "ACME Corp", "Different Company A");
    // The same unresolved shape in tenant-b, and at a broader tenant-a scope.
    await service.promoteCandidate(envelope("scope-3", { entities: [entity("Beta Co")] }, { scope: scope({ tenantId: "tenant-b" }) }));
    await service.promoteCandidate(envelope("scope-4", {
      entities: [entity("Beta Co", { title: "Different Company B" })],
    }, { scope: scope({ tenantId: "tenant-b" }) }));
    await service.promoteCandidate(envelope("scope-5", { entities: [entity("Gamma Co")] }, { scope: scope({ businessId: "", workspaceId: "", projectId: "" }) }));
    await service.promoteCandidate(envelope("scope-6", {
      entities: [entity("Gamma Co", { title: "Different Company C" })],
    }, { scope: scope({ businessId: "", workspaceId: "", projectId: "" }) }));

    // tenant-a at project scope: its own row plus the broader tenant-level
    // one (same-or-broader, like the pool) -- never tenant-b's.
    const tenantA = await service.listUnresolvedMentions({ scope: scope() });
    expect(tenantA.map((mention) => mention.candidateRef).sort()).toEqual(["ACME Corp", "Gamma Co"]);

    // tenant-b sees exactly its own; a third tenant sees nothing.
    const tenantB = await service.listUnresolvedMentions({ scope: scope({ tenantId: "tenant-b" }) });
    expect(tenantB.map((mention) => mention.candidateRef)).toEqual(["Beta Co"]);
    expect(await service.listUnresolvedMentions({ scope: scope({ tenantId: "tenant-c" }) })).toEqual([]);

    await expect(service.listUnresolvedMentions({})).rejects.toMatchObject({ code: "gks_invalid_request" });
  });
});

describe("gks_review_apply BIND: a human decision resolves a mention (D9 write)", () => {
  it("bind_resolvesTheMention_recordsHumanStrategy_andMaterializesThePendingRelation", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("bind-1", {
      entities: [entity("Beta Co", { title: "Beta Industrial Holdings" })],
    }));
    const betaRef = mapping(first, "Beta Co").canonicalRef;

    // alpha promotes; Beta Co re-appears under a conflicting title
    // (REVIEW_REQUIRED, unresolved); their relation is held pending.
    const second = await service.promoteCandidate(envelope("bind-2", {
      entities: [entity("Alpha Co"), entity("Beta Co", { title: "Totally Different Name" })],
      relations: [{ fromRef: "Alpha Co", relationType: "DEPENDS_ON", toRef: "Beta Co" }],
    }));
    const alphaRef = mapping(second, "Alpha Co").canonicalRef;

    const [reviewRow] = await service.listUnresolvedMentions({ scope: scope() });
    expect(reviewRow).toMatchObject({ candidateRef: "Beta Co", outcome: "REVIEW_REQUIRED", canonicalRef: null });

    const decision = await service.applyHumanResolution({
      action: "BIND",
      mentionId: reviewRow.mentionId,
      canonicalRef: betaRef,
      provenanceRef: "msp:proof/review-bind-1",
      scope: scope(),
    });

    expect(decision).toMatchObject({
      action: "BIND",
      mentionId: reviewRow.mentionId,
      canonicalRef: betaRef,
      outcome: "MATCHED",
      strategy: "HUMAN",
      graphVersion: expect.stringMatching(/^gks:graph\//),
    });
    // Acceptance criterion 5: the pending relation materialized when its
    // endpoint resolved -- and the only mechanism for that is this bind.
    expect(decision.materializedRelations).toEqual([
      expect.objectContaining({
        canonicalRef: expect.stringMatching(/^gks:relation\/[a-f0-9]{32}$/),
        fromRef: alphaRef,
        relationType: "DEPENDS_ON",
        toRef: betaRef,
      }),
    ]);

    const raw = openRaw(dbPath);
    // The mention is re-decided in place: strategy HUMAN carries no
    // resolver-assigned confidence, and the original promotion provenance
    // stays on the mention -- the decision's own provenance is its own row.
    const mentionRow = raw.prepare("SELECT * FROM entity_mentions WHERE mention_id = ?").get(reviewRow.mentionId);
    expect(mentionRow).toMatchObject({
      canonical_ref: betaRef,
      outcome: "MATCHED",
      strategy: "HUMAN",
      confidence: null,
      provenance_ref: "msp:proof/bind-2",
    });
    const pending = raw.prepare("SELECT * FROM pending_relations").get();
    expect(pending).toMatchObject({ status: "MATERIALIZED", materialized_ref: decision.materializedRelations[0].canonicalRef });
    const decisionRow = raw.prepare("SELECT * FROM human_resolutions").get();
    expect(decisionRow).toMatchObject({
      action: "BIND",
      mention_id: reviewRow.mentionId,
      canonical_ref: betaRef,
      superseded_ref: null,
      provenance_ref: "msp:proof/review-bind-1",
      graph_version: decision.graphVersion,
    });
    // Decision 1's ALIAS rung source: the bound mention's normalized form is
    // recorded as an alias on the entity.
    expect(JSON.parse(raw.prepare("SELECT aliases_json FROM entities WHERE canonical_ref = ?").get(betaRef).aliases_json)).toContain("beta");

    // The relation is a first-class canonical relation now, and the queue
    // is drained.
    const relations = await service.getRelations({ ref: alphaRef, scope: scope() });
    expect(relations).toEqual([expect.objectContaining({ fromRef: alphaRef, relationType: "DEPENDS_ON", toRef: betaRef })]);
    expect(await service.listUnresolvedMentions({ scope: scope() })).toEqual([]);

    // A second decision on the same mention has nothing to decide.
    await expect(service.applyHumanResolution({
      action: "BIND",
      mentionId: reviewRow.mentionId,
      canonicalRef: betaRef,
      provenanceRef: "msp:proof/review-bind-2",
      scope: scope(),
    })).rejects.toMatchObject({ code: "gks_invalid_request" });
  });

  it("bind_refusesAbsentMentions_rejectedMentions_absentTargets_andSupersededTargets", async () => {
    const { service, dbPath } = runtime();
    const seeded = await service.promoteCandidate(envelope("guard-1", { entities: [entity("ACME Corp"), entity("Beta Co")] }));
    const acmeRef = mapping(seeded, "ACME Corp").canonicalRef;
    const betaRef = mapping(seeded, "Beta Co").canonicalRef;
    await seedReviewRequired(service, "guard-2", "ACME Corp", "Different Company");
    const [reviewRow] = await service.listUnresolvedMentions({ scope: scope() });

    // A well-formed mention id that names nothing.
    await expect(service.applyHumanResolution({
      action: "BIND", mentionId: `gks:mention/${"0".repeat(32)}`, canonicalRef: acmeRef, provenanceRef: "msp:proof/guard", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_invalid_request" });

    // A REJECTED mention is a refused claim, not a review item: it neither
    // lists nor binds.
    const rejected = await service.promoteCandidate(envelope("guard-3", {
      entities: [entity("ghost claim", { resolveTo: `gks:entity/ghost-${"0".repeat(32)}` })],
    }));
    expect(mapping(rejected, "ghost claim").resolution.outcome).toBe("REJECTED");
    const raw = openRaw(dbPath);
    const rejectedMentionId = raw.prepare("SELECT mention_id FROM entity_mentions WHERE outcome = 'REJECTED'").get().mention_id;
    expect((await service.listUnresolvedMentions({ scope: scope() })).map((m) => m.mentionId)).not.toContain(rejectedMentionId);
    await expect(service.applyHumanResolution({
      action: "BIND", mentionId: rejectedMentionId, canonicalRef: acmeRef, provenanceRef: "msp:proof/guard", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_invalid_request" });

    // A bind target that resolves to nothing is invalid input.
    await expect(service.applyHumanResolution({
      action: "BIND", mentionId: reviewRow.mentionId, canonicalRef: `gks:entity/ghost-${"0".repeat(32)}`, provenanceRef: "msp:proof/guard", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_invalid_request" });

    // A superseded entity is no longer a live identity: bind to the survivor.
    await service.applyHumanResolution({ action: "MERGE", survivorRef: acmeRef, supersededRef: betaRef, provenanceRef: "msp:proof/guard-merge", scope: scope() });
    await expect(service.applyHumanResolution({
      action: "BIND", mentionId: reviewRow.mentionId, canonicalRef: betaRef, provenanceRef: "msp:proof/guard", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_conflict" });

    // And through it all, the mention is still unresolved.
    expect(raw.prepare("SELECT canonical_ref, outcome FROM entity_mentions WHERE mention_id = ?").get(reviewRow.mentionId)).toEqual({
      canonical_ref: null,
      outcome: "REVIEW_REQUIRED",
    });
  });

  it("bind_requestShape_failsClosed", async () => {
    const { service } = runtime();
    const base = { mentionId: `gks:mention/${"a".repeat(32)}`, canonicalRef: `gks:entity/acme-${"a".repeat(32)}`, provenanceRef: "msp:proof/shape", scope: scope() };

    await expect(service.applyHumanResolution({ ...base, action: "OVERWRITE" })).rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.applyHumanResolution({ ...base, action: "BIND", provenanceRef: "not-a-proof" })).rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.applyHumanResolution({ ...base, action: "BIND", mentionId: "gks:mention/short" })).rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.applyHumanResolution({ ...base, action: "BIND", canonicalRef: "gks:knowledge/not-an-entity" })).rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.applyHumanResolution({
      action: "MERGE", survivorRef: base.canonicalRef, supersededRef: base.canonicalRef, provenanceRef: "msp:proof/shape", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_invalid_request" });
  });
});

describe("gks_review_apply MERGE: supersession with relation re-pointing (D9 write, D10.2)", () => {
  it("merge_recordsSupersession_repointsRelations_andRemovesTheExactDuplicate_atomically", async () => {
    const { service, dbPath } = runtime();
    const seeded = await service.promoteCandidate(envelope("merge-1", {
      entities: [
        entity("ACME Corp"),
        entity("ACME Industrial Corp", { externalRefs: ["crm:acct-9"] }),
        entity("Gamma Co"),
      ],
      relations: [
        { fromRef: "Gamma Co", relationType: "DEPENDS_ON", toRef: "ACME Industrial Corp" },
        { fromRef: "Gamma Co", relationType: "DEPENDS_ON", toRef: "ACME Corp" },
        { fromRef: "ACME Industrial Corp", relationType: "AFFECTS", toRef: "Gamma Co" },
      ],
    }));
    const survivorRef = mapping(seeded, "ACME Corp").canonicalRef;
    const loserRef = mapping(seeded, "ACME Industrial Corp").canonicalRef;
    const gammaRef = mapping(seeded, "Gamma Co").canonicalRef;
    const raw = openRaw(dbPath);
    const versionBefore = raw.prepare("SELECT version FROM graph_state").get().version;
    const loserAffectsBefore = raw.prepare("SELECT canonical_ref FROM relations WHERE relation_type = 'AFFECTS'").get().canonical_ref;

    const decision = await service.applyHumanResolution({
      action: "MERGE",
      survivorRef,
      supersededRef: loserRef,
      provenanceRef: "msp:proof/review-merge-1",
      scope: scope(),
    });

    // The supersession is recorded on the losing entity; its canonical ref
    // is never rewritten (decision 4) and the row is never deleted.
    expect(decision).toMatchObject({ action: "MERGE", survivorRef, supersededRef: loserRef });
    const loserRow = raw.prepare("SELECT * FROM entities WHERE canonical_ref = ?").get(loserRef);
    expect(loserRow.superseded_by).toBe(survivorRef);

    // D10.2, in the SAME transaction: gamma->loser became gamma->survivor,
    // which already existed -- the duplicate is removed, not left pointing at
    // the ghost. loser->gamma re-pointed to survivor->gamma under a
    // recomputed canonical ref, keeping ref = f(scope, endpoints).
    expect(decision.removedDuplicateRelations).toHaveLength(1);
    expect(decision.repointedRelations).toEqual([
      expect.objectContaining({ fromRef: survivorRef, relationType: "AFFECTS", toRef: gammaRef }),
    ]);
    const relations = raw.prepare("SELECT * FROM relations ORDER BY relation_type").all();
    expect(relations).toHaveLength(2);
    expect(relations.map((row) => [row.from_ref, row.relation_type, row.to_ref])).toEqual([
      [survivorRef, "AFFECTS", gammaRef],
      [gammaRef, "DEPENDS_ON", survivorRef],
    ]);
    expect(relations[0].canonical_ref).not.toBe(loserAffectsBefore);
    for (const row of relations) {
      expect(row.from_ref).not.toBe(loserRef);
      expect(row.to_ref).not.toBe(loserRef);
    }

    // One decision, one graph version: every row the merge wrote carries the
    // same bumped version -- the transactional shape, observable.
    expect(raw.prepare("SELECT version FROM graph_state").get().version).toBe(versionBefore + 1);
    expect(decision.graphVersion).toBe(`gks:graph/${versionBefore + 1}`);
    expect(loserRow.graph_version).toBe(decision.graphVersion);
    expect(relations[0].graph_version).toBe(decision.graphVersion);

    // The survivor absorbed the loser's identity evidence, and the decision
    // carries its own provenance in the audit table.
    const survivorRow = raw.prepare("SELECT * FROM entities WHERE canonical_ref = ?").get(survivorRef);
    expect(JSON.parse(survivorRow.aliases_json)).toContain("acme industrial");
    expect(JSON.parse(survivorRow.external_refs_json)).toContain("crm:acct-9");
    expect(raw.prepare("SELECT * FROM human_resolutions").get()).toMatchObject({
      action: "MERGE",
      mention_id: null,
      canonical_ref: survivorRef,
      superseded_ref: loserRef,
      provenance_ref: "msp:proof/review-merge-1",
    });

    // Merging the same loser again has nothing left to supersede, and no
    // merge may target a superseded survivor.
    await expect(service.applyHumanResolution({
      action: "MERGE", survivorRef: gammaRef, supersededRef: loserRef, provenanceRef: "msp:proof/review-merge-2", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_conflict" });
    await expect(service.applyHumanResolution({
      action: "MERGE", survivorRef: loserRef, supersededRef: gammaRef, provenanceRef: "msp:proof/review-merge-3", scope: scope(),
    })).rejects.toMatchObject({ code: "gks_conflict" });
  });

  it("merge_removesTheLoserFromTheResolutionPool_andItsSpellingResolvesToTheSurvivor", async () => {
    const { service, persistence } = runtime();
    const seeded = await service.promoteCandidate(envelope("repair-1", {
      entities: [entity("ACME Corp"), entity("ACME Industrial Corp")],
    }));
    const survivorRef = mapping(seeded, "ACME Corp").canonicalRef;
    const loserRef = mapping(seeded, "ACME Industrial Corp").canonicalRef;

    await service.applyHumanResolution({
      action: "MERGE", survivorRef, supersededRef: loserRef, provenanceRef: "msp:proof/repair-merge", scope: scope(),
    });

    // The pool no longer offers the ghost, so a repaired over-split can
    // never be matched -- or reported AMBIGUOUS -- against it.
    const pool = persistence.lookupResolutionCandidates({ scope: scope() });
    expect(pool.map((candidate) => candidate.canonicalRef)).toEqual([survivorRef]);
    expect(persistence.getEntity(loserRef)).toMatchObject({ supersededBy: survivorRef });

    // The loser's spelling now reaches the survivor through the alias the
    // merge recorded -- the ALIAS rung is how repairs improve resolution.
    const reasserted = await service.promoteCandidate(envelope("repair-2", {
      entities: [entity("ACME Industrial Corp", { title: "ACME Corp" })],
    }));
    expect(mapping(reasserted, "ACME Industrial Corp")).toMatchObject({
      canonicalRef: survivorRef,
      resolution: { outcome: "MATCHED", strategy: "ALIAS", confidence: 0.92 },
    });
  });

  it("pendingRelationHeldAcrossAMerge_materializesOnTheSurvivor_notTheGhost", async () => {
    const { service, dbPath } = runtime();
    // target and other are both live; mystery exists so its re-assertion
    // under a conflicting title goes unresolved.
    const seedA = await service.promoteCandidate(envelope("chain-1", { entities: [entity("Target Co")] }));
    const targetRef = mapping(seedA, "Target Co").canonicalRef;
    const seedB = await service.promoteCandidate(envelope("chain-2", { entities: [entity("Other Holdings")] }));
    const otherRef = mapping(seedB, "Other Holdings").canonicalRef;
    await service.promoteCandidate(envelope("chain-3", { entities: [entity("Mystery Co", { title: "Mystery Industrial" })] }));

    // Target Co resolves MATCHED; Mystery Co goes REVIEW_REQUIRED; their
    // relation is held pending on the unresolved endpoint.
    const held = await service.promoteCandidate(envelope("chain-4", {
      entities: [entity("Target Co"), entity("Mystery Co", { title: "Completely Other Name" })],
      relations: [{ fromRef: "Target Co", relationType: "DEPENDS_ON", toRef: "Mystery Co" }],
    }));
    expect(mapping(held, "Target Co").resolution.outcome).toBe("MATCHED");
    expect(mapping(held, "Mystery Co").resolution.outcome).toBe("REVIEW_REQUIRED");

    // Target Co is then merged away. The pending relation's resolved
    // endpoint now points at a superseded entity.
    await service.applyHumanResolution({
      action: "MERGE", survivorRef: otherRef, supersededRef: targetRef, provenanceRef: "msp:proof/chain-merge", scope: scope(),
    });

    // When the human bind finally resolves the other endpoint, the relation
    // materializes on the SURVIVOR: supersession is followed at
    // materialization time, never left dangling on the ghost.
    const mysteryReview = (await service.listUnresolvedMentions({ scope: scope() })).find((mention) => mention.candidateRef === "Mystery Co");
    const raw = openRaw(dbPath);
    const mysteryRef = raw.prepare("SELECT canonical_ref FROM entities WHERE candidate_ref = 'Mystery Co'").get().canonical_ref;
    const decision = await service.applyHumanResolution({
      action: "BIND", mentionId: mysteryReview.mentionId, canonicalRef: mysteryRef, provenanceRef: "msp:proof/chain-bind", scope: scope(),
    });

    expect(decision.materializedRelations).toEqual([
      expect.objectContaining({ fromRef: otherRef, relationType: "DEPENDS_ON", toRef: mysteryRef }),
    ]);
    const relation = raw.prepare("SELECT * FROM relations WHERE relation_type = 'DEPENDS_ON'").get();
    expect(relation).toMatchObject({ from_ref: otherRef, to_ref: mysteryRef });
  });
});

describe("the resolver cannot reach the merge path (D9: human-authorized, never resolver-invoked)", () => {
  it("promotionsAcrossEveryOutcome_neverTouchTransactHumanResolution_orRecordHuman", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-d9-guard-"));
    const dbPath = path.join(dir, "gks.sqlite");
    const persistence = openSqlitePersistence({ dbPath });
    cleanups.push(() => {
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const humanResolutionCalls = [];
    const guarded = {
      ...persistence,
      transactHumanResolution: (...args) => {
        humanResolutionCalls.push(args);
        return persistence.transactHumanResolution(...args);
      },
    };
    const service = createGksService({ persistence: guarded });

    // Every outcome the resolver can produce, including the ones a merging
    // resolver would be tempted by: CREATED, MATCHED, REVIEW_REQUIRED
    // (contradiction), AMBIGUOUS (fuzzy) and REJECTED (foreign claim).
    await service.promoteCandidate(envelope("res-1", { entities: [entity("ACME Corp")] }));
    await service.promoteCandidate(envelope("res-2", { entities: [entity("Acme Corp.", { title: "ACME Corp" })] }));
    await service.promoteCandidate(envelope("res-3", { entities: [entity("ACME Corp", { title: "A Conflicting Name" })] }));
    await service.promoteCandidate(envelope("res-4", { entities: [entity("companyaab")] }));
    await service.promoteCandidate(envelope("res-5", { entities: [entity("companyxxy")] }));
    await service.promoteCandidate(envelope("res-6", { entities: [entity("companyaxb")] }));
    await service.promoteCandidate(envelope("res-7", {
      entities: [entity("claimed", { resolveTo: `gks:entity/ghost-${"0".repeat(32)}` })],
    }));

    expect(humanResolutionCalls).toEqual([]);
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM human_resolutions").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities WHERE superseded_by IS NOT NULL").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE strategy = 'HUMAN'").get().n).toBe(0);
  });

  it("transactPromotion_refusesToRecordStrategyHuman_atTheWriteItself", () => {
    const { persistence } = runtime();
    const promotionScope = scope();
    // A hypothetical compromised resolver asserting a HUMAN decision through
    // the promotion write is refused by the adapter, not by convention.
    expect(() => persistence.transactPromotion({
      scope: promotionScope,
      scopeKey: [promotionScope.portfolioId, promotionScope.tenantId, promotionScope.businessId, promotionScope.workspaceId, promotionScope.projectId, promotionScope.sharing].join(" "),
      idempotencyKey: "forged-human",
      knowledgeRef: "gks:knowledge/gks_knowledge_forged",
      sourceHash: "e".repeat(64),
      provenanceRef: "msp:proof/forged-human",
      candidate: { entities: [] },
      entities: [{
        candidateRef: "acme",
        type: "ENTITY",
        title: "ACME Corp",
        summary: "",
        sourceRef: null,
        confidence: null,
        metadata: {},
        aliases: [],
        externalRefs: [],
        canonicalRef: `gks:entity/acme-${"a".repeat(32)}`,
        normKey: "acme",
        normVersion: "norm_v1",
        resolution: { outcome: "MATCHED", strategy: "HUMAN", confidence: 1 },
      }],
      relations: [],
      pendingRelations: [],
      canonicalMappings: [],
    })).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });

  it("resolverLadderSource_carriesNoReferenceToTheHumanWritePath", () => {
    const source = readFileSync("packages/gks-core/src/resolve.mjs", "utf8");
    expect(source).not.toMatch(/transactHumanResolution|applyHumanResolution|"HUMAN"|'HUMAN'/);
  });
});
