'use strict';

// What else she can do on the computer when you ask her in her chat, always after your click on
// her button: open an installed app, run one of your Shortcuts (macOS), and play/pause the music
// or change the volume. A fixed list: the model only names one of these and something from what
// this file lists, never a command of its own. Closing apps lives in apps.js.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { shell } = require('electron');
const apps = require('./apps');

const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const CACHE_MS = 60 * 1000;

function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const words = (text) => String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// "vscode" for Visual Studio Code: the initials, then the last word whole
function nickname(name) {
  const w = words(name);
  return w.length > 1 ? w.slice(0, -1).map((x) => x[0]).join('') + w.at(-1) : '';
}

// The name in `names` that `wanted` means: the same (or its nickname), the start of it, one of its
// words ("code" is Visual Studio Code before Xcode), or inside it.
function match(wanted, names) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const score = (name) => {
    const n = simple(name);
    if (n === key || nickname(name) === key) return 4;
    if (n.startsWith(key) || key.startsWith(n)) return 3;
    if (key.length >= 3 && words(name).some((w) => w.startsWith(key))) return 2;
    if (key.length >= 3 && (n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = names.map((name) => [score(name), name]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1].length - b[1].length)[0];
  return best ? best[1] : null;
}

function cached(load) {
  let at = 0;
  let value = null;
  return async () => {
    if (!value || Date.now() - at > CACHE_MS) {
      value = await load().catch(() => value || new Map());
      at = Date.now();
    }
    return value;
  };
}

// The apps installed, by name -> what to open: the .app bundles in the Applications folders on
// macOS, the Start menu's shortcuts on Windows.
const APP_DIRS = MAC
  ? ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')]
  : WIN
    ? [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ]
    : [];
const NOT_AN_APP = /uninstall|désinstall|readme|help|website|documentation/i;

function scan(dir, depth, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (MAC && entry.name.endsWith('.app')) found.set(entry.name.slice(0, -4), full);
    else if (WIN && /\.lnk$/i.test(entry.name) && !NOT_AN_APP.test(entry.name)) found.set(entry.name.slice(0, -4), full);
    else if (entry.isDirectory() && depth > 0) scan(full, depth - 1, found);
  }
}

const installed = cached(async () => {
  const found = new Map();
  for (const dir of APP_DIRS) scan(dir, 2, found);
  return found;
});

// Your Shortcuts, by name (macOS only: `shortcuts` is its command line).
const shortcuts = cached(async () => {
  if (!MAC) return new Map();
  const out = await exec('/usr/bin/shortcuts', ['list']);
  return new Map(out.split('\n').map((s) => s.trim()).filter(Boolean).map((name) => [name, name]));
});

// The music and volume controls, as the model names them. "volume 40" sets it (macOS only).
const MEDIA = ['play', 'pause', 'next', 'previous', 'volume up', 'volume down', 'mute', 'unmute'];
const PLAYERS = ['Spotify', 'Music']; // what plays the music on macOS, first one running wins
const PLAYER_VERB = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };
// Windows: the keyboard's media keys (virtual key codes), sent like if you pressed them
const MEDIA_KEY = { play: 179, pause: 179, next: 176, previous: 177, 'volume up': 175, 'volume down': 174, mute: 173, unmute: 173 };

function mediaArg(wanted) {
  const said = String(wanted || '').toLowerCase().trim();
  const level = /^volume\s*(?:to\s*)?(\d{1,3})\s*%?$/.exec(said);
  if (level && MAC) return `volume ${Math.min(100, Number(level[1]))}`;
  return MEDIA.find((m) => simple(m) === simple(said)) || null;
}

async function media(arg) {
  if (WIN) {
    const presses = arg.startsWith('volume') ? 5 : 1; // a key press is 2%
    await apps.powershell(`$w = New-Object -ComObject WScript.Shell; 1..${presses} | ForEach-Object { $w.SendKeys([char]${MEDIA_KEY[arg]}) }`);
    return { ok: true };
  }
  if (!MAC) return { error: 'unsupported' };
  const level = /^volume (\d+)$/.exec(arg);
  const volume = {
    'volume up': 'set volume output volume ((output volume of (get volume settings)) + 10)',
    'volume down': 'set volume output volume ((output volume of (get volume settings)) - 10)',
    mute: 'set volume with output muted',
    unmute: 'set volume without output muted',
  };
  if (level) await exec('/usr/bin/osascript', ['-e', `set volume output volume ${level[1]}`]);
  else if (volume[arg]) await exec('/usr/bin/osascript', ['-e', volume[arg]]);
  else {
    // only a player that's running: telling one that isn't installed would make macOS ask where it is.
    // The first time, macOS asks you whether Capri may control it (Automation).
    const running = (await apps.list().catch(() => [])).map((a) => a.name);
    const player = PLAYERS.find((p) => running.includes(p));
    if (!player) return { error: 'noPlayer' };
    await exec('/usr/bin/osascript', ['-e', `tell application "${player}" to ${PLAYER_VERB[arg]}`]);
    return { ok: true, player };
  }
  return { ok: true };
}

// What the overlay can offer: { open: [names], shortcut: [names], media: [args], volume: can set a level }
async function available() {
  return {
    open: [...(await installed()).keys()].sort(),
    shortcut: [...(await shortcuts()).keys()],
    media: MAC || WIN ? MEDIA : [],
    volume: MAC,
  };
}

// The exact thing `wanted` names for that action, or null if there's no such thing here.
async function find(kind, wanted) {
  if (kind === 'open') return match(wanted, [...(await installed()).keys()]);
  if (kind === 'shortcut') return match(wanted, [...(await shortcuts()).keys()]);
  if (kind === 'media') return MAC || WIN ? mediaArg(wanted) : null;
  return null;
}

// Does it, for something find() returned. Resolves with { ok } or { error }.
async function perform(kind, name) {
  try {
    if (kind === 'open') {
      const target = (await installed()).get(name);
      if (!target) return { error: 'notFound' };
      const failed = await shell.openPath(target);
      return failed ? { error: failed } : { ok: true };
    }
    if (kind === 'shortcut') {
      if (!(await shortcuts()).has(name)) return { error: 'notFound' };
      await exec('/usr/bin/shortcuts', ['run', name]);
      return { ok: true };
    }
    if (kind === 'media') {
      const arg = mediaArg(name);
      return arg ? await media(arg) : { error: 'notFound' };
    }
    return { error: 'unknown action' };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { available, find, perform };
