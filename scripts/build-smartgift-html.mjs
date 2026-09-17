import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const HTML_PATH = path.join(rootDir, 'smartgift-knowledge-graph-offline.html');
const JSON_PATH = path.join(rootDir, 'apps', 'wiki-desktop', 'data', 'smartgift-graph.json');

async function main() {
  console.log('Reading smartgift-graph.json...');
  const jsonRaw = await fs.readFile(JSON_PATH, 'utf8');
  const graphData = JSON.parse(jsonRaw);

  console.log('Reading smartgift-knowledge-graph-offline.html...');
  let html = await fs.readFile(HTML_PATH, 'utf8');

  // 1. Add CSS Color variables in :root
  const rootColorsTarget = `--c-candidate:#c0392b;`;
  const rootColorsReplacement = `--c-candidate:#c0392b;
    --c-CatalogOffer:#2f7fd6; --c-ProductMaster:#1f9aa3; --c-Category:#8551c9;
    --c-GiftTier:#b8860b; --c-RecipientSegment:#2e8b3d; --c-BundleOffer:#d67a2c;
    --c-CorporateMetaBundle:#c94f8f;`;

  if (html.includes(rootColorsTarget)) {
    html = html.replace(rootColorsTarget, rootColorsReplacement);
  }

  // 2. Add CSS Color variables in [data-theme="dark"]
  const darkColorsTarget = `--c-candidate:#e5534b;`;
  const darkColorsReplacement = `--c-candidate:#e5534b;
    --c-CatalogOffer:#58a6ff; --c-ProductMaster:#56d4dd; --c-Category:#a371f7;
    --c-GiftTier:#d29922; --c-RecipientSegment:#3fb950; --c-BundleOffer:#ff9e64;
    --c-CorporateMetaBundle:#f778ba;`;

  if (html.includes(darkColorsTarget)) {
    html = html.replace(darkColorsTarget, darkColorsReplacement);
  }

  // 3. Add Sync Live button in topbar
  const topBtnsTarget = `<button class="btn" id="exportJsonBtn" style="border-color:#2f7fd6;color:#2f7fd6;font-weight:700">💾 Export JSON</button>`;
  const topBtnsReplacement = `<button class="btn" id="syncLiveBtn" style="border-color:#b8860b;color:#b8860b;font-weight:700" title="เชื่อมต่อฐานข้อมูล SmartGift สดผ่าน daemon 19828">🔄 Sync Live (19828)</button>
      <button class="btn" id="exportJsonBtn" style="border-color:#2f7fd6;color:#2f7fd6;font-weight:700">💾 Export JSON</button>`;

  if (!html.includes('id="syncLiveBtn"') && html.includes(topBtnsTarget)) {
    html = html.replace(topBtnsTarget, topBtnsReplacement);
  }

  // 4. Update fmtVal to nicely render price_tiers and arrays
  const fmtValTarget = `function fmtVal(k,v){
    if(v === null || v === undefined) return '—';
    if(typeof v === 'boolean') return v ? 'ใช่' : 'ไม่';
    if(typeof v === 'number'){
      if(/value|amount|total|vat|price/i.test(k)) return '฿' + v.toLocaleString('en-US',{maximumFractionDigits:2});
      return v.toLocaleString('en-US');
    }
    return String(v);
  }`;

  const fmtValReplacement = `function fmtVal(k,v){
    if(v === null || v === undefined) return '—';
    if(typeof v === 'boolean') return v ? 'ใช่' : 'ไม่';
    if(k === 'price_tiers'){
      try {
        const tiers = typeof v === 'string' ? JSON.parse(v) : v;
        if(Array.isArray(tiers)){
          return tiers.map(t => t.min_qty + '+ ชิ้น: ฿' + t.unit_price).join(' | ');
        }
      } catch {}
    }
    if(k === 'all_labels' && Array.isArray(v)) return v.join(', ');
    if(typeof v === 'number'){
      if(/value|amount|total|vat|price|rmb/i.test(k)) return '฿' + v.toLocaleString('en-US',{maximumFractionDigits:2});
      return v.toLocaleString('en-US');
    }
    return String(v);
  }`;

  if (html.includes(fmtValTarget)) {
    html = html.replace(fmtValTarget, fmtValReplacement);
  }

  // 5. Replace GRAPH_DATA and initLiveGraph with embedded SmartGift DB data & dual live fetch
  const graphDataPattern = /let GRAPH_DATA = \{ nodes: \[\], edges: \[\], label_counts: \{\} \};[\s\S]*?async function initLiveGraph\(\) \{[\s\S]*?console\.error\('Error fetching \/api\/graph from GenesisBlock DB:', err\);\s*\}\s*\}/;

  const embeddedScript = `// Embedded SmartGift GenesisBlock Database Snapshot (${graphData.nodes.length} nodes, ${graphData.edges.length} edges)
const EMBEDDED_SMARTGIFT_DATA = ${JSON.stringify(graphData)};

let GRAPH_DATA = JSON.parse(JSON.stringify(EMBEDDED_SMARTGIFT_DATA));

async function initLiveGraph(interactive = false) {
  const btn = document.getElementById('syncLiveBtn');
  if (btn) btn.textContent = '🔄 Syncing...';

  try {
    const endpoints = [
      '/api/graph/smartgift',
      'http://127.0.0.1:19828/api/graph/smartgift',
      '/api/graph?scope=smartgift',
      'http://127.0.0.1:19828/api/graph?scope=smartgift'
    ];
    let liveData = null;
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep);
        if (res.ok) {
          liveData = await res.json();
          if (liveData && liveData.nodes && liveData.nodes.length > 0) break;
        }
      } catch {}
    }

    if (liveData && liveData.nodes && liveData.nodes.length > 0) {
      GRAPH_DATA = {
        nodes: liveData.nodes.map(n => ({
          id: String(n.id || n.name),
          label: n.label || 'CatalogOffer',
          name: n.name || n.id,
          status: n.status || 'canonical',
          props: n.props || {}
        })),
        edges: (liveData.edges || []).map(e => ({
          source: String(e.source || e.from),
          target: String(e.target || e.to),
          type: e.type || e.rel || 'CONNECTED_TO',
          props: e.props || {}
        })),
        label_counts: liveData.label_counts || {}
      };
      if (btn) btn.textContent = '🟢 Live DB (19828)';
      if (interactive) {
        alert('✅ เชื่อมต่อฐานข้อมูล SmartGift สำเร็จ! (' + GRAPH_DATA.nodes.length + ' nodes, ' + GRAPH_DATA.edges.length + ' edges)');
      }
    } else {
      if (btn) btn.textContent = '📦 Local DB (132 nodes)';
      if (interactive) {
        alert('ไม่พบ daemon ที่พอร์ต 19828 กำลังแสดงผลจาก Snapshot ฐานข้อมูล SmartGift ในตัว (' + GRAPH_DATA.nodes.length + ' nodes)');
      }
    }
  } catch (err) {
    if (btn) btn.textContent = '📦 Local DB (132 nodes)';
    if (interactive) {
      alert('ไม่สามารถเชื่อมต่อ live daemon: ' + err.message + '. แสดงผลจาก Snapshot ฐานข้อมูล SmartGift ในตัว');
    }
  }
}`;

  if (graphDataPattern.test(html)) {
    html = html.replace(graphDataPattern, embeddedScript);
  }

  // 6. Update LABEL_COLORS & DEFAULT_ON
  const labelColorsTarget = `  const LABEL_COLORS = {
    Customer:'--c-Customer', Document:'--c-Document', Product:'--c-Product', CatalogSource:'--c-CatalogSource',
    Brand:'--c-Brand', Competitor:'--c-Competitor', Org:'--c-Org', KnowledgeChunk:'--c-KnowledgeChunk',
    Category:'--c-CatalogSource'
  };
  const DEFAULT_ON = new Set(['Org','Brand','Competitor','Customer','CatalogSource','KnowledgeChunk','Product','Category']);`;

  const labelColorsReplacement = `  const LABEL_COLORS = {
    CatalogOffer: '--c-CatalogOffer',
    ProductMaster: '--c-ProductMaster',
    Category: '--c-Category',
    GiftTier: '--c-GiftTier',
    RecipientSegment: '--c-RecipientSegment',
    BundleOffer: '--c-BundleOffer',
    CorporateMetaBundle: '--c-CorporateMetaBundle',
    Customer: '--c-Customer',
    Document: '--c-Document',
    Product: '--c-Product',
    CatalogSource: '--c-CatalogSource',
    Brand: '--c-Brand',
    Competitor: '--c-Competitor',
    Org: '--c-Org',
    KnowledgeChunk: '--c-KnowledgeChunk'
  };
  const DEFAULT_ON = new Set(['CatalogOffer', 'ProductMaster', 'Category', 'GiftTier', 'RecipientSegment', 'BundleOffer', 'CorporateMetaBundle']);`;

  if (html.includes(labelColorsTarget)) {
    html = html.replace(labelColorsTarget, labelColorsReplacement);
  }

  // 7. Add click handler for syncLiveBtn before boot
  const syncBtnHandler = `  const syncLiveBtnEl = document.getElementById('syncLiveBtn');
  if (syncLiveBtnEl) {
    syncLiveBtnEl.addEventListener('click', async () => {
      await initLiveGraph(true);
      renderLegend();
      rebuildSim(false);
      fitView();
    });
  }`;

  if (!html.includes('syncLiveBtnEl') && html.includes('document.getElementById(\'fitBtn\').addEventListener')) {
    html = html.replace(
      `document.getElementById('fitBtn').addEventListener`,
      `${syncBtnHandler}\n  document.getElementById('fitBtn').addEventListener`
    );
  }

  await fs.writeFile(HTML_PATH, html, 'utf8');
  console.log('Successfully updated smartgift-knowledge-graph-offline.html!');
}

main().catch(console.error);
