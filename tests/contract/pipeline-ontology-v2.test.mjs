// @req FR-109, FR-110 — ontology_v2 (GenesisRAG17 contract revision 2, ADR-075 Phase 2) at Stages 9-12 and the Stage 17 knowledge dimension.
// @spec ADR-GKS-GENESISRAG17.md, docs/reports/2026-09-11-genesisrag17-structured-record-profile-response.md
// Pure by design: nothing here opens SQLite. The persistence-backed flows
// (submit/claim/gate, a decision persisted before the upgrade) live in
// pipeline-genesisrag17.test.mjs; this file must stay runnable on hosts where
// better-sqlite3 aborts the Vitest worker.

import { describe, expect, it } from "vitest";
import {
  PIPELINE_ONTOLOGY_ENDPOINTS,
  buildPipelineDecision,
  derivePipelineSummaries,
  evaluatePipelineQuality,
  pipelineReadbackExpectations,
} from "@freshair129/gks-core";
import {
  PIPELINE_MODEL,
  PIPELINE_ONTOLOGY_VERSION,
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_STAGE_CATALOG,
  PIPELINE_SUPPORTED_ONTOLOGY_VERSIONS,
  hashPipelineDecision,
  normKey,
  pipelineEntityNormKey,
  sha256Text,
} from "@freshair129/gks-contracts";

const NOW = "2026-09-11T00:00:00.000Z";
const SCOPE = Object.freeze({ portfolioId: "portfolio-ov2", tenantId: "tenant-ov2", businessId: "business-ov2", workspaceId: "", agentId: "agent-ov2", visibility: "private" });

function makeBatch(id, entries, policy = { allowEmbedding: true, allowPublication: true }) {
  const content = entries.map((entry) => entry.text).join("\n");
  let sourceOffset = 0;
  const chunks = [];
  const mentions = [];
  for (const [ordinal, entry] of entries.entries()) {
    const chunkId = `${id}-chunk-${ordinal + 1}`;
    chunks.push({ chunkId, parsedArtifactId: `${id}-parsed`, ordinal, text: entry.text, contentHash: sha256Text(entry.text), startOffset: sourceOffset, endOffset: sourceOffset + entry.text.length });
    const occurrenceOffsets = new Map();
    for (const [mentionIndex, [name, resolutionKey, semanticType]] of entry.mentions.entries()) {
      const startOffset = entry.text.indexOf(name, occurrenceOffsets.get(name) ?? 0);
      if (startOffset < 0) throw new Error(`fixture error: ${name} is not in chunk ${chunkId}`);
      occurrenceOffsets.set(name, startOffset + name.length);
      mentions.push({ sourceMentionId: `${id}-mention-${ordinal + 1}-${mentionIndex + 1}`, resolutionKey, semanticType, name, chunkId, startOffset, endOffset: startOffset + name.length });
    }
    sourceOffset += entry.text.length + 1;
  }
  const runId = `${id}-run`;
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    batchId: id,
    idempotencyKey: `${id}-idempotency`,
    scope: SCOPE,
    runId,
    stages: PIPELINE_STAGE_CATALOG.map((stage) => ({ ...stage, runId, executionStepId: `${id}-step-${stage.stageNumber}`, attemptId: `${id}-attempt-${stage.stageNumber}` })),
    source: { sourceId: `${id}-source`, rawArtifactId: `${id}-raw`, parsedArtifactId: `${id}-parsed`, documentId: `${id}-document`, version: "1", contentHash: sha256Text(content), content },
    policy,
    chunks,
    mentions,
  };
}

const decide = (id, entries) => buildPipelineDecision(makeBatch(id, entries), { now: NOW });

// A C-4 claim chunk: the whole chunk text is the JSON object; subject and object
// are mentions at their exact offsets. `extra` carries the C-5 catalog date.
function claimChunk(subject, subjectType, predicate, object, objectType, extra = {}) {
  return { text: JSON.stringify({ subject, predicate, object, ...extra }), mentions: [[subject, subject, subjectType], [object, object, objectType]] };
}

// A C-4 descriptive chunk: retrieval text carrying exactly one mention.
function descriptiveChunk(label, code, semanticType) {
  return { text: `${label} (${code})`, mentions: [[code, code, semanticType]] };
}

