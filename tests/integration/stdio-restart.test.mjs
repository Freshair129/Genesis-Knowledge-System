import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GksStdioClient } from "@freshair129/gks-client-js";
import { promotion } from "../fixtures/candidates.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe("standalone stdio integration", () => {
  it("server_restart_preservesPromotionAndApi010Compatibility", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gks-stdio-"));
    const dbPath = path.join(dir, "gks.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new GksStdioClient({
      command: process.execPath,
      args: [path.resolve("apps/gks-server/bin/gks-server.mjs")],
      cwd: path.resolve("."),
      env: { ...process.env, GKS_DB_PATH: dbPath, GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri" },
    });
    const exactApi010Request = promotion();
    delete exactApi010Request.scope;

    const first = await client.promoteCandidate(exactApi010Request);
    const afterRestart = await client.promoteCandidate(exactApi010Request);

    expect(first).toMatchObject({ knowledge_ref: expect.stringMatching(/^gks:knowledge\//), source_hash: exactApi010Request.source_snapshot_hash, idempotent: false });
    expect(afterRestart).toEqual({ ...first, idempotent: true });
  });
});
