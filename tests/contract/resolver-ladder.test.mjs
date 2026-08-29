// Stage 9 (DPS-KI-ENTITY-RESOLVE): the resolver ladder, end to end through
// the service (ADR-GKS-ENTITY-RESOLUTION D2, D3, D4, D10.1, decision 1).
//
// These are the ADR's own acceptance criteria, written to be failable: the
// four over-split spellings converge to ONE canonical entity while the two
// same-candidateRef different-title companies do NOT merge; the floor is
// exercised; AMBIGUOUS and REJECTED are each produced by a real input;
// replay stays byte-identical after a later envelope changes what the
// resolver would decide; and an unresolved relation endpoint records a
// pending relation instead of aborting the envelope.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FUZZY_CONFIDENCE_CEILING } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime(serviceOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-ladder-"));
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

describe("acceptance criterion 1: convergence without over-merge", () => {
  it("fourAcmeSpellings_acrossSeparateEnvelopes_convergeToOneCanonicalEntity", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("acme-1", { entities: [entity("ACME Corp")] }));
    const created = mapping(first, "ACME Corp");
    expect(created.resolution).toEqual({ outcome: "CREATED", strategy: "CREATED", confidence: 1 });

    // Full norm_v1 key match ("acme corporation" -> "acme"): DETERMINISTIC,
    // 0.88 — above the 0.85 floor, so the ADR's central convergence case
    // auto-merges.
    const second = await service.promoteCandidate(envelope("acme-2", { entities: [entity("acme corporation")] }));
    expect(mapping(second, "acme corporation").resolution).toEqual({ outcome: "MATCHED", strategy: "DETERMINISTIC", confidence: 0.88 });
    expect(mapping(second, "acme corporation").canonicalRef).toBe(created.canonicalRef);

    // Same creating spelling modulo case/separators/whitespace: EXACT, 0.95.
    for (const [key, spelling] of [["acme-3", "Acme Corp."], ["acme-4", "ACME_CORP"]]) {
      const result = await service.promoteCandidate(envelope(key, { entities: [entity(spelling)] }));
      expect(mapping(result, spelling).resolution).toEqual({ outcome: "MATCHED", strategy: "EXACT", confidence: 0.95 });
      expect(mapping(result, spelling).canonicalRef).toBe(created.canonicalRef);
    }

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    const mentions = raw.prepare("SELECT * FROM entity_mentions ORDER BY promotion_idempotency_key").all();
    expect(mentions).toHaveLength(4);
    expect(mentions.every((mention) => mention.canonical_ref === created.canonicalRef)).toBe(true);
  });

  it("sameCandidateRefDifferentTitle_contradictionCheck_refusesToMerge", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("co-1", {
      entities: [entity("acme", { title: "ACME Corporation (Thailand)", summary: "Industrial conglomerate." })],
    }));
    const canonicalRef = mapping(first, "acme").canonicalRef;

    // No string ladder can separate two companies both literally named
    // "acme" — the discriminating evidence is the materially conflicting
    // title, which drops the match to 0.60 and REVIEW_REQUIRED. No binding
    // is written and the stored entity is not touched.
    const second = await service.promoteCandidate(envelope("co-2", {
      entities: [entity("acme", { title: "Acme Plumbing Supplies", summary: "A different company entirely." })],
    }));
    expect(mapping(second, "acme")).toEqual({
      candidateRef: "acme",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "REVIEW_REQUIRED", strategy: "EXACT", confidence: 0.6 },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    const stored = raw.prepare("SELECT * FROM entities").get();
    expect(stored).toMatchObject({ canonical_ref: canonicalRef, title: "ACME Corporation (Thailand)", summary: "Industrial conglomerate." });
    const reviewMention = raw.prepare("SELECT * FROM entity_mentions WHERE promotion_idempotency_key = 'co-2'").get();
    expect(reviewMention).toMatchObject({ canonical_ref: null, outcome: "REVIEW_REQUIRED", strategy: "EXACT", confidence: 0.6 });
  });

  it("byteIdenticalReassertion_mergesOnTheOnlyEvidenceAvailable", async () => {
    // The ADR's counterpart to the contradiction: two mentions identical in
    // every attribute merge, correctly.
    const { service } = runtime();
    const first = await service.promoteCandidate(envelope("dup-1", { entities: [entity("acme", { title: "ACME Corporation" })] }));
    const second = await service.promoteCandidate(envelope("dup-2", { entities: [entity("acme", { title: "ACME Corporation" })] }));
    expect(mapping(second, "acme").resolution).toEqual({ outcome: "MATCHED", strategy: "EXACT", confidence: 0.95 });
    expect(mapping(second, "acme").canonicalRef).toBe(mapping(first, "acme").canonicalRef);
  });
});