const PKG = "PKG-XMAS-2026-SIGNATURE-CLEVEL";
const catalogEntries = [
  descriptiveChunk("Smart LED Temperature Thermos Bottle", "PM-BOTTLE-LED", "Product"),
  descriptiveChunk("Smart Executive Set", PKG, "PACKAGE"),
  claimChunk(PKG, "PACKAGE", "HAS_COMPONENT", "PM-NB", "Product"),
  claimChunk("PM-BOTTLE-LED", "Product", "PRICED_AT", "PM-BOTTLE-LED:qty100:20000", "PRICE_TIER"),
  claimChunk(PKG, "PACKAGE", "PRICED_AT", `${PKG}:qty10:93000`, "PRICE_TIER"),
  claimChunk("PM-BOTTLE-LED", "Product", "IN_CATEGORY", "cat:drinkware", "CATEGORY"),
  claimChunk(PKG, "PACKAGE", "IN_CATEGORY", "cat:gift-set", "CATEGORY"),
];

// Stage 13-16 receipts shaped exactly as a Tier-4 worker reports them, so the
// Stage 17 gate below exercises all five dimensions rather than one in isolation.
function gate(decision) {
  const derived = derivePipelineSummaries(decision, { now: NOW });
  const graphReceipt = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope: decision.scope,
    runId: decision.runId,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
    readback: { ok: true, nodeCount: decision.expectedGraphReadback.nodeCount, edgeCount: decision.expectedGraphReadback.edgeCount },
    graphReceiptHash: "a".repeat(64),
    derivedHash: "b".repeat(64),
    derived,
  };
  const { expectedReadback, expectedLaneObjects } = pipelineReadbackExpectations(decision, derived);
  const metric = (overrides = {}) => ({ records_in: 1, records_out: 1, records_quarantined: 0, error_count: 0, retry_count: 0, duration_ms: 1, ...overrides });
  const receipt = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    scope: decision.scope,
    runId: decision.runId,
    decisionId: decision.decisionId,
    decisionHash: decision.decisionHash,
    stages: decision.stages,
    graphReceiptHash: graphReceipt.graphReceiptHash,
    derivedHash: graphReceipt.derivedHash,
    executionTimes: {
      13: { startedAt: "2026-09-11T00:00:00.000Z", finishedAt: "2026-09-11T00:00:00.100Z" },
      15: { startedAt: "2026-09-11T00:00:01.000Z", finishedAt: "2026-09-11T00:00:01.100Z" },
      16: { startedAt: "2026-09-11T00:00:02.000Z", finishedAt: "2026-09-11T00:00:02.100Z" },
    },
    snapshotId: `${decision.batchId}-snapshot`,
    generation: `${decision.batchId}-generation`,
    model: { ...PIPELINE_MODEL, artifactHashes: { "model.safetensors": "a".repeat(64) } },
    transaction: { id: `${decision.batchId}-final-tx`, frontier: `${decision.batchId}-final-frontier`, checkpoint: `${decision.batchId}-final-checkpoint` },
    readback: { ok: true, ...expectedReadback },
    laneManifest: Object.fromEntries(Object.entries(expectedLaneObjects).map(([lane, objects]) => [lane, { status: lane === "bitemporal" && objects === 0 ? "not_applicable" : "ready", reason: "frozen-fixture", objects }])),
    metrics: {
      13: metric({ records_in: decision.expectedGraphReadback.nodeCount, records_out: decision.expectedGraphReadback.edgeCount }),
      15: metric({ records_in: decision.chunks.length, records_out: decision.chunks.length }),
      16: metric({ records_in: expectedReadback.nodeCount + expectedReadback.edgeCount, records_out: expectedReadback.nodeCount + expectedReadback.edgeCount }),
    },
    benchmark: { fixtureVersion: "ontology-v2-pure", queryCount: 5, recallAt5: 1, mrr: 1, citationCorrectness: 1, crossTenantLeaks: 0 },
  };
  return evaluatePipelineQuality(decision, receipt, { graphReceipt, derived });
}

// The stored form a decision takes when it was produced under another version:
// only ontologyVersion (and therefore decisionHash) differs. decisionId hashes
// {scope, batchId, batchHash}, never the version, so it is unchanged.
function stampedAs(decision, ontologyVersion) {
  const { decisionHash: ignored, ...withoutHash } = decision;
  const stamped = structuredClone({ ...withoutHash, ontologyVersion });
  return { ...stamped, decisionHash: hashPipelineDecision(stamped) };
}

