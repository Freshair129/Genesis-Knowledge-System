import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("standalone startup boundary", () => {
  it("server_missingExplicitDatabasePath_failsBeforeServing", () => {
    const env = { ...process.env };
    delete env.GKS_DB_PATH;
    const result = spawnSync(process.execPath, [path.resolve("apps/gks-server/bin/gks-server.mjs")], {
      cwd: path.resolve("."),
      env,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GKS_DB_PATH must be an explicit absolute path/);
    expect(result.stdout).toBe("");
  });
});
