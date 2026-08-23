/*
 * orbit-anope — NOTICE NickServ/Anope → événements Orbit + CTA invité.
 *
 * Sans NickServ, pas de compte. Anope LineWrappe souvent : on fusionne ~600 ms
 * puis on émet `anope:<kind>`. `anope:unregistered` ouvre le popup d’enregistrement.
 *
 * La notice d’entrée arrive parfois AVANT le chargement du plugin (handoff) :
 * on rejoue aussi les NOTICE NickServ déjà dans les buffers.
 *
 * config.json:
 *   "plugins": [".../orbit-anope/orbit-anope.js?v=2"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var DISMISS_PREFIX = 'orbit-anope:dismissed:';
  var COALESCE_MS = 600;

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

    function foldNick(n) {
      return String(n || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
    }
    function dismissKey() {
      return DISMISS_PREFIX + (foldNick(orbit.state.nick()) || '*');
    }
    function dismissed() {
      try { return sessionStorage.getItem(dismissKey()) === '1'; } catch (e) { return false; }
    }
    function markDismissed() {
      try { sessionStorage.setItem(dismissKey(), '1'); } catch (e) { /* ignore */ }
      shownUnregistered = true;
      setPromptNick('');
    }

    function stripIrc(text) {
      return String(text || '')
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
        .replace(/[\x02\x0f\x16\x1d\x1e\x1f]/g, '');
    }

    function classify(text) {
      var t = stripIrc(text).toLowerCase();
      if (!t.trim()) return 'other';
      if (/password accepted|successfully identified|already identified|now recognized|d[eé]j[aà] identifi/.test(t)) {
        return 'identified';
      }
      if (/(is now registered|est maintenant enregistr|has been registered|a (bien )?été enregistr)/.test(t)
        && !/pas enregistr|not registered|isn['\u2018\u2019]?t registered/.test(t)) {
        return 'registered';
      }
      if (/pas enregistr|not registered|isn['\u2018\u2019]?t registered|pour l.enregistr|to register (it|this|your)|reseau-entrenous\.fr\/register|\/msg\s+nickserv\s+register|\/ns\s+register/.test(t)) {
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
      if (shownUnregistered || ui.nick || dismissed()) return;
      if (orbit.state.account()) return;
      if ((orbit.config().features || {}).register === false) return;
      shownUnregistered = true;
      setPromptNick(p.nick || orbit.state.nick() || '…');
    }

    function onIdentified() {
      shownUnregistered = false;
      setPromptNick('');
    }

    function applyKind(kind, text) {
      var p = payload(kind, text);
      orbit.emit('anope:nickserv', p);
      if (kind !== 'other') orbit.emit('anope:' + kind, p);
      if (kind === 'unregistered') onUnregistered(p);
      else if (kind === 'identified' || kind === 'registered') onIdentified();
    }

    function flush() {
      coalesceTimer = 0;
      if (!pending.length) return;
      var text = pending.join('\n');
      pending = [];
      applyKind(classify(text), text);
    }

    function onRaw(msg) {
      if (!msg || String(msg.command || '').toUpperCase() !== 'NOTICE') return;
      if (!/^nickserv$/i.test(String(msg.nick || '').trim())) return;
      var text = stripIrc((msg.params && msg.params[1]) || '');
      if (!text.trim()) return;
      pending.push(text);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flush, COALESCE_MS);
    }

    function nickServTexts() {
      var st = orbit.state.get();
      var out = [];
      var buffers = (st && st.buffers) || {};
      Object.keys(buffers).forEach(function (k) {
        var msgs = (buffers[k] && buffers[k].messages) || [];
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          if (!m || m.self) continue;
          if (!/^nickserv$/i.test(String(m.from || '').trim())) continue;
          if (m.kind && m.kind !== 'notice') continue;
          var t = stripIrc(m.text || '');
          if (t.trim()) out.push(t);
        }
      });
      return out;
    }

    function scanHistory() {
      if (shownUnregistered || ui.nick) return;
      var texts = nickServTexts();
      if (!texts.length) return;
      var joined = texts.join('\n');
      var kind = classify(joined);
      if (kind === 'other') {
        for (var i = 0; i < texts.length; i++) {
          kind = classify(texts[i]);
          if (kind !== 'other') {
            joined = texts[i];
            break;
          }
        }
      }
      if (kind !== 'other') applyKind(kind, joined);
    }

    orbit.on('raw', onRaw);
    orbit.on('connected', function () { setTimeout(scanHistory, 50); });
    orbit.on('status', function (s) {
      if (s === 'registered') {
        setTimeout(scanHistory, 50);
        return;
      }
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
      shownUnregistered = false;
      setPromptNick('');
    });
    setTimeout(scanHistory, 0);
    setTimeout(scanHistory, 1200);

    function GuestPrompt() {
      var nick = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
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
