import { describe, expect, it } from "vitest";
import fixture from "../fixtures/temporal-engine-parity-v1.json" with { type: "json" };
import { compareTemporalOrder, createTemporalVersion, isTemporalVisible, nextVersion } from "@freshair129/gks-core";

describe("Stage 12 temporal engine parity fixture", () => {
  it("matches the pinned MSP create semantics", () => {
    for (const example of fixture.create) expect(createTemporalVersion(example.input, example.now)).toMatchObject(example.expected);
  });

  it("matches the pinned MSP visibility semantics", () => {
    for (const example of fixture.visible) expect(isTemporalVisible(example.item, example.options)).toBe(example.expected);
  });

  it("matches the pinned MSP ordering errors", () => {
    for (const example of fixture.order) expect(compareTemporalOrder(example.item)).toEqual(example.expected);
  });

  it("matches the pinned MSP version increment semantics", () => {
    for (const example of fixture.nextVersion) expect(nextVersion(example.records)).toBe(example.expected);
  });
});
