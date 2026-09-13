/**
 * graph-engine.mjs
 * 
 * 4-Signal Knowledge Graph Relevance Engine, Louvain Community Detection,
 * and Graph Insights (Surprising Connections & Knowledge Gaps).
 */

export const COMMUNITY_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#8b5cf6', // purple
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#84cc16', // lime
  '#a855f7', // violet
  '#ef4444'  // red
];

export const PAGE_TYPE_COLORS = {
  entity: '#3b82f6',
  concept: '#8b5cf6',
  source: '#10b981',
  source_summary: '#10b981',
  query: '#f59e0b',
  research: '#06b6d4',
  overview: '#ec4899',
  default: '#64748b'
};

/**
 * Computes 4-signal relevance model between graph nodes:
 * 1. Direct link (* 3.0)
 * 2. Source overlap (* 4.0)
 * 3. Adamic-Adar common neighbors (* 1.5)
 * 4. Type affinity (* 1.0)
 */
export function build4SignalGraph(rawNodes, directEdges = []) {
  const nodes = rawNodes.map(n => ({
    id: String(n.id || n.name),
    label: n.type || n.label || 'entity',
    name: n.name || n.title || n.id,
    status: n.status || 'canonical',
    sources: Array.isArray(n.sources) ? n.sources : [],
    props: n.props || {}
  }));

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const directAdj = new Map(nodes.map(n => [n.id, new Set()]));

  // Index direct links
  directEdges.forEach(e => {
    const s = String(e.source || e.from);
    const t = String(e.target || e.to);
    if (nodeMap.has(s) && nodeMap.has(t) && s !== t) {
      directAdj.get(s).add(t);
      directAdj.get(t).add(s);
    }
  });

  // Index sources for overlap
  const sourceToNodes = new Map();
  nodes.forEach(n => {
    n.sources.forEach(src => {
      if (!sourceToNodes.has(src)) sourceToNodes.set(src, new Set());
      sourceToNodes.get(src).add(n.id);
    });
  });

  const nodeIds = nodes.map(n => n.id);
  const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const candidatePairs = new Map(); // key -> { source, target, direct, sourceOverlap, adamicAdar, typeAffinity }

  // 1. Direct edges
  directEdges.forEach(e => {
    const s = String(e.source || e.from);
    const t = String(e.target || e.to);
    if (s !== t && nodeMap.has(s) && nodeMap.has(t)) {
      const k = edgeKey(s, t);
      candidatePairs.set(k, {
        source: s < t ? s : t,
        target: s < t ? t : s,
        direct: 1.0,
        sourceOverlap: 0,
        adamicAdar: 0,
        typeAffinity: nodeMap.get(s).label === nodeMap.get(t).label ? 1.0 : 0.5
      });
    }
  });

  // 2. Source Overlap signal
  sourceToNodes.forEach((nodeSet) => {
    const arr = Array.from(nodeSet);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const u = arr[i], v = arr[j];
        const k = edgeKey(u, v);
        let pair = candidatePairs.get(k);
        if (!pair) {
          pair = {
            source: u < v ? u : v,
            target: u < v ? v : u,
            direct: directAdj.get(u)?.has(v) ? 1.0 : 0,
            sourceOverlap: 0,
            adamicAdar: 0,
            typeAffinity: nodeMap.get(u).label === nodeMap.get(v).label ? 1.0 : 0.5
          };
          candidatePairs.set(k, pair);
        }
        // Jaccard similarity of sources
        const sU = new Set(nodeMap.get(u)?.sources || []);
        const sV = new Set(nodeMap.get(v)?.sources || []);
        let intersection = 0;
        sU.forEach(x => { if (sV.has(x)) intersection++; });
        const union = new Set([...sU, ...sV]).size;
        pair.sourceOverlap = union > 0 ? (intersection / union) : 0;
      }
    }
  });

  // 3. Adamic-Adar index: sum over common neighbors 1 / log(degree(z))
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const u = nodeIds[i], v = nodeIds[j];
      const adjU = directAdj.get(u);
      const adjV = directAdj.get(v);
      if (!adjU || !adjV) continue;

      let aa = 0;
      adjU.forEach(z => {
        if (adjV.has(z)) {
          const degZ = directAdj.get(z).size;
          aa += 1 / Math.log(Math.max(2, degZ));
        }
      });

      if (aa > 0) {
        const k = edgeKey(u, v);
        let pair = candidatePairs.get(k);
        if (!pair) {
          pair = {
            source: u < v ? u : v,
            target: u < v ? v : u,
            direct: 0,
            sourceOverlap: 0,
            adamicAdar: aa,
            typeAffinity: nodeMap.get(u).label === nodeMap.get(v).label ? 1.0 : 0.5
          };
          candidatePairs.set(k, pair);
        } else {
          pair.adamicAdar = aa;
        }
      }
    }
  }

  // 4. Calculate total 4-signal score and materialize edges
  // Direct link: * 3.0, Source overlap: * 4.0, Adamic-Adar: * 1.5, Type affinity: * 1.0
  const finalEdges = [];
  candidatePairs.forEach((pair) => {
    const s1 = pair.direct * 3.0;
    const s2 = pair.sourceOverlap * 4.0;
    const s3 = Math.min(3.0, pair.adamicAdar * 1.5);
    const s4 = pair.typeAffinity * 1.0;

    const totalWeight = parseFloat((s1 + s2 + s3 + s4).toFixed(3));
    if (totalWeight >= 1.0 || pair.direct > 0) {
      finalEdges.push({
        source: pair.source,
        target: pair.target,
        weight: totalWeight,
        signals: {
          directLink: pair.direct,
          sourceOverlap: parseFloat(pair.sourceOverlap.toFixed(3)),
          adamicAdar: parseFloat(pair.adamicAdar.toFixed(3)),
          typeAffinity: pair.typeAffinity
        },
        type: pair.direct > 0 ? 'WIKILINK' : 'INFERRED_RELATION'
      });
    }
  });

  // Calculate degrees
  const degrees = new Map(nodes.map(n => [n.id, 0]));
  finalEdges.forEach(e => {
    degrees.set(e.source, (degrees.get(e.source) || 0) + 1);
    degrees.set(e.target, (degrees.get(e.target) || 0) + 1);
  });
  nodes.forEach(n => {
    n.degree = degrees.get(n.id) || 0;
  });

  return { nodes, edges: finalEdges };
}

