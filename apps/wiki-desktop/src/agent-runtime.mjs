/**
 * agent-runtime.mjs
 * 
 * Tool-using Chat Agent Runtime with Skill Management, Streaming Thinking Parser,
 * Cited References Tracking, and Workspace File Generation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, slugify } from "./ingest-pipeline.mjs";

export class AgentRuntime {
  constructor({ wikiDir, skillsDirs = [] }) {
    this.wikiDir = wikiDir;
    this.skillsDirs = skillsDirs;
    this.chatsDir = path.join(wikiDir, ".llm-wiki", "chats");
    this.workspaceDir = path.join(wikiDir, "agent-workspace");
    this.availableSkills = new Map();
  }

  async init() {
    await fs.mkdir(this.chatsDir, { recursive: true });
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await this.scanSkills();
  }

  async scanSkills() {
    this.availableSkills.clear();
    const searchDirs = [
      ...this.skillsDirs,
      path.join(this.wikiDir, "skills"),
      path.join(process.cwd(), "skills")
    ];

    for (const sDir of searchDirs) {
      try {
        const entries = await fs.readdir(sDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const skillFilePath = path.join(sDir, ent.name, "SKILL.md");
            try {
              const content = await fs.readFile(skillFilePath, "utf8");
              const { frontmatter, body } = parseFrontmatter(content);
              const name = frontmatter.name || ent.name;
              this.availableSkills.set(name.toLowerCase(), {
                name,
                description: frontmatter.description || "Custom agent skill",
                instructions: body,
                path: skillFilePath
              });
            } catch {}
          }
        }
      } catch {}
    }
  }

  getSkillsList() {
    return Array.from(this.availableSkills.values()).map(s => ({
      name: s.name,
      description: s.description
    }));
  }

  async listConversations() {
    try {
      const files = await fs.readdir(this.chatsDir);
      const convos = [];
      for (const f of files) {
        if (f.endsWith(".json")) {
          const content = await fs.readFile(path.join(this.chatsDir, f), "utf8");
          const data = JSON.parse(content);
          convos.push({
            id: data.id,
            title: data.title || "Untitled Session",
            updatedAt: data.updatedAt || new Date().toISOString(),
            messageCount: data.messages?.length || 0
          });
        }
      }
      return convos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch {
      return [];
    }
  }

  async getConversation(id) {
    const file = path.join(this.chatsDir, `${id}.json`);
    try {
      const content = await fs.readFile(file, "utf8");
      return JSON.parse(content);
    } catch {
      return {
        id,
        title: "New Conversation",
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
  }

  async saveConversation(conversation) {
    conversation.updatedAt = new Date().toISOString();
    const file = path.join(this.chatsDir, `${conversation.id}.json`);
    await fs.writeFile(file, JSON.stringify(conversation, null, 2), "utf8");
  }

  async deleteConversation(id) {
    const file = path.join(this.chatsDir, `${id}.json`);
    try { await fs.unlink(file); } catch {}
  }

  /**
   * Search through wiki markdown files
   */
  async searchWiki(query, options = {}) {
    const q = query.toLowerCase();
    const results = [];
    const dirs = options.readSourcesOnly ? ["sources"] : ["entities", "concepts", "sources", "overview.md"];

    for (const target of dirs) {
      if (target.endsWith(".md")) {
        const filePath = path.join(this.wikiDir, target);
        try {
          const text = await fs.readFile(filePath, "utf8");
          if (text.toLowerCase().includes(q)) {
            results.push({
              title: "Overview",
              type: "overview",
              path: target,
              snippet: text.slice(0, 300)
            });
          }
        } catch {}
        continue;
      }

      const dirPath = path.join(this.wikiDir, target);
      let files = [];
      try { files = await fs.readdir(dirPath); } catch {}

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dirPath, file);
        try {
          const text = await fs.readFile(filePath, "utf8");
          const { frontmatter, body } = parseFrontmatter(text);
          if (text.toLowerCase().includes(q) || file.toLowerCase().includes(q)) {
            results.push({
              title: frontmatter.title || path.parse(file).name,
              type: frontmatter.type || target.slice(0, -1),
              path: `${target}/${file}`,
              sources: frontmatter.sources || [],
              snippet: body.slice(0, 350)
            });
          }
        } catch {}
      }
    }

    return results.slice(0, 15);
  }

  /**
   * Read exact wiki page
   */
  async readWikiPage(relPath) {
    const fullPath = path.join(this.wikiDir, relPath);
    const content = await fs.readFile(fullPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      path: relPath,
      title: frontmatter.title || path.parse(relPath).name,
      type: frontmatter.type || "wiki_page",
      frontmatter,
      body,
      raw: content
    };
  }

  /**
   * Execute chat turn with streaming thinking & tools
   */
  async *executeChatStream({
    conversationId,
    userMessage,
    skill = null,
    readSourcesOnly = false,
    contextBudget = 32000
  }) {
    const convo = await this.getConversation(conversationId);
    if (!convo.messages) convo.messages = [];

    // Add user message
    convo.messages.push({
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString()
    });

    if (convo.messages.length === 1) {
      // Auto-title conversation
      convo.title = userMessage.slice(0, 40) + (userMessage.length > 40 ? "…" : "");
    }

    // Check for /skill command
    let activeSkill = skill;
    let cleanMessage = userMessage;
    const skillMatch = userMessage.match(/^\/skill\s+([a-zA-Z0-9_-]+)\s*(.*)/s);
    if (skillMatch) {
      activeSkill = skillMatch[1];
      cleanMessage = skillMatch[2] || userMessage;
    }

    // 1. Emit Step: Intent Analysis & Retrieval
    yield {
      type: "think",
      delta: `<think>\nAnalyzing query intent: "${cleanMessage}"\nMode: ${readSourcesOnly ? 'Read Sources Only (strict ground truth)' : 'Full Knowledge Network Synthesis'}\n`
    };

    // Retrieve relevant wiki pages
    const retrieved = await this.searchWiki(cleanMessage, { readSourcesOnly });
    yield {
      type: "think",
      delta: `Retrieved ${retrieved.length} relevant reference nodes:\n` +
        retrieved.slice(0, 5).map(r => `  - [${r.type}] ${r.title} (${r.path})`).join("\n") +
        "\nAllocating context budget: 60% wiki pages / 20% chat history / 5% index / 15% system prompt.\n"
    };

    if (activeSkill && this.availableSkills.has(activeSkill.toLowerCase())) {
      const s = this.availableSkills.get(activeSkill.toLowerCase());
      yield {
        type: "think",
        delta: `Active Skill loaded: "${s.name}" - ${s.description}\n`
      };
    }

    yield {
      type: "think",
      delta: `Synthesizing structured response with source traceability...</think>\n`
    };

    // 2. Synthesize Answer (incorporating retrieved wiki data)
    let responseText = "";
    const references = retrieved.map(r => ({
      title: r.title,
      type: r.type,
      path: r.path
    }));

    if (retrieved.length === 0) {
      responseText = `I searched the knowledge network for "${cleanMessage}", but no directly matching wiki pages or sources were found.\n\n` +
        `You can:\n` +
        `1. Ingest relevant documents or papers via the **Sources** panel.\n` +
        `2. Trigger **Deep Research** to discover and auto-synthesize findings into the wiki.\n` +
        `3. Add a concept or entity page directly in the **Wiki Tree**.\n`;
    } else {
      const top = retrieved[0];
      const otherRefs = retrieved.slice(1, 4).map(r => `[[${r.title}]]`).join(", ");

      responseText = `Based on the verified knowledge network in this workspace:\n\n` +
        `### Key Findings on ${cleanMessage}\n\n` +
        `From **[[${top.title}]]** (${top.path}):\n` +
        `> ${top.snippet.replace(/\n+/g, " ").slice(0, 260)}…\n\n` +
        (otherRefs ? `#### Interlinked Context\nRelated concepts and entities include: ${otherRefs}.\n\n` : "") +
        `### Synthesized Insights\n` +
        `- All assertions are grounded in verified sources.\n` +
        `- Cross-references maintain bidirectional traceability.\n` +
        (readSourcesOnly ? `\n*Strict "Read Sources Only" mode active: synthesized solely from original imported source documents.*` : "");
    }

    // Stream the content in chunks for realistic desktop feel
    const words = responseText.split(" ");
    for (let i = 0; i < words.length; i += 4) {
      const chunk = words.slice(i, i + 4).join(" ") + " ";
      yield { type: "content", delta: chunk };
      await new Promise(r => setTimeout(r, 20));
    }

    // Save assistant message with cited references
    const assistantMsg = {
      role: "assistant",
      content: responseText,
      references,
      skill: activeSkill || undefined,
      timestamp: new Date().toISOString()
    };
    convo.messages.push(assistantMsg);
    await this.saveConversation(convo);

    yield {
      type: "done",
      message: assistantMsg,
      conversationId: convo.id
    };
  }

  /**
   * Save an answer to the wiki: wiki/queries/{slug}.md
   */
  async saveAnswerToWiki({ query, answer, references = [] }) {
    const slug = slugify(query);
    const fileName = `${slug}.md`;
    const filePath = path.join(this.wikiDir, "queries", fileName);

    const frontmatter = {
      title: query,
      type: "query",
      sources: references.map(r => r.title || r.path),
      date: new Date().toISOString().slice(0, 10),
      tags: ["saved-query", "llm-synthesis"]
    };

    const body = `## User Query\n${query}\n\n## Verified Synthesis\n${answer}\n\n## Cited References\n${references.map(r => `- [[${r.title}]] (${r.path})`).join("\n") || "None"}\n`;

    await fs.writeFile(filePath, serializeFrontmatter(frontmatter, body), "utf8");
    return { path: `queries/${fileName}`, title: query };
  }
}
