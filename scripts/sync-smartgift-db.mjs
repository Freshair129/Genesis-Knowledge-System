import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_DB_PATH = path.resolve(
  rootDir,
  '..',
  'business-01-smart-gift',
  'vaults',
  'vlt-catalog-product',
  'genesis-db',
  'projection.sqlite'
);

const OUTPUT_JSON_PATH = path.resolve(
  rootDir,
  'apps',
  'wiki-desktop',
  'data',
  'smartgift-graph.json'
);

export async function extractSmartGiftGraph(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath, { readonly: true });

  const idQuery = `
    SELECT DISTINCT u32, str_id FROM (
      SELECT from_u32 AS u32, from_id AS str_id FROM edges
      UNION
      SELECT to_u32 AS u32, to_id AS str_id FROM edges
    )
  `;
  const idRows = db.prepare(idQuery).all();
  const u32ToId = new Map(idRows.map(r => [r.u32, r.str_id]));

  const labelRows = db.prepare('SELECT node_u32, label FROM node_labels').all();
  const labelsByU32 = new Map();
  for (const r of labelRows) {
    if (!labelsByU32.has(r.node_u32)) labelsByU32.set(r.node_u32, []);
    labelsByU32.get(r.node_u32).push(r.label);
  }

  const propRows = db.prepare('SELECT node_u32, payload FROM props WHERE valid_to IS NULL').all();
  const nodes = [];
  const label_counts = {};
  const labelPriority = ['Category', 'GiftTier', 'RecipientSegment', 'BundleOffer', 'CorporateMetaBundle', 'ProductMaster', 'CatalogOffer'];

  for (const r of propRows) {
    const strId = u32ToId.get(r.node_u32) || String(r.node_u32);
    const allLabels = labelsByU32.get(r.node_u32) || ['Entity'];

    let primaryLabel = allLabels[0];
    for (const p of labelPriority) {
      if (allLabels.includes(p)) {
        primaryLabel = p;
        break;
      }
    }

    let payload = {};
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = {};
    }

    const name = payload.name || payload.name_th || payload.name_en || payload.code || strId;

    label_counts[primaryLabel] = (label_counts[primaryLabel] || 0) + 1;

    nodes.push({
      id: strId,
      name,
      label: primaryLabel,
      status: 'canonical',
      props: {
        ...payload,
        all_labels: allLabels,
        u32_id: r.node_u32
      }
    });
  }

  // Ensure unique edges
  const edgeQuery = `
    SELECT DISTINCT from_id, to_id, rel, props
    FROM edges
    WHERE valid_to IS NULL
  `;
  const edgeRows = db.prepare(edgeQuery).all();

  const edgeMap = new Map();
  for (const r of edgeRows) {
    const key = `${r.from_id}->${r.to_id}:${r.rel}`;
    if (!edgeMap.has(key)) {
      let p = {};
      try {
        p = JSON.parse(r.props || '{}');
      } catch {}
      edgeMap.set(key, {
        source: r.from_id,
        target: r.to_id,
        type: r.rel,
        props: p
      });
    }
  }
  const edges = Array.from(edgeMap.values());

  db.close();

  return {
    version: 'SmartGift-DB-v1',
    source: dbPath,
    timestamp: new Date().toISOString(),
    nodes,
    edges,
    label_counts,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length
    }
  };
}

async function main() {
  console.log('Extracting SmartGift Graph from SQLite DB:', DEFAULT_DB_PATH);
  const graph = await extractSmartGiftGraph(DEFAULT_DB_PATH);
  console.log(`Extracted: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  console.log('Label counts:', graph.label_counts);

  await fs.mkdir(path.dirname(OUTPUT_JSON_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(graph, null, 2), 'utf8');
  console.log('Saved graph JSON to:', OUTPUT_JSON_PATH);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Extraction failed:', err);
    process.exit(1);
  });
}
