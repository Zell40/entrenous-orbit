/*!
 * orbit-echecs — plateau d’échecs Orbit pour CapEchecs (EntreNous)
 * Reçoit +ec=v1 TAGMSG (état / coups) et envoie +ev=cmd (sans PRIVMSG).
 */
(function () {
  'use strict';

  var OEC_VER = 4;

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
  var ui = { sel: '', promo: null, drag: null };

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
      from: '', to: '', capW: '', capB: '', sans: '', waiting: false,
      result: '', reason: '', winner: '', flash: '', gid: '', updatedAt: 0,
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
      patchState(channel, {
        status: 'waiting', waiting: true, mode: tagVal(tags, '+mode') || 'pvp',
        creator: tagVal(tags, '+creator'), invited: tagVal(tags, '+invited'),
        gid: gid || prev.gid, result: '', reason: '', flash: '',
      });
      return;
    }

    if (ev === 'game_start' || ev === 'state_sync' || ev === 'move') {
      var fen = tagVal(tags, '+fen') || (ev === 'game_start' ? START_FEN : prev.fen);
      var parsed = parseFen(fen);
      var status = tagVal(tags, '+status') || (tagVal(tags, '+waiting') === '1' ? 'waiting' : 'playing');
      if (ev === 'game_start') status = 'playing';
      if (ev === 'move') { ui.sel = ''; ui.promo = null; }
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
      patchState(channel, {
        status: 'ended', waiting: false, fen: tagVal(tags, '+fen') || prev.fen,
        result: tagVal(tags, '+result'), reason: tagVal(tags, '+reason'),
        winner: tagVal(tags, '+winner'), flash: '', gid: gid || prev.gid,
      });
      return;
    }

    if (ev === 'cmd_err') {
      var err = tagVal(tags, '+text');
      if (err === 'idle') {
        ui.sel = '';
        ui.promo = null;
        patchState(channel, Object.assign(defaultState(), {
          flash: pick({ fr: 'Aucune partie en cours', en: 'No game in progress' }),
        }));
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
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
    }
    if (name === 'game') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/></svg>';
    }
    if (name === 'split') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
    }
    if (name === 'full') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
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
      root.style.display = 'none';
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
      '.oec-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;background:#1a1c19;color:#f5f5f4;font-family:var(--font,system-ui,sans-serif)}',
      '.oec-panel--full{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-bottom:0}',
      '.oec-panel--split{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '.oec-panel--chat{display:none!important}',
      'body.oec-full .chan-hero,body.oec-full .messages,body.oec-full .composer,body.oec-full .main__room-bg{display:none!important}',
      '@media(min-width:1000px){body.oec-split .main{display:grid!important;grid-template-columns:minmax(22rem,min(58vh,48vw)) minmax(16rem,1fr);grid-template-rows:auto auto 1fr auto;align-items:stretch}body.oec-split .topbar{grid-column:1/-1;grid-row:1}body.oec-split .main__room-bg{grid-column:2;grid-row:2/4;height:auto!important}body.oec-split #oec-dom-panel{grid-column:1;grid-row:2/-1;min-width:22rem;min-height:0;height:auto!important;max-height:none!important;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid rgba(255,255,255,.08)}body.oec-split .chan-hero{grid-column:2;grid-row:2}body.oec-split .messages{grid-column:2;grid-row:3;min-height:0}body.oec-split .composer{grid-column:2;grid-row:4}body.oec-split .main>:not(.topbar):not(#oec-dom-panel):not(.main__room-bg):not(.chan-hero):not(.messages):not(.composer){grid-column:2}}',
      '@media(max-width:999px){body.oec-split .main{display:flex;flex-direction:column}body.oec-split #oec-dom-panel{flex:0 0 auto}body.oec-split .messages{flex:1 1 auto;min-height:8rem}}',
      '.oec-head{display:flex;align-items:center;gap:.45rem;padding:.42rem .7rem;background:linear-gradient(135deg,#14532d,#166534);color:#fff;flex:0 0 auto}',
      '.oec-head__title{font-weight:800;font-size:.88rem}',
      '.oec-head__badge{font-size:.68rem;font-weight:800;padding:.16rem .6rem;border-radius:999px;background:rgba(255,255,255,.18)}',
      '.oec-head__actions{margin-left:auto;display:flex;gap:.28rem}',
      '.oec-head__btn{border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:34px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.oec-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.oec-head__btn--on{background:rgba(255,255,255,.34)}',
      '.oec-head__btn svg{width:18px;height:18px;display:block}',
      '.oec-stage{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;gap:1.1rem;padding:.7rem .8rem;overflow:hidden}',
      '.oec-board-wrap{width:min(100%,calc(100dvh - 7.2rem));max-width:min(72dvh,100%);flex:0 0 auto}',
      'body.oec-split .oec-board-wrap{width:100%;max-width:100%}',
      '.oec-board{display:grid;grid-template-columns:repeat(8,1fr);width:100%;aspect-ratio:1/1;height:auto;border-radius:10px;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.35),inset 0 0 0 2px rgba(255,255,255,.08);touch-action:none;user-select:none}',
      '.oec-sq{position:relative;display:grid;place-items:center;cursor:pointer}',
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
      '.oec-piece{width:86%;height:86%;filter:drop-shadow(0 2px 2px rgba(0,0,0,.28));pointer-events:none}',
      '.oec-piece--mini{width:18px;height:18px;filter:none}',
      '.oec-piece--ghost{position:fixed;width:56px;height:56px;z-index:80;pointer-events:none;transform:translate(-50%,-50%);filter:drop-shadow(0 8px 12px rgba(0,0,0,.4))}',
      '.oec-meta{flex:0 1 16rem;min-width:12rem;max-width:18rem}',
      '.oec-players{margin:0 0 .5rem;font-size:.86rem;line-height:1.5}',
      '.oec-clock{display:flex;flex-direction:column;gap:.28rem;margin:0 0 .7rem}',
      '.oec-clock span{display:flex;justify-content:space-between;background:rgba(255,255,255,.06);border-radius:10px;padding:.4rem .55rem;font-weight:700}',
      '.oec-clock span b{font-weight:800}',
      '.oec-clock span.is-turn{outline:2px solid #86efac}',
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
      '.oec-idle{text-align:center;max-width:28rem}',
      '.oec-idle p{margin:0 0 .8rem;color:#a8a29e}',
      '.oec-promo{display:flex;gap:.35rem;margin:.45rem 0}',
      '.oec-promo button{width:2.6rem;height:2.6rem;border-radius:10px;border:1px solid #166534;background:#fff;cursor:pointer;padding:.2rem}',
      '.oec-topbtns{display:flex;gap:.2rem;align-items:center}',
      '.oec-topbtn{border:0;background:transparent;color:inherit;width:34px;height:34px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
      '.oec-topbtn:hover,.oec-topbtn--on{background:rgba(127,127,127,.18)}',
      '.oec-topbtn svg{width:18px;height:18px}',
      '@media(max-width:720px){.oec-stage{flex-direction:column;overflow:auto}.oec-meta{max-width:none;width:100%}.oec-board-wrap{width:min(100%,calc(100vw - 1.6rem))}}',
    ].join('');
    document.head.appendChild(el);
  }

  function renderBoard(orbit, game) {
    var parsed = parseFen(game.fen);
    var flip = myColor(orbit, game) === 'black';
    var lastFrom = game.from || (game.lastUci && game.lastUci.slice(0, 2)) || '';
    var lastTo = game.to || (game.lastUci && game.lastUci.slice(2, 4)) || '';
    var color = myColor(orbit, game);
    var myTurn = game.status === 'playing' && color && game.turn === color;
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
    return '<div class="oec-head__actions">' +
      '<button type="button" class="oec-head__btn' + (mode === VIEW_FULL ? ' oec-head__btn--on' : '') +
        '" data-act="view-full" title="' + escHtml(pick({ fr: 'Jeu en plein écran', en: 'Fullscreen game' })) + '">' + iconSvg('full') + '</button>' +
      '<button type="button" class="oec-head__btn' + (mode === VIEW_SPLIT ? ' oec-head__btn--on' : '') +
        '" data-act="view-split" title="' + escHtml(pick({ fr: 'Jeu + tchat', en: 'Game + chat' })) + '">' + iconSvg('split') + '</button>' +
      '<button type="button" class="oec-head__btn' + (mode === VIEW_CHAT ? ' oec-head__btn--on' : '') +
        '" data-act="view-chat" title="' + escHtml(pick({ fr: 'Afficher le tchat', en: 'Show chat' })) + '">' + iconSvg('chat') + '</button>' +
      '<button type="button" class="oec-head__btn" data-act="sync" title="Sync">↻</button>' +
      '</div>';
  }

  function renderPanel(orbit, root, buffer) {
    var game = getState(buffer);
    var mode = getViewMode(orbit);
    var badge = game.status === 'playing' ? (game.mode === 'ai' ? 'IA' : 'Duo')
      : game.status === 'waiting' ? 'En attente'
      : game.status === 'ended' ? escHtml(game.result || 'Fin')
      : 'Prêt';
    var head = '<div class="oec-head"><span class="oec-head__title">Échecs</span>' +
      '<span class="oec-head__badge">' + badge + '</span>' + viewBtns(mode) + '</div>';

    var body = '<div class="oec-stage">';
    if (game.status === 'idle') {
      body += '<div class="oec-idle"><p>' +
        pick({ fr: 'Lancez une partie contre l’IA ou en duo. Glissez les pièces pour jouer.',
          en: 'Start vs AI or a duo game. Drag pieces to move.' }) +
        '</p><div class="oec-actions">' +
        '<button type="button" class="oec-btn oec-btn--pri" data-act="start">IA (aléatoire)</button>' +
        '<button type="button" class="oec-btn" data-act="start-w">Blancs</button>' +
        '<button type="button" class="oec-btn" data-act="start-b">Noirs</button>' +
        '<button type="button" class="oec-btn" data-act="duo">Duo</button>' +
        '</div></div>';
    } else {
      body += renderBoard(orbit, game);
      body += '<div class="oec-meta">';
      var wTurn = game.status === 'playing' && game.turn === 'white';
      var bTurn = game.status === 'playing' && game.turn === 'black';
      body += '<div class="oec-clock">' +
        '<span class="' + (bTurn ? 'is-turn' : '') + '">Noirs <b>' + escHtml(game.black || '—') + '</b></span>' +
        '<span class="' + (wTurn ? 'is-turn' : '') + '">Blancs <b>' + escHtml(game.white || '—') + '</b></span></div>';
      if (game.status === 'waiting') {
        body += '<p class="oec-turn">' + pick({ fr: 'En attente d’un adversaire…', en: 'Waiting for an opponent…' }) + '</p>';
      } else if (game.status === 'playing' && game.lastSan) {
        body += '<p class="oec-turn">' + pick({ fr: 'Dernier coup', en: 'Last move' }) + ' ' + escHtml(game.lastSan) + '</p>';
      }
      if (game.capW || game.capB) {
        body += '<div class="oec-caps">' + (capturedHtml(game.capB) || '') + '</div>';
        body += '<div class="oec-caps">' + (capturedHtml(game.capW) || '') + '</div>';
      }
      if (game.sans) body += '<div class="oec-sans">' + escHtml(String(game.sans).replace(/,/g, ' ')) + '</div>';
      if (game.flash) body += '<div class="oec-flash">' + escHtml(game.flash) + '</div>';
      if (game.status === 'ended') {
        body += '<div class="oec-end">' + escHtml(game.result || '') +
          (game.reason ? ' — ' + escHtml(reasonFr(game.reason)) : '') + '</div>';
      }
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
        body += '<button type="button" class="oec-btn oec-btn--pri" data-act="start">Nouvelle partie</button>';
        body += '<button type="button" class="oec-btn" data-act="duo">Duo</button>';
      }
      body += '</div></div>';
    }
    body += '</div>';
    root.innerHTML = head + body;
  }

  function tryMove(orbit, buffer, from, to) {
    var game = getState(buffer);
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

    function sent(name, arg) {
      var ok = sendEcCmd(orbit, buffer, name, arg);
      if (!ok) patchState(buffer, { flash: pick({ fr: 'Envoi TAGMSG impossible', en: 'TAGMSG send failed' }) });
      return ok;
    }

    if (act === 'view-full') { setViewMode(orbit, VIEW_FULL); return; }
    if (act === 'view-split') { setViewMode(orbit, VIEW_SPLIT); return; }
    if (act === 'view-chat') { setViewMode(orbit, VIEW_CHAT); return; }
    if (act === 'sync') { sent('sync'); return; }
    if (act === 'start') { sent('commencer'); return; }
    if (act === 'start-w') { sent('commencer', 'blancs'); return; }
    if (act === 'start-b') { sent('commencer', 'noirs'); return; }
    if (act === 'duo') { sent('commencer', 'duo'); return; }
    if (act === 'join') { sent('rejoindre'); return; }
    if (act === 'draw') { sent('nul'); return; }
    if (act === 'abort') { sent('annuler'); return; }
    if (act === 'resign') { sent('abandonner'); return; }

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
    if (getViewMode(orbit) === VIEW_CHAT) return;
    var sig = store.rev + '|' + buf + '|' + ui.sel + '|' + (ui.promo ? ui.promo.to : '') + '|' + getViewMode(orbit);
    if (root.__oecSig === sig) return;
    root.__oecSig = sig;
    renderPanel(orbit, root, buf);
  }

  function bindTopbar(orbit) {
    if (!orbit.addUi || !Orbit.React) return;
    var React = Orbit.React;
    var h = React.createElement;
    var useSyncExternalStore = React.useSyncExternalStore;
    function ChessTopbar() {
      var mode = useSyncExternalStore(subscribeView, function () {
        return viewMode + '|' + (orbit.state.active() || '');
      });
      var on = isChessChannel(orbit, orbit.state.active());
      if (!on) return null;
      function btn(id, title, icon, active) {
        return h('button', {
          type: 'button',
          className: 'oec-topbtn' + (active ? ' oec-topbtn--on' : ''),
          title: title,
          onClick: function () { setViewMode(orbit, id); },
        }, h('span', { dangerouslySetInnerHTML: { __html: iconSvg(icon) } }));
      }
      return h('div', { className: 'oec-topbtns', title: 'Échecs' },
        btn(VIEW_FULL, pick({ fr: 'Jeu', en: 'Game' }), 'game', viewMode === VIEW_FULL),
        btn(VIEW_SPLIT, pick({ fr: 'Jeu + tchat', en: 'Game + chat' }), 'split', viewMode === VIEW_SPLIT),
        btn(VIEW_CHAT, pick({ fr: 'Tchat', en: 'Chat' }), 'chat', viewMode === VIEW_CHAT)
      );
    }
    orbit.addUi('topbar_item', function () { return h(ChessTopbar); });
  }

  Orbit.plugin('orbit-echecs', function (orbit, log) {
    pluginOrbit = orbit;
    viewMode = getViewMode(orbit);
    injectStyles();
    bindTopbar(orbit);
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
