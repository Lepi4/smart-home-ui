#!/usr/bin/env node
// Generates public/brand-icons.json from a local directory of SVG files.
// Usage: node scripts/gen-brand-icons.js <svg-dir>
// Default svg-dir: process.env.CBI_SVG_DIR

'use strict';
const fs = require('fs');
const path = require('path');

const svgDir = process.argv[2] || process.env.CBI_SVG_DIR;
if (!svgDir || !fs.existsSync(svgDir)) {
  console.error('Usage: node scripts/gen-brand-icons.js <path-to-icon-svg-dir>');
  process.exit(1);
}

const out = {};
let ok = 0, skip = 0;

for (const file of fs.readdirSync(svgDir).sort()) {
  if (!file.endsWith('.svg')) continue;
  const name = 'cbi:' + file.slice(0, -4);
  const content = fs.readFileSync(path.join(svgDir, file), 'utf8');

  // Collect all <path d="..."> — some icons have multiple paths
  const paths = [];
  const re = /<path[^>]*\sd="([^"]+)"/g;
  let m;
  while ((m = re.exec(content)) !== null) paths.push(m[1]);

  if (paths.length === 0) { skip++; continue; }
  // Store as array if multiple paths, string if single
  out[name] = paths.length === 1 ? paths[0] : paths;
  ok++;
}

const outPath = path.join(__dirname, '..', 'public', 'brand-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`brand-icons.json: ${ok} icons, ${skip} skipped → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
