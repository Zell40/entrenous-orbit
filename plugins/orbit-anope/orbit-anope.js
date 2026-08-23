/*
 * orbit-anope — NOTICE NickServ/Anope → événements Orbit + CTA invité.
 *
 * Sans NickServ, pas de compte : on ne devine plus l’invité via `account` vide.
 * Anope LineWrappe souvent le message : on fusionne les fragments ~600 ms
 * puis on émet `anope:<kind>` (unregistered, identified, registered, ghost, denied).
 *
 * `anope:unregistered` ouvre le popup « Pseudo non enregistré » (même UI qu’avant).
 *
 * config.json:
 *   "plugins": [".../orbit-anope/orbit-anope.js?v=1"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var DISMISS_KEY = 'orbit-guest-register-dismissed';
  var COALESCE_MS = 600;
  var APOS = "[''\u2018\u2019]";

  Orbit.plugin('orbit-anope', function (orbit, log) {
    var React = orbit.React;
    var h = React.createElement;
    var useSyncExternalStore = React.useSyncExternalStore;

    var pending = [];
    var coalesceTimer = 0;
    var shownUnregistered = false;

    var ui = { nick: '', listeners: new Set() };
    function subscribeUi(cb) { ui.listeners.add(cb); return function () { ui.listeners.delete(cb); }; }
    function uiSnap() { return ui.nick; }
    function setPromptNick(nick) {
      var next = nick || '';
      if (ui.nick === next) return;
      ui.nick = next;
      ui.listeners.forEach(function (l) { l(); });
    }

    function dismissed() {
      try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
    }
    function markDismissed() {
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
      shownUnregistered = true;
      setPromptNick('');
    }

    function classify(text) {
      var t = String(text || '').toLowerCase();
      if (!t.trim()) return 'other';
      if (/password accepted|successfully identified|already identified|now recognized|d[eé]j[aà] identifi/.test(t)) {
        return 'identified';
      }
      if (/(is now registered|est maintenant enregistr|has been registered|a (bien )?été enregistr)/.test(t)
        && !new RegExp('not registered|n' + APOS + '?est pas enregistr', 'i').test(t)) {
        return 'registered';
      }
      if (new RegExp(
        'n' + APOS + '?est pas enregistr|isn' + APOS + '?t registered|not registered'
        + '|pour l' + APOS + '?enregistr|to register (it|this|your)|enregistr(er|ez)-?le'
        + '|reseau-entrenous\\.fr/register|/msg\\s+nickserv\\s+register|/ns\\s+register'
        + '|^\\s*register\\b',
        'i'
      ).test(t)) {
        return 'unregistered';
      }
      if (/\bghost\b/.test(t)) return 'ghost';
      if (/invalid password|wrong password|access denied|authentication failed|mot de passe (invalide|incorrect)|identifi\w+ refus/.test(t)) {
        return 'denied';
      }
      return 'other';
    }

    function payload(kind, text) {
      return { kind: kind, from: 'NickServ', text: text, nick: orbit.state.nick() || '' };
    }

    function onUnregistered(p) {
      if (shownUnregistered || dismissed()) return;
      if (orbit.state.account()) return;
      if ((orbit.config().features || {}).register === false) return;
      shownUnregistered = true;
      setPromptNick(p.nick || orbit.state.nick() || '…');
    }

    function onIdentified() {
      shownUnregistered = false;
      setPromptNick('');
    }

    function flush() {
      coalesceTimer = 0;
      if (!pending.length) return;
      var text = pending.join(' ');
      pending = [];
      var kind = classify(text);
      var p = payload(kind, text);
      orbit.emit('anope:nickserv', p);
      if (kind !== 'other') orbit.emit('anope:' + kind, p);
      if (kind === 'unregistered') onUnregistered(p);
      else if (kind === 'identified' || kind === 'registered') onIdentified();
    }

    function onRaw(msg) {
      if (!msg || String(msg.command || '').toUpperCase() !== 'NOTICE') return;
      if (!/^nickserv$/i.test(String(msg.nick || '').trim())) return;
      var text = (msg.params && msg.params[1]) || '';
      if (!String(text).trim()) return;
      pending.push(text);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flush, COALESCE_MS);
    }

    orbit.on('raw', onRaw);
    orbit.on('status', function (s) {
      if (s === 'registered') return;
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
      shownUnregistered = false;
      setPromptNick('');
    });

    function GuestPrompt() {
      var nick = useSyncExternalStore(subscribeUi, uiSnap);
      if (!nick) return null;
      var cfg = orbit.config() || {};
      var registerUrl = (cfg.branding && cfg.branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
      var title = orbit.i18n.pick({ fr: 'Pseudo non enregistré', en: 'Nickname not registered' });
      var body = orbit.i18n.pick({
        fr: 'Tu es connecté en invité avec le pseudo « ' + nick + ' ». Enregistre-le via ton profil EntreNous pour le protéger et retrouver tes préférences.',
        en: 'You\'re connected as a guest with the nick “' + nick + '”. Register it via your EntreNous profile to protect it and keep your preferences.',
      });
      var create = orbit.i18n.pick({ fr: 'Créer mon profil', en: 'Create my profile' });
      var login = orbit.i18n.pick({ fr: 'J’ai déjà un compte', en: 'I already have an account' });
      var later = orbit.i18n.pick({ fr: 'Plus tard', en: 'Later' });
      var close = orbit.i18n.t('modals.closeButton');
      var openSettings = function () {
        markDismissed();
        var st = orbit.state.get();
        if (st && typeof st.setModal === 'function') st.setModal('settings');
      };
      return h('div', { className: 'guestprompt', role: 'dialog', 'aria-labelledby': 'guestprompt-title', 'aria-describedby': 'guestprompt-desc' },
        h('button', { type: 'button', className: 'guestprompt__x', onClick: markDismissed, 'aria-label': close }, '×'),
        h('div', { className: 'guestprompt__ic', 'aria-hidden': true }, '🔐'),
        h('h2', { id: 'guestprompt-title', className: 'guestprompt__title' }, title),
        h('p', { id: 'guestprompt-desc', className: 'guestprompt__txt' }, body),
        h('div', { className: 'guestprompt__actions' },
          h('a', {
            className: 'guestprompt__primary',
            href: registerUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: markDismissed,
          }, create),
          h('button', { type: 'button', className: 'guestprompt__secondary', onClick: openSettings }, login)
        ),
        h('button', { type: 'button', className: 'guestprompt__later', onClick: markDismissed }, later)
      );
    }

    orbit.addUi('overlay', function () { return h(GuestPrompt); });
    log('anope notices → anope:unregistered | identified | registered | ghost | denied');
  });
})();
