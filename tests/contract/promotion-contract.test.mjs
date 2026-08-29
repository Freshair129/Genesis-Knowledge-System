import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGksService } from "@freshair129/gks-core";
import { openSqlitePersistence } from "@freshair129/gks-persistence";
import { HASH_B, promotion } from "../fixtures/candidates.mjs";

const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function runtime() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-contract-"));
  const persistence = openSqlitePersistence({ dbPath: path.join(dir, "gks.sqlite") });
  cleanups.push(() => {
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return createGksService({ persistence });
}

describe("API-010 promotion contract", () => {
  it("promotion_firstWriteAndRetry_returnsStableCanonicalEvidence", async () => {
    const service = runtime();
    const input = promotion();

    const first = await service.promoteCandidate(input);
    const retry = await service.promoteCandidate(input);

    expect(first).toMatchObject({
      knowledge_ref: expect.stringMatching(/^gks:knowledge\//),
      source_hash: input.source_snapshot_hash,
      idempotent: false,
      graph_version: expect.stringMatching(/^gks:graph\//),
    });
    expect(retry).toEqual({ ...first, idempotent: true });
  });

  it("promotion_changedHash_rejectsConflictWithoutChangingCanonicalMapping", async () => {
    const service = runtime();
    const input = promotion();
    const first = await service.promoteCandidate(input);

    await expect(service.promoteCandidate({ ...input, source_snapshot_hash: HASH_B })).rejects.toMatchObject({ code: "gks_conflict" });
    await expect(service.promoteCandidate(input)).resolves.toEqual({ ...first, idempotent: true });
  });

  it("promotion_callerAssignedCanonicalIdentity_failsClosed", async () => {
    const service = runtime();
    const input = promotion({ candidate: { canonicalRef: "gks:entity/forged" } });

    await expect(service.promoteCandidate(input)).rejects.toMatchObject({ code: "gks_invalid_request" });
  });
});
