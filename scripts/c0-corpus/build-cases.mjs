// @req GKS-MIG-002, ADR-GKS-C0-QUALIFICATION D4 — builds the C0.4 golden
// corpus request fixtures (registry c0-qualification/v2).
//
//   node scripts/c0-corpus/build-cases.mjs
//
// Writes tests/fixtures/c0-qualification/cases/<id>.json and the registry. The
// output is deterministic: tests/contract/c0-golden-registry.test.mjs rebuilds
// it and fails when the committed fixtures differ, so a change to a shared
// test helper cannot silently change the corpus. After a deliberate change,
// rebuild, then re-baseline the expected transcripts with
// `node scripts/run-c0-corpus.mjs --write`.
//
// Pipeline fixtures need values that only exist after a claim: the in-process
// service below is run once to learn the deterministic ones (decision id,
// stage identities, expected readback counts). A value the server derives from
// its own clock (decisionHash and the receipt hashes chained from it) is
// written as a `$bind` to the earlier step's response instead.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GKS_MSP_AUTH_VERSION, GKS_TOOL_DEFINITIONS, PIPELINE_SCHEMA_VERSION, mspScopeDigest } from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion } from "../../tests/fixtures/candidates.mjs";
import { graphReceiptFor, makeBatch, metric, receiptFor } from "../../tests/fixtures/genesisrag17.mjs";
import { CORPUS_DIR, sha256Canonical } from "./runner.mjs";

export const REGISTRY_VERSION = "c0-qualification/v2";
export const FIXTURE_ID = "gks-c0.4-golden";
const REGISTRY_PATH = `${CORPUS_DIR}/registry.json`;

// Fixture-only credentials: not secrets, but the runner still proves they
// never reach process output or the store.
const PIPELINE_RELAY = "c0-fixture-pipeline-relay";
const MSP_RELAY = "c0-fixture-msp-relay";

const LEGACY_SCOPE = { portfolioId: "c0-portfolio", tenantId: "c0-tenant", businessId: "", workspaceId: "", projectId: "", sharing: "private" };
const TENANTLESS_SCOPE = { ...LEGACY_SCOPE, tenantId: "" };
const OTHER_TENANT_SCOPE = { ...LEGACY_SCOPE, tenantId: "c0-tenant-b" };
const PIPELINE_SCOPE = { portfolioId: "c0-portfolio", tenantId: "c0-tenant", businessId: "c0-business", workspaceId: "", agentId: "c0-agent", visibility: "private" };
const BASE_ENV = { GKS_DEFAULT_PORTFOLIO_ID: "c0-portfolio", GKS_PIPELINE_RELAY_CREDENTIAL: PIPELINE_RELAY };

const source = { relayCredential: PIPELINE_RELAY, authenticatedPrincipal: { principalId: "source-principal", role: "source", scope: PIPELINE_SCOPE } };
const worker = { relayCredential: PIPELINE_RELAY, authenticatedPrincipal: { principalId: "worker-principal", role: "worker", scope: PIPELINE_SCOPE } };
const bind = (reference) => ({ $bind: reference });

// One case's steps, with JSON-RPC ids numbered from 1.
function steps() {
  let nextId = 1;
  const list = [];
  const frame = (method, params) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  return {
    list,
    protocol(method, params, expect) {
      list.push({ kind: "call", frame: frame(method, params), ...(expect ? { expect } : {}) });
    },
    call(name, tool, args, expect, meta) {
      list.push({ kind: "call", ...(name ? { name } : {}), frame: frame("tools/call", { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) }), ...(expect ? { expect } : {}) });
    },
    raw(parts, expect) {
      list.push({ kind: "raw", parts, expect });
    },
    killAfterCommit(tool, args, until) {
      list.push({ kind: "kill-after-commit", frame: frame("tools/call", { name: tool, arguments: args }), until });
    },
    restart() {
      list.push({ kind: "restart" });
    },
    storeExec(sql) {
      list.push({ kind: "store-exec", sql });
    },
    storeQuery(sql, params, rows) {
      list.push({ kind: "store-query", sql, params, expect: { rows } });
    },
  };
}

function legacyPromotion(key, overrides = {}) {
  return promotion({ idempotency_key: key, run_id: `${key}-run`, provenance_ref: `msp:proof/${key}`, scope: LEGACY_SCOPE, ...overrides });
}

const conflictingCandidate = { entities: [{ candidateRef: "FEAT-LINE-LINKING", type: "FEAT", title: "A wholly different feature" }], relations: [] };

