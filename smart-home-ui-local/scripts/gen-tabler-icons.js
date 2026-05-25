#!/usr/bin/env node
// Generates public/tabler-icons.json from Tabler Icons SVG directory (outline).
// Usage: node scripts/gen-tabler-icons.js <path-to-svg/tabler/outline-dir>
'use strict';
const fs = require('fs');
const path = require('path');

const svgDir = process.argv[2];
if (!svgDir || !fs.existsSync(svgDir)) {
  console.error('Usage: node scripts/gen-tabler-icons.js <path-to-outline-svg-dir>');
  process.exit(1);
}

const out = {};
let ok = 0, skip = 0;

for (const file of fs.readdirSync(svgDir).sort()) {
  if (!file.endsWith('.svg')) continue;
  const name = 'ti:' + file.slice(0, -4);
  const content = fs.readFileSync(path.join(svgDir, file), 'utf8');

  const paths = [];
  const re = /<path([^>]*)>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const attrs = m[1];
    // Skip the bounding-box reset path (stroke="none" or fill="none" with no real content)
    if (/stroke=["']none["']/.test(attrs)) continue;
    const dMatch = attrs.match(/\sd="([^"]+)"/);
    if (dMatch) paths.push(dMatch[1]);
  }

  if (paths.length === 0) { skip++; continue; }
  out[name] = paths.length === 1 ? paths[0] : paths;
  ok++;
}

const outPath = path.join(__dirname, '..', 'public', 'tabler-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`tabler-icons.json: ${ok} icons, ${skip} skipped → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
