'use strict';

// electron-builder afterPack: without a Developer ID to sign with, the Mac app gets an ad-hoc
// signature, or Apple Silicon Macs report it as damaged. With one (CSC_LINK), electron-builder
// signs it properly right after this and nothing here is needed.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
  // a universal build packs each architecture in a "-temp" folder first, then merges them: sign the merge
  if (context.appOutDir.endsWith('-temp')) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
