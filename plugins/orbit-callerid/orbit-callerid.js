/*!
 * orbit-callerid — contrôle parental + UX callerid (+g / ACCEPT) pour Orbit (EntreNous)
 *
 * Deux notions distinctes (ne pas les mélanger) :
 *   - Contrôle parental = security group (ex. controle-parentale). Peut appliquer un
 *     *paquet* de modes serveur (+ixIgcRw). Le badge « Contrôle parental actif » ne
 *     dépend QUE du groupe, pas d’un mode isolé.
 *   - Callerid / +g = filtre MP (ACCEPT). N’importe qui peut activer +g (ou i, x, …)
 *     un par un ; l’UI liste blanche / 718 s’y accroche sans parler de parental.
 *
 * config.json:
 *   "callerid": { "group": "controle-parentale", "modes": "+ixIgcRw", "autoMode": true }
 *   "plugins": [".../orbit-callerid/orbit-callerid.js?v=10"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var React = Orbit.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useSyncExternalStore = React.useSyncExternalStore;

  var DEFAULT_GROUP = 'controle-parentale';
  var DEFAULT_MODES = '+ixIgcRw';
  var STORAGE_ACCEPT = 'savedAccept';
  var STORAGE_PERSIST = 'persistAccept';
  var STORAGE_DENY = 'savedDeny';

  /** Notice markers (neutral — no « parental ») for cross-client signaling. */
  var MARK_ACCEPT_FR = 'Votre demande de conversation a été acceptée';
  var MARK_ACCEPT_EN = 'Your conversation request has been accepted';
  var MARK_REFUSE_FR = 'Votre demande de conversation a été refusée';
  var MARK_REFUSE_EN = 'Your conversation request has been declined';
  var MARK_BLOCK_FR = 'Vous ne pouvez plus envoyer de messages privés à cet utilisateur';
  var MARK_BLOCK_EN = 'You can no longer send private messages to this user';

  var myGroupsText = '';
  /** Security-group parental policy (NOT the same as having +g). */
  var parentalActive = false;
  /** Callerid UX: +g / demandes 718 (peut exister sans contrôle parental). */
  var calleridActive = false;
  var modesApplied = false;
  var restoreDone = false;
  var popupOpenFor = Object.create(null);
  /** Last PRIVMSG text we tried to send while blocked by +g (nick → text). */
  var outboundText = Object.create(null);
  /** Nicks we already told « blocked » after a refuse (session). */
  var refuseNotified = Object.create(null);

  /** Incoming requests (718): nick → { nick, host, ts } */
  var pending = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribePending(cb) { pending.listeners.add(cb); return function () { pending.listeners.delete(cb); }; }
  function getPendingSnap() { return pending.rev; }
  function pendingKey(nick) { return String(nick || '').toLowerCase(); }
  function listPending() {
    var out = [];
    Object.keys(pending.map).forEach(function (k) { out.push(pending.map[k]); });
    return out;
  }
  function setPending(nick, data) {
    var key = pendingKey(nick);
    if (!key) return;
    if (data) pending.map[key] = data;
    else delete pending.map[key];
    pending.rev++;
    pending.listeners.forEach(function (l) { l(); });
  }

  /** Outgoing waits (716/717): nick → { nick, ts, informed } */
  var outgoing = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribeOutgoing(cb) { outgoing.listeners.add(cb); return function () { outgoing.listeners.delete(cb); }; }
  function getOutgoingSnap() { return outgoing.rev; }
  function setOutgoing(nick, data) {
    var key = pendingKey(nick);
    if (!key) return;
    if (data) outgoing.map[key] = data;
    else delete outgoing.map[key];
    outgoing.rev++;
    outgoing.listeners.forEach(function (l) { l(); });
  }
  function getOutgoing(nick) { return outgoing.map[pendingKey(nick)] || null; }

  /** Target peer flags from WHOIS: nick → { g: bool, group: bool } */
  var peers = { map: Object.create(null), rev: 0, listeners: new Set(), loading: Object.create(null) };
  function subscribePeers(cb) { peers.listeners.add(cb); return function () { peers.listeners.delete(cb); }; }
  function getPeersSnap() { return peers.rev; }
  function bumpPeers() {
    peers.rev++;
    peers.listeners.forEach(function (l) { l(); });
  }
  function getPeer(nick) { return peers.map[pendingKey(nick)] || null; }
  function patchPeer(nick, patch) {
    var key = pendingKey(nick);
    if (!key) return;
    var cur = peers.map[key] || { nick: nick, g: false, group: false };
    peers.map[key] = {
      nick: patch.nick || cur.nick || nick,
      g: patch.g != null ? !!patch.g : cur.g,
      group: patch.group != null ? !!patch.group : cur.group,
    };
    bumpPeers();
  }

  /** ACCEPT whitelist from RPL_ACCEPTLIST (281) */
  var acceptList = { nicks: [], rev: 0, listeners: new Set(), loading: false };
  function subscribeAccept(cb) { acceptList.listeners.add(cb); return function () { acceptList.listeners.delete(cb); }; }
  function getAcceptSnap() { return acceptList.rev; }
  function bumpAccept() {
    acceptList.rev++;
    acceptList.listeners.forEach(function (l) { l(); });
  }
  function beginAcceptList() {
    acceptList.nicks = [];
    acceptList.loading = true;
    bumpAccept();
  }
  function pushAcceptNick(nick) {
    if (!nick) return;
    var n = String(nick);
    var low = fold(n);
    for (var i = 0; i < acceptList.nicks.length; i++) {
      if (fold(acceptList.nicks[i]) === low) return;
    }
    acceptList.nicks.push(n);
    bumpAccept();
  }
  function endAcceptList() {
    acceptList.loading = false;
    bumpAccept();
  }

  /** UI store: parental (group) + callerid (+g) kept separate. */
  var gate = { parental: false, callerid: false, rev: 0, listeners: new Set() };
  function subscribeGate(cb) { gate.listeners.add(cb); return function () { gate.listeners.delete(cb); }; }
  function getGateSnap() { return gate.rev; }
  function bumpGate() {
    gate.parental = parentalActive;
    gate.callerid = calleridActive;
    gate.rev++;
    gate.listeners.forEach(function (l) { l(); });
  }
  function setParental(on) {
    parentalActive = !!on;
    bumpGate();
  }
  function setCallerid(on) {
    calleridActive = !!on;
    bumpGate();
  }

  /** Full-pane allow-list view (Status-like), not a modal. */
  var listView = { open: false, rev: 0, listeners: new Set() };
  function subscribeListView(cb) { listView.listeners.add(cb); return function () { listView.listeners.delete(cb); }; }
  function getListViewSnap() { return listView.rev; }
  function setListViewOpen(on) {
    listView.open = !!on;
    try { document.body.classList.toggle('ocid-view-open', listView.open); } catch (e) { /* ignore */ }
    listView.rev++;
    listView.listeners.forEach(function (l) { l(); });
  }

  function cfg(orbit) {
    var c = (orbit.config() && orbit.config().callerid) || {};
    return {
      group: String(c.group || DEFAULT_GROUP).toLowerCase(),
      modes: String(c.modes || DEFAULT_MODES),
      autoMode: c.autoMode !== false,
    };
  }

  function pick(orbit, table) {
    if (orbit.i18n && orbit.i18n.pick) return orbit.i18n.pick(table);
    return table.fr || table.en || '';
  }

  function fold(s) {
    return String(s || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
  }

  function isChannelName(name) {
    return /^[#&+!]/.test(name || '');
  }

  function myUmodes(orbit) {
    try {
      var st = orbit.state.get();
      return String((st && st.umodes) || '');
    } catch (e) {
      return '';
    }
  }

  function hasModeG(orbit) {
    return myUmodes(orbit).indexOf('g') > -1;
  }

  function isParentalGroup(orbit) {
    var group = cfg(orbit).group;
    return !!(group && myGroupsText.toLowerCase().indexOf(group) > -1);
  }

  /**
   * Full parental *package* of modes (e.g. ixIgcRw), not a single letter.
   * Used when the security group is not visible in WHOIS but the server applied
   * the whole set. Having only +g (or any subset) must NOT count as parental.
   */
  function hasParentalModePackage(orbit) {
    var pack = String(cfg(orbit).modes || '').replace(/^[+-]+/, '');
    if (pack.length < 2) return false;
    var um = myUmodes(orbit);
    for (var i = 0; i < pack.length; i++) {
      if (um.indexOf(pack.charAt(i)) < 0) return false;
    }
    return true;
  }

  function isParental(orbit) {
    return isParentalGroup(orbit) || hasParentalModePackage(orbit);
  }

  function loadSavedAccept(orbit) {
    try {
      var v = orbit.storage.get(STORAGE_ACCEPT, []);
      return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function saveAcceptNick(orbit, nick, add) {
    var persist = true;
    try { persist = orbit.storage.get(STORAGE_PERSIST, true) !== false; } catch (e) { /* ignore */ }
    if (!persist) return;
    var list = loadSavedAccept(orbit);
    var low = fold(nick);
    var next = list.filter(function (n) { return fold(n) !== low; });
    if (add) next.push(String(nick).trim());
    try { orbit.storage.set(STORAGE_ACCEPT, next); } catch (e) { /* ignore */ }
  }

  function persistEnabled(orbit) {
    try { return orbit.storage.get(STORAGE_PERSIST, true) !== false; } catch (e) { return true; }
  }

  function setPersistEnabled(orbit, on) {
    try { orbit.storage.set(STORAGE_PERSIST, !!on); } catch (e) { /* ignore */ }
  }

  function restoreSavedAccept(orbit, log) {
    if (restoreDone || !calleridActive) return;
    restoreDone = true;
    var list = loadSavedAccept(orbit);
    if (!list.length) return;
    log('callerid: restauration ACCEPT (' + list.length + ')');
    list.forEach(function (nick) {
      try { orbit.irc.send('ACCEPT +' + nick); } catch (e) { /* ignore */ }
    });
    window.setTimeout(function () { refreshAcceptList(orbit); }, 400);
  }

  /** Apply the parental *mode package* — only when the security group is confirmed. */
  function applyParentalModes(orbit) {
    if (!parentalActive) return;
    var c = cfg(orbit);
    if (!c.autoMode) return;
    var nick = orbit.state.nick();
    if (!nick) return;
    var modes = c.modes;
    if (!modes || (modes.charAt(0) !== '+' && modes.charAt(0) !== '-')) modes = '+' + modes;
    try {
      orbit.irc.send('MODE ' + nick + ' ' + modes);
      modesApplied = true;
    } catch (e) { /* ignore */ }
  }

  function requestWhois(orbit, nick) {
    var n = nick || orbit.state.nick();
    if (!n) return;
    try { orbit.irc.send('WHOIS ' + n); } catch (e) { /* ignore */ }
  }

  function probePeer(orbit, nick) {
    var key = pendingKey(nick);
    if (!key || isChannelName(nick) || nick === 'Status') return;
    if (peers.loading[key]) return;
    peers.loading[key] = true;
    requestWhois(orbit, nick);
  }

  function sendAccept(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return false;
    if (n.charAt(0) === '+' || n.charAt(0) === '-') n = n.slice(1);
    if (!n) return false;
    try {
      orbit.irc.send('ACCEPT ' + (add ? '+' : '-') + n);
      saveAcceptNick(orbit, n, add);
      return true;
    } catch (e) {
      return false;
    }
  }

  function refreshAcceptList(orbit) {
    beginAcceptList();
    try { orbit.irc.send('ACCEPT *'); } catch (e) { endAcceptList(); }
  }

  /** Parental policy: security group and/or the full mode package — never a lone +g. */
  function activateParental(orbit, log, reason) {
    if (!isParental(orbit)) return;
    if (!parentalActive) {
      setParental(true);
      log('callerid: contrôle parental' + (reason ? ' — ' + reason : ''));
    }
    if (!modesApplied) applyParentalModes(orbit);
    activateCallerid(orbit, log, 'parental');
  }

  /** Callerid UX (+g / ACCEPT). Independent of the parental label. */
  function activateCallerid(orbit, log, reason) {
    if (!calleridActive) {
      setCallerid(true);
      log('callerid: filtre MP (+g / ACCEPT)' + (reason ? ' — ' + reason : ''));
    }
    restoreSavedAccept(orbit, log);
  }

  function syncFromWhois(orbit, log) {
    if (isParental(orbit)) activateParental(orbit, log, isParentalGroup(orbit) ? 'groupe' : 'paquet-modes');
    else if (parentalActive) setParental(false);

    if (hasModeG(orbit)) activateCallerid(orbit, log, '+g');
    if (calleridActive) refreshAcceptList(orbit);
  }

  function loadSavedDeny(orbit) {
    try {
      var v = orbit.storage.get(STORAGE_DENY, []);
      return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  /** Denied / SILENCE’d nicks — shown in the allow-list UI for unblock. */
  var denyUi = { rev: 0, listeners: new Set() };
  function subscribeDeny(cb) { denyUi.listeners.add(cb); return function () { denyUi.listeners.delete(cb); }; }
  function getDenySnap() { return denyUi.rev; }
  function bumpDeny() {
    denyUi.rev++;
    denyUi.listeners.forEach(function (l) { l(); });
  }

  function isDenied(orbit, nick) {
    var low = fold(nick);
    if (!low) return false;
    return loadSavedDeny(orbit).some(function (n) { return fold(n) === low; });
  }

  function saveDenyNick(orbit, nick, add) {
    var list = loadSavedDeny(orbit);
    var low = fold(nick);
    var next = list.filter(function (n) { return fold(n) !== low; });
    if (add) next.push(String(nick).trim());
    try { orbit.storage.set(STORAGE_DENY, next); } catch (e) { /* ignore */ }
    bumpDeny();
  }

  function unblockNick(orbit, nick) {
    var n = String(nick || '').trim();
    if (!n) return;
    saveDenyNick(orbit, n, false);
    silenceNick(orbit, n, false);
    delete refuseNotified[pendingKey(n)];
    orbit.notify(
      pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
      pick(orbit, {
        fr: n + ' n’est plus bloqué. Il pourra à nouveau demander à vous écrire.',
        en: n + ' is unblocked. They may request to message you again.',
      })
    );
  }

  function openPm(orbit, nick) {
    try {
      var st = orbit.state.get();
      if (st && typeof st.openQuery === 'function') {
        st.openQuery(nick);
        return true;
      }
      if (st && typeof st.setActive === 'function') {
        st.setActive(nick);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function pushLocalLine(orbit, buffer, text, kind) {
    try {
      var st = orbit.state.get();
      if (st && typeof st.pushLocal === 'function') {
        st.pushLocal(buffer, text, '', kind || 'system');
        return;
      }
    } catch (e) { /* ignore */ }
  }

  function captureOutboundText(orbit, nick) {
    try {
      var st = orbit.state.get();
      var buffers = (st && st.buffers) || {};
      var buf = buffers[nick] || buffers[fold(nick)];
      if (!buf && buffers) {
        Object.keys(buffers).forEach(function (k) {
          if (fold(k) === fold(nick)) buf = buffers[k];
        });
      }
      var msgs = (buf && buf.messages) || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].self && (msgs[i].kind === 'privmsg' || msgs[i].kind === 'action')) {
          outboundText[pendingKey(nick)] = String(msgs[i].text || '');
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }

  function noticePeer(orbit, nick, text) {
    try { orbit.irc.send('NOTICE ' + nick + ' :' + text); } catch (e) { /* ignore */ }
  }

  function silenceNick(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return;
    // InspIRCd silence: +mask flags — p = private messages. Harmless if module absent.
    try {
      orbit.irc.send('SILENCE ' + (add ? '+' : '-') + n + ' p');
    } catch (e) { /* ignore */ }
  }

  function acceptAndClear(orbit, nick) {
    var n = String(nick || '').trim();
    if (!n) return;
    if (!sendAccept(orbit, n, true)) return;
    setPending(n, null);
    delete popupOpenFor[pendingKey(n)];
    saveDenyNick(orbit, n, false);
    silenceNick(orbit, n, false);

    openPm(orbit, n);
    pushLocalLine(orbit, n, pick(orbit, {
      fr: 'Vous avez accepté la conversation avec ' + n + '.',
      en: 'You accepted the conversation with ' + n + '.',
    }), 'system');

    var acceptMsg = pick(orbit, {
      fr: MARK_ACCEPT_FR + '. Vous pouvez écrire.',
      en: MARK_ACCEPT_EN + '. You can write now.',
    });
    // PRIVMSG so their client opens the PM and they can reply (message was never delivered by +g).
    try { orbit.irc.msg(n, acceptMsg); } catch (e) { noticePeer(orbit, n, acceptMsg); }

    orbit.notify(
      pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
      pick(orbit, {
        fr: n + ' peut maintenant vous écrire — conversation ouverte.',
        en: n + ' can now message you — conversation opened.',
      })
    );
    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  function refuseRequest(orbit, nick) {
    var n = String(nick || '').trim();
    if (!n) return;
    setPending(n, null);
    delete popupOpenFor[pendingKey(n)];
    // Callerid has no server deny list — only ACCEPT whitelist. We persist a local
    // deny list and SILENCE (if available) so retries are blocked / ignored.
    saveDenyNick(orbit, n, true);
    silenceNick(orbit, n, true);

    var refuseMsg = pick(orbit, {
      fr: MARK_REFUSE_FR + '. ' + MARK_BLOCK_FR + '.',
      en: MARK_REFUSE_EN + '. ' + MARK_BLOCK_EN + '.',
    });
    noticePeer(orbit, n, refuseMsg);
    refuseNotified[pendingKey(n)] = true;

    orbit.notify(
      pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
      pick(orbit, {
        fr: 'Demande de ' + n + ' refusée. Il ne pourra plus vous écrire en privé.',
        en: 'Request from ' + n + ' declined. They can no longer private-message you.',
      })
    );
  }

  function ignoreRequest(nick) {
    // Back-compat alias — prefer refuseRequest(orbit, nick) when orbit is available.
    setPending(nick, null);
    delete popupOpenFor[pendingKey(nick)];
  }

  function isAcceptNotice(text) {
    var t = String(text || '');
    return t.indexOf(MARK_ACCEPT_FR) > -1 || t.indexOf(MARK_ACCEPT_EN) > -1;
  }

  function isRefuseNotice(text) {
    var t = String(text || '');
    return t.indexOf(MARK_REFUSE_FR) > -1 || t.indexOf(MARK_REFUSE_EN) > -1;
  }

  function handlePeerDecision(orbit, fromNick, text) {
    if (!fromNick) return;
    if (isAcceptNotice(text)) {
      setOutgoing(fromNick, null);
      openPm(orbit, fromNick);
      pushLocalLine(orbit, fromNick, pick(orbit, {
        fr: fromNick + ' a accepté votre demande. Vous pouvez dialoguer.',
        en: fromNick + ' accepted your request. You can chat now.',
      }), 'system');
      var pending = outboundText[pendingKey(fromNick)];
      if (pending) {
        delete outboundText[pendingKey(fromNick)];
        try { orbit.irc.msg(fromNick, pending); } catch (e) { /* ignore */ }
      }
      orbit.notify(
        pick(orbit, { fr: 'Conversation acceptée', en: 'Conversation accepted' }),
        pick(orbit, {
          fr: fromNick + ' a accepté votre demande.',
          en: fromNick + ' accepted your request.',
        })
      );
      return;
    }
    if (isRefuseNotice(text)) {
      setOutgoing(fromNick, null);
      delete outboundText[pendingKey(fromNick)];
      // Do not open a PM on refuse.
      orbit.notify(
        pick(orbit, { fr: 'Conversation refusée', en: 'Conversation declined' }),
        pick(orbit, {
          fr: fromNick + ' a refusé. ' + MARK_BLOCK_FR + '.',
          en: fromNick + ' declined. ' + MARK_BLOCK_EN + '.',
        })
      );
      setOutgoing(fromNick, { nick: fromNick, ts: Date.now(), informed: true, refused: true });
    }
  }

  function openRequestPopup(orbit, req) {
    if (!req || !req.nick) return;
    var key = pendingKey(req.nick);
    if (popupOpenFor[key]) return;
    if (typeof orbit.modal !== 'function') return;
    popupOpenFor[key] = true;
    var close = orbit.modal(function () {
      return h('div', { className: 'ocid-popup' },
        h('div', { className: 'ocid-popup__icon', 'aria-hidden': true }, h(ShieldIcon, { size: 36 })),
        h('p', { className: 'ocid-popup__lead' },
          h('span', { className: 'ocid-banner__nick' }, req.nick),
          ' ',
          pick(orbit, {
            fr: 'souhaite vous écrire en message privé.',
            en: 'wants to send you a private message.',
          })
        ),
        h('p', { className: 'ocid-modal__empty' },
          parentalActive
            ? pick(orbit, {
              fr: 'Le contrôle parental bloque les MP jusqu’à votre accord. Accepter ajoute cette personne à votre liste blanche.',
              en: 'Parental controls block PMs until you agree. Accepting adds them to your allow list.',
            })
            : pick(orbit, {
              fr: 'Vous filtrez les messages privés (mode +g). Accepter ajoute cette personne à votre liste blanche.',
              en: 'You are filtering private messages (+g). Accepting adds them to your allow list.',
            })
        ),
        h('div', { className: 'ocid-popup__actions' },
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () {
              acceptAndClear(orbit, req.nick);
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () {
              refuseRequest(orbit, req.nick);
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'Refuser', en: 'Decline' }))
        )
      );
    }, {
      title: pick(orbit, { fr: 'Demande de message privé', en: 'Private message request' }),
      wide: false,
    });
  }

  function openListView(orbit) {
    refreshAcceptList(orbit);
    setListViewOpen(true);
  }

  function closeListView() {
    setListViewOpen(false);
  }

  /** @deprecated name kept for call sites — opens the full Status-like pane. */
  function openListModal(orbit) { openListView(orbit); }

  function injectStyles() {
    if (document.getElementById('orbit-callerid-css')) return;
    var style = document.createElement('style');
    style.id = 'orbit-callerid-css';
    style.textContent = [
      '.ocid-side{display:flex;align-items:center;gap:.45rem;margin:.55rem .8rem .4rem;padding:.4rem .65rem;border-radius:8px;background:color-mix(in srgb,#0ea5e9 14%,var(--bg,#fff));border:1px solid color-mix(in srgb,#0ea5e9 35%,var(--border,rgba(0,0,0,.12)));color:var(--ink,inherit);font-size:.82rem;font-weight:600;width:calc(100% - 1.6rem);box-sizing:border-box;text-align:left;cursor:default}',
      '.ocid-room{cursor:default}',
      '.ocid-side__dot{width:.55rem;height:.55rem;border-radius:50%;background:#0ea5e9;flex:none}',
      '.ocid-side__txt{flex:1;min-width:0}',
      '.ocid-side__n{opacity:.75;font-weight:500;font-size:.78rem}',
      '.ocid-room .room__av[data-ocid]{background:color-mix(in srgb,#0ea5e9 22%,#dfe4ea);color:#0369a1}',
      '.ocid-room.is-active{background:var(--accent-soft)}',
      '.ocid-room.is-active::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:60%;border-radius:0 3px 3px 0;background:var(--accent);box-shadow:0 0 10px 0 rgba(20,82,204,.6)}',
      '.ocid-room.is-active .room__name{color:var(--accent-d);font-weight:800}',
      /* Full-pane view (like Status): hide chat chrome, fill main column */
      'body.ocid-view-open .messages,body.ocid-view-open .composer,body.ocid-view-open .chan-hero,body.ocid-view-open .main__room-bg,body.ocid-view-open .empty{display:none!important}',
      'body.ocid-view-open .main{background:var(--bg)}',
      '.ocid-view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg);border-top:1px solid var(--border,rgba(0,0,0,.08))}',
      '.ocid-view__head{display:flex;align-items:center;gap:.65rem;flex:none;padding:.7rem 1rem;border-bottom:1px solid var(--border,rgba(0,0,0,.1));background:var(--bg-soft,rgba(0,0,0,.02))}',
      '.ocid-view__title{margin:0;font-size:1.05rem;font-weight:800;letter-spacing:-.01em;flex:1;min-width:0}',
      '.ocid-view__sub{margin:0;font-size:.82rem;color:var(--muted,var(--faint));font-weight:500}',
      '.ocid-view__body{flex:1 1 auto;min-height:0;overflow:auto;padding:1rem 1.15rem 1.4rem}',
      '.ocid-view .ocid-modal{max-width:36rem;min-width:0;width:100%;margin:0 auto}',
      '.ocid-banner{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.55rem .85rem;margin:0;border-bottom:1px solid var(--border,rgba(0,0,0,.1));background:color-mix(in srgb,#0ea5e9 12%,var(--bg,#fff));color:var(--ink,inherit);font-size:.92rem;flex:none}',
      '.ocid-banner--wait{background:color-mix(in srgb,#f59e0b 14%,var(--bg,#fff));border-bottom-color:color-mix(in srgb,#f59e0b 30%,var(--border,rgba(0,0,0,.1)))}',
      '.ocid-banner__txt{flex:1 1 12rem;min-width:0}',
      '.ocid-banner__nick{font-weight:600}',
      '.ocid-banner__btn{appearance:none;border:1px solid var(--border,rgba(0,0,0,.15));background:var(--bg,#fff);color:inherit;border-radius:6px;padding:.28rem .7rem;cursor:pointer;font:inherit}',
      '.ocid-banner__btn--ok{background:#0ea5e9;border-color:#0ea5e9;color:#fff}',
      '.ocid-banner__btn:hover{filter:brightness(1.05)}',
      '.ocid-modal{display:flex;flex-direction:column;gap:.75rem;padding:.25rem 0}',
      '.ocid-modal__row{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--border,rgba(0,0,0,.08))}',
      '.ocid-modal__empty{opacity:.7;font-size:.92rem;margin:0}',
      '.ocid-modal__actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}',
      '.ocid-modal__check{display:flex;align-items:center;gap:.45rem;font-size:.9rem;cursor:pointer}',
      '.ocid-modal input[type=text]{flex:1 1 8rem;min-width:0;padding:.4rem .6rem;border:1px solid var(--border,rgba(0,0,0,.15));border-radius:6px;background:var(--bg,#fff);color:inherit;font:inherit}',
      '.ocid-popup{display:flex;flex-direction:column;align-items:stretch;gap:.85rem;padding:.35rem .15rem .15rem;max-width:24rem}',
      '.ocid-popup__icon{align-self:center;color:#0ea5e9}',
      '.ocid-popup__lead{margin:0;font-size:1.05rem;text-align:center;line-height:1.35}',
      '.ocid-popup__actions{display:flex;gap:.55rem;justify-content:center;flex-wrap:wrap}',
      '.topbar__search.ocid-topbar.is-on{background:var(--accent-soft,rgba(20,82,204,.14));color:var(--accent-d,var(--accent))}',
      '.topbar__search.ocid-topbar .ocid-topbar__badge{position:absolute;top:2px;right:2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:#0ea5e9;color:#fff;font-size:.65rem;font-weight:800;line-height:14px;text-align:center}',
      '.topbar__search.ocid-topbar{position:relative}',
    ].join('');
    document.head.appendChild(style);
  }

  function ShieldIcon(props) {
    var size = (props && props.size) || 18;
    return h('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
      stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M12 3 5 6.5v5.2c0 4.2 2.8 7.4 7 8.8 4.2-1.4 7-4.6 7-8.8V6.5L12 3z' })
    );
  }

  function SideBadge(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    // Indicator only — does not open the allow-list view.
    if (!gate.parental) return null;
    var n = listPending().length;
    return h('div', {
      className: 'ocid-side',
      role: 'status',
      title: pick(orbit, { fr: 'Contrôle parental actif', en: 'Parental controls on' }),
    },
      h('span', { className: 'ocid-side__dot', 'aria-hidden': true }),
      h('span', { className: 'ocid-side__txt' },
        pick(orbit, { fr: 'Contrôle parental actif', en: 'Parental controls on' })
      ),
      n ? h('span', { className: 'ocid-side__n' }, '(' + n + ')') : null
    );
  }

  /** Sidebar row only while the allow-list pane is open (opened via topbar icon). */
  function WhitelistRoomRow(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeListView, getListViewSnap, getListViewSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    if (!listView.open) return null;
    var n = listPending().length;
    return h('div', {
      className: 'room ocid-room is-active' + (n ? ' has-unread' : ''),
      role: 'status',
      title: pick(orbit, { fr: 'Liste blanche ouverte', en: 'Allow list open' }),
    },
      h('span', { className: 'room__av', 'data-ocid': true, 'aria-hidden': true }, h(ShieldIcon, { size: 18 })),
      h('span', { className: 'room__body' },
        h('span', { className: 'room__name' },
          pick(orbit, { fr: 'Liste blanche', en: 'Allow list' })
        ),
        h('span', { className: 'room__sub' },
          pick(orbit, {
            fr: 'Messages privés autorisés',
            en: 'Allowed private messages',
          })
        )
      ),
      n ? h('span', { className: 'room__badge' }, n > 99 ? '99+' : String(n)) : null
    );
  }

  function TopbarButton(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeListView, getListViewSnap, getListViewSnap);
    if (!gate.callerid && !gate.parental && !listPending().length) return null;
    var n = listPending().length;
    return h('button', {
      type: 'button',
      className: 'topbar__search ocid-topbar' + ((n || listView.open) ? ' is-on' : ''),
      title: pick(orbit, { fr: 'Liste blanche des messages privés', en: 'Private-message allow list' }),
      'aria-label': pick(orbit, { fr: 'Liste blanche MP', en: 'PM allow list' }),
      'aria-pressed': listView.open,
      onClick: function () {
        if (listView.open) closeListView();
        else openListView(orbit);
      },
    },
      h(ShieldIcon, { size: 19 }),
      n ? h('span', { className: 'ocid-topbar__badge', 'aria-hidden': true }, n > 9 ? '9+' : String(n)) : null
    );
  }

  function WhitelistPane(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeListView, getListViewSnap, getListViewSnap);
    useEffect(function () {
      try { document.body.classList.toggle('ocid-view-open', !!listView.open); } catch (e) { /* ignore */ }
      return function () {
        try { document.body.classList.remove('ocid-view-open'); } catch (e2) { /* ignore */ }
      };
    }, [listView.open]);
    if (!listView.open) return null;
    return h('div', { className: 'ocid-view', role: 'region', 'aria-label': pick(orbit, { fr: 'Liste blanche', en: 'Allow list' }) },
      h('div', { className: 'ocid-view__head' },
        h('span', { 'aria-hidden': true }, h(ShieldIcon, { size: 22 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h2', { className: 'ocid-view__title' },
            pick(orbit, { fr: 'Liste blanche', en: 'Allow list' })
          ),
          h('p', { className: 'ocid-view__sub' },
            pick(orbit, {
              fr: 'Personnes autorisées à vous écrire en message privé',
              en: 'People allowed to private-message you',
            })
          )
        ),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn',
          onClick: function () { closeListView(); },
        }, pick(orbit, { fr: 'Fermer', en: 'Close' }))
      ),
      h('div', { className: 'ocid-view__body' },
        h(ListModalBody, { orbit: orbit, onClose: closeListView })
      )
    );
  }

  function MainOverlays(props) {
    var orbit = props.orbit;
    return h(React.Fragment, null,
      h(ChatBanners, { orbit: orbit }),
      h(WhitelistPane, { orbit: orbit })
    );
  }

  function ChatBanners(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribeOutgoing, getOutgoingSnap, getOutgoingSnap);
    useSyncExternalStore(subscribePeers, getPeersSnap, getPeersSnap);
    var active = useSyncExternalStore(
      function (cb) { return orbit.on('buffer.active', cb); },
      function () { return orbit.state.active(); },
      function () { return orbit.state.active(); }
    );

    useEffect(function () {
      if (!active || isChannelName(active) || active === 'Status') return;
      probePeer(orbit, active);
    }, [active]);

    var nodes = [];

    if (gate.callerid || listPending().length) {
      var items = listPending();
      if (items.length) {
        var req = items[0];
        nodes.push(h('div', { key: 'in-' + req.nick, className: 'ocid-banner', role: 'status' },
          h('span', { className: 'ocid-banner__txt' },
            h('span', { className: 'ocid-banner__nick' }, req.nick),
            ' ',
            pick(orbit, {
              fr: 'souhaite vous écrire en message privé.',
              en: 'wants to send you a private message.',
            }),
            items.length > 1
              ? ' (' + items.length + ' ' + pick(orbit, { fr: 'demandes', en: 'requests' }) + ')'
              : ''
          ),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () { acceptAndClear(orbit, req.nick); },
          }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () { refuseRequest(orbit, req.nick); },
          }, pick(orbit, { fr: 'Refuser', en: 'Decline' }))
        ));
      }
    }

    if (active && !isChannelName(active) && active !== 'Status') {
      var wait = getOutgoing(active);
      var peer = getPeer(active);
      // Never tell the requester this is « contrôle parental » — that would expose
      // a protected (often underage) account. Neutral callerid wording only.
      var peerCallerid = !!(peer && (peer.g || peer.group));
      if (wait || peerCallerid) {
        var waitTxt;
        if (wait && wait.refused) {
          waitTxt = pick(orbit, {
            fr: active + ' a refusé la conversation. Vous ne pouvez plus lui envoyer de messages privés.',
            en: active + ' declined the conversation. You can no longer send them private messages.',
          });
        } else if (wait) {
          waitTxt = pick(orbit, {
            fr: 'Votre message est en attente : ' + active + ' doit vous autoriser avant de pouvoir dialoguer en privé.',
            en: 'Your message is pending: ' + active + ' must allow you before private chat.',
          });
        } else {
          waitTxt = pick(orbit, {
            fr: active + ' n’accepte les messages privés que sur autorisation. Attendez son accord pour dialoguer.',
            en: active + ' only accepts private messages when allowed. Wait for their approval to chat.',
          });
        }
        nodes.push(h('div', { key: 'out-' + fold(active), className: 'ocid-banner ocid-banner--wait', role: 'status' },
          h('span', { className: 'ocid-banner__txt' }, waitTxt),
          wait
            ? h('button', {
              type: 'button',
              className: 'ocid-banner__btn',
              onClick: function () { setOutgoing(active, null); },
            }, pick(orbit, { fr: 'Masquer', en: 'Dismiss' }))
            : null
        ));
      }
    }

    if (!nodes.length) return null;
    return h(React.Fragment, null, nodes);
  }

  function ListModalBody(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeAccept, getAcceptSnap, getAcceptSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeDeny, getDenySnap, getDenySnap);
    var [draft, setDraft] = useState('');
    var [persist, setPersist] = useState(function () { return persistEnabled(orbit); });
    var nicks = acceptList.nicks.slice();
    var pendingItems = listPending();
    var saved = loadSavedAccept(orbit);
    var denied = loadSavedDeny(orbit);

    return h('div', { className: 'ocid-modal' },
      h('p', { className: 'ocid-modal__empty' },
        pick(orbit, {
          fr: 'Seules les personnes acceptées peuvent vous écrire en privé (mode +g).',
          en: 'Only accepted people can private-message you (+g).',
        })
      ),
      h('label', { className: 'ocid-modal__check' },
        h('input', {
          type: 'checkbox',
          checked: persist,
          onChange: function (e) {
            var on = !!e.target.checked;
            setPersist(on);
            setPersistEnabled(orbit, on);
            if (on) {
              nicks.forEach(function (n) { saveAcceptNick(orbit, n, true); });
            }
          },
        }),
        pick(orbit, {
          fr: 'Conserver la liste entre les connexions',
          en: 'Keep this list across connections',
        })
      ),
      pendingItems.length
        ? h('div', null,
          h('b', null, pick(orbit, { fr: 'Demandes en cours', en: 'Pending requests' })),
          pendingItems.map(function (req) {
            return h('div', { key: 'p-' + req.nick, className: 'ocid-modal__row' },
              h('span', null, req.nick),
              h('span', { className: 'ocid-modal__actions' },
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn ocid-banner__btn--ok',
                  onClick: function () { acceptAndClear(orbit, req.nick); },
                }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn',
                  onClick: function () { refuseRequest(orbit, req.nick); },
                }, pick(orbit, { fr: 'Refuser', en: 'Decline' }))
              )
            );
          })
        )
        : null,
      h('b', null, pick(orbit, { fr: 'Personnes acceptées', en: 'Accepted' })),
      acceptList.loading && !nicks.length
        ? h('p', { className: 'ocid-modal__empty' }, pick(orbit, { fr: 'Chargement…', en: 'Loading…' }))
        : null,
      !acceptList.loading && !nicks.length
        ? h('p', { className: 'ocid-modal__empty' }, pick(orbit, {
          fr: 'Aucune entrée pour l’instant.',
          en: 'No entries yet.',
        }))
        : null,
      nicks.map(function (nick) {
        return h('div', { key: nick, className: 'ocid-modal__row' },
          h('span', null, nick),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () {
              sendAccept(orbit, nick, false);
              window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
            },
          }, pick(orbit, { fr: 'Retirer', en: 'Remove' }))
        );
      }),
      persist && saved.length
        ? h('p', { className: 'ocid-modal__empty' },
          pick(orbit, {
            fr: 'Mémorisés pour la prochaine connexion : ' + saved.join(', '),
            en: 'Remembered for next login: ' + saved.join(', '),
          })
        )
        : null,
      h('b', null, pick(orbit, { fr: 'Personnes bloquées', en: 'Blocked' })),
      h('p', { className: 'ocid-modal__empty' },
        pick(orbit, {
          fr: 'Refusés (liste locale + SILENCE). Débloquez pour autoriser une nouvelle demande.',
          en: 'Declined (local list + SILENCE). Unblock to allow a new request.',
        })
      ),
      !denied.length
        ? h('p', { className: 'ocid-modal__empty' }, pick(orbit, {
          fr: 'Aucun pseudo bloqué.',
          en: 'No blocked nicks.',
        }))
        : null,
      denied.map(function (nick) {
        return h('div', { key: 'd-' + nick, className: 'ocid-modal__row' },
          h('span', null, nick),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () { unblockNick(orbit, nick); },
          }, pick(orbit, { fr: 'Débloquer', en: 'Unblock' }))
        );
      }),
      h('div', { className: 'ocid-modal__actions' },
        h('input', {
          type: 'text',
          value: draft,
          placeholder: pick(orbit, { fr: 'Pseudo à autoriser', en: 'Nick to allow' }),
          onChange: function (e) { setDraft(e.target.value); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' && draft.trim()) {
              sendAccept(orbit, draft.trim(), true);
              saveDenyNick(orbit, draft.trim(), false);
              silenceNick(orbit, draft.trim(), false);
              setDraft('');
              window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
            }
          },
        }),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn ocid-banner__btn--ok',
          onClick: function () {
            if (!draft.trim()) return;
            sendAccept(orbit, draft.trim(), true);
            saveDenyNick(orbit, draft.trim(), false);
            silenceNick(orbit, draft.trim(), false);
            setDraft('');
            window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
          },
        }, pick(orbit, { fr: 'Ajouter', en: 'Add' })),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn',
          onClick: function () { refreshAcceptList(orbit); bumpDeny(); },
        }, pick(orbit, { fr: 'Actualiser', en: 'Refresh' }))
      )
    );
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    if (!gate.callerid && !gate.parental && !listPending().length) return null;
    var n = listPending().length;
    var label = pick(orbit, { fr: 'Liste blanche MP', en: 'PM allow list' });
    if (n) label += ' (' + n + ')';
    return h('button', {
      type: 'button',
      className: 'nmenu__item',
      role: 'menuitem',
      onClick: function () { openListModal(orbit); },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(ShieldIcon)),
      h('span', { className: 'nmenu__txt' }, h('b', null, label))
    );
  }

  function modesContainG(text) {
    var m = String(text || '');
    var idx = m.search(/modes\s+/i);
    if (idx > -1) m = m.slice(idx + 6);
    m = m.replace(/^\+/, '');
    return m.indexOf('g') > -1;
  }

  Orbit.plugin('orbit-callerid', function (orbit, log) {
    injectStyles();
    // Never leave the full-pane view open from a previous session / HMR.
    try { document.body.classList.remove('ocid-view-open'); } catch (e) { /* ignore */ }
    listView.open = false;

    function boot() {
      myGroupsText = '';
      modesApplied = false;
      restoreDone = false;
      popupOpenFor = Object.create(null);
      refuseNotified = Object.create(null);
      outboundText = Object.create(null);
      setParental(false);
      setCallerid(false);
      closeListView();
      requestWhois(orbit);
      try { orbit.irc.send('MODE ' + (orbit.state.nick() || '')); } catch (e) { /* ignore */ }
      // +g alone → callerid only. Full mode package → parental.
      if (hasParentalModePackage(orbit)) activateParental(orbit, log, 'paquet-modes');
      else if (hasModeG(orbit)) activateCallerid(orbit, log, 'umodes');
    }

    boot();
    orbit.on('connected', boot);

    orbit.on('buffer.active', function (name) {
      if (listView.open) closeListView();
      if (name && !isChannelName(name) && name !== 'Status') probePeer(orbit, name);
    });

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '');
      var params = msg.params || [];
      var me = orbit.state.nick() || '';
      var targetNick = params[1] || '';

      if (cmd === '221') {
        var umodeis = String(params[1] || params[0] || '');
        // Snapshot umodes may lag; use the numeric itself for package / +g checks.
        var fakeOrbit = {
          state: { get: function () { return { umodes: umodeis.replace(/^\+/, '') }; } },
          config: orbit.config.bind(orbit),
        };
        if (hasParentalModePackage(fakeOrbit)) activateParental(orbit, log, '221-paquet');
        else if (umodeis.indexOf('g') > -1) activateCallerid(orbit, log, '221');
        return;
      }

      if (cmd === '320' && targetNick && fold(targetNick) === fold(me)) {
        myGroupsText = (myGroupsText + ' ' + (params[2] || '')).trim();
      }

      // Peer WHOIS: group = parental; +g = callerid filter only
      if (cmd === '320' && targetNick && fold(targetNick) !== fold(me)) {
        var special = String(params[2] || '').toLowerCase();
        if (special.indexOf(cfg(orbit).group) > -1) {
          patchPeer(targetNick, { nick: targetNick, group: true });
        }
      }
      if (cmd === '379' && targetNick) {
        var modeLine = params[2] || params[1] || '';
        if (fold(targetNick) === fold(me)) {
          var selfModes = String(modeLine).replace(/^.*modes\s*/i, '').replace(/^\+/, '');
          var selfOrbit = {
            state: { get: function () { return { umodes: selfModes }; } },
            config: orbit.config.bind(orbit),
          };
          if (hasParentalModePackage(selfOrbit)) activateParental(orbit, log, '379-paquet');
          else if (modesContainG(modeLine)) activateCallerid(orbit, log, '379');
        } else {
          var peerModes = String(modeLine).replace(/^.*modes\s*/i, '').replace(/^\+/, '');
          var peerPack = false;
          var pack = String(cfg(orbit).modes || '').replace(/^[+-]+/, '');
          if (pack.length >= 2) {
            peerPack = true;
            for (var pi = 0; pi < pack.length; pi++) {
              if (peerModes.indexOf(pack.charAt(pi)) < 0) { peerPack = false; break; }
            }
          }
          patchPeer(targetNick, {
            nick: targetNick,
            g: modesContainG(modeLine),
            group: peerPack || !!(getPeer(targetNick) && getPeer(targetNick).group),
          });
        }
      }
      if (cmd === '318' && targetNick) {
        delete peers.loading[pendingKey(targetNick)];
        if (fold(targetNick) === fold(me)) syncFromWhois(orbit, log);
      }

      // Self MODE: +g → callerid; full package → parental; re-apply package only if parental
      if (cmd === 'MODE') {
        var modeTarget = params[0] || '';
        var modeStr = String(params[1] || '');
        if (fold(modeTarget) === fold(me)) {
          window.setTimeout(function () {
            if (hasParentalModePackage(orbit)) activateParental(orbit, log, 'MODE-paquet');
            else if (hasModeG(orbit)) activateCallerid(orbit, log, 'MODE+g');
            else if (!listPending().length) setCallerid(false);
          }, 0);
          if (parentalActive && cfg(orbit).autoMode && modeStr.indexOf('-') > -1 && /[gixIRcRw]/.test(modeStr)) {
            window.setTimeout(function () {
              modesApplied = false;
              applyParentalModes(orbit);
            }, 400);
          }
        }
      }

      // Requester: target has +g (callerid) — wording stays neutral
      if (cmd === '716') {
        var blocked = params[1] || '';
        if (blocked) {
          captureOutboundText(orbit, blocked);
          setOutgoing(blocked, { nick: blocked, ts: Date.now(), informed: false });
          orbit.notify(
            pick(orbit, { fr: 'Message en attente', en: 'Message pending' }),
            pick(orbit, {
              fr: 'Votre message à ' + blocked + ' est en attente d’autorisation.',
              en: 'Your message to ' + blocked + ' is awaiting approval.',
            })
          );
        }
        return;
      }
      if (cmd === '717') {
        var informed = params[1] || '';
        if (informed) {
          captureOutboundText(orbit, informed);
          var prev = getOutgoing(informed) || { nick: informed, ts: Date.now() };
          setOutgoing(informed, { nick: informed, ts: prev.ts || Date.now(), informed: true });
          orbit.notify(
            pick(orbit, { fr: 'Demande envoyée', en: 'Request sent' }),
            pick(orbit, {
              fr: informed + ' a été informé de votre demande de conversation.',
              en: informed + ' has been notified of your conversation request.',
            })
          );
        }
        return;
      }

      // Incoming callerid request (+g) — not automatically « parental »
      if (cmd === '718') {
        var fromNick = params[1] || '';
        var fromHost = params[2] || '';
        if (!fromNick) return;
        if (isDenied(orbit, fromNick)) {
          // Already refused — do not reopen UI; remind once per session if they retry.
          if (!refuseNotified[pendingKey(fromNick)]) {
            noticePeer(orbit, fromNick, pick(orbit, {
              fr: MARK_BLOCK_FR + '.',
              en: MARK_BLOCK_EN + '.',
            }));
            refuseNotified[pendingKey(fromNick)] = true;
          }
          return;
        }
        activateCallerid(orbit, log, '718');
        setPending(fromNick, { nick: fromNick, host: fromHost, ts: Date.now() });
        orbit.notify(
          pick(orbit, { fr: 'Demande de message', en: 'Message request' }),
          pick(orbit, {
            fr: fromNick + ' souhaite vous écrire. Acceptez ou refusez depuis la bannière.',
            en: fromNick + ' wants to message you. Accept or decline from the banner.',
          })
        );
        openRequestPopup(orbit, { nick: fromNick, host: fromHost });
        return;
      }

      if (cmd === '281') {
        if (acceptList.loading) {
          var accepted = params.length >= 2 ? params[1] : params[0];
          if (accepted && (params.length < 2 || fold(accepted) !== fold(me))) {
            pushAcceptNick(accepted);
          }
        }
        return;
      }
      if (cmd === '282') {
        endAcceptList();
        return;
      }

      var up = String(cmd).toUpperCase();
      if ((up === 'PRIVMSG' || up === 'NOTICE') && msg.nick) {
        if (fold(msg.nick) === fold(me)) return;
        var body = (params.length >= 2 ? params[1] : '') || '';
        if (isAcceptNotice(body) || isRefuseNotice(body) || body.indexOf(MARK_BLOCK_FR) > -1 || body.indexOf(MARK_BLOCK_EN) > -1) {
          handlePeerDecision(orbit, msg.nick, body);
          return;
        }
        if (up === 'PRIVMSG' && getOutgoing(msg.nick) && !getOutgoing(msg.nick).refused) {
          setOutgoing(msg.nick, null);
        }
      }
    });

    orbit.addUi('sidebar_item', function () { return h(SideBadge, { orbit: orbit }); });
    orbit.addUi('sidebar_room', function () { return h(WhitelistRoomRow, { orbit: orbit }); });
    orbit.addUi('overlay', function () { return h(MainOverlays, { orbit: orbit }); });
    orbit.addUi('topbar_item', function () { return h(TopbarButton, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });

    if (typeof orbit.addCommand === 'function') {
      function nickArg(args, rest) {
        if (Array.isArray(args) && args[0]) return String(args[0]).trim();
        return String(rest || args || '').trim().split(/\s+/)[0] || '';
      }
      orbit.addCommand('accepter', {
        help: pick(orbit, {
          fr: 'Autoriser un pseudo à vous écrire (ACCEPT +nick)',
          en: 'Allow a nick to message you (ACCEPT +nick)',
        }),
        run: function (args, rest) {
          var nick = nickArg(args, rest);
          if (!nick) {
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: 'Usage : /accepter <pseudo>', en: 'Usage: /accepter <nick>' }));
            return;
          }
          acceptAndClear(orbit, nick);
        },
      });
      orbit.addCommand('refuser', {
        help: pick(orbit, {
          fr: 'Refuser une demande de MP (et bloquer les nouvelles tentatives)',
          en: 'Decline a PM request (and block further attempts)',
        }),
        run: function (args, rest) {
          var nick = nickArg(args, rest);
          if (!nick) {
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: 'Usage : /refuser <pseudo>', en: 'Usage: /refuser <nick>' }));
            return;
          }
          refuseRequest(orbit, nick);
        },
      });
      orbit.addCommand('listeaccept', {
        help: pick(orbit, {
          fr: 'Afficher la liste blanche des messages privés',
          en: 'Show the private-message allow list',
        }),
        run: function () { openListModal(orbit); },
      });
    }

    log('orbit-callerid ready');
  });
})();
