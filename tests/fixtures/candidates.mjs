export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

export function scope(overrides = {}) {
  return {
    portfolioId: "portfolio-zuri",
    tenantId: "tenant-a",
    businessId: "business-a",
    workspaceId: "workspace-a",
    projectId: "project-a",
    sharing: "private",
    ...overrides,
  };
}

export function promotion(overrides = {}) {
  return {
    schema_version: "govibe-knowledge-candidate/v1",
    idempotency_key: "promotion-1",
    run_id: "run-1",
    stage: 1,
    source_snapshot_hash: HASH_A,
    provenance_ref: "msp:proof/promotion-1",
    scope: scope(),
    candidate: {
      entities: [
        { candidateRef: "FEAT-LINE-LINKING", type: "FEAT", title: "LINE account linking", summary: "Links LINE accounts to customer identity." },
        { candidateRef: "ENTITY-CUSTOMER-IDENTITY", type: "ENTITY", title: "Customer identity", summary: "Canonical customer identity concept." },
      ],
      relations: [
        { fromRef: "FEAT-LINE-LINKING", relationType: "DEPENDS_ON", toRef: "ENTITY-CUSTOMER-IDENTITY" },
      ],
    },
    ...overrides,
  };
}
