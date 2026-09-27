// Static C0.4 qualification check: the result manifest covers the registry
// exactly, statuses and summary agree, and every runnable case's request
// fixture and golden transcript still hash to the registry. Replaying the
// corpus is `npm run check:corpus`.
import { existsSync } from "node:fs";
import path from "node:path";
import { CORPUS_DIR, readJson, sha256Canonical } from "./c0-corpus/runner.mjs";

const root = process.cwd();
const registry = readJson(root, `${CORPUS_DIR}/registry.json`);
const manifest = readJson(root, `${CORPUS_DIR}/result-manifest.json`);
const statuses = new Set(registry.statusVocabulary);
const registryIds = new Set(registry.cases.map((item) => item.id));
const manifestIds = new Set(manifest.cases.map((item) => item.id));

if (manifest.registryVersion !== registry.registryVersion) throw new Error("C0 result manifest uses a different registry version.");
if (manifest.fixtureId !== registry.fixtureId) throw new Error("C0 result manifest uses a different fixture.");
if (manifest.cases.length !== registry.cases.length || manifestIds.size !== registryIds.size) throw new Error("C0 result manifest does not cover every registry case exactly once.");
for (const id of registryIds) {
  if (!manifestIds.has(id)) throw new Error(`C0 result manifest is missing ${id}.`);
}

for (const item of registry.cases) {
  if (!item.runnable) continue;
  for (const [file, hash, label] of [[item.fixture, item.requestSha256, "request fixture"], [item.expectedResult, item.expectedResultSha256, "golden transcript"]]) {
    if (!file || !existsSync(path.join(root, CORPUS_DIR, file))) throw new Error(`C0 ${label} for ${item.id} is missing.`);
    if (sha256Canonical(readJson(root, `${CORPUS_DIR}/${file}`)) !== hash) throw new Error(`C0 ${label} ${file} does not hash to the registry for ${item.id}.`);
  }
}

const counts = Object.fromEntries([...statuses].map((status) => [status, 0]));
for (const item of manifest.cases) {
  if (!statuses.has(item.status)) throw new Error(`Unsupported C0 status for ${item.id}: ${item.status}`);
  if (!Array.isArray(item.evidence)) throw new Error(`C0 evidence must be an array for ${item.id}.`);
  if (item.status === "PASS" && item.evidence.length === 0) throw new Error(`C0 PASS case has no evidence for ${item.id}.`);
  if (item.status !== "PASS" && typeof item.reason !== "string") throw new Error(`C0 non-PASS case has no reason for ${item.id}.`);
  // A PASS is a replayable claim: only a runnable case can carry one.
  if (item.status === "PASS" && !registry.cases.find((candidate) => candidate.id === item.id).runnable) throw new Error(`C0 case ${item.id} is PASS but has no replayable fixture.`);
  counts[item.status] += 1;
}

for (const status of statuses) {
  if (manifest.summary?.[status] !== counts[status]) throw new Error(`C0 summary does not match case statuses for ${status}.`);
}
if (counts.FAIL > 0 || counts.BLOCKED > 0) throw new Error(`C0 qualification has unresolved failures or blockers: ${JSON.stringify(counts)}`);
console.log(`C0 qualification ${manifest.gate.status}: PASS=${counts.PASS} NOT_RUN=${counts.NOT_RUN}`);
