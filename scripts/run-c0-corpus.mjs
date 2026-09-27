// @req GKS-MIG-002, ADR-GKS-C0-QUALIFICATION D4 — replay the C0.4 golden corpus.
//
//   node scripts/run-c0-corpus.mjs              replay every runnable case; exit 1 on any mismatch
//   node scripts/run-c0-corpus.mjs --case ID    replay one case
//   node scripts/run-c0-corpus.mjs --write      re-baseline: expected transcripts, registry hashes,
//                                               result manifest
//
// A replay passes only when the request fixture still hashes to the registry,
// every step's intent annotation holds, no fixture secret leaks, stdout carries
// protocol frames only, and the normalized transcript hashes to the registry.
// --write refuses to record a case whose two consecutive runs disagree, so a
// value the normalizer misses cannot be baselined as golden.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CORPUS_DIR, firstDifference, readJson, runCase, sha256Canonical } from "./c0-corpus/runner.mjs";

const root = process.cwd();
const REGISTRY = `${CORPUS_DIR}/registry.json`;
const MANIFEST = `${CORPUS_DIR}/result-manifest.json`;
const args = process.argv.slice(2);
const write = args.includes("--write");
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
if (write && only) throw new Error("--write re-baselines the whole corpus; it cannot be combined with --case.");

function writeJson(relativePath, value) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function provenance() {
  const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", "apps", "packages", "migrations", CORPUS_DIR, "scripts/c0-corpus", "scripts/run-c0-corpus.mjs") !== "";
  return dirty ? `${head}+working-tree` : head;
}

const registry = readJson(root, REGISTRY);
const manifest = readJson(root, MANIFEST);
const selected = registry.cases.filter((item) => item.runnable && (!only || item.id === only));
if (only && !selected.length) throw new Error(`No runnable case ${only} in the registry.`);

const failures = [];
const results = new Map();
for (const item of selected) {
  const fixture = readJson(root, `${CORPUS_DIR}/${item.fixture}`);
  const problems = [];
  if (sha256Canonical(fixture) !== item.requestSha256) problems.push(`request fixture ${item.fixture} does not hash to the registry; rebuild with scripts/c0-corpus/build-cases.mjs`);
  const run = await runCase(root, fixture);
  problems.push(...run.problems);
  const actualSha256 = sha256Canonical(run.transcript);
  if (write) {
    if (!problems.length) {
      const again = await runCase(root, fixture);
      if (sha256Canonical(again.transcript) !== actualSha256) problems.push(`not deterministic across two runs: ${firstDifference(run.transcript, again.transcript)}`);
      problems.push(...again.problems);
    }
    if (!problems.length) {
      writeJson(`${CORPUS_DIR}/${item.expectedResult}`, run.transcript);
      item.expectedResultSha256 = actualSha256;
    }
  } else if (actualSha256 !== item.expectedResultSha256) {
    let expected = null;
    try {
      expected = readJson(root, `${CORPUS_DIR}/${item.expectedResult}`);
    } catch { /* reported below */ }
    if (!expected) problems.push(`expected transcript ${item.expectedResult} is missing`);
    else if (sha256Canonical(expected) !== item.expectedResultSha256) problems.push(`expected transcript ${item.expectedResult} does not hash to the registry`);
    else problems.push(`transcript differs from the golden result at ${firstDifference(expected, run.transcript)}`);
  }
  const manifestCase = manifest.cases?.find((candidate) => candidate.id === item.id);
  if (!write && manifestCase?.status !== "PASS") problems.push(`result manifest records ${manifestCase?.status ?? "no status"}, not PASS`);
  results.set(item.id, problems);
  console.log(`${problems.length ? "FAIL" : "PASS"} ${item.id} (${fixture.steps.length} steps)`);
  for (const problem of problems) console.log(`     - ${problem}`);
  if (problems.length) failures.push(item.id);
}

if (write) {
  if (failures.length) {
    console.error(`Not re-baselined: ${failures.length} case(s) failed. Fix them first.`);
    process.exit(1);
  }
  writeJson(REGISTRY, registry);
  const status = (item) => (item.runnable ? (item.expectedResultSha256 ? "PASS" : "NOT_RUN") : "NOT_RUN");
  const cases = registry.cases.map((item) => {
    const evidence = item.runnable ? [`${CORPUS_DIR}/${item.fixture}`, `${CORPUS_DIR}/${item.expectedResult}`, ...item.evidence.testPaths] : item.evidence.testPaths;
    return status(item) === "PASS" ? { id: item.id, status: "PASS", evidence } : { id: item.id, status: status(item), evidence, reason: item.evidence.reason };
  });
  const summary = { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0 };
  for (const item of cases) summary[item.status] += 1;
  writeJson(MANIFEST, {
    resultVersion: "c0-qualification-result/v2",
    registryVersion: registry.registryVersion,
    fixtureId: registry.fixtureId,
    recordedAt: new Date().toISOString().slice(0, 10),
    recordedFrom: provenance(),
    runtime: { node: process.versions.node, platform: process.platform, database: "repository-owned SQLite", secretsIncluded: false },
    runs: [{ id: "c0-corpus", status: "PASS", command: "npm run check:corpus", cases: selected.length, evidence: "Every runnable case replayed against a real gks-server stdio process on a fresh store, twice, with identical normalized transcripts." }],
    // Real-MSP runs cannot be replayed from this repository; they are carried
    // forward with their own recording date, never re-dated by a re-baseline.
    externalRuns: manifest.externalRuns ?? (manifest.runs ?? []).filter((run) => run.id.startsWith("msp-")).map((run) => ({ ...run, recordedAt: run.recordedAt ?? manifest.recordedAt, baselineSha: run.baselineSha ?? manifest.baselineSha })),
    cases,
    summary,
    gate: {
      status: summary.NOT_RUN || summary.BLOCKED ? "PASS_WITH_LIMITATIONS" : "PASS",
      meaning: "Every runnable C0.4 case replays from its tracked request fixture to its golden transcript. Tier-4 physical readback is outside the GKS boundary and stays NOT_RUN; deployment is not authorized by this gate.",
      productionReady: false,
      deploymentAuthorized: false,
    },
  });
  console.log(`Re-baselined ${selected.length} case(s); registry and result manifest written.`);
} else if (failures.length) {
  console.error(`C0.4 corpus: ${failures.length} of ${selected.length} case(s) failed.`);
  process.exit(1);
} else {
  console.log(`C0.4 corpus: all ${selected.length} runnable case(s) replay to their golden results.`);
}
