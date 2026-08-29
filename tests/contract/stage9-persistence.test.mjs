// Stage 9 persistence behavior (ADR-GKS-ENTITY-RESOLUTION D1, D5, decisions
// 5, 7, 8): every promotion occurrence writes a mention row; writes against
// an existing entity are additive-only with conflicting non-empty diffs
// recorded on the mention; losing the UNIQUE(scope_key, norm_key) race
// surfaces as a typed conflict carrying the winner; and the resolution pool
// filters every scope dimension in SQL with the tenant wall exact.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GksNormKeyConflictError, normKey, scopeKey } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { HASH_A, promotion, scope } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-stage9-"));
  const dbPath = path.join(dir, "gks.sqlite");
  const persistence = openSqlitePersistence({ dbPath });
  cleanups.push(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service: createGksService({ persistence }), persistence, dbPath };
}

function openRaw(dbPath) {
  const raw = new Database(dbPath);
  cleanups.push(() => raw.close());
  return raw;
}

function envelope(idempotencyKey, entities, overrides = {}) {
  return promotion({
    idempotency_key: idempotencyKey,
    provenance_ref: `msp:proof/${idempotencyKey}`,
    candidate: { entities },
    ...overrides,
  });
}

describe("mentions are per-occurrence and entity writes are additive (D1, decision 7)", () => {
  it("sameCandidateRefTwoEnvelopes_yieldsTwoMentions_notOneOverwrittenRow", async () => {
    const { service, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("acme-co-1", [
      { candidateRef: "acme", type: "ENTITY", title: "ACME Corporation (Thailand)", summary: "Industrial conglomerate." },
    ]));
    const canonicalRef = first.canonical_mappings[0].canonicalRef;

    // The old over-merge: a re-assertion of the same mention string used to
    // overwrite title and summary via ON CONFLICT ... DO UPDATE with no
    // conflict and no audit trail. Now the ladder resolves the second
    // occurrence against the first (same creating spelling, same title — no
    // contradiction), the entity keeps its first non-empty fields, and the
    // conflicting summary lands on the second occurrence's own mention row
    // as a proposed edit. (The different-TITLE flavour of this scenario is
    // the contradiction check, pinned in resolver-ladder.test.mjs.)
    await service.promoteCandidate(envelope("acme-co-2", [
      { candidateRef: "acme", type: "ENTITY", title: "ACME Corporation (Thailand)", summary: "A different summary entirely." },
    ], { source_snapshot_hash: "d".repeat(64) }));

    const raw = openRaw(dbPath);
    const entities = raw.prepare("SELECT * FROM entities WHERE candidate_ref = 'acme'").all();
    expect(entities).toHaveLength(1);
    expect(entities[0].canonical_ref).toBe(canonicalRef);
    expect(entities[0].title).toBe("ACME Corporation (Thailand)");
    expect(entities[0].summary).toBe("Industrial conglomerate.");

    const mentions = raw.prepare("SELECT * FROM entity_mentions WHERE candidate_ref = 'acme' ORDER BY promotion_idempotency_key").all();
    expect(mentions).toHaveLength(2);
    expect(new Set(mentions.map((m) => m.mention_id)).size).toBe(2);
    expect(mentions.map((m) => m.promotion_idempotency_key)).toEqual(["acme-co-1", "acme-co-2"]);
    for (const mention of mentions) {
      expect(mention.canonical_ref).toBe(canonicalRef);
      expect(mention.norm_key).toBe("acme");
      expect(mention.provenance_ref).toBe(`msp:proof/${mention.promotion_idempotency_key}`);
      expect(mention.mention_id.startsWith("gks:mention/")).toBe(true);
    }
    expect(mentions[0]).toMatchObject({ outcome: "CREATED", strategy: "CREATED", confidence: 1, field_diffs_json: null });
    expect(mentions[1]).toMatchObject({ outcome: "MATCHED", strategy: "EXACT", confidence: 0.95 });

    // The conflicting non-empty field lands on the SECOND mention as a
    // proposed edit — never on the entity.
    expect(JSON.parse(mentions[1].field_diffs_json)).toEqual([
      { field: "summary", stored: "Industrial conglomerate.", incoming: "A different summary entirely." },
    ]);
  });

  it("matchedWrite_fillsOnlyEmptyFields_andUnionsAliases", async () => {
    const { service, persistence, dbPath } = runtime();
    const first = await service.promoteCandidate(envelope("fill-1", [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]));
    const canonicalRef = first.canonical_mappings[0].canonicalRef;
    expect(persistence.getEntity(canonicalRef)).toMatchObject({ summary: "", sourceRef: null, normKey: "acme", normVersion: "norm_v1" });

    await service.promoteCandidate(envelope("fill-2", [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp", summary: "Filled later.", sourceRef: "doc:acme-profile" },
    ], { source_snapshot_hash: "d".repeat(64) }));

    const entity = persistence.getEntity(canonicalRef);
    expect(entity.summary).toBe("Filled later.");
    expect(entity.sourceRef).toBe("doc:acme-profile");
    // Decision 7: the matched occurrence's normalized form joins the alias
    // set, which is what lets the ALIAS rung improve over time.
    expect(entity.aliases).toContain("acme");

    const raw = openRaw(dbPath);
    const second = raw.prepare("SELECT * FROM entity_mentions WHERE promotion_idempotency_key = 'fill-2'").get();
    expect(second.field_diffs_json).toBeNull();
  });
});