// Runs one batch through the in-process service to learn the deterministic
// parts of every later request.
async function pipelineChain(batch) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-c0-build-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence, pipelineRelayCredential: PIPELINE_RELAY });
    await service.pipelineSubmit({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...source });
    const { decisions } = await service.pipelineClaim({ schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...worker });
    const decision = decisions.find((candidate) => candidate.batchId === batch.batchId);
    const graphReceipt = graphReceiptFor(decision);
    const graphResult = await service.pipelineGraphReceipt({ receipt: graphReceipt, ...worker });
    const receipt = receiptFor(decision, graphResult, graphReceipt);
    return { decision, graphReceipt, receipt };
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Steps for one batch, up to and including `through`. Step names are prefixed
// so a case can run more than one batch; `afterGraph` inserts a case's own
// steps between the graph receipt and the worker receipt.
async function pipelineSteps(s, batch, through, { prefix = "", afterGraph } = {}) {
  const order = ["submit", "claim", "graph", "write", "gate", "publication", "evidence"];
  const upTo = order.indexOf(through);
  const { decision, graphReceipt, receipt } = await pipelineChain(batch);
  const named = (step) => `${prefix}${step}`;
  const decisionHash = bind(`${named("claim")}.result.structuredContent.decisions.0.decisionHash`);
  s.call(named("submit"), "gks_pipeline_submit", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...source }, { ok: true, match: { batchId: batch.batchId, status: "PENDING", idempotent: false } });
  if (upTo < 1) return { decision, decisionHash };
  s.call(named("claim"), "gks_pipeline_claim", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, ...worker }, { ok: true, match: { decisions: [{ batchId: batch.batchId, decisionId: decision.decisionId }] } });
  if (upTo < 2) return { decision, decisionHash };
  const boundGraphReceipt = { ...graphReceipt, decisionHash };
  s.call(named("graph"), "gks_pipeline_graph_receipt", { receipt: boundGraphReceipt, ...worker }, { ok: true, match: { accepted: true, idempotent: false } });
  afterGraph?.({ boundGraphReceipt });
  if (upTo < 3) return { decision, decisionHash, boundGraphReceipt };
  const boundReceipt = {
    ...receipt,
    decisionHash,
    graphReceiptHash: bind(`${named("graph")}.result.structuredContent.graphReceiptHash`),
    derivedHash: bind(`${named("graph")}.result.structuredContent.derivedHash`),
  };
  s.call(named("write"), "gks_pipeline_write_receipt", { receipt: boundReceipt, ...worker }, { ok: true, match: { accepted: true, idempotent: false } });
  if (upTo < 4) return { decision, decisionHash };
  s.call(named("gate"), "gks_pipeline_gate", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, decisionId: decision.decisionId, decisionHash, ...worker }, { ok: true, match: { verdict: { verdict: "PASS", allowPublication: true } } });
  if (upTo < 5) return { decision, decisionHash };
  const publication = {
    schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash,
    snapshotId: receipt.snapshotId, generation: receipt.generation, receiptHash: bind(`${named("write")}.result.structuredContent.receiptHash`),
    publishedAt: "2026-09-07T15:00:03.000Z", pointerHash: "c".repeat(64), modelRevision: receipt.model.revision, transactionFrontier: receipt.transaction.frontier, readback: { ok: true },
  };
  s.call(named("publication"), "gks_pipeline_publication_receipt", { receipt: publication, ...worker }, { ok: true, match: { accepted: true, idempotent: false } });
  if (upTo < 6) return { decision, decisionHash };
  s.call(named("evidence"), "gks_pipeline_evidence", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, ...source }, { ok: true });
  return { decision, decisionHash };
}

function stageFailure(batch, decision, decisionHash) {
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, runId: batch.runId, decisionId: decision.decisionId, decisionHash,
    stage: decision.stages.find((stage) => stage.stageNumber === 15), startedAt: "2026-09-07T15:00:01.000Z", finishedAt: "2026-09-07T15:00:01.100Z",
    metrics: metric({ error_count: 1 }), error: { code: "INDEX_WRITE_FAILED", message: "C0 fixture index write failure" }, ...worker,
  };
}

const batchFor = (id) => makeBatch({ id, scope: PIPELINE_SCOPE });

