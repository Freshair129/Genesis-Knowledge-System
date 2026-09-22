import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const registry = JSON.parse(readFileSync(path.join(root, "tests/fixtures/c0-qualification/registry.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "tests/fixtures/c0-qualification/result-manifest.json"), "utf8"));
const statuses = new Set(registry.statusVocabulary);
const registryIds = new Set(registry.cases.map((item) => item.id));
const manifestIds = new Set(manifest.cases.map((item) => item.id));

if (manifest.registryVersion !== registry.registryVersion) throw new Error("C0 result manifest uses a different registry version.");
if (manifest.fixtureId !== registry.fixtureId) throw new Error("C0 result manifest uses a different fixture.");
if (manifest.cases.length !== registry.cases.length || manifestIds.size !== registryIds.size) throw new Error("C0 result manifest does not cover every registry case exactly once.");
for (const id of registryIds) {
  if (!manifestIds.has(id)) throw new Error(`C0 result manifest is missing ${id}.`);
}

const counts = Object.fromEntries([...statuses].map((status) => [status, 0]));
for (const item of manifest.cases) {
  if (!statuses.has(item.status)) throw new Error(`Unsupported C0 status for ${item.id}: ${item.status}`);
  if (!Array.isArray(item.evidence)) throw new Error(`C0 evidence must be an array for ${item.id}.`);
  if (item.status === "PASS" && item.evidence.length === 0) throw new Error(`C0 PASS case has no evidence for ${item.id}.`);
  if (item.status !== "PASS" && typeof item.reason !== "string") throw new Error(`C0 non-PASS case has no reason for ${item.id}.`);
  counts[item.status] += 1;
}

for (const status of statuses) {
  if (manifest.summary?.[status] !== counts[status]) throw new Error(`C0 summary does not match case statuses for ${status}.`);
}
if (counts.FAIL > 0 || counts.BLOCKED > 0) throw new Error(`C0 qualification has unresolved failures or blockers: ${JSON.stringify(counts)}`);
console.log(`C0 qualification ${manifest.gate.status}: PASS=${counts.PASS} NOT_RUN=${counts.NOT_RUN}`);
