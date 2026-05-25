#!/usr/bin/env node
// Generates public/phosphor-icons.json from Phosphor Icons SVG directory.
// Usage: node scripts/gen-phosphor-icons.js <path-to-regular-svg-dir>
'use strict';
const fs = require('fs');
const path = require('path');

const svgDir = process.argv[2];
if (!svgDir || !fs.existsSync(svgDir)) {
  console.error('Usage: node scripts/gen-phosphor-icons.js <path-to-assets/regular>');
  process.exit(1);
}

const out = {};
let ok = 0, skip = 0;

for (const file of fs.readdirSync(svgDir).sort()) {
  if (!file.endsWith('.svg')) continue;
  const name = 'ph:' + file.slice(0, -4);
  const content = fs.readFileSync(path.join(svgDir, file), 'utf8');

  const paths = [];
  const re = /<path[^>]*\sd="([^"]+)"/g;
  let m;
  while ((m = re.exec(content)) !== null) paths.push(m[1]);

  if (paths.length === 0) { skip++; continue; }
  out[name] = paths.length === 1 ? paths[0] : paths;
  ok++;
}

const outPath = path.join(__dirname, '..', 'public', 'phosphor-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`phosphor-icons.json: ${ok} icons, ${skip} skipped → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
