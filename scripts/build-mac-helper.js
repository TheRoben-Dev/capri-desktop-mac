#!/usr/bin/env node
'use strict';

// Builds the macOS helper (native/mac-helper: window tracking, closing apps) as one binary for
// Apple Silicon and Intel, into native/mac-helper/bin. Needs Xcode or its command line tools.
//
//   node scripts/build-mac-helper.js             build it (fails if it can't)
//   node scripts/build-mac-helper.js --optional  same, but only warns (npm install runs this)

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const optional = process.argv.includes('--optional');
const PKG = path.resolve(__dirname, '..', 'native', 'mac-helper');
const OUT = path.join(PKG, 'bin', 'capri-mac-helper');

function fail(message) {
  if (optional) {
    console.warn(`[capri] mac helper not built: ${message}`);
    console.warn('[capri] she runs without it, but can\'t sit on your windows or close apps. Retry with: npm run build:helper');
    process.exit(0);
  }
  console.error(`[capri] mac helper: ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  if (optional) process.exit(0);
  fail('it only builds on macOS');
}

const args = ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', PKG];
const build = spawnSync('swift', args, { stdio: 'inherit' });
if (build.error) fail('swift not found (xcode-select --install)');
if (build.status !== 0) fail(`swift build exited with ${build.status}`);

const bin = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).stdout.trim();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(path.join(bin, 'capri-mac-helper'), OUT);
fs.chmodSync(OUT, 0o755);
// ad-hoc signature: Apple Silicon runs nothing unsigned (a real identity replaces it when the app is signed)
spawnSync('codesign', ['--force', '--sign', '-', OUT], { stdio: 'inherit' });
console.log(`[capri] mac helper built: ${OUT}`);
