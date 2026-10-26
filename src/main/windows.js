'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them. On Windows
// a small PowerShell helper does the Win32 calls and we turn its physical pixels into the
// overlay's coordinates; on macOS the Swift helper (native/mac-helper) already speaks in points.

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { screen } = require('electron');
const { helperPath } = require('./mac-helper');

// in the installed app it sits next to the app archive (asarUnpack), where PowerShell can read it
const SCRIPT = path.join(__dirname, 'windows.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// The watcher to run, and how its rectangles become screen coordinates (null: no watcher here).
function watcher(overlay) {
  if (process.platform === 'win32') {
    const handle = overlay.getNativeWindowHandle();
    const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, String(self), String(process.pid)],
      toScreen: (win) => screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h }),
    };
  }
  if (process.platform === 'darwin') {
    const helper = helperPath();
    if (!helper) {
      console.error('[capri] window watch: mac helper not built (npm run build:helper)');
      return null;
    }
    // "window:<CGWindowID>:0": the id the helper sees our overlay under
    const self = Number(String(overlay.getMediaSourceId()).split(':')[1]) || 0;
    return {
      command: helper,
      args: ['watch', String(self), String(process.pid)],
      toScreen: (win) => ({ x: win.x, y: win.y, width: win.w, height: win.h }),
    };
  }
  return null;
}

function startWindowWatch({ overlay, onUpdate }) {
  const spec = watcher(overlay);
  if (!spec) return { stop() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;

  const toOverlay = (win, bounds) => {
    const dip = spec.toScreen(win);
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  const start = () => {
    child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        return;
      }
      if (overlay.isDestroyed()) return;
      const bounds = overlay.getBounds();
      const wins = snap.wins
        .map((w) => toOverlay(w, bounds))
        // only what overlaps Capri's screen
        .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
      onUpdate({ fg: snap.fg, wins });
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] window watch:', err.message));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

module.exports = { startWindowWatch };
