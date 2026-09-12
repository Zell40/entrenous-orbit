/*
 * orbit-chanserv — commandes ChanServ / BotServ selon l’accès Anope.
 *
 * Icône barre du salon (desktop) + menu ⋮ (mobile). Panneau overlay (gestion salon).
 * Kick / ban / op / voix : menu de la liste (Commandes <bot>).
 * Salon non enregistré → REGISTER (compte NickServ requis).
 * Salon enregistré → commandes filtrées (VOP/HOP/AOP/SOP/fondateur) + bot.
 *
 * config.json:
 *   "plugins": [".../orbit-chanserv/orbit-chanserv.js?v=75"]
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

  var ACCESS_RANK = { none: 0, vop: 3, hop: 4, aop: 5, sop: 10, qop: 100, founder: 100 };

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
    var expectTimer = 0;
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
      botInfo: '',
      ytStats: '',
      entryMsgs: [],
      badwords: [],
      topicHistory: [],
      akickList: [],
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
        infoText: ui.infoText, botInfo: ui.botInfo, ytStats: ui.ytStats, entryMsgs: ui.entryMsgs.slice(), badwords: ui.badwords.slice(), topicHistory: ui.topicHistory.slice(), akickList: ui.akickList.slice(),
        flash: ui.flash, flashErr: ui.flashErr, lastCmd: ui.lastCmd, tab: ui.tab,
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
        var lv = String(row.level || '');
        var r = ACCESS_RANK[lv.toLowerCase()] || 0;
        if (!r && /^\d+$/.test(lv)) {
          var n = parseInt(lv, 10);
          if (n >= 100) r = 100;
          else if (n >= 10) r = 10;
          else if (n >= 5) r = 5;
          else if (n >= 4) r = 4;
          else if (n > 0) r = 3;
        }
        if (r > bestR) {
          bestR = r;
          if (/^(QOP|SOP|AOP|HOP|VOP)$/i.test(lv)) best = lv.toUpperCase();
          else if (/founder/i.test(lv) || r >= 100) best = 'QOP';
          else if (r >= 10) best = 'SOP';
          else if (r >= 5) best = 'AOP';
          else if (r >= 4) best = 'HOP';
          else best = 'VOP';
        }
      });
      return best;
    }
    function accessRankOf(level) {
      var lv = String(level || '');
      var named = ACCESS_RANK[lv.toLowerCase()];
      if (named) return named;
      if (/founder/i.test(lv)) return ACCESS_RANK.founder;
      if (/^\d+$/.test(lv)) {
        var n = parseInt(lv, 10);
        if (n >= 100) return ACCESS_RANK.founder;
        if (n >= 10) return ACCESS_RANK.sop;
        if (n >= 5) return ACCESS_RANK.aop;
        if (n >= 4) return ACCESS_RANK.hop;
        if (n > 0) return ACCESS_RANK.vop;
      }
      return 0;
    }
    function canManageXop(lv) {
      var mine = rank();
      if (mine < ACCESS_RANK.sop) return false;
      var target = accessRankOf(lv);
      if (!target) return false;
      if (mine >= ACCESS_RANK.founder) return true;
      return mine > target;
    }
    function canManageAccessRow(row) {
      var mine = rank();
      if (mine < ACCESS_RANK.sop) return false;
      if (mine >= ACCESS_RANK.founder) return true;
      var sys = String((row && row.system) || '').toUpperCase();
      if (sys === 'FLAGS' || isFlagToken(row && row.level)) return false;
      var rlv = String((row && row.level) || '');
      if (/^\d+$/.test(rlv)) return parseInt(rlv, 10) < mine;
      return canManageXop(rlv === 'FOUNDER' ? 'QOP' : rlv);
    }
    function xopLevelsICanManage() {
      return ['VOP', 'HOP', 'AOP', 'SOP', 'QOP'].filter(function (lv) { return canManageXop(lv); });
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
    function cleanBotNick(n) {
      var s = String(n || '').replace(/^[(\[{]+|[)\]}]+$/g, '').replace(/[.,;]+$/, '').trim();
      if (!s || /^(n\/?a|none|aucun|non|not|no|unassigned|-|\*|off|oui|yes)$/i.test(s)) return '';
      if (isNamedService(s)) return '';
      return s;
    }
    function parseBotNick(text) {
      var found = '';
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        var m = s.match(/^([^:]{2,48}):\s*(\S+)/);
        if (!m) return;
        var key = foldText(m[1]);
        if (/kicker|interdit|badword|flood|caps|color|gras|fantaisie|fantasy|repeat|italique|underline/.test(key)) return;
        if (!/^(bot|botserv|robot|pseudo)\b/.test(key) && !/\b(bot|robot)\s+(assigne|assigned|du salon)\b/.test(key)) return;
        var n = cleanBotNick(m[2]);
        if (n) found = n;
      });
      if (found) return found;
      var raw = stripIrc(text || '');
      var bm = raw.match(/(?:^|\n)\s*(?:bot(?:serv)?|robot(?:\s+du\s+salon)?|pseudo(?:\s+du\s+bot)?)\s*:\s*(\S+)/i)
        || raw.match(/(?:bot(?:serv)?|robot)\s*(?:assigne[e]?|assigned)\s*:\s*(\S+)/i)
        || raw.match(/\bbot\s+(\S+)\s+(?:is assigned|assigne)/i);
      return bm ? cleanBotNick(bm[1]) : '';
    }
    function channelBotNick(chan, fromInfo) {
      var info = cleanBotNick(fromInfo) || parseBotNick(ui.botInfo);
      if (info) return info;
      var buf = findBuffer(chan);
      var members = (buf && buf.members) || {};
      var best = '';
      var bestRank = 99;
      function consider(nick, member) {
        if (!nick || isNamedService(nick)) return;
        var p = (member && (member.prefixes || member.prefix)) || '';
        var r = !p ? 90 : (p.indexOf('~') >= 0 ? 0 : p.indexOf('&') >= 0 ? 1 : p.indexOf('@') >= 0 ? 2 : p.indexOf('%') >= 0 ? 3 : p.indexOf('+') >= 0 ? 4 : 80);
        if (r < bestRank) { bestRank = r; best = (member && member.nick) || nick; }
      }
      Object.keys(members).forEach(function (n) {
        var m = members[n];
        if (!m || !m.bot) return;
        consider(m.nick || n, m);
      });
      if (best) return best;
      (ui.bots || []).forEach(function (bn) {
        if (!bn) return;
        var want = foldText(bn);
        Object.keys(members).forEach(function (n) {
          var m = members[n];
          var nick = (m && m.nick) || n;
          if (foldText(nick) === want || foldText(n) === want) consider(nick, m);
        });
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
        botInfo: '', ytStats: '', entryMsgs: [], badwords: [], topicHistory: [],
      });
      return true;
    }

    function beginExpect(kind, chan) {
      expectKind = kind;
      expectChan = chan;
      hideUntil = Date.now() + HIDE_MS;
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
      if (expectTimer) clearTimeout(expectTimer);
      expectTimer = setTimeout(function () {
        expectTimer = 0;
        if (!expectKind) return;
        expectKind = '';
        patchUi({ loading: false });
      }, HIDE_MS);
    }
    function endExpect() {
      expectKind = '';
      if (expectTimer) { clearTimeout(expectTimer); expectTimer = 0; }
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
        patchUi({ chan: chan, loading: false, registered: null, access: 'none', bot: '', founder: '', infoText: '', botInfo: '', ytStats: '', entryMsgs: [], badwords: [], topicHistory: [], akickList: [] });
        return;
      }
      if (applyCache(chan)) return;
      var next = { chan: chan, loading: true, botInfo: '', ytStats: '', entryMsgs: [], badwords: [], topicHistory: [] };
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

    function queryBotInfo(chan, opts) {
      if (!isChannel(chan) || !identified()) return;
      beginExpect('botinfo', chan);
      if (opts && opts.notify) {
        patchUi({ lastCmd: 'BotServ INFO ' + chan, loading: true, flash: '', flashErr: false });
      }
      bs('INFO ' + chan);
    }

    function queryEntryMsg(chan) {
      if (!isChannel(chan) || !identified()) return;
      beginExpect('entrymsg', chan);
      cs('ENTRYMSG ' + chan + ' LIST');
    }

    function queryTopicHistory(chan) {
      if (!isChannel(chan) || !identified()) return;
      beginExpect('topichistory', chan);
      cs('TOPICHISTORY ' + chan + ' LIST');
    }

    function queryAkick(chan) {
      if (!isChannel(chan) || !identified()) return;
      beginExpect('akick', chan);
      cs('AKICK ' + chan + (queryAkick.listOnly ? ' LIST' : ' VIEW'));
    }
    queryAkick.listOnly = false;

    function queryBadwords(chan) {
      if (!isChannel(chan) || !identified()) return;
      beginExpect('badwords', chan);
      bs('BADWORDS ' + chan + ' LIST');
    }

    function looksLikeAccessHelp(text) {
      var t = foldText(text);
      return /syntaxe:\s*access|\bsyntax:\s*access|unknown command|commande inconnue|no such command/.test(t);
    }
    function queryAccess(chan, force) {
      if (!isChannel(chan) || !identified()) return;
      var key = String(chan).toLowerCase();
      if (!force && accessFetched === key && ui.accessList.length) return;
      accessFetched = key;
      patchUi({ accessLoading: true });
      rpcCall('access', chan).then(function (data) {
        if (ui.chan && String(ui.chan).toLowerCase() !== key) return;
        if (data && data.ok && data.list != null && String(data.list) !== '' && !looksLikeAccessHelp(data.list)) {
          patchUi({ accessList: parseAccessList(data.list), accessLoading: false });
          expectKind = '';
          return;
        }
        if (data && data.ok && data.lists) {
          var rows = [];
          ['QOP', 'SOP', 'AOP', 'HOP', 'VOP'].forEach(function (lv) {
            rows = rows.concat(parseXopList(data.lists[lv], lv));
          });
          patchUi({ accessList: rows, accessLoading: false });
          expectKind = '';
          return;
        }
        beginExpect('accesslist', chan);
        cs('ACCESS ' + chan + ' LIST * ALL');
      });
    }

    function looksLikeBotInfoDump(text) {
      var t = foldText(text);
      return /pseudo du bot|kicker (de|pour|d[' ])|fantaisie|\bfantasy\b/.test(t);
    }
    function looksLikeServOk(text) {
      var t = foldText(text);
      return /a ete enregistre|has been registered|enregistre avec succes|registered successfully|sujet (modifie|change|a ete)|topic (is now|changed|set|lock)|est maintenant|is now|option|keeptopic|mlock|a ete defini|has been set|est vide|is empty|aucun mot|no (bad ?)?words|a ete ajoute|has been added|a ete (supprime|retire)|has been (removed|deleted)/.test(t);
    }
    function looksLikeServError(text) {
      var t = foldText(text);
      if (!t || looksLikeServOk(t)) return false;
      if (/mots interdits|mot interdit|bad ?words/.test(t) && !/permission|denied|refuse|invalide|invalid/.test(t)) return false;
      if (/liste d['']acces|access list|fin de la liste d['']acces/.test(t) && !/permission|denied|refuse/.test(t)) return false;
      return /limite|limit|depass|exceed|permission|denied|refuse|vous ne pouvez|you cannot|\binterdit\b|impossible|erreur|error|fail|deja|already|trop (de|many)|too many|pas assez|not enough|invalide|invalid|inconnu|unknown|pas autoris|not allowed|syntaxe|syntax/.test(t);
    }
    function looksLikeAccessDenied(text) {
      var t = foldText(text);
      return /acces refuse|access denied|permission denied|pas autoris|not allowed|vous n['']avez pas (acces|le droit)|you do not have/.test(t);
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
      out.bot = parseBotNick(raw);
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
        var m = s.match(/^([^:]{2,60}):\s*(.*)$/);
        if (m) {
          var key = foldText(m[1]);
          var row = { k: m[1], v: m[2] };
          if (/fondateur|founder|pseudo|bot\b/.test(key)) row.hi = true;
          if (/^options?$/.test(key) && m[2]) {
            row.pills = m[2].split(/\s*,\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
          }
          var fv = foldText(m[2]).replace(/[.,;]+$/, '');
          if (/^(active|actif|enabled|on|oui)$/.test(fv)) { row.flag = true; row.flagOn = true; }
          else if (/^(desactive|inactif|disabled|off|non)$/.test(fv)) { row.flag = true; row.flagOn = false; }
          rows.push(row);
        } else if (rows.length && rows[rows.length - 1].k && !rows[rows.length - 1].head) {
          var prev = rows[rows.length - 1];
          prev.v = String(prev.v || '').replace(/\s+$/, '') + ' ' + s.replace(/^\s+/, '');
          if (prev.pills) {
            prev.pills = String(prev.v).split(/\s*,\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
          }
        } else rows.push({ v: s });
      });
      return rows;
    }
    function formatHead(text) {
      var t = String(text || '').replace(/\s+/g, ' ').trim().toUpperCase();
      var colon = /:\s*$/.test(t);
      t = t.replace(/\s*:\s*$/, '');
      if (!t) return colon ? ':' : '';
      var i = t.lastIndexOf(' ');
      var last = i < 0 ? t : t.slice(i + 1);
      var head = i < 0 ? '' : t.slice(0, i) + ' ';
      return [head, h('span', { className: 'ocs-nowrap' }, last + (colon ? '\u00A0:' : ''))];
    }
    function infoCardNodes(text, skipKeyRe, skipHeadRe) {
      return infoRows(text).map(function (row, i) {
        if (skipKeyRe && row.k && skipKeyRe.test(foldText(row.k))) return null;
        if (row.head) {
          if (skipHeadRe && skipHeadRe.test(foldText(row.v))) return null;
          return h('div', { key: 'h' + i, className: 'ocs-dl__head' }, formatHead(row.v));
        }
        if (row.k) {
          var val = row.pills && row.pills.length
            ? h('div', { className: 'ocs-pills' }, row.pills.map(function (p) {
              return h('span', { key: p, className: 'ocs-pill' }, p);
            }))
            : row.flag
              ? h('span', { className: 'ocs-pill' + (row.flagOn ? ' is-on' : ' is-off') }, row.v)
              : (function () {
                if (/^(bantype|type\s+de\s+bans?|type\s+de\s+bannissement)$/.test(foldText(row.k || ''))) {
                  var bt = String(row.v || '').replace(/[^\d]/g, '').slice(0, 1);
                  var opt = banTypeOptions().filter(function (o) { return o.id === bt; })[0];
                  return opt ? bt + ' — ' + opt.mask : (row.v || '—');
                }
                return row.v || '—';
              }());
          return h('div', { key: 'r' + i, className: 'ocs-dl__row' + (row.hi ? ' is-hi' : '') },
            h('div', { className: 'ocs-dl__k' }, row.k),
            h('div', { className: 'ocs-dl__v' }, val)
          );
        }
        return h('div', { key: 'v' + i, className: 'ocs-dl__v' }, row.v);
      }).filter(Boolean);
    }
    function parseBotFlag(text, keyRe) {
      var on = false;
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        var m = s.match(/^([^:]{2,60}):\s*(.*)$/);
        if (!m) return;
        if (!keyRe.test(foldText(m[1]))) return;
        var t = foldText(m[2]);
        if (/\b(desactive|inactif|disabled|off|non)\b/.test(t)) on = false;
        else if (/\b(active|actif|enabled|on|oui)\b/.test(t)) on = true;
      });
      return on;
    }
    function botKickerDefs() {
      return [
        ['BADWORDS', pick('Mots interdits', 'Bad words'), /kicker (de )?mots interdits|\bbadwords\b/],
        ['BOLDS', pick('Gras', 'Bold'), /gras|\bbolds?\b/],
        ['CAPS', pick('Majuscules', 'Caps'), /majuscules|\bcaps\b/],
        ['COLORS', pick('Couleurs', 'Colors'), /couleurs|\bcolors?\b/],
        ['FLOOD', pick('Flood', 'Flood'), /\bflood\b/],
        ['REPEAT', pick('Répétition', 'Repeat'), /repetition|\brepeat\b/],
        ['REVERSES', pick('Reverse', 'Reverse'), /reverses?|inverse/],
        ['UNDERLINES', pick('Souligné', 'Underline'), /souligne|underline/],
        ['ITALICS', pick('Italique', 'Italics'), /italique|italics?/],
        ['AMSG', 'AMSG', /\bamsg\b/],
      ];
    }

    function chanSetInfoValue(text, kind) {
      var re = {
        DESC: /^(description|desc)$/,
        URL: /^(url|site(\s+internet)?)$/,
        EMAIL: /^(e-?mails?|courriels?|adresse\s+e-?mail)$/,
        SUCCESSOR: /^(successeurs?|successors?)$/,
        BANTYPE: /^(bantype|type\s+de\s+bans?|type\s+de\s+bannissement)$/,
      }[String(kind || '').toUpperCase()];
      if (!re) return '';
      var found = '';
      infoRows(text).forEach(function (row) {
        if (row.k && re.test(foldText(row.k))) found = String(row.v || '').trim();
      });
      if (/^(aucun|none|n\/a|vide|non definie|not set|-)$/i.test(foldText(found))) return '';
      return found;
    }
    function banTypeOptions() {
      return [
        { id: '0', mask: '*!user@host', tip: pick('Le plus étroit : ident et hôte exacts.', 'Narrowest: exact ident and host.') },
        { id: '1', mask: '*!*user@host', tip: pick('Ident (avec ou sans ~) et hôte exact.', 'Ident (with or without ~) and exact host.') },
        { id: '2', mask: '*!*@host', tip: pick('Tout le monde sur cet hôte (le plus courant).', 'Everyone on that host (most common).') },
        { id: '3', mask: '*!*user@*.domaine', tip: pick('Ident + tout le domaine (le plus large).', 'Ident + whole domain (widest).') },
      ];
    }
    function parseChanOptions(text) {
      var on = {};
      var blob = '';
      infoRows(text).forEach(function (row) {
        if (row.k && /^options?$/.test(foldText(row.k))) blob = String(row.v || '');
      });
      if (!blob) {
        String(text || '').split(/\n/).forEach(function (line) {
          var s = stripIrc(line).trim();
          var m = s.match(/^options?\s*:\s*(.+)$/i);
          if (m) blob += (blob ? ', ' : '') + m[1];
        });
      }
      String(blob || '').split(/\s*,\s*/).forEach(function (part) {
        var t = foldText(part);
        if (!t) return;
        if (/secureops|secure ops|ops securises|securite (des )?(ops?|operateur)/.test(t)) on.SECUREOPS = true;
        else if (/securefounder|secure founder|fondateur securise|securite (de |du )?fondateur/.test(t)) on.SECUREFOUNDER = true;
        else if (/restricted|restreint/.test(t)) on.RESTRICTED = true;
        else if (/keeptopic|conserver le topic|maintien du topic/.test(t)) on.KEEPTOPIC = true;
        else if (/keepmodes|maintien des modes/.test(t)) on.KEEPMODES = true;
        else if (/^topiclock$/.test(t) || /verrouillage du (topic|sujet)/.test(t)) on.TOPICLOCK = true;
        else if (/signkick|kicks signes/.test(t)) on.SIGNKICK = true;
        else if (/autoop|op auto/.test(t)) on.AUTOOP = true;
        else if (/chanstats/.test(t)) on.CHANSTATS = true;
        else if (/topichistory|historique des sujets/.test(t)) on.TOPICHISTORY = true;
        else if (/peace|paix/.test(t)) on.PEACE = true;
        else if (/persist|persistant/.test(t)) on.PERSIST = true;
        else if (/private|prive/.test(t)) on.PRIVATE = true;
      });
      return on;
    }
    function parseTopicLocked(text) {
      var locked = !!parseChanOptions(text).TOPICLOCK;
      String(text || '').split(/\n/).forEach(function (line) {
        var t = foldText(stripIrc(line));
        if (!/(verrouillage du sujet|topic lock|sujet verrouille)\s*:/.test(t)) return;
        if (/\b(inactif|off|disabled|no)\b/.test(t)) locked = false;
        else if (/\b(actif|on|enabled|yes|oui)\b/.test(t)) locked = true;
      });
      return locked;
    }

    function parseDropCode(text) {
      var t = stripIrc(text).replace(/\s+/g, ' ').trim();
      var m = t.match(/\/CS\s+DROP\s+\S+\s+(\S+)/i)
        || t.match(/\/msg\s+chanserv\s+DROP\s+\S+\s+(\S+)/i)
        || t.match(/\bDROP\s+\S+\s+([A-Za-z0-9]{6,})\s*$/i);
      return m ? m[1].replace(/^['"]+|['".,;]+$/g, '') : '';
    }
    function parseMlock(text) {
      var raw = '';
      infoRows(text).forEach(function (row) {
        if (!row.k) return;
        var k = foldText(row.k);
        if (/modes?\s+verrouill|verrouillage des modes|^mlock$|mode lock/.test(k)) raw = String(row.v || '').trim();
      });
      if (!raw) {
        var m = String(text || '').match(/modes?\s+verrouill[ée]s?\s*:\s*(\S+)/i)
          || String(text || '').match(/\bmlock\s*:\s*(\S+)/i)
          || String(text || '').match(/mode lock\s*:\s*(\S+)/i);
        raw = m ? m[1] : '';
      }
      raw = String(raw || '').split(/\s/)[0];
      if (/^(aucun|none|n\/a|vide|-)$/i.test(foldText(raw))) return '';
      if (!/^[+\-A-Za-z]+$/.test(raw)) return '';
      return raw;
    }
    function mlockHas(mlock, letter) {
      return modeIsOn(mlock, letter);
    }
    function modeForcedLock(letter) {
      return letter === 'r';
    }
    function isXopName(s) {
      return /^(QOP|SOP|AOP|HOP|VOP|FOUNDER)$/i.test(String(s || ''));
    }
    function isFlagToken(s) {
      var t = String(s || '');
      if (!t || t === '=') return false;
      return /^[+\-=*]/.test(t) && /[A-Za-z0-9*]/.test(t) && t.length <= 32;
    }
    function isLevelToken(s) {
      return /^-?\d+$/.test(String(s || ''))
        || /^(AUTOOP|AUTOHALFOP|AUTOVOICE|AUTOPROTECT|AUTODEOP|NOKICK|NOJOIN|SIGNKICK)$/i.test(String(s || ''));
    }
    function isAccessTypeToken(s) {
      return isXopName(s) || isFlagToken(s) || isLevelToken(s);
    }
    function inferAccessSystem(level, tag) {
      var t = String(tag || '').toUpperCase();
      if (/^(XOP|FLAGS|QOP|ACCESS)$/.test(t)) return t;
      var lv = String(level || '');
      if (isXopName(lv)) return /founder/i.test(lv) ? 'QOP' : 'XOP';
      if (isFlagToken(lv)) return 'FLAGS';
      return 'ACCESS';
    }
    function accessTypeSort(row) {
      var n = parseInt(row.n, 10);
      return isNaN(n) ? 9999 : n;
    }
    function accessTypeLabel(row) {
      var lv = String(row.level || '');
      var u = lv.toUpperCase();
      if (/^(QOP|SOP|AOP|HOP|VOP)$/.test(u)) return u;
      if (u === 'FOUNDER') return 'QOP';
      if (isFlagToken(lv)) return lv;
      if (/^-?\d+$/.test(lv)) return lv;
      if (lv) return lv;
      return String(row.system || '').toUpperCase() || '?';
    }
    function parseAccessList(text) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^(liste|list|num\b|num[eé]ro|end of|fin de|acc[eè]s|access list|entries for|niveau|level|masque|mask)\b/i.test(s)
          && !/^\d+/.test(s)) return;
        if (/vide|empty|no (sop|aop|hop|vop|entries|users)|aucun/i.test(s) && !/^\d+/.test(s)) return;
        var m = s.match(/^(?:[-*•]\s*)?(\d+)\s*[:.)]\s+(\S+)\s*=\s*(\S+)/)
          || s.match(/^(?:[-*•]\s*)?(\d+)\s+(\S+)\s*=\s*(\S+)/);
        if (m) {
          var nickEq = m[2].replace(/[.,;]+$/, '');
          var typeEq = m[3].replace(/[.,;]+$/, '');
          if (/^(num|nick|pseudo|level|niveau|mask|masque)$/i.test(nickEq)) return;
          rows.push({
            n: m[1],
            nick: nickEq,
            level: typeEq,
            system: inferAccessSystem(typeEq, ''),
          });
          return;
        }
        m = s.match(/^(?:[-*•]\s*)?(\d+)(?:[.:)])?\s+(\S+)\s+(\S+)(?:\s+\((\w+)\))?/);
        if (!m) return;
        if (/^(num|nick|pseudo|level|niveau|mask|masque)$/i.test(m[2])
          || /^(num|nick|pseudo|level|niveau|mask|masque)$/i.test(m[3])) return;
        var a = m[2];
        var b = m[3].replace(/[.,;]+$/, '');
        if (b === '=') return;
        var level = a;
        var nick = b;
        if (isAccessTypeToken(b) && !isAccessTypeToken(a)) {
          level = b;
          nick = a;
        } else if (isAccessTypeToken(a) && !isAccessTypeToken(b)) {
          level = a;
          nick = b;
        }
        rows.push({
          n: m[1],
          level: level,
          nick: nick,
          system: inferAccessSystem(level, m[4] || ''),
        });
      });
      return rows;
    }
    function parseXopList(text, level) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^(liste|list|num\b|end of|fin de|acc[eè]s|access list|entries for)/i.test(s)) return;
        if (/vide|empty|no (sop|aop|hop|vop|entries|users)|aucun/i.test(s) && !/^\d+/.test(s)) return;
        var m = s.match(/^(?:[-*]\s*)?\d+\s+(SOP|AOP|HOP|VOP|QOP)\s+(\S+)/i);
        if (m) { rows.push({ level: m[1].toUpperCase(), nick: m[2].replace(/[.,;]+$/, ''), system: 'XOP' }); return; }
        m = s.match(/^(?:[-*]\s*)?\d+\s+(\S+)/);
        if (m && !/^(num|nick|pseudo|level|niveau)$/i.test(m[1])) {
          rows.push({ level: level, nick: m[1].replace(/[.,;]+$/, ''), system: 'XOP' });
        }
      });
      return rows;
    }

    function parseEntryList(text, joinWrap) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        var m = s.match(/^(?:[-*•]\s*)?(\d+)\s*[:.)]\s*(.+)$/)
          || s.match(/^\[(\d+)\]\s*(.+)$/)
          || s.match(/^(?:[-*•]\s*)?(\d+)\s{2,}(.+)$/);
        if (!m) {
          if (joinWrap && rows.length && !/^(end of|fin de|liste|list|syntaxe|syntax)\b/i.test(s)) {
            var prev = rows[rows.length - 1];
            var glue = (/[A-Za-zÀ-ÿ]$/.test(prev.text) && /^[a-zà-ÿ]/.test(s)) ? '' : ' ';
            prev.text = prev.text.replace(/\s+$/, '') + glue + s.replace(/^\s+/, '');
          }
          return;
        }
        var rest = m[2].trim();
        if (!rest || /^(end of|fin de|liste|list)\b/i.test(rest)) return;
        rows.push({ n: m[1], text: rest });
      });
      return rows;
    }
    function formatEnDateFr(en) {
      var days = { sun: 'dim.', mon: 'lun.', tue: 'mar.', wed: 'mer.', thu: 'jeu.', fri: 'ven.', sat: 'sam.' };
      var months = { jan: 'janv.', feb: 'févr.', mar: 'mars', apr: 'avr.', may: 'mai', jun: 'juin', jul: 'juil.', aug: 'août', sep: 'sept.', oct: 'oct.', nov: 'nov.', dec: 'déc.' };
      var m = String(en || '').match(/^(\w+)\s+(\w+)\s+(\d{1,2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s+(\d{4})/);
      if (!m) return String(en || '').trim();
      var d = days[m[1].slice(0, 3).toLowerCase()] || m[1];
      var mo = months[m[2].slice(0, 3).toLowerCase()] || m[2];
      return d + ' ' + m[3] + ' ' + mo + ' ' + m[5] + ' à ' + m[4];
    }
    function parseTopicStamp(text) {
      var s = String(text || '').trim();
      var m = s.match(/^((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*[¤:]\s*(.*)$/i)
        || s.match(/^((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*)$/i);
      if (!m) return { when: '', who: '', topic: s };
      return { when: formatEnDateFr(m[1]), who: m[2], topic: String(m[3] || '').trim() };
    }
    function parseAkickList(text) {
      var rows = [];
      var cur = null;
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^(liste|list|akick|syntaxe|syntax|fin de|end of|gere la liste|gère la liste)\b/i.test(s) && !/^\d+/.test(s)) return;
        if (/(vide|empty|aucun|no (akick|entries))/i.test(s) && !/^\d+/.test(s)) return;
        var m = s.match(/^(?:[-*•]\s*)?(\d+)\s*[:.)]\s+(\S+)(?:\s+\((.+)\))?/)
          || s.match(/^(?:[-*•]\s*)?(\d+)\s+(\S+)(?:\s+\((.+)\))?/);
        if (m) {
          var mask = m[2].replace(/[.,;]+$/, '');
          if (/^(num|mask|masque|nick|pseudo|raison|reason)$/i.test(mask)) return;
          cur = { n: m[1], mask: mask, extra: m[3] || '', reason: '' };
          rows.push(cur);
          return;
        }
        if (!cur) return;
        var r = s.match(/^(?:la\s+)?(?:raison|reason)\s*:\s*(.+)$/i);
        if (r) cur.reason = r[1].trim();
        else if (/^(par|by|set by|ajoute|ajout[ée]e?\s+par|derniere|last used|expire)/i.test(s)) {
          cur.extra = cur.extra ? cur.extra + ' · ' + s : s;
        }
      });
      return rows;
    }
    function nickInAkick(nick, list) {
      var k = foldText(nick);
      if (!k) return null;
      for (var i = 0; i < (list || []).length; i++) {
        var row = list[i];
        var mask = String(row.mask || '');
        var nickPart = foldText(mask.split('!')[0]);
        if (!nickPart || nickPart === '*' || nickPart.indexOf('*') >= 0 || nickPart.indexOf('?') >= 0) continue;
        if (nickPart === k) return row;
      }
      return null;
    }
    function parseBadwordsList(text) {
      var rows = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s) return;
        if (/^(liste|list|num[eé]ro|fin de|end of|syntaxe|syntax)\b/i.test(s)) return;
        var m = s.match(/^(?:[-*•]\s*)?(\d+)\s+(\S+)\s+(ANY|SINGLE|START|END)\s*$/i)
          || s.match(/^(?:[-*•]\s*)?(\d+)\s+(\S+)\s*$/);
        if (!m) return;
        if (/^(num|mot|word|type)$/i.test(m[2])) return;
        rows.push({ n: m[1], word: m[2], type: (m[3] || 'ANY').toUpperCase() });
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
      if (kind === 'botinfo') {
        var botRaw = stripIrc(text);
        var botNick = parseBotNick(botRaw);
        var asked = /BotServ INFO/i.test(ui.lastCmd || '');
        patchUi({
          botInfo: botRaw,
          loading: false,
          bot: botNick || ui.bot,
          flash: asked ? pick('Informations BotServ actualisées.', 'BotServ info updated.') : ui.flash,
          flashErr: false,
        });
        expectKind = '';
        return;
      }
      if (kind === 'ytstats') {
        patchUi({ ytStats: stripIrc(text), loading: false });
        expectKind = '';
        return;
      }
      if (kind === 'entrymsg') {
        var entryRaw = stripIrc(text);
        var entryRows = parseEntryList(entryRaw);
        var entryErr = looksLikeServError(entryRaw) && !entryRows.length;
        var entryDenied = entryErr && looksLikeAccessDenied(entryRaw);
        patchUi({
          entryMsgs: entryErr ? (entryDenied ? [] : ui.entryMsgs) : entryRows,
          loading: false,
          flash: entryDenied ? '' : (entryErr ? entryRaw.replace(/\s+/g, ' ').trim().slice(0, 400) : ui.flash),
          flashErr: entryDenied ? false : !!entryErr,
        });
        expectKind = '';
        return;
      }
      if (kind === 'topichistory') {
        var thRaw = stripIrc(text);
        var thRows = parseEntryList(thRaw, true).map(function (row) {
          var p = parseTopicStamp(row.text);
          return { n: row.n, text: row.text, when: p.when, who: p.who, topic: p.topic };
        });
        var thErr = looksLikeServError(thRaw) && !thRows.length && !/vide|empty/.test(foldText(thRaw));
        patchUi({
          topicHistory: thErr ? ui.topicHistory : thRows,
          loading: false,
          flash: thErr ? thRaw.replace(/\s+/g, ' ').trim().slice(0, 400) : ui.flash,
          flashErr: !!thErr,
        });
        expectKind = '';
        return;
      }
      if (kind === 'akick') {
        var akRaw = stripIrc(text);
        if (/syntaxe:\s*akick|syntax:\s*akick/i.test(foldText(akRaw))) {
          if (queryAkick.listOnly) {
            queryAkick.listOnly = false;
          } else {
            queryAkick.listOnly = true;
            beginExpect('akick', chan);
            cs('AKICK ' + chan + ' LIST');
            return;
          }
        }
        queryAkick.listOnly = false;
        var akRows = parseAkickList(akRaw);
        var akErr = looksLikeServError(akRaw) && !akRows.length && !/vide|empty/.test(foldText(akRaw));
        var akDenied = akErr && looksLikeAccessDenied(akRaw);
        patchUi({
          akickList: akErr ? (akDenied ? [] : ui.akickList) : akRows,
          loading: false,
          flash: akDenied ? '' : (akErr ? akRaw.replace(/\s+/g, ' ').trim().slice(0, 400) : ui.flash),
          flashErr: akDenied ? false : !!akErr,
        });
        expectKind = '';
        return;
      }
      if (kind === 'badwords') {
        patchUi({ badwords: parseBadwordsList(text), loading: false, flash: '', flashErr: false });
        expectKind = '';
        return;
      }
      if (kind === 'accesslist') {
        var accRaw = stripIrc(text);
        var accRows = parseAccessList(accRaw);
        if (!accRows.length && looksLikeAccessHelp(accRaw)) {
          xopRows = [];
          xopQueue = ['QOP', 'SOP', 'AOP', 'HOP', 'VOP'];
          beginExpect('xop', chan);
          cs(xopQueue[0] + ' ' + chan + ' LIST');
          return;
        }
        patchUi({ accessList: accRows, accessLoading: false, loading: false });
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
        if (looksLikeBotInfoDump(text)) {
          var dump = stripIrc(text);
          var nick = parseBotNick(dump);
          patchUi({ botInfo: dump, loading: false, bot: nick || ui.bot });
          expectKind = '';
          return;
        }
        var raw = stripIrc(text).replace(/\s+/g, ' ').trim().slice(0, 400);
        var err = looksLikeServError(raw);
        if (!ui.open && !err) {
          patchUi({ loading: false });
          expectKind = '';
          return;
        }
        patchUi({ flash: raw, flashErr: !!err, loading: false, open: err ? true : ui.open });
        expectKind = '';
        cache = {};
        if (!err && ui.chan) {
          if (/^BotServ (SET|KICK)\b/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryBotInfo(ui.chan); }, 400);
          } else if (/^BotServ BADWORDS\b/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryBadwords(ui.chan); }, 400);
          } else if (/^ChanServ ENTRYMSG\b/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryEntryMsg(ui.chan); }, 400);
          } else if (/^ChanServ AKICK\b/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryAkick(ui.chan); }, 500);
          } else if (/TOPICHISTORY/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryInfo(ui.chan, { keepFlash: true }); }, 500);
            setTimeout(function () { queryTopicHistory(ui.chan); }, 700);
          } else if (!/^BotServ\b/i.test(ui.lastCmd || '')) {
            setTimeout(function () { queryInfo(ui.chan, { keepFlash: true }); }, 500);
            if (ui.tab === 'access') {
              setTimeout(function () { queryAccess(ui.chan, true); }, 700);
            }
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
      try { orbit.emit('orbit:panel', 'orbit-chanserv'); } catch (e) { /* ignore */ }
      queryInfo(chan);
    }

    function closePanel() { patchUi({ open: false }); }

    function onTopbarPointer(e) {
      if (!ui.open) return;
      var el = e.target;
      if (!el || !el.closest) return;
      if (el.closest('.ocs-tb, .ocs-panel, .memberrsn, .memberrsn-scrim')) return;
      if (el.closest('.topbar, .nmenu')) closePanel();
    }
    document.addEventListener('mousedown', onTopbarPointer, true);

    function injectStyles() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = [
        '.ocs-panel{position:fixed;top:calc(env(safe-area-inset-top,0px) + 3.6rem);right:12px;z-index:160;',
        'width:min(28rem,calc(100vw - 1.5rem));min-width:0;',
        'max-width:calc(100vw - 1.5rem);box-sizing:border-box;',
        'max-height:min(88vh,720px);overflow:hidden;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45));',
        'padding:1rem 1rem .9rem;display:flex;flex-direction:column;gap:.55rem}',
        '.ocs-chrome{display:flex;flex-direction:column;gap:.55rem;flex:none;min-width:0;max-width:100%;',
        'position:sticky;top:0;z-index:2;background:var(--bg)}',
        '.ocs-body{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;',
        'overscroll-behavior:contain;display:flex;flex-direction:column;gap:.55rem;width:100%;min-width:0;max-width:100%}',
        '.ocs-block{display:flex;flex-direction:column;gap:.55rem;min-width:0}',
        '.ocs-block + .ocs-block{margin-top:.1rem;padding-top:.7rem;border-top:1px solid var(--border)}',
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
        '.ocs-field,.ocs-acwrap{min-width:0;max-width:100%}',
        '.ocs-input,.ocs-select{width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:38px;padding:.45rem .65rem;border-radius:10px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit}',
        '.ocs-textarea{min-height:7.2rem;height:auto;resize:vertical;line-height:1.45;white-space:pre-wrap;overflow:auto;',
        'overflow-wrap:anywhere;word-break:break-word;font:inherit;font-family:inherit}',
        '.ocs-input:focus,.ocs-select:focus,.ocs-textarea:focus{outline:2px solid var(--accent);outline-offset:-2px}',
        '.ocs-ac{margin-top:.15rem;max-height:11.5rem;overflow:auto;border:1px solid var(--border);border-radius:10px;',
        'background:var(--bg);box-shadow:0 8px 22px rgba(0,0,0,.12)}',
        '.ocs-ac__item{display:flex;align-items:center;justify-content:space-between;gap:.45rem;width:100%;',
        'text-align:left;border:0;background:none;color:var(--ink);font:inherit;font-weight:750;font-size:.82rem;',
        'padding:.4rem .6rem;cursor:pointer}',
        '.ocs-ac__item.is-on,.ocs-ac__item:hover{background:var(--accent-soft);color:var(--accent)}',
        '.ocs-ac__tag{flex:none;font-size:.65rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}',
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
        '.ocs-info{display:flex;flex-direction:column;gap:.35rem;min-width:0}',
        '.ocs-dl__head{margin:.2rem 0 0;font-size:.78rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);padding:.15rem 0;',
        'line-height:1.35;overflow-wrap:normal;word-break:normal}',
        '.ocs-nowrap{white-space:nowrap}',
        '.ocs-caps{text-transform:uppercase;letter-spacing:.03em;font-weight:800}',
        '.ocs-sep{border:0;border-top:1px solid var(--border);margin:.2rem 0;width:100%}',
        '.ocs-frame{border:1px solid var(--border);border-radius:12px;padding:.55rem .65rem;display:flex;flex-direction:column;gap:.45rem;min-width:0}',
        '.ocs-dl__row{display:grid;grid-template-columns:minmax(6.2rem,8.4rem) minmax(0,1fr);gap:.35rem .75rem;',
        'padding:.45rem .6rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border);overflow:hidden;min-width:0}',
        '.ocs-dl__k{font-size:.7rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);align-self:start;padding-top:.12rem}',
        '.ocs-dl__v{font-size:.86rem;line-height:1.4;color:var(--ink);min-width:0;overflow-wrap:anywhere;word-break:break-word}',
        '.ocs-dl__row.is-hi{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 42%,var(--border))}',
        '.ocs-dl__row.is-hi .ocs-dl__k{color:var(--accent)}',
        '.ocs-pills{display:flex;flex-wrap:wrap;gap:.3rem;min-width:0;max-width:100%}',
        '.ocs-pill{font-size:.72rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;',
        'background:var(--bg);border:1px solid var(--border);color:var(--ink)}',
        '.ocs-pill.is-on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 42%,var(--border));color:var(--accent)}',
        '.ocs-pill.is-off{color:var(--muted)}',
        '.ocs-now{font-size:.82rem;line-height:1.4;padding:.5rem .65rem;border-radius:10px;',
        'background:var(--bg-soft);border:1px solid var(--border);color:var(--ink);white-space:pre-wrap}',
        '.ocs-flash__cmd{display:block;font-size:.72rem;font-weight:650;opacity:.75;margin-bottom:.25rem;word-break:break-all}',
        '.ocs-tabs{display:flex;flex-wrap:nowrap;align-items:center;gap:.08rem;border-bottom:1px solid var(--border);',
        'padding:0 0 .2rem;overflow:visible;width:max-content;max-width:none;box-sizing:border-box;flex:none}',
        '.ocs-tab{border:0;background:transparent;color:var(--muted);font:inherit;font-weight:800;font-size:.72rem;',
        'display:inline-flex;align-items:center;gap:.28rem;padding:.35rem .48rem;border-radius:8px;cursor:pointer;flex:none;white-space:nowrap}',
        '.ocs-tab.is-on{color:var(--accent);background:var(--accent-soft)}',
        '.ocs-subtabs{display:flex;flex-wrap:wrap;gap:.3rem;overflow:visible}',
        '.ocs-subtabs.ocs-modesubs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.35rem;width:100%}',
        '.ocs-stab{border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit;',
        'font-weight:750;font-size:.76rem;padding:.35rem .65rem;border-radius:999px;cursor:pointer;flex:none;white-space:nowrap}',
        '.ocs-modesubs .ocs-stab{display:flex;align-items:center;justify-content:center;width:100%;text-align:center;border-radius:10px;padding:.48rem .35rem;font-size:.74rem}',
        '.ocs-stab.is-on{background:var(--accent);color:#fff;border-color:transparent}',
        '.ocs-setrow{display:flex;align-items:center;justify-content:space-between;gap:.5rem;',
        'padding:.4rem .55rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)}',
        '.ocs-setrow.is-on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 42%,var(--border))}',
        '.ocs-setrow .ocs-label{min-width:0;flex:1}',
        '.ocs-sw{display:inline-flex;align-items:center;gap:.32rem;flex:none}',
        '.ocs-sw.is-off{opacity:.55}',
        '.ocs-sw.is-off .switch{pointer-events:none;cursor:not-allowed}',
        '.ocs-sw__txt{font-size:.65rem;font-weight:800;letter-spacing:.04em;color:var(--muted);line-height:1}',
        '.ocs-sw__txt.is-on{color:var(--accent)}',
        '.ocs-sw .switch{width:40px;height:22px}',
        '.ocs-sw .switch__dot{width:16px;height:16px;top:3px;left:3px}',
        '.ocs-sw .switch.is-on .switch__dot{transform:translateX(18px)}',
        '.ocs-mm{position:relative;padding:.1rem 0 .15rem}',
        '.ocs-mm__trig{display:flex;align-items:center;justify-content:flex-start;gap:.45rem;width:100%;font-weight:700;white-space:nowrap}',
        '.memberctx__item.ocs-mirow{display:flex;align-items:center;gap:.5rem;white-space:nowrap}',
        '.ocs-miwrap{display:inline-flex;flex:none;line-height:0}',
        '.ocs-mi{flex:none;display:block;opacity:.88}',
        '.memberctx__item:hover .ocs-mi,.ocs-mm.is-open .ocs-mm__trig .ocs-mi,.ocs-tab.is-on .ocs-mi{opacity:1}',
        '.ocs-mm__chev{opacity:.55;font-size:.95rem;line-height:1}',
        '.ocs-mm.is-open .ocs-mm__trig,.ocs-mm:hover .ocs-mm__trig{background:var(--accent);color:#fff}',
        '.ocs-mm__bridge{position:absolute;right:100%;top:-80px;bottom:-80px;width:18px;z-index:219}',
        '.ocs-mm__fly{position:absolute;right:calc(100% - 2px);top:-4px;z-index:220;min-width:220px;max-width:320px;',
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
        'padding:.28rem .5rem;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border);min-width:0}',
        '.ocs-ml.is-on{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:var(--accent-soft)}',
        '.ocs-ml.is-lock{border-style:dashed}',
        '.ocs-ml__lab{font-size:.8rem;font-weight:750;min-width:0;line-height:1.25;overflow:hidden;text-overflow:ellipsis}',
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
        '.ocs-acc__pad{display:flex;flex-direction:column;gap:.5rem;padding:.55rem .65rem}',
        '.ocs-acc__pad .ocs-input,.ocs-acc__pad .ocs-select,.ocs-acc__pad .ocs-textarea{background:var(--bg)}',
        '.ocs-acc__row{display:flex;align-items:center;gap:.45rem;',
        'padding:.35rem .6rem;border-top:1px solid var(--border);font-size:.84rem}',
        '.ocs-acc__nick{font-weight:700;word-break:break-all;min-width:0;flex:1}',
        '.ocs-acc__type{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ocs-acc__row .ocs-btn{min-height:28px;padding:.18rem .5rem;font-size:.72rem;flex:none}',
        '.ocs-th__row{display:flex;flex-direction:column;align-items:stretch;gap:.22rem;',
        'padding:.5rem .65rem;border-top:1px solid var(--border)}',
        '.ocs-th__row:first-child{border-top:0}',
        '.ocs-th__top{display:flex;align-items:flex-start;justify-content:space-between;gap:.45rem}',
        '.ocs-th__meta{font-size:.72rem;color:var(--muted);font-weight:650;line-height:1.35;min-width:0}',
        '.ocs-th__who{font-weight:800;color:var(--ink)}',
        '.ocs-th__text{font-size:.86rem;line-height:1.4;overflow-wrap:anywhere;word-break:break-word}',
        '.ocs-th__edit,.ocs-setinfo{font:inherit;font-family:inherit;font-size:.86rem;line-height:1.4}',
        '.ocs-th__edit{display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:1.4em;',
        'height:auto;margin:0;padding:0;border:0;background:transparent;color:var(--ink);',
        'overflow:hidden;overflow-wrap:anywhere;word-break:break-word;resize:none}',
        '.ocs-th__edit:focus{outline:none}',
        '.ocs-th__row .ocs-btn{min-height:28px;padding:.18rem .5rem;font-size:.72rem;flex:none;align-self:flex-start}',
        '.ocs-acclip{max-height:calc(5 * 2.55rem);overflow-y:auto;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)}',
        '.ocs-acclip .ocs-acc__row:first-child{border-top:0}',
        '.ocs-mm__reason{margin:.2rem .45rem .3rem;min-height:32px;padding:.28rem .5rem;border-radius:8px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit;font-size:.8rem;',
        'width:calc(100% - .9rem);box-sizing:border-box}',
        '.topbar__search.ocs-tb--ok{color:var(--accent)}',
        '.topbar__search.ocs-tb--free,.topbar__search.ocs-tb--none,.topbar__search.ocs-tb--wait{color:var(--muted)}',
        '.nmenu__ic .ocs-ic--ok{color:var(--accent)}',
        '.nmenu__ic .ocs-ic--free,.nmenu__ic .ocs-ic--none,.nmenu__ic .ocs-ic--wait{color:var(--muted)}',
        '@media (max-width:880px){',
        '.ocs-panel{top:max(8px,env(safe-area-inset-top,0px));bottom:auto;right:8px;left:8px;width:auto;min-height:0;',
        'max-height:calc(100vh - 80px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));',
        'max-height:calc(100dvh - 80px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px))}',
        '.ocs-tabs{max-width:100%;width:auto;overflow-x:auto}',
        '.ocs-mm__bridge{display:none}',
        '.ocs-mm__fly,.ocs-mm__fly .ocs-mm__fly{position:relative;right:auto;left:auto;top:auto!important;bottom:auto!important;',
        'width:auto;min-width:0;max-width:none;max-height:none;margin:2px 0 4px;z-index:auto;box-shadow:none;',
        'border:1px solid var(--border)}',
        '.ocs-mm__trig,.memberctx__item.ocs-mirow,.ocs-mm__fly .memberctx__item{white-space:normal;overflow-wrap:anywhere}',
        '.ocs-mm__chev{display:inline-block;transform:rotate(-90deg)}}',
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
    function OnOffSwitch(props) {
      var on = !!props.on;
      var off = !!props.disabled;
      return h('span', { className: 'ocs-sw' + (off ? ' is-off' : '') },
        h('span', { className: 'ocs-sw__txt' + (!on ? ' is-on' : ''), 'aria-hidden': true }, 'OFF'),
        h('button', {
          type: 'button',
          className: 'switch' + (on ? ' is-on' : ''),
          role: 'switch',
          'aria-checked': on,
          'aria-disabled': off,
          disabled: off,
          'aria-label': props.label || '',
          title: off ? (props.lockTitle || props.title) : props.title,
          onClick: off ? undefined : props.onClick,
        }, h('span', { className: 'switch__dot' })),
        h('span', { className: 'ocs-sw__txt' + (on ? ' is-on' : ''), 'aria-hidden': true }, 'ON')
      );
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
      var isu = orbit.server.isupport() || {};
      var cm = String(isu.CHANMODES || 'beI,k,l,imnstp').split(',');
      var flags = '';
      for (var i = 3; i < cm.length; i++) flags += cm[i];
      if (!flags) flags = 'imnstp';
      var skip = 'qaohvbeIkflLjOFJ';
      var px = String(isu.PREFIX || '').match(/^\(([^)]+)\)/);
      if (px) skip += px[1];
      var out = [];
      function add(letter) {
        if (!letter || skip.indexOf(letter) >= 0 || out.indexOf(letter) >= 0) return;
        out.push(letter);
      }
      for (var j = 0; j < flags.length; j++) add(flags[j]);
      var catalog = 'iARzspmnUtMNCTcSGQKDdHPruV';
      for (var k = 0; k < catalog.length; k++) add(catalog[k]);
      return out;
    }
    function modeCatalog() {
      return [
        {
          id: 'join',
          title: pick('Sécurité', 'Security'),
          modes: [
            ['i', pick('Sur invitation', 'Invite only'), pick('Salon uniquement sur invitation : il faut être invité pour entrer.', 'Only invited users can join.')],
            ['s', pick('Secret', 'Secret'), pick('Le salon n’apparaît pas dans les listes publiques.', 'The channel is hidden from public lists.')],
            ['p', pick('Privé', 'Private'), pick('Le salon n’apparaît pas comme salon public.', 'The channel is marked private.')],
            ['R', pick('Compte enregistré', 'Registered nick'), pick('Il faut un pseudo enregistré (NickServ) pour rejoindre.', 'A registered nickname is required to join.')],
            ['z', pick('Connexion chiffrée', 'TLS only'), pick('Uniquement les connexions chiffrées (TLS/SSL).', 'Only TLS/SSL connections may join.')],
            ['A', pick('Autoriser les invitations', 'Allow invite'), pick('Les membres peuvent INVITE même si le salon est +i.', 'Members may INVITE even when the channel is +i.')],
          ],
        },
        {
          id: 'talk',
          title: pick('Discussion', 'Talking'),
          modes: [
            ['n', pick('Pas de msg extérieur', 'No external msgs'), pick('Impossible d’écrire depuis l’extérieur du salon.', 'Messages from outside the channel are blocked.')],
            ['t', pick('Topic protégé', 'Topic locked'), pick('Seuls les opérateurs peuvent changer le sujet.', 'Only operators can change the topic.')],
            ['m', pick('Modéré', 'Moderated'), pick('Seuls les personnes avec voix ou op peuvent écrire.', 'Only voiced or opped users can speak.')],
            ['c', pick('Bloquer les couleurs', 'Block colors'), pick('Les messages avec couleurs IRC sont refusés.', 'Messages containing IRC colors are rejected.')],
            ['C', pick('Pas de CTCP', 'No CTCP'), pick('Les requêtes CTCP (hors ACTION) sont bloquées.', 'CTCP requests (except ACTION) are blocked.')],
            ['T', pick('Pas de NOTICE', 'No NOTICE'), pick('Les messages NOTICE vers le salon sont bloqués.', 'Channel NOTICE messages are blocked.')],
            ['N', pick('Pas de changement de pseudo', 'No nick change'), pick('Impossible de changer de pseudo dans ce salon.', 'Nickname changes are blocked in this channel.')],
            ['M', pick('Parler si enregistré', 'Registered to speak'), pick('Il faut un pseudo enregistré pour parler.', 'A registered nickname is required to speak.')],
            ['S', pick('Retirer les couleurs', 'Strip colors'), pick('Les couleurs IRC sont enlevées des messages.', 'IRC colors are stripped from messages.')],
            ['G', pick('Filtre de mots', 'Badword filter'), pick('Les mots filtrés par le serveur sont censurés.', 'Server-filtered words are censored.')],
            ['Q', pick('Pas d’expulsion', 'No kicks'), pick('Les kicks par les opérateurs du salon sont interdits.', 'Channel operator kicks are forbidden.')],
            ['U', pick('Op-modéré', 'Op-moderated'), pick('Les messages des membres sans voix/op sont masqués pour les autres membres sans privilège.', 'Messages from unprivileged users are hidden from other unprivileged users.')],
          ],
        },
        {
          id: 'other',
          title: pick('Autres', 'Other'),
          modes: [
            ['r', pick('Salon enregistré', 'Registered channel'), pick('Marqueur de salon enregistré (souvent posé par les services).', 'Registered-channel flag (usually set by services).')],
            ['P', pick('Permanent', 'Permanent'), pick('Le salon n’est pas détruit même vide.', 'The channel is not destroyed when empty.')],
            ['K', pick('Pas de knock', 'No knock'), pick('La commande KNOCK (toquer) est interdite.', 'The KNOCK command is disabled.')],
            ['V', pick('Pas d’invitation', 'No invite'), pick('Les invitations par les membres sont interdites.', 'INVITE by channel members is forbidden.')],
            ['D', pick('Entrée différée', 'Delay join'), pick('Les arrivées ne s’affichent qu’au premier message.', 'Joins are hidden until the user speaks.')],
            ['d', pick('Membres masqués', 'Hidden members'), pick('Les membres inactifs peuvent être masqués (delay join).', 'Idle members may be hidden (delay join).')],
            ['H', pick('Masquer les arrivées', 'Hide joins'), pick('Les messages d’arrivée/départ sont masqués.', 'Join and part messages are hidden.')],
            ['u', pick('Auditorium', 'Auditorium'), pick('Les simples membres ne se voient pas entre eux.', 'Regular members cannot see each other.')],
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

    function fitTextarea(el) {
      if (!el) return;
      el.style.height = '0px';
      el.style.height = el.scrollHeight + 'px';
    }

    function AutoTextarea(props) {
      var r = useRef(null);
      useLayoutEffect(function () { fitTextarea(r.current); }, [props.value]);
      var p = {};
      Object.keys(props).forEach(function (k) { if (k !== 'onChange') p[k] = props[k]; });
      p.ref = r;
      p.rows = props.rows || 1;
      p.onChange = function (e) {
        fitTextarea(e.target);
        if (props.onChange) props.onChange(e);
      };
      return h('textarea', p);
    }

    function Field(props) {
      return h('div', { className: 'ocs-field' },
        props.label ? h('label', { className: 'ocs-label' + (props.caps ? ' ocs-caps' : '') }, props.label) : null,
        props.children
      );
    }

    function nickCandidates(chan, q) {
      var st = {};
      try { st = orbit.state.get() || {}; } catch (e) { st = {}; }
      var me = foldText(st.nick || '');
      var friends = st.friends || [];
      var friendSet = {};
      friends.forEach(function (n) { friendSet[foldText(n)] = n; });
      var seen = {};
      var rows = [];
      function push(nick, inChan, inFriend) {
        if (!nick || isNamedService(nick)) return;
        var k = foldText(nick);
        if (!k || k === me || seen[k]) return;
        seen[k] = true;
        rows.push({ nick: nick, inChan: inChan, inFriend: inFriend });
      }
      var mem = ((findBuffer(chan) || {}).members) || {};
      Object.keys(mem).forEach(function (n) {
        var nick = (mem[n] && mem[n].nick) || n;
        push(nick, true, !!friendSet[foldText(nick)]);
      });
      friends.forEach(function (n) { push(n, false, true); });
      var needle = foldText(q);
      if (needle) {
        var start = [];
        var mid = [];
        rows.forEach(function (r) {
          var f = foldText(r.nick);
          if (f.indexOf(needle) === 0) start.push(r);
          else if (f.indexOf(needle) >= 0) mid.push(r);
        });
        rows = start.concat(mid);
      }
      return rows.slice(0, 12);
    }

    function NickComplete(props) {
      var openSt = useState(false);
      var open = openSt[0];
      var setOpen = openSt[1];
      var idxSt = useState(0);
      var idx = idxSt[0];
      var setIdx = idxSt[1];
      var cands = nickCandidates(props.chan, props.value);
      var show = open && cands.length > 0;
      function pickNick(nick) {
        props.onChange(nick);
        setOpen(false);
      }
      function onKey(e) {
        if (!cands.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setOpen(true);
          setIdx(function (i) { return (i + 1) % cands.length; });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setOpen(true);
          setIdx(function (i) { return (i - 1 + cands.length) % cands.length; });
        } else if ((e.key === 'Enter' || e.key === 'Tab') && show) {
          e.preventDefault();
          pickNick(cands[Math.max(0, Math.min(idx, cands.length - 1))].nick);
        } else if (e.key === 'Escape') {
          setOpen(false);
        }
      }
      useEffect(function () { setIdx(0); }, [props.value, props.chan]);
      return h('div', { className: 'ocs-acwrap' },
        h('input', {
          className: 'ocs-input',
          value: props.value,
          autoComplete: 'off',
          spellCheck: false,
          onFocus: function () { setOpen(true); },
          onBlur: function () { setTimeout(function () { setOpen(false); }, 120); },
          onChange: function (e) { props.onChange(e.target.value); setOpen(true); },
          onKeyDown: onKey,
        }),
        show ? h('div', { className: 'ocs-ac', role: 'listbox' }, cands.map(function (r, i) {
          var tag = r.inChan && r.inFriend
            ? pick('salon · ami', 'room · friend')
            : r.inFriend
              ? pick('ami', 'friend')
              : pick('salon', 'room');
          return h('button', {
            key: r.nick,
            type: 'button',
            role: 'option',
            className: 'ocs-ac__item' + (i === idx ? ' is-on' : ''),
            onMouseDown: function (e) { e.preventDefault(); pickNick(r.nick); },
            onMouseEnter: function () { setIdx(i); },
          },
            h('span', null, r.nick),
            h('span', { className: 'ocs-ac__tag' }, tag)
          );
        })) : null
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
      var modOpenSt = useState(false);
      var modOpen = modOpenSt[0];
      var setModOpen = modOpenSt[1];
      var closeT = useRef(0);
      var flyRef = useRef(null);
      function keepOpen() {
        if (closeT.current) { clearTimeout(closeT.current); closeT.current = 0; }
        setOpen(true);
      }
      function delayClose() {
        if (closeT.current) clearTimeout(closeT.current);
        closeT.current = setTimeout(function () { closeT.current = 0; setOpen(false); setAccOpen(false); setModOpen(false); }, 280);
      }
      useEffect(function () {
        return function () { if (closeT.current) clearTimeout(closeT.current); };
      }, []);
      useLayoutEffect(function () {
        if (!open) return undefined;
        var el = flyRef.current;
        if (!el) return undefined;
        if (window.innerWidth <= 880) {
          el.style.top = '';
          el.style.bottom = '';
          el.style.maxHeight = '';
          return undefined;
        }
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
        if (!(s.chan === chan && s.registered !== null)) queryInfo(chan);
        if (!(s.bots && s.bots.length)) queryBotlist();
        return undefined;
      }, [chan]);
      useEffect(function () {
        if (!open || !isChannel(chan) || !identified()) return undefined;
        if (s.registered === true && can(ACCESS_RANK.sop)) queryAccess(chan);
        if (s.registered === true && can(ACCESS_RANK.sop)) queryAkick(chan);
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
      var aop = serv ? can(ACCESS_RANK.aop) : ircOp;
      var vop = serv ? can(ACCESS_RANK.vop) : ircOp;
      var hopOk = hop && (serv ? can(ACCESS_RANK.hop) : ircOp);
      var sop = serv ? can(ACCESS_RANK.sop) : ircOp;
      var founder = serv ? can(ACCESS_RANK.founder) : ircOp;
      var fly = [];
      var pfx = memberPrefixChars(ch, nick);
      if (serv && can(ACCESS_RANK.sop)) {
        var haveXop = xopForNick(nick);
        var accFly = [];
        function accBtn(lv, add, label) {
          if (!canManageXop(lv)) return;
          if (add) {
            if (haveXop) return;
          } else if (haveXop !== lv) return;
          accFly.push(menuBtn(lv + (add ? 'a' : 'd'), false, function () {
            go(lv + ' ' + ch + ' ' + (add ? 'ADD ' : 'DEL ') + nick);
          }, add ? 'assign' : 'unassign',
            (add ? pick('Créer Accès ', 'Create Access ') : pick('Supprimer Accès ', 'Delete Access ')) + label));
        }
        accBtn('VOP', true, pick('Voice (VOP)', 'Voice (VOP)'));
        accBtn('VOP', false, pick('Voice (VOP)', 'Voice (VOP)'));
        accBtn('HOP', true, pick('HalfOp (HOP)', 'HalfOp (HOP)'));
        accBtn('HOP', false, pick('HalfOp (HOP)', 'HalfOp (HOP)'));
        accBtn('AOP', true, pick('Opérateur (AOP)', 'Operator (AOP)'));
        accBtn('AOP', false, pick('Opérateur (AOP)', 'Operator (AOP)'));
        accBtn('SOP', true, pick('Admin (SOP)', 'Admin (SOP)'));
        accBtn('SOP', false, pick('Admin (SOP)', 'Admin (SOP)'));
        accBtn('QOP', true, pick('Fondateur (QOP)', 'Founder (QOP)'));
        accBtn('QOP', false, pick('Fondateur (QOP)', 'Founder (QOP)'));
        if (accFly.length) {
          fly.push(h('div', {
            key: 'acc',
            className: 'ocs-mm' + (accOpen ? ' is-open' : ''),
              onMouseEnter: function () { setAccOpen(true); setModOpen(false); keepOpen(); },
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
                if (!accOpen) setModOpen(false);
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
      var modFly = [];
      var canWarn = aop || hopOk;
      var canAkick = serv && sop;
      if (canWarn) {
        function sendModText(tag, body) {
          var line = nick + ', [' + tag + '] ' + body;
          try { orbit.irc.msg(ch, line); } catch (e) { /* ignore */ }
          try { orbit.irc.send('NOTICE ' + nick + ' :' + line); } catch (e2) { /* ignore */ }
          close();
        }
        modFly.push(menuBtn('mw', false, function () {
          sendModText(
            pick('Avertissement', 'Warning'),
            pick(
              'Ceci est un avertissement de la modération. Merci de rester courtois et de respecter les règles du salon.',
              'This is a moderation warning. Please stay polite and follow the channel rules.'
            )
          );
        }, 'say', pick('Avertissement', 'Warning')));
        modFly.push(menuBtn('mc', false, function () {
          sendModText(
            pick('Comportement', 'Behaviour'),
            pick(
              'Ton comportement n’est pas acceptable. Merci de te calmer, sinon des sanctions pourront être appliquées.',
              'Your behaviour is not acceptable. Please calm down, or sanctions may follow.'
            )
          );
        }, 'say', pick('Comportement', 'Behaviour')));
        modFly.push(menuBtn('ml', false, function () {
          sendModText(
            pick('Langage', 'Language'),
            pick(
              'Merci de surveiller ton langage. Les propos injurieux ou vulgaires ne sont pas autorisés ici.',
              'Please watch your language. Insults and vulgarity are not allowed here.'
            )
          );
        }, 'say', pick('Langage', 'Language')));
      }
      if (canAkick) {
        var akRow = nickInAkick(nick, s.akickList);
        if (akRow) {
          modFly.push(menuBtn('akd', true, function () {
            go('AKICK ' + ch + ' DEL ' + (akRow.n || akRow.mask || nick));
          }, 'unassign', pick('Supprimer AKICK', 'Delete AKICK')));
        } else {
          modFly.push(menuBtn('aka', true, function () {
            go('AKICK ' + ch + ' ADD ' + nick);
          }, 'assign', pick('Ajouter AKICK', 'Add AKICK')));
        }
      }
      if (modFly.length) {
        fly.push(h('div', {
          key: 'mod',
          className: 'ocs-mm' + (modOpen ? ' is-open' : ''),
          onMouseEnter: function () { setModOpen(true); setAccOpen(false); keepOpen(); },
          onMouseLeave: function () { setModOpen(false); },
        },
          h('button', {
            type: 'button',
            className: 'memberctx__item memberctx__item--sub ocs-mm__trig',
            role: 'menuitem',
            'aria-haspopup': 'menu',
            'aria-expanded': modOpen,
            onClick: function (e) {
              e.stopPropagation();
              setModOpen(!modOpen);
              if (!modOpen) setAccOpen(false);
            },
          },
            h('span', { className: 'ocs-mm__chev', 'aria-hidden': true }, '‹'),
            Mi('ban'),
            h('span', null, pick('Modération', 'Moderation'))
          ),
          modOpen ? h('div', { className: 'ocs-mm__fly', role: 'menu', 'aria-label': pick('Modération', 'Moderation') }, modFly) : null
        ));
      }
      function roleBtn(sym, letter, canDo, addCmd, delCmd, addIcon, delIcon, addLab, delLab) {
        if (!canDo) return;
        var has = String(pfx || '').indexOf(sym) >= 0;
        if (has) fly.push(menuBtn(letter + 'd', false, delCmd, delIcon, delLab));
        else fly.push(menuBtn(letter, false, addCmd, addIcon, addLab));
      }
      // Session flags via ChanServ only when we cannot MODE ourselves (not currently opped).
      // Otherwise the native menu already does MODE +v/+h/+o — duplicating it here is noise.
      if (serv && !ircOp) {
        roleBtn('+', 'v', vop,
          function () { go('VOICE ' + ch + ' ' + nick); },
          function () { go('DEVOICE ' + ch + ' ' + nick); },
          'voice', 'novoice', pick('Ajouter Voice', 'Add Voice'), pick('Retirer Voice', 'Remove Voice'));
        roleBtn('%', 'h', hopOk,
          function () { go('HALFOP ' + ch + ' ' + nick); },
          function () { go('DEHALFOP ' + ch + ' ' + nick); },
          'hop', 'nohop', pick('Ajouter Halfop', 'Add Halfop'), pick('Retirer Halfop', 'Remove Halfop'));
        roleBtn('@', 'o', aop,
          function () { go('OP ' + ch + ' ' + nick); },
          function () { go('DEOP ' + ch + ' ' + nick); },
          'op', 'noop', pick('Ajouter Opérateur', 'Add Operator'), pick('Retirer Opérateur', 'Remove Operator'));
        roleBtn('&', 'a', sop && hasPrefixLetter('a'),
          function () { go('PROTECT ' + ch + ' ' + nick); },
          function () { go('DEPROTECT ' + ch + ' ' + nick); },
          'admin', 'noadmin', pick('Ajouter Admin', 'Add Admin'), pick('Retirer Admin', 'Remove Admin'));
        roleBtn('~', 'q', founder && hasPrefixLetter('q'),
          function () { go('OWNER ' + ch + ' ' + nick); },
          function () { go('DEOWNER ' + ch + ' ' + nick); },
          'founder', 'nofounder', pick('Ajouter Fondateur', 'Add Founder'), pick('Retirer Fondateur', 'Remove Founder'));
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
      var setInfoKindSt = useState('DESC');
      var setInfoKind = setInfoKindSt[0];
      var setSetInfoKind = setInfoKindSt[1];
      var banNickSt = useState('');
      var banNick = banNickSt[0];
      var setBanNick = banNickSt[1];
      var banExpSt = useState('');
      var banExp = banExpSt[0];
      var setBanExp = banExpSt[1];
      var banReasonSt = useState('');
      var banReason = banReasonSt[0];
      var setBanReason = banReasonSt[1];
      var akickNickSt = useState('');
      var akickNick = akickNickSt[0];
      var setAkickNick = akickNickSt[1];
      var akickReasonSt = useState('');
      var akickReason = akickReasonSt[0];
      var setAkickReason = akickReasonSt[1];
      var unbanNickSt = useState('');
      var unbanNick = unbanNickSt[0];
      var setUnbanNick = unbanNickSt[1];
      var banTypeSt = useState('');
      var banType = banTypeSt[0];
      var setBanType = banTypeSt[1];
      var inviteSt = useState('');
      var inviteNick = inviteSt[0];
      var setInviteNick = inviteSt[1];
      var entrySt = useState('');
      var entryMsg = entrySt[0];
      var setEntryMsg = entrySt[1];
      var statusNickSt = useState('');
      var statusNick = statusNickSt[0];
      var setStatusNick = statusNickSt[1];
      var botSaySt = useState('');
      var botSay = botSaySt[0];
      var setBotSay = botSaySt[1];
      var botWordSt = useState('');
      var botWord = botWordSt[0];
      var setBotWord = botWordSt[1];
      var bwTypeSt = useState('ANY');
      var bwType = bwTypeSt[0];
      var setBwType = bwTypeSt[1];
      var ytKindSt = useState('channel');
      var ytKind = ytKindSt[0];
      var setYtKind = ytKindSt[1];
      var ytValSt = useState('');
      var ytVal = ytValSt[0];
      var setYtVal = ytValSt[1];
      var modeGroupSt = useState('join');
      var modeGroup = modeGroupSt[0];
      var setModeGroup = modeGroupSt[1];
      var setGroupSt = useState('sec');
      var setGroup = setGroupSt[0];
      var setSetGroup = setGroupSt[1];
      var panelRef = useRef(null);

      useEffect(function () {
        if (s.open && String(s.chan || '') !== String(chan || '')) closePanel();
      }, [chan, s.open, s.chan]);
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
      useEffect(function () {
        if (!s.open || s.registered !== true) return undefined;
        if (s.tab === 'set') queryBotInfo(s.chan || chan);
        if (s.tab === 'divers' && (ACCESS_RANK[s.access] || 0) >= ACCESS_RANK.sop) queryEntryMsg(s.chan || chan);
        return undefined;
      }, [s.open, s.tab, s.chan, s.registered, s.access]);
      useEffect(function () {
        if (!s.open || s.registered !== true || s.tab !== 'topic') return undefined;
        if (parseChanOptions(s.infoText).TOPICHISTORY) queryTopicHistory(s.chan || chan);
        else patchUi({ topicHistory: [] });
        return undefined;
      }, [s.open, s.tab, s.chan, s.registered, s.infoText]);
      useEffect(function () {
        if (!s.open || s.registered !== true || s.tab !== 'set' || setGroup !== 'mod') return undefined;
        queryBadwords(s.chan || chan);
        return undefined;
      }, [s.open, s.tab, setGroup, s.chan, s.registered]);
      useEffect(function () {
        if (!s.open || s.tab !== 'set') return undefined;
        if (setInfoKind === 'BANTYPE') {
          setSetInfoKind('DESC');
          return undefined;
        }
        setSetText(chanSetInfoValue(s.infoText, setInfoKind));
        return undefined;
      }, [s.open, s.tab, s.infoText, setInfoKind]);
      useEffect(function () {
        if (!s.open || s.tab !== 'bans') return undefined;
        var v = String(chanSetInfoValue(s.infoText, 'BANTYPE') || '').replace(/[^\d]/g, '').slice(0, 1);
        setBanType(v === '0' || v === '1' || v === '2' || v === '3' ? v : '2');
        return undefined;
      }, [s.open, s.tab, s.infoText]);
      useEffect(function () {
        if (!s.open || s.tab !== 'bans' || s.registered !== true) return undefined;
        if ((ACCESS_RANK[s.access] || 0) < ACCESS_RANK.sop) return undefined;
        queryAkick(s.chan || chan);
        return undefined;
      }, [s.open, s.tab, s.chan, s.registered, s.access]);
      useLayoutEffect(function () {
        if (!s.open) return undefined;
        var el = panelRef.current;
        if (!el) return undefined;
        function place() {
          if (window.innerWidth <= 880) {
            var vv = window.visualViewport;
            var visTop = vv ? vv.offsetTop : 0;
            var visH = vv ? vv.height : window.innerHeight;
            var topPad = 8;
            var bottomPad = 72;
            el.style.top = (visTop + topPad) + 'px';
            el.style.right = '';
            el.style.left = '';
            el.style.width = '';
            el.style.minWidth = '';
            el.style.height = '';
            el.style.maxHeight = Math.max(160, visH - topPad - bottomPad) + 'px';
            return;
          }
          el.style.maxHeight = '';
          el.style.height = '';
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
            var need = 36;
            Array.prototype.forEach.call(tabsEl.children, function (t) {
              need += t.getBoundingClientRect().width;
            });
            if (tabsEl.children.length > 1) need += (tabsEl.children.length - 1) * 2;
            var cap = window.innerWidth - 16;
            w = Math.min(Math.max(Math.ceil(need), 400), cap);
          }
          el.style.width = w + 'px';
          el.style.minWidth = w + 'px';
          if (window.innerWidth - right - w < 8) {
            el.style.right = Math.max(8, window.innerWidth - w - 8) + 'px';
          }
        }
        place();
        var raf = requestAnimationFrame(place);
        window.addEventListener('resize', place);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', place);
          window.visualViewport.addEventListener('scroll', place);
        }
        return function () {
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', place);
          if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', place);
            window.visualViewport.removeEventListener('scroll', place);
          }
        };
      }, [s.open, s.chan, s.tab, s.registered, s.access, s.infoText, s.flash]);

      if (!s.open) return null;
      var ch = s.chan || chan;
      var tab = s.tab || 'info';
      if (tab === 'salon') tab = 'info';
      if (tab === 'sujet') tab = 'topic';
      var showTopic = s.registered === true && can(ACCESS_RANK.aop);
      var showModes = s.registered === true && can(ACCESS_RANK.aop);
      var showBans = s.registered === true && can(ACCESS_RANK.hop);
      var showAccess = s.registered === true && can(ACCESS_RANK.sop);
      var showSet = s.registered === true && can(ACCESS_RANK.sop);
      var showDivers = s.registered === true && can(ACCESS_RANK.aop);
      if (tab === 'topic' && !showTopic) tab = 'info';
      if (tab === 'modes' && !showModes) tab = 'info';
      if (tab === 'bans' && !showBans) tab = 'info';
      if (tab === 'access' && !showAccess) tab = 'info';
      if (tab === 'set' && !showSet) tab = 'info';
      if (tab === 'bot') tab = showDivers ? 'divers' : 'info';
      if (tab === 'divers' && !showDivers) tab = 'info';
      function goCs(line) { runCmd('ChanServ', line, true); }
      function goBs(line) { runCmd('BotServ', line, true); }
      function csSet(opt, val) {
        goCs('SET ' + opt + ' ' + ch + (val != null && String(val) !== '' ? ' ' + val : ''));
      }
      function csTopicLock(enable) {
        goCs('TOPIC ' + ch + (enable ? ' LOCK' : ' UNLOCK'));
      }
      function csMode(op, modes) {
        var m = String(modes || '').trim();
        if (!m && op !== 'SET' && op !== 'CLEAR') return;
        goCs('MODE ' + ch + ' ' + op + (m ? ' ' + m : ''));
      }
      function subTabs(current, setCurrent, items, extraClass) {
        return h('div', { className: 'ocs-subtabs' + (extraClass ? ' ' + extraClass : ''), role: 'tablist' }, items.map(function (it) {
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
      if (s.loading) chrome.push(h('p', { className: 'ocs-sub' },
        /BotServ/i.test(s.lastCmd || '')
          ? pick('Interrogation de BotServ…', 'Asking BotServ…')
          : pick('Interrogation de ChanServ…', 'Asking ChanServ…')
      ));
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
        tabBtn('bans', 'ban', pick('Bans', 'Bans'), showBans);
        tabBtn('access', 'users', pick('Accès', 'Access'), showAccess);
        tabBtn('set', 'lock', pick('Set', 'Set'), showSet);
        tabBtn('divers', 'more', pick('Divers', 'Other'), showDivers);
        chrome.push(h('div', { className: 'ocs-tabs', role: 'tablist' }, tabs));
        body.push(h('div', { className: 'ocs-row' },
          h('span', { className: 'ocs-badge' }, (s.access || 'none').toUpperCase()),
          s.bot ? h('span', { className: 'ocs-badge' }, pick('Bot', 'Bot') + ' ' + s.bot) : null
        ));

        if (tab === 'info') {
          if (s.infoText) {
            body.push(h('div', { className: 'ocs-info' }, infoCardNodes(s.infoText)));
          }
          pushBtn(body, '', function () {
            beginExpect('info', ch);
            patchUi({ loading: true });
            cs('INFO ' + ch);
          }, 'info', pick('Actualiser l’info', 'Refresh info'));
        }

        if (tab === 'topic' && showTopic) {
          body.push(h('p', { className: 'ocs-h' }, pick('Modifier le topic', 'Edit topic')));
          body.push(h('div', { className: 'ocs-acc' },
            h('div', { className: 'ocs-acc__g' },
              h('div', { className: 'ocs-acc__h' }, pick('Topic actuel', 'Current topic')),
              h('div', { className: 'ocs-th__row' },
                h(AutoTextarea, {
                  className: 'ocs-th__edit',
                  value: topic,
                  onChange: function (e) { setTopic(e.target.value); },
                }),
                h('div', { className: 'ocs-row' },
                  h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
                    var t = topic.trim().replace(/\s+/g, ' ');
                    goCs('TOPIC ' + ch + ' SET' + (t ? ' ' + t : ''));
                  } }, labeled('check', pick('Définir', 'Set'))),
                  h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOPIC ' + ch + ' SET'); } },
                    labeled('novoice', pick('Effacer', 'Clear')))
                )
              )
            )
          ));
          body.push(h('hr', { className: 'ocs-sep' }));
          var topicOpts = parseChanOptions(s.infoText);
          var topicLocked = parseTopicLocked(s.infoText);
          body.push(h('p', { className: 'ocs-h' }, pick('Paramètres du topic', 'Topic settings')));
          body.push(h('div', { className: 'ocs-mg__g' },
            h('div', { className: 'ocs-ml' + (topicLocked ? ' is-on' : '') },
              h('span', { className: 'ocs-ml__lab' }, pick('Verrouiller le topic', 'Lock topic')),
              h(OnOffSwitch, {
                on: topicLocked,
                label: pick('Verrouiller le topic', 'Lock topic'),
                onClick: function () { csTopicLock(!topicLocked); },
              })
            ),
            h('div', { className: 'ocs-ml' + (topicOpts.KEEPTOPIC ? ' is-on' : '') },
              h('span', { className: 'ocs-ml__lab' }, pick('Conserver le topic', 'Keep topic')),
              h(OnOffSwitch, {
                on: !!topicOpts.KEEPTOPIC,
                label: pick('Conserver le topic', 'Keep topic'),
                onClick: function () { csSet('KEEPTOPIC', topicOpts.KEEPTOPIC ? 'OFF' : 'ON'); },
              })
            ),
            h('div', { className: 'ocs-ml' + (topicOpts.TOPICHISTORY ? ' is-on' : '') },
              h('span', { className: 'ocs-ml__lab' }, pick('Historique des topics', 'Topic history')),
              h(OnOffSwitch, {
                on: !!topicOpts.TOPICHISTORY,
                label: pick('Historique des topics', 'Topic history'),
                onClick: function () { csSet('TOPICHISTORY', topicOpts.TOPICHISTORY ? 'OFF' : 'ON'); },
              })
            )
          ));
          if (topicOpts.TOPICHISTORY) {
            if (!(s.topicHistory && s.topicHistory.length)) {
              body.push(h('p', { className: 'ocs-sub' }, pick('Aucun topic enregistré.', 'No saved topics.')));
            } else {
              body.push(h('div', { className: 'ocs-acc' },
                h('div', { className: 'ocs-acc__g' },
                  [h('div', { className: 'ocs-acc__h' }, pick('Topic enregistrés', 'Saved topics'))].concat(s.topicHistory.map(function (row) {
                    var topicTxt = row.topic || row.text;
                    return h('div', { key: row.n, className: 'ocs-th__row' },
                      h('div', { className: 'ocs-th__top' },
                        h('div', { className: 'ocs-th__meta' },
                          row.when || row.who
                            ? [row.when || '', row.who ? h('span', { key: 'w', className: 'ocs-th__who' }, (row.when ? ' · ' : '') + row.who) : null]
                            : ('#' + row.n)
                        ),
                        h('button', {
                          type: 'button', className: 'ocs-btn',
                          onClick: function () { goCs('TOPICHISTORY ' + ch + ' SET ' + row.n); },
                        }, pick('Restaurer', 'Restore'))
                      ),
                      h('div', { className: 'ocs-th__text' }, topicTxt)
                    );
                  }))
                )
              ));
            }
            body.push(h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryTopicHistory(ch); } },
                labeled('list', pick('Actualiser', 'Refresh'))),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOPICHISTORY ' + ch + ' CLEAR'); } },
                labeled('novoice', pick('Tout vider', 'Clear all')))
            ));
          }
        }

        if (tab === 'modes' && showModes) {
          var nowModes = bufferModes(ch);
          var flags = chanFlagLetters();
          var lockedModes = parseMlock(s.infoText);
          body.push(h('p', { className: 'ocs-h' }, pick('Modes actuels', 'Current modes')));
          body.push(h('div', { className: 'ocs-now' }, nowModes || '—'));
          var cat = modeCatalog();
          var used = {};
          cat.forEach(function (g) {
            g.modes.forEach(function (row) { used[row[0]] = true; });
          });
          var extraModes = flags.filter(function (letter) { return !used[letter]; }).map(function (letter) {
            return [letter, pick('Mode ', 'Mode ') + letter, pick('Mode de salon +', 'Channel mode +') + letter];
          });
          var modeTabs = [
            { id: 'join', label: pick('Sécurité', 'Security') },
            { id: 'talk', label: pick('Discussion', 'Talking') },
            { id: 'other', label: pick('Autres', 'Other') },
          ];
          var gid = modeGroup === 'talk' || modeGroup === 'other' ? modeGroup : 'join';
          function modeRow(letter, name, tip) {
            var on = modeIsOn(nowModes, letter);
            var forced = modeForcedLock(letter);
            var locked = forced || mlockHas(lockedModes, letter);
            var sign = on ? '+' : '-';
            var lockTip = forced
              ? pick('Mode posé par les services, non modifiable.', 'Set by services, cannot be changed.')
              : (locked
                ? pick('Mode verrouillé. Retirer le cadenas pour le modifier.', 'Mode is locked. Unlock it to change.')
                : tip);
            return h('div', { key: letter, className: 'ocs-ml' + (on ? ' is-on' : '') + (locked ? ' is-lock' : ''), title: lockTip },
              h('span', { className: 'ocs-ml__lab' }, name + ' ( ', h('span', null, letter), ' )'),
              h('span', { className: 'ocs-ml__btns' },
                h(OnOffSwitch, {
                  on: on,
                  disabled: locked,
                  label: name,
                  title: tip,
                  lockTitle: lockTip,
                  onClick: function () { csMode('SET', (on ? '-' : '+') + letter); },
                }),
                forced ? null : h('button', {
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
          cat.forEach(function (g) {
            if (g.id !== gid) return;
            shown = g.modes.filter(function (row) { return flags.indexOf(row[0]) >= 0; }).map(function (row) {
              return modeRow(row[0], row[1], row[2]);
            });
          });
          if (gid === 'other' && extraModes.length) {
            shown = shown.concat(extraModes.map(function (row) {
              return modeRow(row[0], row[1], row[2]);
            }));
          }
          body.push(h('div', { className: 'ocs-block' }, [
            h('p', { className: 'ocs-h' }, pick('Modifier les modes salon', 'Edit channel modes')),
            subTabs(gid, setModeGroup, modeTabs, 'ocs-modesubs'),
            h('div', { className: 'ocs-frame' },
              shown.length ? shown : [h('p', { key: 'empty', className: 'ocs-sub' }, pick('Aucun mode dans ce groupe.', 'No modes in this group.'))]
            ),
          ]));
          body.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { csMode('CLEAR', ''); } },
              labeled('cog', pick('Vider les modes', 'Clear modes')))
          ));
          body.push(h('p', { className: 'ocs-h' }, pick('Modification manuelle des modes', 'Manual mode edit')));
          body.push(h('input', { className: 'ocs-input', value: modeLine, placeholder: '+nt-k', onChange: function (e) { setModeLine(e.target.value); } }));
          pushBtn(body, 'primary', function () {
            if (modeLine.trim()) csMode('SET', modeLine.trim());
          }, 'cog', pick('Appliquer', 'Apply'));
        }

        if (tab === 'bans' && showBans) {
          var aopBan = can(ACCESS_RANK.aop);
          if (can(ACCESS_RANK.sop)) {
            var akKids = [
              h('p', { className: 'ocs-h' }, pick('Kicks automatiques (AKICK)', 'Auto-kicks (AKICK)')),
              h('p', { className: 'ocs-sub' }, pick(
                'Si une personne de la liste rejoint, ChanServ la ban puis l’expulse.',
                'If someone on the list joins, ChanServ bans then kicks them.'
              )),
            ];
            if (!(s.akickList && s.akickList.length)) {
              akKids.push(h('p', { className: 'ocs-sub' }, pick('Aucun AKICK.', 'No AKICK entries.')));
            } else {
              akKids.push(h('div', { className: 'ocs-acclip' }, s.akickList.map(function (row) {
                return h('div', { key: row.n + row.mask, className: 'ocs-acc__row' },
                  h('span', { className: 'ocs-acc__nick', title: [row.extra, row.reason].filter(Boolean).join(' — ') },
                    row.mask + (row.reason ? ' — ' + row.reason : '')),
                  h('button', {
                    type: 'button', className: 'ocs-btn',
                    onClick: function () { goCs('AKICK ' + ch + ' DEL ' + (row.n || row.mask)); },
                  }, pick('Supprimer', 'Delete'))
                );
              })));
            }
            akKids.push(h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryAkick(ch); } },
                labeled('list', pick('Actualiser', 'Refresh'))),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('AKICK ' + ch + ' ENFORCE'); } },
                labeled('ban', pick('Appliquer', 'Enforce'))),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('AKICK ' + ch + ' CLEAR'); } },
                labeled('novoice', pick('Tout vider', 'Clear all')))
            ));
            akKids.push(h(Field, { label: pick('Pseudo / masque', 'Nick / mask') },
              h(NickComplete, { chan: ch, value: akickNick, onChange: setAkickNick })
            ));
            akKids.push(h('input', {
              className: 'ocs-input',
              value: akickReason,
              placeholder: pick('Raison (optionnel)', 'Reason (optional)'),
              onChange: function (e) { setAkickReason(e.target.value); },
            }));
            pushBtn(akKids, 'primary', function () {
              var t = akickNick.trim();
              if (!t) return;
              goCs('AKICK ' + ch + ' ADD ' + t + (akickReason.trim() ? ' ' + akickReason.trim() : ''));
            }, 'plus', pick('Ajouter', 'Add'));
            body.push(h('div', { className: 'ocs-block' }, akKids));
          }
          if (aopBan) {
            body.push(h('div', { className: 'ocs-block' }, [
              h('p', { className: 'ocs-h' }, pick('Bannir', 'Ban')),
              h(Field, { label: pick('Pseudo / masque', 'Nick / mask') },
                h(NickComplete, { chan: ch, value: banNick, onChange: setBanNick })
              ),
              h('input', {
                className: 'ocs-input',
                value: banExp,
                placeholder: pick('Expiration optionnelle (+1h, +1d…)', 'Optional expiry (+1h, +1d…)'),
                onChange: function (e) { setBanExp(e.target.value); },
              }),
              h('input', {
                className: 'ocs-input',
                value: banReason,
                placeholder: pick('Raison (optionnel)', 'Reason (optional)'),
                onChange: function (e) { setBanReason(e.target.value); },
              }),
              h('div', { className: 'ocs-row' },
                h('button', {
                  type: 'button', className: 'ocs-btn ocs-btn--primary',
                  onClick: function () {
                    var t = banNick.trim();
                    if (!t) return;
                    var exp = banExp.trim();
                    if (exp && exp.charAt(0) !== '+') exp = '+' + exp;
                    var why = banReason.trim() || defaultKickReason();
                    goCs('BAN ' + ch + (exp ? ' ' + exp : '') + ' ' + t + ' ' + why);
                  },
                }, labeled('ban', pick('Bannir', 'Ban'))),
                h('button', { type: 'button', className: 'ocs-btn', onClick: function () { csMode('CLEAR', 'bans'); } },
                  labeled('unassign', pick('Vider les bans', 'Clear bans')))
              ),
            ]));
          }
          if (can(ACCESS_RANK.sop)) {
            var btOpts = banTypeOptions();
            var btCur = btOpts.filter(function (o) { return o.id === banType; })[0] || btOpts[2];
            body.push(h('div', { className: 'ocs-block' }, [
              h('p', { className: 'ocs-h' }, pick('Type de Ban', 'Ban type')),
              h('p', { className: 'ocs-sub' }, pick(
                'Masque utilisé par ChanServ quand il pose un ban (BAN, AKICK…). Plus le numéro est élevé, plus le ban est large.',
                'Mask ChanServ uses when placing a ban (BAN, AKICK…). Higher numbers are wider.'
              )),
              h('select', { className: 'ocs-select', value: banType || '2', onChange: function (e) { setBanType(e.target.value); } },
                btOpts.map(function (o) {
                  return h('option', { key: o.id, value: o.id }, o.id + ' — ' + o.mask);
                })
              ),
              h('p', { className: 'ocs-sub' }, btCur ? (btCur.id + ' : ' + btCur.mask + ' — ' + btCur.tip) : ''),
              h('button', {
                type: 'button',
                className: 'ocs-btn ocs-btn--primary',
                onClick: function () {
                  if (banType) csSet('BANTYPE', banType);
                },
              }, labeled('check', pick('Enregistrer', 'Save'))),
            ]));
          }
          body.push(h('div', { className: 'ocs-block' }, [
            h('p', { className: 'ocs-h' }, pick('Unban', 'Unban')),
            h('p', { className: 'ocs-sub' }, pick(
              'Sans pseudo : retire tes propres bans. Avec un pseudo : les bans qui l’empêchent d’entrer.',
              'Empty nick: remove bans that affect you. With a nick: bans blocking that user.'
            )),
            h(Field, { label: pick('Pseudo (optionnel)', 'Nick (optional)') },
              h(NickComplete, { chan: ch, value: unbanNick, onChange: setUnbanNick })
            ),
            h('button', {
              type: 'button', className: 'ocs-btn ocs-btn--primary',
              onClick: function () {
                goCs('UNBAN ' + ch + (unbanNick.trim() ? ' ' + unbanNick.trim() : ''));
              },
            }, labeled('unlock', unbanNick.trim() ? pick('Unban', 'Unban') : pick('Unban (toi)', 'Unban (you)'))),
          ]));
        }

        if (tab === 'access' && showAccess) {
          var accLabels = {
            QOP: pick('QOP — Propriétaire (~)', 'QOP — Owner (~)'),
            SOP: pick('SOP — Administrateur (&)', 'SOP — Admin (&)'),
            AOP: pick('AOP — Opérateur (@)', 'AOP — Operator (@)'),
            HOP: pick('HOP — HalfOp (%)', 'HOP — HalfOp (%)'),
            VOP: pick('VOP — Voice (+)', 'VOP — Voice (+)'),
            ACCESS: pick('ACCESS (niveaux)', 'ACCESS (levels)'),
            FLAGS: 'FLAGS',
          };
          var accAddLvls = xopLevelsICanManage();
          var accPick = accAddLvls.indexOf(accLvl) >= 0 ? accLvl : (accAddLvls[0] || 'VOP');
          var accList = [
            h('p', { className: 'ocs-h' }, pick('Liste des accès', 'Access list')),
          ];
          if (s.accessLoading) {
            accList.push(h('p', { className: 'ocs-sub' }, pick('Chargement de la liste…', 'Loading list…')));
          } else {
            var rows = (s.accessList || []).slice().sort(function (a, b) {
              return accessTypeSort(a) - accessTypeSort(b);
            });
            if (!rows.length) {
              accList.push(h('p', { className: 'ocs-sub' }, pick('Aucun accès.', 'No access entries yet.')));
            } else {
              accList.push(h('div', { className: 'ocs-acclip' }, rows.map(function (row) {
                var canDrop = canManageAccessRow(row);
                return h('div', { key: (row.n || '') + row.nick + row.level, className: 'ocs-acc__row' },
                  h('span', { className: 'ocs-acc__nick' }, row.nick),
                  h('span', { className: 'ocs-pill ocs-acc__type', title: String(row.system || '') }, accessTypeLabel(row)),
                  canDrop ? h('button', {
                    type: 'button', className: 'ocs-btn',
                    onClick: function () {
                      var sys = String(row.system || '').toUpperCase();
                      var rlv = String(row.level || '').toUpperCase();
                      if (sys === 'FLAGS' || isFlagToken(row.level)) {
                        goCs('FLAGS ' + ch + ' ' + row.nick + ' -*');
                      } else if (sys === 'XOP' || isXopName(rlv)) {
                        goCs((rlv === 'FOUNDER' ? 'QOP' : rlv) + ' ' + ch + ' DEL ' + row.nick);
                      } else {
                        goCs('ACCESS ' + ch + ' DEL ' + (row.n || row.nick));
                      }
                    },
                  }, pick('Retirer', 'Remove')) : null
                );
              })));
            }
          }
          accList.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryAccess(ch, true); } },
              labeled('list', pick('Actualiser la liste', 'Refresh list')))
          ));
          body.push(h('div', { className: 'ocs-block' }, accList));
          if (accAddLvls.length) {
          body.push(h('div', { className: 'ocs-block' }, [
            h('p', { className: 'ocs-h' }, pick('Ajouter un accès', 'Add access')),
            h('select', { className: 'ocs-select', value: accPick, onChange: function (e) { setAccLvl(e.target.value); } },
              accAddLvls.map(function (lv) { return h('option', { key: lv, value: lv }, accLabels[lv] || lv); })
            ),
            h(Field, { label: pick('Compte / pseudo', 'Account / nick') },
              h(NickComplete, { chan: ch, value: accNick, onChange: setAccNick })
            ),
            h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
                if (accNick.trim()) goCs(accPick + ' ' + ch + ' ADD ' + accNick.trim());
              } }, labeled('assign', pick('Ajouter', 'Add'))),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (accNick.trim()) goCs(accPick + ' ' + ch + ' DEL ' + accNick.trim());
              } }, labeled('unassign', pick('Retirer', 'Remove')))
            ),
          ]));
          }
        }

        if (tab === 'set' && showSet) {
          var setOn = parseChanOptions(s.infoText);
          var setGroups = [
            { id: 'sec', label: pick('Sécurité', 'Security'), rows: [
              ['SECUREOPS', pick('Sécurité opérateurs', 'Operator security')],
              ['SECUREFOUNDER', pick('Sécurité fondateur', 'Secure founder')],
              ['RESTRICTED', pick('Accès restreint', 'Restricted access')],
              ['PRIVATE', pick('Accès privé', 'Private access')],
              ['SIGNKICK', pick('Kick signé', 'Signed kick')],
            ] },
            { id: 'mod', label: pick('Modération', 'Moderation') },
            { id: 'other', label: pick('Autres', 'Other'), rows: [
              ['AUTOOP', pick('Auto Op', 'Auto Op')],
              ['PEACE', pick('Paix', 'Peace')],
              ['PERSIST', pick('Persistant', 'Persistent')],
              ['KEEPMODES', pick('Maintien des modes', 'Keep modes')],
              ['CHANSTATS', pick('Statistiques salon', 'Channel stats')],
              ['FANTASY', pick('Commandes fantaisies ( ! )', 'Fantasy commands ( ! )'), 'bs'],
            ] },
          ];
          var sg = setGroup;
          if (!setGroups.some(function (g) { return g.id === sg; })) sg = 'sec';
          var setKids = [
            h('p', { className: 'ocs-h' }, pick('Paramètres du salon', 'Channel settings')),
            subTabs(sg, setSetGroup, setGroups.map(function (g) {
              return { id: g.id, label: g.label };
            })),
          ];
          var frameKids = [];
          setGroups.forEach(function (g) {
            if (g.id !== sg) return;
            if (g.id === 'mod') {
              frameKids.push(h('p', { className: 'ocs-h' }, pick('Kick automatique', 'Automatic kicks')));
              botKickerDefs().forEach(function (row) {
                var on = parseBotFlag(s.botInfo, row[2]);
                frameKids.push(h('div', { className: 'ocs-setrow' + (on ? ' is-on' : ''), key: row[0] },
                  h('span', { className: 'ocs-label' }, row[1]),
                  h(OnOffSwitch, {
                    on: on,
                    label: row[1],
                    onClick: function () {
                      goBs('KICK ' + row[0] + ' ' + ch + ' ' + (on ? 'OFF' : 'ON'));
                    },
                  })
                ));
              });
              frameKids.push(h('hr', { className: 'ocs-sep' }));
              frameKids.push(h(Field, { label: pick('Mot interdit (BADWORDS)', 'Forbidden word (BADWORDS)') },
                h('input', { className: 'ocs-input', value: botWord, onChange: function (e) { setBotWord(e.target.value); } })
              ));
              frameKids.push(subTabs(bwType, setBwType, [
                { id: 'ANY', label: 'ANY' },
                { id: 'SINGLE', label: 'SINGLE' },
                { id: 'START', label: 'START' },
                { id: 'END', label: 'END' },
              ]));
              frameKids.push(h('p', { className: 'ocs-sub' }, pick(
                'ANY = le mot n’importe où, SINGLE = mot entier, START / END = début / fin du mot.',
                'ANY = anywhere, SINGLE = whole word, START / END = word start / end.'
              )));
              frameKids.push(h('div', { className: 'ocs-row' },
                h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
                  var w = botWord.trim();
                  if (!w) return;
                  goBs('BADWORDS ' + ch + ' ADD ' + w + (bwType && bwType !== 'ANY' ? ' ' + bwType : ''));
                } }, labeled('plus', pick('Ajouter', 'Add'))),
                h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                  var w = botWord.trim();
                  if (w) goBs('BADWORDS ' + ch + ' DEL ' + w);
                } }, labeled('novoice', pick('Retirer', 'Remove'))),
                h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryBadwords(ch); } },
                  labeled('list', pick('Liste', 'List'))),
                h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goBs('BADWORDS ' + ch + ' CLEAR'); } },
                  labeled('unassign', pick('Tout vider', 'Clear all')))
              ));
              if (!(s.badwords && s.badwords.length)) {
                frameKids.push(h('p', { className: 'ocs-sub' }, pick('Aucun mot interdit.', 'No forbidden words.')));
              } else {
                frameKids.push(h('div', { className: 'ocs-acc' },
                  h('div', { className: 'ocs-acc__g' },
                    [h('div', { className: 'ocs-acc__h' }, pick('Mots interdits', 'Forbidden words'))].concat(s.badwords.map(function (row) {
                      return h('div', { key: row.n, className: 'ocs-acc__row' },
                        h('span', { className: 'ocs-acc__nick' }, row.n + '. ' + row.word),
                        h('span', { className: 'ocs-pill' }, row.type),
                        h('button', {
                          type: 'button', className: 'ocs-btn',
                          onClick: function () { goBs('BADWORDS ' + ch + ' DEL ' + row.n); },
                        }, pick('Retirer', 'Remove'))
                      );
                    }))
                  )
                ));
              }
              return;
            }
            (g.rows || []).forEach(function (row) {
              var viaBs = row[2] === 'bs';
              var on = viaBs ? parseBotFlag(s.botInfo, /fantaisie|fantasy/) : !!setOn[row[0]];
              frameKids.push(h('div', { className: 'ocs-setrow' + (on ? ' is-on' : ''), key: row[0] },
                h('span', { className: 'ocs-label' }, row[1]),
                h(OnOffSwitch, {
                  on: on,
                  label: row[1],
                  onClick: function () {
                    if (viaBs) goBs('SET ' + ch + ' ' + row[0] + ' ' + (on ? 'OFF' : 'ON'));
                    else csSet(row[0], on ? 'OFF' : 'ON');
                  },
                })
              ));
            });
          });
          setKids.push(h('div', { className: 'ocs-frame' }, frameKids));
          body.push(h('div', { className: 'ocs-block' }, setKids));
          var infoKinds = [
            { id: 'DESC', label: pick('Description', 'Description') },
            { id: 'URL', label: pick('Site internet', 'Website') },
            { id: 'EMAIL', label: pick('Adresse email', 'Email address') },
            { id: 'SUCCESSOR', label: pick('Successeur', 'Successor') },
          ];
          var infoKind = setInfoKind === 'BANTYPE' ? 'DESC' : setInfoKind;
          body.push(h('div', { className: 'ocs-block' }, [
            h('p', { className: 'ocs-h' }, pick('Information du salon', 'Channel information')),
            h('div', { className: 'ocs-frame' },
              h('select', { className: 'ocs-select', value: infoKind, onChange: function (e) { setSetInfoKind(e.target.value); } },
                infoKinds.map(function (it) { return h('option', { key: it.id, value: it.id }, it.label); })
              ),
              infoKind === 'DESC'
                ? h(AutoTextarea, {
                  className: 'ocs-input ocs-textarea',
                  rows: 4,
                  value: setText,
                  placeholder: pick('Écrire la description du salon…', 'Write the channel description…'),
                  onChange: function (e) { setSetText(e.target.value); },
                })
                : h('input', {
                  className: 'ocs-input',
                  value: setText,
                  placeholder: infoKind === 'URL'
                    ? 'https://…'
                    : infoKind === 'EMAIL'
                      ? pick('adresse@email…', 'email@address…')
                      : pick('Pseudo du successeur…', 'Successor nick…'),
                  onChange: function (e) { setSetText(e.target.value); },
                }),
              h('button', {
                type: 'button',
                className: 'ocs-btn ocs-btn--primary',
                onClick: function () {
                  var v = setText.trim();
                  if (infoKind === 'DESC') v = v.replace(/\s+/g, ' ');
                  if (v) csSet(infoKind, v);
                },
              }, labeled('check', pick('Enregistrer', 'Save')))
            ),
          ]));
        }

        if (tab === 'divers' && showDivers) {
          var assigned = channelBotNick(ch, s.bot);
          function block(kids) { return h('div', { className: 'ocs-block' }, kids); }
          var intro = [];
          if (!assigned) {
            intro.push(h('p', { className: 'ocs-sub' }, pick('Aucun bot assigné.', 'No bot assigned.')));
          }
          if (s.botInfo) {
            intro.push(h('div', { className: 'ocs-info' }, infoCardNodes(s.botInfo, /kicker|^options?$/, /informations?\s+a propos/)));
          }
          pushBtn(intro, '', function () { queryBotInfo(ch, { notify: true }); }, 'info', pick('Actualiser l’info bot', 'Refresh bot info'));
          body.push(block(intro));
          if (can(ACCESS_RANK.sop)) {
          var welcome = [
            h('p', { className: 'ocs-h' }, pick('Message d’accueil', 'Welcome message')),
            h('p', { className: 'ocs-sub' }, pick(
              'Notices envoyées à l’arrivée sur le salon (plusieurs possibles).',
              'Notices sent when someone joins (several allowed).'
            )),
          ];
          if (!(s.entryMsgs && s.entryMsgs.length)) {
            welcome.push(h('p', { className: 'ocs-sub' }, pick('Aucun message d’accueil.', 'No welcome messages.')));
          } else {
            welcome.push(h('div', { className: 'ocs-acc' },
              h('div', { className: 'ocs-acc__g' },
                [h('div', { className: 'ocs-acc__h' }, pick('Messages', 'Messages'))].concat(s.entryMsgs.map(function (row) {
                  return h('div', { key: row.n, className: 'ocs-acc__row' },
                    h('span', { className: 'ocs-acc__nick' }, row.n + '. ' + row.text),
                    h('button', {
                      type: 'button', className: 'ocs-btn',
                      onClick: function () { goCs('ENTRYMSG ' + ch + ' DEL ' + row.n); },
                    }, pick('Retirer', 'Remove'))
                  );
                }))
              )
            ));
          }
          welcome.push(h(Field, { label: pick('Nouveau message', 'New message') },
            h('input', { className: 'ocs-input', value: entryMsg, onChange: function (e) { setEntryMsg(e.target.value); } })
          ));
          welcome.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
              if (entryMsg.trim()) goCs('ENTRYMSG ' + ch + ' ADD ' + entryMsg.trim());
            } }, labeled('plus', pick('Ajouter', 'Add'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { queryEntryMsg(ch); } },
              labeled('list', pick('Actualiser', 'Refresh'))),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('ENTRYMSG ' + ch + ' CLEAR'); } },
              labeled('novoice', pick('Tout retirer', 'Clear all')))
          ));
          body.push(block(welcome));
          }
          var invite = [
            h(Field, { caps: true, label: pick('Inviter (vide = toi)', 'Invite (empty = you)') },
              h('input', { className: 'ocs-input', value: inviteNick, onChange: function (e) { setInviteNick(e.target.value); } })
            ),
          ];
          pushBtn(invite, 'primary', function () {
            goCs('INVITE ' + ch + (inviteNick.trim() ? ' ' + inviteNick.trim() : ''));
          }, 'assign', pick('Inviter', 'Invite'));
          body.push(block(invite));
          body.push(block([
            h(Field, { caps: true, label: pick('Faire parler le bot', 'Make the bot talk') },
              h('input', { className: 'ocs-input', value: botSay, onChange: function (e) { setBotSay(e.target.value); } })
            ),
            h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn ocs-btn--primary', onClick: function () {
                if (botSay.trim()) goBs('SAY ' + ch + ' ' + botSay.trim());
              } }, labeled('say', 'SAY')),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                if (botSay.trim()) goBs('ACT ' + ch + ' ' + botSay.trim());
              } }, labeled('act', 'ACT'))
            ),
          ]));
          var yt = [
            h('p', { className: 'ocs-h' }, 'YTSTATS'),
            h('p', { className: 'ocs-sub' }, pick(
              'Statistiques du module YouTube (liens, durées, kicks spam).',
              'YouTube module statistics (links, duration, spam kicks).'
            )),
            subTabs(ytKind, setYtKind, [
              { id: 'channel', label: pick('Salon', 'Channel') },
              { id: 'user', label: pick('Utilisateur', 'User') },
              { id: 'video', label: pick('Vidéo', 'Video') },
            ]),
            h(Field, {
              label: ytKind === 'video'
                ? pick('Identifiant vidéo', 'Video id')
                : ytKind === 'user'
                  ? pick('Pseudo', 'Nickname')
                  : pick('Salon (vide = ici)', 'Channel (empty = here)'),
            },
              h('input', {
                className: 'ocs-input',
                value: ytVal,
                placeholder: ytKind === 'channel' ? ch : '',
                onChange: function (e) { setYtVal(e.target.value); },
              })
            ),
            h('button', {
              type: 'button',
              className: 'ocs-btn ocs-btn--primary',
              onClick: function () {
                var v = ytVal.trim();
                var line = ytKind === 'video'
                  ? (v ? 'YTSTATS VIDEO ' + v : '')
                  : ytKind === 'user'
                    ? (v ? 'YTSTATS USER ' + v : '')
                    : 'YTSTATS CHANNEL ' + (v || ch);
                if (!line) return;
                beginExpect('ytstats', ch);
                patchUi({ lastCmd: 'BotServ ' + line, loading: true, flash: '', ytStats: '' });
                bs(line);
              },
            }, labeled('list', pick('Afficher', 'Show'))),
          ];
          if (s.ytStats) yt.push(h('div', { className: 'ocs-info' }, infoCardNodes(s.ytStats)));
          body.push(block(yt));
          body.push(block([
            h(Field, { caps: true, label: pick('Status d’un pseudo', 'Status for a nick') },
              h('input', { className: 'ocs-input', value: statusNick, onChange: function (e) { setStatusNick(e.target.value); } })
            ),
            h('div', { className: 'ocs-row' },
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
                goCs('STATUS ' + ch + (statusNick.trim() ? ' ' + statusNick.trim() : ''));
              } }, labeled('info', 'Status')),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('STATS ' + ch); } },
                labeled('list', 'Stats')),
              h('button', { type: 'button', className: 'ocs-btn', onClick: function () { goCs('TOP ' + ch); } },
                labeled('hash', 'Top'))
            ),
          ]));
          if (can(ACCESS_RANK.founder)) {
            var drop = [];
            pushBtn(drop, 'warn', function () { startDrop(ch); }, 'unassign', pick('Suppression du salon', 'Delete channel'));
            body.push(block(drop));
          }
        }
      }
      return h('div', { ref: panelRef, className: 'ocs-panel', role: 'dialog', 'aria-label': pick('Services du salon', 'Channel services') },
        h('div', { className: 'ocs-chrome' }, chrome),
        body.length ? h('div', { className: 'ocs-body' }, body) : null
      );
    }

    orbit.on('raw', onRaw);
    orbit.on('buffer.active', function (name) {
      if (!ui.open) return;
      if (foldText(name) !== foldText(ui.chan)) closePanel();
    });
    orbit.on('orbit:panel', function (id) {
      if (id !== 'orbit-chanserv' && ui.open) closePanel();
    });
    orbit.on('status', function (st) {
      if (st === 'registered') return;
      cache = {};
      pending = [];
      expectKind = '';
      if (expectTimer) { clearTimeout(expectTimer); expectTimer = 0; }
      patchUi({ open: false, registered: null, access: 'none', bot: '', bots: [], botInfo: '', ytStats: '', entryMsgs: [], badwords: [], topicHistory: [], akickList: [], loading: false, tab: 'info', accessList: [], reasonAsk: null, dropAsk: null });
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
    if (typeof orbit.addCommand === 'function') {
      function servSlash(service) {
        return {
          help: '/msg ' + service + ' …',
          run: function (_args, rest) {
            var line = String(rest || '').trim();
            if (line) orbit.irc.msg(service, line);
          },
        };
      }
      orbit.addCommand('cs', servSlash('ChanServ'));
      orbit.addCommand('chanserv', servSlash('ChanServ'));
      orbit.addCommand('bs', servSlash('BotServ'));
      orbit.addCommand('botserv', servSlash('BotServ'));
    }
    log('ChanServ/BotServ panel — topbar + overlay');
  });
})();