describe("norm_key conflicts surface to the caller (decision 5)", () => {
  // These two tests drive transactPromotion DIRECTLY. Through the service,
  // the resolver ladder now reads the pool first and converges to MATCHED
  // before the constraint can fire — which is decision 5 working, and is
  // pinned in resolver-ladder.test.mjs. The adapter's half of the contract
  // is still load-bearing on its own: it is what a genuinely CONCURRENT
  // writer hits (two processes resolving CREATED against the same
  // not-yet-existing entity), and the retry-to-MATCHED loop is only sound
  // if the loss surfaces as this typed, rolled-back conflict.
  function createdEntity(candidateRef, canonicalRef, title = candidateRef) {
    return {
      candidateRef,
      type: "ENTITY",
      title,
      summary: "",
      sourceRef: null,
      confidence: null,
      metadata: {},
      aliases: [],
      externalRefs: [],
      canonicalRef,
      normKey: normKey(candidateRef),
      normVersion: "norm_v1",
      resolution: { outcome: "CREATED", strategy: "CREATED", confidence: 1 },
    };
  }

  function adapterPromotion(persistence, idempotencyKey, entities) {
    const promotionScope = scope();
    return persistence.transactPromotion({
      scope: promotionScope,
      scopeKey: scopeKey(promotionScope),
      idempotencyKey,
      knowledgeRef: `gks:knowledge/gks_knowledge_${idempotencyKey}`,
      sourceHash: HASH_A,
      provenanceRef: `msp:proof/${idempotencyKey}`,
      candidate: { entities: [] },
      entities,
      relations: [],
      pendingRelations: [],
      canonicalMappings: entities.map((entity) => ({ candidateRef: entity.candidateRef, canonicalRef: entity.canonicalRef, canonicalType: "ENTITY", resolution: entity.resolution })),
    });
  }

  it("secondWriterSameNormKeyDifferentCandidateRef_surfacesTypedConflictWithWinner_andRollsBack", async () => {
    const { persistence, dbPath } = runtime();
    const winnerRef = "gks:entity/acme-corp-" + "a1".repeat(16);
    adapterPromotion(persistence, "norm-1", [createdEntity("ACME Corp", winnerRef)]);

    // A concurrent writer resolved CREATED for a different spelling before
    // the winner became visible in its pool read. The adapter must surface
    // the loss of the uniqueness race as a typed conflict carrying the
    // winning row — never a silent second entity.
    let caught = null;
    try {
      adapterPromotion(persistence, "norm-2", [createdEntity("Acme Corp.", "gks:entity/acme-corp-" + "b2".repeat(16), "ACME Corp")]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GksNormKeyConflictError);
    expect(caught).toMatchObject({
      code: "gks_conflict",
      candidateRef: "Acme Corp.",
      normKey: "acme",
      winner: expect.objectContaining({ canonicalRef: winnerRef, normKey: "acme" }),
    });

    // The whole envelope rolled back: no second entity, no mention, no
    // promotion row for the losing envelope.
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE promotion_idempotency_key = 'norm-2'").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM promotions WHERE idempotency_key = 'norm-2'").get().n).toBe(0);
  });

  it("oneTransactionTwoCreatedRowsSameNormKey_alsoSurfacesTheConflict_andRollsBackWhole", async () => {
    const { persistence, dbPath } = runtime();
    expect(() => adapterPromotion(persistence, "norm-both", [
      createdEntity("ACME Corp", "gks:entity/acme-corp-" + "a1".repeat(16)),
      createdEntity("Acme Corp.", "gks:entity/acme-corp-" + "b2".repeat(16), "ACME Corp"),
    ])).toThrowError(GksNormKeyConflictError);

    // Atomicity: the first row of the failing envelope did not survive.
    const raw = openRaw(dbPath);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entities").get().n).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM promotions").get().n).toBe(0);
  });
});

