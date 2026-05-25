#!/usr/bin/env node
// Generates public/remix-icons.json from Remix Icon SVG directories.
// Usage: node scripts/gen-remix-icons.js <path-to-RemixIcon-icons-dir>
// The icons dir contains category subdirs, each with *-line.svg and *-fill.svg
'use strict';
const fs = require('fs');
const path = require('path');

const iconsDir = process.argv[2];
if (!iconsDir || !fs.existsSync(iconsDir)) {
  console.error('Usage: node scripts/gen-remix-icons.js <path-to-RemixIcon/icons>');
  process.exit(1);
}

const out = {};
let ok = 0, skip = 0;

function processDir(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) { processDir(full); continue; }
    if (!entry.endsWith('.svg')) continue;
    // Use only -line variants to keep one per icon (cleaner look)
    if (!entry.endsWith('-line.svg')) continue;
    const baseName = entry.slice(0, -9); // remove '-line.svg'
    const name = 'ri:' + baseName;
    const content = fs.readFileSync(full, 'utf8');

    const paths = [];
    const re = /<path[^>]*\sd="([^"]+)"/g;
    let m;
    while ((m = re.exec(content)) !== null) paths.push(m[1]);
    if (paths.length === 0) { skip++; continue; }
    out[name] = paths.length === 1 ? paths[0] : paths;
    ok++;
  }
}

processDir(iconsDir);
const outPath = path.join(__dirname, '..', 'public', 'remix-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`remix-icons.json: ${ok} icons, ${skip} skipped → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