describe("ontology_v2 contract constants", () => {
  it("produces ontology_v2 and supports exactly {ontology_v1, ontology_v2}", () => {
    expect(PIPELINE_ONTOLOGY_VERSION).toBe("ontology_v2");
    expect(PIPELINE_SUPPORTED_ONTOLOGY_VERSIONS).toEqual(["ontology_v1", "ontology_v2"]);
    expect(Object.isFrozen(PIPELINE_SUPPORTED_ONTOLOGY_VERSIONS)).toBe(true);
    expect(PIPELINE_SUPPORTED_ONTOLOGY_VERSIONS).toContain(PIPELINE_ONTOLOGY_VERSION);
    expect(Object.keys(PIPELINE_ONTOLOGY_ENDPOINTS)).toEqual([...PIPELINE_SUPPORTED_ONTOLOGY_VERSIONS]);
  });

  it("pins the predicate -> endpoint table the GenesisBlock worker carries verbatim", () => {
    const v1 = {
      WORKS_FOR: { subject: ["PERSON"], object: ["ORGANIZATION"] },
      PURCHASED: { subject: ["PERSON", "ORGANIZATION"], object: ["PRODUCT"] },
    };
    expect(JSON.parse(JSON.stringify(PIPELINE_ONTOLOGY_ENDPOINTS))).toEqual({
      ontology_v1: v1,
      ontology_v2: {
        ...v1,
        HAS_COMPONENT: { subject: ["PACKAGE"], object: ["PRODUCT"] },
        PRICED_AT: { subject: ["PRODUCT", "PACKAGE"], object: ["PRICE_TIER"] },
        IN_CATEGORY: { subject: ["PRODUCT", "PACKAGE"], object: ["CATEGORY"] },
      },
    });
    expect(Object.isFrozen(PIPELINE_ONTOLOGY_ENDPOINTS.ontology_v2.PRICED_AT.subject)).toBe(true);
    expect(PIPELINE_ONTOLOGY_ENDPOINTS.ontology_v2).not.toHaveProperty("PACKAGED_AS");
  });
});

