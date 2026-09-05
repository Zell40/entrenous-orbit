/*
 * orbit-chanserv — commandes ChanServ / BotServ selon l’accès Anope.
 *
 * Icône barre du salon (desktop) + menu ⋮ (mobile). Panneau overlay (gestion salon).
 * Kick / ban / op / voix : menu de la liste (Commandes <bot>).
 * Salon non enregistré → REGISTER (compte NickServ requis).
 * Salon enregistré → commandes filtrées (VOP/HOP/AOP/SOP/fondateur) + bot.
 *
 * config.json:
 *   "plugins": [".../orbit-chanserv/orbit-chanserv.js?v=21"]
 *   "chanserv": { "kickReason": "Vous n'êtes pas le bienvenu sur ce salon" }
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
    var useLayoutEffect = React.useLayoutEffect;
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
      reasonAsk: null,
      listeners: new Set(),
    };
    var snap = copyUi();
    function copyUi() {
      return {
        open: ui.open, chan: ui.chan, loading: ui.loading, registered: ui.registered,
        founder: ui.founder, bot: ui.bot, access: ui.access, bots: ui.bots.slice(),
        infoText: ui.infoText, flash: ui.flash, flashErr: ui.flashErr, tab: ui.tab, reasonAsk: ui.reasonAsk,
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
    function defaultKickReason() {
      try {
        var c = orbit.config && orbit.config();
        var r = c && c.chanserv && String(c.chanserv.kickReason || '').trim();
        if (r) return r;
      } catch (e) { /* ignore */ }
      return pick("Vous n'êtes pas le bienvenu sur ce salon", 'You are not welcome in this channel');
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
    function findBuffer(chan) {
      try {
        var st = orbit.state.get();
        if (!st || !st.buffers) return null;
        if (st.buffers[chan]) return st.buffers[chan];
        var want = String(chan || '').toLowerCase();
        if (st.buffers[want]) return st.buffers[want];
        var keys = Object.keys(st.buffers);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].toLowerCase() === want) return st.buffers[keys[i]];
        }
      } catch (e) { /* ignore */ }
      return null;
    }
    function amChannelOp(chan) {
      try {
        var st = orbit.state.get();
        var buf = findBuffer(chan);
        var mem = buf && buf.members && buf.members[st.nick];
        return /[~&@%]/.test((mem && (mem.prefixes || mem.prefix)) || '');
      } catch (e) { return false; }
    }
    function isNamedService(n) {
      return /^(chan|bot|nick|host|memo|oper|help|global|link)serv$/i.test(String(n || '').replace(/\[.*$/, ''));
    }
    function channelBotNick(chan, fromInfo) {
      var info = String(fromInfo || '').replace(/[.,;]+$/, '').trim();
      if (info && !/^(none|aucun|n\/?a|-|\*|no)$/i.test(info) && !isNamedService(info)) return info;
      var buf = findBuffer(chan);
      var members = (buf && buf.members) || {};
      var best = '';
      var bestRank = 99;
      Object.keys(members).forEach(function (n) {
        var m = members[n];
        if (!m || !m.bot || isNamedService(n)) return;
        var p = m.prefixes || m.prefix || '';
        var r = !p ? 90 : (p.indexOf('~') >= 0 ? 0 : p.indexOf('&') >= 0 ? 1 : p.indexOf('@') >= 0 ? 2 : p.indexOf('%') >= 0 ? 3 : p.indexOf('+') >= 0 ? 4 : 80);
        if (r < bestRank) { bestRank = r; best = m.nick || n; }
      });
      return best;
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
      var bm = raw.match(/(?:bot(?:serv)?|robot)\s*(?:assigne[e]?|assigned)?\s*:\s*(\S+)/i)
        || raw.match(/\bbot\s+(\S+)\s+(?:is assigned|assigne)/i);
      if (bm && !/^(n\/?a|none|aucun|-|\*|no)$/i.test(bm[1]) && !isNamedService(bm[1])) {
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
        '.ocs-title{margin:0;font-size:1.02rem;font-weight:800;display:flex;align-items:center;gap:.45rem}',
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
        'display:inline-flex;align-items:center;justify-content:center;gap:.4rem;',
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
        'display:inline-flex;align-items:center;gap:.35rem;padding:.4rem .6rem;border-radius:8px;cursor:pointer}',
        '.ocs-tab.is-on{color:var(--accent);background:var(--accent-soft)}',
        '.ocs-mm{position:relative;padding:.1rem 0 .15rem}',
        '.ocs-mm__trig{display:flex;align-items:center;justify-content:flex-start;gap:.45rem;width:100%;font-weight:700}',
        '.memberctx__item.ocs-mirow{display:flex;align-items:center;gap:.5rem}',
        '.ocs-miwrap{display:inline-flex;flex:none;line-height:0}',
        '.ocs-mi{flex:none;display:block;opacity:.88}',
        '.memberctx__item:hover .ocs-mi,.ocs-mm.is-open .ocs-mm__trig .ocs-mi,.ocs-tab.is-on .ocs-mi{opacity:1}',
        '.ocs-mm__chev{opacity:.55;font-size:.95rem;line-height:1}',
        '.ocs-mm.is-open .ocs-mm__trig,.ocs-mm:hover .ocs-mm__trig{background:var(--accent);color:#fff}',
        '.ocs-mm__bridge{position:absolute;right:100%;top:-80px;bottom:-80px;width:18px;z-index:219}',
        '.ocs-mm__fly{position:absolute;right:calc(100% - 2px);top:-4px;z-index:220;min-width:196px;max-width:260px;',
        'max-height:min(70vh,420px);overflow-y:auto;padding:4px;border-radius:10px;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border-2);box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45))}',
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

    function Mi(name, size) {
      var k = 0;
      function p(d) { return h('path', { key: 'p' + (++k), d: d }); }
      function c(cx, cy, r, fill) {
        return h('circle', { key: 'c' + (++k), cx: cx, cy: cy, r: r, fill: fill || 'none', stroke: fill ? 'none' : undefined });
      }
      function l(x1, y1, x2, y2) { return h('line', { key: 'l' + (++k), x1: x1, y1: y1, x2: x2, y2: y2 }); }
      var kids;
      if (name === 'voice') kids = [h('polygon', { key: 'poly', points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }), p('M15.54 8.46a5 5 0 0 1 0 7.07'), p('M19.07 4.93a10 10 0 0 1 0 14.14')];
      else if (name === 'novoice') kids = [h('polygon', { key: 'poly', points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }), l(22, 9, 16, 15), l(16, 9, 22, 15)];
      else if (name === 'hop') kids = [p('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'), p('M9.2 13h5.6')];
      else if (name === 'nohop') kids = [p('M19.7 14a6.9 6.9 0 0 0 .3-2V6a1 1 0 0 0-1-1c-2 0-4.5-1.2-6.24-2.72a1.17 1.17 0 0 0-1.52 0C9.51 3.81 8 4.68 6.3 5'), p('M5 7v6c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c1.8-.63 3.5-1.6 4.8-3'), l(2, 2, 22, 22)];
      else if (name === 'op') kids = [p('m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z'), l(4, 20, 20, 20)];
      else if (name === 'noop') kids = [p('m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z'), l(4, 20, 20, 20), l(3, 3, 21, 21)];
      else if (name === 'kick') kids = [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), c(9, 7, 4), l(22, 11, 16, 11)];
      else if (name === 'ban') kids = [c(12, 12, 10), p('m4.9 4.9 14.2 14.2')];
      else if (name === 'bankick') kids = [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), c(9, 7, 4), l(17, 8, 22, 13), l(22, 8, 17, 13)];
      else if (name === 'bot') kids = [p('M12 8V4H8'), h('rect', { key: 'r', x: 4, y: 8, width: 16, height: 12, rx: 2 }), p('M2 14h2'), p('M20 14h2'), p('M15 13v2'), p('M9 13v2')];
      else if (name === 'hash') kids = [l(4, 9, 20, 9), l(4, 15, 20, 15), l(10, 3, 8, 21), l(16, 3, 14, 21)];
      else if (name === 'topic') kids = [p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')];
      else if (name === 'info') kids = [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')];
      else if (name === 'plus') kids = [c(12, 12, 10), p('M8 12h8'), p('M12 8v8')];
      else if (name === 'list') kids = [p('M8 6h13'), p('M8 12h13'), p('M8 18h13'), c(4, 6, 1.1, 'currentColor'), c(4, 12, 1.1, 'currentColor'), c(4, 18, 1.1, 'currentColor')];
      else if (name === 'assign') kids = [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), c(9, 7, 4), l(19, 8, 19, 14), l(22, 11, 16, 11)];
      else if (name === 'unassign') kids = [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), c(9, 7, 4), l(22, 11, 16, 11)];
      else if (name === 'say') kids = [p('M7.9 20A9 9 0 1 0 4 16.1L2 22z')];
      else if (name === 'act') kids = [c(12, 5, 2), p('M9 20V9.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V20'), p('M6 8l2 2'), p('M18 8l-2 2')];
      else if (name === 'check') kids = [p('M20 6 9 17l-5-5')];
      else kids = [p('M12 5v14'), p('M5 12h14')];
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 15, height: size || 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', className: 'ocs-mi',
      }, kids);
    }
    function labeled(icon, text) {
      return [h('span', { key: 'i', className: 'ocs-miwrap', 'aria-hidden': true }, Mi(icon)), h('span', { key: 'l' }, text)];
    }
    function menuBtn(key, warn, onClick, icon, label) {
      return h('button', {
        key: key, type: 'button',
        className: 'memberctx__item ocs-mirow' + (warn ? ' memberctx__item--warn' : ''),
        role: 'menuitem', onClick: onClick,
      }, labeled(icon, label));
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
      var openSt = useState(false);
      var open = openSt[0];
      var setOpen = openSt[1];
      var closeT = useRef(0);
      var flyRef = useRef(null);
      function keepOpen() {
        if (closeT.current) { clearTimeout(closeT.current); closeT.current = 0; }
        setOpen(true);
      }
      function delayClose() {
        if (closeT.current) clearTimeout(closeT.current);
        closeT.current = setTimeout(function () { closeT.current = 0; setOpen(false); }, 280);
      }
      useEffect(function () {
        return function () { if (closeT.current) clearTimeout(closeT.current); };
      }, []);
      useLayoutEffect(function () {
        if (!open) return undefined;
        var el = flyRef.current;
        if (!el) return undefined;
        el.style.top = '-4px';
        el.style.bottom = 'auto';
        el.style.maxHeight = '';
        var pad = 8;
        var r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - pad) {
          el.style.top = 'auto';
          el.style.bottom = '0px';
          r = el.getBoundingClientRect();
        }
        if (r.top < pad) {
          el.style.top = 'auto';
          el.style.bottom = '0px';
          r = el.getBoundingClientRect();
          if (r.top < pad) {
            el.style.maxHeight = Math.max(120, window.innerHeight - pad * 2) + 'px';
          }
        }
        return undefined;
      }, [open, nick]);
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
      var botName = channelBotNick(ch, s.bot);
      if (!botName) return null;
      var title = pick('Commandes ', 'Commands ') + botName;
      function go(line) {
        runCmd('ChanServ', line, false);
        close();
      }
      function goIrc(line) {
        orbit.irc.send(line);
        close();
      }
      var aop = serv ? can(ACCESS_RANK.aop) : ircOp;
      var vop = serv ? can(ACCESS_RANK.vop) : ircOp;
      var hopOk = hop && (serv ? can(ACCESS_RANK.hop) : ircOp);
      function askReason(kind) {
        patchUi({ reasonAsk: { nick: nick, chan: ch, kind: kind, serv: !!serv } });
        close();
      }
      var fly = [];
      if (vop) {
        fly.push(menuBtn('v', false, function () {
          serv ? go('VOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +v ' + nick);
        }, 'voice', pick('Voix', 'Voice')));
        fly.push(menuBtn('dv', false, function () {
          serv ? go('DEVOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -v ' + nick);
        }, 'novoice', pick('Retirer la voix', 'Devoice')));
      }
      if (hopOk) {
        fly.push(menuBtn('h', false, function () {
          serv ? go('HALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +h ' + nick);
        }, 'hop', 'Halfop'));
        fly.push(menuBtn('dh', false, function () {
          serv ? go('DEHALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -h ' + nick);
        }, 'nohop', pick('Retirer halfop', 'Dehalfop')));
      }
      if (aop) {
        fly.push(menuBtn('o', false, function () {
          serv ? go('OP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +o ' + nick);
        }, 'op', 'Op'));
        fly.push(menuBtn('do', false, function () {
          serv ? go('DEOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -o ' + nick);
        }, 'noop', pick('Retirer op', 'Deop')));
        fly.push(menuBtn('k', true, function () { askReason('kick'); }, 'kick', pick('Expulser', 'Kick')));
        fly.push(menuBtn('b', true, function () { askReason('ban'); }, 'ban', pick('Bannir', 'Ban')));
        fly.push(menuBtn('bk', true, function () { askReason('bankick'); }, 'bankick', pick('Bannir + éjecter', 'Ban + kick')));
      }
      return h('div', {
        className: 'ocs-mm' + (open ? ' is-open' : ''),
        onMouseEnter: keepOpen,
        onMouseLeave: delayClose,
      },
        h('button', {
          type: 'button',
          className: 'memberctx__item memberctx__item--sub ocs-mm__trig',
          role: 'menuitem',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: function (e) {
            e.stopPropagation();
            if (open) { if (closeT.current) clearTimeout(closeT.current); setOpen(false); }
            else keepOpen();
          },
        },
          h('span', { className: 'ocs-mm__chev', 'aria-hidden': true }, '‹'),
          Mi('bot'),
          h('span', null, title)
        ),
        open ? h('div', { className: 'ocs-mm__bridge', 'aria-hidden': true }) : null,
        open ? h('div', { ref: flyRef, className: 'ocs-mm__fly', role: 'menu', 'aria-label': title }, fly) : null
      );
    }

    function ReasonAsk() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var reasonSt = useState('');
      var reason = reasonSt[0];
      var setReason = reasonSt[1];
      var ask = s.reasonAsk;
      useEffect(function () {
        setReason('');
      }, [ask && ask.nick, ask && ask.kind, ask && ask.chan]);
      if (!ask) return null;
      var n = ask.nick;
      var ch = ask.chan;
      var title = ask.kind === 'kick'
        ? pick('Motif de l’expulsion de ', 'Kick reason for ') + n
        : ask.kind === 'bankick'
          ? pick('Motif du bannir + éjecter ', 'Ban + kick reason for ') + n
          : pick('Motif du bannissement de ', 'Ban reason for ') + n;
      function run() {
        var r = reason.trim() || defaultKickReason();
        patchUi({ reasonAsk: null });
        if (ask.serv) {
          if (ask.kind === 'kick') runCmd('ChanServ', 'KICK ' + ch + ' ' + n + ' ' + r);
          else if (ask.kind === 'ban') runCmd('ChanServ', 'BAN ' + ch + ' ' + n + ' ' + r);
          else {
            runCmd('ChanServ', 'BAN ' + ch + ' ' + n + ' ' + r);
            runCmd('ChanServ', 'KICK ' + ch + ' ' + n + ' ' + r);
          }
        } else if (ask.kind === 'kick') {
          orbit.irc.send('KICK ' + ch + ' ' + n + ' :' + r);
        } else if (ask.kind === 'ban') {
          orbit.irc.send('MODE ' + ch + ' +b ' + n + '!*@*');
        } else {
          orbit.irc.send('MODE ' + ch + ' +b ' + n + '!*@*');
          orbit.irc.send('KICK ' + ch + ' ' + n + ' :' + r);
        }
      }
      return h('div', {
        className: 'memberrsn-scrim',
        onMouseDown: function (e) { if (e.target === e.currentTarget) patchUi({ reasonAsk: null }); },
      },
        h('div', { className: 'memberrsn', role: 'dialog', 'aria-label': title },
          h('div', { className: 'memberrsn__head' }, title),
          h('input', {
            className: 'memberrsn__in',
            autoFocus: true,
            value: reason,
            placeholder: defaultKickReason(),
            onChange: function (e) { setReason(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') run();
              if (e.key === 'Escape') patchUi({ reasonAsk: null });
            },
          }),
          h('div', { className: 'memberrsn__row' },
            h('button', { type: 'button', className: 'memberrsn__btn', onClick: function () { patchUi({ reasonAsk: null }); } }, pick('Annuler', 'Cancel')),
            h('button', {
              type: 'button',
              className: 'memberrsn__btn memberrsn__btn--go',
              onClick: run,
            }, pick('Confirmer', 'Confirm'))
          )
        )
      );
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
          h('h2', { className: 'ocs-title' }, h(ChanIcon, { kind: iconKind(s, ch) }), pick('Services du salon', 'Channel services')),
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
        }, labeled('plus', pick('Enregistrer le salon', 'Register channel'))));
      }
      if (s.registered === true) {
        var tabs = [
          h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'salon' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'salon' }); },
          }, labeled('hash', pick('Salon', 'Channel'))),
        ];
        if (showSujet) {
          tabs.push(h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'sujet' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'sujet' }); },
          }, labeled('topic', pick('Sujet', 'Topic'))));
        }
        if (showBot) {
          tabs.push(h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === 'bot' ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: 'bot' }); },
          }, labeled('bot', 'Bot')));
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
          }, labeled('info', pick('Info du salon', 'Channel info'))));
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
          }, labeled('check', pick('Changer le sujet', 'Set topic')));
        }

        if (tab === 'bot' && showBot) {
          if (can(ACCESS_RANK.sop)) {
            if (!s.bot) {
              if (!s.bots.length) {
                kids.push(h('button', { type: 'button', className: 'ocs-btn', onClick: queryBotlist },
                  labeled('list', pick('Charger la liste des bots', 'Load bot list'))));
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
                }, labeled('assign', pick('Assigner le bot', 'Assign bot'))));
              }
            } else {
              kids.push(h('button', {
                type: 'button',
                className: 'ocs-btn',
                onClick: function () { runCmd('BotServ', 'UNASSIGN ' + ch, true); },
              }, labeled('unassign', pick('Retirer le bot', 'Unassign bot'))));
            }
          }
          if (s.bot && can(ACCESS_RANK.aop)) {
            kids.push(h(Field, { label: pick('Message du bot', 'Bot message') },
              h('input', { className: 'ocs-input', value: say, onChange: function (e) { setSay(e.target.value); } })
            ));
            kids.push(h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (say.trim()) runCmd('BotServ', 'SAY ' + ch + ' ' + say.trim());
              } }, labeled('say', pick('Dire', 'Say'))),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (say.trim()) runCmd('BotServ', 'ACT ' + ch + ' ' + say.trim());
              } }, labeled('act', pick('Action', 'Act')))
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
      patchUi({ open: false, registered: null, access: 'none', bot: '', bots: [], loading: false, tab: 'salon', reasonAsk: null });
    });
    orbit.addMessageFilter(function (m) {
      return shouldHideServiceReply(m);
    });
    orbit.addUi('topbar_item', function () { return h(HeaderButton); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem); });
    orbit.addUi('overlay', function () { return h(Panel); });
    orbit.addUi('overlay', function () { return h(ReasonAsk); });
    if (typeof orbit.addMemberMenu === 'function') {
      orbit.addMemberMenu(function (ctx) {
        return h(MemberServMenu, { nick: ctx.nick, close: ctx.close });
      });
    }
    log('ChanServ/BotServ panel — topbar + overlay');
  });
})();
