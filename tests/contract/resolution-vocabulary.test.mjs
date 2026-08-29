// Stage 9 shared vocabulary (ADR-GKS-ENTITY-RESOLUTION decisions 1 and 2).
// These values are contract: an implementation may not re-tune them, only an
// ADR amendment may. The structural test below is the load-bearing one --
// the floor's whole design is WHICH rungs may auto-merge, not the number.
import { describe, expect, it } from "vitest";
import {
  CONTRADICTION_CONFIDENCE,
  DEFAULT_AUTOMERGE_FLOOR,
  FUZZY_CONFIDENCE_CEILING,
  RESOLUTION_OUTCOMES,
  RESOLUTION_STRATEGIES,
  STRATEGY_CONFIDENCE,
  automergeFloor,
} from "@freshair129/gks-contracts";

describe("Stage 9 resolution vocabulary", () => {
  it("outcomes_areExactlyTheFiveFr109Values", () => {
    expect(RESOLUTION_OUTCOMES).toEqual(["MATCHED", "CREATED", "AMBIGUOUS", "REVIEW_REQUIRED", "REJECTED"]);
    expect(Object.isFrozen(RESOLUTION_OUTCOMES)).toBe(true);
  });

  it("strategies_areTheLadderInRungOrderPlusHumanAndBackfill", () => {
    expect(RESOLUTION_STRATEGIES).toEqual([
      "CANONICAL_REF",
      "EXTERNAL_REF",
      "EXACT",
      "ALIAS",
      "DETERMINISTIC",
      "FUZZY",
      "CREATED",
      "HUMAN",
      "BACKFILL",
    ]);
    expect(Object.isFrozen(RESOLUTION_STRATEGIES)).toBe(true);
  });

  it("rungConfidences_areTheFixedDecisionOneValues", () => {
    expect(STRATEGY_CONFIDENCE).toEqual({
      CANONICAL_REF: 1,
      EXTERNAL_REF: 0.98,
      EXACT: 0.95,
      ALIAS: 0.92,
      DETERMINISTIC: 0.88,
      CREATED: 1,
    });
    // FUZZY is detect-only: a ceiling, never a fixed rung confidence.
    expect(STRATEGY_CONFIDENCE.FUZZY).toBeUndefined();
    expect(FUZZY_CONFIDENCE_CEILING).toBe(0.84);
    expect(CONTRADICTION_CONFIDENCE).toBe(0.6);
  });

  it("floorIsStructural_deterministicMayMergeAndFuzzyNeverCan", () => {
    expect(DEFAULT_AUTOMERGE_FLOOR).toBe(0.85);
    expect(STRATEGY_CONFIDENCE.DETERMINISTIC).toBeGreaterThanOrEqual(DEFAULT_AUTOMERGE_FLOOR);
    expect(FUZZY_CONFIDENCE_CEILING).toBeLessThan(DEFAULT_AUTOMERGE_FLOOR);
    // The contradiction overlay lands below the floor: REVIEW_REQUIRED, not a merge.
    expect(CONTRADICTION_CONFIDENCE).toBeLessThan(DEFAULT_AUTOMERGE_FLOOR);
  });
});

describe("automergeFloor deployment override (decision 2)", () => {
  it("floor_unsetOrEmptyEnvironment_returnsTheCodeDefault", () => {
    expect(automergeFloor({})).toBe(0.85);
    expect(automergeFloor({ GKS_AUTOMERGE_FLOOR: "" })).toBe(0.85);
    expect(automergeFloor(undefined)).toBe(0.85);
  });

  it("floor_deploymentOverride_isHonoredWithinRange", () => {
    expect(automergeFloor({ GKS_AUTOMERGE_FLOOR: "0.92" })).toBe(0.92);
    expect(automergeFloor({ GKS_AUTOMERGE_FLOOR: "1" })).toBe(1);
    expect(automergeFloor({ GKS_AUTOMERGE_FLOOR: "0" })).toBe(0);
  });

  it("floor_invalidOverride_failsClosedAtStartupInsteadOfMergingUnderIt", () => {
    for (const bad of ["banana", "NaN", "Infinity", "-Infinity", "-0.1", "1.5"]) {
      expect(() => automergeFloor({ GKS_AUTOMERGE_FLOOR: bad }), `GKS_AUTOMERGE_FLOOR=${bad}`).toThrowError(/GKS_AUTOMERGE_FLOOR/);
    }
  });
});
