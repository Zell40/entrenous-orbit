/*
 * orbit-chanserv — commandes ChanServ / BotServ selon l’accès Anope.
 *
 * Icône barre du salon (desktop) + menu ⋮ (mobile). Panneau overlay (gestion salon).
 * Kick / ban / op / voix : menu de la liste (Commandes <bot>).
 * Salon non enregistré → REGISTER (compte NickServ requis).
 * Salon enregistré → commandes filtrées (VOP/HOP/AOP/SOP/fondateur) + bot.
 *
 * config.json:
 *   "plugins": [".../orbit-chanserv/orbit-chanserv.js?v=34"]
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
      lastCmd: '',
      tab: 'info',
      accessList: [],
      accessLoading: false,
      reasonAsk: null,
      dropAsk: null,
      listeners: new Set(),
    };
    var snap = copyUi();
    function copyUi() {
      return {
        open: ui.open, chan: ui.chan, loading: ui.loading, registered: ui.registered,
        founder: ui.founder, bot: ui.bot, access: ui.access, bots: ui.bots.slice(),
        infoText: ui.infoText, flash: ui.flash, flashErr: ui.flashErr, lastCmd: ui.lastCmd, tab: ui.tab,
        accessList: ui.accessList.slice(), accessLoading: ui.accessLoading, reasonAsk: ui.reasonAsk, dropAsk: ui.dropAsk,
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
    function hasPrefixLetter(letter) {
      var p = String((orbit.server.isupport() || {}).PREFIX || '(qaohv)~&@%+');
      var close = p.indexOf(')');
      var letters = close > 0 ? p.slice(1, close) : 'qaohv';
      return letters.indexOf(letter) >= 0;
    }
    function hasHalfop() {
      return hasPrefixLetter('h');
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
    function memberPrefixChars(chan, nick) {
      var buf = findBuffer(chan);
      var members = (buf && buf.members) || {};
      var m = members[nick];
      if (!m) {
        var want = foldText(nick);
        Object.keys(members).forEach(function (n) {
          if (!m && foldText(n) === want) m = members[n];
        });
      }
      return (m && (m.prefixes || m.prefix)) || '';
    }
    function strongestPrefixSym(pfx) {
      var order = '~&@%+';
      for (var i = 0; i < order.length; i++) {
        if (String(pfx || '').indexOf(order[i]) >= 0) return order[i];
      }
      return '';
    }
    function nickKeys(nick) {
      var n = String(nick || '');
      var keys = [foldText(n)];
      var cut = n.replace(/\[.*$/, '');
      if (cut && foldText(cut) !== keys[0]) keys.push(foldText(cut));
      return keys;
    }
    function xopForNick(nick) {
      var keys = nickKeys(nick);
      var best = '';
      var bestR = 0;
      (ui.accessList || []).forEach(function (row) {
        var k = foldText(row.nick);
        if (keys.indexOf(k) < 0) return;
        var r = ACCESS_RANK[String(row.level || '').toLowerCase()] || 0;
        if (r > bestR) { bestR = r; best = String(row.level || '').toUpperCase(); }
      });
      return best;
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
    var xopQueue = [];
    var xopRows = [];
    var accessFetched = '';
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

    function queryAccess(chan, force) {
      if (!isChannel(chan) || !identified()) return;
      var key = String(chan).toLowerCase();
      if (!force && accessFetched === key && ui.accessList.length) return;
      accessFetched = key;
      patchUi({ accessLoading: true });
      rpcCall('access', chan).then(function (data) {
        if (ui.chan && String(ui.chan).toLowerCase() !== key) return;
        if (data && data.ok && data.lists) {
          var rows = [];
          ['SOP', 'AOP', 'HOP', 'VOP'].forEach(function (lv) {
            rows = rows.concat(parseXopList(data.lists[lv], lv));
          });
          patchUi({ accessList: rows, accessLoading: false });
          expectKind = '';
          return;
        }
        xopRows = [];
        xopQueue = ['SOP', 'AOP', 'HOP', 'VOP'];
        beginExpect('xop', chan);
        cs(xopQueue[0] + ' ' + chan + ' LIST');
      });
    }

    function looksLikeServOk(text) {
      var t = foldText(text);
      return /a ete enregistre|has been registered|enregistre avec succes|registered successfully|sujet (modifie|change|a ete)|topic (is now|changed|set|lock)|est maintenant|is now|option|keeptopic|mlock|a ete defini|has been set/.test(t);
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

    function infoRows(text) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^informations?\s/i.test(s) || /^info(rmation)?s?\s+(about|for|on)\b/i.test(s)) {
          rows.push({ head: true, v: s });
          return;
        }
        var m = s.match(/^([^:]{2,42}):\s*(.*)$/);
        if (m) {
          var key = foldText(m[1]);
          var row = { k: m[1], v: m[2] };
          if (/fondateur|founder/.test(key)) row.hi = true;
          if (/^options?$/.test(key) && m[2]) {
            row.pills = m[2].split(/\s*,\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
          }
          rows.push(row);
        } else rows.push({ v: s });
      });
      return rows;
    }

    function parseChanOptions(text) {
      var on = {};
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        var m = s.match(/^options?\s*:\s*(.+)$/i);
        if (!m) return;
        m[1].split(/\s*,\s*/).forEach(function (part) {
          var t = foldText(part);
          if (/secureops|ops securises/.test(t)) on.SECUREOPS = true;
          else if (/securefounder|securite de fondateur/.test(t)) on.SECUREFOUNDER = true;
          else if (/restricted|restreint/.test(t)) on.RESTRICTED = true;
          else if (/keeptopic|conserver le topic|maintien du topic/.test(t)) on.KEEPTOPIC = true;
          else if (/keepmodes|maintien des modes/.test(t)) on.KEEPMODES = true;
          else if (/topiclock|verrouill/.test(t)) on.TOPICLOCK = true;
          else if (/signkick|kicks signes/.test(t)) on.SIGNKICK = true;
          else if (/opnotice/.test(t)) on.OPNOTICE = true;
          else if (/peace|paix/.test(t)) on.PEACE = true;
          else if (/persist|persistant/.test(t)) on.PERSIST = true;
          else if (/private|prive/.test(t)) on.PRIVATE = true;
          else if (/\bsecure\b|securise/.test(t)) on.SECURE = true;
        });
      });
      return on;
    }

    function parseDropCode(text) {
      var t = stripIrc(text).replace(/\s+/g, ' ').trim();
      var m = t.match(/\/CS\s+DROP\s+\S+\s+(\S+)/i)
        || t.match(/\/msg\s+chanserv\s+DROP\s+\S+\s+(\S+)/i)
        || t.match(/\bDROP\s+\S+\s+([A-Za-z0-9]{6,})\s*$/i);
      return m ? m[1].replace(/^['"]+|['".,;]+$/g, '') : '';
    }
    function parseMlock(text) {
      var m = String(text || '').match(/modes?\s+verrouill[ée]s?\s*:\s*(\S+)/i)
        || String(text || '').match(/\bmlock\s*:\s*(\S+)/i)
        || String(text || '').match(/mode lock\s*:\s*(\S+)/i);
      return m ? m[1] : '';
    }
    function mlockHas(mlock, letter) {
      return String(mlock || '').indexOf(letter) >= 0;
    }
    function parseXopList(text, level) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^(liste|list|num\b|end of|fin de|acc[eè]s|access list|entries for)/i.test(s)) return;
        if (/vide|empty|no (sop|aop|hop|vop|entries|users)|aucun/i.test(s) && !/^\d+/.test(s)) return;
        var m = s.match(/^(?:[-*]\s*)?\d+\s+(SOP|AOP|HOP|VOP|QOP)\s+(\S+)/i);
        if (m) { rows.push({ level: m[1].toUpperCase(), nick: m[2].replace(/[.,;]+$/, '') }); return; }
        m = s.match(/^(?:[-*]\s*)?\d+\s+(\S+)/);
        if (m && !/^(num|nick|pseudo|level|niveau)$/i.test(m[1])) {
          rows.push({ level: level, nick: m[1].replace(/[.,;]+$/, '') });
        }
      });
      return rows;
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
        return;
      }
      if (kind === 'botlist') {
        patchUi({ bots: parseBotlist(text), loading: false });
        expectKind = '';
        return;
      }
      if (kind === 'xop') {
        var lv = xopQueue.shift() || 'AOP';
        xopRows = xopRows.concat(parseXopList(text, lv));
        if (xopQueue.length) {
          beginExpect('xop', chan);
          cs(xopQueue[0] + ' ' + chan + ' LIST');
          return;
        }
        patchUi({ accessList: xopRows.slice(), accessLoading: false });
        expectKind = '';
        return;
      }
      if (kind === 'drop') {
        var dropRaw = stripIrc(text).replace(/\s+/g, ' ').trim();
        var code = parseDropCode(dropRaw);
        var dropped = /a ete (supprime|droppe|desenregistre)|has been (dropped|unregistered)|dropped successfully/.test(foldText(dropRaw));
        if (dropped) {
          patchUi({ dropAsk: null, registered: false, loading: false, flash: dropRaw, flashErr: false });
          expectKind = '';
          cache = {};
          return;
        }
        if (code) {
          patchUi({
            dropAsk: { chan: (ui.dropAsk && ui.dropAsk.chan) || chan, code: code, waiting: false, error: '' },
            loading: false,
            flash: '',
            flashErr: false,
          });
          expectKind = '';
          return;
        }
        if (looksLikeServError(dropRaw)) {
          patchUi({
            dropAsk: {
              chan: (ui.dropAsk && ui.dropAsk.chan) || chan,
              code: (ui.dropAsk && ui.dropAsk.code) || '',
              waiting: false,
              error: dropRaw,
            },
            loading: false,
            flash: dropRaw,
            flashErr: true,
          });
          expectKind = '';
          return;
        }
        hideUntil = Date.now() + HIDE_MS;
        return;
      }
      if (kind === 'cmd') {
        var raw = stripIrc(text).replace(/\s+/g, ' ').trim().slice(0, 400);
        var err = looksLikeServError(raw);
        patchUi({ flash: raw, flashErr: !!err, loading: false, open: err ? true : ui.open });
        expectKind = '';
        cache = {};
        if (!err && ui.chan) {
          setTimeout(function () { queryInfo(ui.chan, { keepFlash: true }); }, 500);
          if (ui.tab === 'access') {
            setTimeout(function () { queryAccess(ui.chan, true); }, 700);
          }
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
      patchUi({ flash: '', lastCmd: service + ' ' + line, loading: true });
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
      patchUi({ open: true, chan: chan, flash: '', flashErr: false, lastCmd: '', tab: 'info' });
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
        '.ocs-panel{position:fixed;top:calc(env(safe-area-inset-top,0px) + 3.6rem);right:12px;z-index:160;',
        'width:max-content;min-width:min(28rem,calc(100vw - 1.5rem));',
        'max-width:calc(100vw - 1.5rem);box-sizing:border-box;',
        'max-height:min(88vh,720px);overflow:hidden;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45));',
        'padding:1rem 1rem .9rem;display:flex;flex-direction:column;gap:.55rem}',
        '.ocs-chrome{display:flex;flex-direction:column;gap:.55rem;flex:none}',
        '.ocs-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:.55rem;width:100%;min-width:0}',
        '.ocs-tabs{flex:none;width:max-content;max-width:100%}',
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
        '.ocs-btn--warn{color:var(--danger,#b91c1c);border-color:color-mix(in srgb,var(--danger,#dc2626) 40%,var(--border))}',
        '.ocs-flash{font-size:.88rem;line-height:1.45;padding:.6rem .75rem;border-radius:12px;font-weight:650;',
        'color:var(--accent);background:var(--accent-soft);',
        'border:1px solid color-mix(in srgb,var(--accent) 38%,var(--border))}',
        '.ocs-flash.is-err{color:var(--danger,#b91c1c);font-weight:700;',
        'background:color-mix(in srgb,var(--danger,#dc2626) 14%,var(--bg));',
        'border-color:color-mix(in srgb,var(--danger,#dc2626) 40%,var(--border))}',
        '.ocs-h{margin:.2rem 0 0;font-size:.78rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}',
        '.ocs-info{display:flex;flex-direction:column;gap:.35rem}',
        '.ocs-dl__head{font-size:.8rem;font-weight:800;color:var(--accent);padding:.15rem .15rem .35rem}',
        '.ocs-dl__row{display:grid;grid-template-columns:minmax(7.5rem,9.2rem) 1fr;gap:.35rem .75rem;',
        'padding:.45rem .6rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)}',
        '.ocs-dl__k{font-size:.7rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);align-self:center}',
        '.ocs-dl__v{font-size:.86rem;line-height:1.4;color:var(--ink);word-break:break-word}',
        '.ocs-dl__row.is-hi{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 42%,var(--border))}',
        '.ocs-dl__row.is-hi .ocs-dl__k{color:var(--accent)}',
        '.ocs-pills{display:flex;flex-wrap:wrap;gap:.3rem}',
        '.ocs-pill{font-size:.72rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;',
        'background:var(--bg);border:1px solid var(--border);color:var(--ink)}',
        '.ocs-now{font-size:.82rem;line-height:1.4;padding:.5rem .65rem;border-radius:10px;',
        'background:var(--bg-soft);border:1px solid var(--border);color:var(--ink);white-space:pre-wrap}',
        '.ocs-flash__cmd{display:block;font-size:.72rem;font-weight:650;opacity:.75;margin-bottom:.25rem;word-break:break-all}',
        '.ocs-tabs{display:flex;flex-wrap:nowrap;gap:.15rem;border-bottom:1px solid var(--border);padding:0 0 .2rem;overflow:visible}',
        '.ocs-tab{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:800;font-size:.74rem;',
        'display:inline-flex;align-items:center;gap:.35rem;padding:.4rem .6rem;border-radius:8px;cursor:pointer;flex:none;white-space:nowrap}',
        '.ocs-tab.is-on{color:var(--accent);background:var(--accent-soft)}',
        '.ocs-subtabs{display:flex;flex-wrap:wrap;gap:.3rem}',
        '.ocs-stab{border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit;',
        'font-weight:750;font-size:.76rem;padding:.35rem .65rem;border-radius:999px;cursor:pointer}',
        '.ocs-stab.is-on{background:var(--accent);color:#fff;border-color:transparent}',
        '.ocs-setrow{display:flex;align-items:center;justify-content:space-between;gap:.5rem;',
        'padding:.4rem .55rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)}',
        '.ocs-setrow.is-on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 42%,var(--border))}',
        '.ocs-setrow .ocs-label{min-width:0;flex:1}',
        '.ocs-mm{position:relative;padding:.1rem 0 .15rem}',
        '.ocs-mm__trig{display:flex;align-items:center;justify-content:flex-start;gap:.45rem;width:100%;font-weight:700}',
        '.memberctx__item.ocs-mirow{display:flex;align-items:center;gap:.5rem}',
        '.ocs-miwrap{display:inline-flex;flex:none;line-height:0}',
        '.ocs-mi{flex:none;display:block;opacity:.88}',
        '.memberctx__item:hover .ocs-mi,.ocs-mm.is-open .ocs-mm__trig .ocs-mi,.ocs-tab.is-on .ocs-mi{opacity:1}',
        '.ocs-mm__chev{opacity:.55;font-size:.95rem;line-height:1}',
        '.ocs-mm.is-open .ocs-mm__trig,.ocs-mm:hover .ocs-mm__trig{background:var(--accent);color:#fff}',
        '.ocs-mm__bridge{position:absolute;right:100%;top:-80px;bottom:-80px;width:18px;z-index:219}',
        '.ocs-mm__fly{position:absolute;right:calc(100% - 2px);top:-4px;z-index:220;min-width:196px;max-width:280px;',
        'max-height:min(70vh,480px);overflow:visible;padding:4px;border-radius:10px;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border-2);box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45))}',
        '.ocs-mm__fly .ocs-mm{position:relative}',
        '.ocs-mm__fly .ocs-mm__trig{width:100%;justify-content:flex-start}',
        '.ocs-mm__fly .ocs-mm__fly{z-index:230;min-width:210px}',
        '.ocs-mg{display:flex;flex-direction:column;gap:.55rem}',
        '.ocs-mg__h{margin:0;font-size:.72rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}',
        '.ocs-mg__g{display:flex;flex-direction:column;gap:.22rem}',
        '.ocs-ml__lab span{font-weight:650;color:var(--muted)}',
        '.ocs-ml{display:flex;align-items:center;justify-content:space-between;gap:.4rem;',
        'padding:.28rem .5rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)}',
        '.ocs-ml.is-on{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:var(--accent-soft)}',
        '.ocs-ml.is-lock{border-style:dashed}',
        '.ocs-ml__lab{font-size:.8rem;font-weight:750;min-width:0;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ocs-ml__btns{display:flex;gap:.22rem;flex:none;white-space:nowrap}',
        '.ocs-ml__btns .ocs-btn{min-height:26px;padding:.12rem .45rem;font-size:.7rem}',
        '.ocs-ml__btns .ocs-btn .ocs-miwrap + span:empty{display:none}',
        '.ocs-drop__msg{margin:0;padding:.85rem 1rem .2rem;font-size:.88rem;line-height:1.4;color:var(--ink)}',
        '.ocs-drop__code{margin:.35rem 1rem 1rem;padding:.55rem .7rem;border-radius:10px;font:inherit;font-weight:800;',
        'letter-spacing:.04em;background:var(--bg-soft);border:1px solid var(--border);word-break:break-all}',
        '.ocs-acc{display:flex;flex-direction:column;gap:.45rem}',
        '.ocs-acc__g{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg-soft)}',
        '.ocs-acc__h{font-size:.72rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;',
        'padding:.35rem .6rem;color:var(--accent);background:var(--accent-soft)}',
        '.ocs-acc__row{display:flex;align-items:center;justify-content:space-between;gap:.5rem;',
        'padding:.35rem .6rem;border-top:1px solid var(--border);font-size:.84rem}',
        '.ocs-acc__nick{font-weight:700;word-break:break-all}',
        '.ocs-acc__row .ocs-btn{min-height:28px;padding:.18rem .5rem;font-size:.72rem}',
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
      else if (name === 'admin') kids = [p('M12 3 4 7v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V7z'), p('M12 8v5'), p('M12 16h.01')];
      else if (name === 'noadmin') kids = [p('M12 3 4 7v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V7z'), l(3, 3, 21, 21)];
      else if (name === 'founder') kids = [p('m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z'), p('M12 14v6'), p('M9 20h6')];
      else if (name === 'nofounder') kids = [p('m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z'), l(3, 3, 21, 21)];
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
      else if (name === 'lock') kids = [h('rect', { key: 'r', x: 5, y: 11, width: 14, height: 10, rx: 2 }), p('M8 11V7.5a4 4 0 0 1 8 0V11')];
      else if (name === 'unlock') kids = [h('rect', { key: 'r', x: 5, y: 11, width: 14, height: 10, rx: 2 }), p('M8 11V7.5a4 4 0 0 1 8 0')];
      else if (name === 'users') kids = [p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), c(9, 7, 4), p('M22 21v-2a4 4 0 0 0-3-3.87'), p('M16 3.13a4 4 0 0 1 0 7.75')];
      else if (name === 'cog') kids = [c(12, 12, 3), p('M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1')];
      else if (name === 'more') kids = [c(5, 12, 1.4, 'currentColor'), c(12, 12, 1.4, 'currentColor'), c(19, 12, 1.4, 'currentColor')];
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
    function pushBtn(list, kind, onClick, icon, label) {
      list.push(h('button', {
        type: 'button',
        className: kind === 'primary' ? 'ocs-btn ocs-btn--primary' : kind === 'warn' ? 'ocs-btn ocs-btn--warn' : 'ocs-btn',
        onClick: onClick,
      }, labeled(icon, label)));
    }
    function bufferTopic(chan) {
      var buf = findBuffer(chan);
      return (buf && buf.topic) || '';
    }
    function bufferModes(chan) {
      var buf = findBuffer(chan);
      return (buf && buf.modes) || '';
    }
    function modeIsOn(modes, letter) {
      var s = String(modes || '');
      var i = s.indexOf(letter);
      if (i < 0) return false;
      var plus = s.lastIndexOf('+', i);
      var minus = s.lastIndexOf('-', i);
      return plus > minus;
    }
    function chanFlagLetters() {
      var cm = String((orbit.server.isupport() || {}).CHANMODES || 'beI,k,l,imnstp').split(',');
      var flags = String(cm[3] || 'imnstp');
      var skip = 'qaohvbeIkflLjOA';
      var out = [];
      for (var i = 0; i < flags.length; i++) {
        if (skip.indexOf(flags[i]) < 0 && out.indexOf(flags[i]) < 0) out.push(flags[i]);
      }
      if (out.indexOf('U') < 0) out.push('U');
      return out;
    }
    function modeCatalog() {
      return [
        {
          id: 'join',
          title: pick('Accès au salon', 'Joining'),
          modes: [
            ['i', pick('Sur invitation', 'Invite only'), pick('Salon uniquement sur invitation : il faut être invité pour entrer.', 'Only invited users can join.')],
            ['R', pick('Compte enregistré', 'Registered nick'), pick('Il faut un pseudo enregistré (NickServ) pour rejoindre.', 'A registered nickname is required to join.')],
            ['z', pick('Connexion chiffrée', 'TLS only'), pick('Uniquement les connexions chiffrées (TLS/SSL).', 'Only TLS/SSL connections may join.')],
            ['s', pick('Secret', 'Secret'), pick('Le salon n’apparaît pas dans les listes publiques.', 'The channel is hidden from public lists.')],
            ['p', pick('Privé', 'Private'), pick('Le salon n’apparaît pas comme salon public.', 'The channel is marked private.')],
          ],
        },
        {
          id: 'talk',
          title: pick('Discussion', 'Talking'),
          modes: [
            ['m', pick('Modéré', 'Moderated'), pick('Seuls les personnes avec voix ou op peuvent écrire.', 'Only voiced or opped users can speak.')],
            ['U', pick('Op-modéré', 'Op-moderated'), pick('Les messages des membres sans voix/op sont masqués pour les autres membres sans privilège.', 'Messages from unprivileged users are hidden from other unprivileged users.')],
            ['n', pick('Pas de msg extérieur', 'No external msgs'), pick('Impossible d’écrire depuis l’extérieur du salon.', 'Messages from outside the channel are blocked.')],
            ['t', pick('Topic protégé', 'Topic locked'), pick('Seuls les opérateurs peuvent changer le sujet.', 'Only operators can change the topic.')],
            ['M', pick('Parler si enregistré', 'Registered to speak'), pick('Il faut un pseudo enregistré pour parler.', 'A registered nickname is required to speak.')],
            ['N', pick('Pas de changement de pseudo', 'No nick change'), pick('Impossible de changer de pseudo dans ce salon.', 'Nickname changes are blocked in this channel.')],
            ['C', pick('Pas de CTCP', 'No CTCP'), pick('Les requêtes CTCP (hors ACTION) sont bloquées.', 'CTCP requests (except ACTION) are blocked.')],
            ['T', pick('Pas de NOTICE', 'No NOTICE'), pick('Les messages NOTICE vers le salon sont bloqués.', 'Channel NOTICE messages are blocked.')],
            ['c', pick('Bloquer les couleurs', 'Block colors'), pick('Les messages avec couleurs IRC sont refusés.', 'Messages containing IRC colors are rejected.')],
            ['S', pick('Retirer les couleurs', 'Strip colors'), pick('Les couleurs IRC sont enlevées des messages.', 'IRC colors are stripped from messages.')],
            ['G', pick('Filtre de mots', 'Badword filter'), pick('Les mots filtrés par le serveur sont censurés.', 'Server-filtered words are censored.')],
            ['Q', pick('Pas d’expulsion', 'No kicks'), pick('Les kicks par les opérateurs du salon sont interdits.', 'Channel operator kicks are forbidden.')],
          ],
        },
        {
          id: 'other',
          title: pick('Autres', 'Other'),
          modes: [
            ['K', pick('Pas de knock', 'No knock'), pick('La commande KNOCK (toquer) est interdite.', 'The KNOCK command is disabled.')],
            ['D', pick('Entrée différée', 'Delay join'), pick('Les arrivées ne s’affichent qu’au premier message.', 'Joins are hidden until the user speaks.')],
            ['d', pick('Membres masqués', 'Hidden members'), pick('Les membres inactifs peuvent être masqués (delay join).', 'Idle members may be hidden (delay join).')],
            ['H', pick('Masquer les arrivées', 'Hide joins'), pick('Les messages d’arrivée/départ sont masqués.', 'Join and part messages are hidden.')],
            ['P', pick('Permanent', 'Permanent'), pick('Le salon n’est pas détruit même vide.', 'The channel is not destroyed when empty.')],
            ['r', pick('Salon enregistré', 'Registered channel'), pick('Marqueur de salon enregistré (souvent posé par les services).', 'Registered-channel flag (usually set by services).')],
            ['u', pick('Auditorium', 'Auditorium'), pick('Les simples membres ne se voient pas entre eux.', 'Regular members cannot see each other.')],
            ['V', pick('Pas d’invitation', 'No invite'), pick('Les invitations par les membres sont interdites.', 'INVITE by channel members is forbidden.')],
          ],
        },
      ];
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
      var accOpenSt = useState(false);
      var accOpen = accOpenSt[0];
      var setAccOpen = accOpenSt[1];
      var closeT = useRef(0);
      var flyRef = useRef(null);
      function keepOpen() {
        if (closeT.current) { clearTimeout(closeT.current); closeT.current = 0; }
        setOpen(true);
      }
      function delayClose() {
        if (closeT.current) clearTimeout(closeT.current);
        closeT.current = setTimeout(function () { closeT.current = 0; setOpen(false); setAccOpen(false); }, 280);
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
      useEffect(function () {
        if (!open || !isChannel(chan) || !identified()) return undefined;
        if (s.registered === true && can(ACCESS_RANK.aop)) queryAccess(chan);
        return undefined;
      }, [open, chan, nick, s.registered, s.access]);
      var me = foldText(orbit.state.nick() || '');
      var serv = s.registered === true && can(ACCESS_RANK.vop);
      var ircOp = amChannelOp(chan);
      if (!isChannel(chan) || !identified()) return null;
      if (me && foldText(nick) === me) return null;
      if (!serv && !ircOp) return null;
      var ch = s.chan || chan;
      var hop = hasHalfop();
      var botName = channelBotNick(ch, s.bot);
      var title = pick('Commandes ', 'Commands ') + (botName || 'ChanServ');
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
      var sop = serv ? can(ACCESS_RANK.sop) : ircOp;
      var founder = serv ? can(ACCESS_RANK.founder) : ircOp;
      function askReason(kind) {
        patchUi({ reasonAsk: { nick: nick, chan: ch, kind: kind, serv: !!serv } });
        close();
      }
      var fly = [];
      var pfx = memberPrefixChars(ch, nick);
      var top = strongestPrefixSym(pfx);
      function roleBtn(sym, letter, canDo, addCmd, delCmd, addIcon, delIcon, addLab, delLab) {
        if (!canDo) return;
        if (top) {
          if (top !== sym) return;
          fly.push(menuBtn(letter + 'd', false, delCmd, delIcon, delLab));
        } else if (sym === '+') {
          fly.push(menuBtn(letter, false, addCmd, addIcon, addLab));
        }
      }
      roleBtn('+', 'v', vop,
        function () { serv ? go('VOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +v ' + nick); },
        function () { serv ? go('DEVOICE ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -v ' + nick); },
        'voice', 'novoice', pick('Voix (+)', 'Voice (+)'), pick('Retirer la voix', 'Devoice'));
      roleBtn('%', 'h', hopOk,
        function () { serv ? go('HALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +h ' + nick); },
        function () { serv ? go('DEHALFOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -h ' + nick); },
        'hop', 'nohop', pick('Halfop (%)', 'Halfop (%)'), pick('Retirer halfop', 'Dehalfop'));
      roleBtn('@', 'o', aop,
        function () { serv ? go('OP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +o ' + nick); },
        function () { serv ? go('DEOP ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -o ' + nick); },
        'op', 'noop', pick('Op (@)', 'Op (@)'), pick('Retirer op', 'Deop'));
      roleBtn('&', 'a', sop && hasPrefixLetter('a'),
        function () { serv ? go('PROTECT ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +a ' + nick); },
        function () { serv ? go('DEPROTECT ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -a ' + nick); },
        'admin', 'noadmin', pick('Admin (&)', 'Admin (&)'), pick('Retirer admin', 'Remove admin'));
      roleBtn('~', 'q', founder && hasPrefixLetter('q'),
        function () { serv ? go('OWNER ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' +q ' + nick); },
        function () { serv ? go('DEOWNER ' + ch + ' ' + nick) : goIrc('MODE ' + ch + ' -q ' + nick); },
        'founder', 'nofounder', pick('Fondateur (~)', 'Founder (~)'), pick('Retirer fondateur', 'Remove founder'));
      if (aop) {
        fly.push(menuBtn('k', true, function () { askReason('kick'); }, 'kick', pick('Expulser', 'Kick')));
        fly.push(menuBtn('b', true, function () { askReason('ban'); }, 'ban', pick('Bannir', 'Ban')));
        fly.push(menuBtn('bk', true, function () { askReason('bankick'); }, 'bankick', pick('Bannir + éjecter', 'Ban + kick')));
      }
      if (serv && can(ACCESS_RANK.aop)) {
        var haveXop = xopForNick(nick);
        var accFly = [];
        function accBtn(lv, add, need, label) {
          if (!can(need)) return;
          if (haveXop) {
            if (add || lv !== haveXop) return;
          } else if (!add) return;
          accFly.push(menuBtn(lv + (add ? 'a' : 'd'), false, function () {
            go(lv + ' ' + ch + ' ' + (add ? 'ADD ' : 'DEL ') + nick);
          }, add ? 'assign' : 'unassign',
            (add ? pick('Accorder ', 'Grant ') : pick('Retirer ', 'Remove ')) + label));
        }
        accBtn('VOP', true, ACCESS_RANK.aop, pick('VOP (voix)', 'VOP (voice)'));
        accBtn('VOP', false, ACCESS_RANK.aop, pick('VOP (voix)', 'VOP (voice)'));
        accBtn('HOP', true, ACCESS_RANK.aop, pick('HOP (halfop)', 'HOP (halfop)'));
        accBtn('HOP', false, ACCESS_RANK.aop, pick('HOP (halfop)', 'HOP (halfop)'));
        accBtn('AOP', true, ACCESS_RANK.sop, pick('AOP (op)', 'AOP (op)'));
        accBtn('AOP', false, ACCESS_RANK.sop, pick('AOP (op)', 'AOP (op)'));
        accBtn('SOP', true, ACCESS_RANK.sop, pick('SOP (admin)', 'SOP (admin)'));
        accBtn('SOP', false, ACCESS_RANK.sop, pick('SOP (admin)', 'SOP (admin)'));
        if (accFly.length) {
          fly.push(h('div', {
            key: 'acc',
            className: 'ocs-mm' + (accOpen ? ' is-open' : ''),
            onMouseEnter: function () { setAccOpen(true); keepOpen(); },
            onMouseLeave: function () { setAccOpen(false); },
          },
            h('button', {
              type: 'button',
              className: 'memberctx__item memberctx__item--sub ocs-mm__trig',
              role: 'menuitem',
              'aria-haspopup': 'menu',
              'aria-expanded': accOpen,
              onClick: function (e) {
                e.stopPropagation();
                setAccOpen(!accOpen);
              },
            },
              h('span', { className: 'ocs-mm__chev', 'aria-hidden': true }, '‹'),
              Mi('users'),
              h('span', null, pick('Gérer les accès', 'Manage access'))
            ),
            accOpen ? h('div', { className: 'ocs-mm__fly', role: 'menu', 'aria-label': pick('Gérer les accès', 'Manage access') }, accFly) : null
          ));
        }
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

    function startDrop(chan) {
      if (!chan) return;
      patchUi({
        dropAsk: { chan: chan, code: '', waiting: true, error: '' },
        flash: '',
        flashErr: false,
        lastCmd: 'ChanServ DROP ' + chan,
        loading: true,
      });
      beginExpect('drop', chan);
      cs('DROP ' + chan);
    }
    function confirmDrop() {
      var ask = ui.dropAsk;
      if (!ask || !ask.code || ask.waiting) return;
      patchUi({
        dropAsk: { chan: ask.chan, code: ask.code, waiting: true, error: '' },
        lastCmd: 'ChanServ DROP ' + ask.chan + ' ' + ask.code,
        loading: true,
      });
      beginExpect('drop', ask.chan);
      cs('DROP ' + ask.chan + ' ' + ask.code);
    }
    function DropAsk() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var ask = s.dropAsk;
      if (!ask) return null;
      var ch = ask.chan || '';
      var title = pick('Suppression du salon', 'Delete channel');
      function cancel() { patchUi({ dropAsk: null, loading: false }); }
      var msg = ask.waiting && !ask.code
        ? pick('Récupération du code de confirmation ChanServ…', 'Fetching the ChanServ confirmation code…')
        : ask.waiting
          ? pick('Confirmation en cours…', 'Confirming…')
          : pick('Confirmer la suppression de ', 'Confirm deletion of ') + ch + ' ?';
      return h('div', {
        className: 'memberrsn-scrim',
        onMouseDown: function (e) { if (e.target === e.currentTarget) cancel(); },
      },
        h('div', { className: 'memberrsn', role: 'dialog', 'aria-label': title },
          h('div', { className: 'memberrsn__head' }, title),
          h('p', { className: 'ocs-drop__msg' }, msg),
          ask.code ? h('div', { className: 'ocs-drop__code' }, ask.code) : null,
          ask.error ? h('p', { className: 'ocs-drop__msg', style: { color: 'var(--danger)' } }, ask.error) : null,
          h('div', { className: 'memberrsn__row' },
            h('button', { type: 'button', className: 'memberrsn__btn', onClick: cancel }, pick('Annuler', 'Cancel')),
            h('button', {
              type: 'button',
              className: 'memberrsn__btn memberrsn__btn--go',
              disabled: !ask.code || !!ask.waiting,
              onClick: confirmDrop,
            }, pick('Supprimer', 'Delete'))
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
      var modeSt = useState('');
      var modeLine = modeSt[0];
      var setModeLine = modeSt[1];
      var accNickSt = useState('');
      var accNick = accNickSt[0];
      var setAccNick = accNickSt[1];
      var accLvlSt = useState('AOP');
      var accLvl = accLvlSt[0];
      var setAccLvl = accLvlSt[1];
      var setTextSt = useState('');
      var setText = setTextSt[0];
      var setSetText = setTextSt[1];
      var extraSt = useState('');
      var extra = extraSt[0];
      var setExtra = extraSt[1];
      var inviteSt = useState('');
      var inviteNick = inviteSt[0];
      var setInviteNick = inviteSt[1];
      var entrySt = useState('');
      var entryMsg = entrySt[0];
      var setEntryMsg = entrySt[1];
      var statusNickSt = useState('');
      var statusNick = statusNickSt[0];
      var setStatusNick = statusNickSt[1];
      var modeGroupSt = useState('join');
      var modeGroup = modeGroupSt[0];
      var setModeGroup = modeGroupSt[1];
      var setGroupSt = useState('topic');
      var setGroup = setGroupSt[0];
      var setSetGroup = setGroupSt[1];
      var panelRef = useRef(null);

      useEffect(function () {
        if (s.open && isChannel(chan) && s.chan !== chan) {
          accessFetched = '';
          patchUi({ chan: chan, flash: '', flashErr: false, lastCmd: '', tab: 'info', accessList: [] });
          queryInfo(chan);
        }
      }, [chan, s.open]);
      useEffect(function () {
        if (!s.open) return undefined;
        if (s.tab === 'topic' || s.tab === 'sujet') setTopic(bufferTopic(s.chan || chan));
        return undefined;
      }, [s.open, s.tab, s.chan, chan]);
      useEffect(function () {
        if (!s.open || s.tab !== 'access' || s.registered !== true) return undefined;
        if ((ACCESS_RANK[s.access] || 0) < ACCESS_RANK.sop) return undefined;
        queryAccess(s.chan || chan);
        return undefined;
      }, [s.open, s.tab, s.chan, s.registered, s.access]);
      useLayoutEffect(function () {
        if (!s.open) return undefined;
        var el = panelRef.current;
        if (!el) return undefined;
        function place() {
          if (window.innerWidth <= 880) {
            el.style.top = '';
            el.style.right = '';
            el.style.left = '';
            el.style.width = '';
            el.style.minWidth = '';
            return;
          }
          var btn = document.querySelector('.topbar__search.ocs-tb');
          if (!btn) return;
          var r = btn.getBoundingClientRect();
          if (r.width < 2) return;
          var right = Math.max(8, window.innerWidth - r.right);
          el.style.top = (r.bottom + 6) + 'px';
          el.style.right = right + 'px';
          el.style.left = 'auto';
          el.style.maxWidth = (window.innerWidth - 16) + 'px';
          var w = 440;
          var tabsEl = el.querySelector('.ocs-tabs');
          if (tabsEl) {
            var need = Math.ceil(tabsEl.scrollWidth) + 32;
            var cap = window.innerWidth - 16;
            w = Math.min(Math.max(need, 400), cap);
          }
          el.style.width = w + 'px';
          el.style.minWidth = w + 'px';
          if (window.innerWidth - right - w < 8) {
            el.style.right = Math.max(8, window.innerWidth - w - 8) + 'px';
          }
        }
        place();
        window.addEventListener('resize', place);
        return function () { window.removeEventListener('resize', place); };
      }, [s.open, s.chan, s.tab, s.infoText, s.flash]);

      if (!s.open) return null;
      var ch = s.chan || chan;
      var tab = s.tab || 'info';
      if (tab === 'salon') tab = 'info';
      if (tab === 'sujet') tab = 'topic';
      var showTopic = s.registered === true && can(ACCESS_RANK.aop);
      var showModes = s.registered === true && can(ACCESS_RANK.aop);
      var showAccess = s.registered === true && can(ACCESS_RANK.sop);
      var showSet = s.registered === true && can(ACCESS_RANK.sop);
      var showDivers = s.registered === true && can(ACCESS_RANK.aop);
      if (tab === 'topic' && !showTopic) tab = 'info';
      if (tab === 'modes' && !showModes) tab = 'info';
      if (tab === 'access' && !showAccess) tab = 'info';
      if (tab === 'set' && !showSet) tab = 'info';
      if (tab === 'divers' && !showDivers) tab = 'info';
      if (tab === 'bot') tab = 'info';
      function goCs(line) { runCmd('ChanServ', line, true); }
      function csSet(opt, val) {
        goCs('SET ' + opt + ' ' + ch + (val != null && String(val) !== '' ? ' ' + val : ''));
      }
      function csMode(op, modes) {
        var m = String(modes || '').trim();
        if (!m && op !== 'SET') return;
        goCs('MODE ' + ch + ' ' + op + (m ? ' ' + m : ''));
      }
      function subTabs(current, setCurrent, items) {
        return h('div', { className: 'ocs-subtabs', role: 'tablist' }, items.map(function (it) {
          return h('button', {
            key: it.id, type: 'button',
            className: 'ocs-stab' + (current === it.id ? ' is-on' : ''),
            onClick: function () { setCurrent(it.id); },
          }, it.label);
        }));
      }

      var chrome = [
        h('div', { className: 'ocs-head' },
          h('h2', { className: 'ocs-title' }, h(ChanIcon, { kind: iconKind(s, ch) }), pick('Services du salon', 'Channel services')),
          h('button', { type: 'button', className: 'ocs-x', onClick: closePanel, 'aria-label': pick('Fermer', 'Close') }, '×')
        ),
        h('p', { className: 'ocs-sub' }, ch),
      ];
      if (s.flash) {
        chrome.push(h('div', {
          className: 'ocs-flash' + (s.flashErr ? ' is-err' : ''),
          role: s.flashErr ? 'alert' : 'status',
        },
          s.lastCmd ? h('span', { className: 'ocs-flash__cmd' }, s.lastCmd) : null,
          s.flash
        ));
      }
      if (s.loading) chrome.push(h('p', { className: 'ocs-sub' }, pick('Interrogation de ChanServ…', 'Asking ChanServ…')));
      var body = [];
      if (s.registered === false) {
        body.push(h(Field, { label: pick('Description (optionnel)', 'Description (optional)') },
          h('input', {
            className: 'ocs-input',
            value: desc,
            maxLength: 80,
            onChange: function (e) { setDesc(e.target.value); },
          })
        ));
        body.push(h('button', {
          type: 'button',
          className: 'ocs-btn ocs-btn--primary',
          onClick: function () {
            var d = desc.trim() || pick('Salon EntreNous', 'EntreNous channel');
            runCmd('ChanServ', 'REGISTER ' + ch + ' ' + d, true);
          },
        }, labeled('plus', pick('Enregistrer le salon', 'Register channel'))));
      }
      if (s.registered === true) {
        var tabs = [];
        function tabBtn(id, icon, label, show) {
          if (!show) return;
          tabs.push(h('button', {
            type: 'button',
            className: 'ocs-tab' + (tab === id ? ' is-on' : ''),
            onClick: function () { patchUi({ tab: id, flash: '', flashErr: false, lastCmd: '' }); },
          }, labeled(icon, label)));
        }
        tabBtn('info', 'info', 'Info', true);
        tabBtn('topic', 'topic', 'Topic', showTopic);
        tabBtn('modes', 'cog', pick('Modes', 'Modes'), showModes);
        tabBtn('access', 'users', pick('Accès', 'Access'), showAccess);
        tabBtn('set', 'lock', 'SET', showSet);
        tabBtn('divers', 'more', pick('Divers', 'Other'), showDivers);
        chrome.push(h('div', { className: 'ocs-tabs', role: 'tablist' }, tabs));
        body.push(h('div', { className: 'ocs-row' },
          h('span', { className: 'ocs-badge' }, (s.access || 'none').toUpperCase()),
          s.bot ? h('span', { className: 'ocs-badge' }, pick('Bot', 'Bot') + ' ' + s.bot) : null
        ));

        if (tab === 'info') {
          pushBtn(body, '', function () {
            beginExpect('info', ch);
            patchUi({ loading: true });
            cs('INFO ' + ch);
          }, 'info', pick('Actualiser l’info', 'Refresh info'));
          if (s.infoText) {
            body.push(h('div', { className: 'ocs-info' }, infoRows(s.infoText).map(function (row, i) {
              if (row.head) return h('div', { key: 'h' + i, className: 'ocs-dl__head' }, row.v);
              if (row.k) {
                var val = row.pills && row.pills.length
                  ? h('div', { className: 'ocs-pills' }, row.pills.map(function (p) {
                    return h('span', { key: p, className: 'ocs-pill' }, p);
                  }))
                  : (row.v || '—');
                return h('div', { key: 'r' + i, className: 'ocs-dl__row' + (row.hi ? ' is-hi' : '') },
                  h('div', { className: 'ocs-dl__k' }, row.k),
                  h('div', { className: 'ocs-dl__v' }, val)
                );
              }
              return h('div', { key: 'v' + i, className: 'ocs-dl__v' }, row.v);
            })));
          }
        }

        if (tab === 'topic' && showTopic) {
          body.push(h(Field, { label: pick('Modifier le topic', 'Edit topic') },
            h('input', { className: 'ocs-input', value: topic, onChange: function (e) { setTopic(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
              goCs('TOPIC ' + ch + ' SET' + (topic.trim() ? ' ' + topic.trim() : ''));
            } }, labeled('check', pick('Définir', 'Set'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOPIC ' + ch + ' SET'); } },
              labeled('novoice', pick('Effacer', 'Clear')))
          ));
          body.push(h(Field, { label: pick('Ajouter au topic', 'Append / prepend') },
            h('input', { className: 'ocs-input', value: extra, onChange: function (e) { setExtra(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              var add = extra.trim();
              if (!add) return;
              goCs('TOPIC ' + ch + ' APPEND ' + add);
            } }, labeled('plus', pick('À la fin', 'Append'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              var add = extra.trim();
              if (!add) return;
              goCs('TOPIC ' + ch + ' PREPEND ' + add);
            } }, labeled('plus', pick('Au début', 'Prepend')))
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOPIC ' + ch + ' LOCK'); } },
              labeled('lock', pick('Verrouiller', 'Lock'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOPIC ' + ch + ' UNLOCK'); } },
              labeled('unlock', pick('Déverrouiller', 'Unlock'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { csSet('KEEPTOPIC', 'ON'); } },
              labeled('topic', pick('Conserver', 'Keep'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { csSet('KEEPTOPIC', 'OFF'); } },
              labeled('novoice', pick('Ne pas conserver', 'Do not keep')))
          ));
        }

        if (tab === 'modes' && showModes) {
          var nowModes = bufferModes(ch);
          var flags = chanFlagLetters();
          var lockedModes = parseMlock(s.infoText);
          body.push(h('p', { className: 'ocs-h' }, pick('Modes actuels', 'Current modes')));
          body.push(h('div', { className: 'ocs-now' }, nowModes || '—'));
          body.push(h(Field, { label: pick('Mode ChanServ (ex. +nt-k)', 'ChanServ mode (e.g. +nt-k)') },
            h('input', { className: 'ocs-input', value: modeLine, placeholder: '+nt', onChange: function (e) { setModeLine(e.target.value); } })
          ));
          pushBtn(body, 'primary', function () {
            if (modeLine.trim()) csMode('SET', modeLine.trim());
          }, 'cog', pick('Appliquer', 'Apply'));
          var cat = modeCatalog();
          var used = {};
          cat.forEach(function (g) {
            g.modes.forEach(function (row) { used[row[0]] = true; });
          });
          var extraModes = flags.filter(function (letter) { return !used[letter]; }).map(function (letter) {
            return [letter, pick('Mode ', 'Mode ') + letter, pick('Mode de salon +', 'Channel mode +') + letter];
          });
          var groupsAvail = cat.filter(function (g) {
            return g.modes.some(function (row) { return flags.indexOf(row[0]) >= 0; });
          });
          if (extraModes.length) groupsAvail = groupsAvail.concat([{ id: 'extra', title: pick('Réseau', 'Network'), extra: true }]);
          var gid = modeGroup;
          if (!groupsAvail.some(function (g) { return g.id === gid; }) && groupsAvail[0]) gid = groupsAvail[0].id;
          body.push(h('p', { className: 'ocs-h' }, pick('Modifier les modes salon', 'Edit channel modes')));
          body.push(subTabs(gid, setModeGroup, groupsAvail.map(function (g) {
            return { id: g.id, label: g.title };
          })));
          function modeRow(letter, name, tip) {
            var on = modeIsOn(nowModes, letter);
            var locked = mlockHas(lockedModes, letter);
            var sign = on ? '+' : '-';
            return h('div', { key: letter, className: 'ocs-ml' + (on ? ' is-on' : '') + (locked ? ' is-lock' : ''), title: tip },
              h('span', { className: 'ocs-ml__lab' }, name + ' ( ', h('span', null, letter), ' )'),
              h('span', { className: 'ocs-ml__btns' },
                h('button', {
                  type: 'button',
                  className: 'ocs-btn' + (on ? ' ocs-btn--primary' : ''),
                  title: tip,
                  onClick: function () { csMode('SET', '+' + letter); },
                }, 'ON'),
                h('button', {
                  type: 'button',
                  className: 'ocs-btn',
                  title: tip,
                  onClick: function () { csMode('SET', '-' + letter); },
                }, 'OFF'),
                h('button', {
                  type: 'button',
                  className: 'ocs-btn' + (locked ? ' ocs-btn--primary' : ''),
                  title: locked
                    ? pick('Retirer le verrou ' + sign + letter, 'Remove lock ' + sign + letter)
                    : pick('Verrouiller ' + sign + letter, 'Lock ' + sign + letter),
                  onClick: function () {
                    csMode(locked ? 'LOCK DEL' : 'LOCK ADD', sign + letter);
                  },
                }, Mi(locked ? 'unlock' : 'lock'))
              )
            );
          }
          var shown = [];
          groupsAvail.forEach(function (g) {
            if (g.id !== gid) return;
            if (g.extra) shown = extraModes.map(function (row) { return modeRow(row[0], row[1], row[2]); });
            else {
              shown = g.modes.filter(function (row) { return flags.indexOf(row[0]) >= 0; }).map(function (row) {
                return modeRow(row[0], row[1], row[2]);
              });
            }
          });
          body.push(h('div', { className: 'ocs-mg__g' }, shown));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (modeLine.trim()) csMode('LOCK ADD', modeLine.trim());
            } }, labeled('lock', pick('Verrouiller', 'Lock'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (modeLine.trim()) csMode('LOCK DEL', modeLine.trim());
            } }, labeled('unlock', pick('Déverrouiller', 'Unlock')))
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('CLEAR ' + ch + ' BANS'); } },
              labeled('ban', pick('Vider les bans', 'Clear bans'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('CLEAR ' + ch + ' MODES'); } },
              labeled('cog', pick('Vider les modes', 'Clear modes'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('UNBAN ' + ch); } },
              labeled('unlock', pick('Unban (toi)', 'Unban (you)')))
          ));
        }

        if (tab === 'access' && showAccess) {
          var accLabels = {
            SOP: pick('SOP — Super-op / admin', 'SOP — Super-op / admin'),
            AOP: pick('AOP — Opérateur auto', 'AOP — Auto-op'),
            HOP: pick('HOP — Halfop auto', 'HOP — Auto-halfop'),
            VOP: pick('VOP — Voix auto', 'VOP — Auto-voice'),
          };
          body.push(h('p', { className: 'ocs-h' }, pick('Liste des accès', 'Access list')));
          if (s.accessLoading) {
            body.push(h('p', { className: 'ocs-sub' }, pick('Chargement de la liste…', 'Loading list…')));
          } else {
            var grouped = { SOP: [], AOP: [], HOP: [], VOP: [] };
            (s.accessList || []).forEach(function (row) {
              if (grouped[row.level]) grouped[row.level].push(row);
            });
            var any = false;
            var listKids = [];
            ['SOP', 'AOP', 'HOP', 'VOP'].forEach(function (lv) {
              if (!grouped[lv].length) return;
              any = true;
              listKids.push(h('div', { key: lv, className: 'ocs-acc__g' },
                [h('div', { className: 'ocs-acc__h' }, accLabels[lv] || lv)].concat(grouped[lv].map(function (row) {
                  return h('div', { key: lv + row.nick, className: 'ocs-acc__row' },
                    h('span', { className: 'ocs-acc__nick' }, row.nick),
                    h('button', {
                      type: 'button', className: 'ocs-btn',
                      onClick: function () { goCs(lv + ' ' + ch + ' DEL ' + row.nick); },
                    }, pick('Retirer', 'Remove'))
                  );
                }))
              ));
            });
            if (!any) {
              body.push(h('p', { className: 'ocs-sub' }, pick('Aucun accès XOP pour l’instant.', 'No XOP access entries yet.')));
            } else {
              body.push(h('div', { className: 'ocs-acc' }, listKids));
            }
          }
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryAccess(ch, true); } },
              labeled('list', pick('Actualiser la liste', 'Refresh list')))
          ));
          body.push(h(Field, { label: pick('Niveau', 'Level') },
            h('select', { className: 'ocs-select', value: accLvl, onChange: function (e) { setAccLvl(e.target.value); } },
              ['VOP', 'HOP', 'AOP', 'SOP'].map(function (lv) { return h('option', { key: lv, value: lv }, accLabels[lv] || lv); })
            )
          ));
          body.push(h(Field, { label: pick('Compte / pseudo', 'Account / nick') },
            h('input', { className: 'ocs-input', value: accNick, onChange: function (e) { setAccNick(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
              if (accNick.trim()) goCs(accLvl + ' ' + ch + ' ADD ' + accNick.trim());
            } }, labeled('assign', pick('Ajouter', 'Add'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (accNick.trim()) goCs(accLvl + ' ' + ch + ' DEL ' + accNick.trim());
            } }, labeled('unassign', pick('Retirer', 'Remove')))
          ));
        }

        if (tab === 'set' && showSet) {
          var setOn = parseChanOptions(s.infoText);
          body.push(h(Field, { label: pick('Valeur (DESC, URL, EMAIL…)', 'Value (DESC, URL, EMAIL…)') },
            h('input', { className: 'ocs-input', value: setText, onChange: function (e) { setSetText(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (setText.trim()) csSet('DESC', setText.trim()); } }, 'DESC'),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (setText.trim()) csSet('URL', setText.trim()); } }, 'URL'),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (setText.trim()) csSet('EMAIL', setText.trim()); } }, 'EMAIL')
          ));
          var setGroups = [
            { id: 'topic', label: pick('Topic', 'Topic'), rows: [
              ['KEEPTOPIC', pick('Conserver le topic', 'Keep topic')],
              ['TOPICLOCK', pick('Verrouiller le topic', 'Lock topic')],
            ] },
            { id: 'sec', label: pick('Sécurité', 'Security'), rows: [
              ['SECUREOPS', 'SECUREOPS'],
              ['SECUREFOUNDER', pick('Sécurité fondateur', 'Secure founder')],
              ['SECURE', 'SECURE'],
              ['RESTRICTED', 'RESTRICTED'],
              ['PRIVATE', 'PRIVATE'],
              ['SIGNKICK', 'SIGNKICK'],
            ] },
            { id: 'other', label: pick('Autres', 'Other'), rows: [
              ['OPNOTICE', 'OPNOTICE'],
              ['PEACE', pick('Paix', 'Peace')],
              ['PERSIST', 'PERSIST'],
              ['KEEPMODES', pick('Maintien des modes', 'Keep modes')],
            ] },
          ];
          var sg = setGroup;
          if (!setGroups.some(function (g) { return g.id === sg; })) sg = 'topic';
          body.push(h('p', { className: 'ocs-h' }, pick('Options', 'Options')));
          body.push(subTabs(sg, setSetGroup, setGroups.map(function (g) {
            return { id: g.id, label: g.label };
          })));
          setGroups.forEach(function (g) {
            if (g.id !== sg) return;
            g.rows.forEach(function (row) {
              var on = !!setOn[row[0]];
              body.push(h('div', { className: 'ocs-setrow' + (on ? ' is-on' : ''), key: row[0] },
                h('span', { className: 'ocs-label' }, row[1]),
                h('button', {
                  type: 'button',
                  className: 'ocs-btn' + (on ? ' ocs-btn--primary' : ''),
                  onClick: function () { csSet(row[0], on ? 'OFF' : 'ON'); },
                }, on ? 'OFF' : 'ON')
              ));
            });
          });
        }

        if (tab === 'divers' && showDivers) {
          body.push(h(Field, { label: pick('Inviter (vide = toi)', 'Invite (empty = you)') },
            h('input', { className: 'ocs-input', value: inviteNick, onChange: function (e) { setInviteNick(e.target.value); } })
          ));
          pushBtn(body, 'primary', function () {
            goCs('INVITE ' + ch + (inviteNick.trim() ? ' ' + inviteNick.trim() : ''));
          }, 'assign', pick('Inviter', 'Invite'));
          body.push(h(Field, { label: pick('Status d’un pseudo (optionnel)', 'Status for nick (optional)') },
            h('input', { className: 'ocs-input', value: statusNick, onChange: function (e) { setStatusNick(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              goCs('STATUS ' + ch + (statusNick.trim() ? ' ' + statusNick.trim() : ''));
            } }, labeled('info', 'Status')),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('STATS ' + ch); } },
              labeled('list', 'Stats')),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOP ' + ch); } },
              labeled('hash', 'Top'))
          ));
          body.push(h(Field, { label: 'ENTRYMSG' },
            h('input', { className: 'ocs-input', value: entryMsg, onChange: function (e) { setEntryMsg(e.target.value); } })
          ));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (entryMsg.trim()) csSet('ENTRYMSG', entryMsg.trim());
            } }, labeled('say', pick('Définir', 'Set'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { csSet('ENTRYMSG', ''); } },
              labeled('novoice', pick('Retirer', 'Unset')))
          ));
          if (can(ACCESS_RANK.founder)) {
            pushBtn(body, 'warn', function () { startDrop(ch); }, 'unassign', pick('Suppression du salon', 'Delete channel'));
          }
        }
      }
      return h('div', { ref: panelRef, className: 'ocs-panel', role: 'dialog', 'aria-label': pick('Services du salon', 'Channel services') },
        h('div', { className: 'ocs-chrome' }, chrome),
        body.length ? h('div', { className: 'ocs-body' }, body) : null
      );
    }

    orbit.on('raw', onRaw);
    orbit.on('status', function (st) {
      if (st === 'registered') return;
      cache = {};
      pending = [];
      expectKind = '';
      patchUi({ open: false, registered: null, access: 'none', bot: '', bots: [], loading: false, tab: 'info', accessList: [], reasonAsk: null, dropAsk: null });
    });
    orbit.addMessageFilter(function (m) {
      return shouldHideServiceReply(m);
    });
    orbit.addUi('topbar_item', function () { return h(HeaderButton); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem); });
    orbit.addUi('overlay', function () { return h(Panel); });
    orbit.addUi('overlay', function () { return h(ReasonAsk); });
    orbit.addUi('overlay', function () { return h(DropAsk); });
    if (typeof orbit.addMemberMenu === 'function') {
      orbit.addMemberMenu(function (ctx) {
        return h(MemberServMenu, { nick: ctx.nick, close: ctx.close });
      });
    }
    log('ChanServ/BotServ panel — topbar + overlay');
  });
})();
