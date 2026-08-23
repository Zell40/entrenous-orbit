/*
 * orbit-anope — NOTICE NickServ/Anope → événements Orbit + CTA invité + IDENTIFY.
 *
 * Sans NickServ, pas de compte. Anope LineWrappe souvent : on fusionne ~600 ms
 * puis on émet `anope:<kind>`. `anope:unregistered` ouvre le popup d’enregistrement.
 * `anope:enforce` (countdown « pseudo sera changé dans … ») ouvre le formulaire
 * mot de passe ; le délai est lu dans la notice (réglages Anope variables).
 * `anope:forced` (pseudo changé en Guest/ENuser|…) explique le changement et
 * propose de créer un compte.
 *
 * La notice d’entrée arrive parfois AVANT le chargement du plugin (handoff) :
 * on rejoue aussi les NOTICE NickServ déjà dans les buffers.
 *
 * Les CTA n’apparaissent qu’après le splash de boot (écran de chargement).
 *
 * config.json:
 *   "plugins": [".../orbit-anope/orbit-anope.js?v=5"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var DISMISS_PREFIX = 'orbit-anope:dismissed:';
  var COALESCE_MS = 600;
  var IDENTIFY_TIMEOUT_MS = 12000;
  var SUCCESS_CLOSE_MS = 1400;
  var STYLE_ID = 'orbit-anope-css';

  Orbit.plugin('orbit-anope', function (orbit, log) {
    var React = orbit.React;
    var h = React.createElement;
    var useSyncExternalStore = React.useSyncExternalStore;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var pending = [];
    var coalesceTimer = 0;
    var shownUnregistered = false;
    var dismissedEnforce = false;
    var identifyTimer = 0;
    var successTimer = 0;

    var ui = { nick: '', enforce: null, forced: null, listeners: new Set() };
    var snap = { nick: '', enforce: null, forced: null };
    function subscribeUi(cb) { ui.listeners.add(cb); return function () { ui.listeners.delete(cb); }; }
    function uiSnap() { return snap; }
    function notifyUi() {
      snap = { nick: ui.nick, enforce: ui.enforce, forced: ui.forced };
      ui.listeners.forEach(function (l) { l(); });
    }
    function setPromptNick(nick) {
      var next = nick || '';
      if (ui.nick === next) return;
      ui.nick = next;
      notifyUi();
    }
    function setEnforce(next) {
      ui.enforce = next;
      notifyUi();
    }
    function setForced(next) {
      ui.forced = next;
      notifyUi();
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
    function foldText(text) {
      return stripIrc(text).toLowerCase()
        .replace(/[àáâä]/g, 'a').replace(/[éèêë]/g, 'e')
        .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
        .replace(/[ùûü]/g, 'u').replace(/ç/g, 'c');
    }

    function isEnforceText(t) {
      if (/(sera change|will be changed|i will change your nick|je (vais |changerai )?(changer |ton |votre )*(pseudo|nick))/.test(t)
        && /(identifi|minute|second|seconde|protect)/.test(t)) return true;
      if (/si vous ne (vous )?identifiez pas|if you do not identify|if you don't identify/.test(t)
        && /(change|changed|pseudo|nick)/.test(t)) return true;
      if (/vous avez \d+.+\bpour (vous )?identifi|you have \d+.+\bto identify/.test(t)) return true;
      if (/enregistre et protege|registered and protected/.test(t) && /identif/.test(t)) return true;
      return false;
    }

    function isForcedText(t) {
      if (/pseudo est maintenant change(e)? en/.test(t)) return true;
      if (/nick(name)? is now (being )?changed to/.test(t)) return true;
      if (/nick(name)? has been changed to/.test(t)) return true;
      return false;
    }

    function parseForcedNick(text) {
      var raw = stripIrc(text);
      var m = raw.match(/chang[eé]e? en\s+(\S+)/i) || raw.match(/changed to\s+(\S+)/i);
      if (!m) return '';
      return m[1].replace(/[.,;:!?]+$/g, '');
    }

    /** Durée Anope dans la notice : « 1 minute », « 20 secondes », « une minute », … */
    function parseEnforceSeconds(text) {
      var t = foldText(text);
      var total = 0;
      var found = false;
      function add(re, mul) {
        var m = t.match(re);
        if (m) { total += parseInt(m[1], 10) * mul; found = true; }
      }
      add(/(\d+)\s*(heures?|hours?)\b/, 3600);
      add(/(\d+)\s*(minutes?|mins?)\b/, 60);
      add(/(\d+)\s*(secondes?|seconds?|secs?)\b/, 1);
      if (!found) {
        if (/\b(une|one)\s+heure\b/.test(t) || /\b(une|one)\s+hour\b/.test(t)) { total += 3600; found = true; }
        if (/\b(une|one)\s+minute\b/.test(t)) { total += 60; found = true; }
        if (/\b(une|one)\s+seconde/.test(t) || /\b(une|one)\s+second\b/.test(t)) { total += 1; found = true; }
      }
      return found ? Math.max(1, total) : 0;
    }

    function classify(text) {
      var t = foldText(text);
      if (!t.trim()) return 'other';
      if (/password accepted|successfully identified|already identified|now recognized|deja identifi/.test(t)) {
        return 'identified';
      }
      if (/(is now registered|est maintenant enregistr|has been registered|a (bien )?ete enregistr)/.test(t)
        && !/pas enregistr|not registered|isn['\u2018\u2019]?t registered/.test(t)) {
        return 'registered';
      }
      if (isForcedText(t)) return 'forced';
      if (isEnforceText(t)) return 'enforce';
      if (/pas enregistr|not registered|isn['\u2018\u2019]?t registered|pour l.enregistr|to register (it|this|your)|reseau-entrenous\.fr\/register|\/msg\s+nickserv\s+register|\/ns\s+register/.test(t)) {
        return 'unregistered';
      }
      if (/\bghost\b/.test(t)) return 'ghost';
      if (/invalid password|wrong password|password incorrect|access denied|authentication failed|mot de passe (invalide|incorrect)|identifi\w+ refus/.test(t)) {
        return 'denied';
      }
      return 'other';
    }

    function payload(kind, text) {
      return { kind: kind, from: 'NickServ', text: text, nick: orbit.state.nick() || '' };
    }

    function clearIdentifyTimer() {
      if (identifyTimer) { clearTimeout(identifyTimer); identifyTimer = 0; }
    }
    function clearSuccessTimer() {
      if (successTimer) { clearTimeout(successTimer); successTimer = 0; }
    }

    function dismissOrbitNickServ() {
      try {
        var st = orbit.state.get();
        if (st && typeof st.dismissNickServAlert === 'function') st.dismissNickServAlert();
      } catch (e) { /* ignore */ }
    }

    function onUnregistered(p) {
      if (shownUnregistered || ui.nick || ui.enforce || ui.forced || dismissed()) return;
      if (orbit.state.account()) return;
      if ((orbit.config().features || {}).register === false) return;
      shownUnregistered = true;
      setPromptNick(p.nick || orbit.state.nick() || '…');
    }

    function onIdentified() {
      shownUnregistered = false;
      setPromptNick('');
      setForced(null);
      clearIdentifyTimer();
      if (!ui.enforce) return;
      var cur = ui.enforce;
      setEnforce({
        nick: cur.nick,
        deadline: cur.deadline,
        error: '',
        pending: false,
        success: true,
      });
      clearSuccessTimer();
      successTimer = setTimeout(function () {
        successTimer = 0;
        setEnforce(null);
      }, SUCCESS_CLOSE_MS);
    }

    function onDenied() {
      if (!ui.enforce) return;
      clearIdentifyTimer();
      var cur = ui.enforce;
      setEnforce({
        nick: cur.nick,
        deadline: cur.deadline,
        error: orbit.i18n.pick({
          fr: 'Mot de passe refusé. Vérifie et réessaie.',
          en: 'Password rejected. Check it and try again.',
        }),
        pending: false,
        success: false,
      });
    }

    function onEnforce(p, ts, fromHistory) {
      if (fromHistory && dismissedEnforce) return;
      if (orbit.state.account() && !ui.enforce) return;
      dismissedEnforce = false;
      shownUnregistered = true;
      setPromptNick('');
      var seconds = parseEnforceSeconds(p.text);
      var now = Date.now();
      var base = typeof ts === 'number' && ts > 0 ? ts : now;
      var remaining = seconds ? Math.max(0, seconds - Math.floor((now - base) / 1000)) : 0;
      if (seconds && remaining <= 0 && (now - base) > (seconds + 8) * 1000) return;
      var prev = ui.enforce;
      var deadline = remaining > 0 ? now + remaining * 1000 : (seconds ? now : (prev && prev.deadline) || 0);
      if (prev && prev.pending && !seconds) deadline = prev.deadline;
      setEnforce({
        nick: p.nick || orbit.state.nick() || '',
        deadline: deadline,
        error: prev && prev.pending ? prev.error : '',
        pending: prev ? prev.pending : false,
        success: false,
      });
      dismissOrbitNickServ();
    }

    function onForced(p, fromHistory) {
      if (fromHistory && ui.forced) return;
      shownUnregistered = true;
      setPromptNick('');
      clearIdentifyTimer();
      clearSuccessTimer();
      setEnforce(null);
      setForced({ nick: parseForcedNick(p.text) || p.nick || orbit.state.nick() || '' });
      dismissOrbitNickServ();
    }

    function dismissForced() {
      setForced(null);
    }

    function dismissEnforce() {
      dismissedEnforce = true;
      clearIdentifyTimer();
      clearSuccessTimer();
      setEnforce(null);
    }

    function sendIdentify(password) {
      var pw = String(password || '');
      if (!pw || !ui.enforce || ui.enforce.pending || ui.enforce.success) return;
      var cur = ui.enforce;
      setEnforce({
        nick: cur.nick,
        deadline: cur.deadline,
        error: '',
        pending: true,
        success: false,
      });
      clearIdentifyTimer();
      identifyTimer = setTimeout(function () {
        identifyTimer = 0;
        if (!ui.enforce || !ui.enforce.pending) return;
        setEnforce({
          nick: ui.enforce.nick,
          deadline: ui.enforce.deadline,
          error: orbit.i18n.pick({
            fr: 'Pas de réponse de NickServ. Réessaie.',
            en: 'No reply from NickServ. Try again.',
          }),
          pending: false,
          success: false,
        });
      }, IDENTIFY_TIMEOUT_MS);
      try {
        orbit.irc.msg('NickServ', 'IDENTIFY ' + pw);
      } catch (e) {
        clearIdentifyTimer();
        setEnforce({
          nick: cur.nick,
          deadline: cur.deadline,
          error: orbit.i18n.pick({
            fr: 'Impossible d’envoyer l’identification.',
            en: 'Could not send identification.',
          }),
          pending: false,
          success: false,
        });
      }
    }

    function applyKind(kind, text, ts, fromHistory) {
      var p = payload(kind, text);
      orbit.emit('anope:nickserv', p);
      if (kind !== 'other') orbit.emit('anope:' + kind, p);
      if (kind === 'unregistered') onUnregistered(p);
      else if (kind === 'identified' || kind === 'registered') onIdentified();
      else if (kind === 'denied') onDenied();
      else if (kind === 'enforce') onEnforce(p, ts, fromHistory);
      else if (kind === 'forced') onForced(p, fromHistory);
    }

    function flush() {
      coalesceTimer = 0;
      if (!pending.length) return;
      var text = pending.join('\n');
      pending = [];
      applyKind(classify(text), text, Date.now(), false);
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

    function nickServNotices() {
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
          if (t.trim()) out.push({ text: t, ts: m.ts || 0 });
        }
      });
      return out;
    }

    function scanHistory() {
      if (orbit.state.account() && !ui.enforce && !ui.forced) return;
      var notices = nickServNotices();
      if (!notices.length) return;
      var kind = 'other';
      var chosen = '';
      var ts = Date.now();
      for (var i = notices.length - 1; i >= 0; i--) {
        var k = classify(notices[i].text);
        if (k !== 'other') {
          kind = k;
          chosen = notices[i].text;
          ts = notices[i].ts || ts;
          break;
        }
      }
      if (kind === 'unregistered' && (shownUnregistered || ui.nick || ui.enforce || ui.forced || dismissed())) return;
      if (kind === 'enforce' && ui.enforce) return;
      if (kind === 'forced' && ui.forced) return;
      if (kind !== 'other') applyKind(kind, chosen, ts, true);
    }

    function resetSession() {
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
      clearIdentifyTimer();
      clearSuccessTimer();
      shownUnregistered = false;
      dismissedEnforce = false;
      setPromptNick('');
      setEnforce(null);
      setForced(null);
    }

    orbit.on('raw', onRaw);
    orbit.on('connected', function () { setTimeout(scanHistory, 50); });
    orbit.on('status', function (s) {
      if (s === 'registered') {
        setTimeout(scanHistory, 50);
        return;
      }
      resetSession();
    });
    setTimeout(scanHistory, 0);
    setTimeout(scanHistory, 1200);

    function injectStyles() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = [
        '.anope-id{z-index:170;width:min(420px,calc(100vw - 1.5rem))}',
        '.anope-id__time{margin:.7rem 0 0;font-size:1.55rem;font-weight:800;letter-spacing:.02em;',
        'font-variant-numeric:tabular-nums;color:var(--accent);line-height:1}',
        '.anope-id__time.is-late{color:var(--danger,#dc2626)}',
        '.anope-id__form{display:flex;flex-direction:column;gap:.45rem;width:100%;margin-top:.95rem;text-align:left}',
        '.anope-id__label{font-size:.78rem;font-weight:700;color:var(--muted)}',
        '.anope-id__input{width:100%;box-sizing:border-box;min-height:42px;padding:.55rem .75rem;border-radius:11px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit}',
        '.anope-id__input:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:1px}',
        '.anope-id__input:disabled{opacity:.65}',
        '.anope-id__err{margin:.15rem 0 0;font-size:.84rem;font-weight:650;color:var(--danger,#dc2626);text-align:center}',
        '.anope-id__ok{margin:.35rem 0 0;font-size:.92rem;font-weight:750;color:var(--accent);text-align:center}',
        '.anope-id .guestprompt__primary:disabled{opacity:.65;cursor:wait}',
      ].join('');
    }
    injectStyles();

    function GuestPrompt() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var nick = s.nick;
      if (!nick || s.enforce || s.forced) return null;
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

    function formatRemain(sec) {
      if (sec < 0) sec = 0;
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      if (m <= 0) return s + ' s';
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function IdentifyPrompt() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var en = s.enforce;
      var pwState = useState('');
      var password = pwState[0];
      var setPassword = pwState[1];
      var tickState = useState(0);
      var setTick = tickState[1];
      var inputRef = useRef(null);

      useEffect(function () {
        if (!en || en.success) return undefined;
        var id = setInterval(function () { setTick(function (n) { return n + 1; }); }, 250);
        return function () { clearInterval(id); };
      }, [en && en.deadline, en && en.success]);

      useEffect(function () {
        if (!en || en.success) return;
        var el = inputRef.current;
        if (el && typeof el.focus === 'function') el.focus();
      }, [en && en.nick]);

      useEffect(function () {
        if (!en) setPassword('');
      }, [!en]);

      if (!en || s.forced) return null;
      var nick = en.nick || orbit.state.nick() || '';
      var remain = en.deadline ? Math.max(0, Math.ceil((en.deadline - Date.now()) / 1000)) : 0;
      var late = !!(en.deadline && remain <= 10);
      var title = orbit.i18n.pick({ fr: 'Identifie ton compte', en: 'Identify your account' });
      var body = en.deadline
        ? orbit.i18n.pick({
          fr: 'Le pseudo « ' + nick + ' » est protégé. Identifie-toi avant que NickServ ne le change.',
          en: 'The nick “' + nick + '” is protected. Identify before NickServ changes it.',
        })
        : orbit.i18n.pick({
          fr: 'Le pseudo « ' + nick + ' » est enregistré. Saisis le mot de passe de ton compte Anope.',
          en: 'The nick “' + nick + '” is registered. Enter your Anope account password.',
        });
      var timeHint = orbit.i18n.pick({
        fr: remain <= 0 ? 'Le délai indiqué est écoulé — identifie-toi tout de suite.' : 'Temps restant',
        en: remain <= 0 ? 'The given delay has elapsed — identify now.' : 'Time remaining',
      });
      var pwdLabel = orbit.i18n.pick({ fr: 'Mot de passe du compte', en: 'Account password' });
      var submitLbl = en.pending
        ? orbit.i18n.pick({ fr: 'Vérification…', en: 'Checking…' })
        : orbit.i18n.pick({ fr: 'Valider', en: 'Sign in' });
      var later = orbit.i18n.pick({ fr: 'Plus tard', en: 'Later' });
      var close = orbit.i18n.t('modals.closeButton');
      var okTxt = orbit.i18n.pick({ fr: 'Compte identifié.', en: 'Account identified.' });
      var onSubmit = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        sendIdentify(password);
      };
      var kids = [
        h('button', { type: 'button', className: 'guestprompt__x', onClick: dismissEnforce, 'aria-label': close }, '×'),
        h('div', { className: 'guestprompt__ic', 'aria-hidden': true }, '🔑'),
        h('h2', { id: 'anope-id-title', className: 'guestprompt__title' }, title),
        h('p', { id: 'anope-id-desc', className: 'guestprompt__txt' }, body),
      ];
      if (en.deadline) {
        kids.push(h('div', {
          className: 'anope-id__time' + (late ? ' is-late' : ''),
          'aria-live': 'polite',
        }, remain > 0 ? formatRemain(remain) : '0 s'));
        kids.push(h('p', { className: 'guestprompt__txt' }, timeHint));
      }
      if (en.success) {
        kids.push(h('p', { className: 'anope-id__ok', role: 'status' }, okTxt));
      } else {
        kids.push(h('form', { className: 'anope-id__form', onSubmit: onSubmit },
          h('label', { className: 'anope-id__label', htmlFor: 'anope-id-pw' }, pwdLabel),
          h('input', {
            id: 'anope-id-pw',
            ref: inputRef,
            type: 'password',
            className: 'anope-id__input',
            autoComplete: 'current-password',
            value: password,
            disabled: !!en.pending,
            onChange: function (e) { setPassword(e.target.value); },
          }),
          en.error ? h('p', { className: 'anope-id__err', role: 'alert' }, en.error) : null,
          h('div', { className: 'guestprompt__actions' },
            h('button', {
              type: 'submit',
              className: 'guestprompt__primary',
              disabled: !!en.pending || !String(password).length,
            }, submitLbl)
          )
        ));
        kids.push(h('button', { type: 'button', className: 'guestprompt__later', onClick: dismissEnforce }, later));
      }
      return h('div', {
        className: 'guestprompt anope-id',
        role: 'dialog',
        'aria-labelledby': 'anope-id-title',
        'aria-describedby': 'anope-id-desc',
      }, kids);
    }

    function ForcedPrompt() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var forced = s.forced;
      if (!forced) return null;
      var nick = forced.nick || orbit.state.nick() || '';
      var cfg = orbit.config() || {};
      var registerUrl = (cfg.branding && cfg.branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
      var title = orbit.i18n.pick({ fr: 'Pseudo modifié', en: 'Nickname changed' });
      var body = orbit.i18n.pick({
        fr: 'Ton pseudo a été changé en « ' + nick + ' » parce que tu ne t’es pas identifié sur le compte. Tu peux créer un compte EntreNous ici pour protéger ton pseudo.',
        en: 'Your nick was changed to “' + nick + '” because you did not identify to the account. You can create an EntreNous account here to protect your nick.',
      });
      var create = orbit.i18n.pick({ fr: 'Créer un compte', en: 'Create an account' });
      var login = orbit.i18n.pick({ fr: 'J’ai déjà un compte', en: 'I already have an account' });
      var later = orbit.i18n.pick({ fr: 'Plus tard', en: 'Later' });
      var close = orbit.i18n.t('modals.closeButton');
      var openSettings = function () {
        dismissForced();
        var st = orbit.state.get();
        if (st && typeof st.setModal === 'function') st.setModal('settings');
      };
      return h('div', { className: 'guestprompt', role: 'dialog', 'aria-labelledby': 'anope-forced-title', 'aria-describedby': 'anope-forced-desc' },
        h('button', { type: 'button', className: 'guestprompt__x', onClick: dismissForced, 'aria-label': close }, '×'),
        h('div', { className: 'guestprompt__ic', 'aria-hidden': true }, '⚠️'),
        h('h2', { id: 'anope-forced-title', className: 'guestprompt__title' }, title),
        h('p', { id: 'anope-forced-desc', className: 'guestprompt__txt' }, body),
        h('div', { className: 'guestprompt__actions' },
          h('a', {
            className: 'guestprompt__primary',
            href: registerUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: dismissForced,
          }, create),
          h('button', { type: 'button', className: 'guestprompt__secondary', onClick: openSettings }, login)
        ),
        h('button', { type: 'button', className: 'guestprompt__later', onClick: dismissForced }, later)
      );
    }

    function splashGone() {
      return !document.querySelector('.splash');
    }

    function usePageReady() {
      var st = useState(splashGone);
      var ready = st[0];
      var setReady = st[1];
      useEffect(function () {
        if (ready) return undefined;
        function go() { setReady(true); }
        function check() {
          if (splashGone()) { go(); return true; }
          return false;
        }
        if (check()) return undefined;
        var off = orbit.on('boot:ready', go);
        var obs = new MutationObserver(check);
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        var iv = setInterval(check, 150);
        return function () {
          if (typeof off === 'function') off();
          obs.disconnect();
          clearInterval(iv);
        };
      }, [ready]);
      return ready;
    }

    function Overlays() {
      var ready = usePageReady();
      if (!ready) return null;
      return h(React.Fragment, null, h(GuestPrompt), h(IdentifyPrompt), h(ForcedPrompt));
    }

    orbit.addUi('overlay', function () {
      return h(Overlays);
    });
    log('anope notices → anope:unregistered | identified | registered | ghost | denied | enforce | forced');
  });
})();
