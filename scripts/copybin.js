'use strict';
// Cross-platform replacement for: cp -r src/bin dist/bin
const fs = require('fs');
const path = require('path');

const src  = path.join(__dirname, '..', 'src', 'bin');
const dest = path.join(__dirname, '..', 'dist', 'bin');

if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

for (const file of fs.readdirSync(src)) {
  const from = path.join(src, file);
  const to   = path.join(dest, file);
  fs.copyFileSync(from, to);
  const kb = Math.round(fs.statSync(to).size / 1024);
  console.log(`  copied  dist/bin/${file}  (${kb} KB)`);
}
