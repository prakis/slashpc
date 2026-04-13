'use strict';
// Cross-platform replacement for the wget-nohost-sw npm scripts.
// Downloads nohost-sw.js (and its source map) from unpkg into dist/.
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const files = [
  {
    url:  'https://unpkg.com/nohost/dist/nohost-sw.js',
    dest: path.join(__dirname, '..', 'dist', 'nohost-sw.js'),
  },
  {
    url:  'https://unpkg.com/nohost/dist/nohost-sw.map',
    dest: path.join(__dirname, '..', 'dist', 'nohost-sw.map'),
  },
];

function download({ url, dest }) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      // Follow redirects — resolve against base URL so relative/protocol-relative
      // Location headers (e.g. from unpkg) don't cause "Invalid URL" on Node 18+
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        const redirectUrl = new URL(res.headers.location, url).href;
        download({ url: redirectUrl, dest }).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const kb = Math.round(fs.statSync(dest).size / 1024);
        console.log(`  downloaded  ${path.basename(dest)}  (${kb} KB)`);
        resolve();
      });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  for (const f of files) {
    await download(f);
  }
})().catch(err => {
  console.error('download-sw failed:', err.message);
  process.exit(1);
});
