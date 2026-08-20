/*!
 * orbit-echecs — plateau d’échecs Orbit pour CapEchecs (EntreNous)
 * Reçoit +ec=v1 TAGMSG (état / coups) et envoie +ev=cmd (sans PRIVMSG).
 */
(function () {
  'use strict';

  var OEC_VER = 3;

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
  var UNICODE = {
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  };
  var pluginOrbit = null;
  var syncRequestAt = Object.create(null);

  var store = { byChannel: Object.create(null), rev: 0, listeners: new Set() };
  var ui = { sel: '', promo: null, flash: '' };

  function subscribe(cb) { store.listeners.add(cb); return function () { store.listeners.delete(cb); }; }
  function bump() { store.rev++; store.listeners.forEach(function (l) { l(); }); }

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
      status: 'idle',
      mode: '',
      white: '',
      black: '',
      creator: '',
      invited: '',
      fen: START_FEN,
      turn: 'white',
      ply: 0,
      lastUci: '',
      lastSan: '',
      from: '',
      to: '',
      capW: '',
      capB: '',
      sans: '',
      waiting: false,
      result: '',
      reason: '',
      winner: '',
      flash: '',
      gid: '',
      updatedAt: 0,
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
    for (r = 0; r < 8; r++) {
      grid[r] = [null, null, null, null, null, null, null, null];
    }
    for (r = 0; r < rows.length && r < 8; r++) {
      var rank = 7 - r;
      f = 0;
      for (k = 0; k < rows[r].length && f < 8; k++) {
        ch = rows[r].charAt(k);
        if (ch >= '1' && ch <= '8') {
          f += Number(ch);
        } else {
          grid[rank][f] = ch;
          f++;
        }
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

  function capturedHtml(symbols) {
    return String(symbols || '').split('').map(function (p) {
      return UNICODE[p] || p;
    }).join('');
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
      mate: 'Échec et mat',
      stalemate: 'Pat',
      insufficient: 'Matériel insuffisant',
      fifty: 'Règle des 50 coups',
      threefold: 'Triple répétition',
      resign: 'Abandon',
      abort: 'Partie annulée',
      timeout: 'Délai dépassé',
      inactivity: 'Inactivité',
      agree: 'Nulle acceptée',
      quit: 'Déconnexion',
      part: 'Départ',
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
        status: 'waiting',
        waiting: true,
        mode: tagVal(tags, '+mode') || 'pvp',
        creator: tagVal(tags, '+creator'),
        invited: tagVal(tags, '+invited'),
        gid: gid || prev.gid,
        result: '',
        reason: '',
        flash: '',
      });
      return;
    }

    if (ev === 'game_start' || ev === 'state_sync' || ev === 'move') {
      var fen = tagVal(tags, '+fen') || (ev === 'game_start' ? START_FEN : prev.fen);
      var parsed = parseFen(fen);
      var status = tagVal(tags, '+status') || (tagVal(tags, '+waiting') === '1' ? 'waiting' : 'playing');
      if (ev === 'game_start') status = 'playing';
      if (ev === 'move') {
        ui.sel = '';
        ui.promo = null;
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
        ply: Number(tagVal(tags, '+ply')) || prev.ply,
        lastUci: tagVal(tags, '+uci') || tagVal(tags, '+last-uci') || (ev === 'move' ? tagVal(tags, '+uci') : prev.lastUci),
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
      var msg = {
        illegal: 'Coup illégal',
        'not-turn': 'Ce n’est pas votre tour',
        waiting: 'En attente d’un adversaire',
        'no-game': 'Aucune partie en cours',
      }[why] || 'Coup refusé';
      patchState(channel, { flash: msg });
      return;
    }

    if (ev === 'draw_offer') {
      patchState(channel, {
        flash: (tagVal(tags, '+nick') || 'L’adversaire') + ' propose nulle',
      });
      return;
    }

    if (ev === 'game_end') {
      ui.sel = '';
      ui.promo = null;
      patchState(channel, {
        status: 'ended',
        waiting: false,
        fen: tagVal(tags, '+fen') || prev.fen,
        result: tagVal(tags, '+result'),
        reason: tagVal(tags, '+reason'),
        winner: tagVal(tags, '+winner'),
        flash: '',
        gid: gid || prev.gid,
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

  function injectStyles() {
    var prev = document.getElementById('orbit-echecs-css');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'orbit-echecs-css';
    el.textContent = [
      '.oec-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;border-bottom:1px solid color-mix(in srgb,var(--accent,#16a34a) 18%,var(--border,#ddd));background:var(--bg,#fff);font-family:var(--font,system-ui,sans-serif)}',
      '.oec-head{display:flex;align-items:center;gap:.5rem;padding:.45rem .75rem;background:#166534;color:#fff}',
      '.oec-head__title{font-weight:800;font-size:.88rem;flex:1}',
      '.oec-head__badge{font-size:.68rem;font-weight:800;padding:.18rem .65rem;border-radius:999px;background:rgba(255,255,255,.18)}',
      '.oec-head__btn{border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:32px;border-radius:8px;cursor:pointer;font-size:.78rem;font-weight:700;padding:0 .55rem}',
      '.oec-body{padding:.65rem .75rem .8rem;display:flex;flex-wrap:wrap;gap:.85rem;align-items:flex-start;justify-content:center}',
      '.oec-board-wrap{display:flex;flex-direction:column;align-items:center;gap:.35rem}',
      '.oec-files,.oec-ranks{display:flex;font-size:.62rem;font-weight:700;color:var(--muted,#888);user-select:none}',
      '.oec-files{width:min(360px,72vw);justify-content:space-around;padding:0 1.1rem}',
      '.oec-board-row{display:flex;align-items:center;gap:.25rem}',
      '.oec-board{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));width:min(360px,72vw);aspect-ratio:1;border:1px solid color-mix(in srgb,#166534 35%,var(--border,#ccc));border-radius:4px;overflow:hidden}',
      '.oec-sq{display:grid;place-items:center;font-size:clamp(1.15rem,4.6vw,1.85rem);line-height:1;cursor:pointer;user-select:none}',
      '.oec-sq--light{background:#eee8d5}',
      '.oec-sq--dark{background:#769656}',
      '.oec-sq--last{box-shadow:inset 0 0 0 3px rgba(250,204,21,.85)}',
      '.oec-sq--sel{box-shadow:inset 0 0 0 3px #166534}',
      '.oec-sq--mine{cursor:pointer}',
      '.oec-meta{flex:1 1 12rem;min-width:11rem;max-width:18rem}',
      '.oec-players{font-size:.82rem;line-height:1.45;margin:0 0 .45rem}',
      '.oec-players b{font-weight:800}',
      '.oec-turn{font-size:.78rem;font-weight:800;margin:0 0 .5rem;color:#166534}',
      '.oec-caps{font-size:.9rem;min-height:1.2em;margin:0 0 .35rem;letter-spacing:.04em}',
      '.oec-sans{font-size:.72rem;color:var(--muted,#666);max-height:4.5rem;overflow:auto;line-height:1.4}',
      '.oec-flash{margin:.35rem 0;padding:.4rem .55rem;border-radius:8px;background:#fef3c7;color:#92400e;font-size:.78rem;font-weight:700}',
      '.oec-end{margin:.35rem 0;padding:.5rem .6rem;border-radius:8px;background:#ecfdf5;color:#166534;font-size:.82rem;font-weight:800}',
      '.oec-actions{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.55rem}',
      '.oec-btn{border:1px solid color-mix(in srgb,#166534 28%,var(--border,#ddd));background:var(--bg,#fff);color:var(--ink,#222);border-radius:999px;padding:.4rem .75rem;font-size:.76rem;font-weight:800;cursor:pointer;min-height:34px}',
      '.oec-btn:hover{border-color:#166534;color:#166534}',
      '.oec-btn--pri{background:#166534;color:#fff;border-color:#166534}',
      '.oec-btn--danger{background:#fff;color:#b91c1c;border-color:#fca5a5}',
      '.oec-idle{text-align:center;width:100%}',
      '.oec-idle p{margin:0 0 .75rem;color:var(--muted,#666);font-size:.88rem}',
      '.oec-promo{display:flex;gap:.3rem;margin:.4rem 0;flex-wrap:wrap}',
      '.oec-promo button{font-size:1.2rem;min-width:2.2rem;min-height:2.2rem;border-radius:8px;border:1px solid #166534;background:#fff;cursor:pointer}',
      '@media(max-width:720px){.oec-body{flex-direction:column;align-items:center}.oec-meta{max-width:none;width:100%}}',
    ].join('');
    document.head.appendChild(el);
  }

  function filesLabel(flip) {
    var files = 'abcdefgh';
    if (flip) files = files.split('').reverse().join('');
    return files.split('').map(function (f) {
      return '<span>' + f + '</span>';
    }).join('');
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
    var html = '<div class="oec-board-wrap"><div class="oec-files">' + filesLabel(flip) + '</div><div class="oec-board">';
    ranks.forEach(function (rank) {
      files.forEach(function (file) {
        var name = sqName(file, rank);
        var piece = parsed.grid[rank][file];
        var light = (file + rank) % 2 === 1;
        var cls = 'oec-sq ' + (light ? 'oec-sq--light' : 'oec-sq--dark');
        if (name === lastFrom || name === lastTo) cls += ' oec-sq--last';
        if (name === ui.sel) cls += ' oec-sq--sel';
        if (myTurn && piece && pieceColor(piece) === color) cls += ' oec-sq--mine';
        html += '<button type="button" class="' + cls + '" data-sq="' + escHtml(name) + '"' +
          (game.status === 'playing' && color ? '' : ' disabled') + '>' +
          (piece ? UNICODE[piece] || '' : '') + '</button>';
      });
    });
    html += '</div><div class="oec-files">' + filesLabel(flip) + '</div></div>';
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

  function renderPanel(orbit, root, buffer) {
    var game = getState(buffer);
    var title = pick({ fr: 'Échecs', en: 'Chess' });
    var badge = game.status === 'playing' ? (game.mode === 'ai' ? 'IA' : 'Duo')
      : game.status === 'waiting' ? 'En attente'
      : game.status === 'ended' ? escHtml(game.result || 'Fin')
      : 'Prêt';
    var head = '<div class="oec-head"><span class="oec-head__title">' + title + '</span>' +
      '<span class="oec-head__badge">' + badge + '</span>' +
      '<button type="button" class="oec-head__btn" data-act="sync">↻</button></div>';

    var body = '<div class="oec-body">';
    if (game.status === 'idle') {
      body += '<div class="oec-idle"><p>' +
        pick({ fr: 'Lancez une partie contre l’IA ou en duo. Les coups passent en TAGMSG, sans polluer le tchat.',
          en: 'Start vs AI or a duo game. Moves use TAGMSG and stay out of chat.' }) +
        '</p><div class="oec-actions">' +
        '<button type="button" class="oec-btn oec-btn--pri" data-act="start">IA (aléatoire)</button>' +
        '<button type="button" class="oec-btn" data-act="start-w">Blancs</button>' +
        '<button type="button" class="oec-btn" data-act="start-b">Noirs</button>' +
        '<button type="button" class="oec-btn" data-act="duo">Duo</button>' +
        '</div></div>';
    } else {
      body += renderBoard(orbit, game);
      body += '<div class="oec-meta">';
      body += '<p class="oec-players">Blancs : <b>' + escHtml(game.white || '—') + '</b><br>Noirs : <b>' + escHtml(game.black || '—') + '</b></p>';
      if (game.status === 'waiting') {
        body += '<p class="oec-turn">' + pick({ fr: 'En attente d’un adversaire…', en: 'Waiting for an opponent…' }) + '</p>';
      } else if (game.status === 'playing') {
        var turnLbl = game.turn === 'black' ? 'Noirs' : 'Blancs';
        body += '<p class="oec-turn">Trait : ' + turnLbl +
          (game.lastSan ? ' — dernier coup ' + escHtml(game.lastSan) : '') + '</p>';
      }
      if (game.capW || game.capB) {
        body += '<div class="oec-caps">Blancs : ' + escHtml(capturedHtml(game.capW) || '—') + '</div>';
        body += '<div class="oec-caps">Noirs : ' + escHtml(capturedHtml(game.capB) || '—') + '</div>';
      }
      if (game.sans) body += '<div class="oec-sans">' + escHtml(String(game.sans).replace(/,/g, ' ')) + '</div>';
      if (game.flash) body += '<div class="oec-flash">' + escHtml(game.flash) + '</div>';
      if (game.status === 'ended') {
        body += '<div class="oec-end">' + escHtml(game.result || '') +
          (game.reason ? ' — ' + escHtml(reasonFr(game.reason)) : '') + '</div>';
      }
      if (ui.promo) {
        body += '<div class="oec-promo">' +
          '<button type="button" data-promo="q" title="Dame">♕</button>' +
          '<button type="button" data-promo="r" title="Tour">♖</button>' +
          '<button type="button" data-promo="b" title="Fou">♗</button>' +
          '<button type="button" data-promo="n" title="Cavalier">♘</button></div>';
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

  function onClick(orbit, buffer, ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act],[data-sq],[data-promo]') : null;
    if (!el) return;
    ev.preventDefault();
    var act = el.getAttribute('data-act');
    var sq = el.getAttribute('data-sq');
    var promo = el.getAttribute('data-promo');
    var game = getState(buffer);

    function sent(name, arg) {
      var ok = sendEcCmd(orbit, buffer, name, arg);
      if (!ok) patchState(buffer, { flash: pick({ fr: 'Envoi TAGMSG impossible', en: 'TAGMSG send failed' }) });
      return ok;
    }

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
      return;
    }

    if (sq && game.status === 'playing') {
      var color = myColor(orbit, game);
      if (!color) return;
      if (game.turn !== color) {
        patchState(buffer, { flash: pick({ fr: 'Ce n’est pas votre tour', en: 'Not your turn' }) });
        return;
      }
      if (!ui.sel) {
        var parsed = parseFen(game.fen);
        var f = 'abcdefgh'.indexOf(sq.charAt(0));
        var r = Number(sq.charAt(1)) - 1;
        var piece = parsed.grid[r] && parsed.grid[r][f];
        if (!piece || pieceColor(piece) !== color) return;
        ui.sel = sq;
        bump();
        return;
      }
      if (ui.sel === sq) {
        ui.sel = '';
        bump();
        return;
      }
      if (needsPromo(game, ui.sel, sq)) {
        ui.promo = { from: ui.sel, to: sq };
        bump();
        return;
      }
      sent('jouer', ui.sel + sq);
      ui.sel = '';
      bump();
    }
  }

  function mountDomPanel(orbit) {
    var buf = orbit.state.active();
    var show = isChessChannel(orbit, buf) && (cfg(orbit).showWhenIdle || isPlaying(getState(buf)) || getState(buf).status === 'ended');
    var root = document.getElementById('oec-dom-panel');
    var main = document.querySelector('.main');
    var topbar = main && main.querySelector('.topbar');
    if (!show) {
      if (root) root.style.display = 'none';
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
    }
    root.style.display = '';
    if (main && topbar && root.parentNode !== main) {
      topbar.insertAdjacentElement('afterend', root);
    }
    var sig = store.rev + '|' + buf + '|' + ui.sel + '|' + (ui.promo ? ui.promo.to : '');
    if (root.__oecSig === sig) return;
    root.__oecSig = sig;
    renderPanel(orbit, root, buf);
  }

  Orbit.plugin('orbit-echecs', function (orbit, log) {
    pluginOrbit = orbit;
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
        sendEcCmd(orbit, buf, 'sync');
        syncDom();
      },
    });

    log('orbit-echecs ready');
  });

  }

  boot(0);
})();
