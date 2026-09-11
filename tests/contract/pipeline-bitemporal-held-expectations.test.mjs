// @req FR-109, FR-110 — Stage 17 quality authority's bitemporal-lane expectation.
// @spec ADR-GKS-GENESISRAG17.md (contract item C-10)
// @tested this file — pure unit coverage of pipelineReadbackExpectations, no SQLite.
//
// Residual of C-10 (PR #6, merged f72e3160): that fix made the expected bitemporal count
// equal the number of FACTS that carry valid time, matching the GenesisBlock worker's
// verifyTemporalLane -> mapped.length. But the worker's temporalRows() classifies facts AND
// held rows together (Freshair129/GenesisBlock genesisrag17-worker/src/worker.mjs, ~:1464-1469):
//
//   temporalRows(decision) {
//     return [
//       ...decision.facts.map((row) => ({ kind: 'fact', row, id: row.id ?? row.factId })),
//       ...decision.held.map((row) => ({ kind: 'held', row, id: row.id ?? row.factId })),
//     ];
//   }
//
// so a decision with a held row that carries valid time still disagreed on the count. This
// file hand-builds decisions (no batch submission, no persistence, no better-sqlite3) and
// calls pipelineReadbackExpectations directly, so it runs under Vitest on a machine where the
// SQLite-backed contract/integration tests abort (better-sqlite3 on this Windows/Node 24 box).
//
// This test file does not (and cannot, without SQLite) exercise the graph-dimension gate
// itself — that stays covered by tests/contract/pipeline-genesisrag17.test.mjs, which already
// asserts the mixed-facts case end to end via a real service + worker receipt.

import { describe, expect, it } from "vitest";
import { pipelineReadbackExpectations } from "@freshair129/gks-core";

// The worker's per-row classification (~:243-260), quoted verbatim for parity review:
//
//   function temporalClassification(row) {
//     const temporal = row?.temporal;
//     if (temporal === undefined) return 'not_applicable';
//     if (!isPlainObject(temporal)) return 'unsupported';
//     const status = temporalValue(row, 'status');
//     const validFrom = temporalValue(row, 'validFrom');
//     const validTo = temporalValue(row, 'validTo');
//     const noValidTime = (value) => value === undefined || value === null || value === 'not_applicable';
//     if (noValidTime(validFrom) && noValidTime(validTo)
//       && (status === undefined || status === 'not_applicable')) {
//       return 'not_applicable';
//     }
//     return 'mapped';
//   }
//
// GKS's fix (packages/gks-core/src/pipeline.mjs, temporalRowClassification) mirrors it exactly:
//
//   function temporalRowClassification(row) {
//     const temporal = row?.temporal;
//     if (temporal === undefined) return "not_applicable";
//     if (!isPlainTemporalObject(temporal)) return "unsupported";
//     const noValidTime = (value) => value === undefined || value === null || value === "not_applicable";
//     // The worker's temporalValue() reads the camelCase key, then its snake_case form.
//     const pick = (key) => temporal[key] ?? temporal[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
//     const validFrom = pick("validFrom");
//     const validTo = pick("validTo");
//     const status = pick("status");
//     if (noValidTime(validFrom) && noValidTime(validTo) && (status === undefined || status === "not_applicable")) {
//       return "not_applicable";
//     }
//     return "mapped";
//   }
//
// A row is "dated" (mapped) unless validFrom and validTo are both undefined/null/
// "not_applicable" AND status is undefined/"not_applicable" — applied uniformly to facts and
// held, never distinguishing which collection the row came from, exactly like the worker.

const DATED = { validFrom: "2026-09-01T00:00:00.000Z", validTo: null, status: "mapped" };
const NOT_APPLICABLE = { validFrom: "not_applicable", validTo: "not_applicable" };
// Real held records built by heldRecord() in pipeline.mjs never carry a `.temporal` key at
// all — the worker's `temporal === undefined` branch is what classifies those as not_applicable.
const NO_TEMPORAL_KEY = undefined;

function fact(id, temporal) {
  return { id, subjectId: `subject-${id}`, objectId: `object-${id}`, predicate: "WORKS_FOR", confidence: 0.9, temporal, sourceReferences: {} };
}

function heldRow(id, temporal) {
  const row = { id, reason: "temporal_unmapped", predicate: "WORKS_FOR", confidence: 0.5, sourceReferences: {} };
  if (temporal !== undefined) row.temporal = temporal;
  return row;
}

describe("pipelineReadbackExpectations — bitemporal lane (C-10 held-row residual)", () => {
  it("counts held rows that carry valid time alongside dated facts", () => {
    const decision = {
      facts: [fact("f1", DATED), fact("f2", NOT_APPLICABLE)],
      held: [heldRow("h1", DATED), heldRow("h2", NOT_APPLICABLE)],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    // 1 dated fact + 1 dated held row — not facts.length (2) and not facts-only dated (1).
    expect(expectedLaneObjects.bitemporal).toBe(2);
  });

  it("does not count a held row that carries no valid time", () => {
    const decision = {
      facts: [fact("f1", DATED), fact("f2", DATED)],
      held: [heldRow("h1", NOT_APPLICABLE), heldRow("h2", NO_TEMPORAL_KEY)],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    // Both held rows are not_applicable (one explicit, one via the missing-key branch) —
    // the expected count stays exactly the dated-fact count.
    expect(expectedLaneObjects.bitemporal).toBe(2);
  });

  it("expects zero when facts and held are all not_applicable, considered together", () => {
    const decision = {
      facts: [fact("f1", NOT_APPLICABLE)],
      held: [heldRow("h1", NOT_APPLICABLE), heldRow("h2", NO_TEMPORAL_KEY)],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    expect(expectedLaneObjects.bitemporal).toBe(0);
  });

  it("expects zero when there are no facts and no held rows at all", () => {
    const decision = { facts: [], held: [] };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    expect(expectedLaneObjects.bitemporal).toBe(0);
  });

  it("keeps the existing mixed-facts case unchanged when there are no held rows (PR #6 regression)", () => {
    const decision = {
      facts: [fact("f1", DATED), fact("f2", NOT_APPLICABLE)],
      held: [],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    expect(expectedLaneObjects.bitemporal).toBe(1);
  });

  it("matches the worker's exact classification boundary: status alone can make a row 'mapped' even when validFrom/validTo are not_applicable", () => {
    // This is the case the pre-fix code (which only ever looked at validFrom/validTo) could
    // not represent: temporalClassification's noValidTime check on validFrom/validTo is not
    // enough on its own — a non-not_applicable, non-undefined status also forces 'mapped'.
    const statusOnlyDated = { validFrom: "not_applicable", validTo: "not_applicable", status: "mapped" };
    const decision = {
      facts: [fact("f1", statusOnlyDated)],
      held: [heldRow("h1", statusOnlyDated)],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    expect(expectedLaneObjects.bitemporal).toBe(2);
  });

  it("reads snake_case temporal keys the way the worker's temporalValue() does", () => {
    // The worker falls back from validFrom/validTo to valid_from/valid_to; GKS must too, or a
    // snake_case row would be dated for the worker and not_applicable here.
    const snakeDated = { valid_from: "2026-09-01T00:00:00.000Z", valid_to: null };
    const snakeNotApplicable = { valid_from: "not_applicable", valid_to: "not_applicable" };
    const decision = {
      facts: [fact("f1", snakeDated), fact("f2", snakeNotApplicable)],
      held: [heldRow("h1", snakeDated)],
    };
    const { expectedLaneObjects } = pipelineReadbackExpectations(decision);
    expect(expectedLaneObjects.bitemporal).toBe(2);
  });
});
