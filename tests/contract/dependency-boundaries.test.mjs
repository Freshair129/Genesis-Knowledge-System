import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Directories `rg --files` would never descend into (VCS metadata,
// dependency trees, coverage output and scratch dirs are not runtime
// source and must not gate this check). `.gitignore` also excludes
// coverage/, .tmp/, *.sqlite*, *.tgz under apps/packages; coverage and
// .tmp are directory names so they belong here, while the dotfile skip
// below (matching `rg --files`' default) covers .git, .tmp and any other
// hidden entry without needing to enumerate every ignored file pattern.
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "coverage", ".tmp"]);

function listFilesRecursive(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `rg --files` hides dotfiles/dot-directories by default.
      if (entry.name.startsWith(".")) continue;
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

// apps/wiki-desktop is a standalone desktop viewer that reads GenesisBlockDB
// itself. It is not the GKS service, is not on the MSP -> GKS path, and GKS
// never imports it -- so it is exempt by name, not by a spelling that happens
// to dodge the pattern. Any other app is GKS runtime and is checked.
const NON_SERVICE_APPS = new Set(["wiki-desktop"]);
const OUTWARD_REFERENCE = /GenesisBlock|G:\\GenesisBlock_Dev|G:\\govibe|D:\\msp/i;

function serviceRoots() {
  const apps = readdirSync("apps", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_SERVICE_APPS.has(entry.name))
    .map((entry) => join("apps", entry.name));
  return [...apps, "packages"];
}

describe("repository dependency boundaries", () => {
  it("runtime_hasNoGenesisBlockOrGoVibeImports", () => {
    const offenders = serviceRoots()
      .flatMap((dir) => listFilesRecursive(dir))
      .filter((file) => OUTWARD_REFERENCE.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("outwardReference_matchesAnySpelling", () => {
    for (const spelling of ["GenesisBlock", "Genesisblock", "genesisblock", "GENESISBLOCK"]) {
      expect(OUTWARD_REFERENCE.test(`fetch(${spelling}Url)`), spelling).toBe(true);
    }
  });

  // Every module under each package's src/, judged by the specifiers it
  // actually imports -- not a text scan of one entry file.
  it("packages_followContractsCorePersistenceServerDirection", () => {
    const forbidden = {
      "gks-contracts": ["gks-core", "gks-persistence", "gks-server", "gks-client-js"],
      "gks-core": ["gks-persistence", "gks-server", "gks-client-js"],
      "gks-persistence": ["gks-core", "gks-server", "gks-client-js"],
      "gks-client-js": ["gks-contracts", "gks-core", "gks-persistence", "gks-server"],
    };
    const violations = [];
    for (const [pkg, banned] of Object.entries(forbidden)) {
      const files = listFilesRecursive(join("packages", pkg, "src")).filter((file) => /\.[cm]?js$/.test(file));
      expect(files.length, `${pkg} has source files to check`).toBeGreaterThan(0);
      for (const file of files) {
        for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
          const hit = banned.find((name) => specifier.toLowerCase().includes(name));
          if (hit) violations.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("importSpecifiers_seesStaticDynamicAndReexportForms", () => {
    const source = [
      'import { a } from "@freshair129/gks-core";',
      "import './side-effect.mjs';",
      'export * from "@freshair129/gks-persistence";',
      'const lazy = await import("@freshair129/gks-server");',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["@freshair129/gks-core", "./side-effect.mjs", "@freshair129/gks-persistence", "@freshair129/gks-server"]);
  });
});

function importSpecifiers(source) {
  const pattern = /(?:^|[\s;])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2]);
}
