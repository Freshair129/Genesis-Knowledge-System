import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { promotion, scope } from "../fixtures/candidates.mjs";

test("c0TenantWall_normalizesMissingTenant_andPreservesOtherOptionalDimensions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-security-c0-tenant-wall-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  try {
    const service = createGksService({ persistence });
    const tenantlessStoredScope = scope({ tenantId: "", businessId: "" });
    const tenantAScope = scope({ tenantId: "tenant-a" });
    const tenantBScope = scope({ tenantId: "tenant-b" });
    const tenantlessRequestScope = scope({ tenantId: undefined, businessId: "business-a" });
    const tenantlessPromotion = await service.promoteCandidate(promotion({ idempotency_key: "c0-tenantless", scope: tenantlessStoredScope }));
    const tenantAPromotion = await service.promoteCandidate(promotion({ idempotency_key: "c0-tenant-a", scope: tenantAScope }));
    const tenantlessRef = tenantlessPromotion.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING").canonicalRef;
    const tenantARef = tenantAPromotion.canonical_mappings.find((item) => item.candidateRef === "FEAT-LINE-LINKING").canonicalRef;

    assert.notEqual(tenantlessRef, tenantARef);
    assert.deepEqual((await service.search({ query: "LINE", scope: tenantAScope })).map((entity) => entity.canonicalRef), [tenantARef]);
    assert.deepEqual(await service.search({ query: "LINE", scope: tenantBScope }), []);
    assert.deepEqual((await service.search({ query: "LINE", scope: tenantlessRequestScope })).map((entity) => entity.canonicalRef), [tenantlessRef]);

    await assert.rejects(service.getEntity({ ref: tenantlessRef, scope: tenantAScope }), { code: "gks_scope_denied" });
    await assert.rejects(service.getEntity({ ref: tenantARef, scope: tenantlessRequestScope }), { code: "gks_scope_denied" });
    await assert.rejects(service.getEntity({ ref: tenantARef, scope: tenantBScope }), { code: "gks_scope_denied" });
    assert.equal((await service.getEntity({ ref: tenantARef, scope: tenantAScope })).canonicalRef, tenantARef);
    assert.equal((await service.getEntity({ ref: tenantlessRef, scope: tenantlessRequestScope })).canonicalRef, tenantlessRef);
  } finally {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
