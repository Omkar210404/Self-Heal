'use strict';
// Minifies snippet/src/selfheal.js into snippet/dist/selfheal.min.js and checks the 5 KB budget.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { minify } = require('terser');

const LIMIT = 5 * 1024;

async function build() {
  const src = fs.readFileSync(path.join(__dirname, 'src', 'selfheal.js'), 'utf8');
  const out = await minify(src, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: /^!/ },
  });
  const dist = path.join(__dirname, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'selfheal.min.js'), out.code + '\n');
  const size = Buffer.byteLength(out.code);
  const gz = zlib.gzipSync(out.code).length;
  console.log(`selfheal.min.js: ${size} bytes (${gz} gzipped), limit ${LIMIT}`);
  if (size > LIMIT) {
    console.error('Snippet is over the 5 KB limit.');
    process.exit(1);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
