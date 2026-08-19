/*!
 * orbit-bac-live — Tableau live Petit Bac pour Orbit (EntreNous)
 * Complète orbit-petitbac : voir les réponses de tous les joueurs en temps réel.
 * Parse les PRIVMSG du bot Bac (+ TAGMSG +pb=v1 si disponibles).
 */
(function () {
  'use strict';

  var LIVE_VER = 2;

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (retry < 80) setTimeout(function () { boot(retry + 1); }, 50);
      else console.error('[orbit-bac-live] Orbit API unavailable');
      return;
    }
    if (window.__ORBIT_BAC_LIVE__ === LIVE_VER) return;
    window.__ORBIT_BAC_LIVE__ = LIVE_VER;

    var pluginOrbit = null;
    var PB = '+pb';
    var EV = '+ev';
    var STORAGE_OPEN = 'bacLiveOpen';
    var STORAGE_COLLAPSED = 'bacLiveCollapsed';
    var STORAGE_STATS = 'bacLiveStats';

    function pick(table) {
      if (pluginOrbit && pluginOrbit.i18n && pluginOrbit.i18n.pick) {
        return pluginOrbit.i18n.pick(table);
      }
      var lang = (document.documentElement.lang || 'fr').slice(0, 2);
      return table[lang] || table.fr || table.en || Object.values(table)[0] || '';
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
      var c = (orbit.config().bacLive) || {};
      var channels = c.channels;
      if (!Array.isArray(channels) || !channels.length) {
        channels = ['#Baccalaureat.chat'];
      }
      return {
        channels: channels.map(normChan),
        channelsAll: channels.some(function (ch) { return ch === '*'; }),
        defaultOpen: c.defaultOpen === true,
        defaultCollapsed: c.defaultCollapsed !== false,
        maxPlayers: Math.max(4, Math.min(24, Number(c.maxPlayers) || 14)),
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

    function channelEnabled(orbit, channelKey) {
      if (!channelKey) return false;
      var name = resolveChannelName(orbit, channelKey);
      var n = normChan(name);
      if (!isChannelName(n)) return false;
      if (/baccalaureat/i.test(n)) return true;
      var c = cfg(orbit);
      if (c.channelsAll) return true;
      if (c.channels.indexOf(n) >= 0) return true;
      var play = (((orbit.config().startup || {}).intents || {}).play) || [];
      return play.some(function (ch) { return normChan(ch) === n; });
    }

    function stripIrc(text) {
      return String(text || '')
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
        .replace(/\x02|\x0f|\x1f|\x16|\x06|\x07|\x09/g, '');
    }

    function escHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    }

    function stripReplyPrefix(plain) {
      return String(plain || '').replace(/^[^:]{1,32}:\s*/, '');
    }

    function parseCategories(raw) {
      return String(raw || '')
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
    }

    function defaultBoard() {
      return {
        phase: 'idle',
        round: 0,
        totalRounds: 0,
        letter: '',
        categories: [],
        players: Object.create(null),
        updatedAt: 0,
      };
    }

    var store = {
      byChannel: Object.create(null),
      rev: 0,
      listeners: new Set(),
    };

    function subscribe(cb) {
      store.listeners.add(cb);
      return function () { store.listeners.delete(cb); };
    }

    function bump() {
      store.rev++;
      store.listeners.forEach(function (l) { l(); });
    }

    function getBoard(channel) {
      return store.byChannel[normChan(channel)] || null;
    }

    function setBoard(channel, next) {
      var key = normChan(channel);
      if (!key) return;
      store.byChannel[key] = next;
      bump();
    }

    function patchBoard(channel, patch) {
      var key = normChan(channel);
      var prev = store.byChannel[key] || defaultBoard();
      setBoard(channel, Object.assign({}, prev, patch, { updatedAt: Date.now() }));
    }

    function ensurePlayer(board, nick) {
      var k = String(nick || '').toLowerCase();
      if (!k) return null;
      if (!board.players[k]) {
        board.players[k] = {
          nick: nick,
          answers: Object.create(null),
          score: 0,
          roundPts: 0,
        };
      }
      return board.players[k];
    }

    function resetRoundPlayers(board) {
      Object.keys(board.players).forEach(function (k) {
        board.players[k].answers = Object.create(null);
        board.players[k].roundPts = 0;
      });
    }

    function tagVal(tags, name) {
      if (!tags) return '';
      if (Object.prototype.hasOwnProperty.call(tags, name)) return String(tags[name] || '');
      var alt = name.charAt(0) === '+' ? name.slice(1) : '+' + name;
      if (Object.prototype.hasOwnProperty.call(tags, alt)) return String(tags[alt] || '');
      return '';
    }

    function safeJson(raw, fallback) {
      if (!raw) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    }

    function recordPersonalStat(orbit, kind, delta) {
      try {
        var stats = orbit.storage.get(STORAGE_STATS, { validated: 0, points: 0, combos: 0 });
        stats[kind] = (Number(stats[kind]) || 0) + (delta || 1);
        orbit.storage.set(STORAGE_STATS, stats);
      } catch (e) { /* ignore */ }
    }

    function applyValidation(channel, playerNick, word, cat, pts, myNick) {
      var board = Object.assign({}, getBoard(channel) || defaultBoard());
      board.players = Object.assign({}, board.players);
      var p = ensurePlayer(board, playerNick);
      if (!p) return;
      p.answers = Object.assign({}, p.answers);
      p.answers[cat.toLowerCase()] = { word: word, pts: pts || 1 };
      p.roundPts = (p.roundPts || 0) + (pts || 1);
      p.score = (p.score || 0) + (pts || 1);
      setBoard(channel, board);

      if (myNick && playerNick.toLowerCase() === myNick.toLowerCase()) {
        recordPersonalStat(orbitRef, 'validated', 1);
        recordPersonalStat(orbitRef, 'points', pts || 1);
        var b2 = getBoard(channel);
        if (b2 && b2.categories.length) {
          var me = b2.players[String(playerNick).toLowerCase()];
          if (me && Object.keys(me.answers).length >= b2.categories.length) {
            recordPersonalStat(orbitRef, 'combos', 1);
          }
        }
      }
    }

    var orbitRef = null;

    function parseValidationLine(plain) {
      var m = plain.match(/^([^:]{1,32}):\s*(?:✔️|💎)\s*Mot(?:\s+difficile)?\s*[«"]([^»"]+)[»"].*?\(\+(\d+)\s+point/i);
      if (!m) {
        m = plain.match(/^([^:]{1,32}):\s*(?:✔️|💎).*?Cat[ée]gorie\s+(\S+)/i);
        if (!m) return null;
        var wordM = plain.match(/[«"]([^»"]+)[»"]/);
        return {
          nick: m[1].trim(),
          word: wordM ? wordM[1] : '',
          cat: m[2].replace(/[.,;:!?]+$/, ''),
          pts: /💎/.test(plain) ? 2 : 1,
        };
      }
      var catM = plain.match(/Cat[ée]gorie\s+(\S+)/i);
      return {
        nick: m[1].trim(),
        word: m[2],
        cat: catM ? catM[1].replace(/[.,;:!?]+$/, '') : '',
        pts: Number(m[3]) || 1,
      };
    }

    function handleTagEvent(channel, tags) {
      if (tagVal(tags, PB) !== 'v1') return;
      var ev = tagVal(tags, EV);

      if (ev === 'game_start') {
        setBoard(channel, Object.assign(defaultBoard(), {
          phase: 'playing',
          totalRounds: Number(tagVal(tags, '+max_rounds')) || 0,
          round: Number(tagVal(tags, '+round')) || 1,
        }));
        return;
      }

      if (ev === 'round_start') {
        var cats = tagVal(tags, '+categories');
        var board = Object.assign(defaultBoard(), getBoard(channel) || {});
        board.phase = 'playing';
        board.round = Number(tagVal(tags, '+round')) || board.round;
        board.letter = tagVal(tags, '+letter') || board.letter;
        board.categories = cats ? parseCategories(cats) : board.categories;
        board.totalRounds = Number(tagVal(tags, '+totalRounds')) || board.totalRounds;
        resetRoundPlayers(board);
        setBoard(channel, board);
        return;
      }

      if (ev === 'round_end') {
        var rs = safeJson(tagVal(tags, '+round_scores'), {});
        var b = Object.assign({}, getBoard(channel) || defaultBoard());
        Object.keys(rs).forEach(function (nick) {
          var p = ensurePlayer(b, nick);
          if (p) p.roundPts = Number(rs[nick]) || p.roundPts;
        });
        b.phase = 'round_end';
        setBoard(channel, b);
        return;
      }

      if (ev === 'game_end') {
        patchBoard(channel, { phase: 'game_end', letter: '', categories: [] });
      }
    }

    function handleIrcLine(channel, msgNick, text, myNick) {
      var plain = stripIrc(text).trim();
      if (!plain) return;
      var body = stripReplyPrefix(plain);
      var fromBac = /^[@+%~&]?bac$/i.test(String(msgNick || '').replace(/^[@+%~&]/, ''));

      var val = parseValidationLine(plain);
      if (val && val.cat) {
        applyValidation(channel, val.nick, val.word, val.cat, val.pts, myNick);
        return;
      }

      var join = body.match(/^👋\s+(\S+)\s+rejoint la partie/i);
      if (join) {
        var bJoin = Object.assign({}, getBoard(channel) || defaultBoard());
        ensurePlayer(bJoin, join[1]);
        setBoard(channel, bJoin);
      }

      var manche = body.match(/manche\s+(\d+)\s*\/\s*(\d+)/i);
      if (manche) {
        var bM = Object.assign({}, getBoard(channel) || defaultBoard());
        bM.phase = 'playing';
        bM.round = Number(manche[1]) || 0;
        bM.totalRounds = Number(manche[2]) || 0;
        if (bM.round > 1 || !bM.categories.length) resetRoundPlayers(bM);
        setBoard(channel, bM);
      }

      var lc = body.match(/lettre\s*(?:actuelle)?\s*:\s*(\S+).*cat[ée]gories\s*:\s*(.+)$/i);
      if (lc) {
        var bLc = Object.assign({}, getBoard(channel) || defaultBoard());
        bLc.phase = 'playing';
        bLc.letter = lc[1].trim().charAt(0).toUpperCase();
        bLc.categories = parseCategories(lc[2]);
        resetRoundPlayers(bLc);
        setBoard(channel, bLc);
        return;
      }

      var letterOnly = body.match(/(?:🔤|🎲)\s*lettre(?:\s+actuelle)?\s*:\s*(\S)/i)
        || body.match(/lettre(?:\s+actuelle)?\s*:\s*(\S)/i);
      if (letterOnly) {
        var bL = Object.assign({}, getBoard(channel) || defaultBoard());
        bL.phase = 'playing';
        bL.letter = letterOnly[1].trim().charAt(0).toUpperCase();
        if (bL.categories.length) resetRoundPlayers(bL);
        setBoard(channel, bL);
      }

      var catsOnly = body.match(/(?:📚\s*)?cat[ée]gories\s*:\s*(.+)$/i);
      if (catsOnly && !/par manche|actuelles/i.test(body)) {
        var bC = Object.assign({}, getBoard(channel) || defaultBoard());
        bC.phase = 'playing';
        bC.categories = parseCategories(catsOnly[1]);
        patchBoard(channel, { phase: 'playing', categories: bC.categories });
      }

      if (fromBac && /fin de la manche|manche termin[eé]e/i.test(body)) {
        patchBoard(channel, { phase: 'round_end' });
      }
      if (fromBac && /fin de la partie|partie termin[eé]e/i.test(body)) {
        patchBoard(channel, { phase: 'game_end', letter: '', categories: [] });
      }
    }

    function playerList(board, maxPlayers) {
      return Object.keys(board.players || {})
        .map(function (k) { return board.players[k]; })
        .sort(function (a, b) {
          if (b.roundPts !== a.roundPts) return b.roundPts - a.roundPts;
          return a.nick.localeCompare(b.nick);
        })
        .slice(0, maxPlayers);
    }

    function buildRecapMarkdown(board) {
      if (!board.categories.length) return '';
      var lines = ['# Petit Bac — Manche ' + (board.round || '?') + ' (' + board.letter + ')', ''];
      var header = '| Joueur | ' + board.categories.join(' | ') + ' | Points |';
      var sep = '| --- | ' + board.categories.map(function () { return '---'; }).join(' | ') + ' | --- |';
      lines.push(header, sep);
      playerList(board, 99).forEach(function (p) {
        var cells = board.categories.map(function (cat) {
          var a = p.answers[cat.toLowerCase()];
          return a ? a.word + (a.pts > 1 ? ' (+' + a.pts + ')' : '') : '—';
        });
        lines.push('| ' + p.nick + ' | ' + cells.join(' | ') + ' | ' + (p.roundPts || 0) + ' |');
      });
      return lines.join('\n');
    }

    function injectStyles() {
      if (document.getElementById('orbit-bac-live-css')) return;
      var el = document.createElement('style');
      el.id = 'orbit-bac-live-css';
      el.textContent = [
        '.oblive-panel{flex:0 0 auto;width:100%;border-bottom:1px solid var(--border,#ddd);background:var(--bg,#fff);font-family:var(--font,system-ui,sans-serif)}',
        '.oblive-panel--collapsed .oblive-body,.oblive-panel--collapsed .oblive-foot{display:none}',
        '.oblive-head{display:flex;align-items:center;gap:.45rem;padding:.38rem .75rem;background:color-mix(in srgb,var(--accent,#6366f1) 8%,var(--bg,#fff));color:var(--ink,#111);cursor:pointer}',
        '.oblive-head__title{font-weight:800;font-size:.78rem;flex:1}',
        '.oblive-head__meta{font-size:.65rem;font-weight:700;padding:.1rem .4rem;border-radius:999px;background:var(--bg-soft,rgba(127,127,127,.1))}',
        '.oblive-head__btn{border:0;background:var(--bg-soft,rgba(127,127,127,.12));color:var(--ink,#111);width:28px;height:28px;border-radius:7px;cursor:pointer}',
        '.oblive-body{padding:.55rem .65rem .65rem;overflow-x:auto}',
        '.oblive-grid{width:100%;border-collapse:collapse;font-size:.74rem}',
        '.oblive-grid th,.oblive-grid td{border:1px solid var(--border,#ddd);padding:.32rem .4rem;text-align:center;vertical-align:middle}',
        '.oblive-grid th{background:var(--bg-soft,rgba(127,127,127,.08));font-weight:800;color:var(--ink,#111)}',
        '.oblive-grid th.oblive-sticky,.oblive-grid td.oblive-sticky{position:sticky;left:0;z-index:1;background:var(--bg,#fff);text-align:left;min-width:5.5rem;max-width:7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.oblive-grid td.oblive-cell--ok{background:color-mix(in srgb,#22c55e 18%,transparent);font-weight:700}',
        '.oblive-grid td.oblive-cell--bonus{background:color-mix(in srgb,#f59e0b 22%,transparent);font-weight:800}',
        '.oblive-grid td.oblive-cell--empty{color:var(--muted,#999)}',
        '.oblive-grid td.oblive-pts{font-weight:800;font-variant-numeric:tabular-nums;color:var(--accent,#6366f1)}',
        '.oblive-grid tr.oblive-me td.oblive-sticky{font-weight:800;color:#6366f1}',
        '.oblive-grid tr.oblive-combo td.oblive-sticky::after{content:" 🔥";font-size:.7rem}',
        '.oblive-foot{display:flex;gap:.4rem;padding:.45rem .65rem .55rem;border-top:1px solid var(--border,#ddd)}',
        '.oblive-foot__btn{flex:1;border:0;border-radius:8px;padding:.38rem .5rem;font-size:.72rem;font-weight:800;cursor:pointer;background:var(--bg-soft,rgba(127,127,127,.1));color:var(--ink,#111)}',
        '.oblive-foot__btn:hover{filter:brightness(1.05)}',
        '.oblive-idle{font-size:.8rem;color:var(--muted,#666);text-align:center;padding:.65rem;line-height:1.4}',
        '.oblive-stats{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.45rem}',
        '.oblive-stat{flex:1;min-width:4.5rem;padding:.35rem .45rem;border-radius:8px;background:var(--bg-soft,rgba(127,127,127,.08));text-align:center}',
        '.oblive-stat__n{display:block;font-size:1rem;font-weight:900;color:var(--accent,#6366f1)}',
        '.oblive-stat__l{font-size:.62rem;font-weight:700;text-transform:uppercase;color:var(--muted,#666)}',
        '.oblive-topbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:1px solid var(--border,#ccc);background:var(--bg,#fff);cursor:pointer;font-size:.95rem}',
        '.oblive-topbtn.on{background:linear-gradient(135deg,#0ea5e9,#6366f1);color:#fff;border-color:transparent}',
      ].join('');
      document.head.appendChild(el);
    }

    function renderPanel(orbit, root) {
      var buffer = orbit.state.active();
      var open = false;
      try { open = orbit.storage.get(STORAGE_OPEN, cfg(orbit).defaultOpen); } catch (e) { open = cfg(orbit).defaultOpen; }

      if (!channelEnabled(orbit, buffer) || !open) {
        root.style.display = 'none';
        return;
      }
      root.style.display = '';

      var board = getBoard(buffer) || defaultBoard();
      var myNick = orbit.state.nick() || '';
      var collapsed = cfg(orbit).defaultCollapsed;
      try { collapsed = orbit.storage.get(STORAGE_COLLAPSED, collapsed); } catch (e) { /* ignore */ }
      var players = playerList(board, cfg(orbit).maxPlayers);
      var showBoard = board.phase !== 'idle'
        && board.categories.length > 0
        && (players.length > 0 || board.letter);

      var stats = { validated: 0, points: 0, combos: 0 };
      try { stats = orbit.storage.get(STORAGE_STATS, stats); } catch (e) { /* ignore */ }

      var gridHtml = '';
      if (showBoard) {
        var headCats = board.categories.map(function (cat) {
          return '<th>' + escHtml(cat) + '</th>';
        }).join('');
        var rows = players.map(function (p) {
          var isMe = myNick && p.nick.toLowerCase() === myNick.toLowerCase();
          var filled = board.categories.filter(function (c) { return p.answers[c.toLowerCase()]; }).length;
          var combo = filled >= board.categories.length && board.categories.length > 0;
          var rowCls = (isMe ? ' oblive-me' : '') + (combo ? ' oblive-combo' : '');
          var cells = board.categories.map(function (cat) {
            var a = p.answers[cat.toLowerCase()];
            if (!a) return '<td class="oblive-cell--empty">—</td>';
            var cls = a.pts > 1 ? 'oblive-cell--bonus' : 'oblive-cell--ok';
            return '<td class="' + cls + '" title="+' + a.pts + ' pt">' + escHtml(a.word) + '</td>';
          }).join('');
          return '<tr class="' + rowCls + '">' +
            '<td class="oblive-sticky">' + escHtml(p.nick) + '</td>' + cells +
            '<td class="oblive-pts">' + (p.roundPts || 0) + '</td></tr>';
        }).join('');

        gridHtml =
          '<table class="oblive-grid"><thead><tr>' +
            '<th class="oblive-sticky">' + escHtml(pick({ fr: 'Joueur', en: 'Player' })) + '</th>' +
            headCats +
            '<th>' + escHtml(pick({ fr: 'Pts', en: 'Pts' })) + '</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }

      root.className = 'oblive-panel' + (collapsed ? ' oblive-panel--collapsed' : '');
      root.innerHTML =
        '<div class="oblive-head">' +
          '<span class="oblive-head__title">📊 ' + escHtml(pick({ fr: 'Scores live', en: 'Live scores' })) + '</span>' +
          (board.letter
            ? ('<span class="oblive-head__meta">' + escHtml(board.letter) +
               (board.round && board.totalRounds ? (' · ' + board.round + '/' + board.totalRounds) : '') + '</span>')
            : '') +
          '<button type="button" class="oblive-head__btn" data-act="collapse" title="' +
            escHtml(pick({ fr: 'Réduire', en: 'Collapse' })) + '">' + (collapsed ? '▾' : '▴') + '</button>' +
        '</div>' +
        '<div class="oblive-body">' +
          (showBoard
            ? ('<div class="oblive-stats">' +
                '<div class="oblive-stat"><span class="oblive-stat__n">' + stats.validated + '</span>' +
                  '<span class="oblive-stat__l">' + escHtml(pick({ fr: 'Mots', en: 'Words' })) + '</span></div>' +
                '<div class="oblive-stat"><span class="oblive-stat__n">' + stats.points + '</span>' +
                  '<span class="oblive-stat__l">' + escHtml(pick({ fr: 'Points', en: 'Points' })) + '</span></div>' +
                '<div class="oblive-stat"><span class="oblive-stat__n">' + stats.combos + '</span>' +
                  '<span class="oblive-stat__l">' + escHtml(pick({ fr: 'Grilles', en: 'Full rows' })) + '</span></div>' +
              '</div>' + gridHtml)
            : ('<div class="oblive-idle">' + escHtml(pick({
              fr: 'Le tableau se remplit au fur et à mesure que les joueurs valident leurs mots.',
              en: 'The board fills in as players validate their words.',
            })) + '</div>')) +
        '</div>' +
        (showBoard
          ? ('<div class="oblive-foot">' +
              '<button type="button" class="oblive-foot__btn" data-act="copy">' +
                escHtml(pick({ fr: 'Copier le récap', en: 'Copy recap' })) + '</button>' +
              '<button type="button" class="oblive-foot__btn" data-act="hide">' +
                escHtml(pick({ fr: 'Masquer', en: 'Hide' })) + '</button></div>')
          : '');
    }

    function mountPanel(orbit) {
      var root = document.getElementById('oblive-dom-panel');
      if (!root) {
        root = document.createElement('div');
        root.id = 'oblive-dom-panel';
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', pick({ fr: 'Tableau live Petit Bac', en: 'Petit Bac live board' }));
      }
      var main = document.querySelector('.main');
      var anchor = document.getElementById('opbac-dom-panel');
      var topbar = main && main.querySelector('.topbar');
      if (!main || !topbar) return;

      if (anchor && anchor.parentNode === main) {
        if (root.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', root);
      } else if (root.previousElementSibling !== topbar) {
        topbar.insertAdjacentElement('afterend', root);
      }

      if (!root.__obliveBound) {
        root.__obliveBound = true;
        root.addEventListener('click', function (ev) {
          var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
          if (!btn) return;
          var act = btn.getAttribute('data-act');
          if (act === 'collapse') {
            var was = true;
            try { was = orbit.storage.get(STORAGE_COLLAPSED, true); } catch (e) { /* ignore */ }
            try { orbit.storage.set(STORAGE_COLLAPSED, !was); } catch (e2) { /* ignore */ }
            renderPanel(orbit, root);
          }
          if (act === 'hide') {
            try { orbit.storage.set(STORAGE_OPEN, false); } catch (e) { /* ignore */ }
            renderPanel(orbit, root);
          }
          if (act === 'copy') {
            var buffer = orbit.state.active();
            var md = buildRecapMarkdown(getBoard(buffer) || defaultBoard());
            if (md && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(md).then(function () {
                orbit.notify('Petit Bac', pick({ fr: 'Récap copié !', en: 'Recap copied!' }));
              });
            }
          }
        });
      }

      renderPanel(orbit, root);
    }

    Orbit.plugin('orbit-bac-live', function (orbit, log) {
      pluginOrbit = orbit;
      orbitRef = orbit;
      injectStyles();
      console.info('[orbit-bac-live] loaded v' + LIVE_VER);

      function sync() {
        try { mountPanel(orbit); } catch (e) { console.error('[orbit-bac-live]', e); }
      }

      subscribe(sync);

      orbit.on('raw', function (msg) {
        var cmd = String(msg.command || '').toUpperCase();
        if (cmd === 'TAGMSG') {
          var tags = msg.tags || {};
          if (tagVal(tags, PB) !== 'v1') return;
          var target = (msg.params && msg.params[0]) || '';
          if (!isChannelName(target) || !channelEnabled(orbit, target)) return;
          handleTagEvent(target, tags);
          return;
        }
        if (cmd === 'PRIVMSG' || cmd === 'NOTICE') {
          var chan = (msg.params && msg.params[0]) || '';
          if (!isChannelName(chan) || !channelEnabled(orbit, chan)) return;
          handleIrcLine(chan, msg.nick, (msg.params && msg.params[1]) || '', orbit.state.nick() || '');
        }
      });

      orbit.on('buffer.active', sync);
      orbit.on('connected', sync);

      try {
        window.addEventListener('orbit-bac-live-sync', sync);
      } catch (e) { /* ignore */ }

      var React = Orbit.React;
      var h = React.createElement;
      var useSyncExternalStore = React.useSyncExternalStore;

      function useActiveBuffer() {
        return useSyncExternalStore(
          function (cb) { return orbit.on('buffer.active', cb); },
          function () { return orbit.state.active(); },
          function () { return orbit.state.active(); }
        );
      }

      orbit.addUi('topbar_item', function () {
        var buffer = useActiveBuffer();
        if (!buffer || !channelEnabled(orbit, buffer)) return null;
        var board = getBoard(buffer);
        var live = board && board.phase !== 'idle' && board.categories.length > 0;
        var open = true;
        try { open = orbit.storage.get(STORAGE_OPEN, cfg(orbit).defaultOpen); } catch (e) { /* ignore */ }
        return h('button', {
          type: 'button',
          className: 'oblive-topbtn' + (live && open ? ' on' : ''),
          title: pick({ fr: 'Tableau live Petit Bac', en: 'Petit Bac live board' }),
          onClick: function () {
            try { orbit.storage.set(STORAGE_OPEN, !open); } catch (e) { /* ignore */ }
            sync();
          },
        }, '📊');
      });

      orbit.addCommand('bacboard', {
        help: pick({ fr: 'Afficher/masquer le tableau live Petit Bac', en: 'Toggle Petit Bac live board' }),
        run: function () {
          var open = false;
          try { open = orbit.storage.get(STORAGE_OPEN, cfg(orbit).defaultOpen); } catch (e) { /* ignore */ }
          try {
            orbit.storage.set(STORAGE_OPEN, !open);
            if (!open) orbit.storage.set(STORAGE_COLLAPSED, false);
          } catch (e2) { /* ignore */ }
          sync();
          orbit.notify('Petit Bac', !open
            ? pick({ fr: 'Scores affichés', en: 'Scores shown' })
            : pick({ fr: 'Scores masqués', en: 'Scores hidden' }));
        },
      });

      log('orbit-bac-live ready');
      sync();
    });
  }

  boot(0);
})();