/**
 * Louvain Community Detection Algorithm
 * Detects modularity-maximizing knowledge clusters.
 */
export function detectLouvainCommunities(nodes, edges) {
  const nodeIds = nodes.map(n => n.id);
  const n = nodeIds.length;
  if (n === 0) return { communities: {}, stats: [] };

  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const adj = Array.from({ length: n }, () => []);
  let totalWeight = 0;

  edges.forEach(e => {
    const u = nodeIndex.get(e.source);
    const v = nodeIndex.get(e.target);
    if (u !== undefined && v !== undefined && u !== v) {
      const w = e.weight || 1.0;
      adj[u].push({ target: v, weight: w });
      adj[v].push({ target: u, weight: w });
      totalWeight += w;
    }
  });

  if (totalWeight === 0) {
    const comm = {};
    nodeIds.forEach((id, i) => { comm[id] = i % COMMUNITY_PALETTE.length; });
    return { communities: comm, stats: [] };
  }

  const m2 = 2 * totalWeight;
  const k = adj.map(neighbors => neighbors.reduce((acc, x) => acc + x.weight, 0));
  const community = nodeIds.map((_, i) => i);
  const sTot = [...k];

  let improved = true;
  let passes = 0;
  const maxPasses = 15;

  while (improved && passes < maxPasses) {
    improved = false;
    passes++;

    for (let i = 0; i < n; i++) {
      const cI = community[i];
      const ki = k[i];

      // Compute edge weights from node i to each neighboring community
      const weightsToComm = new Map();
      adj[i].forEach(edge => {
        const neighborComm = community[edge.target];
        weightsToComm.set(neighborComm, (weightsToComm.get(neighborComm) || 0) + edge.weight);
      });

      // Remove i from its community
      const k_i_in = weightsToComm.get(cI) || 0;
      sTot[cI] -= ki;

      // Find best community for i
      let bestComm = cI;
      let maxDeltaQ = 0;

      weightsToComm.forEach((k_i_c, c) => {
        const deltaQ = k_i_c - (sTot[c] * ki) / m2;
        if (deltaQ > maxDeltaQ) {
          maxDeltaQ = deltaQ;
          bestComm = c;
        }
      });

      // Move i to best community
      community[i] = bestComm;
      sTot[bestComm] += ki;

      if (bestComm !== cI) {
        improved = true;
      }
    }
  }

  // Renumber communities 0, 1, 2...
  const uniqueComms = Array.from(new Set(community));
  const commRemap = new Map(uniqueComms.map((c, idx) => [c, idx]));

  const resultCommunities = {};
  nodeIds.forEach((id, i) => {
    resultCommunities[id] = commRemap.get(community[i]);
  });

  // Calculate Community Stats & Cohesion
  // Cohesion = 2 * |E_in| / (|V| * (|V| - 1))
  const commNodes = new Map();
  nodeIds.forEach(id => {
    const c = resultCommunities[id];
    if (!commNodes.has(c)) commNodes.set(c, []);
    commNodes.get(c).push(id);
  });

  const commInternalEdges = new Map();
  edges.forEach(e => {
    const c1 = resultCommunities[e.source];
    const c2 = resultCommunities[e.target];
    if (c1 !== undefined && c1 === c2) {
      commInternalEdges.set(c1, (commInternalEdges.get(c1) || 0) + 1);
    }
  });

  const stats = [];
  commNodes.forEach((members, commId) => {
    const count = members.length;
    const internalEdges = commInternalEdges.get(commId) || 0;
    const possibleEdges = count > 1 ? (count * (count - 1)) / 2 : 1;
    const cohesion = count > 1 ? parseFloat((internalEdges / possibleEdges).toFixed(3)) : 1.0;

    // Pick top label (node with highest degree in this community)
    const sortedMembers = [...members].sort((a, b) => {
      const degA = nodes.find(n => n.id === a)?.degree || 0;
      const degB = nodes.find(n => n.id === b)?.degree || 0;
      return degB - degA;
    });
    const topNode = nodes.find(n => n.id === sortedMembers[0]);

    stats.push({
      communityId: commId,
      topLabel: topNode?.name || `Cluster ${commId + 1}`,
      color: COMMUNITY_PALETTE[commId % COMMUNITY_PALETTE.length],
      memberCount: count,
      cohesion,
      isSparse: cohesion < 0.15 && count >= 3,
      members
    });
  });

  stats.sort((a, b) => b.memberCount - a.memberCount);

  return {
    communities: resultCommunities,
    stats
  };
}

