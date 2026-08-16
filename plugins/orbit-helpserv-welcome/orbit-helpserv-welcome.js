/*
 * Orbit ↔ HelpServ welcome — when the user opens a query (PV) with AideMoi
 * or SignalMoi, show the same pre-ticket guidance HelpServ would send, so
 * they see help links / report instructions before typing.
 *
 * Does not open tickets and does not send IRC traffic; local system lines only.
 * Real ticket flow stays in the Anope HelpServ module.
 *
 * Configure in config.json:
 *   "plugins": [..., "/app/plugins/third/orbit-helpserv-welcome/orbit-helpserv-welcome.js"]
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
      `Bonjour ${who}. Dès que vous aurez envoyé votre premier message décrivant le signalement, l'équipe interviendra rapidement.`,
      'Ne discutez pas des signalements en public.',
      'Pour déposer un signalement, tapez REPORT pseudo [#salon] raison (ou SIGNALER). Une fois le ticket ouvert, envoyez les preuves ici en message privé.',
    ];
  }

  function alreadyHasWelcome(buf, desk) {
    const msgs = (buf && buf.messages) || [];
    const needle = desk === 'aide' ? 'reseau-entrenous.fr/aide/' : 'SIGNALER';
    return msgs.some((m) => m && typeof m.text === 'string' && m.text.includes(needle));
  }

  function showWelcome(target) {
    const desk = whichDesk(target);
    if (!desk) return;
    const key = fold(target);
    if (welcomed.has(key)) return;

    const st = orbit.state.get();
    if (!st || typeof st.pushSystem !== 'function') {
      log('pushSystem unavailable — skip welcome');
      return;
    }

    // Prefer the live buffer name (case) if it already exists.
    const buffers = st.buffers || {};
    let name = target;
    for (const k of Object.keys(buffers)) {
      if (fold(k) === key || fold(buffers[k] && buffers[k].name) === key) {
        name = (buffers[k] && buffers[k].name) || k;
        break;
      }
    }

    const existing = buffers[key] || buffers[name] || null;
    if (alreadyHasWelcome(existing, desk)) {
      welcomed.add(key);
      return;
    }

    if (typeof st.openQuery === 'function') st.openQuery(name);

    const nick = orbit.state.nick() || '';
    for (const line of linesFor(desk, nick)) {
      st.pushSystem(name, line);
    }
    welcomed.add(key);
    log('welcome shown for', name);
  }

  orbit.on('buffer.active', (name) => {
    if (!name || String(name).charAt(0) === '#') return;
    showWelcome(name);
  });

  // In case the buffer was already active when the plugin loaded.
  const cur = orbit.state.active();
  if (cur) showWelcome(cur);
});
