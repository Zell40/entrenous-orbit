/*!
 * orbit-echecs — plateau d’échecs Orbit pour CapEchecs (EntreNous)
 * Reçoit +ec=v1 TAGMSG (état / coups) et envoie +ev=cmd (sans PRIVMSG).
 */
(function () {
  'use strict';

  var OEC_VER = 52;

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (retry < 80) setTimeout(function () { boot(retry + 1); }, 50);
      else console.error('[orbit-echecs] Orbit API unavailable after retries');
      return;
    }
    if (window.__ORBIT_ECHECS__ === OEC_VER) return;
    window.__ORBIT_ECHECS__ = OEC_VER;

  var EC = '+ec';
  var EV = '+ev';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-_0_1';
  var VIEW_FULL = 'full';
  var VIEW_SPLIT = 'split';
  var VIEW_CHAT = 'chat';
  var STORAGE_VIEW = 'oecViewMode';
  var STORAGE_PREMOVE = 'oecPremove';
  var STORAGE_ONBOARD = 'oecOnboarded';
  var pluginOrbit = null;
  var syncRequestAt = Object.create(null);
  var viewMode = VIEW_FULL;
  var viewListeners = new Set();

  var store = { byChannel: Object.create(null), rev: 0, listeners: new Set() };
  var ui = {
    sel: '', promo: null, drag: null, navPly: -1, settings: false, ccBusy: false,
    ccBusyChan: '', premoves: [], flushing: false, pendingMove: null, ccUser: '', enName: '',
    cmdBusy: '', cmdBusyVal: '',
    setup: { vs: 'ai', skill: 'moyen', tc: 'blitz', color: 'random', duo: 'open', invite: '' },
    tour: false,
  };
  var archiveGame = null;
  var ccBusyTimer = 0;
  var cmdBusyTimer = 0;
  var ccBootTimer = 0;
  var chatUnread = 0;
  var chatBadgeArmed = false;
  var HOME_IMG = '/app/plugins/third/orbit-echecs/assets/echecs-home.jpg';

  function subscribe(cb) { store.listeners.add(cb); return function () { store.listeners.delete(cb); }; }
  function bump() { store.rev++; store.listeners.forEach(function (l) { l(); }); }
  function subscribeView(cb) { viewListeners.add(cb); return function () { viewListeners.delete(cb); }; }
  function bumpView() { viewListeners.forEach(function (l) { l(); }); }

  function setCcBusy(on, ms, channel) {
    ui.ccBusy = !!on;
    if (channel) ui.ccBusyChan = channel;
    if (ccBusyTimer) {
      clearTimeout(ccBusyTimer);
      ccBusyTimer = 0;
    }
    if (on) {
      var ch = channel || ui.ccBusyChan;
      ccBusyTimer = setTimeout(function () {
        ccBusyTimer = 0;
        if (!ui.ccBusy) return;
        ui.ccBusy = false;
        if (ch) patchState(ch, { ccErr: 'Chess.com ne répond pas. Réessaie.' });
        else bump();
      }, Number(ms) > 0 ? Number(ms) : 20000);
    }
  }

  function clearCmdBusy() {
    if (cmdBusyTimer) {
      clearTimeout(cmdBusyTimer);
      cmdBusyTimer = 0;
    }
    ui.cmdBusy = '';
    ui.cmdBusyVal = '';
  }

  function setCmdBusy(act, ms, val) {
    ui.cmdBusy = act || '';
    ui.cmdBusyVal = val || '';
    if (cmdBusyTimer) {
      clearTimeout(cmdBusyTimer);
      cmdBusyTimer = 0;
    }
    if (act) {
      cmdBusyTimer = setTimeout(function () {
        cmdBusyTimer = 0;
        ui.cmdBusy = '';
        ui.cmdBusyVal = '';
        bump();
      }, Number(ms) > 0 ? Number(ms) : 12000);
    }
    bump();
  }

  function cmdBtn(act, label, waitLabel, extraClass) {
    var busy = ui.cmdBusy === act;
    var locked = !!ui.cmdBusy;
    return '<button type="button" class="oec-btn' + (extraClass ? ' ' + extraClass : '') +
      (busy ? ' is-wait' : '') + '" data-act="' + act + '"' +
      (locked ? ' disabled aria-busy="true"' : '') + '>' +
      (busy ? '<span class="oec-spin" aria-hidden="true"></span>' + (waitLabel || 'Chargement…') : label) +
      '</button>';
  }

  function pick(table) {
    if (pluginOrbit && pluginOrbit.i18n && pluginOrbit.i18n.pick) return pluginOrbit.i18n.pick(table);
    var lang = (document.documentElement.lang || 'fr').slice(0, 2);
    return table[lang] || table.fr || table.en || '';
  }

  function normChan(name) {
    var s = String(name || '').trim().toLowerCase();
    if (s && s.charAt(0) !== '#' && s.charAt(0) !== '&') s = '#' + s;
    return s;
  }

  function isChannelName(name) {
    var c = String(name || '').charAt(0);
    return c === '#' || c === '&';
  }

  function cfg(orbit) {
    var c = (orbit.config().echecs) || {};
    var channels = c.channels;
    if (!Array.isArray(channels) || !channels.length) channels = ['#Echecs.chat'];
    return {
      channels: channels.map(normChan),
      channelsAll: channels.some(function (ch) { return ch === '*'; }),
      showWhenIdle: c.showWhenIdle !== false,
    };
  }

  function resolveChannelName(orbit, keyOrName) {
    if (!keyOrName) return '';
    var st = orbit.state.get();
    if (st && st.buffers && st.buffers[keyOrName] && st.buffers[keyOrName].name) {
      return st.buffers[keyOrName].name;
    }
    return keyOrName;
  }

  function isChessChannel(orbit, channelKey) {
    if (!orbit || !channelKey) return false;
    var raw = String(resolveChannelName(orbit, channelKey) || channelKey).trim();
    if (!isChannelName(raw)) return false;
    var n = normChan(raw);
    var c = cfg(orbit);
    if (c.channelsAll) return true;
    return c.channels.indexOf(n) >= 0;
  }

  function isBouncerSession(orbit) {
    try {
      if (orbit.state.viaBouncer) return !!orbit.state.viaBouncer();
      return !!(orbit.state.get() || {}).viaBouncer;
    } catch (e) { return false; }
  }

  function tagVal(tags, name) {
    if (!tags) return '';
    if (Object.prototype.hasOwnProperty.call(tags, name)) return String(tags[name] || '');
    var alt = name.charAt(0) === '+' ? name.slice(1) : '+' + name;
    if (Object.prototype.hasOwnProperty.call(tags, alt)) return String(tags[alt] || '');
    return '';
  }

  function tagPly(tags, fallback) {
    var raw = tagVal(tags, '+ply');
    if (raw === '') return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  function escapeIrcTag(val) {
    return String(val || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/;/g, '\\:')
      .replace(/ /g, '\\s');
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  }

  function sendEcCmd(orbit, buffer, name, arg) {
    if (!orbit || !buffer || !name) return false;
    var target = resolveChannelName(orbit, buffer) || buffer;
    var tags = '+ec=v1;+ev=cmd;+name=' + escapeIrcTag(name);
    if (arg != null && String(arg) !== '') tags += ';+arg=' + escapeIrcTag(arg);
    try {
      if (orbit.irc && orbit.irc.send) {
        orbit.irc.send('@' + tags + ' TAGMSG ' + target);
        return true;
      }
    } catch (e) {
      console.error('[orbit-echecs] TAGMSG send failed', e);
    }
    return false;
  }

  function maybeRequestSync(orbit, buffer, game) {
    if (!orbit || !buffer || !isChessChannel(orbit, buffer)) return;
    if (game && game.status && game.status !== 'idle') return;
    var key = normChan(resolveChannelName(orbit, buffer) || buffer);
    var now = Date.now();
    if (syncRequestAt[key] && now - syncRequestAt[key] < 12000) return;
    syncRequestAt[key] = now;
    sendEcCmd(orbit, buffer, 'sync');
    armCcBoot(buffer);
  }

  function armCcBoot(channel) {
    if (ccBootTimer) return;
    var ch = channel;
    ccBootTimer = setTimeout(function () {
      ccBootTimer = 0;
      var g = getState(ch);
      if (!g.ccReady) {
        patchState(ch, { ccReady: true, ccPrompt: g.ccPrompt || 'missing', ccAsk: true });
      }
    }, 18000);
  }

  function finishCcBoot() {
    if (ccBootTimer) {
      clearTimeout(ccBootTimer);
      ccBootTimer = 0;
    }
  }

  function emptyPlayer() {
    return { nick: '', elo: '', games: '', cc: '', rapid: '', blitz: '', bullet: '', verified: false };
  }

  function parseRoster(raw) {
    var p = String(raw || '').split('|');
    return {
      nick: p[0] || '',
      elo: p[1] || '',
      games: p[2] || '',
      cc: p[3] || '',
      rapid: p[4] || '',
      blitz: p[5] || '',
      bullet: p[6] || '',
      verified: p[7] === '1',
    };
  }

  function emptyReview() {
    return {
      status: '', n: 0,
      cls: [], ev: [], bp: [], bs: [],
      accW: '', accB: '',
      wBl: 0, wMi: 0, wIn: 0, wEx: 0, wGd: 0, wBs: 0, wGr: 0, wBr: 0, wMs: 0,
      bBl: 0, bMi: 0, bIn: 0, bEx: 0, bGd: 0, bBs: 0, bGr: 0, bBr: 0, bMs: 0,
    };
  }

  function defaultState() {
    return {
      status: 'idle', mode: '', white: '', black: '', creator: '', invited: '',
      fen: START_FEN, turn: 'white', ply: 0, lastUci: '', lastSan: '',
      from: '', to: '', capW: '', capB: '', sans: '', ucis: '', waiting: false,
      result: '', reason: '', winner: '', flash: '', gid: '', updatedAt: 0,
      opening: '', openingVar: '', skill: '', tc: 'casual', clockW: 0, clockB: 0, clockInc: 0,
      clockAt: 0, rated: false, duration: 0, elo: '', eloGames: '', enName: '',
      enRapid: '', enBlitz: '', enBullet: '',
      enRapidBest: '', enBlitzBest: '', enBulletBest: '',
      enRapidRec: '', enBlitzRec: '', enBulletRec: '',
      chesscom: '', ccRapid: '', ccBlitz: '', ccBullet: '',
      ccRapidBest: '', ccBlitzBest: '', ccBulletBest: '',
      ccRapidRec: '', ccBlitzRec: '', ccBulletRec: '',
      ccLeague: '', ccTac: '', ccVerified: false,
      eloW: '', eloB: '', eloDw: '',
      ccAsk: false, ccName: '', ccTitle: '', ccCountry: '',
      ccPrompt: '', ccOptout: false, ccErr: '', ccReady: false, ccToken: '',
      pWhite: emptyPlayer(), pBlack: emptyPlayer(),
      review: emptyReview(),
      history: [],
    };
  }

  function chanKey(channel) {
    var name = channel;
    if (pluginOrbit) name = resolveChannelName(pluginOrbit, channel) || channel;
    return normChan(name);
  }

  function getState(channel) {
    return store.byChannel[chanKey(channel)] || defaultState();
  }

  function patchState(channel, patch) {
    var key = chanKey(channel);
    var prev = store.byChannel[key] || defaultState();
    store.byChannel[key] = Object.assign({}, prev, patch, { updatedAt: Date.now() });
    bump();
  }

  function parseFen(fenTag) {
    var fen = String(fenTag || START_FEN).replace(/_/g, ' ');
    var parts = fen.split(/\s+/);
    var placement = parts[0] || '8/8/8/8/8/8/8/8';
    var turn = (parts[1] || 'w').charAt(0) === 'b' ? 'black' : 'white';
    var rows = placement.split('/');
    var grid = [];
    var r, f, k, ch;
    for (r = 0; r < 8; r++) grid[r] = [null, null, null, null, null, null, null, null];
    for (r = 0; r < rows.length && r < 8; r++) {
      var rank = 7 - r;
      f = 0;
      for (k = 0; k < rows[r].length && f < 8; k++) {
        ch = rows[r].charAt(k);
        if (ch >= '1' && ch <= '8') f += Number(ch);
        else { grid[rank][f] = ch; f++; }
      }
    }
    return { grid: grid, turn: turn, fen: fen };
  }

  function splitUcis(raw) {
    return String(raw || '').split(/[,\s]+/).filter(Boolean);
  }

  function sqRF(name) {
    return { f: 'abcdefgh'.indexOf(String(name || '').charAt(0)), r: Number(String(name || '').charAt(1)) - 1 };
  }

  function gridToFen(grid, turn, rights, ep) {
    var ranks = [];
    var r, f, empty, ch, row;
    for (r = 7; r >= 0; r--) {
      empty = 0;
      row = '';
      for (f = 0; f < 8; f++) {
        ch = grid[r][f];
        if (!ch) empty += 1;
        else {
          if (empty) { row += String(empty); empty = 0; }
          row += ch;
        }
      }
      if (empty) row += String(empty);
      ranks.push(row);
    }
    return ranks.join('/') + '_' + (turn === 'black' ? 'b' : 'w') + '_' +
      (rights || '-') + '_' + (ep || '-') + '_0_1';
  }

  function dropCastle(rights, gone) {
    var next = String(rights || '');
    gone.split('').forEach(function (ch) { next = next.replace(ch, ''); });
    return next || '-';
  }

  function applyUciFen(fenTag, uci) {
    var fen = String(fenTag || START_FEN).replace(/_/g, ' ');
    var parts = fen.split(/\s+/);
    var parsed = parseFen(fenTag);
    var grid = parsed.grid.map(function (row) { return row.slice(); });
    uci = String(uci || '').toLowerCase();
    if (uci.length < 4) return fenTag;
    var from = sqRF(uci.slice(0, 2));
    var to = sqRF(uci.slice(2, 4));
    var promo = uci.charAt(4);
    if (from.f < 0 || to.f < 0 || from.r < 0 || to.r < 0) return fenTag;
    var piece = grid[from.r][from.f];
    if (!piece) return fenTag;
    var dest = grid[to.r][to.f];
    var rights = parts[2] || 'KQkq';
    var newEp = '-';
    if (piece.toLowerCase() === 'k' && Math.abs(to.f - from.f) === 2) {
      if (to.f === 6) { grid[to.r][5] = grid[to.r][7]; grid[to.r][7] = null; }
      else if (to.f === 2) { grid[to.r][3] = grid[to.r][0]; grid[to.r][0] = null; }
    }
    if (piece === 'K') rights = dropCastle(rights, 'KQ');
    if (piece === 'k') rights = dropCastle(rights, 'kq');
    if (uci.slice(0, 2) === 'a1' || uci.slice(2, 4) === 'a1') rights = dropCastle(rights, 'Q');
    if (uci.slice(0, 2) === 'h1' || uci.slice(2, 4) === 'h1') rights = dropCastle(rights, 'K');
    if (uci.slice(0, 2) === 'a8' || uci.slice(2, 4) === 'a8') rights = dropCastle(rights, 'q');
    if (uci.slice(0, 2) === 'h8' || uci.slice(2, 4) === 'h8') rights = dropCastle(rights, 'k');
    if (piece.toLowerCase() === 'p' && from.f !== to.f && !dest) {
      grid[from.r][to.f] = null;
    }
    if (piece.toLowerCase() === 'p' && Math.abs(to.r - from.r) === 2) {
      newEp = sqName(from.f, (from.r + to.r) / 2);
    }
    grid[from.r][from.f] = null;
    if (promo) {
      var up = piece === piece.toUpperCase();
      piece = up ? promo.toUpperCase() : promo.toLowerCase();
    }
    grid[to.r][to.f] = piece;
    return gridToFen(grid, parsed.turn === 'white' ? 'black' : 'white', rights, newEp);
  }

  function fenAtPly(game, ply) {
    var ucis = splitUcis(game.ucis);
    var n = ply < 0 ? ucis.length : Math.min(ply, ucis.length);
    var fen = START_FEN;
    var i;
    for (i = 0; i < n; i++) fen = applyUciFen(fen, ucis[i]);
    return fen;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function liveClock(game, color) {
    var base = Number(color === 'white' ? game.clockW : game.clockB) || 0;
    if (game._archive) return '';
    if (!game.tc || game.tc === 'casual') return '∞';
    var extra = 0;
    if (game.status === 'playing' && game.turn === color && Number(game.clockAt)) {
      extra = (Date.now() / 1000) - Number(game.clockAt);
    }
    return fmtClock(base - extra);
  }

  function startArg() {
    var s = ui.setup || {};
    var parts = [];
    if (s.vs === 'duo') {
      var invite = String(s.invite || '').trim();
      if (s.duo === 'friend' && invite) parts.push(invite);
      else parts.push('duo');
    } else {
      if (s.skill) parts.push(s.skill);
      if (s.color === 'white') parts.push('blancs');
      if (s.color === 'black') parts.push('noirs');
    }
    if (s.tc && s.tc !== 'casual') parts.push(s.tc);
    return parts.join(' ');
  }

  function tcLabel(tc) {
    return ({
      casual: 'Illimité',
      bullet: 'Bullet 1+0',
      blitz: 'Blitz 3+2',
      rapide: 'Rapide 10+0',
      rapide15: 'Rapide 15+10',
      classique: 'Rapide 15+10',
    })[tc] || tc || '';
  }

  function sqName(file, rank) {
    return 'abcdefgh'.charAt(file) + String(rank + 1);
  }

  function pieceColor(ch) {
    if (!ch) return '';
    return ch === ch.toUpperCase() ? 'white' : 'black';
  }

  function myNick(orbit) {
    return String((orbit && orbit.state && orbit.state.nick && orbit.state.nick()) || '').toLowerCase();
  }

  var SERVICE_NICKS = {
    capechecs: 1, jeuechecs: 1, petitbac: 1, bac: 1, maitredujeu: 1,
    choixpeau: 1, harrypotter: 1, aidemoi: 1, signalmoi: 1,
    botserv: 1, chanserv: 1, nickserv: 1, hostserv: 1, operserv: 1,
    memoserv: 1, helpserv: 1, statserv: 1, gameserv: 1, global: 1, alis: 1,
  };

  function isServiceNick(nick) {
    var n = String(nick || '').toLowerCase().replace(/^[@+%~&]/, '');
    if (!n) return false;
    if (SERVICE_NICKS[n]) return true;
    return n.length > 4 && n.slice(-4) === 'serv';
  }

  function memberIsBot(m) {
    return !!(m && (m.bot || m.isBot));
  }

  function configBotNicks(orbit) {
    var out = Object.create(null);
    try {
      var all = (orbit && orbit.config && orbit.config()) || {};
      ['echecs', 'petitbac', 'harrypotter'].forEach(function (key) {
        var arr = (all[key] || {}).botNicks;
        if (!Array.isArray(arr)) return;
        arr.forEach(function (n) {
          var low = String(n || '').toLowerCase();
          if (low) out[low] = 1;
        });
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function nickIsBot(orbit, nick, member) {
    var n = String(nick || '').toLowerCase().replace(/^[@+%~&]/, '');
    if (!n || isServiceNick(n) || memberIsBot(member)) return true;
    if (configBotNicks(orbit)[n]) return true;
    var st = (orbit && orbit.state && orbit.state.get && orbit.state.get()) || {};
    var buffers = st.buffers || {};
    var keys = Object.keys(buffers);
    for (var i = 0; i < keys.length; i++) {
      var members = (buffers[keys[i]] && buffers[keys[i]].members) || {};
      var direct = members[nick] || members[n];
      if (memberIsBot(direct)) return true;
      var mkeys = Object.keys(members);
      for (var j = 0; j < mkeys.length; j++) {
        var m = members[mkeys[j]];
        var mn = String((m && m.nick) || mkeys[j]).replace(/^[@+%~&]/, '').toLowerCase();
        if (mn === n && memberIsBot(m)) return true;
      }
    }
    return false;
  }

  function findIrcBuffer(orbit, bufferKey) {
    var st = (orbit && orbit.state && orbit.state.get && orbit.state.get()) || {};
    var buffers = st.buffers || {};
    if (buffers[bufferKey]) return buffers[bufferKey];
    var want = normChan(resolveChannelName(orbit, bufferKey) || bufferKey);
    var keys = Object.keys(buffers);
    for (var i = 0; i < keys.length; i++) {
      var b = buffers[keys[i]];
      if (b && normChan(b.name || keys[i]) === want) return b;
    }
    return null;
  }

  function inviteCandidates(orbit, bufferKey) {
    var me = myNick(orbit);
    var st = (orbit && orbit.state && orbit.state.get && orbit.state.get()) || {};
    var byLow = Object.create(null);
    function add(nick, flags, member) {
      var raw = String(nick || '').replace(/^[@+%~&]/, '').trim();
      if (!raw) return;
      var low = raw.toLowerCase();
      if (!low || low === me || nickIsBot(orbit, raw, member)) return;
      var cur = byLow[low];
      if (!cur) {
        byLow[low] = { nick: raw, inChan: !!flags.inChan, friend: !!flags.friend };
        return;
      }
      if (flags.inChan) { cur.inChan = true; cur.nick = raw; }
      if (flags.friend) cur.friend = true;
    }
    var buf = findIrcBuffer(orbit, bufferKey);
    var members = (buf && buf.members) || {};
    Object.keys(members).forEach(function (k) {
      var m = members[k];
      add((m && m.nick) || k, { inChan: true }, m);
    });
    (st.friends || []).forEach(function (n) { add(n, { friend: true }); });
    var list = Object.keys(byLow).map(function (k) { return byLow[k]; });
    list.sort(function (a, b) {
      if (a.inChan !== b.inChan) return a.inChan ? -1 : 1;
      if (a.friend !== b.friend) return a.friend ? -1 : 1;
      return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase(), 'fr');
    });
    return list;
  }

  function applyInviteFilter(root) {
    if (!root) return;
    var input = root.querySelector('#oec-invite');
    var list = root.querySelector('#oec-invite-list');
    if (!input || !list) return;
    var q = String(input.value || '').trim().toLowerCase();
    var nicks = list.querySelectorAll('.oec-invite__nick');
    var shown = 0;
    for (var i = 0; i < nicks.length; i++) {
      var nick = String(nicks[i].getAttribute('data-val') || '').toLowerCase();
      var ok = !q || nick.indexOf(q) >= 0;
      nicks[i].classList.toggle('is-hide', !ok);
      nicks[i].classList.toggle('is-on', !!q && nick === q);
      if (ok) shown++;
    }
    var empty = list.querySelector('.oec-invite__empty');
    if (empty) {
      if (!nicks.length) empty.classList.remove('is-hide');
      else empty.classList.toggle('is-hide', shown > 0);
    }
  }

  function renderInvitePicker(orbit, buffer) {
    var q = String(ui.setup.invite || '');
    var rows = inviteCandidates(orbit, buffer);
    var html = '<div class="oec-invite">' +
      '<input id="oec-invite" type="text" maxlength="32" autocomplete="off" spellcheck="false" ' +
      'placeholder="Cherche un pseudo…" value="' + escHtml(q) + '">' +
      '<div class="oec-invite__list" id="oec-invite-list" role="listbox">';
    rows.forEach(function (row) {
      var tags = '';
      if (row.inChan) tags += '<span class="oec-invite__tag">salon</span>';
      if (row.friend) tags += '<span class="oec-invite__tag oec-invite__tag--ami">ami</span>';
      html += '<button type="button" class="oec-invite__nick" data-act="invite-pick" data-val="' +
        escHtml(row.nick) + '" role="option"><b>' + escHtml(row.nick) + '</b>' + tags + '</button>';
    });
    html += '<p class="oec-invite__empty' + (rows.length ? ' is-hide' : '') + '">' +
      (rows.length
        ? 'Aucun résultat — tu peux quand même lancer avec ce pseudo.'
        : 'Personne d’autre dans le salon. Tape un pseudo.') +
      '</p></div></div>';
    return html;
  }

  function noteIncomingChat(orbit, msg) {
    if (!chatBadgeArmed) return;
    if (getViewMode(orbit) !== VIEW_FULL) return;
    var target = (msg.params && msg.params[0]) || (msg.args && msg.args[0]) || '';
    if (!isChannelName(target) || !isChessChannel(orbit, target)) return;
    var nick = String(msg.nick || '').toLowerCase();
    if (!nick || nick === myNick(orbit) || isServiceNick(nick)) return;
    var text = String((msg.params && msg.params[1]) || (msg.args && msg.args[1]) || '');
    if (text.charAt(0) === '\x01' && text.indexOf('ACTION ') !== 0) return;
    chatUnread = Math.min(99, chatUnread + 1);
    bump();
  }

  function eventForMe(tags) {
    var who = String(tagVal(tags, '+nick') || '').toLowerCase();
    if (!who) return true;
    var me = myNick(pluginOrbit);
    return me && who === me;
  }

  function keepProfile(prev) {
    return {
      elo: prev.elo, eloGames: prev.eloGames, enName: prev.enName, chesscom: prev.chesscom,
      enRapid: prev.enRapid, enBlitz: prev.enBlitz, enBullet: prev.enBullet,
      enRapidBest: prev.enRapidBest, enBlitzBest: prev.enBlitzBest, enBulletBest: prev.enBulletBest,
      enRapidRec: prev.enRapidRec, enBlitzRec: prev.enBlitzRec, enBulletRec: prev.enBulletRec,
      ccRapid: prev.ccRapid, ccBlitz: prev.ccBlitz, ccBullet: prev.ccBullet,
      ccRapidBest: prev.ccRapidBest, ccBlitzBest: prev.ccBlitzBest, ccBulletBest: prev.ccBulletBest,
      ccRapidRec: prev.ccRapidRec, ccBlitzRec: prev.ccBlitzRec, ccBulletRec: prev.ccBulletRec,
      ccLeague: prev.ccLeague, ccTac: prev.ccTac,
      ccAsk: prev.ccAsk, ccName: prev.ccName, ccTitle: prev.ccTitle, ccCountry: prev.ccCountry,
      ccPrompt: prev.ccPrompt, ccOptout: prev.ccOptout, ccErr: prev.ccErr, ccReady: prev.ccReady,
      ccVerified: prev.ccVerified,
      history: prev.history || [],
    };
  }

  function ccFieldsFromTags(tags, prev, keep) {
    function one(tag, key) {
      if (!keep) return '';
      return tagVal(tags, tag) || prev[key] || '';
    }
    return {
      chesscom: keep ? (tagVal(tags, '+chesscom') || prev.chesscom || '') : '',
      ccName: one('+cc-name', 'ccName'),
      ccTitle: one('+cc-title', 'ccTitle'),
      ccCountry: one('+cc-country', 'ccCountry'),
      ccLeague: one('+cc-league', 'ccLeague'),
      ccTac: one('+cc-tac', 'ccTac'),
      ccRapid: one('+cc-rapid', 'ccRapid'),
      ccBlitz: one('+cc-blitz', 'ccBlitz'),
      ccBullet: one('+cc-bullet', 'ccBullet'),
      ccRapidBest: one('+cc-rapid-best', 'ccRapidBest'),
      ccBlitzBest: one('+cc-blitz-best', 'ccBlitzBest'),
      ccBulletBest: one('+cc-bullet-best', 'ccBulletBest'),
      ccRapidRec: one('+cc-rapid-rec', 'ccRapidRec'),
      ccBlitzRec: one('+cc-blitz-rec', 'ccBlitzRec'),
      ccBulletRec: one('+cc-bullet-rec', 'ccBulletRec'),
      ccVerified: (function () {
        if (!keep) return false;
        var raw = tagVal(tags, '+cc-verified');
        if (raw !== '') return raw === '1';
        return prev.ccVerified === true || prev.ccVerified === '1';
      }()),
    };
  }

  function isCcVerified(obj) {
    var v = obj && (obj.ccVerified !== undefined ? obj.ccVerified : obj.verified);
    return v === true || v === 1 || v === '1';
  }

  function ccVerifyBadge(verified, prompt) {
    if (prompt === 'preview' || prompt === 'found') {
      return '<span class="oec-vbadge oec-vbadge--wait">À confirmer</span>';
    }
    if (prompt === 'verify') {
      return '<span class="oec-vbadge oec-vbadge--wait">Preuve en cours</span>';
    }
    if (verified) {
      return '<span class="oec-vbadge oec-vbadge--ok">✓ Vérifié</span>';
    }
    return '<span class="oec-vbadge oec-vbadge--no">Non vérifié</span>';
  }

  function fmtRec(rec) {
    var parts = String(rec || '').split('-');
    if (parts.length < 3) return '';
    return parts[0] + ' V · ' + parts[1] + ' D · ' + parts[2] + ' N';
  }

  function ccStatCell(label, last, best, rec, loading) {
    if (loading) {
      return '<div class="oec-cc__stat is-empty"><span>' + label + '</span><b>—</b></div>';
    }
    if (!last && !best) {
      return '<div class="oec-cc__stat is-empty"><span>' + label + '</span><b>—</b><i>non classé</i></div>';
    }
    return '<div class="oec-cc__stat"><span>' + label + '</span><b>' + escHtml(last || '—') + '</b>' +
      (best ? '<i>max ' + escHtml(best) + '</i>' : '') +
      (rec ? '<i>' + escHtml(fmtRec(rec)) + '</i>' : '') + '</div>';
  }

  function ccHandle(game) {
    var user = String(game.chesscom || '').trim();
    var name = String(game.ccName || '').trim();
    var title = String(game.ccTitle || '').trim();
    var ident = (title ? escHtml(title) + ' ' : '') + (user ? escHtml(user) : escHtml(name));
    var same = name && user && name.toLowerCase() === user.toLowerCase();
    var real = (!same && name) ? '<span class="oec-cc__real">' + escHtml(name) + '</span>' : '';
    var meta = [game.ccCountry, game.ccLeague].filter(Boolean).join(' · ');
    var badge = user ? ccVerifyBadge(isCcVerified(game), game.ccPrompt) : '';
    return '<div class="oec-cc__id">' +
      '<p class="oec-cc__user">' + ident + (badge ? ' ' + badge : '') + '</p>' + real +
      (meta ? '<span class="oec-cc__meta">' + escHtml(meta) + '</span>' : '') +
      '</div>';
  }

  function ccStatsGrid(game, loading) {
    var inner = '<div class="oec-cc__stats">' +
      ccStatCell('Rapide', game.ccRapid, game.ccRapidBest, game.ccRapidRec, loading) +
      ccStatCell('Blitz', game.ccBlitz, game.ccBlitzBest, game.ccBlitzRec, loading) +
      ccStatCell('Bullet', game.ccBullet, game.ccBulletBest, game.ccBulletRec, loading) +
      '</div>';
    if (loading) {
      return '<div class="oec-cc__box is-loading">' + inner +
        '<div class="oec-cc__spinner" role="status"><span class="oec-spin"></span> Chargement des stats…</div>' +
        '</div>';
    }
    return inner +
      (game.ccTac ? '<p class="oec-cc__more">Puzzles <b>' + escHtml(game.ccTac) + '</b></p>' : '') +
      (game.chesscom
        ? '<a class="oec-cc__link" href="https://www.chess.com/member/' +
          encodeURIComponent(game.chesscom) + '" target="_blank" rel="noopener">Profil Chess.com</a>'
        : '');
  }

  function iAm(orbit, game, color) {
    var nick = myNick(orbit);
    var who = String((game && game[color]) || '').toLowerCase();
    return nick && who && nick === who;
  }

  function myColor(orbit, game) {
    if (iAm(orbit, game, 'white')) return 'white';
    if (iAm(orbit, game, 'black')) return 'black';
    return '';
  }

  function isPlaying(game) {
    return game && (game.status === 'playing' || game.status === 'waiting');
  }

  function premoveOn(orbit) {
    try {
      if (orbit) return orbit.storage.get(STORAGE_PREMOVE, '1') !== '0';
    } catch (e) { /* ignore */ }
    return true;
  }

  function setPremoveOn(orbit, on) {
    try { if (orbit) orbit.storage.set(STORAGE_PREMOVE, on ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!on) ui.premoves = [];
    bump();
  }

  function clearPremoves() {
    if (!ui.premoves.length && !ui.flushing) return;
    ui.premoves = [];
    ui.flushing = false;
    ui.sel = '';
  }

  function pieceAt(fen, name) {
    var parsed = parseFen(fen);
    var f = 'abcdefgh'.indexOf(String(name || '').charAt(0));
    var r = Number(String(name || '').charAt(1)) - 1;
    if (f < 0 || r < 0 || r > 7) return null;
    return parsed.grid[r][f];
  }

  function premoveValid(game, pm, color) {
    if (!pm || !pm.from || !pm.to || pm.from === pm.to) return false;
    var piece = pieceAt(game.fen, pm.from);
    if (!piece || pieceColor(piece) !== color) return false;
    var dest = pieceAt(game.fen, pm.to);
    if (dest && pieceColor(dest) === color) return false;
    return true;
  }

  function queuePremove(from, to, promo) {
    var next = { from: from, to: to, promo: promo || '' };
    ui.premoves = ui.premoves.filter(function (pm) {
      return !(pm.from === from && pm.to === to);
    });
    ui.premoves.push(next);
    ui.sel = '';
    ui.promo = null;
    bump();
  }

  function cancelPremoveAt(name) {
    var before = ui.premoves.length;
    ui.premoves = ui.premoves.filter(function (pm) {
      return pm.from !== name && pm.to !== name;
    });
    if (ui.premoves.length !== before) bump();
    return ui.premoves.length !== before;
  }

  function maybeFlushPremove(channel) {
    if (!pluginOrbit || !premoveOn(pluginOrbit) || ui.flushing) return;
    if (!ui.premoves.length) return;
    var game = getState(channel);
    if (game.status !== 'playing') return;
    var color = myColor(pluginOrbit, game);
    if (!color || game.turn !== color) return;
    var pm = ui.premoves[0];
    if (!premoveValid(game, pm, color)) {
      ui.premoves = [];
      bump();
      return;
    }
    ui.premoves = ui.premoves.slice(1);
    ui.flushing = true;
    var uci = pm.from + pm.to + (pm.promo || '');
    sendEcCmd(pluginOrbit, channel, 'jouer', uci);
    bump();
  }

  function openingHtml(game) {
    var name = game.opening || '';
    var variant = game.openingVar || '';
    if (!name && !variant) return '';
    return escHtml(name) +
      (variant ? '<span class="oec-opening__var">' + escHtml(variant) + '</span>' : '');
  }

  function reasonFr(code) {
    var map = {
      mate: 'Échec et mat', stalemate: 'Pat', insufficient: 'Matériel insuffisant',
      fifty: 'Règle des 50 coups', threefold: 'Triple répétition', resign: 'Abandon',
      abort: 'Partie annulée', timeout: 'N’a pas rejoint', inactivity: 'Inactivité',
      agree: 'Nulle acceptée', quit: 'Déconnexion', part: 'Départ',
      flag: 'Temps écoulé', engine: 'Erreur moteur', crash: 'Erreur technique',
    };
    return map[code] || code || '';
  }

  function mergeMoveChunk(game, start, addU, addS) {
    var ucis = splitUcis(game.ucis);
    var sans = String(game.sans || '').split(',').filter(Boolean);
    (addU || []).forEach(function (uci, i) {
      ucis[start - 1 + i] = uci;
      if (addS && addS[i]) sans[start - 1 + i] = addS[i];
    });
    var lastU = ucis[ucis.length - 1] || '';
    var joined = ucis.filter(Boolean).join(',');
    var joinedS = sans.filter(Boolean).join(',');
    return {
      ucis: joined,
      sans: joinedS,
      ply: ucis.filter(Boolean).length,
      lastUci: lastU,
      lastSan: sans.filter(Boolean)[sans.filter(Boolean).length - 1] || game.lastSan || '',
      from: lastU.slice(0, 2),
      to: lastU.slice(2, 4),
    };
  }

  function parseHistoryRows(raw) {
    return String(raw || '').split(';').filter(Boolean).map(function (row) {
      var p = row.split('|');
      return {
        gid: p[0] || '',
        white: p[1] || '',
        black: p[2] || '',
        result: p[3] || '',
        tc: p[4] || '',
        at: Number(p[5] || 0),
        eloW: p[6] || '',
        eloB: p[7] || '',
      };
    }).filter(function (row) { return row.gid; });
  }

  function reviewSink(gid, prev) {
    if (archiveGame && (!gid || String(archiveGame.gid) === String(gid))) return 'archive';
    if (prev && (prev.status === 'ended' || prev.status === 'playing') && (!gid || !prev.gid || String(prev.gid) === String(gid))) return 'state';
    if (prev && prev.status === 'ended') return 'state';
    return '';
  }

  function putReview(channel, gid, prev, review) {
    var sink = reviewSink(gid, prev);
    if (sink === 'archive') {
      archiveGame = Object.assign({}, archiveGame, { review: review });
      bump();
      return;
    }
    if (sink === 'state') patchState(channel, { review: review });
  }

  function handleEvent(channel, tags) {
    if (tagVal(tags, EC) !== 'v1') return;
    var ev = tagVal(tags, EV);
    if (!ev || ev === 'cmd') return;
    if (ev === 'waiting' || ev === 'game_start' || ev === 'game_end' || ev === 'draw_offer') {
      clearCmdBusy();
    }
    var gid = tagVal(tags, '+gid');
    var prev = getState(channel);
    if (gid && prev.gid && gid !== prev.gid && ev !== 'game_end' && ev !== 'archive' && ev !== 'archive_moves' && ev !== 'review_start' && ev !== 'review_chunk' && ev !== 'review_done') {
      ui.sel = '';
      ui.promo = null;
    }

    if (ev === 'waiting') {
      archiveGame = null;
      ui.sel = '';
      ui.navPly = -1;
      clearPremoves();
      patchState(channel, {
        status: 'waiting', waiting: true, mode: tagVal(tags, '+mode') || 'pvp',
        creator: tagVal(tags, '+creator'), invited: tagVal(tags, '+invited'),
        gid: gid || prev.gid, result: '', reason: '', flash: '',
        tc: tagVal(tags, '+tc') || prev.tc,
      });
      return;
    }

    if (ev === 'roster') {
      patchState(channel, {
        pWhite: parseRoster(tagVal(tags, '+pw')),
        pBlack: parseRoster(tagVal(tags, '+pb')),
      });
      return;
    }

    if (ev === 'elo_sync') {
      if (!eventForMe(tags)) return;
      var eloPatch = {
        elo: tagVal(tags, '+elo') || prev.elo,
        eloGames: tagVal(tags, '+games') || prev.eloGames,
        enName: tagVal(tags, '+en-name'),
        enRapid: tagVal(tags, '+en-rapid'),
        enBlitz: tagVal(tags, '+en-blitz'),
        enBullet: tagVal(tags, '+en-bullet'),
        enRapidBest: tagVal(tags, '+en-rapid-best'),
        enBlitzBest: tagVal(tags, '+en-blitz-best'),
        enBulletBest: tagVal(tags, '+en-bullet-best'),
        enRapidRec: tagVal(tags, '+en-rapid-rec'),
        enBlitzRec: tagVal(tags, '+en-blitz-rec'),
        enBulletRec: tagVal(tags, '+en-bullet-rec'),
      };
      if (!prev.ccReady || ui.ccBusy || prev.ccPrompt === 'preview' || prev.ccPrompt === 'found' || prev.ccPrompt === 'verify') {
        patchState(channel, eloPatch);
        return;
      }
      var storedCc = tagVal(tags, '+chesscom');
      var opted = tagVal(tags, '+optout') === '1';
      if (opted) {
        finishCcBoot();
        patchState(channel, Object.assign(eloPatch, ccFieldsFromTags({}, prev, false), {
          ccOptout: true, ccAsk: false, ccPrompt: 'optout', ccReady: true,
        }));
        return;
      }
      if (storedCc) {
        finishCcBoot();
        patchState(channel, Object.assign(eloPatch, ccFieldsFromTags(tags, prev, true), {
          ccOptout: false, ccAsk: false, ccPrompt: 'linked', ccReady: true,
        }));
        return;
      }
      finishCcBoot();
      patchState(channel, Object.assign(eloPatch, {
        ccOptout: false,
        ccAsk: true,
        ccPrompt: prev.ccPrompt || 'missing',
        ccReady: true,
      }));
      return;
    }

    if (ev === 'cc_prompt') {
      if (!eventForMe(tags)) return;
      var mode = tagVal(tags, '+mode') || 'missing';
      if (mode === 'wait') {
        setCcBusy(true, 20000, channel);
        patchState(channel, { ccErr: '', flash: '' });
        return;
      }
      var previewUser = tagVal(tags, '+chesscom');
      var keepPreview = mode === 'preview' || mode === 'found' || mode === 'linked' || mode === 'verify';
      if (ui.ccBusy) setCcBusy(false);
      if (mode !== 'wait') finishCcBoot();
      patchState(channel, Object.assign({
        ccPrompt: mode === 'wait' ? prev.ccPrompt : mode,
        ccOptout: mode === 'optout',
        ccAsk: mode === 'missing' || mode === 'preview' || mode === 'found' || mode === 'verify',
        ccErr: mode === 'verify' ? (tagVal(tags, '+text') || '') : '',
        ccToken: mode === 'verify' ? (tagVal(tags, '+token') || prev.ccToken || '') : '',
        flash: '',
        ccReady: mode === 'wait' ? prev.ccReady : true,
      }, ccFieldsFromTags(tags, Object.assign({}, prev, { chesscom: previewUser || prev.chesscom }), keepPreview)));
      return;
    }

    if (ev === 'cc_err') {
      if (!eventForMe(tags)) return;
      if (ui.ccBusy) setCcBusy(false);
      finishCcBoot();
      patchState(channel, {
        ccErr: tagVal(tags, '+text') || 'Compte Chess.com introuvable',
        ccOptout: false,
        ccPrompt: prev.ccPrompt === 'preview' ? 'missing' : (prev.ccPrompt === 'optout' ? 'missing' : (prev.ccPrompt || 'missing')),
        ccAsk: true,
        ccReady: true,
      });
      return;
    }

    if (ev === 'cc_ask') {
      if (!eventForMe(tags)) return;
      finishCcBoot();
      patchState(channel, {
        ccAsk: true,
        ccPrompt: 'missing',
        ccReady: true,
        flash: tagVal(tags, '+text') || 'Indique ton pseudo Chess.com',
      });
      return;
    }

    if (ev === 'game_start' || ev === 'state_sync' || ev === 'move') {
      var fen = tagVal(tags, '+fen') || (ev === 'game_start' ? START_FEN : prev.fen);
      var parsed = parseFen(fen);
      var status = tagVal(tags, '+status') || (tagVal(tags, '+waiting') === '1' ? 'waiting' : 'playing');
      if (ev === 'game_start') { archiveGame = null; status = 'playing'; ui.navPly = -1; clearPremoves(); ui.pendingMove = null; }
      if (ev === 'move') {
        ui.sel = '';
        ui.promo = null;
        ui.navPly = -1;
        ui.flushing = false;
        ui.pendingMove = null;
      }
      patchState(channel, {
        status: status,
        waiting: tagVal(tags, '+waiting') === '1' || status === 'waiting',
        mode: tagVal(tags, '+mode') || prev.mode,
        white: tagVal(tags, '+white') || prev.white,
        black: tagVal(tags, '+black') || prev.black,
        creator: tagVal(tags, '+creator') || prev.creator,
        invited: tagVal(tags, '+invited') || prev.invited,
        fen: fen,
        turn: tagVal(tags, '+turn') || parsed.turn,
        ply: tagPly(tags, ev === 'game_start' ? 0 : prev.ply),
        lastUci: tagVal(tags, '+uci') || tagVal(tags, '+last-uci') || prev.lastUci,
        lastSan: tagVal(tags, '+san-fr') || tagVal(tags, '+last-san-fr') || prev.lastSan,
        from: tagVal(tags, '+from') || prev.from,
        to: tagVal(tags, '+to') || prev.to,
        capW: tagVal(tags, '+cap-w') || prev.capW,
        capB: tagVal(tags, '+cap-b') || prev.capB,
        sans: tagVal(tags, '+sans') || (ev === 'move' && tagVal(tags, '+san-fr')
          ? (prev.sans ? prev.sans + ',' + tagVal(tags, '+san-fr') : tagVal(tags, '+san-fr'))
          : prev.sans),
        ucis: tagVal(tags, '+ucis') || (ev === 'move' && tagVal(tags, '+uci')
          ? (prev.ucis ? prev.ucis + ',' + tagVal(tags, '+uci') : tagVal(tags, '+uci'))
          : prev.ucis),
        opening: tagVal(tags, '+opening') || prev.opening,
        openingVar: tagVal(tags, '+opening') ? tagVal(tags, '+opening-var') : prev.openingVar,
        skill: tagVal(tags, '+skill') || prev.skill,
        tc: tagVal(tags, '+tc') || prev.tc,
        clockW: tagVal(tags, '+clock-w') !== '' ? Number(tagVal(tags, '+clock-w')) : prev.clockW,
        clockB: tagVal(tags, '+clock-b') !== '' ? Number(tagVal(tags, '+clock-b')) : prev.clockB,
        clockInc: tagVal(tags, '+clock-inc') !== '' ? Number(tagVal(tags, '+clock-inc')) : prev.clockInc,
        clockAt: tagVal(tags, '+clock-at') !== '' ? Number(tagVal(tags, '+clock-at')) : prev.clockAt,
        rated: tagVal(tags, '+rated') === '1' || prev.rated,
        gid: gid || prev.gid,
        result: '',
        flash: ev === 'move' ? '' : prev.flash,
        review: ev === 'game_start' ? emptyReview() : prev.review,
      });
      maybeFlushPremove(channel);
      return;
    }

    if (ev === 'illegal') {
      ui.sel = '';
      ui.promo = null;
      clearPremoves();
      var why = tagVal(tags, '+reason');
      var flash = ({
        illegal: 'Coup illégal', 'not-turn': 'Ce n’est pas votre tour',
        waiting: 'En attente d’un adversaire', 'no-game': 'Aucune partie en cours',
      }[why] || 'Coup refusé');
      if (ui.pendingMove) {
        var back = ui.pendingMove;
        ui.pendingMove = null;
        patchState(channel, {
          fen: back.prevFen,
          turn: back.turn,
          from: back.prevFrom || '',
          to: back.prevTo || '',
          lastUci: back.prevUci || '',
          flash: flash,
        });
        return;
      }
      patchState(channel, { flash: flash });
      return;
    }

    if (ev === 'draw_offer') {
      patchState(channel, { flash: (tagVal(tags, '+nick') || 'L’adversaire') + ' propose nulle' });
      return;
    }

    if (ev === 'game_end') {
      ui.sel = '';
      ui.promo = null;
      ui.pendingMove = null;
      clearPremoves();
      var endUcis = tagVal(tags, '+ucis') || prev.ucis;
      var endPly = Number(tagVal(tags, '+ply')) || splitUcis(endUcis).length;
      ui.navPly = endPly;
      var why = tagVal(tags, '+reason');
      var invitedEnd = tagVal(tags, '+invited') || prev.invited;
      var crashMsg = why === 'crash'
        ? 'La partie a été arrêtée à cause d’une erreur technique. Relance depuis l’accueil.'
        : '';
      var timeoutMsg = '';
      if (why === 'timeout') {
        timeoutMsg = invitedEnd
          ? (invitedEnd + ' n’a pas accepté l’invitation.')
          : 'Personne n’a rejoint la partie.';
      }
      patchState(channel, {
        status: 'ended', waiting: false, fen: tagVal(tags, '+fen') || prev.fen,
        result: tagVal(tags, '+result'), reason: why,
        winner: tagVal(tags, '+winner'), flash: crashMsg || timeoutMsg, gid: gid || prev.gid,
        invited: invitedEnd,
        creator: tagVal(tags, '+creator') || prev.creator,
        sans: tagVal(tags, '+sans') || prev.sans,
        ucis: endUcis,
        opening: tagVal(tags, '+opening') || prev.opening,
        openingVar: tagVal(tags, '+opening') ? tagVal(tags, '+opening-var') : prev.openingVar,
        skill: tagVal(tags, '+skill') || prev.skill,
        tc: tagVal(tags, '+tc') || prev.tc,
        duration: Number(tagVal(tags, '+duration')) || prev.duration,
        white: tagVal(tags, '+white') || prev.white,
        black: tagVal(tags, '+black') || prev.black,
        ply: endPly,
        eloW: tagVal(tags, '+elo-w'),
        eloB: tagVal(tags, '+elo-b'),
        eloDw: tagVal(tags, '+elo-dw'),
        review: emptyReview(),
      });
      return;
    }

    if (ev === 'history_list') {
      if (!eventForMe(tags)) return;
      var from = Number(tagVal(tags, '+from')) || 0;
      var added = parseHistoryRows(tagVal(tags, '+rows'));
      var list = from === 0 ? added : (prev.history || []).concat(added);
      patchState(channel, { history: list });
      return;
    }

    if (ev === 'archive') {
      if (!eventForMe(tags)) return;
      clearCmdBusy();
      archiveGame = Object.assign(defaultState(), {
        status: 'ended',
        _archive: true,
        gid: gid || tagVal(tags, '+gid'),
        white: tagVal(tags, '+white'),
        black: tagVal(tags, '+black'),
        result: tagVal(tags, '+result'),
        reason: tagVal(tags, '+reason'),
        tc: tagVal(tags, '+tc') || 'casual',
        skill: tagVal(tags, '+skill'),
        opening: tagVal(tags, '+opening'),
        openingVar: tagVal(tags, '+opening-var'),
        duration: Number(tagVal(tags, '+duration')) || 0,
        fen: tagVal(tags, '+fen') || START_FEN,
        ply: Number(tagVal(tags, '+ply')) || 0,
        ucis: '',
        sans: '',
        review: emptyReview(),
      });
      ui.navPly = -1;
      bump();
      return;
    }

    if (ev === 'archive_moves' || ev === 'hist_chunk') {
      var start = Math.max(1, Number(tagVal(tags, '+from')) || 1);
      var addU = splitUcis(tagVal(tags, '+ucis'));
      var addS = String(tagVal(tags, '+sans') || '').split(',').filter(Boolean);
      if (ev === 'archive_moves') {
        if (!eventForMe(tags) || !archiveGame) return;
        if (gid && archiveGame.gid && String(gid) !== String(archiveGame.gid)) return;
        archiveGame = Object.assign({}, archiveGame, mergeMoveChunk(archiveGame, start, addU, addS));
        bump();
        return;
      }
      patchState(channel, mergeMoveChunk(prev, start, addU, addS));
      return;
    }

    if (ev === 'review_start') {
      var started = Object.assign(emptyReview(), {
        status: 'run',
        n: Number(tagVal(tags, '+n')) || splitUcis((archiveGame && archiveGame.ucis) || prev.ucis).length,
      });
      putReview(channel, gid, prev, started);
      return;
    }

    if (ev === 'review_chunk') {
      var base = (reviewSink(gid, prev) === 'archive' && archiveGame)
        ? archiveGame.review
        : prev.review;
      var rev = Object.assign(emptyReview(), base || {});
      var fromPly = Math.max(1, Number(tagVal(tags, '+from')) || 1);
      var cls = String(tagVal(tags, '+cls') || '').split(',');
      var evs = String(tagVal(tags, '+cps') || tagVal(tags, '+cp') || '').split(',');
      var bps = String(tagVal(tags, '+bp') || '').split(',');
      var bss = String(tagVal(tags, '+bs') || '').split(',');
      rev.cls = (rev.cls || []).slice();
      rev.ev = (rev.ev || []).slice();
      rev.bp = (rev.bp || []).slice();
      rev.bs = (rev.bs || []).slice();
      cls.forEach(function (code, i) {
        if (!code) return;
        var idx = fromPly - 1 + i;
        rev.cls[idx] = code;
        rev.ev[idx] = Number(evs[i] || 0);
        rev.bp[idx] = bps[i] || '';
        rev.bs[idx] = bss[i] || '';
      });
      if (!rev.status) rev.status = 'run';
      putReview(channel, gid, prev, rev);
      return;
    }

    if (ev === 'review_done') {
      var prevRev = (reviewSink(gid, prev) === 'archive' && archiveGame)
        ? archiveGame.review
        : prev.review;
      var done = Object.assign(emptyReview(), prevRev || {});
      done.status = tagVal(tags, '+ok') === '0' ? 'err' : 'done';
      done.accW = tagVal(tags, '+acc-w');
      done.accB = tagVal(tags, '+acc-b');
      done.wBl = Number(tagVal(tags, '+w-bl')) || 0;
      done.wMi = Number(tagVal(tags, '+w-mi')) || 0;
      done.wIn = Number(tagVal(tags, '+w-in')) || 0;
      done.wEx = Number(tagVal(tags, '+w-ex')) || 0;
      done.wGd = Number(tagVal(tags, '+w-gd')) || 0;
      done.wBs = Number(tagVal(tags, '+w-bs')) || 0;
      done.wGr = Number(tagVal(tags, '+w-gr')) || 0;
      done.wBr = Number(tagVal(tags, '+w-br')) || 0;
      done.wMs = Number(tagVal(tags, '+w-ms')) || 0;
      done.bBl = Number(tagVal(tags, '+b-bl')) || 0;
      done.bMi = Number(tagVal(tags, '+b-mi')) || 0;
      done.bIn = Number(tagVal(tags, '+b-in')) || 0;
      done.bEx = Number(tagVal(tags, '+b-ex')) || 0;
      done.bGd = Number(tagVal(tags, '+b-gd')) || 0;
      done.bBs = Number(tagVal(tags, '+b-bs')) || 0;
      done.bGr = Number(tagVal(tags, '+b-gr')) || 0;
      done.bBr = Number(tagVal(tags, '+b-br')) || 0;
      done.bMs = Number(tagVal(tags, '+b-ms')) || 0;
      if (tagVal(tags, '+text')) done.err = tagVal(tags, '+text');
      putReview(channel, gid, prev, done);
      return;
    }

    if (ev === 'cmd_err') {
      if (tagVal(tags, '+nick') && !eventForMe(tags)) return;
      clearCmdBusy();
      var err = tagVal(tags, '+text');
      if (err === 'idle') {
        if (prev.status === 'idle') {
          bump();
          return;
        }
        ui.sel = '';
        ui.promo = null;
        ui.navPly = -1;
        ui.pendingMove = null;
        clearPremoves();
        patchState(channel, Object.assign(defaultState(), keepProfile(prev), { flash: '' }));
        return;
      }
      patchState(channel, { flash: err || 'Erreur' });
    }
  }

  function pieceSvg(ch, cls) {
    if (!ch) return '';
    var white = ch === ch.toUpperCase();
    var kind = ch.toLowerCase();
    var fill = white ? '#f8f4ea' : '#1c1917';
    var stroke = white ? '#292524' : '#0c0a09';
    var ink = white ? '#292524' : '#e7e5e4';
    var body = '';
    if (kind === 'p') {
      body = '<path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z"/>';
    } else if (kind === 'r') {
      body = '<path d="M9 39h27v-3H9v3zM12 36v-4h21v4H12zM11 14V9h4v2h5V9h5v2h5V9h4v5" stroke-linecap="butt"/>' +
        '<path d="M34 14l-3 3H14l-3-3" stroke-linecap="butt"/>' +
        '<path d="M31 17v12.5H14V17" stroke-linecap="butt" stroke-linejoin="miter"/>' +
        '<path d="M31 29.5l1.5 2.5h-20l1.5-2.5" stroke-linecap="butt"/>' +
        '<path d="M11 14h23" fill="none" stroke-linecap="butt"/><path d="M12 35.5h21M13 31.5h19" fill="none"/>';
    } else if (kind === 'n') {
      body = '<path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-18"/>' +
        '<path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.99-.5-2 .5-3s3 2.5 3 2.5h2s.78-1.99 2.5-3c1 0 1 3 1 3"/>' +
        '<path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0z" fill="' + ink + '" stroke="' + ink + '"/>' +
        '<path d="M14.973 15.5a.5 1.5 0 1 1-1 0 .5 1.5 0 1 1 1 0z" fill="' + ink + '" stroke="' + ink + '" transform="rotate(120 13.97 15.5)"/>';
    } else if (kind === 'b') {
      body = '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" stroke-linecap="butt">' +
        '<path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.46 3-2 3-2z"/>' +
        '<path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/>' +
        '<path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g>' +
        '<path d="M17.5 26h10M15 30h15M22.5 15.5l-3 6 3 6 3-6z" fill="none" stroke="' + ink + '" stroke-width="1.5" stroke-linejoin="miter"/>';
    } else if (kind === 'q') {
      body = '<circle cx="6" cy="12" r="2.75"/><circle cx="14" cy="9" r="2.75"/><circle cx="22.5" cy="8" r="2.75"/>' +
        '<circle cx="31" cy="9" r="2.75"/><circle cx="39" cy="12" r="2.75"/>' +
        '<path d="M9 26c8.5-9 18.5-9 27 0l-3-7.5-6.5 4L22.5 11l-4 11.5-6.5-4L9 26z" stroke-linecap="butt"/>' +
        '<path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-4.5-18.5-4.5-27 0z" stroke-linecap="butt"/>' +
        '<path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none"/>';
    } else {
      body = '<path d="M22.5 11.63V6M20 8h5" fill="none" stroke-linejoin="miter"/>' +
        '<path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" stroke-linecap="butt" stroke-linejoin="miter"/>' +
        '<path d="M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z"/>' +
        '<path d="M12.5 30c5.5-3 14.5-3 20 0M12.5 33.5c5.5-3 14.5-3 20 0M12.5 37c5.5-3 14.5-3 20 0" fill="none"/>';
    }
    return '<svg class="' + (cls || 'oec-piece') + '" viewBox="0 0 45 45" aria-hidden="true">' +
      '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">' +
      body + '</g></svg>';
  }

  function capturedHtml(symbols) {
    return String(symbols || '').split('').map(function (p) {
      return '<span class="oec-cap">' + pieceSvg(p, 'oec-piece oec-piece--mini') + '</span>';
    }).join('');
  }

  function iconSvg(name) {
    if (name === 'chat') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
    }
    if (name === 'game') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/></svg>';
    }
    if (name === 'split') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>';
    }
    if (name === 'full') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    }
    if (name === 'settings') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
    }
    return '';
  }

  function normalizeViewMode(mode) {
    var m = String(mode || '').toLowerCase();
    if (m === VIEW_FULL || m === VIEW_SPLIT || m === VIEW_CHAT) return m;
    return VIEW_FULL;
  }

  function getViewMode(orbit) {
    try {
      if (orbit) return normalizeViewMode(orbit.storage.get(STORAGE_VIEW, VIEW_FULL));
    } catch (e) { /* ignore */ }
    return normalizeViewMode(viewMode);
  }

  function hasOnboarded(orbit) {
    try {
      return !!orbit.storage.get(STORAGE_ONBOARD, false);
    } catch (e) { return false; }
  }

  function markOnboarded(orbit) {
    try { if (orbit) orbit.storage.set(STORAGE_ONBOARD, true); } catch (e) { /* ignore */ }
    ui.tour = false;
  }

  function startTour(orbit) {
    ui.settings = false;
    ui.tour = true;
    if (orbit) setViewMode(orbit, VIEW_FULL);
    else bump();
  }

  function maybeFirstVisitGame(orbit) {
    if (!orbit || hasOnboarded(orbit)) return;
    if (ui.tour) return;
    ui.tour = true;
    viewMode = VIEW_FULL;
    try { orbit.storage.set(STORAGE_VIEW, VIEW_FULL); } catch (e) { /* ignore */ }
  }

  function isNarrowScreen() {
    return window.matchMedia('(max-width:880px)').matches;
  }

  function chromeBottom() {
    var vv = window.visualViewport;
    var vh = (vv && vv.height) || window.innerHeight || 0;
    var extra = 0;
    function consider(el) {
      if (!el || (el.closest && el.closest('#oec-dom-panel'))) return;
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return;
      var r = el.getBoundingClientRect();
      if (r.height >= 36 && r.height <= 88 && r.width > vh * 0.4 && r.top > vh * 0.62 && r.bottom >= vh - 12) {
        extra = Math.max(extra, Math.ceil(vh - r.top));
      }
    }
    var nodes = document.querySelectorAll(
      'nav, footer, [role="navigation"], [role="tablist"], [class*="tabbar"], [class*="tab-bar"], [class*="bottombar"], [class*="bottom-bar"], [class*="dock"]'
    );
    for (var i = 0; i < nodes.length; i++) consider(nodes[i]);
    var roots = [document.body];
    var app = document.getElementById('app') || document.querySelector('.app, #orbit, .orbit');
    if (app) roots.push(app);
    roots.forEach(function (rootEl) {
      if (!rootEl || !rootEl.children) return;
      for (var j = 0; j < rootEl.children.length; j++) {
        var child = rootEl.children[j];
        var pos = window.getComputedStyle(child).position;
        if (pos === 'fixed' || pos === 'sticky') consider(child);
      }
    });
    return Math.min(extra, 88);
  }

  function clearPanelBox(root, main) {
    if (root) {
      ['height', 'max-height', 'width', 'top', 'left', 'right', 'bottom', 'position', 'z-index', 'margin'].forEach(function (p) {
        root.style.removeProperty(p);
      });
    }
    if (main) {
      ['height', 'max-height', 'width', 'max-width', 'margin', 'padding', 'padding-left', 'padding-right'].forEach(function (p) {
        main.style.removeProperty(p);
      });
    }
  }

  function fitPanelToViewport() {
    var root = document.getElementById('oec-dom-panel');
    var main = document.querySelector('.main');
    if (!root) return;
    var full = document.body.classList.contains('oec-full');
    var split = document.body.classList.contains('oec-split');
    if (!full && !split) {
      clearPanelBox(root, main);
      return;
    }
    var topbar = null;
    if (main) {
      for (var ti = 0; ti < main.children.length; ti++) {
        if (main.children[ti].classList && main.children[ti].classList.contains('topbar')) {
          topbar = main.children[ti];
          break;
        }
      }
    }
    if (!topbar) topbar = document.querySelector('.topbar');
    var vv = window.visualViewport;
    var vh = Math.round((vv && vv.height) || window.innerHeight || 0);
    var vw = Math.round((vv && vv.width) || window.innerWidth || document.documentElement.clientWidth || 0);
    var top = 0;
    if (topbar) top = Math.round(topbar.getBoundingClientRect().bottom);
    else top = Math.round(root.getBoundingClientRect().top);
    if (vv) top -= Math.round(vv.offsetTop || 0);
    top = Math.max(0, top);
    var bottom = chromeBottom();
    var h = Math.floor(vh - top - bottom);
    if (split && !full && window.matchMedia('(max-width:999px)').matches) {
      h = Math.min(h, Math.floor(vh * 0.58));
    }
    if (full && isNarrowScreen()) {
      if (vv) top = Math.round(topbar ? topbar.getBoundingClientRect().bottom : top);
      top = Math.max(0, top);
      var kb = 0;
      if (vv) {
        var hidden = Math.round((window.innerHeight || 0) - vv.height - (vv.offsetTop || 0));
        if (hidden > 140) kb = hidden;
      }
      if (main) {
        main.style.setProperty('padding', '0', 'important');
        main.style.setProperty('margin', '0', 'important');
        main.style.setProperty('width', '100%', 'important');
        main.style.setProperty('max-width', 'none', 'important');
        main.style.setProperty('height', '100dvh', 'important');
        main.style.setProperty('max-height', '100dvh', 'important');
      }
      root.style.setProperty('position', 'fixed', 'important');
      root.style.setProperty('left', '0', 'important');
      root.style.setProperty('right', '0', 'important');
      root.style.setProperty('top', top + 'px', 'important');
      root.style.setProperty('bottom', kb + 'px', 'important');
      root.style.setProperty('height', 'auto', 'important');
      root.style.setProperty('max-height', 'none', 'important');
      root.style.setProperty('width', '100%', 'important');
      root.style.setProperty('margin', '0', 'important');
      root.style.setProperty('z-index', '40', 'important');
      return;
    }
    root.style.removeProperty('position');
    root.style.removeProperty('left');
    root.style.removeProperty('right');
    root.style.removeProperty('top');
    root.style.removeProperty('bottom');
    root.style.removeProperty('z-index');
    if (full && main) {
      main.style.setProperty('height', vh + 'px', 'important');
      main.style.setProperty('max-height', vh + 'px', 'important');
    }
    if (h > 80) {
      root.style.setProperty('height', h + 'px', 'important');
      root.style.setProperty('max-height', h + 'px', 'important');
      root.style.setProperty('width', '100%', 'important');
    }
  }

  function clearShellLayout() {
    document.body.classList.remove('oec-full', 'oec-split');
    document.documentElement.classList.remove('oec-full', 'oec-split');
    var root = document.getElementById('oec-dom-panel');
    var main = document.querySelector('.main');
    if (root) root.style.display = 'none';
    clearPanelBox(root, main);
  }

  function applyViewMode(orbit, mode) {
    mode = normalizeViewMode(mode);
    viewMode = mode;
    var on = !!(orbit && isChessChannel(orbit, orbit.state.active()));
    if (!on) {
      clearShellLayout();
      return;
    }
    var root = document.getElementById('oec-dom-panel');
    document.body.classList.toggle('oec-full', mode === VIEW_FULL);
    document.body.classList.toggle('oec-split', mode === VIEW_SPLIT);
    document.documentElement.classList.toggle('oec-full', mode === VIEW_FULL);
    document.documentElement.classList.toggle('oec-split', mode === VIEW_SPLIT);
    if (!root) return;
    root.classList.remove('oec-panel--full', 'oec-panel--split', 'oec-panel--chat');
    if (mode === VIEW_CHAT || mode === VIEW_SPLIT) {
      if (chatUnread) chatUnread = 0;
    }
    if (mode === VIEW_CHAT) {
      root.classList.add('oec-panel--chat');
      root.style.display = '';
      fitPanelToViewport();
      requestAnimationFrame(fitPanelToViewport);
      return;
    }
    root.style.display = '';
    root.classList.add(mode === VIEW_SPLIT ? 'oec-panel--split' : 'oec-panel--full');
    fitPanelToViewport();
    requestAnimationFrame(fitPanelToViewport);
  }

  function setViewMode(orbit, mode) {
    mode = normalizeViewMode(mode);
    viewMode = mode;
    try { if (orbit) orbit.storage.set(STORAGE_VIEW, mode); } catch (e) { /* ignore */ }
    applyViewMode(orbit, mode);
    bumpView();
    bump();
  }

  function injectStyles() {
    var prev = document.getElementById('orbit-echecs-css');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'orbit-echecs-css';
    el.textContent = [
      '.oec-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;background:#1a1c19;color:#f5f5f4;font-family:var(--font,system-ui,sans-serif);display:flex;flex-direction:column;min-height:0;overflow:hidden;box-sizing:border-box}',
      '.oec-panel--home{background:#f6f1e7;color:#3f3a32}',
      '.oec-panel--full{flex:1 1 auto;min-height:0;max-height:100%;border-bottom:0}',
      '.oec-panel--split{flex:1 1 auto;min-height:0;max-height:100%}',
      '.oec-panel--chat{flex:0 0 auto;min-height:0;height:auto!important;max-height:none!important}',
      '.oec-panel--chat .oec-stage,.oec-panel--chat .oec-home-actions,.oec-panel--chat .oec-game-actions{display:none!important}',
      'html.oec-full,html.oec-full body,body.oec-full{overflow:hidden;width:100%;max-width:100%;margin:0;padding:0;height:100%;min-height:100svh;min-height:100dvh}',
      'body.oec-full .main{display:flex!important;flex-direction:column;overflow:hidden;min-height:0;width:100%!important;max-width:none!important;margin:0!important;padding:0!important;height:100svh!important;height:100dvh!important;max-height:100svh!important;max-height:100dvh!important}',
      'html.oec-full .chan-hero,html.oec-full .messages,html.oec-full .composer,html.oec-full .main__room-bg,html.oec-full .empty,body.oec-full .chan-hero,body.oec-full .messages,body.oec-full .composer,body.oec-full .main__room-bg,body.oec-full .empty,body.oec-full .composer textarea,body.oec-full form.composer{display:none!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important;opacity:0!important;margin:0!important;padding:0!important;border:0!important;flex:none!important;resize:none!important}',
      'body.oec-full #oec-dom-panel{flex:1 1 0;min-height:0;width:100%;max-width:none;margin:0;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;background:#1a1c19}',
      'body.oec-full #oec-dom-panel.oec-panel--home{background:#f6f1e7}',
      '@media(max-width:880px){body.oec-full .app,body.oec-full #app,body.oec-full .shell,body.oec-full .layout{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;height:100%!important;min-height:100svh!important}body.oec-full .topbar{z-index:60!important;position:relative}body.oec-full .sidebar,body.oec-full .rail,body.oec-full aside.sidebar{z-index:90!important}body.oec-full .nav-backdrop{z-index:80!important}body.oec-full #oec-dom-panel{border-radius:0!important;width:100%!important;max-width:none!important;margin:0!important;left:0!important;right:0!important;bottom:0!important;height:auto!important;max-height:none!important}body.oec-full .oec-idle{width:100%!important;max-width:none!important;margin:0!important;flex:1 1 auto;min-height:0}body.oec-full .oec-stage{width:100%!important;box-sizing:border-box;padding:.45rem .55rem .5rem}body.oec-full .oec-home-actions,body.oec-full .oec-game-actions{padding-left:.55rem;padding-right:.55rem;padding-bottom:max(.55rem,env(safe-area-inset-bottom,0px))}}',
      '@media(min-width:1000px){body.oec-split .main{display:grid!important;grid-template-columns:minmax(28rem,1.25fr) minmax(14rem,.7fr);grid-template-rows:auto auto 1fr auto;align-items:stretch;overflow:hidden}body.oec-split .topbar{grid-column:1/-1;grid-row:1}body.oec-split .main__room-bg{grid-column:2;grid-row:2/4;height:auto!important}body.oec-split #oec-dom-panel{grid-column:1;grid-row:2/-1;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid rgba(255,255,255,.08)}body.oec-split .chan-hero{grid-column:2;grid-row:2}body.oec-split .messages{grid-column:2;grid-row:3;min-height:0}body.oec-split .composer{grid-column:2;grid-row:4}body.oec-split .main>:not(.topbar):not(#oec-dom-panel):not(.main__room-bg):not(.chan-hero):not(.messages):not(.composer){grid-column:2}}',
      '@media(max-width:999px){body.oec-split .main{display:flex;flex-direction:column;overflow:hidden}body.oec-split #oec-dom-panel{flex:0 1 auto;min-height:0;max-height:min(58vh,calc(100dvh - 12rem));overflow:hidden}body.oec-split .messages{flex:1 1 auto;min-height:8rem}}',
      '.oec-head{position:relative;display:flex;align-items:center;gap:.45rem;padding:.42rem .7rem;background:linear-gradient(135deg,#14532d,#166534);color:#fff;flex:0 0 auto;overflow:visible;z-index:30}',
      '.oec-head__title{font-weight:800;font-size:.88rem}',
      '.oec-head__badge{font-size:.68rem;font-weight:800;padding:.16rem .6rem;border-radius:999px;background:rgba(255,255,255,.18)}',
      '.oec-head__actions{margin-left:auto;display:flex;gap:.28rem}',
      '.oec-head__btn{position:relative;border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:34px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.oec-head__unread{position:absolute;top:-5px;right:-5px;min-width:1.15rem;height:1.15rem;padding:0 .22rem;border-radius:999px;background:#dc2626;color:#fff;font-size:.62rem;font-weight:800;line-height:1.15rem;text-align:center;box-shadow:0 0 0 2px #14532d}',
      '.oec-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.oec-head__btn--on{background:rgba(255,255,255,.34)}',
      '.oec-head__btn svg{width:18px;height:18px;display:block}',
      '.oec-settings{position:absolute;right:.55rem;top:calc(100% + 6px);z-index:50;width:min(22rem,calc(100vw - 1.4rem));padding:.7rem .75rem .8rem;border-radius:12px;background:#fff;color:#3f3a32;border:1px solid #d7ccb8;box-shadow:0 16px 36px rgba(15,23,42,.22);text-align:left}',
      '.oec-settings h3{margin:0 0 .4rem;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:#6b7c4a}',
      '.oec-settings p{margin:0 0 .55rem;font-size:.8rem;line-height:1.4;color:#5c564c}',
      '.oec-settings .oec-actions{margin:0}',
      '.oec-settings .oec-btn{border-color:#cfc3ad;background:#faf6ee;color:#3f3a32}',
      '.oec-settings .oec-btn:hover{border-color:#166534;color:#14532d}',
      '.oec-settings .oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '.oec-check{display:flex;align-items:center;gap:.55rem;margin:0;cursor:pointer;font-size:.84rem;font-weight:700;color:#3f3a32;user-select:none}',
      '.oec-check input{width:1.1rem;height:1.1rem;accent-color:#166534;flex:0 0 auto}',
      '.oec-settings .oec-check + .oec-check{margin-top:.55rem}',
      '.oec-tour{position:absolute;left:.45rem;right:.45rem;top:calc(100% + 8px);z-index:46;padding:.75rem .8rem .85rem;border-radius:12px;background:#fff;color:#3f3a32;border:1px solid #d7ccb8;box-shadow:0 16px 36px rgba(15,23,42,.28);text-align:left}',
      '.oec-tour h3{margin:0 0 .2rem;font-size:.92rem;font-weight:800;color:#14532d}',
      '.oec-tour__lead{margin:0 0 .55rem;font-size:.78rem;line-height:1.4;color:#5c564c}',
      '.oec-tour__list{margin:0 0 .7rem;padding:0;list-style:none;display:flex;flex-direction:column;gap:.5rem}',
      '.oec-tour__list li{display:flex;align-items:flex-start;gap:.55rem;font-size:.8rem;line-height:1.4;color:#3f3a32}',
      '.oec-tour__list b{font-weight:800;color:#14532d}',
      '.oec-tour__ico{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:.18rem;min-width:2.1rem;height:2.1rem;padding:0 .28rem;border-radius:9px;background:#166534;color:#fff}',
      '.oec-tour__ico svg{width:16px;height:16px;display:block}',
      '.oec-tour__ico--btn{min-width:0;height:auto;padding:.28rem .45rem;font-size:.62rem;font-weight:800;letter-spacing:.01em;white-space:nowrap}',
      '.oec-tour .oec-btn{width:100%}',
      '.oec-head__btn--hint{animation:oec-hint 1.4s ease-in-out infinite;box-shadow:0 0 0 2px #fde68a}',
      '@keyframes oec-hint{50%{background:rgba(253,224,71,.55)}}',
      '.oec-spin{width:16px;height:16px;border:2px solid #d7ccb8;border-top-color:#166534;border-radius:50%;animation:oec-spin .7s linear infinite;flex:0 0 auto}',
      '@keyframes oec-spin{to{transform:rotate(360deg)}}',
      '.oec-panel--menu{overflow:visible}',
      '.oec-stage{flex:1 1 auto;min-height:0;display:flex;align-items:flex-start;justify-content:center;gap:1.1rem;padding:.55rem .7rem .65rem;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#166534 rgba(22,101,52,.15)}',
      '.oec-stage::-webkit-scrollbar{width:8px}',
      '.oec-stage::-webkit-scrollbar-thumb{background:rgba(22,101,52,.35);border-radius:999px}',
      '.oec-panel--home .oec-stage{align-items:stretch;justify-content:flex-start;flex-direction:column;flex:1 1 auto;min-height:0}',
      'body.oec-split .oec-stage{flex-direction:column;align-items:center;justify-content:flex-start;gap:.65rem}',
      'body.oec-split .oec-board-wrap{width:min(100%,calc(100dvh - 9.5rem));max-width:100%;margin:0 auto}',
      'body.oec-split .oec-meta{max-width:none;width:100%;flex:1 1 auto;min-height:0;overflow:auto}',
      '.oec-board{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));grid-template-rows:repeat(8,minmax(0,1fr));width:100%;aspect-ratio:1/1;height:auto;border-radius:10px;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.35),inset 0 0 0 2px rgba(255,255,255,.08);touch-action:none;user-select:none}',
      '.oec-sq{position:relative;display:grid;place-items:center;min-width:0;min-height:0;width:100%;height:100%;overflow:visible;cursor:pointer}',
      '.oec-sq--light{background:#eed7ac}',
      '.oec-sq--dark{background:#b58863}',
      '.oec-sq--last{box-shadow:inset 0 0 0 100px rgba(205,210,106,.42)}',
      '.oec-sq--sel,.oec-sq--drag{box-shadow:inset 0 0 0 3px #14532d}',
      '.oec-sq--pre{box-shadow:inset 0 0 0 100px rgba(220,38,38,.34)}',
      '.oec-sq--pre.oec-sq--sel{box-shadow:inset 0 0 0 100px rgba(220,38,38,.34),inset 0 0 0 3px #7f1d1d}',
      '.oec-sq__mark{position:absolute;top:3px;left:50%;right:auto;transform:translateX(-50%);width:max-content;max-width:calc(100% - 4px);min-width:0;height:auto;padding:.12rem .28rem;border-radius:6px;font-size:clamp(.4rem,.95vw,.58rem);font-weight:800;display:block;z-index:8;pointer-events:none;line-height:1.15;letter-spacing:.01em;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45)}',
      '.oec-sq__mark--br{background:#06b6d4;color:#042f2e}',
      '.oec-sq__mark--gr{background:#14b8a6;color:#042f2e}',
      '.oec-sq__mark--bs,.oec-sq__mark--ex{background:#22c55e;color:#052e16}',
      '.oec-sq__mark--gd{background:#a3e635;color:#1a2e05}',
      '.oec-sq__mark--in{background:#facc15;color:#422006}',
      '.oec-sq__mark--mi{background:#fb923c;color:#431407}',
      '.oec-sq__mark--bl,.oec-sq__mark--ms{background:#ef4444;color:#fff}',
      '.oec-sq__mark--bk{background:#78716c;color:#fff}',
      '.oec-sq--over{outline:3px solid #facc15;outline-offset:-3px}',
      '.oec-piece{width:88%;height:88%;max-width:100%;max-height:100%;filter:drop-shadow(0 1px 0 rgba(255,255,255,.28)) drop-shadow(0 3px 4px rgba(0,0,0,.38));pointer-events:none}',
      '.oec-piece--mini{width:18px;height:18px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}',
      '.oec-piece--ghost{position:fixed;width:56px;height:56px;z-index:80;pointer-events:none;transform:translate(-50%,-50%);filter:drop-shadow(0 8px 12px rgba(0,0,0,.4))}',
      '.oec-piece--pre{position:absolute;width:88%;height:88%;opacity:.48;pointer-events:none}',
      '.oec-board-wrap{position:relative;width:min(100%,calc(100dvh - 7.2rem));max-width:min(72dvh,100%);flex:0 0 auto}',
      '.oec-board-wait{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:rgba(26,28,25,.28);pointer-events:all;border-radius:10px}',
      '.oec-link .oec-spin{width:14px;height:14px;border-color:#c4b8a0;border-top-color:#166534}',
      '.oec-btn:disabled{opacity:.6;cursor:wait}',
      '.oec-pre-arrows{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:2}',
      '.oec-opening{margin:0 0 .45rem;font-size:.8rem;font-weight:700;color:#fde68a;line-height:1.35}',
      '.oec-opening__var{display:block;margin-top:.12rem;font-size:.72rem;font-weight:800;color:#bbf7d0;letter-spacing:.02em}',
      '.oec-sq__coord{position:absolute;font-size:.62rem;font-weight:800;opacity:.55;pointer-events:none;line-height:1}',
      '.oec-sq__coord--file{right:3px;bottom:3px}',
      '.oec-sq__coord--rank{left:3px;top:3px}',
      '.oec-sq--dark .oec-sq__coord{color:#f5e6cc}',
      '.oec-sq--light .oec-sq__coord{color:#6b4f34}',
      '.oec-meta{flex:1 1 16rem;min-width:12rem;max-width:22rem;min-height:0;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '.oec-players{margin:0 0 .5rem;font-size:.86rem;line-height:1.5}',
      '.oec-clock{display:flex;flex-direction:column;gap:.28rem;margin:0 0 .7rem}',
      '.oec-clock > span{display:flex;flex-direction:column;gap:.12rem;background:rgba(255,255,255,.06);border-radius:10px;padding:.4rem .55rem;font-weight:700}',
      '.oec-clock__top{display:flex;justify-content:space-between;align-items:center;gap:.4rem;width:100%}',
      '.oec-clock span b{font-weight:800}',
      '.oec-clock > span.is-turn{outline:2px solid #86efac}',
      '.oec-clock__time{font-variant-numeric:tabular-nums;font-size:1.05rem;letter-spacing:.02em}',
      '.oec-pl__line{font-style:normal;font-size:.68rem;font-weight:700;color:#bbf7d0;opacity:.92}',
      '.oec-pl__line b{font-weight:800;color:#ecfdf5}',
      '.oec-vbadge{display:inline-flex;align-items:center;padding:.08rem .42rem;border-radius:999px;font-size:.58rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;line-height:1.35;white-space:nowrap;vertical-align:middle}',
      '.oec-vbadge--ok{background:#166534;color:#ecfdf5}',
      '.oec-vbadge--no{background:#c2410c;color:#fff7ed}',
      '.oec-vbadge--wait{background:#ea580c;color:#fff}',
      '.oec-pl__line .oec-vbadge{margin-left:.2rem;opacity:1}',
      '.oec-cc-banner{margin:0 0 .55rem;padding:.45rem .5rem;border-radius:10px;background:#fff7ed;color:#3f3a32;border:1px solid #ea580c}',
      '.oec-cc-banner .oec-cc-preview{color:#7c2d12}',
      '.oec-cc-banner .oec-btn{border-color:#cfc3ad;background:#fff;color:#3f3a32}',
      '.oec-cc-banner .oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '.oec-nav{display:flex;flex-wrap:wrap;gap:.3rem;margin:.35rem 0}',
      '.oec-review{margin:.45rem 0;padding:.65rem .7rem;border-radius:12px;background:#14532d;color:#ecfdf5;font-size:.82rem;line-height:1.45}',
      '.oec-review h3{margin:0 0 .35rem;font-size:.9rem}',
      '.oec-review dl{display:grid;grid-template-columns:auto 1fr;gap:.12rem .7rem;margin:0}',
      '.oec-review dt{opacity:.75}',
      '.oec-review dd{margin:0;font-weight:700}',
      '.oec-board-col{display:flex;align-items:stretch;gap:.4rem;width:min(100%,calc(100dvh - 7.2rem));max-width:min(72dvh,100%);flex:0 0 auto}',
      '.oec-board-col .oec-board-wrap{width:100%;max-width:none;flex:1 1 auto}',
      'body.oec-split .oec-board-col{width:min(100%,calc(100dvh - 9.5rem));max-width:100%;margin:0 auto}',
      '.oec-eval{position:relative;flex:0 0 18px;width:18px;align-self:stretch;min-height:12rem;border-radius:9px;overflow:hidden;background:#0c0a09;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}',
      '.oec-eval__fill{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(180deg,#fff7ed,#f5f0e6);transition:height .25s ease}',
      '.oec-eval__lab{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:.52rem;font-weight:800;color:#fde68a;writing-mode:vertical-rl;pointer-events:none;text-shadow:0 0 4px #000}',
      '.oec-eval__b,.oec-eval__w{position:absolute;left:0;right:0;text-align:center;font-size:.48rem;font-weight:800;pointer-events:none;z-index:1}',
      '.oec-eval__b{top:3px;color:#e7e5e4}',
      '.oec-eval__w{bottom:3px;color:#1c1917}',
      '.oec-sq--best{box-shadow:inset 0 0 0 3px #22d3ee}',
      '.oec-accs{display:grid;grid-template-columns:1fr 1fr;gap:.45rem;margin:.45rem 0 .35rem}',
      '.oec-acc{display:flex;align-items:center;gap:.45rem;background:rgba(0,0,0,.18);border-radius:10px;padding:.4rem .5rem}',
      '.oec-acc__ring{width:2.6rem;height:2.6rem;border-radius:50%;display:grid;place-items:center;flex:0 0 auto}',
      '.oec-acc__ring span{width:1.95rem;height:1.95rem;border-radius:50%;background:#14532d;display:grid;place-items:center;font-weight:800;font-size:.78rem}',
      '.oec-acc b{display:block;font-size:.78rem}',
      '.oec-acc small{opacity:.75;font-size:.68rem}',
      '.oec-rev-counts{display:flex;flex-wrap:wrap;gap:.25rem;margin:.2rem 0 .45rem}',
      '.oec-rev-counts span{font-size:.68rem;font-weight:800;border-radius:999px;padding:.12rem .45rem;background:rgba(255,255,255,.1)}',
      '.oec-tip{margin:.35rem 0 .45rem;padding:.55rem .6rem;border-radius:10px;background:rgba(0,0,0,.28);font-size:.82rem;line-height:1.4}',
      '.oec-tip .oec-badge{margin-right:.25rem}',
      '.oec-tip b{display:block;margin-bottom:.15rem}',
      '.oec-tip__best{display:block;margin-top:.2rem;color:#67e8f9;font-weight:700}',
      '.oec-eval-hint{margin:.15rem 0 .35rem;font-size:.68rem;opacity:.8}',
      '.oec-hist{display:flex;flex-direction:column;gap:.22rem}',
      '.oec-hist button{border:1px solid #e4d9c5;background:#faf6ee;color:#3f3a32;border-radius:10px;padding:.32rem .5rem;text-align:left;cursor:pointer;font-size:.74rem;display:flex;flex-wrap:wrap;align-items:center;gap:.28rem .4rem}',
      '.oec-hist button:hover{border-color:#166534}',
      '.oec-hist b{display:block;font-size:.78rem}',
      '.oec-hist span{opacity:.7;font-size:.68rem}',
      '.oec-badge{display:inline-block;border-radius:999px;padding:.08rem .42rem;font-size:.66rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase}',
      '.oec-badge--bk{background:#78716c;color:#fff}',
      '.oec-badge--br{background:#06b6d4;color:#042f2e}',
      '.oec-badge--gr{background:#14b8a6;color:#042f2e}',
      '.oec-badge--bs{background:#22c55e;color:#052e16}',
      '.oec-badge--ex{background:#86efac;color:#14532d}',
      '.oec-badge--gd{background:#a3e635;color:#1a2e05}',
      '.oec-badge--in{background:#facc15;color:#422006}',
      '.oec-badge--mi{background:#fb923c;color:#431407}',
      '.oec-badge--bl{background:#ef4444;color:#fff}',
      '.oec-badge--ms{background:#f97316;color:#fff}',
      '.oec-moves{display:grid;grid-template-columns:1.4rem 1fr 1fr;gap:.12rem .3rem;max-height:min(40vh,16rem);overflow:auto;font-size:.75rem;line-height:1.35;margin:.2rem 0}',
      '.oec-moves button{border:0;background:transparent;color:inherit;text-align:left;padding:.12rem .25rem;border-radius:6px;cursor:pointer;font-weight:700}',
      '.oec-moves button.is-on{background:rgba(255,255,255,.16)}',
      '.oec-moves small{display:block;font-size:.58rem;font-weight:800;opacity:.85;text-transform:uppercase;letter-spacing:.02em}',
      '.oec-mv--bk{color:#d6d3d1}',
      '.oec-mv--br{color:#67e8f9}',
      '.oec-mv--gr{color:#5eead4}',
      '.oec-mv--bs,.oec-mv--ex,.oec-mv--gd{color:#bbf7d0}',
      '.oec-mv--in{color:#fde68a}',
      '.oec-mv--mi{color:#fdba74}',
      '.oec-mv--bl,.oec-mv--ms{color:#fca5a5}',
      '.oec-moves .n{opacity:.55;font-variant-numeric:tabular-nums;padding:.12rem 0}',
      '.oec-wait{display:flex;align-items:center;gap:.4rem;font-size:.78rem;margin:.35rem 0}',
      '.oec-turn{margin:0 0 .5rem;font-size:.8rem;font-weight:800;color:#86efac}',
      '.oec-caps{display:flex;flex-wrap:wrap;gap:.1rem;min-height:1.3em;margin:0 0 .35rem}',
      '.oec-sans{font-size:.72rem;color:#a8a29e;max-height:5.2rem;overflow:auto;line-height:1.45}',
      '.oec-flash{margin:.4rem 0;padding:.45rem .55rem;border-radius:8px;background:#fef3c7;color:#92400e;font-size:.78rem;font-weight:700}',
      '.oec-end{margin:.4rem 0;padding:.5rem .6rem;border-radius:8px;background:#14532d;color:#bbf7d0;font-size:.82rem;font-weight:800}',
      '.oec-actions{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.55rem}',
      '.oec-btn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f5f5f4;border-radius:999px;padding:.4rem .75rem;font-size:.76rem;font-weight:800;cursor:pointer;min-height:34px;display:inline-flex;align-items:center;justify-content:center;gap:.35rem}',
      '.oec-btn:hover{border-color:#86efac;color:#bbf7d0}',
      '.oec-btn:disabled,.oec-btn.is-wait{opacity:.82;cursor:wait;pointer-events:none}',
      '.oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '.oec-btn--danger{color:#fecaca;border-color:#7f1d1d}',
      '.oec-game-actions .oec-spin,.oec-btn--pri .oec-spin,.oec-btn--danger .oec-spin{border-color:rgba(255,255,255,.32);border-top-color:#fff}',
      '.oec-hist .oec-spin{width:14px;height:14px;border-color:#d7ccb8;border-top-color:#166534}',
      '.oec-idle{text-align:left;width:100%;max-width:58rem;margin:0 auto;color:#3f3a32;display:flex;flex-direction:column;gap:.38rem;min-height:0;flex:1 1 auto;box-sizing:border-box}',
      '.oec-hero{position:relative;border-radius:14px;overflow:hidden;margin:0;flex:0 1 auto;min-height:clamp(5.5rem,14vh,9.5rem);max-height:min(16vh,9.5rem);background:#e8dcc4}',
      '.oec-hero img{display:block;position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '.oec-hero__label{position:absolute;left:.8rem;bottom:.5rem;margin:0;color:#fff;font-size:clamp(1rem,2vh,1.35rem);font-weight:800;text-shadow:0 2px 10px rgba(0,0,0,.45)}',
      '.oec-home-lead{margin:0;color:#5c564c;font-size:.74rem;line-height:1.3}',
      '.oec-home-grid{display:grid;grid-template-columns:1fr 1fr;gap:.32rem;align-items:start}',
      '.oec-home-grid .oec-card--wide{grid-column:1/-1}',
      '.oec-card{background:#fff;border:1px solid #e4d9c5;border-radius:12px;padding:.38rem .52rem;margin:0;box-shadow:0 6px 16px rgba(92,70,40,.07)}',
      '.oec-card--invite{position:relative;z-index:8;overflow:visible}',
      '.oec-card--ask{border-color:#ea580c;background:#fff7ed}',
      '.oec-card--ask h3{color:#c2410c}',
      '.oec-card--ok{border-color:#166534;background:#f0fdf4}',
      '.oec-card--en{background:#f8faf4}',
      '.oec-en__name{margin:0 0 .12rem;font-size:.92rem;font-weight:800;color:#14532d}',
      '.oec-en__elo{margin:0;font-size:1.7rem;font-weight:800;color:#3f3a32;line-height:1.1}',
      '.oec-card--en .oec-cc__stats{margin-top:.32rem}',
      '.oec-field{display:flex;flex-direction:column;gap:.28rem;margin:0 0 .65rem;font-size:.72rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6b7c4a}',
      '.oec-field__row{display:flex;gap:.35rem}',
      '.oec-field input{flex:1;min-width:0;border:1px solid #d7ccb8;border-radius:10px;padding:.32rem .5rem;font-size:.8rem;font-weight:700;text-transform:none;letter-spacing:0;background:#fff;color:#3f3a32}',
      '.oec-en__meta{margin:.2rem 0 0;font-size:.72rem;font-weight:700;color:#6b7c4a;display:flex;align-items:center;gap:.35rem}',
      '.oec-card--load{border-color:#d7ccb8;background:#faf8f3}',
      '.oec-cc__box{position:relative}',
      '.oec-cc__box.is-loading .oec-cc__stats{opacity:.4}',
      '.oec-cc__spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:.4rem;font-size:.76rem;font-weight:800;color:#14532d}',
      '.oec-cc__token{margin:.35rem 0;padding:.45rem .5rem;border-radius:10px;background:#14532d;color:#bbf7d0;font-size:1.35rem;font-weight:800;letter-spacing:.12em;text-align:center}',
      '.oec-review__sum{margin:.15rem 0;font-size:.78rem;line-height:1.35}',
      '.oec-cc-preview{margin:0 0 .3rem;font-size:.78rem;line-height:1.35;color:#7c2d12}',
      '.oec-card--ok .oec-cc-preview{color:#14532d}',
      '.oec-cc__id{display:flex;flex-direction:column;gap:.08rem;margin:0 0 .32rem}',
      '.oec-cc__user{margin:0;font-size:1.05rem;font-weight:800;color:#14532d;line-height:1.15}',
      '.oec-cc__real{font-size:.72rem;font-weight:700;color:#57534e}',
      '.oec-cc__meta{color:#6b7c4a;font-size:.7rem;font-weight:700}',
      '.oec-cc__id .oec-vbadge{margin-left:.28rem}',
      '.oec-cc__id .oec-vbadge--ok{color:#ecfdf5}',
      '.oec-cc__id .oec-vbadge--no{color:#fff7ed}',
      '.oec-cc__id .oec-vbadge--wait{color:#fff}',
      '.oec-cc__stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.28rem}',
      '.oec-cc__stat{background:#f6f1e7;border-radius:8px;padding:.28rem .25rem .22rem;text-align:center}',
      '.oec-card--ok .oec-cc__stat,.oec-card--ask .oec-cc__stat{background:rgba(255,255,255,.7)}',
      '.oec-cc__stat span{display:block;font-size:.6rem;letter-spacing:.05em;text-transform:uppercase;color:#6b7c4a;font-weight:800}',
      '.oec-cc__stat b{display:block;margin:.06rem 0 .02rem;font-size:1.28rem;color:#14532d;line-height:1.1;font-variant-numeric:tabular-nums}',
      '.oec-cc__stat i{display:block;font-style:normal;font-size:.62rem;color:#7c7468;line-height:1.25}',
      '.oec-cc__stat.is-empty b{color:#a8a29e;font-size:1.15rem}',
      '.oec-cc__more{margin:.28rem 0 0;font-size:.72rem;color:#5c564c}',
      '.oec-cc__more b{color:#14532d}',
      '.oec-cc__link{display:inline-block;margin-top:.2rem;font-size:.72rem;font-weight:800;color:#166534}',
      '.oec-card h3{margin:0 0 .32rem;font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:#6b7c4a}',
      '.oec-pills{display:flex;flex-wrap:wrap;gap:.28rem}',
      '.oec-pill{border:1px solid #d7ccb8;background:#faf6ee;color:#3f3a32;border-radius:999px;padding:.2rem .5rem;font-size:.7rem;font-weight:800;cursor:pointer;min-height:26px}',
      '.oec-pill.is-on{background:#166534;border-color:#166534;color:#fff}',
      '.oec-elo{display:flex;flex-wrap:wrap;gap:.35rem .9rem;margin:0;font-size:.78rem}',
      '.oec-elo b{color:#14532d}',
      '.oec-link{display:flex;gap:.35rem;margin-top:.4rem}',
      '.oec-link input{flex:1;min-width:0;border:1px solid #d7ccb8;border-radius:10px;padding:.32rem .5rem;font-size:.8rem;background:#fff;color:#3f3a32}',
      '.oec-invite{position:relative;z-index:8;display:flex;flex-direction:column;gap:.28rem;margin-top:.35rem}',
      '.oec-invite input{width:100%;box-sizing:border-box;border:1px solid #d7ccb8;border-radius:10px;padding:.36rem .55rem;font-size:.8rem;font-weight:700;background:#fff;color:#3f3a32}',
      '.oec-invite input:focus{outline:0;border-color:#166534;box-shadow:0 0 0 2px rgba(22,101,52,.18)}',
      '.oec-invite__list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:12;max-height:9.6rem;overflow:auto;border:1px solid #e4d9c5;border-radius:10px;background:#fff;display:flex;flex-direction:column;padding:.12rem;box-shadow:0 14px 32px rgba(28,25,23,.22)}',
      '.oec-invite__nick{display:flex;align-items:center;gap:.35rem;border:0;background:transparent;text-align:left;padding:.3rem .42rem;border-radius:8px;cursor:pointer;font-size:.78rem;color:#3f3a32}',
      '.oec-invite__nick:hover,.oec-invite__nick.is-on{background:#e8f5e9}',
      '.oec-invite__nick.is-hide{display:none!important}',
      '.oec-invite__nick b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oec-invite__tag{font-size:.58rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;padding:.08rem .32rem;border-radius:999px;background:#e8dcc4;color:#5c564c;flex:0 0 auto}',
      '.oec-invite__tag--ami{background:#dcfce7;color:#166534}',
      '.oec-invite__empty{margin:.3rem .4rem;font-size:.72rem;color:#7c7468}',
      '.oec-invite__empty.is-hide{display:none}',
      '.oec-game-actions{flex:0 0 auto;z-index:5;display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:.4rem .7rem .55rem;background:#141613;border-top:1px solid rgba(255,255,255,.1)}',
      '.oec-game-actions .oec-btn{flex:1 1 auto;min-width:6.5rem}',
      '.oec-home-actions{flex:0 0 auto;z-index:4;margin:0;padding:.45rem .7rem .65rem;background:#f6f1e7;border-top:1px solid #e4d9c5}',
      '.oec-home-actions .oec-btn--pri{width:100%;min-height:34px}',
      '.oec-home-actions--inflow{display:none;grid-column:1/-1;margin:0;padding:.1rem 0 .15rem;background:transparent;border:0}',
      '@media(min-width:880px){.oec-home-actions--inflow{display:flex}.oec-panel>.oec-home-actions{display:none!important}.oec-home-actions--inflow .oec-btn--pri{min-height:42px;font-size:.88rem}}',
      '.oec-panel--home .oec-btn{border-color:#cfc3ad;background:#fff;color:#3f3a32}',
      '.oec-panel--home .oec-btn:hover{border-color:#166534;color:#14532d}',
      '.oec-panel--home .oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '@media(max-width:640px){.oec-home-grid{grid-template-columns:1fr}.oec-hero{min-height:clamp(4.8rem,12vh,8rem);max-height:8rem}.oec-hero__label{font-size:.95rem}}',
      '.oec-promo{display:flex;gap:.35rem;margin:.45rem 0}',
      '.oec-promo button{width:2.6rem;height:2.6rem;border-radius:10px;border:1px solid #166534;background:#fff;cursor:pointer;padding:.2rem}',
      '@media(min-width:721px){.oec-panel:not(.oec-panel--home) .oec-stage{align-items:flex-start;justify-content:center;overflow:hidden}.oec-panel:not(.oec-panel--home) .oec-board-col,.oec-panel:not(.oec-panel--home) .oec-board-wrap{align-self:flex-start}.oec-panel:not(.oec-panel--home) .oec-meta{max-height:100%;align-self:stretch;padding-top:0}}',
      '@media(max-width:720px){.oec-stage{flex-direction:column;align-items:stretch;justify-content:flex-start;overflow:auto;width:100%}.oec-meta{max-width:none;width:100%;align-self:stretch;overflow:visible}.oec-board-wrap,.oec-board-col{width:100%;max-width:none;margin:0}.oec-board-col{gap:.35rem}.oec-eval{flex-basis:14px;width:14px;min-height:0}}',
    ].join('');
    document.head.appendChild(el);
  }

  function viewingGame(game) {
    var view = Object.assign({}, game);
    var ucis = splitUcis(game.ucis);
    if (ui.navPly >= 0 && ucis.length) {
      var ply = Math.min(ui.navPly, ucis.length);
      view.fen = fenAtPly(game, ply);
      var uci = ucis[ply - 1] || '';
      view.from = uci.slice(0, 2);
      view.to = uci.slice(2, 4);
      view.lastUci = uci;
      var sans = String(game.sans || '').split(',').filter(Boolean);
      view.lastSan = sans[ply - 1] || '';
      view._replay = ply < ucis.length || game.status === 'ended';
      view._ply = ply;
    } else {
      view._ply = ucis.length;
    }
    var rev = game.review || emptyReview();
    var idx = (view._ply || 0) - 1;
    view._revEval = 0;
    view._hasEval = false;
    if (idx >= 0) {
      if (rev.cls && rev.cls[idx]) view._revClass = rev.cls[idx];
      if (rev.ev && rev.ev.length > idx && rev.ev[idx] != null && rev.ev[idx] !== '') {
        view._revEval = Number(rev.ev[idx]);
        view._hasEval = !isNaN(view._revEval);
      }
      view._revBest = (rev.bp && rev.bp[idx]) || '';
      view._revBestSan = (rev.bs && rev.bs[idx]) || '';
    }
    return view;
  }

  function renderBoard(orbit, game) {
    var parsed = parseFen(game.fen);
    var flip = myColor(orbit, game) === 'black';
    var lastFrom = game.from || (game.lastUci && game.lastUci.slice(0, 2)) || '';
    var lastTo = game.to || (game.lastUci && game.lastUci.slice(2, 4)) || '';
    var bestUci = game._revBest || '';
    var bestFrom = (bestUci && bestUci !== game.lastUci) ? bestUci.slice(0, 2) : '';
    var bestTo = bestFrom ? bestUci.slice(2, 4) : '';
    var color = myColor(orbit, game);
    var myTurn = game.status === 'playing' && color && game.turn === color && !game._replay;
    var canPremove = game.status === 'playing' && color && !myTurn && !game._replay && premoveOn(orbit);
    var preFrom = {};
    var preTo = {};
    var preGhost = {};
    (ui.premoves || []).forEach(function (pm) {
      preFrom[pm.from] = true;
      preTo[pm.to] = true;
      var piece = pieceAt(game.fen, pm.from);
      if (piece) {
        var ch = piece;
        if (pm.promo) {
          ch = color === 'white' ? pm.promo.toUpperCase() : pm.promo.toLowerCase();
        }
        preGhost[pm.to] = ch;
      }
    });
    var ranks = flip ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    var files = flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    var html = '<div class="oec-board-wrap"><div class="oec-board" role="grid">';
    ranks.forEach(function (rank) {
      files.forEach(function (file) {
        var name = sqName(file, rank);
        var piece = parsed.grid[rank][file];
        var light = (file + rank) % 2 === 1;
        var cls = 'oec-sq ' + (light ? 'oec-sq--light' : 'oec-sq--dark');
        if (name === lastFrom || name === lastTo) cls += ' oec-sq--last';
        if (name === bestFrom || name === bestTo) cls += ' oec-sq--best';
        if (name === ui.sel) cls += ' oec-sq--sel';
        if (preFrom[name] || preTo[name]) cls += ' oec-sq--pre';
        var showFile = rank === (flip ? 7 : 0);
        var showRank = file === (flip ? 7 : 0);
        var mine = (myTurn || canPremove) && piece && pieceColor(piece) === color;
        html += '<div class="' + cls + '" data-sq="' + escHtml(name) + '"' +
          (mine ? ' data-mine="1"' : '') + '>';
        if (showFile) html += '<span class="oec-sq__coord oec-sq__coord--file">' + 'abcdefgh'.charAt(file) + '</span>';
        if (showRank) html += '<span class="oec-sq__coord oec-sq__coord--rank">' + (rank + 1) + '</span>';
        if (piece) html += pieceSvg(piece);
        if (preGhost[name]) html += pieceSvg(preGhost[name], 'oec-piece oec-piece--pre');
        if (name === lastTo && game._revClass) {
          html += '<span class="oec-sq__mark oec-sq__mark--' + game._revClass + '">' +
            escHtml(revLabel(game._revClass)) + '</span>';
        }
        html += '</div>';
      });
    });
    html += '</div>' + premoveArrows(flip) +
      (ui.pendingMove ? '<div class="oec-board-wait"><span class="oec-spin" aria-hidden="true"></span></div>' : '') +
      '</div>';
    if (game.status === 'ended') {
      var hasEval = !!game._hasEval;
      var cp = hasEval ? Number(game._revEval) : 0;
      if (isNaN(cp)) { cp = 0; hasEval = false; }
      var whitePct = Math.max(4, Math.min(96, evalWinPct(cp)));
      var fillPos = flip ? 'top:0;bottom:auto;' : 'bottom:0;top:auto;';
      var topLab = flip ? 'B' : 'N';
      var botLab = flip ? 'N' : 'B';
      html = '<div class="oec-board-col">' +
        '<div class="oec-eval" title="Barre d’évaluation (POV Blancs). La zone claire est l’avantage des Blancs. ' +
        (hasEval ? escHtml(fmtEval(cp)) : 'Analyse en cours') + '">' +
        '<span class="oec-eval__b">' + topLab + '</span>' +
        '<div class="oec-eval__fill" style="' + fillPos + 'height:' + whitePct.toFixed(1) + '%"></div>' +
        '<span class="oec-eval__w">' + botLab + '</span>' +
        '<span class="oec-eval__lab">' + (hasEval ? escHtml(fmtEval(cp)) : '…') + '</span></div>' +
        html + '</div>';
    }
    return html;
  }

  function evalWinPct(cp) {
    cp = Math.max(-1500, Math.min(1500, Number(cp) || 0));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  function fmtEval(cp) {
    cp = Number(cp) || 0;
    if (Math.abs(cp) >= 9000) return cp > 0 ? 'M' : '-M';
    var n = (cp / 100);
    var s = (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1));
    return (cp > 0 ? '+' : '') + s;
  }

  function premoveArrows(flip) {
    if (!ui.premoves || !ui.premoves.length) return '';
    var lines = ui.premoves.map(function (pm) {
      var a = arrowPoint(pm.from, flip);
      var b = arrowPoint(pm.to, flip);
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len;
      var uy = dy / len;
      var x2 = b.x - ux * 0.28;
      var y2 = b.y - uy * 0.28;
      return '<line x1="' + a.x.toFixed(2) + '" y1="' + a.y.toFixed(2) +
        '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '"/>';
    }).join('');
    return '<svg class="oec-pre-arrows" viewBox="0 0 8 8" aria-hidden="true">' +
      '<defs><marker id="oec-pre-ah" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">' +
      '<path d="M0 0 10 5 0 10z" fill="#dc2626"/></marker></defs>' +
      '<g stroke="#dc2626" stroke-width=".18" stroke-linecap="round" marker-end="url(#oec-pre-ah)" opacity=".9">' +
      lines + '</g></svg>';
  }

  function arrowPoint(name, flip) {
    var f = 'abcdefgh'.indexOf(String(name).charAt(0));
    var r = Number(String(name).charAt(1)) - 1;
    return {
      x: (flip ? 7 - f : f) + 0.5,
      y: (flip ? r : 7 - r) + 0.5,
    };
  }

  function needsPromo(game, from, to) {
    var parsed = parseFen(game.fen);
    var ff = 'abcdefgh'.indexOf(from.charAt(0));
    var fr = Number(from.charAt(1)) - 1;
    var tr = Number(to.charAt(1)) - 1;
    var piece = parsed.grid[fr] && parsed.grid[fr][ff];
    if (piece === 'P' && tr === 7) return true;
    if (piece === 'p' && tr === 0) return true;
    return false;
  }

  function viewBtns(mode) {
    var layoutAct = mode === VIEW_SPLIT ? 'view-full' : 'view-split';
    var layoutIcon = mode === VIEW_SPLIT ? 'full' : 'split';
    var layoutTitle = mode === VIEW_SPLIT
      ? pick({ fr: 'Jeu en plein écran', en: 'Fullscreen game' })
      : pick({ fr: 'Jeu + tchat', en: 'Game + chat' });
    var paneAct = mode === VIEW_CHAT ? 'view-full' : 'view-chat';
    var paneIcon = mode === VIEW_CHAT ? 'game' : 'chat';
    var paneTitle = mode === VIEW_CHAT
      ? pick({ fr: 'Afficher le jeu', en: 'Show game' })
      : pick({ fr: 'Afficher le tchat', en: 'Show chat' });
    return '<div class="oec-head__actions">' +
      '<button type="button" class="oec-head__btn' + (mode === VIEW_SPLIT ? ' oec-head__btn--on' : '') +
        '" data-act="' + layoutAct + '" title="' + escHtml(layoutTitle) + '">' + iconSvg(layoutIcon) + '</button>' +
      '<button type="button" class="oec-head__btn' + (mode === VIEW_CHAT ? ' oec-head__btn--on' : '') +
        (ui.tour ? ' oec-head__btn--hint' : '') +
        '" data-act="' + paneAct + '" title="' + escHtml(paneTitle) + '">' + iconSvg(paneIcon) +
        (mode !== VIEW_CHAT && chatUnread ? '<span class="oec-head__unread">' +
          (chatUnread > 99 ? '99+' : String(chatUnread)) + '</span>' : '') +
        '</button>' +
      '<button type="button" class="oec-head__btn' + (ui.settings ? ' oec-head__btn--on' : '') +
        (ui.tour ? ' oec-head__btn--hint' : '') +
        '" data-act="settings" title="' + escHtml(pick({ fr: 'Paramètres', en: 'Settings' })) + '">' +
        iconSvg('settings') + '</button>' +
      '</div>';
  }

  function renderSettings(game) {
    if (!ui.settings) return '';
    var on = !game.ccOptout;
    var busy = !!ui.ccBusy;
    var preview = game.ccPrompt === 'preview' || game.ccPrompt === 'found' || game.ccPrompt === 'verify';
    var extra = '';
    if (!on) {
      extra = '<p>Le bloc Chess.com est masqué. Coche la case pour le réafficher.</p>';
    } else if (preview) {
      extra = game.ccPrompt === 'verify' ? renderCcVerify(game) : renderCcConfirm(game);
    } else {
      extra = '<label class="oec-field"><span>Pseudo Chess.com</span>' +
        '<span class="oec-field__row">' +
        '<input id="oec-cc" type="text" maxlength="25" placeholder="pseudo Chess.com" value="' +
        escHtml(ui.ccUser || game.chesscom || '') + '"' + (busy ? ' disabled' : '') + '>' +
        '<button type="button" class="oec-btn oec-btn--pri" data-act="lier"' + (busy ? ' disabled' : '') + '>' +
        (busy ? '…' : 'OK') + '</button></span></label>' +
        (game.chesscom && game.ccPrompt === 'linked'
          ? '<p>Compte actuel : <b>' + escHtml(game.chesscom) + '</b> ' +
            ccVerifyBadge(isCcVerified(game)) +
            (isCcVerified(game) ? '.' : '. Clique <b>Prouver que c’est moi</b> sur l’accueil pour le code.') +
            '</p>'
          : '<p>Indique ton pseudo Chess.com pour lier tes classements.</p>');
    }
    return '<div class="oec-settings" role="dialog" aria-label="Paramètres">' +
      '<h3>Paramètres</h3>' + extra +
      '<label class="oec-check' + (busy ? ' is-busy' : '') + '" data-act="cc-toggle">' +
      '<input type="checkbox"' + (on ? ' checked' : '') + (busy ? ' disabled' : '') + '>' +
      '<span>Afficher Chess.com</span>' +
      (busy ? '<span class="oec-spin" aria-hidden="true"></span>' : '') +
      '</label>' +
      '<label class="oec-check" data-act="premove-toggle">' +
      '<input type="checkbox"' + (premoveOn(pluginOrbit) ? ' checked' : '') + '>' +
      '<span>Pré-mouvement</span></label>' +
      '<label class="oec-check" data-act="tour-toggle">' +
      '<input type="checkbox"' + ((ui.tour || !hasOnboarded(pluginOrbit)) ? ' checked' : '') + '>' +
      '<span>Voir le guide</span></label></div>';
  }

  function renderTour() {
    if (!ui.tour || ui.settings) return '';
    return '<div class="oec-tour" role="dialog" aria-label="Guide du salon échecs">' +
      '<h3>Bienvenue aux échecs</h3>' +
      '<p class="oec-tour__lead">Trois gestes à retenir pour démarrer :</p>' +
      '<ul class="oec-tour__list">' +
      '<li><span class="oec-tour__ico" aria-hidden="true">' + iconSvg('settings') + '</span>' +
      '<div><b>Le menu</b> — À droite de la barre verte, la roue dentée ouvre les paramètres du jeu (Chess.com, pré-mouvement, ce guide).</div></li>' +
      '<li><span class="oec-tour__ico" aria-hidden="true">' + iconSvg('chat') + iconSvg('game') + '</span>' +
      '<div><b>Tchat ou jeu</b> — Ces icônes, à droite de la barre verte, affichent le tchat du salon ou le plateau.</div></li>' +
      '<li><span class="oec-tour__ico oec-tour__ico--btn" aria-hidden="true">Lancer la partie</span>' +
      '<div><b>Nouvelle partie</b> — Choisissez l’adversaire et la cadence, puis touchez ce bouton.</div></li>' +
      '</ul>' +
      '<button type="button" class="oec-btn oec-btn--pri" data-act="tour-done">C’est compris</button></div>';
  }

  function playerStatsLine(p, nickFallback) {
    var nick = (p && p.nick) || nickFallback || '';
    if (!nick || nick === 'IA') {
      return '<i class="oec-pl__line">IA' + (p && p.elo ? ' (' + escHtml(p.elo) + ')' : '') + '</i>';
    }
    var bits = [];
    if (p && p.elo) bits.push('EntreNous <b>' + escHtml(p.elo) + '</b>');
    if (p && (p.blitz || p.rapid || p.bullet || p.cc)) {
      var cc = [];
      if (p.blitz) cc.push('blz ' + p.blitz);
      if (p.rapid) cc.push('rap ' + p.rapid);
      if (p.bullet) cc.push('bul ' + p.bullet);
      bits.push('CC ' + (cc.length ? cc.join(' · ') : escHtml(p.cc)) +
        (p.cc ? ' ' + ccVerifyBadge(isCcVerified(p)) : ''));
    }
    return bits.length
      ? '<i class="oec-pl__line">' + bits.join(' · ') + '</i>'
      : '<i class="oec-pl__line">EntreNous —</i>';
  }

  function ccOuiBtn(label, busyLabel) {
    var busy = !!ui.ccBusy;
    return '<button type="button" class="oec-btn oec-btn--pri" data-act="lier-oui"' +
      (busy ? ' disabled' : '') + '>' +
      (busy ? '<span class="oec-spin" aria-hidden="true"></span> ' + busyLabel : label) +
      '</button>';
  }

  function ccSideBtns() {
    var busy = !!ui.ccBusy;
    return '<button type="button" class="oec-btn" data-act="lier-non"' + (busy ? ' disabled' : '') +
      '>Autre pseudo</button>' +
      '<button type="button" class="oec-btn" data-act="lier-skip"' + (busy ? ' disabled' : '') +
      '>Ne pas utiliser</button>';
  }

  function renderCcVerify(game) {
    var busy = !!ui.ccBusy;
    return '<p class="oec-cc-preview">Pour prouver que <b>' + escHtml(game.chesscom || '') +
      '</b> est à toi, colle ce code dans <b>Localisation</b> de ton profil Chess.com (Paramètres → Profil).</p>' +
      '<p class="oec-cc__token">' + escHtml(game.ccToken || '…') + '</p>' +
      (game.ccErr ? '<p class="oec-cc-err">' + escHtml(game.ccErr) + '</p>' : '') +
      '<div class="oec-actions" style="margin-top:.3rem">' +
      ccOuiBtn('J’ai collé le code', 'Vérification…') + ccSideBtns() + '</div>' +
      (busy ? '<p class="oec-wait" style="color:#7c2d12"><span class="oec-spin" aria-hidden="true"></span>Vérification du profil Chess.com…</p>' : '');
  }

  function renderCcConfirm(game) {
    var busy = !!ui.ccBusy;
    return '<p class="oec-cc-preview">Confirme le compte Chess.com <b>' +
      escHtml(game.chesscom || game.ccName) + '</b>.</p>' +
      ccHandle(game) + ccStatsGrid(game) +
      '<div class="oec-actions" style="margin-top:.3rem">' +
      ccOuiBtn('C’est moi', 'Création du code…') + ccSideBtns() + '</div>' +
      (busy ? '<p class="oec-wait" style="color:#7c2d12"><span class="oec-spin" aria-hidden="true"></span>Création du code…</p>' : '');
  }

  function pill(act, val, label, current) {
    return '<button type="button" class="oec-pill' + (current === val ? ' is-on' : '') +
      '" data-act="' + act + '" data-val="' + val + '">' + label + '</button>';
  }

  function renderHome(orbit, game) {
    var s = ui.setup;
    var busy = !!ui.ccBusy;
    var loading = !game.ccReady && !game.ccOptout;
    if (loading) armCcBoot(orbit.state && orbit.state.active ? orbit.state.active() : '');
    var prompt = game.ccPrompt || '';
    var preview = prompt === 'preview' || prompt === 'found';
    var verify = prompt === 'verify';
    var missing = prompt === 'missing' || (game.ccReady && !prompt && !game.ccOptout && !preview && !verify && prompt !== 'linked');
    var linked = prompt === 'linked';
    var showCc = !game.ccOptout;
    var elo = game.elo || (loading ? '—' : '1200');
    var gamesN = Number(game.eloGames || 0);
    var enMeta = loading && !game.elo
      ? '<span class="oec-spin"></span> Chargement…'
      : (gamesN ? gamesN + ' partie' + (gamesN > 1 ? 's' : '') + ' classée' + (gamesN > 1 ? 's' : '') : 'Aucune partie classée');
    var enCard = '<div class="oec-card oec-card--en' + (showCc ? '' : ' oec-card--wide') + (loading && !game.elo ? ' is-loading' : '') + '">' +
      '<h3>Classement EntreNous</h3>' +
      (game.enName ? '<p class="oec-en__name">' + escHtml(game.enName) + '</p>' : '') +
      '<p class="oec-en__elo">' + escHtml(String(elo)) + '</p>' +
      '<div class="oec-cc__stats">' +
      ccStatCell('Rapide', game.enRapid, game.enRapidBest, game.enRapidRec, loading && !game.elo) +
      ccStatCell('Blitz', game.enBlitz, game.enBlitzBest, game.enBlitzRec, loading && !game.elo) +
      ccStatCell('Bullet', game.enBullet, game.enBulletBest, game.enBulletRec, loading && !game.elo) +
      '</div>' +
      '<p class="oec-en__meta">' + enMeta + '</p></div>';
    var ccCard = '';
    if (showCc) {
      var ccTitle = loading ? 'Classement Chess.com'
        : verify ? 'Preuve Chess.com'
        : preview ? 'Confirmer le compte Chess.com'
        : (busy && missing) ? 'Recherche Chess.com'
        : (busy && linked && !isCcVerified(game)) ? 'Preuve Chess.com'
        : missing ? 'Compte Chess.com'
        : linked ? 'Classement Chess.com'
        : 'Chess.com';
      var ccCls = 'oec-card' + (loading ? ' oec-card--load' : '') +
        (!loading && (preview || verify || missing || (linked && !isCcVerified(game))) ? ' oec-card--ask' : '') +
        (linked && isCcVerified(game) ? ' oec-card--ok' : '');
      var ccBody = '';
      if (loading) {
        ccBody = '<p class="oec-cc-preview" style="color:#5c564c">Recherche d’un compte Chess.com…</p>' +
          ccStatsGrid(game, true);
      } else if (verify) {
        ccBody = renderCcVerify(game);
      } else if (preview) {
        ccBody = '<p class="oec-cc-preview">Un compte a été trouvé. Confirme s’il s’agit bien du tien avant affichage.</p>' +
          ccHandle(game) + ccStatsGrid(game) +
          '<div class="oec-actions" style="margin-top:.35rem">' +
          ccOuiBtn('C’est moi', 'Création du code…') +
          '<button type="button" class="oec-btn" data-act="lier-non"' + (busy ? ' disabled' : '') + '>Ce n’est pas moi</button>' +
          '<button type="button" class="oec-btn" data-act="lier-skip"' + (busy ? ' disabled' : '') + '>Ne pas utiliser</button>' +
          '</div>' +
          (busy ? '<p class="oec-wait" style="color:#7c2d12"><span class="oec-spin" aria-hidden="true"></span>Création du code…</p>' : '');
      } else if (linked) {
        ccBody = ccHandle(game) + ccStatsGrid(game);
        if (!isCcVerified(game)) {
          ccBody += '<div class="oec-actions" style="margin-top:.3rem">' +
            ccOuiBtn('Prouver que c’est moi', 'Création du code…') + '</div>' +
            (busy ? '<p class="oec-wait" style="color:#7c2d12"><span class="oec-spin" aria-hidden="true"></span>Création du code de preuve…</p>' : '');
        }
      } else {
        ccBody = '<p class="oec-cc-preview">Indique ton pseudo Chess.com, ou désactive cette fonction.</p>' +
          (game.ccErr ? '<p class="oec-cc-err">' + escHtml(game.ccErr) + '</p>' : '') +
          '<div class="oec-link"><input id="oec-cc" type="text" placeholder="pseudo Chess.com" value="' +
          escHtml(ui.ccUser || '') + '"' + (busy ? ' disabled' : '') + '>' +
          '<button type="button" class="oec-btn oec-btn--pri" data-act="lier"' + (busy ? ' disabled' : '') + '>' +
          (busy ? '<span class="oec-spin" aria-hidden="true"></span> Recherche…' : 'Vérifier') + '</button>' +
          '<button type="button" class="oec-btn" data-act="lier-skip"' + (busy ? ' disabled' : '') + '>Ne pas utiliser</button></div>' +
          (busy ? '<p class="oec-wait" style="color:#7c2d12"><span class="oec-spin" aria-hidden="true"></span>Recherche du compte Chess.com…</p>' : '');
      }
      ccCard = '<div class="' + ccCls + '"><h3>' + ccTitle + '</h3>' + ccBody + '</div>';
    }
    return '<div class="oec-idle">' +
      '<div class="oec-hero"><img src="' + HOME_IMG + '" alt="">' +
      '<p class="oec-hero__label">Bienvenue aux échecs</p></div>' +
      '<p class="oec-home-lead">' +
      pick({ fr: 'Choisissez un niveau, une cadence, puis lancez une partie contre l’IA ou un ami du salon.',
        en: 'Pick a level and time control, then play the AI or a friend.' }) +
      '</p>' +
      '<div class="oec-home-grid">' +
      '<div class="oec-card"><h3>Adversaire</h3><div class="oec-pills">' +
      pill('setup-vs', 'ai', 'Contre l’IA', s.vs) +
      pill('setup-vs', 'duo', 'Partie duo', s.vs) +
      '</div></div>' +
      (s.vs === 'ai'
        ? '<div class="oec-card"><h3>Votre couleur</h3><div class="oec-pills">' +
          pill('setup-color', 'random', 'Au hasard', s.color) +
          pill('setup-color', 'white', 'Blancs', s.color) +
          pill('setup-color', 'black', 'Noirs', s.color) +
          '</div></div>' +
          '<div class="oec-card oec-card--wide"><h3>Niveau d’IA</h3><div class="oec-pills">' +
          pill('setup-skill', 'debutant', 'Débutant (400)', s.skill) +
          pill('setup-skill', 'facile', 'Facile (800)', s.skill) +
          pill('setup-skill', 'moyen', 'Moyen (1400)', s.skill) +
          pill('setup-skill', 'difficile', 'Difficile (1800)', s.skill) +
          pill('setup-skill', 'expert', 'Expert (2200)', s.skill) +
          '</div></div>'
        : '<div class="oec-card oec-card--wide oec-card--invite"><h3>Qui défier ?</h3><div class="oec-pills">' +
          pill('setup-duo', 'open', 'Premier arrivé', s.duo || 'open') +
          pill('setup-duo', 'friend', 'Un ami précis', s.duo || 'open') +
          '</div>' +
          ((s.duo || 'open') === 'friend'
            ? renderInvitePicker(orbit, (orbit.state && orbit.state.active && orbit.state.active()) || '')
            : '<p class="oec-home-lead" style="margin-top:.3rem">N’importe qui dans le salon peut rejoindre.</p>') +
          '</div>') +
      '<div class="oec-card oec-card--wide"><h3>Cadence (Chess.com)</h3><div class="oec-pills">' +
      pill('setup-tc', 'casual', 'Illimité', s.tc) +
      pill('setup-tc', 'bullet', 'Bullet 1+0', s.tc) +
      pill('setup-tc', 'blitz', 'Blitz 3+2', s.tc) +
      pill('setup-tc', 'rapide', 'Rapide 10+0', s.tc) +
      pill('setup-tc', 'rapide15', 'Rapide 15+10', s.tc) +
      '</div></div>' +
      renderHomeLaunch(game, 'oec-home-actions--inflow') +
      enCard + ccCard +
      renderHistory(game) +
      '</div>' +
      (game.flash ? '<div class="oec-flash">' + escHtml(game.flash) + '</div>' : '') +
      '</div>';
  }

  function renderHomeLaunch(game, extraClass) {
    var s = ui.setup;
    var label = (s.vs === 'duo' && s.duo === 'friend') ? 'Défier' : 'Lancer la partie';
    return '<div class="oec-actions oec-home-actions' + (extraClass ? ' ' + extraClass : '') + '">' +
      cmdBtn('start-setup', label, 'Lancement…', 'oec-btn--pri') +
      '</div>';
  }

  function gamePly(game) {
    if (!game) return 0;
    if (game.ply === 0 || game.ply === '0') return 0;
    var ply = Number(game.ply);
    if (isFinite(ply) && ply > 0) return ply;
    return String(game.ucis || '').split(',').filter(Boolean).length;
  }

  function canAbort(game) {
    if (!game) return false;
    if (game.status === 'waiting') return true;
    if (game.status !== 'playing') return false;
    return gamePly(game) < 2;
  }

  function renderGameFooter(orbit, game) {
    var html = '<div class="oec-actions oec-game-actions">';
    if (game._archive) {
      html += cmdBtn('home', 'Accueil', 'Chargement…', 'oec-btn--pri');
    } else if (game.status === 'waiting') {
      var me = myNick(orbit);
      var invited = String(game.invited || '').toLowerCase();
      var creator = String(game.creator || '').toLowerCase();
      var canJoin = invited ? invited === me : creator && creator !== me;
      if (canJoin) html += cmdBtn('join', 'Rejoindre', 'Connexion…', 'oec-btn--pri');
      if (creator === me) html += cmdBtn('abort', 'Annuler', 'Annulation…');
    } else if (game.status === 'playing') {
      html += cmdBtn('draw', 'Nulle', 'Envoi…');
      if (canAbort(game)) html += cmdBtn('abort', 'Annuler', 'Annulation…');
      html += cmdBtn('resign', 'Abandonner', 'Abandon…', 'oec-btn--danger');
    } else if (game.status === 'ended') {
      html += cmdBtn('home', 'Accueil', 'Chargement…', 'oec-btn--pri');
      html += cmdBtn('start-setup', 'Rejouer', 'Lancement…');
    }
    html += '</div>';
    return html;
  }

  function renderHistory(game) {
    var rows = (game.history || []).slice(0, 5);
    var html = '<div class="oec-card oec-card--wide"><h3>Tes parties</h3>';
    if (!rows.length) {
      html += '<p class="oec-home-lead">Tes 5 dernières parties classées apparaîtront ici.</p></div>';
      return html;
    }
    html += '<div class="oec-hist">';
    rows.forEach(function (row) {
      var white = (row.white || '?') + (row.eloW ? ' (' + row.eloW + ')' : '');
      var black = (row.black || '?') + (row.eloB ? ' (' + row.eloB + ')' : '');
      var wait = ui.cmdBusy === 'revoir' && ui.cmdBusyVal === String(row.gid);
      html += '<button type="button" data-act="revoir" data-val="' + escHtml(row.gid) + '"' +
        (ui.cmdBusy ? ' disabled' : '') + (wait ? ' aria-busy="true" class="is-wait"' : '') + '>' +
        (wait ? '<span class="oec-spin" aria-hidden="true"></span>' : '') +
        '<b>' + escHtml(white) + ' – ' + escHtml(black) +
        ' · ' + escHtml(row.result || '*') + '</b>' +
        '<span>' + escHtml(tcLabel(row.tc)) + '</span></button>';
    });
    html += '</div></div>';
    return html;
  }

  function renderNav(game) {
    var ucis = splitUcis(game.ucis);
    if (!ucis.length) return '';
    var at = ui.navPly < 0 ? ucis.length : ui.navPly;
    return '<div class="oec-nav">' +
      '<button type="button" class="oec-btn" data-act="nav-start" title="Début">⏮</button>' +
      '<button type="button" class="oec-btn" data-act="nav-prev" title="Coup précédent">◀</button>' +
      '<button type="button" class="oec-btn" data-act="nav-next" title="Coup suivant">▶</button>' +
      '<button type="button" class="oec-btn" data-act="nav-end" title="Position actuelle">⏭</button>' +
      '<span class="oec-turn">' + at + ' / ' + ucis.length + '</span></div>';
  }

  function revLabel(code) {
    return ({
      bk: 'Théorique', br: 'Brillant', gr: 'Superbe', bs: 'Meilleur',
      ex: 'Excellent', gd: 'Bon', in: 'Imprécision', mi: 'Erreur',
      bl: 'Gaffe', ms: 'Gain manqué',
    })[code] || '';
  }

  function revTip(code, bestSan) {
    var best = bestSan ? ' → ' + bestSan : '';
    return ({
      bk: 'Livre',
      br: 'Brillant',
      gr: 'Seul bon coup',
      bs: 'Meilleur coup',
      ex: 'Excellent',
      gd: 'Bon' + best,
      in: 'Imprécision' + best,
      mi: 'Erreur' + best,
      bl: 'Gaffe' + best,
      ms: 'Gain manqué' + best,
    })[code] || '';
  }

  function accRing(score) {
    var n = Math.max(0, Math.min(100, Number(score) || 0));
    var col = n >= 90 ? '#22c55e' : n >= 70 ? '#a3e635' : n >= 50 ? '#facc15' : '#ef4444';
    return '<div class="oec-acc__ring" style="background:conic-gradient(' + col + ' 0 ' + n + '%,#292524 ' + n + '% 100%)">' +
      '<span>' + (score === '' || score == null ? '—' : n) + '</span></div>';
  }

  function renderReview(game) {
    var rev = game.review || emptyReview();
    var html = '<div class="oec-review">';
    html += '<p class="oec-review__sum"><b>' + escHtml(game.result || '') + '</b> · ' +
      escHtml(String(splitUcis(game.ucis).length)) + ' coups · ' + escHtml(tcLabel(game.tc || 'casual')) +
      (game.skill ? ' · IA ' + escHtml(game.skill) : '') + '</p>';
    if (game.eloW || game.eloB) {
      html += '<p class="oec-review__sum">ELO ' + escHtml(game.white) + ' ' + escHtml(String(game.eloW || '—')) +
        ' · ' + escHtml(game.black) + ' ' + escHtml(String(game.eloB || '—')) +
        (game.eloDw ? ' (' + (Number(game.eloDw) > 0 ? '+' : '') + escHtml(String(game.eloDw)) + ')</p>' : '</p>');
    }
    if (rev.status === 'run') {
      html += '<p class="oec-wait"><span class="oec-spin" aria-hidden="true"></span>Analyse…</p>';
    } else if (rev.status === 'err') {
      html += '<p class="oec-wait">' + escHtml(rev.err || 'Analyse indisponible') + '</p>';
    }
    if (rev.status === 'done' || (rev.cls && rev.cls.length)) {
      html += '<div class="oec-accs">' +
        '<div class="oec-acc">' + accRing(rev.accW) + '<div><b>' + escHtml(game.white || 'Blancs') + '</b><small>Précision</small></div></div>' +
        '<div class="oec-acc">' + accRing(rev.accB) + '<div><b>' + escHtml(game.black || 'Noirs') + '</b><small>Précision</small></div></div>' +
        '</div>';
      html += '<div class="oec-rev-counts">' +
        countChip('!!', (rev.wBr || 0) + (rev.bBr || 0), 'br') +
        countChip('!', (rev.wGr || 0) + (rev.bGr || 0), 'gr') +
        countChip('?!', (rev.wIn || 0) + (rev.bIn || 0), 'in') +
        countChip('?', (rev.wMi || 0) + (rev.bMi || 0), 'mi') +
        countChip('??', (rev.wBl || 0) + (rev.bBl || 0), 'bl') +
        '</div>';
    }
    var view = viewingGame(game);
    html += renderMoveList(game, view._ply);
    html += '</div>';
    return html;
  }

  function coachCard(view) {
    if (!view || !view.lastSan) return '';
    if (!view._revClass) {
      return '<div class="oec-tip"><span class="oec-spin" aria-hidden="true"></span> Analyse de ' +
        escHtml(view.lastSan) + '…</div>';
    }
    var best = view._revBestSan
      ? '<span class="oec-tip__best">Meilleur : ' + escHtml(view._revBestSan) + '</span>'
      : '';
    return '<div class="oec-tip"><span class="oec-badge oec-badge--' + view._revClass + '">' +
      escHtml(revLabel(view._revClass)) + '</span> ' + escHtml(view.lastSan) +
      ' — ' + escHtml(revTip(view._revClass, view._revBestSan)) + best + '</div>';
  }

  function countChip(label, n, code, always) {
    n = Number(n) || 0;
    if (!n && !always) return '';
    return '<span class="oec-badge oec-badge--' + code + '">' + n + ' ' + escHtml(label) + '</span>';
  }

  function renderMoveList(game, currentPly) {
    var sans = String(game.sans || '').split(',').filter(Boolean);
    var rev = game.review || emptyReview();
    if (!sans.length) return '';
    var html = '<div class="oec-moves">';
    var i;
    for (i = 0; i < sans.length; i += 2) {
      var num = Math.floor(i / 2) + 1;
      html += '<span class="n">' + num + '</span>';
      html += moveCell(i, sans[i], rev.cls[i], currentPly);
      html += i + 1 < sans.length
        ? moveCell(i + 1, sans[i + 1], rev.cls[i + 1], currentPly)
        : '<span></span>';
    }
    html += '</div>';
    return html;
  }

  function moveCell(idx, san, code, currentPly) {
    var ply = idx + 1;
    var on = currentPly === ply ? ' is-on' : '';
    var tint = code ? ' oec-mv--' + code : '';
    return '<button type="button" class="' + on + tint + '" data-act="nav-ply" data-val="' + ply +
      '" title="' + escHtml(revLabel(code) || 'Coup') + '">' +
      escHtml(san) + '</button>';
  }

  function renderPanel(orbit, root, buffer) {
    var live = getState(buffer);
    var game = archiveGame || live;
    var view = viewingGame(game);
    var mode = getViewMode(orbit);
    var badge = game.status === 'playing' ? (game.mode === 'ai' ? 'IA' : 'Duo')
      : game.status === 'waiting' ? 'En attente'
      : game.status === 'ended' ? (game.reason === 'timeout' ? 'Non rejoint' : escHtml(game.result || 'Fin'))
      : 'Prêt';
    if (game._archive) badge = 'Relecture';
    if (game.tc && game.tc !== 'casual' && game.status !== 'idle') badge += ' · ' + tcLabel(game.tc);
    var stage = root.querySelector('.oec-stage');
    var meta = root.querySelector('.oec-meta');
    var scrollY = stage ? stage.scrollTop : 0;
    var metaY = meta ? meta.scrollTop : 0;
    var head = '<div class="oec-head"><span class="oec-head__title">Échecs</span>' +
      '<span class="oec-head__badge">' + badge + '</span>' + viewBtns(mode) +
      renderSettings(game) + renderTour() + '</div>';

    var body = '<div class="oec-stage">';
    if (game.status === 'idle') {
      body += renderHome(orbit, game);
      body += '</div>' + renderHomeLaunch(game);
    } else {
      body += renderBoard(orbit, view);
      body += '<div class="oec-meta">';
      var wTurn = game.status === 'playing' && game.turn === 'white' && !view._replay;
      var bTurn = game.status === 'playing' && game.turn === 'black' && !view._replay;
      body += '<div class="oec-clock">' +
        '<span class="' + (bTurn ? 'is-turn' : '') + '"><span class="oec-clock__top">Noirs <b>' +
        escHtml(game.black || '—') + '</b> <span class="oec-clock__time">' + liveClock(game, 'black') +
        '</span></span>' + playerStatsLine(game.pBlack, game.black) + '</span>' +
        '<span class="' + (wTurn ? 'is-turn' : '') + '"><span class="oec-clock__top">Blancs <b>' +
        escHtml(game.white || '—') + '</b> <span class="oec-clock__time">' + liveClock(game, 'white') +
        '</span></span>' + playerStatsLine(game.pWhite, game.white) + '</span></div>';
      if (!game._archive && (game.ccPrompt === 'preview' || game.ccPrompt === 'found' || game.ccPrompt === 'verify')) {
        body += '<div class="oec-cc-banner">' +
          (game.ccPrompt === 'verify' ? renderCcVerify(game) : renderCcConfirm(game)) + '</div>';
      }
      if (game.opening || game.openingVar) body += '<p class="oec-opening">' + openingHtml(game) + '</p>';
      if (game.status === 'waiting') {
        var waitTxt = game.invited
          ? ('En attente de ' + game.invited + '…')
          : pick({ fr: 'En attente d’un adversaire…', en: 'Waiting for an opponent…' });
        body += '<p class="oec-turn">' + escHtml(waitTxt) + '</p>';
      } else if (game.status === 'ended' && game.reason === 'timeout') {
        body += '<p class="oec-end">' + escHtml(game.flash || (game.invited
          ? (game.invited + ' n’a pas accepté l’invitation.')
          : 'Personne n’a rejoint la partie.')) + '</p>';
      } else if (view.lastSan) {
        var mark = view._revClass
          ? ' <span class="oec-badge oec-badge--' + view._revClass + '">' + escHtml(revLabel(view._revClass)) + '</span>'
          : '';
        body += '<p class="oec-turn">' + pick({ fr: 'Coup', en: 'Move' }) + ' ' +
          escHtml(view.lastSan) + mark + '</p>';
        if (game.status === 'ended') body += coachCard(view);
      }
      body += renderNav(game);
      if (game.capW || game.capB) {
        body += '<div class="oec-caps">' + (capturedHtml(game.capB) || '') + '</div>';
        body += '<div class="oec-caps">' + (capturedHtml(game.capW) || '') + '</div>';
      }
      if (game.sans && !(game.review && game.review.cls && game.review.cls.length)) {
        body += '<div class="oec-sans">' + escHtml(String(game.sans).replace(/,/g, ' ')) + '</div>';
      }
      if (game.flash && !(game.status === 'ended' && game.reason === 'timeout')) {
        body += '<div class="oec-flash">' + escHtml(game.flash) + '</div>';
      }
      if (game.status === 'ended' && game.reason !== 'timeout') body += renderReview(game);
      if (ui.promo) {
        body += '<div class="oec-promo">' +
          '<button type="button" data-promo="q" title="Dame">' + pieceSvg('Q') + '</button>' +
          '<button type="button" data-promo="r" title="Tour">' + pieceSvg('R') + '</button>' +
          '<button type="button" data-promo="b" title="Fou">' + pieceSvg('B') + '</button>' +
          '<button type="button" data-promo="n" title="Cavalier">' + pieceSvg('N') + '</button></div>';
      }
      body += '</div></div>' + renderGameFooter(orbit, game);
    }
    root.innerHTML = head + body;
    root.classList.toggle('oec-panel--home', game.status === 'idle');
    root.classList.toggle('oec-panel--menu', !!(ui.settings || ui.tour));
    var stage2 = root.querySelector('.oec-stage');
    var meta2 = root.querySelector('.oec-meta');
    if (stage2) stage2.scrollTop = scrollY;
    if (meta2) meta2.scrollTop = metaY;
    applyInviteFilter(root);
    fitPanelToViewport();
  }

  function tryMove(orbit, buffer, from, to, promo) {
    var game = getState(buffer);
    if (ui.pendingMove) return;
    if (viewingGame(game)._replay) return;
    if (!from || !to || from === to) return;
    var color = myColor(orbit, game);
    var myTurn = game.status === 'playing' && color && game.turn === color;
    if (!myTurn) {
      if (!premoveOn(orbit) || game.status !== 'playing' || !color) return;
      if (needsPromo(game, from, to)) {
        ui.promo = { from: from, to: to, premove: true };
        ui.sel = '';
        bump();
        return;
      }
      queuePremove(from, to, promo || '');
      return;
    }
    if (!promo && needsPromo(game, from, to)) {
      ui.promo = { from: from, to: to };
      ui.sel = '';
      bump();
      return;
    }
    sendOptimisticMove(orbit, buffer, game, from, to, promo || '');
  }

  function sendOptimisticMove(orbit, buffer, game, from, to, promo) {
    var uci = from + to + (promo || '');
    var nextFen = applyUciFen(game.fen, uci);
    ui.pendingMove = {
      uci: uci,
      from: from,
      to: to,
      prevFen: game.fen,
      prevFrom: game.from,
      prevTo: game.to,
      prevUci: game.lastUci,
      turn: game.turn,
      at: Date.now(),
    };
    ui.sel = '';
    ui.promo = null;
    var ok = sendEcCmd(orbit, buffer, 'jouer', uci);
    if (!ok) {
      ui.pendingMove = null;
      patchState(buffer, { flash: pick({ fr: 'Envoi TAGMSG impossible', en: 'TAGMSG send failed' }) });
      return;
    }
    patchState(buffer, {
      fen: nextFen,
      from: from,
      to: to,
      lastUci: uci,
      turn: game.turn === 'white' ? 'black' : 'white',
      flash: '',
    });
  }

  function ghostEl() {
    var g = document.getElementById('oec-ghost');
    if (!g) {
      g = document.createElement('div');
      g.id = 'oec-ghost';
      g.className = 'oec-piece--ghost';
      document.body.appendChild(g);
    }
    return g;
  }

  function clearDrag() {
    ui.drag = null;
    var g = document.getElementById('oec-ghost');
    if (g) g.style.display = 'none';
    document.querySelectorAll('.oec-sq--drag,.oec-sq--over').forEach(function (n) {
      n.classList.remove('oec-sq--drag', 'oec-sq--over');
    });
  }

  function bindBoardPointer(root, orbit) {
    if (root.__oecPtr) return;
    root.__oecPtr = true;
    root.addEventListener('pointerdown', function (ev) {
      var sqEl = ev.target && ev.target.closest ? ev.target.closest('[data-sq]') : null;
      if (!sqEl) return;
      var buffer = orbit.state.active();
      var game = getState(buffer);
      if (game.status !== 'playing') return;
      if (ui.pendingMove) return;
      if (viewingGame(game)._replay) return;
      var color = myColor(orbit, game);
      if (!color) return;
      var myTurn = game.turn === color;
      var canPremove = !myTurn && premoveOn(orbit);
      if (!myTurn && !canPremove) return;
      var from = sqEl.getAttribute('data-sq');
      var parsed = parseFen(game.fen);
      var f = 'abcdefgh'.indexOf(from.charAt(0));
      var r = Number(from.charAt(1)) - 1;
      var piece = parsed.grid[r] && parsed.grid[r][f];
      if (!piece || pieceColor(piece) !== color) return;
      ev.preventDefault();
      ui.drag = { from: from, piece: piece, x: ev.clientX, y: ev.clientY, moved: false };
      sqEl.classList.add('oec-sq--drag');
      try { sqEl.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    root.addEventListener('pointermove', function (ev) {
      if (!ui.drag) return;
      var dx = ev.clientX - ui.drag.x;
      var dy = ev.clientY - ui.drag.y;
      if (!ui.drag.moved && (dx * dx + dy * dy) < 36) return;
      ui.drag.moved = true;
      var g = ghostEl();
      g.innerHTML = pieceSvg(ui.drag.piece);
      g.style.display = 'block';
      g.style.left = ev.clientX + 'px';
      g.style.top = ev.clientY + 'px';
      document.querySelectorAll('.oec-sq--over').forEach(function (n) { n.classList.remove('oec-sq--over'); });
      var over = document.elementFromPoint(ev.clientX, ev.clientY);
      var sq = over && over.closest ? over.closest('[data-sq]') : null;
      if (sq) sq.classList.add('oec-sq--over');
    });
    root.addEventListener('pointerup', function (ev) {
      if (!ui.drag) return;
      var from = ui.drag.from;
      var moved = ui.drag.moved;
      var over = document.elementFromPoint(ev.clientX, ev.clientY);
      var sq = over && over.closest ? over.closest('[data-sq]') : null;
      var to = sq && sq.getAttribute('data-sq');
      clearDrag();
      var buffer = orbit.state.active();
      if (!moved && cancelPremoveAt(from)) {
        ui.sel = '';
        return;
      }
      if (moved && to) {
        tryMove(orbit, buffer, from, to);
        return;
      }
      if (!moved) {
        if (ui.sel && ui.sel !== from) tryMove(orbit, buffer, ui.sel, from);
        else {
          ui.sel = ui.sel === from ? '' : from;
          bump();
        }
      }
    });
    root.addEventListener('pointercancel', function () { clearDrag(); });
    root.addEventListener('contextmenu', function (ev) {
      var sqEl = ev.target && ev.target.closest ? ev.target.closest('[data-sq]') : null;
      if (!sqEl) return;
      if (!ui.premoves.length) return;
      ev.preventDefault();
      ui.premoves = ui.premoves.slice(0, -1);
      ui.sel = '';
      bump();
    });
    root.addEventListener('click', function (ev) {
      var sqEl = ev.target && ev.target.closest ? ev.target.closest('[data-sq]') : null;
      if (!sqEl || ui.drag) return;
      var buffer = orbit.state.active();
      var game = getState(buffer);
      if (game.status !== 'playing' || viewingGame(game)._replay || ui.pendingMove) return;
      var color = myColor(orbit, game);
      if (!color) return;
      var myTurn = game.turn === color;
      if (!myTurn && !premoveOn(orbit)) return;
      var name = sqEl.getAttribute('data-sq');
      if (!ui.sel || ui.sel === name) return;
      var piece = pieceAt(game.fen, name);
      if (piece && pieceColor(piece) === color) return;
      tryMove(orbit, buffer, ui.sel, name);
    });
  }

  function onClick(orbit, buffer, ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act],[data-promo]') : null;
    if (!el) return;
    ev.preventDefault();
    var act = el.getAttribute('data-act');
    var promo = el.getAttribute('data-promo');
    var val = el.getAttribute('data-val');

    function sent(name, arg) {
      var ok = sendEcCmd(orbit, buffer, name, arg);
      if (!ok) patchState(buffer, { flash: pick({ fr: 'Envoi TAGMSG impossible', en: 'TAGMSG send failed' }) });
      return ok;
    }
    function sentWait(actName, name, arg, extra) {
      if (ui.cmdBusy) return false;
      setCmdBusy(actName, 12000, extra);
      var ok = sent(name, arg);
      if (!ok) { clearCmdBusy(); bump(); }
      return ok;
    }
    if ({
      'start-setup': 1, start: 1, 'start-w': 1, 'start-b': 1, duo: 1,
      join: 1, draw: 1, abort: 1, resign: 1, revoir: 1, home: 1,
    }[act] && ui.cmdBusy) return;

    if (act === 'setup-vs' || act === 'setup-skill' || act === 'setup-color' || act === 'setup-tc' || act === 'setup-duo') {
      var key = act.replace('setup-', '');
      ui.setup[key] = val;
      bump();
      return;
    }
    if (act === 'invite-pick') {
      ui.setup.invite = val || '';
      bump();
      return;
    }
    if (act === 'view-full') { setViewMode(orbit, VIEW_FULL); return; }
    if (act === 'view-split') { setViewMode(orbit, VIEW_SPLIT); return; }
    if (act === 'view-chat') { setViewMode(orbit, VIEW_CHAT); return; }
    if (act === 'settings') { ui.settings = !ui.settings; bump(); return; }
    if (act === 'tour-done') { markOnboarded(orbit); bump(); return; }
    if (act === 'tour-toggle') {
      if (ui.tour || !hasOnboarded(orbit)) {
        markOnboarded(orbit);
        bump();
      } else {
        startTour(orbit);
      }
      return;
    }
    if (act === 'premove-toggle') {
      setPremoveOn(orbit, !premoveOn(orbit));
      return;
    }
    if (act === 'cc-toggle') {
      if (ui.ccBusy) return;
      var gameNow = getState(buffer);
      var wantOn = !!gameNow.ccOptout;
      setCcBusy(true, 8000, buffer);
      if (wantOn) {
        if (getViewMode(orbit) === VIEW_CHAT) setViewMode(orbit, VIEW_FULL);
        patchState(buffer, {
          ccOptout: false,
          ccPrompt: gameNow.chesscom ? 'linked' : 'missing',
          ccAsk: !gameNow.chesscom,
          ccErr: '',
        });
        sent('lier', 'activer');
      } else {
        patchState(buffer, {
          ccOptout: true,
          ccPrompt: 'optout',
          ccAsk: false,
          ccErr: '',
        });
        sent('lier', 'ignorer');
      }
      return;
    }
    if (act === 'start-setup') {
      if (ui.setup.vs === 'duo' && ui.setup.duo === 'friend' && !String(ui.setup.invite || '').trim()) {
        patchState(buffer, { flash: 'Indique le pseudo de ton ami.' });
        return;
      }
      archiveGame = null;
      sentWait('start-setup', 'commencer', startArg());
      return;
    }
    if (act === 'start') { sentWait('start', 'commencer', startArg()); return; }
    if (act === 'start-w') { sentWait('start-w', 'commencer', 'blancs ' + (ui.setup.skill || '') + ' ' + (ui.setup.tc || '')); return; }
    if (act === 'start-b') { sentWait('start-b', 'commencer', 'noirs ' + (ui.setup.skill || '') + ' ' + (ui.setup.tc || '')); return; }
    if (act === 'duo') { sentWait('duo', 'commencer', 'duo ' + (ui.setup.tc || '')); return; }
    if (act === 'join') { sentWait('join', 'rejoindre'); return; }
    if (act === 'draw') { sentWait('draw', 'nul'); return; }
    if (act === 'abort') { sentWait('abort', 'annuler'); return; }
    if (act === 'resign') { sentWait('resign', 'abandonner'); return; }
    if (act === 'elo') { sent('elo'); return; }
    if (act === 'lier-oui') {
      if (ui.ccBusy) return;
      setCcBusy(true, 20000, buffer);
      bump();
      sent('lier', 'oui');
      return;
    }
    if (act === 'lier-non') { sent('lier', 'non'); return; }
    if (act === 'lier-skip') {
      setCcBusy(true, 8000, buffer);
      patchState(buffer, { ccOptout: true, ccPrompt: 'optout', ccAsk: false, ccErr: '' });
      sent('lier', 'ignorer');
      return;
    }
    if (act === 'lier') {
      if (ui.ccBusy) return;
      var inp = document.getElementById('oec-cc');
      var user = inp ? String(inp.value || '').trim() : String(ui.ccUser || '').trim();
      if (!user) { patchState(buffer, { ccErr: 'Indique un pseudo Chess.com' }); return; }
      ui.ccUser = user;
      setCcBusy(true, 20000, buffer);
      bump();
      sent('lier', 'chesscom ' + user);
      return;
    }
    if (act === 'home') {
      var prev = getState(buffer);
      ui.navPly = -1;
      archiveGame = null;
      var kept = keepProfile(prev);
      var me = myNick(orbit);
      if (prev.status === 'ended' && !prev._archive && me) {
        var mineW = String(prev.white || '').toLowerCase() === me;
        var mineB = String(prev.black || '').toLowerCase() === me;
        var nextElo = mineW ? prev.eloW : (mineB ? prev.eloB : '');
        if (nextElo && String(nextElo) !== 'IA') {
          if (String(kept.elo) !== String(nextElo)) {
            kept.eloGames = String((Number(kept.eloGames) || 0) + 1);
          }
          kept.elo = String(nextElo);
        }
      }
      patchState(buffer, Object.assign(defaultState(), kept));
      sent('historique');
      sent('elo');
      return;
    }
    if (act === 'revoir') {
      var liveNow = getState(buffer);
      if (liveNow.status === 'playing' || liveNow.status === 'waiting') {
        patchState(buffer, { flash: 'Termine ou annule la partie en cours pour revoir une ancienne.' });
        return;
      }
      sentWait('revoir', 'revoir', val, val);
      return;
    }
    if (act === 'nav-start' || act === 'nav-prev' || act === 'nav-next' || act === 'nav-end' || act === 'nav-ply') {
      var game = archiveGame || getState(buffer);
      var n = splitUcis(game.ucis).length;
      var cur = ui.navPly < 0 ? n : ui.navPly;
      if (act === 'nav-start') ui.navPly = 0;
      else if (act === 'nav-prev') ui.navPly = Math.max(0, cur - 1);
      else if (act === 'nav-next') ui.navPly = Math.min(n, cur + 1);
      else if (act === 'nav-ply') ui.navPly = Math.max(0, Math.min(n, Number(val) || 0));
      else ui.navPly = game.status === 'ended' ? n : -1;
      if (game.status !== 'ended' && ui.navPly === n) ui.navPly = -1;
      bump();
      return;
    }

    if (promo && ui.promo) {
      var pm = ui.promo;
      ui.promo = null;
      ui.sel = '';
      if (pm.premove) queuePremove(pm.from, pm.to, promo);
      else tryMove(orbit, buffer, pm.from, pm.to, promo);
      return;
    }
  }

  function mountDomPanel(orbit) {
    var buf = orbit.state.active();
    var on = isChessChannel(orbit, buf);
    var show = on && (cfg(orbit).showWhenIdle || isPlaying(getState(buf)) || getState(buf).status === 'ended' || getViewMode(orbit) !== VIEW_CHAT);
    var root = document.getElementById('oec-dom-panel');
    var main = document.querySelector('.main');
    var topbar = main && main.querySelector('.topbar');
    if (!on || isBouncerSession(orbit)) {
      clearShellLayout();
      bumpView();
      return;
    }
    if (!root) {
      root = document.createElement('div');
      root.id = 'oec-dom-panel';
      root.className = 'oec-panel';
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', 'Échecs');
    }
    if (!root.__oecBound) {
      root.__oecBound = true;
      root.addEventListener('click', function (ev) {
        var b = orbit.state.active();
        if (isChessChannel(orbit, b)) onClick(orbit, b, ev);
      });
      bindBoardPointer(root, orbit);
      root.addEventListener('input', function (ev) {
        if (ev.target && ev.target.id === 'oec-cc') ui.ccUser = ev.target.value;
        if (ev.target && ev.target.id === 'oec-invite') {
          ui.setup.invite = ev.target.value;
          applyInviteFilter(root);
        }
      });
      root.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' || !ev.target || ev.target.id !== 'oec-cc') return;
        ev.preventDefault();
        var btn = root.querySelector('[data-act="lier"]');
        if (btn && !btn.disabled) btn.click();
      });
    }
    if (main && topbar && root.parentNode !== main) {
      topbar.insertAdjacentElement('afterend', root);
    }
    maybeFirstVisitGame(orbit);
    applyViewMode(orbit, getViewMode(orbit));
    if (ui.drag) return;
    var g = archiveGame || getState(buf);
    var live = getState(buf);
    var tick = (live.status === 'playing' && live.tc && live.tc !== 'casual') ? Math.floor(Date.now() / 400) : 0;
    var sig = store.rev + '|' + buf + '|' + ui.sel + '|' + (ui.promo ? ui.promo.to : '') + '|' +
      getViewMode(orbit) + '|' + ui.navPly + '|' + tick + '|' + (ui.settings ? '1' : '0') + '|' +
      (ui.tour ? 't' : '0') + '|' +
      (ui.ccBusy ? '1' : '0') + '|' + (ui.cmdBusy || '') + (ui.cmdBusyVal || '') + '|' +
      (ui.pendingMove ? ui.pendingMove.uci : '') + '|' +
      'u' + chatUnread + '|' +
      (ui.setup.vs || '') + (ui.setup.skill || '') + (ui.setup.tc || '') + (ui.setup.duo || '') + '|' +
      (archiveGame ? archiveGame.gid : '') + '|' +
      (ui.premoves || []).map(function (p) { return p.from + p.to + (p.promo || ''); }).join(',');
    if (root.__oecSig === sig) return;
    root.__oecSig = sig;
    renderPanel(orbit, root, buf);
  }

  Orbit.plugin('orbit-echecs', function (orbit, log) {
    pluginOrbit = orbit;
    viewMode = getViewMode(orbit);
    injectStyles();
    console.info('[orbit-echecs] loaded v' + OEC_VER);
    setTimeout(function () { chatBadgeArmed = true; }, 800);
    if (orbit.requireVisualDisplay) {
      orbit.requireVisualDisplay({
        label: 'Échecs',
        inChannel: function (ch) { return isChessChannel(orbit, ch); },
      });
    }

    function syncDom() {
      try { mountDomPanel(orbit); } catch (e) { console.error('[orbit-echecs] panel', e); }
    }

    subscribe(syncDom);
    window.addEventListener('resize', fitPanelToViewport);
    window.addEventListener('orientationchange', fitPanelToViewport);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitPanelToViewport);
      window.visualViewport.addEventListener('scroll', fitPanelToViewport);
    }

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '').toUpperCase();
      if (cmd === 'PRIVMSG' || cmd === 'NOTICE') {
        noteIncomingChat(orbit, msg);
        return;
      }
      if (cmd !== 'TAGMSG') return;
      var tags = msg.tags || {};
      if (tagVal(tags, EC) !== 'v1') return;
      var target = (msg.params && msg.params[0]) || '';
      if (!isChannelName(target)) return;
      if (!isChessChannel(orbit, target)) return;
      handleEvent(target, tags);
      log('orbit-echecs', tagVal(tags, EV), target);
    });

    orbit.on('buffer.active', function () {
      var buf = orbit.state.active();
      if (isChessChannel(orbit, buf)) maybeRequestSync(orbit, buf, getState(buf));
      syncDom();
      bumpView();
    });
    orbit.on('connected', syncDom);
    orbit.on('status', syncDom);
    setInterval(syncDom, 400);

    orbit.addCommand('echecs', {
      help: pick({ fr: 'Afficher le plateau d’échecs', en: 'Show the chess board' }),
      run: function () {
        var buf = orbit.state.active();
        if (!buf || !isChessChannel(orbit, buf)) {
          orbit.notify('Échecs', pick({ fr: 'Ouvrez #Echecs.chat d’abord.', en: 'Open #Echecs.chat first.' }));
          return;
        }
        setViewMode(orbit, VIEW_FULL);
        sendEcCmd(orbit, buf, 'sync');
        syncDom();
      },
    });

    log('orbit-echecs ready');
  });

  }

  boot(0);
})();
