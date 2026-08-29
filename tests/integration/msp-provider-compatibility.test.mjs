import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mspRoot = process.env.MSP_REPO_ROOT;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

describe.skipIf(!mspRoot)("external MSP provider compatibility", () => {
  it("actualMspProvider_promotesAgainstStandaloneGks", async () => {
    const providerModule = path.join(mspRoot, "apps/msp-server/src/providers/gks-stdio-provider.mjs");
    const { createGksProviderFromEnvironment } = await import(pathToFileURL(providerModule).href);
    const dir = mkdtempSync(path.join(tmpdir(), "gks-msp-provider-"));
    // Each provider.promote() spawns a GKS child and kills it in a finally,
    // but on Windows the kill is asynchronous: the child can still hold the
    // SQLite handle when cleanup runs, and rmSync then fails EPERM. Under
    // the full suite (other spawning tests loading the machine) the
    // maxRetries window alone proved insufficient — it failed exactly this
    // way on 2026-08-30 while passing solo. So: wait like the service-chain
    // test does, retry like Node suggests, and if the handle STILL is not
    // released, leave the temp dir to the OS rather than failing a test
    // whose assertions all passed. A leaked mkdtemp dir is kilobytes; a
    // suite that fails on handle-release timing is one people learn to
    // rerun, which is how real failures start getting rerun too.
    cleanups.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
        console.warn(`[msp-provider-compatibility] temp dir left for the OS: ${dir} (${error.code})`);
      }
    });
    const provider = createGksProviderFromEnvironment({
      ...process.env,
      MSP_GKS_COMMAND: process.execPath,
      MSP_GKS_ARGS: JSON.stringify([path.resolve("apps/gks-server/bin/gks-server.mjs")]),
      MSP_GKS_CWD: path.resolve("."),
      GKS_DB_PATH: path.join(dir, "gks.sqlite"),
      GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri",
    });
    const candidate = {
      schema_version: "govibe-knowledge-candidate/v1",
      idempotency_key: "msp-compat-1",
      run_id: "run-msp-compat",
      stage: 1,
      source_snapshot_hash: "d".repeat(64),
      provenance_ref: "msp:proof/msp-compat-1",
      candidate: { entities: [{ candidateRef: "API-MSP-GKS", type: "API", title: "MSP GKS contract", summary: "Compatibility proof" }] },
    };

    const first = await provider.promote(candidate);
    const retry = await provider.promote(candidate);

    expect(first).toMatchObject({ knowledge_ref: expect.stringMatching(/^gks:knowledge\//), source_hash: candidate.source_snapshot_hash, idempotent: false });
    expect(retry).toEqual({ ...first, idempotent: true });
  });
});
