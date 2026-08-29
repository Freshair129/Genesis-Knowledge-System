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

describe.skipIf(!mspRoot)("MSP to GKS service chain", () => {
  it("mspClient_promotesThroughStandaloneMspAndStandaloneGks", async () => {
    const clientModule = path.join(mspRoot, "packages/msp-client-js/src/index.mjs");
    const { MspClient, createMspStdioCaller } = await import(pathToFileURL(clientModule).href);
    const dir = mkdtempSync(path.join(tmpdir(), "gks-msp-chain-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const call = createMspStdioCaller({
      command: process.execPath,
      args: [path.join(mspRoot, "apps/msp-server/bin/msp-server.mjs")],
      cwd: mspRoot,
      env: {
        ...process.env,
        MSP_DB_PATH: path.join(dir, "msp.sqlite"),
        MSP_GKS_COMMAND: process.execPath,
        MSP_GKS_ARGS: JSON.stringify([path.resolve("apps/gks-server/bin/gks-server.mjs")]),
        MSP_GKS_CWD: path.resolve("."),
        GKS_DB_PATH: path.join(dir, "gks.sqlite"),
        GKS_DEFAULT_PORTFOLIO_ID: "portfolio-zuri",
      },
    });
    cleanups.push(async () => {
      call.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const client = new MspClient(call);
    const candidate = {
      schema_version: "govibe-knowledge-candidate/v1",
      idempotency_key: "msp-chain-1",
      run_id: "run-msp-chain",
      stage: 1,
      source_snapshot_hash: "e".repeat(64),
      provenance_ref: "msp:proof/msp-chain-1",
      candidate: { entities: [{ candidateRef: "FLOW-ZURI-MSP-GKS", type: "FLOW", title: "Zuri MSP GKS flow", summary: "Service chain proof" }] },
    };

    const first = await client.submitKnowledgeCandidate(candidate);
    const retry = await client.submitKnowledgeCandidate(candidate);

    expect(first).toMatchObject({
      knowledgeRef: expect.stringMatching(/^gks:knowledge\//),
      sourceHash: candidate.source_snapshot_hash,
      promotionRef: expect.stringMatching(/^msp:promotion\//),
    });
    expect(retry).toEqual(first);
  });
});
