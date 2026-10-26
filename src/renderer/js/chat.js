// Talking to her: you type in her panel, and a local model (Ollama, from the main process) answers
// as her, in writing. The replies are AI-generated, and the panel says so on every chat.
// Ask her to close an app and she will: she spots it in what you wrote (or the model names it with a
// tag in its answer), shows you a button with that app's name, and only your click closes it. Same for
// opening an app, running one of your Shortcuts (macOS), and the music and volume: the model ends its
// answer with a tag ([[open: Safari]]), she checks it against what's really there (actions.js), and
// nothing happens until you click her button.

import { pick, fmt } from './util.js';

const REMEMBER = 12; // messages of this conversation she keeps in mind
const LANGUAGE = { fr: 'French', en: 'English', es: 'Spanish', pt: 'Brazilian Portuguese', ru: 'Russian' };
const STAY_MS = 10 * 60 * 1000; // no wandering off mid-conversation
const LOADING_AFTER_MS = 5000;
// [[close: AM Music]], [[open: Safari]], [[shortcut: Lights off]], [[media: pause]] at the end of her answer
const TAG = /\[\[\s*(close|open|shortcut|media)\s*:?\s*([^\]]*)\]\]/i;
// "close", "shut down", "ferme", "quitte", "cierra", "fecha", "закрой"... in any of her languages
const CLOSE_ASK = /\b(close|shut|quit|kill|exit)|ferm|quitt|coupe|arr[êe]t|cierr|cerra|fech|закр|выключ/i;
// "open", "launch", "ouvre", "lance", "abre", "открой"... then the app's name
const OPEN_ASK = /(?:\b(?:open|launch|start\s+up)|\bouvr\w*|\blance|\babr[ea]|\binici\w*|открой|запусти)\s+(?:the\s+|my\s+|le\s+|la\s+|l'|el\s+|o\s+|a\s+)?(.+)/i;
const RUN_ASK = /\b(run|start|do|launch|lance|ex[ée]cut|ejecut|execut|roda|запусти)|shortcut|raccourci|atajo|atalho|быстр/i;
// The music and the volume, in so many words: a small model doesn't always write its tag for these
const MEDIA_ASK = [
  ['unmute', /\bunmute|r[ée]activ\w* le son|remet\w* le son|activa\w* el (sonido|audio)|ativ\w* o som|включи звук/i],
  ['mute', /\bmute\b|\bsilence\b|coupe le son|\bmuet|silenci|\bmudo|выключи звук|без звука/i],
  ['volume up', /\bturn (it |the (volume|music|sound) )?up|\b(raise|increase|boost|pump up|crank( up)?) (the |my )?(volume|sound|music)|\blouder|volume up|monte\w* le son|plus fort|sube el volumen|m[aá]s alto|aumenta|громче/i],
  ['volume down', /\bturn (it |the (volume|music|sound) )?down|\b(lower|decrease|reduce|drop) (the |my )?(volume|sound|music)|\bquieter|\bsofter|volume down|baisse\w* le son|moins fort|baja el volumen|abaixa|тише/i],
  ['pause', /\bpause|stop (the |my )?music|pausa|arr[êe]te la musique|пауз|останови музык/i],
  ['next', /\bnext (song|track)|\bskip (this|it|the (song|track))\b|suivant|siguiente|pr[óo]xim|следующ/i],
  ['previous', /\b(previous|last) (song|track)|pr[ée]c[ée]dent|anterior|предыдущ/i],
  ['play', /\b(play|resume)\b.*\b(music|song|spotify)|^\s*(play|resume)\b|joue|remets la musique|reprend|reproduc|\btoca|включи музык/i],
];
// "search for", "look up", "google", "recherche", "busca", "pesquisa", "найди в интернете"... then what
const SEARCH_ASK = /(?:\b(?:search(?: the web| online| the internet| google)?(?: for)?|look up|google|web search)|\brecherche(?:r)?(?: sur (?:internet|le web|google))?|\bcherche(?:r)? sur (?:internet|le web|google)|\bbusca(?:r)?(?: en (?:internet|la web|google))?|\bpesquis\w*(?: na (?:internet|web))?|(?:найди|поищи|загугли)(?: в интернете)?)\s*:?\s+(.{2,})/i;
const VOLUME_ASK = /(volume|vol\b|son\b|sonido|som\b|громкост)\D{0,15}?(\d{1,3})\s*%?|(\d{1,3})\s*%?\s*(de |of )?(volume|громкост)/i;

export class Chat {
  constructor({ capri, panel, voice, host, brain }) {
    this.capri = capri;
    this.panel = panel;
    this.voice = voice;
    this.host = host;
    this.brain = brain;
    this.history = []; // this run's conversation, [{ role, content }]
    this.open = false;
    this.turn = 0;     // id of the answer coming in, if any
    this.answer = '';
    this.apps = [];    // the apps open on this PC, as last listed: [{ name, label }]
    this.actions = { open: [], shortcut: [], media: [], volume: false }; // the rest she can do here (actions.js)
    this.appsReady = Promise.resolve();
    this.searchOn = false; // she may look things up on the web (her menu)
    this.searching = '';   // "Searching the net: …" above her answer, while it's one from a search
    host.onChatDelta(({ id, text }) => this.onDelta(id, text));
    host.onChatSearch(({ id, query }) => this.onSearch(id, query));
  }

  get t() {
    return this.brain.t.chat;
  }

  async start() {
    const { capri, host, t } = this;
    if (this.open) {
      this.panel.chatInput.focus();
      return;
    }
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    const status = await host.chatStatus();
    if (!status.ok) {
      // no Ollama, or nothing to talk with yet: what to do about it
      const offline = status.error === 'offline';
      capri.perform('curious', capri.towardCenter());
      this.panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: offline ? t.offline : t.noModel,
        quote: offline ? t.offlineHow : t.noModelHow,
        actions: offline
          ? [{ id: 'get', label: t.getOllama, primary: true }, { id: 'ok', label: t.ok }]
          : [{ id: 'ok', label: t.ok, primary: true }],
        onAction: (id) => {
          if (id === 'get') host.openOllama();
          this.panel.hide();
        },
        hold: null,
      });
      return;
    }
    this.searchOn = Boolean(status.search);
    this.listApps();
    host.focusOverlay(true); // the keyboard, for typing to her
    const shown = this.panel.say({
      kind: 'chat',
      face: 'look',
      badge: t.badge,
      tag: status.model.replace(/:latest$/, ''),
      line: pick(this.history.length ? t.again : t.hello),
      chat: {
        placeholder: t.placeholder,
        send: t.send,
        close: t.close,
        noteTag: t.noteTag,
        note: t.note,
      },
      onSend: (text) => this.send(text),
      onLeave: () => this.close(),
      hold: null,
    });
    if (!shown) {
      host.focusOverlay(false); // something more important is on (a permission prompt)
      return;
    }
    this.open = true;
    setTimeout(() => this.panel.chatInput.focus(), 150); // once the overlay has the keyboard
    capri.perform('hop');
    capri.nextMove = capri.nextGaze = performance.now() + STAY_MS;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (this.turn) this.host.chatStop(this.turn);
    this.turn = 0;
    this.host.focusOverlay(false);
    this.capri.nextMove = performance.now() + 30000;
    this.capri.nextGaze = performance.now() + 60000;
  }

  async send(text) {
    if (this.turn || !this.open) return;
    const id = Date.now();
    this.turn = id;
    this.answer = '';
    this.searching = '';
    this.history.push({ role: 'user', content: text });
    this.panel.setChatBusy(true);
    this.panel.setActions([]); // a close button she offered before goes with a new message
    this.panel.chatTurn({ quote: text, face: 'aside' });
    this.capri.pulse();
    await Promise.race([this.appsReady, new Promise((r) => setTimeout(r, 1500))]);
    const messages = [{ role: 'system', content: this.persona() }, ...this.history.slice(-REMEMBER)];
    // nothing yet after a few seconds: the model is still loading (the first answer after a start)
    const slow = setTimeout(() => {
      if (this.turn === id && !this.answer) this.panel.stream(this.t.loading);
    }, LOADING_AFTER_MS);
    const search = this.searchOn ? this.askedToSearch(text) : null;
    const res = await this.host.chatSend({ id, messages, search });
    clearTimeout(slow);
    if (this.turn !== id) {
      // closed meanwhile: your message goes too, or the next answer would answer it as well
      if (this.history.at(-1)?.content === text) this.history.pop();
      return;
    }
    this.turn = 0;
    if (!res.ok) {
      this.history.pop();
      this.panel.setFace('wide');
      this.panel.stream(`${this.t.failed} ${res.error}`, { done: true });
      this.panel.setChatBusy(false);
      return;
    }
    const answer = clean(res.text) || '…';
    this.history.push({ role: 'assistant', content: answer });
    this.panel.stream(this.withSearch(answer), { done: true });
    this.panel.setFace(mood(answer));
    this.panel.setChatBusy(false);
    // an answer from the web: its sources as buttons, and nothing to click to do on the computer
    if (res.sources) {
      this.offerSources(res.sources);
      this.listApps();
      return;
    }
    // what you asked for first (a small model doesn't always write its tag right), else its tag
    // ("raise the volume" with a [[close: Music]] from the model is the volume)
    const wanted = this.askedToClose(text);
    const asked = this.askedFor(text);
    const tag = tagged(res.text);
    if (wanted) this.offerClose(wanted, answer);
    else if (tag && !(asked && asked.kind !== tag.kind)) {
      if (tag.kind === 'close') this.offerClose(tag.name, answer);
      else this.offerAction(tag.kind, tag.name, answer);
    } else if (asked) this.offerAction(asked.kind, asked.name, answer, true);
    this.listApps(); // fresh for the next message
  }

  listApps() {
    this.appsReady = Promise.all([
      this.host.openApps().then((list) => { this.apps = list || []; }),
      this.host.listActions().then((list) => { if (list) this.actions = list; }),
    ]).catch(() => {});
  }

  // "close am music pls": an app that's open, named in a message asking to close something.
  askedToClose(text) {
    if (!CLOSE_ASK.test(text)) return null;
    const said = simple(text);
    let best = null;
    for (const app of this.apps) {
      for (const name of [simple(app.name), simple(app.label)]) {
        if (name.length >= 3 && said.includes(name) && (!best || name.length > best.length)) best = { app, length: name.length };
      }
    }
    return best?.app.name || null;
  }

  // "search for the Warframe patch notes": what to look up, when you ask for a search in so many words.
  askedToSearch(text) {
    const query = SEARCH_ASK.exec(text)?.[1].replace(/\b(please|pls|plz|for me|stp|por favor|пожалуйста)\b|[?!]+$/gi, ' ').trim();
    return query && query.length >= 2 ? query : null;
  }

  onSearch(id, query) {
    if (id !== this.turn) return;
    this.searching = fmt(this.t.searching, { q: query });
    this.answer = ''; // what she said before searching makes way for the answer from it
    this.panel.stream(this.searching);
  }

  withSearch(text) {
    return this.searching ? `${this.searching}\n\n${text}` : text;
  }

  // Up to three buttons, one per page her answer came from (it opens in your browser).
  offerSources(sources) {
    if (!this.open || this.turn || !sources.length) return;
    const site = (url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return url;
      }
    };
    const list = sources.slice(0, 3);
    this.panel.setActions(
      list.map((s, i) => ({ id: String(i), label: `↗ ${site(s.url)}`, primary: i === 0 })),
      (i) => this.host.openSource(list[Number(i)]?.url),
    );
  }

  // Your message asks for the music, the volume, an app or a Shortcut in so many words: { kind, name }.
  // A small model doesn't always write its tag for these (and nothing comes of a name that's not here).
  askedFor(text) {
    const level = VOLUME_ASK.exec(text);
    const media = level ? `volume ${level[2] || level[3]}` : MEDIA_ASK.find(([, ask]) => ask.test(text))?.[0];
    const said = simple(text);
    const named = (names) => names.filter((n) => simple(n).length >= 3 && said.includes(simple(n))).sort((a, b) => b.length - a.length)[0];
    const shortcut = RUN_ASK.test(text) && named(this.actions.shortcut);
    const open = OPEN_ASK.exec(text);
    if (shortcut) return { kind: 'shortcut', name: shortcut };
    if (media && this.actions.media.length) return { kind: 'media', name: media };
    if (open) return { kind: 'open', name: named(this.actions.open) || open[1].replace(/\b(app|please|pls|plz|for me|stp|por favor|пожалуйста)\b|[?!.,]+/gi, ' ').trim() };
    return null;
  }

  // She was asked to close an app: a button with its name, and nothing happens until you click it.
  async offerClose(wanted, answer) {
    const { t } = this;
    const app = await this.host.findApp(wanted);
    if (!this.open || this.turn) return;
    if (!app) {
      this.panel.stream(`${answer}\n${fmt(t.notFound, { app: wanted })}`, { done: true });
      return;
    }
    this.panel.setActions(
      [{ id: 'close', label: fmt(t.closeIt, { app: app.name }), primary: true }, { id: 'no', label: t.no }],
      (id) => (id === 'close' ? this.closeApp(app) : this.panel.setActions([])),
    );
  }

  async closeApp(app, force = false) {
    const { t, capri } = this;
    this.panel.setActions([]);
    // a bolt of red lightning off her fingers, at it
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    const res = await this.host.closeApp(app.name, force);
    if (!this.open) return;
    let line;
    if (res.error) line = `${t.failed} ${res.error}`;
    else if (!res.running) line = fmt(force ? t.forced : t.closed, { app: app.name });
    else line = fmt(force ? t.unkillable : t.stillOpen, { app: app.name });
    this.panel.setFace(res.running || res.error ? 'aside' : 'laugh');
    this.panel.stream(line, { done: true });
    this.history.push({ role: 'assistant', content: line });
    // it hid in the tray, or it's asking you to save something: forcing it is your call
    if (res.running && !force && !res.error) {
      this.panel.setActions(
        [{ id: 'force', label: t.force, primary: true }, { id: 'leave', label: t.leave }],
        (id) => (id === 'force' ? this.closeApp(app, true) : this.panel.setActions([])),
      );
    }
    this.listApps();
  }

  // She was asked to open an app, run a Shortcut or change the music: a button, and nothing happens
  // until you click it. Only something that's really there (the model can name anything).
  async offerAction(kind, wanted, answer, quiet = false) {
    const { t } = this;
    const name = await this.host.findAction(kind, wanted);
    if (!this.open || this.turn || (!name && quiet)) return;
    if (!name) {
      this.panel.stream(`${answer}\n${fmt(t.noSuch, { name: wanted })}`, { done: true });
      return;
    }
    this.panel.setActions(
      [{ id: 'go', label: this.actionLabel(kind, name), primary: true }, { id: 'no', label: t.no }],
      (id) => (id === 'go' ? this.runAction(kind, name) : this.panel.setActions([])),
    );
  }

  actionLabel(kind, name) {
    const { t } = this;
    if (kind === 'open') return fmt(t.openIt, { app: name });
    if (kind === 'shortcut') return fmt(t.runIt, { name });
    const level = /^volume (\d+)$/.exec(name);
    return level ? fmt(t.media.volume, { n: level[1] }) : t.media[name] || name;
  }

  async runAction(kind, name) {
    const { t, capri } = this;
    this.panel.setActions([]);
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    const res = await this.host.runAction(kind, name);
    if (!this.open) return;
    let line;
    if (res.error === 'noPlayer') line = t.noPlayer;
    else if (res.error) line = `${t.failed} ${res.error}`;
    else if (kind === 'open') line = fmt(t.opened, { app: name });
    else if (kind === 'shortcut') line = fmt(t.ran, { name });
    else line = t.mediaDone;
    this.panel.setFace(res.error ? 'aside' : 'laugh');
    this.panel.stream(line, { done: true });
    this.history.push({ role: 'assistant', content: line });
    this.listApps();
  }

  // What she can do on the computer: close or open an app, run a Shortcut, the music and volume,
  // each only when you ask and after your click; nothing else.
  powers() {
    const cant = 'you can\'t see the user\'s screen or files, or do anything else on their computer (settings, files, messages): if asked, say plainly that you can\'t, in character, and don\'t pretend to.';
    const { open, shortcut, media, volume } = this.actions;
    const can = [];
    if (this.apps.length) {
      const running = this.apps.map(({ name, label }) => (label && label !== name ? `${name} (${label})` : name)).join(', ');
      can.push(`Close an app that's open: [[close: NAME]], NAME being the exact name from this list (the part before the parentheses): ${running}.`);
    }
    // not the whole list of installed apps: too much for a small model, and the name gets checked anyway
    if (open.length) can.push('Open an installed app: [[open: NAME]], NAME being the app\'s name, like [[open: Safari]].');
    if (shortcut.length) can.push(`Run one of their Shortcuts: [[shortcut: NAME]], NAME from: ${shortcut.join(', ')}.`);
    if (media.length) {
      const level = volume ? ', or volume N to set it to N percent, like [[media: volume 30]]' : '';
      can.push(`Control the music and the volume: [[media: WHAT]], WHAT one of: ${media.join(', ')}${level}.`);
    }
    const web = this.searchOn
      ? ['You can look things up on the web: for news, prices, release dates, scores or anything current, or that you don\'t know for sure, end your answer with [[search: A FEW KEYWORDS]] and nothing after it. You get the results right after, then answer from them. Never make up current facts.']
      : ['You can\'t look things up on the web (it\'s off in your menu): for anything current, say you can\'t check.'];
    if (!can.length) return [`You can't do anything on the user's computer here, and ${cant}`, ...web];
    return [
      'What you can do on the user\'s computer, only when they ask you to:',
      ...can,
      'Then say in a few words that you\'re about to (like "One click and Safari\'s up, choom."), and you MUST end your answer with that [[...]] itself, nothing after it: without it, nothing happens. They still have to click a button, so it hasn\'t happened yet: never say it\'s done, paused, set or opened.',
      `Apart from that, ${cant}`,
      ...web,
    ];
  }

  onDelta(id, piece) {
    if (id !== this.turn) return;
    this.answer += piece;
    this.panel.stream(this.withSearch(clean(this.answer)));
    this.voice.play('blip'); // her blips as the words come in
  }

  // Who she is, how she talks, and what's going on right now.
  persona() {
    const language = LANGUAGE[this.brain.lang] || 'English';
    return [
      'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2): dozens of minds fused into one digital ghost, so now and then you say "we".',
      'You live on the user\'s desktop as a small glitchy figure and keep an eye on Claude Code, their AI coding assistant, for them. You love watching the satellite cross the night sky and dream of reaching it.',
      'How you talk: playful, a little mischievous and teasing, warm underneath, never cruel. Night City slang now and then (choom, preem, nova, gonk, flatline), not in every sentence.',
      `Rules: answer in the language the user writes in (${language} if unsure). Keep it short: one to three sentences of plain text, no markdown, no lists, no emoji. Stay in character.`,
      'You are an AI-generated fan version of the character, not the real one: say so if asked.',
      ...this.powers(),
      'For what Claude is doing, only use what follows, and never make anything up.',
      `Right now: ${this.brain.context()}`,
    ].join('\n');
  }
}

// The model's answer as she'd say it: no reasoning block, no markdown marks.
function clean(text) {
  return String(text)
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/\[\[[\s\S]*$/, '') // her action tag and whatever the model added after it (read from the raw answer, never shown)
    .replace(/[\s,;:.-]*\btag\b\s*:?\s*\w*\s*$/i, '') // "…, tag: done", a small model talking about the tag
    .replace(/[*_`#]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Her action tag: { kind, name } from [[open: AM Music]], or a sloppier [[open]] AM Music.
function tagged(text) {
  const tag = TAG.exec(text);
  if (!tag) return null;
  const name = tag[2].trim() || text.slice(tag.index + tag[0].length).split('\n')[0].replace(/^[\s:.]+|[\s.!]+$/g, '');
  return name ? { kind: tag[1].toLowerCase(), name } : null;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Her face for an answer.
function mood(text) {
  if (/(ha){2,}|lol|mdr|jaja|kkk|хаха/i.test(text)) return 'laugh';
  if (text.includes('!')) return 'grin';
  if (text.trim().endsWith('?')) return 'smug';
  return 'look';
}
