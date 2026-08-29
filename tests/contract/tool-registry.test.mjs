import { describe, expect, it } from "vitest";
import { GKS_TOOL_DEFINITIONS } from "@freshair129/gks-contracts";

describe("public GKS tool registry", () => {
  it("registry_exposesOnlyTheApprovedServicePort", () => {
    expect(GKS_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "gks_health",
      "gks_knowledge_promote",
      "gks_search",
      "gks_entity_get",
      "gks_relations_get",
      "gks_artifact_link",
    ]);
  });

  it("api010PromotionSchema_preservesCompatibilityFields", () => {
    const promote = GKS_TOOL_DEFINITIONS.find((tool) => tool.name === "gks_knowledge_promote");
    expect(promote.inputSchema.required).toEqual([
      "schema_version",
      "idempotency_key",
      "run_id",
      "stage",
      "source_snapshot_hash",
      "provenance_ref",
      "candidate",
    ]);
    expect(promote.inputSchema.properties.schema_version.const).toBe("govibe-knowledge-candidate/v1");
  });
});