describe("resolution pool SQL (decisions 5 and 8)", () => {
  async function seedPool(service) {
    const seed = async (idempotencyKey, candidateRef, scopeOverrides, sharing = "private") => {
      await service.promoteCandidate(envelope(idempotencyKey, [
        { candidateRef, type: "ENTITY", title: candidateRef },
      ], { scope: scope({ ...scopeOverrides, sharing }) }));
    };
    await seed("pool-a", "Tenant A Narrow", { tenantId: "tenant-a" });
    await seed("pool-a-broad", "Tenant A Broad", { tenantId: "tenant-a", businessId: "", workspaceId: "", projectId: "" });
    await seed("pool-a-other-project", "Tenant A Project B", { tenantId: "tenant-a", projectId: "project-b" });
    await seed("pool-b", "Tenant B Co", { tenantId: "tenant-b" });
    await seed("pool-b-shared", "Tenant B Shared", { tenantId: "tenant-b" }, "portfolio-shared");
    await seed("pool-none", "No Tenant Co", { tenantId: "" });
  }

  it("pool_matchesSameOrBroaderScope_belowTheTenantWall_neverNarrower", async () => {
    const { service, persistence } = runtime();
    await seedPool(service);

    // Mention at project-a in tenant-a: sees its own scope and ancestors,
    // never the sibling project (downward matching would pull narrow
    // knowledge up past its scope), never another tenant, never the
    // tenant-less pool, and sharing buys tenant-b nothing.
    const pool = persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "tenant-a" }) });
    expect(pool.map((entity) => entity.candidateRef).sort()).toEqual(["Tenant A Broad", "Tenant A Narrow"]);

    // Mention at the tenant level (empty business/workspace/project) pools
    // only tenant-level-or-broader entities — the narrow ones are excluded.
    const broadPool = persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "tenant-a", businessId: "", workspaceId: "", projectId: "" }) });
    expect(broadPool.map((entity) => entity.candidateRef)).toEqual(["Tenant A Broad"]);
  });

  it("pool_tenantWallIsExactEquality_emptyTenantIsATenantOfItsOwn", async () => {
    const { service, persistence } = runtime();
    await seedPool(service);

    // The tenant-less pool holds ONLY tenant-less knowledge: empty matches
    // empty, never "any tenant" — the visible() wildcard hazard the ADR
    // names is exactly what this predicate must not reproduce.
    const tenantless = persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "" }) });
    expect(tenantless.map((entity) => entity.candidateRef)).toEqual(["No Tenant Co"]);

    // And a tenanted mention never pools tenant-less knowledge.
    const tenantA = persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "tenant-a" }) });
    expect(tenantA.every((entity) => entity.scope.tenantId === "tenant-a")).toBe(true);

    // A third tenant sees nothing at all — not tenant-a, not tenant-b,
    // not portfolio-shared tenant-b (sharing is not a pooling dimension),
    // not tenant-less.
    const tenantC = persistence.lookupResolutionCandidates({ scope: scope({ tenantId: "tenant-c" }) });
    expect(tenantC).toEqual([]);

    // A different portfolio sees nothing either.
    const otherPortfolio = persistence.lookupResolutionCandidates({ scope: scope({ portfolioId: "portfolio-other", tenantId: "tenant-a" }) });
    expect(otherPortfolio).toEqual([]);
  });
});

describe("promotion evidence stays frozen (D4) while mentions accumulate", () => {
  it("replayAfterALaterEnvelopeTouchedTheEntity_returnsTheOriginalSnapshot", async () => {
    const { service } = runtime();
    const input = envelope("frozen-1", [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp" },
    ]);
    const first = await service.promoteCandidate(input);

    // A later envelope adds a mention against the same entity (and fills
    // its empty summary) — the mention table has legitimately moved on.
    await service.promoteCandidate(envelope("frozen-2", [
      { candidateRef: "ACME Corp", type: "ENTITY", title: "ACME Corp", summary: "Enriched later." },
    ], { source_snapshot_hash: "d".repeat(64) }));

    // Replay still returns the promotion snapshot byte-identically.
    await expect(service.promoteCandidate(input)).resolves.toEqual({ ...first, idempotent: true });
  });
});
