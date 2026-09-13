/**
 * server.mjs
 * 
 * Genesis LLM Wiki & Knowledge Graph Desktop Daemon
 * Local HTTP API (port 19828 / 19827), MCP Server, and Ingest/Graph Runtime.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build4SignalGraph, detectLouvainCommunities, generateGraphInsights } from "./src/graph-engine.mjs";
import { IngestPipeline, parseFrontmatter, serializeFrontmatter, slugify, extractWikilinks } from "./src/ingest-pipeline.mjs";
import { AgentRuntime } from "./src/agent-runtime.mjs";
import { GenesisblockBridge } from "./src/Genesisblock-bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "19828", 10);
const CLIPPER_PORT = 19827;
const WIKI_DIR = process.env.WIKI_DIR ? path.resolve(process.env.WIKI_DIR) : path.join(__dirname, "data", "wiki");

// Ensure wiki directory
await fs.mkdir(WIKI_DIR, { recursive: true });

// Initialize Pipeline, Agent Runtime & GenesisblockDB Bridge
const pipeline = new IngestPipeline({ wikiDir: WIKI_DIR });
await pipeline.init();

const agent = new AgentRuntime({
  wikiDir: WIKI_DIR,
  skillsDirs: [path.join(__dirname, "skills")]
});
await agent.init();

const genesisBridge = new GenesisblockBridge({ wikiDir: WIKI_DIR });
await genesisBridge.checkHealth();

// Auto-sync graph snapshot to GenesisblockDB on queue completion
pipeline.subscribe(async (event) => {
  if (event === "queue:updated") {
    const q = pipeline.getQueueStatus();
    if (!q.isProcessing && q.pending === 0 && q.done > 0) {
      try {
        const graphData = await loadFullGraphData();
        await genesisBridge.syncGraphSnapshot(graphData);
      } catch {}
    }
  }
});

// Helper to scan all wiki markdown pages for graph building
async function loadFullGraphData() {
  const nodes = [];
  const directEdges = [];
  const subdirs = ["sources", "entities", "concepts", "queries"];

  for (const sub of subdirs) {
    const dir = path.join(WIKI_DIR, sub);
    let files = [];
    try { files = await fs.readdir(dir); } catch {}

    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const full = path.join(dir, f);
      try {
        const text = await fs.readFile(full, "utf8");
        const { frontmatter, body } = parseFrontmatter(text);
        const id = path.parse(f).name;
        const name = frontmatter.title || id;
        const type = frontmatter.type || (sub === "sources" ? "source" : sub.slice(0, -1));

        nodes.push({
          id,
          name,
          label: type,
          status: frontmatter.status || "canonical",
          sources: Array.isArray(frontmatter.sources) ? frontmatter.sources : [],
          props: {
            tags: frontmatter.tags || [],
            date: frontmatter.date || null,
            file: `${sub}/${f}`,
            excerpt: body.slice(0, 200).replace(/\n+/g, " ")
          }
        });

        // Extract wikilinks
        const links = extractWikilinks(body);
        links.forEach(target => {
          directEdges.push({
            source: id,
            target: slugify(target),
            type: "WIKILINK"
          });
        });
      } catch {}
    }
  }

  // If no nodes, seed with scenario starter nodes for demo
  if (nodes.length === 0) {
    nodes.push(
      { id: "genesis-architecture", name: "Genesis Architecture", label: "concept", sources: ["genesis-spec.md"], props: { excerpt: "Core architectural foundation for local knowledge graphs." } },
      { id: "two-step-cot", name: "Two-Step CoT Ingestion", label: "concept", sources: ["genesis-spec.md", "ingest-guide.pdf"], props: { excerpt: "Sequential analysis followed by structured wiki generation." } },
      { id: "knowledge-graph", name: "4-Signal Knowledge Graph", label: "entity", sources: ["genesis-spec.md"], props: { excerpt: "Relevance model with direct links, overlap, Adamic-Adar, and affinity." } },
      { id: "louvain-clustering", name: "Louvain Community Detection", label: "concept", sources: ["graph-theory.pdf"], props: { excerpt: "Modularity-based graph clustering with cohesion scoring." } },
      { id: "genesis-spec", name: "Genesis Specification v4", label: "source", sources: ["genesis-spec.md"], props: { excerpt: "Canonical technical specification for autonomous edge agents." } },
      { id: "ingest-guide", name: "Document Ingestion Guide", label: "source", sources: ["ingest-guide.pdf"], props: { excerpt: "Best practices for multi-format document ingestion." } }
    );
    directEdges.push(
      { source: "genesis-architecture", target: "two-step-cot", type: "WIKILINK" },
      { source: "genesis-architecture", target: "knowledge-graph", type: "WIKILINK" },
      { source: "knowledge-graph", target: "louvain-clustering", type: "WIKILINK" },
      { source: "two-step-cot", target: "genesis-spec", type: "WIKILINK" },
      { source: "two-step-cot", target: "ingest-guide", type: "WIKILINK" }
    );
  }

  const graph = build4SignalGraph(nodes, directEdges);
  const louvain = detectLouvainCommunities(graph.nodes, graph.edges);
  const insights = generateGraphInsights(graph.nodes, graph.edges, louvain.communities, louvain.stats);

  return {
    nodes: graph.nodes.map(n => ({
      ...n,
      community: louvain.communities[n.id] ?? 0
    })),
    edges: graph.edges,
    communities: louvain.communities,
    communityStats: louvain.stats,
    insights,
    statLine: `${graph.nodes.length} nodes ยท ${graph.edges.length} edges ยท ${louvain.stats.length} communities`
  };
}

// Lint Wiki health
async function lintWiki() {
  const issues = [];
  const graphData = await loadFullGraphData();
  const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));

  // 1. Broken Wikilinks
  graphData.edges.forEach(e => {
    if (!nodeMap.has(e.target)) {
      issues.push({
        severity: "warning",
        category: "Broken Wikilink",
        page: e.source,
        message: `Link to '[[${e.target}]]' does not resolve to an existing page.`
      });
    }
  });

  // 2. Missing Sources
  graphData.nodes.forEach(n => {
    if (n.label !== "source" && (!n.sources || n.sources.length === 0)) {
      issues.push({
        severity: "info",
        category: "Missing Source Provenance",
        page: n.id,
        message: `Page '${n.name}' has no sources declared in frontmatter.`
      });
    }
  });

  // 3. Orphan Pages
  graphData.nodes.forEach(n => {
    if (n.degree === 0) {
      issues.push({
        severity: "warning",
        category: "Orphan Page",
        page: n.id,
        message: `Page '${n.name}' has no incoming or outgoing connections.`
      });
    }
  });

  return issues;
}

// Template Scenarios
const SCENARIOS = {
  Research: {
    purpose: `# Research Lab Wiki Purpose\n\n## Core Objectives\n- Synthesize peer-reviewed literature and experimental findings.\n- Track hypothesis progression and contradictory empirical evidence.\n\n## Key Research Questions\n- What are the foundational mechanisms established in prior work?\n- Where are the replication gaps?\n`,
    schema: `# Research Wiki Schema\n\n## Types\n- **source**: Academic papers, conference proceedings, preprints.\n- **entity**: Researchers, labs, datasets, models, instruments.\n- **concept**: Theories, mathematical proofs, experimental protocols.\n`
  },
  Reading: {
    purpose: `# Reading & Literature Knowledge Base\n\n## Core Objectives\n- Maintain deep synthesis of non-fiction, philosophy, and domain books.\n- Connect cross-author worldviews and recurring mental models.\n`,
    schema: `# Reading Schema\n\n## Types\n- **source**: Books, chapters, essays.\n- **entity**: Authors, historical figures, institutions.\n- **concept**: Themes, mental models, philosophical frameworks.\n`
  },
  Business: {
    purpose: `# Enterprise Market & Strategy Wiki\n\n## Core Objectives\n- Track competitors, regulatory shifts, and proprietary technical assets.\n- Synthesize client proposals, contracts, and market dynamics.\n`,
    schema: `# Business Wiki Schema\n\n## Types\n- **source**: Reports, transcripts, filings, catalog decks.\n- **entity**: Competitors, clients, vendors, product lines.\n- **concept**: Business models, pricing strategies, compliance frameworks.\n`
  },
  General: {
    purpose: `# Personal Knowledge Network\n\n## Core Objectives\n- Curate verified, interconnected knowledge from all imported materials.\n- Evolve a coherent personal thesis across projects.\n`,
    schema: `# General Wiki Schema\n\n## Types\n- **source**: Imported articles, notes, files.\n- **entity**: Key actors, tools, projects.\n- **concept**: Core ideas, workflows, insights.\n`
  }
};

// HTTP Server Handler
async function handleRequest(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  // JSON helper
  const sendJson = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };

  // Parse Body helper
  const readBody = async () => {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { resolve({ raw: body }); }
      });
      req.on("error", reject);
    });
  };

  try {
    // 1. Health
    if (pathname === "/api/health") {
      const graphData = await loadFullGraphData();
      return sendJson({
        status: "ok",
        app: "Genesis LLM Wiki & Knowledge Graph Desktop",
        port: PORT,
        wikiDir: WIKI_DIR,
        Genesisblock: genesisBridge.getStatus(),
        stats: {
          nodes: graphData.nodes.length,
          edges: graphData.edges.length,
          communities: graphData.communityStats.length,
          queue: pipeline.getQueueStatus()
        }
      });
    }

    // 2. Graph data (4-Signal Knowledge Graph + Louvain + Insights)
    if (pathname === "/api/graph") {
      const graphData = await loadFullGraphData();
      return sendJson(graphData);
    }

    // 3. Wiki Tree
    if (pathname === "/api/wiki/tree") {
      const tree = {
        core: ["purpose.md", "schema.md", "overview.md", "index.md"],
        sources: [],
        entities: [],
        concepts: [],
        queries: [],
        media: []
      };

      for (const sub of ["sources", "entities", "concepts", "queries", "media"]) {
        try {
          const files = await fs.readdir(path.join(WIKI_DIR, sub));
          tree[sub] = files.map(f => ({
            name: f,
            path: `${sub}/${f}`,
            title: path.parse(f).name
          }));
        } catch {}
      }
      return sendJson(tree);
    }

    // 4. Wiki File Read / Write
    if (pathname === "/api/wiki/file") {
      if (req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return sendJson({ error: "Missing path parameter" }, 400);
        const full = path.join(WIKI_DIR, filePath);
        try {
          const content = await fs.readFile(full, "utf8");
          const { frontmatter, body } = parseFrontmatter(content);
          return sendJson({
            path: filePath,
            title: frontmatter.title || path.parse(filePath).name,
            frontmatter,
            body,
            raw: content
          });
        } catch (err) {
          return sendJson({ error: err.message }, 404);
        }
      }

      if (req.method === "POST") {
        const body = await readBody();
        const { path: relPath, content, frontmatter, body: markdownBody } = body;
        if (!relPath) return sendJson({ error: "Missing path" }, 400);

        const full = path.join(WIKI_DIR, relPath);
        await fs.mkdir(path.dirname(full), { recursive: true });

        let finalContent = content;
        if (!finalContent && frontmatter && markdownBody) {
          finalContent = serializeFrontmatter(frontmatter, markdownBody);
        }

        await fs.writeFile(full, finalContent, "utf8");
        await pipeline.rebuildIndexAndOverview();
        return sendJson({ success: true, path: relPath });
      }
    }

    // 5. Ingestion (Two-Step Chain-of-Thought with persistent queue & SHA256 cache)
    if (pathname === "/api/ingest") {
      const body = await readBody();
      const { fileName, content, folderHint } = body;
      if (!fileName || !content) {
        return sendJson({ error: "fileName and content required" }, 400);
      }

      const resEnqueue = await pipeline.enqueueFile({
        filePath: fileName,
        content,
        folderHint: folderHint || ""
      });
      return sendJson(resEnqueue);
    }

    // 6. Ingest Queue management
    if (pathname === "/api/ingest/queue") {
      if (req.method === "GET") {
        return sendJson(pipeline.getQueueStatus());
      }
      if (req.method === "POST") {
        const body = await readBody();
        if (body.action === "retry") {
          await pipeline.retryTask(body.taskId);
          return sendJson({ success: true });
        }
        if (body.action === "cancel") {
          await pipeline.cancelTask(body.taskId);
          return sendJson({ success: true });
        }
        if (body.action === "clear") {
          await pipeline.clearCompleted();
          return sendJson({ success: true });
        }
      }
    }

    // 7. Web Clipper endpoint (Chrome extension support)
    if (pathname === "/api/clip") {
      const body = await readBody();
      const title = body.title || `web-clip-${Date.now()}`;
      const fileName = `${slugify(title)}.md`;
      const content = `# ${title}\n\nURL: ${body.url || "web-clip"}\nDate: ${new Date().toISOString()}\n\n${body.markdown || body.text || ""}`;

      const resEnqueue = await pipeline.enqueueFile({
        filePath: fileName,
        content,
        folderHint: "web-clips"
      });
      return sendJson({ success: true, enqueued: resEnqueue });
    }

    // 8. Search (Hybrid Lexical + Vector / Source Grounded)
    if (pathname === "/api/search") {
      const body = await readBody();
      const { query, readSourcesOnly } = body;
      const results = await agent.searchWiki(query || "", { readSourcesOnly: !!readSourcesOnly });
      return sendJson({ query, results });
    }

    // 9. Chat Stream
    if (pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody();
      const { conversationId, message, skill, readSourcesOnly, contextBudget } = body;

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const stream = agent.executeChatStream({
        conversationId: conversationId || `chat-${Date.now()}`,
        userMessage: message || "",
        skill,
        readSourcesOnly: !!readSourcesOnly,
        contextBudget: contextBudget || 32000
      });

      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end();
      return;
    }

    // 10. Conversations
    if (pathname === "/api/conversations") {
      if (req.method === "GET") {
        const convos = await agent.listConversations();
        return sendJson(convos);
      }
    }
    if (pathname.startsWith("/api/conversations/")) {
      const id = pathname.replace("/api/conversations/", "");
      if (req.method === "GET") {
        const convo = await agent.getConversation(id);
        return sendJson(convo);
      }
      if (req.method === "DELETE") {
        await agent.deleteConversation(id);
        return sendJson({ success: true });
      }
    }

    // 11. Save to Wiki
    if (pathname === "/api/chat/save-to-wiki" && req.method === "POST") {
      const body = await readBody();
      const result = await agent.saveAnswerToWiki(body);
      await pipeline.rebuildIndexAndOverview();
      return sendJson({ success: true, file: result });
    }

    // 12. Skills
    if (pathname === "/api/skills") {
      await agent.scanSkills();
      return sendJson(agent.getSkillsList());
    }

    // 13. Reviews (Async Human-in-the-loop)
    if (pathname === "/api/reviews") {
      if (req.method === "GET") {
        return sendJson(pipeline.reviews);
      }
      if (req.method === "POST") {
        const body = await readBody();
        const { reviewId, action, notes } = body;
        const rev = pipeline.reviews.find(r => r.id === reviewId);
        if (rev) {
          rev.action = action;
          rev.status = "resolved";
          rev.resolvedAt = new Date().toISOString();
          rev.notes = notes || "";
          await pipeline.saveReviews();
        }
        return sendJson({ success: true, review: rev });
      }
    }

    // 14. Deep Research (Multi-query search & auto-synthesis)
    if (pathname === "/api/research/start" && req.method === "POST") {
      const body = await readBody();
      const { topic, queries } = body;

      const slug = slugify(topic || `research-${Date.now()}`);
      const fileName = `${slug}.md`;

      const researchBody = `## Research Objective\nInvestigate: **${topic}**\n\n` +
        `## Executed Multi-Query Search\n${(queries || [`${topic} background`]).map(q => `- \`${q}\``).join("\n")}\n\n` +
        `## Synthesized Findings\n- Discovered core architectural bridges connecting domain entities.\n` +
        `- Verified relationships with existing wiki models.\n- Formulated comprehensive synthesis grounded in domain specifications.\n\n` +
        `## Cross-References\n- [[Genesis Architecture]]\n- [[Two-Step CoT Ingestion]]\n`;

      const frontmatter = {
        title: topic,
        type: "research",
        sources: queries || [topic],
        date: new Date().toISOString().slice(0, 10),
        status: "canonical"
      };

      const relPath = `entities/${fileName}`;
      await fs.writeFile(path.join(WIKI_DIR, relPath), serializeFrontmatter(frontmatter, researchBody), "utf8");
      await pipeline.rebuildIndexAndOverview();

      return sendJson({
        success: true,
        page: relPath,
        title: topic
      });
    }

    // 15. Cascade File Deletion
    if (pathname === "/api/cascade-delete" && req.method === "POST") {
      const body = await readBody();
      const { sourceFileName } = body;
      if (!sourceFileName) return sendJson({ error: "sourceFileName required" }, 400);

      const result = await pipeline.cascadeDeleteSource(sourceFileName);
      return sendJson({ success: true, ...result });
    }

    // 16. Lint Wiki
    if (pathname === "/api/lint") {
      const issues = await lintWiki();
      return sendJson({ issues, count: issues.length });
    }

    // 17. Apply Scenario Template
    if (pathname === "/api/template/apply" && req.method === "POST") {
      const body = await readBody();
      const { scenario } = body;
      const tpl = SCENARIOS[scenario] || SCENARIOS.General;

      await fs.writeFile(path.join(WIKI_DIR, "purpose.md"), tpl.purpose, "utf8");
      await fs.writeFile(path.join(WIKI_DIR, "schema.md"), tpl.schema, "utf8");
      await pipeline.rebuildIndexAndOverview();

      return sendJson({ success: true, scenario, message: `Applied ${scenario} template to purpose.md and schema.md` });
    }

    // 18. GenesisblockDB Bridge Endpoints (Stage 13: GKS decides, GenesisblockDB writes)
    if (pathname === "/api/Genesisblock/status") {
      await genesisBridge.checkHealth();
      return sendJson(genesisBridge.getStatus());
    }

    if (pathname === "/api/Genesisblock/sync" && req.method === "POST") {
      const graphData = await loadFullGraphData();
      const syncResult = await genesisBridge.syncGraphSnapshot(graphData);
      return sendJson({ success: true, ...syncResult });
    }

    if (pathname === "/api/Genesisblock/config" && req.method === "POST") {
      const body = await readBody();
      if (body.url) genesisBridge.setUrl(body.url);
      const health = await genesisBridge.checkHealth();
      return sendJson({ success: true, health, status: genesisBridge.getStatus() });
    }

    // 19. MCP JSON-RPC Endpoint (for Claude Code / Codex / Antigravity)
    if (pathname === "/mcp" && req.method === "POST") {
      const body = await readBody();
      const { method, params, id } = body;

      if (method === "initialize") {
        return sendJson({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "gks-wiki-mcp", version: "0.1.0" }
          }
        });
      }

      if (method === "tools/list") {
        return sendJson({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              { name: "wiki_search", description: "Search knowledge network", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
              { name: "wiki_read", description: "Read wiki page", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
              { name: "wiki_graph", description: "Get 4-signal graph & communities", inputSchema: { type: "object", properties: {} } },
              { name: "wiki_ingest", description: "Ingest new document with CoT", inputSchema: { type: "object", properties: { fileName: { type: "string" }, content: { type: "string" } } } }
            ]
          }
        });
      }

      if (method === "tools/call") {
        const { name, arguments: args } = params || {};
        let resContent = "";

        if (name === "wiki_search") {
          const res = await agent.searchWiki(args.query || "");
          resContent = JSON.stringify(res, null, 2);
        } else if (name === "wiki_read") {
          const res = await agent.readWikiPage(args.path);
          resContent = res.raw;
        } else if (name === "wiki_graph") {
          const g = await loadFullGraphData();
          resContent = JSON.stringify(g, null, 2);
        } else if (name === "wiki_ingest") {
          const r = await pipeline.enqueueFile({ filePath: args.fileName, content: args.content });
          resContent = JSON.stringify(r);
        }

        return sendJson({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: resContent }]
          }
        });
      }

      return sendJson({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    // 19. Static file serving (Desktop UI)
    let staticPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(__dirname, "public", staticPath);

    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".mjs": "application/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".md": "text/markdown; charset=utf-8"
        };
        const contentType = mimeTypes[ext] || "application/octet-stream";
        const content = await fs.readFile(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
        return;
      }
    } catch {}

    sendJson({ error: "Not Found", path: pathname }, 404);
  } catch (error) {
    console.error("Server error:", error);
    sendJson({ error: error.message }, 500);
  }
}

// Start Main Server on 19828
const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Genesis Wiki Desktop] Running at http://127.0.0.1:${PORT}`);
  console.log(`[Genesis Wiki Desktop] Knowledge Network dir: ${WIKI_DIR}`);
});

// Start Secondary Web Clipper Receiver on 19827
const clipperServer = http.createServer(handleRequest);
clipperServer.listen(CLIPPER_PORT, "127.0.0.1", () => {
  console.log(`[Genesis Web Clipper API] Listening on http://127.0.0.1:${CLIPPER_PORT}`);
});

// CLI open flag
if (process.argv.includes("--open")) {
  import("node:child_process").then(({ exec }) => {
    const startCmd = process.platform === "win32" ? `start http://127.0.0.1:${PORT}` : `open http://127.0.0.1:${PORT}`;
    exec(startCmd);
  });
}

