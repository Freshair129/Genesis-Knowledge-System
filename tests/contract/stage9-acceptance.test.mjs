// Stage 9 (DPS-KI-ENTITY-RESOLVE): the acceptance-criteria suite.
//
// Source of truth: docs/ADR-GKS-ENTITY-RESOLUTION.md (0.3.0b, accepted),
// §Acceptance criteria. This file IS the gate: every criterion in that
// section becomes at least one test here, named after it, asserted
// independently of the step suites that grew alongside the implementation.
// The criteria were written to be failable — an implementation normalizing
// exactly the four ACME spellings and nothing else must NOT pass, which is
// why the inputs below reach past those four strings (Thai legal forms, the
// fuzzy neighbourhood, the tenant wall, resolveTo claims, the D9 cycle).
//
// Criterion 10 — "msp-provider-compatibility and msp-service-chain run WITH
// MSP_REPO_ROOT set and pass" — cannot live in this file: it is a run
// requirement on tests/integration/*, which skip without that variable and
// prove nothing when they do. The gate for it is running `npm test` with
// MSP_REPO_ROOT set and seeing both suites EXECUTE.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_AUTOMERGE_FLOOR,
  FUZZY_CONFIDENCE_CEILING,
  GKS_TOOL_DEFINITIONS,
} from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime(serviceOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-acceptance-"));
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

let hashCounter = 0x5000;
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

describe("criterion 1: the four over-split spellings converge, the two same-candidateRef companies never merge", () => {
  it("criterion1_fourOverSplitSpellings_resolveToOneCanonicalEntity", async () => {
    const { service, dbPath } = runtime();
    // The ADR's own four spellings, one envelope each — the historical
    // over-split that produced four digest refs for one company.
    const first = await service.promoteCandidate(envelope("c1-1", { entities: [entity("ACME Corp")] }));
    const canonicalRef = mapping(first, "ACME Corp").canonicalRef;
    expect(canonicalRef).toMatch(/^gks:entity\//);

    for (const [key, spelling] of [
      ["c1-2", "Acme Corp."],
      ["c1-3", "acme corporation"],
      ["c1-4", "ACME_CORP"],
    ]) {
      const result = await service.promoteCandidate(envelope(key, { entities: [entity(spelling)] }));
      const resolved = mapping(result, spelling);
      expect(resolved.canonicalRef).toBe(canonicalRef);
      expect(resolved.resolution.outcome).toBe("MATCHED");
      expect(resolved.resolution.confidence).toBeGreaterThanOrEqual(DEFAULT_AUTOMERGE_FLOOR);
    }

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    const mentions = raw.prepare("SELECT * FROM entity_mentions").all();
    expect(mentions).toHaveLength(4);
    expect(mentions.every((mention) => mention.canonical_ref === canonicalRef)).toBe(true);
  });

  it("criterion1_convergenceIsNotAnAcmeLookupTable_thaiLegalFormsConvergeToo", async () => {
    // The failability clause: an implementation special-casing the four ACME
    // spellings must not pass. Three Thai spellings of one company — the
    // circumfix legal form (บริษัท X จำกัด), the bare name, and the
    // limited-partnership abbreviation — converge through norm_v1's own
    // rules, on strings the ACME cases never touch.
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("c1-th-1", { entities: [entity("บริษัท ซูริ จำกัด")] }));
    const canonicalRef = mapping(first, "บริษัท ซูริ จำกัด").canonicalRef;

    for (const [key, spelling] of [
      ["c1-th-2", "ซูริ"],
      ["c1-th-3", "หจก ซูริ"],
    ]) {
      const result = await service.promoteCandidate(envelope(key, { entities: [entity(spelling)] }));
      const resolved = mapping(result, spelling);
      expect(resolved.canonicalRef).toBe(canonicalRef);
      expect(resolved.resolution.outcome).toBe("MATCHED");
      // Which norm_v1-derived rung fires may shift as evidence accumulates
      // (the first match records an alias, so a later spelling can hit
      // ALIAS ahead of DETERMINISTIC); the criterion is convergence above
      // the floor, through the frozen rules rather than a lookup table.
      expect(["DETERMINISTIC", "ALIAS"]).toContain(resolved.resolution.strategy);
      expect(resolved.resolution.confidence).toBeGreaterThanOrEqual(DEFAULT_AUTOMERGE_FLOOR);
    }

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
  });

  it("criterion1_twoSameCandidateRefCompanies_doNotMerge_secondIsItsOwnMentionWithItsOwnOutcome", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("c1-co-1", {
      entities: [entity("acme", { title: "ACME Corporation (Thailand)", summary: "Industrial conglomerate." })],
    }));
    const canonicalRef = mapping(first, "acme").canonicalRef;

    // Same candidateRef, materially different title: the ADR's over-merge
    // case. The old ON CONFLICT ... DO UPDATE silently overwrote the first
    // company; Stage 9 must refuse and record the second occurrence as its
    // own mention with its own outcome — never forced onto the first.
    const second = await service.promoteCandidate(envelope("c1-co-2", {
      entities: [entity("acme", { title: "Acme Plumbing Supplies", summary: "A different company entirely." })],
    }));
    expect(mapping(second, "acme").canonicalRef).toBeNull();
    expect(mapping(second, "acme").resolution.outcome).toBe("REVIEW_REQUIRED");

    const raw = openRaw(dbPath);
    // Still exactly one entity, its fields untouched by the second company.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(raw.prepare("SELECT title, summary FROM entities WHERE canonical_ref = ?").get(canonicalRef))
      .toEqual({ title: "ACME Corporation (Thailand)", summary: "Industrial conglomerate." });
    // Two mention rows for the one string — per-occurrence (D1), each with
    // its own outcome.
    const mentions = raw.prepare("SELECT promotion_idempotency_key, canonical_ref, outcome FROM entity_mentions WHERE candidate_ref = 'acme' ORDER BY promotion_idempotency_key").all();
    expect(mentions).toEqual([
      { promotion_idempotency_key: "c1-co-1", canonical_ref: canonicalRef, outcome: "CREATED" },
      { promotion_idempotency_key: "c1-co-2", canonical_ref: null, outcome: "REVIEW_REQUIRED" },
    ]);
  });
});

