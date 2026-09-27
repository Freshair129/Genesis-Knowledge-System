// @req ADR-GKS-GOVERNED-CALLERS — a system with its own auth and memory is a
// governed caller: it writes to the portfolios it owns, under its own
// provenance namespace, over the private HTTP transport, without MSP. MSP
// stays the built-in governed caller and loses only the portfolios another
// caller owns.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GKS_CALLER_AUTH_VERSION,
  GKS_MSP_AUTH_VERSION,
  authorizeGovernedCallerRequest,
  hashGksClientCredential,
  mspScopeDigest,
  parseGksClientGrants,
  scopeKey,
} from "@freshair129/gks-contracts";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";
import { runHttpServer } from "../../apps/gks-server/src/http-server.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const credential = (fill) => `gksc_${Buffer.alloc(32, fill).toString("base64url")}`;
const ACME = credential(41);
const OTHER = credential(42);
const MSP_SECRET = "governed-msp-secret";
const acmeScope = scope({ portfolioId: "acme-portfolio", tenantId: "acme-tenant" });
const mspScope = scope({ portfolioId: "portfolio-zuri" });
const LEGACY_TOOLS = ["gks_knowledge_promote", "gks_search", "gks_entity_get", "gks_relations_get", "gks_artifact_link", "gks_review_list", "gks_review_apply", "gks_stage_evidence_export"];

function governed(overrides = {}) {
  return { profile: "governed", clientId: "acme-backend", credentialSha256: hashGksClientCredential(ACME), provenanceNamespace: "acme", portfolioIds: ["acme-portfolio"], allowedTools: LEGACY_TOOLS, ...overrides };
}

function grants(...clients) {
  return { schemaVersion: "gks-client-grants/v2", clients };
}

describe("grants v2: the governed profile", () => {
  it("parses a governed entry alongside a read entry, and v1 documents unchanged", () => {
    const parsed = parseGksClientGrants(grants(
      governed(),
      { profile: "read", clientId: "reporting", credentialSha256: hashGksClientCredential(OTHER), allowedTools: ["gks_search"], scopes: [mspScope] },
    ));
    expect(parsed.map((grant) => [grant.profile, grant.clientId])).toEqual([["governed", "acme-backend"], ["read", "reporting"]]);
    expect(parsed[0]).toMatchObject({ provenanceNamespace: "acme", portfolioIds: ["acme-portfolio"] });
    const v1 = parseGksClientGrants({ schemaVersion: "gks-client-grants/v1", clients: [{ clientId: "reporting", credentialSha256: hashGksClientCredential(OTHER), allowedTools: ["gks_search"], scopes: [mspScope] }] });
    expect(v1[0]).toMatchObject({ profile: "read", clientId: "reporting" });
  });

  it.each([
    ["the reserved msp namespace", [governed({ provenanceNamespace: "msp" })]],
    ["the msp-runtime client id", [governed({ clientId: "msp-runtime" })]],
    ["a namespace claimed twice", [governed(), governed({ clientId: "other", credentialSha256: hashGksClientCredential(OTHER), portfolioIds: ["other-portfolio"] })]],
    ["a portfolio claimed twice", [governed(), governed({ clientId: "other", credentialSha256: hashGksClientCredential(OTHER), provenanceNamespace: "other" })]],
    ["a pipeline tool", [governed({ allowedTools: ["gks_pipeline_submit"] })]],
    ["no portfolios", [governed({ portfolioIds: [] })]],
    ["a malformed namespace", [governed({ provenanceNamespace: "Acme Corp" })]],
    ["read-profile scopes on a governed entry", [{ ...governed(), scopes: [acmeScope] }]],
    ["an unknown profile", [governed({ profile: "admin" })]],
  ])("fails startup on %s", (_label, clients) => {
    expect(() => parseGksClientGrants(grants(...clients))).toThrow(TypeError);
  });
});

