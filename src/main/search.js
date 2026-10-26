'use strict';

// Looking things up on the web for her chat: a search, then the text of the first pages, handed to
// the model so it answers from them and names its sources. Read-only: nothing is sent anywhere but
// the search itself (and a plain GET of those pages). DuckDuckGo needs no key; a Brave Search API
// key or a SearXNG instance in her settings file is used instead when there is one.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SEARCH_MS = 8000;
const PAGE_MS = 5000;
const RESULTS = 5;     // results given to the model
const PAGES = 2;       // of which this many get their page read too
const PAGE_CHARS = 1800;
const HTML_MAX = 1500000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// text only: the tags inside a line (<b>…</b>) go without a trace, the others leave a space
const plain = (html) => decode(String(html || '').replace(/<\/?(b|i|em|strong|span|a|mark|small|sup|sub|abbr|code)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function withTimeout(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

// Which search engine: Brave with a key, else a SearXNG instance if set, else DuckDuckGo.
function engine(cfg) {
  if (cfg.braveKey) return 'Brave';
  if (cfg.searxngUrl) return 'SearXNG';
  return 'DuckDuckGo';
}

async function duckduckgo(query, signal) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'text/html' },
    body: new URLSearchParams({ q: query }),
    signal: withTimeout(signal, SEARCH_MS),
  });
  if (!res.ok) throw new Error(`DuckDuckGo answered ${res.status}`);
  const html = await res.text();
  // each result: <a class="result__a" href="//duckduckgo.com/l/?uddg=REAL_URL...">title</a>, then its
  // <a class="result__snippet">; the ads link through duckduckgo.com/y.js and are left out
  const links = [...html.matchAll(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/g)];
  const results = [];
  links.forEach((link, i) => {
    const href = decode(/href="([^"]*)"/.exec(link[0])?.[1] || '');
    let url;
    try {
      const parsed = new URL(href, 'https://duckduckgo.com');
      url = parsed.searchParams.get('uddg') || (parsed.hostname.endsWith('duckduckgo.com') ? null : parsed.href);
    } catch {
      url = null;
    }
    if (!url || /duckduckgo\.com\/y\.js/.test(href)) return;
    const until = links[i + 1]?.index ?? link.index + 4000;
    const block = html.slice(link.index + link[0].length, until);
    const snippet = /<[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/.exec(block)?.[1];
    results.push({ title: plain(link[0]), url, snippet: plain(snippet) });
  });
  if (!results.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('DuckDuckGo wants a captcha right now');
  return results;
}

async function brave(query, key, signal) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(RESULTS + 3) })}`, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: withTimeout(signal, SEARCH_MS),
  });
  if (!res.ok) throw new Error(`Brave Search answered ${res.status}`);
  const json = await res.json();
  return (json.web?.results || []).map((r) => ({ title: plain(r.title), url: r.url, snippet: plain(r.description) }));
}

// The instance has to allow format=json (search.formats in its settings.yml).
async function searxng(query, base, signal) {
  const url = `${String(base).replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: withTimeout(signal, SEARCH_MS) });
  if (!res.ok) throw new Error(`SearXNG answered ${res.status}`);
  const json = await res.json();
  return (json.results || []).map((r) => ({ title: plain(r.title), url: r.url, snippet: plain(r.content) }));
}

// Pages on the web only: not this machine or the local network.
function isPublic(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return !(
    host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')
    || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || host === '::1' || /^f[cd]/.test(host) || /^fe80:/.test(host)
  );
}

// The readable text of a page: its article (or main part) when it has one, without the scripts,
// menus and footers.
async function pageText(url, signal) {
  if (!isPublic(url)) return '';
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,text/plain' },
    redirect: 'follow',
    signal: withTimeout(signal, PAGE_MS),
  });
  if (!res.ok || !isPublic(res.url || url)) return '';
  const type = res.headers.get('content-type') || '';
  if (!/text\/(html|plain)/.test(type)) return '';
  let html = (await res.text()).slice(0, HTML_MAX);
  if (type.includes('text/plain')) return html.replace(/\s+/g, ' ').trim().slice(0, PAGE_CHARS);
  html = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const part = /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] || /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] || html;
  return plain(part).slice(0, PAGE_CHARS);
}

// Searches, and reads the first pages: { query, engine, results: [{ title, url, snippet, text }] }.
async function run(query, cfg, signal) {
  const name = engine(cfg);
  let found;
  if (name === 'Brave') found = await brave(query, cfg.braveKey, signal);
  else if (name === 'SearXNG') found = await searxng(query, cfg.searxngUrl, signal);
  else found = await duckduckgo(query, signal);
  const seen = new Set();
  const results = found.filter((r) => r.url && isPublic(r.url) && !seen.has(r.url) && seen.add(r.url)).slice(0, RESULTS);
  await Promise.all(results.slice(0, PAGES).map(async (r) => {
    r.text = await pageText(r.url, signal).catch(() => '');
  }));
  return { query, engine: name, results };
}

// What the model gets to answer from.
function forModel({ query, engine: name, results }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!results.length) return `Web search (${name}, ${today}) for "${query}": no results. Say you found nothing.`;
  return [
    `Web search (${name}, ${today}) for "${query}". Results, numbered:`,
    ...results.map((r, i) => {
      const site = new URL(r.url).hostname.replace(/^www\./, '');
      return [`[${i + 1}] ${r.title} (${site})`, r.snippet, r.text ? `Page text: ${r.text}` : ''].filter(Boolean).join('\n');
    }),
    'Answer the user from these results only, in character and short (two to four sentences), and name the sites you got it from. If they don\'t answer it, say so instead of guessing.',
  ].join('\n\n');
}

module.exports = { run, forModel, engine, isPublic };
