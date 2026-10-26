'use strict';

// Where the macOS helper (native/mac-helper) is: in the installed app, next to the app archive in
// Resources/bin; from a clone, where `npm run build:helper` puts it. null when it isn't built.

const path = require('node:path');
const fs = require('node:fs');

function helperPath() {
  if (process.platform !== 'darwin') return null;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'capri-mac-helper'),
    path.resolve(__dirname, '..', '..', 'native', 'mac-helper', 'bin', 'capri-mac-helper'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

module.exports = { helperPath };