describe("authorizeGovernedCallerRequest", () => {
  const [grant] = parseGksClientGrants(grants(governed()));
  const meta = (overrides = {}) => ({ gksCallerAuth: { version: GKS_CALLER_AUTH_VERSION, callerId: "acme-backend", scopeDigest: mspScopeDigest(acmeScope), ...overrides } });
  const promote = promotion({ scope: acmeScope, provenance_ref: "acme:proof/p-1" });

  it("returns the caller context for a call inside its boundary and namespace", () => {
    expect(authorizeGovernedCallerRequest(grant, meta(), { toolName: "gks_knowledge_promote", args: promote })).toMatchObject({ callerId: "acme-backend", provenanceNamespace: "acme" });
  });

  it.each([
    ["a tool it was not granted", () => authorizeGovernedCallerRequest(parseGksClientGrants(grants(governed({ allowedTools: ["gks_search"] })))[0], meta(), { toolName: "gks_knowledge_promote", args: promote })],
    ["a pipeline tool", () => authorizeGovernedCallerRequest(grant, meta(), { toolName: "gks_pipeline_submit", args: promote })],
    ["a missing envelope", () => authorizeGovernedCallerRequest(grant, {}, { toolName: "gks_knowledge_promote", args: promote })],
    ["a stale envelope version", () => authorizeGovernedCallerRequest(grant, meta({ version: GKS_MSP_AUTH_VERSION }), { toolName: "gks_knowledge_promote", args: promote })],
    ["another caller's id", () => authorizeGovernedCallerRequest(grant, meta({ callerId: "msp-runtime" }), { toolName: "gks_knowledge_promote", args: promote })],
    ["a portfolio it does not own", () => authorizeGovernedCallerRequest(grant, meta({ scopeDigest: mspScopeDigest(mspScope) }), { toolName: "gks_search", args: { query: "x", scope: mspScope } })],
    ["a scope digest for another scope", () => authorizeGovernedCallerRequest(grant, meta({ scopeDigest: mspScopeDigest({ ...acmeScope, tenantId: "t2" }) }), { toolName: "gks_knowledge_promote", args: promote })],
    ["MSP's provenance namespace", () => authorizeGovernedCallerRequest(grant, meta(), { toolName: "gks_knowledge_promote", args: { ...promote, provenance_ref: "msp:proof/p-1" } })],
    ["another namespace on a review", () => authorizeGovernedCallerRequest(grant, meta(), { toolName: "gks_review_apply", args: { action: "BIND", scope: acmeScope, provenanceRef: "other:proof/h-1" } })],
    ["another namespace on an artifact link", () => authorizeGovernedCallerRequest(grant, meta(), { toolName: "gks_artifact_link", args: { scope: acmeScope, evidenceRef: "msp:proof/a-1" } })],
  ])("denies %s", (_label, call) => {
    expect(call).toThrow(expect.objectContaining({ code: "gks_scope_denied" }));
  });
});