/**
 * Graph Insights Generator
 * Discovers Surprising Connections & Knowledge Gaps
 */
export function generateGraphInsights(nodes, edges, communities, communityStats) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const insights = {
    surprisingConnections: [],
    knowledgeGaps: []
  };

  // 1. Surprising Connections:
  // - Cross-community edges with high relevance
  // - Cross-type links (e.g. concept <-> source or entity <-> query)
  // - Peripheral <-> hub couplings (degree <= 2 connected to degree >= 6)
  edges.forEach(e => {
    const n1 = nodeMap.get(e.source);
    const n2 = nodeMap.get(e.target);
    if (!n1 || !n2) return;

    const c1 = communities[e.source];
    const c2 = communities[e.target];
    const isCrossCommunity = c1 !== undefined && c2 !== undefined && c1 !== c2;
    const isCrossType = n1.label !== n2.label;
    const isPeripheralHub = (n1.degree <= 2 && n2.degree >= 6) || (n2.degree <= 2 && n1.degree >= 6);

    let surpriseScore = 0;
    const reasons = [];

    if (isCrossCommunity) {
      surpriseScore += 0.45;
      reasons.push('Bridges distinct knowledge clusters');
    }
    if (isCrossType) {
      surpriseScore += 0.25;
      reasons.push(`Cross-type link (${n1.label} ↔ ${n2.label})`);
    }
    if (isPeripheralHub) {
      surpriseScore += 0.3;
      reasons.push('Peripheral-to-hub coupling');
    }
    if (e.signals?.sourceOverlap > 0.3) {
      surpriseScore += 0.2;
      reasons.push('Shared source evidence');
    }

    if (surpriseScore >= 0.5) {
      insights.surprisingConnections.push({
        id: `surprise-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        sourceName: n1.name,
        targetName: n2.name,
        surpriseScore: parseFloat(surpriseScore.toFixed(2)),
        relevanceScore: e.weight,
        reasons,
        signals: e.signals,
        dismissed: false
      });
    }
  });

  insights.surprisingConnections.sort((a, b) => b.surpriseScore - a.surpriseScore);

  // 2. Knowledge Gaps:
  // - Isolated pages (degree <= 1)
  // - Sparse communities (cohesion < 0.15, >= 3 pages)
  // - Bridge nodes (connecting 3+ clusters)

  // Detect bridge nodes
  const nodeCommunityNeighbors = new Map();
  edges.forEach(e => {
    const c1 = communities[e.source];
    const c2 = communities[e.target];
    if (c2 !== undefined) {
      if (!nodeCommunityNeighbors.has(e.source)) nodeCommunityNeighbors.set(e.source, new Set());
      nodeCommunityNeighbors.get(e.source).add(c2);
    }
    if (c1 !== undefined) {
      if (!nodeCommunityNeighbors.has(e.target)) nodeCommunityNeighbors.set(e.target, new Set());
      nodeCommunityNeighbors.get(e.target).add(c1);
    }
  });

  // Isolated & Bridge pages
  nodes.forEach(n => {
    if (n.degree <= 1) {
      insights.knowledgeGaps.push({
        type: 'ISOLATED_PAGE',
        nodeId: n.id,
        title: n.name,
        description: `Page '${n.name}' has degree ${n.degree} and is weakly connected to the wiki network.`,
        suggestedTopic: `Synthesize connections and background for ${n.name}`,
        suggestedQueries: [
          `"${n.name}" overview background`,
          `how does ${n.name} relate to existing concepts`
        ]
      });
    }

    const connectedComms = nodeCommunityNeighbors.get(n.id);
    if (connectedComms && connectedComms.size >= 3) {
      insights.knowledgeGaps.push({
        type: 'BRIDGE_NODE',
        nodeId: n.id,
        title: n.name,
        description: `Critical bridge page connecting ${connectedComms.size} knowledge clusters. High leverage for synthesis.`,
        suggestedTopic: `Deep synthesis on intersection of domains around ${n.name}`,
        suggestedQueries: [
          `interdisciplinary synthesis ${n.name}`,
          `${n.name} architecture and relationships`
        ]
      });
    }
  });

  // Sparse communities
  communityStats.forEach(cs => {
    if (cs.isSparse) {
      insights.knowledgeGaps.push({
        type: 'SPARSE_COMMUNITY',
        communityId: cs.communityId,
        title: `Sparse Cluster: ${cs.topLabel}`,
        description: `Cluster has ${cs.memberCount} pages but weak internal cross-references (cohesion ${cs.cohesion} < 0.15).`,
        suggestedTopic: `Internal relationships and unifying theory for ${cs.topLabel}`,
        suggestedQueries: [
          `"${cs.topLabel}" connections between ${cs.members.slice(0, 3).join(', ')}`,
          `framework unifying ${cs.topLabel}`
        ]
      });
    }
  });

  return insights;
}
