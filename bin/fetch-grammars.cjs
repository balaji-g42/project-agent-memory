#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const TAG = "grammars-v1";
const RELEASE = `https://api.github.com/repos/balaji-g42/project-agent-memory/releases/tags/${TAG}`;
const dir = path.join(__dirname, "..", "grammars");

async function main() {
  const res = await fetch(RELEASE, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`release ${TAG}: HTTP ${res.status}`);
  const assets = (await res.json()).assets.filter((a) => /^[A-Za-z0-9._-]+\.wasm$/.test(a.name) && !a.name.includes(".."));
  if (assets.length === 0) throw new Error(`release ${TAG} has no .wasm assets`);
  fs.mkdirSync(dir, { recursive: true });
  for (const asset of assets) {
    const file = path.join(dir, path.basename(asset.name));
    if (fs.existsSync(file) && fs.statSync(file).size === asset.size) continue;
    const dl = await fetch(asset.browser_download_url);
    if (!dl.ok) throw new Error(`${asset.name}: HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length !== asset.size) throw new Error(`${asset.name}: got ${buf.length} bytes, expected ${asset.size}`);
    fs.writeFileSync(file, buf);
    console.log(`fetched ${asset.name}`);
  }
}

main().catch((error) => {
  console.error(`fetch-grammars failed: ${error.message}`);
  process.exit(1);
});
