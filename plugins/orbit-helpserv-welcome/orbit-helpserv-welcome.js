/*
 * Orbit ↔ HelpServ welcome — when the user opens a query (PV) with AideMoi
 * or SignalMoi, inject local PRIVMSG-looking lines from the bot (no IRC).
 *
 * Profile "Signaler" uses config.report.query (SignalMoi): openQuery + a
 * natural-language draft naming the nick (no REPORT command). The bot opens
 * the ticket after the user's first real message.
 *
 * config.json:
 *   "report": { "query": "SignalMoi", ... }
 *   "plugins": [".../orbit-helpserv-welcome.js?v=4"]
 */
Orbit.plugin('helpserv-welcome', (orbit, log) => {
  const AIDE = 'aidemoi';
  const SIGNAL = 'signalmoi';

  const HELP_LINKS = [
    'Besoin d\'aide? Visitez https://www.reseau-entrenous.fr/aide/ pour trouver de l\'aide à l\'utilisation du tchat EntreNous.',
    'Le webchat : https://www.reseau-entrenous.fr/aide/webchat/',
    'Les services des pseudos NickServ : https://www.reseau-entrenous.fr/aide/nickserv/',
    'Le bot des salons personnels Gaya : https://www.reseau-entrenous.fr/aide/gaya/',
    'Comprendre le fonctionnement du serveur de tchat EntreNous : https://www.reseau-entrenous.fr/aide/aide-serveur/',
  ];

  /** @type {Set<string>} */
  const welcomed = new Set();

  function fold(name) {
    return String(name || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
  }

  function whichDesk(name) {
    const n = fold(name);
    if (n === AIDE) return 'aide';
    if (n === SIGNAL) return 'signal';
    return null;
  }

  function botLabel(desk) {
    return desk === 'aide' ? 'AideMoi' : 'SignalMoi';
  }

  function linesFor(desk, nick) {
    const who = (nick || '').trim() || 'toi';
    if (desk === 'aide') {
      return [
        `Bonjour ${who}, comment puis-je vous aider ?`,
        ...HELP_LINKS,
        'Si ces pages ne suffisent pas, décrivez votre problème (pseudo, salon, connexion, erreur) : un ticket sera ouvert uniquement quand la demande sera claire.',
      ];
    }
    return [
      `Bonjour ${who}, comment puis-je vous aider pour ce signalement ?`,
      'Expliquez la situation (pseudo concerné, salon, ce qui s\'est passé). Dès votre premier message, le bot ouvrira le suivi automatiquement.',
      'Ne discutez pas des signalements en public.',
    ];
  }

  function bufferHasNeedle(st, key, needle) {
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
    const desk = whichDesk(target);
    if (!desk) return;
    const key = fold(target);
    if (welcomed.has(key)) return;

    const bot = botLabel(desk);
    const nick = orbit.state.nick() || '';
    const needle = desk === 'aide'
      ? 'reseau-entrenous.fr/aide/'
      : 'Ne discutez pas des signalements en public';

    // Defer so openQuery/setActive (and setDraft from reportUser) have committed.
    setTimeout(() => {
      if (welcomed.has(key)) return;
      const st = orbit.state.get();
      if (bufferHasNeedle(st, key, needle)) {
        welcomed.add(key);
        return;
      }
      const name = resolveName(st, target, key);
      const ok = injectLines(name, bot, linesFor(desk, nick));
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
  log('helpserv-welcome ready (privmsg)');
});
