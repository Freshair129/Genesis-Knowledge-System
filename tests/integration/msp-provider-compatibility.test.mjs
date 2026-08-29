import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mspRoot = process.env.MSP_REPO_ROOT;
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe.skipIf(!mspRoot)("external MSP provider compatibility", () => {
  it("actualMspProvider_promotesAgainstStandaloneGks", async () => {
    const providerModule = path.join(mspRoot, "apps/msp-server/src/providers/gks-stdio-provider.mjs");
    const { createGksProviderFromEnvironment } = await import(pathToFileURL(providerModule).href);
    const dir = mkdtempSync(path.join(tmpdir(), "gks-msp-provider-"));
    // Each provider.promote() spawns a GKS child and kills it in a finally,
    // but on Windows the kill is asynchronous: the child can still hold the
    // SQLite handle when this synchronous cleanup runs, and rmSync then
    // fails EPERM. maxRetries/retryDelay is Node's own knob for exactly
    // that race (the service-chain test waits 250ms after close for the
    // same reason).
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
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
