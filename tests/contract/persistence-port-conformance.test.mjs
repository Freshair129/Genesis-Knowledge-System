import { describe, expect, it } from "vitest";
import { assertGksPersistencePort } from "@freshair129/gks-contracts";

describe("GksPersistencePort replacement contract", () => {
  it("adapter_missingRequiredOperation_isRejectedBeforeServiceUse", () => {
    expect(() => assertGksPersistencePort({ health() {} })).toThrowError(expect.objectContaining({ code: "gks_invalid_backend_response" }));
  });

  it("adapter_completeSurface_isAcceptedWithoutNamingItsTechnology", () => {
    const adapter = Object.fromEntries([
      "health",
      "transactPromotion",
      "search",
      "getEntity",
      "getRelations",
      "transactArtifactLink",
      "close",
    ].map((name) => [name, () => undefined]));

    expect(assertGksPersistencePort(adapter)).toBe(adapter);
  });
});
