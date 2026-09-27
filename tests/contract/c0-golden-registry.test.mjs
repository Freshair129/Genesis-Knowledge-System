// The C0.4 golden corpus (registry c0-qualification/v2) as a tracked artifact:
// its shape, its coverage of the public tools, the integrity of every request
// fixture and golden transcript, and that the fixtures are exactly what the
// builder produces. Replaying the corpus is tests/integration/c0-corpus.test.mjs.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GKS_TOOL_DEFINITIONS, canonicalJsonString } from "@freshair129/gks-contracts";
import { buildCorpus } from "../../scripts/c0-corpus/build-cases.mjs";
import { sha256Canonical } from "../../scripts/c0-corpus/runner.mjs";

const CORPUS = path.resolve(process.cwd(), "tests/fixtures/c0-qualification");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(CORPUS, relativePath), "utf8"));
const registry = readJson("registry.json");
const resultManifest = readJson("result-manifest.json");
const SHA256 = /^[a-f0-9]{64}$/;
const STATUS_VOCABULARY = ["PASS", "FAIL", "NOT_RUN", "BLOCKED"];
const REQUIRED_CATEGORIES = [
  "tool",
  "api-010-replay",
  "tenant-wall",
  "auth-denial",
  "transport-denial",
  "genesisrag17-receipts",
  "backend-failure",
  "lost-response-replay",
];
const runnable = registry.cases.filter((item) => item.runnable);

describe("C0.4 golden qualification registry", () => {
  it("has the deterministic registry and case shape", () => {
    expect(registry).toMatchObject({
      registryVersion: "c0-qualification/v2",
      supersedes: "c0-qualification/v1",
      fixtureId: "gks-c0.4-golden",
      profile: "C0.4",
      statusVocabulary: STATUS_VOCABULARY,
      categories: REQUIRED_CATEGORIES,
      provenance: {
        adr: "docs/ADR-GKS-C0-QUALIFICATION.md",
        toolDefinitions: "packages/gks-contracts/src/tool-definitions.mjs",
        builder: "scripts/c0-corpus/build-cases.mjs",
        runner: "scripts/run-c0-corpus.mjs",
        containsSecrets: false,
        externalEndpoints: false,
      },
    });
    expect(registry.cases.length).toBeGreaterThanOrEqual(25);
    for (const qualificationCase of registry.cases) {
      expect(qualificationCase).toMatchObject({
        id: expect.any(String),
        fixtureId: registry.fixtureId,
        contractVersion: registry.registryVersion,
        category: expect.any(String),
        runnable: expect.any(Boolean),
        normalizedScope: expect.objectContaining({ portfolioId: expect.any(String), tenantId: expect.any(String) }),
        expected: { opaqueRefs: expect.any(Array), receiptHashes: expect.any(Array), cursorOutcome: expect.any(String) },
        evidence: { testPaths: expect.any(Array), reason: expect.any(String) },
      });
      expect(qualificationCase.expected).toHaveProperty("ledger");
      expect(qualificationCase.expected).toHaveProperty("errorCode");
      if (qualificationCase.runnable) {
        expect(qualificationCase).toMatchObject({ fixture: `cases/${qualificationCase.id}.json`, expectedResult: `expected/${qualificationCase.id}.json`, requestSha256: expect.stringMatching(SHA256), expectedResultSha256: expect.stringMatching(SHA256) });
      } else {
        expect(qualificationCase).toMatchObject({ fixture: null, expectedResult: null, requestSha256: null, expectedResultSha256: null });
      }
    }
  });

  it("keeps all case IDs unique", () => {
    const ids = registry.cases.map((qualificationCase) => qualificationCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains the minimum approved C0.4 categories, each with a replayable case", () => {
    expect(new Set(registry.cases.map((qualificationCase) => qualificationCase.category))).toEqual(new Set(REQUIRED_CATEGORIES));
    for (const category of REQUIRED_CATEGORIES) {
      expect(runnable.filter((qualificationCase) => qualificationCase.category === category).length, category).toBeGreaterThan(0);
    }
  });

  it("covers exactly the 17 registered GKS tools, and each tool case calls its tool", () => {
    expect(GKS_TOOL_DEFINITIONS).toHaveLength(17);
    const toolCases = registry.cases.filter((qualificationCase) => qualificationCase.category === "tool");
    expect(toolCases.map((qualificationCase) => qualificationCase.tool)).toEqual(GKS_TOOL_DEFINITIONS.map((tool) => tool.name));
    for (const toolCase of toolCases) {
      expect(toolCase.runnable).toBe(true);
      const calledTools = readJson(toolCase.fixture).steps.filter((step) => step.kind === "call").map((step) => step.frame.params?.name);
      expect(calledTools, toolCase.id).toContain(toolCase.tool);
    }
  });

  it("pins every request fixture and golden transcript by hash", () => {
    for (const qualificationCase of runnable) {
      expect(sha256Canonical(readJson(qualificationCase.fixture)), qualificationCase.fixture).toBe(qualificationCase.requestSha256);
      expect(sha256Canonical(readJson(qualificationCase.expectedResult)), qualificationCase.expectedResult).toBe(qualificationCase.expectedResultSha256);
    }
  });

  it("rebuilds to exactly the committed fixtures", async () => {
    const { registry: rebuilt, fixtures } = await buildCorpus();
    for (const qualificationCase of runnable) {
      expect(canonicalJsonString(fixtures[qualificationCase.id]), `${qualificationCase.id} drifted from scripts/c0-corpus/build-cases.mjs`).toBe(canonicalJsonString(readJson(qualificationCase.fixture)));
    }
    const withoutResultHashes = (cases) => cases.map(({ expectedResultSha256: _hash, ...rest }) => rest);
    expect(canonicalJsonString(withoutResultHashes(rebuilt.cases))).toBe(canonicalJsonString(withoutResultHashes(registry.cases)));
  });

  it("has a complete closeout manifest with explicit limitations", () => {
    expect(resultManifest).toMatchObject({
      resultVersion: "c0-qualification-result/v2",
      registryVersion: registry.registryVersion,
      fixtureId: registry.fixtureId,
      summary: { PASS: 24, FAIL: 0, NOT_RUN: 1, BLOCKED: 0 },
      gate: { status: "PASS_WITH_LIMITATIONS", productionReady: false, deploymentAuthorized: false },
    });
    expect(resultManifest.cases.map((item) => item.id)).toEqual(registry.cases.map((item) => item.id));
    for (const item of resultManifest.cases) {
      const registered = registry.cases.find((candidate) => candidate.id === item.id);
      // PASS is a replayable claim; the one NOT_RUN case is the Tier-4 readback.
      expect(item.status, item.id).toBe(registered.runnable ? "PASS" : "NOT_RUN");
    }
    expect(resultManifest.cases.find((item) => item.status === "NOT_RUN")).toMatchObject({ id: "C0.4-TIER4-READBACK", reason: expect.stringContaining("GenesisBlockDB") });
  });
});