// --- The 17 tool cases: each tool's accepted request and response envelope.
const TOOL_STEPS = {
  async gks_health(s) {
    s.protocol("initialize", {}, { ok: true });
    s.protocol("tools/list", {}, { ok: true });
    s.call("health", "gks_health", {}, { ok: true, match: { service: "gks", state: "ready" } });
  },
  async gks_knowledge_promote(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-promote"), { ok: true, match: { idempotent: false } });
    s.call("replay", "gks_knowledge_promote", legacyPromotion("c0-tool-promote"), { ok: true, match: { idempotent: true } });
  },
  async gks_search(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-search"), { ok: true });
    s.call("search", "gks_search", { query: "LINE", scope: LEGACY_SCOPE }, { ok: true });
  },
  async gks_entity_get(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-entity"), { ok: true });
    s.call("entity", "gks_entity_get", { ref: bind("promote.result.structuredContent.canonical_mappings.0.canonicalRef"), scope: LEGACY_SCOPE }, { ok: true, match: { candidateRef: "FEAT-LINE-LINKING" } });
  },
  async gks_relations_get(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-relations"), { ok: true });
    s.call("relations", "gks_relations_get", { ref: bind("promote.result.structuredContent.canonical_mappings.0.canonicalRef"), scope: LEGACY_SCOPE }, { ok: true, match: [{ relationType: "DEPENDS_ON" }] });
  },
  async gks_artifact_link(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-artifact"), { ok: true });
    s.call("link", "gks_artifact_link", { knowledgeRef: bind("promote.result.structuredContent.canonical_mappings.0.canonicalRef"), artifactRef: "artifact:c0/spec-line-linking", relationType: "DESCRIBED_BY", evidenceRef: "msp:proof/c0-tool-artifact-link", scope: LEGACY_SCOPE }, { ok: true, match: { relationType: "DESCRIBED_BY" } });
  },
  async gks_review_list(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-review-list"), { ok: true });
    s.call("conflict", "gks_knowledge_promote", legacyPromotion("c0-tool-review-list-2", { source_snapshot_hash: "c".repeat(64), candidate: conflictingCandidate }), { ok: true, match: { canonical_mappings: [{ resolution: { outcome: "REVIEW_REQUIRED" } }] } });
    s.call("list", "gks_review_list", { scope: LEGACY_SCOPE }, { ok: true, match: [{ outcome: "REVIEW_REQUIRED" }] });
  },
  async gks_review_apply(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-review-apply"), { ok: true });
    s.call("conflict", "gks_knowledge_promote", legacyPromotion("c0-tool-review-apply-2", { source_snapshot_hash: "c".repeat(64), candidate: conflictingCandidate }), { ok: true });
    s.call("list", "gks_review_list", { scope: LEGACY_SCOPE }, { ok: true });
    s.call("apply", "gks_review_apply", {
      action: "BIND", provenanceRef: "msp:proof/c0-tool-review-apply-human", scope: LEGACY_SCOPE,
      mentionId: bind("list.result.structuredContent.0.mentionId"), canonicalRef: bind("promote.result.structuredContent.canonical_mappings.0.canonicalRef"),
    }, { ok: true });
    s.call("after", "gks_review_list", { scope: LEGACY_SCOPE }, { ok: true, match: [] });
  },
  async gks_stage_evidence_export(s) {
    s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-tool-export"), { ok: true });
    s.call("promote2", "gks_knowledge_promote", legacyPromotion("c0-tool-export-2", { source_snapshot_hash: "d".repeat(64) }), { ok: true });
    s.call("page1", "gks_stage_evidence_export", { scope: LEGACY_SCOPE, limit: 1 }, { ok: true, match: { next_cursor: 1 } });
    s.call("page2", "gks_stage_evidence_export", { scope: LEGACY_SCOPE, since_cursor: 1 }, { ok: true, match: { next_cursor: 2 } });
  },
  async gks_pipeline_submit(s) {
    const batch = batchFor("c0-submit");
    await pipelineSteps(s, batch, "submit");
    s.call("replay", "gks_pipeline_submit", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...source }, { ok: true, match: { idempotent: true } });
  },
  async gks_pipeline_claim(s) { await pipelineSteps(s, batchFor("c0-claim"), "claim"); },
  async gks_pipeline_graph_receipt(s) {
    const { boundGraphReceipt } = await pipelineSteps(s, batchFor("c0-graph"), "graph");
    s.call("replay", "gks_pipeline_graph_receipt", { receipt: boundGraphReceipt, ...worker }, { ok: true, match: { accepted: true, idempotent: true } });
  },
  async gks_pipeline_stage_failure(s) {
    const batch = batchFor("c0-failure");
    const { decision, decisionHash } = await pipelineSteps(s, batch, "graph");
    s.call("failure", "gks_pipeline_stage_failure", stageFailure(batch, decision, decisionHash), { ok: true, match: { accepted: true, idempotent: false, stage: { stageNumber: 15 } } });
  },
  async gks_pipeline_write_receipt(s) { await pipelineSteps(s, batchFor("c0-write"), "write"); },
  async gks_pipeline_gate(s) { await pipelineSteps(s, batchFor("c0-gate"), "gate"); },
  async gks_pipeline_publication_receipt(s) { await pipelineSteps(s, batchFor("c0-publication"), "publication"); },
  async gks_pipeline_evidence(s) { await pipelineSteps(s, batchFor("c0-evidence"), "evidence"); },
};

