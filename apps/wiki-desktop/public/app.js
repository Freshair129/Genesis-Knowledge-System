/**
 * app.js
 * 
 * Genesis LLM Wiki & Knowledge Graph Desktop Client
 * Integrates 4-Signal Knowledge Graph, Louvain Communities, CoT Ingestion,
 * Multi-Conversation Chat Agent, KaTeX Math, Mermaid Diagrams, and Review Queue.
 */

(function () {
  "use strict";

  // State Management
  const state = {
    theme: localStorage.getItem("gks_theme") || "dark",
    currentFilePath: null,
    currentFileRaw: null,
    isEditing: false,
    activeConversationId: null,
    conversations: [],
    skills: [],
    graphData: { nodes: [], edges: [], communities: {}, communityStats: [], insights: {} },
    graphColorMode: "type", // 'type' or 'community'
    activeLabels: new Set(),
    selectedNodeId: null,
    hoverNodeId: null,
    queue: { isProcessing: false, total: 0, tasks: [] }
  };

  // DOM Elements
  const html = document.documentElement;
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const themeIcon = document.getElementById("themeIcon");
  const scenarioSelect = document.getElementById("scenarioSelect");
  const iconSidebar = document.getElementById("iconSidebar");
  const colNav = document.getElementById("colNav");
  const colPreview = document.getElementById("colPreview");
  const resizerLeft = document.getElementById("resizerLeft");
  const resizerRight = document.getElementById("resizerRight");
  const treeList = document.getElementById("treeList");
  const refreshTreeBtn = document.getElementById("refreshTreeBtn");
  const newPageBtn = document.getElementById("newPageBtn");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const sourcesList = document.getElementById("sourcesList");
  const refreshSourcesBtn = document.getElementById("refreshSourcesBtn");
  const panelSearchInput = document.getElementById("panelSearchInput");
  const readSourcesOnlyToggle = document.getElementById("readSourcesOnlyToggle");
  const panelSearchResults = document.getElementById("panelSearchResults");
  const globalSearchInput = document.getElementById("globalSearchInput");
  const searchDropdown = document.getElementById("searchDropdown");
  const runLintBtn = document.getElementById("runLintBtn");
  const lintStats = document.getElementById("lintStats");
  const lintList = document.getElementById("lintList");
  const refreshReviewBtn = document.getElementById("refreshReviewBtn");
  const reviewList = document.getElementById("reviewList");
  const startResearchBtn = document.getElementById("startResearchBtn");
  const researchTopicInput = document.getElementById("researchTopicInput");
  const researchQueriesInput = document.getElementById("researchQueriesInput");
  const recentResearchList = document.getElementById("recentResearchList");
  const settingContextBudget = document.getElementById("settingContextBudget");
  const contextBudgetValue = document.getElementById("contextBudgetValue");
  const exportProjectBtn = document.getElementById("exportProjectBtn");

  // Chat Elements
  const conversationsScroll = document.getElementById("conversationsScroll");
  const newChatBtn = document.getElementById("newChatBtn");
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const sendChatBtn = document.getElementById("sendChatBtn");
  const streamingIndicator = document.getElementById("streamingIndicator");
  const chatReadSourcesOnly = document.getElementById("chatReadSourcesOnly");
  const skillsAutocomplete = document.getElementById("skillsAutocomplete");
  const activeSkillBadge = document.getElementById("activeSkillBadge");

  // Preview Elements
  const tabMarkdown = document.getElementById("tabMarkdown");
  const tabGraph = document.getElementById("tabGraph");
  const tabInsights = document.getElementById("tabInsights");
  const paneMarkdown = document.getElementById("paneMarkdown");
  const paneGraph = document.getElementById("paneGraph");
  const paneInsights = document.getElementById("paneInsights");
  const editFileToggleBtn = document.getElementById("editFileToggleBtn");
  const saveFileBtn = document.getElementById("saveFileBtn");
  const deleteSourceBtn = document.getElementById("deleteSourceBtn");
  const currentFilePathEl = document.getElementById("currentFilePath");
  const frontmatterBadges = document.getElementById("frontmatterBadges");
  const markdownEditor = document.getElementById("markdownEditor");
  const markdownRendered = document.getElementById("markdownRendered");

  // Graph Elements
  const graphCanvas = document.getElementById("graphCanvas");
  const ctx = graphCanvas.getContext("2d");
  const stageWrap = document.querySelector(".canvas-stage-wrap");
  const colorByTypeBtn = document.getElementById("colorByTypeBtn");
  const colorByCommunityBtn = document.getElementById("colorByCommunityBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const fitGraphBtn = document.getElementById("fitGraphBtn");
  const nodePanel = document.getElementById("nodePanel");
  const nodePanelClose = document.getElementById("nodePanelClose");
  const nodePanelTitle = document.getElementById("nodePanelTitle");
  const nodePanelType = document.getElementById("nodePanelType");
  const nodePanelDegree = document.getElementById("nodePanelDegree");
  const nodePropsTable = document.getElementById("nodePropsTable");
  const nodeRelationsList = document.getElementById("nodeRelationsList");
  const openNodeInWikiBtn = document.getElementById("openNodeInWikiBtn");
  const surprisingList = document.getElementById("surprisingList");
  const knowledgeGapsList = document.getElementById("knowledgeGapsList");

  // Activity Drawer
  const openActivityBtn = document.getElementById("openActivityBtn");
  const activityDrawer = document.getElementById("activityDrawer");
  const closeActivityBtn = document.getElementById("closeActivityBtn");
  const activityTaskList = document.getElementById("activityTaskList");
  const queueStatusText = document.getElementById("queueStatusText");
  const queueBadge = document.getElementById("queueBadge");
  const clearQueueBtn = document.getElementById("clearQueueBtn");

  // Research Modal
  const researchModal = document.getElementById("researchModal");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const cancelModalBtn = document.getElementById("cancelModalBtn");
  const confirmResearchBtn = document.getElementById("confirmResearchBtn");
  const modalTopicInput = document.getElementById("modalTopicInput");
  const modalQueriesInput = document.getElementById("modalQueriesInput");

  // =========================================================================
  // Theme & Initialization
  // =========================================================================
  function applyTheme(theme) {
    state.theme = theme;
    html.dataset.theme = theme;
    themeIcon.textContent = theme === "dark" ? "โ€๏ธ" : "๐";
    localStorage.setItem("gks_theme", theme);
  }

  themeToggleBtn.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });
  applyTheme(state.theme);

  // Initialize Mermaid
  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: state.theme === "dark" ? "dark" : "default",
      securityLevel: "loose"
    });
  }

  // =========================================================================
  // Resizable Panels Splitters
  // =========================================================================
  function setupResizers() {
    let isDraggingLeft = false;
    let isDraggingRight = false;

    resizerLeft.addEventListener("mousedown", () => {
      isDraggingLeft = true;
      document.body.style.cursor = "col-resize";
      resizerLeft.classList.add("dragging");
    });

    resizerRight.addEventListener("mousedown", () => {
      isDraggingRight = true;
      document.body.style.cursor = "col-resize";
      resizerRight.classList.add("dragging");
    });

    window.addEventListener("mousemove", (e) => {
      if (isDraggingLeft) {
        const sidebarWidth = 54;
        const newWidth = Math.max(180, Math.min(450, e.clientX - sidebarWidth));
        colNav.style.width = `${newWidth}px`;
      }
      if (isDraggingRight) {
        const newWidth = Math.max(280, Math.min(750, window.innerWidth - e.clientX));
        colPreview.style.width = `${newWidth}px`;
        resizeCanvas();
      }
    });

    window.addEventListener("mouseup", () => {
      if (isDraggingLeft || isDraggingRight) {
        isDraggingLeft = false;
        isDraggingRight = false;
        document.body.style.cursor = "";
        resizerLeft.classList.remove("dragging");
        resizerRight.classList.remove("dragging");
        resizeCanvas();
      }
    });
  }
  setupResizers();

  // =========================================================================
  // Icon Sidebar View Switching
  // =========================================================================
  iconSidebar.querySelectorAll(".sidebar-icon").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (!view) return;

      iconSidebar.querySelectorAll(".sidebar-icon").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      if (view === "graph") {
        switchPreviewTab("graph");
        return;
      }

      // Hide all nav panels and show selected
      document.querySelectorAll(".nav-panel").forEach((p) => p.classList.remove("active"));
      const targetPanel = document.getElementById(`panel${view.charAt(0).toUpperCase() + view.slice(1)}`);
      if (targetPanel) targetPanel.classList.add("active");

      if (view === "lint") loadLint();
      if (view === "review") loadReviews();
    });
  });

  // Preview Tabs
  function switchPreviewTab(mode) {
    [tabMarkdown, tabGraph, tabInsights].forEach((t) => t.classList.remove("active"));
    [paneMarkdown, paneGraph, paneInsights].forEach((p) => p.classList.remove("active"));

    if (mode === "markdown") {
      tabMarkdown.classList.add("active");
      paneMarkdown.classList.add("active");
    } else if (mode === "graph") {
      tabGraph.classList.add("active");
      paneGraph.classList.add("active");
      resizeCanvas();
      fitView();
    } else if (mode === "insights") {
      tabInsights.classList.add("active");
      paneInsights.classList.add("active");
      loadInsights();
    }
  }

  tabMarkdown.addEventListener("click", () => switchPreviewTab("markdown"));
  tabGraph.addEventListener("click", () => switchPreviewTab("graph"));
  tabInsights.addEventListener("click", () => switchPreviewTab("insights"));
  document.getElementById("toggleGraphLayoutBtn").addEventListener("click", () => switchPreviewTab("graph"));

  // =========================================================================
  // Knowledge Tree & Markdown Editor
  // =========================================================================
  async function loadKnowledgeTree() {
    try {
      const res = await fetch("/api/wiki/tree");
      const tree = await res.json();
      treeList.innerHTML = "";

      // 1. Core Pages (purpose, schema, overview, index)
      const coreGroup = document.createElement("div");
      coreGroup.className = "tree-group";
      coreGroup.innerHTML = `<div class="tree-group-title"><span>๐</span> Core Wiki Architecture</div>`;
      (tree.core || []).forEach((file) => {
        const item = document.createElement("div");
        item.className = `tree-item ${state.currentFilePath === file ? "active" : ""}`;
        item.innerHTML = `<span>๐“</span> <span>${file}</span>`;
        item.addEventListener("click", () => loadWikiFile(file));
        coreGroup.appendChild(item);
      });
      treeList.appendChild(coreGroup);

      // 2. Dynamic Categories
      const categories = [
        { key: "entities", label: "Entities", icon: "๐”ท" },
        { key: "concepts", label: "Concepts", icon: "๐’ก" },
        { key: "sources", label: "Sources", icon: "๐“‘" },
        { key: "queries", label: "Saved Syntheses", icon: "๐’ฌ" }
      ];

      categories.forEach((cat) => {
        const group = document.createElement("div");
        group.className = "tree-group";
        const count = (tree[cat.key] || []).length;
        group.innerHTML = `<div class="tree-group-title"><span>${cat.icon}</span> ${cat.label} <span class="tree-badge">${count}</span></div>`;

        (tree[cat.key] || []).forEach((node) => {
          const item = document.createElement("div");
          item.className = `tree-item ${state.currentFilePath === node.path ? "active" : ""}`;
          item.innerHTML = `<span>${cat.icon}</span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${node.title}</span>`;
          item.addEventListener("click", () => loadWikiFile(node.path));
          group.appendChild(item);
        });

        treeList.appendChild(group);
      });
    } catch (e) {
      console.error("Error loading tree:", e);
    }
  }

  async function loadWikiFile(relPath) {
    try {
      const res = await fetch(`/api/wiki/file?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) throw new Error("Could not load file");
      const data = await res.json();

      state.currentFilePath = relPath;
      state.currentFileRaw = data.raw;
      currentFilePathEl.textContent = relPath;

      // Frontmatter badges
      frontmatterBadges.innerHTML = "";
      if (data.frontmatter) {
        if (data.frontmatter.type) {
          frontmatterBadges.innerHTML += `<span class="badge" style="background:var(--accent-primary);color:#fff">${data.frontmatter.type}</span>`;
        }
        if (Array.isArray(data.frontmatter.sources)) {
          data.frontmatter.sources.forEach((s) => {
            frontmatterBadges.innerHTML += `<span class="badge" title="Source Traceability">๐”— ${s}</span>`;
          });
        }
      }

      // Show cascade delete button if it's a source file
      deleteSourceBtn.style.display = relPath.startsWith("sources/") ? "inline-block" : "none";

      // Render Markdown
      markdownEditor.value = data.raw;
      renderMarkdownView(data.body);

      // Ensure Markdown tab active
      switchPreviewTab("markdown");
      loadKnowledgeTree();
    } catch (e) {
      console.error(e);
    }
  }

  function renderMarkdownView(body) {
    // Process [[wikilinks]]
    let htmlContent = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
      const display = alias || target;
      return `<a class="wikilink" data-target="${target}">${display}</a>`;
    });

    // Basic markdown to HTML conversion
    htmlContent = htmlContent
      .replace(/^### (.*$)/gim, "<h3>$1</h3>")
      .replace(/^## (.*$)/gim, "<h2>$1</h2>")
      .replace(/^# (.*$)/gim, "<h1>$1</h1>")
      .replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>")
      .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/gim, "<em>$1</em>")
      .replace(/`([^`]+)`/gim, "<code>$1</code>")
      .replace(/\n\n/gim, "<p></p>");

    markdownRendered.innerHTML = htmlContent;

    // Attach click listener to wikilinks
    markdownRendered.querySelectorAll(".wikilink").forEach((link) => {
      link.addEventListener("click", () => {
        const target = link.dataset.target;
        findAndOpenWikiPage(target);
      });
    });

    // Render KaTeX Math
    if (window.katex) {
      try {
        const mathMatches = markdownRendered.innerHTML.match(/\$\$([^\$]+)\$\$/g);
        if (mathMatches) {
          mathMatches.forEach((m) => {
            const raw = m.slice(2, -2);
            const rendered = window.katex.renderToString(raw, { displayMode: true, throwOnError: false });
            markdownRendered.innerHTML = markdownRendered.innerHTML.replace(m, rendered);
          });
        }
        const inlineMath = markdownRendered.innerHTML.match(/\$([^\$]+)\$/g);
        if (inlineMath) {
          inlineMath.forEach((m) => {
            const raw = m.slice(1, -1);
            const rendered = window.katex.renderToString(raw, { displayMode: false, throwOnError: false });
            markdownRendered.innerHTML = markdownRendered.innerHTML.replace(m, rendered);
          });
        }
      } catch (e) {
        console.warn("KaTeX error:", e);
      }
    }

    // Render Mermaid diagrams
    if (window.mermaid) {
      try {
        window.mermaid.run({ nodes: markdownRendered.querySelectorAll(".mermaid") });
      } catch (err) {
        console.warn("Mermaid error captured:", err);
      }
    }
  }

  async function findAndOpenWikiPage(pageName) {
    const slug = pageName.toLowerCase().replace(/\s+/g, "-");
    const candidates = [
      `entities/${slug}.md`,
      `concepts/${slug}.md`,
      `sources/${slug}.md`,
      `queries/${slug}.md`
    ];
    for (const p of candidates) {
      try {
        const r = await fetch(`/api/wiki/file?path=${encodeURIComponent(p)}`);
        if (r.ok) {
          loadWikiFile(p);
          return;
        }
      } catch {}
    }
    // Search fallback
    searchWikiAndOpen(pageName);
  }

  async function searchWikiAndOpen(query) {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      loadWikiFile(data.results[0].path);
    } else {
      alert(`Wiki page '[[${query}]]' does not exist yet.`);
    }
  }

  // Toggle Edit / Preview
  editFileToggleBtn.addEventListener("click", () => {
    state.isEditing = !state.isEditing;
    if (state.isEditing) {
      markdownEditor.style.display = "block";
      markdownRendered.style.display = "none";
      editFileToggleBtn.textContent = "๐‘๏ธ";
    } else {
      markdownEditor.style.display = "none";
      markdownRendered.style.display = "block";
      editFileToggleBtn.textContent = "โ๏ธ";
      renderMarkdownView(markdownEditor.value);
    }
  });

  // Save File
  saveFileBtn.addEventListener("click", async () => {
    if (!state.currentFilePath) return;
    try {
      const res = await fetch("/api/wiki/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: state.currentFilePath,
          content: markdownEditor.value
        })
      });
      if (res.ok) {
        alert("File saved successfully!");
        loadWikiFile(state.currentFilePath);
        refreshGraph();
      }
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
  });

  // Delete Source with Cascade Cleanup
  deleteSourceBtn.addEventListener("click", async () => {
    if (!state.currentFilePath) return;
    const fileName = state.currentFilePath.replace("sources/", "");
    if (!confirm(`Are you sure you want to delete '${fileName}'?\nThis will trigger Cascade Cleanup: removing summary, scrubbing dead [[wikilinks]], and updating shared entity provenance.`)) return;

    try {
      const res = await fetch("/api/cascade-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFileName: fileName })
      });
      const data = await res.json();
      alert(`Cascade Cleanup Complete!\nDeleted ${data.deletedFiles.length} files, updated ${data.updatedFiles.length} files.`);
      state.currentFilePath = null;
      loadKnowledgeTree();
      refreshGraph();
      switchPreviewTab("graph");
    } catch (e) {
      alert("Cascade delete error: " + e.message);
    }
  });

  // New Page Prompt
  newPageBtn.addEventListener("click", async () => {
    const title = prompt("Enter new page title:");
    if (!title) return;
    const type = prompt("Select page type (entity / concept / source):", "entity") || "entity";
    const slug = title.toLowerCase().replace(/\s+/g, "-");
    const sub = type === "concept" ? "concepts" : (type === "source" ? "sources" : "entities");
    const filePath = `${sub}/${slug}.md`;

    const templateContent = `---\ntitle: "${title}"\ntype: "${type}"\nsources: []\nstatus: "canonical"\n---\n\n# ${title}\n\n## Overview\nAdd verified notes with [[wikilinks]] here.\n`;

    await fetch("/api/wiki/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: templateContent })
    });
    loadKnowledgeTree();
    loadWikiFile(filePath);
  });

  refreshTreeBtn.addEventListener("click", loadKnowledgeTree);

  // =========================================================================
  // Drag-and-Drop Ingestion (Two-Step CoT Pipeline)
  // =========================================================================
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      try {
        await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            content: text,
            folderHint: "user-upload"
          })
        });
      } catch (e) {
        console.error("Ingest error:", e);
      }
    }
    openActivityDrawer();
    pollQueueStatus();
  }

  // Poll Ingest Queue
  async function pollQueueStatus() {
    try {
      const res = await fetch("/api/ingest/queue");
      const q = await res.json();
      state.queue = q;

      // Update badge
      const activeCount = q.pending + q.processing;
      queueBadge.textContent = activeCount;
      queueBadge.style.display = activeCount > 0 ? "inline-block" : "none";
      queueStatusText.textContent = q.isProcessing ? `Processing (${activeCount} left)` : "Idle";

      // Render Task List in Activity Drawer
      activityTaskList.innerHTML = "";
      if (q.tasks.length === 0) {
        activityTaskList.innerHTML = `<div class="empty-queue-msg">No active tasks in queue.</div>`;
      } else {
        q.tasks.forEach((t) => {
          const card = document.createElement("div");
          card.className = "task-card";
          card.innerHTML = `
            <span style="font-size:1.1rem">${t.status === "done" ? "โ…" : (t.status === "failed" ? "โ" : "โณ")}</span>
            <div style="flex:1">
              <div style="display:flex;justify-content:space-between">
                <strong>${t.fileName}</strong>
                <small>${t.step || t.status}</small>
              </div>
              <div class="task-progress-bar" style="margin-top:4px">
                <div class="task-progress-fill" style="width:${t.progress}%"></div>
              </div>
            </div>
            ${t.status === "failed" ? `<button class="btn-xs" onclick="retryTask('${t.id}')">Retry</button>` : ""}
          `;
          activityTaskList.appendChild(card);
        });
      }

      if (q.isProcessing || q.pending > 0) {
        setTimeout(pollQueueStatus, 1000);
      } else {
        loadKnowledgeTree();
        refreshGraph();
      }
    } catch {}
  }
  setInterval(pollQueueStatus, 5000);
  pollQueueStatus();

  // Activity Drawer Toggle
  function openActivityDrawer() { activityDrawer.dataset.open = "true"; }
  function closeActivityDrawer() { activityDrawer.dataset.open = "false"; }
  openActivityBtn.addEventListener("click", openActivityDrawer);
  closeActivityBtn.addEventListener("click", closeActivityDrawer);
  clearQueueBtn.addEventListener("click", async () => {
    await fetch("/api/ingest/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" })
    });
    pollQueueStatus();
  });

  // =========================================================================
  // 4-Signal Knowledge Graph (Elevated Canvas Physics from graph-viewer.html)
  // =========================================================================
  let simNodes = new Map();
  let simEdges = [];
  let cam = { x: 0, y: 0, k: 1 };
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let alpha = 1;
  let dragNode = null, panning = false, panStart = null, camStart = null;

  const LABEL_COLORS = {
    entity: "#3b82f6",
    concept: "#8b5cf6",
    source: "#10b981",
    query: "#f59e0b",
    research: "#06b6d4",
    overview: "#ec4899"
  };

  const COMMUNITY_COLORS = [
    "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#06b6d4",
    "#f97316", "#14b8a6", "#6366f1", "#84cc16", "#a855f7", "#ef4444"
  ];

  function resizeCanvas() {
    if (!stageWrap) return;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = stageWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    graphCanvas.width = rect.width * dpr;
    graphCanvas.height = rect.height * dpr;
    graphCanvas.style.width = rect.width + "px";
    graphCanvas.style.height = rect.height + "px";
  }
  window.addEventListener("resize", resizeCanvas);

  function worldToScreen(x, y) {
    const rect = stageWrap.getBoundingClientRect();
    return [(x - cam.x) * cam.k + rect.width / 2, (y - cam.y) * cam.k + rect.height / 2];
  }
  function screenToWorld(sx, sy) {
    const rect = stageWrap.getBoundingClientRect();
    return [(sx - rect.width / 2) / cam.k + cam.x, (sy - rect.height / 2) / cam.k + cam.y];
  }

  async function refreshGraph() {
    try {
      const res = await fetch("/api/graph");
      const data = await res.json();
      state.graphData = data;
      rebuildSim(true);
      renderInsights();
    } catch (e) {
      console.error("Error fetching graph data:", e);
    }
  }

  function rebuildSim(preserveExisting) {
    const prev = simNodes;
    simNodes = new Map();
    const nodes = state.graphData.nodes || [];
    const n = nodes.length;

    nodes.forEach((node, i) => {
      const old = preserveExisting && prev.get(node.id);
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      const rad = 50 + Math.sqrt(i) * 26;
      simNodes.set(node.id, old || {
        id: node.id,
        x: Math.cos(angle) * rad,
        y: Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        r: 5 + Math.min(8, Math.sqrt(node.degree || 1) * 2),
        fixed: false
      });
    });

    simEdges = [];
    (state.graphData.edges || []).forEach((e) => {
      if (simNodes.has(e.source) && simNodes.has(e.target)) {
        simEdges.push({ a: e.source, b: e.target, edge: e });
      }
    });

    alpha = 1;
  }

  function tick() {
    if (alpha <= 0.002) return;
    const arr = Array.from(simNodes.values());
    const n = arr.length;
    const REPEL = 1100;

    for (let i = 0; i < n; i++) {
      const a = arr[i];
      if (a.fixed) continue;
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = arr[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 80000) continue;
        const d = Math.sqrt(d2);
        const f = REPEL / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      fx += -a.x * 0.005;
      fy += -a.y * 0.005;
      a.vx = (a.vx + fx * alpha) * 0.82;
      a.vy = (a.vy + fy * alpha) * 0.82;
    }

    simEdges.forEach((e) => {
      const a = simNodes.get(e.a), b = simNodes.get(e.b);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 85;
      const f = (d - target) * 0.022 * alpha;
      const ux = dx / d, uy = dy / d;
      if (!a.fixed) { a.vx += ux * f; a.vy += uy * f; }
      if (!b.fixed) { b.vx -= ux * f; b.vy -= uy * f; }
    });

    arr.forEach((a) => {
      if (a.fixed) return;
      a.x += a.vx;
      a.y += a.vy;
    });

    alpha *= 0.985;
  }

  function draw() {
    if (!stageWrap || !ctx) return;
    const rect = stageWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const isDark = state.theme === "dark";
    const textMain = isDark ? "#f8fafc" : "#0f172a";
    const nodeMap = new Map((state.graphData.nodes || []).map((n) => [n.id, n]));

    // Draw 4-Signal Edges
    simEdges.forEach((e) => {
      const a = simNodes.get(e.a), b = simNodes.get(e.b);
      if (!a || !b) return;
      const [ax, ay] = worldToScreen(a.x, a.y);
      const [bx, by] = worldToScreen(b.x, b.y);

      const touches = state.selectedNodeId && (e.a === state.selectedNodeId || e.b === state.selectedNodeId);
      const weight = e.edge.weight || 1.0;

      ctx.lineWidth = Math.min(4, Math.max(1, weight * 0.7));
      if (touches) {
        ctx.strokeStyle = "var(--accent-primary, #38bdf8)";
        ctx.globalAlpha = 0.9;
      } else {
        ctx.strokeStyle = weight >= 3.0 ? (isDark ? "#34d399" : "#10b981") : (isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)");
        ctx.globalAlpha = state.selectedNodeId ? 0.2 : Math.min(0.8, 0.3 + weight * 0.1);
      }

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    });

    // Draw Nodes
    simNodes.forEach((node) => {
      const data = nodeMap.get(node.id);
      if (!data) return;
      const [sx, sy] = worldToScreen(node.x, node.y);
      const isFocus = node.id === state.selectedNodeId || node.id === state.hoverNodeId;
      const r = node.r * Math.max(0.7, Math.min(1.5, cam.k));

      let color = LABEL_COLORS[data.label] || "#64748b";
      if (state.graphColorMode === "community") {
        color = COMMUNITY_COLORS[(data.community || 0) % COMMUNITY_COLORS.length];
      }

      ctx.globalAlpha = state.selectedNodeId && !isFocus ? 0.28 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (isFocus) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = textMain;
        ctx.stroke();
      }

      // Label
      const showLabel = isFocus || cam.k > 1.2 || (data.degree || 0) >= 3;
      if (showLabel) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = textMain;
        ctx.font = `${isFocus ? "700" : "500"} ${Math.max(10, 11 * Math.min(1.4, cam.k))}px var(--font-sans)`;
        ctx.textBaseline = "middle";
        ctx.fillText(data.name.slice(0, 22), sx + r + 5, sy);
      }
    });

    ctx.restore();
  }

  function loop() {
    tick();
    draw();
    requestAnimationFrame(loop);
  }

  function fitView() {
    const arr = Array.from(simNodes.values());
    if (!arr.length) { cam = { x: 0, y: 0, k: 1 }; return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    arr.forEach((n) => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    const rect = stageWrap.getBoundingClientRect();
    const w = Math.max(80, maxX - minX), h = Math.max(80, maxY - minY);
    const k = Math.min(rect.width / (w * 1.3), rect.height / (h * 1.3), 2.2);
    cam = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k: Math.max(0.15, k) };
  }

  // Pointer interactions
  function nodeAtScreen(sx, sy) {
    const [wx, wy] = screenToWorld(sx, sy);
    let best = null, bestD = Infinity;
    simNodes.forEach((n) => {
      const dx = n.x - wx, dy = n.y - wy;
      const d = dx * dx + dy * dy;
      const hitR = n.r + 8 / cam.k;
      if (d < hitR * hitR && d < bestD) { bestD = d; best = n; }
    });
    return best;
  }

  graphCanvas.addEventListener("pointerdown", (ev) => {
    graphCanvas.setPointerCapture(ev.pointerId);
    const rect = graphCanvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const hit = nodeAtScreen(sx, sy);
    if (hit) {
      dragNode = hit;
      hit.fixed = true;
    } else {
      panning = true;
      panStart = [ev.clientX, ev.clientY];
      camStart = { ...cam };
    }
  });

  graphCanvas.addEventListener("pointermove", (ev) => {
    const rect = graphCanvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    if (dragNode) {
      const [wx, wy] = screenToWorld(sx, sy);
      dragNode.x = wx; dragNode.y = wy; dragNode.vx = 0; dragNode.vy = 0;
      alpha = Math.max(alpha, 0.3);
    } else if (panning) {
      cam.x = camStart.x - (ev.clientX - panStart[0]) / cam.k;
      cam.y = camStart.y - (ev.clientY - panStart[1]) / cam.k;
    } else {
      const hit = nodeAtScreen(sx, sy);
      state.hoverNodeId = hit ? hit.id : null;
      graphCanvas.style.cursor = hit ? "pointer" : "grab";
    }
  });

  window.addEventListener("pointerup", () => {
    if (dragNode) dragNode.fixed = false;
    dragNode = null;
    panning = false;
  });

  graphCanvas.addEventListener("click", (ev) => {
    const rect = graphCanvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const hit = nodeAtScreen(sx, sy);
    if (hit) {
      selectGraphNode(hit.id);
    } else {
      state.selectedNodeId = null;
      nodePanel.dataset.open = "false";
    }
  });

  graphCanvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = graphCanvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    const factor = Math.exp(-ev.deltaY * 0.0012);
    cam.k = Math.min(5, Math.max(0.1, cam.k * factor));
    const [wx2, wy2] = screenToWorld(sx, sy);
    cam.x += (wx - wx2);
    cam.y += (wy - wy2);
  }, { passive: false });

  zoomInBtn.addEventListener("click", () => { cam.k = Math.min(5, cam.k * 1.3); });
  zoomOutBtn.addEventListener("click", () => { cam.k = Math.max(0.1, cam.k / 1.3); });
  fitGraphBtn.addEventListener("click", fitView);

  colorByTypeBtn.addEventListener("click", () => {
    state.graphColorMode = "type";
    colorByTypeBtn.classList.add("active");
    colorByCommunityBtn.classList.remove("active");
  });

  colorByCommunityBtn.addEventListener("click", () => {
    state.graphColorMode = "community";
    colorByCommunityBtn.classList.add("active");
    colorByTypeBtn.classList.remove("active");
  });

  function selectGraphNode(id) {
    state.selectedNodeId = id;
    const node = state.graphData.nodes.find((n) => n.id === id);
    if (!node) return;

    nodePanel.dataset.open = "true";
    nodePanelTitle.textContent = node.name;
    nodePanelType.textContent = node.label;
    nodePanelDegree.textContent = `Degree: ${node.degree || 0}`;
    nodePanelStatus.textContent = node.status.toUpperCase();

    // Fill properties
    nodePropsTable.innerHTML = "";
    Object.entries(node.props || {}).forEach(([k, v]) => {
      if (!v || typeof v === "object") return;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
      nodePropsTable.appendChild(tr);
    });

    // Fill relations with 4-signal scores
    nodeRelationsList.innerHTML = "";
    const connectedEdges = (state.graphData.edges || []).filter((e) => e.source === id || e.target === id);
    connectedEdges.forEach((e) => {
      const otherId = e.source === id ? e.target : e.source;
      const otherNode = state.graphData.nodes.find((n) => n.id === otherId);
      if (!otherNode) return;

      const item = document.createElement("div");
      item.className = "relation-item";
      item.innerHTML = `
        <span><strong>${otherNode.name}</strong> <small>(${otherNode.label})</small></span>
        <span style="font-family:var(--font-mono);font-size:0.7rem;color:var(--accent-primary)">w: ${e.weight}</span>
      `;
      item.addEventListener("click", () => selectGraphNode(otherId));
      nodeRelationsList.appendChild(item);
    });

    openNodeInWikiBtn.onclick = () => {
      findAndOpenWikiPage(node.name);
    };
  }

  nodePanelClose.addEventListener("click", () => {
    nodePanel.dataset.open = "false";
    state.selectedNodeId = null;
  });

  // =========================================================================
  // Graph Insights & Deep Research
  // =========================================================================
  function renderInsights() {
    const ins = state.graphData.insights || {};
    surprisingList.innerHTML = "";
    knowledgeGapsList.innerHTML = "";

    // Surprising connections
    (ins.surprisingConnections || []).slice(0, 8).forEach((sc) => {
      const card = document.createElement("div");
      card.className = "insight-card";
      card.innerHTML = `
        <div class="insight-header">
          <span class="insight-title">${sc.sourceName} โ” ${sc.targetName}</span>
          <span class="insight-score">Surprise ${sc.surpriseScore}</span>
        </div>
        <div class="insight-desc">${sc.reasons.join(" ยท ")}</div>
        <button class="btn-xs" onclick="highlightGraphPair('${sc.source}', '${sc.target}')">Highlight on Graph</button>
      `;
      surprisingList.appendChild(card);
    });

    // Knowledge gaps
    (ins.knowledgeGaps || []).slice(0, 8).forEach((kg) => {
      const card = document.createElement("div");
      card.className = "insight-card";
      card.innerHTML = `
        <div class="insight-header">
          <span class="insight-title">${kg.title}</span>
          <span class="badge" style="background:rgba(244,63,94,0.15);color:var(--accent-rose)">${kg.type}</span>
        </div>
        <div class="insight-desc">${kg.description}</div>
        <button class="btn primary-btn btn-sm" onclick="triggerDeepResearchModal('${kg.suggestedTopic}', '${(kg.suggestedQueries || []).join("\\n")}')">Launch Deep Research</button>
      `;
      knowledgeGapsList.appendChild(card);
    });
  }

  window.highlightGraphPair = function (s, t) {
    switchPreviewTab("graph");
    selectGraphNode(s);
  };

  window.triggerDeepResearchModal = function (topic, queries) {
    modalTopicInput.value = topic;
    modalQueriesInput.value = queries;
    researchModal.style.display = "flex";
  };

  closeModalBtn.addEventListener("click", () => { researchModal.style.display = "none"; });
  cancelModalBtn.addEventListener("click", () => { researchModal.style.display = "none"; });

  confirmResearchBtn.addEventListener("click", async () => {
    const topic = modalTopicInput.value.trim();
    const queries = modalQueriesInput.value.split("\n").map((q) => q.trim()).filter(Boolean);
    researchModal.style.display = "none";

    try {
      const res = await fetch("/api/research/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, queries })
      });
      const data = await res.json();
      alert(`Deep Research synthesis complete! Page generated: ${data.page}`);
      loadKnowledgeTree();
      loadWikiFile(data.page);
      refreshGraph();
    } catch (e) {
      alert("Deep research error: " + e.message);
    }
  });

  startResearchBtn.addEventListener("click", () => {
    const topic = researchTopicInput.value.trim();
    if (!topic) return alert("Please enter a research topic");
    window.triggerDeepResearchModal(topic, researchQueriesInput.value);
  });

  // =========================================================================
  // Multi-Conversation Chat Agent & /skill Completion
  // =========================================================================
  async function loadConversations() {
    try {
      const res = await fetch("/api/conversations");
      const list = await res.json();
      state.conversations = list;
      renderConversationTabs();

      if (!state.activeConversationId && list.length > 0) {
        selectConversation(list[0].id);
      } else if (!state.activeConversationId) {
        startNewConversation();
      }
    } catch {}
  }

  function renderConversationTabs() {
    conversationsScroll.innerHTML = "";
    state.conversations.forEach((c) => {
      const pill = document.createElement("div");
      pill.className = `chat-tab-pill ${c.id === state.activeConversationId ? "active" : ""}`;
      pill.innerHTML = `<span>๐’ฌ ${c.title || "Session"}</span>`;
      pill.addEventListener("click", () => selectConversation(c.id));
      conversationsScroll.appendChild(pill);
    });
  }

  async function selectConversation(id) {
    state.activeConversationId = id;
    renderConversationTabs();
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      renderChatMessages(data.messages || []);
    } catch {}
  }

  function startNewConversation() {
    const newId = `chat-${Date.now()}`;
    state.activeConversationId = newId;
    state.conversations.unshift({ id: newId, title: "New Session", messageCount: 0 });
    renderConversationTabs();
    renderChatMessages([]);
  }
  newChatBtn.addEventListener("click", startNewConversation);

  function renderChatMessages(messages) {
    chatMessages.innerHTML = "";
    if (!messages || messages.length === 0) {
      chatMessages.innerHTML = `
        <div class="welcome-card">
          <h3>Welcome to Genesis LLM Wiki</h3>
          <p>Unlike traditional RAG which answers from scratch, this system incrementally builds a persistent, interlinked wiki network from your documents.</p>
          <div class="shortcut-tags">
            <span class="tag">Two-Step CoT Ingest</span>
            <span class="tag">4-Signal Relevance Graph</span>
            <span class="tag">Louvain Clusters</span>
            <span class="tag">/skill System</span>
            <span class="tag">Mermaid & Math</span>
          </div>
        </div>
      `;
      return;
    }

    messages.forEach((msg) => {
      appendChatMessageUI(msg);
    });
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendChatMessageUI(msg) {
    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${msg.role}`;

    let thinkingHtml = "";
    let cleanContent = msg.content;

    // Check for <think> blocks
    const thinkMatch = msg.content.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      cleanContent = msg.content.replace(/<think>[\s\S]*?<\/think>/, "").trim();
      thinkingHtml = `
        <div class="think-block">
          <div class="think-summary" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
            ๐ง  Reasoning Chain (click to toggle)
          </div>
          <div class="think-body" style="display:none">${thinkMatch[1].trim()}</div>
        </div>
      `;
    }

    // Cited references
    let refsHtml = "";
    if (msg.references && msg.references.length > 0) {
      refsHtml = `
        <div class="references-card">
          <small style="color:var(--text-muted);font-weight:600">Grounded References:</small><br/>
          ${msg.references.map((r) => `<span class="ref-pill" onclick="findAndOpenWikiPage('${r.title}')">๐“ ${r.title}</span>`).join("")}
        </div>
      `;
    }

    const saveBtnHtml = msg.role === "assistant" ? `
      <button class="save-wiki-btn" onclick="saveAnswerToWiki('${encodeURIComponent(cleanContent)}')">
        ๐’พ Save to Wiki (/queries)
      </button>
    ` : "";

    bubble.innerHTML = `
      <div class="msg-header">
        <strong>${msg.role === "user" ? "You" : "Genesis Agent"}</strong>
        <small>${new Date(msg.timestamp || Date.now()).toLocaleTimeString()}</small>
      </div>
      <div class="msg-content">
        ${thinkingHtml}
        <div>${cleanContent.replace(/\n/g, "<br/>")}</div>
        ${refsHtml}
        ${saveBtnHtml}
      </div>
    `;

    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  window.saveAnswerToWiki = async function (encodedContent) {
    const text = decodeURIComponent(encodedContent);
    const query = prompt("Enter query title for the wiki page:", "Synthesis on " + text.slice(0, 30));
    if (!query) return;

    try {
      const res = await fetch("/api/chat/save-to-wiki", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, answer: text })
      });
      const data = await res.json();
      alert(`Answer saved to wiki: ${data.file.path}!`);
      loadKnowledgeTree();
      loadWikiFile(data.file.path);
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
  };

  // Send Message with Streaming SSE
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";

    // Append user message immediately
    appendChatMessageUI({
      role: "user",
      content: text,
      timestamp: new Date().toISOString()
    });

    streamingIndicator.style.display = "flex";

    // Setup assistant placeholder
    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message-bubble assistant";
    assistantBubble.innerHTML = `
      <div class="msg-header"><strong>Genesis Agent</strong></div>
      <div class="msg-content">
        <div class="think-block" style="display:none">
          <div class="think-summary">๐ง  Reasoning Chain</div>
          <div class="think-body"></div>
        </div>
        <div class="answer-text"></div>
        <div class="references-card" style="display:none"></div>
      </div>
    `;
    chatMessages.appendChild(assistantBubble);

    const thinkBlock = assistantBubble.querySelector(".think-block");
    const thinkBody = assistantBubble.querySelector(".think-body");
    const answerText = assistantBubble.querySelector(".answer-text");
    const refCard = assistantBubble.querySelector(".references-card");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: state.activeConversationId,
          message: text,
          readSourcesOnly: chatReadSourcesOnly.checked,
          contextBudget: parseInt(settingContextBudget.value, 10)
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          try {
            const ev = JSON.parse(jsonStr);
            if (ev.type === "think") {
              thinkBlock.style.display = "block";
              thinkBody.textContent += ev.delta.replace(/<\/?think>/g, "");
            } else if (ev.type === "content") {
              answerText.innerHTML += ev.delta.replace(/\n/g, "<br/>");
            } else if (ev.type === "done") {
              if (ev.message.references && ev.message.references.length > 0) {
                refCard.style.display = "block";
                refCard.innerHTML = `<small style="color:var(--text-muted);font-weight:600">Grounded References:</small><br/>` +
                  ev.message.references.map((r) => `<span class="ref-pill" onclick="findAndOpenWikiPage('${r.title}')">๐“ ${r.title}</span>`).join("");
              }
            }
          } catch {}
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    } catch (e) {
      answerText.textContent = `Error during agent execution: ${e.message}`;
    } finally {
      streamingIndicator.style.display = "none";
      loadConversations();
    }
  }

  sendChatBtn.addEventListener("click", sendMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // /skill Autocompletion
  async function loadSkills() {
    try {
      const res = await fetch("/api/skills");
      state.skills = await res.json();
    } catch {}
  }
  loadSkills();

  chatInput.addEventListener("input", () => {
    const val = chatInput.value;
    if (val.startsWith("/skill")) {
      const query = val.slice(6).trim().toLowerCase();
      const matches = state.skills.filter((s) => s.name.toLowerCase().includes(query));
      if (matches.length > 0) {
        skillsAutocomplete.innerHTML = matches.map((m) => `
          <div class="skill-opt" onclick="insertSkill('${m.name}')">
            <strong>/${m.name}</strong> - <small>${m.description}</small>
          </div>
        `).join("");
        skillsAutocomplete.style.display = "block";
        return;
      }
    }
    skillsAutocomplete.style.display = "none";
  });

  window.insertSkill = function (name) {
    chatInput.value = `/skill ${name} `;
    skillsAutocomplete.style.display = "none";
    chatInput.focus();
  };

  // =========================================================================
  // Wiki Health & Lint
  // =========================================================================
  async function loadLint() {
    try {
      const res = await fetch("/api/lint");
      const data = await res.json();
      lintStats.textContent = `Found ${data.count} health issues across wiki network.`;
      lintList.innerHTML = "";
      (data.issues || []).forEach((iss) => {
        const item = document.createElement("div");
        item.className = "insight-card";
        item.style.borderLeft = `3px solid ${iss.severity === "warning" ? "var(--accent-amber)" : "var(--accent-primary)"}`;
        item.innerHTML = `
          <strong>[${iss.category}]</strong> <small>${iss.page}</small>
          <div class="insight-desc">${iss.message}</div>
        `;
        lintList.appendChild(item);
      });
    } catch {}
  }
  runLintBtn.addEventListener("click", loadLint);

  // =========================================================================
  // Review Queue (Async Human-in-the-Loop)
  // =========================================================================
  async function loadReviews() {
    try {
      const res = await fetch("/api/reviews");
      const list = await res.json();
      reviewList.innerHTML = "";
      if (list.length === 0) {
        reviewList.innerHTML = `<p style="font-size:0.75rem;color:var(--text-muted)">No items currently requiring human review.</p>`;
        return;
      }
      list.forEach((r) => {
        const item = document.createElement("div");
        item.className = "insight-card";
        item.innerHTML = `
          <div class="insight-header">
            <strong>${r.claim}</strong>
            <span class="badge">${r.status}</span>
          </div>
          <div class="insight-desc">Source: ${r.source} ยท Reason: ${r.reason}</div>
          <div style="display:flex;gap:0.3rem;margin-top:0.4rem">
            <button class="btn-xs" onclick="resolveReview('${r.id}', 'Create Page')">Create Page</button>
            <button class="btn-xs" onclick="resolveReview('${r.id}', 'Deep Research')">Deep Research</button>
            <button class="btn-xs" onclick="resolveReview('${r.id}', 'Skip')">Skip</button>
          </div>
        `;
        reviewList.appendChild(item);
      });
    } catch {}
  }
  refreshReviewBtn.addEventListener("click", loadReviews);

  window.resolveReview = async function (reviewId, action) {
    await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewId, action })
    });
    loadReviews();
  };

  // =========================================================================
  // Scenario Template Selection
  // =========================================================================
  scenarioSelect.addEventListener("change", async () => {
    const scenario = scenarioSelect.value;
    if (!confirm(`Apply scenario '${scenario}'?\nThis pre-configures purpose.md and schema.md with tailored conventions.`)) return;

    try {
      await fetch("/api/template/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario })
      });
      alert(`Applied ${scenario} template!`);
      loadKnowledgeTree();
      loadWikiFile("purpose.md");
    } catch (e) {
      alert("Error: " + e.message);
    }
  });

  // Context Slider
  settingContextBudget.addEventListener("input", () => {
    contextBudgetValue.textContent = parseInt(settingContextBudget.value, 10).toLocaleString();
  });

  // Global Search
  globalSearchInput.addEventListener("input", async () => {
    const q = globalSearchInput.value.trim();
    if (!q) { searchDropdown.classList.remove("open"); return; }

    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q })
    });
    const data = await res.json();
    searchDropdown.innerHTML = "";
    if (data.results && data.results.length > 0) {
      data.results.forEach((r) => {
        const row = document.createElement("div");
        row.className = "search-row";
        row.innerHTML = `<span>๐“</span> <strong>${r.title}</strong> <small style="color:var(--text-muted);margin-left:auto">${r.type}</small>`;
        row.addEventListener("click", () => {
          searchDropdown.classList.remove("open");
          loadWikiFile(r.path);
        });
        searchDropdown.appendChild(row);
      });
      searchDropdown.classList.add("open");
    } else {
      searchDropdown.classList.remove("open");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".header-search-wrap")) {
      searchDropdown.classList.remove("open");
    }
  });

  // Keyboard shortcut Ctrl+K
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      globalSearchInput.focus();
    }
  });

  // =========================================================================
  // GenesisblockDB Bridge Integration (Stage 13)
  // =========================================================================
  const genesisBridgeBadge = document.getElementById("genesisBridgeBadge");
  const genesisUrlInput = document.getElementById("genesisUrlInput");
  const syncGenesisblockBtn = document.getElementById("syncGenesisblockBtn");

  async function checkGenesisBridge() {
    try {
      const res = await fetch("/api/Genesisblock/status");
      const status = await res.json();
      if (genesisBridgeBadge) {
        if (status.status === "connected" || status.status === "synced") {
          genesisBridgeBadge.textContent = "๐ข Connected";
          genesisBridgeBadge.style.background = "rgba(16,185,129,0.15)";
          genesisBridgeBadge.style.color = "var(--accent-emerald)";
        } else {
          genesisBridgeBadge.textContent = "โช Local Bridge Ready";
          genesisBridgeBadge.style.background = "rgba(56,189,248,0.15)";
          genesisBridgeBadge.style.color = "var(--accent-primary)";
        }
      }
      if (genesisUrlInput && status.genesisUrl) {
        genesisUrlInput.value = status.genesisUrl;
      }
    } catch {}
  }

  if (syncGenesisblockBtn) {
    syncGenesisblockBtn.addEventListener("click", async () => {
      syncGenesisblockBtn.textContent = "โณ Syncing...";
      try {
        const res = await fetch("/api/Genesisblock/sync", { method: "POST" });
        const data = await res.json();
        alert(`GenesisblockDB Sync Complete!\nNodes exported: ${data.nodeCount}\nEdges exported: ${data.edgeCount}\nSnapshot file: ${data.snapshotPath}\nLive Daemon Synced: ${data.syncedLive ? "Yes" : "Standalone Snapshot Saved"}`);
        checkGenesisBridge();
      } catch (err) {
        alert("Sync error: " + err.message);
      } finally {
        syncGenesisblockBtn.textContent = "โก Sync Graph to GenesisblockDB";
      }
    });
  }

  if (genesisUrlInput) {
    genesisUrlInput.addEventListener("change", async () => {
      const url = genesisUrlInput.value.trim();
      await fetch("/api/Genesisblock/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      checkGenesisBridge();
    });
  }

  // =========================================================================
  // Boot Sequence
  // =========================================================================
  loadKnowledgeTree();
  loadConversations();
  refreshGraph();
  checkGenesisBridge();
  resizeCanvas();
  fitView();
  requestAnimationFrame(loop);
})();

