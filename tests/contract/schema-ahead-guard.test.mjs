// @req GKS-MIG-008, GKS-STO-001 — an older binary must not open a store that a
// newer binary migrated. The production runbook's rollback restores the
// previous artifact against the kept SQLite file; without this guard that
// artifact would read and write a schema it does not understand.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openSqlitePersistence } from "@freshair129/gks-persistence";

const SHIPPED_MIGRATIONS = path.resolve("migrations");

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The migrations directory an older binary would ship: every shipped file
// except the newest one.
function olderBinaryMigrations() {
  const dir = path.join(tempDir("gks-older-migrations-"), "migrations");
  mkdirSync(dir);
  const files = readdirSync(SHIPPED_MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files.slice(0, -1)) copyFileSync(path.join(SHIPPED_MIGRATIONS, name), path.join(dir, name));
  return { dir, dropped: files.at(-1) };
}

describe("schema-ahead guard", () => {
  it("refuses a store migrated by a newer binary and names the unknown migration", () => {
    const dbPath = path.join(tempDir("gks-schema-ahead-"), "gks.sqlite");
    openSqlitePersistence({ dbPath }).close();

    const older = olderBinaryMigrations();
    let thrown;
    try {
      openSqlitePersistence({ dbPath, migrationsDir: older.dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "an older binary must not open a newer schema").toBeDefined();
    expect(thrown.code).toBe("gks_backend_unavailable");
    expect(thrown.message).toContain("(GKS_SCHEMA_AHEAD)");
    expect(thrown.message).toContain(older.dropped);
    expect(thrown.message).not.toContain(dbPath);
  });

  it("still reopens a store at the shipped schema", () => {
    const dbPath = path.join(tempDir("gks-schema-current-"), "gks.sqlite");
    openSqlitePersistence({ dbPath }).close();
    const reopened = openSqlitePersistence({ dbPath });
    expect(reopened.health().state).toBe("ready");
    reopened.close();
  });
});
