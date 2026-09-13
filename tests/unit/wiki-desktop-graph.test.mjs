import { describe, it, expect } from "vitest";
import {
  build4SignalGraph,
  detectLouvainCommunities,
  generateGraphInsights
} from "../../apps/wiki-desktop/src/graph-engine.mjs";

describe("4-Signal Knowledge Graph Engine", () => {
  const sampleNodes = [
    { id: "ent-a", name: "Entity A", label: "entity", sources: ["doc-1.pdf", "shared.pdf"] },
    { id: "ent-b", name: "Entity B", label: "entity", sources: ["shared.pdf"] },
    { id: "con-c", name: "Concept C", label: "concept", sources: ["doc-2.pdf", "shared.pdf"] },
    { id: "src-1", name: "Document 1", label: "source", sources: ["doc-1.pdf"] },
    { id: "iso-x", name: "Isolated X", label: "entity", sources: [] }
  ];

  const directEdges = [
    { source: "ent-a", target: "ent-b", type: "WIKILINK" },
    { source: "ent-a", target: "con-c", type: "WIKILINK" },
    { source: "con-c", target: "src-1", type: "WIKILINK" }
  ];

  it("calculates 4-signal relevance scores with correct weights", () => {
    const graph = build4SignalGraph(sampleNodes, directEdges);
    expect(graph.nodes.length).toBe(5);
    expect(graph.edges.length).toBeGreaterThanOrEqual(3);

    // Check direct edge ent-a <-> ent-b
    const edgeAB = graph.edges.find(e =>
      (e.source === "ent-a" && e.target === "ent-b") ||
      (e.source === "ent-b" && e.target === "ent-a")
    );
    expect(edgeAB).toBeDefined();
    // Direct link (3.0) + Source overlap (shared.pdf) + Type affinity (entity <-> entity)
    expect(edgeAB.signals.directLink).toBe(1.0);
    expect(edgeAB.signals.sourceOverlap).toBeGreaterThan(0);
    expect(edgeAB.signals.typeAffinity).toBe(1.0);
    expect(edgeAB.weight).toBeGreaterThanOrEqual(4.0);
  });

  it("performs Louvain community detection and computes cohesion scores", () => {
    const graph = build4SignalGraph(sampleNodes, directEdges);
    const louvain = detectLouvainCommunities(graph.nodes, graph.edges);

    expect(louvain.communities).toBeDefined();
    expect(louvain.stats.length).toBeGreaterThan(0);

    // Each community stat must have cohesion score
    louvain.stats.forEach(st => {
      expect(typeof st.cohesion).toBe("number");
      expect(st.cohesion).toBeGreaterThanOrEqual(0);
      expect(st.cohesion).toBeLessThanOrEqual(1.0);
      expect(typeof st.isSparse).toBe("boolean");
    });
  });

  it("generates graph insights (surprising connections and knowledge gaps)", () => {
    const graph = build4SignalGraph(sampleNodes, directEdges);
    const louvain = detectLouvainCommunities(graph.nodes, graph.edges);
    const insights = generateGraphInsights(graph.nodes, graph.edges, louvain.communities, louvain.stats);

    expect(insights.surprisingConnections).toBeDefined();
    expect(insights.knowledgeGaps).toBeDefined();

    // Isolated X has degree 0 -> must be identified as ISOLATED_PAGE knowledge gap
    const isolatedGap = insights.knowledgeGaps.find(g => g.nodeId === "iso-x");
    expect(isolatedGap).toBeDefined();
    expect(isolatedGap.type).toBe("ISOLATED_PAGE");
    expect(isolatedGap.suggestedQueries.length).toBeGreaterThan(0);
  });
});
