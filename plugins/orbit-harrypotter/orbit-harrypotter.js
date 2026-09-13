/*!
 * orbit-harrypotter — panneau Orbit pour le bot Limnoria HarryPotter
 * Écoute les TAGMSG IRCv3 : +hp=v1 +ev=<event>
 */
(function () {
  'use strict';

  var HP_VER = 6;
  var HP = '+hp';
  var EV = '+ev';
  var VIEW_FULL = 'full';
  var VIEW_SPLIT = 'split';
  var VIEW_CHAT = 'chat';
  var STORAGE_VIEW = 'ohpViewMode';
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
  var lastFxKey = '';
  var fxTimer = 0;
  var hatUntil = 0;
  var hatTimer = 0;
  var viewMode = VIEW_FULL;
  var chatUnread = 0;
  var chatBadgeArmed = false;

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

  function isBouncerSession(orbit) {
    try {
      if (orbit.state.viaBouncer) return !!orbit.state.viaBouncer();
      return !!(orbit.state.get() || {}).viaBouncer;
    } catch (e) { return false; }
  }

  function myNick(orbit) {
    return String((orbit && orbit.state && orbit.state.nick && orbit.state.nick()) || '').toLowerCase();
  }

  function isServiceNick(nick) {
    var n = String(nick || '').toLowerCase().replace(/^[@+%~&]/, '');
    if (!n) return false;
    var bots = (pluginOrbit && cfg(pluginOrbit).botNicks) || [];
    if (bots.indexOf(n) >= 0) return true;
    if (n.length > 4 && n.slice(-4) === 'serv') return true;
    return n === 'botserv' || n === 'chanserv' || n === 'nickserv' || n === 'global';
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
      if (orbit) {
        var stored = orbit.storage.get(STORAGE_VIEW, '');
        if (stored) return normalizeViewMode(stored);
        if (cfg(orbit).defaultCollapsed) return VIEW_CHAT;
      }
    } catch (e) { /* ignore */ }
    return normalizeViewMode(viewMode);
  }

  function isNarrowScreen() {
    return window.matchMedia('(max-width:880px)').matches;
  }

  function chromeBottom() {
    var vv = window.visualViewport;
    var vh = (vv && vv.height) || window.innerHeight || 0;
    var extra = 0;
    function consider(el) {
      if (!el || (el.closest && el.closest('#ohp-dom-panel'))) return;
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
    var root = document.getElementById('ohp-dom-panel');
    var main = document.querySelector('.main');
    if (!root) return;
    var full = document.body.classList.contains('ohp-full');
    var split = document.body.classList.contains('ohp-split');
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
    document.body.classList.remove('ohp-full', 'ohp-split');
    document.documentElement.classList.remove('ohp-full', 'ohp-split');
    var root = document.getElementById('ohp-dom-panel');
    var main = document.querySelector('.main');
    if (root) {
      root.style.display = 'none';
      root.classList.remove('ohp-panel--full', 'ohp-panel--split', 'ohp-panel--chat');
    }
    clearPanelBox(root, main);
  }

  function applyViewMode(orbit, mode) {
    mode = normalizeViewMode(mode);
    viewMode = mode;
    var on = !!(orbit && isHpChannel(orbit, orbit.state.active()) && !isBouncerSession(orbit));
    if (!on) {
      clearShellLayout();
      return;
    }
    var root = document.getElementById('ohp-dom-panel');
    document.body.classList.toggle('ohp-full', mode === VIEW_FULL);
    document.body.classList.toggle('ohp-split', mode === VIEW_SPLIT);
    document.documentElement.classList.toggle('ohp-full', mode === VIEW_FULL);
    document.documentElement.classList.toggle('ohp-split', mode === VIEW_SPLIT);
    if (!root) return;
    root.hidden = false;
    root.classList.remove('ohp-panel--full', 'ohp-panel--split', 'ohp-panel--chat');
    if (mode === VIEW_CHAT || mode === VIEW_SPLIT) {
      if (chatUnread) chatUnread = 0;
    }
    if (mode === VIEW_CHAT) {
      root.classList.add('ohp-panel--chat');
      root.style.display = '';
      fitPanelToViewport();
      requestAnimationFrame(fitPanelToViewport);
      return;
    }
    root.style.display = '';
    root.classList.add(mode === VIEW_SPLIT ? 'ohp-panel--split' : 'ohp-panel--full');
    fitPanelToViewport();
    requestAnimationFrame(fitPanelToViewport);
  }

  function setViewMode(orbit, mode) {
    mode = normalizeViewMode(mode);
    viewMode = mode;
    try { if (orbit) orbit.storage.set(STORAGE_VIEW, mode); } catch (e) { /* ignore */ }
    applyViewMode(orbit, mode);
    emit();
  }

  function viewBtns(mode) {
    var layoutAct = mode === VIEW_SPLIT ? 'view-full' : 'view-split';
    var layoutIcon = mode === VIEW_SPLIT ? 'full' : 'split';
    var layoutTitle = mode === VIEW_SPLIT ? 'Jeu en plein écran' : 'Jeu + tchat';
    var paneAct = mode === VIEW_CHAT ? 'view-full' : 'view-chat';
    var paneIcon = mode === VIEW_CHAT ? 'game' : 'chat';
    var paneTitle = mode === VIEW_CHAT ? 'Afficher le jeu' : 'Afficher le tchat';
    return '<div class="ohp-head__actions">' +
      '<button type="button" class="ohp-head__btn' + (mode === VIEW_SPLIT ? ' ohp-head__btn--on' : '') +
        '" data-act="' + layoutAct + '" title="' + escHtml(layoutTitle) + '">' + iconSvg(layoutIcon) + '</button>' +
      '<button type="button" class="ohp-head__btn' + (mode === VIEW_CHAT ? ' ohp-head__btn--on' : '') +
        '" data-act="' + paneAct + '" title="' + escHtml(paneTitle) + '">' + iconSvg(paneIcon) +
        (mode !== VIEW_CHAT && chatUnread ? '<span class="ohp-head__unread">' +
          (chatUnread > 99 ? '99+' : String(chatUnread)) + '</span>' : '') +
        '</button>' +
      '</div>';
  }

  function noteIncomingChat(orbit, msg) {
    if (!chatBadgeArmed) return;
    if (getViewMode(orbit) !== VIEW_FULL) return;
    var target = (msg.params && msg.params[0]) || (msg.args && msg.args[0]) || '';
    if (!isChannelName(target) || !isHpChannel(orbit, target)) return;
    var nick = String(msg.nick || '').toLowerCase();
    if (!nick || nick === myNick(orbit) || isServiceNick(nick)) return;
    var text = String((msg.params && msg.params[1]) || (msg.args && msg.args[1]) || '');
    if (text.charAt(0) === '\x01' && text.indexOf('ACTION ') !== 0) return;
    chatUnread = Math.min(99, chatUnread + 1);
    var btn = document.querySelector('#ohp-dom-panel [data-act="view-chat"]');
    if (!btn) return;
    var badge = btn.querySelector('.ohp-head__unread');
    var label = chatUnread > 99 ? '99+' : String(chatUnread);
    if (badge) {
      badge.textContent = label;
      return;
    }
    badge = document.createElement('span');
    badge.className = 'ohp-head__unread';
    badge.textContent = label;
    btn.appendChild(badge);
  }

  function phaseBadge(game) {
    var p = game && game.phase;
    if (p === 'sorting') return 'Répartition';
    if (p === 'waiting') return 'Inscription';
    if (p === 'question') return 'Question';
    if (p === 'spell') return 'Sortilège';
    if (p === 'duel') return 'Duel';
    if (p === 'playing') return 'Cours';
    if (p === 'ended') return 'Terminé';
    return 'Poudlard';
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
        playHpFx(channel, 'year', { title: 'Bienvenue à Poudlard' });
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
        playHpFx(channel, 'cup', {
          title: tagVal(tags, '+winner') || 'Poudlard',
          sub: (tagVal(tags, '+points') || '0') + ' points'
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
        playHatFx(channel, {
          step: Number(tagVal(tags, '+step')) || 0,
          text: tagVal(tags, '+text'),
          nick: tagVal(tags, '+nick'),
          house: tagVal(tags, '+house')
        });
        break;
      case 'house_join':
        patchChannel(channel, {
          phase: 'waiting',
          lastEvent: ev,
          toast: (tagVal(tags, '+nick') || '') + ' → ' + (tagVal(tags, '+house') || ''),
          sortHouse: tagVal(tags, '+house')
        });
        playHatFx(channel, {
          step: 4,
          text: tagVal(tags, '+house') ? 'Le Choixpeau a décidé… ' + tagVal(tags, '+house') + ' !' : '',
          nick: tagVal(tags, '+nick'),
          house: tagVal(tags, '+house')
        });
        playHpFx(channel, 'transform', {
          nick: tagVal(tags, '+nick'),
          next: tagVal(tags, '+game_nick') || tagVal(tags, '+nick'),
          house: tagVal(tags, '+house')
        });
        break;
      case 'year_start':
        patchChannel(channel, { phase: 'playing', lastEvent: ev, toast: 'L\'année commence !' });
        playHpFx(channel, 'year', { title: 'L\'année commence !' });
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
        playHpFx(channel, 'spark', {
          title: tagVal(tags, '+nick'),
          sub: '+' + (tagVal(tags, '+points') || '10') + ' points'
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
        playHpFx(channel, 'spell', {
          title: tagVal(tags, '+inc') || 'Sortilège',
          sub: tagVal(tags, '+nick')
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
        playHpFx(channel, 'duel', {
          title: tagVal(tags, '+p1'),
          sub: tagVal(tags, '+p2')
        });
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
        playHpFx(channel, 'spark', {
          title: tagVal(tags, '+winner'),
          sub: (tagVal(tags, '+s1') || '') + ' bat ' + (tagVal(tags, '+s2') || '')
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
        playHpFx(channel, 'transform', {
          nick: tagVal(tags, '+nick'),
          next: tagVal(tags, '+game_nick'),
          house: tagVal(tags, '+house')
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

  function fxLayer() {
    var el = document.getElementById('ohp-fx');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ohp-fx';
    el.className = 'ohp-fx';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  }

  function hatSvg() {
    return '<svg class="ohp-fx-hat" viewBox="0 0 200 220" aria-hidden="true">' +
      '<defs><linearGradient id="ohpHat" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#6b4226"/><stop offset=".55" stop-color="#3d2414"/>' +
      '<stop offset="1" stop-color="#24150c"/></linearGradient></defs>' +
      '<ellipse cx="100" cy="188" rx="92" ry="18" fill="#1a1008"/>' +
      '<ellipse cx="100" cy="178" rx="88" ry="16" fill="#2c1a0e"/>' +
      '<path d="M100 10 C118 48 148 108 146 168 L54 168 C58 108 82 48 100 10Z" fill="url(#ohpHat)"/>' +
      '<path d="M86 52 C96 70 112 68 118 50" fill="none" stroke="#24150c" stroke-width="3"/>' +
      '<path d="M72 96 C90 112 118 108 130 90" fill="none" stroke="#2a180e" stroke-width="2.5"/>' +
      '<ellipse class="ohp-hat-mouth" cx="100" cy="142" rx="16" ry="4" fill="#120a06"/>' +
      '<path d="M78 128 Q100 136 122 128" fill="none" stroke="#1a1008" stroke-width="2"/>' +
      '</svg>';
  }

  function wandSvg() {
    return '<svg class="ohp-fx-wand" viewBox="0 0 280 48" aria-hidden="true">' +
      '<defs><linearGradient id="ohpWandGold" x1="0" x2="1"><stop offset="0" stop-color="#7a4a12"/><stop offset="1" stop-color="#e8c547"/></linearGradient>' +
      '<filter id="ohpGlow"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
      '<rect x="8" y="20" width="132" height="10" rx="4" fill="#3a2410"/>' +
      '<rect x="136" y="18" width="108" height="13" rx="3" fill="url(#ohpWandGold)"/>' +
      '<circle cx="252" cy="24" r="10" fill="#fff6c8" filter="url(#ohpGlow)"/>' +
      '<circle cx="252" cy="24" r="4" fill="#fff"/>' +
      '</svg>';
  }

  function sparklesHtml() {
    var bits = [];
    var i;
    for (i = 0; i < 14; i++) {
      var x = 8 + Math.random() * 84;
      var y = 18 + Math.random() * 64;
      var dx = (Math.random() * 140 - 70).toFixed(0) + 'px';
      var dy = (Math.random() * -120 - 20).toFixed(0) + 'px';
      bits.push('<i style="left:' + x + '%;top:' + y + '%;--dx:' + dx + ';--dy:' + dy + ';animation-delay:' + (i * 0.05).toFixed(2) + 's"></i>');
    }
    return '<div class="ohp-fx-sparkles">' + bits.join('') + '</div>';
  }

  function houseColor(house) {
    var n = String(house || '').toLowerCase();
    if (n.indexOf('gryff') === 0) return HOUSES.G.color;
    if (n.indexOf('serp') === 0) return HOUSES.S.color;
    if (n.indexOf('pouf') === 0) return HOUSES.P.color;
    if (n.indexOf('serd') === 0) return HOUSES.R.color;
    return '#e8c547';
  }

  function shouldShowFx(channel, involvedNicks) {
    if (!pluginOrbit || isBouncerSession(pluginOrbit)) return false;
    var buf = pluginOrbit.state.active();
    var onChan = isHpChannel(pluginOrbit, buf) &&
      normChan(resolveChannelName(pluginOrbit, buf) || buf) === normChan(channel);
    if (onChan) return true;
    var me = String(pluginOrbit.state.nick() || '').toLowerCase();
    if (!me || !involvedNicks) return false;
    return involvedNicks.some(function (n) { return String(n || '').toLowerCase() === me; });
  }

  function playHatFx(channel, data) {
    data = data || {};
    var nick = data.nick || '';
    var house = data.house || '';
    var text = data.text || 'Hmm… voyons voir…';
    if (!shouldShowFx(channel, [nick])) return;

    var layer = fxLayer();
    var scene = layer.querySelector('.ohp-fx-hatwrap');
    var color = houseColor(house);
    if (!scene) {
      layer.innerHTML =
        '<div class="ohp-fx__vignette"></div>' +
        '<div class="ohp-fx__scene ohp-fx-hatwrap">' +
        sparklesHtml() + hatSvg() +
        '<p class="ohp-fx-sub ohp-fx-who">' + escHtml(nick) + '</p>' +
        '<p class="ohp-fx-phrase"></p>' +
        '<p class="ohp-fx-title ohp-fx-housecall" hidden></p>' +
        '</div>';
      layer.hidden = false;
    }
    var phrase = layer.querySelector('.ohp-fx-phrase');
    var call = layer.querySelector('.ohp-fx-housecall');
    var hat = layer.querySelector('.ohp-fx-hat');
    var who = layer.querySelector('.ohp-fx-who');
    if (who && nick) who.textContent = nick;
    if (phrase) phrase.textContent = text;
    if (house && call) {
      call.hidden = false;
      call.textContent = house;
      call.style.color = color;
      call.style.textShadow = '0 0 24px ' + color;
      layer.classList.add('ohp-fx--sorted');
      if (hat) hat.classList.add('ohp-fx-hat--speak');
      var vig = layer.querySelector('.ohp-fx__vignette');
      if (vig) vig.style.background = 'radial-gradient(ellipse at center,rgba(18,10,4,.12),' + color + '55)';
    }
    hatUntil = Date.now() + (house ? 3800 : 2400);
    if (hatTimer) clearTimeout(hatTimer);
    hatTimer = setTimeout(function hideHat() {
      if (Date.now() < hatUntil - 30) {
        hatTimer = setTimeout(hideHat, hatUntil - Date.now());
        return;
      }
      if (!layer.querySelector('.ohp-fx-hatwrap')) return;
      layer.hidden = true;
      layer.innerHTML = '';
      layer.classList.remove('ohp-fx--sorted');
      hatTimer = 0;
    }, house ? 3900 : 2500);
  }

  function playHpFx(channel, kind, data) {
    data = data || {};
    var nick = data.nick || '';
    var next = data.next || '';
    var key = kind + '|' + nick + '|' + next + '|' + (data.house || '');
    if (kind === 'transform' && lastFxKey === key && data._afterHat) {
      /* ok, queued after hat */
    } else if (kind === 'transform' && lastFxKey === key) {
      return;
    }
    if (kind === 'transform') lastFxKey = key;
    if (kind === 'transform' && !data._afterHat && Date.now() < hatUntil) {
      var wait = Math.max(200, hatUntil - Date.now() + 250);
      setTimeout(function () {
        playHpFx(channel, kind, Object.assign({}, data, { _afterHat: true }));
      }, wait);
      return;
    }
    if (!shouldShowFx(channel, [nick, next, data.title, data.sub])) return;

    var layer = fxLayer();
    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
    var html = sparklesHtml();
    if (kind === 'transform') {
      html += wandSvg() +
        '<div class="ohp-fx-nicks">' +
        '<span class="ohp-fx-old">' + escHtml(nick || '…') + '</span>' +
        '<span class="ohp-fx-arrow">→</span>' +
        '<span class="ohp-fx-new" style="color:' + houseColor(data.house) + '">' + escHtml(next || nick) + '</span>' +
        '</div>' +
        (data.house ? '<div class="ohp-fx-house">' + escHtml(data.house) + '</div>' : '');
    } else if (kind === 'spell') {
      html += wandSvg() + '<span class="ohp-fx-ico">✨</span><p class="ohp-fx-title">' +
        escHtml(data.title || 'Sortilège') + '</p><p class="ohp-fx-sub">' + escHtml(data.sub || '') + '</p>';
    } else if (kind === 'duel') {
      html += '<span class="ohp-fx-ico">⚔️</span><div class="ohp-fx-nicks"><span class="ohp-fx-new">' +
        escHtml(data.title || '') + '</span><span class="ohp-fx-arrow">vs</span><span class="ohp-fx-new">' +
        escHtml(data.sub || '') + '</span></div>';
    } else if (kind === 'cup') {
      html += '<span class="ohp-fx-ico">🏆</span><p class="ohp-fx-title">' + escHtml(data.title || '') +
        '</p><p class="ohp-fx-sub">' + escHtml(data.sub || '') + '</p>';
    } else if (kind === 'year') {
      html += '<span class="ohp-fx-ico">🏰</span><p class="ohp-fx-title">' + escHtml(data.title || '') + '</p>';
    } else {
      html += '<span class="ohp-fx-ico">🌟</span><p class="ohp-fx-title">' + escHtml(data.title || '') +
        '</p><p class="ohp-fx-sub">' + escHtml(data.sub || '') + '</p>';
    }
    layer.innerHTML = '<div class="ohp-fx__vignette"></div><div class="ohp-fx__scene">' + html + '</div>';
    layer.hidden = false;
    if (fxTimer) clearTimeout(fxTimer);
    fxTimer = setTimeout(function () {
      layer.hidden = true;
      layer.innerHTML = '';
      fxTimer = 0;
    }, reduced ? 1400 : (kind === 'transform' || kind === 'spell' || kind === 'hat' ? 3200 : 2200));
  }

  function injectStyles() {
    var el = document.getElementById('orbit-harrypotter-css');
    if (!el) {
      el = document.createElement('style');
      el.id = 'orbit-harrypotter-css';
      document.head.appendChild(el);
    }
    el.textContent = [
      '.ohp-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;border-bottom:1px solid color-mix(in srgb,#c9a227 35%,var(--border,#333));background:linear-gradient(180deg,#1a1208,#120c06 55%,#0d0905);color:#f4e4c1;font-size:13px;font-family:var(--font,system-ui,sans-serif);display:flex;flex-direction:column;min-height:0;overflow:hidden;box-sizing:border-box}',
      '.ohp-panel[hidden]{display:none!important}',
      '.ohp-panel--full{flex:1 1 auto;min-height:0;max-height:100%;border-bottom:0}',
      '.ohp-panel--split{flex:1 1 auto;min-height:0;max-height:100%}',
      '.ohp-panel--chat{flex:0 0 auto;min-height:0;height:auto!important;max-height:none!important}',
      '.ohp-panel--chat .ohp-houses,.ohp-panel--chat .ohp-stage{display:none!important}',
      'html.ohp-full,html.ohp-full body,body.ohp-full{overflow:hidden;width:100%;max-width:100%;margin:0;padding:0;height:100%;min-height:100svh;min-height:100dvh}',
      'body.ohp-full .main{display:flex!important;flex-direction:column;overflow:hidden;min-height:0;width:100%!important;max-width:none!important;margin:0!important;padding:0!important;height:100svh!important;height:100dvh!important;max-height:100svh!important;max-height:100dvh!important}',
      'html.ohp-full .chan-hero,html.ohp-full .messages,html.ohp-full .composer,html.ohp-full .main__room-bg,html.ohp-full .empty,body.ohp-full .chan-hero,body.ohp-full .messages,body.ohp-full .composer,body.ohp-full .main__room-bg,body.ohp-full .empty,body.ohp-full .composer textarea,body.ohp-full form.composer{display:none!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important;opacity:0!important;margin:0!important;padding:0!important;border:0!important;flex:none!important;resize:none!important}',
      'body.ohp-full #ohp-dom-panel{flex:1 1 0;min-height:0;width:100%;max-width:none;margin:0;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box}',
      '@media(max-width:880px){body.ohp-full .app,body.ohp-full #app,body.ohp-full .shell,body.ohp-full .layout{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;height:100%!important;min-height:100svh!important}body.ohp-full .topbar{z-index:60!important;position:relative}body.ohp-full .sidebar,body.ohp-full .rail,body.ohp-full aside.sidebar{z-index:90!important}body.ohp-full .nav-backdrop{z-index:80!important}body.ohp-full #ohp-dom-panel{border-radius:0!important;width:100%!important;max-width:none!important;margin:0!important;left:0!important;right:0!important;bottom:0!important;height:auto!important;max-height:none!important}body.ohp-full .ohp-stage{width:100%!important;box-sizing:border-box}}',
      '@media(min-width:1000px){body.ohp-split .main{display:grid!important;grid-template-columns:minmax(28rem,1.25fr) minmax(14rem,.7fr);grid-template-rows:auto auto 1fr auto;align-items:stretch;overflow:hidden}body.ohp-split .topbar{grid-column:1/-1;grid-row:1}body.ohp-split .main__room-bg{grid-column:2;grid-row:2/4;height:auto!important}body.ohp-split #ohp-dom-panel{grid-column:1;grid-row:2/-1;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid rgba(201,162,39,.28)}body.ohp-split .chan-hero{grid-column:2;grid-row:2}body.ohp-split .messages{grid-column:2;grid-row:3;min-height:0}body.ohp-split .composer{grid-column:2;grid-row:4}body.ohp-split .main>:not(.topbar):not(#ohp-dom-panel):not(.main__room-bg):not(.chan-hero):not(.messages):not(.composer){grid-column:2}}',
      '@media(max-width:999px){body.ohp-split .main{display:flex;flex-direction:column;overflow:hidden}body.ohp-split #ohp-dom-panel{flex:0 1 auto;min-height:0;max-height:min(58vh,calc(100dvh - 12rem));overflow:hidden}body.ohp-split .messages{flex:1 1 auto;min-height:8rem}}',
      '.ohp-head{position:relative;display:flex;align-items:center;gap:.45rem;padding:.42rem .7rem;background:linear-gradient(135deg,#5c3a12,#3d2208 55%,#2a1606);color:#f8e7c0;flex:0 0 auto;overflow:visible;z-index:30}',
      '.ohp-head__title{font-weight:800;font-size:.88rem;letter-spacing:.04em;color:#e8c547;white-space:nowrap}',
      '.ohp-head__badge{font-size:.68rem;font-weight:800;padding:.16rem .6rem;border-radius:999px;background:rgba(232,197,71,.18);color:#f4e4c1}',
      '.ohp-head__actions{margin-left:auto;display:flex;gap:.28rem}',
      '.ohp-head__btn{position:relative;border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:34px;border-radius:9px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.ohp-head__unread{position:absolute;top:-5px;right:-5px;min-width:1.15rem;height:1.15rem;padding:0 .22rem;border-radius:999px;background:#dc2626;color:#fff;font-size:.62rem;font-weight:800;line-height:1.15rem;text-align:center;box-shadow:0 0 0 2px #3d2208}',
      '.ohp-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.ohp-head__btn--on{background:rgba(232,197,71,.38)}',
      '.ohp-head__btn svg{width:18px;height:18px;display:block}',
      '.ohp-toast{flex:1;min-width:0;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ohp-clock{font-variant-numeric:tabular-nums;background:#2a1c0a;border:1px solid #c9a227;border-radius:999px;padding:.15rem .55rem;color:#f1c40f;flex:0 0 auto}',
      '.ohp-houses{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.35rem;padding:.5rem .75rem .35rem;flex:0 0 auto}',
      '.ohp-house{border-radius:8px;padding:.25rem .4rem;text-align:center;font-size:11px;border:1px solid transparent}',
      '.ohp-house b{display:block;font-size:14px}',
      '.ohp-stage{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:.55rem;padding:.15rem .75rem .9rem;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '.ohp-card{border:1px solid color-mix(in srgb,#c9a227 40%,transparent);border-radius:12px;padding:.85rem .95rem;background:color-mix(in srgb,#2a1c0a 70%,transparent);flex:1 1 auto}',
      'body.ohp-full .ohp-q{font-size:clamp(1.05rem,2.4vw,1.45rem)}',
      '.ohp-q{font-size:15px;line-height:1.35;margin:0 0 .5rem}',
      '.ohp-row{display:flex;gap:.4rem;flex-wrap:wrap}',
      '.ohp-row input{flex:1;min-width:8rem;border-radius:8px;border:1px solid #c9a227;background:#0e0a05;color:#f4e4c1;padding:.4rem .55rem}',
      '.ohp-btn{border:0;border-radius:8px;padding:.4rem .7rem;cursor:pointer;background:#c9a227;color:#1a1208;font-weight:700}',
      '.ohp-btn.ghost{background:transparent;color:#e8c547;border:1px solid #c9a227}',
      '.ohp-hat{font-size:1.4rem;margin-bottom:.35rem}',
      '.ohp-rank{margin:.4rem 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.35rem .7rem}',
      '.ohp-idle{display:flex;align-items:center;justify-content:space-between;gap:.6rem}',
      'body.ohp-full .ohp-idle{flex-direction:column;align-items:flex-start;justify-content:center;min-height:min(42vh,22rem);gap:1rem}',
      '.ohp-spells{display:flex;gap:.4rem;flex-wrap:wrap}',
      '.ohp-fx{position:fixed;inset:0;z-index:80;pointer-events:none;display:flex;align-items:center;justify-content:center}',
      '.ohp-fx[hidden]{display:none!important}',
      '.ohp-fx__vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(18,10,4,.15),rgba(8,4,2,.72));animation:ohpFade .45s ease}',
      '.ohp-fx__scene{position:relative;z-index:1;text-align:center;color:#f8e7c0;max-width:min(92vw,36rem);padding:1.2rem}',
      '.ohp-fx-wand{width:min(72vw,22rem);height:auto;display:block;margin:0 auto .85rem;transform-origin:12% 50%;animation:ohpWand 1.15s cubic-bezier(.2,1.4,.3,1) both}',
      '.ohp-fx-hat{width:min(46vw,13.5rem);height:auto;display:block;margin:0 auto .35rem;transform-origin:50% 85%;animation:ohpHatIn .7s cubic-bezier(.2,1.3,.3,1) both}',
      '.ohp-fx-hat--speak,.ohp-fx--sorted .ohp-fx-hat{animation:ohpHatIn .7s cubic-bezier(.2,1.3,.3,1) both,ohpHatThink 1.1s ease-in-out infinite}',
      '.ohp-hat-mouth{transform-box:fill-box;transform-origin:center;animation:ohpMouth 1.2s ease-in-out infinite}',
      '.ohp-fx--sorted .ohp-hat-mouth{animation:ohpMouthSpeak .35s ease-in-out infinite}',
      '.ohp-fx-phrase{min-height:2.6em;margin:.2rem 0 0;font-size:clamp(1.05rem,3.2vw,1.45rem);line-height:1.35;font-style:italic}',
      '.ohp-fx-housecall{margin-top:.45rem;letter-spacing:.08em;text-transform:uppercase;animation:ohpNew .7s both}',
      '.ohp-fx-who{opacity:.75;margin:0}',
      '.ohp-fx-sparkles{position:absolute;inset:-10% -6%;pointer-events:none}',
      '.ohp-fx-sparkles i{position:absolute;width:7px;height:7px;border-radius:50%;background:#ffe9a3;box-shadow:0 0 10px 3px rgba(255,220,120,.85);animation:ohpSpark 1.4s ease-out forwards}',
      '.ohp-fx-nicks{display:flex;align-items:center;justify-content:center;gap:.7rem;flex-wrap:wrap;font-size:clamp(1.35rem,4vw,2.1rem);font-weight:800;letter-spacing:.02em}',
      '.ohp-fx-old{opacity:.7;filter:blur(0);animation:ohpOld .9s ease forwards}',
      '.ohp-fx-arrow{color:#e8c547;animation:ohpPop .5s .35s both}',
      '.ohp-fx-new{color:#ffe08a;text-shadow:0 0 18px rgba(232,197,71,.75);animation:ohpNew .7s .55s both}',
      '.ohp-fx-house{margin-top:.55rem;font-size:.95rem;letter-spacing:.12em;text-transform:uppercase;opacity:.9}',
      '.ohp-fx-title{font-size:clamp(1.4rem,4.5vw,2.3rem);font-weight:800;margin:0;text-shadow:0 0 22px rgba(232,197,71,.45)}',
      '.ohp-fx-sub{margin:.35rem 0 0;opacity:.88;font-size:1.05rem}',
      '.ohp-fx-ico{font-size:3.2rem;line-height:1;display:block;margin-bottom:.4rem;animation:ohpPop .55s both}',
      '@keyframes ohpFade{from{opacity:0}to{opacity:1}}',
      '@keyframes ohpWand{0%{transform:translate(42%,38%) rotate(-55deg) scale(.4);opacity:0}45%{opacity:1;transform:translate(8%,-6%) rotate(-12deg) scale(1)}70%{transform:translate(0,0) rotate(8deg) scale(1.05)}100%{transform:translate(0,0) rotate(0) scale(1)}}',
      '@keyframes ohpHatIn{0%{opacity:0;transform:translateY(-42%) rotate(-8deg) scale(.7)}100%{opacity:1;transform:translateY(0) rotate(0) scale(1)}}',
      '@keyframes ohpHatThink{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(4deg)}}',
      '@keyframes ohpMouth{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.85)}}',
      '@keyframes ohpMouthSpeak{0%,100%{transform:scaleY(1.1)}50%{transform:scaleY(2.5)}}',
      '@keyframes ohpOld{0%{opacity:1;transform:scale(1)}70%{opacity:.25;filter:blur(4px);transform:scale(.92) rotate(-2deg)}100%{opacity:0;transform:scale(.8)}}',
      '@keyframes ohpNew{0%{opacity:0;transform:scale(.6) rotate(6deg);filter:blur(8px)}100%{opacity:1;transform:scale(1);filter:blur(0)}}',
      '@keyframes ohpPop{0%{opacity:0;transform:scale(.4)}70%{transform:scale(1.12)}100%{opacity:1;transform:scale(1)}}',
      '@keyframes ohpSpark{0%{opacity:0;transform:translate(0,0) scale(.3)}25%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.1)}}',
      '@media (prefers-reduced-motion:reduce){.ohp-fx__vignette,.ohp-fx-wand,.ohp-fx-hat,.ohp-fx-old,.ohp-fx-new,.ohp-fx-ico,.ohp-fx-sparkles i,.ohp-hat-mouth{animation:none!important;opacity:1;transform:none;filter:none}}'
    ].join('');
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
    var mode = getViewMode(orbit);
    if (!on) {
      root.hidden = true;
      root.innerHTML = '';
      clearShellLayout();
      return;
    }
    var game = getChannelState(buffer);
    if (game.phase === 'idle' && !c.showWhenIdle) {
      root.hidden = true;
      clearShellLayout();
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
      '<div class="ohp-head"><span class="ohp-head__title">⚡ Poudlard</span>' +
      '<span class="ohp-head__badge">' + escHtml(phaseBadge(game)) + '</span>' +
      '<span class="ohp-toast">' + escHtml(game.toast || '') + '</span>' +
      (left ? '<span class="ohp-clock">' + left + 's</span>' : '') +
      viewBtns(mode) +
      '</div>' +
      '<div class="ohp-houses">' + houseBlock(game.houses) + '</div>' +
      '<div class="ohp-stage">' + stage +
      (ranks ? '<ul class="ohp-rank">' + ranks + '</ul>' : '') +
      '</div>';

    root.onclick = function (ev) {
      var btn = ev.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'view-full') { setViewMode(orbit, VIEW_FULL); return; }
      if (act === 'view-split') { setViewMode(orbit, VIEW_SPLIT); return; }
      if (act === 'view-chat') { setViewMode(orbit, VIEW_CHAT); return; }
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
    applyViewMode(orbit, mode);
  }

  function mountDomPanel(orbit) {
    var on = isHpChannel(orbit, orbit.state.active());
    var root = document.getElementById('ohp-dom-panel');
    if (!on || isBouncerSession(orbit)) {
      if (root) {
        root.hidden = true;
        root.innerHTML = '';
      }
      clearShellLayout();
      return;
    }
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
    if (root.parentNode !== main) {
      topbar.insertAdjacentElement('afterend', root);
    }
    renderDomPanel(orbit, root);
  }

  Orbit.plugin('orbit-harrypotter', function (orbit, log) {
    pluginOrbit = orbit;
    viewMode = getViewMode(orbit);
    injectStyles();
    console.info('[orbit-harrypotter] loaded v' + HP_VER);
    setTimeout(function () { chatBadgeArmed = true; }, 800);
    if (orbit.requireVisualDisplay) {
      orbit.requireVisualDisplay({
        label: 'Harry Potter',
        inChannel: function (ch) { return isHpChannel(orbit, ch); },
      });
    }

    function syncDom() {
      try { mountDomPanel(orbit); } catch (e) { console.error('[orbit-harrypotter] panel', e); }
    }

    subscribe(function () { syncDom(); });
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
      if (tagVal(tags, HP) !== 'v1') return;
      var target = (msg.params && msg.params[0]) || '';
      if (!isChannelName(target)) return;
      if (!isHpChannel(orbit, target)) return;
      handleHpEvent(target, tags);
      log('orbit-harrypotter', tagVal(tags, EV), target);
    });

    orbit.on('buffer.active', function () {
      var buf = orbit.state.active();
      var fx = document.getElementById('ohp-fx');
      if (fx && !isHpChannel(orbit, buf)) {
        fx.hidden = true;
        fx.innerHTML = '';
      }
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
