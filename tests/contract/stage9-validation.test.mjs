// Stage 9 contract-layer validation (ADR-GKS-ENTITY-RESOLUTION decisions
// 2, 3 and D6): confidence fails closed, resolveTo is the ONE exemption to
// the gks: rejection, and the DPS-KI-* pipeline id travels in its own
// additive field while `stage` keeps meaning Deep Scan 1-12.
import { describe, expect, it } from "vitest";
import {
  GKS_TOOL_DEFINITIONS,
  validateEntityCandidate,
  validatePromotionRequest,
  validateRelationCandidate,
} from "@freshair129/gks-contracts";
import { promotion } from "../fixtures/candidates.mjs";

const WELL_FORMED_RESOLVE_TO = `gks:entity/acme-corp-${"0123456789abcdef".repeat(2)}`;

function entity(overrides = {}) {
  return { candidateRef: "ENTITY-ACME", type: "ENTITY", title: "ACME Corp", ...overrides };
}

function promotionWithEntity(overrides) {
  const input = promotion();
  input.candidate = { ...input.candidate, entities: [{ ...input.candidate.entities[0], ...overrides }, input.candidate.entities[1]] };
  return input;
}

describe("confidence validation (decision 2): finite in [0,1] or gks_invalid_request", () => {
  const rejected = [NaN, Infinity, -Infinity, -0.1, 1.0001, "0.5", true];

  it("entityConfidence_nanInfinityOutOfRangeOrNonNumber_failsClosed", () => {
    for (const confidence of rejected) {
      expect(() => validateEntityCandidate(entity({ confidence }), 0), `confidence=${String(confidence)}`)
        .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    }
  });

  it("relationConfidence_nanInfinityOutOfRangeOrNonNumber_failsClosed", () => {
    for (const confidence of rejected) {
      expect(() => validateRelationCandidate({ fromRef: "a", relationType: "DEPENDS_ON", toRef: "b", confidence }, 0), `confidence=${String(confidence)}`)
        .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    }
  });

  it("confidence_finiteInRange_passesThroughAndAbsentBecomesNull", () => {
    expect(validateEntityCandidate(entity({ confidence: 0 }), 0).confidence).toBe(0);
    expect(validateEntityCandidate(entity({ confidence: 0.85 }), 0).confidence).toBe(0.85);
    expect(validateEntityCandidate(entity({ confidence: 1 }), 0).confidence).toBe(1);
    expect(validateEntityCandidate(entity(), 0).confidence).toBeNull();
    // Explicit null is absence, never Number(null) === 0 -- the silent
    // coercion the bare Number() call used to perform.
    expect(validateEntityCandidate(entity({ confidence: null }), 0).confidence).toBeNull();
    expect(validateRelationCandidate({ fromRef: "a", relationType: "DEPENDS_ON", toRef: "b", confidence: 0.5 }, 0).confidence).toBe(0.5);
  });
});

