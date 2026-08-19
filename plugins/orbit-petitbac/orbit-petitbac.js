/*!
 * orbit-petitbac — UI moderne pour le bot Limnoria Petit Bac (EntreNous)
 * Écoute les TAGMSG IRCv3 : +pb=v1 +ev=<event> (+letter, +categories, …)
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var React = Orbit.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useSyncExternalStore = React.useSyncExternalStore;

  var PB = '+pb';
  var EV = '+ev';
  var STORAGE_COLLAPSED = 'panelCollapsed';

  function pick(table) {
    return Orbit.i18n.pick(table);
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
    var c = (orbit.config().petitbac) || {};
    var channels = c.channels;
    if (!Array.isArray(channels) || !channels.length) {
      channels = ['#Baccalaureat.chat'];
    }
    return {
      channels: channels.map(normChan),
      channelsAll: channels.some(function (ch) { return ch === '*'; }),
      showWhenIdle: c.showWhenIdle !== false,
      defaultCollapsed: !!c.defaultCollapsed,
    };
  }

  function channelEnabled(orbit, channel) {
    var c = cfg(orbit);
    if (c.channelsAll) return isChannelName(channel);
    return c.channels.indexOf(normChan(channel)) >= 0;
  }

  function defaultState() {
    return {
      phase: 'idle',
      mode: '',
      round: 0,
      totalRounds: 0,
      letter: '',
      categories: [],
      duration: 0,
      roundStartAt: 0,
      countdown: 0,
      scores: {},
      roundScores: {},
      finalRanking: [],
      topGlobal: [],
      starter: '',
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

  function getSnap() {
    return store.rev;
  }

  function getChannelState(channel) {
    return store.byChannel[normChan(channel)] || null;
  }

  function setChannelState(channel, next) {
    var key = normChan(channel);
    if (!key) return;
    store.byChannel[key] = next;
    store.rev++;
    store.listeners.forEach(function (l) { l(); });
  }

  function patchChannel(channel, patch) {
    var key = normChan(channel);
    var prev = store.byChannel[key] || defaultState();
    setChannelState(channel, Object.assign({}, prev, patch, { updatedAt: Date.now() }));
  }

  function resetChannel(channel) {
    var key = normChan(channel);
    delete store.byChannel[key];
    store.rev++;
    store.listeners.forEach(function (l) { l(); });
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
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function rankingFromPairs(pairs) {
    if (!Array.isArray(pairs)) return [];
    return pairs.map(function (row) {
      if (Array.isArray(row)) return { nick: String(row[0] || ''), pts: Number(row[1]) || 0 };
      return { nick: String(row.nick || row.user || ''), pts: Number(row.pts || row.points) || 0 };
    });
  }

  function handlePetitBacEvent(channel, tags) {
    if (tagVal(tags, PB) !== 'v1') return;
    var ev = tagVal(tags, EV);
    if (!ev) return;

    if (ev === 'game_start') {
      patchChannel(channel, {
        phase: 'starting',
        mode: tagVal(tags, '+mode'),
        duration: Number(tagVal(tags, '+duration')) || 0,
        totalRounds: Number(tagVal(tags, '+max_rounds')) || 0,
        round: Number(tagVal(tags, '+round')) || 1,
        starter: tagVal(tags, '+starter'),
        letter: '',
        categories: [],
        scores: {},
        roundScores: {},
        countdown: 0,
        finalRanking: [],
      });
      return;
    }

    if (ev === 'rules_start') {
      patchChannel(channel, { phase: 'rules', starter: tagVal(tags, '+player') || tagVal(tags, '+starter') });
      return;
    }

    if (ev === 'countdown_start') {
      patchChannel(channel, {
        phase: 'countdown',
        countdown: Number(tagVal(tags, '+seconds')) || 0,
      });
      return;
    }

    if (ev === 'game_go') {
      patchChannel(channel, { phase: 'go', countdown: 0 });
      return;
    }

    if (ev === 'round_start') {
      var cats = tagVal(tags, '+categories');
      patchChannel(channel, {
        phase: 'playing',
        round: Number(tagVal(tags, '+round')) || 0,
        letter: tagVal(tags, '+letter'),
        categories: cats ? cats.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        duration: Number(tagVal(tags, '+duration')) || 0,
        totalRounds: Number(tagVal(tags, '+totalRounds')) || ((getChannelState(channel) || {}).totalRounds) || 0,
        roundStartAt: Date.now(),
        countdown: 0,
        roundScores: {},
      });
      return;
    }

    if (ev === 'round_countdown') {
      patchChannel(channel, {
        phase: 'playing',
        countdown: Number(tagVal(tags, '+seconds')) || 0,
      });
      return;
    }

    if (ev === 'round_end') {
      var rs = safeJson(tagVal(tags, '+round_scores'), {});
      var merged = Object.assign({}, (getChannelState(channel) || {}).scores || {});
      Object.keys(rs).forEach(function (nick) {
        merged[nick] = (merged[nick] || 0) + (Number(rs[nick]) || 0);
      });
      patchChannel(channel, {
        phase: 'round_end',
        round: Number(tagVal(tags, '+round')) || 0,
        roundScores: rs,
        scores: merged,
        roundStartAt: 0,
      });
      return;
    }

    if (ev === 'game_end') {
      var ranking = safeJson(tagVal(tags, '+final_ranking'), []);
      var topGlobal = safeJson(tagVal(tags, '+top_global'), []);
      patchChannel(channel, {
        phase: 'game_end',
        finalRanking: rankingFromPairs(ranking),
        topGlobal: rankingFromPairs(topGlobal),
        roundStartAt: 0,
        letter: '',
        categories: [],
      });
      return;
    }
  }

  function injectStyles() {
    if (document.getElementById('orbit-petitbac-css')) return;
    var el = document.createElement('style');
    el.id = 'orbit-petitbac-css';
    el.textContent = [
      '.opbac-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;border-bottom:1px solid var(--border,#333);background:var(--bg,#111);box-shadow:0 8px 28px -16px rgba(0,0,0,.35);font-family:var(--font,system-ui,sans-serif)}',
      '.opbac-panel--collapsed .opbac-body,.opbac-panel--collapsed .opbac-foot{display:none}',
      '.opbac-head{display:flex;align-items:center;gap:.5rem;padding:.55rem .75rem;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
      '.opbac-head__title{font-weight:800;font-size:.92rem;letter-spacing:.01em;flex:1}',
      '.opbac-head__badge{font-size:.68rem;font-weight:700;padding:.15rem .45rem;border-radius:999px;background:rgba(255,255,255,.22)}',
      '.opbac-head__btn{border:0;background:rgba(255,255,255,.18);color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:.85rem;line-height:1}',
      '.opbac-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.opbac-body{padding:.75rem .85rem .65rem}',
      '.opbac-hero{display:flex;align-items:center;gap:.85rem;margin-bottom:.65rem}',
      '.opbac-letter{flex:none;width:72px;height:72px;border-radius:50%;display:grid;place-items:center;font-size:2.4rem;font-weight:900;color:#fff;background:linear-gradient(145deg,#f97316,#ef4444);box-shadow:0 8px 24px -8px rgba(239,68,68,.55)}',
      '.opbac-meta{flex:1;min-width:0}',
      '.opbac-meta__round{font-size:.78rem;font-weight:700;color:var(--muted,#666);text-transform:uppercase;letter-spacing:.06em}',
      '.opbac-meta__phase{font-size:1rem;font-weight:800;color:var(--ink,#111);margin:.1rem 0 .25rem}',
      '.opbac-timer{display:flex;align-items:center;gap:.45rem}',
      '.opbac-timer__bar{flex:1;height:6px;border-radius:99px;background:var(--bg-soft,rgba(127,127,127,.15));overflow:hidden}',
      '.opbac-timer__fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#22c55e,#16a34a);transition:width .25s linear}',
      '.opbac-timer__fill--warn{background:linear-gradient(90deg,#f59e0b,#ef4444)}',
      '.opbac-timer__txt{font-size:.82rem;font-weight:800;font-variant-numeric:tabular-nums;min-width:2.5rem;text-align:right;color:var(--ink,#111)}',
      '.opbac-cats{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.15rem}',
      '.opbac-cat{font-size:.72rem;font-weight:700;padding:.28rem .55rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#6366f1) 14%,transparent);color:var(--ink,#111);border:1px solid color-mix(in srgb,var(--accent,#6366f1) 28%,transparent)}',
      '.opbac-scores{margin-top:.55rem;border-top:1px solid var(--border,#ddd);padding-top:.55rem}',
      '.opbac-scores__title{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#666);margin-bottom:.35rem}',
      '.opbac-score{display:flex;align-items:center;gap:.45rem;padding:.22rem 0;font-size:.82rem}',
      '.opbac-score__rank{width:1.2rem;font-weight:800;color:var(--muted,#888)}',
      '.opbac-score__nick{flex:1;font-weight:700;color:var(--ink,#111);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.opbac-score__pts{font-weight:800;font-variant-numeric:tabular-nums;color:var(--accent,#6366f1)}',
      '.opbac-foot{display:flex;gap:.45rem;padding:.55rem .75rem .65rem;border-top:1px solid var(--border,#ddd);background:var(--bg-soft,rgba(127,127,127,.06))}',
      '.opbac-foot__btn{flex:1;border:0;border-radius:10px;padding:.45rem .6rem;font-size:.78rem;font-weight:800;cursor:pointer;background:var(--bg,#fff);color:var(--ink,#111);border:1px solid var(--border,#ccc)}',
      '.opbac-foot__btn--primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-color:transparent}',
      '.opbac-foot__btn:hover{filter:brightness(1.05)}',
      '.opbac-idle{padding:.85rem;text-align:center}',
      '.opbac-idle__txt{font-size:.88rem;color:var(--muted,#666);margin-bottom:.55rem;line-height:1.4}',
      '.opbac-countdown{display:grid;place-items:center;padding:1rem 0}',
      '.opbac-countdown__n{font-size:3rem;font-weight:900;line-height:1;background:linear-gradient(135deg,#6366f1,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.opbac-topbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:1px solid var(--border,#ccc);background:var(--bg,#fff);cursor:pointer;font-size:1rem}',
      '.opbac-topbtn.on{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-color:transparent}',
    ].join('');
    document.head.appendChild(el);
  }

  function phaseLabel(phase, countdown) {
    if (phase === 'idle') return pick({ fr: 'En attente', en: 'Waiting' });
    if (phase === 'starting' || phase === 'rules') return pick({ fr: 'Préparation', en: 'Getting ready' });
    if (phase === 'countdown' || phase === 'go') {
      return countdown > 0
        ? pick({ fr: 'Départ dans…', en: 'Starting in…' })
        : pick({ fr: 'C\'est parti !', en: 'Go!' });
    }
    if (phase === 'playing') return pick({ fr: 'Manche en cours', en: 'Round in play' });
    if (phase === 'round_end') return pick({ fr: 'Fin de manche', en: 'Round over' });
    if (phase === 'game_end') return pick({ fr: 'Partie terminée', en: 'Game over' });
    return '';
  }

  function useChannelGame(orbit, buffer) {
    useSyncExternalStore(subscribe, getSnap, getSnap);
    return getChannelState(buffer);
  }

  function useNow(tickMs) {
    var setTick = useState(0)[1];
    useEffect(function () {
      var id = setInterval(function () { setTick(Date.now()); }, tickMs || 250);
      return function () { clearInterval(id); };
    }, [tickMs]);
  }

  function sortedScores(scores) {
    return Object.keys(scores || {})
      .map(function (nick) { return { nick: nick, pts: scores[nick] }; })
      .sort(function (a, b) { return b.pts - a.pts; })
      .slice(0, 8);
  }

  function useActiveBuffer(orbit) {
    return useSyncExternalStore(
      function (cb) { return orbit.on('buffer.active', cb); },
      function () { return orbit.state.active(); },
      function () { return orbit.state.active(); }
    );
  }

  function OpbacPanel(props) {
    var orbit = props.orbit;
    var buffer = useActiveBuffer(orbit);
    var game = useChannelGame(orbit, buffer);
    var c = cfg(orbit);
    var collapsedKey = STORAGE_COLLAPSED;
    var collapsedState = useState(function () {
      try { return orbit.storage.get(collapsedKey, c.defaultCollapsed); } catch (e) { return c.defaultCollapsed; }
    });
    var collapsed = collapsedState[0];
    var setCollapsed = collapsedState[1];
    useNow(250);

    if (!buffer || !channelEnabled(orbit, buffer)) return null;

    var phase = (game && game.phase) || 'idle';
    var showIdle = c.showWhenIdle && phase === 'idle';
    var showActive = phase !== 'idle';
    if (!showIdle && !showActive) return null;

    var now = Date.now();
    var remaining = 0;
    var progress = 0;
    if (game && game.phase === 'playing' && game.roundStartAt && game.duration > 0) {
      var elapsed = (now - game.roundStartAt) / 1000;
      remaining = Math.max(0, Math.ceil(game.duration - elapsed));
      progress = Math.min(1, elapsed / game.duration);
    }

    var scores = game && (game.phase === 'game_end' && game.finalRanking.length
      ? game.finalRanking
      : sortedScores(game.scores));

    function toggleCollapsed() {
      var next = !collapsed;
      setCollapsed(next);
      try { orbit.storage.set(collapsedKey, next); } catch (e) { /* ignore */ }
    }

    function playAgain() {
      orbit.irc.msg(buffer, '!jouer');
    }

    var panelClass = 'opbac-panel' + (collapsed ? ' opbac-panel--collapsed' : '');

    return h('div', { className: panelClass, role: 'region', 'aria-label': pick({ fr: 'Petit Bac', en: 'Petit Bac' }) },
      h('div', { className: 'opbac-head' },
        h('span', { className: 'opbac-head__title' }, pick({ fr: 'Petit Bac', en: 'Petit Bac' })),
        showActive
          ? h('span', { className: 'opbac-head__badge' },
            game.round && game.totalRounds
              ? pick({ fr: 'Manche', en: 'Round' }) + ' ' + game.round + '/' + game.totalRounds
              : phaseLabel(phase, game.countdown))
          : null,
        h('button', {
          type: 'button',
          className: 'opbac-head__btn',
          title: collapsed
            ? pick({ fr: 'Développer', en: 'Expand' })
            : pick({ fr: 'Réduire', en: 'Collapse' }),
          onClick: toggleCollapsed,
        }, collapsed ? '▾' : '▴')
      ),

        showIdle ? h('div', { className: 'opbac-body opbac-idle' },
          h('div', { className: 'opbac-idle__txt' }, pick({
            fr: 'Tapez !jouer dans le salon pour lancer une partie. Les mots se répondent ici, un par ligne et par catégorie.',
            en: 'Type !jouer in the channel to start a game. Answer here with one word per line per category.',
          })),
          h('button', { type: 'button', className: 'opbac-foot__btn opbac-foot__btn--primary', onClick: playAgain },
            pick({ fr: 'Lancer une partie', en: 'Start a game' }))
        ) : null,

        showActive ? h('div', { className: 'opbac-body' },
          (phase === 'countdown' || (phase === 'go' && game.countdown > 0))
            ? h('div', { className: 'opbac-countdown' },
              h('div', { className: 'opbac-countdown__n' }, String(game.countdown || '!')))
            : null,

          phase !== 'countdown' ? h('div', { className: 'opbac-hero' },
            game.letter
              ? h('div', { className: 'opbac-letter', 'aria-label': pick({ fr: 'Lettre', en: 'Letter' }) }, game.letter)
              : h('div', { className: 'opbac-letter', style: { fontSize: '1.4rem', background: 'linear-gradient(145deg,#6366f1,#8b5cf6)' } }, '🎲'),
            h('div', { className: 'opbac-meta' },
              h('div', { className: 'opbac-meta__round' },
                game.totalRounds
                  ? pick({ fr: 'Manche', en: 'Round' }) + ' ' + (game.round || 1) + ' / ' + game.totalRounds
                  : (game.mode || pick({ fr: 'Partie', en: 'Game' }))),
              h('div', { className: 'opbac-meta__phase' }, phaseLabel(phase, game.countdown)),
              phase === 'playing' && game.duration > 0
                ? h('div', { className: 'opbac-timer' },
                  h('div', { className: 'opbac-timer__bar' },
                    h('div', {
                      className: 'opbac-timer__fill' + (remaining <= 10 ? ' opbac-timer__fill--warn' : ''),
                      style: { width: Math.round(progress * 100) + '%' },
                    })),
                  h('span', { className: 'opbac-timer__txt' }, remaining + 's'))
                : (game.countdown > 0 && phase === 'playing'
                  ? h('div', { className: 'opbac-meta__phase', style: { fontSize: '.85rem' } },
                    pick({ fr: 'Plus que', en: 'Only' }) + ' ' + game.countdown + 's')
                  : null)
            )
          ) : null,

          game.categories && game.categories.length
            ? h('div', { className: 'opbac-cats', role: 'list' },
              game.categories.map(function (cat) {
                return h('span', { key: cat, className: 'opbac-cat', role: 'listitem' }, cat);
              }))
            : null,

          scores && scores.length
            ? h('div', { className: 'opbac-scores' },
              h('div', { className: 'opbac-scores__title' },
                phase === 'game_end'
                  ? pick({ fr: 'Classement final', en: 'Final ranking' })
                  : pick({ fr: 'Scores', en: 'Scores' })),
              scores.map(function (row, i) {
                return h('div', { key: row.nick + i, className: 'opbac-score' },
                  h('span', { className: 'opbac-score__rank' }, String(i + 1)),
                  h('span', { className: 'opbac-score__nick' }, row.nick),
                  h('span', { className: 'opbac-score__pts' }, row.pts + ' pt' + (row.pts > 1 ? 's' : '')));
              }))
            : null
        ) : null,

        showActive && !collapsed
          ? h('div', { className: 'opbac-foot' },
            h('button', {
              type: 'button',
              className: 'opbac-foot__btn',
              onClick: function () { orbit.irc.msg(buffer, '!aide'); },
            }, pick({ fr: 'Aide', en: 'Help' })),
            h('button', {
              type: 'button',
              className: 'opbac-foot__btn opbac-foot__btn--primary',
              onClick: playAgain,
            }, pick({ fr: 'Rejouer', en: 'Play again' })))
          : null
    );
  }

  function TopbarToggle(props) {
    var orbit = props.orbit;
    var buffer = useActiveBuffer(orbit);
    if (!buffer || !channelEnabled(orbit, buffer)) return null;
    var game = getChannelState(buffer);
    var live = game && game.phase !== 'idle';
    return h('button', {
      type: 'button',
      className: 'opbac-topbtn' + (live ? ' on' : ''),
      title: pick({ fr: 'Panneau Petit Bac', en: 'Petit Bac panel' }),
      'aria-label': pick({ fr: 'Panneau Petit Bac', en: 'Petit Bac panel' }),
      onClick: function () {
        if (!game || game.phase === 'idle') {
          orbit.irc.msg(buffer, '!jouer');
        }
      },
    }, '🎲');
  }

  Orbit.plugin('orbit-petitbac', function (orbit, log) {
    injectStyles();
    try { console.info('[orbit-petitbac] loading v2'); } catch (e) { /* ignore */ }

    orbit.on('raw', function (msg) {
      if (String(msg.command || '').toUpperCase() !== 'TAGMSG') return;
      var tags = msg.tags || {};
      if (tagVal(tags, PB) !== 'v1') return;
      var target = (msg.params && msg.params[0]) || '';
      if (!isChannelName(target)) return;
      if (!channelEnabled(orbit, target)) return;
      handlePetitBacEvent(target, tags);
      log('orbit-petitbac', tagVal(tags, EV), target);
    });

    orbit.addUi('overlay', function () {
      return h(OpbacPanel, { orbit: orbit });
    });

    orbit.addUi('topbar_item', function () {
      return h(TopbarToggle, { orbit: orbit });
    });

    orbit.addCommand('jouer', {
      help: pick({ fr: 'Lancer une partie de Petit Bac', en: 'Start a Petit Bac game' }),
      run: function () {
        var buf = orbit.state.active();
        if (!buf || !isChannelName(buf)) {
          orbit.notify('Petit Bac', pick({ fr: 'Ouvrez le salon #Baccalaureat.chat d\'abord.', en: 'Open #Baccalaureat.chat first.' }));
          return;
        }
        orbit.irc.msg(buf, '!jouer');
      },
    });

    log('orbit-petitbac ready');
    try { console.info('[orbit-petitbac] ready — salon(s):', (cfg(orbit).channels || []).join(', ')); } catch (e2) { /* ignore */ }
  });
})();