describe("ontology_v2 Stage 10/11", () => {
  const passCases = [
    ["HAS_COMPONENT", [PKG, "PACKAGE"], ["PM-NB", "Product"]],
    ["PRICED_AT from a product", ["PM-BOTTLE-LED", "Product"], ["PM-BOTTLE-LED:qty100:20000", "PRICE_TIER"]],
    ["PRICED_AT from a package", [PKG, "PACKAGE"], [`${PKG}:qty10:93000`, "PRICE_TIER"]],
    ["IN_CATEGORY from a product", ["PM-BOTTLE-LED", "Product"], ["cat:drinkware", "CATEGORY"]],
    ["IN_CATEGORY from a package", [PKG, "PACKAGE"], ["cat:gift-set", "CATEGORY"]],
  ];
  for (const [label, [subject, subjectType], [object, objectType]] of passCases) {
    it(`maps a structured ${label} claim chunk to a 0.85 fact`, () => {
      const predicate = label.split(" ")[0];
      const decision = decide(`pass-${label.replace(/\W+/g, "-").toLowerCase()}`, [claimChunk(subject, subjectType, predicate, object, objectType)]);
      expect(decision.ontologyVersion).toBe("ontology_v2");
      expect(decision.held).toEqual([]);
      expect(decision.facts).toHaveLength(1);
      const subjectEntity = decision.entities.find((entity) => entity.name === subject);
      const objectEntity = decision.entities.find((entity) => entity.name === object);
      expect(decision.facts[0]).toMatchObject({ predicate, confidence: 0.85, basis: "structured", subjectId: subjectEntity.id, objectId: objectEntity.id });
    });
  }

  const invalidCases = [
    ["HAS_COMPONENT", "reversed (PRODUCT -> PACKAGE)", ["PM-NB", "Product"], [PKG, "PACKAGE"]],
    ["PRICED_AT", "from a CATEGORY", ["cat:drinkware", "CATEGORY"], ["PM-BOTTLE-LED:qty100:20000", "PRICE_TIER"]],
    ["PRICED_AT", "to a type spelled PriceTier (normalizes to PRICETIER)", ["PM-BOTTLE-LED", "Product"], ["PM-BOTTLE-LED:qty100:20000", "PriceTier"]],
    ["IN_CATEGORY", "reversed (CATEGORY -> PRODUCT)", ["cat:drinkware", "CATEGORY"], ["PM-BOTTLE-LED", "Product"]],
    ["HAS_COMPONENT", "from an OFFER, which v2 does not define", ["OFFER-TGC06-4", "OFFER"], ["PM-NB", "Product"]],
    ["PURCHASED", "to a PACKAGE (v1 predicates keep their v1 endpoints)", ["Alice", "Person"], [PKG, "PACKAGE"]],
  ];
  for (const [predicate, label, [subject, subjectType], [object, objectType]] of invalidCases) {
    it(`holds ${predicate} ${label} as invalid_endpoint`, () => {
      const decision = decide(`invalid-${predicate}-${label.replace(/\W+/g, "-").toLowerCase()}`.slice(0, 80), [claimChunk(subject, subjectType, predicate, object, objectType)]);
      expect(decision.facts).toEqual([]);
      expect(decision.held).toEqual([expect.objectContaining({ reason: "invalid_endpoint", confidence: 0.85 })]);
    });
  }

  it("normalizes each semanticType zuri-ai emits onto an ENDPOINT_TYPES key", () => {
    // Product, PACKAGE, CATEGORY, PRICE_TIER are the Stage 8 spellings. A type
    // that normalized to anything else would hold every catalog fact.
    const decision = decide("types-as-emitted", [
      claimChunk(PKG, "PACKAGE", "HAS_COMPONENT", "PM-NB", "Product"),
      claimChunk("PM-TMB", "Product", "PRICED_AT", "PM-TMB:qty100:20000", "PRICE_TIER"),
      claimChunk("PM-TMB", "Product", "IN_CATEGORY", "cat:drinkware", "CATEGORY"),
      claimChunk("PM-PEN", "Product", "PRICED_AT", "PM-PEN:qty1:19000", "price-tier"),
    ]);
    expect(decision.held).toEqual([]);
    expect(decision.facts.map((fact) => fact.predicate)).toEqual(["HAS_COMPONENT", "PRICED_AT", "IN_CATEGORY", "PRICED_AT"]);
    // Entities keep the supplied spelling; only the comparison is normalized.
    expect(decision.entities.map((entity) => entity.semanticType)).toEqual(expect.arrayContaining(["PACKAGE", "Product", "PRICE_TIER", "CATEGORY", "price-tier"]));
  });

  it("holds a dropped or unknown predicate as unknown_predicate", () => {
    for (const predicate of ["PACKAGED_AS", "OFFERED_AS"]) {
      const decision = decide(`unknown-${predicate.toLowerCase()}`, [claimChunk("PM-NB", "Product", predicate, PKG, "PACKAGE")]);
      expect(decision.facts).toEqual([]);
      expect(decision.held).toEqual([expect.objectContaining({ reason: "unknown_predicate", predicate })]);
    }
  });

  it("keeps ontology_v1 behaviour unchanged inside ontology_v2 decisions", () => {
    const decision = decide("v1-regression", [
      { text: "Alice works for Acme", mentions: [["Alice", "alice", "Person"], ["Acme", "acme", "Organization"]] },
      { text: '{"subject":"Bob","predicate":"purchased_from","object":"Atlas"}', mentions: [["Bob", "bob", "Person"], ["Atlas", "atlas", "Product"]] },
      { text: '{"subject":"Acme","predicate":"bought","object":"Atlas"}', mentions: [["Acme", "acme", "Organization"], ["Atlas", "atlas", "Product"]] },
      { text: '{"subject":"Carol","predicate":"works_for","object":"Atlas"}', mentions: [["Carol", "carol", "Person"], ["Atlas", "atlas", "Product"]] },
    ]);
    expect(decision.ontologyVersion).toBe("ontology_v2");
    expect(decision.facts.map((fact) => [fact.predicate, fact.confidence, fact.basis])).toEqual([
      ["WORKS_FOR", 0.9, "explicit"],
      ["PURCHASED", 0.85, "structured"],
      ["PURCHASED", 0.85, "structured"],
    ]);
    expect(decision.held).toEqual([expect.objectContaining({ reason: "invalid_endpoint", predicate: "works_for" })]);
  });

  it("holds a chunk with two mentions and no claim as an inferred 0.70 candidate below the write floor", () => {
    const decision = decide("inferred-hold", [
      { text: "Smart LED Temperature Thermos Bottle (PM-BOTTLE-LED) in cat:drinkware", mentions: [["PM-BOTTLE-LED", "PM-BOTTLE-LED", "Product"], ["cat:drinkware", "cat:drinkware", "CATEGORY"]] },
    ]);
    expect(decision.facts).toEqual([]);
    expect(decision.held).toEqual([expect.objectContaining({ reason: "confidence_below_write_floor", predicate: "INFERRED", confidence: 0.7 })]);
  });

  it("produces no candidate from a descriptive chunk carrying exactly one mention", () => {
    const decision = decide("descriptive-single", [descriptiveChunk("Smart LED Temperature Thermos Bottle", "PM-BOTTLE-LED", "Product")]);
    expect(decision.facts).toEqual([]);
    expect(decision.held).toEqual([]);
    expect(decision.stageMetrics[10]).toMatchObject({ records_in: 1, records_out: 0 });
  });
});

