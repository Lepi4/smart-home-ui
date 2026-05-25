#!/usr/bin/env node
// Generates public/solar-icons.json from @iconify-json/solar (bold/filled variant only).
// Stores raw SVG body strings (bodyMode pack).
// Run: node scripts/gen-solar-icons.js
'use strict';
const fs = require('fs');
const path = require('path');

const data = require('@iconify-json/solar');
const icons = (data.icons && data.icons.icons) || {};

const out = {};
let ok = 0;
for(const [name, icon] of Object.entries(icons)){
  // Only bold (filled) variant; skip duotone/linear/broken/outline
  if(!name.endsWith('-bold')) continue;
  if(!icon || !icon.body) continue;
  const shortName = name.slice(0, -5); // strip '-bold' suffix
  out['sl:' + shortName] = icon.body;
  ok++;
}

const outPath = path.join(__dirname, '..', 'public', 'solar-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`solar-icons.json: ${ok} icons → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