async function startServer(clientGrants) {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-governed-"));
  const dbPath = path.join(dir, "gks.sqlite");
  const grantsPath = path.join(dir, "client-grants.json");
  writeFileSync(grantsPath, JSON.stringify(clientGrants), "utf8");
  const app = runHttpServer({
    env: { GKS_DB_PATH: dbPath, GKS_MSP_AUTH_REQUIRED: "1", GKS_MSP_RELAY_CREDENTIAL: MSP_SECRET, GKS_CLIENT_GRANTS_PATH: grantsPath, GKS_PIPELINE_RELAY_CREDENTIAL: "governed-pipeline-secret" },
    host: "127.0.0.1",
    port: 0,
  });
  await app.ready;
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${app.server.address().port}`, dbPath };
}

let nextId = 1;
async function call(base, bearer, name, args, meta) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
  });
  return (await response.json()).result;
}

const asAcme = (requestScope = acmeScope) => ({ gksCallerAuth: { version: GKS_CALLER_AUTH_VERSION, callerId: "acme-backend", scopeDigest: mspScopeDigest(requestScope) } });
const asMsp = (requestScope) => ({ gksMspAuth: { version: GKS_MSP_AUTH_VERSION, principalId: "msp-runtime", role: "msp", scopeDigest: mspScopeDigest(requestScope) } });

function rows(dbPath, sql, ...params) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

describe("a governed caller over HTTP", () => {
  it("writes and reads inside its own portfolio, attributed to itself, without MSP", async () => {
    const { base, dbPath } = await startServer(grants(governed()));
    const promoted = await call(base, ACME, "gks_knowledge_promote", promotion({ idempotency_key: "acme-1", scope: acmeScope, provenance_ref: "acme:proof/acme-1" }), asAcme());
    expect(promoted.isError).toBeUndefined();
    const ref = promoted.structuredContent.canonical_mappings[0].canonicalRef;
    const found = await call(base, ACME, "gks_search", { query: "LINE", scope: acmeScope }, asAcme());
    expect(found.structuredContent.map((entity) => entity.canonicalRef)).toContain(ref);
    const linked = await call(base, ACME, "gks_artifact_link", { knowledgeRef: ref, artifactRef: "artifact:acme/spec", relationType: "DESCRIBED_BY", evidenceRef: "acme:proof/link-1", scope: acmeScope }, asAcme());
    expect(linked.isError).toBeUndefined();

    expect(rows(dbPath, "SELECT caller_id, provenance_ref FROM promotions")).toEqual([{ caller_id: "acme-backend", provenance_ref: "acme:proof/acme-1" }]);
    expect(rows(dbPath, "SELECT caller_id FROM stage_evidence")).toEqual([{ caller_id: "acme-backend" }]);
    expect(rows(dbPath, "SELECT caller_id, evidence_ref FROM artifact_links")).toEqual([{ caller_id: "acme-backend", evidence_ref: "acme:proof/link-1" }]);
  });

  it("is denied outside its boundary, under another namespace, and on pipeline tools", async () => {
    const { base, dbPath } = await startServer(grants(governed()));
    const denied = { isError: true, structuredContent: { code: "gks_scope_denied" } };
    expect(await call(base, ACME, "gks_search", { query: "LINE", scope: mspScope }, asAcme(mspScope))).toMatchObject(denied);
    expect(await call(base, ACME, "gks_knowledge_promote", promotion({ idempotency_key: "acme-msp-ns", scope: acmeScope, provenance_ref: "msp:proof/forged" }), asAcme())).toMatchObject(denied);
    expect(await call(base, ACME, "gks_knowledge_promote", promotion({ idempotency_key: "acme-no-envelope", scope: acmeScope, provenance_ref: "acme:proof/x" }))).toMatchObject(denied);
    expect(await call(base, ACME, "gks_pipeline_claim", { scope: acmeScope }, asAcme())).toMatchObject(denied);
    expect(rows(dbPath, "SELECT COUNT(*) AS n FROM promotions")).toEqual([{ n: 0 }]);
  });

  it("takes its portfolios away from MSP, which keeps every other portfolio", async () => {
    const { base, dbPath } = await startServer(grants(governed()));
    const onAcme = await call(base, MSP_SECRET, "gks_knowledge_promote", promotion({ idempotency_key: "msp-on-acme", scope: acmeScope }), asMsp(acmeScope));
    expect(onAcme).toMatchObject({ isError: true, structuredContent: { code: "gks_scope_denied", message: "This portfolio is governed by another caller." } });
    const onZuri = await call(base, MSP_SECRET, "gks_knowledge_promote", promotion({ idempotency_key: "msp-on-zuri", scope: mspScope }), asMsp(mspScope));
    expect(onZuri.isError).toBeUndefined();
    expect(rows(dbPath, "SELECT caller_id, idempotency_key FROM promotions")).toEqual([{ caller_id: "msp-runtime", idempotency_key: "msp-on-zuri" }]);
  });
});

describe("caller attribution (migration 0008)", () => {
  it("backfills every earlier write as msp-runtime", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-governed-backfill-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "gks.sqlite");

    // A store from before governed callers, seeded at migration 0001 the way
    // stage9-migration.test.mjs does, holding a promotion written the old
    // way. Opening it applies 0002-0008, hooks included.
    const raw = new Database(dbPath);
    raw.exec(readFileSync(path.resolve("migrations/0001_init.sql"), "utf8"));
    raw.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-08-01T00:00:00.000Z')").run();
    const seeded = scope();
    const key = scopeKey(seeded);
    const canonicalRef = `gks:entity/pre-${"0".repeat(32)}`;
    raw.prepare(`INSERT INTO entities (canonical_ref, scope_key, candidate_ref, type, title, summary, source_ref, confidence, portfolio_id, tenant_id, business_id, workspace_id, project_id, sharing, metadata_json, created_at, updated_at, graph_version)
      VALUES (?, ?, 'PRE', 'ENTITY', 'Pre', 'Seeded.', NULL, NULL, ?, ?, ?, ?, ?, ?, '{}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'gks:graph/1')`)
      .run(canonicalRef, key, seeded.portfolioId, seeded.tenantId, seeded.businessId, seeded.workspaceId, seeded.projectId, seeded.sharing);
    raw.prepare(`INSERT INTO promotions (scope_key, idempotency_key, knowledge_ref, source_hash, provenance_ref, candidate_json, canonical_mappings_json, graph_version, created_at)
      VALUES (?, 'pre-0008', 'gks:knowledge/gks_knowledge_pre', ?, 'msp:proof/pre', ?, ?, 'gks:graph/1', '2026-08-01T00:00:00.000Z')`)
      .run(key, "a".repeat(64), JSON.stringify({ entities: [{ candidateRef: "PRE", type: "ENTITY", title: "Pre" }] }), JSON.stringify([{ candidateRef: "PRE", canonicalRef, canonicalType: "ENTITY" }]));
    raw.prepare("UPDATE graph_state SET version = 1 WHERE singleton = 1").run();
    raw.close();

    openSqlitePersistence({ dbPath }).close();
    expect(rows(dbPath, "SELECT idempotency_key, caller_id FROM promotions")).toEqual([{ idempotency_key: "pre-0008", caller_id: "msp-runtime" }]);
    // Migration 0005 backfilled a stage-evidence row for it; that row is MSP's too.
    expect(rows(dbPath, "SELECT caller_id FROM stage_evidence")).toEqual([{ caller_id: "msp-runtime" }]);
    for (const table of ["promotions", "stage_evidence", "human_resolutions", "artifact_links"]) {
      expect(rows(dbPath, `SELECT "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('${table}') WHERE name = 'caller_id'`), table).toEqual([{ required: 1, fallback: "'msp-runtime'" }]);
    }
  });

  it("records msp-runtime for every write that comes through MSP", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-governed-msp-"));
    const dbPath = path.join(dir, "gks.sqlite");
    const persistence = openSqlitePersistence({ dbPath });
    cleanups.push(() => {
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await createGksService({ persistence }).promoteCandidate(promotion({ idempotency_key: "via-msp" }));
    expect(rows(dbPath, "SELECT caller_id FROM promotions")).toEqual([{ caller_id: "msp-runtime" }]);
    expect(rows(dbPath, "SELECT caller_id FROM stage_evidence")).toEqual([{ caller_id: "msp-runtime" }]);
  });
});
