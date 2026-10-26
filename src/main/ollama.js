'use strict';

// Talking to her: a local model through Ollama (https://ollama.com). Done from here, not from
// the overlay's page, which can't reach other local ports. Everything stays on this machine
// unless OLLAMA_HOST points somewhere else.

function base() {
  let host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace('://0.0.0.0', '://127.0.0.1').replace(/\/+$/, '');
}

// Ollama's errors come as {"error": "..."}
async function failure(res) {
  const body = await res.text().catch(() => '');
  try {
    return new Error(JSON.parse(body).error);
  } catch {
    return new Error(body || `Ollama answered ${res.status}`);
  }
}

// The models installed, by name ("llama3.2:latest"...).
async function models() {
  const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw await failure(res);
  const { models: list = [] } = await res.json();
  return list.map((m) => m.name);
}

// Loads the model into memory ahead of the first message (the first answer after a fresh start
// otherwise waits for it to load, which can take a while).
function warm(model) {
  fetch(`${base()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '15m' }),
  }).catch(() => {});
}

// What a model can do and how big it is: { tools: can call functions, billions: its size }.
const shown = new Map();
async function info(model) {
  if (!shown.has(model)) {
    shown.set(model, (async () => {
      const res = await fetch(`${base()}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw await failure(res);
      const json = await res.json();
      const size = /([\d.]+)\s*B/i.exec(json.details?.parameter_size || '');
      return { tools: (json.capabilities || []).includes('tools'), billions: size ? Number(size[1]) : 0 };
    })().catch(() => {
      shown.delete(model);
      return { tools: false, billions: 0 };
    }));
  }
  return shown.get(model);
}

// Her answer, streamed: onDelta(piece) as it comes, resolves with { text, calls } (calls: the
// functions from `tools` the model asked to run, if any).
async function chat({ model, messages, tools, predict = 240 }, onDelta, signal) {
  const res = await fetch(`${base()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: '15m', // she stays loaded while you chat
      ...(tools?.length ? { tools } : {}),
      options: { temperature: 0.85, num_predict: predict },
    }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const calls = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      const piece = msg.message?.content || ''; // a thinking model's reasoning comes apart, and is left out
      if (piece) {
        text += piece;
        onDelta(piece);
      }
      calls.push(...(msg.message?.tool_calls || []));
      if (msg.done) return { text, calls };
    }
  }
  return { text, calls };
}

module.exports = { models, warm, chat, info };
