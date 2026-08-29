import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Directories `rg --files` would never descend into (VCS metadata and
// dependency trees are not runtime source and must not gate this check).
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

function listFilesRecursive(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

describe("repository dependency boundaries", () => {
  it("runtime_hasNoGenesisBlockOrGoVibeImports", () => {
    const files = ["apps", "packages"].flatMap((dir) => listFilesRecursive(dir));
    const runtime = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(runtime).not.toMatch(/GenesisBlock|G:\\GenesisBlock_Dev|G:\\govibe|D:\\msp/);
  });

  it("packages_followContractsCorePersistenceServerDirection", () => {
    const core = readFileSync("packages/gks-core/src/index.mjs", "utf8");
    const persistence = readFileSync("packages/gks-persistence/src/index.mjs", "utf8");
    const client = readFileSync("packages/gks-client-js/src/gks-stdio-client.mjs", "utf8");

    expect(core).not.toMatch(/gks-persistence|gks-server/);
    expect(persistence).not.toMatch(/gks-core|gks-server/);
    expect(client).not.toMatch(/gks-core|gks-persistence|gks-server/);
  });
});