describe("resolveTo (decision 3): the one exemption to the gks: rejection", () => {
  it("resolveTo_wellFormedOnACandidateEntity_isAccepted", () => {
    expect(() => validatePromotionRequest(promotionWithEntity({ resolveTo: WELL_FORMED_RESOLVE_TO }))).not.toThrow();
    expect(validateEntityCandidate(entity({ resolveTo: WELL_FORMED_RESOLVE_TO }), 0).resolveTo).toBe(WELL_FORMED_RESOLVE_TO);
    expect(validateEntityCandidate(entity(), 0).resolveTo).toBeNull();
  });

  it("resolveTo_malformedOnACandidateEntity_isRejected", () => {
    const malformed = [
      "gks:entity/forged",                                             // no digest
      `gks:knowledge/x-${"ab".repeat(16)}`,                            // wrong namespace
      `GKS:ENTITY/ACME-${"ab".repeat(16)}`,                            // wrong case
      `gks:entity/acme-${"ab".repeat(15)}`,                            // short digest
      42,                                                              // not a string
      null,                                                            // present key must carry the shape
    ];
    for (const resolveTo of malformed) {
      expect(() => validatePromotionRequest(promotionWithEntity({ resolveTo })), `resolveTo=${String(resolveTo)}`)
        .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    }
  });

  it("resolveTo_anywhereExceptACandidateEntity_staysRejected", () => {
    const onCandidateRoot = promotion();
    onCandidateRoot.candidate = { ...onCandidateRoot.candidate, resolveTo: WELL_FORMED_RESOLVE_TO };
    expect(() => validatePromotionRequest(onCandidateRoot)).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));

    expect(() => validatePromotionRequest(promotionWithEntity({ metadata: { resolveTo: WELL_FORMED_RESOLVE_TO } })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });

  it("gksPrefixedFreeText_atAnyDepth_staysRejected", () => {
    expect(() => validatePromotionRequest(promotionWithEntity({ metadata: { note: "gks:entity/whatever" } })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => validatePromotionRequest(promotionWithEntity({ summary: "gks:graph/1 is the version" })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    // And the forged-identity guard is untouched: CANONICAL_KEYS still reject.
    const forged = promotion();
    forged.candidate = { ...forged.candidate, canonicalRef: WELL_FORMED_RESOLVE_TO };
    expect(() => validatePromotionRequest(forged)).toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });
});

describe("pipeline stage id (D6): a string in its own additive field", () => {
  it("pipelineStageId_dpsKiString_isCarriedThroughUnchanged", () => {
    const normalized = validatePromotionRequest(promotion({ pipeline_stage_id: "DPS-KI-ENTITY-RESOLVE" }));
    expect(normalized.pipeline_stage_id).toBe("DPS-KI-ENTITY-RESOLVE");
    // stage keeps its Deep Scan meaning alongside the pipeline id.
    expect(normalized.stage).toBe(1);
  });

  it("pipelineStageId_absent_staysAbsent_api010Unchanged", () => {
    expect(validatePromotionRequest(promotion()).pipeline_stage_id).toBeUndefined();
  });

  it("pipelineStageId_nonStringOrNonDpsKiShape_isRejected", () => {
    for (const pipeline_stage_id of [9, "dps-ki-entity-resolve", "DEEP-SCAN-9", "DPS-KI-", ""]) {
      expect(() => validatePromotionRequest(promotion({ pipeline_stage_id })), `pipeline_stage_id=${String(pipeline_stage_id)}`)
        .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    }
  });

  it("stage_neverAcceptsThePipelineVocabulary_andStays1To12", () => {
    expect(() => validatePromotionRequest(promotion({ stage: "DPS-KI-ENTITY-RESOLVE" })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    expect(() => validatePromotionRequest(promotion({ stage: 13 })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });

  it("promoteToolSchema_addsPipelineStageIdAdditively_notRequired", () => {
    const promote = GKS_TOOL_DEFINITIONS.find((tool) => tool.name === "gks_knowledge_promote");
    expect(promote.inputSchema.properties.pipeline_stage_id).toEqual({ type: "string", pattern: "^DPS-KI-[A-Z0-9]+(-[A-Z0-9]+)*$" });
    expect(promote.inputSchema.required).not.toContain("pipeline_stage_id");
  });
});

describe("externalRefs (decision 1): the EXTERNAL_REF rung's evidence", () => {
  it("externalRefs_arrayOfStrings_isDeduplicated_andAbsentBecomesEmpty", () => {
    expect(validateEntityCandidate(entity({ externalRefs: ["wikidata:Q42", "crm:acct-77", "wikidata:Q42"] }), 0).externalRefs)
      .toEqual(["wikidata:Q42", "crm:acct-77"]);
    expect(validateEntityCandidate(entity(), 0).externalRefs).toEqual([]);
    expect(validateEntityCandidate(entity({ externalRefs: null }), 0).externalRefs).toEqual([]);
  });

  it("externalRefs_nonArrayOrNonStringMembers_failClosed", () => {
    for (const externalRefs of ["wikidata:Q42", { ref: "x" }, [42], [""], ["  "], [null]]) {
      expect(() => validateEntityCandidate(entity({ externalRefs }), 0), JSON.stringify(externalRefs))
        .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
    }
  });

  it("externalRefs_gksPrefixedValue_staysRejectedByTheCandidateWideGuard", () => {
    // An external ref is external by definition: the blanket gks: rejection
    // runs over the whole candidate and resolveTo stays its ONE exemption.
    expect(() => validatePromotionRequest(promotionWithEntity({ externalRefs: ["gks:entity/forged-00000000000000000000000000000000"] })))
      .toThrowError(expect.objectContaining({ code: "gks_invalid_request" }));
  });
});
