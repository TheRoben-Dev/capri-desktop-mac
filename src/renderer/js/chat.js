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
const NAMES_MAX = 200; // installed apps named to the model, at most
// "close", "shut down", "ferme", "quitte", "cierra", "fecha", "закрой"... in any of her languages
const CLOSE_ASK = /\b(close|shut|quit|kill|exit)|ferm|quitt|coupe|arr[êe]t|cierr|cerra|fech|закр|выключ/i;

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
    this.actions = { open: [], shortcut: [], media: [] }; // the rest she can do here (actions.js)
    this.appsReady = Promise.resolve();
    host.onChatDelta(({ id, text }) => this.onDelta(id, text));
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
    const res = await this.host.chatSend({ id, messages });
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
    this.panel.stream(answer, { done: true });
    this.panel.setFace(mood(answer));
    this.panel.setChatBusy(false);
    // what you asked for first (a small model doesn't always write its tag right), else its tag
    const wanted = this.askedToClose(text);
    const tag = tagged(res.text);
    if (wanted) this.offerClose(wanted, answer);
    else if (tag?.kind === 'close') this.offerClose(tag.name, answer);
    else if (tag) this.offerAction(tag.kind, tag.name, answer);
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
  async offerAction(kind, wanted, answer) {
    const { t } = this;
    const name = await this.host.findAction(kind, wanted);
    if (!this.open || this.turn) return;
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
    const { open, shortcut, media } = this.actions;
    const can = [];
    if (this.apps.length) {
      const running = this.apps.map(({ name, label }) => (label && label !== name ? `${name} (${label})` : name)).join(', ');
      can.push(`Close an app that's open: [[close: NAME]], NAME being the exact name from this list (the part before the parentheses): ${running}.`);
    }
    if (open.length) can.push(`Open an installed app: [[open: NAME]], NAME from: ${open.slice(0, NAMES_MAX).join(', ')}.`);
    if (shortcut.length) can.push(`Run one of their Shortcuts: [[shortcut: NAME]], NAME from: ${shortcut.join(', ')}.`);
    if (media.length) can.push(`Control the music and the volume: [[media: WHAT]], WHAT one of: ${media.join(', ')}.`);
    if (!can.length) return [`You can't do anything on the user's computer here, and ${cant}`];
    return [
      'What you can do on the user\'s computer, only when they ask you to:',
      ...can,
      'Then say in a few words that you will, and end your answer with that one tag. They get a button to confirm it, so never say it\'s already done.',
      `Apart from that, ${cant}`,
    ];
  }

  onDelta(id, piece) {
    if (id !== this.turn) return;
    this.answer += piece;
    this.panel.stream(clean(this.answer));
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
    .replace(/\[\[[^\]]*(\]\]|$)/g, '') // her action tag (read from the raw answer, never shown)
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
