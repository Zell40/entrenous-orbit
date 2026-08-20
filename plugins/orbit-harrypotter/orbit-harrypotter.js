/*!
 * orbit-harrypotter — panneau Orbit pour le bot Limnoria HarryPotter
 * Écoute les TAGMSG IRCv3 : +hp=v1 +ev=<event>
 */
(function () {
  'use strict';

  var HP_VER = 1;
  var HP = '+hp';
  var EV = '+ev';
  var HOUSES = {
    G: { name: 'Gryffondor', color: '#c11b1b', bg: '#740001' },
    S: { name: 'Serpentard', color: '#2ecc71', bg: '#1a472a' },
    P: { name: 'Poufsouffle', color: '#f1c40f', bg: '#946b2d' },
    R: { name: 'Serdaigle', color: '#5dade2', bg: '#0e1a40' }
  };

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (retry < 80) setTimeout(function () { boot(retry + 1); }, 50);
      else console.error('[orbit-harrypotter] Orbit API unavailable after retries');
      return;
    }
    if (window.__ORBIT_HARRYPOTTER__ === HP_VER) return;
    window.__ORBIT_HARRYPOTTER__ = HP_VER;

  var pluginOrbit = null;
  var store = { byChannel: {}, rev: 0, listeners: [] };
  var syncAt = Object.create(null);

  function subscribe(fn) {
    store.listeners.push(fn);
    return function () {
      store.listeners = store.listeners.filter(function (l) { return l !== fn; });
    };
  }

  function emit() {
    store.rev++;
    store.listeners.forEach(function (l) { l(); });
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
    var c = (orbit.config().harrypotter) || {};
    var channels = c.channels;
    if (!Array.isArray(channels) || !channels.length) {
      channels = ['#HarryPotter.chat'];
    }
    return {
      channels: channels.map(normChan),
      channelsAll: channels.some(function (ch) { return ch === '*'; }),
      showWhenIdle: c.showWhenIdle !== false,
      defaultCollapsed: !!c.defaultCollapsed,
      botNicks: Array.isArray(c.botNicks) && c.botNicks.length
        ? c.botNicks.map(function (n) { return String(n || '').toLowerCase(); })
        : ['harrypotter', 'poudlard', 'choixpeau', 'mimsy']
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

  function isHpChannel(orbit, channelKey) {
    if (!channelKey) return false;
    var name = resolveChannelName(orbit, channelKey);
    var n = normChan(name);
    if (!isChannelName(n) && !isChannelName(name)) return false;
    if (/harrypotter/i.test(n)) return true;
    var c = cfg(orbit);
    if (c.channelsAll) return true;
    return c.channels.indexOf(n) >= 0;
  }

  function defaultState() {
    return {
      phase: 'idle',
      houses: { G: 0, S: 0, P: 0, R: 0 },
      ranking: [],
      q: '',
      inc: '',
      p1: '',
      p2: '',
      timeout: 0,
      left: 0,
      deadline: 0,
      sortText: '',
      sortNick: '',
      sortHouse: '',
      sortStep: 0,
      lastEvent: '',
      toast: '',
      updatedAt: 0
    };
  }

  function getChannelState(channel) {
    return store.byChannel[normChan(channel)] || defaultState();
  }

  function setChannelState(channel, next) {
    store.byChannel[normChan(channel)] = next;
    emit();
  }

  function patchChannel(channel, patch) {
    var prev = getChannelState(channel);
    setChannelState(channel, Object.assign({}, prev, patch, { updatedAt: Date.now() }));
  }

  function tagVal(tags, name) {
    if (!tags) return '';
    if (Object.prototype.hasOwnProperty.call(tags, name)) return String(tags[name] || '');
    var alt = name.charAt(0) === '+' ? name.slice(1) : '+' + name;
    if (Object.prototype.hasOwnProperty.call(tags, alt)) return String(tags[alt] || '');
    return '';
  }

  function parseHouses(raw) {
    var out = { G: 0, S: 0, P: 0, R: 0 };
    String(raw || '').split(',').forEach(function (chunk) {
      var p = String(chunk || '').split(':');
      if (p.length < 2) return;
      var k = p[0].toUpperCase();
      if (out.hasOwnProperty(k)) out[k] = Number(p[1]) || 0;
    });
    return out;
  }

  function parseRanking(raw) {
    return String(raw || '').split(',').map(function (chunk) {
      var p = String(chunk || '').split(':');
      if (p.length < 3) return null;
      return { nick: p[0], house: p[1], pts: Number(p[2]) || 0 };
    }).filter(Boolean);
  }

  function startTimer(channel, timeout, left) {
    var sec = Number(left || timeout || 0);
    return {
      timeout: Number(timeout) || sec,
      left: sec,
      deadline: sec > 0 ? Date.now() + sec * 1000 : 0
    };
  }

  function remainingOf(game) {
    if (!game || !game.deadline) return 0;
    return Math.max(0, Math.ceil((game.deadline - Date.now()) / 1000));
  }

  function handleHpEvent(channel, tags) {
    if (tagVal(tags, HP) !== 'v1') return;
    var ev = tagVal(tags, EV);
    var t;

    switch (ev) {
      case 'game_start':
        patchChannel(channel, Object.assign(defaultState(), {
          phase: 'waiting', lastEvent: ev
        }));
        break;
      case 'game_end':
        patchChannel(channel, {
          phase: 'ended',
          lastEvent: ev,
          toast: 'Coupe : ' + (tagVal(tags, '+winner') || '') + ' (' + (tagVal(tags, '+points') || '0') + ' pts)',
          houses: parseHouses(tagVal(tags, '+houses')),
          ranking: parseRanking(tagVal(tags, '+ranking')),
          deadline: 0
        });
        break;
      case 'sorting':
        patchChannel(channel, {
          phase: 'sorting',
          lastEvent: ev,
          sortStep: Number(tagVal(tags, '+step')) || 0,
          sortText: tagVal(tags, '+text'),
          sortNick: tagVal(tags, '+nick'),
          sortHouse: tagVal(tags, '+house')
        });
        break;
      case 'house_join':
        patchChannel(channel, {
          phase: 'waiting',
          lastEvent: ev,
          toast: (tagVal(tags, '+nick') || '') + ' → ' + (tagVal(tags, '+house') || ''),
          sortHouse: tagVal(tags, '+house')
        });
        break;
      case 'year_start':
        patchChannel(channel, { phase: 'playing', lastEvent: ev, toast: 'L\'année commence !' });
        break;
      case 'question':
        t = startTimer(channel, tagVal(tags, '+timeout'), tagVal(tags, '+timeout'));
        patchChannel(channel, Object.assign({
          phase: 'question',
          lastEvent: ev,
          q: tagVal(tags, '+q'),
          toast: tagVal(tags, '+taunt')
        }, t));
        break;
      case 'answer_ok':
        patchChannel(channel, {
          phase: 'playing', lastEvent: ev, deadline: 0, q: '',
          toast: '✅ ' + tagVal(tags, '+nick') + ' +' + (tagVal(tags, '+points') || '10')
        });
        break;
      case 'answer_ko':
        patchChannel(channel, {
          lastEvent: ev,
          toast: '❌ ' + tagVal(tags, '+nick')
        });
        break;
      case 'question_expire':
        patchChannel(channel, { phase: 'playing', lastEvent: ev, deadline: 0, q: '', toast: 'Question expirée' });
        break;
      case 'spell':
        t = startTimer(channel, tagVal(tags, '+timeout'), tagVal(tags, '+timeout'));
        patchChannel(channel, Object.assign({
          phase: 'spell', lastEvent: ev,
          inc: tagVal(tags, '+inc'),
          toast: tagVal(tags, '+taunt')
        }, t));
        break;
      case 'spell_ok':
        patchChannel(channel, {
          phase: 'playing', lastEvent: ev, deadline: 0, inc: '',
          toast: '🌟 ' + tagVal(tags, '+nick') + ' +' + (tagVal(tags, '+points') || '8')
        });
        break;
      case 'spell_ko':
        patchChannel(channel, { lastEvent: ev, toast: '🙃 ' + tagVal(tags, '+nick') });
        break;
      case 'spell_expire':
        patchChannel(channel, { phase: 'playing', lastEvent: ev, deadline: 0, inc: '', toast: 'Sort expiré' });
        break;
      case 'duel_start':
        t = startTimer(channel, tagVal(tags, '+timeout'), tagVal(tags, '+timeout'));
        patchChannel(channel, Object.assign({
          phase: 'duel', lastEvent: ev,
          p1: tagVal(tags, '+p1'), p2: tagVal(tags, '+p2'),
          toast: tagVal(tags, '+taunt')
        }, t));
        break;
      case 'duel_choice':
        patchChannel(channel, { lastEvent: ev, toast: tagVal(tags, '+nick') + ' a choisi.' });
        break;
      case 'duel_tie':
        t = startTimer(channel, 30, 30);
        patchChannel(channel, Object.assign({
          phase: 'duel', lastEvent: ev,
          toast: 'Égalité ' + tagVal(tags, '+s1') + ' vs ' + tagVal(tags, '+s2')
        }, t));
        break;
      case 'duel_win':
        patchChannel(channel, {
          phase: 'playing', lastEvent: ev, deadline: 0, p1: '', p2: '',
          toast: '🏅 ' + tagVal(tags, '+winner') + ' (' + tagVal(tags, '+s1') + ' bat ' + tagVal(tags, '+s2') + ')'
        });
        break;
      case 'duel_expire':
        patchChannel(channel, { phase: 'playing', lastEvent: ev, deadline: 0, p1: '', p2: '', toast: 'Duel expiré' });
        break;
      case 'score':
      case 'state_sync':
        patchChannel(channel, {
          lastEvent: ev,
          phase: tagVal(tags, '+phase') || getChannelState(channel).phase,
          q: tagVal(tags, '+q') || (ev === 'state_sync' ? '' : getChannelState(channel).q),
          inc: tagVal(tags, '+inc') || (ev === 'state_sync' ? getChannelState(channel).inc : getChannelState(channel).inc),
          p1: tagVal(tags, '+p1') || getChannelState(channel).p1,
          p2: tagVal(tags, '+p2') || getChannelState(channel).p2,
          houses: parseHouses(tagVal(tags, '+houses')) ,
          ranking: parseRanking(tagVal(tags, '+ranking')),
          timeout: Number(tagVal(tags, '+timeout')) || getChannelState(channel).timeout,
          left: Number(tagVal(tags, '+left')) || 0,
          deadline: Number(tagVal(tags, '+left')) > 0
            ? Date.now() + Number(tagVal(tags, '+left')) * 1000
            : getChannelState(channel).deadline
        });
        break;
      case 'ambiance':
      case 'mimsy':
        patchChannel(channel, { lastEvent: ev, toast: tagVal(tags, '+text') });
        break;
      case 'nick_transform':
        patchChannel(channel, {
          lastEvent: ev,
          toast: tagVal(tags, '+nick') + ' devient ' + tagVal(tags, '+game_nick')
        });
        break;
      default:
        break;
    }
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function injectStyles() {
    if (document.getElementById('orbit-harrypotter-css')) return;
    var el = document.createElement('style');
    el.id = 'orbit-harrypotter-css';
    el.textContent = [
      '.ohp-panel{flex:0 0 auto;border-bottom:1px solid color-mix(in srgb,#c9a227 35%,var(--border,#333));background:linear-gradient(180deg,#1a1208,#120c06 55%,var(--bg,#111));color:#f4e4c1;font-size:13px}',
      '.ohp-panel[hidden]{display:none!important}',
      '.ohp-bar{display:flex;align-items:center;gap:.6rem;padding:.45rem .75rem;min-height:2.4rem}',
      '.ohp-title{font-weight:700;letter-spacing:.04em;color:#e8c547;white-space:nowrap}',
      '.ohp-toast{flex:1;min-width:0;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ohp-clock{font-variant-numeric:tabular-nums;background:#2a1c0a;border:1px solid #c9a227;border-radius:999px;padding:.15rem .55rem;color:#f1c40f}',
      '.ohp-houses{display:grid;grid-template-columns:repeat(4,1fr);gap:.35rem;padding:0 .75rem .45rem}',
      '.ohp-house{border-radius:8px;padding:.25rem .4rem;text-align:center;font-size:11px;border:1px solid transparent}',
      '.ohp-house b{display:block;font-size:14px}',
      '.ohp-stage{padding:.15rem .75rem .7rem}',
      '.ohp-card{border:1px solid color-mix(in srgb,#c9a227 40%,transparent);border-radius:12px;padding:.7rem .8rem;background:color-mix(in srgb,#2a1c0a 70%,transparent)}',
      '.ohp-q{font-size:15px;line-height:1.35;margin:0 0 .5rem}',
      '.ohp-row{display:flex;gap:.4rem;flex-wrap:wrap}',
      '.ohp-row input{flex:1;min-width:8rem;border-radius:8px;border:1px solid #c9a227;background:#0e0a05;color:#f4e4c1;padding:.4rem .55rem}',
      '.ohp-btn{border:0;border-radius:8px;padding:.4rem .7rem;cursor:pointer;background:#c9a227;color:#1a1208;font-weight:700}',
      '.ohp-btn.ghost{background:transparent;color:#e8c547;border:1px solid #c9a227}',
      '.ohp-hat{font-size:1.4rem;margin-bottom:.35rem}',
      '.ohp-rank{margin:.4rem 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.35rem .7rem}',
      '.ohp-idle{display:flex;align-items:center;justify-content:space-between;gap:.6rem}',
      '.ohp-spells{display:flex;gap:.4rem;flex-wrap:wrap}'
    ].join('');
    document.head.appendChild(el);
  }

  function send(orbit, buffer, text) {
    if (!orbit || !buffer || !text) return;
    try { orbit.irc.msg(buffer, text); } catch (e) { /* ignore */ }
  }

  function houseBlock(houses) {
    return Object.keys(HOUSES).map(function (k) {
      var h = HOUSES[k];
      var pts = (houses && houses[k]) || 0;
      return '<div class="ohp-house" style="border-color:' + h.color + ';background:color-mix(in srgb,' + h.bg + ' 55%,transparent)">' +
        escHtml(h.name) + '<b>' + pts + '</b></div>';
    }).join('');
  }

  function renderDomPanel(orbit, root) {
    var buffer = orbit.state.active();
    var on = isHpChannel(orbit, buffer);
    var c = cfg(orbit);
    if (!on) {
      root.hidden = true;
      root.innerHTML = '';
      return;
    }
    var game = getChannelState(buffer);
    if (game.phase === 'idle' && !c.showWhenIdle) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    var left = remainingOf(game);
    var stage = '';
    var prevInp = root.querySelector('[data-role="answer"]');
    var keepAnswer = (prevInp && document.activeElement === prevInp) ? prevInp.value : null;

    if (game.phase === 'idle' || game.phase === 'ended') {
      stage = '<div class="ohp-card ohp-idle"><div>' +
        (game.phase === 'ended' ? escHtml(game.toast || 'Partie terminée') : 'Le Choixpeau attend les élèves…') +
        '</div><div class="ohp-row">' +
        '<button class="ohp-btn" data-act="jouer">⚡ Jouer</button>' +
        '<button class="ohp-btn ghost" data-act="rejoindre">🎩 Rejoindre</button>' +
        '</div></div>';
    } else if (game.phase === 'sorting') {
      stage = '<div class="ohp-card"><div class="ohp-hat">🎩</div><div class="ohp-q">' +
        escHtml(game.sortText || 'Hmm… voyons voir…') + '</div>' +
        (game.sortHouse ? '<div>Maison : <b>' + escHtml(game.sortHouse) + '</b></div>' : '') +
        '</div>';
    } else if (game.phase === 'waiting') {
      stage = '<div class="ohp-card ohp-idle"><div>🎓 Rejoins la partie pour recevoir ta maison.</div>' +
        '<button class="ohp-btn" data-act="rejoindre">🎩 Rejoindre</button></div>';
    } else if (game.phase === 'question') {
      stage = '<div class="ohp-card"><p class="ohp-q">❓ ' + escHtml(game.q || 'Question en cours…') + '</p>' +
        '<div class="ohp-row"><input data-role="answer" placeholder="Ta réponse…" maxlength="80"/>' +
        '<button class="ohp-btn" data-act="reponse">Répondre</button></div></div>';
    } else if (game.phase === 'spell') {
      stage = '<div class="ohp-card"><p class="ohp-q">✨ Lance exactement : <b>' + escHtml(game.inc) + '</b></p>' +
        '<button class="ohp-btn" data-act="lancer">Lancer ' + escHtml(game.inc) + '</button></div>';
    } else if (game.phase === 'duel') {
      stage = '<div class="ohp-card"><p class="ohp-q">⚔️ ' + escHtml(game.p1) + ' vs ' + escHtml(game.p2) + '</p>' +
        '<div class="ohp-spells">' +
        '<button class="ohp-btn" data-act="choisir" data-spell="Expelliarmus">Expelliarmus</button>' +
        '<button class="ohp-btn" data-act="choisir" data-spell="Stupefy">Stupefy</button>' +
        '<button class="ohp-btn ghost" data-act="choisir" data-spell="Protego">Protego</button>' +
        '</div></div>';
    } else {
      stage = '<div class="ohp-card">🪄 Cours en cours… Mimsy prépare le prochain défi.</div>';
    }

    var ranks = (game.ranking || []).map(function (r) {
      var h = HOUSES[r.house] || {};
      return '<li><span style="color:' + (h.color || '#e8c547') + '">' + escHtml(r.nick) + '</span> · ' + r.pts + ' pts</li>';
    }).join('');

    root.innerHTML =
      '<div class="ohp-bar"><span class="ohp-title">⚡ Poudlard</span>' +
      '<span class="ohp-toast">' + escHtml(game.toast || '') + '</span>' +
      (left ? '<span class="ohp-clock">' + left + 's</span>' : '') +
      '</div>' +
      '<div class="ohp-houses">' + houseBlock(game.houses) + '</div>' +
      '<div class="ohp-stage">' + stage +
      (ranks ? '<ul class="ohp-rank">' + ranks + '</ul>' : '') +
      '</div>';

    root.onclick = function (ev) {
      var btn = ev.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'jouer') send(orbit, buffer, '!jouer');
      if (act === 'rejoindre') send(orbit, buffer, '!rejoindre');
      if (act === 'lancer') send(orbit, buffer, '!lancer ' + (game.inc || ''));
      if (act === 'choisir') send(orbit, buffer, '!choisir ' + (btn.getAttribute('data-spell') || ''));
      if (act === 'reponse') {
        var inp = root.querySelector('[data-role="answer"]');
        var word = inp && inp.value.trim();
        if (word) send(orbit, buffer, '!reponse ' + word);
      }
    };
    root.onkeydown = function (ev) {
      if (ev.key !== 'Enter') return;
      var inp = ev.target;
      if (!inp || inp.getAttribute('data-role') !== 'answer') return;
      var word = inp.value.trim();
      if (word) send(orbit, buffer, '!reponse ' + word);
    };
    if (keepAnswer !== null) {
      var restore = root.querySelector('[data-role="answer"]');
      if (restore) {
        restore.value = keepAnswer;
        restore.focus();
      }
    }
  }

  function mountDomPanel(orbit) {
    var root = document.getElementById('ohp-dom-panel');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ohp-dom-panel';
      root.className = 'ohp-panel';
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', 'Harry Potter');
    }
    var main = document.querySelector('.main');
    var topbar = main && main.querySelector('.topbar');
    if (!main || !topbar) return;
    if (root.parentNode !== main || root.previousElementSibling !== topbar) {
      var bac = document.getElementById('opbac-dom-panel');
      if (bac && bac.parentNode === main) bac.insertAdjacentElement('afterend', root);
      else topbar.insertAdjacentElement('afterend', root);
    }
    renderDomPanel(orbit, root);
  }

  Orbit.plugin('orbit-harrypotter', function (orbit, log) {
    pluginOrbit = orbit;
    injectStyles();
    console.info('[orbit-harrypotter] loaded v' + HP_VER);

    function syncDom() {
      try { mountDomPanel(orbit); } catch (e) { console.error('[orbit-harrypotter] panel', e); }
    }

    subscribe(function () { syncDom(); });

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '').toUpperCase();
      if (cmd !== 'TAGMSG') return;
      var tags = msg.tags || {};
      if (tagVal(tags, HP) !== 'v1') return;
      var target = (msg.params && msg.params[0]) || '';
      if (!isChannelName(target)) return;
      if (!isHpChannel(orbit, target)) return;
      handleHpEvent(target, tags);
      log('orbit-harrypotter', tagVal(tags, EV), target);
    });

    orbit.on('buffer.active', function () {
      var buf = orbit.state.active();
      if (isHpChannel(orbit, buf)) {
        var g = getChannelState(buf);
        var key = normChan(resolveChannelName(orbit, buf) || buf);
        var now = Date.now();
        if (g.phase && g.phase !== 'idle' && g.phase !== 'ended' && (!syncAt[key] || now - syncAt[key] > 8000)) {
          syncAt[key] = now;
          send(orbit, buf, '!etat');
        }
      }
      syncDom();
    });
    orbit.on('connected', syncDom);
    orbit.on('status', syncDom);
    setInterval(function () {
      var root = document.getElementById('ohp-dom-panel');
      if (!root || root.hidden) return;
      var buf = orbit.state.active();
      if (!buf || !isHpChannel(orbit, buf)) return;
      var left = remainingOf(getChannelState(buf));
      var clock = root.querySelector('.ohp-clock');
      if (clock) {
        clock.textContent = left ? left + 's' : '';
        clock.hidden = !left;
        return;
      }
      if (left) syncDom();
    }, 250);

    orbit.addCommand('jouer', {
      help: 'Lancer une partie Harry Potter',
      run: function () {
        var buf = orbit.state.active();
        if (!buf || !isHpChannel(orbit, buf)) {
          orbit.notify('Poudlard', 'Ouvrez #HarryPotter.chat d\'abord.');
          return;
        }
        send(orbit, buf, '!jouer');
      }
    });

    log('orbit-harrypotter ready');
  });
  }

  boot(0);
})();
