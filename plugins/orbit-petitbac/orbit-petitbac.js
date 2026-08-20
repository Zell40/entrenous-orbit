/*!
 * orbit-petitbac — UI moderne pour le bot Limnoria Petit Bac (EntreNous)
 * Écoute les TAGMSG IRCv3 : +pb=v1 +ev=<event> (+letter, +categories, …)
 */
(function () {
  'use strict';

  var PBAC_VER = 30;
  var syncRequestAt = Object.create(null);
  var STORAGE_PANEL_HEIGHT = 'opbacPanelHeightV2';
  var PANEL_HEIGHT_MIN = 220;
  var PANEL_HEIGHT_MAX = 900;

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

  function categoryIconKind(cat) {
    var s = String(cat || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/animal|oiseau|mamif|insect|reptil|poisson/.test(s)) return 'animal';
    if (/pays|ville|capitale|continent|monde|region|ile/.test(s)) return 'geo';
    if (/fruit|legume|nourriture|plat|boisson|manger|vegetal|repas/.test(s)) return 'food';
    if (/prenom|nom/.test(s)) return 'person';
    if (/metier|profession|job|travail/.test(s)) return 'job';
    if (/marque|enseigne|marques/.test(s)) return 'brand';
    if (/couleur/.test(s)) return 'color';
    if (/sport|jeu/.test(s)) return 'sport';
    if (/film|serie|acteur|chanteur|artiste|musique|chanson/.test(s)) return 'media';
    return 'default';
  }

  function categoryIconHtml(cat) {
    var kind = categoryIconKind(cat);
    var paths = {
      animal: '<path d="M8 18c2-3 5-4 8-4s6 1 8 4c2 3 1 7-2 9-2 1-4 1-6 0-2 1-4 1-6 0-3-2-4-6-2-9z" fill="currentColor" opacity=".9"/><circle cx="9" cy="13" r="1.2" fill="#fff"/><circle cx="15" cy="13" r="1.2" fill="#fff"/>',
      geo: '<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M2 9h14M9 2c2 2.5 3 5 3 7s-1 4.5-3 7M9 2C7 4.5 6 7 6 9s1 4.5 3 7" stroke="currentColor" stroke-width="1.2" fill="none"/>',
      food: '<path d="M10 3v4c0 2.5-1.5 4-3.5 4.5V17h3v-5.5C11.5 11 13 9.5 13 7V3h-3z" fill="currentColor"/><path d="M15 3v7c0 2 1.5 3.5 3.5 3.8V17H15V3z" fill="currentColor" opacity=".75"/>',
      person: '<circle cx="9" cy="6.5" r="3" fill="currentColor"/><path d="M3 17c0-3.5 2.7-6 6-6s6 2.5 6 6" fill="currentColor" opacity=".85"/>',
      job: '<rect x="3" y="7" width="12" height="9" rx="1.5" fill="currentColor" opacity=".85"/><path d="M7 7V5.5C7 4.7 7.7 4 8.5 4h3C12.3 4 13 4.7 13 5.5V7" stroke="currentColor" stroke-width="1.4" fill="none"/>',
      brand: '<path d="M4 4h8l4 4v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z" fill="currentColor" opacity=".85"/><path d="M8 4v4h4" stroke="#fff" stroke-width="1.2" fill="none"/>',
      color: '<circle cx="6" cy="10" r="3" fill="#ef4444"/><circle cx="10" cy="7" r="3" fill="#3b82f6"/><circle cx="14" cy="10" r="3" fill="#22c55e"/><circle cx="10" cy="13" r="3" fill="#f59e0b"/>',
      sport: '<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 9h12M9 3c2 2 3 4 3 6s-1 4-3 6M9 3c-2 2-3 4-3 6s1 4 3 6" stroke="currentColor" stroke-width="1.2" fill="none"/>',
      media: '<rect x="3" y="5" width="12" height="10" rx="2" fill="currentColor" opacity=".85"/><path d="M8 9l3 2 4-4" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
      default: '<rect x="4" y="4" width="10" height="12" rx="2" fill="currentColor" opacity=".85"/><path d="M7 8h6M7 11h4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
    };
    return '<svg class="opbac-col__ico" viewBox="0 0 18 18" aria-hidden="true" focusable="false">' +
      (paths[kind] || paths.default) + '</svg>';
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

  function maybeRequestGameSync(orbit, buffer, game) {
    if (!orbit || !buffer || !isBacChannel(orbit, buffer)) return;
    if (hasPlayableGrid(game) && game.phase === 'playing') return;
    var key = normChan(buffer);
    var now = Date.now();
    if (syncRequestAt[key] && now - syncRequestAt[key] < 12000) return;
    syncRequestAt[key] = now;
    try { orbit.irc.msg(buffer, '!manche'); } catch (e) { /* ignore */ }
  }

  function pinChatIfFollowing() {
    var el = document.querySelector('.main .messages');
    if (!el) return;
    var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 200) el.scrollTop = el.scrollHeight;
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
      root.classList.remove('opbac-panel--collapsed', 'opbac-panel--playing', 'opbac-panel--game-end', 'opbac-panel--round-end', 'opbac-panel--complete');
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
    var cmd = '!info ' + word;
    return '<div class="opbac-info-hint" role="note">' +
      '<span class="opbac-info-hint__icon" aria-hidden="true">🔍</span>' +
      '<div class="opbac-info-hint__body">' +
        '<span class="opbac-info-hint__lbl">' +
          escHtml(pick({ fr: 'Consulter sur Wikipédia', en: 'Look up on Wikipedia' })) +
        '</span>' +
        '<code class="opbac-info-hint__cmd">' + escHtml(cmd) + '</code>' +
      '</div>' +
      '<button type="button" class="opbac-info-hint__btn" data-act="info" data-info-word="' +
        escHtml(word) + '" title="' + escHtml(pick({ fr: 'Envoyer la commande', en: 'Send command' })) + '">' +
        escHtml(pick({ fr: 'Consulter', en: 'Look up' })) +
      '</button></div>';
  }

  function sendInfo(orbit, buffer, word) {
    word = String(word || '').trim();
    if (!word || !buffer) return;
    infoLookup = { word: word, waiting: true, buffer: normChan(buffer) };
    openInfoModal(word, '', true);
    orbit.irc.msg(buffer, '!info ' + word);
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

  function showScoreBurst(pts) {
    pts = Number(pts) || 1;
    var host = document.getElementById('opbac-dom-panel');
    if (!host || host.classList.contains('opbac-panel--collapsed')) host = document.body;
    var burst = document.createElement('div');
    burst.className = 'opbac-score-burst' + (pts >= 2 ? ' opbac-score-burst--hard' : '');
    burst.setAttribute('aria-hidden', 'true');
    var sparks = '';
    var dirs = [[-42, -28], [38, -34], [-28, 22], [44, 18], [0, -48], [-52, 4], [54, -8]];
    for (var i = 0; i < dirs.length; i++) {
      sparks += '<span class="opbac-score-burst__spark" style="--dx:' + dirs[i][0] + 'px;--dy:' +
        dirs[i][1] + 'px;animation-delay:' + (i * 0.04) + 's"></span>';
    }
    burst.innerHTML =
      sparks +
      '<span class="opbac-score-burst__n">+' + pts + '</span>' +
      '<span class="opbac-score-burst__lbl">' + escHtml(pick({ fr: 'pt', en: 'pt' })) + '</span>';
    host.appendChild(burst);
    window.setTimeout(function () { if (burst.parentNode) burst.remove(); }, 1450);
  }

  function showWordValidatedPopup(orbit, catLabel, word, pts) {
    orbit = orbit || pluginOrbit;
    catLabel = String(catLabel || '').trim();
    word = String(word || '').trim();
    pts = Number(pts) || 1;
    if (!word && !catLabel) return;
    showScoreBurst(pts);
    var prev = document.getElementById('opbac-word-toast');
    if (prev) prev.remove();
    var el = document.createElement('div');
    el.id = 'opbac-word-toast';
    el.className = 'opbac-word-toast';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="opbac-word-toast__icon" aria-hidden="true">' +
        imgHtml('complete.svg', pick({ fr: 'Mot accepté', en: 'Word accepted' }), '') +
      '</div>' +
      '<div class="opbac-word-toast__body">' +
        '<strong class="opbac-word-toast__title">' +
          escHtml(pick({ fr: 'Mot accepté !', en: 'Word accepted!' })) +
        '</strong>' +
        (word ? ('<span class="opbac-word-toast__word">« ' + escHtml(word) + ' »</span>') : '') +
        (catLabel ? ('<span class="opbac-word-toast__cat">' + escHtml(catLabel) + '</span>') : '') +
        '<span class="opbac-word-toast__pts">+' + pts + ' ' +
          escHtml(pick({ fr: 'pt', en: 'pt' })) + '</span></div>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('opbac-word-toast--show'); });
    window.setTimeout(function () {
      el.classList.add('opbac-word-toast--hide');
      window.setTimeout(function () { if (el.parentNode) el.remove(); }, 320);
    }, 4200);
    if (orbit && orbit.notify) {
      try {
        orbit.notify('Petit Bac', pick({
          fr: '✓ ' + (word || catLabel) + ' (+' + pts + ' pt)',
          en: '✓ ' + (word || catLabel) + ' (+' + pts + ' pt)',
        }));
      } catch (e) { /* ignore */ }
    }
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
      draft.validated[cat] = true;
      delete draft.pending[cat];
      if (draft.rejected) {
        delete draft.rejected[cat];
        Object.keys(draft.rejected).forEach(function (k) {
          if (draft.rejected[k] && draft.rejected[k].catKey === cat) delete draft.rejected[k];
        });
      }
      var catLabel = resolveCatName(game, cat);
      var wordOk = extractQuotedWord(msg) || draft.drafts[cat] || '';
      showWordValidatedPopup(null, catLabel, wordOk, /💎/.test(msg) ? 2 : 1);
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
      maybeOpenRulesModal(pluginOrbit, channel);
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
        phase: 'rules',
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
    var manche = body.match(/manche\s+(\d+)\s*\/\s*(\d+)/i)
      || body.match(/manche\s*:\s*(\d+)(?:\s*\/\s*(\d+))?/i);
    if (manche) {
      var durM = (getChannelState(channel) || {}).duration || 60;
      patchChannel(channel, {
        phase: 'playing',
        round: Number(manche[1]) || 0,
        totalRounds: Number(manche[2]) || (getChannelState(channel) || {}).totalRounds || 0,
        roundStartAt: Date.now(),
        countdownAt: Date.now(),
        countdown: durM,
        duration: durM,
      });
    }
    var lc = body.match(/lettre\s*(?:actuelle)?\s*:\s*(\S+).*cat[ée]gories(?:\s+actuelles)?\s*:\s*(.+)$/i);
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
    var catsOnly = body.match(/(?:📚\s*)?cat[ée]gories(?:\s+actuelles)?\s*:\s*(.+)$/i);
    if (catsOnly && !/par manche|actuelles/i.test(body)) {
      patchChannel(channel, {
        phase: 'playing',
        categories: parseCategories(catsOnly[1]),
        roundStartAt: Date.now(),
        duration: (getChannelState(channel) || {}).duration || 60,
      });
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
      if (left) {
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

      if (gameSt.phase === 'game_end' && /[!🎮✏️🐞🎉📊🌟🏆📅]|Merci d'avoir jou[eé]|recommencer|!jouer|!jeu|!suggestion|!bug/i.test(body)) {
        patchChannel(channel, { endNotes: appendEndNote(gameSt, body) });
      }

      if (/manche termin[eé]e/i.test(body)) {
        patchChannel(channel, { phase: 'round_end' });
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
      fullComboNick: '',
      fullComboRound: '',
      finalRanking: [],
      topGlobal: [],
      endNotes: [],
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
      });
      return;
    }

    if (ev === 'rules_start') {
      patchChannel(channel, { phase: 'rules', starter: tagVal(tags, '+player') || tagVal(tags, '+starter') });
      maybeOpenRulesModal(pluginOrbit, channel);
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

    if (ev === 'round_tick') {
      patchChannel(channel, {
        phase: 'playing',
        countdown: Number(tagVal(tags, '+seconds_left')) || 0,
        countdownAt: Date.now(),
      });
      return;
    }

    if (ev === 'state_sync') {
      var catsS = tagVal(tags, '+categories');
      var durS = Number(tagVal(tags, '+duration')) || ((getChannelState(channel) || {}).duration) || 60;
      var leftS = Number(tagVal(tags, '+seconds_left'));
      if (!(leftS >= 0)) leftS = durS;
      patchChannel(channel, {
        phase: tagVal(tags, '+paused') === '1' ? 'paused' : 'playing',
        round: Number(tagVal(tags, '+round')) || 0,
        letter: tagVal(tags, '+letter'),
        categories: catsS ? catsS.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        duration: durS,
        totalRounds: Number(tagVal(tags, '+max_rounds')) || ((getChannelState(channel) || {}).totalRounds) || 0,
        mode: tagVal(tags, '+mode') || ((getChannelState(channel) || {}).mode) || '',
        countdown: leftS,
        countdownAt: Date.now(),
        roundStartAt: Date.now() - Math.max(0, (durS - leftS) * 1000),
      });
      return;
    }

    if (ev === 'word_ok') {
      var gameOk = getChannelState(channel) || defaultState();
      var catOk = matchCatKey(gameOk, tagVal(tags, '+category'));
      if (catOk) {
        var draftOk = getDraft(channel, gameOk);
        draftOk.validated[catOk] = true;
        delete draftOk.pending[catOk];
        if (draftOk.rejected) delete draftOk.rejected[catOk];
        var nickOkPopup = tagVal(tags, '+nick') || tagVal(tags, '+player');
        var meOk = pluginOrbit && pluginOrbit.state && pluginOrbit.state.nick
          ? String(pluginOrbit.state.nick() || '')
          : '';
        if (!nickOkPopup || !meOk || String(nickOkPopup).toLowerCase() === meOk.toLowerCase()) {
          showWordValidatedPopup(
            pluginOrbit,
            resolveCatName(gameOk, catOk),
            tagVal(tags, '+word'),
            Number(tagVal(tags, '+points')) || 1
          );
        }
        var nickOk = tagVal(tags, '+nick') || tagVal(tags, '+player');
        var ptsOk = parsePts(tagVal(tags, '+points'));
        if (nickOk && ptsOk > 0) {
          var scoresOk = Object.assign({}, gameOk.scores || {});
          var rsOk = Object.assign({}, gameOk.roundScores || {});
          addScore(scoresOk, nickOk, ptsOk);
          addScore(rsOk, nickOk, ptsOk);
          patchChannel(channel, { scores: scoresOk, roundScores: rsOk });
        } else {
          bumpStore();
        }
      }
      return;
    }

    if (ev === 'word_ko') {
      var gameKo = getChannelState(channel) || defaultState();
      var koReason = tagVal(tags, '+reason') || 'invalid';
      var koWord = tagVal(tags, '+word');
      var koCat = matchCatKey(gameKo, tagVal(tags, '+category'));
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
      var prevS = (getChannelState(channel) || {}).scores || {};
      var merged = Object.assign({}, prevS);
      if (!Object.keys(prevS).length) {
        Object.keys(rs).forEach(function (nick) {
          assignScore(merged, nick, parsePts(rs[nick]));
        });
      }
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
      var rankingRaw = tagVal(tags, '+final_ranking') || tagVal(tags, '+ranking');
      var ranking = rankingFromPairs(rankingRaw);
      var topGlobal = safeJson(tagVal(tags, '+top_global'), []);
      patchChannel(channel, {
        phase: 'game_end',
        finalRanking: ranking,
        topGlobal: rankingFromPairs(topGlobal),
        roundStartAt: 0,
        letter: '',
        categories: [],
        scores: scoresFromRanking(ranking),
      });
      return;
    }

    if (ev === 'game_stop' || ev === 'stopped') {
      stopGameUi(channel, tagVal(tags, '+reason') || 'op');
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
      '.opbac-panel--collapsed .opbac-body{display:none!important;height:auto;max-height:none}',
      '.opbac-panel--collapsed .opbac-resize{display:none}',
      '.opbac-resize{height:12px;flex:none;cursor:ns-resize;touch-action:none;user-select:none;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--accent,#6366f1) 12%,var(--border,#ddd)));border-top:1px solid color-mix(in srgb,var(--accent,#6366f1) 15%,var(--border,#ddd))}',
      '.opbac-resize::after{content:"";display:block;width:2.6rem;height:4px;margin:.28rem auto 0;border-radius:999px;background:color-mix(in srgb,var(--muted,#888) 45%,transparent)}',
      '.opbac-resize:hover,.opbac-resize:active{background:color-mix(in srgb,var(--accent,#6366f1) 18%,var(--border,#ddd))}',
      '.opbac-head{display:flex;align-items:center;gap:.5rem;padding:.45rem .75rem;background:linear-gradient(135deg,#4338ca,#6d28d9);color:#fff;overflow:visible}',
      '.opbac-head__brand{flex:1;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:.35rem .5rem;overflow:visible}',
      '.opbac-head__logo{width:28px;height:28px;border-radius:8px;flex-shrink:0;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,.15)}',
      '.opbac-head__title{font-weight:800;font-size:.88rem;letter-spacing:.01em}',
      '.opbac-head__badge{display:inline-flex;align-items:center;font-size:.68rem;font-weight:800;padding:.18rem .65rem;border-radius:999px;background:rgba(255,255,255,.18);white-space:nowrap;flex:0 0 auto;width:auto;max-width:none;overflow:visible;line-height:1.2}',
      '.opbac-head__badge--mode{background:rgba(255,255,255,.28)}',
      '.opbac-head__actions{display:flex;align-items:center;gap:.3rem}',
      '.opbac-head__btn{border:0;background:rgba(255,255,255,.16);color:#fff;min-width:36px;min-height:36px;border-radius:9px;cursor:pointer;font-size:.82rem;line-height:1}',
      '.opbac-head__btn:hover{background:rgba(255,255,255,.28)}',
      '.opbac-head__cta-wrap{display:contents}',
      '.opbac-head__cta{display:none;align-items:center;justify-content:center;border:0;border-radius:999px;padding:.42rem .9rem;font-size:.78rem;font-weight:900;cursor:pointer;background:#fff;color:#4338ca;min-height:36px;white-space:nowrap;line-height:1.1}',
      '.opbac-head__cta:hover{filter:brightness(.96)}',
      '.opbac-head__cta--join{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff}',
      '.opbac-panel--collapsed .opbac-head__cta{display:inline-flex}',
      '.opbac-panel--collapsed .opbac-head__btn[data-act="play-menu"]{display:none}',
      '.opbac-body{padding:0}',
      '.opbac-arena{position:relative;display:flex;align-items:center;justify-content:center;min-height:7.4rem;padding:.75rem 15.5rem .55rem .85rem;background:linear-gradient(180deg,color-mix(in srgb,#6366f1 5%,var(--bg,#fff)),var(--bg,#fff));background-image:url(/app/plugins/third/orbit-petitbac/assets/arena-pattern.svg),linear-gradient(180deg,color-mix(in srgb,#6366f1 5%,var(--bg,#fff)),var(--bg,#fff));background-repeat:no-repeat;background-position:center;background-size:cover;flex:0 0 auto}',
      '.opbac-arena__play{display:flex;align-items:center;justify-content:center;gap:clamp(.75rem,4vw,1.75rem);position:relative;z-index:1}',
      '.opbac-arena__block{display:flex;flex-direction:column;align-items:center;gap:.2rem}',
      '.opbac-arena__scores{position:absolute;right:.75rem;top:50%;transform:translateY(-50%);z-index:2;width:min(14rem,calc(100% - 1.5rem));min-width:8.5rem;padding:.4rem .55rem;border-radius:12px;background:color-mix(in srgb,var(--bg,#fff) 88%,#6366f1);border:1px solid color-mix(in srgb,#6366f1 18%,var(--border,#e5e5e5));max-height:7.2rem;overflow-y:auto;overflow-x:hidden}',
      '.opbac-arena__scores-h{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#888);margin:0 0 .3rem;display:flex;align-items:center;gap:.3rem}',
      '.opbac-arena__scores-h::before{content:"";display:inline-block;width:1rem;height:1rem;background:url(/app/plugins/third/orbit-petitbac/assets/trophy.svg) center/contain no-repeat;opacity:.85}',
      '.opbac-arena__scores-row{display:flex;justify-content:space-between;align-items:center;gap:.4rem;font-size:.78rem;line-height:1.35;font-weight:700}',
      '.opbac-arena__scores-nick{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:.25rem}',
      '.opbac-arena__scores-rank{flex-shrink:0;font-size:.85rem;line-height:1}',
      '.opbac-arena__scores-pts{font-variant-numeric:tabular-nums;color:#4f46e5;flex-shrink:0;font-weight:800;white-space:nowrap}',
      '.opbac-arena__scores-empty{margin:0;font-size:.72rem;color:var(--muted,#888);font-weight:600}',
      '@media(max-width:720px){.opbac-arena{flex-direction:column;justify-content:flex-start;padding:.75rem .85rem .55rem;min-height:0}.opbac-arena__scores{position:static;transform:none;width:100%;max-width:none;max-height:5.5rem}}',
      '.opbac-arena__lbl{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted,#888)}',
      '.opbac-letter-xl{width:clamp(72px,18vw,96px);height:clamp(72px,18vw,96px);border-radius:50%;display:grid;place-items:center;font-size:clamp(2.4rem,9vw,3.6rem);font-weight:900;color:#fff;background:linear-gradient(145deg,#fb923c,#ea580c);box-shadow:0 8px 24px -8px rgba(234,88,12,.45)}',
      '.opbac-clock{position:relative;isolation:isolate;overflow:hidden;width:clamp(72px,18vw,96px);height:clamp(72px,18vw,96px);flex-shrink:0}',
      '.opbac-clock__ring{width:100%;height:100%;transform:rotate(-90deg)}',
      '.opbac-clock__track{fill:none;stroke:color-mix(in srgb,var(--muted,#888) 20%,transparent);stroke-width:5}',
      '.opbac-clock__prog{fill:none;stroke:#22c55e;stroke-width:5;stroke-linecap:round;transition:stroke-dashoffset .35s linear}',
      '.opbac-clock--warn .opbac-clock__prog{stroke:#f59e0b}',
      '.opbac-clock--urgent .opbac-clock__prog{stroke:#ef4444}',
      '.opbac-clock__n{position:absolute;inset:0;display:grid;place-items:center;font-size:clamp(1.75rem,6vw,2.6rem);font-weight:900;font-variant-numeric:tabular-nums;color:var(--ink,#111);line-height:1}',
      '.opbac-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:.5rem .75rem .65rem}',
      '.opbac-vote{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:.45rem;padding:.55rem .75rem;background:color-mix(in srgb,#f59e0b 12%,var(--bg,#fff));border-bottom:1px solid color-mix(in srgb,#f59e0b 30%,var(--border,#ddd))}',
      '.opbac-vote__txt{flex:1 1 12rem;font-size:.8rem;font-weight:700;color:var(--ink,#222);text-align:center}',
      '.opbac-vote__btn{border:0;border-radius:999px;padding:.45rem .9rem;font-size:.82rem;font-weight:900;cursor:pointer;min-height:38px}',
      '.opbac-vote__btn--yes{background:#16a34a;color:#fff}',
      '.opbac-vote__btn--no{background:#dc2626;color:#fff}',
      '.opbac-idle{padding:1rem .85rem 1.1rem;text-align:center}',
      '.opbac-idle__art{width:min(240px,78vw);height:auto;margin:0 auto .75rem;display:block;border-radius:14px;box-shadow:0 8px 24px -12px rgba(99,102,241,.35)}',
      '.opbac-idle__txt{font-size:.9rem;color:var(--muted,#666);margin:0 0 .75rem;line-height:1.45}',
      '.opbac-idle__cta{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;border:0;border-radius:999px;padding:.75rem 1.35rem;font-size:.95rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;min-height:48px}',
      '.opbac-idle__help{margin-top:.55rem;border:0;background:none;color:var(--accent,#6366f1);font-size:.78rem;font-weight:700;cursor:pointer;text-decoration:underline}',
      '.opbac-idle__stopped{margin:0 auto .65rem;max-width:26rem;padding:.45rem .7rem;border-radius:10px;font-size:.82rem;font-weight:800;color:#9a3412;background:color-mix(in srgb,#f97316 12%,var(--bg,#fff));border:1px solid color-mix(in srgb,#f97316 28%,var(--border,#ddd))}',
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
      '.opbac-sheet{display:grid;grid-template-columns:repeat(var(--opbac-cols,3),minmax(0,1fr));gap:.55rem;width:100%;align-items:stretch}',
      '@media(max-width:720px){.opbac-sheet{grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))}}',
      '.opbac-col{display:flex;flex-direction:column;gap:.35rem;min-width:0;padding:.55rem .5rem;border-radius:12px;background:var(--bg-soft,rgba(127,127,127,.05));border:1px solid var(--border,#e5e5e5)}',
      '.opbac-col--ok{border-color:#86efac;background:color-mix(in srgb,#22c55e 7%,var(--bg,#fff))}',
      '.opbac-col--pending{border-color:#fcd34d;background:color-mix(in srgb,#fbbf24 6%,var(--bg,#fff))}',
      '.opbac-col__pending{display:inline-block;width:.85rem;height:.85rem;border-width:1.5px;vertical-align:middle;margin-left:.15rem}',
      '.opbac-col--reject{border-color:#fca5a5;background:color-mix(in srgb,#ef4444 5%,var(--bg,#fff))}',
      '.opbac-col__cat{font-size:.8rem;font-weight:900;text-transform:capitalize;color:var(--ink,#111);text-align:center;line-height:1.2;display:flex;align-items:center;justify-content:center;gap:.3rem}',
      '.opbac-col__ico{width:1.05rem;height:1.05rem;flex-shrink:0;color:#6366f1}',
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
      '.opbac-help-dialog__body,.opbac-help{padding:1rem 1.15rem 1.2rem;overflow-y:auto;line-height:1.5;max-height:min(72vh,620px)}',
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
      '.opbac-rules-modal__lead{margin:0 0 .85rem;font-size:.88rem;line-height:1.45;color:var(--ink,#222)}',
      '.opbac-rules-modal__list{margin:0 0 .85rem;padding-left:1.15rem;line-height:1.45}',
      '.opbac-rules-modal__list li{margin-bottom:.45rem;font-size:.86rem}',
      '.opbac-rules-modal__cmds{display:flex;flex-direction:column;gap:0;border:1px solid var(--border,#e5e5e5);border-radius:12px;overflow:hidden}',
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
      '.opbac-end{padding:.85rem .9rem 1rem}',
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
      '.opbac-end__actions{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.85rem}',
      '.opbac-end__btn{flex:1;min-width:8rem;border:0;border-radius:999px;padding:.65rem 1rem;font-size:.84rem;font-weight:800;cursor:pointer}',
      '.opbac-end__btn--primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
      '.opbac-end__btn--ghost{background:var(--bg-soft,rgba(127,127,127,.1));color:var(--ink,#111);border:1px solid var(--border,#ddd)}',
      '.opbac-end__empty{font-size:.82rem;color:var(--muted,#666);text-align:center;padding:.65rem;display:flex;align-items:center;justify-content:center;gap:.45rem}',
      '.opbac-end__chat-hint{margin:.85rem 0 0;text-align:center}',
      '.opbac-end__chat-btn{border:0;background:none;color:var(--accent,#6366f1);font-size:.8rem;font-weight:800;cursor:pointer;text-decoration:underline}',
      '.opbac-replay__q{margin:0 0 .25rem;font-size:1.08rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-replay__sub{margin:0 0 .75rem;font-size:.8rem;font-weight:600;color:var(--muted,#666)}',
      '.opbac-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem;margin-bottom:.75rem}',
      '@media(max-width:560px){.opbac-modes{grid-template-columns:1fr}}',
      '.opbac-mode{display:flex;flex-direction:column;align-items:center;gap:.15rem;padding:.55rem .4rem;border-radius:12px;border:2px solid var(--border,#ddd);background:var(--bg,#fff);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .12s;font:inherit;color:inherit}',
      '.opbac-mode:hover{border-color:color-mix(in srgb,#6366f1 40%,var(--border,#ccc));transform:translateY(-1px)}',
      '.opbac-mode--on{border-color:#6366f1;background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff));box-shadow:0 0 0 3px color-mix(in srgb,#6366f1 18%,transparent)}',
      '.opbac-mode__emoji{font-size:1.25rem;line-height:1}',
      '.opbac-mode__label{font-size:.82rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-mode__hint{font-size:.62rem;font-weight:700;color:var(--muted,#666);line-height:1.25}',
      '.opbac-replay__cta{display:block;width:100%;border:0;border-radius:999px;padding:.85rem 1rem;font-size:1rem;font-weight:900;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 10px 24px -10px rgba(99,102,241,.55);margin-bottom:.45rem}',
      '.opbac-replay__cta:hover{filter:brightness(1.05)}',
      '.opbac-replay__help{border:0;background:none;color:var(--accent,#6366f1);font-size:.76rem;font-weight:700;cursor:pointer;text-decoration:underline}',
      '.opbac-playpick__sec{margin:.15rem 0 .7rem}',
      '.opbac-playpick__h{margin:0 0 .4rem;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#666)}',
      '.opbac-customs{display:flex;flex-direction:column;gap:.35rem;max-height:9rem;overflow-y:auto;margin-bottom:.55rem}',
      '.opbac-customs__empty{margin:0;font-size:.78rem;color:var(--muted,#666)}',
      '.opbac-custom{display:flex;align-items:center;justify-content:space-between;gap:.45rem;width:100%;text-align:left;border:1.5px solid var(--border,#ddd);border-radius:10px;padding:.45rem .55rem;background:var(--bg,#fff);cursor:pointer;font:inherit;color:inherit}',
      '.opbac-custom--on{border-color:#6366f1;background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff))}',
      '.opbac-custom__name{font-size:.82rem;font-weight:800;color:var(--ink,#111)}',
      '.opbac-custom__hint{font-size:.68rem;font-weight:700;color:var(--muted,#666);white-space:nowrap}',
      '.opbac-create{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.4rem;margin:.35rem 0 .5rem}',
      '.opbac-create label{display:flex;flex-direction:column;gap:.2rem;font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#666)}',
      '.opbac-create input{border:1px solid var(--border,#ccc);border-radius:8px;padding:.4rem .45rem;font-size:.88rem;font-weight:700;min-height:38px;background:var(--bg,#fff);color:var(--ink,#111)}',
      '.opbac-create__btn{grid-column:1/-1;border:1px dashed color-mix(in srgb,#6366f1 45%,var(--border,#ccc));border-radius:10px;padding:.55rem .65rem;font-size:.8rem;font-weight:800;cursor:pointer;background:color-mix(in srgb,#6366f1 6%,var(--bg,#fff));color:#4338ca}',
      '.opbac-play-note{margin:.35rem 0 0;font-size:.72rem;color:var(--muted,#666);line-height:1.35}',
      'body.opbac-active .chan-hero{grid-template-columns:40px 1fr;padding:.22rem .7rem;gap:.45rem;min-height:0}',
      'body.opbac-active .chan-hero__media{width:40px;height:40px;min-height:40px;border-radius:9px}',
      'body.opbac-active .chan-hero__topic{-webkit-line-clamp:1;font-size:.72rem;line-height:1.25}',
      'body.opbac-active .chan-hero__by,body.opbac-active .chan-hero__more{display:none}',
      'body.opbac-active .main__room-bg{height:min(22%,160px)!important}',
      '@media(max-width:880px){body.opbac-active .chan-hero{grid-template-columns:32px 1fr;padding:.15rem .45rem;gap:.35rem}body.opbac-active .chan-hero__media{width:32px;height:32px;min-height:32px;border-radius:8px}}',
      '.opbac-word-toast{position:fixed;z-index:10000;left:50%;bottom:max(1rem,env(safe-area-inset-bottom));transform:translateX(-50%) translateY(12px);display:flex;align-items:center;gap:.65rem;padding:.65rem .85rem;border-radius:14px;background:var(--bg,#fff);border:1px solid color-mix(in srgb,#22c55e 35%,var(--border,#ddd));box-shadow:0 12px 40px -12px rgba(15,23,42,.35);opacity:0;pointer-events:none;transition:opacity .25s ease,transform .25s ease;max-width:min(92vw,22rem)}',
      '.opbac-word-toast--show{opacity:1;transform:translateX(-50%) translateY(0)}',
      '.opbac-word-toast--hide{opacity:0;transform:translateX(-50%) translateY(8px)}',
      '.opbac-word-toast__icon{width:2.1rem;height:2.1rem;border-radius:50%;display:grid;place-items:center;flex-shrink:0;background:transparent}',
      '.opbac-word-toast__icon img{width:2.1rem;height:2.1rem;display:block}',
      '.opbac-word-toast__body{display:flex;flex-direction:column;gap:.12rem;min-width:0}',
      '.opbac-word-toast__title{font-size:.88rem;font-weight:900;color:var(--ink,#111)}',
      '.opbac-word-toast__word{font-size:.82rem;font-weight:700;color:var(--ink,#222)}',
      '.opbac-word-toast__cat{font-size:.72rem;font-weight:700;color:var(--muted,#666);text-transform:capitalize}',
      '.opbac-word-toast__pts{font-size:.72rem;font-weight:800;color:#16a34a}',
      '.opbac-score-burst{position:absolute;left:50%;top:38%;z-index:60;pointer-events:none;display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);filter:drop-shadow(0 10px 22px rgba(15,23,42,.18))}',
      '.opbac-score-burst__n{font-size:clamp(2.6rem,9vw,4.4rem);font-weight:900;line-height:1;letter-spacing:-.03em;color:#16a34a;animation:opbacScorePop 1.35s cubic-bezier(.16,1.2,.3,1) both}',
      '.opbac-score-burst__lbl{margin-top:.15rem;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#15803d;opacity:.9;animation:opbacScoreLbl 1.35s ease both}',
      '.opbac-score-burst--hard .opbac-score-burst__n{color:#d97706;background:linear-gradient(180deg,#fbbf24,#d97706);-webkit-background-clip:text;background-clip:text;color:transparent}',
      '.opbac-score-burst--hard .opbac-score-burst__lbl{color:#b45309}',
      '.opbac-score-burst__spark{position:absolute;width:.45rem;height:.45rem;border-radius:50%;background:#4ade80;animation:opbacSpark 1.1s ease-out both}',
      '.opbac-score-burst--hard .opbac-score-burst__spark{background:#fbbf24}',
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
    if (phase !== 'playing' && phase !== 'paused') return { remaining: 0, progress: 0, total: 0 };
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
      '<span class="opbac-clock__n" data-opbac-timer>' + (remaining > 0 ? String(remaining) : '—') + '</span></div>';
  }

  function buildSideScoresHtml(game) {
    var rows = rankingForDisplay(game, false);
    var html = '<aside class="opbac-arena__scores" data-opbac-scores>' +
      '<p class="opbac-arena__scores-h">' + escHtml(pick({ fr: 'Scores', en: 'Scores' })) + '</p>';
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
    return '<div class="opbac-arena">' +
      '<div class="opbac-arena__play">' +
        '<div class="opbac-arena__block">' +
          '<span class="opbac-arena__lbl">' + escHtml(pick({ fr: 'Lettre', en: 'Letter' })) + '</span>' +
          '<div class="opbac-letter-xl" data-opbac-letter>' + escHtml(game.letter) + '</div>' +
        '</div>' +
        '<div class="opbac-arena__block">' +
          '<span class="opbac-arena__lbl">' + escHtml(pick({ fr: 'Temps', en: 'Time' })) + '</span>' +
          buildClockHtml(remaining, progress, 0) +
        '</div>' +
      '</div>' +
      buildSideScoresHtml(game) +
    '</div>';
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
    var showCountdown = (phase === 'countdown' || phase === 'go') && (remaining > 0 || game.countdown > 0);
    var cd = showCountdown ? (remaining > 0 ? remaining : game.countdown) : 0;
    var body = '';
    if (showCountdown && cd > 0) {
      body = '<div class="opbac-prep__cd" data-opbac-prep-cd>' + escHtml(String(cd)) + '</div>' +
        '<p class="opbac-prep__msg">' + escHtml(pick({ fr: 'C\'est parti dans…', en: 'Starting in…' })) + '</p>';
    } else {
      body = refreshSpinnerHtml('opbac-prep__spin') +
        '<p class="opbac-prep__msg">' + escHtml(
          phase === 'rules'
            ? pick({ fr: 'Lecture des règles…', en: 'Reading rules…' })
            : (phase === 'starting'
              ? pick({ fr: 'Préparation de la partie…', en: 'Setting up the game…' })
              : pick({ fr: 'La manche va commencer…', en: 'Round starting soon…' }))
        ) + '</p>';
    }
    if (game.letter) {
      body += '<div class="opbac-prep__letter" data-opbac-letter>' + escHtml(game.letter) + '</div>';
    }
    if (game.categories && game.categories.length) {
      body += '<p class="opbac-prep__cats">' + escHtml(game.categories.join(' · ')) + '</p>';
    }
    return '<div class="opbac-prep" data-opbac-prep>' +
      imgHtml('logo.svg', 'Petit Bac', 'opbac-prep__logo') +
      '<p class="opbac-prep__title">' + escHtml(title) + '</p>' +
      (detail ? '<p class="opbac-prep__detail">' + escHtml(detail) + '</p>' : '') +
      body + '</div>';
  }

  function buildPlayingBodyHtml(buffer, game, remaining, progress) {
    if (hasPlayableGrid(game)) {
      return buildStageHtml(game, remaining, progress) +
        '<div class="opbac-scroll"><div data-opbac-form>' + buildFormHtml(buffer, game) + '</div></div>';
    }
    if (isGameRunning(game)) return buildPrepScreenHtml(game, remaining);
    return '';
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

  function collapsedCtaKind(wasCollapsed, gameRunning, isEnd, isIdle, isGameEnd) {
    if (!wasCollapsed) return '';
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
    root.classList.remove('opbac-panel--collapsed');
    var collapseBtn = root.querySelector('[data-act="collapse"]');
    if (collapseBtn) {
      collapseBtn.textContent = '▴';
      collapseBtn.title = pick({ fr: 'Réduire', en: 'Collapse' });
    }
    applyPanelHeight(root, getPanelHeight(orbit));
    var ctaWrap = root.querySelector('[data-opbac-cta-wrap]');
    if (ctaWrap) ctaWrap.innerHTML = '';
    var playBtn = root.querySelector('[data-act="play-menu"]');
    if (playBtn) playBtn.hidden = false;
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
    if (playBtn) playBtn.hidden = root.classList.contains('opbac-panel--collapsed') && kind === 'play';
  }

  function buildHeadHtml(headBadge, modeBadge, wasCollapsed, gameActive, collapsedCta) {
    return '<div class="opbac-head">' +
      '<div class="opbac-head__brand">' +
        imgHtml('logo.svg', 'Petit Bac', 'opbac-head__logo') +
        '<span class="opbac-head__title">Petit Bac</span>' +
        '<span class="opbac-head__badge" data-opbac-head-badge>' + escHtml(headBadge) + '</span>' +
        '<span class="opbac-head__badge opbac-head__badge--mode" data-opbac-head-mode' +
          (modeBadge ? '' : ' hidden') + '>' + escHtml(modeBadge || '') + '</span>' +
      '</div>' +
      '<div class="opbac-head__actions">' +
        '<button type="button" class="opbac-head__btn" data-act="aide" title="' +
          escHtml(pick({ fr: 'Aide', en: 'Help' })) + '">?</button>' +
        (!gameActive
          ? ('<button type="button" class="opbac-head__btn" data-act="play-menu" title="' +
          escHtml(pick({ fr: 'Choisir un niveau', en: 'Choose a level' })) + '">▶</button>')
          : '') +
        '<span class="opbac-head__cta-wrap" data-opbac-cta-wrap>' +
          buildCollapsedCtaHtml(wasCollapsed ? collapsedCta : '') +
        '</span>' +
        '<button type="button" class="opbac-head__btn" data-act="collapse" title="' +
          escHtml(pick({ fr: 'Réduire', en: 'Collapse' })) + '">' + (wasCollapsed ? '▾' : '▴') + '</button>' +
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

  function formatPtsDisplay(pts) {
    var n = Number(pts);
    if (!(n >= 0)) n = 0;
    var s = Math.abs(n % 1) < 0.001 ? String(Math.round(n)) : String(n);
    return s + ' ' + pick({ fr: 'pt', en: 'pt' });
  }

  function defaultPanelHeight(orbit) {
    var main = document.querySelector('.main');
    var h = main ? Math.round(main.clientHeight * 0.6) : 420;
    return Math.max(PANEL_HEIGHT_MIN, Math.min(PANEL_HEIGHT_MAX, h));
  }

  function getPanelHeight(orbit) {
    try {
      var h = Number(orbit.storage.get(STORAGE_PANEL_HEIGHT, 0));
      if (h >= PANEL_HEIGHT_MIN && h <= PANEL_HEIGHT_MAX) return h;
    } catch (e) { /* ignore */ }
    return defaultPanelHeight(orbit);
  }

  function applyPanelHeight(root, h) {
    if (!root || root.classList.contains('opbac-panel--collapsed')) return;
    h = Math.max(PANEL_HEIGHT_MIN, Math.min(PANEL_HEIGHT_MAX, Number(h) || defaultPanelHeight(null)));
    root.__opbacPanelHeight = h;
    root.style.setProperty('--opbac-h', h + 'px');
  }

  function bindPanelResize(root, orbit) {
    if (root.__opbacResizeBound) return;
    root.__opbacResizeBound = true;
    root.addEventListener('pointerdown', function (ev) {
      var handle = ev.target && ev.target.closest ? ev.target.closest('[data-opbac-resize]') : null;
      if (!handle || root.classList.contains('opbac-panel--collapsed')) return;
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
    } else {
      rulesEscHandler = escHandler;
    }
    document.body.appendChild(overlay);
    return escHandler;
  }

  function buildRulesModalHtml() {
    return '<div class="opbac-rules-modal">' +
      '<p class="opbac-rules-modal__lead">' + escHtml(pick({
        fr: 'Voici le déroulé d\'une manche — le tchat reste visible derrière cette fenêtre.',
        en: 'How a round works — chat stays visible behind this window.',
      })) + '</p>' +
      '<ul class="opbac-rules-modal__list">' +
        helpHowToPlay().map(function (line) {
          return '<li>' + escHtml(line) + '</li>';
        }).join('') +
      '</ul>' +
      '<div class="opbac-rules-modal__cmds">' +
        buildHelpCmdRow('!jeu liste', pick({ fr: 'Voir les modes disponibles', en: 'List available modes' })) +
        buildHelpCmdRow('!jeu <mode>', pick({ fr: 'Changer de mode', en: 'Change mode' })) +
        buildHelpCmdRow('!oui / !non', pick({ fr: 'Voter', en: 'Vote' })) +
        buildHelpCmdRow('!aide', pick({ fr: 'Aide complète', en: 'Full help' })) +
      '</div></div>';
  }

  function maybeOpenRulesModal(orbit, channel) {
    var key = normChan(channel);
    if (rulesShownFor[key]) return;
    rulesShownFor[key] = true;
    openRulesModal(orbit);
  }

  function openRulesModal(orbit) {
    closeOverlayModal('rules');
    var title = pick({ fr: 'Règles du Petit Bac', en: 'Petit Bac rules' });
    var bodyHtml = buildRulesModalHtml();
    if (typeof orbit.modal === 'function') {
      rulesModalClose = orbit.modal(function () {
        return h('div', { className: 'opbac-help-wrap', dangerouslySetInnerHTML: { __html: bodyHtml } });
      }, { title: title, wide: true });
      return;
    }
    openOverlayDialog('opbac-rules-overlay', title, bodyHtml, 'rules');
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

  function requestModeList(orbit, buffer) {
    if (!orbit || !buffer) return;
    var now = Date.now();
    if (now - listeAt < 8000) return;
    listeAt = now;
    waitingListe = true;
    extraModes = [];
    try { orbit.irc.msg(buffer, '!jeu liste'); } catch (e) { /* ignore */ }
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
    handleModeListLine(plain);
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
      if (me) {
        try { pluginOrbit.storage.set('petitbacMode', me); } catch (e) { /* ignore */ }
        bumpStore();
        refreshPlayMenuCustom(me);
        var buf = pluginOrbit.state.active && pluginOrbit.state.active();
        if (buf) requestModeList(pluginOrbit, buf);
      }
      return true;
    }
    return false;
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
      '<button type="button" class="opbac-create__btn" data-act="create-mode">' +
        escHtml(pick({ fr: 'Créer mon jeu (il portera votre pseudo)', en: 'Create my game (named after your nick)' })) +
      '</button></div>' +
      '<p class="opbac-play-note">' + escHtml(pick({
        fr: 'Le bot enregistre le mode sous votre pseudo. Vous pourrez ensuite le relancer depuis la liste.',
        en: 'The bot saves the mode under your nick. You can start it again from the list.',
      })) + '</p>';
  }

  function buildPlayPickerHtml(selectedMode) {
    selectedMode = sanitizeModeId(selectedMode);
    var cards = gameModeOptions().map(function (m) {
      var on = m.id === selectedMode;
      return '<button type="button" class="opbac-mode' + (on ? ' opbac-mode--on' : '') + '" data-act="pick-mode" data-mode="' +
        escHtml(m.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="opbac-mode__emoji" aria-hidden="true">' + m.emoji + '</span>' +
        '<span class="opbac-mode__label">' + escHtml(m.label) + '</span>' +
        '<span class="opbac-mode__hint">' + escHtml(m.hint) + '</span></button>';
    }).join('');
    return '<div class="opbac-playpick" data-opbac-playpick>' +
      '<div class="opbac-playpick__sec">' +
        '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Niveaux officiels', en: 'Official levels' })) + '</p>' +
        '<div class="opbac-modes" role="group" aria-label="' + escHtml(pick({ fr: 'Niveau du jeu', en: 'Game level' })) + '">' +
          cards + '</div></div>' +
      '<div class="opbac-playpick__sec">' +
        '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Jeux personnalisés', en: 'Custom games' })) + '</p>' +
        '<div class="opbac-customs" data-opbac-customs>' + buildCustomModesHtml(selectedMode) + '</div></div>' +
      '<div class="opbac-playpick__sec">' +
        '<p class="opbac-playpick__h">' + escHtml(pick({ fr: 'Créer mon jeu', en: 'Create my game' })) + '</p>' +
        buildCreateModeHtml() +
      '</div></div>';
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
        var picked = sanitizeModeId(pickBtn.getAttribute('data-mode'));
        updateReplayModeUi(overlay, picked);
        var panel = document.getElementById('opbac-dom-panel');
        if (panel) updateReplayModeUi(panel, picked);
        try { orbit.storage.set('petitbacMode', picked); } catch (e) { /* ignore */ }
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
            fr: 'Choisissez un niveau officiel, un jeu personnalisé, ou créez le vôtre.',
            en: 'Pick an official level, a custom game, or create your own.',
          })) + '</p>' +
          buildPlayPickerHtml(selected) +
          '<button type="button" class="opbac-replay__cta" data-act="replay">' +
            escHtml(pick({ fr: '▶ Lancer la partie', en: '▶ Start the game' })) +
          '</button>' +
        '</div></div>';
    bindPlayOverlay(orbit, overlay);
    playEscHandler = function (ev) {
      if (ev.key === 'Escape') closeOverlayModal('play');
    };
    document.addEventListener('keydown', playEscHandler);
    document.body.appendChild(overlay);
  }

  function sendCreateMode(orbit, buffer, host) {
    var catsEl = host.querySelector('[data-create-cats]');
    var durEl = host.querySelector('[data-create-dur]');
    var roundsEl = host.querySelector('[data-create-rounds]');
    var cats = Math.max(3, Math.min(30, Number(catsEl && catsEl.value) || 5));
    var dur = Math.max(10, Math.min(300, Number(durEl && durEl.value) || 40));
    var rounds = Math.max(1, Math.min(50, Number(roundsEl && roundsEl.value) || 12));
    pendingCreate = true;
    orbit.irc.msg(buffer, '!jeu creer ' + cats + ' ' + dur + ' ' + rounds);
    try {
      orbit.notify('Petit Bac', pick({
        fr: 'Création du jeu ' + cats + ' cat. / ' + dur + ' s / ' + rounds + ' manches…',
        en: 'Creating game ' + cats + ' cat. / ' + dur + ' s / ' + rounds + ' rounds…',
      }));
    } catch (e) { /* ignore */ }
  }

  function buildReplaySectionHtml(selectedMode) {
    selectedMode = sanitizeModeId(selectedMode);
    return '<div class="opbac-replay" data-opbac-replay>' +
      '<h3 class="opbac-replay__q">' + escHtml(pick({ fr: 'Une nouvelle partie ?', en: 'Play again?' })) + '</h3>' +
      '<p class="opbac-replay__sub">' + escHtml(pick({
        fr: 'Choisissez un niveau, un jeu personnalisé, ou créez le vôtre.',
        en: 'Choose a level, a custom game, or create your own.',
      })) + '</p>' +
      buildPlayPickerHtml(selectedMode) +
      '<button type="button" class="opbac-replay__cta" data-act="replay">' +
        escHtml(pick({ fr: '▶ Oui, lancer une partie', en: '▶ Yes, start a game' })) +
      '</button>' +
      '<button type="button" class="opbac-replay__help" data-act="rules">' +
        escHtml(pick({ fr: 'Règles et commandes', en: 'Rules and commands' })) +
      '</button></div>';
  }

  function startReplayGame(orbit, buffer, root) {
    var mode = defaultReplayMode(null, root, orbit);
    try { orbit.storage.set('petitbacMode', mode); } catch (e) { /* ignore */ }
    orbit.irc.msg(buffer, '!jeu ' + mode);
    window.setTimeout(function () {
      orbit.irc.msg(buffer, '!jouer');
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

  function buildRankingTableHtml(rows, myNick) {
    if (!rows || !rows.length) {
      return '<p class="opbac-end__empty">' + refreshSpinnerHtml() + escHtml(pick({
        fr: 'Scores en cours de publication…',
        en: 'Scores being published…',
      })) + '</p>';
    }
    var body = rows.map(function (row, i) {
      var isMe = myNick && String(row.nick).toLowerCase() === myNick.toLowerCase();
      return '<tr class="' + (isMe ? 'opbac-end__me' : '') + '">' +
        '<td class="opbac-end__rank">' + rankMedal(i) + '</td>' +
        '<td>' + escHtml(row.nick) + (isMe ? ' ' + escHtml(pick({ fr: '(vous)', en: '(you)' })) : '') + '</td>' +
        '<td class="opbac-end__pts">' + escHtml(formatPtsDisplay(row.pts)) + '</td></tr>';
    }).join('');
    return '<table class="opbac-end__table"><thead><tr>' +
      '<th></th><th>' + escHtml(pick({ fr: 'Joueur', en: 'Player' })) + '</th>' +
      '<th>' + escHtml(pick({ fr: 'Points', en: 'Points' })) + '</th></tr></thead><tbody>' +
      body + '</tbody></table>';
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
      (game.endNotes || []).join('\n'),
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
              fr: 'Classement final après ' + game.totalRounds + ' manche' + (game.totalRounds > 1 ? 's' : ''),
              en: 'Final ranking after ' + game.totalRounds + ' round' + (game.totalRounds > 1 ? 's' : ''),
            })
            : pick({ fr: 'Voici le classement final de la partie', en: 'Final game ranking' })) +
        '</p></div>';

      html += '<div class="opbac-end__block">' +
        '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Classement final', en: 'Final ranking' })) + '</h3>' +
        buildRankingTableHtml(rankingForDisplay(game, true), myNick) +
        '</div>';

      if (game.topGlobal && game.topGlobal.length) {
        html += '<div class="opbac-end__block">' +
          '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Top joueurs (global)', en: 'Top players (global)' })) + '</h3>' +
          buildRankingTableHtml(game.topGlobal, myNick) +
          '</div>';
      }
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

    var notes = game.endNotes || [];
    if (isGameEnd) {
      if (!notes.length) {
        notes = [
          pick({ fr: '✏️ Suggestion : !suggestion <message>', en: '✏️ Suggestion: !suggestion <message>' }),
          pick({ fr: '🐞 Signaler un bug : !bug <message>', en: '🐞 Report a bug: !bug <message>' }),
        ];
      }
      if (notes.length) {
        html += '<div class="opbac-end__block">' +
          '<h3 class="opbac-end__h">' + escHtml(pick({ fr: 'Infos du bot', en: 'From the bot' })) + '</h3>' +
          '<div class="opbac-end__notes">' +
          notes.map(function (n) {
            return '<p class="opbac-end__note">' + escHtml(n) + '</p>';
          }).join('') +
          '</div></div>';
      }

      html += buildReplaySectionHtml(selectedMode);
      html += '<p class="opbac-end__chat-hint">' +
        '<button type="button" class="opbac-end__chat-btn" data-act="collapse">' +
          escHtml(pick({ fr: '↩ Revoir le tchat', en: '↩ Show chat' })) +
        '</button></p>';
    } else if (game.round && game.totalRounds && game.round < game.totalRounds) {
      html += '<p class="opbac-end__note" style="margin-top:.5rem">' +
        escHtml(pick({ fr: '⏳ La manche suivante va démarrer…', en: '⏳ Next round starting soon…' })) +
        '</p>';
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
      var pending = draft.pending[catKey] || draft.pending[cat];
      var rej = (draft.rejected && (draft.rejected[catKey] || draft.rejected[cat])) || null;
      var colClass = 'opbac-col' +
        (ok ? ' opbac-col--ok' : (rej ? ' opbac-col--reject' : (pending ? ' opbac-col--pending' : '')));
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
          (ok ? ' ✓' : '') + '</span>' +
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

  function updatePrepDom(root, remaining) {
    var cdEl = root.querySelector('[data-opbac-prep-cd]');
    if (cdEl && remaining > 0) cdEl.textContent = String(remaining);
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
    ].join(';');
    if (game.phase === 'game_end' || game.phase === 'round_end') {
      base += '|' + JSON.stringify(game.finalRanking || []) +
        '|' + JSON.stringify(game.scores || {}) +
        '|' + JSON.stringify(game.roundScores || {}) +
        '|' + (game.endNotes || []).join('\n');
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
    orbit.irc.msg(buffer, '!verifier ' + catName + ' ' + word);
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
      if (act === 'collapse') {
        root.classList.toggle('opbac-panel--collapsed');
        var collapsedNow = root.classList.contains('opbac-panel--collapsed');
        var collapseBtn = root.querySelector('[data-act="collapse"]');
        if (collapseBtn) {
          collapseBtn.textContent = collapsedNow ? '▾' : '▴';
          collapseBtn.title = collapsedNow
            ? pick({ fr: 'Développer', en: 'Expand' })
            : pick({ fr: 'Réduire', en: 'Collapse' });
        }
        if (collapsedNow) {
          root.style.removeProperty('--opbac-h');
        } else {
          applyPanelHeight(root, getPanelHeight(orbit));
        }
        var gameNow = getChannelState(buffer) || defaultState();
        var phaseNow = gameNow.phase || 'idle';
        var runningNow = isGameRunning(gameNow);
        var endNow = phaseNow === 'game_end' || phaseNow === 'round_end';
        var idleNow = !runningNow && phaseNow === 'idle' && !gameNow.letter;
        syncCollapsedCta(root, collapsedNow
          ? collapsedCtaKind(collapsedNow, runningNow, endNow, idleNow, phaseNow === 'game_end')
          : '');
        return;
      }
      if (act === 'play-now') {
        expandPanel(root, orbit);
        return;
      }
      if (act === 'join-game') {
        expandPanel(root, orbit, { focusInput: true });
        return;
      }
      if (act === 'jouer' || act === 'play-menu') {
        openPlayMenu(orbit);
        return;
      }
      if (act === 'pick-mode') {
        var picked = sanitizeModeId(btn.getAttribute('data-mode'));
        updateReplayModeUi(root, picked);
        try { orbit.storage.set('petitbacMode', picked); } catch (e) { /* ignore */ }
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
      if (act === 'aide') openHelpModal(orbit);
      if (act === 'rules') openRulesModal(orbit);
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
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    bindDomPanel(root, orbit);
    var game = getChannelState(buffer) || defaultState();
    var phase = game.phase || 'idle';
    var sig = panelSignature(game);
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

    if (rebuild) {
      saveDraftFromDom(root, buffer);
      root.__opbacSig = sig;
    }

    var timing = computeRemaining(game);
    var remaining = timing.remaining;
    var progress = timing.progress;
    var wasCollapsed = root.classList.contains('opbac-panel--collapsed');
    if (isRoundEnd) wasCollapsed = false;
    var headBadge = game.round && game.totalRounds
      ? ('Manche ' + game.round + '/' + game.totalRounds)
      : phaseLabel(phase, game.countdown);
    if (isGameEnd) {
      headBadge = pick({ fr: 'Partie terminée', en: 'Game over' });
    } else     if (isRoundEnd) {
      headBadge = pick({ fr: 'Fin de manche', en: 'Round over' });
    }
    if (isLive && game.fullComboNick && game.fullComboRound === roundKey(game)) {
      headBadge += ' · 🔥 Full combo';
    }
    var modeBadge = (gameRunning || isEnd) ? modeBadgeLabel(game.mode) : '';
    var collapsedCta = collapsedCtaKind(wasCollapsed, gameRunning, isEnd, isIdle, isGameEnd);

    root.className = 'opbac-panel' +
      (wasCollapsed ? ' opbac-panel--collapsed' : '') +
      ((isLive || isPrep) ? ' opbac-panel--playing' : '') +
      (isGameEnd ? ' opbac-panel--game-end' : '') +
      (isRoundEnd ? ' opbac-panel--round-end' : '') +
      ((isLive && game.fullComboNick && game.fullComboRound === roundKey(game)) ? ' opbac-panel--complete' : '');

    if (rebuild) {
      var bodyHtml = '';
      if (isIdle) {
        var stopBanner = game.stopReason
          ? ('<p class="opbac-idle__stopped">' + escHtml(game.stopReason === 'idle'
              ? pick({ fr: 'Partie arrêtée pour inactivité.', en: 'Game stopped due to inactivity.' })
              : pick({ fr: 'Partie arrêtée par un opérateur.', en: 'Game stopped by an operator.' })) +
            '</p>')
          : '';
        bodyHtml = '<div class="opbac-idle">' +
          imgHtml('idle-hero.svg', pick({ fr: 'Petit Bac', en: 'Petit Bac' }), 'opbac-idle__art') +
          stopBanner +
          '<p class="opbac-idle__txt">' + escHtml(pick({
            fr: 'Choisissez un niveau, un jeu personnalisé, ou créez le vôtre.',
            en: 'Pick a level, a custom game, or create your own.',
          })) + '</p>' +
          buildPlayPickerHtml(replayMode) +
          '<button type="button" class="opbac-idle__cta" data-act="replay">' +
            escHtml(pick({ fr: '▶ Lancer une partie', en: '▶ Start a game' })) +
          '</button>' +
          '<button type="button" class="opbac-idle__help" data-act="rules">' +
            escHtml(pick({ fr: 'Règles du jeu', en: 'Game rules' })) +
          '</button></div>';
        if (isBacBotPresent(orbit, buffer)) requestModeList(orbit, buffer);
      } else if (isEnd) {
        var endSig = endScreenSignature(game);
        var endAnimate = root.__opbacEndPhase !== phase;
        root.__opbacEndPhase = phase;
        root.__opbacEndSig = endSig;
        bodyHtml = buildEndScreenHtml(game, myNick, replayMode, endAnimate);
        root.__opbacReplayMode = replayMode;
        requestModeList(orbit, buffer);
      } else {
        bodyHtml = buildPlayingBodyHtml(buffer, game, remaining, progress);
      }

      root.innerHTML =
        buildHeadHtml(headBadge, modeBadge, wasCollapsed, gameRunning && !isEnd, collapsedCta) +
        '<div class="opbac-body">' + bodyHtml + '</div>' +
        '<div class="opbac-resize" data-opbac-resize role="separator" aria-label="' +
          escHtml(pick({ fr: 'Redimensionner le panneau', en: 'Resize panel' })) + '"></div>';

      bindPanelResize(root, orbit);
      if (!wasCollapsed) {
        var panelH = isGameEnd ? Math.max(getPanelHeight(orbit), 460) : getPanelHeight(orbit);
        applyPanelHeight(root, panelH);
      } else {
        root.style.removeProperty('--opbac-h');
      }

      root.__opbacDraftSig = draftSignature(buffer, game);

      if (isLive && !isEnd) {
        requestAnimationFrame(function () {
          var first = root.querySelector('.opbac-col__input:not([disabled])');
          if (first) first.focus();
        });
      }
      if (!isEnd) syncCompleteCelebration(root, buffer, game);
    } else {
      var headBadgeEl = root.querySelector('[data-opbac-head-badge]');
      if (headBadgeEl) headBadgeEl.textContent = headBadge;
      var modeEl = root.querySelector('[data-opbac-head-mode]');
      if (modeEl) {
        if (modeBadge) {
          modeEl.hidden = false;
          modeEl.textContent = modeBadge;
        } else {
          modeEl.hidden = true;
        }
      }
      syncCollapsedCta(root, collapsedCta);
      var customsEl = root.querySelector('[data-opbac-customs]');
      if (customsEl && (isIdle || isEnd)) {
        customsEl.innerHTML = buildCustomModesHtml(defaultReplayMode(game, root, orbit));
      }
      var scoresWrap = root.querySelector('[data-opbac-scores]');
      if (scoresWrap && (isLive || hasGrid) && !isEnd) {
        scoresWrap.outerHTML = buildSideScoresHtml(game);
      }
      if (isLive && !isEnd) updateClockDom(root, remaining, progress);
      else if (isPrep) updatePrepDom(root, remaining);

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
            if (bodyEl) bodyEl.innerHTML = endHtml;
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
        }
        syncCompleteCelebration(root, buffer, game);
      } else if (isPrep) {
        updatePrepDom(root, remaining);
      }
    }

    if (!rebuild && !wasCollapsed) {
      applyPanelHeight(root, root.__opbacPanelHeight || getPanelHeight(orbit));
    }
    if (!rebuild && isLive && !isEnd) updateClockDom(root, remaining, progress);
    if (!rebuild && isPrep && !isEnd) updatePrepDom(root, remaining);
    if (!isEnd && root.__opbacEndPhase) root.__opbacEndPhase = '';
    requestAnimationFrame(function () { pinChatIfFollowing(); });
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

  Orbit.plugin('orbit-petitbac', function (orbit, log) {
    pluginOrbit = orbit;
    injectStyles();
    console.info('[orbit-petitbac] loaded v' + PBAC_VER);

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

    log('orbit-petitbac ready');
    console.info('[orbit-petitbac] ready — channels:', (cfg(orbit).channels || []).join(', '));
  });

  }

  boot(0);
})();
