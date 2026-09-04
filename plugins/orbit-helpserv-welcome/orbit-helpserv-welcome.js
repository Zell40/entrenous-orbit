/*
 * Orbit ↔ HelpServ welcome — when the user opens a query (PV) with a configured
 * HelpServ desk bot, inject local PRIVMSG-looking lines from the bot (no IRC).
 *
 * Profile "Signaler" uses config.report.query (SignalMoi): openQuery + a
 * natural-language draft naming the nick (no REPORT command). The bot opens
 * the ticket after the user's first real message.
 *
 * config.json:
 *   "report": { "query": "SignalMoi", ... }
 *   "helpservWelcome": {
 *     "bots": [
 *       { "nick": "AideMoi", "needle": "…", "lines": ["…", "…"] },
 *       { "nick": "SignalMoi", "needle": "…", "lines": ["…"] },
 *       { "nick": "EcoutE", "needle": "…", "lines": ["…"] }
 *     ]
 *   }
 *   "plugins": [".../orbit-helpserv-welcome.js?v=6"]
 *
 * In lines, {{nick}} is replaced with the user's nick. Omit helpservWelcome
 * (or bots) to use the built-in AideMoi / SignalMoi / EcoutE defaults.
 */
Orbit.plugin('helpserv-welcome', (orbit, log) => {
  const B = '\x02'; // IRC bold
  const R = '\x0f'; // IRC reset

  /** @type {Set<string>} */
  const welcomed = new Set();

  function fold(name) {
    return String(name || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
  }

  function aideGuide() {
    return [
      'Avant d\'ouvrir un ticket, jetez un œil à la documentation EntreNous :',
      '',
      `${B}Aide générale${R} — prise en main du tchat`,
      'https://www.reseau-entrenous.fr/aide/',
      '',
      `${B}Webchat${R} — connexion et interface`,
      'https://www.reseau-entrenous.fr/aide/webchat/',
      '',
      `${B}NickServ${R} — protéger et gérer son pseudo`,
      'https://www.reseau-entrenous.fr/aide/nickserv/',
      '',
      `${B}Gaya${R} — bots des salons personnels`,
      'https://www.reseau-entrenous.fr/aide/gaya/',
      '',
      `${B}Serveur${R} — fonctionnement du réseau`,
      'https://www.reseau-entrenous.fr/aide/aide-serveur/',
      '',
      'Si ces pages ne suffisent pas, décrivez votre problème (pseudo, salon, connexion, erreur).',
      'Un ticket sera ouvert uniquement lorsque la demande sera claire.',
    ].join('\n');
  }

  /** Built-in desks when config.helpservWelcome.bots is absent/empty. */
  function defaultBots() {
    return [
      {
        nick: 'AideMoi',
        needle: 'reseau-entrenous.fr/aide/',
        lines: [
          'Bonjour {{nick}}, comment puis-je vous aider ?',
          aideGuide(),
        ],
      },
      {
        nick: 'SignalMoi',
        needle: 'Ne discutez pas des signalements en public',
        lines: [
          'Bonjour {{nick}}, comment puis-je vous aider pour ce signalement ?',
          'Expliquez la situation (pseudo concerné, salon, ce qui s\'est passé). Dès votre premier message, le bot ouvrira le suivi automatiquement.\n\nNe discutez pas des signalements en public.',
        ],
      },
      {
        nick: 'EcoutE',
        needle: 'idée ou un avis',
        lines: [
          'Bonjour {{nick}}, merci de partager une idée ou un avis.',
          'Décrivez votre suggestion en quelques mots (amélioration, nouveau salon, fonctionnalité…). Un ticket sera ouvert dès que le message sera clair.\n\nL\'équipe lit toutes les idées via HelpServ.',
        ],
      },
    ];
  }

  function loadBots() {
    const cfg = (orbit.config() && orbit.config().helpservWelcome) || {};
    const raw = Array.isArray(cfg.bots) ? cfg.bots : null;
    const list = (raw && raw.length) ? raw : defaultBots();
    /** @type {Map<string, { nick: string, needle: string, lines: string[] }>} */
    const map = new Map();
    for (const b of list) {
      if (!b || !b.nick) continue;
      const nick = String(b.nick).trim();
      const lines = Array.isArray(b.lines) ? b.lines.map(String).filter(Boolean) : [];
      if (!nick || !lines.length) continue;
      map.set(fold(nick), {
        nick,
        needle: String(b.needle || lines[0] || nick),
        lines,
      });
    }
    return map;
  }

  function expandLines(lines, nick) {
    const who = (nick || '').trim() || 'toi';
    return lines.map((l) => l.replace(/\{\{\s*nick\s*\}\}/gi, who));
  }

  function bufferHasNeedle(st, key, needle) {
    if (!needle) return false;
    const buffers = (st && st.buffers) || {};
    for (const k of Object.keys(buffers)) {
      if (fold(k) !== key && fold(buffers[k] && buffers[k].name) !== key) continue;
      const msgs = (buffers[k] && buffers[k].messages) || [];
      if (msgs.some((m) => m && typeof m.text === 'string' && m.text.includes(needle))) return true;
    }
    return false;
  }

  function resolveName(st, target, key) {
    const buffers = (st && st.buffers) || {};
    for (const k of Object.keys(buffers)) {
      if (fold(k) === key || fold(buffers[k] && buffers[k].name) === key) {
        return (buffers[k] && buffers[k].name) || k;
      }
    }
    return target;
  }

  function injectLines(name, bot, lines) {
    const st = orbit.state.get();
    if (!st) {
      console.warn('[helpserv-welcome] no chat state');
      return false;
    }
    if (typeof st.openQuery === 'function') {
      try { st.openQuery(name); } catch (e) { log('openQuery failed', e); }
    }
    if (typeof st.pushLocal === 'function') {
      for (const line of lines) st.pushLocal(name, line, bot, 'privmsg');
      return true;
    }
    console.warn('[helpserv-welcome] pushLocal missing — redeploy Orbit');
    return false;
  }

  function showWelcome(target) {
    const bots = loadBots();
    const key = fold(target);
    const desk = bots.get(key);
    if (!desk) return;
    if (welcomed.has(key)) return;

    const nick = orbit.state.nick() || '';

    // Defer so openQuery/setActive (and setDraft from reportUser) have committed.
    setTimeout(() => {
      if (welcomed.has(key)) return;
      const st = orbit.state.get();
      if (bufferHasNeedle(st, key, desk.needle)) {
        welcomed.add(key);
        return;
      }
      const name = resolveName(st, target, key);
      const ok = injectLines(name, desk.nick, expandLines(desk.lines, nick));
      welcomed.add(key);
      if (ok) log('welcome privmsg for', name);
    }, 0);
  }

  orbit.on('buffer.active', (name) => {
    if (!name || String(name).charAt(0) === '#' || String(name).charAt(0) === '&') return;
    showWelcome(name);
  });

  const cur = orbit.state.active();
  if (cur) showWelcome(cur);
  log('helpserv-welcome ready (privmsg), desks=', [...loadBots().keys()].join(','));
});
