// @req SEC — a failure to open the store must not republish the store's
// location. The message crosses two process boundaries: GKS writes it to
// stderr (apps/gks-server/bin/gks-server.mjs), and MSP folds a GKS child's
// stderr tail into the error it returns to its own caller
// (Memory-and-Soul-Passport, apps/msp-server/src/providers/gks-stdio-provider.mjs),
// so a raw Node fs error would carry the value of GKS_DB_PATH out to whoever
// called the tool. Before this, mkdirSync ran outside the try and propagated
// unwrapped.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openSqlitePersistence } from "@freshair129/gks-persistence";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function unopenableDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "gks-redaction-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // A file where a directory must be: creating the parent directory fails, and
  // Node's fs error embeds the offending path.
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  return path.join(blocker, "nested", "gks.sqlite");
}

describe("persistence open failure", () => {
  it("names the error code but never the value of GKS_DB_PATH", () => {
    const dbPath = unopenableDbPath();
    let thrown;
    try {
      openSqlitePersistence({ dbPath });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "opening an unopenable store must fail").toBeDefined();
    expect(thrown.message).toContain("Unable to open GKS persistence");
    // Diagnosable: the OS error code survives.
    expect(thrown.message, "the error code is what makes this diagnosable").toMatch(/\((E[A-Z]+|SQLITE_[A-Z_]+)\)/);
    // Redacted: neither the path nor its parent directory appears anywhere.
    expect(thrown.message).not.toContain(dbPath);
    expect(thrown.message).not.toContain(path.dirname(dbPath));
    expect(thrown.message).not.toContain(tmpdir());
    expect(thrown.message).toContain("<GKS_DB_PATH");
  });

  it("still rejects a relative path before touching the filesystem", () => {
    expect(() => openSqlitePersistence({ dbPath: "relative/gks.sqlite" })).toThrow(/GKS_DB_PATH must be an absolute path/);
  });
});
