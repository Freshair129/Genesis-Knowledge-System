/**
 * ingest-pipeline.mjs
 * 
 * Two-Step Chain-of-Thought Ingest Pipeline, SHA256 Incremental Cache,
 * Persistent Ingest Queue, and Cascade File Deletion.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function computeSha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function extractWikilinks(text) {
  const matches = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1].trim());
  }
  return matches;
}

export function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const endIndex = markdown.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: markdown };

  const rawYaml = markdown.slice(3, endIndex).trim();
  const body = markdown.slice(endIndex + 4).trim();
  const frontmatter = {};

  rawYaml.split("\n").forEach(line => {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        // array
        frontmatter[key] = val
          .slice(1, -1)
          .split(",")
          .map(s => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      } else {
        frontmatter[key] = val.replace(/^['"]|['"]$/g, "");
      }
    }
  });

  return { frontmatter, body };
}

export function serializeFrontmatter(frontmatter, body) {
  const lines = ["---"];
  Object.entries(frontmatter).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(item => `"${item}"`).join(", ")}]`);
    } else {
      lines.push(`${k}: "${v}"`);
    }
  });
  lines.push("---", "", body);
  return lines.join("\n");
}

export class IngestPipeline {
  constructor({ wikiDir, llmCaller = null }) {
    this.wikiDir = wikiDir;
    this.llmCaller = llmCaller;
    this.queueFile = path.join(wikiDir, ".llm-wiki", "queue.json");
    this.cacheFile = path.join(wikiDir, ".llm-wiki", "cache.json");
    this.reviewsFile = path.join(wikiDir, ".llm-wiki", "reviews.json");
    this.queue = [];
    this.cache = {}; // sha256 -> { filePath, ingestedAt, generatedFiles: [] }
    this.reviews = [];
    this.isProcessing = false;
    this.listeners = new Set();
  }

  async init() {
    await fs.mkdir(path.join(this.wikiDir, ".llm-wiki"), { recursive: true });
    await fs.mkdir(path.join(this.wikiDir, "sources"), { recursive: true });
    await fs.mkdir(path.join(this.wikiDir, "entities"), { recursive: true });
    await fs.mkdir(path.join(this.wikiDir, "concepts"), { recursive: true });
    await fs.mkdir(path.join(this.wikiDir, "queries"), { recursive: true });
    await fs.mkdir(path.join(this.wikiDir, "media"), { recursive: true });

    // Load queue
    try {
      const q = await fs.readFile(this.queueFile, "utf8");
      this.queue = JSON.parse(q);
      // Reset any stuck processing task to pending
      this.queue.forEach(t => { if (t.status === "processing") t.status = "pending"; });
    } catch {
      this.queue = [];
    }

    // Load cache
    try {
      const c = await fs.readFile(this.cacheFile, "utf8");
      this.cache = JSON.parse(c);
    } catch {
      this.cache = {};
    }

    // Load reviews
    try {
      const r = await fs.readFile(this.reviewsFile, "utf8");
      this.reviews = JSON.parse(r);
    } catch {
      this.reviews = [];
    }

    // Ensure core template files exist
    await this.ensureCoreFiles();
  }

  async ensureCoreFiles() {
    const purposePath = path.join(this.wikiDir, "purpose.md");
    try {
      await fs.access(purposePath);
    } catch {
      await fs.writeFile(purposePath, `# Wiki Purpose & Evolving Thesis\n\n## Core Objectives\n- Curate verified, interlinked knowledge from raw sources.\n- Bridge concepts across domains.\n\n## Key Research Questions\n- What are the core entities and their operational mechanics?\n- Where are the contradictions or missing links in our current understanding?\n`, "utf8");
    }

    const schemaPath = path.join(this.wikiDir, "schema.md");
    try {
      await fs.access(schemaPath);
    } catch {
      await fs.writeFile(schemaPath, `# Wiki Schema & Conventions\n\n## Page Types\n- **source**: Summaries of original papers/documents.\n- **entity**: Real-world actors, systems, models, organizations.\n- **concept**: Theories, methodologies, abstractions, paradigms.\n- **query**: Saved high-value Q&A syntheses.\n\n## Link Rules\n- Use [[wikilinks]] with exact casing.\n- Every page must declare \`sources: [...] \` in YAML frontmatter.\n`, "utf8");
    }

    const indexPath = path.join(this.wikiDir, "index.md");
    try {
      await fs.access(indexPath);
    } catch {
      await fs.writeFile(indexPath, `# Wiki Index\n\nWelcome to the persistent knowledge network.\n\n## Entities\n\n## Concepts\n\n## Sources\n`, "utf8");
    }

    const overviewPath = path.join(this.wikiDir, "overview.md");
    try {
      await fs.access(overviewPath);
    } catch {
      await fs.writeFile(overviewPath, `# Knowledge Network Overview\n\n*Auto-generated high-level synthesis of all verified sources and concepts.*\n\nNo sources ingested yet.\n`, "utf8");
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, data) {
    this.listeners.forEach(l => {
      try { l(event, data); } catch {}
    });
  }

  async saveQueue() {
    await fs.writeFile(this.queueFile, JSON.stringify(this.queue, null, 2), "utf8");
    this.emit("queue:updated", this.getQueueStatus());
  }

  async saveCache() {
    await fs.writeFile(this.cacheFile, JSON.stringify(this.cache, null, 2), "utf8");
  }

  async saveReviews() {
    await fs.writeFile(this.reviewsFile, JSON.stringify(this.reviews, null, 2), "utf8");
    this.emit("reviews:updated", this.reviews);
  }

  getQueueStatus() {
    return {
      isProcessing: this.isProcessing,
      total: this.queue.length,
      pending: this.queue.filter(q => q.status === "pending").length,
      processing: this.queue.filter(q => q.status === "processing").length,
      done: this.queue.filter(q => q.status === "done").length,
      failed: this.queue.filter(q => q.status === "failed").length,
      tasks: this.queue
    };
  }

  async enqueueFile({ filePath, content, folderHint = "" }) {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fileName = path.basename(filePath);
    const hash = computeSha256(content);

    // Check incremental cache
    if (this.cache[hash]) {
      return {
        id,
        skipped: true,
        reason: "Content unchanged (SHA256 cache hit)",
        fileName
      };
    }

    const task = {
      id,
      fileName,
      filePath,
      folderHint,
      content,
      hash,
      status: "pending",
      progress: 0,
      step: "Queued",
      error: null,
      retries: 0,
      createdAt: new Date().toISOString()
    };

    this.queue.push(task);
    await this.saveQueue();

    // Trigger process loop
    this.processNext();

    return { id, skipped: false, task };
  }

  async retryTask(taskId) {
    const task = this.queue.find(t => t.id === taskId);
    if (task) {
      task.status = "pending";
      task.error = null;
      task.progress = 0;
      task.step = "Retrying";
      await this.saveQueue();
      this.processNext();
    }
  }

  async cancelTask(taskId) {
    const idx = this.queue.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      if (this.queue[idx].status === "processing") {
        this.queue[idx].status = "cancelled";
      } else {
        this.queue.splice(idx, 1);
      }
      await this.saveQueue();
    }
  }

  async clearCompleted() {
    this.queue = this.queue.filter(t => t.status === "pending" || t.status === "processing");
    await this.saveQueue();
  }

  async processNext() {
    if (this.isProcessing) return;
    const task = this.queue.find(t => t.status === "pending");
    if (!task) return;

    this.isProcessing = true;
    task.status = "processing";
    task.step = "Step 1: Chain-of-Thought Analysis";
    task.progress = 15;
    await this.saveQueue();

    try {
      await this.executeTwoStepIngest(task);
      task.status = "done";
      task.progress = 100;
      task.step = "Completed";
    } catch (err) {
      task.retries++;
      if (task.retries <= 3) {
        task.status = "pending";
        task.step = `Auto-retry ${task.retries}/3: ${err.message}`;
      } else {
        task.status = "failed";
        task.error = err.message;
        task.step = "Failed after 3 retries";
      }
    } finally {
      this.isProcessing = false;
      await this.saveQueue();
      // Continue next in queue
      setTimeout(() => this.processNext(), 50);
    }
  }

  /**
   * Two-Step Chain-of-Thought Ingest
   * Step 1: Deep structured analysis
   * Step 2: Generation of wiki files with source traceability
   */
  async executeTwoStepIngest(task) {
    const { fileName, content, folderHint, hash } = task;

    // Read purpose.md and schema.md for context
    const purpose = await fs.readFile(path.join(this.wikiDir, "purpose.md"), "utf8").catch(() => "");
    const schema = await fs.readFile(path.join(this.wikiDir, "schema.md"), "utf8").catch(() => "");

    // STEP 1: Analysis
    task.step = "Step 1: Analyzing entities, concepts & tensions";
    task.progress = 35;
    await this.saveQueue();

    let analysis = null;
    if (this.llmCaller) {
      try {
        analysis = await this.llmCaller.analyzeSource({
          fileName,
          content,
          folderHint,
          purpose,
          schema
        });
      } catch (e) {
        console.warn("LLM analysis call failed, falling back to heuristic parser:", e.message);
      }
    }

    if (!analysis) {
      // Heuristic CoT analysis fallback
      analysis = this.heuristicAnalyze(fileName, content, folderHint);
    }

    // STEP 2: Generation
    task.step = "Step 2: Generating wiki pages, cross-references & trace frontmatter";
    task.progress = 70;
    await this.saveQueue();

    let generatedResult = null;
    if (this.llmCaller) {
      try {
        generatedResult = await this.llmCaller.generateWikiFiles({
          fileName,
          content,
          analysis,
          purpose,
          schema
        });
      } catch (e) {
        console.warn("LLM generation call failed, falling back to heuristic generator:", e.message);
      }
    }

    if (!generatedResult) {
      generatedResult = this.heuristicGenerate(fileName, content, analysis);
    }

    // Write generated files to disk
    const createdFiles = [];

    // 1. Source Summary
    const sourceSlug = slugify(path.parse(fileName).name);
    const sourcePath = path.join(this.wikiDir, "sources", `${sourceSlug}.md`);
    const sourceFrontmatter = {
      title: generatedResult.sourceSummary.title || fileName,
      type: "source_summary",
      sources: [fileName],
      date: new Date().toISOString().slice(0, 10),
      tags: generatedResult.sourceSummary.tags || ["raw-import"]
    };
    await fs.writeFile(sourcePath, serializeFrontmatter(sourceFrontmatter, generatedResult.sourceSummary.body), "utf8");
    createdFiles.push(`sources/${sourceSlug}.md`);

    // 2. Entities
    for (const ent of generatedResult.entities || []) {
      const entSlug = slugify(ent.name);
      const entPath = path.join(this.wikiDir, "entities", `${entSlug}.md`);
      let existingSources = [fileName];
      try {
        const existing = await fs.readFile(entPath, "utf8");
        const parsed = parseFrontmatter(existing);
        if (Array.isArray(parsed.frontmatter.sources)) {
          existingSources = Array.from(new Set([...parsed.frontmatter.sources, fileName]));
        }
      } catch {}

      const entFrontmatter = {
        title: ent.name,
        type: "entity",
        sources: existingSources,
        status: "canonical"
      };
      await fs.writeFile(entPath, serializeFrontmatter(entFrontmatter, ent.body), "utf8");
      createdFiles.push(`entities/${entSlug}.md`);
    }

    // 3. Concepts
    for (const con of generatedResult.concepts || []) {
      const conSlug = slugify(con.name);
      const conPath = path.join(this.wikiDir, "concepts", `${conSlug}.md`);
      let existingSources = [fileName];
      try {
        const existing = await fs.readFile(conPath, "utf8");
        const parsed = parseFrontmatter(existing);
        if (Array.isArray(parsed.frontmatter.sources)) {
          existingSources = Array.from(new Set([...parsed.frontmatter.sources, fileName]));
        }
      } catch {}

      const conFrontmatter = {
        title: con.name,
        type: "concept",
        sources: existingSources,
        status: "canonical"
      };
      await fs.writeFile(conPath, serializeFrontmatter(conFrontmatter, con.body), "utf8");
      createdFiles.push(`concepts/${conSlug}.md`);
    }

    // 4. Update Index & Overview
    task.step = "Updating Wiki Index & Synthesis Overview";
    task.progress = 88;
    await this.saveQueue();

    await this.rebuildIndexAndOverview();

    // 5. Enqueue Review Items
    if (analysis.reviewItems && analysis.reviewItems.length > 0) {
      analysis.reviewItems.forEach(item => {
        this.reviews.push({
          id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: fileName,
          claim: item.claim || item.title,
          reason: item.reason || "Ambiguity or potential contradiction",
          action: "Pending", // Create Page | Deep Research | Skip
          suggestedQueries: item.queries || [`${item.claim} verification`],
          status: "pending",
          createdAt: new Date().toISOString()
        });
      });
      await this.saveReviews();
    }

    // Record cache hit
    this.cache[hash] = {
      filePath: task.filePath,
      fileName,
      ingestedAt: new Date().toISOString(),
      generatedFiles: createdFiles
    };
    await this.saveCache();
  }

  /**
   * Heuristic analysis fallback for fast, deterministic ingestion
   */
  heuristicAnalyze(fileName, content, folderHint) {
    const cleanLines = content.split("\n").map(l => l.trim()).filter(Boolean);
    const title = cleanLines[0]?.replace(/^#+\s*/, "") || fileName;

    // Extract potential entities (capitalized phrases or keywords)
    const entitySet = new Set();
    const conceptSet = new Set();
    const words = content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];

    words.slice(0, 30).forEach(w => {
      if (["The", "And", "For", "This", "That", "With", "From"].includes(w)) return;
      if (w.endsWith("tion") || w.endsWith("ism") || w.endsWith("ity") || w.endsWith("ing")) {
        conceptSet.add(w);
      } else {
        entitySet.add(w);
      }
    });

    return {
      title,
      summary: cleanLines.slice(0, 5).join(" "),
      entities: Array.from(entitySet).slice(0, 8),
      concepts: Array.from(conceptSet).slice(0, 8),
      arguments: [
        `Document addresses core workflows in ${folderHint || "general domain"}.`,
        `Synthesizes structured relationship patterns for persistent recall.`
      ],
      reviewItems: [
        {
          claim: `Verify scope boundaries for ${title}`,
          reason: "Domain cross-dependency requires user alignment",
          queries: [`"${title}" architecture and boundaries`]
        }
      ]
    };
  }

  /**
   * Heuristic generation fallback creating interlinked markdown with wikilinks
   */
  heuristicGenerate(fileName, content, analysis) {
    const entityLinks = analysis.entities.map(e => `[[${e}]]`).join(", ");
    const conceptLinks = analysis.concepts.map(c => `[[${c}]]`).join(", ");

    const sourceSummary = {
      title: analysis.title,
      tags: ["verified-source", slugify(analysis.title)],
      body: `## Executive Summary\n${analysis.summary}\n\n## Extracted Entities\n${entityLinks || "None identified"}\n\n## Core Concepts\n${conceptLinks || "None identified"}\n\n## Source Excerpt\n\`\`\`\n${content.slice(0, 800)}\n\`\`\`\n`
    };

    const entities = analysis.entities.map(entName => ({
      name: entName,
      body: `## Overview\nEntity identified in source [[${analysis.title}]].\n\n## Relationships\n- **Document Source**: [[${analysis.title}]]\n- **Related Concepts**: ${conceptLinks}\n\n## Verified Notes\nReferenced during ingestion of \`${fileName}\`.\n`
    }));

    const concepts = analysis.concepts.map(conName => ({
      name: conName,
      body: `## Definition\nCore concept extracted from source [[${analysis.title}]].\n\n## Operational Context\nConnects to entities: ${entityLinks}\n\n## Theoretical Significance\nProvides structural framing for persistent reasoning.\n`
    }));

    return {
      sourceSummary,
      entities,
      concepts
    };
  }

  /**
   * Auto-rebuilds index.md and overview.md from disk state
   */
  async rebuildIndexAndOverview() {
    const readDirSafe = async (sub) => {
      try {
        const files = await fs.readdir(path.join(this.wikiDir, sub));
        return files.filter(f => f.endsWith(".md"));
      } catch {
        return [];
      }
    };

    const entityFiles = await readDirSafe("entities");
    const conceptFiles = await readDirSafe("concepts");
    const sourceFiles = await readDirSafe("sources");

    // Index.md
    const indexLines = [
      "# Wiki Index",
      "",
      `*Total Pages: ${entityFiles.length + conceptFiles.length + sourceFiles.length} | Last Rebuilt: ${new Date().toLocaleString()}*`,
      "",
      "## Entities",
      ...entityFiles.map(f => `- [[${path.parse(f).name}]]`),
      "",
      "## Concepts",
      ...conceptFiles.map(f => `- [[${path.parse(f).name}]]`),
      "",
      "## Sources",
      ...sourceFiles.map(f => `- [[${path.parse(f).name}]]`),
      ""
    ];
    await fs.writeFile(path.join(this.wikiDir, "index.md"), indexLines.join("\n"), "utf8");

    // Overview.md
    const overviewLines = [
      "# Knowledge Network Overview",
      "",
      `*Living high-level synthesis of all verified sources and concepts (${new Date().toLocaleDateString()}).*`,
      "",
      "## Domain Structure & Scope",
      `The knowledge base currently maintains **${sourceFiles.length} source documents**, indexing **${entityFiles.length} canonical entities** and **${conceptFiles.length} fundamental concepts**.`,
      "",
      "### Key Hub Entities",
      ...entityFiles.slice(0, 10).map(f => `- **[[${path.parse(f).name}]]**: Cross-referenced entity.`),
      "",
      "### Core Theoretical Frameworks",
      ...conceptFiles.slice(0, 10).map(f => `- **[[${path.parse(f).name}]]**: Core conceptual bridge.`),
      "",
      "## Research Directions & Synthesis",
      "- Run Deep Research on isolated knowledge gaps to close domain boundaries.",
      "- Maintain source traceability across all extracted assertions.",
      ""
    ];
    await fs.writeFile(path.join(this.wikiDir, "overview.md"), overviewLines.join("\n"), "utf8");
  }

  /**
   * Cascade File Deletion with 3-method matching:
   * 1. Frontmatter sources[] array
   * 2. Source summary page name
   * 3. Frontmatter section references
   * Preserves shared entities (only removes deleted source from their sources array)
   */
  async cascadeDeleteSource(sourceFileName) {
    const sourceSlug = slugify(path.parse(sourceFileName).name);
    const deletedFiles = [];
    const updatedFiles = [];

    // 1. Delete source summary
    const sourceSummaryPath = path.join(this.wikiDir, "sources", `${sourceSlug}.md`);
    try {
      await fs.unlink(sourceSummaryPath);
      deletedFiles.push(`sources/${sourceSlug}.md`);
    } catch {}

    // Check entities and concepts
    for (const sub of ["entities", "concepts"]) {
      const dirPath = path.join(this.wikiDir, sub);
      let files = [];
      try { files = await fs.readdir(dirPath); } catch {}

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, "utf8");
        const { frontmatter, body } = parseFrontmatter(content);

        let sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
        if (sources.includes(sourceFileName) || sources.includes(sourceSlug)) {
          // Remove deleted source
          sources = sources.filter(s => s !== sourceFileName && s !== sourceSlug);

          if (sources.length === 0) {
            // Solely dependent -> delete file
            await fs.unlink(filePath);
            deletedFiles.push(`${sub}/${file}`);
          } else {
            // Shared entity -> preserve file, update frontmatter
            frontmatter.sources = sources;
            await fs.writeFile(filePath, serializeFrontmatter(frontmatter, body), "utf8");
            updatedFiles.push(`${sub}/${file}`);
          }
        }
      }
    }

    // Clean dead wikilinks from remaining files
    const deadPageNames = new Set([sourceSlug, ...deletedFiles.map(f => path.parse(f).name)]);
    for (const sub of ["entities", "concepts", "sources"]) {
      const dirPath = path.join(this.wikiDir, sub);
      let files = [];
      try { files = await fs.readdir(dirPath); } catch {}

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dirPath, file);
        let content = await fs.readFile(filePath, "utf8");
        let modified = false;

        deadPageNames.forEach(dead => {
          const re = new RegExp(`\\[\\[${dead}\\]\\]`, "g");
          if (re.test(content)) {
            content = content.replace(re, `*${dead} (deleted)*`);
            modified = true;
          }
        });

        if (modified) {
          await fs.writeFile(filePath, content, "utf8");
          updatedFiles.push(`${sub}/${file}`);
        }
      }
    }

    // Rebuild index and overview
    await this.rebuildIndexAndOverview();

    // Clear from cache
    Object.keys(this.cache).forEach(hash => {
      if (this.cache[hash].fileName === sourceFileName) {
        delete this.cache[hash];
      }
    });
    await this.saveCache();

    return { deletedFiles, updatedFiles };
  }
}
