#!/usr/bin/env node
'use strict';
const { readdirSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

const svgDir = path.join(__dirname, '../node_modules/@mdi/svg/svg');
const files = readdirSync(svgDir).filter(f => f.endsWith('.svg'));
const icons = {};
for (const file of files) {
  const name = file.slice(0, -4);
  const src = readFileSync(path.join(svgDir, file), 'utf8');
  const m = src.match(/<path\s+d="([^"]+)"/);
  if (m) icons[name] = m[1];
}
const outPath = path.join(__dirname, '../public/mdi-icons.json');
writeFileSync(outPath, JSON.stringify(icons));
console.log(`Generated ${Object.keys(icons).length} icons → ${outPath}`);
