// @req GKS-MIG-001 (baseline lock), GKS-API-001 (frozen public tools) — detect
// drift from the recorded baseline instead of trusting a hand-written report.
//
//   node scripts/check-baseline-lock.mjs          compare; exit 1 on drift
//   node scripts/check-baseline-lock.mjs --write  re-lock after a deliberate change
//
// Text inputs are hashed with CRLF folded to LF, so a Windows working copy and
// a Linux CI checkout of the same commit lock to the same values.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GKS_TOOL_DEFINITIONS, canonicalJsonString } from "@freshair129/gks-contracts";

const root = process.cwd();
const LOCK_PATH = path.join(root, "tests/fixtures/baseline-lock.json");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function textSha256(relativePath) {
  return sha256(readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n"));
}

function observe() {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return {
    nodeEngine: pkg.engines?.node ?? null,
    packageLockSha256: textSha256("package-lock.json"),
    workflowSha256: textSha256(".github/workflows/test.yml"),
    migrations: readdirSync(path.join(root, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sha256: textSha256(path.join("migrations", name)) })),
    tools: GKS_TOOL_DEFINITIONS.map((tool) => tool.name),
    toolRegistrySha256: sha256(canonicalJsonString(GKS_TOOL_DEFINITIONS)),
  };
}

function drift(locked, observed) {
  const differences = [];
  for (const key of ["nodeEngine", "packageLockSha256", "workflowSha256", "toolRegistrySha256"]) {
    if (locked[key] !== observed[key]) differences.push(`${key}: locked ${locked[key]} observed ${observed[key]}`);
  }
  if (canonicalJsonString(locked.tools) !== canonicalJsonString(observed.tools)) {
    differences.push(`tools: locked [${locked.tools.join(", ")}] observed [${observed.tools.join(", ")}]`);
  }
  const lockedMigrations = new Map(locked.migrations.map((item) => [item.name, item.sha256]));
  const observedMigrations = new Map(observed.migrations.map((item) => [item.name, item.sha256]));
  for (const [name, hash] of lockedMigrations) {
    // A shipped migration is immutable: editing or removing one rewrites history.
    if (!observedMigrations.has(name)) differences.push(`migration removed: ${name}`);
    else if (observedMigrations.get(name) !== hash) differences.push(`migration changed: ${name}`);
  }
  for (const name of observedMigrations.keys()) {
    if (!lockedMigrations.has(name)) differences.push(`migration added without re-lock: ${name}`);
  }
  return differences;
}

const observed = observe();

// The hashed inputs, for telling whether the lock was taken from HEAD itself
// or from uncommitted changes on top of it.
const HASHED_PATHS = ["package.json", "package-lock.json", ".github/workflows/test.yml", "migrations", "packages/gks-contracts/src"];

if (process.argv.includes("--write")) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", ...HASHED_PATHS) !== "";
  // Honest provenance: a lock written over uncommitted changes names HEAD
  // plus "+working-tree", never HEAD alone.
  const lockedFromCommit = dirty ? `${head}+working-tree` : head;
  const lock = { lockVersion: "gks-baseline-lock/v1", lockedAt: new Date().toISOString().slice(0, 10), lockedFromCommit, ...observed };
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Baseline lock written from ${lockedFromCommit}.`);
} else {
  const locked = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  const differences = drift(locked, observed);
  if (differences.length) {
    console.error(`Baseline drift since ${locked.lockedFromCommit} (${locked.lockedAt}):`);
    for (const difference of differences) console.error(`  - ${difference}`);
    console.error("If the change is deliberate, re-lock with: node scripts/check-baseline-lock.mjs --write");
    process.exitCode = 1;
  } else {
    console.log(`Baseline lock holds: ${observed.tools.length} tools, ${observed.migrations.length} migrations, locked from ${locked.lockedFromCommit}.`);
  }
}
