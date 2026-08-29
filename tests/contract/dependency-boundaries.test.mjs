import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

describe("repository dependency boundaries", () => {
  it("runtime_hasNoGenesisBlockOrGoVibeImports", () => {
    const files = execFileSync("rg", ["--files", "apps", "packages"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
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
