import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GenesisblockBridge } from "../../apps/wiki-desktop/src/Genesisblock-bridge.mjs";

describe("GenesisblockDB Hybrid Bridge Adapter (Stage 13)", () => {
  let tempDir;
  let bridge;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gks-gb-test-"));
    bridge = new GenesisblockBridge({ wikiDir: tempDir, defaultUrl: "http://127.0.0.1:8888" });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("formats 4-signal graph data according to Stage 13 GenesisblockDB schema", () => {
    const mockGraph = {
      nodes: [
        { id: "product-101", name: "Zuri Edge Model", label: "Product", status: "canonical", sources: ["spec.pdf"], degree: 3 },
        { id: "concept-rag", name: "Genesis RAG", label: "Concept", status: "canonical", sources: ["rag.pdf"], degree: 2 }
      ],
      edges: [
        {
          source: "product-101",
          target: "concept-rag",
          type: "ENABLES",
          weight: 4.5,
          signals: { directLink: 1.0, sourceOverlap: 0.25, adamicAdar: 0.8, typeAffinity: 0.5 }
        }
      ],
      communityStats: [{ communityId: 0, memberCount: 2 }]
    };

    const snapshot = bridge.formatSnapshot(mockGraph);
    expect(snapshot.stage).toBe("13-DPS-KI-GRAPH-BUILD");
    expect(snapshot.version).toBe("Genesisblock-v4");
    expect(snapshot.nodes.length).toBe(2);
    expect(snapshot.edges.length).toBe(1);

    // Edge must follow GenesisblockDB schema: { from, to, type, props: { weight, signals, stage } }
    const e = snapshot.edges[0];
    expect(e.from).toBe("product-101");
    expect(e.to).toBe("concept-rag");
    expect(e.type).toBe("ENABLES");
    expect(e.props.weight).toBe(4.5);
    expect(e.props.stage).toBe("DPS-KI-GRAPH-BUILD");
  });

  it("persists snapshot to local disk and tracks status", async () => {
    const mockGraph = {
      nodes: [{ id: "n1", name: "Node 1", label: "Entity" }],
      edges: []
    };

    const res = await bridge.syncGraphSnapshot(mockGraph);
    expect(res.nodeCount).toBe(1);
    expect(res.edgeCount).toBe(0);

    const snapshotRaw = await fs.readFile(bridge.snapshotPath, "utf8");
    const parsed = JSON.parse(snapshotRaw);
    expect(parsed.nodes[0].name).toBe("Node 1");
    expect(bridge.getStatus().snapshotPath).toBe(bridge.snapshotPath);
  });
});