const TOOL_EVIDENCE = { testPaths: ["tests/contract/tool-registry.test.mjs", "tests/contract/server-dispatch.test.mjs"], reason: "Replayed by the C0.4 corpus runner against a real gks-server process; the contract tests cover the same tool in-process." };
const LEDGER_BY_TOOL = { gks_stage_evidence_export: "stage_evidence" };

function toolCase(tool, index) {
  const pipeline = tool.startsWith("gks_pipeline_");
  return {
    id: `C0.4-TOOL-${String(index + 1).padStart(3, "0")}`,
    category: "tool",
    tool,
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: pipeline ? PIPELINE_SCOPE : LEGACY_SCOPE,
    expected: { responseEnvelope: "jsonrpc-result-or-error", opaqueRefs: [], receiptHashes: [], ledger: LEDGER_BY_TOOL[tool] ?? (pipeline ? "pipeline_evidence" : null), cursorOutcome: "replayed", errorCode: null, assertions: ["registered tool and response envelope are preserved"] },
    evidence: TOOL_EVIDENCE,
    build: TOOL_STEPS[tool],
  };
}

function mspAuth(scopeForDigest, overrides = {}) {
  return { gksMspAuth: { version: GKS_MSP_AUTH_VERSION, principalId: "msp-runtime", role: "msp", relayCredential: MSP_RELAY, scopeDigest: mspScopeDigest(scopeForDigest), ...overrides } };
}

