/*!
 * orbit-petitbac — UI moderne pour le bot Limnoria Petit Bac (EntreNous)
 * Écoute les TAGMSG IRCv3 : +pb=v1 +ev=<event> (+letter, +categories, …)
 */
(function () {
  'use strict';

  var PBAC_VER = 8;

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (retry < 80) setTimeout(function () { boot(retry + 1); }, 50);
      else console.error('[orbit-petitbac] Orbit API unavailable after retries');
      return;
    }
    if (window.__ORBIT_PETITBAC__ === PBAC_VER) return;
    window.__ORBIT_PETITBAC__ = PBAC_VER;

  var React = Orbit.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useSyncExternalStore = React.useSyncExternalStore;

  var PB = '+pb';
  var EV = '+ev';
  var STORAGE_COLLAPSED = 'panelCollapsed';
  /** Instance API du plugin (Orbit global n'expose pas i18n). */
  var pluginOrbit = null;

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

  function resolveChannelName(orbit, keyOrName) {
    if (!keyOrName) return '';
    var st = orbit.state.get();
    if (st && st.buffers && st.buffers[keyOrName] && st.buffers[keyOrName].name) {
      return st.buffers[keyOrName].name;
    }
    return keyOrName;
  }

  function isBacChannel(orbit, channelKey) {
    if (!channelKey) return false;
    var name = resolveChannelName(orbit, channelKey);
    var n = normChan(name);
    if (!isChannelName(n) && !isChannelName(name)) return false;
    if (/baccalaureat/i.test(n)) return true;
    var c = cfg(orbit);
    if (c.channelsAll) return true;
    if (c.channels.indexOf(n) >= 0) return true;
    var play = (((orbit.config().startup || {}).intents || {}).play) || [];
    return play.some(function (ch) { return normChan(ch) === n; });
  }

  function channelEnabled(orbit, channelKey) {
    return isBacChannel(orbit, channelKey);
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

  function roundKey(game) {
    if (!game) return '';
    return String(game.round || 0) + '|' + String(game.letter || '') + '|' + (game.categories || []).join(',');
  }

  var draftStore = { byChannel: Object.create(null) };

  function getDraft(channel, game) {
    var key = normChan(channel);
    var rk = roundKey(game);
    var d = draftStore.byChannel[key];
    if (!d || d.roundKey !== rk) {
      d = { roundKey: rk, drafts: Object.create(null), validated: Object.create(null), pending: Object.create(null), rejected: Object.create(null) };
      draftStore.byChannel[key] = d;
    }
    return d;
  }

  function bumpStore() {
    store.rev++;
    store.listeners.forEach(function (l) { l(); });
  }

  function parseCategories(raw) {
    return String(raw || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function extractQuotedWord(msg) {
    var w = String(msg || '').match(/[«"]([^»"]+)[»"]/);
    return w ? w[1].trim() : '';
  }

  function matchCatKey(game, catHint) {
    if (!catHint || !game || !game.categories) return String(catHint || '').toLowerCase();
    var h = String(catHint).toLowerCase().replace(/[.,;:!?<>]+/g, '').trim();
    if (!h || h === 'catégorie' || h === 'categorie') return '';
    for (var i = 0; i < game.categories.length; i++) {
      var c = game.categories[i].toLowerCase();
      if (c === h) return c;
    }
    for (var j = 0; j < game.categories.length; j++) {
      var c2 = game.categories[j].toLowerCase();
      if (c2.indexOf(h) === 0 || h.indexOf(c2) === 0) return c2;
    }
    return h;
  }

  function resolveCatName(game, catKey) {
    var k = String(catKey || '').toLowerCase();
    var cats = game.categories || [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].toLowerCase() === k) return cats[i];
    }
    return catKey;
  }

  function markRejected(channel, catKey, word, reason) {
    if (!word && !catKey) return;
    var game = getChannelState(channel) || defaultState();
    var draft = getDraft(channel, game);
    draft.rejected = draft.rejected || Object.create(null);
    var key = catKey || word.toLowerCase();
    draft.rejected[key] = {
      word: word,
      catKey: catKey,
      msg: reason || pick({ fr: 'Mot non accepté', en: 'Word not accepted' }),
      verifying: false,
    };
    if (catKey) delete draft.pending[catKey];
    bumpStore();
  }

  function handlePlayerFeedback(channel, plain, myNick) {
    if (!myNick || !plain) return;
    var game = getChannelState(channel) || defaultState();
    var draft = getDraft(channel, game);

    var hint = plain.match(/ℹ️.*!verifier\s+(?:<cat[ée]gorie>\s+|(\S+)\s+)(.+)$/i);
    if (hint) {
      var hintWord = hint[2].replace(/[.!]+$/, '').trim();
      var hintCat = matchCatKey(game, hint[1] || '');
      if (!hintCat) {
        Object.keys(draft.drafts).forEach(function (k) {
          if (!hintCat && draft.drafts[k].toLowerCase() === hintWord.toLowerCase()) hintCat = k;
        });
        Object.keys(draft.pending).forEach(function (k) {
          if (!hintCat && String(draft.pending[k]).toLowerCase() === hintWord.toLowerCase()) hintCat = k;
        });
      }
      markRejected(channel, hintCat, hintWord, pick({
        fr: 'Mot refusé — vous pouvez le faire vérifier',
        en: 'Word rejected — you can request verification',
      }));
      return;
    }

    var m = plain.match(/^([^:]{1,32}):\s*(.+)$/);
    if (!m || m[1].toLowerCase() !== myNick.toLowerCase()) return;
    var msg = m[2];

    var accepted = msg.match(/(?:✔️|💎).*?Cat[ée]gorie\s+(\S+)/i);
    if (accepted) {
      var cat = accepted[1].replace(/[.,;:!?]+$/, '').toLowerCase();
      draft.validated[cat] = true;
      delete draft.pending[cat];
      if (draft.rejected) {
        delete draft.rejected[cat];
        Object.keys(draft.rejected).forEach(function (k) {
          if (draft.rejected[k] && draft.rejected[k].catKey === cat) delete draft.rejected[k];
        });
      }
      bumpStore();
      return;
    }

    if (/❌|⛔/.test(msg)) {
      var word = extractQuotedWord(msg);
      var catKey = '';
      var catM = msg.match(/cat[ée]gorie\s+(\S+)/i);
      if (catM) catKey = matchCatKey(game, catM[1]);
      if (!catKey && word) {
        Object.keys(draft.pending).forEach(function (k) {
          if (!catKey && String(draft.pending[k]).toLowerCase() === word.toLowerCase()) catKey = k;
        });
      }
      if (!catKey && word) {
        Object.keys(draft.drafts).forEach(function (k) {
          if (!catKey && String(draft.drafts[k]).toLowerCase() === word.toLowerCase()) catKey = k;
        });
      }
      if (!catKey && Object.keys(draft.pending).length === 1) {
        catKey = Object.keys(draft.pending)[0];
      }
      var short = msg.replace(/^[^«"]*[«"]?[^»"]*[»"]?\s*/i, '').slice(0, 100);
      markRejected(channel, catKey, word || draft.drafts[catKey] || '', short || msg.slice(0, 100));
      return;
    }

    if (/⚠️/.test(msg) && /d[eé]j[aà]/i.test(msg)) {
      var catW = msg.match(/cat[ée]gorie\s+(\S+)/i);
      if (catW) delete draft.pending[matchCatKey(game, catW[1])];
      bumpStore();
    }
  }

  function stripReplyPrefix(plain) {
    return String(plain || '').replace(/^[^:]{1,32}:\s*/, '');
  }

  function handleIrcLine(channel, nick, text, myNick) {
    var plain = stripIrc(text).trim();
    if (!plain) return;

    handlePlayerFeedback(channel, plain, myNick);

    var body = stripReplyPrefix(plain);
    var n = String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
    var fromBac = n === 'bac' || n === 'maitredujeu';

    if (fromBac && /petit bac est actuellement en cours|la partie d[eé]marre|c'est parti|une partie est d[eé]j[aà] en cours/i.test(body)) {
      patchChannel(channel, { phase: 'starting' });
    }
    var manche = body.match(/manche\s+(\d+)\s*\/\s*(\d+)/i);
    if (manche) {
      var durM = (getChannelState(channel) || {}).duration || 60;
      patchChannel(channel, {
        phase: 'playing',
        round: Number(manche[1]) || 0,
        totalRounds: Number(manche[2]) || 0,
        roundStartAt: Date.now(),
        countdownAt: Date.now(),
        countdown: durM,
        duration: durM,
      });
    }
    var lc = body.match(/lettre\s*(?:actuelle)?\s*:\s*(\S+).*cat[ée]gories\s*:\s*(.+)$/i);
    if (lc) {
      var durLc = (getChannelState(channel) || {}).duration || 60;
      patchChannel(channel, {
        phase: 'playing',
        letter: lc[1].trim().charAt(0).toUpperCase(),
        categories: parseCategories(lc[2]),
        roundStartAt: Date.now(),
        countdownAt: Date.now(),
        countdown: durLc,
        duration: durLc,
      });
      return;
    }
    var letterOnly = body.match(/(?:🔤|🎲)\s*lettre(?:\s+actuelle)?\s*:\s*(\S)/i)
      || body.match(/lettre(?:\s+actuelle)?\s*:\s*(\S)/i);
    if (letterOnly) {
      patchChannel(channel, {
        phase: 'playing',
        letter: letterOnly[1].trim().charAt(0).toUpperCase(),
        roundStartAt: Date.now(),
        duration: (getChannelState(channel) || {}).duration || 60,
      });
    }
    var catsOnly = body.match(/(?:📚\s*)?cat[ée]gories\s*:\s*(.+)$/i);
    if (catsOnly && !/par manche|actuelles/i.test(body)) {
      patchChannel(channel, {
        phase: 'playing',
        categories: parseCategories(catsOnly[1]),
        roundStartAt: Date.now(),
        duration: (getChannelState(channel) || {}).duration || 60,
      });
    }
    if (fromBac) {
      var dur = body.match(/(\d+)\s+secondes/i);
      if (dur && /manche|partie|tour/i.test(body)) {
        patchChannel(channel, { duration: Number(dur[1]) || 60 });
      }
      var left = body.match(/il reste\s+(\d+)\s+secondes/i);
      if (left) {
        patchChannel(channel, {
          phase: 'playing',
          countdown: Number(left[1]) || 0,
          countdownAt: Date.now(),
          duration: (getChannelState(channel) || {}).duration || Number(left[1]) || 60,
        });
      }
      if (/fin de la (?:partie|manche)|partie termin[eé]e|manche termin[eé]e/i.test(body)) {
        var endPhase = /manche termin[eé]e/i.test(body) ? 'round_end' : 'game_end';
        patchChannel(channel, { phase: endPhase });
      }
    }

    var st = getChannelState(channel);
    if (st && st.letter && st.categories && st.categories.length
        && st.phase !== 'game_end' && st.phase !== 'round_end'
        && (st.phase === 'idle' || st.phase === 'starting')) {
      patchChannel(channel, { phase: 'playing' });
    }
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
      countdownAt: 0,
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
      var dur = Number(tagVal(tags, '+duration')) || 60;
      patchChannel(channel, {
        phase: 'playing',
        round: Number(tagVal(tags, '+round')) || 0,
        letter: tagVal(tags, '+letter'),
        categories: cats ? cats.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        duration: dur,
        totalRounds: Number(tagVal(tags, '+totalRounds')) || ((getChannelState(channel) || {}).totalRounds) || 0,
        roundStartAt: Date.now(),
        countdown: dur,
        countdownAt: Date.now(),
        roundScores: {},
      });
      return;
    }

    if (ev === 'round_countdown') {
      patchChannel(channel, {
        phase: 'playing',
        countdown: Number(tagVal(tags, '+seconds')) || 0,
        countdownAt: Date.now(),
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
    var prev = document.getElementById('orbit-petitbac-css');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'orbit-petitbac-css';
    el.textContent = [
      '.opbac-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;border-bottom:2px solid var(--border,#333);background:var(--bg,#fff);font-family:var(--font,system-ui,sans-serif);box-shadow:0 12px 40px -20px rgba(0,0,0,.25)}',
      '.opbac-panel--playing .opbac-body{max-height:min(46vh,420px);overflow:hidden;display:flex;flex-direction:column}',
      '.opbac-panel--collapsed .opbac-body,.opbac-panel--collapsed .opbac-foot{display:none}',
      '.opbac-head{display:flex;align-items:center;gap:.55rem;padding:.5rem .85rem;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff}',
      '.opbac-head__title{font-weight:800;font-size:.95rem;flex:1;display:flex;align-items:center;gap:.4rem}',
      '.opbac-head__badge{font-size:.72rem;font-weight:800;padding:.2rem .55rem;border-radius:999px;background:rgba(255,255,255,.22)}',
      '.opbac-head__btn{border:0;background:rgba(255,255,255,.2);color:#fff;min-width:44px;min-height:44px;border-radius:10px;cursor:pointer;font-size:.9rem}',
      '.opbac-body{padding:0}',
      '.opbac-stage{display:grid;grid-template-columns:minmax(88px,1fr) minmax(0,2fr) minmax(88px,1fr);gap:.65rem;padding:.85rem .85rem .65rem;align-items:center;background:linear-gradient(180deg,color-mix(in srgb,var(--accent,#6366f1) 6%,var(--bg,#fff)),var(--bg,#fff))}',
      '@media(max-width:640px){.opbac-stage{grid-template-columns:1fr 1fr;grid-template-rows:auto auto}.opbac-stage__center{grid-column:1/-1;order:-1}}',
      '.opbac-stage__lbl{display:block;font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666);text-align:center;margin-bottom:.25rem}',
      '.opbac-letter-xl{width:100%;max-width:110px;aspect-ratio:1;margin:0 auto;border-radius:50%;display:grid;place-items:center;font-size:clamp(3rem,12vw,4.5rem);font-weight:900;line-height:1;color:#fff;background:linear-gradient(145deg,#f97316,#dc2626);box-shadow:0 12px 32px -10px rgba(220,38,38,.55)}',
      '.opbac-clock{position:relative;width:100%;max-width:110px;aspect-ratio:1;margin:0 auto}',
      '.opbac-clock__ring{width:100%;height:100%;transform:rotate(-90deg)}',
      '.opbac-clock__track{fill:none;stroke:var(--bg-soft,rgba(127,127,127,.15));stroke-width:6}',
      '.opbac-clock__prog{fill:none;stroke:#22c55e;stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset .35s linear,stroke .25s}',
      '.opbac-clock--warn .opbac-clock__prog{stroke:#f59e0b}',
      '.opbac-clock--urgent .opbac-clock__prog{stroke:#ef4444;animation:opbac-pulse 1s ease-in-out infinite}',
      '.opbac-clock__n{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(2rem,8vw,3.2rem);font-weight:900;font-variant-numeric:tabular-nums;color:var(--ink,#111)}',
      '.opbac-clock__unit{position:absolute;bottom:18%;left:0;right:0;text-align:center;font-size:.62rem;font-weight:800;text-transform:uppercase;color:var(--muted,#666)}',
      '@keyframes opbac-pulse{50%{transform:scale(1.04)}}',
      '.opbac-stage__center{text-align:center;min-width:0}',
      '.opbac-stage__round{font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#666)}',
      '.opbac-stage__phase{font-size:1.05rem;font-weight:900;color:var(--ink,#111);margin:.15rem 0 .45rem}',
      '.opbac-cats{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center}',
      '.opbac-cat{font-size:.82rem;font-weight:800;padding:.38rem .75rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#6366f1) 12%,var(--bg,#fff));color:var(--ink,#111);border:2px solid color-mix(in srgb,var(--accent,#6366f1) 35%,transparent);text-transform:capitalize}',
      '.opbac-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 .85rem .65rem}',
      '.opbac-idle{padding:1.25rem .85rem 1rem;text-align:center}',
      '.opbac-idle__txt{font-size:.95rem;color:var(--muted,#666);margin-bottom:.85rem;line-height:1.45}',
      '.opbac-idle__cta{display:block;width:100%;max-width:320px;margin:0 auto;border:0;border-radius:14px;padding:.85rem 1rem;font-size:1rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;min-height:52px}',
      '.opbac-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:.55rem}',
      '.opbac-card{display:flex;flex-direction:column;gap:.35rem;padding:.55rem .6rem;border-radius:12px;border:2px solid var(--border,#ddd);background:var(--bg,#fff)}',
      '.opbac-card--ok{border-color:#22c55e;background:color-mix(in srgb,#22c55e 8%,var(--bg,#fff))}',
      '.opbac-card--pending{border-color:#f59e0b}',
      '.opbac-card--reject{border-color:#ef4444;background:color-mix(in srgb,#ef4444 7%,var(--bg,#fff))}',
      '.opbac-card__err{font-size:.72rem;font-weight:700;color:#dc2626;margin:0;line-height:1.35}',
      '.opbac-card__verify{width:100%;border:0;border-radius:10px;padding:.52rem .6rem;font-size:.78rem;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#f59e0b,#ea580c);color:#fff;min-height:44px}',
      '.opbac-card__verify--ghost{background:var(--bg,#fff);border:2px dashed #f59e0b;color:#c2410c}',
      '.opbac-card__verify--sent{opacity:.65;cursor:wait}',
      '.opbac-card__err{font-size:.72rem;font-weight:700;color:#dc2626;margin:0;line-height:1.35}',
      '.opbac-card__verify{width:100%;border:0;border-radius:10px;padding:.52rem .6rem;font-size:.78rem;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#f59e0b,#ea580c);color:#fff;min-height:44px}',
      '.opbac-card__verify--ghost{background:var(--bg,#fff);border:2px dashed #f59e0b;color:#c2410c}',
      '.opbac-card__verify--sent{opacity:.65;cursor:wait}',
      '.opbac-card__cat{font-size:.78rem;font-weight:900;text-transform:capitalize;color:var(--ink,#111)}',
      '.opbac-card__input{width:100%;border:2px solid var(--border,#ccc);border-radius:10px;padding:.65rem .7rem;font-size:1rem;min-height:48px;background:var(--bg,#fff);color:var(--ink,#111)}',
      '.opbac-card__input:focus{outline:none;border-color:var(--accent,#6366f1);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#6366f1) 25%,transparent)}',
      '.opbac-card__input:disabled{opacity:.7;background:var(--bg-soft,rgba(127,127,127,.06))}',
      '.opbac-card__send{border:0;border-radius:10px;padding:.55rem .65rem;font-size:.82rem;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;min-height:44px}',
      '.opbac-card__send:disabled{opacity:.45;cursor:not-allowed}',
      '.opbac-form__all{width:100%;margin-top:.55rem;border:0;border-radius:12px;padding:.7rem;font-size:.88rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;min-height:48px}',
      '.opbac-form__all:disabled{opacity:.45;cursor:not-allowed}',
      '.opbac-foot{display:flex;gap:.5rem;padding:.55rem .85rem .65rem;border-top:1px solid var(--border,#ddd);background:var(--bg-soft,rgba(127,127,127,.05))}',
      '.opbac-foot__btn{flex:1;border:0;border-radius:12px;padding:.6rem .75rem;font-size:.85rem;font-weight:800;cursor:pointer;background:var(--bg,#fff);color:var(--ink,#111);border:2px solid var(--border,#ccc);min-height:48px}',
      '.opbac-foot__btn--primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-color:transparent}',
      '.opbac-topbtn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;border:2px solid var(--border,#ccc);background:var(--bg,#fff);cursor:pointer;font-size:1.1rem}',
      '.opbac-topbtn.on{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-color:transparent}',
    ].join('');
    document.head.appendChild(el);
  }

  function computeRemaining(game) {
    if (!game || game.phase !== 'playing') return { remaining: 0, progress: 0, total: 0 };
    var now = Date.now();
    if (game.roundStartAt && game.duration > 0) {
      var elapsed = (now - game.roundStartAt) / 1000;
      var rem = Math.max(0, Math.ceil(game.duration - elapsed));
      return { remaining: rem, progress: Math.min(1, elapsed / game.duration), total: game.duration };
    }
    if (game.countdown > 0 && game.countdownAt) {
      var elapsed2 = (now - game.countdownAt) / 1000;
      var rem2 = Math.max(0, Math.ceil(game.countdown - elapsed2));
      var total = game.duration || game.countdown;
      return { remaining: rem2, progress: total > 0 ? Math.min(1, 1 - rem2 / total) : 0, total: total };
    }
    if (game.countdown > 0) {
      return { remaining: game.countdown, progress: 0, total: game.countdown };
    }
    return { remaining: 0, progress: 0, total: 0 };
  }

  function buildClockHtml(remaining, progress, total) {
    var r = 42;
    var c = 2 * Math.PI * r;
    var off = c * (1 - (progress || 0));
    var warn = remaining > 0 && remaining <= 10;
    var urgent = remaining > 0 && remaining <= 5;
    var cls = 'opbac-clock' + (urgent ? ' opbac-clock--urgent' : (warn ? ' opbac-clock--warn' : ''));
    return '<div class="' + cls + '" data-opbac-clock>' +
      '<svg class="opbac-clock__ring" viewBox="0 0 100 100" aria-hidden="true">' +
        '<circle class="opbac-clock__track" cx="50" cy="50" r="' + r + '"/>' +
        '<circle class="opbac-clock__prog" data-opbac-ring cx="50" cy="50" r="' + r + '" ' +
          'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/>' +
      '</svg>' +
      '<span class="opbac-clock__n" data-opbac-timer>' + (remaining > 0 ? String(remaining) : '—') + '</span>' +
      '<span class="opbac-clock__unit">sec</span></div>';
  }

  function buildStageHtml(game, phase, remaining, progress, total) {
    if (!game.letter && phase === 'idle') return '';
    var cats = (game.categories || []).map(function (c) {
      return '<span class="opbac-cat">' + escHtml(c) + '</span>';
    }).join('');
    return '<div class="opbac-stage">' +
      '<div class="opbac-stage__letter">' +
        '<span class="opbac-stage__lbl">' + escHtml(pick({ fr: 'Lettre', en: 'Letter' })) + '</span>' +
        '<div class="opbac-letter-xl" data-opbac-letter>' + escHtml(game.letter || '?') + '</div>' +
      '</div>' +
      '<div class="opbac-stage__center">' +
        '<div class="opbac-stage__round" data-opbac-badge">' +
          (game.round && game.totalRounds
            ? escHtml(pick({ fr: 'Manche', en: 'Round' }) + ' ' + game.round + ' / ' + game.totalRounds)
            : escHtml(pick({ fr: 'Petit Bac', en: 'Petit Bac' }))) +
        '</div>' +
        '<div class="opbac-stage__phase" data-opbac-phase>' + escHtml(phaseLabel(phase, game.countdown)) + '</div>' +
        (cats ? ('<div class="opbac-cats">' + cats + '</div>') : '') +
      '</div>' +
      '<div class="opbac-stage__timer">' +
        '<span class="opbac-stage__lbl">' + escHtml(pick({ fr: 'Temps restant', en: 'Time left' })) + '</span>' +
        buildClockHtml(remaining, progress, total) +
      '</div></div>';
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

  function ComposerButton(props) {
    var orbit = props.orbit;
    var buffer = useActiveBuffer(orbit);
    if (!buffer || !channelEnabled(orbit, buffer)) return null;
    return h('button', {
      type: 'button',
      className: 'opbac-topbtn on',
      title: pick({ fr: 'Petit Bac — lancer / aide', en: 'Petit Bac — start / help' }),
      onClick: function () { orbit.irc.msg(buffer, '!jouer'); },
    }, '🎲');
  }

  function buildFormHtml(channel, game) {
    if (!game || !game.categories || !game.categories.length || !game.letter) return '';
    var canAnswer = game.phase === 'playing'
      || (game.phase !== 'game_end' && game.phase !== 'idle' && game.phase !== 'round_end');
    if (!canAnswer) return '';
    var draft = getDraft(channel, game);
    var letter = game.letter || '';
    var sendLbl = pick({ fr: 'Envoyer', en: 'Send' });
    var cards = game.categories.map(function (cat) {
      var catKey = cat.toLowerCase();
      var val = draft.drafts[catKey] || draft.drafts[cat] || '';
      var ok = draft.validated[catKey] || draft.validated[cat];
      var pending = draft.pending[catKey] || draft.pending[cat];
      var rej = (draft.rejected && (draft.rejected[catKey] || draft.rejected[cat])) || null;
      var cardClass = 'opbac-card' +
        (ok ? ' opbac-card--ok' : (rej ? ' opbac-card--reject' : (pending ? ' opbac-card--pending' : '')));
      var ph = letter
        ? pick({ fr: 'Mot en ' + letter + '…', en: 'Word with ' + letter + '…' })
        : pick({ fr: 'Votre mot…', en: 'Your word…' });
      var verifyWord = (rej && rej.word) || val;
      var verifyHtml = '';
      if (!ok && verifyWord) {
        var verifyLbl = rej
          ? pick({ fr: '🔍 Vérifier « ' + verifyWord + ' »', en: '🔍 Verify « ' + verifyWord + ' »' })
          : pick({ fr: 'Pas accepté ? Vérifier', en: 'Not accepted? Verify' });
        verifyHtml =
          '<button type="button" class="opbac-card__verify' +
            (rej ? '' : ' opbac-card__verify--ghost') +
            (rej && rej.verifying ? ' opbac-card__verify--sent' : '') + '" data-verify-cat="' + escHtml(catKey) + '" ' +
            'data-verify-word="' + escHtml(verifyWord) + '">' +
            escHtml(rej && rej.verifying
              ? pick({ fr: 'Vérification envoyée…', en: 'Verification sent…' })
              : verifyLbl) +
          '</button>';
      }
      var errHtml = rej && rej.msg && !ok
        ? ('<p class="opbac-card__err">' + escHtml(rej.msg) + '</p>')
        : '';
      return '<div class="' + cardClass + '" data-cat="' + escHtml(catKey) + '">' +
        '<span class="opbac-card__cat">' + escHtml(cat) + (ok ? ' ✓' : '') + '</span>' +
        errHtml +
        '<input type="text" class="opbac-card__input" data-cat-input="' + escHtml(catKey) + '" ' +
          'value="' + escHtml(val) + '" placeholder="' + escHtml(ph) + '" ' +
          (ok ? 'disabled' : '') + ' autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="send" />' +
        '<button type="button" class="opbac-card__send" data-send-cat="' + escHtml(catKey) + '" ' +
          (ok ? 'disabled' : '') + '>' + escHtml(sendLbl) + '</button>' +
        verifyHtml +
      '</div>';
    }).join('');
    var allDisabled = game.categories.every(function (cat) {
      var k = cat.toLowerCase();
      return draft.validated[k] || draft.validated[cat];
    });
    return '<div class="opbac-form">' +
      '<div class="opbac-cards">' + cards + '</div>' +
      '<button type="button" class="opbac-form__all" data-act="sendall"' + (allDisabled ? ' disabled' : '') + '>' +
        escHtml(pick({ fr: 'Envoyer toutes mes réponses', en: 'Send all my answers' })) +
      '</button></div>';
  }

  function updateClockDom(root, remaining, progress) {
    var timerEl = root.querySelector('[data-opbac-timer]');
    var ringEl = root.querySelector('[data-opbac-ring]');
    var clockEl = root.querySelector('[data-opbac-clock]');
    if (timerEl) timerEl.textContent = remaining > 0 ? String(remaining) : '—';
    if (ringEl) {
      var r = 42;
      var c = 2 * Math.PI * r;
      ringEl.setAttribute('stroke-dashoffset', String(c * (1 - (progress || 0))));
    }
    if (clockEl) {
      clockEl.classList.toggle('opbac-clock--warn', remaining > 0 && remaining <= 10);
      clockEl.classList.toggle('opbac-clock--urgent', remaining > 0 && remaining <= 5);
    }
  }

  function draftSignature(channel, game) {
    var d = getDraft(channel, game);
    return roundKey(game) + '|' + JSON.stringify(d.validated) + '|' + JSON.stringify(d.pending) + '|' + JSON.stringify(d.rejected);
  }

  function panelSignature(game) {
    if (!game) return 'idle';
    return [
      game.phase,
      game.round,
      game.letter,
      (game.categories || []).join('|'),
      game.totalRounds,
    ].join(';');
  }

  function sendVerify(orbit, buffer, catKey, word) {
    word = String(word || '').trim();
    catKey = String(catKey || '').toLowerCase();
    if (!word || !catKey) return;
    var game = getChannelState(buffer) || defaultState();
    var catName = resolveCatName(game, catKey);
    var draft = getDraft(buffer, game);
    draft.drafts[catKey] = word;
    if (!draft.rejected) draft.rejected = Object.create(null);
    draft.rejected[catKey] = {
      word: word,
      catKey: catKey,
      msg: pick({ fr: 'Vérification en cours…', en: 'Verification in progress…' }),
      verifying: true,
    };
    orbit.irc.msg(buffer, '!verifier ' + catName + ' ' + word);
    bumpStore();
    try {
      orbit.notify('Petit Bac', pick({
        fr: '!verifier ' + catName + ' ' + word,
        en: '!verifier ' + catName + ' ' + word,
      }));
    } catch (e) { /* ignore */ }
  }

  function sendCategoryAnswer(orbit, buffer, catKey, word) {
    word = String(word || '').trim();
    if (!word) return;
    var game = getChannelState(buffer) || defaultState();
    var draft = getDraft(buffer, game);
    if (draft.validated[catKey]) return;
    draft.drafts[catKey] = word;
    draft.pending[catKey] = word;
    if (draft.rejected && draft.rejected[catKey]) delete draft.rejected[catKey];
    orbit.irc.msg(buffer, word);
    bumpStore();
  }

  function sendAllAnswers(orbit, buffer) {
    var game = getChannelState(buffer) || defaultState();
    if (!game.categories || !game.categories.length) return;
    var draft = getDraft(buffer, game);
    game.categories.forEach(function (cat) {
      var catKey = cat.toLowerCase();
      if (draft.validated[catKey]) return;
      var word = (draft.drafts[catKey] || '').trim();
      if (word) sendCategoryAnswer(orbit, buffer, catKey, word);
    });
  }

  function saveDraftFromDom(root, buffer) {
    var game = getChannelState(buffer) || defaultState();
    var draft = getDraft(buffer, game);
    var inputs = root.querySelectorAll('[data-cat-input]');
    inputs.forEach(function (inp) {
      var cat = inp.getAttribute('data-cat-input');
      if (cat && !draft.validated[cat]) draft.drafts[cat] = inp.value;
    });
  }

  function bindDomPanel(root, orbit) {
    if (root.__opbacBound) return;
    root.__opbacBound = true;
    root.addEventListener('click', function (ev) {
      var buffer = orbit.state.active();
      if (!buffer || !isBacChannel(orbit, buffer)) return;
      var sendCat = ev.target && ev.target.closest ? ev.target.closest('[data-send-cat]') : null;
      if (sendCat) {
        ev.preventDefault();
        var cat = sendCat.getAttribute('data-send-cat');
        var row = sendCat.closest('[data-cat]');
        var inp = row && row.querySelector('[data-cat-input]');
        if (cat && inp) sendCategoryAnswer(orbit, buffer, cat, inp.value);
        return;
      }
      var verifyBtn = ev.target && ev.target.closest ? ev.target.closest('[data-verify-cat]') : null;
      if (verifyBtn) {
        ev.preventDefault();
        var vCat = verifyBtn.getAttribute('data-verify-cat');
        var vWord = verifyBtn.getAttribute('data-verify-word');
        if (!vWord) {
          var vRow = verifyBtn.closest('[data-cat]');
          var vInp = vRow && vRow.querySelector('[data-cat-input]');
          vWord = vInp ? vInp.value : '';
        }
        if (vCat && vWord) sendVerify(orbit, buffer, vCat, vWord);
        return;
      }
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'collapse') {
        root.classList.toggle('opbac-panel--collapsed');
        var collapseBtn = root.querySelector('[data-act="collapse"]');
        if (collapseBtn) {
          collapseBtn.textContent = root.classList.contains('opbac-panel--collapsed') ? '▾' : '▴';
        }
        return;
      }
      if (act === 'jouer') orbit.irc.msg(buffer, '!jouer');
      if (act === 'aide') orbit.irc.msg(buffer, '!aide');
      if (act === 'sendall') sendAllAnswers(orbit, buffer);
    });
    root.addEventListener('input', function (ev) {
      var inp = ev.target;
      if (!inp || !inp.getAttribute || !inp.getAttribute('data-cat-input')) return;
      var buffer = orbit.state.active();
      if (!buffer) return;
      var game = getChannelState(buffer) || defaultState();
      var draft = getDraft(buffer, game);
      var cat = inp.getAttribute('data-cat-input');
      if (cat) draft.drafts[cat] = inp.value;
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var inp = ev.target;
      if (!inp || !inp.getAttribute || !inp.getAttribute('data-cat-input')) return;
      ev.preventDefault();
      var buffer = orbit.state.active();
      if (!buffer) return;
      var cat = inp.getAttribute('data-cat-input');
      if (cat) sendCategoryAnswer(orbit, buffer, cat, inp.value);
    });
  }

  function renderDomPanel(orbit, root) {
    var buffer = orbit.state.active();
    if (!isBacChannel(orbit, buffer)) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    bindDomPanel(root, orbit);
    var game = getChannelState(buffer) || defaultState();
    var phase = game.phase || 'idle';
    var sig = panelSignature(game);
    var rebuild = root.__opbacSig !== sig;
    var isLive = phase === 'playing' && game.letter && game.categories.length > 0;
    var isIdle = phase === 'idle' && !game.letter;

    if (rebuild) {
      saveDraftFromDom(root, buffer);
      root.__opbacSig = sig;
    }

    var timing = computeRemaining(game);
    var remaining = timing.remaining;
    var progress = timing.progress;
    var wasCollapsed = root.classList.contains('opbac-panel--collapsed');

    root.className = 'opbac-panel' +
      (wasCollapsed ? ' opbac-panel--collapsed' : '') +
      (isLive ? ' opbac-panel--playing' : '');

    if (rebuild) {
      var headBadge = game.round && game.totalRounds
        ? ('Manche ' + game.round + '/' + game.totalRounds)
        : phaseLabel(phase, game.countdown);

      root.innerHTML =
        '<div class="opbac-head">' +
          '<span class="opbac-head__title">🎲 ' + escHtml(pick({ fr: 'Petit Bac', en: 'Petit Bac' })) + '</span>' +
          '<span class="opbac-head__badge">' + escHtml(headBadge) + '</span>' +
          '<button type="button" class="opbac-head__btn" data-act="collapse" title="' +
            escHtml(pick({ fr: 'Réduire', en: 'Collapse' })) + '">' + (wasCollapsed ? '▾' : '▴') + '</button>' +
        '</div>' +
        '<div class="opbac-body">' +
          (isIdle && !game.letter
            ? ('<div class="opbac-idle">' +
                '<p class="opbac-idle__txt">' + escHtml(pick({
                  fr: 'Jouez au Petit Bac directement ici. Le tchat reste visible en dessous pour suivre la partie.',
                  en: 'Play Petit Bac right here. Chat stays visible below to follow the game.',
                })) + '</p>' +
                '<button type="button" class="opbac-idle__cta" data-act="jouer">' +
                  escHtml(pick({ fr: '▶ Lancer une partie', en: '▶ Start a game' })) +
                '</button></div>')
            : (buildStageHtml(game, phase, remaining, progress, timing.total) +
              '<div class="opbac-scroll"><div data-opbac-form>' + buildFormHtml(buffer, game) + '</div></div>')) +
        '</div>' +
        '<div class="opbac-foot">' +
          '<button type="button" class="opbac-foot__btn" data-act="aide">' +
            escHtml(pick({ fr: 'Aide', en: 'Help' })) + '</button>' +
          '<button type="button" class="opbac-foot__btn opbac-foot__btn--primary" data-act="jouer">' +
            escHtml(pick({ fr: 'Jouer', en: 'Play' })) + '</button>' +
        '</div>';

      root.__opbacDraftSig = draftSignature(buffer, game);

      if (isLive) {
        requestAnimationFrame(function () {
          var first = root.querySelector('.opbac-card__input:not([disabled])');
          if (first) first.focus();
        });
      }
    } else {
      var badgeEl = root.querySelector('[data-opbac-badge]');
      if (badgeEl && game.round && game.totalRounds) {
        badgeEl.textContent = pick({ fr: 'Manche', en: 'Round' }) + ' ' + game.round + ' / ' + game.totalRounds;
      }
      var phaseEl = root.querySelector('[data-opbac-phase]');
      if (phaseEl) phaseEl.textContent = phaseLabel(phase, game.countdown);
      updateClockDom(root, remaining, progress);

      var formWrap = root.querySelector('[data-opbac-form]');
      var dSig = draftSignature(buffer, game);
      if (formWrap && root.__opbacDraftSig !== dSig) {
        root.__opbacDraftSig = dSig;
        saveDraftFromDom(root, buffer);
        formWrap.innerHTML = buildFormHtml(buffer, game);
      }
    }

    if (!rebuild && isLive) updateClockDom(root, remaining, progress);
  }

  function mountDomPanel(orbit) {
    var root = document.getElementById('opbac-dom-panel');
    if (!root) {
      root = document.createElement('div');
      root.id = 'opbac-dom-panel';
      root.className = 'opbac-panel';
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', 'Petit Bac');
    }
    var main = document.querySelector('.main');
    var topbar = main && main.querySelector('.topbar');
    if (!main || !topbar) return;
    if (root.parentNode !== main || root.previousElementSibling !== topbar) {
      topbar.insertAdjacentElement('afterend', root);
    }
    renderDomPanel(orbit, root);
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    var buffer = useActiveBuffer(orbit);
    if (!buffer || !channelEnabled(orbit, buffer)) return null;
    return h('button', {
      type: 'button',
      className: 'nmenu__item',
      role: 'menuitem',
      onClick: function () { orbit.irc.msg(buffer, '!jouer'); },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, '🎲'),
      h('span', { className: 'nmenu__txt' }, h('b', null, pick({ fr: 'Petit Bac', en: 'Petit Bac' })))
    );
  }

  Orbit.plugin('orbit-petitbac', function (orbit, log) {
    pluginOrbit = orbit;
    injectStyles();
    console.info('[orbit-petitbac] loaded v8');

    function syncDom() {
      try { mountDomPanel(orbit); } catch (e) { console.error('[orbit-petitbac] dom panel', e); }
    }

    var unsubStore = subscribe(function () { syncDom(); });

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '').toUpperCase();
      if (cmd === 'TAGMSG') {
        var tags = msg.tags || {};
        if (tagVal(tags, PB) !== 'v1') return;
        var target = (msg.params && msg.params[0]) || '';
        if (!isChannelName(target)) return;
        if (!channelEnabled(orbit, target)) return;
        handlePetitBacEvent(target, tags);
        log('orbit-petitbac', tagVal(tags, EV), target);
        return;
      }
      if (cmd === 'PRIVMSG' || cmd === 'NOTICE') {
        var chan = (msg.params && msg.params[0]) || '';
        if (!isChannelName(chan)) return;
        if (!channelEnabled(orbit, chan)) return;
        var myNick = orbit.state.nick() || '';
        handleIrcLine(chan, msg.nick, (msg.params && msg.params[1]) || '', myNick);
        syncDom();
      }
    });

    orbit.on('buffer.active', syncDom);
    orbit.on('connected', syncDom);
    orbit.on('status', syncDom);
    setInterval(syncDom, 250);

    orbit.addUi('topbar_item', function () {
      return h(TopbarToggle, { orbit: orbit });
    });

    orbit.addUi('composer_button', function () {
      return h(ComposerButton, { orbit: orbit });
    });

    orbit.addUi('topbar_more_item', function () {
      return h(MoreMenuItem, { orbit: orbit });
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
    console.info('[orbit-petitbac] ready — channels:', (cfg(orbit).channels || []).join(', '));
  });

  }

  boot(0);
})();
