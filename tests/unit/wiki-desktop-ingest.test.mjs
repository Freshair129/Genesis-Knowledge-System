import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  IngestPipeline,
  computeSha256,
  parseFrontmatter,
  serializeFrontmatter,
  extractWikilinks
} from "../../apps/wiki-desktop/src/ingest-pipeline.mjs";

describe("Ingest Pipeline & Cascade Cleanup", () => {
  let tempDir;
  let pipeline;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gks-wiki-test-"));
    pipeline = new IngestPipeline({ wikiDir: tempDir });
    await pipeline.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("computes deterministic SHA256 hashes", () => {
    const hash1 = computeSha256("test content");
    const hash2 = computeSha256("test content");
    const hash3 = computeSha256("different content");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it("parses and serializes YAML frontmatter with sources traceability", () => {
    const raw = `---
title: "Quantum Decoupling"
type: "concept"
sources: ["paper1.pdf", "paper2.pdf"]
status: "canonical"
---

## Overview
Connects to [[Quantum Coherence]].
`;

    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter.title).toBe("Quantum Decoupling");
    expect(parsed.frontmatter.type).toBe("concept");
    expect(parsed.frontmatter.sources).toEqual(["paper1.pdf", "paper2.pdf"]);
    expect(extractWikilinks(parsed.body)).toEqual(["Quantum Coherence"]);

    const reserialized = serializeFrontmatter(parsed.frontmatter, parsed.body);
    expect(reserialized).toContain('title: "Quantum Decoupling"');
    expect(reserialized).toContain('sources: ["paper1.pdf", "paper2.pdf"]');
  });

  it("executes Two-Step Ingest and caches file SHA256", async () => {
    const docContent = `# Autonomous Knowledge Systems\n\nAutonomous edge devices maintain persistent memory through Graph Networks. Connects to [[Genesis Architecture]].\n`;

    const res1 = await pipeline.enqueueFile({
      filePath: "autonomous-systems.md",
      content: docContent,
      folderHint: "research"
    });

    expect(res1.skipped).toBe(false);

    // Wait for queue to process
    let attempts = 0;
    while (pipeline.isProcessing || pipeline.queue.some(t => t.status === "pending" || t.status === "processing")) {
      await new Promise(r => setTimeout(r, 50));
      attempts++;
      if (attempts > 40) break;
    }

    // Check generated files
    const sourceSummaryPath = path.join(tempDir, "sources", "autonomous-systems.md");
    const summaryExists = await fs.access(sourceSummaryPath).then(() => true).catch(() => false);
    expect(summaryExists).toBe(true);

    // Enqueueing identical content must be skipped by SHA256 cache
    const res2 = await pipeline.enqueueFile({
      filePath: "autonomous-systems.md",
      content: docContent
    });
    expect(res2.skipped).toBe(true);
    expect(res2.reason).toContain("SHA256 cache hit");
  });

  it("handles cascade deletion: cleans dead links and preserves shared entities", async () => {
    // Manually create two sources and a shared entity
    const entDir = path.join(tempDir, "entities");
    const srcDir = path.join(tempDir, "sources");

    // Shared entity linked to DocA and DocB
    const sharedEntPath = path.join(entDir, "shared-model.md");
    const sharedContent = serializeFrontmatter(
      { title: "Shared Model", type: "entity", sources: ["DocA.pdf", "DocB.pdf"] },
      "References [[DocA]] and [[DocB]]."
    );
    await fs.writeFile(sharedEntPath, sharedContent, "utf8");

    // Sole entity linked only to DocA
    const soleEntPath = path.join(entDir, "sole-model.md");
    const soleContent = serializeFrontmatter(
      { title: "Sole Model", type: "entity", sources: ["DocA.pdf"] },
      "References [[DocA]]."
    );
    await fs.writeFile(soleEntPath, soleContent, "utf8");

    // Delete DocA
    const cascadeRes = await pipeline.cascadeDeleteSource("DocA.pdf");

    // 1. Sole entity should be deleted
    const soleExists = await fs.access(soleEntPath).then(() => true).catch(() => false);
    expect(soleExists).toBe(false);
    expect(cascadeRes.deletedFiles).toContain("entities/sole-model.md");

    // 2. Shared entity should be preserved, but DocA removed from sources
    const sharedExists = await fs.access(sharedEntPath).then(() => true).catch(() => false);
    expect(sharedExists).toBe(true);
    const updatedShared = await fs.readFile(sharedEntPath, "utf8");
    const parsedShared = parseFrontmatter(updatedShared);
    expect(parsedShared.frontmatter.sources).toEqual(["DocB.pdf"]);
  });
});