describe("ontology_v2 Stage 12 on claim chunks", () => {
  it("maps a claim chunk carrying one ISO date to an open-ended valid time", () => {
    const decision = decide("stage12-dated", [claimChunk("PM-BOTTLE-LED", "Product", "PRICED_AT", "PM-BOTTLE-LED:qty100:20000", "PRICE_TIER", { catalogVersion: "2026-09-10" })]);
    expect(decision.held).toEqual([]);
    expect(decision.facts[0].temporal).toMatchObject({ validFrom: "2026-09-10", validTo: null, txFrom: NOW, txTo: null });
    expect(decision.stageMetrics[12]).toMatchObject({ records_out: 1, unmapped: 0 });
  });

  it("marks a claim chunk with no date-shaped text not_applicable, never unmapped", () => {
    const decision = decide("stage12-undated", [claimChunk("PM-BOTTLE-LED", "Product", "PRICED_AT", "PM-BOTTLE-LED:qty100:20000", "PRICE_TIER")]);
    expect(decision.held).toEqual([]);
    expect(decision.facts[0].temporal).toMatchObject({ validFrom: "not_applicable", validTo: "not_applicable" });
    expect(decision.stageMetrics[12]).toMatchObject({ records_out: 1, unmapped: 0 });
  });
});

describe("PRICE_TIER resolution identity", () => {
  // {productCode}:{tier}:{price in satang}. Same product with a different tier or
  // price, and a different product with the same tier and price, are all distinct.
  const tierCodes = [
    ["PM-BOTTLE-LED", "Product", "PM-BOTTLE-LED:qty1:29000"],
    ["PM-BOTTLE-LED", "Product", "PM-BOTTLE-LED:qty10:26000"],
    ["PM-BOTTLE-LED", "Product", "PM-BOTTLE-LED:qty100:20000"],
    ["PM-BOTTLE-LED", "Product", "PM-BOTTLE-LED:qty100:20500"],
    ["PM-BOTTLE-LED", "Product", "PM-BOTTLE-LED:qty1000:15500"],
    ["PM-TMB", "Product", "PM-TMB:qty100:20000"],
    ["PM-NB", "Product", "PM-NB:qty1:75000"],
    ["PM-PB10K", "Product", "PM-PB10K:qty1:69000"],
    [PKG, "PACKAGE", `${PKG}:qty10:93000`],
    [PKG, "PACKAGE", `${PKG}:qty100:82000`],
  ];

  it("never folds two distinct tier codes into one norm_v1 key", () => {
    const keys = tierCodes.map(([, , code]) => normKey(code));
    expect(new Set(keys).size).toBe(tierCodes.length);
    expect(new Set(tierCodes.map(([, , code]) => pipelineEntityNormKey(code, "PRICE_TIER"))).size).toBe(tierCodes.length);
    // ":" is not a norm_v1 separator, so the three segments stay in one token.
    expect(normKey("PM-BOTTLE-LED:qty100:20000")).toBe("pm bottle led:qty100:20000");
  });

  it("resolves each distinct tier code to its own Stage 9 entity and fact", () => {
    const decision = decide("price-tier-identity", tierCodes.map(([product, productType, code]) => claimChunk(product, productType, "PRICED_AT", code, "PRICE_TIER")));
    const tiers = decision.entities.filter((entity) => entity.semanticType === "PRICE_TIER");
    expect(tiers).toHaveLength(tierCodes.length);
    expect(new Set(tiers.map((entity) => entity.id)).size).toBe(tierCodes.length);
    expect(decision.facts).toHaveLength(tierCodes.length);
    expect(new Set(decision.facts.map((fact) => fact.objectId)).size).toBe(tierCodes.length);
  });

  it("names the norm_v1 folds a tier code is still subject to", () => {
    // norm_v1 is frozen (NORM-V1-RULE-TABLE 1.0.0): case, the separators
    // _ - . , / \ & +, and a leading article token all fold. Codes that differ
    // only that way are one identity; SmartGift's PM-/PKG- codes cannot hit it.
    expect(normKey("PM-BOTTLE-LED:qty100:20000")).toBe(normKey("pm_bottle_led:qty100:20000"));
    expect(normKey("A-100:qty1:5000")).toBe(normKey("100:qty1:5000"));
  });
});