describe("criterion 2: the floor is exercised", () => {
  it("criterion2_candidateScoringBelowTheFloor_yieldsReviewRequired_writesNoBinding_doesNotModifyTheNearMatch", async () => {
    const { service, dbPath } = runtime();
    await service.promoteCandidate(envelope("c2-1", {
      entities: [entity("companyaab", { summary: "The stored near-match." })],
    }));
    const raw = openRaw(dbPath);
    const before = raw.prepare("SELECT * FROM entities").get();

    // One fuzzy near-match scores at most the FUZZY ceiling (0.84) — below
    // the 0.85 floor by construction. The outcome must be a refusal that
    // binds nothing and leaves the near-match entity byte-identical.
    const result = await service.promoteCandidate(envelope("c2-2", {
      entities: [entity("companyaac", { summary: "Must never land on the near-match." })],
    }));
    const resolved = mapping(result, "companyaac");
    expect(resolved.canonicalRef).toBeNull();
    expect(["REVIEW_REQUIRED", "AMBIGUOUS"]).toContain(resolved.resolution.outcome);
    expect(resolved.resolution.confidence).toBeLessThan(DEFAULT_AUTOMERGE_FLOOR);
    expect(resolved.resolution.confidence).toBeLessThanOrEqual(FUZZY_CONFIDENCE_CEILING);

    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(raw.prepare("SELECT * FROM entities").get()).toEqual(before);
    expect(raw.prepare("SELECT canonical_ref FROM entity_mentions WHERE promotion_idempotency_key = 'c2-2'").get().canonical_ref).toBeNull();
  });

  it("criterion2_theFloorItselfDecides_sameRungRefusedAboveIt_mergedBelowIt", async () => {
    // Without this pair, a resolver that ignores the floor entirely would
    // still pass the fuzzy case above (FUZZY is detect-only structurally).
    // The same DETERMINISTIC (0.88) input must refuse under a deployment
    // floor of 0.9 and merge under the default 0.85 — proof that the
    // comparison against the floor is live, not decorative.
    const raised = runtime({ automergeFloor: 0.9 });
    await raised.service.promoteCandidate(envelope("c2-hi-1", { entities: [entity("ACME Corp", { summary: "Original." })] }));
    const refused = await raised.service.promoteCandidate(envelope("c2-hi-2", {
      entities: [entity("acme corporation", { title: "ACME Corp" })],
    }));
    expect(mapping(refused, "acme corporation")).toMatchObject({
      canonicalRef: null,
      resolution: { outcome: "REVIEW_REQUIRED", strategy: "DETERMINISTIC", confidence: 0.88 },
    });
    const rawRaised = openRaw(raised.dbPath);
    expect(rawRaised.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(rawRaised.prepare("SELECT summary FROM entities").get().summary).toBe("Original.");

    const dflt = runtime();
    const seeded = await dflt.service.promoteCandidate(envelope("c2-lo-1", { entities: [entity("ACME Corp")] }));
    const merged = await dflt.service.promoteCandidate(envelope("c2-lo-2", {
      entities: [entity("acme corporation", { title: "ACME Corp" })],
    }));
    expect(mapping(merged, "acme corporation")).toMatchObject({
      canonicalRef: mapping(seeded, "ACME Corp").canonicalRef,
      resolution: { outcome: "MATCHED", strategy: "DETERMINISTIC", confidence: 0.88 },
    });
  });
});

describe("criterion 3: AMBIGUOUS and REJECTED are each produced by at least one real input", () => {
  it("criterion3_ambiguous_isProducedByARealInput", async () => {
    const { service, dbPath } = runtime();
    // Two stored entities near the candidate but not near each other, then
    // a candidate within fuzzy range of both: no single merge target.
    await service.promoteCandidate(envelope("c3-a-1", { entities: [entity("companyaab")] }));
    await service.promoteCandidate(envelope("c3-a-2", { entities: [entity("companyxxy")] }));

    const result = await service.promoteCandidate(envelope("c3-a-3", { entities: [entity("companyaxb")] }));
    expect(mapping(result, "companyaxb")).toEqual({
      candidateRef: "companyaxb",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "AMBIGUOUS", strategy: "FUZZY", confidence: null },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(2);
    expect(raw.prepare("SELECT outcome FROM entity_mentions WHERE promotion_idempotency_key = 'c3-a-3'").get().outcome).toBe("AMBIGUOUS");
  });

  it("criterion3_rejected_isProducedByARealInput", async () => {
    const { service, dbPath } = runtime();
    // A resolveTo claim naming a well-formed but nonexistent entity: the
    // CANONICAL_REF rung verifies and refuses — no binding, no entity
    // created for the refused claim.
    const result = await service.promoteCandidate(envelope("c3-r-1", {
      entities: [entity("Claimed Company", { resolveTo: `gks:entity/ghost-${"0".repeat(32)}` })],
    }));
    expect(mapping(result, "Claimed Company")).toEqual({
      candidateRef: "Claimed Company",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(0);
    expect(raw.prepare("SELECT canonical_ref, outcome FROM entity_mentions").get()).toEqual({ canonical_ref: null, outcome: "REJECTED" });
  });
});

describe("criterion 4: confidence validation rejects NaN, Infinity and out-of-range before any comparison to the floor", () => {
  it("criterion4_entityConfidenceJunk_failsClosed_persistingNothing", async () => {
    const { service, dbPath } = runtime();
    // "Before any comparison to the floor" made observable: junk must be a
    // request error, never a silent landing on the no-merge path — so the
    // whole envelope fails and NOTHING reaches the store. NaN >= 0.85 being
    // false is exactly the wrong-twice behaviour the ADR closed.
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.1, "0.9"]) {
      await expect(service.promoteCandidate(envelope(`c4-e-${String(junk)}`, {
        entities: [entity("ACME Corp", { confidence: junk })],
      }))).rejects.toMatchObject({ code: "gks_invalid_request" });
    }

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM promotions").get().n).toBe(0);

    // The in-range boundaries stay accepted — a guard that also rejected 0
    // or 1 would be a different defect wearing the same test name.
    await expect(service.promoteCandidate(envelope("c4-e-ok", {
      entities: [entity("Bounded Co", { confidence: 0 }), entity("Bounded Two Co", { confidence: 1 })],
    }))).resolves.toMatchObject({ idempotent: false });
  });

  it("criterion4_relationConfidenceJunk_failsClosedTheSameWay", async () => {
    const { service, dbPath } = runtime();
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
      await expect(service.promoteCandidate(envelope(`c4-r-${String(junk)}`, {
        entities: [entity("alpha"), entity("beta")],
        relations: [{ fromRef: "alpha", relationType: "DEPENDS_ON", toRef: "beta", confidence: junk }],
      }))).rejects.toMatchObject({ code: "gks_invalid_request" });
    }
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM promotions").get().n).toBe(0);
  });
});

describe("criterion 5: relations survive an unresolved endpoint, end to end", () => {
  it("criterion5_endpointReviewRequired_entitiesStillPromote_relationPends_thenMaterializesWhenTheEndpointResolves", async () => {
    const { service, dbPath } = runtime();
    const seeded = await service.promoteCandidate(envelope("c5-seed", {
      entities: [entity("beta", { title: "Beta Industrial Holdings" })],
    }));
    const betaRef = mapping(seeded, "beta").canonicalRef;

    // beta re-appears under a materially conflicting title (REVIEW_REQUIRED,
    // no canonical ref); alpha is new and depends on it. No envelope-wide
    // abort: alpha promotes, the relation is held pending.
    const result = await service.promoteCandidate(envelope("c5-rel", {
      entities: [
        entity("alpha", { title: "Alpha Co" }),
        entity("beta", { title: "A Wholly Different Concern" }),
      ],
      relations: [{ fromRef: "alpha", relationType: "DEPENDS_ON", toRef: "beta" }],
    }));
    const alphaRef = mapping(result, "alpha").canonicalRef;
    expect(mapping(result, "alpha").resolution.outcome).toBe("CREATED");
    expect(mapping(result, "beta").resolution.outcome).toBe("REVIEW_REQUIRED");

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM relations").get().n).toBe(0);
    expect(raw.prepare("SELECT status FROM pending_relations").get().status).toBe("PENDING");
    await expect(service.getRelations({ ref: alphaRef, scope: scope() })).resolves.toEqual([]);

    // The endpoint resolves — the ONLY mechanism by which an unresolved
    // endpoint later resolves is a D9 bind (ADR decision 6, which is why
    // this criterion is untestable without D9 in scope).
    const listed = await service.listUnresolvedMentions({ scope: scope() });
    const unresolvedBeta = listed.find((mention) => mention.candidateRef === "beta");
    expect(unresolvedBeta).toBeDefined();
    const bound = await service.applyHumanResolution({
      action: "BIND",
      provenanceRef: "msp:proof/c5-bind",
      scope: scope(),
      mentionId: unresolvedBeta.mentionId,
      canonicalRef: betaRef,
    });
    expect(bound.materializedRelations).toEqual([
      expect.objectContaining({ fromRef: alphaRef, relationType: "DEPENDS_ON", toRef: betaRef }),
    ]);

    // The held relation now stands as a real canonical relation.
    await expect(service.getRelations({ ref: alphaRef, scope: scope() })).resolves.toEqual([
      expect.objectContaining({ fromRef: alphaRef, relationType: "DEPENDS_ON", toRef: betaRef }),
    ]);
    expect(raw.prepare("SELECT status, materialized_ref FROM pending_relations").get()).toMatchObject({
      status: "MATERIALIZED",
      materialized_ref: expect.stringMatching(/^gks:relation\//),
    });
  });
});

describe("criterion 6: replay returns byte-identical evidence after the underlying mention's decision changed", () => {
  it("criterion6_replayAfterAD9BindReDecidedTheMention_returnsTheFrozenPromotionSnapshot", async () => {
    const { service, dbPath } = runtime();
    const seeded = await service.promoteCandidate(envelope("c6-seed", {
      entities: [entity("acme", { title: "ACME Corporation (Thailand)" })],
    }));
    const canonicalRef = mapping(seeded, "acme").canonicalRef;

    // The promotion whose evidence must stay frozen: REVIEW_REQUIRED via the
    // contradiction check, canonical_ref null.
    const input = envelope("c6-frozen", {
      entities: [entity("acme", { title: "Acme Plumbing Supplies" })],
    });
    const first = await service.promoteCandidate(input);
    expect(mapping(first, "acme").resolution.outcome).toBe("REVIEW_REQUIRED");

    // A human re-decides that very mention — not merely the same string in a
    // later envelope, THE mention the frozen promotion wrote.
    const listed = await service.listUnresolvedMentions({ scope: scope() });
    await service.applyHumanResolution({
      action: "BIND",
      provenanceRef: "msp:proof/c6-bind",
      scope: scope(),
      mentionId: listed[0].mentionId,
      canonicalRef,
    });
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT outcome, strategy, canonical_ref FROM entity_mentions WHERE mention_id = ?").get(listed[0].mentionId))
      .toEqual({ outcome: "MATCHED", strategy: "HUMAN", canonical_ref: canonicalRef });

    // Replay reads the promotion snapshot (D4), never the mention table:
    // byte-identical to the first response, still REVIEW_REQUIRED, still
    // unbound — the divergence from the mention row IS the audit record.
    const replay = await service.promoteCandidate(input);
    expect(replay).toEqual({ ...first, idempotent: true });
    expect(JSON.stringify(replay.canonical_mappings)).toBe(JSON.stringify(first.canonical_mappings));
    expect(mapping(replay, "acme").canonicalRef).toBeNull();
    expect(mapping(replay, "acme").resolution.outcome).toBe("REVIEW_REQUIRED");
  });
});

describe("criterion 7: a candidate in tenant B never resolves to an entity in tenant A, including a tenant-less one", () => {
  it("criterion7_tenantBCandidate_neverResolvesToTenantAOrTenantlessEntities", async () => {
    const { service, dbPath } = runtime();
    const tenantA = scope();
    const tenantless = scope({ tenantId: "" });
    const tenantB = scope({ tenantId: "tenant-b" });

    const inA = await service.promoteCandidate(envelope("c7-a", { entities: [entity("ACME Corp")] }, { scope: tenantA }));
    const refA = mapping(inA, "ACME Corp").canonicalRef;

    // The tenant-less record is the hazard the ADR names: under visible()'s
    // read semantics an empty tenantId was visible to every tenant. In the
    // resolution pool it is a tenant of its own — so this promotion itself
    // must CREATE rather than match tenant-a's entity...
    const inNone = await service.promoteCandidate(envelope("c7-none", { entities: [entity("acme corporation", { title: "ACME Corp" })] }, { scope: tenantless }));
    expect(mapping(inNone, "acme corporation").resolution.outcome).toBe("CREATED");
    const refNone = mapping(inNone, "acme corporation").canonicalRef;
    expect(refNone).not.toBe(refA);

    // ...and a tenant-b candidate that every rung would otherwise match
    // (DETERMINISTIC against both stored spellings) must match NEITHER the
    // tenant-a entity nor the tenant-less one.
    const inB = await service.promoteCandidate(envelope("c7-b", { entities: [entity("Acme Corp.", { title: "ACME Corp" })] }, { scope: tenantB }));
    expect(mapping(inB, "Acme Corp.").resolution.outcome).toBe("CREATED");
    expect(mapping(inB, "Acme Corp.").canonicalRef).not.toBe(refA);
    expect(mapping(inB, "Acme Corp.").canonicalRef).not.toBe(refNone);

    // An explicit cross-tenant resolveTo claim is REJECTED, not honoured.
    const claimed = await service.promoteCandidate(envelope("c7-claim", {
      entities: [entity("Claimed Across The Wall", { resolveTo: refA })],
    }, { scope: tenantB }));
    expect(mapping(claimed, "Claimed Across The Wall").resolution).toEqual({ outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null });

    // Positive control, so a broken ladder cannot pass this test by never
    // matching anything: inside its own tenant-less pool the same string
    // DOES match. The wall is the only thing that separated the tenants.
    const control = await service.promoteCandidate(envelope("c7-control", { entities: [entity("ACME_CORP", { title: "ACME Corp" })] }, { scope: tenantless }));
    expect(mapping(control, "ACME_CORP")).toMatchObject({ canonicalRef: refNone, resolution: { outcome: "MATCHED" } });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(3);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities WHERE tenant_id = 'tenant-b'").get().n).toBe(1);
  });
});

describe("criterion 8: stage keeps meaning Deep Scan stage; the pipeline id travels separately", () => {
  it("criterion8_stageStaysDeepScanInteger_andThePipelineIdTravelsInItsOwnField", async () => {
    const { service } = runtime();
    // Deep Scan stage 9 and DPS-KI stage 9 coexist without aliasing: the
    // integer is GoVibe Deep Scan vocabulary, the string is the pipeline id.
    await expect(service.promoteCandidate(envelope("c8-ok", { entities: [entity("Stage Nine Co")] }, {
      stage: 9,
      pipeline_stage_id: "DPS-KI-ENTITY-RESOLVE",
    }))).resolves.toMatchObject({ idempotent: false });

    // Stage 17 is inexpressible in `stage` — that is D6's point, not a gap.
    await expect(service.promoteCandidate(envelope("c8-17", { entities: [entity("Stage Seventeen Co")] }, { stage: 17 })))
      .rejects.toMatchObject({ code: "gks_invalid_request" });
    // Neither vocabulary is accepted in the other's field.
    await expect(service.promoteCandidate(envelope("c8-overload", { entities: [entity("Overload Co")] }, { stage: "DPS-KI-ENTITY-RESOLVE" })))
      .rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.promoteCandidate(envelope("c8-numeric-id", { entities: [entity("Numeric Id Co")] }, { pipeline_stage_id: 9 })))
      .rejects.toMatchObject({ code: "gks_invalid_request" });
    await expect(service.promoteCandidate(envelope("c8-alien-id", { entities: [entity("Alien Id Co")] }, { pipeline_stage_id: "DEEP-SCAN-9" })))
      .rejects.toMatchObject({ code: "gks_invalid_request" });
  });

  it("criterion8_promoteToolSchema_capsStageAt12_andAddsThePipelineIdAdditively", () => {
    const promote = GKS_TOOL_DEFINITIONS.find((tool) => tool.name === "gks_knowledge_promote");
    expect(promote.inputSchema.properties.stage).toMatchObject({ type: "integer", minimum: 1, maximum: 12 });
    expect(promote.inputSchema.properties.pipeline_stage_id).toMatchObject({ type: "string" });
    expect(promote.inputSchema.properties.pipeline_stage_id.pattern).toContain("DPS-KI-");
    // Additive means additive: legacy API-010 callers never send it.
    expect(promote.inputSchema.required).not.toContain("pipeline_stage_id");
    expect(promote.inputSchema.required).toContain("stage");
  });
});

describe("criterion 9: API-010 promotion fixtures pass unchanged", () => {
  it("criterion9_theUntouchedApi010Fixture_promotesRepliesIdempotentlyAndKeepsItsEvidenceShape", async () => {
    const { service } = runtime();
    const input = promotion(); // the API-010 fixture, exactly as it stands

    const first = await service.promoteCandidate(input);
    expect(first).toMatchObject({
      knowledge_ref: expect.stringMatching(/^gks:knowledge\//),
      source_hash: input.source_snapshot_hash,
      idempotent: false,
      graph_version: expect.stringMatching(/^gks:graph\//),
    });
    // The pre-Stage-9 evidence fields stand; resolution evidence is additive
    // on the same per-entity channel (D7), never a replacement of it.
    for (const item of first.canonical_mappings) {
      expect(item).toMatchObject({
        candidateRef: expect.any(String),
        canonicalRef: expect.stringMatching(/^gks:entity\//),
        canonicalType: "ENTITY",
        resolution: { outcome: "CREATED", strategy: "CREATED", confidence: 1 },
      });
    }

    await expect(service.promoteCandidate(input)).resolves.toEqual({ ...first, idempotent: true });
    await expect(service.promoteCandidate({ ...input, source_snapshot_hash: "b".repeat(64) }))
      .rejects.toMatchObject({ code: "gks_conflict" });
    await expect(service.promoteCandidate(promotion({ candidate: { canonicalRef: "gks:entity/forged" } })))
      .rejects.toMatchObject({ code: "gks_invalid_request" });
  });

  it("criterion9_legacyScopelessApi010Call_underTheDefaultPortfolio_stillPromotes", async () => {
    // The compatibility path the MSP fixtures exercise: no scope envelope,
    // GKS_DEFAULT_PORTFOLIO_ID supplies the portfolio (legacy API-010 only).
    const { service } = runtime({ defaultPortfolioId: "portfolio-zuri" });
    const { scope: _omitted, ...legacy } = promotion();

    const first = await service.promoteCandidate(legacy);
    expect(first).toMatchObject({
      knowledge_ref: expect.stringMatching(/^gks:knowledge\//),
      idempotent: false,
    });
    await expect(service.promoteCandidate(legacy)).resolves.toEqual({ ...first, idempotent: true });
  });
});
