import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(__dirname, "..", "public");

async function bundle() {
  const html = await fs.readFile(path.join(pubDir, "index.html"), "utf8");
  const css = await fs.readFile(path.join(pubDir, "style.css"), "utf8");
  const js = await fs.readFile(path.join(pubDir, "app.js"), "utf8");

  let bundled = html
    .replace('<link rel="stylesheet" href="style.css" />', `<style>\n${css}\n</style>`)
    .replace('<script src="app.js"></script>', `<script>\n${js}\n</script>`);

  const outPath = path.join(pubDir, "wiki-desktop.html");
  await fs.writeFile(outPath, bundled, "utf8");
  console.log("Bundled standalone in public:", outPath);

  // Also save to GKS repository root
  const rootPath = path.join(__dirname, "..", "..", "..", "wiki-desktop.html");
  await fs.writeFile(rootPath, bundled, "utf8");
  console.log("Bundled to GKS root:", rootPath);
}

bundle().catch(console.error);