describe("ontology_v2 Stage 17 knowledge dimension", () => {
  it("passes a full ontology_v2 catalog decision and allows publication", () => {
    const decision = decide("gate-v2-catalog", catalogEntries);
    expect(decision.ontologyVersion).toBe("ontology_v2");
    expect(decision.held).toEqual([]);
    expect(decision.facts.map((fact) => fact.predicate)).toEqual(["HAS_COMPONENT", "PRICED_AT", "PRICED_AT", "IN_CATEGORY", "IN_CATEGORY"]);
    const quality = gate(decision);
    expect(quality.dimensions.knowledge).toEqual({ result: "PASS", critical: false, reasons: [] });
    expect(quality).toMatchObject({ verdict: "PASS", allowPublication: true });
  });

  it("passes a decision stored under ontology_v1 against the ontology_v1 table", () => {
    const v1 = stampedAs(decide("gate-v1-inflight", [
      { text: "Alice works for Acme", mentions: [["Alice", "alice", "Person"], ["Acme", "acme", "Organization"]] },
      { text: "Alice purchased Atlas.", mentions: [["Alice", "alice", "Person"], ["Atlas", "atlas", "Product"]] },
    ]), "ontology_v1");
    expect(v1.ontologyVersion).toBe("ontology_v1");
    const quality = gate(v1);
    expect(quality.dimensions.knowledge).toEqual({ result: "PASS", critical: false, reasons: [] });
    expect(quality).toMatchObject({ verdict: "PASS", allowPublication: true });
  });

  it("fails a decision whose facts are not valid under its own version", () => {
    const v1WithCatalogFacts = stampedAs(decide("gate-v1-with-v2-facts", catalogEntries), "ontology_v1");
    const quality = gate(v1WithCatalogFacts);
    expect(quality.dimensions.knowledge).toMatchObject({ result: "FAIL", critical: true });
    expect(quality.dimensions.knowledge.reasons).toHaveLength(5);
    expect(quality.dimensions.knowledge.reasons.every((reason) => reason.includes("is not a valid ontology_v1 relation"))).toBe(true);
    expect(quality).toMatchObject({ verdict: "FAIL", allowPublication: false });
  });

  it("fails an unsupported version and names the supported set, not ontology_v1 alone", () => {
    const quality = gate(stampedAs(decide("gate-unsupported", catalogEntries), "ontology_v3"));
    expect(quality.dimensions.knowledge).toMatchObject({ result: "FAIL", critical: true });
    expect(quality.dimensions.knowledge.reasons).toEqual(['ontology version "ontology_v3" is not a supported ontology version (ontology_v1, ontology_v2).']);
    expect(JSON.stringify(quality)).not.toContain("is not ontology_v1");
  });

  it("ends a catalog run with one held relation as WARN and never publishes it", () => {
    const decision = decide("gate-held-relation", [...catalogEntries, claimChunk("PM-NB", "Product", "PACKAGED_AS", PKG, "PACKAGE")]);
    expect(decision.held).toEqual([expect.objectContaining({ reason: "unknown_predicate" })]);
    const quality = gate(decision);
    expect(quality.dimensions.knowledge).toEqual({ result: "WARN", critical: false, reasons: ["1 fact(s) remain held for review."] });
    expect(quality).toMatchObject({ verdict: "WARN", allowPublication: false });
  });
});
