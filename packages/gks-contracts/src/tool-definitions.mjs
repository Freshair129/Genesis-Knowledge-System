export const GKS_TOOL_DEFINITIONS = Object.freeze([
  { name: "gks_health", description: "Reports standalone GKS service health.", inputSchema: { type: "object", additionalProperties: false } },
  {
    name: "gks_knowledge_promote",
    description: "Promotes one MSP-authorized knowledge candidate.",
    inputSchema: {
      type: "object",
      properties: {
        schema_version: { type: "string", const: "govibe-knowledge-candidate/v1" },
        idempotency_key: { type: "string", minLength: 1 },
        run_id: { type: "string", minLength: 1 },
        stage: { type: "integer", minimum: 1, maximum: 12 },
        source_snapshot_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        provenance_ref: { type: "string", pattern: "^msp:proof/" },
        candidate: { type: "object" },
        scope: { type: "object" },
        pipeline_stage_id: { type: "string", pattern: "^DPS-KI-[A-Z0-9]+(-[A-Z0-9]+)*$" },
      },
      required: ["schema_version", "idempotency_key", "run_id", "stage", "source_snapshot_hash", "provenance_ref", "candidate"],
      additionalProperties: true,
    },
  },
  { name: "gks_search", description: "Searches canonical knowledge within scope.", inputSchema: { type: "object", required: ["query", "scope"] } },
  { name: "gks_entity_get", description: "Gets one canonical entity within scope.", inputSchema: { type: "object", required: ["ref", "scope"] } },
  { name: "gks_relations_get", description: "Gets canonical relations within scope.", inputSchema: { type: "object", required: ["ref", "scope"] } },
  { name: "gks_artifact_link", description: "Links an external artifact reference to canonical knowledge.", inputSchema: { type: "object", required: ["knowledgeRef", "artifactRef", "relationType", "evidenceRef", "scope"] } },
  // Stage 9 D9: the unresolved-mention consumer. The read tool lists the
  // review queue within scope; the write tool applies ONE human decision --
  // bind an unresolved mention to an existing canonical entity, or merge two
  // canonical entities with supersession and relation re-pointing in the
  // same transaction (D10.2). Human-authorized repair, never resolver reach.
  { name: "gks_review_list", description: "Lists unresolved entity mentions (REVIEW_REQUIRED / AMBIGUOUS) within scope.", inputSchema: { type: "object", required: ["scope"] } },
  {
    name: "gks_review_apply",
    description: "Applies one human resolution decision: bind an unresolved mention to a canonical entity, or merge two canonical entities.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["BIND", "MERGE"] },
        provenanceRef: { type: "string", pattern: "^msp:proof/" },
        scope: { type: "object" },
        mentionId: { type: "string", pattern: "^gks:mention/[a-f0-9]{32}$" },
        canonicalRef: { type: "string", pattern: "^gks:entity/[a-z0-9-]+-[a-f0-9]{32}$" },
        survivorRef: { type: "string", pattern: "^gks:entity/[a-z0-9-]+-[a-f0-9]{32}$" },
        supersededRef: { type: "string", pattern: "^gks:entity/[a-z0-9-]+-[a-f0-9]{32}$" },
      },
      required: ["action", "provenanceRef", "scope"],
      additionalProperties: true,
    },
  },
]);
