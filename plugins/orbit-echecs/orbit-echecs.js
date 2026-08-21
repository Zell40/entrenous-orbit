/*!
 * orbit-echecs — plateau d’échecs Orbit pour CapEchecs (EntreNous)
 * Reçoit +ec=v1 TAGMSG (état / coups) et envoie +ev=cmd (sans PRIVMSG).
 */
(function () {
  'use strict';

  var OEC_VER = 11;

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
  var pluginOrbit = null;
  var syncRequestAt = Object.create(null);
  var viewMode = VIEW_FULL;
  var viewListeners = new Set();

  var store = { byChannel: Object.create(null), rev: 0, listeners: new Set() };
  var ui = {
    sel: '', promo: null, drag: null, navPly: -1,
    setup: { vs: 'ai', skill: 'moyen', tc: 'blitz', color: 'random' },
  };
  var HOME_IMG = '/app/plugins/third/orbit-echecs/assets/echecs-home.jpg';

  function subscribe(cb) { store.listeners.add(cb); return function () { store.listeners.delete(cb); }; }
  function bump() { store.rev++; store.listeners.forEach(function (l) { l(); }); }
  function subscribeView(cb) { viewListeners.add(cb); return function () { viewListeners.delete(cb); }; }
  function bumpView() { viewListeners.forEach(function (l) { l(); }); }

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
    if (!channelKey) return false;
    var n = normChan(resolveChannelName(orbit, channelKey));
    if (!isChannelName(n)) return false;
    if (/echecs|chess/i.test(n)) return true;
    var c = cfg(orbit);
    if (c.channelsAll) return true;
    return c.channels.indexOf(n) >= 0;
  }

  function tagVal(tags, name) {
    if (!tags) return '';
    if (Object.prototype.hasOwnProperty.call(tags, name)) return String(tags[name] || '');
    var alt = name.charAt(0) === '+' ? name.slice(1) : '+' + name;
    if (Object.prototype.hasOwnProperty.call(tags, alt)) return String(tags[alt] || '');
    return '';
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
  }

  function defaultState() {
    return {
      status: 'idle', mode: '', white: '', black: '', creator: '', invited: '',
      fen: START_FEN, turn: 'white', ply: 0, lastUci: '', lastSan: '',
      from: '', to: '', capW: '', capB: '', sans: '', ucis: '', waiting: false,
      result: '', reason: '', winner: '', flash: '', gid: '', updatedAt: 0,
      opening: '', skill: '', tc: 'casual', clockW: 0, clockB: 0, clockInc: 0,
      clockAt: 0, rated: false, duration: 0, elo: '', eloGames: '',
      chesscom: '', ccRapid: '', ccBlitz: '', ccBullet: '',
      eloW: '', eloB: '', eloDw: '',
      ccAsk: false, ccName: '', ccTitle: '', ccCountry: '',
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

  function gridToFen(grid, turn) {
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
    return ranks.join('/') + '_' + (turn === 'black' ? 'b' : 'w') + '_KQkq_-_0_1';
  }

  function applyUciFen(fenTag, uci) {
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
    if (piece.toLowerCase() === 'k' && Math.abs(to.f - from.f) === 2) {
      if (to.f === 6) { grid[to.r][5] = grid[to.r][7]; grid[to.r][7] = null; }
      else if (to.f === 2) { grid[to.r][3] = grid[to.r][0]; grid[to.r][0] = null; }
    }
    if (piece.toLowerCase() === 'p' && from.f !== to.f && !dest) {
      grid[from.r][to.f] = null;
    }
    grid[from.r][from.f] = null;
    if (promo) {
      var up = piece === piece.toUpperCase();
      piece = up ? promo.toUpperCase() : promo.toLowerCase();
    }
    grid[to.r][to.f] = piece;
    return gridToFen(grid, parsed.turn === 'white' ? 'black' : 'white');
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
    if (s.vs === 'duo') parts.push('duo');
    else {
      if (s.skill) parts.push(s.skill);
      if (s.color === 'white') parts.push('blancs');
      if (s.color === 'black') parts.push('noirs');
    }
    if (s.tc && s.tc !== 'casual') parts.push(s.tc);
    return parts.join(' ');
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

  function eventForMe(tags) {
    var who = String(tagVal(tags, '+nick') || '').toLowerCase();
    if (!who) return true;
    var me = myNick(pluginOrbit);
    return me && who === me;
  }

  function keepProfile(prev) {
    return {
      elo: prev.elo, eloGames: prev.eloGames, chesscom: prev.chesscom,
      ccRapid: prev.ccRapid, ccBlitz: prev.ccBlitz, ccBullet: prev.ccBullet,
      ccAsk: prev.ccAsk, ccName: prev.ccName, ccTitle: prev.ccTitle, ccCountry: prev.ccCountry,
    };
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

  function reasonFr(code) {
    var map = {
      mate: 'Échec et mat', stalemate: 'Pat', insufficient: 'Matériel insuffisant',
      fifty: 'Règle des 50 coups', threefold: 'Triple répétition', resign: 'Abandon',
      abort: 'Partie annulée', timeout: 'Délai dépassé', inactivity: 'Inactivité',
      agree: 'Nulle acceptée', quit: 'Déconnexion', part: 'Départ',
      flag: 'Temps écoulé', engine: 'Erreur moteur',
    };
    return map[code] || code || '';
  }

  function handleEvent(channel, tags) {
    if (tagVal(tags, EC) !== 'v1') return;
    var ev = tagVal(tags, EV);
    if (!ev || ev === 'cmd') return;
    var gid = tagVal(tags, '+gid');
    var prev = getState(channel);
    if (gid && prev.gid && gid !== prev.gid && ev !== 'game_end') {
      ui.sel = '';
      ui.promo = null;
    }

    if (ev === 'waiting') {
      ui.sel = '';
      ui.navPly = -1;
      patchState(channel, {
        status: 'waiting', waiting: true, mode: tagVal(tags, '+mode') || 'pvp',
        creator: tagVal(tags, '+creator'), invited: tagVal(tags, '+invited'),
        gid: gid || prev.gid, result: '', reason: '', flash: '',
        tc: tagVal(tags, '+tc') || prev.tc,
      });
      return;
    }

    if (ev === 'elo_sync') {
      if (!eventForMe(tags)) return;
      var linked = tagVal(tags, '+chesscom') || prev.chesscom;
      patchState(channel, {
        elo: tagVal(tags, '+elo') || prev.elo,
        eloGames: tagVal(tags, '+games') || prev.eloGames,
        chesscom: linked,
        ccRapid: tagVal(tags, '+cc-rapid') || prev.ccRapid,
        ccBlitz: tagVal(tags, '+cc-blitz') || prev.ccBlitz,
        ccBullet: tagVal(tags, '+cc-bullet') || prev.ccBullet,
        ccName: tagVal(tags, '+cc-name') || prev.ccName,
        ccTitle: tagVal(tags, '+cc-title') || prev.ccTitle,
        ccCountry: tagVal(tags, '+cc-country') || prev.ccCountry,
        ccAsk: linked ? false : prev.ccAsk,
      });
      return;
    }

    if (ev === 'cc_ask') {
      if (!eventForMe(tags)) return;
      patchState(channel, {
        ccAsk: true,
        flash: tagVal(tags, '+text') || 'Indique ton pseudo Chess.com',
      });
      return;
    }

    if (ev === 'game_start' || ev === 'state_sync' || ev === 'move') {
      var fen = tagVal(tags, '+fen') || (ev === 'game_start' ? START_FEN : prev.fen);
      var parsed = parseFen(fen);
      var status = tagVal(tags, '+status') || (tagVal(tags, '+waiting') === '1' ? 'waiting' : 'playing');
      if (ev === 'game_start') { status = 'playing'; ui.navPly = -1; }
      if (ev === 'move') { ui.sel = ''; ui.promo = null; ui.navPly = -1; }
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
        ply: Number(tagVal(tags, '+ply')) || prev.ply,
        lastUci: tagVal(tags, '+uci') || tagVal(tags, '+last-uci') || prev.lastUci,
        lastSan: tagVal(tags, '+san-fr') || tagVal(tags, '+last-san-fr') || prev.lastSan,
        from: tagVal(tags, '+from') || prev.from,
        to: tagVal(tags, '+to') || prev.to,
        capW: tagVal(tags, '+cap-w') || prev.capW,
        capB: tagVal(tags, '+cap-b') || prev.capB,
        sans: tagVal(tags, '+sans') || prev.sans,
        ucis: tagVal(tags, '+ucis') || (ev === 'move' && tagVal(tags, '+uci')
          ? (prev.ucis ? prev.ucis + ',' + tagVal(tags, '+uci') : tagVal(tags, '+uci'))
          : prev.ucis),
        opening: tagVal(tags, '+opening') || prev.opening,
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
      });
      return;
    }

    if (ev === 'illegal') {
      ui.sel = '';
      ui.promo = null;
      var why = tagVal(tags, '+reason');
      patchState(channel, {
        flash: ({
          illegal: 'Coup illégal', 'not-turn': 'Ce n’est pas votre tour',
          waiting: 'En attente d’un adversaire', 'no-game': 'Aucune partie en cours',
        }[why] || 'Coup refusé'),
      });
      return;
    }

    if (ev === 'draw_offer') {
      patchState(channel, { flash: (tagVal(tags, '+nick') || 'L’adversaire') + ' propose nulle' });
      return;
    }

    if (ev === 'game_end') {
      ui.sel = '';
      ui.promo = null;
      var endUcis = tagVal(tags, '+ucis') || prev.ucis;
      var endPly = Number(tagVal(tags, '+ply')) || splitUcis(endUcis).length;
      ui.navPly = endPly;
      patchState(channel, {
        status: 'ended', waiting: false, fen: tagVal(tags, '+fen') || prev.fen,
        result: tagVal(tags, '+result'), reason: tagVal(tags, '+reason'),
        winner: tagVal(tags, '+winner'), flash: '', gid: gid || prev.gid,
        sans: tagVal(tags, '+sans') || prev.sans,
        ucis: endUcis,
        opening: tagVal(tags, '+opening') || prev.opening,
        skill: tagVal(tags, '+skill') || prev.skill,
        tc: tagVal(tags, '+tc') || prev.tc,
        duration: Number(tagVal(tags, '+duration')) || prev.duration,
        white: tagVal(tags, '+white') || prev.white,
        black: tagVal(tags, '+black') || prev.black,
        ply: endPly,
        eloW: tagVal(tags, '+elo-w'),
        eloB: tagVal(tags, '+elo-b'),
        eloDw: tagVal(tags, '+elo-dw'),
      });
      return;
    }

    if (ev === 'cmd_err') {
      var err = tagVal(tags, '+text');
      if (err === 'idle') {
        ui.sel = '';
        ui.promo = null;
        ui.navPly = -1;
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
    var fill = white ? '#f4efe3' : '#1c1917';
    var stroke = white ? '#44403c' : '#0c0a09';
    var body = '';
    if (kind === 'p') {
      body = '<circle cx="22.5" cy="14" r="6.2"/><path d="M13.5 36.5h18c-1.2-4.8-3.6-8.2-6.2-10.2 2.4-1.5 4-4 4-6.8 0-1.8-.7-3.2-1.8-4.3"/>';
    } else if (kind === 'r') {
      body = '<path d="M11 13.5h4v-5h4v5h7v-5h4v5h4v5.5H11z"/><path d="M13 19h19v11.5H13z"/><path d="M11 36.5h23l-2-6H13z"/>';
    } else if (kind === 'n') {
      body = '<path d="M34 36.5H12.5c1-6 3.2-11 8.2-16.2-1.6-1.2-4.4-1.8-7.2.2 1.4-5.4 5.8-9.6 11.6-11.4 1.4 2.2 3.8 3.4 6.2 2.6-.2 3.4 1.4 6.2 4.6 7.6-3.2 2.4-5.4 6.4-5.8 11.2h4z"/>';
    } else if (kind === 'b') {
      body = '<path d="M22.5 8.5c3.4 3.2 10 8.8 10 15.2 0 5.4-4.2 8.3-10 8.3s-10-2.9-10-8.3c0-6.4 6.6-12 10-15.2z"/><path d="M13 36.5h19l-2.2-4.8H15.2z"/><path d="M18 20.5h9" fill="none"/>';
    } else if (kind === 'q') {
      body = '<circle cx="10" cy="11" r="2.4"/><circle cx="18" cy="8.2" r="2.4"/><circle cx="27" cy="8.2" r="2.4"/><circle cx="35" cy="11" r="2.4"/><path d="M10.2 13.2 15 24h15l4.8-10.8L27 16.5 22.5 10 18 16.5z"/><path d="M15 24h15l1.5 6.5H13.5z"/><path d="M12 36.5h21l-2-6H14z"/>';
    } else {
      body = '<path d="M22.5 7v6M19.5 10h6"/><path d="M16.2 15.2c3.2-2.4 9.4-2.4 12.6 0 1.6 1.2 2.4 3 2.2 5.2-2.8 1-6.8 1.6-14.8 1.6-8 0-12-.6-14.8-1.6-.2-2.2.6-4 2.2-5.2z" transform="translate(7.4 0)"/><path d="M14.5 22.5h16v7h-16z"/><path d="M12 36.5h21l-2-7H14z"/>';
    }
    return '<svg class="' + (cls || 'oec-piece') + '" viewBox="0 0 45 45" aria-hidden="true">' +
      '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">' +
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

  function applyViewMode(orbit, mode) {
    mode = normalizeViewMode(mode);
    viewMode = mode;
    var on = !!(orbit && isChessChannel(orbit, orbit.state.active()));
    var root = document.getElementById('oec-dom-panel');
    document.body.classList.toggle('oec-full', on && mode === VIEW_FULL);
    document.body.classList.toggle('oec-split', on && mode === VIEW_SPLIT);
    if (!root) return;
    root.classList.remove('oec-panel--full', 'oec-panel--split', 'oec-panel--chat');
    if (!on) return;
    if (mode === VIEW_CHAT) {
      root.classList.add('oec-panel--chat');
      root.style.display = '';
      return;
    }
    root.style.display = '';
    root.classList.add(mode === VIEW_SPLIT ? 'oec-panel--split' : 'oec-panel--full');
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
      '.oec-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;background:#1a1c19;color:#f5f5f4;font-family:var(--font,system-ui,sans-serif);display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.oec-panel--home{background:#f6f1e7;color:#3f3a32}',
      '.oec-panel--full{flex:1 1 auto;min-height:0;max-height:100%;border-bottom:0}',
      '.oec-panel--split{flex:1 1 auto;min-height:0;max-height:100%}',
      '.oec-panel--chat{flex:0 0 auto;min-height:0}',
      '.oec-panel--chat .oec-stage{display:none!important}',
      'body.oec-full .main{display:flex!important;flex-direction:column;overflow:hidden;min-height:0}',
      'body.oec-full .chan-hero,body.oec-full .messages,body.oec-full .composer,body.oec-full .main__room-bg{display:none!important}',
      'body.oec-full #oec-dom-panel{flex:1 1 auto;min-height:0;height:auto!important;max-height:calc(100dvh - 9.25rem)}',
      '@media(min-width:1000px){body.oec-split .main{display:grid!important;grid-template-columns:minmax(28rem,1.25fr) minmax(14rem,.7fr);grid-template-rows:auto auto 1fr auto;align-items:stretch;overflow:hidden}body.oec-split .topbar{grid-column:1/-1;grid-row:1}body.oec-split .main__room-bg{grid-column:2;grid-row:2/4;height:auto!important}body.oec-split #oec-dom-panel{grid-column:1;grid-row:2/-1;min-width:0;min-height:0;height:auto!important;max-height:calc(100dvh - 9.25rem)!important;overflow:hidden;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid rgba(255,255,255,.08)}body.oec-split .chan-hero{grid-column:2;grid-row:2}body.oec-split .messages{grid-column:2;grid-row:3;min-height:0}body.oec-split .composer{grid-column:2;grid-row:4}body.oec-split .main>:not(.topbar):not(#oec-dom-panel):not(.main__room-bg):not(.chan-hero):not(.messages):not(.composer){grid-column:2}}',
      '@media(max-width:999px){body.oec-split .main{display:flex;flex-direction:column;overflow:hidden}body.oec-split #oec-dom-panel{flex:0 1 auto;min-height:0;max-height:min(58vh,calc(100dvh - 12rem));overflow:hidden}body.oec-split .messages{flex:1 1 auto;min-height:8rem}}',
      '.oec-head{display:flex;align-items:center;gap:.45rem;padding:.42rem .7rem;background:linear-gradient(135deg,#14532d,#166534);color:#fff;flex:0 0 auto}',
      '.oec-head__title{font-weight:800;font-size:.88rem}',
      '.oec-head__badge{font-size:.68rem;font-weight:800;padding:.16rem .6rem;border-radius:999px;background:rgba(255,255,255,.18)}',
      '.oec-head__actions{margin-left:auto;display:flex;gap:.28rem}',
      '.oec-head__btn{border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:34px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.oec-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.oec-head__btn--on{background:rgba(255,255,255,.34)}',
      '.oec-head__btn svg{width:18px;height:18px;display:block}',
      '.oec-stage{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;gap:1.1rem;padding:.55rem .7rem .65rem;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#166534 rgba(22,101,52,.15)}',
      '.oec-stage::-webkit-scrollbar{width:8px}',
      '.oec-stage::-webkit-scrollbar-thumb{background:rgba(22,101,52,.35);border-radius:999px}',
      '.oec-panel--home .oec-stage{align-items:center;justify-content:safe center;flex-direction:column}',
      '.oec-board-wrap{width:min(100%,calc(100dvh - 7.2rem));max-width:min(72dvh,100%);flex:0 0 auto}',
      'body.oec-split .oec-stage{flex-direction:column;align-items:stretch;justify-content:flex-start;gap:.65rem}',
      'body.oec-split .oec-board-wrap{width:min(100%,calc(100dvh - 9.5rem));max-width:100%;margin:0 auto}',
      'body.oec-split .oec-meta{max-width:none;width:100%;flex:0 0 auto}',
      '.oec-board{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));grid-template-rows:repeat(8,minmax(0,1fr));width:100%;aspect-ratio:1/1;height:auto;border-radius:10px;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.35),inset 0 0 0 2px rgba(255,255,255,.08);touch-action:none;user-select:none}',
      '.oec-sq{position:relative;display:grid;place-items:center;min-width:0;min-height:0;width:100%;height:100%;overflow:hidden;cursor:pointer}',
      '.oec-sq--light{background:#eed7ac}',
      '.oec-sq--dark{background:#b58863}',
      '.oec-sq--last{box-shadow:inset 0 0 0 100px rgba(205,210,106,.42)}',
      '.oec-sq--sel,.oec-sq--drag{box-shadow:inset 0 0 0 3px #14532d}',
      '.oec-sq--over{outline:3px solid #facc15;outline-offset:-3px}',
      '.oec-sq__coord{position:absolute;font-size:.62rem;font-weight:800;opacity:.55;pointer-events:none;line-height:1}',
      '.oec-sq__coord--file{right:3px;bottom:3px}',
      '.oec-sq__coord--rank{left:3px;top:3px}',
      '.oec-sq--dark .oec-sq__coord{color:#f5e6cc}',
      '.oec-sq--light .oec-sq__coord{color:#6b4f34}',
      '.oec-piece{width:86%;height:86%;max-width:100%;max-height:100%;filter:drop-shadow(0 2px 2px rgba(0,0,0,.28));pointer-events:none}',
      '.oec-piece--mini{width:18px;height:18px;filter:none}',
      '.oec-piece--ghost{position:fixed;width:56px;height:56px;z-index:80;pointer-events:none;transform:translate(-50%,-50%);filter:drop-shadow(0 8px 12px rgba(0,0,0,.4))}',
      '.oec-meta{flex:0 1 16rem;min-width:12rem;max-width:18rem}',
      '.oec-players{margin:0 0 .5rem;font-size:.86rem;line-height:1.5}',
      '.oec-clock{display:flex;flex-direction:column;gap:.28rem;margin:0 0 .7rem}',
      '.oec-clock span{display:flex;justify-content:space-between;background:rgba(255,255,255,.06);border-radius:10px;padding:.4rem .55rem;font-weight:700}',
      '.oec-clock span b{font-weight:800}',
      '.oec-clock span.is-turn{outline:2px solid #86efac}',
      '.oec-clock__time{font-variant-numeric:tabular-nums;font-size:1.05rem;letter-spacing:.02em}',
      '.oec-opening{margin:0 0 .45rem;font-size:.8rem;font-weight:700;color:#fde68a}',
      '.oec-nav{display:flex;flex-wrap:wrap;gap:.3rem;margin:.35rem 0}',
      '.oec-review{margin:.45rem 0;padding:.65rem .7rem;border-radius:12px;background:#14532d;color:#ecfdf5;font-size:.82rem;line-height:1.45}',
      '.oec-review h3{margin:0 0 .35rem;font-size:.9rem}',
      '.oec-review dl{display:grid;grid-template-columns:auto 1fr;gap:.12rem .7rem;margin:0}',
      '.oec-review dt{opacity:.75}',
      '.oec-review dd{margin:0;font-weight:700}',
      '.oec-turn{margin:0 0 .5rem;font-size:.8rem;font-weight:800;color:#86efac}',
      '.oec-caps{display:flex;flex-wrap:wrap;gap:.1rem;min-height:1.3em;margin:0 0 .35rem}',
      '.oec-sans{font-size:.72rem;color:#a8a29e;max-height:5.2rem;overflow:auto;line-height:1.45}',
      '.oec-flash{margin:.4rem 0;padding:.45rem .55rem;border-radius:8px;background:#fef3c7;color:#92400e;font-size:.78rem;font-weight:700}',
      '.oec-end{margin:.4rem 0;padding:.5rem .6rem;border-radius:8px;background:#14532d;color:#bbf7d0;font-size:.82rem;font-weight:800}',
      '.oec-actions{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.55rem}',
      '.oec-btn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f5f5f4;border-radius:999px;padding:.4rem .75rem;font-size:.76rem;font-weight:800;cursor:pointer;min-height:34px}',
      '.oec-btn:hover{border-color:#86efac;color:#bbf7d0}',
      '.oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '.oec-btn--danger{color:#fecaca;border-color:#7f1d1d}',
      '.oec-idle{text-align:left;width:min(42rem,100%);max-width:42rem;margin:auto;color:#3f3a32;display:flex;flex-direction:column;gap:.45rem;min-height:min-content;flex:0 1 auto}',
      '.oec-hero{position:relative;border-radius:14px;overflow:hidden;margin:0;flex:0 0 auto;background:#e8dcc4}',
      '.oec-hero img{display:block;width:100%;height:clamp(4.2rem,14vh,6.6rem);object-fit:cover}',
      '.oec-hero__label{position:absolute;left:.75rem;bottom:.55rem;margin:0;color:#fff;font-size:1.05rem;font-weight:800;text-shadow:0 2px 10px rgba(0,0,0,.45)}',
      '.oec-home-lead{margin:0;color:#5c564c;font-size:.8rem;line-height:1.35}',
      '.oec-home-grid{display:grid;grid-template-columns:1fr 1fr;gap:.45rem}',
      '.oec-home-grid .oec-card--wide{grid-column:1/-1}',
      '.oec-card{background:#fff;border:1px solid #e4d9c5;border-radius:12px;padding:.5rem .6rem;margin:0;box-shadow:0 6px 16px rgba(92,70,40,.07)}',
      '.oec-card--ask{border-color:#ea580c;background:#fff7ed}',
      '.oec-card--ask h3{color:#c2410c}',
      '.oec-card h3{margin:0 0 .32rem;font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:#6b7c4a}',
      '.oec-pills{display:flex;flex-wrap:wrap;gap:.28rem}',
      '.oec-pill{border:1px solid #d7ccb8;background:#faf6ee;color:#3f3a32;border-radius:999px;padding:.26rem .55rem;font-size:.72rem;font-weight:800;cursor:pointer;min-height:30px}',
      '.oec-pill.is-on{background:#166534;border-color:#166534;color:#fff}',
      '.oec-elo{display:flex;flex-wrap:wrap;gap:.35rem .9rem;margin:0;font-size:.78rem}',
      '.oec-elo b{color:#14532d}',
      '.oec-link{display:flex;gap:.35rem;margin-top:.4rem}',
      '.oec-link input{flex:1;min-width:0;border:1px solid #d7ccb8;border-radius:10px;padding:.32rem .5rem;font-size:.8rem;background:#fff;color:#3f3a32}',
      '.oec-home-actions{position:sticky;bottom:0;z-index:2;margin:0;padding:.4rem 0 .1rem;background:linear-gradient(180deg,rgba(246,241,231,0) 0%,#f6f1e7 38%)}',
      '.oec-home-actions .oec-btn--pri{width:100%;min-height:38px}',
      '.oec-panel--home .oec-btn{border-color:#cfc3ad;background:#fff;color:#3f3a32}',
      '.oec-panel--home .oec-btn:hover{border-color:#166534;color:#14532d}',
      '.oec-panel--home .oec-btn--pri{background:#166534;border-color:#166534;color:#fff}',
      '@media(max-width:640px){.oec-home-grid{grid-template-columns:1fr}.oec-hero img{height:clamp(3.6rem,12vh,5.4rem)}.oec-hero__label{font-size:.95rem}}',
      '.oec-promo{display:flex;gap:.35rem;margin:.45rem 0}',
      '.oec-promo button{width:2.6rem;height:2.6rem;border-radius:10px;border:1px solid #166534;background:#fff;cursor:pointer;padding:.2rem}',
      '@media(max-width:720px){.oec-stage{flex-direction:column;overflow:auto}.oec-meta{max-width:none;width:100%}.oec-board-wrap{width:min(100%,calc(100vw - 1.6rem))}}',
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
    }
    return view;
  }

  function renderBoard(orbit, game) {
    var parsed = parseFen(game.fen);
    var flip = myColor(orbit, game) === 'black';
    var lastFrom = game.from || (game.lastUci && game.lastUci.slice(0, 2)) || '';
    var lastTo = game.to || (game.lastUci && game.lastUci.slice(2, 4)) || '';
    var color = myColor(orbit, game);
    var myTurn = game.status === 'playing' && color && game.turn === color && !game._replay;
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
        if (name === ui.sel) cls += ' oec-sq--sel';
        var showFile = rank === (flip ? 7 : 0);
        var showRank = file === (flip ? 7 : 0);
        html += '<div class="' + cls + '" data-sq="' + escHtml(name) + '"' +
          (myTurn && piece && pieceColor(piece) === color ? ' data-mine="1"' : '') + '>';
        if (showFile) html += '<span class="oec-sq__coord oec-sq__coord--file">' + 'abcdefgh'.charAt(file) + '</span>';
        if (showRank) html += '<span class="oec-sq__coord oec-sq__coord--rank">' + (rank + 1) + '</span>';
        if (piece) html += pieceSvg(piece);
        html += '</div>';
      });
    });
    html += '</div></div>';
    return html;
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
        '" data-act="' + paneAct + '" title="' + escHtml(paneTitle) + '">' + iconSvg(paneIcon) + '</button>' +
      '<button type="button" class="oec-head__btn" data-act="sync" title="Sync">↻</button>' +
      '</div>';
  }

  function pill(act, val, label, current) {
    return '<button type="button" class="oec-pill' + (current === val ? ' is-on' : '') +
      '" data-act="' + act + '" data-val="' + val + '">' + label + '</button>';
  }

  function renderHome(orbit, game) {
    var s = ui.setup;
    var eloLine = game.elo
      ? 'ELO EntreNous <b>' + escHtml(game.elo) + '</b>' +
        (game.eloGames ? ' · ' + escHtml(game.eloGames) + ' parties' : '')
      : 'ELO EntreNous <b>1200</b> (provisoire)';
    var cc;
    var ccCardCls = 'oec-card oec-card--wide' + (game.ccAsk && !game.chesscom ? ' oec-card--ask' : '');
    if (game.chesscom) {
      cc = (game.ccTitle ? escHtml(game.ccTitle) + ' ' : '') +
        '<b>' + escHtml(game.ccName || game.chesscom) + '</b>' +
        (game.ccCountry ? ' · ' + escHtml(game.ccCountry) : '') +
        ' — blitz ' + escHtml(game.ccBlitz || '—') +
        ', rapide ' + escHtml(game.ccRapid || '—') +
        ', bullet ' + escHtml(game.ccBullet || '—');
    } else if (game.ccAsk) {
      cc = 'Aucun compte Chess.com pour ton identifiant Anope. Indique ton pseudo, il sera mémorisé.';
    } else {
      cc = 'Liez votre compte Chess.com pour afficher votre classement.';
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
          pill('setup-skill', 'debutant', 'Débutant', s.skill) +
          pill('setup-skill', 'facile', 'Facile', s.skill) +
          pill('setup-skill', 'moyen', 'Moyen', s.skill) +
          pill('setup-skill', 'difficile', 'Difficile', s.skill) +
          pill('setup-skill', 'expert', 'Expert', s.skill) +
          '</div></div>'
        : '') +
      '<div class="oec-card oec-card--wide"><h3>Cadence</h3><div class="oec-pills">' +
      pill('setup-tc', 'casual', 'Illimité', s.tc) +
      pill('setup-tc', 'bullet', 'Bullet 1+0', s.tc) +
      pill('setup-tc', 'blitz', 'Blitz 3+2', s.tc) +
      pill('setup-tc', 'rapide', 'Rapide 10+0', s.tc) +
      pill('setup-tc', 'classique', 'Classique 15+10', s.tc) +
      '</div></div>' +
      '<div class="' + ccCardCls + '"><h3>' +
      (game.ccAsk && !game.chesscom ? 'Compte Chess.com requis' : 'Classement') +
      '</h3><p class="oec-elo"><span>' + eloLine +
      '</span><span>' + cc + '</span></p>' +
      '<div class="oec-link"><input id="oec-cc" type="text" placeholder="pseudo Chess.com" value="' +
      escHtml(game.chesscom || '') + '">' +
      '<button type="button" class="oec-btn" data-act="lier">Lier</button>' +
      '<button type="button" class="oec-btn" data-act="elo">Mon ELO</button></div></div>' +
      '</div>' +
      '<div class="oec-actions oec-home-actions">' +
      '<button type="button" class="oec-btn oec-btn--pri" data-act="start-setup">Lancer la partie</button>' +
      '</div></div>';
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

  function renderReview(game) {
    var dur = Number(game.duration) || 0;
    var mm = Math.floor(dur / 60);
    var ss = dur % 60;
    var durStr = mm + ' min ' + (ss < 10 ? '0' : '') + ss + ' s';
    var eloBit = '';
    if (game.eloW || game.eloB) {
      eloBit = '<dt>ELO</dt><dd>' + escHtml(game.white) + ' ' + escHtml(game.eloW || '—') +
        ' · ' + escHtml(game.black) + ' ' + escHtml(game.eloB || '—') +
        (game.eloDw ? ' (' + (Number(game.eloDw) > 0 ? '+' : '') + escHtml(game.eloDw) + ' Blancs)</dd>' : '</dd>');
    }
    return '<div class="oec-review"><h3>Bilan de la partie</h3><dl>' +
      '<dt>Résultat</dt><dd>' + escHtml(game.result || '') +
      (game.reason ? ' — ' + escHtml(reasonFr(game.reason)) : '') + '</dd>' +
      '<dt>Ouverture</dt><dd>' + escHtml(game.opening || 'Hors livre') + '</dd>' +
      '<dt>Coups</dt><dd>' + escHtml(String(game.ply || 0)) + '</dd>' +
      '<dt>Cadence</dt><dd>' + escHtml(game.tc || 'illimité') +
      (game.skill ? ' · IA ' + escHtml(game.skill) : '') + '</dd>' +
      '<dt>Durée</dt><dd>' + durStr + '</dd>' +
      eloBit +
      '</dl></div>';
  }

  function renderPanel(orbit, root, buffer) {
    var game = getState(buffer);
    var view = viewingGame(game);
    var mode = getViewMode(orbit);
    var badge = game.status === 'playing' ? (game.mode === 'ai' ? 'IA' : 'Duo')
      : game.status === 'waiting' ? 'En attente'
      : game.status === 'ended' ? escHtml(game.result || 'Fin')
      : 'Prêt';
    if (game.tc && game.tc !== 'casual' && game.status !== 'idle') badge += ' · ' + game.tc;
    var head = '<div class="oec-head"><span class="oec-head__title">Échecs</span>' +
      '<span class="oec-head__badge">' + badge + '</span>' + viewBtns(mode) + '</div>';

    var body = '<div class="oec-stage">';
    if (game.status === 'idle') {
      body += renderHome(orbit, game);
    } else {
      body += renderBoard(orbit, view);
      body += '<div class="oec-meta">';
      var wTurn = game.status === 'playing' && game.turn === 'white' && !view._replay;
      var bTurn = game.status === 'playing' && game.turn === 'black' && !view._replay;
      body += '<div class="oec-clock">' +
        '<span class="' + (bTurn ? 'is-turn' : '') + '">Noirs <b>' + escHtml(game.black || '—') +
        '</b> <span class="oec-clock__time">' + liveClock(game, 'black') + '</span></span>' +
        '<span class="' + (wTurn ? 'is-turn' : '') + '">Blancs <b>' + escHtml(game.white || '—') +
        '</b> <span class="oec-clock__time">' + liveClock(game, 'white') + '</span></span></div>';
      if (game.opening) body += '<p class="oec-opening">' + escHtml(game.opening) + '</p>';
      if (game.status === 'waiting') {
        body += '<p class="oec-turn">' + pick({ fr: 'En attente d’un adversaire…', en: 'Waiting for an opponent…' }) + '</p>';
      } else if (view.lastSan) {
        body += '<p class="oec-turn">' + pick({ fr: 'Dernier coup', en: 'Last move' }) + ' ' + escHtml(view.lastSan) + '</p>';
      }
      body += renderNav(game);
      if (game.capW || game.capB) {
        body += '<div class="oec-caps">' + (capturedHtml(game.capB) || '') + '</div>';
        body += '<div class="oec-caps">' + (capturedHtml(game.capW) || '') + '</div>';
      }
      if (game.sans) body += '<div class="oec-sans">' + escHtml(String(game.sans).replace(/,/g, ' ')) + '</div>';
      if (game.flash) body += '<div class="oec-flash">' + escHtml(game.flash) + '</div>';
      if (game.status === 'ended') body += renderReview(game);
      if (ui.promo) {
        body += '<div class="oec-promo">' +
          '<button type="button" data-promo="q" title="Dame">' + pieceSvg('Q') + '</button>' +
          '<button type="button" data-promo="r" title="Tour">' + pieceSvg('R') + '</button>' +
          '<button type="button" data-promo="b" title="Fou">' + pieceSvg('B') + '</button>' +
          '<button type="button" data-promo="n" title="Cavalier">' + pieceSvg('N') + '</button></div>';
      }
      body += '<div class="oec-actions">';
      if (game.status === 'waiting') {
        body += '<button type="button" class="oec-btn oec-btn--pri" data-act="join">Rejoindre</button>';
        body += '<button type="button" class="oec-btn" data-act="abort">Annuler</button>';
      } else if (game.status === 'playing') {
        body += '<button type="button" class="oec-btn" data-act="draw">Nulle</button>';
        body += '<button type="button" class="oec-btn" data-act="abort">Annuler</button>';
        body += '<button type="button" class="oec-btn oec-btn--danger" data-act="resign">Abandonner</button>';
      } else if (game.status === 'ended') {
        body += '<button type="button" class="oec-btn oec-btn--pri" data-act="home">Accueil</button>';
        body += '<button type="button" class="oec-btn" data-act="start-setup">Rejouer</button>';
      }
      body += '</div></div>';
    }
    body += '</div>';
    root.innerHTML = head + body;
    root.classList.toggle('oec-panel--home', game.status === 'idle');
  }

  function tryMove(orbit, buffer, from, to) {
    var game = getState(buffer);
    if (viewingGame(game)._replay) return;
    if (!from || !to || from === to) return;
    if (needsPromo(game, from, to)) {
      ui.promo = { from: from, to: to };
      ui.sel = '';
      bump();
      return;
    }
    var ok = sendEcCmd(orbit, buffer, 'jouer', from + to);
    if (!ok) patchState(buffer, { flash: pick({ fr: 'Envoi TAGMSG impossible', en: 'TAGMSG send failed' }) });
    ui.sel = '';
    bump();
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
      if (viewingGame(game)._replay) return;
      var color = myColor(orbit, game);
      if (!color || game.turn !== color) return;
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

    if (act === 'setup-vs' || act === 'setup-skill' || act === 'setup-color' || act === 'setup-tc') {
      var key = act.replace('setup-', '');
      ui.setup[key] = val;
      bump();
      return;
    }
    if (act === 'view-full') { setViewMode(orbit, VIEW_FULL); return; }
    if (act === 'view-split') { setViewMode(orbit, VIEW_SPLIT); return; }
    if (act === 'view-chat') { setViewMode(orbit, VIEW_CHAT); return; }
    if (act === 'sync') { sent('sync'); return; }
    if (act === 'start-setup') { sent('commencer', startArg()); return; }
    if (act === 'start') { sent('commencer', startArg()); return; }
    if (act === 'start-w') { sent('commencer', 'blancs ' + (ui.setup.skill || '') + ' ' + (ui.setup.tc || '')); return; }
    if (act === 'start-b') { sent('commencer', 'noirs ' + (ui.setup.skill || '') + ' ' + (ui.setup.tc || '')); return; }
    if (act === 'duo') { sent('commencer', 'duo ' + (ui.setup.tc || '')); return; }
    if (act === 'join') { sent('rejoindre'); return; }
    if (act === 'draw') { sent('nul'); return; }
    if (act === 'abort') { sent('annuler'); return; }
    if (act === 'resign') { sent('abandonner'); return; }
    if (act === 'elo') { sent('elo'); return; }
    if (act === 'lier') {
      var inp = document.getElementById('oec-cc');
      var user = inp ? String(inp.value || '').trim() : '';
      if (!user) { patchState(buffer, { flash: 'Indiquez un pseudo Chess.com' }); return; }
      sent('lier', 'chesscom ' + user);
      return;
    }
    if (act === 'home') {
      var prev = getState(buffer);
      ui.navPly = -1;
      patchState(buffer, Object.assign(defaultState(), keepProfile(prev)));
      return;
    }
    if (act === 'nav-start' || act === 'nav-prev' || act === 'nav-next' || act === 'nav-end') {
      var game = getState(buffer);
      var n = splitUcis(game.ucis).length;
      var cur = ui.navPly < 0 ? n : ui.navPly;
      if (act === 'nav-start') ui.navPly = 0;
      else if (act === 'nav-prev') ui.navPly = Math.max(0, cur - 1);
      else if (act === 'nav-next') ui.navPly = Math.min(n, cur + 1);
      else ui.navPly = game.status === 'ended' ? n : -1;
      if (game.status !== 'ended' && ui.navPly === n) ui.navPly = -1;
      bump();
      return;
    }

    if (promo && ui.promo) {
      sent('jouer', ui.promo.from + ui.promo.to + promo);
      ui.promo = null;
      ui.sel = '';
      bump();
    }
  }

  function mountDomPanel(orbit) {
    var buf = orbit.state.active();
    var on = isChessChannel(orbit, buf);
    var show = on && (cfg(orbit).showWhenIdle || isPlaying(getState(buf)) || getState(buf).status === 'ended' || getViewMode(orbit) !== VIEW_CHAT);
    var root = document.getElementById('oec-dom-panel');
    var main = document.querySelector('.main');
    var topbar = main && main.querySelector('.topbar');
    if (!on) {
      document.body.classList.remove('oec-full', 'oec-split');
      if (root) root.style.display = 'none';
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
    }
    if (main && topbar && root.parentNode !== main) {
      topbar.insertAdjacentElement('afterend', root);
    }
    applyViewMode(orbit, getViewMode(orbit));
    if (ui.drag) return;
    var g = getState(buf);
    var tick = (g.status === 'playing' && g.tc && g.tc !== 'casual') ? Math.floor(Date.now() / 400) : 0;
    var sig = store.rev + '|' + buf + '|' + ui.sel + '|' + (ui.promo ? ui.promo.to : '') + '|' +
      getViewMode(orbit) + '|' + ui.navPly + '|' + tick;
    if (root.__oecSig === sig) return;
    root.__oecSig = sig;
    renderPanel(orbit, root, buf);
  }

  Orbit.plugin('orbit-echecs', function (orbit, log) {
    pluginOrbit = orbit;
    viewMode = getViewMode(orbit);
    injectStyles();
    console.info('[orbit-echecs] loaded v' + OEC_VER);

    function syncDom() {
      try { mountDomPanel(orbit); } catch (e) { console.error('[orbit-echecs] panel', e); }
    }

    subscribe(syncDom);

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '').toUpperCase();
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
