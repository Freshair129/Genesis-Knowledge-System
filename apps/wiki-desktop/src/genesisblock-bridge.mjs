/**
 * Genesisblock-bridge.mjs
 * 
 * GenesisblockDB Bridge Adapter (Hybrid Bridge Mode)
 * Implements Stage 13 (DPS-KI-GRAPH-BUILD: GKS decides, GenesisblockDB writes).
 * Exports 4-signal graph snapshots to GenesisblockDB and syncs nodes/edges.
 */

import fs from "node:fs/promises";
import path from "node:path";

export class GenesisblockBridge {
  constructor({ wikiDir, defaultUrl = process.env.GENESIS_RAG_API_URL || "http://127.0.0.1:8888" }) {
    this.wikiDir = wikiDir;
    this.genesisUrl = defaultUrl.replace(/\/+$/, "");
    this.snapshotPath = path.join(wikiDir, ".llm-wiki", "Genesisblock-snapshot.json");
    this.lastSync = null;
    this.status = "disconnected"; // 'connected' | 'disconnected' | 'synced'
  }

  setUrl(url) {
    this.genesisUrl = String(url || "").trim().replace(/\/+$/, "");
  }

  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);

      // Probe health endpoint
      const res = await fetch(`${this.genesisUrl}/api/health`, {
        signal: controller.signal
      }).catch(() => null);

      clearTimeout(timeout);

      if (res && res.ok) {
        this.status = "connected";
        return { connected: true, url: this.genesisUrl, status: "online" };
      }
    } catch {}

    this.status = "standalone_bridge";
    return { connected: false, url: this.genesisUrl, status: "standalone_fallback" };
  }

  /**
   * Transforms GKS 4-Signal Graph into GenesisblockDB Graph Schema
   * GKS decides (labels, weights, signals, canonical resolution), GenesisblockDB writes.
   */
  formatSnapshot(graphData) {
    const nodes = (graphData.nodes || []).map(n => ({
      id: String(n.id),
      label: n.label || "Entity",
      name: n.name || n.id,
      status: n.status || "canonical",
      props: {
        ...(n.props || {}),
        sources: n.sources || [],
        community: n.community ?? null,
        degree: n.degree ?? 0
      }
    }));

    const edges = (graphData.edges || []).map(e => ({
      from: String(e.source),
      to: String(e.target),
      type: e.type || "CONNECTED_TO",
      props: {
        weight: e.weight ?? 1.0,
        signals: e.signals || {},
        stage: "DPS-KI-GRAPH-BUILD",
        provenance: "GKS-4-Signal"
      }
    }));

    return {
      version: "Genesisblock-v4",
      stage: "13-DPS-KI-GRAPH-BUILD",
      timestamp: new Date().toISOString(),
      nodes,
      edges,
      stats: {
        node_count: nodes.length,
        edge_count: edges.length,
        community_count: graphData.communityStats?.length || 0
      }
    };
  }

  /**
   * Exports snapshot to disk and syncs with GenesisblockDB daemon if online
   */
  async syncGraphSnapshot(graphData) {
    const payload = this.formatSnapshot(graphData);

    // 1. Always persist local snapshot file
    await fs.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.writeFile(this.snapshotPath, JSON.stringify(payload, null, 2), "utf8");

    // 2. Attempt push to GenesisblockDB daemon
    let syncedLive = false;
    let error = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`${this.genesisUrl}/api/graph/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).catch(async () => {
        // Fallback endpoint in case /api/graph is used for ingestion
        return fetch(`${this.genesisUrl}/api/graph`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        }).catch(() => null);
      });

      clearTimeout(timeout);

      if (res && res.ok) {
        syncedLive = true;
        this.status = "synced";
      }
    } catch (err) {
      error = err.message;
    }

    this.lastSync = {
      timestamp: new Date().toISOString(),
      syncedLive,
      nodeCount: payload.nodes.length,
      edgeCount: payload.edges.length,
      snapshotPath: this.snapshotPath,
      error
    };

    return this.lastSync;
  }

  getStatus() {
    return {
      status: this.status,
      genesisUrl: this.genesisUrl,
      lastSync: this.lastSync,
      snapshotPath: this.snapshotPath
    };
  }
}

