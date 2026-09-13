/*!
 * orbit-harrypotter — panneau Orbit pour le bot Limnoria HarryPotter
 * Écoute les TAGMSG IRCv3 : +hp=v1 +ev=<event>
 */
(function () {
  'use strict';

  var HP_VER = 5;
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
  var lastFxKey = '';
  var fxTimer = 0;
  var hatUntil = 0;
  var hatTimer = 0;

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
    var on = isHpChannel(orbit, orbit.state.active());
    var root = document.getElementById('ohp-dom-panel');
    if (!on || isBouncerSession(orbit)) {
      if (root) {
        root.hidden = true;
        root.innerHTML = '';
      }
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
    injectStyles();
    console.info('[orbit-harrypotter] loaded v' + HP_VER);
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
