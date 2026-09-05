/*
 * orbit-chanserv — commandes ChanServ / BotServ selon l’accès Anope.
 *
 * Icône barre du salon (desktop) + menu ⋮ (mobile). Panneau overlay (gestion salon).
 * Kick / ban / op / voix : menu de la liste (Commandes <bot>).
 * Salon non enregistré → REGISTER (compte NickServ requis).
 * Salon enregistré → commandes filtrées (VOP/HOP/AOP/SOP/fondateur) + bot.
 *
 * config.json:
 *   "plugins": [".../orbit-chanserv/orbit-chanserv.js?v=14"]
 *
 * INFO / STATUS / BOTLIST: JSON-RPC Anope via chanserv-rpc.php (pas de MP).
 * Commandes (OP, KICK, …) : IRC ; les PRIVMSG/NOTICE de réponse sont masqués.
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var COALESCE_MS = 600;
  var HIDE_MS = 12000;
  var CACHE_MS = 20000;
  var STYLE_ID = 'orbit-chanserv-css';
  var RPC_PATH = '/app/plugins/third/orbit-chanserv/chanserv-rpc.php';

  var ACCESS_RANK = { none: 0, vop: 3, hop: 4, aop: 5, sop: 10, founder: 100 };

  Orbit.plugin('orbit-chanserv', function (orbit, log) {
    var React = orbit.React;
    var h = React.createElement;
    var useSyncExternalStore = React.useSyncExternalStore;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var pending = [];
    var coalesceTimer = 0;
    var pendingFrom = '';
    var hideUntil = 0;
    var expectKind = '';
    var expectChan = '';
    var cache = {};

    var ui = {
      open: false,
      chan: '',
      loading: false,
      registered: null,
      founder: '',
      bot: '',
      access: 'none',
      bots: [],
      infoText: '',
      flash: '',
      flashErr: false,
      tab: 'salon',
      listeners: new Set(),
    };
    var snap = copyUi();
    function copyUi() {
      return {
        open: ui.open, chan: ui.chan, loading: ui.loading, registered: ui.registered,
        founder: ui.founder, bot: ui.bot, access: ui.access, bots: ui.bots.slice(),
        infoText: ui.infoText, flash: ui.flash, flashErr: ui.flashErr, tab: ui.tab,
      };
    }
    function subscribeUi(cb) { ui.listeners.add(cb); return function () { ui.listeners.delete(cb); }; }
    function uiSnap() { return snap; }
    function notifyUi() {
      snap = copyUi();
      ui.listeners.forEach(function (l) { l(); });
    }
    function patchUi(partial) {
      Object.keys(partial).forEach(function (k) { ui[k] = partial[k]; });
      notifyUi();
    }

    function pick(fr, en) {
      return orbit.i18n.pick({ fr: fr, en: en });
    }
    function isChannel(name) {
      return !!name && (name[0] === '#' || name[0] === '&');
    }
    function foldText(text) {
      return String(text || '').toLowerCase()
        .replace(/[àáâä]/g, 'a').replace(/[éèêë]/g, 'e')
        .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
        .replace(/[ùûü]/g, 'u').replace(/ç/g, 'c');
    }
    function stripIrc(text) {
      return String(text || '')
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
        .replace(/[\x02\x0f\x16\x1d\x1e\x1f]/g, '');
    }
    function hasHalfop() {
      try {
        var p = (orbit.server.isupport() || {}).PREFIX || '';
        return p.indexOf('%') !== -1;
      } catch (e) { return false; }
    }
    function rank() { return ACCESS_RANK[ui.access] || 0; }
    function can(min) { return rank() >= min; }
    function identified() { return !!orbit.state.account(); }
    function amChannelOp(chan) {
      try {
        var st = orbit.state.get();
        var buf = st.buffers && (st.buffers[chan] || st.buffers[String(chan || '').toLowerCase()]);
        if (!buf && st.buffers) {
          var keys = Object.keys(st.buffers);
          var want = String(chan || '').toLowerCase();
          for (var i = 0; i < keys.length; i++) {
            if (keys[i].toLowerCase() === want) { buf = st.buffers[keys[i]]; break; }
          }
        }
        var mem = buf && buf.members && buf.members[st.nick];
        return /[~&@%]/.test((mem && (mem.prefixes || mem.prefix)) || '');
      } catch (e) { return false; }
    }

    function isServNick(name) {
      return /^(chanserv|botserv)$/i.test(String(name || '').trim());
    }

    function iconVisible(s, chan) {
      return isChannel(chan) && identified();
    }

    function cs(cmd) { orbit.irc.msg('ChanServ', cmd); }
    function bs(cmd) { orbit.irc.msg('BotServ', cmd); }

    var rpcState = 'try';
    var rpcInflight = {};
    function rpcPost(body) {
      return fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) {
            return { ok: false, error: 'bad_json' };
          }
          if (!data || typeof data !== 'object') return { ok: false, error: 'empty' };
          if (!r.ok && data.ok !== true) {
            data.ok = false;
            data.error = data.error || ('http_' + r.status);
          }
          return data;
        });
      });
    }
    function rpcCall(action, chan, extra) {
      if (rpcState === 'off') return Promise.resolve(null);
      var account = orbit.state.account();
      if (!account) return Promise.resolve(null);
      var key = action + ':' + String(chan || '').toLowerCase();
      if (rpcInflight[key]) return rpcInflight[key];
      var body = Object.assign({
        account: account,
        channel: chan,
        action: action,
        nick: orbit.state.nick() || '',
      }, extra || {});
      var p = rpcPost(body)
        .then(function (data) {
          if (data && data.ok) {
            rpcState = 'on';
            return data;
          }
          var err = (data && data.error) || 'unknown';
          if (err === 'not_configured') {
            log('RPC non configuré');
            rpcState = 'off';
            return null;
          }
          log('RPC échec: ' + err);
          return data || null;
        })
        .catch(function (err) {
          log('RPC fetch KO: ' + (err && err.message ? err.message : err));
          rpcState = 'off';
          return null;
        })
        .then(function (data) {
          delete rpcInflight[key];
          return data;
        });
      rpcInflight[key] = p;
      return p;
    }

    function rememberCache(chan) {
      if (!chan) return;
      cache[chan.toLowerCase()] = {
        ts: Date.now(),
        registered: ui.registered,
        founder: ui.founder,
        bot: ui.bot,
        access: ui.access,
        infoText: ui.infoText,
      };
    }
    function applyCache(chan) {
      var c = cache[chan.toLowerCase()];
      if (!c || Date.now() - c.ts > CACHE_MS) return false;
      patchUi({
        chan: chan, loading: false, registered: c.registered, founder: c.founder,
        bot: c.bot, access: c.access, infoText: c.infoText, flash: '',
      });
      return true;
    }

    function beginExpect(kind, chan) {
      expectKind = kind;
      expectChan = chan;
      hideUntil = Date.now() + HIDE_MS;
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
    }

    function founderMatch(founder) {
      var f = foldText(founder);
      if (!f) return false;
      var me = foldText(orbit.state.nick() || '');
      var acc = foldText(orbit.state.account() || '');
      return (me && f === me) || (acc && f === acc);
    }

    function applyProbeTexts(chan, infoText, statusText) {
      var info = parseInfo(infoText || '');
      if (isUnregisteredText(statusText || '')) info.registered = false;
      var acc = 'none';
      if (info.registered) {
        acc = parseAccess(statusText || '') || 'none';
        if (founderMatch(info.founder)) acc = 'founder';
      }
      patchUi({
        loading: false,
        registered: info.registered,
        founder: info.founder,
        bot: info.bot,
        infoText: info.infoText,
        access: acc,
      });
      rememberCache(chan);
      expectKind = '';
      if (ui.open && can(ACCESS_RANK.sop) && !ui.bot && !ui.bots.length) queryBotlist();
    }

    function queryInfo(chan, opts) {
      if (!isChannel(chan) || !identified()) {
        patchUi({ chan: chan, loading: false, registered: null, access: 'none', bot: '', founder: '', infoText: '' });
        return;
      }
      if (applyCache(chan)) return;
      var next = { chan: chan, loading: true };
      if (!(opts && opts.keepFlash)) next.flash = '';
      patchUi(next);
      rpcCall('probe', chan).then(function (data) {
        if (ui.chan !== chan) return;
        if (data && data.ok && (data.info || data.status)) {
          applyProbeTexts(chan, data.info, data.status);
          return;
        }
        beginExpect('info', chan);
        cs('INFO ' + chan);
      });
    }

    function queryStatus(chan) {
      beginExpect('status', chan);
      cs('STATUS ' + chan);
    }

    function queryBotlist() {
      var chan = expectChan || ui.chan;
      rpcCall('botlist', chan).then(function (data) {
        if (data && data.ok && data.bots != null) {
          patchUi({ bots: parseBotlist(data.bots), loading: false });
          expectKind = '';
          return;
        }
        beginExpect('botlist', chan);
        bs('BOTLIST');
      });
    }

    function looksLikeServOk(text) {
      var t = foldText(text);
      return /a ete enregistre|has been registered|enregistre avec succes|registered successfully|sujet (modifie|change|a ete)|topic (is now|changed|set)|est maintenant|is now (the )?(op|hop|voice|aop|sop)|bot (assigne|assigned|unassign)/.test(t);
    }
    function looksLikeServError(text) {
      var t = foldText(text);
      if (!t || looksLikeServOk(t)) return false;
      return /limite|limit|depass|exceed|permission|denied|refuse|vous ne pouvez|you cannot|interdit|impossible|erreur|error|fail|deja|already|trop (de|many)|too many|pas assez|not enough|invalide|invalid|inconnu|unknown|pas autoris|not allowed|syntaxe|syntax/.test(t);
    }
    function parseAccess(text) {
      var t = foldText(text);
      if (/pas (d[' ]?)?acces|no(t)? (have )?access|don't have access|dont have access|aucun acces/.test(t)
        && !/fondateur|founder|sop|aop|hop|vop|niveau|level/.test(t)) {
        return 'none';
      }
      if (/fondateur|founder/.test(t)) return 'founder';
      if (/\bsop\b/.test(t)) return 'sop';
      if (/\baop\b/.test(t)) return 'aop';
      if (/\bhop\b/.test(t) || /halfop/.test(t)) return 'hop';
      if (/\bvop\b/.test(t) || /\bvoice\b/.test(t) && /acces/.test(t)) return 'vop';
      var m = t.match(/niveau\s+(\d+)/) || t.match(/access(?:\s+level)?\s+(\d+)/) || t.match(/has access\s+(\d+)/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n >= 100 || n >= 10000) return 'founder';
        if (n >= 10) return 'sop';
        if (n >= 5) return 'aop';
        if (n >= 4) return 'hop';
        if (n >= 3) return 'vop';
        if (n > 0) return 'vop';
        return 'none';
      }
      if (/vous avez (un )?acces|you have access|has access/.test(t)) return 'aop';
      return '';
    }

    function isUnregisteredText(text) {
      var t = foldText(text).replace(/[\u2018\u2019\u02bc`]/g, "'");
      return /pas enregistre|is not registered|isn'?t registered|n'?est pas|n'?existe pas|not registered/.test(t);
    }

    function parseInfo(text) {
      var raw = stripIrc(text);
      var out = { registered: true, founder: '', bot: '', infoText: raw.trim() };
      if (isUnregisteredText(raw)) {
        out.registered = false;
        return out;
      }
      var fm = raw.match(/(?:fondateur|founder)\s*:\s*(\S+)/i);
      if (fm) out.founder = fm[1].replace(/[.,;]+$/, '');
      var bm = raw.match(/(?:^|\n)\s*(?:bot|botserv)\s*:\s*(\S+)/i);
      if (bm && !/^n\/?a$/i.test(bm[1]) && bm[1] !== '-' && bm[1] !== '*') {
        out.bot = bm[1].replace(/[.,;]+$/, '');
      }
      return out;
    }

    function parseBotlist(text) {
      var names = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s || /bot list|liste des bots|end of/i.test(s)) return;
        var m = s.match(/^[-*•]\s*(\S+)/) || s.match(/^(\S+)\s+\(/);
        if (m && !/chanserv|botserv|nickserv/i.test(m[1])) names.push(m[1]);
      });
      return names;
    }

    function applyKind(kind, text) {
      var chan = expectChan || ui.chan;
      if (kind === 'info') {
        var info = parseInfo(text);
        patchUi({
          loading: info.registered === true,
          registered: info.registered,
          founder: info.founder,
          bot: info.bot,
          infoText: info.infoText,
          access: info.registered ? ui.access : 'none',
        });
        if (info.registered) queryStatus(chan);
        else {
          rememberCache(chan);
          expectKind = '';
        }
        return;
      }
      if (kind === 'status') {
        var acc = parseAccess(text) || 'none';
        var me = foldText(orbit.state.nick() || '');
        var founder = foldText(ui.founder);
        if (founder && me && founder === me) acc = 'founder';
        patchUi({ access: acc, loading: false });
        rememberCache(chan);
        expectKind = '';
        if (ui.open && can(ACCESS_RANK.sop) && !ui.bot && !ui.bots.length) queryBotlist();
        return;
      }
      if (kind === 'botlist') {
        patchUi({ bots: parseBotlist(text), loading: false });
        expectKind = '';
        return;
      }
      if (kind === 'cmd') {
        var raw = stripIrc(text).replace(/\s+/g, ' ').trim().slice(0, 400);
        var err = looksLikeServError(raw);
        patchUi({ flash: raw, flashErr: err || !looksLikeServOk(raw), loading: false, open: err ? true : ui.open });
        expectKind = '';
        cache = {};
        if (!err && ui.chan) {
          setTimeout(function () { queryInfo(ui.chan, { keepFlash: true }); }, 500);
        }
      }
    }

    function flush() {
      coalesceTimer = 0;
      if (!pending.length) return;
      var text = pending.join('\n');
      pending = [];
      var kind = expectKind || 'cmd';
      applyKind(kind, text);
    }

    function onRaw(msg) {
      if (!msg) return;
      var cmd = String(msg.command || '').toUpperCase();
      if (cmd !== 'NOTICE' && cmd !== 'PRIVMSG') return;
      var from = String(msg.nick || '').trim();
      if (!/^(chanserv|botserv)$/i.test(from)) return;
      if (Date.now() > hideUntil && !expectKind) return;
      var text = stripIrc((msg.params && msg.params[1]) || '');
      if (!text.trim() || text.charCodeAt(0) === 1) return;
      if (pendingFrom && pendingFrom !== from.toLowerCase()) {
        flush();
      }
      pendingFrom = from.toLowerCase();
      pending.push(text);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flush, COALESCE_MS);
    }

    function shouldHideServiceReply(m) {
      if (Date.now() > hideUntil && !expectKind) return false;
      var cmd = String(m.command || '').toUpperCase();
      if (cmd !== 'NOTICE' && cmd !== 'PRIVMSG') return false;
      // Incoming: nick=ChanServ. Outgoing echo-message: target=ChanServ (nick=toi).
      return isServNick(m.nick) || isServNick(m.target);
    }

    function runCmd(service, line, refresh) {
      if (!line) return;
      beginExpect(refresh ? 'cmd' : 'cmd', ui.chan);
      patchUi({ flash: '', loading: true });
      if (service === 'BotServ') bs(line);
      else cs(line);
    }

    function toggleOpen() {
      var chan = orbit.state.active();
      if (!isChannel(chan)) return;
      if (ui.open && ui.chan === chan) {
        patchUi({ open: false });
        return;
      }
      patchUi({ open: true, chan: chan, flash: '' });
      queryInfo(chan);
    }

    function closePanel() { patchUi({ open: false }); }

    function injectStyles() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = [
        '.ocs-panel{position:fixed;right:12px;top:58px;z-index:160;width:min(420px,calc(100vw - 1.5rem));',
        'max-height:min(78vh,640px);overflow:auto;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45));',
        'padding:1rem 1rem .9rem;display:flex;flex-direction:column;gap:.65rem}',
        '.ocs-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}',
        '.ocs-title{margin:0;font-size:1.02rem;font-weight:800}',
        '.ocs-x{border:0;background:transparent;color:var(--muted);font-size:1.3rem;cursor:pointer;border-radius:8px;padding:.1rem .35rem}',
        '.ocs-x:hover{background:var(--bg-soft);color:var(--ink)}',
        '.ocs-sub{font-size:.8rem;color:var(--muted);margin:0}',
        '.ocs-badge{display:inline-flex;align-items:center;gap:.35rem;font-size:.75rem;font-weight:700;',
        'background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:.15rem .55rem}',
        '.ocs-row{display:flex;flex-wrap:wrap;gap:.4rem}',
        '.ocs-field{display:flex;flex-direction:column;gap:.28rem}',
        '.ocs-label{font-size:.75rem;font-weight:700;color:var(--muted)}',
        '.ocs-input,.ocs-select{width:100%;box-sizing:border-box;min-height:38px;padding:.45rem .65rem;border-radius:10px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit}',
        '.ocs-btn{min-height:36px;padding:.4rem .7rem;border-radius:10px;border:1px solid var(--border);',
        'background:var(--bg-soft);color:var(--ink);font:inherit;font-weight:700;font-size:.82rem;cursor:pointer}',
        '.ocs-btn:hover{background:var(--bg-soft-2,var(--bg))}',
        '.ocs-btn--primary{background:var(--accent);color:#fff;border:0}',
        '.ocs-flash{font-size:.88rem;line-height:1.45;padding:.6rem .75rem;border-radius:12px;',
        'background:var(--bg-soft);border:1px solid var(--border)}',
        '.ocs-flash.is-err{color:var(--danger,#b91c1c);font-weight:700;',
        'background:color-mix(in srgb,var(--danger,#dc2626) 14%,var(--bg));',
        'border-color:color-mix(in srgb,var(--danger,#dc2626) 40%,var(--border))}',
        '.ocs-h{margin:.2rem 0 0;font-size:.78rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}',
        '.ocs-info{white-space:pre-wrap;font-size:.78rem;line-height:1.4;color:var(--muted);max-height:7rem;overflow:auto}',
        '.ocs-tabs{display:flex;flex-wrap:wrap;gap:.15rem;border-bottom:1px solid var(--border);padding:0 0 .2rem}',
        '.ocs-tab{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:800;font-size:.76rem;',
        'padding:.4rem .6rem;border-radius:8px;cursor:pointer}',
        '.ocs-tab.is-on{color:var(--accent);background:var(--accent-soft)}',
        '.ocs-mm{display:flex;flex-direction:column;gap:1px;padding:.1rem 0 .15rem}',
        '.ocs-mm__reason{margin:.2rem .45rem .3rem;min-height:32px;padding:.28rem .5rem;border-radius:8px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit;font-size:.8rem;',
        'width:calc(100% - .9rem);box-sizing:border-box}',
        '.topbar__search.ocs-tb--ok{color:var(--accent)}',
        '.topbar__search.ocs-tb--free,.topbar__search.ocs-tb--none,.topbar__search.ocs-tb--wait{color:var(--muted)}',
        '.nmenu__ic .ocs-ic--ok{color:var(--accent)}',
        '.nmenu__ic .ocs-ic--free,.nmenu__ic .ocs-ic--none,.nmenu__ic .ocs-ic--wait{color:var(--muted)}',
        '@media (max-width:880px){.ocs-panel{top:auto;bottom:72px;right:8px;left:8px;width:auto}}',
      ].join('');
    }
    injectStyles();

    function iconKind(s, chan) {
      if (!isChannel(chan) || s.chan !== chan || s.registered == null) return 'wait';
      if (s.registered === false) return 'free';
      if ((ACCESS_RANK[s.access] || 0) >= ACCESS_RANK.vop) return 'ok';
      return 'none';
    }
    function iconTitle(kind, access) {
      if (kind === 'free') return pick('Salon non enregistré — cliquer pour l’enregistrer', 'Unregistered channel — click to register');
      if (kind === 'none') return pick('Salon enregistré — pas d’accès ChanServ', 'Registered channel — no ChanServ access');
      if (kind === 'ok') {
        var lvl = String(access || '').toUpperCase();
        return pick('Services du salon (' + lvl + ')', 'Channel services (' + lvl + ')');
      }
      return pick('Services du salon (ChanServ)', 'Channel services (ChanServ)');
    }

    function ChanIcon(props) {
      var kind = props.kind || 'wait';
      var dash = kind === 'free' ? '3 2.5' : undefined;
      var hash = [
        h('line', { key: 'a', x1: '3.5', y1: '9', x2: '18', y2: '9', strokeDasharray: dash }),
        h('line', { key: 'b', x1: '3.5', y1: '15', x2: '18', y2: '15', strokeDasharray: dash }),
        h('line', { key: 'c', x1: '9.5', y1: '3', x2: '7.6', y2: '21', strokeDasharray: dash }),
        h('line', { key: 'd', x1: '15.2', y1: '3', x2: '13.3', y2: '21', strokeDasharray: dash }),
      ];
      var badge = null;
      if (kind === 'free') {
        badge = h('g', { key: 'badge', transform: 'translate(13,13)' },
          h('circle', { cx: '5', cy: '5', r: '5.3', fill: 'var(--bg,#fff)', stroke: 'currentColor', strokeWidth: '1.6', strokeDasharray: undefined }),
          h('path', { d: 'M5 2.5v5M2.5 5h5', fill: 'none', stroke: 'currentColor', strokeWidth: '1.7' })
        );
      } else if (kind === 'none') {
        badge = h('g', { key: 'badge', transform: 'translate(12.2,12.2)' },
          h('circle', { cx: '5.6', cy: '5.6', r: '5.5', fill: 'var(--bg,#fff)', stroke: 'currentColor', strokeWidth: '1.5' }),
          h('path', { d: 'M4.1 5.1V4a1.5 1.5 0 0 1 3 0v1.1', fill: 'none', stroke: 'currentColor', strokeWidth: '1.45' }),
          h('rect', { x: '3.2', y: '5', width: '4.8', height: '3.5', rx: '0.7', fill: 'currentColor', stroke: 'none' })
        );
      } else if (kind === 'ok') {
        badge = h('g', { key: 'badge', transform: 'translate(12.2,12.2)' },
          h('circle', { cx: '5.6', cy: '5.6', r: '5.5', fill: 'currentColor', stroke: 'none' }),
          h('path', { d: 'M3.3 5.7l1.6 1.7 3.1-3.3', fill: 'none', stroke: 'var(--bg,#fff)', strokeWidth: '1.8' })
        );
      }
      return h('svg', {
        viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
        className: 'ocs-ic ocs-ic--' + kind,
      }, badge ? hash.concat([badge]) : hash);
    }

    function useActiveBuffer() {
      return useSyncExternalStore(
        function (cb) {
          var off = orbit.on('buffer.active', cb);
          var id = window.setInterval(cb, 400);
          return function () { if (typeof off === 'function') off(); window.clearInterval(id); };
        },
        function () { return orbit.state.active(); },
        function () { return orbit.state.active(); }
      );
    }

    function HeaderButton() {
      var chan = useActiveBuffer();
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      useEffect(function () {
        if (!isChannel(chan) || !identified()) return undefined;
        if (s.chan === chan && s.registered !== null) return undefined;
        queryInfo(chan);
        return undefined;
      }, [chan, identified()]);
      if (!iconVisible(s, chan)) return null;
      var kind = iconKind(s, chan);
      var on = s.open && s.chan === chan;
      var title = iconTitle(kind, s.access);
      return h('button', {
        type: 'button',
        className: 'topbar__search ocs-tb ocs-tb--' + kind + (on ? ' is-on' : ''),
        title: title,
        'aria-label': title,
        'aria-pressed': on,
        onClick: toggleOpen,
      }, h(ChanIcon, { kind: kind }));
    }

    function MoreMenuItem() {
      var chan = useActiveBuffer();
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      if (!iconVisible(s, chan)) return null;
      var kind = iconKind(s, chan);
      var on = s.open && s.chan === chan;
      var label = pick('Services du salon', 'Channel services');
      return h('button', {
        type: 'button',
        className: 'nmenu__item',
        role: 'menuitem',
        onClick: toggleOpen,
      },
        h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(ChanIcon, { kind: kind })),
        h('span', { className: 'nmenu__txt' }, h('b', null, on ? pick('Fermer les services', 'Close services') : label))
      );
    }

    function Field(props) {
      return h('div', { className: 'ocs-field' },
        props.label ? h('label', { className: 'ocs-label' }, props.label) : null,
        props.children
      );
    }

    function MemberServMenu(props) {
      var nick = props.nick;
      var close = props.close;
      var chan = useActiveBuffer();
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var openSt = useState(true);
      var open = openSt[0];
      var setOpen = openSt[1];
      var reasonSt = useState('');
      var reason = reasonSt[0];
      var setReason = reasonSt[1];
      useEffect(function () {
        if (!isChannel(chan) || !identified()) return undefined;
        if (s.chan === chan && s.registered !== null) return undefined;
        queryInfo(chan);
        return undefined;
      }, [chan]);
      var me = foldText(orbit.state.nick() || '');
      var serv = s.registered === true && can(ACCESS_RANK.vop);
      var ircOp = amChannelOp(chan);
      if (!isChannel(chan) || !identified()) return null;
      if (me && foldText(nick) === me) return null;
      if (!serv && !ircOp) return null;
      var ch = s.chan || chan;
      var hop = hasHalfop();
      var botName = s.bot || 'ChanServ';
      var title = pick('Commandes ', 'Commands ') + botName;
      function go(line) {
        runCmd('ChanServ', line, false);
        close();
      }
      function goIrc(line) {
        orbit.irc.send(line);
        close();
      }
      var kids = [
        h('button', {
          type: 'button',
          className: 'memberctx__item memberctx__item--sub',
          role: 'menuitem',
          'aria-expanded': open,
          onClick: function (e) { e.stopPropagation(); setOpen(!open); },
        }, title + (open ? ' ▾' : ' ▸')),
      ];
      if (open) {
        var aop = serv ? can(ACCESS_RANK.aop) : ircOp;
        var vop = serv ? can(ACCESS_RANK.vop) : ircOp;
        var hopOk = hop && (serv ? can(ACCESS_RANK.hop) : ircOp);
        if (aop) {
          kids.push(h('input', {
            className: 'ocs-mm__reason',
            value: reason,
            placeholder: pick('Motif (kick / ban)', 'Reason (kick / ban)'),
            onClick: function (e) { e.stopPropagation(); },
            onChange: function (e) { setReason(e.target.value); },
          }));
        }
        if (vop) {
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('VOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +v ' + nick);
          } }, pick('Voix', 'Voice')));
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('DEVOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -v ' + nick);
          } }, pick('Retirer la voix', 'Devoice')));
        }
        if (hopOk) {
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('HALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +h ' + nick);
          } }, 'Halfop'));
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('DEHALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -h ' + nick);
          } }, pick('Retirer halfop', 'Dehalfop')));
        }
        if (aop) {
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('OP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +o ' + nick);
          } }, 'Op'));
          kids.push(h('button', { type: 'button', className: 'memberctx__item', role: 'menuitem', onClick: function () {
            serv ? go('DEOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -o ' + nick);
          } }, pick('Retirer op', 'Deop')));
          kids.push(h('button', {
            type: 'button', className: 'memberctx__item memberctx__item--warn', role: 'menuitem',
            onClick: function () {
              var r = reason.trim();
              serv ? go('KICK ' + ch + ' ' + nick + (r ? ' ' + r : '')) : goIrc('KICK ' + ch + ' ' + nick + (r ? ' :' + r : ''));
            },
          }, pick('Expulser', 'Kick')));
          kids.push(h('button', {
            type: 'button', className: 'memberctx__item memberctx__item--warn', role: 'menuitem',
            onClick: function () {
              var r = reason.trim();
              serv ? go('BAN ' + ch + ' ' + nick + (r ? ' ' + r : '')) : goIrc('MODE ' + ch + ' +b ' + nick + '!*@*');
            },
          }, pick('Bannir', 'Ban')));
        }
      }
      return h('div', { className: 'ocs-mm' }, kids);
    }

    function Panel() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var chan = useActiveBuffer();
      var topicSt = useState('');
      var topic = topicSt[0];
      var setTopic = topicSt[1];
      var descSt = useState('');
      var desc = descSt[0];
      var setDesc = descSt[1];
      var saySt = useState('');
      var say = saySt[0];
      var setSay = saySt[1];
      var botPickSt = useState('');
      var botPick = botPickSt[0];
      var setBotPick = botPickSt[1];
      var infoOpenSt = useState(false);
      var infoOpen = infoOpenSt[0];
      var setInfoOpen = infoOpenSt[1];

      useEffect(function () {
        if (s.open && isChannel(chan) && s.chan !== chan) {
          patchUi({ chan: chan, flash: '', tab: 'salon' });
          queryInfo(chan);
        }
      }, [chan, s.open]);

      if (!s.open) return null;
      var ch = s.chan || chan;
      var tab = s.tab || 'salon';
      var showSujet = s.registered === true && can(ACCESS_RANK.aop);
      var showBot = s.registered === true && (can(ACCESS_RANK.sop) || (s.bot && can(ACCESS_RANK.aop)));
      if (tab === 'sujet' && !showSujet) tab = 'salon';
      if (tab === 'bot' && !showBot) tab = 'salon';

      var kids = [
        h('div', { className: 'ocs-head' },
          h('h2', { className: 'ocs-title' }, pick('Services du salon', 'Channel services')),
          h('button', { type: 'button', className: 'ocs-x', onClick: closePanel, 'aria-label': pick('Fermer', 'Close') }, '×')
        ),
        h('p', { className: 'ocs-sub' }, ch),
      ];
      if (s.flash) {
        kids.push(h('div', {
          className: 'ocs-flash' + (s.flashErr ? ' is-err' : ''),
          role: s.flashErr ? 'alert' : 'status',
        }, s.flash));
      }
      if (s.loading) kids.push(h('p', { className: 'ocs-sub' }, pick('Interrogation de ChanServ…', 'Asking ChanServ…')));
      if (s.registered === false) {
        kids.push(h(Field, { label: pick('Description (optionnel)', 'Description (optional)') },
          h('input', {
            className: 'ocs-input',
            value: desc,
            maxLength: 80,
            onChange: function (e) { setDesc(e.target.value); },
          })
        ));
        kids.push(h('button', {
          type: 'button',
          className: 'ocs-btn ocs-btn--primary',
          onClick: function () {
            var d = desc.trim() || pick('Salon EntreNous', 'EntreNous channel');
            runCmd('ChanServ', 'REGISTER ' + ch + ' ' + d, true);
          },
        }, pick('Enregistrer le salon', 'Register channel')));
      }
      if (s.registered === true) {
        var tabs = [
          h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'salon' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'salon' }); },
          }, pick('Salon', 'Channel')),
        ];
        if (showSujet) {
          tabs.push(h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'sujet' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'sujet' }); },
          }, pick('Sujet', 'Topic')));
        }
        if (showBot) {
          tabs.push(h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'bot' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'bot' }); },
          }, 'Bot'));
        }
        kids.push(h('div', { className: 'ocs-tabs', role: 'tablist' }, tabs));
        kids.push(h('div', { className: 'ocs-row' },
          h('span', { className: 'ocs-badge' }, (s.access || 'none').toUpperCase()),
          s.bot ? h('span', { className: 'ocs-badge' }, pick('Bot', 'Bot') + ' ' + s.bot) : null
        ));

        if (tab === 'salon') {
          kids.push(h('button', {
            type: 'button',
            className: 'ocs-btn',
            onClick: function () {
              setInfoOpen(true);
              beginExpect('info', ch);
              patchUi({ loading: true });
              cs('INFO ' + ch);
            },
          }, pick('Info du salon', 'Channel info')));
          if (infoOpen && s.infoText) kids.push(h('pre', { className: 'ocs-info' }, s.infoText));
        }

        if (tab === 'sujet' && showSujet) {
          kids.push(h(Field, { label: pick('Sujet', 'Topic') },
            h('input', { className: 'ocs-input', value: topic, onChange: function (e) { setTopic(e.target.value); } })
          ));
          kids.push(h('button', {
            type: 'button',
            className: 'ocs-btn ocs-btn--primary',
            onClick: function () { if (topic.trim()) runCmd('ChanServ', 'TOPIC ' + ch + ' ' + topic.trim()); },
          }, pick('Changer le sujet', 'Set topic')));
        }

        if (tab === 'bot' && showBot) {
          if (can(ACCESS_RANK.sop)) {
            if (!s.bot) {
              if (!s.bots.length) {
                kids.push(h('button', { type: 'button', className: 'ocs-btn', onClick: queryBotlist },
                  pick('Charger la liste des bots', 'Load bot list')));
              } else {
                kids.push(h(Field, { label: pick('Bot à assigner', 'Bot to assign') },
                  h('select', {
                    className: 'ocs-select',
                    value: botPick,
                    onChange: function (e) { setBotPick(e.target.value); },
                  }, [h('option', { value: '' }, '—')].concat(s.bots.map(function (b) {
                    return h('option', { key: b, value: b }, b);
                  })))
                ));
                kids.push(h('button', {
                  type: 'button',
                  className: 'ocs-btn ocs-btn--primary',
                  onClick: function () {
                    var b = botPick || s.bots[0];
                    if (b) runCmd('BotServ', 'ASSIGN ' + ch + ' ' + b, true);
                  },
                }, pick('Assigner le bot', 'Assign bot')));
              }
            } else {
              kids.push(h('button', {
                type: 'button',
                className: 'ocs-btn',
                onClick: function () { runCmd('BotServ', 'UNASSIGN ' + ch, true); },
              }, pick('Retirer le bot', 'Unassign bot')));
            }
          }
          if (s.bot && can(ACCESS_RANK.aop)) {
            kids.push(h(Field, { label: pick('Message du bot', 'Bot message') },
              h('input', { className: 'ocs-input', value: say, onChange: function (e) { setSay(e.target.value); } })
            ));
            kids.push(h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (say.trim()) runCmd('BotServ', 'SAY ' + ch + ' ' + say.trim());
              } }, pick('Dire', 'Say')),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (say.trim()) runCmd('BotServ', 'ACT ' + ch + ' ' + say.trim());
              } }, pick('Action', 'Act'))
            ));
          }
        }
      }
      return h('div', { className: 'ocs-panel', role: 'dialog', 'aria-label': pick('Services du salon', 'Channel services') }, kids);
    }

    orbit.on('raw', onRaw);
    orbit.on('status', function (st) {
      if (st === 'registered') return;
      cache = {};
      pending = [];
      expectKind = '';
      patchUi({ open: false, registered: null, access: 'none', bot: '', bots: [], loading: false, tab: 'salon' });
    });
    orbit.addMessageFilter(function (m) {
      return shouldHideServiceReply(m);
    });
    orbit.addUi('topbar_item', function () { return h(HeaderButton); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem); });
    orbit.addUi('overlay', function () { return h(Panel); });
    if (typeof orbit.addMemberMenu === 'function') {
      orbit.addMemberMenu(function (ctx) {
        return h(MemberServMenu, { nick: ctx.nick, close: ctx.close });
      });
    }
    log('ChanServ/BotServ panel — topbar + overlay');
  });
})();
