// @req FR-109, FR-110 — expose the frozen authenticated GenesisRAG17 tool surface.
// @spec ADR-GKS-GENESISRAG17.md, docs/plans/GENESISRAG17-CONTRACT.md
// @tested tests/contract/tool-registry.test.mjs, tests/contract/server-dispatch.test.mjs

const pipelineScope = { type: "object", required: ["portfolioId", "tenantId", "businessId", "workspaceId", "agentId", "visibility"] };
const pipelineEnvelope = {
  type: "object",
  properties: {
    schemaVersion: { type: "string", const: "genesisrag17.v1" },
    scope: pipelineScope,
    relayCredential: { type: "string", minLength: 1 },
    authenticatedPrincipal: { type: "object", required: ["principalId", "role", "scope"] },
  },
  required: ["schemaVersion", "scope", "relayCredential", "authenticatedPrincipal"],
  additionalProperties: true,
};

export const PIPELINE_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "gks_pipeline_submit",
    description: "Validates and durably accepts one GenesisRAG17 source batch for stages 9 through 17.",
    inputSchema: {
      ...pipelineEnvelope,
      required: [...pipelineEnvelope.required, "batch"],
      properties: { ...pipelineEnvelope.properties, batch: { type: "object" } },
    },
  },
  {
    name: "gks_pipeline_claim",
    description: "Claims one pending GenesisRAG17 decision without destructive dequeue.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required], properties: { ...pipelineEnvelope.properties, limit: { type: "integer", const: 1 } } },
  },
  {
    name: "gks_pipeline_graph_receipt",
    description: "Records the authenticated Tier4 graph receipt, then authorizes actual GKS enrichment for stages 13 and 14.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "receipt"], properties: { ...pipelineEnvelope.properties, receipt: { type: "object" } } },
  },
  {
    name: "gks_pipeline_stage_failure",
    description: "Records one authenticated worker failure as the terminal evidence for its exact stage attempt.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "runId", "decisionId", "decisionHash", "stage", "startedAt", "finishedAt", "metrics", "error"], properties: { ...pipelineEnvelope.properties, runId: { type: "string", minLength: 1 }, decisionId: { type: "string", minLength: 1 }, decisionHash: { type: "string" }, stage: { type: "object" }, startedAt: { type: "string", minLength: 1 }, finishedAt: { type: "string", minLength: 1 }, metrics: { type: "object" }, error: { type: "object" } } },
  },
  {
    name: "gks_pipeline_write_receipt",
    description: "Records an authenticated Tier4 worker receipt for stages 13, 15, and 16.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "receipt"], properties: { ...pipelineEnvelope.properties, receipt: { type: "object" } } },
  },
  {
    name: "gks_pipeline_gate",
    description: "Evaluates the five GenesisRAG17 quality dimensions against immutable evidence and a physical receipt.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "decisionId", "decisionHash"] },
  },
  {
    name: "gks_pipeline_publication_receipt",
    description: "Records the Tier4 publication receipt and closes Stage 17 evidence after a passing gate.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "receipt"], properties: { ...pipelineEnvelope.properties, receipt: { type: "object" } } },
  },
  {
    name: "gks_pipeline_evidence",
    description: "Pulls immutable GenesisRAG17 stage terminal evidence by scoped cursor.",
    inputSchema: { ...pipelineEnvelope, required: [...pipelineEnvelope.required, "runId"], properties: { ...pipelineEnvelope.properties, runId: { type: "string", minLength: 1 }, afterCursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } } },
  },
]);