describe("the floor is exercised (D3, decision 2)", () => {
  it("rungBelowARaisedFloor_yieldsReviewRequired_writesNoBinding_touchesNothing", async () => {
    const { service, dbPath } = runtime({ automergeFloor: 0.9 });
    const first = await service.promoteCandidate(envelope("floor-1", {
      entities: [entity("ACME Corp", { summary: "Original summary." })],
    }));
    const canonicalRef = mapping(first, "ACME Corp").canonicalRef;

    // DETERMINISTIC (0.88) sits below a deployment floor of 0.9: the rung
    // is decisive but may not merge — REVIEW_REQUIRED with the rung's own
    // honest confidence, no binding, and the near-match entity unmodified.
    const second = await service.promoteCandidate(envelope("floor-2", {
      entities: [entity("acme corporation", { title: "ACME Corp", summary: "Must not land on the entity." })],
    }));
    expect(mapping(second, "acme corporation")).toMatchObject({
      canonicalRef: null,
      resolution: { outcome: "REVIEW_REQUIRED", strategy: "DETERMINISTIC", confidence: 0.88 },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(raw.prepare("SELECT summary FROM entities WHERE canonical_ref = ?").get(canonicalRef).summary).toBe("Original summary.");
  });
});

describe("FUZZY is detect-only (decision 1)", () => {
  it("oneNearMatch_isReviewRequired_atOrBelowTheCeiling_neverMatched", async () => {
    const { service, dbPath } = runtime();
    await service.promoteCandidate(envelope("fuzzy-1", { entities: [entity("companyaab")] }));

    const result = await service.promoteCandidate(envelope("fuzzy-2", { entities: [entity("companyaac")] }));
    const resolved = mapping(result, "companyaac");
    expect(resolved.canonicalRef).toBeNull();
    expect(resolved.resolution.outcome).toBe("REVIEW_REQUIRED");
    expect(resolved.resolution.strategy).toBe("FUZZY");
    expect(resolved.resolution.confidence).toBeLessThanOrEqual(FUZZY_CONFIDENCE_CEILING);
    expect(resolved.resolution.confidence).toBeGreaterThan(0);

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
  });

  it("severalNearMatches_areAmbiguous_aRealInputReachesTheOutcome", async () => {
    const { service, dbPath } = runtime();
    // Two entities near the candidate but not near each other (so both
    // could be created), then a candidate within fuzzy range of both.
    await service.promoteCandidate(envelope("ambig-1", { entities: [entity("companyaab")] }));
    await service.promoteCandidate(envelope("ambig-2", { entities: [entity("companyxxy")] }));

    const result = await service.promoteCandidate(envelope("ambig-3", { entities: [entity("companyaxb")] }));
    expect(mapping(result, "companyaxb")).toEqual({
      candidateRef: "companyaxb",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "AMBIGUOUS", strategy: "FUZZY", confidence: null },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE outcome = 'AMBIGUOUS'").get().n).toBe(1);
  });
});

describe("CANONICAL_REF rung (decision 3): a claim verified, never trusted", () => {
  it("resolveToAnExistingInPoolEntity_matchesAtFullConfidence_withoutTitleCheck", async () => {
    const { service } = runtime();
    const first = await service.promoteCandidate(envelope("claim-1", { entities: [entity("ACME Corp")] }));
    const canonicalRef = mapping(first, "ACME Corp").canonicalRef;

    // The one rung with no contradiction overlay: a verified explicit claim
    // binds even under a different title.
    const second = await service.promoteCandidate(envelope("claim-2", {
      entities: [entity("A Wholly New Spelling", { title: "Some Other Title", resolveTo: canonicalRef })],
    }));
    expect(mapping(second, "A Wholly New Spelling")).toEqual({
      candidateRef: "A Wholly New Spelling",
      canonicalRef,
      canonicalType: "ENTITY",
      resolution: { outcome: "MATCHED", strategy: "CANONICAL_REF", confidence: 1 },
    });
  });

  it("resolveToANonexistentEntity_isRejected_creatingNothing", async () => {
    const { service, dbPath } = runtime();
    const ghost = `gks:entity/ghost-${"0".repeat(32)}`;
    const result = await service.promoteCandidate(envelope("claim-ghost", {
      entities: [entity("Would Otherwise Create", { resolveTo: ghost })],
    }));
    expect(mapping(result, "Would Otherwise Create")).toEqual({
      candidateRef: "Would Otherwise Create",
      canonicalRef: null,
      canonicalType: "ENTITY",
      resolution: { outcome: "REJECTED", strategy: "CANONICAL_REF", confidence: null },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(0);
    expect(raw.prepare("SELECT * FROM entity_mentions").get()).toMatchObject({ canonical_ref: null, outcome: "REJECTED", strategy: "CANONICAL_REF" });
  });
});

describe("EXTERNAL_REF and ALIAS rungs", () => {
  it("intersectingExternalRefs_matchAheadOfTheStringRungs", async () => {
    const { service, persistence } = runtime();
    const first = await service.promoteCandidate(envelope("ext-1", {
      entities: [entity("ACME Thailand", { externalRefs: ["wikidata:Q42"] })],
    }));
    const canonicalRef = mapping(first, "ACME Thailand").canonicalRef;

    const second = await service.promoteCandidate(envelope("ext-2", {
      entities: [entity("ACME TH Operations", { title: "Acme Thailand", externalRefs: ["wikidata:Q42", "crm:acct-77"] })],
    }));
    expect(mapping(second, "ACME TH Operations")).toEqual({
      candidateRef: "ACME TH Operations",
      canonicalRef,
      canonicalType: "ENTITY",
      resolution: { outcome: "MATCHED", strategy: "EXTERNAL_REF", confidence: 0.98 },
    });
    // Decision 7: the union is what lets this rung improve over time.
    expect(persistence.getEntity(canonicalRef).externalRefs).toEqual(["crm:acct-77", "wikidata:Q42"]);
  });

  it("aliasRecordedOnTheEntity_matchesAtItsOwnRung", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("alias-1", { entities: [entity("ACME Corp")] }));
    const canonicalRef = mapping(first, "ACME Corp").canonicalRef;

    // Seed the alias the way a D9 human bind will record it (the D9 tool is
    // the next build step; the rung's contract holds either way).
    const raw = openRaw(dbPath);
    raw.prepare("UPDATE entities SET aliases_json = ? WHERE canonical_ref = ?").run(JSON.stringify(["acme (thailand)"]), canonicalRef);

    const second = await service.promoteCandidate(envelope("alias-2", {
      entities: [entity("ACME (Thailand) Co., Ltd.", { title: "Acme Corp." })],
    }));
    expect(mapping(second, "ACME (Thailand) Co., Ltd.")).toEqual({
      candidateRef: "ACME (Thailand) Co., Ltd.",
      canonicalRef,
      canonicalType: "ENTITY",
      resolution: { outcome: "MATCHED", strategy: "ALIAS", confidence: 0.92 },
    });
  });
});

describe("within-envelope convergence (decision 5, in memory)", () => {
  it("twoSpellingsInOneEnvelope_convergeToOneEntity_insteadOfConflicting", async () => {
    const { service, dbPath } = runtime();
    const result = await service.promoteCandidate(envelope("intra-1", {
      entities: [entity("ACME Corp"), entity("Acme Corp.", { title: "ACME Corp" })],
    }));
    const created = mapping(result, "ACME Corp");
    expect(created.resolution.outcome).toBe("CREATED");
    expect(mapping(result, "Acme Corp.")).toMatchObject({
      canonicalRef: created.canonicalRef,
      resolution: { outcome: "MATCHED", strategy: "EXACT", confidence: 0.95 },
    });

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions").get().n).toBe(2);
  });
});

describe("replay stays frozen (D4) while decisions move on", () => {
  it("replayAfterALaterEnvelopeChangedTheDecision_returnsByteIdenticalEvidence", async () => {
    const { service } = runtime();
    const input = envelope("frozen-1", { entities: [entity("ACME Corp")] });
    const first = await service.promoteCandidate(input);
    expect(mapping(first, "ACME Corp").resolution.outcome).toBe("CREATED");

    // A later envelope re-decides the same mention string — recomputing
    // frozen-1 today would say MATCHED, not CREATED.
    const later = await service.promoteCandidate(envelope("frozen-2", { entities: [entity("ACME Corp")] }));
    expect(mapping(later, "ACME Corp").resolution.outcome).toBe("MATCHED");

    // Replay returns the promotion snapshot: the original CREATED evidence,
    // byte-identical — never a recomputation.
    await expect(service.promoteCandidate(input)).resolves.toEqual({ ...first, idempotent: true });
  });
});

describe("relations survive unresolved endpoints (D10.1)", () => {
  it("endpointReviewRequired_recordsPendingRelation_entitiesStillPromote", async () => {
    const { service, dbPath } = runtime();
    await service.promoteCandidate(envelope("rel-1", {
      entities: [entity("beta", { title: "Beta Industrial Holdings" })],
    }));

    // beta re-appears with a materially conflicting title (REVIEW_REQUIRED,
    // no canonical ref); alpha is new. The envelope still promotes alpha,
    // and the relation is held pending with its mention endpoints instead
    // of aborting the whole envelope.
    const result = await service.promoteCandidate(envelope("rel-2", {
      entities: [
        entity("alpha", { title: "Alpha Co" }),
        entity("beta", { title: "Totally Different Name" }),
      ],
      relations: [{ fromRef: "alpha", relationType: "DEPENDS_ON", toRef: "beta" }],
    }));
    const alpha = mapping(result, "alpha");
    expect(alpha.resolution.outcome).toBe("CREATED");
    expect(mapping(result, "beta").resolution.outcome).toBe("REVIEW_REQUIRED");

    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM relations").get().n).toBe(0);
    const pending = raw.prepare("SELECT * FROM pending_relations").all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      from_candidate_ref: "alpha",
      relation_type: "DEPENDS_ON",
      to_candidate_ref: "beta",
      status: "PENDING",
      promotion_idempotency_key: "rel-2",
      provenance_ref: "msp:proof/rel-2",
    });
    // The mention endpoints are the same ids the envelope's mention rows
    // were written under — the join a later materialization needs is total.
    const mentionIds = new Map(raw.prepare("SELECT candidate_ref, mention_id FROM entity_mentions WHERE promotion_idempotency_key = 'rel-2'").all().map((row) => [row.candidate_ref, row.mention_id]));
    expect(pending[0].from_mention_id).toBe(mentionIds.get("alpha"));
    expect(pending[0].to_mention_id).toBe(mentionIds.get("beta"));

    // And the pending-bearing promotion replays byte-identically too.
    const replay = await service.promoteCandidate(envelope("rel-2", {
      entities: [
        entity("alpha", { title: "Alpha Co" }),
        entity("beta", { title: "Totally Different Name" }),
      ],
      relations: [{ fromRef: "alpha", relationType: "DEPENDS_ON", toRef: "beta" }],
    }, { source_snapshot_hash: result.source_hash }));
    expect(replay).toEqual({ ...result, idempotent: true });
  });

  it("endpointAbsentFromTheEnvelopeEntirely_isStillAHardError", async () => {
    const { service } = runtime();
    await expect(service.promoteCandidate(envelope("rel-bad", {
      entities: [entity("alpha", { title: "Alpha Co" })],
      relations: [{ fromRef: "alpha", relationType: "DEPENDS_ON", toRef: "never-declared" }],
    }))).rejects.toMatchObject({ code: "gks_invalid_request" });
  });
});
