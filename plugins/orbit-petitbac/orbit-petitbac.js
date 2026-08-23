/*!
 * orbit-petitbac — UI moderne pour le bot Limnoria Petit Bac (EntreNous)
 * Écoute les TAGMSG IRCv3 : +pb=v1 +ev=<event> (+letter, +categories, …)
 * Envoie les commandes en TAGMSG (+ev=cmd) pour ne pas polluer le tchat.
 */
(function () {
  'use strict';

  var PBAC_VER = 57;
  var syncRequestAt = Object.create(null);
  var STORAGE_PANEL_HEIGHT = 'opbacPanelHeightV2';
  var STORAGE_VIEW_MODE = 'opbacViewMode';
  var STORAGE_GAME_VIEW = 'opbacGameView';
  var STORAGE_LIVE_OPEN = 'opbacLiveOpen';
  var STORAGE_SKIP_RULES = 'opbacSkipRules';
  var PANEL_HEIGHT_MIN = 220;
  var PANEL_HEIGHT_MAX = 1200;
  var CHAT_RESERVE_MIN = 120; /* topic + composer at least */
  var VIEW_FULL = 'full';
  var VIEW_SPLIT = 'split';
  var VIEW_CHAT = 'chat';
  var lobbyFetchAt = 0;
  var lobbyWaiting = false;

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
  var extraModes = [];
  var extraModesTick = 0;
  var listeAt = 0;
  var waitingListe = false;
  var pendingCreate = false;
  var createdNotice = '';
  var createdModeId = '';
  var STORAGE_LOBBY_TAB = 'opbacLobbyTab';
  var activeVote = null;

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
      botNicks: Array.isArray(c.botNicks) && c.botNicks.length
        ? c.botNicks.map(function (n) { return String(n || '').toLowerCase(); })
        : ['bac', 'maitredujeu'],
      maxPlayers: Math.max(4, Math.min(24, Number(c.maxPlayers) || 14)),
    };
  }

  function bacBotNicks(orbit) {
    return cfg(orbit).botNicks;
  }

  /** @returns {'present'|'absent'|'unknown'} */
  function bacBotPresence(orbit, bufferKey) {
    if (!orbit || !bufferKey) return 'unknown';
    var st = orbit.state.get();
    var buf = st && st.buffers && st.buffers[bufferKey];
    if (!buf) return 'unknown';
    var members = buf.members || {};
    var keys = Object.keys(members);
    var bots = bacBotNicks(orbit);
    for (var i = 0; i < keys.length; i++) {
      if (bots.indexOf(String(keys[i]).toLowerCase()) >= 0) return 'present';
    }
    var me = String(st.nick || '').toLowerCase();
    var hasMe = me && keys.some(function (k) { return String(k).toLowerCase() === me; });
    if (hasMe || (buf.joined && keys.length > 0)) return 'absent';
    return 'unknown';
  }

  function isBacBotPresent(orbit, bufferKey) {
    return bacBotPresence(orbit, bufferKey) === 'present';
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
    return c.channels.indexOf(n) >= 0;
  }

  function channelEnabled(orbit, channelKey) {
    return isBacChannel(orbit, channelKey);
  }

  function isBouncerSession(orbit) {
    try {
      if (orbit.state.viaBouncer) return !!orbit.state.viaBouncer();
      return !!(orbit.state.get() || {}).viaBouncer;
    } catch (e) { return false; }
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

  var ASSET_BASE = '/app/plugins/third/orbit-petitbac/assets/';

  function assetUrl(name) {
    return ASSET_BASE + String(name || '');
  }

  function imgHtml(name, alt, cls) {
    return '<img class="' + escHtml(cls || 'opbac-img') + '" src="' + escHtml(assetUrl(name)) + '" alt="' +
      escHtml(alt || '') + '" loading="lazy" decoding="async" draggable="false"/>';
  }

  function refreshSpinnerHtml(cls) {
    return '<span class="opbac-refresh' + (cls ? ' ' + escHtml(cls) : '') + '" role="status" aria-hidden="true"></span>';
  }

  function categoryIconMeta(cat) {
    var s = String(cat || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/prenom|nom propre|celebrite|star/.test(s) && !/pays|ville|marque/.test(s)) {
      return { kind: 'person', bg: '#ec4899' };
    }
    if (/pays|ville|capitale|continent|monde|region|ile|departement/.test(s)) {
      return { kind: 'geo', bg: '#0d9488' };
    }
    if (/animal|oiseau|mamif|insect|reptil|poisson|bete/.test(s)) {
      return { kind: 'animal', bg: '#f97316' };
    }
    if (/fruit/.test(s)) return { kind: 'fruit', bg: '#ef4444' };
    if (/legume|vegetal|plante|fleur|arbre/.test(s)) return { kind: 'plant', bg: '#16a34a' };
    if (/nourriture|plat|boisson|manger|repas|aliment/.test(s)) return { kind: 'food', bg: '#ca8a04' };
    if (/metier|profession|job|travail/.test(s)) return { kind: 'job', bg: '#d97706' };
    if (/marque|enseigne/.test(s)) return { kind: 'brand', bg: '#7c3aed' };
    if (/couleur/.test(s)) return { kind: 'color', bg: 'linear-gradient(135deg,#ef4444 0%,#eab308 35%,#22c55e 65%,#3b82f6 100%)' };
    if (/sport/.test(s)) return { kind: 'sport', bg: '#dc2626' };
    if (/film|serie|cinema/.test(s)) return { kind: 'media', bg: '#4f46e5' };
    if (/musique|chanson|chanteur|artiste/.test(s)) return { kind: 'music', bg: '#c026d3' };
    if (/acteur|personnage/.test(s)) return { kind: 'person', bg: '#db2777' };
    if (/objet|chose|ustensile/.test(s)) return { kind: 'object', bg: '#2563eb' };
    if (/vetement|habit/.test(s)) return { kind: 'cloth', bg: '#0ea5e9' };
    if (/voiture|vehicule/.test(s)) return { kind: 'car', bg: '#334155' };
    if (/jeu/.test(s)) return { kind: 'game', bg: '#7c3aed' };
    if (/livre|auteur/.test(s)) return { kind: 'book', bg: '#92400e' };
    if (/monument|batiment|lieu/.test(s)) return { kind: 'building', bg: '#57534e' };
    if (/mer|ocean|riviere|fleuve|lac/.test(s)) return { kind: 'water', bg: '#0284c7' };
    return { kind: 'default', bg: '#6366f1' };
  }

  function categoryIconHtml(cat) {
    var meta = categoryIconMeta(cat);
    var kind = meta.kind;
    var paths = {
      animal: '<path d="M4 11c1.2-2.2 3.2-3.2 5-3.2s3.8 1 5 3.2c1.2 2.2.6 4.8-1.4 6.2-1.2.8-2.6.8-3.6 0-1 .8-2.4.8-3.6 0-2-1.4-2.6-4-1.4-6.2z" fill="#fff"/><circle cx="7.2" cy="10.2" r="1" fill="#fb923c"/><circle cx="10.8" cy="10.2" r="1" fill="#fb923c"/>',
      geo: '<circle cx="9" cy="9" r="6.2" fill="none" stroke="#fff" stroke-width="1.7"/><path d="M2.8 9h12.4M9 2.8c1.8 2.2 2.6 4.2 2.6 6.2S10.8 14 9 15.2M9 2.8C7.2 5 6.4 7 6.4 9s.8 4.2 2.6 6.2" stroke="#fff" stroke-width="1.3" fill="none"/>',
      fruit: '<path d="M9 4.2c2.8.2 5 2.8 5 5.8 0 3.4-2.2 6.2-5 6.2S4 13.4 4 10c0-3 2.2-5.6 5-5.8z" fill="#fff"/><path d="M9 4.2c.4-1.4 1.6-2.2 2.8-2" stroke="#bbf7d0" stroke-width="1.3" fill="none"/>',
      plant: '<path d="M9 16V8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M9 11c-3-2.4-4.5-5.2-3.8-7.2 2.4.4 4.2 2.6 4.2 5.2 0-2.6 1.8-4.8 4.2-5.2.7 2-1 4.8-3.8 7.2" fill="#fff"/>',
      food: '<path d="M6.5 3.2v4.2c0 1.8-1 2.8-2.4 3.2V15h2.4V10.6c1.4-.2 2.4-1.4 2.4-3.2V3.2H6.5z" fill="#fff"/><path d="M12.2 3.2v5.2c0 1.5 1 2.6 2.4 2.8V15h-2.4V3.2z" fill="#fff" opacity=".8"/>',
      person: '<circle cx="9" cy="6.2" r="2.8" fill="#fff"/><path d="M3.4 16c0-3.2 2.5-5.4 5.6-5.4s5.6 2.2 5.6 5.4" fill="#fff"/>',
      job: '<rect x="3.2" y="7.2" width="11.6" height="8" rx="1.4" fill="#fff"/><path d="M6.6 7.2V5.6c0-.7.6-1.2 1.3-1.2h2.2c.7 0 1.3.5 1.3 1.2v1.6" stroke="#fff" stroke-width="1.4" fill="none"/>',
      brand: '<path d="M4 3.6h7.2L15 7.4v7c0 .9-.7 1.6-1.6 1.6H4c-.9 0-1.6-.7-1.6-1.6V5.2C2.4 4.3 3.1 3.6 4 3.6z" fill="#fff"/><path d="M8 3.6v3.6h3.6" stroke="#7c3aed" stroke-width="1.2" fill="none"/>',
      color: '<circle cx="6.2" cy="10" r="2.6" fill="#fecaca"/><circle cx="9.6" cy="7.2" r="2.6" fill="#bfdbfe"/><circle cx="13" cy="10" r="2.6" fill="#bbf7d0"/><circle cx="9.6" cy="12.8" r="2.6" fill="#fde68a"/>',
      sport: '<circle cx="9" cy="9" r="6.2" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M3 9h12M9 3c1.8 1.8 2.6 3.6 2.6 6S10.8 13.2 9 15M9 3C7.2 4.8 6.4 6.6 6.4 9S7.2 13.2 9 15" stroke="#fff" stroke-width="1.2" fill="none"/>',
      media: '<rect x="2.8" y="4.8" width="12.4" height="9.4" rx="1.8" fill="#fff"/><path d="M7.4 8.2l2.6 1.7 3.4-3.4" stroke="#4f46e5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      music: '<path d="M7.2 14.6a2.2 2.2 0 11-2.2-2.2" fill="#fff"/><path d="M7.2 12.4V4.4l7 1.4v8.2" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="14.2" cy="13.8" r="2.2" fill="#fff"/>',
      object: '<rect x="4" y="3.6" width="10" height="11.6" rx="2" fill="#fff"/><path d="M7 7.4h4.2M7 10.2h3" stroke="#2563eb" stroke-width="1.3" stroke-linecap="round"/>',
      cloth: '<path d="M6 4.2l3-1.2 3 1.2 2.4 2.2-2.2 1.4v7.2H5.8V7.8L3.6 6.4 6 4.2z" fill="#fff"/>',
      car: '<path d="M3.4 10.2l1.6-3.4h8l1.6 3.4v3.2H3.4v-3.2z" fill="#fff"/><circle cx="6.2" cy="13.6" r="1.3" fill="#334155"/><circle cx="11.8" cy="13.6" r="1.3" fill="#334155"/>',
      game: '<rect x="2.4" y="6.2" width="13.2" height="7.6" rx="3.2" fill="#fff"/><path d="M6 10h2.4M7.2 8.8v2.4M11.4 9.2h.02M13.2 10.8h.02" stroke="#7c3aed" stroke-width="1.4" stroke-linecap="round"/>',
      book: '<path d="M4 3.8h8.2c.9 0 1.6.7 1.6 1.6v9.4H5.6c-.9 0-1.6-.7-1.6-1.6V3.8z" fill="#fff"/><path d="M5.8 5.6h6.2M5.8 8h4.4" stroke="#92400e" stroke-width="1.2" stroke-linecap="round"/>',
      building: '<path d="M4 15.2V6.4l5-2.6 5 2.6v8.8H4z" fill="#fff"/><path d="M8.2 15.2v-3.6h1.6v3.6" fill="#57534e"/><path d="M6.2 8.2h1.4v1.4H6.2zm4.2 0h1.4v1.4h-1.4z" fill="#57534e"/>',
      water: '<path d="M9 3.4c2.8 3.2 4.8 5.4 4.8 7.6A4.8 4.8 0 019 15.8a4.8 4.8 0 01-4.8-4.8c0-2.2 2-4.4 4.8-7.6z" fill="#fff"/>',
      default: '<rect x="4" y="3.6" width="10" height="11.6" rx="2" fill="#fff"/><path d="M6.6 7.4h4.8M6.6 10.2h3.2" stroke="#6366f1" stroke-width="1.3" stroke-linecap="round"/>',
    };
    return '<span class="opbac-col__ico-wrap" style="background:' + escHtml(meta.bg) + '" title="' +
      escHtml(cat) + '"><svg class="opbac-col__ico" viewBox="0 0 18 18" aria-hidden="true" focusable="false">' +
      (paths[kind] || paths.default) + '</svg></span>';
  }

  function isPrepPhase(phase) {
    return phase === 'starting' || phase === 'rules' || phase === 'countdown' || phase === 'go';
  }

  function isGameRunning(game) {
    if (!game) return false;
    var phase = game.phase || 'idle';
    if (phase === 'game_end') return false;
    if (phase === 'round_end') return false;
    if (phase === 'idle' && !game.totalRounds && !game.round && !game.letter) return false;
    return phase !== 'idle' || game.totalRounds > 0 || game.round > 0 || !!game.letter;
  }

  function hasPlayableGrid(game) {
    return !!(game && game.letter && game.categories && game.categories.length);
  }

  function escapeIrcTag(val) {
    return String(val || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/;/g, '\\:')
      .replace(/ /g, '\\s');
  }

  function sendPbTarget(orbit, buffer) {
    return resolveChannelName(orbit, buffer) || buffer;
  }

  function sendPbCmd(orbit, buffer, name, arg) {
    if (!orbit || !buffer || !name) return;
    var target = sendPbTarget(orbit, buffer);
    var tags = '+pb=v1;+ev=cmd;+name=' + escapeIrcTag(name);
    if (arg != null && String(arg) !== '') tags += ';+arg=' + escapeIrcTag(arg);
    try {
      if (orbit.irc && orbit.irc.send) {
        orbit.irc.send('@' + tags + ' TAGMSG ' + target);
        return;
      }
    } catch (e) { /* ignore */ }
  }

  function skipRulesPref(orbit) {
    var o = orbit || pluginOrbit;
    try { if (o) return o.storage.get(STORAGE_SKIP_RULES, false) === true; } catch (e) { /* ignore */ }
    return false;
  }

  function setSkipRulesPref(orbit, skip) {
    var o = orbit || pluginOrbit;
    try { if (o) o.storage.set(STORAGE_SKIP_RULES, !!skip); } catch (e) { /* ignore */ }
    bumpStore();
  }

  function sendJouerCmd(orbit, buffer) {
    sendPbCmd(orbit, buffer, 'jouer', skipRulesPref(orbit) ? 'noregles' : '');
  }

  function buildSkipRulesCheckHtml(orbit) {
    var on = skipRulesPref(orbit);
    return '<label class="opbac-skip-rules">' +
      '<input type="checkbox" data-skip-rules' + (on ? ' checked' : '') + '>' +
      escHtml(pick({
        fr: 'Ne plus afficher les règles au lancement',
        en: 'Don\'t show the rules at launch',
      })) +
      '</label>';
  }

  function bindSkipRulesUi(root, orbit) {
    if (!root || root.__opbacSkipBound) return;
    root.__opbacSkipBound = true;
    root.addEventListener('change', function (ev) {
      var inp = ev.target;
      if (!inp || !inp.getAttribute || inp.getAttribute('data-skip-rules') == null) return;
      setSkipRulesPref(orbit || pluginOrbit, !!inp.checked);
      if (inp.checked) closeOverlayModal('rules');
    });
  }

  function sendPbPlay(orbit, buffer, word, cat) {
    if (!orbit || !buffer || !word) return;
    var target = sendPbTarget(orbit, buffer);
    var tags = '+pb=v1;+ev=play;+word=' + escapeIrcTag(word);
    if (cat) tags += ';+cat=' + escapeIrcTag(cat);
    try {
      if (orbit.irc && orbit.irc.send) {
        orbit.irc.send('@' + tags + ' TAGMSG ' + target);
      }
    } catch (e) { /* ignore */ }
  }

  function maybeRequestGameSync(orbit, buffer, game) {
    if (!orbit || !buffer || !isBacChannel(orbit, buffer)) return;
    if (isPrepPhase(game.phase) || game.phase === 'paused') return;
    if (hasPlayableGrid(game) && game.phase === 'playing') return;
    var key = normChan(buffer);
    var now = Date.now();
    if (syncRequestAt[key] && now - syncRequestAt[key] < 12000) return;
    syncRequestAt[key] = now;
    sendPbCmd(orbit, buffer, 'manche');
  }

  function bindChatFollow() {
    var el = document.querySelector('.main .messages');
    if (!el || el.__opbacFollowBound) return;
    el.__opbacFollowBound = true;
    el.__opbacStickBottom = true;
    el.addEventListener('scroll', function () {
      var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      el.__opbacStickBottom = dist < 24;
    }, { passive: true });
  }

  function pinChatIfFollowing() {
    bindChatFollow();
    var el = document.querySelector('.main .messages');
    if (!el) return;
    var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.__opbacStickBottom === false || dist > 24) return;
    el.scrollTop = el.scrollHeight;
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

  function isMyNick(nick) {
    if (!nick) return true;
    var me = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick
      ? String(pluginOrbit.state.nick() || '')
      : '';
    if (!me) return true;
    return String(nick).replace(/^[@+%~&]/, '').toLowerCase() ===
      me.replace(/^[@+%~&]/, '').toLowerCase();
  }

  function isIaAward(pts) {
    var n = Number(pts);
    return n > 0 && n < 1;
  }

  function formatPtsShort(pts) {
    var n = Number(pts);
    if (!(n >= 0)) n = 0;
    if (Math.abs(n % 1) < 0.001) return String(Math.round(n));
    return String(Math.round(n * 10) / 10).replace('.', ',');
  }

  function catAward(draft, catKey, cat) {
    var v = draft && (draft.validated[catKey] || (cat && draft.validated[cat]));
    if (!v) return null;
    if (v === true) return { pts: 1, ia: false };
    return { pts: v.pts || 1, ia: !!v.ia || isIaAward(v.pts) };
  }

  function markCatValidated(draft, catKey, pts, ia) {
    if (!draft || !catKey) return;
    var n = parsePts(pts);
    if (!(n > 0)) n = 1;
    draft.validated[catKey] = { pts: n, ia: !!ia || isIaAward(n) };
    delete draft.pending[catKey];
    if (draft.rejected) delete draft.rejected[catKey];
  }

  function clearDraft(channel) {
    delete draftStore.byChannel[normChan(channel)];
  }

  function stopGameUi(channel, reason) {
    clearDraft(channel);
    activeVote = null;
    try { delete rulesShownFor[normChan(channel)]; } catch (e) { /* ignore */ }
    setChannelState(channel, Object.assign(defaultState(), {
      phase: 'idle',
      stopReason: reason || 'op',
      updatedAt: Date.now(),
    }));
    var root = document.getElementById('opbac-dom-panel');
    if (root) {
      root.classList.remove(
        'opbac-panel--collapsed', 'opbac-panel--playing', 'opbac-panel--game-end',
        'opbac-panel--round-end', 'opbac-panel--complete',
        'opbac-panel--full', 'opbac-panel--split', 'opbac-panel--chat'
      );
      root.__opbacSig = '';
      root.__opbacEndPhase = '';
      root.__opbacEndSig = '';
      root.__opbacDidOpenEnd = false;
    }
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

  function shouldSuggestInfo(reasonCode, msg) {
    var code = String(reasonCode || '').toLowerCase();
    var m = String(msg || '').toLowerCase();
    if (code === 'not_found' || code === 'invalid') return true;
    if (/pas trouv|dictionnaire|wikip[eé]dia|n.?est pas valide|not found|not recognized/.test(m)) return true;
    return false;
  }

  function rejectMessageForCode(code, word) {
    var w = String(word || '').trim();
    var quoted = w ? (' « ' + w + ' »') : '';
    switch (String(code || '').toLowerCase()) {
      case 'invalid':
        return pick({ fr: 'Mot' + quoted + ' non reconnu pour cette manche.', en: 'Word' + quoted + ' not recognized for this round.' });
      case 'not_found':
        return pick({ fr: 'Mot' + quoted + ' introuvable (dictionnaire / Wikipédia).', en: 'Word' + quoted + ' not found (dictionary / Wikipedia).' });
      case 'wrong_letter':
        return pick({ fr: 'Le mot ne commence pas par la bonne lettre.', en: 'Word does not start with the correct letter.' });
      case 'already_used':
        return pick({ fr: 'Ce mot a déjà été utilisé.', en: 'This word was already used.' });
      case 'already_round':
        return pick({ fr: 'Catégorie déjà validée dans cette manche.', en: 'Category already validated this round.' });
      case 'bad_cat':
        return pick({ fr: 'Mot invalide pour cette catégorie.', en: 'Word invalid for this category.' });
      case 'excluded':
        return pick({ fr: 'Mot exclu du jeu.', en: 'Word excluded from the game.' });
      default:
        return pick({ fr: 'Mot non accepté.', en: 'Word not accepted.' });
    }
  }

  function buildInfoHintHtml(word) {
    word = String(word || '').trim();
    if (!word) return '';
    return '<div class="opbac-info-hint" role="note">' +
      '<span class="opbac-info-hint__icon" aria-hidden="true">🔍</span>' +
      '<div class="opbac-info-hint__body">' +
        '<span class="opbac-info-hint__lbl">' +
          escHtml(pick({ fr: 'Consulter sur Wikipédia', en: 'Look up on Wikipedia' })) +
        '</span>' +
        '<span class="opbac-info-hint__cmd">' + escHtml(word) + '</span>' +
      '</div>' +
      '<button type="button" class="opbac-info-hint__btn" data-act="info" data-info-word="' +
        escHtml(word) + '" title="' + escHtml(pick({ fr: 'Ouvrir la fiche', en: 'Open article' })) + '">' +
        escHtml(pick({ fr: 'Consulter', en: 'Look up' })) +
      '</button></div>';
  }

  function sendInfo(orbit, buffer, word) {
    word = String(word || '').trim();
    if (!word || !buffer) return;
    infoLookup = { word: word, waiting: true, buffer: normChan(buffer) };
    openInfoModal(word, '', true);
    sendPbCmd(orbit, buffer, 'info', word);
  }

  function markRejected(channel, catKey, word, reason, meta) {
    if (!word && !catKey) return;
    meta = meta || {};
    var game = getChannelState(channel) || defaultState();
    var draft = getDraft(channel, game);
    draft.rejected = draft.rejected || Object.create(null);
    var key = catKey || String(word || '').toLowerCase();
    var code = meta.code || '';
    var msg = reason;
    if (code && (!msg || msg === code)) msg = rejectMessageForCode(code, word);
    if (!msg) msg = pick({ fr: 'Mot non accepté', en: 'Word not accepted' });
    draft.rejected[key] = {
      word: word,
      catKey: catKey,
      msg: msg,
      reason: code,
      suggestInfo: meta.suggestInfo != null ? meta.suggestInfo : shouldSuggestInfo(code, msg),
      verifying: false,
    };
    if (catKey) delete draft.pending[catKey];
    bumpStore();
  }

  function showScoreBurst(pts, kind) {
    pts = Number(pts);
    if (!(pts > 0)) pts = 1;
    var ia = kind === 'ia' || isIaAward(pts);
    var host = document.getElementById('opbac-dom-panel');
    if (!host || host.classList.contains('opbac-panel--chat') || host.classList.contains('opbac-panel--collapsed')) host = document.body;
    var burst = document.createElement('div');
    burst.className = 'opbac-score-burst' + (pts >= 2 ? ' opbac-score-burst--hard' : (ia ? ' opbac-score-burst--ia' : ''));
    burst.setAttribute('aria-hidden', 'true');
    var sparks = '';
    var dirs = [[-42, -28], [38, -34], [-28, 22], [44, 18], [0, -48], [-52, 4], [54, -8]];
    for (var i = 0; i < dirs.length; i++) {
      sparks += '<span class="opbac-score-burst__spark" style="--dx:' + dirs[i][0] + 'px;--dy:' +
        dirs[i][1] + 'px;animation-delay:' + (i * 0.04) + 's"></span>';
    }
    burst.innerHTML =
      sparks +
      '<span class="opbac-score-burst__n">+' + formatPtsShort(pts) + '</span>' +
      '<span class="opbac-score-burst__lbl">' +
        escHtml(ia
          ? pick({ fr: 'IA', en: 'AI' })
          : ptsLabel()) +
      '</span>';
    host.appendChild(burst);
    window.setTimeout(function () { if (burst.parentNode) burst.remove(); }, 1450);
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
      }), { suggestInfo: false });
      return;
    }

    var infoLine = plain.match(/!info\s+(\S+)/i);
    if (infoLine && /🔍|d[eé]finition|wikip[eé]dia/i.test(plain)) {
      var infoWord = infoLine[1].replace(/[.!?,;:]+$/, '').trim();
      if (infoWord) {
        Object.keys(draft.rejected || {}).forEach(function (k) {
          var entry = draft.rejected[k];
          if (entry && String(entry.word || '').toLowerCase() === infoWord.toLowerCase()) {
            entry.suggestInfo = true;
          }
        });
        bumpStore();
      }
      return;
    }

    var noticeManche = plain.match(/🧮\s*Manche\s*:\s*(\d+)/i);
    if (noticeManche) {
      patchChannel(channel, {
        round: Number(noticeManche[1]) || 1,
        phase: 'playing',
        duration: (getChannelState(channel) || {}).duration || 60,
      });
    }

    var m = plain.match(/^([^:]{1,32}):\s*(.+)$/);
    if (!m || m[1].toLowerCase() !== myNick.toLowerCase()) return;
    var msg = m[2];

    var accepted = msg.match(/(?:✔️|💎).*?Cat[ée]gorie\s+(\S+)/i);
    if (accepted) {
      var cat = accepted[1].replace(/[.,;:!?]+$/, '').toLowerCase();
      if (draft.validated[cat]) return;
      var ptsM = msg.match(/\(\+?\s*(\d+(?:[.,]\d+)?)\s*point/i);
      var ia = /🤖|l['’]IA/i.test(msg);
      var pts = ptsM ? parsePts(ptsM[1]) : (ia ? 0.5 : (/💎/.test(msg) ? 2 : 1));
      markCatValidated(draft, cat, pts, ia);
      if (draft.rejected) {
        Object.keys(draft.rejected).forEach(function (k) {
          if (draft.rejected[k] && draft.rejected[k].catKey === cat) delete draft.rejected[k];
        });
      }
      showScoreBurst(pts, ia ? 'ia' : '');
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
      markRejected(
        channel,
        catKey,
        word || draft.drafts[catKey] || '',
        short || msg.slice(0, 100),
        { suggestInfo: shouldSuggestInfo('', short || msg) }
      );
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
    var liveVal = parseValidationLine(plain);
    if (liveVal && liveVal.cat) applyLiveAnswer(channel, liveVal.nick, liveVal.cat, liveVal.word, liveVal.pts);
    var joinLive = stripReplyPrefix(plain).match(/^👋\s+(\S+)\s+rejoint la partie/i);
    if (joinLive) ensureLivePlayer(channel, joinLive[1]);

    var body = stripReplyPrefix(plain);
    var n = String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
    var fromBac = n === 'bac' || n === 'maitredujeu';
    try {
      if (!fromBac && pluginOrbit) fromBac = bacBotNicks(pluginOrbit).indexOf(n) >= 0;
    } catch (e) { /* ignore */ }

    if (fromBac && handleModeListLine(body)) return;

    if (fromBac && /Partie arr[eê]t[eé]e|Jeu arr[eê]t[eé]|arr[eê]t[eé]e?\s+par un op|inactivit[eé]/i.test(body)) {
      stopGameUi(channel, /inactivit/i.test(body) ? 'idle' : 'op');
      return;
    }

    if (fromBac && /R[eè]gles du Petit Bac/i.test(body)) {
      var stRules = getChannelState(channel) || defaultState();
      if (isPrepPhase(stRules.phase) || stRules.phase === 'idle') {
        patchChannel(channel, { phase: 'rules' });
      }
    }

    if (fromBac && handleBacInfoResponse(channel, body)) return;

    if (fromBac && /nouvelle partie/i.test(body)) {
      delete rulesShownFor[normChan(channel)];
      var modeStart = body.match(/mode\s+([a-zàâéèêëïîôùûüç0-9_-]+)/i);
      patchChannel(channel, {
        phase: 'starting',
        letter: '',
        categories: [],
        mode: modeStart ? modeStart[1].toLowerCase() : ((getChannelState(channel) || {}).mode || ''),
      });
    }
    if (fromBac && /petit bac est actuellement en cours|la partie d[eé]marre|c'est parti|une partie est d[eé]j[aà] en cours/i.test(body)) {
      if (!/partie d[eé]marre\s*:/i.test(body)) {
        patchChannel(channel, { phase: 'starting' });
      }
    }
    var startInfo = body.match(/partie d[eé]marre\s*:\s*(\d+)\s+manches\s+de\s+(\d+)\s+secondes/i);
    if (startInfo) {
      var stStart = getChannelState(channel) || defaultState();
      patchChannel(channel, {
        phase: 'starting',
        totalRounds: Number(startInfo[1]) || stStart.totalRounds || 0,
        duration: Number(startInfo[2]) || stStart.duration || 60,
        round: stStart.round || 1,
      });
    }
    var cdStart = body.match(/jeu commence dans\s+(\d+)/i);
    if (cdStart) {
      patchChannel(channel, {
        phase: 'countdown',
        countdown: Number(cdStart[1]) || 0,
        countdownAt: Date.now(),
      });
    }
    if (/c'est parti/i.test(body)) {
      patchChannel(channel, { phase: 'go', countdown: 0 });
    }
    if (fromBac && /mise en pause/i.test(body)) {
      var tPauseIrc = computeRemaining(getChannelState(channel) || defaultState());
      patchChannel(channel, {
        phase: 'paused',
        countdown: tPauseIrc.remaining,
        countdownAt: Date.now(),
        roundStartAt: 0,
      });
    }
    if (fromBac && (/🚀\s*GO/.test(body) || /GO\s*!/.test(body)) && (getChannelState(channel) || {}).phase === 'paused') {
      var leftGo = (getChannelState(channel) || {}).countdown || 0;
      var durGo = (getChannelState(channel) || {}).duration || 60;
      patchChannel(channel, {
        phase: 'playing',
        countdown: leftGo,
        countdownAt: Date.now(),
        roundStartAt: Date.now() - Math.max(0, (durGo - leftGo) * 1000),
      });
    }
    if (fromBac && (/Votez\s*:/i.test(body) || /Tapez !oui/i.test(body) || /propose de passer en mode/i.test(body) || /Voulez-vous continuer la partie/i.test(body))) {
      patchChannel(channel, {
        vote: {
          text: body.replace(/\s+/g, ' ').trim().slice(0, 160),
          until: Date.now() + 30000,
        },
      });
    }
    if (fromBac && (/Vote refusé/i.test(body) || /Temps écoulé : la partie actuelle continue/i.test(body))) {
      patchChannel(channel, { vote: null });
    }

    var manche = body.match(/manche\s+(\d+)\s*\/\s*(\d+)/i)
      || body.match(/manche\s*:\s*(\d+)(?:\s*\/\s*(\d+))?/i);
    if (manche) {
      var stMan = getChannelState(channel) || defaultState();
      if (stMan.phase === 'paused') {
        patchChannel(channel, {
          round: Number(manche[1]) || stMan.round || 0,
          totalRounds: Number(manche[2]) || stMan.totalRounds || 0,
        });
      } else {
      var durM = stMan.duration || 60;
      patchChannel(channel, {
        phase: 'playing',
        round: Number(manche[1]) || 0,
        totalRounds: Number(manche[2]) || stMan.totalRounds || 0,
        roundStartAt: Date.now(),
        countdownAt: Date.now(),
        countdown: durM,
        duration: durM,
      });
      }
    }
    var lc = body.match(/lettre\s*(?:actuelle)?\s*:\s*(\S+).*cat[ée]gories(?:\s+actuelles)?\s*:\s*(.+)$/i);
    if (lc) {
      var stLc = getChannelState(channel) || defaultState();
      if (stLc.phase === 'paused') {
        patchChannel(channel, {
          letter: lc[1].trim().charAt(0).toUpperCase(),
          categories: parseCategories(lc[2]),
        });
        return;
      }
      var durLc = stLc.duration || 60;
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
      var stLet = getChannelState(channel) || defaultState();
      if (stLet.phase === 'paused' || isPrepPhase(stLet.phase)) {
        patchChannel(channel, { letter: letterOnly[1].trim().charAt(0).toUpperCase() });
        return;
      }
      patchChannel(channel, {
        phase: 'playing',
        letter: letterOnly[1].trim().charAt(0).toUpperCase(),
        roundStartAt: Date.now(),
        duration: stLet.duration || 60,
      });
    }
    var catsOnly = body.match(/(?:📚\s*)?cat[ée]gories(?:\s+actuelles)?\s*:\s*(.+)$/i);
    if (catsOnly && !/par manche|actuelles/i.test(body)) {
      var stCat = getChannelState(channel) || defaultState();
      if (stCat.phase === 'paused' || isPrepPhase(stCat.phase)) {
        patchChannel(channel, { categories: parseCategories(catsOnly[1]) });
        return;
      }
      patchChannel(channel, {
        phase: 'playing',
        categories: parseCategories(catsOnly[1]),
        roundStartAt: Date.now(),
        duration: stCat.duration || 60,
      });
    }
    if (fromBac && /🏆\s*Top\s+\d+/i.test(body)) {
      patchChannel(channel, { topGlobal: [], topLoaded: false });
      return;
    }
    var topRow = body.match(/^\s*(\d+)\.\s+([^\s—\-]+)[^\d]*?(\d+(?:[.,]\d+)?)\s*pts/i);
    if (fromBac && topRow && !/classement\s*:/i.test(body) && !/Partie termin[eé]e/i.test(body)) {
      var stTop = getChannelState(channel) || defaultState();
      var topList = (stTop.topGlobal || []).slice();
      topList.push({ nick: topRow[2], pts: parsePts(topRow[3]), fc: 0 });
      patchChannel(channel, { topGlobal: topList, topLoaded: true });
      refreshDockOverlay();
    }
    if (fromBac) {
      var infoBot = body.match(/!info\s+(\S+)/i);
      if (infoBot && /🔍|d[eé]finition|wikip[eé]dia/i.test(body)) {
        var infoW = infoBot[1].replace(/[.!?,;:]+$/, '').trim();
        if (infoW) {
          var gameInfo = getChannelState(channel) || defaultState();
          var draftInfo = getDraft(channel, gameInfo);
          if (draftInfo.rejected) {
            Object.keys(draftInfo.rejected).forEach(function (k) {
              var entry = draftInfo.rejected[k];
              if (entry && String(entry.word || '').toLowerCase() === infoW.toLowerCase()) {
                entry.suggestInfo = true;
              }
            });
            bumpStore();
          }
        }
      }

      var dur = body.match(/(\d+)\s+secondes/i);
      if (dur && /manche|partie|tour/i.test(body)) {
        patchChannel(channel, { duration: Number(dur[1]) || 60 });
      }
      var left = body.match(/il reste\s+(\d+)\s+secondes/i);
      if (left && (getChannelState(channel) || {}).phase !== 'paused') {
        patchChannel(channel, {
          phase: 'playing',
          countdown: Number(left[1]) || 0,
          countdownAt: Date.now(),
          duration: (getChannelState(channel) || {}).duration || Number(left[1]) || 60,
        });
      }

      var gameSt = getChannelState(channel) || defaultState();

      if (/FIN DE LA PARTIE/i.test(body)) {
        patchChannel(channel, {
          phase: 'game_end',
          letter: '',
          categories: [],
          roundStartAt: 0,
          endNotes: gameSt.endNotes || [],
        });
        return;
      }

      if (/Fin de manche|fin de la manche|🏁\s*Fin de manche/i.test(body) && !/FIN DE LA PARTIE/i.test(body)) {
        patchChannel(channel, { phase: 'round_end', roundStartAt: 0 });
        gameSt = getChannelState(channel) || defaultState();
      }

      if (/Partie termin[eé]e|FIN DE LA PARTIE/i.test(body) && /classement/i.test(body)) {
        var ranked = [];
        var rankRe = /(\d+)\.\s*([^\s·|,]+)\s+(\d+(?:[.,]\d+)?)\s*pts/gi;
        var rm;
        while ((rm = rankRe.exec(body))) {
          ranked.push({ nick: rm[2], pts: parsePts(rm[3]) });
        }
        if (ranked.length) {
          patchChannel(channel, {
            phase: 'game_end',
            finalRanking: ranked,
            scores: scoresFromRanking(ranked),
            letter: '',
            categories: [],
            roundStartAt: 0,
          });
          gameSt = getChannelState(channel) || defaultState();
        }
      }

      if (/fin de la partie|partie termin[eé]e/i.test(body)) {
        patchChannel(channel, {
          phase: 'game_end',
          letter: '',
          categories: [],
          roundStartAt: 0,
        });
        gameSt = getChannelState(channel) || defaultState();
      }

      if (/full\s*combo/i.test(body) || /bonus\s*\+?\s*1\s*point/i.test(body)) {
        var comboNick = '';
        var bravoM = body.match(/bravo\s+([A-Za-z0-9_\[\]\\^{}|`-]+)/i);
        var pourM = body.match(/pour\s+(\S+)/i);
        if (bravoM) comboNick = bravoM[1].replace(/[!.,;:]+$/, '');
        else if (pourM && !/toi|vous/i.test(pourM[1])) comboNick = pourM[1].replace(/[!.,;:]+$/, '');
        applyFullCombo(channel, comboNick, '');
        gameSt = getChannelState(channel) || defaultState();
      }

      var scoreLine = parseScoreLine(body);
      var scorePairs = extractScorePairs(body);
      var isCumul = /scores cumul/i.test(body);
      if (scorePairs.length > 1 || (scoreLine && /classement|scores cumul/i.test(body))) {
        var list = scorePairs.length ? scorePairs : [scoreLine];
        var mergedScores = isCumul ? Object.create(null) : Object.assign({}, gameSt.scores || {});
        list.forEach(function (row) { assignScore(mergedScores, row.nick, row.pts); });
        if (gameSt.phase === 'game_end' || /classement final|Voici le classement|Fin de partie/i.test(body)) {
          patchChannel(channel, {
            phase: 'game_end',
            finalRanking: Object.keys(mergedScores).map(function (nick) {
              return { nick: nick, pts: mergedScores[nick] };
            }).sort(function (a, b) { return b.pts - a.pts; }),
            scores: mergedScores,
          });
        } else {
          patchChannel(channel, { scores: mergedScores });
          gameSt = getChannelState(channel) || defaultState();
        }
      } else if (scoreLine) {
        if (gameSt.phase === 'game_end' || /classement final|Voici le classement/i.test(body)) {
          var finalList = upsertRankingRow(gameSt.finalRanking || [], scoreLine.nick, scoreLine.pts);
          patchChannel(channel, {
            phase: 'game_end',
            finalRanking: finalList,
            scores: scoresFromRanking(finalList),
          });
        } else if (gameSt.phase === 'round_end' || isCumul || /Scores cumul[eé]s/i.test(body)) {
          var cum = isCumul ? Object.create(null) : Object.assign({}, gameSt.scores || {});
          assignScore(cum, scoreLine.nick, scoreLine.pts);
          patchChannel(channel, { scores: cum });
          gameSt = getChannelState(channel) || defaultState();
        } else if (gameSt.phase === 'playing' || gameSt.phase === 'paused') {
          var liveScores = Object.assign({}, gameSt.scores || {});
          assignScore(liveScores, scoreLine.nick, scoreLine.pts);
          patchChannel(channel, { scores: liveScores });
          gameSt = getChannelState(channel) || defaultState();
        }
      }

      var roundRes = body.match(/R[eé]sultat pour\s+(\S+)\s*:\s*(\d+(?:[.,]\d+)?)\s+point/i);
      if (roundRes) {
        var rs = Object.assign({}, gameSt.roundScores || {});
        assignScore(rs, roundRes[1], parsePts(roundRes[2]));
        patchChannel(channel, { phase: 'round_end', roundScores: rs, roundStartAt: 0 });
        gameSt = getChannelState(channel) || defaultState();
      }

      var recLine = parseServerRecord(body);
      if (recLine) {
        patchChannel(channel, { serverRecords: mergeServerRecord(gameSt, recLine) });
        gameSt = getChannelState(channel) || defaultState();
      }

      if (/manche termin[eé]e/i.test(body)) {
        patchChannel(channel, { phase: 'round_end' });
      }
    }

    var st = getChannelState(channel);
    if (st && st.letter && st.categories && st.categories.length
        && st.phase === 'idle') {
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
      fullComboNick: '',
      fullComboRound: '',
      finalRanking: [],
      topGlobal: [],
      serverRecords: [],
      lobbySummary: '',
      lobbyRanking: [],
      lobbyHistory: [],
      endNotes: [],
      starter: '',
      statCard: null,
      livePlayers: {},
      mancheHistory: [],
      vote: null,
      topLoaded: false,
      updatedAt: 0,
    };
  }

  function liveBoardPlayers(game, maxPlayers) {
    var byKey = Object.create(null);
    function addNick(nick) {
      var key = scoreNickKey(nick);
      if (!key) return;
      if (!byKey[key]) byKey[key] = { nick: nick, answers: {}, roundPts: 0 };
    }
    Object.keys((game && game.livePlayers) || {}).forEach(function (k) {
      var p = game.livePlayers[k];
      byKey[k] = {
        nick: p.nick,
        answers: p.answers || {},
        roundPts: p.roundPts || 0,
      };
    });
    Object.keys((game && game.scores) || {}).forEach(addNick);
    Object.keys((game && game.roundScores) || {}).forEach(addNick);
    ((game && game.mancheHistory) || []).forEach(function (h) {
      Object.keys((h && h.scores) || {}).forEach(addNick);
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; })
      .sort(function (a, b) {
        var ta = playerTotalPts(game, a.nick);
        var tb = playerTotalPts(game, b.nick);
        if (tb !== ta) return tb - ta;
        if ((b.roundPts || 0) !== (a.roundPts || 0)) return (b.roundPts || 0) - (a.roundPts || 0);
        return String(a.nick || '').localeCompare(String(b.nick || ''));
      })
      .slice(0, maxPlayers || 14);
  }

  function livePlayerList(game, maxPlayers) {
    return liveBoardPlayers(game, maxPlayers);
  }

  function applyLiveAnswer(channel, nick, cat, word, pts) {
    var key = String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
    var catKey = String(cat || '').toLowerCase();
    if (!key || !catKey) return;
    var game = getChannelState(channel) || defaultState();
    var players = Object.assign({}, game.livePlayers || {});
    var prev = players[key] || { nick: nick, answers: {}, roundPts: 0 };
    var answers = Object.assign({}, prev.answers);
    var already = answers[catKey];
    var nPts = pts > 0 ? pts : 1;
    answers[catKey] = {
      word: word || (already && already.word) || '',
      pts: nPts,
      ia: isIaAward(nPts),
    };
    players[key] = {
      nick: nick || prev.nick,
      answers: answers,
      roundPts: (prev.roundPts || 0) + (already ? 0 : nPts),
    };
    patchChannel(channel, { livePlayers: players });
  }

  function ensureLivePlayer(channel, nick) {
    var key = String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
    if (!key) return;
    var game = getChannelState(channel) || defaultState();
    if (game.livePlayers && game.livePlayers[key]) return;
    var players = Object.assign({}, game.livePlayers || {});
    players[key] = { nick: nick, answers: {}, roundPts: 0 };
    patchChannel(channel, { livePlayers: players });
  }

  function parseValidationLine(plain) {
    var s = String(plain || '');
    if (!/(?:✔️|💎)/.test(s)) return null;
    var nickM = s.match(/^([^:]{1,32}):\s*/);
    if (!nickM) return null;
    var wordM = s.match(/[«"]([^»"]+)[»"]/);
    var catM = s.match(/Cat[ée]gorie\s+(\S+)/i);
    if (!wordM && !catM) return null;
    var ia = /🤖|l['’]IA/i.test(s);
    var ptsM = s.match(/\(\+?\s*(\d+(?:[.,]\d+)?)\s*point/i);
    var pts = ptsM ? parsePts(ptsM[1]) : (ia ? 0.5 : (/💎/.test(s) ? 2 : 1));
    return {
      nick: nickM[1].trim(),
      word: wordM ? wordM[1] : '',
      cat: catM ? catM[1].replace(/[.,;:!?]+$/, '') : '',
      pts: pts,
      ia: ia,
    };
  }

  function buildLiveRecapMarkdown(game) {
    var cats = (game && game.categories) || [];
    if (!cats.length) return '';
    var lines = ['# Petit Bac — Manche ' + (game.round || '?') + ' (' + (game.letter || '?') + ')', ''];
    lines.push('| Joueur | ' + cats.join(' | ') + ' | Manche | Total |');
    lines.push('| --- | ' + cats.map(function () { return '---'; }).join(' | ') + ' | --- | --- |');
    livePlayerList(game, 99).forEach(function (p) {
      var cells = cats.map(function (cat) {
        var a = p.answers[String(cat).toLowerCase()];
        return a ? a.word + ' (+' + a.pts + ')' : '—';
      });
      lines.push('| ' + p.nick + ' | ' + cells.join(' | ') + ' | ' + (p.roundPts || 0) + ' | ' + playerTotalPts(game, p.nick) + ' |');
    });
    return lines.join('\n');
  }

  function isLiveBoardOpen(orbit) {
    try { if (orbit) return orbit.storage.get(STORAGE_LIVE_OPEN, true) !== false; } catch (e) { /* ignore */ }
    return true;
  }

  function setLiveBoardOpen(orbit, open) {
    try { if (orbit) orbit.storage.set(STORAGE_LIVE_OPEN, !!open); } catch (e) { /* ignore */ }
  }

  function playerTotalPts(game, nick) {
    var scores = (game && game.scores) || {};
    var key = findScoreNick(scores, nick);
    if (key) return parsePts(scores[key]);
    var rs = (game && game.roundScores) || {};
    var rk = findScoreNick(rs, nick);
    return rk ? parsePts(rs[rk]) : 0;
  }

  function buildLiveBoardHtml(orbit, game, myNick) {
    var cats = (game && game.categories) || [];
    var open = isLiveBoardOpen(orbit);
    var maxP = pluginOrbit ? cfg(pluginOrbit).maxPlayers : 14;
    var players = liveBoardPlayers(game, maxP);
    var hist = ((game && game.mancheHistory) || []).slice().sort(function (a, b) {
      return Number(a.round) - Number(b.round);
    });
    var head = '<div class="opbac-live__head">' +
      '<span class="opbac-live__title">📊 ' + escHtml(pick({ fr: 'Tableau live', en: 'Live board' })) + '</span>' +
      '<button type="button" class="opbac-live__tog" data-act="live-toggle">' + (open ? '▴' : '▾') + '</button></div>';
    if (!open) return '<section class="opbac-live opbac-live--collapsed" data-opbac-live>' + head + '</section>';
    var histHead = hist.map(function (h) {
      return '<th>M' + escHtml(String(h.round)) + '</th>';
    }).join('');
    var headCats = cats.map(function (cat) { return '<th>' + escHtml(cat) + '</th>'; }).join('');
    var rows = players.map(function (p) {
      var isMe = myNick && String(p.nick).toLowerCase() === String(myNick).toLowerCase();
      var filled = cats.filter(function (c) { return p.answers[String(c).toLowerCase()]; }).length;
      var combo = filled >= cats.length && cats.length > 0;
      var histCells = hist.map(function (h) {
        var key = findScoreNick(h.scores || {}, p.nick);
        var pts = key ? parsePts(h.scores[key]) : 0;
        return '<td class="opbac-live__pts">' + (pts ? ptsHtml(pts) : '—') + '</td>';
      }).join('');
      var cells = cats.map(function (cat) {
        var a = p.answers[String(cat).toLowerCase()];
        if (!a) return '<td class="opbac-live__empty">—</td>';
        var cls = a.pts > 1
          ? 'opbac-live__cell opbac-live__cell--bonus'
          : (a.ia || isIaAward(a.pts) ? 'opbac-live__cell opbac-live__cell--ia' : 'opbac-live__cell');
        var ptsLbl = '+' + formatPtsShort(a.pts);
        return '<td class="' + cls + '" title="' + escHtml(ptsLbl + (a.ia || isIaAward(a.pts) ? ' IA' : '')) + '">' +
          (a.ia || isIaAward(a.pts) ? '🤖 ' : '') +
          escHtml(a.word) + '<small class="opbac-live__cell-pts">' + ptsLbl + '</small></td>';
      }).join('');
      var total = playerTotalPts(game, p.nick);
      return '<tr class="' + (isMe ? 'opbac-live__me' : '') + (combo ? ' opbac-live__combo' : '') + '">' +
        '<td class="opbac-live__nick">' + escHtml(p.nick) + '</td>' + histCells + cells +
        '<td class="opbac-live__pts">' + ptsHtml(p.roundPts || 0) + '</td>' +
        '<td class="opbac-live__pts opbac-live__pts--total">' + ptsHtml(total) + '</td></tr>';
    }).join('');
    var colCount = Math.max(cats.length, 0) + hist.length + 3;
    return '<section class="opbac-live" data-opbac-live>' + head +
      '<div class="opbac-live__wrap"><table class="opbac-live__grid"><thead><tr>' +
        '<th class="opbac-live__nick">' + escHtml(pick({ fr: 'Joueur', en: 'Player' })) + '</th>' +
        histHead +
        headCats +
        '<th>' + escHtml(pick({ fr: 'Manche', en: 'Round' })) + '</th>' +
        '<th>' + escHtml(pick({ fr: 'Total', en: 'Total' })) + '</th>' +
      '</tr></thead><tbody>' + (rows || ('<tr><td colspan="' + colCount +
        '" class="opbac-live__empty">' + escHtml(pick({
          fr: 'En attente des premières validations…',
          en: 'Waiting for the first answers…',
        })) + '</td></tr>')) + '</tbody></table></div>' +
      '<div class="opbac-live__foot"><button type="button" class="opbac-live__copy" data-act="live-copy">' +
        escHtml(pick({ fr: 'Copier le récap', en: 'Copy recap' })) + '</button></div></section>';
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
    if (typeof pairs === 'string') {
      var parsed = safeJson(pairs, null);
      if (parsed) pairs = parsed;
      else {
        return String(pairs).split(',').map(function (chunk) {
          var parts = String(chunk || '').split(':');
          if (parts.length < 2) return null;
          var pts = parsePts(parts.pop());
          var nick = parts.join(':').trim();
          if (!nick) return null;
          return { nick: nick, pts: pts };
        }).filter(Boolean);
      }
    }
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
      var rootStart = document.getElementById('opbac-dom-panel');
      if (rootStart && pluginOrbit) setViewMode(pluginOrbit, rootStart, VIEW_FULL);
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
        fullComboNick: '',
        fullComboRound: '',
        countdown: 0,
        finalRanking: [],
        endNotes: [],
        serverRecords: [],
        livePlayers: {},
        mancheHistory: [],
        vote: null,
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
        fullComboNick: '',
        fullComboRound: '',
        livePlayers: {},
      });
      return;
    }

    if (ev === 'round_countdown') {
      var curCd = getChannelState(channel);
      if (curCd && curCd.phase === 'paused') return;
      patchChannel(channel, {
        phase: 'playing',
        countdown: Number(tagVal(tags, '+seconds')) || 0,
        countdownAt: Date.now(),
      });
      return;
    }

    if (ev === 'round_tick') {
      var curTick = getChannelState(channel);
      if (curTick && curTick.phase === 'paused') return;
      patchChannel(channel, {
        phase: 'playing',
        countdown: Number(tagVal(tags, '+seconds_left')) || 0,
        countdownAt: Date.now(),
      });
      return;
    }

    if (ev === 'game_pause') {
      var leftPause = Number(tagVal(tags, '+seconds_left'));
      if (!(leftPause >= 0)) {
        var tPause = computeRemaining(getChannelState(channel) || defaultState());
        leftPause = tPause.remaining;
      }
      patchChannel(channel, {
        phase: 'paused',
        countdown: leftPause,
        countdownAt: Date.now(),
        roundStartAt: 0,
        pausedBy: tagVal(tags, '+by'),
      });
      return;
    }

    if (ev === 'game_resume') {
      var leftRes = Number(tagVal(tags, '+seconds_left'));
      var prevRes = getChannelState(channel) || defaultState();
      var durRes = prevRes.duration || 60;
      if (!(leftRes >= 0)) leftRes = prevRes.countdown || durRes;
      patchChannel(channel, {
        phase: 'playing',
        countdown: leftRes,
        countdownAt: Date.now(),
        roundStartAt: Date.now() - Math.max(0, (durRes - leftRes) * 1000),
      });
      return;
    }

    if (ev === 'vote_start') {
      patchChannel(channel, {
        vote: {
          kind: tagVal(tags, '+kind') || 'mode',
          text: tagVal(tags, '+text') || pick({ fr: 'Un vote est en cours', en: 'A vote is in progress' }),
          mode: tagVal(tags, '+mode'),
          until: Date.now() + (Number(tagVal(tags, '+seconds')) || 30) * 1000,
        },
      });
      return;
    }

    if (ev === 'vote_end') {
      patchChannel(channel, { vote: null });
      return;
    }

    if (ev === 'state_sync') {
      var catsS = tagVal(tags, '+categories');
      var durS = Number(tagVal(tags, '+duration')) || ((getChannelState(channel) || {}).duration) || 60;
      var leftS = Number(tagVal(tags, '+seconds_left'));
      if (!(leftS >= 0)) leftS = durS;
      var letterS = tagVal(tags, '+letter');
      var prevS = getChannelState(channel) || defaultState();
      var syncPhase = tagVal(tags, '+phase');
      if (!syncPhase) {
        syncPhase = tagVal(tags, '+paused') === '1' ? 'paused' : (letterS ? 'playing' : 'starting');
      }
      if (isPrepPhase(prevS.phase) && syncPhase !== 'paused' && prevS.phase !== 'go') {
        patchChannel(channel, {
          phase: prevS.phase,
          duration: durS || prevS.duration,
          totalRounds: Number(tagVal(tags, '+max_rounds')) || prevS.totalRounds || 0,
          mode: tagVal(tags, '+mode') || prevS.mode || '',
        });
        return;
      }
      patchChannel(channel, {
        phase: syncPhase,
        round: Number(tagVal(tags, '+round')) || 0,
        letter: letterS,
        categories: catsS ? catsS.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        duration: durS,
        totalRounds: Number(tagVal(tags, '+max_rounds')) || prevS.totalRounds || 0,
        mode: tagVal(tags, '+mode') || prevS.mode || '',
        countdown: leftS,
        countdownAt: Date.now(),
        roundStartAt: syncPhase === 'paused' ? 0 : (Date.now() - Math.max(0, (durS - leftS) * 1000)),
      });
      return;
    }

    if (ev === 'word_ok') {
      var gameOk = getChannelState(channel) || defaultState();
      var catOk = matchCatKey(gameOk, tagVal(tags, '+category'));
      var nickOk = tagVal(tags, '+nick') || tagVal(tags, '+player');
      var wordOk = tagVal(tags, '+word');
      var ptsOk = parsePts(tagVal(tags, '+points'));
      applyLiveAnswer(channel, nickOk, catOk || tagVal(tags, '+category'), wordOk, ptsOk);
      gameOk = getChannelState(channel) || gameOk;
      var mineOk = isMyNick(nickOk);
      if (catOk && mineOk) {
        var draftOk = getDraft(channel, gameOk);
        markCatValidated(draftOk, catOk, ptsOk, isIaAward(ptsOk));
        showScoreBurst(ptsOk || 1, isIaAward(ptsOk) ? 'ia' : '');
        if (isIaAward(ptsOk) && pluginOrbit) {
          try {
            pluginOrbit.notify('Petit Bac', pick({
              fr: '« ' + (wordOk || '') + ' » reconnu par l’IA — +0,5 pt',
              en: '« ' + (wordOk || '') + ' » recognized by AI — +0.5 pt',
            }));
          } catch (eOk) { /* ignore */ }
        }
      }
      if (nickOk && ptsOk > 0) {
        var scoresOk = Object.assign({}, gameOk.scores || {});
        var rsOk = Object.assign({}, gameOk.roundScores || {});
        addScore(scoresOk, nickOk, ptsOk);
        addScore(rsOk, nickOk, ptsOk);
        patchChannel(channel, { scores: scoresOk, roundScores: rsOk });
      } else {
        bumpStore();
      }
      return;
    }

    if (ev === 'word_ko') {
      var gameKo = getChannelState(channel) || defaultState();
      var koReason = tagVal(tags, '+reason') || 'invalid';
      var koWord = tagVal(tags, '+word');
      var koCat = matchCatKey(gameKo, tagVal(tags, '+category'));
      var nickKo = tagVal(tags, '+nick') || tagVal(tags, '+player');
      if (nickKo && !isMyNick(nickKo)) return;
      markRejected(
        channel,
        koCat,
        koWord,
        rejectMessageForCode(koReason, koWord),
        { code: koReason, suggestInfo: shouldSuggestInfo(koReason, '') }
      );
      return;
    }

    if (ev === 'full_combo') {
      applyFullCombo(channel, tagVal(tags, '+nick') || tagVal(tags, '+player'), tagVal(tags, '+score'));
      return;
    }

    if (ev === 'round_end') {
      var rs = parseScoreMap(tagVal(tags, '+round_scores'));
      var prevRound = getChannelState(channel) || defaultState();
      var prevS = prevRound.scores || {};
      var merged = Object.assign({}, prevS);
      if (!Object.keys(prevS).length) {
        Object.keys(rs).forEach(function (nick) {
          assignScore(merged, nick, parsePts(rs[nick]));
        });
      }
      var rndN = Number(tagVal(tags, '+round')) || prevRound.round || 0;
      var hist = (prevRound.mancheHistory || []).slice();
      if (!hist.some(function (h) { return Number(h.round) === rndN; })) {
        hist.push({ round: rndN, scores: rs });
      }
      patchChannel(channel, {
        phase: 'round_end',
        round: rndN,
        roundScores: rs,
        scores: merged,
        mancheHistory: hist,
        roundStartAt: 0,
      });
      return;
    }

    if (ev === 'game_end') {
      var rankingRaw = tagVal(tags, '+final_ranking') || tagVal(tags, '+ranking');
      var ranking = rankingFromPairs(rankingRaw);
      var topGlobal = rankingFromPairs(safeJson(tagVal(tags, '+top_global'), []));
      var endPatch = {
        phase: 'game_end',
        finalRanking: ranking,
        roundStartAt: 0,
        letter: '',
        categories: [],
        scores: scoresFromRanking(ranking),
      };
      if (topGlobal.length) endPatch.topGlobal = topGlobal;
      patchChannel(channel, endPatch);
      return;
    }

    if (ev === 'server_records') {
      var recs = recordsFromTags(tags);
      if (recs.length) {
        var prevRec = getChannelState(channel) || defaultState();
        var mergedRec = prevRec.serverRecords || [];
        recs.forEach(function (r) {
          mergedRec = mergeServerRecord({ serverRecords: mergedRec }, r);
        });
        patchChannel(channel, { serverRecords: mergedRec });
      }
      return;
    }

    if (ev === 'game_stop' || ev === 'stopped') {
      stopGameUi(channel, tagVal(tags, '+reason') || 'op');
      return;
    }

    if (ev === 'modes_list') {
      applyModesList(tags);
      return;
    }
    if (ev === 'lobby_stats') {
      applyLobbyStats(channel, tags);
      return;
    }
    if (ev === 'lobby_hist') {
      applyLobbyHist(channel, tags);
      return;
    }
    if (ev === 'info_result') {
      applyInfoResult(channel, tags);
      return;
    }
    if (ev === 'stat_result') {
      applyStatResult(channel, tags);
      return;
    }
    if (ev === 'top_result') {
      applyTopResult(channel, tags);
      return;
    }
    if (ev === 'mode_created') {
      pendingCreate = false;
      listeAt = 0;
      markModeCreated(tagVal(tags, '+mode'));
      var bufCreated = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
        ? pluginOrbit.state.active()
        : '';
      if (bufCreated) requestModeList(pluginOrbit, bufCreated, true);
      return;
    }
    if (ev === 'feedback_ok') {
      applyFeedbackResult(true, tagVal(tags, '+kind') || tagVal(tags, '+name'), 'ok');
      return;
    }
    if (ev === 'cmd_err') {
      var errName = tagVal(tags, '+name');
      var errText = tagVal(tags, '+text');
      if (errName === 'manche' && errText === 'idle') return;
      if (errName === 'bug' || errName === 'suggestion') {
        applyFeedbackResult(false, errName, errText);
        return;
      }
      try {
        if (pluginOrbit) {
          pluginOrbit.notify('Petit Bac', pick({
            fr: errText === 'unknown'
              ? 'Commande inconnue.'
              : ('Erreur : ' + (errText || errName || 'commande')),
            en: errText === 'unknown'
              ? 'Unknown command.'
              : ('Error: ' + (errText || errName || 'command')),
          }));
        }
      } catch (e) { /* ignore */ }
      return;
    }
    if (ev === 'verify_pending' || ev === 'verify_ok' || ev === 'verify_ko') {
      var vWord = tagVal(tags, '+word');
      var vCat = matchCatKey(getChannelState(channel) || defaultState(), tagVal(tags, '+category'));
      if (ev === 'verify_ko') {
        markRejected(channel, vCat, vWord, rejectMessageForCode(tagVal(tags, '+reason') || 'not_found', vWord), {
          code: tagVal(tags, '+reason') || 'not_found',
          suggestInfo: true,
        });
      } else if (ev === 'verify_ok') {
        markRejected(channel, vCat, vWord, pick({
          fr: 'Ce mot existe déjà dans le dictionnaire — pas besoin de le reproposer.',
          en: 'This word is already in the dictionary — no need to resubmit.',
        }), { code: 'exists' });
      }
      return;
    }
  }

  function injectStyles() {
    var prev = document.getElementById('orbit-petitbac-css');
    if (prev) prev.remove();
    var el = document.createElement('style');
    el.id = 'orbit-petitbac-css';
    el.textContent = [
      '.opbac-panel{position:relative;flex:0 0 auto;width:100%;z-index:20;--opbac-h:360px;border-bottom:1px solid color-mix(in srgb,var(--accent,#6366f1) 18%,var(--border,#ddd));background:var(--bg,#fff);font-family:var(--font,system-ui,sans-serif)}',
      '.opbac-panel .opbac-body{height:var(--opbac-h);max-height:var(--opbac-h);overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}',
      '.opbac-panel--playing .opbac-body{display:flex;flex-direction:column}',
      '.opbac-panel--chat .opbac-body{display:none!important;height:auto;max-height:none}',
      '.opbac-panel--chat .opbac-resize{display:none}',
      '.opbac-panel--full .opbac-resize{display:none}',
      '.opbac-panel--full{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-bottom:0}',
      '.opbac-panel--full .opbac-body,.opbac-panel--split .opbac-body{display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;flex:1 1 auto;height:auto!important;max-height:none!important}',
      '.opbac-panel--full .opbac-body>*,.opbac-panel--split .opbac-body>*{width:100%;max-width:none;margin-left:0;margin-right:0}',
      '.opbac-panel--full .opbac-scroll,.opbac-panel--split .opbac-scroll{width:100%;flex:1 1 auto}',
      'body.opbac-full .chan-hero,body.opbac-full .messages,body.opbac-full .composer,body.opbac-full .main__room-bg{display:none!important}',
      '@media(min-width:1000px){body.opbac-split .main{display:grid!important;grid-template-columns:minmax(28rem,1.25fr) minmax(16rem,.75fr);grid-template-rows:auto auto 1fr auto;align-items:stretch}body.opbac-split .topbar{grid-column:1/-1;grid-row:1}body.opbac-split .main__room-bg{grid-column:2;grid-row:2/4;height:auto!important}body.opbac-split #opbac-dom-panel{grid-column:1;grid-row:2/-1;min-height:0;height:auto!important;max-height:none!important;display:flex;flex-direction:column;border-bottom:0;border-right:1px solid color-mix(in srgb,#6366f1 18%,var(--border,#ddd))}body.opbac-split .chan-hero{grid-column:2;grid-row:2}body.opbac-split .messages{grid-column:2;grid-row:3;min-height:0;overflow-anchor:none}body.opbac-split .composer{grid-column:2;grid-row:4}body.opbac-split .main>:not(.topbar):not(#opbac-dom-panel):not(.main__room-bg):not(.chan-hero):not(.messages):not(.composer){grid-column:2}body.opbac-split .opbac-resize{display:none!important}}',
      '.opbac-dock{display:none;flex-wrap:wrap;align-items:center;justify-content:center;gap:.4rem;padding:.55rem .7rem .75rem;border-top:1px solid color-mix(in srgb,#6366f1 16%,var(--border,#e5e5e5));background:color-mix(in srgb,#6366f1 5%,var(--bg,#fff));flex:0 0 auto}',
      '.opbac-dock__btn{border:0;border-radius:999px;padding:.42rem .8rem;font-size:.76rem;font-weight:800;cursor:pointer;min-height:36px;background:var(--bg,#fff);color:var(--ink,#222);border:1px solid color-mix(in srgb,#6366f1 22%,var(--border,#ddd));box-shadow:0 1px 2px rgba(15,23,42,.06)}',
      '.opbac-dock__btn:hover{border-color:#6366f1;color:#4338ca}',
      '.opbac-dock__btn--yes{background:#16a34a;color:#fff;border-color:#16a34a}',
      '.opbac-dock__btn--no{background:#dc2626;color:#fff;border-color:#dc2626}',
      '.opbac-dock__btn--op{background:#fff7ed;color:#c2410c;border-color:#fdba74}',
      '@media(min-width:880px){.opbac-panel--full .opbac-dock,.opbac-panel--split .opbac-dock{display:flex}}',
      '.opbac-dock-stat{margin:0 0 .45rem;font-size:.88rem;line-height:1.45}',
      '.opbac-live{width:100%;margin:.15rem 0 0;border-top:1px solid color-mix(in srgb,#6366f1 16%,var(--border,#e5e5e5));background:color-mix(in srgb,#6366f1 4%,var(--bg,#fff));flex:0 1 auto;min-height:8.5rem;max-height:min(42vh,18rem);display:flex;flex-direction:column}',
      '.opbac-live__head{display:flex;align-items:center;gap:.45rem;padding:.4rem .75rem}',
      '.opbac-live__title{font-weight:800;font-size:.78rem;flex:1}',
      '.opbac-live__tog{border:0;background:var(--bg-soft,rgba(127,127,127,.12));width:28px;height:28px;border-radius:7px;cursor:pointer}',
      '.opbac-live--collapsed{flex:0 0 auto;min-height:0;max-height:none}',
      '.opbac-live__wrap{overflow:auto;padding:0 .65rem .45rem;min-height:5.5rem;flex:1 1 auto}',
      '.opbac-live__grid{width:100%;border-collapse:collapse;font-size:.74rem}',
      '.opbac-live__grid th,.opbac-live__grid td{border:1px solid var(--border,#ddd);padding:.32rem .4rem;text-align:center}',
      '.opbac-live__grid th{background:var(--bg-soft,rgba(127,127,127,.08));font-weight:800}',
      '.opbac-live__nick{text-align:left!important;min-width:5rem;max-width:7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.opbac-live__cell{background:color-mix(in srgb,#22c55e 16%,transparent);font-weight:700}',
      '.opbac-live__cell--bonus{background:color-mix(in srgb,#f59e0b 22%,transparent);font-weight:800}',
      '.opbac-live__cell--ia{background:color-mix(in srgb,#06b6d4 20%,transparent);font-weight:800}',
      '.opbac-live__empty{color:var(--muted,#999)}',
      '.opbac-live__cell-pts{display:block;font-size:.62rem;font-weight:800;opacity:.8}',
      '.opbac-live__pts{font-weight:800;color:#4f46e5;font-variant-numeric:tabular-nums}',
      '.opbac-live__pts--total{color:#166534}',
      '.opbac-live__me td.opbac-live__nick{font-weight:800;color:#6366f1}',
      '.opbac-live__combo td.opbac-live__nick::after{content:" 🔥"}',
      '.opbac-live__foot{padding:.35rem .65rem .55rem}',
      '.opbac-live__copy{border:0;border-radius:8px;padding:.38rem .6rem;font-size:.72rem;font-weight:800;cursor:pointer;background:var(--bg-soft,rgba(127,127,127,.12))}',
      '.opbac-panel--split .opbac-resize{display:block}',
      '.opbac-resize{height:12px;flex:none;cursor:ns-resize;touch-action:none;user-select:none;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--accent,#6366f1) 12%,var(--border,#ddd)));border-top:1px solid color-mix(in srgb,var(--accent,#6366f1) 15%,var(--border,#ddd))}',
      '.opbac-resize::after{content:"";display:block;width:2.6rem;height:4px;margin:.28rem auto 0;border-radius:999px;background:color-mix(in srgb,var(--muted,#888) 45%,transparent)}',
      '.opbac-resize:hover,.opbac-resize:active{background:color-mix(in srgb,var(--accent,#6366f1) 18%,var(--border,#ddd))}',
      '.opbac-head{display:flex;align-items:center;flex-wrap:nowrap;gap:.5rem;padding:.45rem .75rem;background:linear-gradient(135deg,#4338ca,#6d28d9);color:#fff;overflow:visible;position:relative;z-index:30}',
      '.opbac-head__brand{flex:1;min-width:0;display:flex;align-items:center;flex-wrap:nowrap;gap:.35rem .5rem;overflow:visible}',
      '.opbac-head__logo{width:28px;height:28px;border-radius:8px;flex-shrink:0;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,.15)}',
      '.opbac-head__title{font-weight:800;font-size:.88rem;letter-spacing:.01em;white-space:nowrap}',
      '.opbac-head__title-short{display:none}',
      '.opbac-head__badge{display:inline-flex;align-items:center;font-size:.68rem;font-weight:800;padding:.18rem .65rem;border-radius:999px;background:rgba(255,255,255,.18);white-space:nowrap;flex:0 0 auto;width:auto;max-width:none;overflow:visible;line-height:1.2}',
      '.opbac-head__badge:empty{display:none}',
      '.opbac-head__badge--mode{background:rgba(255,255,255,.28);border:0;color:#fff;cursor:pointer;gap:.2rem;font:inherit}',
      '.opbac-head__badge--mode:hover{background:rgba(255,255,255,.4)}',
      '.opbac-head__mode{position:relative;flex:0 0 auto}',
      '.opbac-head__caret{font-size:.62rem;opacity:.85}',
      '.opbac-mode-dd{position:absolute;top:calc(100% + 6px);left:0;z-index:50;min-width:15.5rem;max-width:min(22rem,92vw);max-height:min(18rem,52vh);overflow:auto;padding:.35rem;border-radius:12px;background:var(--bg,#fff);color:var(--ink,#111);border:1px solid color-mix(in srgb,#6366f1 22%,var(--border,#ddd));box-shadow:0 18px 40px -16px rgba(15,23,42,.5)}',
      '.opbac-mode-dd[hidden]{display:none}',
      '.opbac-mode-dd__h{margin:.2rem .4rem .2rem;font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666)}',
      '.opbac-mode-dd__item{display:flex;flex-direction:column;align-items:flex-start;gap:.08rem;width:100%;text-align:left;border:0;border-radius:9px;padding:.4rem .5rem;background:transparent;cursor:pointer;font:inherit;color:inherit}',
      '.opbac-mode-dd__item:hover{background:color-mix(in srgb,#6366f1 10%,transparent)}',
      '.opbac-mode-dd__item--on{background:color-mix(in srgb,#6366f1 14%,transparent)}',
      '.opbac-mode-dd__name{font-size:.78rem;font-weight:800}',
      '.opbac-mode-dd__hint{font-size:.62rem;font-weight:700;color:var(--muted,#666)}',
      '.opbac-mode-dd__note{margin:.35rem .4rem .2rem;font-size:.66rem;font-weight:600;color:var(--muted,#666);line-height:1.35}',
      '.opbac-head__actions{display:flex;align-items:center;gap:.3rem}',
      '.opbac-head__btn{border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:36px;border-radius:9px;cursor:pointer;font-size:.82rem;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}',
      '.opbac-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.opbac-head__btn--on{background:rgba(255,255,255,.32)}',
      '.opbac-head__btn svg{width:18px;height:18px;display:block}',
      '.opbac-head__cta-wrap{display:contents}',
      '.opbac-head__cta{display:none;align-items:center;justify-content:center;border:0;border-radius:999px;padding:.42rem .9rem;font-size:.78rem;font-weight:900;cursor:pointer;background:#fff;color:#4338ca;min-height:36px;white-space:nowrap;line-height:1.1}',
      '.opbac-head__cta:hover{filter:brightness(.96)}',
      '.opbac-head__cta--join{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff}',
      '.opbac-panel--chat .opbac-head__cta{display:inline-flex}',
      '.opbac-panel--chat .opbac-head__btn[data-act="play-menu"]{display:none}',
      '.opbac-body{padding:0}',
      '.opbac-arena{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start;justify-items:center;gap:.75rem 1rem;min-height:9rem;padding:.9rem .9rem .75rem;background:linear-gradient(180deg,color-mix(in srgb,#6366f1 5%,var(--bg,#fff)),var(--bg,#fff));background-image:url(/app/plugins/third/orbit-petitbac/assets/arena-pattern.svg),linear-gradient(180deg,color-mix(in srgb,#6366f1 5%,var(--bg,#fff)),var(--bg,#fff));background-repeat:no-repeat;background-position:center;background-size:cover;flex:0 0 auto}',
      '.opbac-pause-banner{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:.15rem;padding:.45rem .8rem;border-radius:12px;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;text-align:center;width:100%;max-width:none;box-sizing:border-box}',
      '.opbac-pause-banner strong{font-size:.92rem}',
      '.opbac-pause-banner span{font-size:.72rem;font-weight:700}',
      '.opbac-arena__letter,.opbac-arena__clock,.opbac-arena__scores-wrap{position:static;transform:none;z-index:1;width:100%;max-width:none;min-height:8.4rem;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:.35rem}',
      '.opbac-arena__block{display:flex;flex-direction:column;align-items:center;gap:.35rem}',
      '.opbac-arena__scores{position:static;transform:none;z-index:2;width:100%;min-width:0;min-height:4.6rem;padding:.45rem .55rem;border-radius:12px;background:color-mix(in srgb,var(--bg,#fff) 88%,#6366f1);border:1px solid color-mix(in srgb,#6366f1 18%,var(--border,#e5e5e5));max-height:7.2rem;overflow-y:auto;overflow-x:hidden}',
      '.opbac-arena__scores-h{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#888);margin:0 0 .3rem;display:flex;align-items:center;gap:.3rem}',
      '.opbac-arena__scores-h::before{content:"";display:inline-block;width:1rem;height:1rem;background:url(/app/plugins/third/orbit-petitbac/assets/trophy.svg) center/contain no-repeat;opacity:.85}',
      '.opbac-arena__scores-row{display:flex;justify-content:space-between;align-items:center;gap:.4rem;font-size:.78rem;line-height:1.35;font-weight:700}',
      '.opbac-arena__scores-nick{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:.25rem}',
      '.opbac-arena__scores-rank{flex-shrink:0;font-size:.85rem;line-height:1}',
      '.opbac-arena__scores-pts{font-variant-numeric:tabular-nums;color:#4f46e5;flex-shrink:0;font-weight:800;white-space:nowrap}',
      '.opbac-arena__scores-empty{margin:0;font-size:.72rem;color:var(--muted,#888);font-weight:600}',
      '@media(max-width:720px){.opbac-arena{grid-template-columns:1fr 1fr;min-height:0;padding:.7rem .7rem .55rem}.opbac-arena__scores-wrap{display:none!important}.opbac-live{min-height:7.5rem;max-height:min(36vh,14rem)}.opbac-head{padding:.28rem .4rem;gap:.28rem}.opbac-head__brand{flex-wrap:nowrap;gap:.28rem}.opbac-head__title-full{display:none}.opbac-head__title-short{display:inline}.opbac-head__title{font-size:.82rem}.opbac-head__badge:not(.opbac-head__badge--mode){display:none}.opbac-head__caret{display:none}.opbac-head__badge--mode{padding:.18rem .36rem;min-width:32px;min-height:32px;justify-content:center}.opbac-head__logo{width:22px;height:22px;border-radius:6px}.opbac-head__actions{gap:.16rem;flex-shrink:0}.opbac-head__btn{min-width:30px;min-height:30px;border-radius:8px}.opbac-head__btn svg{width:15px;height:15px}}',
      '.opbac-arena__lbl{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted,#888)}',
      '.opbac-arena__round{font-size:.68rem;font-weight:800;padding:.12rem .5rem;border-radius:999px;background:color-mix(in srgb,#6366f1 14%,transparent);color:#4338ca;letter-spacing:.02em}',
      '.opbac-letter-xl{width:clamp(72px,18vw,96px);height:clamp(72px,18vw,96px);border-radius:50%;display:grid;place-items:center;font-size:clamp(2.4rem,9vw,3.6rem);font-weight:900;color:#fff;background:linear-gradient(145deg,#fb923c,#ea580c);box-shadow:0 8px 24px -8px rgba(234,88,12,.45)}',
      '.opbac-clock{position:relative;isolation:isolate;overflow:hidden;width:clamp(72px,18vw,96px);height:clamp(72px,18vw,96px);flex-shrink:0}',
      '.opbac-clock__ring{width:100%;height:100%;transform:rotate(-90deg)}',
      '.opbac-clock__track{fill:none;stroke:color-mix(in srgb,var(--muted,#888) 20%,transparent);stroke-width:5}',
      '.opbac-clock__prog{fill:none;stroke:#22c55e;stroke-width:5;stroke-linecap:round;transition:stroke-dashoffset .35s linear}',
      '.opbac-clock--warn .opbac-clock__prog{stroke:#f59e0b}',
      '.opbac-clock--urgent .opbac-clock__prog{stroke:#ef4444}',
      '.opbac-clock--paused .opbac-clock__prog{stroke:#f59e0b;transition:none}',
      '.opbac-clock--paused .opbac-clock__n{color:#c2410c}',
      '.opbac-clock__n{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(1.75rem,6vw,2.6rem);font-weight:900;font-variant-numeric:tabular-nums;color:var(--ink,#111);line-height:1}',
      '.opbac-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:.5rem .75rem .65rem}',
      '.opbac-vote{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.45rem;padding:.55rem .75rem;background:color-mix(in srgb,#f59e0b 12%,var(--bg,#fff));border-bottom:1px solid color-mix(in srgb,#f59e0b 30%,var(--border,#ddd))}',
      '.opbac-vote__txt{flex:1 1 12rem;font-size:.8rem;font-weight:700;color:var(--ink,#222);text-align:center}',
      '.opbac-vote__btn{border:0;border-radius:999px;padding:.45rem .9rem;font-size:.82rem;font-weight:900;cursor:pointer;min-height:38px}',
      '.opbac-vote__btn--yes{background:#16a34a;color:#fff}',
      '.opbac-vote__btn--no{background:#dc2626;color:#fff}',
      '.opbac-panel--full:not(.opbac-panel--playing):not(.opbac-panel--round-end):not(.opbac-panel--game-end) .opbac-body,.opbac-panel--split:not(.opbac-panel--playing):not(.opbac-panel--round-end):not(.opbac-panel--game-end) .opbac-body{overflow:hidden;min-height:0}',
      '.opbac-idle{display:flex;flex-direction:column;align-items:stretch;gap:.35rem;padding:.4rem .65rem .4rem;text-align:center;min-height:0;flex:1 1 auto;overflow:hidden;box-sizing:border-box;height:100%}',
      '.opbac-idle__art{display:none}',
      '.opbac-idle__txt{display:none}',
      '.opbac-idle__launch{display:flex;flex-direction:column;align-items:center;gap:.28rem;margin:0;flex:0 0 auto}',
      '.opbac-idle__cta{display:flex;width:100%;max-width:28rem;align-items:center;justify-content:center;gap:.4rem;border:0;border-radius:999px;padding:.7rem 1.1rem;font-size:1rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;min-height:46px;box-shadow:0 10px 24px -10px rgba(99,102,241,.65)}',
      '.opbac-idle__cta:hover{filter:brightness(1.06)}',
      '.opbac-idle__launch .opbac-skip-rules{margin:0 auto;max-width:28rem;padding:.32rem .5rem;font-size:.72rem}',
      '.opbac-idle__help{margin-top:0;border:0;background:none;color:var(--accent,#6366f1);font-size:.78rem;font-weight:700;cursor:pointer;text-decoration:underline}',
      '.opbac-idle__stopped{margin:0 auto;max-width:26rem;padding:.32rem .6rem;border-radius:10px;font-size:.76rem;font-weight:800;color:#9a3412;background:color-mix(in srgb,#f97316 12%,var(--bg,#fff));border:1px solid color-mix(in srgb,#f97316 28%,var(--border,#ddd));flex:0 0 auto}',
      '.opbac-offline{padding:1.15rem .95rem 1.25rem;text-align:center}',
      '.opbac-offline__art{width:min(200px,70vw);height:auto;margin:0 auto .7rem;display:block;border-radius:14px;opacity:.88}',
      '.opbac-offline__title{margin:0 0 .4rem;font-size:1.05rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-offline__txt{margin:0 auto;max-width:26rem;font-size:.88rem;line-height:1.45;color:var(--muted,#666)}',
      '.opbac-offline__badge{display:inline-flex;align-items:center;gap:.35rem;margin:.75rem 0 .15rem;padding:.28rem .7rem;border-radius:999px;font-size:.72rem;font-weight:800;background:color-mix(in srgb,#ef4444 12%,var(--bg,#fff));color:#b91c1c;border:1px solid color-mix(in srgb,#ef4444 28%,var(--border,#ddd))}',
      '.opbac-offline__wait{display:inline-flex;align-items:center;gap:.45rem;margin-top:.75rem;font-size:.82rem;font-weight:700;color:var(--muted,#666)}',
      '.opbac-head__badge--off{background:rgba(239,68,68,.85)!important}',
      '.opbac-prep{padding:1rem .85rem 1.15rem;text-align:center}',
      '.opbac-prep__logo{width:56px;height:56px;margin:0 auto .55rem;display:block;border-radius:14px;box-shadow:0 6px 18px -8px rgba(99,102,241,.4)}',
      '.opbac-prep__title{margin:0;font-size:1rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-prep__detail{margin:.35rem 0 .65rem;font-size:.78rem;font-weight:700;color:var(--muted,#666)}',
      '.opbac-prep__msg{margin:.45rem 0 0;font-size:.86rem;color:var(--muted,#666)}',
      '.opbac-prep__spin{display:block;margin:.35rem auto 0}',
      '.opbac-prep__cd{margin:.35rem auto 0;width:4.5rem;height:4.5rem;border-radius:50%;display:grid;place-items:center;font-size:2.4rem;font-weight:900;color:#fff;background:linear-gradient(145deg,#6366f1,#8b5cf6);box-shadow:0 8px 24px -8px rgba(99,102,241,.45)}',
      '.opbac-prep__letter{margin:.65rem auto 0;width:3.5rem;height:3.5rem;border-radius:50%;display:grid;place-items:center;font-size:2rem;font-weight:900;color:#fff;background:linear-gradient(145deg,#fb923c,#ea580c)}',
      '.opbac-prep__cats{margin:.45rem 0 0;font-size:.78rem;font-weight:700;color:var(--muted,#666);text-transform:capitalize}',
      '.opbac-prep__bar{margin:.85rem auto 0;width:min(100%,18rem);height:.55rem;border-radius:999px;background:color-mix(in srgb,#6366f1 14%,var(--border,#e5e5e5));overflow:hidden}',
      '.opbac-prep__bar-fill{height:100%;width:var(--opbac-prep-pct,12%);border-radius:999px;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width .45s ease}',
      '.opbac-prep__pct{margin:.35rem 0 0;font-size:.72rem;font-weight:800;color:#6366f1}',
      '.opbac-prep__steps{list-style:none;margin:.85rem auto 0;padding:0;max-width:22rem;text-align:left;display:flex;flex-direction:column;gap:.4rem}',
      '.opbac-prep__step{display:flex;align-items:flex-start;gap:.55rem;padding:.45rem .55rem;border-radius:10px;background:color-mix(in srgb,#6366f1 5%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 14%,var(--border,#e5e5e5));font-size:.8rem;font-weight:700;color:var(--muted,#666)}',
      '.opbac-prep__step--done{border-color:#86efac;background:color-mix(in srgb,#22c55e 7%,var(--bg,#fff));color:#166534}',
      '.opbac-prep__step--on{border-color:#a5b4fc;background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff));color:#3730a3}',
      '.opbac-prep__step-ic{flex-shrink:0;width:1.15rem;text-align:center}',
      '.opbac-skip-rules{display:flex;align-items:flex-start;gap:.5rem;margin:.9rem auto 0;max-width:22rem;padding:.55rem .65rem;border-radius:10px;background:color-mix(in srgb,#6366f1 6%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 16%,var(--border,#e5e5e5));text-align:left;font-size:.78rem;font-weight:700;color:var(--ink,#333);cursor:pointer;user-select:none;line-height:1.35}',
      '.opbac-skip-rules input{margin:.12rem 0 0;flex-shrink:0;width:1.05rem;height:1.05rem;accent-color:#6366f1}',
      '.opbac-idle__stats{margin:0;max-width:none;text-align:left;font-family:ui-sans-serif,system-ui,Segoe UI,sans-serif;min-height:0}',
      '.opbac-recap .opbac-idle__stats,.opbac-recap__body .opbac-sum,.opbac-recap__body .opbac-hist{min-height:0}',
      '.opbac-idle__stats-h{margin:.35rem 0 .25rem;font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666)}',
      '.opbac-idle__stats-h:first-child{margin-top:0}',
      '.opbac-idle__stats-card{margin:0 0 .35rem;padding:.4rem .5rem;border-radius:10px;background:color-mix(in srgb,#6366f1 6%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 16%,var(--border,#e5e5e5))}',
      '.opbac-idle__stats-sum{margin:0;font-size:.84rem;font-weight:700;color:var(--ink,#222);line-height:1.4}',
      '.opbac-idle__stats-empty{margin:0;font-size:.8rem;color:var(--muted,#666);font-weight:600}',
      '.opbac-sum{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.35rem;margin:0 0 .45rem}',
      '.opbac-sum__chip{padding:.4rem .45rem;border-radius:12px;background:color-mix(in srgb,#6366f1 8%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 18%,var(--border,#e5e5e5));text-align:center}',
      '.opbac-sum__n{display:block;font-size:1.2rem;font-weight:900;color:#4338ca;font-variant-numeric:tabular-nums}',
      '.opbac-sum__l{display:block;margin-top:.1rem;font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#666)}',
      '.opbac-rank{display:flex;flex-direction:column;gap:.32rem}',
      '.opbac-rank__row{display:grid;grid-template-columns:2rem minmax(0,1fr) auto;align-items:center;gap:.4rem;padding:.42rem .5rem;border-radius:10px;background:var(--bg,#fff);border:1px solid var(--border,#e5e5e5)}',
      '.opbac-rank__row--1{background:linear-gradient(135deg,#fffbeb,#fef3c7);border-color:#fcd34d}',
      '.opbac-rank__row--2{background:linear-gradient(135deg,#f8fafc,#e2e8f0);border-color:#cbd5e1}',
      '.opbac-rank__row--3{background:linear-gradient(135deg,#fff7ed,#ffedd5);border-color:#fdba74}',
      '.opbac-rank__row--me{box-shadow:inset 0 0 0 2px color-mix(in srgb,#6366f1 70%,transparent)}',
      '.opbac-rank__medal{text-align:center;font-size:1.05rem;line-height:1}',
      '.opbac-rank__n{width:1.55rem;height:1.55rem;margin:0 auto;border-radius:50%;display:grid;place-items:center;font-size:.68rem;font-weight:900;background:var(--bg-soft,rgba(127,127,127,.12));color:var(--muted,#666)}',
      '.opbac-rank__nick{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink,#111)}',
      '.opbac-rank__you{font-size:.62rem;font-weight:800;color:#6366f1;margin-left:.2rem}',
      '.opbac-rank__pts{font-weight:900;font-variant-numeric:tabular-nums;color:#4f46e5;white-space:nowrap}',
      '.opbac-rank__pts small,.opbac-hist__p-pts small,.opbac-hist__p-pts small,.opbac-live__pts small,.opbac-podium__pts small{font-size:.7rem;font-weight:800;opacity:.88;margin-left:.18rem}',
      '.opbac-podium{display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:end;gap:.4rem;margin:0 0 .85rem}',
      '.opbac-podium--2{grid-template-columns:1fr 1fr}',
      '.opbac-podium__slot{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:.2rem;padding:.5rem .3rem .65rem;border-radius:14px;text-align:center;border:1px solid var(--border,#e5e5e5);min-width:0}',
      '.opbac-podium__slot--1{background:linear-gradient(180deg,#fffbeb,#fde68a);border-color:#fbbf24;min-height:7rem;order:2}',
      '.opbac-podium__slot--2{background:linear-gradient(180deg,#f8fafc,#e2e8f0);border-color:#cbd5e1;min-height:5.6rem;order:1}',
      '.opbac-podium__slot--3{background:linear-gradient(180deg,#fff7ed,#fed7aa);border-color:#fdba74;min-height:5rem;order:3}',
      '.opbac-podium--2 .opbac-podium__slot--1{order:1}',
      '.opbac-podium--2 .opbac-podium__slot--2{order:2}',
      '.opbac-podium__medal{font-size:1.35rem;line-height:1}',
      '.opbac-podium__nick{font-size:.78rem;font-weight:900;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.opbac-podium__pts{font-size:.82rem;font-weight:900;color:#4f46e5;font-variant-numeric:tabular-nums}',
      '.opbac-hist{display:flex;flex-direction:column;gap:.28rem}',
      '.opbac-hist__card{padding:.32rem .45rem;border-radius:9px;background:var(--bg,#fff);border:1px solid color-mix(in srgb,#6366f1 14%,var(--border,#e5e5e5))}',
      '.opbac-idle__stats .opbac-rank{gap:.22rem}',
      '.opbac-hist__when{display:block;font-size:.68rem;font-weight:800;color:var(--muted,#666);margin:0 0 .4rem}',
      '.opbac-hist__players{display:flex;flex-wrap:wrap;gap:.3rem}',
      '.opbac-hist__p{display:inline-flex;align-items:center;gap:.28rem;padding:.22rem .5rem;border-radius:999px;background:color-mix(in srgb,#6366f1 8%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 14%,var(--border,#e5e5e5));font-size:.72rem;font-weight:800;max-width:100%}',
      '.opbac-hist__p--win{background:linear-gradient(135deg,#fef3c7,#fde68a);border-color:#fbbf24}',
      '.opbac-hist__p-nick{max-width:7.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.opbac-hist__p-pts{color:#4f46e5;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.opbac-hist__raw{margin:0;font-size:.74rem;font-weight:700;color:var(--muted,#555);line-height:1.35}',
      '.opbac-sheet{display:grid;grid-template-columns:repeat(var(--opbac-cols,3),minmax(0,1fr));gap:.55rem;width:100%;align-items:stretch}',
      '@media(max-width:720px){.opbac-sheet{grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))}}',
      '.opbac-col{display:flex;flex-direction:column;gap:.35rem;min-width:0;padding:.55rem .5rem;border-radius:12px;background:var(--bg-soft,rgba(127,127,127,.05));border:1px solid var(--border,#e5e5e5)}',
      '.opbac-col--ok{border-color:#86efac;background:color-mix(in srgb,#22c55e 7%,var(--bg,#fff))}',
      '.opbac-col--ia{border-color:#67e8f9;background:color-mix(in srgb,#06b6d4 8%,var(--bg,#fff))}',
      '.opbac-col__award{display:inline-flex;align-items:center;margin-left:.25rem;font-size:.68rem;font-weight:800;color:#15803d;white-space:nowrap}',
      '.opbac-col--ia .opbac-col__award{color:#0e7490}',
      '.opbac-col--pending{border-color:#fcd34d;background:color-mix(in srgb,#fbbf24 6%,var(--bg,#fff))}',
      '.opbac-col__pending{display:inline-block;width:.85rem;height:.85rem;border-width:1.5px;vertical-align:middle;margin-left:.15rem}',
      '.opbac-col--reject{border-color:#fca5a5;background:color-mix(in srgb,#ef4444 5%,var(--bg,#fff))}',
      '.opbac-col__cat{font-size:.8rem;font-weight:900;text-transform:capitalize;color:var(--ink,#111);text-align:center;line-height:1.2;display:flex;align-items:center;justify-content:center;gap:.35rem}',
      '.opbac-col__ico-wrap{width:1.5rem;height:1.5rem;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 3px rgba(15,23,42,.18)}',
      '.opbac-col__ico{width:1rem;height:1rem;flex-shrink:0;color:#fff}',
      '.opbac-col__input{width:100%;border:1px solid var(--border,#ccc);border-radius:9px;padding:.55rem .5rem;font-size:.95rem;min-height:44px;background:var(--bg,#fff);text-align:center}',
      '.opbac-col__input:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 2px color-mix(in srgb,#6366f1 22%,transparent)}',
      '.opbac-col__input:disabled{opacity:.65}',
      '.opbac-col__send{width:100%;border:0;border-radius:9px;padding:.48rem .5rem;font-size:.78rem;font-weight:800;cursor:pointer;background:#6366f1;color:#fff;min-height:40px}',
      '.opbac-col__send:disabled{opacity:.4;cursor:not-allowed}',
      '.opbac-col__err{font-size:.65rem;font-weight:700;color:#dc2626;margin:0;line-height:1.25;text-align:center}',
      '.opbac-info-hint{display:flex;align-items:center;gap:.45rem;margin-top:.15rem;padding:.45rem .5rem;border-radius:10px;background:color-mix(in srgb,#3b82f6 7%,var(--bg,#fff));border:1px solid color-mix(in srgb,#3b82f6 22%,var(--border,#ddd))}',
      '.opbac-info-hint__icon{font-size:1rem;line-height:1;flex-shrink:0}',
      '.opbac-info-hint__body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.12rem}',
      '.opbac-info-hint__lbl{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#1d4ed8}',
      '.opbac-info-hint__cmd{display:block;font-family:ui-monospace,Consolas,monospace;font-size:.72rem;font-weight:800;color:#1e3a8a;background:rgba(255,255,255,.55);padding:.18rem .35rem;border-radius:6px;word-break:break-word}',
      '.opbac-info-hint__btn{flex-shrink:0;border:0;border-radius:8px;padding:.38rem .55rem;font-size:.68rem;font-weight:800;cursor:pointer;background:#2563eb;color:#fff;white-space:nowrap}',
      '.opbac-info-hint__btn:hover{filter:brightness(1.06)}',
      '.opbac-col__verify{width:100%;border:0;border-radius:8px;padding:.35rem .45rem;font-size:.65rem;font-weight:800;cursor:pointer;background:#fff7ed;color:#c2410c;border:1px solid #fdba74}',
      '.opbac-col__verify--sent{opacity:.6}',
      '.opbac-sheet__all{grid-column:1/-1;width:100%;margin-top:.1rem;border:1px solid color-mix(in srgb,#6366f1 35%,var(--border,#ccc));border-radius:10px;padding:.5rem;font-size:.8rem;font-weight:800;cursor:pointer;background:var(--bg,#fff);color:#6366f1;min-height:40px}',
      '.opbac-sheet__all:disabled{opacity:.4;cursor:not-allowed}',
      '.opbac-help-wrap{padding:0 1.2rem 1.25rem}',
      '.opbac-help-overlay{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:1rem;background:rgba(15,23,42,.5);backdrop-filter:blur(2px)}',
      '.opbac-help-dialog{width:min(680px,100%);max-height:min(88vh,760px);display:flex;flex-direction:column;background:var(--bg,#fff);border-radius:16px;border:1px solid var(--border,#ddd);box-shadow:0 24px 64px -20px rgba(15,23,42,.45);overflow:hidden}',
      '.opbac-help-dialog__head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:1rem 1.15rem .85rem;border-bottom:1px solid var(--border,#e5e5e5)}',
      '.opbac-help-dialog__head h3{margin:0;font-size:1.15rem;font-weight:900;color:var(--ink,#111);display:flex;align-items:center;gap:.55rem}',
      '.opbac-help-dialog__logo{width:1.65rem;height:1.65rem;border-radius:6px;flex-shrink:0}',
      '.opbac-help-dialog__x{width:34px;height:34px;border:0;border-radius:9px;background:var(--bg-soft,rgba(127,127,127,.12));color:var(--muted,#666);cursor:pointer;font-size:.95rem}',
      '.opbac-help-dialog__x:hover{background:var(--bg-soft-2,rgba(127,127,127,.18))}',
      '.opbac-help-dialog__body,.opbac-help{padding:1rem 1.15rem 1.2rem;overflow-y:auto;line-height:1.5;max-height:min(72vh,620px);-webkit-overflow-scrolling:touch}',
      '.modal:has(.opbac-help-wrap),.modal:has(.opbac-rules-modal){width:min(720px,96vw);max-height:min(90vh,780px);display:flex;flex-direction:column;overflow:hidden}',
      '.modal:has(.opbac-help-wrap) .opbac-help-wrap{overflow-y:auto;-webkit-overflow-scrolling:touch;max-height:min(72vh,640px);padding:0 .15rem 1.1rem}',
      '.opbac-help-intro{margin:0 0 1rem;padding:.65rem .75rem;border-radius:10px;background:color-mix(in srgb,#6366f1 8%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 22%,var(--border,#ddd));font-size:.88rem;color:var(--ink,#222)}',
      '.opbac-help-sec{margin:0 0 1.15rem}',
      '.opbac-help-sec:last-child{margin-bottom:0}',
      '.opbac-help-sec__h{margin:0 0 .55rem;font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--ink,#111)}',
      '.opbac-help-sec__note{margin:.5rem 0 0;font-size:.76rem;color:var(--muted,#666);line-height:1.4}',
      '.opbac-help-steps{margin:0;padding:0;list-style:none;counter-reset:opbacstep}',
      '.opbac-help-steps li{position:relative;margin:0 0 .55rem;padding:.15rem 0 .15rem 2rem;font-size:.86rem;color:var(--ink,#222)}',
      '.opbac-help-steps li:last-child{margin-bottom:0}',
      '.opbac-help-steps li::before{counter-increment:opbacstep;content:counter(opbacstep);position:absolute;left:0;top:.1rem;width:1.45rem;height:1.45rem;border-radius:50%;display:grid;place-items:center;font-size:.72rem;font-weight:900;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6)}',
      '.opbac-help-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem}',
      '@media(max-width:560px){.opbac-help-modes{grid-template-columns:1fr}}',
      '.opbac-help-mode{display:flex;flex-direction:column;align-items:center;gap:.12rem;padding:.55rem .4rem;border-radius:11px;border:1px solid var(--border,#e5e5e5);background:var(--bg-soft,rgba(127,127,127,.05));text-align:center}',
      '.opbac-help-mode__emoji{font-size:1.15rem;line-height:1}',
      '.opbac-help-mode strong{font-size:.8rem;color:var(--ink,#111)}',
      '.opbac-help-mode span{font-size:.65rem;font-weight:700;color:var(--muted,#666);line-height:1.25}',
      '.opbac-help-cmds{display:flex;flex-direction:column;gap:0;border:1px solid var(--border,#e5e5e5);border-radius:12px;overflow:hidden}',
      '.opbac-help-cmd{display:grid;grid-template-columns:minmax(7.5rem,9.5rem) 1fr;gap:.55rem;padding:.52rem .65rem;border-bottom:1px solid var(--border,#eee);background:var(--bg,#fff);align-items:start}',
      '.opbac-help-cmd:last-child{border-bottom:0}',
      '.opbac-help-cmd__k{display:inline-block;padding:.15rem .45rem;border-radius:7px;background:color-mix(in srgb,#6366f1 12%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 25%,var(--border,#ddd));font-family:ui-monospace,Consolas,monospace;font-size:.76rem;font-weight:800;color:#4338ca;word-break:break-word}',
      '.opbac-help-cmd__d{font-size:.82rem;color:var(--ink,#222);line-height:1.35}',
      '.opbac-help-foot{margin:1rem 0 0;padding-top:.85rem;border-top:1px solid var(--border,#ddd);font-size:.78rem;color:var(--muted,#666);line-height:1.45}',
      '.opbac-rules-modal{display:flex;flex-direction:column;gap:.85rem}',
      '.opbac-rules-modal__lead{margin:0;font-size:.88rem;line-height:1.45;color:var(--ink,#222)}',
      '.opbac-rules-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}',
      '.opbac-rules-card{display:flex;gap:.55rem;align-items:flex-start;padding:.7rem .75rem;border-radius:14px;border:1px solid color-mix(in srgb,#6366f1 18%,var(--border,#e5e5e5));background:color-mix(in srgb,#6366f1 5%,var(--bg,#fff))}',
      '.opbac-rules-card__ico{flex-shrink:0;width:2.1rem;height:2.1rem;border-radius:10px;display:grid;place-items:center;font-size:1.15rem;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
      '.opbac-rules-card p{margin:0;font-size:.82rem;line-height:1.4;color:var(--ink,#222)}',
      '.opbac-rules-card b{display:block;font-size:.78rem;margin-bottom:.12rem}',
      '@media(max-width:640px){.opbac-rules-cards{grid-template-columns:1fr}.opbac-help-dialog__body,.opbac-help{max-height:min(70vh,560px);-webkit-overflow-scrolling:touch}}',
      '.opbac-info-modal__wait{display:flex;align-items:center;gap:.55rem;margin:0;font-size:.88rem;color:var(--muted,#666)}',
      '.opbac-info-modal__word{margin:0 0 .65rem;font-size:1rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-info-modal__txt{font-size:.88rem;line-height:1.5;color:var(--ink,#222);white-space:pre-wrap}',
      '.opbac-complete{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:.35rem;padding:.85rem 1rem;margin-bottom:.2rem;border-radius:14px;background:linear-gradient(135deg,#ecfdf5,#dcfce7);border:1px solid #86efac;color:#166534;text-align:center}',
      '.opbac-complete--combo{background:linear-gradient(135deg,#fff7ed,#ffedd5);border-color:#fdba74;color:#9a3412}',
      '.opbac-complete__fire{font-size:1.85rem;line-height:1}',
      '.opbac-complete__img{width:3rem;height:3rem;display:block;margin:0 auto .15rem}',
      '.opbac-complete__title{font-size:1rem;font-weight:900;letter-spacing:.01em}',
      '.opbac-complete__sub{font-size:.78rem;font-weight:700;opacity:.9}',
      '.opbac-panel--complete{border-bottom-color:color-mix(in srgb,#22c55e 35%,var(--border,#ddd))}',
      '.opbac-head__badge--complete{background:rgba(34,197,94,.85)!important}',
      '.opbac-panel--game-end{border-bottom-color:color-mix(in srgb,#eab308 40%,var(--border,#ddd))}',
      '.opbac-panel--round-end{border-bottom-color:color-mix(in srgb,#6366f1 35%,var(--border,#ddd))}',
      '.opbac-panel--round-end .opbac-end{flex:0 1 auto;min-height:0;overflow:auto}',
      '.opbac-panel--round-end .opbac-live{flex:1 1 40%;min-height:8rem}',
      '.opbac-end{padding:.85rem .9rem 1rem;font-family:ui-sans-serif,system-ui,Segoe UI,sans-serif}',
      '.opbac-end--enter{animation:opbacFadeIn .35s ease 1 both}',
      '@keyframes opbacFadeIn{0%{opacity:0}100%{opacity:1}}',
      '@keyframes opbacSpin{to{transform:rotate(360deg)}}',
      '.opbac-refresh{display:inline-block;width:1.35rem;height:1.35rem;border:2px solid color-mix(in srgb,var(--accent,#6366f1) 35%,var(--border,#ccc));border-top-color:var(--accent,#6366f1);border-radius:50%;animation:opbacSpin .75s linear infinite;vertical-align:middle}',
      '.opbac-end__refresh{width:1.75rem;height:1.75rem;margin:0 auto .45rem;display:block}',
      '.opbac-end__hero{text-align:center;padding:.85rem .75rem .95rem;border-radius:14px;margin-bottom:.85rem;color:#fff;overflow:visible;width:100%;box-sizing:border-box}',
      '.opbac-end__hero--game{background:linear-gradient(135deg,#6d28d9,#4f46e5)}',
      '.opbac-end__hero--round{background:linear-gradient(135deg,#6366f1,#4f46e5)}',
      '.opbac-end__illus{width:3.25rem;height:3.25rem;margin:0 auto .45rem;display:block;filter:drop-shadow(0 4px 8px rgba(0,0,0,.12))}',
      '.opbac-end__trophy{font-size:2.2rem;line-height:1;margin-bottom:.35rem}',
      '.opbac-end__title{display:block;width:100%;max-width:100%;box-sizing:border-box;font-size:1.22rem;font-weight:900;letter-spacing:0;margin:0 0 .25rem;line-height:1.35;overflow:visible;white-space:normal;word-break:normal;overflow-wrap:normal;hyphens:none;text-align:center}',
      '.opbac-end__sub{font-size:.82rem;font-weight:700;opacity:.92;margin:0}',
      '.opbac-end__block{margin-bottom:.85rem}',
      '.opbac-end__block:last-child{margin-bottom:0}',
      '.opbac-end__h{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666);margin:0 0 .45rem}',
      '.opbac-end__table{width:100%;border-collapse:collapse;font-size:.84rem}',
      '.opbac-end__table th,.opbac-end__table td{padding:.42rem .45rem;border-bottom:1px solid var(--border,#e5e5e5);text-align:left}',
      '.opbac-end__table th{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#666)}',
      '.opbac-end__table tr.opbac-end__me td{font-weight:800;color:#6366f1;background:color-mix(in srgb,#6366f1 6%,transparent)}',
      '.opbac-end__rank{width:2rem;text-align:center;font-size:1rem}',
      '.opbac-end__pts{text-align:right;font-weight:800;font-variant-numeric:tabular-nums;color:var(--accent,#6366f1)}',
      '.opbac-end__notes{display:flex;flex-direction:column;gap:.35rem}',
      '.opbac-end__note{margin:0;padding:.55rem .65rem;border-radius:10px;background:var(--bg-soft,rgba(127,127,127,.07));border:1px solid var(--border,#e5e5e5);font-size:.78rem;line-height:1.4;color:var(--ink,#222)}',
      '.opbac-end__wait{display:flex;align-items:center;justify-content:center;gap:.55rem;margin-top:.7rem;padding:.75rem .9rem;border-radius:12px;background:color-mix(in srgb,var(--accent,#6366f1) 8%,var(--bg-soft,rgba(127,127,127,.07)));border:1px solid color-mix(in srgb,var(--accent,#6366f1) 28%,var(--border,#e5e5e5))}',
      '.opbac-end__wait .opbac-refresh{flex-shrink:0;width:1.2rem;height:1.2rem}',
      '.opbac-end__wait-txt{margin:0;font-size:.84rem;font-weight:700;color:var(--ink,#222)}',
      '.opbac-end__actions{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.85rem}',
      '.opbac-end__btn{flex:1;min-width:8rem;border:0;border-radius:999px;padding:.65rem 1rem;font-size:.84rem;font-weight:800;cursor:pointer}',
      '.opbac-end__btn--primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
      '.opbac-end__btn--ghost{background:var(--bg-soft,rgba(127,127,127,.1));color:var(--ink,#111);border:1px solid var(--border,#ddd)}',
      '.opbac-end__empty{font-size:.82rem;color:var(--muted,#666);text-align:center;padding:.65rem;display:flex;align-items:center;justify-content:center;gap:.45rem}',
      '.opbac-end__split{display:grid;grid-template-columns:1fr;gap:.85rem;margin-bottom:.85rem}',
      '.opbac-end__split .opbac-end__block{margin-bottom:0}',
      '@media(min-width:880px){.opbac-end__split{grid-template-columns:1fr 1fr;align-items:start}}',
      '.opbac-end__h--sub{margin-top:.65rem}',
      '.opbac-records{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.35rem}',
      '.opbac-records__row{display:flex;align-items:center;gap:.5rem;padding:.5rem .6rem;border-radius:10px;background:var(--bg-soft,rgba(127,127,127,.07));border:1px solid var(--border,#e5e5e5)}',
      '.opbac-records__ico{flex-shrink:0;font-size:1.05rem;line-height:1}',
      '.opbac-records__meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:.08rem}',
      '.opbac-records__label{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#666)}',
      '.opbac-records__who{font-size:.82rem;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.opbac-records__val{flex-shrink:0;font-size:.78rem;font-weight:800;font-variant-numeric:tabular-nums;color:#4f46e5}',
      '.opbac-end__chat-hint{margin:.85rem 0 0;text-align:center}',
      '.opbac-end__chat-btn{border:0;background:none;color:var(--accent,#6366f1);font-size:.8rem;font-weight:800;cursor:pointer;text-decoration:underline}',
      '.opbac-feedback{margin:.15rem 0 .85rem;padding:.75rem .8rem;border-radius:14px;background:color-mix(in srgb,#6366f1 7%,var(--bg,#fff));border:1px solid color-mix(in srgb,#6366f1 22%,var(--border,#e5e5e5))}',
      '.opbac-feedback__lead{margin:0 0 .55rem;font-size:.82rem;font-weight:600;color:var(--ink,#222);line-height:1.4}',
      '.opbac-feedback__acts{display:flex;flex-wrap:wrap;gap:.4rem}',
      '.opbac-fb-form{display:flex;flex-direction:column;gap:.55rem}',
      '.opbac-fb-form__hint{margin:0;font-size:.84rem;line-height:1.4;color:var(--ink,#222)}',
      '.opbac-fb-form textarea{width:100%;min-height:7rem;resize:vertical;border:1px solid var(--border,#ccc);border-radius:10px;padding:.65rem .7rem;font:inherit;font-size:.88rem;background:var(--bg,#fff);color:var(--ink,#111);box-sizing:border-box}',
      '.opbac-fb-form textarea:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 2px color-mix(in srgb,#6366f1 22%,transparent)}',
      '.opbac-fb-form__status{margin:0;font-size:.8rem;font-weight:700;line-height:1.35}',
      '.opbac-fb-form__status--err{color:#b91c1c}',
      '.opbac-fb-form__status--ok{color:#15803d}',
      '.opbac-fb-form__row{display:flex;justify-content:flex-end}',
      '.opbac-replay__q{margin:0 0 .25rem;font-size:1.08rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-replay__sub{margin:0 0 .45rem;font-size:.8rem;font-weight:600;color:var(--muted,#666)}',
      '.opbac-mode{display:flex;flex-direction:column;align-items:center;gap:.1rem;padding:.4rem .3rem;border-radius:12px;border:2px solid var(--border,#ddd);background:var(--bg,#fff);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .12s;font:inherit;color:inherit}',
      '.opbac-mode:hover{border-color:color-mix(in srgb,#6366f1 40%,var(--border,#ccc));transform:translateY(-1px)}',
      '.opbac-mode--on{border-color:#6366f1;background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff));box-shadow:0 0 0 3px color-mix(in srgb,#6366f1 18%,transparent)}',
      '.opbac-mode__emoji{font-size:1.25rem;line-height:1}',
      '.opbac-mode__label{font-size:.82rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-mode__hint{font-size:.62rem;font-weight:700;color:var(--muted,#666);line-height:1.25}',
      '.opbac-replay__cta{display:flex;width:100%;max-width:32rem;margin:0 auto;align-items:center;justify-content:center;border:0;border-radius:999px;padding:.85rem 1rem;font-size:1.05rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 12px 28px -10px rgba(99,102,241,.65);min-height:52px}',
      '.opbac-replay__cta:hover{filter:brightness(1.06)}',
      '.opbac-replay__help{border:0;background:none;color:var(--accent,#6366f1);font-size:.76rem;font-weight:700;cursor:pointer;text-decoration:underline}',
      '.opbac-playpick{display:flex;flex-direction:column;gap:.35rem;flex:0 1 auto;min-height:0;overflow:hidden}',
      '.opbac-setup{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(15rem,.75fr);gap:.45rem;text-align:left;flex:1 1 auto;min-height:0;overflow:hidden}',
      '.opbac-setup--solo{grid-template-columns:1fr}',
      '@media(max-width:760px){.opbac-setup{grid-template-columns:1fr;overflow:auto}}',
      '.opbac-setup__modes,.opbac-setup__create{display:flex;flex-direction:column;padding:.45rem .5rem .5rem;border-radius:12px;border:1px solid color-mix(in srgb,#6366f1 16%,var(--border,#e5e5e5));background:color-mix(in srgb,#6366f1 5%,var(--bg,#fff));min-width:0;min-height:0;overflow:auto}',
      '.opbac-create-ok{margin:.35rem 0 0;padding:.35rem .45rem;border-radius:10px;background:#ecfdf5;border:1px solid #86efac;color:#166534;font-size:.72rem;font-weight:800;line-height:1.35}',
      '.opbac-recap{flex:1 1 0;min-height:6rem;display:flex;flex-direction:column;text-align:left;overflow:hidden}',
      '.opbac-recap__tabs{display:flex;gap:.3rem;flex:0 0 auto;margin:0 0 .3rem}',
      '.opbac-recap__tab{border:1px solid color-mix(in srgb,#6366f1 22%,var(--border,#ddd));background:var(--bg,#fff);color:var(--ink,#333);border-radius:999px;padding:.26rem .7rem;font-size:.72rem;font-weight:800;cursor:pointer;min-height:28px}',
      '.opbac-recap__tab--on{background:#4f46e5;border-color:#4f46e5;color:#fff}',
      '.opbac-recap__body{flex:1 1 auto;min-height:0;overflow:auto}',
      '.opbac-playpick__sec{margin:.05rem 0 .35rem}',
      '.opbac-playpick__h{margin:0 0 .28rem;font-size:.66rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666)}',
      '.opbac-customs{display:flex;flex-direction:column;gap:.25rem;flex:1 1 auto;min-height:0;max-height:min(8.2rem,22vh);overflow-y:auto;margin:0}',
      '.opbac-customs__empty{margin:0;font-size:.74rem;color:var(--muted,#666)}',
      '.opbac-custom{display:flex;align-items:center;justify-content:space-between;gap:.45rem;width:100%;text-align:left;border:1.5px solid var(--border,#ddd);border-radius:10px;padding:.32rem .45rem;background:var(--bg,#fff);cursor:pointer;font:inherit;color:inherit}',
      '.opbac-custom--on{border-color:#6366f1;background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff))}',
      '.opbac-custom__name{font-size:.78rem;font-weight:800;color:var(--ink,#111)}',
      '.opbac-custom__hint{font-size:.64rem;font-weight:700;color:var(--muted,#666);white-space:nowrap}',
      '.opbac-create{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.3rem;margin:.1rem 0 .3rem}',
      '.opbac-create label{display:flex;flex-direction:column;gap:.15rem;font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#666)}',
      '.opbac-create input{border:1px solid var(--border,#ccc);border-radius:8px;padding:.32rem .4rem;font-size:.82rem;font-weight:700;min-height:34px;background:var(--bg,#fff);color:var(--ink,#111)}',
      '.opbac-create__btn{display:inline-flex;align-items:center;justify-content:center;width:auto;align-self:start;border:0;border-radius:10px;padding:.38rem .8rem;font-size:.74rem;font-weight:800;cursor:pointer;background:#4f46e5;color:#fff;min-height:32px}',
      '.opbac-create__btn:hover{filter:brightness(1.06)}',
      '.opbac-play-note{margin:.25rem 0 0;font-size:.64rem;color:var(--muted,#666);line-height:1.3}',
      '.opbac-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.3rem;margin-bottom:.4rem}',
      '@media(max-width:560px){.opbac-modes{grid-template-columns:1fr}}',
      'body.opbac-active .chan-hero{grid-template-columns:40px 1fr;padding:.22rem .7rem;gap:.45rem;min-height:0}',
      'body.opbac-active .chan-hero__media{width:40px;height:40px;min-height:40px;border-radius:9px}',
      'body.opbac-active .chan-hero__topic{-webkit-line-clamp:1;font-size:.72rem;line-height:1.25}',
      'body.opbac-active .chan-hero__by,body.opbac-active .chan-hero__more{display:none}',
      'body.opbac-active .main__room-bg{height:min(22%,160px)!important}',
      '@media(max-width:880px){body.opbac-active .chan-hero{grid-template-columns:32px 1fr;padding:.15rem .45rem;gap:.35rem}body.opbac-active .chan-hero__media{width:32px;height:32px;min-height:32px;border-radius:8px}}',
      '.opbac-score-burst{position:absolute;left:50%;top:38%;z-index:60;pointer-events:none;display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);filter:drop-shadow(0 10px 22px rgba(15,23,42,.18))}',
      '.opbac-score-burst__n{font-size:clamp(2.6rem,9vw,4.4rem);font-weight:900;line-height:1;letter-spacing:-.03em;color:#16a34a;animation:opbacScorePop 1.35s cubic-bezier(.16,1.2,.3,1) both}',
      '.opbac-score-burst__lbl{margin-top:.15rem;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#15803d;opacity:.9;animation:opbacScoreLbl 1.35s ease both}',
      '.opbac-score-burst--hard .opbac-score-burst__n{color:#d97706;background:linear-gradient(180deg,#fbbf24,#d97706);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.opbac-score-burst--hard .opbac-score-burst__lbl{color:#b45309}',
      '.opbac-score-burst__spark{position:absolute;width:.45rem;height:.45rem;border-radius:50%;background:#4ade80;animation:opbacSpark 1.1s ease-out both}',
      '.opbac-score-burst--hard .opbac-score-burst__spark{background:#fbbf24}',
      '.opbac-score-burst--ia .opbac-score-burst__n{color:#0891b2}',
      '.opbac-score-burst--ia .opbac-score-burst__lbl{color:#0e7490}',
      '.opbac-score-burst--ia .opbac-score-burst__spark{background:#22d3ee}',
      '@keyframes opbacScorePop{0%{opacity:0;transform:scale(.35) translateY(18px)}16%{opacity:1;transform:scale(1.22) translateY(0)}55%{opacity:1;transform:scale(1) translateY(-10px)}100%{opacity:0;transform:scale(.86) translateY(-52px)}}',
      '@keyframes opbacScoreLbl{0%,12%{opacity:0}22%{opacity:.95}70%{opacity:.9}100%{opacity:0}}',
      '@keyframes opbacSpark{0%{opacity:0;transform:translate(0,0) scale(.4)}18%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.2)}}',
    ].join('');
    document.head.appendChild(el);
  }

  function computeRemaining(game) {
    if (!game) return { remaining: 0, progress: 0, total: 0 };
    var phase = game.phase || 'idle';
    var now = Date.now();
    if (phase === 'countdown' || phase === 'go') {
      if (game.countdown > 0 && game.countdownAt) {
        var elapsedCd = (now - game.countdownAt) / 1000;
        var remCd = Math.max(0, Math.ceil(game.countdown - elapsedCd));
        var totalCd = game.countdown;
        return {
          remaining: remCd,
          progress: totalCd > 0 ? Math.min(1, 1 - remCd / totalCd) : 0,
          total: totalCd,
        };
      }
      if (game.countdown > 0) {
        return { remaining: game.countdown, progress: 0, total: game.countdown };
      }
    }
    if (phase === 'paused') {
      var frozen = game.countdown > 0 ? game.countdown : 0;
      var totalP = game.duration || frozen;
      return {
        remaining: frozen,
        progress: totalP > 0 ? Math.min(1, 1 - frozen / totalP) : 0,
        total: totalP,
      };
    }
    if (phase !== 'playing') return { remaining: 0, progress: 0, total: 0 };
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

  function buildClockHtml(remaining, progress, total, paused) {
    var r = 42;
    var c = 2 * Math.PI * r;
    var off = c * (1 - (progress || 0));
    var warn = remaining > 0 && remaining <= 10;
    var urgent = remaining > 0 && remaining <= 5;
    var cls = 'opbac-clock' + (paused ? ' opbac-clock--paused' : (urgent ? ' opbac-clock--urgent' : (warn ? ' opbac-clock--warn' : '')));
    return '<div class="' + cls + '" data-opbac-clock>' +
      '<svg class="opbac-clock__ring" viewBox="0 0 100 100" aria-hidden="true">' +
        '<circle class="opbac-clock__track" cx="50" cy="50" r="' + r + '"/>' +
        '<circle class="opbac-clock__prog" data-opbac-ring cx="50" cy="50" r="' + r + '" ' +
          'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/>' +
      '</svg>' +
      '<span class="opbac-clock__n" data-opbac-timer>' + (remaining > 0 ? String(remaining) : '—') + '</span></div>';
  }

  function buildSideScoresHtml(game) {
    var rows = rankingForDisplay(game, false);
    var html = '<aside class="opbac-arena__scores" data-opbac-scores>';
    if (!rows.length) {
      html += '<p class="opbac-arena__scores-empty">' + escHtml(pick({
        fr: 'Les points s’affichent ici',
        en: 'Points appear here',
      })) + '</p></aside>';
      return html;
    }
    html += rows.slice(0, 8).map(function (row, i) {
      return '<div class="opbac-arena__scores-row">' +
        '<span class="opbac-arena__scores-nick">' +
          '<span class="opbac-arena__scores-rank" aria-hidden="true">' + rankMedal(i) + '</span>' +
          escHtml(row.nick) + '</span>' +
        '<span class="opbac-arena__scores-pts">' + escHtml(formatPtsDisplay(row.pts)) + '</span></div>';
    }).join('') + '</aside>';
    return html;
  }

  function buildStageHtml(game, remaining, progress) {
    if (!game.letter) return '';
    var paused = game.phase === 'paused';
    var roundChip = (game.round && game.totalRounds)
      ? ('<span class="opbac-arena__round">' + escHtml(String(game.round) + '/' + game.totalRounds) + '</span>')
      : '';
    return '<div class="opbac-arena' + (paused ? ' opbac-arena--paused' : '') + '">' +
      (paused
        ? ('<div class="opbac-pause-banner" data-opbac-pause>' +
            '<strong>⏸️ ' + escHtml(pick({ fr: 'Partie en pause', en: 'Game paused' })) + '</strong>' +
            '<span>' + escHtml(pick({
              fr: 'Le chrono est figé. Un opérateur peut relancer avec Reprendre.',
              en: 'The timer is frozen. An operator can resume the round.',
            })) + '</span></div>')
        : '') +
      '<div class="opbac-arena__letter opbac-arena__block">' +
        roundChip +
        '<span class="opbac-arena__lbl">' + escHtml(pick({ fr: 'Lettre', en: 'Letter' })) + '</span>' +
        '<div class="opbac-letter-xl" data-opbac-letter>' + escHtml(game.letter) + '</div>' +
      '</div>' +
      '<div class="opbac-arena__clock opbac-arena__block">' +
        '<span class="opbac-arena__lbl">' + escHtml(paused
          ? pick({ fr: 'Temps restant', en: 'Time left' })
          : pick({ fr: 'Temps', en: 'Time' })) + '</span>' +
        buildClockHtml(remaining, progress, 0, paused) +
      '</div>' +
      '<div class="opbac-arena__scores-wrap opbac-arena__block">' +
        '<span class="opbac-arena__lbl">' + escHtml(pick({ fr: 'Scores', en: 'Scores' })) + '</span>' +
        buildSideScoresHtml(game) +
      '</div>' +
    '</div>';
  }

  function prepProgress(game, remaining) {
    var phase = (game && game.phase) || 'starting';
    if (phase === 'rules') return 18;
    if (phase === 'starting') return 38;
    if (phase === 'countdown' || phase === 'go') {
      var total = Number(game.countdown) || Number(game.duration) || 5;
      var left = remaining > 0 ? remaining : (Number(game.countdown) || 0);
      if (phase === 'go' || left <= 0) return 100;
      var pct = 55 + Math.round(40 * (1 - left / Math.max(total, 1)));
      return Math.max(55, Math.min(98, pct));
    }
    return 12;
  }

  function buildPrepStepsHtml(game, remaining) {
    var phase = (game && game.phase) || 'starting';
    var steps = [
      { id: 'rules', label: pick({ fr: 'Lecture des règles', en: 'Reading the rules' }) },
      { id: 'starting', label: pick({ fr: 'Préparation de la partie', en: 'Setting up the game' }) },
      { id: 'countdown', label: pick({ fr: 'Décompte avant le départ', en: 'Countdown before start' }) },
      { id: 'go', label: pick({ fr: 'Lancement de la manche', en: 'Launching the round' }) },
    ];
    if (skipRulesPref() && phase !== 'rules') {
      steps = steps.filter(function (step) { return step.id !== 'rules'; });
    }
    var cur = 0;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].id === phase) { cur = i; break; }
      if (phase === 'go') cur = i;
    }
    if (phase === 'go' && remaining <= 0) cur = steps.length - 1;
    return '<ul class="opbac-prep__steps" data-opbac-prep-steps>' + steps.map(function (step, i) {
      var cls = 'opbac-prep__step';
      var ic = '○';
      if (i < cur) { cls += ' opbac-prep__step--done'; ic = '✓'; }
      else if (i === cur) { cls += ' opbac-prep__step--on'; ic = '●'; }
      var extra = '';
      if (step.id === 'countdown' && (phase === 'countdown' || phase === 'go') && remaining > 0) {
        extra = ' — ' + remaining + ' s';
      }
      return '<li class="' + cls + '"><span class="opbac-prep__step-ic" aria-hidden="true">' + ic +
        '</span><span>' + escHtml(step.label + extra) + '</span></li>';
    }).join('') + '</ul>';
  }

  function buildPrepScreenHtml(game, remaining) {
    var phase = game.phase || 'starting';
    var title = phaseLabel(phase, game.countdown || remaining);
    var detail = '';
    if (game.totalRounds && game.duration) {
      detail = pick({
        fr: game.totalRounds + ' manches · ' + game.duration + ' s par manche',
        en: game.totalRounds + ' rounds · ' + game.duration + ' s each',
      });
    } else if (game.totalRounds) {
      detail = pick({ fr: game.totalRounds + ' manches', en: game.totalRounds + ' rounds' });
    }
    if (game.mode) {
      detail = (detail ? detail + ' · ' : '') + modeBadgeLabel(game.mode);
    }
    var showCountdown = (phase === 'countdown' || phase === 'go') && (remaining > 0 || game.countdown > 0);
    var cd = showCountdown ? (remaining > 0 ? remaining : game.countdown) : 0;
    var pct = prepProgress(game, remaining);
    var body = '';
    if (showCountdown && cd > 0) {
      body = '<div class="opbac-prep__cd" data-opbac-prep-cd>' + escHtml(String(cd)) + '</div>' +
        '<p class="opbac-prep__msg">' + escHtml(pick({ fr: 'C\'est parti dans…', en: 'Starting in…' })) + '</p>';
    } else {
      body = refreshSpinnerHtml('opbac-prep__spin') +
        '<p class="opbac-prep__msg">' + escHtml(
          phase === 'rules'
            ? pick({ fr: 'Le bot présente les règles — patientez…', en: 'The bot is presenting the rules — please wait…' })
            : (phase === 'starting'
              ? pick({ fr: 'Préparation de la partie…', en: 'Setting up the game…' })
              : pick({ fr: 'Presque prêt…', en: 'Almost ready…' }))
        ) + '</p>';
    }
    body += '<div class="opbac-prep__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      pct + '" data-opbac-prep-bar><div class="opbac-prep__bar-fill" data-opbac-prep-fill style="--opbac-prep-pct:' +
      pct + '%"></div></div>' +
      '<p class="opbac-prep__pct" data-opbac-prep-pct>' + pct + ' %</p>' +
      buildPrepStepsHtml(game, remaining);
    if (game.letter) {
      body += '<div class="opbac-prep__letter" data-opbac-letter>' + escHtml(game.letter) + '</div>';
    }
    if (game.categories && game.categories.length) {
      body += '<p class="opbac-prep__cats">' + escHtml(game.categories.join(' · ')) + '</p>';
    }
    if (phase === 'rules' || phase === 'starting') {
      body += buildSkipRulesCheckHtml();
    }
    return '<div class="opbac-prep" data-opbac-prep>' +
      imgHtml('logo.svg', 'Petit Bac', 'opbac-prep__logo') +
      '<p class="opbac-prep__title">' + escHtml(title) + '</p>' +
      (detail ? '<p class="opbac-prep__detail">' + escHtml(detail) + '</p>' : '') +
      body + '</div>';
  }

  function buildPlayDockHtml(orbit, buffer, game) {
    var paused = game && game.phase === 'paused';
    var isOp = !!(orbit && buffer && isChannelOp(orbit, buffer));
    var items = [
      { act: 'dock-rules', label: pick({ fr: 'Règles', en: 'Rules' }) },
      { act: 'dock-scores', label: pick({ fr: 'Scores', en: 'Scores' }) },
      { act: 'dock-stats', label: pick({ fr: 'Stats', en: 'Stats' }) },
      { act: 'dock-top', label: pick({ fr: 'Top', en: 'Top' }) },
    ];
    if (isOp) {
      items.push({
        act: paused ? 'dock-resume' : 'dock-pause',
        label: paused
          ? pick({ fr: 'Reprendre', en: 'Resume' })
          : pick({ fr: 'Pause', en: 'Pause' }),
        cls: 'opbac-dock__btn--op',
      });
    }
    var vote = game && game.vote && (!game.vote.until || game.vote.until > Date.now());
    return (vote ? buildVoteBarHtml(game) : '') +
      '<nav class="opbac-dock" aria-label="' +
      escHtml(pick({ fr: 'Commandes du jeu', en: 'Game commands' })) + '">' +
      items.map(function (item) {
        return '<button type="button" class="opbac-dock__btn' + (item.cls ? ' ' + item.cls : '') +
          '" data-act="' + escHtml(item.act) + '">' + escHtml(item.label) + '</button>';
      }).join('') + '</nav>';
  }

  function buildVoteBarHtml(game) {
    var vote = game && game.vote;
    if (!vote || (vote.until && vote.until <= Date.now())) return '';
    return '<div class="opbac-vote" data-opbac-vote>' +
      '<p class="opbac-vote__txt">🗳️ ' + escHtml(vote.text || pick({ fr: 'Un vote est en cours', en: 'A vote is in progress' })) + '</p>' +
      '<button type="button" class="opbac-vote__btn opbac-vote__btn--yes" data-act="dock-yes">' +
        escHtml(pick({ fr: 'Oui', en: 'Yes' })) + '</button>' +
      '<button type="button" class="opbac-vote__btn opbac-vote__btn--no" data-act="dock-no">' +
        escHtml(pick({ fr: 'Non', en: 'No' })) + '</button></div>';
  }

  function buildPlayingBodyHtml(orbit, buffer, game, remaining, progress) {
    if (hasPlayableGrid(game)) {
      return buildStageHtml(game, remaining, progress) +
        '<div class="opbac-scroll"><div data-opbac-form>' + buildFormHtml(buffer, game) + '</div></div>' +
        buildLiveBoardHtml(orbit, game, (orbit && orbit.state && orbit.state.nick) ? (orbit.state.nick() || '') : '') +
        buildPlayDockHtml(orbit, buffer, game);
    }
    if (isGameRunning(game)) return buildPrepScreenHtml(game, remaining);
    return '';
  }

  function canCreateGameMode(game) {
    var phase = (game && game.phase) || 'idle';
    return phase === 'idle' || phase === 'game_end';
  }

  function modeBadgeLabel(mode) {
    var id = String(mode || '').trim().toLowerCase();
    if (!id) return '';
    var opts = gameModeOptions();
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].id === id) return opts[i].emoji + ' ' + opts[i].label;
    }
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  function modeBadgeIcon(mode) {
    var id = String(mode || '').trim().toLowerCase();
    if (!id) return '🎮';
    var opts = gameModeOptions();
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].id === id) return opts[i].emoji;
    }
    return '✨';
  }

  function buildModeMenuInnerHtml(selectedMode) {
    selectedMode = sanitizeModeId(selectedMode);
    var html = '<p class="opbac-mode-dd__h">' + escHtml(pick({ fr: 'Modes', en: 'Modes' })) + '</p>';
    gameModeOptions().forEach(function (m) {
      var on = m.id === selectedMode;
      html += '<button type="button" class="opbac-mode-dd__item' + (on ? ' opbac-mode-dd__item--on' : '') +
        '" data-act="switch-mode" data-mode="' + escHtml(m.id) + '">' +
        '<span class="opbac-mode-dd__name">' + m.emoji + ' ' + escHtml(m.label) + '</span>' +
        '<span class="opbac-mode-dd__hint">' + escHtml(m.hint) + '</span></button>';
    });
    if (extraModes.length) {
      html += '<p class="opbac-mode-dd__h">' + escHtml(pick({ fr: 'Personnalisés', en: 'Custom' })) + '</p>';
      extraModes.forEach(function (m) {
        var on = m.id === selectedMode;
        html += '<button type="button" class="opbac-mode-dd__item' + (on ? ' opbac-mode-dd__item--on' : '') +
          '" data-act="switch-mode" data-mode="' + escHtml(m.id) + '">' +
          '<span class="opbac-mode-dd__name">✨ ' + escHtml(m.label || m.id) + '</span>' +
          '<span class="opbac-mode-dd__hint">' + escHtml(modeHint(m)) + '</span></button>';
      });
    }
    html += '<p class="opbac-mode-dd__note">' + escHtml(pick({
      fr: 'S’il y a plus d’un joueur, un vote de 30 s est lancé. Créer un mode : seulement entre deux parties.',
      en: 'If more than one player is in, a 30s vote starts. Create a mode only between games.',
    })) + '</p>';
    return html;
  }

  function closeModeMenu(root) {
    var dd = root && root.querySelector ? root.querySelector('[data-opbac-mode-dd]') : null;
    if (dd) dd.hidden = true;
  }

  function toggleModeMenu(root, orbit, buffer) {
    var dd = root && root.querySelector ? root.querySelector('[data-opbac-mode-dd]') : null;
    if (!dd) return;
    var opening = dd.hidden;
    dd.hidden = !opening;
    if (opening) {
      requestModeList(orbit, buffer);
      var game = getChannelState(buffer) || defaultState();
      dd.innerHTML = buildModeMenuInnerHtml(game.mode || defaultReplayMode(game, root, orbit));
    }
  }

  function requestModeSwitch(orbit, buffer, root, mode) {
    mode = sanitizeModeId(mode);
    var game = getChannelState(buffer) || defaultState();
    if (game.mode && sanitizeModeId(game.mode) === mode && !canCreateGameMode(game)) {
      try {
        orbit.notify('Petit Bac', pick({
          fr: 'Ce mode est déjà en cours.',
          en: 'This mode is already active.',
        }));
      } catch (e0) { /* ignore */ }
      return;
    }
    rememberPickedMode(orbit, root, mode);
    sendPbCmd(orbit, buffer, 'jeu', mode);
    try {
      orbit.notify('Petit Bac', pick({
        fr: canCreateGameMode(game)
          ? ('Mode « ' + mode + ' » sélectionné pour la prochaine partie.')
          : ('Changement vers « ' + mode + ' » demandé. S’il y a plusieurs joueurs, un vote de 30 s démarre.'),
        en: canCreateGameMode(game)
          ? ('Mode “' + mode + '” selected for the next game.')
          : ('Switch to “' + mode + '” requested. If several players are in, a 30s vote starts.'),
      }));
    } catch (e1) { /* ignore */ }
  }

  function buildOfflineHtml(presence) {
    if (presence === 'unknown') {
      return '<div class="opbac-offline" data-opbac-offline role="status">' +
        imgHtml('logo.svg', 'Petit Bac', 'opbac-offline__art') +
        '<p class="opbac-offline__title">' + escHtml(pick({ fr: 'Connexion au jeu…', en: 'Connecting to the game…' })) + '</p>' +
        '<p class="opbac-offline__wait">' + refreshSpinnerHtml() +
          escHtml(pick({ fr: 'Recherche du bot Bac dans le salon…', en: 'Looking for the Bac bot in the channel…' })) +
        '</p></div>';
    }
    return '<div class="opbac-offline" data-opbac-offline role="status">' +
      imgHtml('idle-hero.svg', pick({ fr: 'Petit Bac', en: 'Petit Bac' }), 'opbac-offline__art') +
      '<span class="opbac-offline__badge">⚠ ' +
        escHtml(pick({ fr: 'Bot absent', en: 'Bot offline' })) + '</span>' +
      '<p class="opbac-offline__title">' + escHtml(pick({
        fr: 'Le jeu n\'est pas disponible actuellement',
        en: 'The game is not available right now',
      })) + '</p>' +
      '<p class="opbac-offline__txt">' + escHtml(pick({
        fr: 'Le bot Bac n\'est pas présent dans ce salon. Réessayez plus tard, ou contactez un opérateur si le problème persiste.',
        en: 'The Bac bot is not in this channel. Try again later, or ask an operator if this persists.',
      })) + '</p></div>';
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
    if (name === 'rules') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8M8 11h6"/></svg>';
    }
    return '';
  }

  function normalizeViewMode(mode) {
    var m = String(mode || '').toLowerCase();
    if (m === VIEW_FULL || m === VIEW_SPLIT || m === VIEW_CHAT) return m;
    if (m === 'collapsed' || m === 'true' || m === '1') return VIEW_CHAT;
    return VIEW_FULL;
  }

  function getViewMode(orbit, root) {
    if (root && root.__opbacViewMode) return normalizeViewMode(root.__opbacViewMode);
    try {
      if (orbit) return normalizeViewMode(orbit.storage.get(STORAGE_VIEW_MODE, VIEW_FULL));
    } catch (e) { /* ignore */ }
    return VIEW_FULL;
  }

  function setViewMode(orbit, root, mode, opts) {
    mode = normalizeViewMode(mode);
    if (root) root.__opbacViewMode = mode;
    if (mode === VIEW_FULL || mode === VIEW_SPLIT) {
      if (root) root.__opbacGameView = mode;
      try { if (orbit) orbit.storage.set(STORAGE_GAME_VIEW, mode); } catch (e) { /* ignore */ }
    }
    try { if (orbit) orbit.storage.set(STORAGE_VIEW_MODE, mode); } catch (e) { /* ignore */ }
    applyViewMode(root, orbit, mode, opts || {});
    requestAnimationFrame(function () { pinChatIfFollowing(); });
  }

  function rememberedGameView(orbit, root) {
    if (root && (root.__opbacGameView === VIEW_FULL || root.__opbacGameView === VIEW_SPLIT)) {
      return root.__opbacGameView;
    }
    try {
      if (orbit) {
        var stored = normalizeViewMode(orbit.storage.get(STORAGE_GAME_VIEW, VIEW_FULL));
        if (stored === VIEW_FULL || stored === VIEW_SPLIT) return stored;
      }
    } catch (e) { /* ignore */ }
    return VIEW_FULL;
  }

  function currentGameView(orbit, root, viewMode) {
    viewMode = normalizeViewMode(viewMode);
    if (viewMode === VIEW_FULL || viewMode === VIEW_SPLIT) return viewMode;
    return rememberedGameView(orbit, root);
  }

  function chatReservePx() {
    var main = document.querySelector('.main');
    if (!main) return CHAT_RESERVE_MIN;
    var topic = main.querySelector('.chan-hero');
    var composer = main.querySelector('.composer');
    var topicH = topic ? topic.offsetHeight : 44;
    var compH = composer ? composer.offsetHeight : 64;
    return Math.max(CHAT_RESERVE_MIN, topicH + compH + 8);
  }

  function maxBodyHeight(root) {
    var main = document.querySelector('.main');
    if (!main) return PANEL_HEIGHT_MAX;
    var topbar = main.querySelector('.topbar');
    var head = root && root.querySelector ? root.querySelector('.opbac-head') : null;
    var topH = topbar ? topbar.offsetHeight : 52;
    var headH = head ? head.offsetHeight : 48;
    var resizeH = 12;
    var avail = main.clientHeight - topH - headH - resizeH - chatReservePx();
    return Math.max(PANEL_HEIGHT_MIN, Math.min(PANEL_HEIGHT_MAX, avail));
  }

  function fullBodyHeight(root) {
    return maxBodyHeight(root);
  }

  function collapsedCtaKind(viewMode, gameRunning, isEnd, isIdle, isGameEnd) {
    if (viewMode !== VIEW_CHAT) return '';
    if (gameRunning && !isEnd) return 'join';
    if (isIdle || isGameEnd) return 'play';
    return '';
  }

  function buildCollapsedCtaHtml(kind) {
    if (kind === 'play') {
      return '<button type="button" class="opbac-head__cta" data-opbac-cta data-act="play-now">' +
        escHtml(pick({ fr: 'Jouer maintenant', en: 'Play now' })) + '</button>';
    }
    if (kind === 'join') {
      return '<button type="button" class="opbac-head__cta opbac-head__cta--join" data-opbac-cta data-act="join-game">' +
        escHtml(pick({ fr: 'Participer au jeu', en: 'Join the game' })) + '</button>';
    }
    return '';
  }

  function expandPanel(root, orbit, opts) {
    opts = opts || {};
    setViewMode(orbit, root, opts.mode || VIEW_FULL, opts);
    if (opts.focusInput) {
      requestAnimationFrame(function () {
        var first = root.querySelector('.opbac-col__input:not([disabled])');
        if (first) first.focus();
      });
    }
  }

  function syncCollapsedCta(root, kind) {
    var wrap = root.querySelector('[data-opbac-cta-wrap]');
    if (!wrap) return;
    wrap.innerHTML = buildCollapsedCtaHtml(kind);
    var playBtn = root.querySelector('[data-act="play-menu"]');
    if (playBtn) playBtn.hidden = normalizeViewMode(root.__opbacViewMode) === VIEW_CHAT && kind === 'play';
  }

  function buildHeadHtml(headBadge, modeBadge, viewMode, gameActive, collapsedCta, modeId, gameView) {
    viewMode = normalizeViewMode(viewMode);
    var chatOn = viewMode === VIEW_CHAT;
    gameView = (gameView === VIEW_SPLIT) ? VIEW_SPLIT : VIEW_FULL;
    var layoutTarget = gameView === VIEW_SPLIT ? VIEW_FULL : VIEW_SPLIT;
    var backToGame = gameView === VIEW_SPLIT ? 'view-split' : 'view-full';
    var modeHtml = '';
    if (modeBadge) {
      modeHtml = '<div class="opbac-head__mode" data-opbac-mode-wrap>' +
        '<button type="button" class="opbac-head__badge opbac-head__badge--mode" data-act="mode-menu" ' +
          'aria-haspopup="listbox" aria-label="' + escHtml(modeBadge) + '" title="' +
          escHtml(modeBadge) + '">' +
          '<span class="opbac-head__mode-ico" data-opbac-head-mode-ico>' +
            escHtml(modeBadgeIcon(modeId)) + '</span>' +
          '<span class="opbac-head__caret" aria-hidden="true">▾</span></button>' +
        '<div class="opbac-mode-dd" hidden data-opbac-mode-dd>' +
          buildModeMenuInnerHtml(modeId) + '</div></div>';
    }
    return '<div class="opbac-head">' +
      '<div class="opbac-head__brand">' +
        imgHtml('logo.svg', 'Petit Bac', 'opbac-head__logo') +
        '<span class="opbac-head__title" title="Petit Bac">' +
          '<span class="opbac-head__title-full">Petit Bac</span>' +
          '<span class="opbac-head__title-short">PB</span></span>' +
        '<span class="opbac-head__badge" data-opbac-head-badge>' + escHtml(headBadge) + '</span>' +
        modeHtml +
      '</div>' +
      '<div class="opbac-head__actions">' +
        '<button type="button" class="opbac-head__btn" data-act="aide" title="' +
          escHtml(pick({ fr: 'Aide', en: 'Help' })) + '">?</button>' +
        '<button type="button" class="opbac-head__btn" data-act="bug" title="' +
          escHtml(pick({ fr: 'Signaler un bug', en: 'Report a bug' })) + '">🐞</button>' +
        '<button type="button" class="opbac-head__btn" data-act="rules" title="' +
          escHtml(pick({ fr: 'Règles du jeu', en: 'Game rules' })) + '">' +
          iconSvg('rules') + '</button>' +
        (!gameActive
          ? ('<button type="button" class="opbac-head__btn" data-act="play-menu" title="' +
          escHtml(pick({ fr: 'Choisir un niveau', en: 'Choose a level' })) + '">▶</button>')
          : '') +
        '<button type="button" class="opbac-head__btn' + (!chatOn ? ' opbac-head__btn--on' : '') +
          '" data-act="view-' + layoutTarget + '" title="' +
          escHtml(layoutTarget === VIEW_SPLIT
            ? pick({ fr: 'Partager l\'écran (jeu + tchat)', en: 'Split screen (game + chat)' })
            : pick({ fr: 'Jeu en plein écran', en: 'Fullscreen game' })) + '">' +
          iconSvg(layoutTarget) + '</button>' +
        '<button type="button" class="opbac-head__btn' + (chatOn ? ' opbac-head__btn--on' : '') +
          '" data-act="' + (chatOn ? backToGame : 'view-chat') + '" title="' +
          escHtml(chatOn
            ? pick({ fr: 'Afficher le jeu', en: 'Show game' })
            : pick({ fr: 'Afficher le tchat', en: 'Show chat' })) + '">' +
          iconSvg(chatOn ? 'game' : 'chat') + '</button>' +
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
    if (phase === 'paused') return pick({ fr: '⏸️ Pause', en: '⏸️ Paused' });
    if (phase === 'round_end') return pick({ fr: 'Fin de manche', en: 'Round over' });
    if (phase === 'game_end') return pick({ fr: 'Partie terminée', en: 'Game over' });
    return '';
  }

  function isChannelOp(orbit, bufferKey) {
    var st = orbit.state.get();
    var nick = String(st.nick || '').toLowerCase();
    var buf = st.buffers && st.buffers[bufferKey];
    if (!buf || !buf.members || !nick) return false;
    var me = buf.members[st.nick];
    if (!me) {
      Object.keys(buf.members).some(function (k) {
        if (k.toLowerCase() === nick) { me = buf.members[k]; return true; }
        return false;
      });
    }
    if (!me || !me.prefix) return false;
    return /[~&@]/.test(me.prefix);
  }

  function helpPlayerCommands() {
    return [
      { cmd: '!jouer [noregles]', desc: pick({ fr: 'Démarre une nouvelle partie', en: 'Start a new game' }) },
      { cmd: '!jeu <facile|moyen|difficile|…>', desc: pick({ fr: 'Modifier la difficulté ou personnaliser le jeu', en: 'Change difficulty or customize the game' }) },
      { cmd: '!oui / !non', desc: pick({ fr: 'Voter lors d\'un vote', en: 'Vote yes or no' }) },
      { cmd: '!scores', desc: pick({ fr: 'Affiche les scores cumulés', en: 'Show cumulative scores' }) },
      { cmd: '!stat [pseudo]', desc: pick({ fr: 'Statistiques globales (ou d\'un joueur)', en: 'Global stats (or a player\'s)' }) },
      { cmd: '!top [<n>]', desc: pick({ fr: 'Classement global', en: 'Global ranking' }) },
      { cmd: '!manche', desc: pick({ fr: 'Lettre et catégories de la manche en cours', en: 'Current round letter and categories' }) },
      { cmd: '!verifier <cat> <mot>', desc: pick({ fr: 'Proposer un mot refusé — un opérateur valide manuellement', en: 'Submit a rejected word — an operator validates manually' }) },
      { cmd: '!info <mot>', desc: pick({ fr: 'Informations Wikipédia sur un mot', en: 'Wikipedia info about a word' }) },
      { cmd: '!bug / !suggestion', desc: pick({ fr: 'Signaler un bug ou proposer une amélioration', en: 'Report a bug or suggest an improvement' }) },
    ];
  }

  function helpHowToPlay() {
    return [
      pick({ fr: 'Une lettre et plusieurs catégories sont tirées au sort.', en: 'A letter and several categories are drawn.' }),
      pick({ fr: 'Trouvez un mot commençant par cette lettre pour chaque catégorie.', en: 'Find a word starting with that letter for each category.' }),
      pick({ fr: 'Répondez dans la grille du panneau ou directement dans le tchat.', en: 'Answer in the panel grid or directly in chat.' }),
      pick({ fr: 'Le bot valide automatiquement les mots (+1 pt, +2 pt pour un mot difficile).', en: 'The bot validates words automatically (+1 pt, +2 pt for a hard word).' }),
      pick({ fr: 'Les points sont cumulés à chaque manche ; le classement s\'affiche en fin de manche.', en: 'Points add up each round; rankings show at the end of each round.' }),
      pick({ fr: 'Mot refusé ? Bouton « Vérifier » ou !verifier — un opérateur examinera votre proposition.', en: 'Word rejected? Use Verify or !verifier — an operator will review your request.' }),
    ];
  }

  var helpModalClose = null;
  var helpEscHandler = null;
  var infoModalClose = null;
  var infoEscHandler = null;
  var rulesModalClose = null;
  var rulesEscHandler = null;
  var playEscHandler = null;
  var dockEscHandler = null;
  var dockKind = '';
  var feedbackEscHandler = null;
  var feedbackPending = null;
  var infoLookup = { word: '', waiting: false, buffer: '' };
  var rulesShownFor = Object.create(null);

  function parsePts(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) && n >= 0 ? n : 0;
  }

  function scoreNickKey(nick) {
    return String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
  }

  function findScoreNick(scores, nick) {
    if (!scores || !nick) return null;
    var key = scoreNickKey(nick);
    return Object.keys(scores).find(function (k) { return scoreNickKey(k) === key; }) || null;
  }

  function assignScore(scores, nick, pts) {
    if (!scores || !nick) return;
    var existing = findScoreNick(scores, nick);
    scores[existing || nick] = parsePts(pts);
  }

  function addScore(scores, nick, delta) {
    if (!scores || !nick) return;
    var existing = findScoreNick(scores, nick);
    var key = existing || nick;
    scores[key] = parsePts(scores[key]) + parsePts(delta);
  }

  function ptsLabel() {
    return pick({ fr: 'pts', en: 'pts' });
  }

  function formatPtsDisplay(pts) {
    return formatPtsShort(pts) + ' ' + ptsLabel();
  }

  function ptsHtml(pts) {
    return escHtml(formatPtsShort(pts)) + '<small>' + escHtml(ptsLabel()) + '</small>';
  }

  function defaultPanelHeight(orbit) {
    var main = document.querySelector('.main');
    var h = main ? Math.round(main.clientHeight * 0.45) : 380;
    return Math.max(PANEL_HEIGHT_MIN, Math.min(maxBodyHeight(null), h));
  }

  function getPanelHeight(orbit) {
    try {
      var h = Number(orbit.storage.get(STORAGE_PANEL_HEIGHT, 0));
      var maxH = maxBodyHeight(document.getElementById('opbac-dom-panel'));
      if (h >= PANEL_HEIGHT_MIN && h <= maxH) return h;
    } catch (e) { /* ignore */ }
    return defaultPanelHeight(orbit);
  }

  function applyPanelHeight(root, h) {
    if (!root || normalizeViewMode(root.__opbacViewMode) === VIEW_CHAT) return;
    var maxH = maxBodyHeight(root);
    h = Math.max(PANEL_HEIGHT_MIN, Math.min(maxH, Number(h) || defaultPanelHeight(null)));
    root.__opbacPanelHeight = h;
    root.style.setProperty('--opbac-h', h + 'px');
  }

  function applyViewMode(root, orbit, mode, opts) {
    if (!root) return;
    opts = opts || {};
    mode = normalizeViewMode(mode || root.__opbacViewMode || VIEW_FULL);
    var onBac = !!(orbit && isBacChannel(orbit, orbit.state.active()));
    var wantFull = onBac && mode === VIEW_FULL;
    var wantSplit = onBac && mode === VIEW_SPLIT;
    var same = root.__opbacViewMode === mode
      && document.body.classList.contains('opbac-full') === wantFull
      && document.body.classList.contains('opbac-split') === wantSplit
      && ((mode === VIEW_FULL && root.classList.contains('opbac-panel--full'))
        || (mode === VIEW_SPLIT && root.classList.contains('opbac-panel--split'))
        || (mode === VIEW_CHAT && root.classList.contains('opbac-panel--chat')));
    if (same && !opts.force && opts.height == null) return;
    root.__opbacViewMode = mode;
    root.classList.remove('opbac-panel--collapsed', 'opbac-panel--full', 'opbac-panel--split', 'opbac-panel--chat');
    document.body.classList.toggle('opbac-full', wantFull);
    document.body.classList.toggle('opbac-split', wantSplit);
    if (mode === VIEW_CHAT) {
      root.classList.add('opbac-panel--chat', 'opbac-panel--collapsed');
      root.style.removeProperty('--opbac-h');
      return;
    }
    if (mode === VIEW_FULL) {
      root.classList.add('opbac-panel--full');
      root.style.removeProperty('--opbac-h');
      return;
    }
    root.classList.add('opbac-panel--split');
    var h = opts.height != null ? opts.height : (root.__opbacPanelHeight || getPanelHeight(orbit));
    applyPanelHeight(root, h);
  }

  function bindPanelResize(root, orbit) {
    if (root.__opbacResizeBound) return;
    root.__opbacResizeBound = true;
    root.addEventListener('pointerdown', function (ev) {
      var handle = ev.target && ev.target.closest ? ev.target.closest('[data-opbac-resize]') : null;
      if (!handle) return;
      if (normalizeViewMode(root.__opbacViewMode) !== VIEW_SPLIT) return;
      ev.preventDefault();
      ev.stopPropagation();
      var startY = ev.clientY;
      var startH = root.__opbacPanelHeight || getPanelHeight(orbit);
      function onMove(e) {
        applyPanelHeight(root, startH + (e.clientY - startY));
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (root.__opbacPanelHeight) {
          try { orbit.storage.set(STORAGE_PANEL_HEIGHT, root.__opbacPanelHeight); } catch (err) { /* ignore */ }
        }
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function closeOverlayModal(kind) {
    if (kind === 'info') {
      if (infoModalClose) { try { infoModalClose(); } catch (e) { /* ignore */ } infoModalClose = null; }
      if (infoEscHandler) { document.removeEventListener('keydown', infoEscHandler); infoEscHandler = null; }
      var infoDom = document.getElementById('opbac-info-overlay');
      if (infoDom) infoDom.remove();
      return;
    }
    if (kind === 'rules') {
      if (rulesModalClose) { try { rulesModalClose(); } catch (e) { /* ignore */ } rulesModalClose = null; }
      if (rulesEscHandler) { document.removeEventListener('keydown', rulesEscHandler); rulesEscHandler = null; }
      var rulesDom = document.getElementById('opbac-rules-overlay');
      if (rulesDom) rulesDom.remove();
      return;
    }
    if (kind === 'play') {
      if (playEscHandler) { document.removeEventListener('keydown', playEscHandler); playEscHandler = null; }
      var playDom = document.getElementById('opbac-play-overlay');
      if (playDom) playDom.remove();
      return;
    }
    if (kind === 'dock') {
      if (dockEscHandler) { document.removeEventListener('keydown', dockEscHandler); dockEscHandler = null; }
      var dockDom = document.getElementById('opbac-dock-overlay');
      if (dockDom) dockDom.remove();
      dockKind = '';
      return;
    }
    if (kind === 'feedback') {
      if (feedbackEscHandler) { document.removeEventListener('keydown', feedbackEscHandler); feedbackEscHandler = null; }
      var fbDom = document.getElementById('opbac-feedback-overlay');
      if (fbDom) fbDom.remove();
      if (feedbackPending && feedbackPending.timer) {
        try { clearTimeout(feedbackPending.timer); } catch (e1) { /* ignore */ }
      }
      feedbackPending = null;
    }
  }

  function openOverlayDialog(id, title, bodyHtml, onCloseKind) {
    closeOverlayModal(onCloseKind);
    var overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'opbac-help-overlay';
    overlay.innerHTML =
      '<div class="opbac-help-dialog" role="dialog" aria-modal="true" aria-label="' + escHtml(title) + '">' +
        '<div class="opbac-help-dialog__head">' +
          '<h3>' + imgHtml('logo.svg', '', 'opbac-help-dialog__logo') + escHtml(title) + '</h3>' +
          '<button type="button" class="opbac-help-dialog__x" data-act="close-overlay" aria-label="' +
            escHtml(pick({ fr: 'Fermer', en: 'Close' })) + '">✕</button>' +
        '</div>' +
        '<div class="opbac-help-dialog__body">' + bodyHtml + '</div>' +
      '</div>';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeOverlayModal(onCloseKind);
      var closeBtn = ev.target && ev.target.closest ? ev.target.closest('[data-act="close-overlay"]') : null;
      if (closeBtn) closeOverlayModal(onCloseKind);
    });
    var escHandler = function (ev) {
      if (ev.key === 'Escape') closeOverlayModal(onCloseKind);
    };
    document.addEventListener('keydown', escHandler);
    if (onCloseKind === 'info') {
      infoEscHandler = escHandler;
    } else if (onCloseKind === 'dock') {
      dockEscHandler = escHandler;
    } else {
      rulesEscHandler = escHandler;
    }
    document.body.appendChild(overlay);
    bindSkipRulesUi(overlay, pluginOrbit);
    return escHandler;
  }

  function buildStatCardHtml(card) {
    if (!card) {
      return '<p class="opbac-end__empty">' + refreshSpinnerHtml() + escHtml(pick({
        fr: 'Chargement des statistiques…',
        en: 'Loading stats…',
      })) + '</p>';
    }
    if (card.kind === 'player' && card.ok === false) {
      return '<p class="opbac-idle__stats-empty">' + escHtml(pick({
        fr: 'Aucun historique pour ce joueur.',
        en: 'No history for this player.',
      })) + '</p>';
    }
    var title = card.kind === 'player' && card.nick
      ? pick({ fr: 'Stats de ', en: 'Stats for ' }) + card.nick
      : pick({ fr: 'Statistiques globales', en: 'Global stats' });
    return '<p class="opbac-idle__stats-h">' + escHtml(title) + '</p>' +
      '<div class="opbac-idle__stats-card"><p class="opbac-dock-stat">' +
        escHtml(pick({ fr: 'Parties', en: 'Games' }) + ' : ' + (card.games || '0')) + '<br>' +
        escHtml(pick({ fr: 'Manches', en: 'Rounds' }) + ' : ' + (card.rounds || '0')) + '<br>' +
        escHtml(pick({ fr: 'Mots validés', en: 'Words' }) + ' : ' + (card.words || '0')) + '<br>' +
        escHtml(pick({ fr: 'Full combos', en: 'Full combos' }) + ' : ' + (card.combos || '0')) + '<br>' +
        escHtml(pick({ fr: 'Points', en: 'Points' }) + ' : ' + (card.pts || '0')) +
      '</p></div>';
  }

  function buildDockBodyHtml(kind, game, myNick) {
    if (kind === 'scores') return buildIdleStatsHtml(game || defaultState(), myNick);
    if (kind === 'stats') return buildStatCardHtml(game && game.statCard);
    if (kind === 'top') {
      var rows = (game && game.topGlobal) || [];
      if (!rows.length) {
        if (game && game.topLoaded) {
          return '<p class="opbac-end__empty">' + escHtml(pick({
            fr: 'Aucun classement pour le moment.',
            en: 'No ranking yet.',
          })) + '</p>';
        }
        return '<p class="opbac-end__empty">' + refreshSpinnerHtml() + escHtml(pick({
          fr: 'Chargement du classement…',
          en: 'Loading ranking…',
        })) + '</p>';
      }
      return buildRankingTableHtml(rows, myNick);
    }
    return '';
  }

  function openDockModal(kind, title) {
    var buf = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
      ? pluginOrbit.state.active()
      : '';
    var game = buf ? (getChannelState(buf) || defaultState()) : defaultState();
    var myNick = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick
      ? (pluginOrbit.state.nick() || '')
      : '';
    openOverlayDialog('opbac-dock-overlay', title, buildDockBodyHtml(kind, game, myNick), 'dock');
    dockKind = kind;
    var overlay = document.getElementById('opbac-dock-overlay');
    if (overlay) overlay.setAttribute('data-dock-kind', kind);
  }

  function refreshDockOverlay() {
    var overlay = document.getElementById('opbac-dock-overlay');
    if (!overlay) return;
    var kind = overlay.getAttribute('data-dock-kind') || dockKind;
    if (!kind) return;
    dockKind = kind;
    var body = overlay.querySelector('.opbac-help-dialog__body');
    if (!body) return;
    var buf = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
      ? pluginOrbit.state.active()
      : '';
    var game = buf ? (getChannelState(buf) || defaultState()) : defaultState();
    var myNick = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick
      ? (pluginOrbit.state.nick() || '')
      : '';
    body.innerHTML = buildDockBodyHtml(kind, game, myNick);
  }

  function buildRulesModalHtml() {
    var cards = [
      { ico: '🎲', title: pick({ fr: 'Lettre et catégories', en: 'Letter and categories' }),
        text: pick({ fr: 'Une lettre est tirée au sort. Trouvez un mot commençant par cette lettre, dans chacune des catégories affichées.', en: 'A letter is drawn. Find a word starting with that letter in each shown category.' }) },
      { ico: '📂', title: pick({ fr: 'Catégories', en: 'Categories' }),
        text: pick({ fr: 'Le mot doit appartenir à la catégorie affichée. Les catégories changent à chaque manche.', en: 'The word must belong to the shown category. Categories change each round.' }) },
      { ico: '✍️', title: pick({ fr: 'Une réponse par case', en: 'One word per category' }),
        text: pick({ fr: 'Un seul mot par catégorie, un seul mot par ligne. Pas de virgule, point ou autre ponctuation.', en: 'One word per category, one word per line. No commas, periods or other punctuation.' }) },
      { ico: '⭐', title: pick({ fr: 'Points', en: 'Points' }),
        text: pick({ fr: '+1 point pour un mot simple, +2 points pour un mot difficile. Bonus +1 si toutes les catégories sont remplies (full combo) : la manche se termine alors immédiatement.', en: '+1 point for a simple word, +2 for a hard word. Bonus +1 if every category is filled (full combo): the round then ends immediately.' }) },
      { ico: '⏱️', title: pick({ fr: 'Manche chronométrée', en: 'Timed round' }),
        text: pick({ fr: 'La manche s’arrête quand le temps est écoulé. Les scores s’additionnent à chaque manche ; le classement s’affiche en fin de manche et en fin de partie.', en: 'The round ends when time runs out. Scores add up each round; rankings appear at the end of the round and the game.' }) },
      { ico: '✅', title: pick({ fr: 'Validation', en: 'Validation' }),
        text: pick({ fr: 'Le bot valide automatiquement les mots du dictionnaire. Vous pouvez répondre dans la grille du panneau ou directement dans le tchat.', en: 'The bot validates dictionary words automatically. Answer in the panel grid or directly in chat.' }) },
      { ico: '🔍', title: pick({ fr: 'Mot refusé', en: 'Rejected word' }),
        text: pick({ fr: 'Bouton « Vérifier » : un opérateur examinera votre proposition. Vous pouvez aussi consulter une fiche Wikipédia via le bouton Consulter.', en: 'Use Verify so an operator can review your word. You can also look up a Wikipedia snippet.' }) },
    ];
    return '<div class="opbac-rules-modal">' +
      imgHtml('logo.svg', 'Petit Bac', 'opbac-prep__logo') +
      '<p class="opbac-rules-modal__lead">' + escHtml(pick({
        fr: 'Voici le déroulé d’une partie de Petit Bac.',
        en: 'Here is how a Petit Bac game works.',
      })) + '</p>' +
      '<div class="opbac-rules-cards">' +
        cards.map(function (c) {
          return '<article class="opbac-rules-card"><span class="opbac-rules-card__ico" aria-hidden="true">' +
            c.ico + '</span><p><b>' + escHtml(c.title) + '</b>' + escHtml(c.text) + '</p></article>';
        }).join('') +
      '</div>' +
      buildSkipRulesCheckHtml() +
      '</div>';
  }

  function maybeOpenRulesModal(orbit, channel) {
    if (skipRulesPref(orbit)) return;
    var key = normChan(channel);
    if (rulesShownFor[key]) return;
    rulesShownFor[key] = true;
    openRulesModal(orbit);
  }

  function openRulesModal() {
    closeOverlayModal('rules');
    var title = pick({ fr: 'Règles du Petit Bac', en: 'Petit Bac rules' });
    openOverlayDialog('opbac-rules-overlay', title, buildRulesModalHtml(), 'rules');
  }

  function openInfoModal(word, content, loading) {
    closeOverlayModal('info');
    word = String(word || '').trim();
    var title = pick({ fr: 'Information : ', en: 'About: ' }) + (word || '…');
    var bodyHtml = loading
      ? ('<p class="opbac-info-modal__wait">' + refreshSpinnerHtml('opbac-info-modal__spin') +
          escHtml(pick({ fr: 'Recherche sur Wikipédia…', en: 'Searching Wikipedia…' })) + '</p>')
      : ('<p class="opbac-info-modal__word">« ' + escHtml(word) + ' »</p>' +
          '<div class="opbac-info-modal__txt">' + escHtml(content || pick({
            fr: 'Aucune information trouvée.',
            en: 'No information found.',
          })) + '</div>');
    if (pluginOrbit && typeof pluginOrbit.modal === 'function') {
      infoModalClose = pluginOrbit.modal(function () {
        return h('div', { className: 'opbac-help-wrap', dangerouslySetInnerHTML: { __html: bodyHtml } });
      }, { title: title, wide: true });
      return;
    }
    openOverlayDialog('opbac-info-overlay', title, bodyHtml, 'info');
  }

  function handleBacInfoResponse(channel, body) {
    if (!infoLookup.waiting || normChan(channel) !== infoLookup.buffer) return false;
    if (!/ℹ️|Aucune information|wikip/i.test(body)) return false;
    var word = infoLookup.word;
    var text = body.replace(/^ℹ️\s*/i, '').trim();
    if (/Aucune information/i.test(body)) {
      text = pick({ fr: 'Aucune fiche Wikipédia trouvée pour ce mot.', en: 'No Wikipedia article found for this word.' });
    }
    infoLookup.waiting = false;
    openInfoModal(word, text, false);
    return true;
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
      .slice(0, 12);
  }

  function upsertRankingRow(list, nick, pts) {
    var out = (list || []).slice();
    var key = String(nick || '').toLowerCase();
    var idx = -1;
    for (var i = 0; i < out.length; i++) {
      if (String(out[i].nick || '').toLowerCase() === key) { idx = i; break; }
    }
    var row = { nick: nick, pts: Number(pts) || 0 };
    if (idx >= 0) out[idx] = row;
    else out.push(row);
    return out.sort(function (a, b) { return b.pts - a.pts; });
  }

  function scoresFromRanking(list) {
    var o = Object.create(null);
    (list || []).forEach(function (r) { o[r.nick] = r.pts; });
    return o;
  }

  function rankingForDisplay(game, preferFinal) {
    if (preferFinal && game.finalRanking && game.finalRanking.length) return game.finalRanking;
    if (game.scores && Object.keys(game.scores).length) return sortedScores(game.scores);
    return game.finalRanking || [];
  }

  function roundScoresList(game) {
    var rs = game.roundScores || {};
    return Object.keys(rs).map(function (nick) {
      return { nick: nick, pts: Number(rs[nick]) || 0 };
    }).sort(function (a, b) { return b.pts - a.pts; });
  }

  function rankMedal(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return String(index + 1);
  }

  function appendEndNote(game, line) {
    line = String(line || '').trim();
    if (!line || line.length > 220) return game.endNotes || [];
    var notes = (game.endNotes || []).slice();
    if (notes.indexOf(line) >= 0) return notes;
    notes.push(line);
    return notes.slice(-8);
  }

  function parseServerRecord(body) {
    var t = String(body || '').replace(/^\s+/, '');
    function rec(key, ico, label, nick, value) {
      nick = String(nick || '').replace(/^[@+%~&]/, '').trim();
      value = String(value || '').trim();
      if (!nick || !value) return null;
      return { key: key, ico: ico, label: label, nick: nick, value: value };
    }
    var m;
    if ((m = t.match(/Plus haut score cumul[eé]\s*:\s*(\S+)\s+[—\-–]\s*(\d+(?:[.,]\d+)?)\s*pts/i))) {
      return rec('score', '🏅', pick({ fr: 'Plus haut score cumulé', en: 'Highest score' }), m[1], m[2] + ' pts');
    }
    if ((m = t.match(/Plus grand nombre de full combos\s*:\s*(\S+)\s+[—\-–]\s*(\d+)/i))) {
      return rec('combos', '🔥', pick({ fr: 'Full combos', en: 'Full combos' }), m[1], m[2] + ' combos');
    }
    if ((m = t.match(/Joueur le plus actif\s*:\s*(\S+)\s+[—\-–]\s*(\d+)/i))) {
      return rec('active', '📘', pick({ fr: 'Le plus actif', en: 'Most active' }), m[1], m[2] + ' manches');
    }
    if ((m = t.match(/Record de vitesse\s*:\s*(\S+)\s+[—\-–]\s*([\d.,]+)\s*sec/i))) {
      return rec('speed', '⚡', pick({ fr: 'Record de vitesse', en: 'Speed record' }), m[1], m[2].replace(',', '.') + ' s');
    }
    if ((m = t.match(/Score hebdo\s*:\s*(\S+)\s+[—\-–]\s*(\d+(?:[.,]\d+)?)/i))) {
      return rec('wscore', '🏅', pick({ fr: 'Score de la semaine', en: 'Weekly score' }), m[1], m[2] + ' pts');
    }
    if ((m = t.match(/Full combos hebdo\s*:\s*(\S+)\s+[—\-–]\s*(\d+)/i))) {
      return rec('wcombo', '🔥', pick({ fr: 'Combos de la semaine', en: 'Weekly combos' }), m[1], m[2] + ' combos');
    }
    if ((m = t.match(/Vitesse hebdo\s*:\s*(\S+)\s+[—\-–]\s*([\d.,]+)/i))) {
      return rec('wspeed', '⚡', pick({ fr: 'Vitesse de la semaine', en: 'Weekly speed' }), m[1], m[2].replace(',', '.') + ' s');
    }
    return null;
  }

  function mergeServerRecord(game, rec) {
    if (!rec || !rec.key) return (game && game.serverRecords) || [];
    var order = ['score', 'combos', 'active', 'speed', 'wscore', 'wcombo', 'wspeed'];
    var list = ((game && game.serverRecords) || []).slice();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === rec.key) idx = i;
    }
    if (idx >= 0) list[idx] = rec;
    else list.push(rec);
    list.sort(function (a, b) {
      var ia = order.indexOf(a.key);
      var ib = order.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  function recordFromTagPair(key, ico, label, raw, suffix) {
    raw = String(raw || '').trim();
    if (!raw) return null;
    var i = raw.lastIndexOf(':');
    if (i < 1) return null;
    var nick = raw.slice(0, i).trim();
    var val = raw.slice(i + 1).trim();
    if (!nick || !val) return null;
    return { key: key, ico: ico, label: label, nick: nick, value: val + (suffix || '') };
  }

  function recordsFromTags(tags) {
    var specs = [
      ['score', '🏅', pick({ fr: 'Plus haut score cumulé', en: 'Highest score' }), '+score', ' pts'],
      ['combos', '🔥', pick({ fr: 'Full combos', en: 'Full combos' }), '+combos', ' combos'],
      ['active', '📘', pick({ fr: 'Le plus actif', en: 'Most active' }), '+active', ' manches'],
      ['speed', '⚡', pick({ fr: 'Record de vitesse', en: 'Speed record' }), '+speed', ' s'],
      ['wscore', '🏅', pick({ fr: 'Score de la semaine', en: 'Weekly score' }), '+wscore', ' pts'],
      ['wcombo', '🔥', pick({ fr: 'Combos de la semaine', en: 'Weekly combos' }), '+wcombo', ' combos'],
      ['wspeed', '⚡', pick({ fr: 'Vitesse de la semaine', en: 'Weekly speed' }), '+wspeed', ' s'],
    ];
    var list = [];
    specs.forEach(function (s) {
      var rec = recordFromTagPair(s[0], s[1], s[2], tagVal(tags, s[3]), s[4]);
      if (rec) list.push(rec);
    });
    return list;
  }

  function buildRecordsListHtml(records) {
    return '<ul class="opbac-records">' + records.map(function (r) {
      return '<li class="opbac-records__row">' +
        '<span class="opbac-records__ico" aria-hidden="true">' + escHtml(r.ico || '') + '</span>' +
        '<span class="opbac-records__meta">' +
          '<span class="opbac-records__label">' + escHtml(r.label || '') + '</span>' +
          '<span class="opbac-records__who">' + escHtml(r.nick || '') + '</span>' +
        '</span>' +
        '<span class="opbac-records__val">' + escHtml(r.value || '') + '</span></li>';
    }).join('') + '</ul>';
  }

  function buildRecordsHtml(records) {
    records = records || [];
    if (!records.length) {
      return '<p class="opbac-end__empty">' + escHtml(pick({
        fr: 'Aucun record reçu pour le moment.',
        en: 'No records received yet.',
      })) + '</p>';
    }
    var serverKeys = { score: 1, combos: 1, active: 1, speed: 1 };
    var server = [];
    var weekly = [];
    records.forEach(function (r) {
      if (serverKeys[r.key]) server.push(r);
      else weekly.push(r);
    });
    var html = '';
    if (server.length) html += buildRecordsListHtml(server);
    if (weekly.length) {
      html += '<h4 class="opbac-end__h opbac-end__h--sub">' + escHtml(pick({
        fr: 'Records de la semaine',
        en: 'Weekly records',
      })) + '</h4>' + buildRecordsListHtml(weekly);
    }
    return html;
  }

  function parseScoreMap(raw) {
    var json = safeJson(raw, null);
    if (json && typeof json === 'object' && !Array.isArray(json)) return json;
    var o = Object.create(null);
    rankingFromPairs(raw).forEach(function (row) { o[row.nick] = row.pts; });
    return o;
  }

  function applyFullCombo(channel, nick, scoreRaw) {
    var game = getChannelState(channel) || defaultState();
    var rk = roundKey(game);
    var nickTrim = String(nick || '').trim().replace(/[!.,;:]+$/, '');
    if (!nickTrim) {
      var me = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick ? String(pluginOrbit.state.nick() || '') : '';
      if (me) nickTrim = me;
    }
    var patch = {
      fullComboNick: nickTrim,
      fullComboRound: rk,
    };
    if (nickTrim) {
      var scores = Object.assign({}, game.scores || {});
      var alreadyCombo = game.fullComboRound === rk && game.fullComboNick;
      if (scoreRaw !== '' && scoreRaw != null) {
        assignScore(scores, nickTrim, scoreRaw);
      } else if (!alreadyCombo) {
        addScore(scores, nickTrim, 1);
      }
      patch.scores = scores;
    }
    patchChannel(channel, patch);
    var root = document.getElementById('opbac-dom-panel');
    if (root) triggerCompleteCelebration(root);
  }

  function extractScorePairs(body) {
    var out = [];
    var re = /(?:^|[•·|,]\s*|(?:pour)\s+)([^\s:]{1,32})\s*:\s*(\d+(?:[.,]\d+)?)\s+point/gi;
    var m;
    var skip = /^(scores|cumul[eé]s?|manche|lettre|r[eé]sultat|classement|point|pts|cat[ée]gorie)$/i;
    while ((m = re.exec(String(body || '')))) {
      var nick = String(m[1] || '').replace(/^[@+%~&]/, '');
      if (!nick || skip.test(nick)) continue;
      out.push({ nick: nick, pts: parsePts(m[2]) });
    }
    return out;
  }

  function parseScoreLine(body) {
    var all = extractScorePairs(body);
    if (all.length === 1) return all[0];
    var m = String(body || '').match(/^[•\s]*([^\s:]{1,32})\s*:\s*(\d+(?:[.,]\d+)?)\s+point/i);
    if (!m) return null;
    return { nick: m[1].replace(/^[@+%~&]/, ''), pts: parsePts(m[2]) };
  }

  function gameModeOptions() {
    return [
      {
        id: 'facile',
        emoji: '🌱',
        label: pick({ fr: 'Facile', en: 'Easy' }),
        hint: pick({ fr: '3 catégories · 30 s · 10 manches', en: '3 categories · 30 s · 10 rounds' }),
      },
      {
        id: 'moyen',
        emoji: '⚡',
        label: pick({ fr: 'Moyen', en: 'Medium' }),
        hint: pick({ fr: '5 catégories · 40 s · 12 manches', en: '5 categories · 40 s · 12 rounds' }),
      },
      {
        id: 'difficile',
        emoji: '🔥',
        label: pick({ fr: 'Difficile', en: 'Hard' }),
        hint: pick({ fr: '7 catégories · 45 s · 15 manches', en: '7 categories · 45 s · 15 rounds' }),
      },
    ];
  }

  function isBuiltinMode(mode) {
    return /^(facile|moyen|difficile)$/.test(String(mode || '').trim().toLowerCase());
  }

  function sanitizeModeId(mode) {
    var m = String(mode || '').trim().toLowerCase();
    if (!m) return 'facile';
    return m.replace(/[^a-z0-9_-]/g, '') || 'facile';
  }

  function normalizeModeId(mode) {
    return sanitizeModeId(mode);
  }

  function defaultReplayMode(game, root, orbit) {
    if (root && root.__opbacReplayMode) return sanitizeModeId(root.__opbacReplayMode);
    if (game && game.mode) return sanitizeModeId(game.mode);
    try {
      if (orbit && orbit.storage) return sanitizeModeId(orbit.storage.get('petitbacMode', 'facile'));
    } catch (e) { /* ignore */ }
    return 'facile';
  }

  function modeHint(cfg) {
    return (cfg.cats || cfg.categories) + ' cat. · ' + (cfg.duration || cfg.dur) + ' s · ' +
      (cfg.rounds || cfg.maxrounds) + ' ' + pick({ fr: 'manches', en: 'rounds' });
  }

  function requestModeList(orbit, buffer, force) {
    if (!orbit || !buffer) return;
    var now = Date.now();
    if (!force && now - listeAt < 8000) return;
    listeAt = now;
    waitingListe = true;
    extraModes = [];
    sendPbCmd(orbit, buffer, 'jeu', 'liste');
  }

  function requestLobbyStats(orbit, buffer, force) {
    if (!orbit || !buffer) return;
    var now = Date.now();
    if (!force && now - lobbyFetchAt < 45000) return;
    lobbyFetchAt = now;
    lobbyWaiting = true;
    sendPbCmd(orbit, buffer, 'scores');
  }

  function currentLobbyTab() {
    try {
      if (pluginOrbit) {
        var tab = String(pluginOrbit.storage.get(STORAGE_LOBBY_TAB, 'scores') || 'scores');
        if (tab === 'stats' || tab === 'top') return tab;
      }
    } catch (e) { /* ignore */ }
    return 'scores';
  }

  function setLobbyTab(tab) {
    if (tab !== 'stats' && tab !== 'top') tab = 'scores';
    try { if (pluginOrbit) pluginOrbit.storage.set(STORAGE_LOBBY_TAB, tab); } catch (e) { /* ignore */ }
    return tab;
  }

  function requestLobbyTabData(orbit, buffer, tab, force) {
    if (!orbit || !buffer) return;
    tab = tab || currentLobbyTab();
    if (tab === 'stats') {
      sendPbCmd(orbit, buffer, 'stat');
      return;
    }
    if (tab === 'top') {
      if (force) patchChannel(buffer, { topGlobal: [], topLoaded: false });
      sendPbCmd(orbit, buffer, 'top', '10');
      return;
    }
    requestLobbyStats(orbit, buffer, force);
  }

  function buildScoresRecapHtml(game, myNick) {
    var ranking = (game.lobbyRanking && game.lobbyRanking.length)
      ? game.lobbyRanking
      : (game.finalRanking && game.finalRanking.length
        ? game.finalRanking
        : rankingForDisplay(game, true));
    var html = '';
    if (game.lobbySummary) html += buildSummaryChipsHtml(game.lobbySummary);
    if (ranking && ranking.length) {
      html += '<p class="opbac-idle__stats-h">' +
        escHtml(pick({ fr: 'Classement / scores', en: 'Ranking / scores' })) + '</p>' +
        '<div class="opbac-idle__stats-card">' + buildRankingTableHtml(ranking.slice(0, 5), myNick) + '</div>';
    }
    if (game.lobbyHistory && game.lobbyHistory.length) {
      html += '<p class="opbac-idle__stats-h">' +
        escHtml(pick({ fr: 'Dernières parties', en: 'Recent games' })) + '</p>' +
        buildHistoryHtml(game.lobbyHistory.slice(0, 8), myNick);
    }
    if (!html) {
      html = '<p class="opbac-idle__stats-empty">' + escHtml(pick({
        fr: 'Aucun score pour le moment.',
        en: 'No scores yet.',
      })) + '</p>';
    }
    return html;
  }

  function buildTopRecapHtml(game, myNick) {
    var rows = (game && game.topGlobal) || [];
    if (!rows.length) {
      if (game && game.topLoaded) {
        return '<p class="opbac-end__empty">' + escHtml(pick({
          fr: 'Aucun classement pour le moment.',
          en: 'No ranking yet.',
        })) + '</p>';
      }
      return '<p class="opbac-end__empty">' + refreshSpinnerHtml() + escHtml(pick({
        fr: 'Chargement du classement…',
        en: 'Loading ranking…',
      })) + '</p>';
    }
    return '<p class="opbac-idle__stats-h">' +
      escHtml(pick({ fr: 'Top 10 joueurs', en: 'Top 10 players' })) + '</p>' +
      '<div class="opbac-idle__stats-card">' + buildRankingTableHtml(rows.slice(0, 10), myNick) + '</div>';
  }

  function buildRecapBodyHtml(game, myNick, tab) {
    tab = tab || currentLobbyTab();
    if (tab === 'stats') return buildStatCardHtml(game && game.statCard);
    if (tab === 'top') return buildTopRecapHtml(game, myNick);
    return buildScoresRecapHtml(game || defaultState(), myNick);
  }

  function buildIdleStatsHtml(game, myNick) {
    return '<div class="opbac-idle__stats" data-opbac-idle-stats>' +
      buildScoresRecapHtml(game, myNick) + '</div>';
  }

  function buildRecapHtml(game, myNick) {
    var tab = currentLobbyTab();
    var tabs = [
      ['scores', pick({ fr: 'Scores', en: 'Scores' })],
      ['stats', pick({ fr: 'Stats', en: 'Stats' })],
      ['top', pick({ fr: 'Top 10', en: 'Top 10' })],
    ];
    var html = '<div class="opbac-recap" data-opbac-recap>' +
      '<div class="opbac-recap__tabs" role="tablist">';
    tabs.forEach(function (item) {
      html += '<button type="button" class="opbac-recap__tab' + (item[0] === tab ? ' opbac-recap__tab--on' : '') +
        '" data-act="lobby-tab" data-tab="' + item[0] + '" aria-pressed="' + (item[0] === tab ? 'true' : 'false') + '">' +
        escHtml(item[1]) + '</button>';
    });
    html += '</div><div class="opbac-recap__body" data-opbac-idle-stats>' +
      buildRecapBodyHtml(game, myNick, tab) + '</div></div>';
    return html;
  }

  function updateLobbyTabUi(root, tab, game, myNick) {
    if (!root) return;
    tab = setLobbyTab(tab);
    root.querySelectorAll('[data-act="lobby-tab"]').forEach(function (btn) {
      var on = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('opbac-recap__tab--on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var body = root.querySelector('[data-opbac-idle-stats]');
    if (body) body.innerHTML = buildRecapBodyHtml(game || defaultState(), myNick || '', tab);
  }

  function syncCreatedNotice(root) {
    if (!root || !root.querySelector) return;
    var host = root.querySelector('[data-opbac-create-ok]');
    if (!host) return;
    host.innerHTML = createdNotice
      ? ('<p class="opbac-create-ok">' + escHtml(createdNotice) + '</p>')
      : '';
  }

  function markModeCreated(modeId) {
    modeId = sanitizeModeId(modeId);
    if (!modeId) return;
    createdModeId = modeId;
    createdNotice = pick({
      fr: 'Votre mode « ' + modeId + ' » a été créé et est sélectionné pour le prochain lancement.',
      en: 'Your mode “' + modeId + '” was created and is selected for the next launch.',
    });
    if (pluginOrbit) {
      try { pluginOrbit.storage.set('petitbacMode', modeId); } catch (e) { /* ignore */ }
      try { pluginOrbit.notify('Petit Bac', createdNotice); } catch (e2) { /* ignore */ }
    }
    bumpStore();
    refreshPlayMenuCustom(modeId);
    var panel = document.getElementById('opbac-dom-panel');
    if (panel) {
      updateReplayModeUi(panel, modeId);
      syncCreatedNotice(panel);
    }
  }

  function rememberPickedMode(orbit, host, modeId) {
    modeId = sanitizeModeId(modeId);
    if (createdModeId && modeId !== createdModeId) {
      createdNotice = '';
      createdModeId = '';
    }
    try { if (orbit) orbit.storage.set('petitbacMode', modeId); } catch (e) { /* ignore */ }
    updateReplayModeUi(host, modeId);
    var panel = document.getElementById('opbac-dom-panel');
    if (panel && panel !== host) updateReplayModeUi(panel, modeId);
    syncCreatedNotice(host);
    if (panel) syncCreatedNotice(panel);
  }

  function buildLaunchHtml(label) {
    return '<div class="opbac-idle__launch">' +
      '<button type="button" class="opbac-idle__cta" data-act="replay">' + escHtml(label) + '</button>' +
      buildSkipRulesCheckHtml() +
      '</div>';
  }

  function buildIdleHtml(game, replayMode, myNick) {
    var stopBanner = game.stopReason
      ? ('<p class="opbac-idle__stopped">' + escHtml(game.stopReason === 'idle'
          ? pick({ fr: 'Partie arrêtée pour inactivité.', en: 'Game stopped due to inactivity.' })
          : pick({ fr: 'Partie arrêtée par un opérateur.', en: 'Game stopped by an operator.' })) +
        '</p>')
      : '';
    return '<div class="opbac-idle">' +
      stopBanner +
      buildPlayPickerHtml(replayMode, buildLaunchHtml(pick({
        fr: '▶ Lancer une partie',
        en: '▶ Start a game',
      }))) +
      buildRecapHtml(game, myNick) +
      '</div>';
  }

  function parseListeLine(body) {
    var m = String(body || '').match(
      /^•\s+([^\s→]+?)(?:\s*🔒)?(?:\s*\(actif\))?\s*→\s*(\d+)\s+cat[ée]gories?,\s*(\d+)\s+secondes?,\s*(\d+)\s+manches/i
    );
    if (!m) return null;
    var id = sanitizeModeId(m[1]);
    return {
      id: id,
      label: m[1].replace(/🔒/g, '').trim(),
      cats: Number(m[2]) || 0,
      duration: Number(m[3]) || 0,
      rounds: Number(m[4]) || 0,
      custom: !isBuiltinMode(id),
    };
  }

  function handleBacNotice(nick, text) {
    var plain = stripIrc(text).trim();
    if (!plain) return;
    var n = String(nick || '').replace(/^[@+%~&]/, '').toLowerCase();
    if (n !== 'bac' && n !== 'maitredujeu') return;
    if (handleLobbyNotice(plain)) return;
    handleModeListLine(plain);
  }

  function handleLobbyNotice(body) {
    var buf = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
      ? pluginOrbit.state.active()
      : '';
    if (!buf || !isBacChannel(pluginOrbit, buf)) return false;
    var game = getChannelState(buf) || defaultState();

    var summary = body.match(/R[eé]sum[eé] global\s*:\s*(.+)$/i);
    if (summary) {
      lobbyWaiting = true;
      patchChannel(buf, { lobbySummary: summary[1].trim(), lobbyRanking: [] });
      return true;
    }
    if (/Classement g[eé]n[eé]ral/i.test(body)) {
      lobbyWaiting = true;
      patchChannel(buf, { lobbyRanking: [] });
      return true;
    }
    var rank = body.match(/^\s*(\d+)\.\s*([^\s:]+)\s*:\s*(\d+(?:[.,]\d+)?)\s*point/i);
    if (rank && lobbyWaiting) {
      var list = (game.lobbyRanking || []).slice();
      list.push({ nick: rank[2], pts: parsePts(rank[3]) });
      list.sort(function (a, b) { return b.pts - a.pts; });
      patchChannel(buf, { lobbyRanking: list });
      return true;
    }
    if (/Aucun score/i.test(body)) {
      lobbyWaiting = false;
      patchChannel(buf, { lobbyRanking: [], lobbySummary: pick({ fr: 'Aucun score pour le moment.', en: 'No scores yet.' }) });
      return true;
    }
    if (/Historique des/i.test(body)) {
      return true;
    }
    var hist = body.match(/^\s*Partie\s+(\d+)\s*[—\-]\s*(.+)$/i);
    if (hist && lobbyWaiting) {
      var histList = (game.lobbyHistory || []).slice();
      var line = 'Partie ' + hist[1] + ' — ' + hist[2].trim();
      if (histList.indexOf(line) < 0) histList.push(line);
      patchChannel(buf, { lobbyHistory: histList.slice(0, 10) });
      return true;
    }
    if (lobbyWaiting && /^\s*[A-Za-z0-9_\[\]\\^{}|`-]+\(\d+/.test(body)) {
      var histList2 = (game.lobbyHistory || []).slice();
      if (histList2.length) {
        histList2[histList2.length - 1] += ' · ' + body.replace(/\s+/g, ' ').trim();
        patchChannel(buf, { lobbyHistory: histList2.slice(0, 10) });
      }
      if (histList2.length >= 10) lobbyWaiting = false;
      return true;
    }
    return false;
  }

  function handleModeListLine(body) {
    if (/Modes disponibles/i.test(body)) {
      waitingListe = true;
      extraModes = [];
      return true;
    }
    if (waitingListe) {
      var row = parseListeLine(body);
      if (row) {
        if (row.custom && !extraModes.some(function (x) { return x.id === row.id; })) {
          extraModes.push(row);
          bumpStore();
          refreshPlayMenuCustom();
        }
        return true;
      }
      if (/Tapez !jeu|sélectionner un mode/i.test(body)) {
        waitingListe = false;
        bumpStore();
        refreshPlayMenuCustom();
        return true;
      }
      if (/^•/.test(body)) return true;
    }
    if (/Mode personnalisé créé/i.test(body)) {
      pendingCreate = false;
      listeAt = 0;
      var me = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick
        ? String(pluginOrbit.state.nick() || '').toLowerCase()
        : '';
      if (me && sanitizeModeId(me) !== createdModeId) markModeCreated(me);
      var bufNotice = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
        ? pluginOrbit.state.active()
        : '';
      if (bufNotice) requestModeList(pluginOrbit, bufNotice, true);
      return true;
    }
    return false;
  }

  function applyModesList(tags) {
    waitingListe = false;
    extraModes = [];
    String(tagVal(tags, '+modes') || '').split(',').forEach(function (chunk) {
      var p = String(chunk || '').split(':');
      if (p.length < 4) return;
      var id = sanitizeModeId(p[0]);
      var locked = p[4] === '1';
      if (locked || isBuiltinMode(id)) return;
      extraModes.push({
        id: id,
        label: p[0],
        cats: Number(p[1]) || 0,
        duration: Number(p[2]) || 0,
        rounds: Number(p[3]) || 0,
        custom: true,
      });
    });
    bumpStore();
    refreshPlayMenuCustom();
  }

  function historyLinesFromTag(raw) {
    if (!raw) return [];
    return String(raw).split('|').map(function (chunk) {
      var i = chunk.indexOf('=');
      if (i < 0) {
        var m = chunk.match(/^(\d{2}\/\d{2}\/\d{4}_\d{2}[:_]\d{2})(?::|=)(.*)$/);
        if (m) return m[1].replace(/_/g, ' ') + (m[2] ? ' — ' + m[2].replace(/,/g, ' · ') : '');
        return chunk.replace(/_/g, ' ');
      }
      var ts = chunk.slice(0, i).replace(/_/g, ' ');
      var rest = chunk.slice(i + 1).replace(/,/g, ' · ');
      return rest ? (ts + ' — ' + rest) : ts;
    }).filter(Boolean);
  }

  function historyLineFromParts(ts, pairs) {
    var when = String(ts || '').replace(/_/g, ' ');
    var rest = String(pairs || '').replace(/,/g, ' · ');
    return rest ? (when + ' — ' + rest) : when;
  }

  function applyLobbyHist(channel, tags) {
    var line = historyLineFromParts(tagVal(tags, '+ts'), tagVal(tags, '+pairs'));
    if (!line) return;
    var game = getChannelState(channel) || defaultState();
    var list = (game.lobbyHistory || []).slice();
    var idx = Number(tagVal(tags, '+i'));
    if (idx >= 0 && idx < 10) {
      list[idx] = line;
    } else if (list.indexOf(line) < 0) {
      list.push(line);
    }
    patchChannel(channel, { lobbyHistory: list.filter(Boolean).slice(0, 10) });
    refreshDockOverlay();
  }

  function applyLobbyStats(channel, tags) {
    lobbyWaiting = false;
    var next = {
      lobbySummary: tagVal(tags, '+summary'),
      lobbyRanking: rankingFromPairs(tagVal(tags, '+ranking')),
    };
    var histTag = tagVal(tags, '+history');
    if (histTag) next.lobbyHistory = historyLinesFromTag(histTag);
    else if (tagVal(tags, '+hist_count')) next.lobbyHistory = [];
    patchChannel(channel, next);
    refreshDockOverlay();
  }

  function applyInfoResult(channel, tags) {
    var word = tagVal(tags, '+word') || (infoLookup && infoLookup.word) || '';
    var ok = tagVal(tags, '+ok') !== '0';
    var text = tagVal(tags, '+text');
    if (!ok || text === 'not_found' || text === 'invalide') {
      text = pick({
        fr: 'Aucune fiche Wikipédia trouvée pour ce mot.',
        en: 'No Wikipedia article found for this word.',
      });
    }
    infoLookup.waiting = false;
    openInfoModal(word, text, false);
  }

  function rankingFromTop(raw) {
    return String(raw || '').split(',').map(function (chunk) {
      var p = String(chunk || '').split(':');
      if (p.length < 2) return null;
      var fc = p.length > 2 ? Number(p.pop()) || 0 : 0;
      var pts = Number(p.pop()) || 0;
      var nick = p.join(':').trim();
      if (!nick) return null;
      return { nick: nick, pts: pts, fc: fc };
    }).filter(Boolean);
  }

  function applyStatResult(channel, tags) {
    var kind = tagVal(tags, '+kind') || 'global';
    var ok = tagVal(tags, '+ok') !== '0';
    var card = {
      kind: kind,
      ok: ok,
      nick: tagVal(tags, '+nick'),
      games: tagVal(tags, '+games'),
      rounds: tagVal(tags, '+rounds'),
      words: tagVal(tags, '+words'),
      combos: tagVal(tags, '+combos'),
      pts: tagVal(tags, '+pts'),
      last: tagVal(tags, '+last'),
    };
    patchChannel(channel, { statCard: card });
    refreshDockOverlay();
  }

  function applyTopResult(channel, tags) {
    patchChannel(channel, { topGlobal: rankingFromTop(tagVal(tags, '+ranking')), topLoaded: true });
    refreshDockOverlay();
  }

  function buildCustomModesHtml(selectedMode) {
    selectedMode = sanitizeModeId(selectedMode);
    if (!extraModes.length) {
      return '<p class="opbac-customs__empty">' + escHtml(pick({
        fr: waitingListe
          ? 'Chargement des jeux personnalisés…'
          : 'Aucun jeu personnalisé pour le moment.',
        en: waitingListe
          ? 'Loading custom games…'
          : 'No custom games yet.',
      })) + '</p>';
    }
    return extraModes.map(function (m) {
      var on = m.id === selectedMode;
      return '<button type="button" class="opbac-custom' + (on ? ' opbac-custom--on' : '') +
        '" data-act="pick-mode" data-mode="' + escHtml(m.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="opbac-custom__name">✨ ' + escHtml(m.label || m.id) + '</span>' +
        '<span class="opbac-custom__hint">' + escHtml(modeHint(m)) + '</span></button>';
    }).join('');
  }

  function buildCreateModeHtml() {
    return '<div class="opbac-create">' +
      '<label>' + escHtml(pick({ fr: 'Catégories', en: 'Categories' })) +
        '<input type="number" min="3" max="30" value="5" data-create-cats></label>' +
      '<label>' + escHtml(pick({ fr: 'Secondes', en: 'Seconds' })) +
        '<input type="number" min="10" max="300" value="40" data-create-dur></label>' +
      '<label>' + escHtml(pick({ fr: 'Manches', en: 'Rounds' })) +
        '<input type="number" min="1" max="50" value="12" data-create-rounds></label>' +
      '</div>' +
      '<button type="button" class="opbac-create__btn" data-act="create-mode">' +
        escHtml(pick({ fr: '✨ Créer mon jeu', en: '✨ Create my game' })) +
      '</button>' +
      '<p class="opbac-play-note">' + escHtml(pick({
        fr: 'Enregistré sous votre pseudo, puis sélectionné pour le prochain lancement.',
        en: 'Saved under your nick, then selected for the next launch.',
      })) + '</p>' +
      '<div data-opbac-create-ok>' +
        (createdNotice ? ('<p class="opbac-create-ok">' + escHtml(createdNotice) + '</p>') : '') +
      '</div>';
  }

  function buildPlayPickerHtml(selectedMode, launchHtml, allowCreate) {
    selectedMode = sanitizeModeId(selectedMode);
    if (allowCreate == null) allowCreate = true;
    var cards = gameModeOptions().map(function (m) {
      var on = m.id === selectedMode;
      return '<button type="button" class="opbac-mode' + (on ? ' opbac-mode--on' : '') + '" data-act="pick-mode" data-mode="' +
        escHtml(m.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="opbac-mode__emoji" aria-hidden="true">' + m.emoji + '</span>' +
        '<span class="opbac-mode__label">' + escHtml(m.label) + '</span>' +
        '<span class="opbac-mode__hint">' + escHtml(m.hint) + '</span></button>';
    }).join('');
    return '<div class="opbac-playpick" data-opbac-playpick>' +
      '<div class="opbac-setup' + (allowCreate ? '' : ' opbac-setup--solo') + '">' +
        '<div class="opbac-setup__modes">' +
          '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Modes disponibles', en: 'Available modes' })) + '</p>' +
          '<div class="opbac-modes" role="group" aria-label="' + escHtml(pick({ fr: 'Niveau du jeu', en: 'Game level' })) + '">' +
            cards + '</div>' +
          '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Jeux personnalisés', en: 'Custom games' })) + '</p>' +
          '<div class="opbac-customs" data-opbac-customs>' + buildCustomModesHtml(selectedMode) + '</div>' +
        '</div>' +
        (allowCreate
          ? ('<div class="opbac-setup__create">' +
              '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Créer mon jeu', en: 'Create my game' })) + '</p>' +
              buildCreateModeHtml() +
            '</div>')
          : '') +
      '</div>' +
      (launchHtml || '') +
    '</div>';
  }

  function refreshPlayMenuCustom(selectId) {
    var overlay = document.getElementById('opbac-play-overlay');
    var hosts = [];
    if (overlay) hosts.push(overlay);
    var panel = document.getElementById('opbac-dom-panel');
    if (panel) hosts.push(panel);
    var selected = selectId || (panel && panel.__opbacReplayMode) || '';
    hosts.forEach(function (host) {
      var wrap = host.querySelector('[data-opbac-customs]');
      if (wrap) wrap.innerHTML = buildCustomModesHtml(selected);
      if (selectId) updateReplayModeUi(host, selectId);
      syncCreatedNotice(host);
      var modeDd = host.querySelector('[data-opbac-mode-dd]');
      if (modeDd) {
        var gameHost = pluginOrbit && pluginOrbit.state && pluginOrbit.state.active
          ? (getChannelState(pluginOrbit.state.active()) || defaultState())
          : defaultState();
        modeDd.innerHTML = buildModeMenuInnerHtml(selectId || gameHost.mode || selected);
      }
    });
  }

  function bindPlayOverlay(orbit, overlay) {
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) { closeOverlayModal('play'); return; }
      if (ev.target.closest && ev.target.closest('[data-act="close-overlay"]')) {
        closeOverlayModal('play');
        return;
      }
      var buffer = orbit.state.active();
      if (!buffer) return;
      var pickBtn = ev.target.closest ? ev.target.closest('[data-act="pick-mode"]') : null;
      if (pickBtn) {
        rememberPickedMode(orbit, overlay, pickBtn.getAttribute('data-mode'));
        return;
      }
      var createBtn = ev.target.closest ? ev.target.closest('[data-act="create-mode"]') : null;
      if (createBtn) {
        sendCreateMode(orbit, buffer, overlay);
        return;
      }
      var launchBtn = ev.target.closest ? ev.target.closest('[data-act="replay"]') : null;
      if (launchBtn) {
        var panelRoot = document.getElementById('opbac-dom-panel') || overlay;
        startReplayGame(orbit, buffer, panelRoot);
        closeOverlayModal('play');
      }
    });
  }

  function openPlayMenu(orbit) {
    closeOverlayModal('play');
    var buffer = orbit.state.active();
    requestModeList(orbit, buffer);
    var selected = defaultReplayMode(getChannelState(buffer), document.getElementById('opbac-dom-panel'), orbit);
    var title = pick({ fr: 'Choisir un niveau', en: 'Choose a level' });
    var overlay = document.createElement('div');
    overlay.id = 'opbac-play-overlay';
    overlay.className = 'opbac-help-overlay';
    overlay.innerHTML =
      '<div class="opbac-help-dialog" role="dialog" aria-modal="true" aria-label="' + escHtml(title) + '">' +
        '<div class="opbac-help-dialog__head">' +
          '<h3>' + imgHtml('logo.svg', '', 'opbac-help-dialog__logo') + escHtml(title) + '</h3>' +
          '<button type="button" class="opbac-help-dialog__x" data-act="close-overlay" aria-label="' +
            escHtml(pick({ fr: 'Fermer', en: 'Close' })) + '">✕</button>' +
        '</div>' +
        '<div class="opbac-help-dialog__body">' +
          '<p class="opbac-replay__sub">' + escHtml(pick({
            fr: canCreateGameMode(getChannelState(buffer) || defaultState())
              ? 'Choisissez un niveau officiel, un jeu personnalisé, ou créez le vôtre.'
              : 'Choisissez un niveau. La création d’un mode n’est possible qu’entre deux parties.',
            en: canCreateGameMode(getChannelState(buffer) || defaultState())
              ? 'Pick an official level, a custom game, or create your own.'
              : 'Pick a level. You can create a mode only between games.',
          })) + '</p>' +
          buildPlayPickerHtml(selected, buildLaunchHtml(pick({
            fr: '▶ Lancer la partie',
            en: '▶ Start the game',
          })), canCreateGameMode(getChannelState(buffer) || defaultState())) +
        '</div></div>';
    bindPlayOverlay(orbit, overlay);
    playEscHandler = function (ev) {
      if (ev.key === 'Escape') closeOverlayModal('play');
    };
    document.addEventListener('keydown', playEscHandler);
    document.body.appendChild(overlay);
    bindSkipRulesUi(overlay, orbit);
  }

  function sendCreateMode(orbit, buffer, host) {
    var game = getChannelState(buffer) || defaultState();
    if (!canCreateGameMode(game)) {
      try {
        orbit.notify('Petit Bac', pick({
          fr: 'La création d’un mode n’est possible que lorsque la partie est arrêtée ou terminée.',
          en: 'You can only create a mode when the game is stopped or over.',
        }));
      } catch (e0) { /* ignore */ }
      return;
    }
    var catsEl = host.querySelector('[data-create-cats]');
    var durEl = host.querySelector('[data-create-dur]');
    var roundsEl = host.querySelector('[data-create-rounds]');
    var cats = Math.max(3, Math.min(30, Number(catsEl && catsEl.value) || 5));
    var dur = Math.max(10, Math.min(300, Number(durEl && durEl.value) || 40));
    var rounds = Math.max(1, Math.min(50, Number(roundsEl && roundsEl.value) || 12));
    pendingCreate = true;
    sendPbCmd(orbit, buffer, 'jeu', 'creer ' + cats + ' ' + dur + ' ' + rounds);
    try {
      orbit.notify('Petit Bac', pick({
        fr: 'Création du jeu ' + cats + ' cat. / ' + dur + ' s / ' + rounds + ' manches…',
        en: 'Creating game ' + cats + ' cat. / ' + dur + ' s / ' + rounds + ' rounds…',
      }));
    } catch (e) { /* ignore */ }
  }

  function buildFeedbackBlockHtml() {
    return '<div class="opbac-feedback">' +
      '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Votre avis', en: 'Your feedback' })) + '</h3>' +
      '<p class="opbac-feedback__lead">' + escHtml(pick({
        fr: 'Un bug, une idée, une amélioration ? Dites-le-nous — ça n’apparaît pas dans le tchat.',
        en: 'A bug, an idea, an improvement? Tell us — it stays out of chat.',
      })) + '</p>' +
      '<div class="opbac-feedback__acts">' +
        '<button type="button" class="opbac-end__btn opbac-end__btn--ghost" data-act="suggest">✏️ ' +
          escHtml(pick({ fr: 'Proposer une amélioration', en: 'Suggest an improvement' })) + '</button>' +
        '<button type="button" class="opbac-end__btn opbac-end__btn--ghost" data-act="bug">🐞 ' +
          escHtml(pick({ fr: 'Signaler un bug', en: 'Report a bug' })) + '</button>' +
      '</div></div>';
  }

  function feedbackStatusEl() {
    var overlay = document.getElementById('opbac-feedback-overlay');
    return overlay ? overlay.querySelector('[data-opbac-fb-status]') : null;
  }

  function setFeedbackStatus(text, isErr) {
    var el = feedbackStatusEl();
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'opbac-fb-form__status' + (isErr ? ' opbac-fb-form__status--err' : ' opbac-fb-form__status--ok');
  }

  function applyFeedbackResult(ok, kind, code) {
    if (feedbackPending && feedbackPending.timer) {
      try { clearTimeout(feedbackPending.timer); } catch (e) { /* ignore */ }
      feedbackPending.timer = null;
    }
    var msg;
    if (ok) {
      msg = kind === 'bug'
        ? pick({ fr: 'Merci, le bug a bien été signalé.', en: 'Thanks, the bug has been reported.' })
        : pick({ fr: 'Merci, ta suggestion a bien été enregistrée.', en: 'Thanks, your suggestion has been saved.' });
      setFeedbackStatus(msg, false);
      try { if (pluginOrbit) pluginOrbit.notify('Petit Bac', msg); } catch (e2) { /* ignore */ }
      setTimeout(function () { closeOverlayModal('feedback'); }, 700);
      return;
    }
    if (code === 'empty') {
      msg = pick({ fr: 'Écris un message avant d’envoyer.', en: 'Write a message before sending.' });
    } else if (code === 'need_played') {
      msg = pick({
        fr: 'Il faut avoir joué au moins une partie pour envoyer un avis.',
        en: 'You need to have played at least one game to send feedback.',
      });
    } else if (code === 'unknown') {
      msg = pick({
        fr: 'Le bot n’a pas reconnu la commande. Recharge le plugin PetitBac, puis réessaie.',
        en: 'The bot did not recognize the command. Reload the PetitBac plugin, then try again.',
      });
    } else {
      msg = pick({ fr: 'Envoi impossible. Réessaie dans un instant.', en: 'Could not send. Try again in a moment.' });
    }
    setFeedbackStatus(msg, true);
    var sendBtn = document.querySelector('#opbac-feedback-overlay [type="submit"]');
    if (sendBtn) sendBtn.disabled = false;
    try { if (pluginOrbit) pluginOrbit.notify('Petit Bac', msg); } catch (e3) { /* ignore */ }
  }

  function openFeedbackModal(orbit, buffer, kind) {
    kind = kind === 'bug' ? 'bug' : 'suggestion';
    if (!orbit || !buffer) return;
    closeOverlayModal('feedback');
    var title = kind === 'bug'
      ? pick({ fr: 'Signaler un bug', en: 'Report a bug' })
      : pick({ fr: 'Proposer une amélioration', en: 'Suggest an improvement' });
    var hint = kind === 'bug'
      ? pick({
        fr: 'Décris ce qui ne va pas (quand, où, ce que tu attendais). L’équipe le reçoit sans passer par le tchat.',
        en: 'Describe what went wrong (when, where, what you expected). The team receives it without going through chat.',
      })
      : pick({
        fr: 'Une idée, un avis, une catégorie à ajouter… Ton message est envoyé à l’équipe.',
        en: 'An idea, some feedback, a category to add… Your message goes to the team.',
      });
    var placeholder = kind === 'bug'
      ? pick({ fr: 'Ex. : le tableau live ne se met pas à jour…', en: 'E.g. the live board does not update…' })
      : pick({ fr: 'Ex. : ajouter une catégorie Fleurs…', en: 'E.g. add a Flowers category…' });
    var overlay = document.createElement('div');
    overlay.id = 'opbac-feedback-overlay';
    overlay.className = 'opbac-help-overlay';
    overlay.innerHTML =
      '<div class="opbac-help-dialog" role="dialog" aria-modal="true" aria-label="' + escHtml(title) + '">' +
        '<div class="opbac-help-dialog__head">' +
          '<h3>' + imgHtml('logo.svg', '', 'opbac-help-dialog__logo') + escHtml(title) + '</h3>' +
          '<button type="button" class="opbac-help-dialog__x" data-act="close-overlay" aria-label="' +
            escHtml(pick({ fr: 'Fermer', en: 'Close' })) + '">✕</button>' +
        '</div>' +
        '<div class="opbac-help-dialog__body">' +
          '<form class="opbac-fb-form" data-opbac-fb>' +
            '<p class="opbac-fb-form__hint">' + escHtml(hint) + '</p>' +
            '<textarea name="msg" maxlength="350" rows="5" required placeholder="' + escHtml(placeholder) + '"></textarea>' +
            '<p class="opbac-fb-form__status" data-opbac-fb-status hidden></p>' +
            '<div class="opbac-fb-form__row">' +
              '<button type="submit" class="opbac-end__btn opbac-end__btn--primary">' +
                escHtml(pick({ fr: 'Envoyer', en: 'Send' })) + '</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeOverlayModal('feedback');
      var closeBtn = ev.target && ev.target.closest ? ev.target.closest('[data-act="close-overlay"]') : null;
      if (closeBtn) closeOverlayModal('feedback');
    });
    overlay.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var ta = overlay.querySelector('textarea');
      var text = ta ? String(ta.value || '').trim() : '';
      if (!text) {
        setFeedbackStatus(pick({ fr: 'Écris un message avant d’envoyer.', en: 'Write a message before sending.' }), true);
        return;
      }
      var btn = overlay.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      setFeedbackStatus(pick({ fr: 'Envoi…', en: 'Sending…' }), false);
      if (feedbackPending && feedbackPending.timer) {
        try { clearTimeout(feedbackPending.timer); } catch (e4) { /* ignore */ }
      }
      feedbackPending = {
        kind: kind,
        timer: setTimeout(function () {
          applyFeedbackResult(false, kind, 'timeout');
        }, 8000),
      };
      sendPbCmd(orbit, buffer, kind, text.slice(0, 350));
    });
    feedbackEscHandler = function (ev) {
      if (ev.key === 'Escape') closeOverlayModal('feedback');
    };
    document.addEventListener('keydown', feedbackEscHandler);
    document.body.appendChild(overlay);
    var taFocus = overlay.querySelector('textarea');
    if (taFocus) {
      try { taFocus.focus(); } catch (e5) { /* ignore */ }
    }
  }

  function buildReplaySectionHtml(selectedMode) {
    selectedMode = sanitizeModeId(selectedMode);
    return '<div class="opbac-replay" data-opbac-replay>' +
      '<h3 class="opbac-replay__q">' + escHtml(pick({ fr: 'Une nouvelle partie ?', en: 'Play again?' })) + '</h3>' +
      '<p class="opbac-replay__sub">' + escHtml(pick({
        fr: 'Choisissez un niveau, un jeu personnalisé, ou créez le vôtre.',
        en: 'Choose a level, a custom game, or create your own.',
      })) + '</p>' +
      buildPlayPickerHtml(selectedMode, buildLaunchHtml(pick({
        fr: '▶ Oui, lancer une partie',
        en: '▶ Yes, start a game',
      }))) +
      '</div>';
  }

  function startReplayGame(orbit, buffer, root) {
    var mode = defaultReplayMode(null, root, orbit);
    try { orbit.storage.set('petitbacMode', mode); } catch (e) { /* ignore */ }
    if (root) setViewMode(orbit, root, VIEW_FULL);
    sendPbCmd(orbit, buffer, 'jeu', mode);
    window.setTimeout(function () {
      sendJouerCmd(orbit, buffer);
    }, 350);
    try {
      orbit.notify('Petit Bac', pick({
        fr: 'Partie ' + mode + ' en cours de lancement…',
        en: 'Starting ' + mode + ' game…',
      }));
    } catch (e2) { /* ignore */ }
  }

  function updateReplayModeUi(root, mode) {
    if (!root) return;
    mode = sanitizeModeId(mode);
    root.__opbacReplayMode = mode;
    var buttons = root.querySelectorAll('[data-act="pick-mode"]');
    buttons.forEach(function (btn) {
      var on = String(btn.getAttribute('data-mode') || '').toLowerCase() === mode;
      btn.classList.toggle('opbac-mode--on', on && btn.classList.contains('opbac-mode'));
      btn.classList.toggle('opbac-custom--on', on && btn.classList.contains('opbac-custom'));
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function buildHelpCmdRow(cmd, desc) {
    return '<div class="opbac-help-cmd">' +
      '<code class="opbac-help-cmd__k">' + escHtml(cmd) + '</code>' +
      '<span class="opbac-help-cmd__d">' + escHtml(desc) + '</span></div>';
  }

  function buildHelpHtml(orbit) {
    var buffer = orbit.state.active();
    var isOp = buffer ? isChannelOp(orbit, buffer) : false;
    var steps = helpHowToPlay().map(function (line) {
      return '<li>' + escHtml(line) + '</li>';
    }).join('');
    var cmdRows = helpPlayerCommands().map(function (row) {
      return buildHelpCmdRow(row.cmd, row.desc);
    }).join('');
    var modeCards = gameModeOptions().map(function (m) {
      return '<div class="opbac-help-mode">' +
        '<span class="opbac-help-mode__emoji" aria-hidden="true">' + m.emoji + '</span>' +
        '<strong>' + escHtml(m.label) + '</strong>' +
        '<span>' + escHtml(m.hint) + '</span></div>';
    }).join('');
    var opBlock = isOp
      ? ('<section class="opbac-help-sec">' +
          '<h4 class="opbac-help-sec__h">🔧 ' + escHtml(pick({ fr: 'Commandes opérateur', en: 'Operator commands' })) + '</h4>' +
          '<div class="opbac-help-cmds">' +
            buildHelpCmdRow('!stop', pick({ fr: 'Arrête la partie en cours', en: 'Stop the current game' })) +
            buildHelpCmdRow('!scores reset', pick({ fr: 'Réinitialise les scores du salon', en: 'Reset channel scores' })) +
            buildHelpCmdRow('!bac config', pick({ fr: 'Affiche ou modifie la configuration du jeu', en: 'Show or edit game configuration' })) +
          '</div>' +
          '<p class="opbac-help-sec__note">' + escHtml(pick({
            fr: 'Gestion avancée des mots et catégories : !bac mots … (réservé aux ops).',
            en: 'Advanced words/categories management: !bac mots … (ops only).',
          })) + '</p></section>')
      : '';

    return '<div class="opbac-help">' +
      '<p class="opbac-help-intro">' + escHtml(pick({
        fr: 'Trouvez un mot par catégorie commençant par la lettre tirée. Répondez dans la grille du panneau ou dans le tchat.',
        en: 'Find one word per category starting with the drawn letter. Answer in the panel grid or in chat.',
      })) + '</p>' +
      '<section class="opbac-help-sec">' +
        '<h4 class="opbac-help-sec__h">🎯 ' + escHtml(pick({ fr: 'Comment jouer', en: 'How to play' })) + '</h4>' +
        '<ol class="opbac-help-steps">' + steps + '</ol>' +
      '</section>' +
      '<section class="opbac-help-sec">' +
        '<h4 class="opbac-help-sec__h">🎮 ' + escHtml(pick({ fr: 'Niveaux de jeu', en: 'Game levels' })) + '</h4>' +
        '<div class="opbac-help-modes">' + modeCards + '</div>' +
        '<p class="opbac-help-sec__note">' + escHtml(pick({
          fr: 'Au lancement ou en fin de partie : choisissez Facile, Moyen ou Difficile puis confirmez.',
          en: 'When starting or after a game: pick Easy, Medium or Hard then confirm.',
        })) + '</p>' +
      '</section>' +
      '<section class="opbac-help-sec">' +
        '<h4 class="opbac-help-sec__h">⌨️ ' + escHtml(pick({ fr: 'Commandes utiles', en: 'Useful commands' })) + '</h4>' +
        '<div class="opbac-help-cmds">' + cmdRows + '</div>' +
      '</section>' +
      opBlock +
      '<p class="opbac-help-foot">' + escHtml(pick({
        fr: '💡 Les scores live s\'affichent à droite pendant la manche. Mot refusé ? Bouton « Vérifier » ou !verifier <catégorie> <mot>.',
        en: '💡 Live scores appear on the right during the round. Word rejected? Use Verify or !verifier <category> <word>.',
      })) + '</p></div>';
  }

  function closeHelpModal() {
    if (helpModalClose) {
      try { helpModalClose(); } catch (e) { /* ignore */ }
      helpModalClose = null;
    }
    if (helpEscHandler) {
      document.removeEventListener('keydown', helpEscHandler);
      helpEscHandler = null;
    }
    var dom = document.getElementById('opbac-help-overlay');
    if (dom) dom.remove();
  }

  function openHelpModal(orbit) {
    closeHelpModal();
    var bodyHtml = buildHelpHtml(orbit);
    var title = pick({ fr: 'Aide du Petit Bac', en: 'Petit Bac help' });

    if (typeof orbit.modal === 'function') {
      helpModalClose = orbit.modal(function () {
        return h('div', {
          className: 'opbac-help-wrap',
          dangerouslySetInnerHTML: { __html: bodyHtml },
        });
      }, { title: title, wide: true });
      return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'opbac-help-overlay';
    overlay.className = 'opbac-help-overlay';
    overlay.innerHTML =
      '<div class="opbac-help-dialog" role="dialog" aria-modal="true" aria-label="' + escHtml(title) + '">' +
        '<div class="opbac-help-dialog__head">' +
          '<h3>' + imgHtml('logo.svg', '', 'opbac-help-dialog__logo') + escHtml(title) + '</h3>' +
          '<button type="button" class="opbac-help-dialog__x" data-act="close-help" aria-label="' +
            escHtml(pick({ fr: 'Fermer', en: 'Close' })) + '">✕</button>' +
        '</div>' +
        '<div class="opbac-help-dialog__body">' + bodyHtml + '</div>' +
      '</div>';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeHelpModal();
      var closeBtn = ev.target && ev.target.closest ? ev.target.closest('[data-act="close-help"]') : null;
      if (closeBtn) closeHelpModal();
    });
    helpEscHandler = function (ev) {
      if (ev.key === 'Escape') closeHelpModal();
    };
    document.addEventListener('keydown', helpEscHandler);
    document.body.appendChild(overlay);
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
      sendJouerCmd(orbit, buffer);
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
                  ? pick({ fr: 'Classement final de la partie', en: 'Final game ranking' })
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
              onClick: function () { openHelpModal(orbit); },
            }, pick({ fr: 'Aide', en: 'Help' })),
            h('button', {
              type: 'button',
              className: 'opbac-foot__btn opbac-foot__btn--primary',
              onClick: playAgain,
            }, pick({ fr: 'Rejouer', en: 'Play again' })))
          : null
    );
  }

  function allCategoriesValidated(channel, game) {
    if (!game || !game.categories || !game.categories.length) return false;
    var draft = getDraft(channel, game);
    return game.categories.every(function (cat) {
      var k = cat.toLowerCase();
      return draft.validated[k] || draft.validated[cat];
    });
  }

  function buildCompleteBannerHtml(game) {
    var rk = roundKey(game);
    var isFullCombo = game.fullComboNick && game.fullComboRound === rk;
    if (isFullCombo) {
      return '<div class="opbac-complete opbac-complete--combo" data-opbac-complete role="status" aria-live="polite">' +
        '<span class="opbac-complete__fire" aria-hidden="true">🔥</span>' +
        '<span class="opbac-complete__title">' +
          escHtml(pick({ fr: 'Full combo !', en: 'Full combo!' })) +
        '</span>' +
        '<span class="opbac-complete__sub">' +
          escHtml(pick({
            fr: 'Toutes les catégories validées — bonus +1 pt pour ' + game.fullComboNick + ' !',
            en: 'All categories validated — +1 pt bonus for ' + game.fullComboNick + '!',
          })) +
        '</span></div>';
    }
    return '<div class="opbac-complete" data-opbac-complete role="status" aria-live="polite">' +
      imgHtml('complete.svg', pick({ fr: 'Grille complète', en: 'Grid complete' }), 'opbac-complete__img') +
      '<span class="opbac-complete__title">' +
        escHtml(pick({ fr: 'Grille complète !', en: 'Grid complete!' })) +
      '</span>' +
      '<span class="opbac-complete__sub">' +
        escHtml(pick({
          fr: 'Toutes vos catégories sont validées — bravo !',
          en: 'All your categories are validated — well done!',
        })) +
      '</span></div>';
  }

  function triggerCompleteCelebration(root) {
    root.classList.add('opbac-panel--complete');
  }

  function syncCompleteCelebration(root, buffer, game) {
    if (!game || !game.categories || !game.categories.length) {
      root.classList.remove('opbac-panel--complete');
      return false;
    }
    var rk = roundKey(game);
    var gridComplete = allCategoriesValidated(buffer, game);
    var fullCombo = !!(game.fullComboNick && game.fullComboRound === rk);
    var complete = gridComplete || fullCombo;
    if (complete) {
      if (root.__opbacCompleteRound !== rk) {
        root.__opbacCompleteRound = rk;
        triggerCompleteCelebration(root);
      } else {
        root.classList.add('opbac-panel--complete');
      }
      return true;
    }
    if (root.__opbacCompleteRound === rk) root.__opbacCompleteRound = '';
    root.classList.remove('opbac-panel--complete');
    return false;
  }

  function parseHistoryLine(line) {
    var s = String(line || '').trim();
    var when = '';
    var rest = s;
    var split = s.split(/\s+[—–]\s+/);
    if (split.length < 2) split = s.split(/\s+-\s+/);
    if (split.length >= 2 && /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(split[0])) {
      when = split[0].trim();
      rest = split.slice(1).join(' - ');
    }
    var players = [];
    String(rest || '').split(/\s*[·•,]\s*|\s+-\s+/).forEach(function (chunk) {
      var m = String(chunk || '').trim().match(/^(.+?)[:\s]+(\d+(?:[.,]\d+)?)\s*$/);
      if (!m) return;
      players.push({ nick: m[1].trim(), pts: parsePts(m[2]) });
    });
    players.sort(function (a, b) { return b.pts - a.pts; });
    return { when: when, players: players, raw: s };
  }

  function parseLobbySummary(text) {
    var s = String(text || '').trim();
    var games = s.match(/(\d+)\s*partie/i);
    var players = s.match(/(\d+)\s*joueur/i);
    return {
      games: games ? games[1] : '',
      players: players ? players[1] : '',
      raw: s,
    };
  }

  function buildSummaryChipsHtml(text) {
    var info = parseLobbySummary(text);
    if (info.games || info.players) {
      var html = '<div class="opbac-sum">';
      if (info.games) {
        html += '<div class="opbac-sum__chip"><span class="opbac-sum__n">' + escHtml(info.games) + '</span>' +
          '<span class="opbac-sum__l">' + escHtml(pick({ fr: 'parties', en: 'games' })) + '</span></div>';
      }
      if (info.players) {
        html += '<div class="opbac-sum__chip"><span class="opbac-sum__n">' + escHtml(info.players) + '</span>' +
          '<span class="opbac-sum__l">' + escHtml(pick({ fr: 'joueurs', en: 'players' })) + '</span></div>';
      }
      return html + '</div>';
    }
    if (!info.raw) return '';
    return '<div class="opbac-idle__stats-card"><p class="opbac-idle__stats-sum">' + escHtml(info.raw) + '</p></div>';
  }

  function buildHistoryHtml(lines, myNick) {
    if (!lines || !lines.length) return '';
    return '<div class="opbac-hist">' + lines.map(function (line) {
      var g = parseHistoryLine(line);
      if (!g.players.length) {
        return '<article class="opbac-hist__card"><p class="opbac-hist__raw">' + escHtml(g.raw) + '</p></article>';
      }
      var players = g.players.map(function (p, i) {
        var isMe = myNick && String(p.nick).toLowerCase() === String(myNick).toLowerCase();
        return '<span class="opbac-hist__p' + (i === 0 ? ' opbac-hist__p--win' : '') + '">' +
          (i === 0 ? '🏆 ' : '') +
          '<span class="opbac-hist__p-nick">' + escHtml(p.nick) + (isMe ? ' ★' : '') + '</span>' +
          '<span class="opbac-hist__p-pts">' + ptsHtml(p.pts) + '</span></span>';
      }).join('');
      return '<article class="opbac-hist__card">' +
        (g.when ? '<time class="opbac-hist__when">' + escHtml(g.when) + '</time>' : '') +
        '<div class="opbac-hist__players">' + players + '</div></article>';
    }).join('') + '</div>';
  }

  function buildPodiumHtml(rows, myNick) {
    if (!rows || rows.length < 2) return '';
    var count = Math.min(3, rows.length);
    var html = '<div class="opbac-podium' + (count === 2 ? ' opbac-podium--2' : '') + '">';
    for (var i = 0; i < count; i++) {
      var row = rows[i];
      var isMe = myNick && String(row.nick).toLowerCase() === String(myNick).toLowerCase();
      html += '<div class="opbac-podium__slot opbac-podium__slot--' + (i + 1) + '">' +
        '<span class="opbac-podium__medal">' + rankMedal(i) + '</span>' +
        '<span class="opbac-podium__nick">' + escHtml(row.nick) +
          (isMe ? ' ' + escHtml(pick({ fr: '(vous)', en: '(you)' })) : '') + '</span>' +
        '<span class="opbac-podium__pts">' + ptsHtml(row.pts) + '</span></div>';
    }
    return html + '</div>';
  }

  function buildRankingTableHtml(rows, myNick) {
    if (!rows || !rows.length) {
      return '<p class="opbac-end__empty">' + refreshSpinnerHtml() + escHtml(pick({
        fr: 'Scores en cours de publication…',
        en: 'Scores being published…',
      })) + '</p>';
    }
    var body = rows.map(function (row, i) {
      var isMe = myNick && String(row.nick).toLowerCase() === String(myNick).toLowerCase();
      var place = i < 3 ? ' opbac-rank__row--' + (i + 1) : '';
      var medal = i < 3
        ? '<span class="opbac-rank__medal">' + rankMedal(i) + '</span>'
        : '<span class="opbac-rank__n">' + escHtml(String(i + 1)) + '</span>';
      return '<div class="opbac-rank__row' + place + (isMe ? ' opbac-rank__row--me' : '') + '">' +
        medal +
        '<span class="opbac-rank__nick">' + escHtml(row.nick) +
          (isMe ? '<span class="opbac-rank__you">' + escHtml(pick({ fr: '(vous)', en: '(you)' })) + '</span>' : '') +
        '</span>' +
        '<span class="opbac-rank__pts">' + ptsHtml(row.pts) + '</span></div>';
    }).join('');
    return '<div class="opbac-rank">' + body + '</div>';
  }

  function endScreenSignature(game) {
    if (!game) return '';
    return [
      game.phase,
      game.round,
      game.totalRounds,
      JSON.stringify(game.finalRanking || []),
      JSON.stringify(game.scores || {}),
      JSON.stringify(game.roundScores || {}),
      JSON.stringify(game.topGlobal || []),
      JSON.stringify(game.serverRecords || []),
    ].join('|');
  }

  function endHeroVisualHtml(game, isGameEnd) {
    var finalRows = isGameEnd ? rankingForDisplay(game, true) : rankingForDisplay(game, false);
    var roundRows = isGameEnd ? [] : roundScoresList(game);
    var pending = isGameEnd ? !finalRows.length : (!roundRows.length && !finalRows.length);
    if (pending) return refreshSpinnerHtml('opbac-end__refresh');
    if (isGameEnd) {
      return imgHtml('trophy.svg', pick({ fr: 'Partie terminée', en: 'Game over' }), 'opbac-end__illus');
    }
    return imgHtml('round-end.svg', pick({ fr: 'Fin de manche', en: 'Round over' }), 'opbac-end__illus');
  }

  function buildEndScreenHtml(game, myNick, selectedMode, animate) {
    var isGameEnd = game.phase === 'game_end';
    var html = '<div class="opbac-end' + (animate ? ' opbac-end--enter' : '') + '" data-opbac-end role="status" aria-live="polite">';

    if (isGameEnd) {
      html += '<div class="opbac-end__hero opbac-end__hero--game">' +
        endHeroVisualHtml(game, true) +
        '<p class="opbac-end__title">' + escHtml(pick({ fr: 'Partie terminée !', en: 'Game over!' })) + '</p>' +
        '<p class="opbac-end__sub">' +
          escHtml(game.totalRounds
            ? pick({
              fr: 'Classement final de la partie · ' + game.totalRounds + ' manche' + (game.totalRounds > 1 ? 's' : ''),
              en: 'Final game ranking · ' + game.totalRounds + ' round' + (game.totalRounds > 1 ? 's' : ''),
            })
            : pick({ fr: 'Classement final de la partie', en: 'Final game ranking' })) +
        '</p></div>';

      html += '<div class="opbac-end__block">' +
        '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Classement final de la partie', en: 'Final game ranking' })) + '</h3>' +
        buildPodiumHtml(rankingForDisplay(game, true), myNick) +
        buildRankingTableHtml(rankingForDisplay(game, true), myNick) +
        '</div>';

      html += '<div class="opbac-end__split">' +
        '<div class="opbac-end__block">' +
          '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Top joueurs (global)', en: 'Top players (global)' })) + '</h3>' +
          (game.topGlobal && game.topGlobal.length
            ? buildRankingTableHtml(game.topGlobal, myNick)
            : ('<p class="opbac-end__empty">' + escHtml(pick({
              fr: 'Aucun classement global pour le moment.',
              en: 'No global ranking yet.',
            })) + '</p>')) +
        '</div>' +
        '<div class="opbac-end__block">' +
          '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Records du serveur', en: 'Server records' })) + '</h3>' +
          buildRecordsHtml(game.serverRecords) +
        '</div></div>';
    } else {
      html += '<div class="opbac-end__hero opbac-end__hero--round">' +
        endHeroVisualHtml(game, false) +
        '<p class="opbac-end__title">' + escHtml(pick({ fr: 'Fin de manche', en: 'Round over' })) + '</p>' +
        '<p class="opbac-end__sub">' +
          escHtml(game.round && game.totalRounds
            ? pick({ fr: 'Manche ', en: 'Round ' }) + game.round + ' / ' + game.totalRounds
            : pick({ fr: 'Scores de la manche et cumul', en: 'Round and cumulative scores' })) +
        '</p></div>';

      var roundRows = roundScoresList(game);
      if (roundRows.length) {
        html += '<div class="opbac-end__block">' +
          '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Points de la manche', en: 'Round points' })) + '</h3>' +
          buildRankingTableHtml(roundRows, myNick) +
          '</div>';
      }

      html += '<div class="opbac-end__block">' +
        '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Scores cumulés', en: 'Cumulative scores' })) + '</h3>' +
        buildRankingTableHtml(rankingForDisplay(game, false), myNick) +
        '</div>';
    }

    if (isGameEnd) {
      html += buildFeedbackBlockHtml();
      html += buildReplaySectionHtml(selectedMode);
      html += '<p class="opbac-end__chat-hint">' +
        '<button type="button" class="opbac-end__chat-btn" data-act="collapse">' +
          escHtml(pick({ fr: '↩ Revoir le tchat', en: '↩ Show chat' })) +
        '</button></p>';
    } else if (game.round && game.totalRounds && game.round < game.totalRounds) {
      html += '<div class="opbac-end__wait" role="status" aria-live="polite">' +
        refreshSpinnerHtml() +
        '<p class="opbac-end__wait-txt">' +
          escHtml(pick({
            fr: 'Préparation de la manche suivante…',
            en: 'Preparing the next round…',
          })) +
        '</p></div>';
    }

    html += '</div>';
    return html;
  }

  function buildFormHtml(channel, game) {
    if (!game || !game.categories || !game.categories.length || !game.letter) return '';
    var canAnswer = game.phase === 'playing'
      || (game.phase !== 'game_end' && game.phase !== 'idle' && game.phase !== 'round_end');
    if (!canAnswer) return '';
    var draft = getDraft(channel, game);
    var letter = game.letter || '';
    var sendLbl = pick({ fr: 'Envoyer', en: 'Send' });
    var cols = game.categories.length;
    var rows = game.categories.map(function (cat) {
      var catKey = cat.toLowerCase();
      var val = draft.drafts[catKey] || draft.drafts[cat] || '';
      var ok = draft.validated[catKey] || draft.validated[cat];
      var award = catAward(draft, catKey, cat);
      var pending = draft.pending[catKey] || draft.pending[cat];
      var rej = (draft.rejected && (draft.rejected[catKey] || draft.rejected[cat])) || null;
      var colClass = 'opbac-col' +
        (ok ? ' opbac-col--ok' + (award && award.ia ? ' opbac-col--ia' : '') : (rej ? ' opbac-col--reject' : (pending ? ' opbac-col--pending' : '')));
      var ph = letter
        ? pick({ fr: 'Mot en ' + letter + '…', en: 'Word with ' + letter + '…' })
        : pick({ fr: 'Votre mot…', en: 'Your word…' });
      var verifyWord = (rej && rej.word) || val;
      var verifyHtml = '';
      if (!ok && verifyWord) {
        verifyHtml =
          '<button type="button" class="opbac-col__verify' +
            (rej && rej.verifying ? ' opbac-col__verify--sent' : '') + '" data-verify-cat="' + escHtml(catKey) + '" ' +
            'data-verify-word="' + escHtml(verifyWord) + '">' +
            escHtml(rej && rej.verifying
              ? pick({ fr: 'Envoyé — attente opérateur', en: 'Sent — awaiting operator' })
              : pick({ fr: 'Vérifier', en: 'Verify' })) +
          '</button>';
      }
      var errHtml = rej && rej.msg && !ok
        ? ('<p class="opbac-col__err">' + escHtml(rej.msg) + '</p>')
        : '';
      var infoHtml = (rej && rej.suggestInfo && verifyWord && !ok)
        ? buildInfoHintHtml(verifyWord)
        : '';
      return '<div class="' + colClass + '" data-cat="' + escHtml(catKey) + '">' +
        '<span class="opbac-col__cat">' + categoryIconHtml(cat) + escHtml(cat) +
          (pending && !ok ? refreshSpinnerHtml('opbac-col__pending') : '') +
          (ok && award && award.ia
            ? '<span class="opbac-col__award">🤖 +' + escHtml(formatPtsShort(award.pts)) + '</span>'
            : (ok ? '<span class="opbac-col__award">✓ +' + escHtml(formatPtsShort((award && award.pts) || 1)) + '</span>' : '')) +
        '</span>' +
        errHtml +
        infoHtml +
        '<input type="text" class="opbac-col__input" data-cat-input="' + escHtml(catKey) + '" ' +
          'value="' + escHtml(val) + '" placeholder="' + escHtml(ph) + '" ' +
          (ok ? 'disabled' : '') + ' autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="send" />' +
        '<button type="button" class="opbac-col__send" data-send-cat="' + escHtml(catKey) + '" ' +
          (ok ? 'disabled' : '') + '>' + escHtml(sendLbl) + '</button>' +
        verifyHtml +
      '</div>';
    }).join('');
    var allDisabled = game.categories.every(function (cat) {
      var k = cat.toLowerCase();
      return draft.validated[k] || draft.validated[cat];
    });
    var hasDraft = game.categories.some(function (cat) {
      var k = cat.toLowerCase();
      return (draft.drafts[k] || '').trim() && !(draft.validated[k]);
    });
    var completeBanner = '';
    if (allDisabled || (game.fullComboNick && game.fullComboRound === roundKey(game))) {
      completeBanner = buildCompleteBannerHtml(game);
    }
    var sheetCls = 'opbac-sheet' + (allDisabled ? ' opbac-sheet--complete' : '');
    return completeBanner +
      '<div class="' + sheetCls + '" style="--opbac-cols:' + cols + '">' + rows +
      (hasDraft
        ? ('<button type="button" class="opbac-sheet__all" data-act="sendall"' + (allDisabled ? ' disabled' : '') + '>' +
            escHtml(pick({ fr: 'Tout envoyer', en: 'Send all' })) + '</button>')
        : '') +
      '</div>';
  }

  function updatePrepDom(root, remaining, game) {
    var cdEl = root.querySelector('[data-opbac-prep-cd]');
    if (cdEl && remaining > 0) cdEl.textContent = String(remaining);
    if (!game) return;
    var pct = prepProgress(game, remaining);
    var fill = root.querySelector('[data-opbac-prep-fill]');
    if (fill) fill.style.setProperty('--opbac-prep-pct', pct + '%');
    var bar = root.querySelector('[data-opbac-prep-bar]');
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
    var pctEl = root.querySelector('[data-opbac-prep-pct]');
    if (pctEl) pctEl.textContent = pct + ' %';
    var steps = root.querySelector('[data-opbac-prep-steps]');
    if (steps) steps.outerHTML = buildPrepStepsHtml(game, remaining);
  }

  function updateClockDom(root, remaining, progress, paused) {
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
      clockEl.classList.toggle('opbac-clock--paused', !!paused);
    }
  }

  function draftSignature(channel, game) {
    var d = getDraft(channel, game);
    return roundKey(game) + '|' + JSON.stringify(d.validated) + '|' + JSON.stringify(d.pending) + '|' + JSON.stringify(d.rejected);
  }

  function panelSignature(game) {
    if (!game) return 'idle';
    var base = [
      game.phase,
      game.round,
      game.letter,
      (game.categories || []).join('|'),
      game.totalRounds,
      game.mode || '',
      game.stopReason || '',
      game.fullComboNick || '',
      game.fullComboRound || '',
      JSON.stringify(game.scores || {}),
      JSON.stringify(game.livePlayers || {}),
      JSON.stringify(game.vote || null),
      JSON.stringify(game.mancheHistory || []),
    ].join(';');
    if (game.phase === 'game_end' || game.phase === 'round_end') {
      base += '|' + JSON.stringify(game.finalRanking || []) +
        '|' + JSON.stringify(game.scores || {}) +
        '|' + JSON.stringify(game.roundScores || {}) +
        '|' + JSON.stringify(game.serverRecords || []) +
        '|' + JSON.stringify(game.topGlobal || []);
    }
    return base;
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
      msg: pick({
        fr: 'Proposition envoyée — un opérateur examinera votre mot manuellement.',
        en: 'Request sent — an operator will review your word manually.',
      }),
      verifying: true,
    };
    sendPbCmd(orbit, buffer, 'verifier', catName + ' ' + word);
    bumpStore();
    try {
      orbit.notify('Petit Bac', pick({
        fr: 'Proposition envoyée pour « ' + word + ' » — validation manuelle par un opérateur.',
        en: 'Request sent for « ' + word + ' » — manual review by an operator.',
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
    sendPbPlay(orbit, buffer, word, resolveCatName(game, catKey) || catKey);
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

  function catInputEl(root, catKey) {
    if (!root || !catKey) return null;
    var key = String(catKey).toLowerCase();
    var inputs = root.querySelectorAll('[data-cat-input]');
    for (var i = 0; i < inputs.length; i++) {
      if (String(inputs[i].getAttribute('data-cat-input') || '').toLowerCase() === key) return inputs[i];
    }
    return null;
  }

  function captureFormFocus(root) {
    if (!root) return null;
    if (root.__opbacRestoreFocus) {
      var pending = root.__opbacRestoreFocus;
      root.__opbacRestoreFocus = null;
      return pending;
    }
    var ae = document.activeElement;
    if (!ae || !root.contains(ae)) return null;
    var inp = (ae.getAttribute && ae.getAttribute('data-cat-input')) ? ae : null;
    if (!inp && ae.closest) {
      var row = ae.closest('[data-cat]');
      inp = row && row.querySelector('[data-cat-input]');
      if (row && inp) {
        return { cat: row.getAttribute('data-cat') || inp.getAttribute('data-cat-input'), select: true };
      }
    }
    if (!inp) return null;
    return {
      cat: inp.getAttribute('data-cat-input'),
      start: typeof inp.selectionStart === 'number' ? inp.selectionStart : null,
      end: typeof inp.selectionEnd === 'number' ? inp.selectionEnd : null,
    };
  }

  function restoreFormFocus(root, saved) {
    if (!root || !saved || !saved.cat) return false;
    var apply = function () {
      var inp = catInputEl(root, saved.cat);
      if (!inp || inp.disabled) return false;
      inp.focus();
      try {
        if (saved.select && inp.value) inp.select();
        else if (saved.start != null && saved.end != null) inp.setSelectionRange(saved.start, saved.end);
      } catch (e) { /* ignore */ }
      return document.activeElement === inp;
    };
    if (apply()) return true;
    requestAnimationFrame(apply);
    return true;
  }

  function bindDomPanel(root, orbit) {
    if (root.__opbacBound) return;
    root.__opbacBound = true;
    bindSkipRulesUi(root, orbit);
    document.addEventListener('click', function (ev) {
      if (!root.contains(ev.target)) closeModeMenu(root);
    }, true);
    root.addEventListener('mousedown', function (ev) {
      var keep = ev.target && ev.target.closest
        ? ev.target.closest('[data-verify-cat]')
        : null;
      if (keep) ev.preventDefault();
    });
    root.addEventListener('click', function (ev) {
      var buffer = orbit.state.active();
      if (!buffer || !isBacChannel(orbit, buffer)) return;
      if (!(ev.target.closest && ev.target.closest('[data-opbac-mode-wrap]'))) closeModeMenu(root);
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
        if (vCat && vWord) {
          root.__opbacRestoreFocus = { cat: vCat, select: true };
          sendVerify(orbit, buffer, vCat, vWord);
          restoreFormFocus(root, { cat: vCat, select: true });
        }
        return;
      }
      var infoBtn = ev.target && ev.target.closest ? ev.target.closest('[data-act="info"]') : null;
      if (infoBtn) {
        ev.preventDefault();
        var infoWord = infoBtn.getAttribute('data-info-word');
        if (!infoWord) {
          var infoRow = infoBtn.closest('[data-cat]');
          var infoInp = infoRow && infoRow.querySelector('[data-cat-input]');
          infoWord = infoInp ? infoInp.value : '';
        }
        if (infoWord) sendInfo(orbit, buffer, infoWord);
        return;
      }
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'view-chat') {
        setViewMode(orbit, root, VIEW_CHAT);
        var gChat = getChannelState(buffer) || defaultState();
        var pChat = gChat.phase || 'idle';
        var runChat = isGameRunning(gChat);
        var endChat = pChat === 'game_end' || pChat === 'round_end';
        var idleChat = !runChat && pChat === 'idle' && !gChat.letter;
        syncCollapsedCta(root, collapsedCtaKind(VIEW_CHAT, runChat, endChat, idleChat, pChat === 'game_end'));
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'view-split') {
        setViewMode(orbit, root, VIEW_SPLIT);
        syncCollapsedCta(root, '');
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'view-full') {
        setViewMode(orbit, root, VIEW_FULL);
        syncCollapsedCta(root, '');
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'collapse') {
        setViewMode(orbit, root, VIEW_CHAT);
        var gameNow = getChannelState(buffer) || defaultState();
        var phaseNow = gameNow.phase || 'idle';
        var runningNow = isGameRunning(gameNow);
        var endNow = phaseNow === 'game_end' || phaseNow === 'round_end';
        var idleNow = !runningNow && phaseNow === 'idle' && !gameNow.letter;
        syncCollapsedCta(root, collapsedCtaKind(VIEW_CHAT, runningNow, endNow, idleNow, phaseNow === 'game_end'));
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'play-now') {
        expandPanel(root, orbit, { mode: VIEW_FULL });
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'join-game') {
        expandPanel(root, orbit, { mode: VIEW_FULL, focusInput: true });
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'jouer' || act === 'play-menu') {
        openPlayMenu(orbit);
        return;
      }
      if (act === 'mode-menu') {
        toggleModeMenu(root, orbit, buffer);
        return;
      }
      if (act === 'switch-mode') {
        closeModeMenu(root);
        requestModeSwitch(orbit, buffer, root, btn.getAttribute('data-mode'));
        return;
      }
      if (act === 'pick-mode') {
        rememberPickedMode(orbit, root, btn.getAttribute('data-mode'));
        return;
      }
      if (act === 'lobby-tab') {
        var tab = btn.getAttribute('data-tab') || 'scores';
        var gameTab = getChannelState(buffer) || defaultState();
        updateLobbyTabUi(root, tab, gameTab, orbit.state.nick() || '');
        requestLobbyTabData(orbit, buffer, tab, true);
        return;
      }
      if (act === 'create-mode') {
        sendCreateMode(orbit, buffer, root);
        return;
      }
      if (act === 'replay') {
        startReplayGame(orbit, buffer, root);
        return;
      }
      if (act === 'bug' || act === 'suggest') {
        openFeedbackModal(orbit, buffer, act === 'bug' ? 'bug' : 'suggestion');
        return;
      }
      if (act === 'aide') openHelpModal(orbit);
      if (act === 'rules' || act === 'dock-rules') openRulesModal(orbit);
      if (act === 'dock-scores') {
        requestLobbyStats(orbit, buffer, true);
        openDockModal('scores', pick({ fr: 'Scores', en: 'Scores' }));
        return;
      }
      if (act === 'dock-stats') {
        sendPbCmd(orbit, buffer, 'stat');
        openDockModal('stats', pick({ fr: 'Statistiques', en: 'Stats' }));
        return;
      }
      if (act === 'dock-top') {
        patchChannel(buffer, { topGlobal: [], topLoaded: false });
        sendPbCmd(orbit, buffer, 'top', '5');
        openDockModal('top', pick({ fr: 'Top joueurs', en: 'Top players' }));
        setTimeout(function () {
          var g = getChannelState(buffer) || defaultState();
          if (!g.topLoaded) {
            patchChannel(buffer, { topLoaded: true });
            refreshDockOverlay();
          }
        }, 7000);
        return;
      }
      if (act === 'dock-pause') { sendPbCmd(orbit, buffer, 'pause'); return; }
      if (act === 'dock-resume') { sendPbCmd(orbit, buffer, 'reprendre'); return; }
      if (act === 'dock-yes') { sendPbCmd(orbit, buffer, 'oui'); return; }
      if (act === 'dock-no') { sendPbCmd(orbit, buffer, 'non'); return; }
      if (act === 'live-toggle') {
        setLiveBoardOpen(orbit, !isLiveBoardOpen(orbit));
        root.__opbacSig = '';
        bumpStore();
        return;
      }
      if (act === 'live-copy') {
        var md = buildLiveRecapMarkdown(getChannelState(buffer) || defaultState());
        if (md && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(md).then(function () {
            orbit.notify('Petit Bac', pick({ fr: 'Récap copié !', en: 'Recap copied!' }));
          });
        }
        return;
      }
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
    var onBac = isBacChannel(orbit, buffer);
    document.body.classList.toggle('opbac-active', !!onBac);
    if (!onBac) {
      document.body.classList.remove('opbac-full', 'opbac-split');
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    bindDomPanel(root, orbit);
    var game = getChannelState(buffer) || defaultState();
    var phase = game.phase || 'idle';
    var sig = panelSignature(game) + '|' + (isLiveBoardOpen(orbit) ? '1' : '0') +
      '|' + (skipRulesPref(orbit) ? '1' : '0');
    var rebuild = root.__opbacSig !== sig;
    var gameRunning = isGameRunning(game);
    var hasGrid = hasPlayableGrid(game);
    var isLive = hasGrid && (phase === 'playing' || phase === 'paused');
    var isIdle = !gameRunning && phase === 'idle' && !game.letter;
    var isGameEnd = phase === 'game_end';
    var isRoundEnd = phase === 'round_end';
    var isEnd = isGameEnd || isRoundEnd;
    var isPrep = gameRunning && !hasGrid && !isEnd;
    var myNick = orbit.state.nick() || '';
    var replayMode = defaultReplayMode(game, root, orbit);

    if (gameRunning && !isEnd) maybeRequestGameSync(orbit, buffer, game);

    var restoreFocus = captureFormFocus(root);
    if (rebuild) {
      saveDraftFromDom(root, buffer);
      root.__opbacSig = sig;
    }

    var timing = computeRemaining(game);
    var remaining = timing.remaining;
    var progress = timing.progress;
    var viewMode = getViewMode(orbit, root);
    if (isRoundEnd && viewMode === VIEW_CHAT) {
      viewMode = VIEW_FULL;
      root.__opbacViewMode = VIEW_FULL;
    }
    if (gameRunning && !isEnd && viewMode === VIEW_CHAT) {
      /* keep chat if user chose it during play */
    } else if ((phase === 'starting' || phase === 'rules' || phase === 'countdown' || phase === 'go')
        && !root.__opbacDidAutoFull) {
      viewMode = VIEW_FULL;
      root.__opbacViewMode = VIEW_FULL;
      root.__opbacDidAutoFull = true;
      try { orbit.storage.set(STORAGE_VIEW_MODE, VIEW_FULL); } catch (e) { /* ignore */ }
    }
    if (isIdle) root.__opbacDidAutoFull = false;
    if (phase === 'rules') maybeOpenRulesModal(orbit, buffer);

    var headBadge = phaseLabel(phase, game.countdown);
    if (isGameEnd) {
      headBadge = pick({ fr: 'Partie terminée', en: 'Game over' });
    } else if (isRoundEnd) {
      headBadge = pick({ fr: 'Fin de manche', en: 'Round over' });
    } else if (game.round && game.totalRounds && (isLive || isPrep)) {
      headBadge = '';
    }
    if (isLive && game.phase === 'paused') {
      headBadge = pick({ fr: '⏸️ Pause', en: '⏸️ Paused' });
    }
    if (isLive && game.fullComboNick && game.fullComboRound === roundKey(game)) {
      headBadge += ' · 🔥 Full combo';
    }
    var modeBadge = (gameRunning || isEnd) ? modeBadgeLabel(game.mode) : '';
    var collapsedCta = collapsedCtaKind(viewMode, gameRunning, isEnd, isIdle, isGameEnd);

    root.className = 'opbac-panel' +
      (viewMode === VIEW_CHAT ? ' opbac-panel--chat opbac-panel--collapsed' : '') +
      (viewMode === VIEW_FULL ? ' opbac-panel--full' : '') +
      (viewMode === VIEW_SPLIT ? ' opbac-panel--split' : '') +
      ((isLive || isPrep || isRoundEnd) ? ' opbac-panel--playing' : '') +
      (isGameEnd ? ' opbac-panel--game-end' : '') +
      (isRoundEnd ? ' opbac-panel--round-end' : '') +
      ((isLive && game.fullComboNick && game.fullComboRound === roundKey(game)) ? ' opbac-panel--complete' : '');

    if (rebuild) {
      var bodyHtml = '';
      if (isIdle) {
        bodyHtml = buildIdleHtml(game, replayMode, myNick);
        if (isBacBotPresent(orbit, buffer)) {
          requestModeList(orbit, buffer);
          requestLobbyTabData(orbit, buffer, currentLobbyTab(), false);
        }
      } else if (isEnd) {
        var endSig = endScreenSignature(game);
        var endAnimate = root.__opbacEndPhase !== phase;
        root.__opbacEndPhase = phase;
        root.__opbacEndSig = endSig;
        bodyHtml = buildEndScreenHtml(game, myNick, replayMode, endAnimate);
        if (isRoundEnd) bodyHtml += buildLiveBoardHtml(orbit, game, myNick);
        root.__opbacReplayMode = replayMode;
        if (isGameEnd && isBacBotPresent(orbit, buffer)) requestModeList(orbit, buffer);
      } else {
        bodyHtml = buildPlayingBodyHtml(orbit, buffer, game, remaining, progress);
        if (isBacBotPresent(orbit, buffer)) requestModeList(orbit, buffer);
      }

      root.innerHTML =
        buildHeadHtml(headBadge, modeBadge, viewMode, gameRunning && !isEnd, collapsedCta, game.mode,
          currentGameView(orbit, root, viewMode)) +
        '<div class="opbac-body">' + bodyHtml + '</div>' +
        '<div class="opbac-resize" data-opbac-resize role="separator" aria-label="' +
          escHtml(pick({ fr: 'Redimensionner le panneau', en: 'Resize panel' })) + '"></div>';

      bindPanelResize(root, orbit);
      applyViewMode(root, orbit, viewMode);

      root.__opbacDraftSig = draftSignature(buffer, game);

      if (isLive && !isEnd && viewMode !== VIEW_CHAT) {
        requestAnimationFrame(function () {
          if (restoreFormFocus(root, restoreFocus)) return;
          var first = root.querySelector('.opbac-col__input:not([disabled])');
          if (first) first.focus();
        });
      }
      if (!isEnd) syncCompleteCelebration(root, buffer, game);
    } else {
      var headBadgeEl = root.querySelector('[data-opbac-head-badge]');
      if (headBadgeEl) headBadgeEl.textContent = headBadge;
      var modeIco = root.querySelector('[data-opbac-head-mode-ico]');
      if (modeIco) modeIco.textContent = modeBadgeIcon(game.mode);
      var modeBtn = root.querySelector('[data-act="mode-menu"]');
      if (modeBtn && modeBadge) {
        modeBtn.setAttribute('aria-label', modeBadge);
        modeBtn.setAttribute('title', modeBadge);
      }
      var modeWrap = root.querySelector('[data-opbac-mode-wrap]');
      if (modeWrap) modeWrap.hidden = !modeBadge;
      syncCollapsedCta(root, collapsedCta);
      var customsEl = root.querySelector('[data-opbac-customs]');
      if (customsEl && (isIdle || isEnd)) {
        customsEl.innerHTML = buildCustomModesHtml(defaultReplayMode(game, root, orbit));
      }
      var idleStats = root.querySelector('[data-opbac-idle-stats]');
      if (idleStats && isIdle) {
        idleStats.innerHTML = buildRecapBodyHtml(game, myNick, currentLobbyTab());
      }
      if (isIdle) syncCreatedNotice(root);
      var scoresWrap = root.querySelector('[data-opbac-scores]');
      if (scoresWrap && (isLive || hasGrid) && !isEnd) {
        scoresWrap.outerHTML = buildSideScoresHtml(game);
      }
      if (isLive && !isEnd) updateClockDom(root, remaining, progress, game.phase === 'paused');
      else if (isPrep) updatePrepDom(root, remaining, game);

      if (isEnd) {
        var endSig2 = endScreenSignature(game);
        if (root.__opbacEndSig !== endSig2) {
          root.__opbacEndSig = endSig2;
          var endWrap = root.querySelector('[data-opbac-end]');
          var endHtml = buildEndScreenHtml(game, myNick, defaultReplayMode(game, root, orbit), false);
          if (endWrap) {
            endWrap.outerHTML = endHtml;
          } else {
            var bodyEl = root.querySelector('.opbac-body');
            if (bodyEl) {
              bodyEl.innerHTML = endHtml + (isRoundEnd ? buildLiveBoardHtml(orbit, game, myNick) : '');
            }
          }
        }
        updateReplayModeUi(root, defaultReplayMode(game, root, orbit));
      } else if (hasGrid) {
        var formWrap = root.querySelector('[data-opbac-form]');
        var dSig = draftSignature(buffer, game);
        if (formWrap && root.__opbacDraftSig !== dSig) {
          root.__opbacDraftSig = dSig;
          saveDraftFromDom(root, buffer);
          formWrap.innerHTML = buildFormHtml(buffer, game);
          restoreFormFocus(root, restoreFocus);
        }
        syncCompleteCelebration(root, buffer, game);
        var liveEl = root.querySelector('[data-opbac-live]');
        if (isLive && !isEnd) {
          var liveSig = JSON.stringify(game.livePlayers || {}) + '|' + JSON.stringify(game.scores || {});
          if (!liveEl) {
            var liveHtml = buildLiveBoardHtml(orbit, game, myNick);
            var scrollEl = root.querySelector('.opbac-scroll');
            var dockEl = root.querySelector('.opbac-dock');
            if (scrollEl) scrollEl.insertAdjacentHTML('afterend', liveHtml);
            else if (dockEl) dockEl.insertAdjacentHTML('beforebegin', liveHtml);
            root.__opbacLiveSig = liveSig;
          } else if (root.__opbacLiveSig !== liveSig) {
            root.__opbacLiveSig = liveSig;
            liveEl.outerHTML = buildLiveBoardHtml(orbit, game, myNick);
          }
        }
      } else if (isPrep) {
        updatePrepDom(root, remaining, game);
      }
      applyViewMode(root, orbit, viewMode);
    }

    if (!rebuild && isLive && !isEnd) updateClockDom(root, remaining, progress, game.phase === 'paused');
    if (!rebuild && isPrep && !isEnd) updatePrepDom(root, remaining, game);
    if (!isEnd && root.__opbacEndPhase) root.__opbacEndPhase = '';
  }

  function hideBacPanel(root) {
    document.body.classList.remove('opbac-active', 'opbac-full', 'opbac-split');
    if (!root) return;
    root.style.display = 'none';
    root.classList.remove('opbac-panel--full', 'opbac-panel--split', 'opbac-panel--playing');
  }

  function mountDomPanel(orbit) {
    var onBac = isBacChannel(orbit, orbit.state.active());
    var root = document.getElementById('opbac-dom-panel');
    if (!onBac || isBouncerSession(orbit)) {
      hideBacPanel(root);
      return;
    }
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
    if (root.parentNode !== main) {
      topbar.insertAdjacentElement('afterend', root);
    }
    renderDomPanel(orbit, root);
  }

  Orbit.plugin('orbit-petitbac', function (orbit, log) {
    pluginOrbit = orbit;
    injectStyles();
    console.info('[orbit-petitbac] loaded v' + PBAC_VER);
    if (orbit.requireVisualDisplay) {
      orbit.requireVisualDisplay({
        label: 'Petit Bac',
        inChannel: function (ch) { return channelEnabled(orbit, ch); },
      });
    }

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
        var text = (msg.params && msg.params[1]) || '';
        var myNick = orbit.state.nick() || '';
        if (!isChannelName(chan)) {
          handleBacNotice(msg.nick, text);
          syncDom();
          return;
        }
        if (!channelEnabled(orbit, chan)) return;
        handleIrcLine(chan, msg.nick, text, myNick);
        syncDom();
      }
    });

    orbit.on('buffer.active', function () {
      var buf = orbit.state.active();
      if (isBacChannel(orbit, buf)) {
        var g = getChannelState(buf) || defaultState();
        if (isGameRunning(g) && !hasPlayableGrid(g)) maybeRequestGameSync(orbit, buf, g);
      }
      syncDom();
    });
    orbit.on('connected', syncDom);
    orbit.on('status', syncDom);
    setInterval(syncDom, 250);

    orbit.addCommand('aide', {
      help: pick({ fr: 'Afficher l\'aide du Petit Bac', en: 'Show Petit Bac help' }),
      run: function () { openHelpModal(orbit); },
    });

    orbit.addCommand('jouer', {
      help: pick({ fr: 'Choisir un niveau et lancer une partie', en: 'Choose a level and start a game' }),
      run: function () {
        var buf = orbit.state.active();
        if (!buf || !isBacChannel(orbit, buf)) {
          orbit.notify('Petit Bac', pick({ fr: 'Ouvrez le salon #Baccalaureat.chat d\'abord.', en: 'Open #Baccalaureat.chat first.' }));
          return;
        }
        openPlayMenu(orbit);
      },
    });

    orbit.addCommand('bacboard', {
      help: pick({ fr: 'Afficher/masquer le tableau live Petit Bac', en: 'Toggle Petit Bac live board' }),
      run: function () {
        var open = isLiveBoardOpen(orbit);
        setLiveBoardOpen(orbit, !open);
        bumpStore();
        orbit.notify('Petit Bac', !open
          ? pick({ fr: 'Tableau live affiché', en: 'Live board shown' })
          : pick({ fr: 'Tableau live masqué', en: 'Live board hidden' }));
      },
    });

    log('orbit-petitbac ready');
    console.info('[orbit-petitbac] ready — channels:', (cfg(orbit).channels || []).join(', '));
  });

  }

  boot(0);
})();