const SCENARIO_CASES = [
  {
    id: "C0.4-API010-REPLAY",
    category: "api-010-replay",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: LEGACY_SCOPE,
    expected: { responseEnvelope: "api-010-compatible", opaqueRefs: ["<fixture:knowledge-ref>", "<fixture:promotion-ref>"], receiptHashes: [], ledger: "stage_evidence", cursorOutcome: "idempotent-replay", errorCode: "gks_conflict", assertions: ["inner govibe-knowledge-candidate/v1 payload is unchanged", "replay after a restart returns the original opaque refs", "replay writes no duplicate evidence", "a changed payload under the same key is a conflict"] },
    evidence: { testPaths: ["tests/integration/stdio-restart.test.mjs", "tests/integration/msp-provider-compatibility.test.mjs", "tests/integration/msp-service-chain.test.mjs"], reason: "Replayed by the corpus runner across a server restart; the MSP provider and service-chain suites cover the same payload through MSP." },
    async build(s) {
      s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-api010"), { ok: true, match: { idempotent: false } });
      s.restart();
      s.call("replay", "gks_knowledge_promote", legacyPromotion("c0-api010"), { ok: true, match: { idempotent: true } });
      s.call("conflict", "gks_knowledge_promote", legacyPromotion("c0-api010", { source_snapshot_hash: "b".repeat(64) }), { toolError: "gks_conflict" });
      s.storeQuery("SELECT COUNT(*) AS promotions FROM promotions WHERE idempotency_key = ?", ["c0-api010"], [{ promotions: 1 }]);
      s.storeQuery("SELECT COUNT(*) AS evidence FROM stage_evidence", [], [{ evidence: 1 }]);
    },
  },
  {
    id: "C0.4-TENANT-WALL",
    category: "tenant-wall",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: TENANTLESS_SCOPE,
    expected: { responseEnvelope: "scoped-result-or-denial", opaqueRefs: ["<fixture:tenantless-knowledge-ref>"], receiptHashes: [], ledger: "canonical-knowledge", cursorOutcome: "no-cross-tenant-cursor", errorCode: "gks_scope_denied", assertions: ["empty tenant matches only empty tenant", "tenanted and tenantless rows never cross", "portfolio sharing does not bypass the tenant wall"] },
    evidence: { testPaths: ["tests/security/c0-tenant-wall.security.mjs", "tests/security/cross-tenant-deny.security.mjs", "tests/contract/stage9-persistence.test.mjs"], reason: "Replayed by the corpus runner; the security suites cover the same wall in-process. Forged scope digests are the auth-denial case." },
    async build(s) {
      s.call("tenant", "gks_knowledge_promote", legacyPromotion("c0-wall-tenant"), { ok: true });
      s.call("tenantless", "gks_knowledge_promote", legacyPromotion("c0-wall-tenantless", { scope: TENANTLESS_SCOPE }), { ok: true });
      s.call("searchTenant", "gks_search", { query: "LINE", scope: LEGACY_SCOPE }, { ok: true, match: [{ scope: { tenantId: "c0-tenant" } }] });
      s.call("searchTenantless", "gks_search", { query: "LINE", scope: TENANTLESS_SCOPE }, { ok: true, match: [{ scope: { tenantId: "" } }] });
      s.call("searchOther", "gks_search", { query: "LINE", scope: OTHER_TENANT_SCOPE }, { ok: true, match: [] });
      s.call("searchShared", "gks_search", { query: "LINE", scope: { ...OTHER_TENANT_SCOPE, sharing: "portfolio-shared" } }, { ok: true, match: [] });
      s.call("crossIntoTenantless", "gks_entity_get", { ref: bind("tenantless.result.structuredContent.canonical_mappings.0.canonicalRef"), scope: LEGACY_SCOPE }, { toolError: "gks_scope_denied" });
      s.call("crossIntoTenant", "gks_entity_get", { ref: bind("tenant.result.structuredContent.canonical_mappings.0.canonicalRef"), scope: TENANTLESS_SCOPE }, { toolError: "gks_scope_denied" });
      s.call("crossFromOther", "gks_relations_get", { ref: bind("tenant.result.structuredContent.canonical_mappings.0.canonicalRef"), scope: OTHER_TENANT_SCOPE }, { toolError: "gks_scope_denied" });
    },
  },
  {
    id: "C0.4-AUTH-DENIAL",
    category: "auth-denial",
    env: { ...BASE_ENV, GKS_MSP_AUTH_REQUIRED: "1", GKS_MSP_RELAY_CREDENTIAL: MSP_RELAY },
    secrets: [PIPELINE_RELAY, MSP_RELAY],
    normalizedScope: TENANTLESS_SCOPE,
    expected: { responseEnvelope: "typed-denial", opaqueRefs: [], receiptHashes: [], ledger: null, cursorOutcome: "no-persistence", errorCode: "gks_scope_denied", assertions: ["missing, forged, stale, wrong-role and scope-mismatched MSP auth are denied", "denials write nothing", "auth material is not persisted or logged"] },
    evidence: { testPaths: ["tests/contract/c0-msp-auth.test.mjs", "tests/integration/msp-provider-compatibility.test.mjs", "tests/integration/msp-service-chain.test.mjs"], reason: "Replayed by the corpus runner in secure mode; the MSP suites cover the same envelope from the real MSP provider." },
    async build(s) {
      const { scope: _scope, ...inner } = legacyPromotion("c0-auth");
      const defaultScope = { ...TENANTLESS_SCOPE };
      s.call("health", "gks_health", {}, { ok: true });
      s.call("missing", "gks_knowledge_promote", inner, { toolError: "gks_scope_denied" });
      s.call("forgedCredential", "gks_knowledge_promote", inner, { toolError: "gks_scope_denied" }, mspAuth(defaultScope, { relayCredential: `${MSP_RELAY}-forged` }));
      s.call("wrongRole", "gks_knowledge_promote", inner, { toolError: "gks_scope_denied" }, mspAuth(defaultScope, { role: "worker" }));
      s.call("staleVersion", "gks_knowledge_promote", inner, { toolError: "gks_scope_denied" }, mspAuth(defaultScope, { version: "gks-msp-auth/v0" }));
      s.call("forgedScope", "gks_knowledge_promote", inner, { toolError: "gks_scope_denied" }, mspAuth({ ...defaultScope, tenantId: "c0-tenant" }));
      s.call("searchUnauthenticated", "gks_search", { query: "LINE", scope: defaultScope }, { toolError: "gks_scope_denied" });
      s.storeQuery("SELECT COUNT(*) AS promotions FROM promotions", [], [{ promotions: 0 }]);
      s.call("accepted", "gks_knowledge_promote", inner, { ok: true, match: { idempotent: false } }, mspAuth(defaultScope));
      s.call("search", "gks_search", { query: "LINE", scope: defaultScope }, { ok: true }, mspAuth(defaultScope));
      s.storeQuery("SELECT COUNT(*) AS promotions FROM promotions", [], [{ promotions: 1 }]);
    },
  },
  {
    id: "C0.4-TRANSPORT-DENIAL",
    category: "transport-denial",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: LEGACY_SCOPE,
    expected: { responseEnvelope: "protocol-error", opaqueRefs: [], receiptHashes: [], ledger: null, cursorOutcome: "no-persistence", errorCode: null, assertions: ["oversized, malformed, invalid UTF-8, deep, duplicate-key, non-finite-number and batch frames are denied", "stdout contains protocol frames only", "the server keeps serving after every denial"] },
    evidence: { testPaths: ["tests/contract/c0-transport-bounds.test.mjs", "tests/integration/stdio-restart.test.mjs"], reason: "Replayed by the corpus runner against the real stdio transport; the runner rejects any stdout line that is not a JSON-RPC frame." },
    async build(s) {
      let deep = "0";
      for (let depth = 0; depth < 33; depth += 1) deep = `[${deep}]`;
      s.raw([{ text: "{not json\n" }], { protocolError: true });
      s.raw([{ text: '{"jsonrpc":"2.0","id":1,"method":"initialize","method":"tools/list"}\n' }], { protocolError: true });
      s.raw([{ text: `${JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "initialize" }])}\n` }], { protocolError: true, errorMessage: "JSON-RPC batch requests are unsupported." });
      s.raw([{ text: `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gks_health","arguments":${deep}}}\n` }], { protocolError: true, errorMessage: "JSON depth exceeds the configured limit." });
      s.raw([{ text: '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gks_health","arguments":{"padding":"' }, { repeat: "x", count: 1_048_576 }, { text: '"}}}\n' }], { protocolError: true, errorMessage: "Request frame exceeds the configured limit." });
      s.raw([{ text: '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{"x":"' }, { base64: Buffer.from([0xc3, 0x28]).toString("base64") }, { text: '"}}\n' }], { protocolError: true });
      s.raw([{ text: '{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{"x":1e400}}\n' }], { protocolError: true });
      s.storeQuery("SELECT COUNT(*) AS promotions FROM promotions", [], [{ promotions: 0 }]);
      s.call("alive", "gks_health", {}, { ok: true, match: { state: "ready" } });
    },
  },
  {
    id: "C0.4-GENESISRAG17-RECEIPTS",
    category: "genesisrag17-receipts",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: PIPELINE_SCOPE,
    expected: { responseEnvelope: "pipeline-result-or-denial", opaqueRefs: ["<fixture:decision-id>", "<fixture:run-id>"], receiptHashes: ["<fixture:graph-receipt-hash>", "<fixture:worker-receipt-hash>", "<fixture:publication-hash>"], ledger: "pipeline_evidence", cursorOutcome: "ordered-stage-cursors", errorCode: null, assertions: ["receipts remain ordered and immutable", "wrong hash, scope, or stage is denied", "duplicate receipt is idempotent", "failed terminal state blocks publication"] },
    evidence: { testPaths: ["tests/contract/pipeline-genesisrag17.test.mjs"], reason: "The GKS side of the receipt protocol, replayed by the corpus runner with frozen Tier-4 receipts. Physical Tier-4 readback is the separate C0.4-TIER4-READBACK case." },
    async build(s) {
      // One batch through publication, with the denials inserted after its
      // graph receipt: none of them may disturb the receipts that follow.
      await pipelineSteps(s, batchFor("c0-receipts"), "evidence", {
        afterGraph({ boundGraphReceipt }) {
          s.call("graphReplay", "gks_pipeline_graph_receipt", { receipt: boundGraphReceipt, ...worker }, { ok: true, match: { idempotent: true } });
          s.call("wrongHash", "gks_pipeline_graph_receipt", { receipt: { ...boundGraphReceipt, decisionHash: "0".repeat(64) }, ...worker }, { toolError: "gks_conflict" });
          s.call("wrongScope", "gks_pipeline_graph_receipt", { receipt: { ...boundGraphReceipt, scope: { ...PIPELINE_SCOPE, tenantId: "c0-tenant-b" } }, ...worker }, { toolError: "gks_scope_denied" });
          s.call("wrongStage", "gks_pipeline_graph_receipt", { receipt: { ...boundGraphReceipt, stages: boundGraphReceipt.stages.map((stage) => (stage.stageNumber === 13 ? { ...stage, attemptId: "c0-forged-attempt" } : stage)) }, ...worker }, { toolError: "gks_conflict" });
          s.call("sourceRole", "gks_pipeline_graph_receipt", { receipt: boundGraphReceipt, ...worker, authenticatedPrincipal: { ...worker.authenticatedPrincipal, role: "source" } }, { toolError: "gks_scope_denied" });
        },
      });
      // A second batch whose Stage 15 fails: the gate answers FAIL and refuses
      // publication.
      const failed = batchFor("c0-receipts-failed");
      const failedChain = await pipelineSteps(s, failed, "graph", { prefix: "failed-" });
      s.call("failure", "gks_pipeline_stage_failure", stageFailure(failed, failedChain.decision, failedChain.decisionHash), { ok: true, match: { accepted: true } });
      s.call("gateAfterFailure", "gks_pipeline_gate", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: failed.scope, decisionId: failedChain.decision.decisionId, decisionHash: failedChain.decisionHash, ...worker }, { ok: true, match: { verdict: { verdict: "FAIL", allowPublication: false } } });
      s.call("failedEvidence", "gks_pipeline_evidence", { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: failed.scope, runId: failed.runId, ...source }, { ok: true });
    },
  },
  {
    id: "C0.4-TIER4-READBACK",
    category: "genesisrag17-receipts",
    runnable: false,
    normalizedScope: PIPELINE_SCOPE,
    expected: { responseEnvelope: "pipeline-result-or-denial", opaqueRefs: [], receiptHashes: ["<tier4:graph-readback>", "<tier4:index-readback>", "<tier4:publication-readback>"], ledger: "pipeline_evidence", cursorOutcome: "not-run", errorCode: null, assertions: ["GenesisBlockDB physical graph, index and publication readback match the GKS receipts"] },
    evidence: { testPaths: [], reason: "Physical Tier-4 readback needs a running GenesisBlockDB worker. GKS never calls outward (ADR-GKS-BOUNDARY), so this cannot run inside the GKS corpus and stays NOT_RUN." },
  },
  {
    id: "C0.4-BACKEND-FAILURE",
    category: "backend-failure",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: LEGACY_SCOPE,
    expected: { responseEnvelope: "typed-error", opaqueRefs: [], receiptHashes: [], ledger: null, cursorOutcome: "no-partial-write", errorCode: "gks_backend_unavailable", assertions: ["a storage failure inside a write transaction is a typed gks_backend_unavailable error", "the transaction rolls back: no entity or promotion row is left behind"] },
    evidence: { testPaths: ["tests/contract/server-dispatch.test.mjs", "tests/contract/persistence-error-redaction.test.mjs"], reason: "Replayed by the corpus runner: the last table a promotion writes is dropped from a second connection, so the write fails after its earlier inserts." },
    async build(s) {
      s.call("promote", "gks_knowledge_promote", legacyPromotion("c0-backend"), { ok: true });
      s.storeExec("DROP TABLE stage_evidence");
      s.call("failed", "gks_knowledge_promote", legacyPromotion("c0-backend-2", { source_snapshot_hash: "e".repeat(64), candidate: { entities: [{ candidateRef: "C0-BACKEND-PROBE", type: "ENTITY", title: "Backend probe" }], relations: [] } }), { toolError: "gks_backend_unavailable" });
      s.storeQuery("SELECT COUNT(*) AS entities FROM entities WHERE candidate_ref = ?", ["C0-BACKEND-PROBE"], [{ entities: 0 }]);
      s.storeQuery("SELECT COUNT(*) AS promotions FROM promotions WHERE idempotency_key = ?", ["c0-backend-2"], [{ promotions: 0 }]);
      s.call("alive", "gks_health", {}, { ok: true });
    },
  },
  {
    id: "C0.4-LOST-RESPONSE-REPLAY",
    category: "lost-response-replay",
    env: BASE_ENV,
    secrets: [PIPELINE_RELAY],
    normalizedScope: PIPELINE_SCOPE,
    expected: { responseEnvelope: "idempotent-replay", opaqueRefs: ["<fixture:knowledge-ref>", "<fixture:decision-id>"], receiptHashes: [], ledger: "pipeline_evidence", cursorOutcome: "same-durable-result", errorCode: "gks_conflict", assertions: ["a response lost after the durable commit can be replayed", "replay returns the committed result without a duplicate write", "a changed payload under the same key is a conflict"] },
    evidence: { testPaths: ["tests/integration/lost-response-replay.test.mjs", "tests/integration/stdio-restart.test.mjs"], reason: "Replayed by the corpus runner: the server is SIGKILLed once the write is durable and before the response is read." },
    async build(s) {
      const request = legacyPromotion("c0-lost");
      s.killAfterCommit("gks_knowledge_promote", request, { sql: "SELECT knowledge_ref, source_hash FROM promotions WHERE idempotency_key = ?", params: ["c0-lost"] });
      s.restart();
      s.call("replay", "gks_knowledge_promote", request, { ok: true, match: { idempotent: true } });
      s.call("conflict", "gks_knowledge_promote", { ...request, source_snapshot_hash: "b".repeat(64) }, { toolError: "gks_conflict" });
      const batch = batchFor("c0-lost-submit");
      const submit = { schemaVersion: PIPELINE_SCHEMA_VERSION, scope: batch.scope, batch, ...source };
      s.killAfterCommit("gks_pipeline_submit", submit, { sql: "SELECT batch_id, decision_id FROM pipeline_batches WHERE idempotency_key = ?", params: [batch.idempotencyKey] });
      s.restart();
      s.call("submitReplay", "gks_pipeline_submit", submit, { ok: true, match: { batchId: batch.batchId, status: "PENDING", idempotent: true } });
      s.storeQuery("SELECT (SELECT COUNT(*) FROM promotions WHERE idempotency_key = ?) AS promotions, (SELECT COUNT(*) FROM pipeline_batches WHERE idempotency_key = ?) AS batches", ["c0-lost", batch.idempotencyKey], [{ promotions: 1, batches: 1 }]);
    },
  },
];

