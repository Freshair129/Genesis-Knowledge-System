// @req GKS-MIG-002, C0.4 — every runnable golden case replays from its tracked
// request fixture to its golden transcript against a real gks-server process.
// The same check runs as `npm run check:corpus` in the c0-gate CI slice.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CORPUS_DIR, firstDifference, readJson, runCase, sha256Canonical } from "../../scripts/c0-corpus/runner.mjs";

const root = path.resolve(".");
const registry = JSON.parse(readFileSync(path.join(root, CORPUS_DIR, "registry.json"), "utf8"));
// Each case spawns at least one server process; allow for a slow runner.
const CASE_TIMEOUT_MS = 60_000;

describe("C0.4 golden corpus replay", () => {
  for (const qualificationCase of registry.cases.filter((item) => item.runnable)) {
    it(`${qualificationCase.id} replays to its golden transcript`, async () => {
      const run = await runCase(root, readJson(root, `${CORPUS_DIR}/${qualificationCase.fixture}`));
      expect(run.problems).toEqual([]);
      const expected = readJson(root, `${CORPUS_DIR}/${qualificationCase.expectedResult}`);
      expect(sha256Canonical(run.transcript), firstDifference(expected, run.transcript) ?? "").toBe(qualificationCase.expectedResultSha256);
    }, CASE_TIMEOUT_MS);
  }
});
