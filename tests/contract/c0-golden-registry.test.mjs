import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GKS_TOOL_DEFINITIONS } from "@freshair129/gks-contracts";

const registryPath = path.resolve(process.cwd(), "tests/fixtures/c0-qualification/registry.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const resultManifest = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/c0-qualification/result-manifest.json"), "utf8"));
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

describe("C0.4 golden qualification registry", () => {
  it("has the deterministic registry and case shape", () => {
    expect(registry).toMatchObject({
      registryVersion: "c0-qualification/v1",
      fixtureId: "gks-c0.4-golden",
      profile: "C0.4",
      statusVocabulary: STATUS_VOCABULARY,
      categories: REQUIRED_CATEGORIES,
      provenance: {
        adr: "docs/ADR-GKS-C0-QUALIFICATION.md",
        toolDefinitions: "packages/gks-contracts/src/tool-definitions.mjs",
        runtime: "fixture-only",
        containsSecrets: false,
        externalEndpoints: false,
      },
    });
    expect(Array.isArray(registry.cases)).toBe(true);
    expect(registry.cases.length).toBeGreaterThanOrEqual(24);

    for (const qualificationCase of registry.cases) {
      expect(qualificationCase).toMatchObject({
        id: expect.any(String),
        fixtureId: registry.fixtureId,
        contractVersion: registry.registryVersion,
        category: expect.any(String),
        status: expect.stringMatching(/^(PASS|FAIL|NOT_RUN|BLOCKED)$/),
        requestSha256: expect.stringMatching(SHA256),
        expectedResultSha256: expect.stringMatching(SHA256),
        normalizedScope: {
          portfolioId: expect.any(String),
          tenantId: expect.any(String),
          businessId: expect.any(String),
          workspaceId: expect.any(String),
          agentId: expect.any(String),
          visibility: expect.any(String),
        },
        expected: {
          opaqueRefs: expect.any(Array),
          receiptHashes: expect.any(Array),
          cursorOutcome: expect.any(String),
        },
        evidence: {
          executable: expect.any(Boolean),
          testPaths: expect.any(Array),
          reason: expect.any(String),
        },
      });
      expect(STATUS_VOCABULARY).toContain(qualificationCase.status);
      expect(qualificationCase.expected).toHaveProperty("ledger");
      expect(qualificationCase.expected).toHaveProperty("errorCode");

      if (qualificationCase.status === "PASS") {
        expect(qualificationCase.evidence.executable).toBe(true);
        expect(qualificationCase.evidence.testPaths.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps all case IDs unique", () => {
    const ids = registry.cases.map((qualificationCase) => qualificationCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains the minimum approved C0.4 categories", () => {
    expect(new Set(registry.cases.map((qualificationCase) => qualificationCase.category))).toEqual(new Set(REQUIRED_CATEGORIES));
    for (const category of REQUIRED_CATEGORIES) {
      expect(registry.cases.filter((qualificationCase) => qualificationCase.category === category).length).toBeGreaterThan(0);
    }
  });

  it("covers exactly the 17 registered GKS tools", () => {
    expect(GKS_TOOL_DEFINITIONS).toHaveLength(17);
    const toolCases = registry.cases.filter((qualificationCase) => qualificationCase.category === "tool");
    expect(toolCases).toHaveLength(17);
    expect(toolCases.map((qualificationCase) => qualificationCase.tool)).toEqual(GKS_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(new Set(toolCases.map((qualificationCase) => qualificationCase.tool)).size).toBe(17);
  });

  it("has a complete closeout manifest with explicit limitations", () => {
    expect(resultManifest).toMatchObject({
      resultVersion: "c0-qualification-result/v1",
      registryVersion: registry.registryVersion,
      fixtureId: registry.fixtureId,
      summary: { PASS: 22, FAIL: 0, NOT_RUN: 2, BLOCKED: 0 },
      gate: { status: "PASS_WITH_LIMITATIONS", productionReady: false, deploymentAuthorized: false },
    });
    expect(resultManifest.cases).toHaveLength(registry.cases.length);
    expect(resultManifest.cases.filter((item) => item.status === "PASS")).toHaveLength(22);
    expect(resultManifest.cases.filter((item) => item.status === "NOT_RUN")).toHaveLength(2);
    expect(resultManifest.cases.every((item) => registry.cases.some((candidate) => candidate.id === item.id))).toBe(true);
  });
});