function stripCaseDefinition({ build: _build, env: _env, secrets: _secrets, ...metadata }) {
  return metadata;
}

/** Builds every case fixture and the registry skeleton (without expected hashes). */
export async function buildCorpus() {
  const definitions = [...GKS_TOOL_DEFINITIONS.map((tool, index) => toolCase(tool.name, index)), ...SCENARIO_CASES];
  const fixtures = {};
  const cases = [];
  for (const definition of definitions) {
    const metadata = stripCaseDefinition(definition);
    const runnable = definition.runnable !== false;
    if (runnable) {
      const s = steps();
      await definition.build(s);
      fixtures[definition.id] = { id: definition.id, fixtureVersion: REGISTRY_VERSION, env: definition.env, secrets: definition.secrets, steps: s.list };
    }
    cases.push({
      id: definition.id,
      fixtureId: FIXTURE_ID,
      contractVersion: REGISTRY_VERSION,
      category: metadata.category,
      ...(metadata.tool ? { tool: metadata.tool } : {}),
      runnable,
      fixture: runnable ? `cases/${definition.id}.json` : null,
      expectedResult: runnable ? `expected/${definition.id}.json` : null,
      requestSha256: runnable ? sha256Canonical(fixtures[definition.id]) : null,
      expectedResultSha256: null,
      normalizedScope: metadata.normalizedScope,
      expected: metadata.expected,
      evidence: metadata.evidence,
    });
  }
  const registry = {
    registryVersion: REGISTRY_VERSION,
    supersedes: "c0-qualification/v1",
    fixtureId: FIXTURE_ID,
    profile: "C0.4",
    statusVocabulary: ["PASS", "FAIL", "NOT_RUN", "BLOCKED"],
    categories: ["tool", "api-010-replay", "tenant-wall", "auth-denial", "transport-denial", "genesisrag17-receipts", "backend-failure", "lost-response-replay"],
    provenance: {
      adr: "docs/ADR-GKS-C0-QUALIFICATION.md",
      toolDefinitions: "packages/gks-contracts/src/tool-definitions.mjs",
      builder: "scripts/c0-corpus/build-cases.mjs",
      runner: "scripts/run-c0-corpus.mjs",
      runtime: "gks-server stdio process, fresh SQLite store per case",
      normalization: "server-clock instants, measured durations and clock-derived hashes are replaced by stable labels before hashing",
      containsSecrets: false,
      externalEndpoints: false,
    },
    cases,
  };
  return { registry, fixtures };
}

function writeJson(root, relativePath, value) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const root = process.cwd();
  const { registry, fixtures } = await buildCorpus();
  // Keep an expected hash only while its request fixture is unchanged.
  let previous = {};
  try {
    previous = Object.fromEntries(JSON.parse(readFileSync(path.join(root, REGISTRY_PATH), "utf8")).cases.map((item) => [item.id, item]));
  } catch { /* first build */ }
  for (const item of registry.cases) {
    const before = previous[item.id];
    if (before && before.requestSha256 === item.requestSha256) item.expectedResultSha256 = before.expectedResultSha256 ?? null;
  }
  for (const [id, fixture] of Object.entries(fixtures)) writeJson(root, `${CORPUS_DIR}/cases/${id}.json`, fixture);
  writeJson(root, REGISTRY_PATH, registry);
  const stale = registry.cases.filter((item) => item.runnable && !item.expectedResultSha256).map((item) => item.id);
  console.log(`Built ${Object.keys(fixtures).length} case fixtures (${registry.cases.length} registry cases).`);
  if (stale.length) console.log(`Needs re-baseline (node scripts/run-c0-corpus.mjs --write): ${stale.join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
