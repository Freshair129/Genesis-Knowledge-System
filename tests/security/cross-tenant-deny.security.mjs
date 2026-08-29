import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

test("crossTenantDefault_DENY prevents search and direct lookup leakage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a" });
    const tenantB = scope({ tenantId: "tenant-b" });
    const promoted = await service.promoteCandidate(promotion({ scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    assert.deepEqual(await service.search({ query: "LINE", scope: tenantB }), []);
    await assert.rejects(service.getEntity({ ref: feature.canonicalRef, scope: tenantB }), { code: "gks_scope_denied" });
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("portfolioShared_withoutMspAuthorizationEvidence_stillDeniesCrossTenant", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-shared-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantA = scope({ tenantId: "tenant-a", sharing: "portfolio-shared" });
    const tenantB = scope({ tenantId: "tenant-b", sharing: "private" });
    const promoted = await service.promoteCandidate(promotion({ idempotency_key: "shared-no-evidence", scope: tenantA }));
    const feature = promoted.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING");

    assert.deepEqual(await service.search({ query: "LINE", scope: tenantB }), []);
    await assert.rejects(service.getEntity({ ref: feature.canonicalRef, scope: tenantB }), { code: "gks_scope_denied" });
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
