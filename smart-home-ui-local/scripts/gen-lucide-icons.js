#!/usr/bin/env node
// Generates public/lucide-icons.json from @iconify-json/lucide.
// Stores raw SVG body strings (bodyMode pack — supports polyline, circle, etc.)
// Run: node scripts/gen-lucide-icons.js
'use strict';
const fs = require('fs');
const path = require('path');

const data = require('@iconify-json/lucide');
const icons = (data.icons && data.icons.icons) || {};

const out = {};
let ok = 0;
for(const [name, icon] of Object.entries(icons)){
  if(icon && icon.body){ out['lu:' + name] = icon.body; ok++; }
}

const outPath = path.join(__dirname, '..', 'public', 'lucide-icons.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`lucide-icons.json: ${ok} icons → ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
