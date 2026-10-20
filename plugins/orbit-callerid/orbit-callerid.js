/*!
 * orbit-callerid — contrôle parental + UX callerid (+g / ACCEPT) pour Orbit (EntreNous)
 *
 * Deux notions distinctes (ne pas les mélanger) :
 *   - Contrôle parental = security group (ex. controle-parentale). Peut appliquer un
 *     *paquet* de modes serveur (+ixIgcRw). Le badge « Contrôle parental actif » ne
 *     dépend QUE du groupe, pas d’un mode isolé.
 *   - Callerid / +g = filtre MP (ACCEPT). N’importe qui peut activer +g (ou i, x, …)
 *     un par un ; l’UI liste blanche / 718 s’y accroche sans parler de parental.
 *   - Amis Orbit → ACCEPT (liste blanche) ; Ignore Orbit → SILENCE/deny (liste noire).
 *
 * config.json:
 *   "callerid": {
 *     "group": "controle-parentale", "modes": "+ixIgcRw", "autoMode": true,
 *     "safeChannels": ["#EntreJeunes.chat"], "warnOfficialJoins": true
 *   }
 *   "plugins": [".../orbit-callerid/orbit-callerid.js?v=56"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var React = Orbit.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useSyncExternalStore = React.useSyncExternalStore;

  var DEFAULT_GROUP = 'controle-parentale';
  var DEFAULT_MODES = '+ixIgcRw';
  var DEFAULT_SAFE_CHANNELS = ['#EntreJeunes.chat'];
  var CHAN_WARN_TIMEOUT_MS = 2800;
  /** Local Orbit buffer (not a channel) so the topbar / member list detach from the salon. */
  var ALLOWLIST_BUF = 'Liste blanche';
  var STORAGE_ACCEPT = 'savedAccept';
  var STORAGE_PERSIST = 'persistAccept';
  var STORAGE_DENY = 'savedDeny';
  var STORAGE_BLOCKED_BY = 'blockedBy';
  var STORAGE_WANT_G = 'wantCallerid';
  /** User opted out of the « MP bloqués » tip (+D / enveloppe). */
  var STORAGE_HIDE_PRIVDEAF_TIP = 'hidePmBlockedTip';
  /** User opted out of the official-channel warn popup (parental). */
  var STORAGE_HIDE_CHANNEL_WARN = 'hideChannelWarn';
  var privDeafTipOpen = false;
  var privDeafWasOn = false;
  /** Current browser-session identity (account or nick) for in-memory lists. */
  var sessionOwner = '';

  /** Notice markers (neutral — no « parental ») for cross-client signaling. */
  var MARK_ACCEPT_FR = 'Votre demande de conversation a été acceptée';
  var MARK_ACCEPT_EN = 'Your conversation request has been accepted';
  var MARK_REFUSE_FR = 'Votre demande de conversation a été refusée';
  var MARK_REFUSE_EN = 'Your conversation request has been declined';
  var MARK_REVOKED_FR = 'La conversation a été bloquée';
  var MARK_REVOKED_EN = 'The conversation has been blocked';
  var MARK_BLOCK_FR = 'Vous ne pouvez plus envoyer de messages privés à cet utilisateur';
  var MARK_BLOCK_EN = 'You can no longer send private messages to this user';
  var MARK_UNBLOCK_FR = 'Vous n’êtes plus bloqué : vous pouvez à nouveau demander une conversation';
  var MARK_UNBLOCK_EN = 'You are no longer blocked: you may request a conversation again';

  var myGroupsText = '';
  /** Security-group parental policy (NOT the same as having +g). */
  var parentalActive = false;
  /** Callerid UX: +g / demandes 718 (peut exister sans contrôle parental). */
  var calleridActive = false;
  var modesApplied = false;
  var restoreDone = false;
  var denyRestoreDone = false;
  var popupOpenFor = Object.create(null);
  /** Last PRIVMSG text we tried to send while blocked by +g (nick → text). */
  var outboundText = Object.create(null);
  /** Nicks the server confirmed on our ACCEPT list (not the optimistic local copy). */
  var acceptConfirmed = Object.create(null);
  /** First blocked PM already resent after the peer accepted (nick → true). */
  var resentFirst = Object.create(null);
  /** « Masquer » on the pending banner, until the next refresh. */
  var dismissedOutgoingWait = Object.create(null);
  /** Ignores history replay when deciding who started the PM this session. */
  var sessionStartedAt = Date.now();
  /** Nicks we already told « blocked » after a refuse (session). */
  var refuseNotified = Object.create(null);
  /** Blocker-side banner dismissed for these nicks (session). */
  var dismissedWeBlocked = Object.create(null);
  /** Requester-side « X vous a bloqué » dismissed until the next refresh (session). */
  var dismissedPeerBlocked = Object.create(null);
  var STATUS_BUF = '$server';

  /**
   * Top-of-PM tip after ACCEPT (replaces the inline blue ACTION:allowlist line).
   * nick → { nick, kind: 'we-accepted' | 'they-accepted' }
   */
  var acceptedTips = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribeAcceptedTips(cb) {
    acceptedTips.listeners.add(cb);
    return function () { acceptedTips.listeners.delete(cb); };
  }
  function getAcceptedTipsSnap() { return acceptedTips.rev; }
  function setAcceptedTip(nick, data) {
    var key = pendingKey(nick);
    if (!key) return;
    if (data) acceptedTips.map[key] = data;
    else delete acceptedTips.map[key];
    acceptedTips.rev++;
    acceptedTips.listeners.forEach(function (l) { l(); });
  }
  function getAcceptedTip(nick) { return acceptedTips.map[pendingKey(nick)] || null; }

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
  var peers = { map: Object.create(null), rev: 0, listeners: new Set(), loading: Object.create(null), probedAt: Object.create(null) };
  var PEER_WHOIS_TTL = 10 * 60 * 1000;
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
    // Already allowed — drop a stale 718 banner/popup for this nick.
    if (pending.map[low]) {
      delete pending.map[low];
      delete popupOpenFor[low];
      pending.rev++;
      pending.listeners.forEach(function (l) { l(); });
    }
    bumpAccept();
  }
  function forgetAcceptNick(nick) {
    var low = fold(nick);
    if (!low) return;
    var next = [];
    var i;
    for (i = 0; i < acceptList.nicks.length; i++) {
      if (fold(acceptList.nicks[i]) !== low) next.push(acceptList.nicks[i]);
    }
    acceptList.nicks = next;
    bumpAccept();
  }
  function endAcceptList() {
    acceptList.loading = false;
    prunePendingAllowed(lastOrbit);
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
  var lastOrbit = null;

  function setParental(on) {
    parentalActive = !!on;
    bumpGate();
    try {
      var st = lastOrbit && lastOrbit.state && lastOrbit.state.get();
      if (st && typeof st.setParentalControls === 'function') st.setParentalControls(!!on);
    } catch (e) { /* ignore */ }
  }
  function setCallerid(on) {
    calleridActive = !!on;
    bumpGate();
  }

  /** Full-pane allow-list view — backed by a local buffer so chrome is independent of the salon. */
  var listView = { open: false, rev: 0, listeners: new Set(), prevActive: '', switching: false };
  function subscribeListView(cb) { listView.listeners.add(cb); return function () { listView.listeners.delete(cb); }; }
  function getListViewSnap() { return listView.rev; }
  function setListViewOpen(on) {
    listView.open = !!on;
    try { document.body.classList.toggle('ocid-view-open', listView.open); } catch (e) { /* ignore */ }
    listView.rev++;
    listView.listeners.forEach(function (l) { l(); });
  }

  function isAllowlistBuffer(name) {
    return fold(name) === fold(ALLOWLIST_BUF);
  }

  function chatState(orbit) {
    try { return orbit.state.get(); } catch (e) { return null; }
  }

  /** Hide Orbit's native PM row for our buffer — we render the shield tab via sidebar_room. */
  function hideNativeAllowlistRow() {
    try {
      var rooms = document.querySelector('.rooms');
      if (!rooms) return;
      rooms.querySelectorAll('.room:not(.ocid-room)').forEach(function (row) {
        var nm = row.querySelector('.room__name');
        var label = nm ? String(nm.textContent || '').trim() : '';
        if (isAllowlistBuffer(label)) {
          row.hidden = true;
          row.setAttribute('data-ocid-native-hide', '1');
        }
      });
    } catch (e) { /* ignore */ }
  }

  function revealNativeAllowlistRows() {
    try {
      document.querySelectorAll('.room[data-ocid-native-hide]').forEach(function (row) {
        row.hidden = false;
        row.removeAttribute('data-ocid-native-hide');
      });
    } catch (e) { /* ignore */ }
  }

  function cfg(orbit) {
    var c = (orbit.config() && orbit.config().callerid) || {};
    var safe = Array.isArray(c.safeChannels) && c.safeChannels.length
      ? c.safeChannels
      : DEFAULT_SAFE_CHANNELS;
    return {
      group: String(c.group || DEFAULT_GROUP).toLowerCase(),
      modes: String(c.modes || DEFAULT_MODES),
      autoMode: c.autoMode !== false,
      warnOfficialJoins: c.warnOfficialJoins !== false,
      safeChannels: safe.map(function (ch) { return fold(ch); }),
      officialSuffix: String(c.officialSuffix != null ? c.officialSuffix : '.chat').toLowerCase(),
    };
  }

  /** Official-channel cache: fold(chan) → { official: bool|null, ts } */
  var officialCache = Object.create(null);
  /**
   * Channel safety banner for this visit: fold(chan) → { chan, hidden }.
   * hidden = user closed it; cleared on PART/KICK so the next join shows it again.
   */
  var channelWarn = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribeChannelWarn(cb) {
    channelWarn.listeners.add(cb);
    return function () { channelWarn.listeners.delete(cb); };
  }
  function getChannelWarnSnap() { return channelWarn.rev; }
  function bumpChannelWarn() {
    channelWarn.rev++;
    channelWarn.listeners.forEach(function (l) { l(); });
  }
  function getChannelWarn(chan) { return channelWarn.map[fold(chan)] || null; }
  /** Pending official checks: fold(chan) → { timer, orbit } */
  var officialPending = Object.create(null);
  var channelWarnOpen = false;

  function isChannelName(name) {
    var c = String(name || '').charAt(0);
    return c === '#' || c === '&';
  }

  function isSafeChannel(orbit, chan) {
    var key = fold(chan);
    var list = cfg(orbit).safeChannels || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] === key) return true;
    }
    return false;
  }

  function looksNetworkChannel(orbit, chan) {
    var suffix = cfg(orbit).officialSuffix;
    if (!suffix) return true;
    return fold(chan).slice(-suffix.length) === suffix;
  }

  function rememberOfficial(chan, official) {
    var key = fold(chan);
    if (!key) return;
    officialCache[key] = { official: !!official, known: true, ts: Date.now() };
  }

  function clearOfficialPending(chan) {
    var key = fold(chan);
    var pend = officialPending[key];
    if (pend && pend.timer) window.clearTimeout(pend.timer);
    delete officialPending[key];
  }

  function joinChannelNow(orbit, chan) {
    var name = String(chan || '').trim();
    if (!name) return;
    try { orbit.irc.join(name); } catch (e) { /* ignore */ }
    try {
      var st = orbit.state.get();
      if (st && typeof st.setActive === 'function') st.setActive(name);
    } catch (e2) { /* ignore */ }
  }

  function ChannelWarnBody(props) {
    var orbit = props.orbit;
    var chan = props.chan;
    return h('div', { className: 'ocid-warn' },
      h('p', { className: 'ocid-warn__row' },
        h('span', { className: 'ocid-warn__ic', 'aria-hidden': true }, '🚪'),
        h('span', null,
          pick(orbit, { fr: 'Tu viens d’entrer dans ', en: 'You just joined ' }),
          h('b', null, chan),
          pick(orbit, {
            fr: ', un salon où il peut aussi y avoir des adultes.',
            en: ', a channel where adults may also be present.',
          })
        )
      ),
      h('p', { className: 'ocid-warn__row' },
        h('span', { className: 'ocid-warn__ic', 'aria-hidden': true }, '🎭'),
        h('span', null, pick(orbit, {
          fr: 'L’âge affiché sur un profil n’est pas une preuve : sur le tchat, on ne peut pas être sûr de qui se cache derrière un pseudo.',
          en: 'The age on a profile is not proof: on chat you cannot be sure who is behind a nick.',
        }))
      ),
      h('p', { className: 'ocid-warn__row' },
        h('span', { className: 'ocid-warn__ic', 'aria-hidden': true }, '🛡️'),
        h('span', null, pick(orbit, {
          fr: 'Reste prudent·e : ne donne jamais ton adresse, ton école, ton numéro, ni de photos. Si quelqu’un te met mal à l’aise, arrête la discussion et parle-en à un adulte de confiance.',
          en: 'Stay careful: never share your address, school, number, or photos. If someone makes you uncomfortable, stop and talk to a trusted adult.',
        }))
      ),
      h('div', { className: 'ocid-warn__row ocid-warn__row--actions' },
        h('span', { className: 'ocid-warn__ic', 'aria-hidden': true }, '📣'),
        h('div', { className: 'ocid-warn__tools' },
          h('span', { className: 'ocid-warn__hint' }, pick(orbit, {
            fr: 'Pour signaler :',
            en: 'To report:',
          })),
          h('button', {
            type: 'button',
            className: 'ocid-bot',
            title: pick(orbit, { fr: 'Écrire à SignalMoi', en: 'Message SignalMoi' }),
            onClick: function () { openPm(orbit, 'SignalMoi'); },
          },
            h('span', { className: 'ocid-bot__av', 'aria-hidden': true }, '🤖'),
            h('span', { className: 'ocid-bot__name' }, 'SignalMoi'),
            h('span', { className: 'ocid-bot__badge' }, 'BOT')
          ),
          h('button', {
            type: 'button',
            className: 'ocid-tag',
            title: pick(orbit, { fr: 'Rejoindre #Signalement.chat', en: 'Join #Signalement.chat' }),
            onClick: function () { joinChannelNow(orbit, '#Signalement.chat'); },
          }, '#Signalement.chat'),
          h('button', {
            type: 'button',
            className: 'pm-chip pm-chip--warn ocid-report',
            title: pick(orbit, {
              fr: 'Comme sur la fiche d’un utilisateur',
              en: 'Same as on a user profile',
            }),
            onClick: function () {
              orbit.notify(
                pick(orbit, { fr: 'Signaler', en: 'Report' }),
                pick(orbit, {
                  fr: 'Ouvre la fiche d’une personne (dans la liste des membres), puis appuie sur Signaler.',
                  en: 'Open someone’s profile from the member list, then press Report.',
                })
              );
            },
          }, '🚩 ', pick(orbit, { fr: 'Signaler', en: 'Report' }))
        )
      ),
      h('p', { className: 'ocid-warn__row' },
        h('span', { className: 'ocid-warn__ic', 'aria-hidden': true }, '🌱'),
        h('span', null, pick(orbit, {
          fr: 'Le salon #EntreJeunes.chat est pensé pour les plus jeunes. Ici, prends le temps de choisir à qui tu parles.',
          en: '#EntreJeunes.chat is meant for younger users. Here, take your time choosing who you talk to.',
        }))
      )
    );
  }

  function warnText(orbit, chan) {
    return pick(orbit, {
      fr: 'Tu viens d’entrer dans ' + chan + ', un salon où il peut aussi y avoir des adultes. '
        + '— L’âge affiché sur un profil n’est pas une preuve : sur le tchat, on ne peut pas être sûr de qui se cache derrière un pseudo. '
        + '— Reste prudent·e : ne donne jamais ton adresse, ton école, ton numéro, ni de photos. Si quelqu’un te met mal à l’aise, arrête la discussion, quitte le salon si besoin, et parle-en à un adulte de confiance '
        + '— Plusieurs solutions s\'offre à toi pour signaler un comportement anormal : envoi un message privé à SignalMoi, rejoins #Signalement.chat ou utilise le bouton Signaler dans l\'affichage de l\'utilisateur. '
        + '— Le salon #EntreJeunes.chat est pensé pour les plus jeunes. Ici, prends le temps de choisir à qui tu parles.',
      en: 'You just joined ' + chan + ', a channel where adults may also be present. '
        + '— The age on a profile is not proof: on chat you cannot be sure who is behind a nick. '
        + '— Stay careful: never share your address, school, phone number, or photos. If someone makes you uncomfortable, stop the chat, leave the channel if needed, and talk to a trusted adult. '
        + '— To report a problem: private-message SignalMoi, join #Signalement.chat, or use the Report button on the user. '
        + '— #EntreJeunes.chat is meant for younger users. Here, take your time choosing who you talk to.',
    });
  }

  function hideChannelWarnPref(orbit) {
    try { return !!orbit.storage.get(STORAGE_HIDE_CHANNEL_WARN, false); } catch (e) { return false; }
  }

  function setHideChannelWarnPref(orbit, on) {
    try { orbit.storage.set(STORAGE_HIDE_CHANNEL_WARN, !!on); } catch (e) { /* ignore */ }
    if (!on) {
      channelWarn.map = Object.create(null);
      bumpChannelWarn();
      try {
        var active = orbit && orbit.state && orbit.state.active && orbit.state.active();
        if (active && isChannelName(active)) maybeWarnOfficialJoin(orbit, active);
      } catch (e) { /* ignore */ }
    }
    try { window.dispatchEvent(new Event('ocid-channel-warn-pref')); } catch (e) { /* ignore */ }
    bumpChannelWarn();
  }

  /** Banner under the top bar, plus the existing popup. */
  function showChannelWarn(orbit, chan) {
    var key = fold(chan);
    if (!key) return;
    if (!parentalActive) return;
    if (hideChannelWarnPref(orbit)) return;
    var cur = channelWarn.map[key];
    if (cur) return; // already showing, or dismissed until they leave
    channelWarn.map[key] = { chan: String(chan), hidden: false };
    bumpChannelWarn();
    openChannelWarnPopup(orbit, chan);
  }

  function openChannelWarnPopup(orbit, chan) {
    if (typeof orbit.modal !== 'function' || channelWarnOpen) return;
    if (hideChannelWarnPref(orbit)) return;
    channelWarnOpen = true;
    var dontShow = { current: false };
    var close = orbit.modal(function () {
      return h('div', { className: 'ocid-popup ocid-popup--warn' },
        h('div', { className: 'ocid-popup__icon ocid-popup__icon--warn', 'aria-hidden': true }, h(ShieldIcon, { size: 36 })),
        h('p', { className: 'ocid-popup__lead' },
          pick(orbit, {
            fr: 'Attention avant de discuter',
            en: 'A quick heads-up before you chat',
          })
        ),
        h(ChannelWarnBody, { orbit: orbit, chan: chan }),
        h('label', { className: 'ocid-check--tip' },
          h('input', {
            type: 'checkbox',
            onChange: function (e) { dontShow.current = !!(e && e.target && e.target.checked); },
          }),
          h('span', null,
            pick(orbit, {
              fr: 'Ne plus afficher ce message',
              en: 'Don’t show this again',
            })
          )
        ),
        h('div', { className: 'ocid-popup__actions' },
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () {
              if (dontShow.current) setHideChannelWarnPref(orbit, true);
              channelWarnOpen = false;
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'J’ai compris', en: 'Got it' }))
        )
      );
    }, {
      title: pick(orbit, { fr: 'Salon avec adultes possibles', en: 'Channel may include adults' }),
      wide: true,
    });
  }

  function dismissChannelWarn(chan) {
    var key = fold(chan);
    var cur = channelWarn.map[key];
    if (!cur || cur.hidden) return;
    cur.hidden = true;
    bumpChannelWarn();
  }

  /** Leave the channel → next join shows the banner again. */
  function resetChannelWarnVisit(chan) {
    var key = fold(chan);
    if (!key || !channelWarn.map[key]) return;
    delete channelWarn.map[key];
    bumpChannelWarn();
  }

  /** True only after the server accepted the join. A refused salon has no banner. */
  function channelJoined(orbit, chan) {
    try {
      var st = orbit.state.get();
      var buffers = (st && st.buffers) || {};
      var want = fold(chan);
      var buf = null;
      Object.keys(buffers).forEach(function (k) {
        if (fold(k) === want) buf = buffers[k];
      });
      return !!(buf && buf.isChannel && buf.joined && !buf.joinDenied);
    } catch (e) { return false; }
  }

  function maybeWarnOfficialJoin(orbit, chan) {
    if (!orbit || !isChannelName(chan)) return;
    if (!channelJoined(orbit, chan)) return;
    if (!cfg(orbit).warnOfficialJoins) return;
    if (!parentalActive) return;
    if (hideChannelWarnPref(orbit)) return;
    if (isSafeChannel(orbit, chan)) return;
    var key = fold(chan);
    if (channelWarn.map[key]) return;

    // EntreNous: salons réseau (suffixe .chat) = avertir tout de suite, hors liste sûre.
    // Ne pas attendre ChanServ : un INFO « non officiel » annulait sinon le fallback.
    if (looksNetworkChannel(orbit, chan)) {
      showChannelWarn(orbit, chan);
      return;
    }

    var cached = officialCache[key];
    if (cached && cached.known) {
      if (cached.official) showChannelWarn(orbit, chan);
      return;
    }

    if (officialPending[key]) return;
    officialPending[key] = {
      orbit: orbit,
      chan: chan,
      timer: window.setTimeout(function () {
        clearOfficialPending(chan);
        // Hors suffixe réseau : sans réponse ChanServ, on n’avertit pas.
      }, CHAN_WARN_TIMEOUT_MS),
    };
    try {
      orbit.irc.send('PRIVMSG ChanServ :INFO ' + chan);
    } catch (e) { /* ignore */ }
  }

  function onOfficialInfo(orbit, info) {
    if (!info || !info.chan) return;
    rememberOfficial(info.chan, !!info.official);
    var key = fold(info.chan);
    var pend = officialPending[key];
    if (!pend) return;
    clearOfficialPending(info.chan);
    if (info.official || looksNetworkChannel(orbit || pend.orbit, info.chan)) {
      showChannelWarn(orbit || pend.orbit, info.chan);
    }
  }

  function pick(orbit, table) {
    if (orbit.i18n && orbit.i18n.pick) return orbit.i18n.pick(table);
    return table.fr || table.en || '';
  }

  /** Prefer NickServ account, else nick — empty until registration. */
  function storageOwner(orbit) {
    var acct = '';
    var nick = '';
    try { acct = fold(orbit.state.account && orbit.state.account()); } catch (e) { /* ignore */ }
    try { nick = fold(orbit.state.nick && orbit.state.nick()); } catch (e) { /* ignore */ }
    return acct || nick || '';
  }

  // Persistence is identity-scoped by Orbit's plugin storage API (localStorage
  // key includes @account). Keys below stay plain; do not add @owner here.

  /**
   * Isolate in-memory ACCEPT / pending state when another account uses this tab.
   * Returns the current owner (may be empty before NICK/SASL).
   */
  function ensureOwnerSession(orbit, log) {
    var owner = storageOwner(orbit);
    if (!owner) return '';
    if (sessionOwner === owner) return owner;
    var prev = sessionOwner;
    sessionOwner = owner;
    if (prev) {
      acceptList.nicks = [];
      acceptList.loading = false;
      bumpAccept();
      restoreDone = false;
      denyRestoreDone = false;
      pending.map = Object.create(null);
      pending.rev++;
      pending.listeners.forEach(function (l) { l(); });
      outgoing.map = Object.create(null);
      outgoing.rev++;
      outgoing.listeners.forEach(function (l) { l(); });
      acceptedTips.map = Object.create(null);
      acceptedTips.rev++;
      acceptedTips.listeners.forEach(function (l) { l(); });
      popupOpenFor = Object.create(null);
      refuseNotified = Object.create(null);
      dismissedWeBlocked = Object.create(null);
      dismissedPeerBlocked = Object.create(null);
      outboundText = Object.create(null);
      acceptConfirmed = Object.create(null);
      resentFirst = Object.create(null);
      dismissedOutgoingWait = Object.create(null);
      sessionStartedAt = Date.now();
      nickCase = Object.create(null);
      bumpDeny();
      if (log) log('callerid: compte changé (' + prev + ' → ' + owner + '), listes isolées');
    }
    return owner;
  }

  function fold(s) {
    return String(s || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
  }

  /** Preserve last-seen nick casing (IRC fold keys are lowercase). */
  var nickCase = Object.create(null);
  function rememberNickCase(nick) {
    var n = String(nick || '').replace(/^[@+%~&]/, '').trim();
    if (!n) return '';
    nickCase[pendingKey(n)] = n;
    return n;
  }
  function displayNick(orbit, nick) {
    var raw = String(nick || '').replace(/^[@+%~&]/, '').trim();
    if (!raw) return '';
    var key = pendingKey(raw);
    if (nickCase[key]) return nickCase[key];
    var tip = acceptedTips.map[key];
    if (tip && tip.nick) return tip.nick;
    var pend = pending.map[key];
    if (pend && pend.nick) return pend.nick;
    var out = outgoing.map[key];
    if (out && out.nick) return out.nick;
    var peer = peers.map[key];
    if (peer && peer.nick) return peer.nick;
    try {
      var st = orbit && orbit.state && orbit.state.get && orbit.state.get();
      var buffers = (st && st.buffers) || {};
      var buf = buffers[raw] || buffers[key];
      if (!buf) {
        Object.keys(buffers).forEach(function (k) {
          if (!buf && fold(k) === key) buf = buffers[k];
        });
      }
      if (buf && buf.name) return String(buf.name).replace(/^[@+%~&]/, '').trim() || raw;
    } catch (e) { /* ignore */ }
    for (var i = 0; i < acceptList.nicks.length; i++) {
      if (fold(acceptList.nicks[i]) === key) return acceptList.nicks[i];
    }
    return raw;
  }

  function isChannelName(name) {
    return /^[#&+!]/.test(name || '');
  }

  /** Status / notice inboxes / allow-list pane — not IRC nicks. */
  function isPseudoBuffer(name) {
    var n = String(name || '');
    return n.charAt(0) === '$' || n === 'Status' || isAllowlistBuffer(n);
  }

  function isQueryPeer(name) {
    return !!(name && !isChannelName(name) && !isPseudoBuffer(name));
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

  function hasModeD(orbit) {
    return myUmodes(orbit).indexOf('D') > -1;
  }

  function hidePrivDeafTipPref(orbit) {
    try { return !!orbit.storage.get(STORAGE_HIDE_PRIVDEAF_TIP, false); } catch (e) { return false; }
  }

  function setHidePrivDeafTipPref(orbit, on) {
    try { orbit.storage.set(STORAGE_HIDE_PRIVDEAF_TIP, !!on); } catch (e) { /* ignore */ }
  }

  /** Tip when +D (enveloppe) blocks all private messages. */
  function showPrivDeafBlockedTip(orbit) {
    if (!orbit || typeof orbit.modal !== 'function') return;
    if (privDeafTipOpen) return;
    if (!hasModeD(orbit)) return;
    if (hidePrivDeafTipPref(orbit)) return;
    privDeafTipOpen = true;
    var dontShow = { current: false };
    var close = orbit.modal(function () {
      return h('div', { className: 'ocid-popup' },
        h('div', { className: 'ocid-popup__icon', 'aria-hidden': true, style: { color: 'var(--danger,#d6465f)' } },
          h('svg', {
            viewBox: '0 0 24 24', width: 36, height: 36, fill: 'none',
            stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            h('path', { d: 'M4 6h16v12H4z' }),
            h('path', { d: 'm4 7 8 6 8-6' })
          )
        ),
        h('p', { className: 'ocid-popup__lead' },
          pick(orbit, {
            fr: 'Messages privés bloqués',
            en: 'Private messages blocked',
          })
        ),
        h('p', { className: 'ocid-modal__empty ocid-warn__body' },
          pick(orbit, {
            fr: [
              'L’icône enveloppe (dans la barre du haut) est active : personne ne peut t’écrire en message privé.',
              '',
              'Pour débloquer : clique à nouveau sur cette icône (elle redevient grise), ou désactive le mode « ne pas recevoir les MP » dans Paramètres → Modes.',
              '',
              'Astuce : le bouclier gère la liste blanche (+g) ; l’enveloppe coupe tous les MP (+D).',
            ].join('\n'),
            en: [
              'The envelope icon in the top bar is on: nobody can private-message you.',
              '',
              'To unblock: click that icon again (it turns grey), or turn off “block private messages” in Settings → Modes.',
              '',
              'Tip: the shield manages the allow list (+g); the envelope blocks all PMs (+D).',
            ].join('\n'),
          })
        ),
        h('label', { className: 'ocid-check--tip' },
          h('input', {
            type: 'checkbox',
            onChange: function (e) { dontShow.current = !!(e && e.target && e.target.checked); },
          }),
          h('span', null,
            pick(orbit, {
              fr: 'Ne plus afficher ce message',
              en: 'Don’t show this again',
            })
          )
        ),
        h('div', { className: 'ocid-popup__actions' },
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () {
              if (dontShow.current) setHidePrivDeafTipPref(orbit, true);
              privDeafTipOpen = false;
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'J’ai compris', en: 'Got it' }))
        )
      );
    }, {
      title: pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
      wide: false,
    });
  }

  function syncPrivDeafTip(orbit) {
    var on = hasModeD(orbit);
    if (on && !privDeafWasOn) showPrivDeafBlockedTip(orbit);
    privDeafWasOn = on;
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

  function wantCallerid(orbit) {
    try { return orbit.storage.get(STORAGE_WANT_G, false) === true; } catch (e) { return false; }
  }

  function setWantCallerid(orbit, on) {
    try { orbit.storage.set(STORAGE_WANT_G, !!on); } catch (e) { /* ignore */ }
  }

  /** Voluntary +g (Settings → Modes). Never used to remove parental package. */
  function applyVoluntaryCallerid(orbit, logFn) {
    if (parentalActive || isParental(orbit)) return;
    if (!wantCallerid(orbit)) return;
    var nick = orbit.state.nick();
    if (!nick) return;
    if (hasModeG(orbit)) {
      activateCallerid(orbit, logFn || function () {}, 'pref');
      return;
    }
    try {
      orbit.irc.send('MODE ' + nick + ' +g');
      (logFn || function () {})('callerid: +g volontaire (paramètres)');
    } catch (e) { /* ignore */ }
  }

  function setVoluntaryCallerid(orbit, enable, logFn) {
    if (parentalActive || isParental(orbit)) {
      orbit.notify(
        pick(orbit, { fr: 'Contrôle parental', en: 'Parental controls' }),
        pick(orbit, {
          fr: 'Ce mode est imposé par le contrôle parental et ne peut pas être désactivé.',
          en: 'This mode is required by parental controls and cannot be turned off.',
        })
      );
      return;
    }
    setWantCallerid(orbit, enable);
    var nick = orbit.state.nick();
    if (!nick) return;
    try {
      orbit.irc.send('MODE ' + nick + ' ' + (enable ? '+g' : '-g'));
    } catch (e) { /* ignore */ }
    if (enable) activateCallerid(orbit, logFn || function () {}, 'settings');
    else {
      window.setTimeout(function () {
        if (!hasModeG(orbit) && !listPending().length) setCallerid(false);
      }, 400);
    }
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
    if (!persistEnabled(orbit)) return;
    if (!storageOwner(orbit)) return;
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
    if (!calleridActive) return;
    ensureOwnerSession(orbit, log);
    if (!storageOwner(orbit)) return;
    if (restoreDone) return;
    restoreDone = true;
    var list = loadSavedAccept(orbit);
    if (!list.length) {
      refreshAcceptList(orbit);
      return;
    }
    log('callerid: restauration ACCEPT (' + list.length + ') pour ' + storageOwner(orbit));
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
    if (!key || !isQueryPeer(nick)) return;
    if (peers.loading[key]) return;
    var last = peers.probedAt[key] || 0;
    if (last && (Date.now() - last) < PEER_WHOIS_TTL) return;
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
      if (add) pushAcceptNick(n);
      else {
        forgetAcceptNick(n);
        delete acceptConfirmed[pendingKey(n)];
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Same queue as ACCEPT. privmsg() jumps the line (sendFirst) and would race +g. */
  function sendQueuedPrivmsg(orbit, nick, body) {
    var n = String(nick || '').trim();
    var lines = String(body || '').split(/\r?\n/);
    var i;
    var sent = false;
    if (!n) return false;
    for (i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        orbit.irc.send('PRIVMSG ' + n + ' :' + lines[i]);
        sent = true;
      } catch (e) { /* ignore */ }
    }
    return sent;
  }

  function markAcceptConfirmed(nick) {
    var key = pendingKey(nick);
    if (key) acceptConfirmed[key] = true;
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
    try {
      var active = orbit.state.active();
      if (active && isChannelName(active)) maybeWarnOfficialJoin(orbit, active);
    } catch (e) { /* ignore */ }
  }

  /** Callerid UX (+g / ACCEPT). Independent of the parental label. */
  function activateCallerid(orbit, log, reason) {
    ensureOwnerSession(orbit, log);
    if (!calleridActive) {
      setCallerid(true);
      log('callerid: filtre MP (+g / ACCEPT)' + (reason ? ' — ' + reason : ''));
    }
    // Saved ACCEPT first, then live Amis/Ignore (covers +g applied after connect).
    restoreSavedAccept(orbit, log);
    syncOrbitListsToCallerid(orbit, log);
  }

  function syncFromWhois(orbit, log) {
    if (isParental(orbit)) activateParental(orbit, log, isParentalGroup(orbit) ? 'groupe' : 'paquet-modes');
    else {
      if (parentalActive) setParental(false);
    }

    if (hasModeG(orbit)) activateCallerid(orbit, log, '+g');
    else if (wantCallerid(orbit) && !isParental(orbit)) applyVoluntaryCallerid(orbit, log);
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
    if (!storageOwner(orbit)) return;
    var list = loadSavedDeny(orbit);
    var low = fold(nick);
    var next = list.filter(function (n) { return fold(n) !== low; });
    if (add) next.push(String(nick).trim());
    try { orbit.storage.set(STORAGE_DENY, next); } catch (e) { /* ignore */ }
    bumpDeny();
  }

  /** Nicks who refused / blocked *us* (requester-side memory). */
  function loadBlockedBy(orbit) {
    try {
      var v = orbit.storage.get(STORAGE_BLOCKED_BY, []);
      return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  function isBlockedBy(orbit, nick) {
    var low = fold(nick);
    if (!low) return false;
    return loadBlockedBy(orbit).some(function (n) { return fold(n) === low; });
  }

  function saveBlockedByNick(orbit, nick, add) {
    if (!storageOwner(orbit)) return;
    var list = loadBlockedBy(orbit);
    var low = fold(nick);
    var next = list.filter(function (n) { return fold(n) !== low; });
    if (add) next.push(String(nick).trim());
    try { orbit.storage.set(STORAGE_BLOCKED_BY, next); } catch (e) { /* ignore */ }
  }

  function markPeerBlockedUs(orbit, nick) {
    var n = rememberNickCase(nick);
    if (!n) return;
    saveBlockedByNick(orbit, n, true);
    delete dismissedPeerBlocked[pendingKey(n)];
    delete outboundText[pendingKey(n)];
    setAcceptedTip(n, null);
    setOutgoing(n, { nick: n, ts: Date.now(), informed: true, refused: true, blocked: true });
  }

  function markPeerDeclinedUs(orbit, nick) {
    var n = rememberNickCase(nick);
    if (!n) return;
    // Soft decline only — not stored in the blocked list.
    saveBlockedByNick(orbit, n, false);
    setOutgoing(n, { nick: n, ts: Date.now(), informed: true, refused: true, blocked: false });
  }

  function clearPeerBlockedUs(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    saveBlockedByNick(orbit, n, false);
    var prev = getOutgoing(n);
    // After unblock: back to « waiting for allow-list » if we already wrote them.
    if (hasRealOutboundAttempt(orbit, n) || (prev && (prev.blocked || prev.refused))) {
      setOutgoing(n, {
        nick: n,
        ts: (prev && prev.ts) || Date.now(),
        informed: false,
        refused: false,
        blocked: false,
      });
    } else {
      setOutgoing(n, null);
    }
  }

  function unblockNick(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    saveDenyNick(orbit, n, false);
    silenceNick(orbit, n, false);
    delete refuseNotified[pendingKey(n)];
    // Tell the peer so their red « blocked » banner becomes the wait banner again.
    noticePeer(orbit, n, pick(orbit, {
      fr: MARK_UNBLOCK_FR + '.',
      en: MARK_UNBLOCK_EN + '.',
    }));
    // In-app only (no OS / browser notification while the UI already shows the list).
    pushStatus(orbit, pick(orbit, {
      fr: n + ' n’est plus bloqué. Il pourra à nouveau demander à vous écrire.',
      en: n + ' is unblocked. They may request to message you again.',
    }));
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

  function pushLocalLine(orbit, buffer, text, kind, asSelf) {
    try {
      var st = orbit.state.get();
      if (st && typeof st.pushLocal === 'function') {
        if (asSelf) st.pushLocal(buffer, text, st.nick || '', kind || 'privmsg', true);
        else st.pushLocal(buffer, text, '', kind || 'system');
        return;
      }
    } catch (e) { /* ignore */ }
  }

  function getQueryBuffer(orbit, nick) {
    try {
      var st = orbit.state.get();
      var buffers = (st && st.buffers) || {};
      var buf = buffers[nick] || buffers[fold(nick)];
      if (!buf && buffers) {
        Object.keys(buffers).forEach(function (k) {
          if (fold(k) === fold(nick)) buf = buffers[k];
        });
      }
      return buf || null;
    } catch (e) {
      return null;
    }
  }

  function bufferHasSelfText(orbit, nick, text) {
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      var want = String(text || '');
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].self && String(msgs[i].text || '') === want) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** True if we already sent a real PRIVMSG/ACTION in this PM (not just opened it). */
  function bufferHasSelfOutbound(orbit, nick) {
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (m && m.self && (m.kind === 'privmsg' || m.kind === 'action')) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** Peer already wrote in this PM — they initiated; don't claim *our* message is pending. */
  function bufferHasPeerOutbound(orbit, nick) {
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (m && !m.self && (m.kind === 'privmsg' || m.kind === 'action')) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function hasRealOutboundAttempt(orbit, nick) {
    return !!outboundText[pendingKey(nick)] || bufferHasSelfOutbound(orbit, nick);
  }

  /** Optimistic send still waiting for a server echo (id stays local-). */
  function hasUnconfirmedSelf(orbit, nick) {
    return listUnconfirmedTexts(orbit, nick).length > 0;
  }

  function listUnconfirmedTexts(orbit, nick) {
    var out = [];
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      var i;
      for (i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || !m.self || (m.kind !== 'privmsg' && m.kind !== 'action')) continue;
        if (String(m.id || '').indexOf('local-') !== 0) continue;
        if (m.text) out.push(String(m.text));
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /**
   * A PRIVMSG we sent during this connection — not a history replay.
   * Old lines must not count as « I started the chat » and swallow a new 718.
   */
  function hasFreshOutbound(orbit, nick) {
    if (outboundText[pendingKey(nick)]) return true;
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      var i;
      for (i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || !m.self || (m.kind !== 'privmsg' && m.kind !== 'action')) continue;
        if (String(m.id || '').indexOf('local-') === 0) return true;
        if (m.ts && sessionStartedAt && m.ts >= sessionStartedAt - 5000) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function captureOutboundText(orbit, nick) {
    if (outboundText[pendingKey(nick)]) return;
    try {
      var buf = getQueryBuffer(orbit, nick);
      var msgs = (buf && buf.messages) || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].self && (msgs[i].kind === 'privmsg' || msgs[i].kind === 'action')) {
          outboundText[pendingKey(nick)] = String(msgs[i].text || '');
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }

  /** Keep the undelivered first DM visible while waiting for ACCEPT (no server echo on +g). */
  function ensurePendingVisible(orbit, nick) {
    var n = String(nick || '').trim();
    if (!n) return;
    captureOutboundText(orbit, n);
    var text = outboundText[pendingKey(n)];
    if (!text) return;
    if (bufferHasSelfText(orbit, n, text)) return;
    openPm(orbit, n);
    pushLocalLine(orbit, n, text, 'privmsg', true);
  }

  /**
   * Parental user opened the PM themselves: they accept this nick on the allow
   * list, so the peer's reply must not raise a 718 / « souhaite vous écrire ».
   */
  /**
   * Parental user opened the PM themselves. Returns true when ACCEPT was just
   * queued and the PRIVMSG must stay behind it (same slow queue, not sendFirst).
   */
  function allowStartedPeer(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n || !isQueryPeer(n)) return false;
    if (!parentalActive && !isParental(orbit)) return false;
    if (isDenied(orbit, n)) return false;
    // Optimistic savedAccept is not enough: the server list is empty after a reconnect
    // until ACCEPT is actually processed. sendFirst would jump ahead of that command.
    if (acceptConfirmed[pendingKey(n)]) return false;
    var already = isAllowedNick(orbit, n);
    if (!sendAccept(orbit, n, true)) return false;
    setPending(n, null);
    delete popupOpenFor[pendingKey(n)];
    if (!already) {
      setAcceptedTip(n, { nick: n, kind: 'we-started' });
      pushStatus(orbit, pick(orbit, {
        fr: n + ' a été ajouté à votre liste blanche, parce que vous avez commencé la conversation.',
        en: n + ' was added to your allow list because you started the conversation.',
      }));
      window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
    }
    return true;
  }

  /** Replay the PMs the server dropped (+g) once the peer has accepted us. */
  function resendUnconfirmed(orbit, nick) {
    var key = pendingKey(nick);
    if (!key || resentFirst[key]) return;
    var lines = listUnconfirmedTexts(orbit, nick);
    var pendingTxt = outboundText[key];
    if (!lines.length && pendingTxt && !isControlBody(pendingTxt)) lines = [pendingTxt];
    lines = lines.filter(function (line) { return line && !isControlBody(line); });
    if (!lines.length) return;
    resentFirst[key] = true;
    delete outboundText[key];
    var i;
    for (i = 0; i < lines.length; i++) sendQueuedPrivmsg(orbit, nick, lines[i]);
  }

  function isControlBody(body) {
    return isAcceptNotice(body) || isRefuseNotice(body) || isBlockNotice(body)
      || isRevokedNotice(body) || isUnblockNotice(body);
  }

  function hookOutboundCapture(orbit) {
    if (!orbit.irc || typeof orbit.irc.msg !== 'function' || orbit.irc.__ocidHooked) return;
    var orig = orbit.irc.msg.bind(orbit.irc);
    orbit.irc.msg = function (target, text) {
      var t = String(target || '').trim();
      var body = String(text || '');
      if (t && body && isQueryPeer(t) && !isControlBody(body)) {
        outboundText[pendingKey(t)] = body;
        if (allowStartedPeer(orbit, t)) {
          sendQueuedPrivmsg(orbit, t, body);
          return;
        }
      }
      return orig(target, text);
    };
    orbit.irc.__ocidHooked = true;
  }

  function noticePeer(orbit, nick, text) {
    try { orbit.irc.send('NOTICE ' + nick + ' :' + text); } catch (e) { /* ignore */ }
  }

  /** Log a short line on the Status console (not in the PM). */
  function pushStatus(orbit, text) {
    var body = String(text || '').trim();
    if (!body) return;
    try {
      var st = orbit.state.get();
      if (st && typeof st.pushLocal === 'function') {
        st.pushLocal(STATUS_BUF, body, '', 'info');
        return;
      }
    } catch (e) { /* ignore */ }
    pushLocalLine(orbit, STATUS_BUF, body, 'info');
  }

  function isCalleridControlNotice(text) {
    return isRefuseNotice(text) || isRevokedNotice(text) || isBlockNotice(text)
      || isAcceptNotice(text) || isUnblockNotice(text);
  }

  function silenceNick(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return;
    // InspIRCd: P = PRIVMSG utilisateur (p = salon). Ancien « p » retiré au déblocage.
    var flag = add ? '+' : '-';
    try { orbit.irc.send('SILENCE ' + flag + n + ' P'); } catch (e) { /* ignore */ }
    if (!add) {
      try { orbit.irc.send('SILENCE -' + n + ' p'); } catch (e2) { /* ignore */ }
    }
    // Persists on the account so mphistory can refuse the nick while we are offline.
    try {
      orbit.irc.send('METADATA ' + n + ' SET soju.im/blocked ' + (add ? '1' : '0'));
    } catch (e3) { /* ignore */ }
  }

  /** Re-apply the block list after connect (SILENCE is session-only). */
  function restoreSavedDeny(orbit, log) {
    ensureOwnerSession(orbit, log);
    if (!storageOwner(orbit)) return;
    if (denyRestoreDone) return;
    denyRestoreDone = true;
    var list = loadSavedDeny(orbit);
    if (!list.length) return;
    if (log) log('callerid: restauration blocage (' + list.length + ') pour ' + storageOwner(orbit));
    list.forEach(function (nick) { silenceNick(orbit, nick, true); });
  }

  /** Friends panel → allow-list (ACCEPT). Also clears a prior deny/SILENCE.
   *  ACCEPT is server-side and works without +g; +g only enables the filter. */
  function syncFriendAllowlist(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return;
    if (add) {
      sendAccept(orbit, n, true);
      saveDenyNick(orbit, n, false);
      silenceNick(orbit, n, false);
      window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
    } else {
      // Removing a friend does not revoke ACCEPT — they may still be welcome in PMs.
    }
  }

  /** Orbit ignore → deny list + SILENCE p. Drops ACCEPT so +g stays consistent. */
  function syncIgnoreDenylist(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return;
    if (add) {
      sendAccept(orbit, n, false);
      saveDenyNick(orbit, n, true);
      silenceNick(orbit, n, true);
      window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
    } else {
      saveDenyNick(orbit, n, false);
      silenceNick(orbit, n, false);
    }
  }

  /**
   * When +g / callerid becomes active (late MODE, parental pack, reconnect),
   * re-push Orbit Amis → ACCEPT and Ignore → SILENCE so lists match even if
   * they were edited before the filter was on.
   */
  function syncOrbitListsToCallerid(orbit, logFn) {
    var st;
    try { st = orbit.state.get(); } catch (e) { return; }
    if (!st) return;
    var friends = Array.isArray(st.friends) ? st.friends : [];
    var ignored = Array.isArray(st.ignored) ? st.ignored : [];
    var i;
    var n;
    var touched = false;
    for (i = 0; i < friends.length; i++) {
      n = String(friends[i] || '').trim();
      if (!n) continue;
      sendAccept(orbit, n, true);
      saveDenyNick(orbit, n, false);
      silenceNick(orbit, n, false);
      touched = true;
    }
    for (i = 0; i < ignored.length; i++) {
      n = String(ignored[i] || '').trim();
      if (!n) continue;
      sendAccept(orbit, n, false);
      saveDenyNick(orbit, n, true);
      silenceNick(orbit, n, true);
      touched = true;
    }
    if (touched) {
      (logFn || function () {})('callerid: sync Amis/Ignore → ACCEPT/SILENCE');
      window.setTimeout(function () { refreshAcceptList(orbit); }, 400);
    }
  }

  function acceptAndClear(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    if (!sendAccept(orbit, n, true)) return;
    setPending(n, null);
    delete popupOpenFor[pendingKey(n)];
    saveDenyNick(orbit, n, false);
    silenceNick(orbit, n, false);

    openPm(orbit, n);
    // Top banner (same strip as wait / historique) — not an inline chat line.
    setAcceptedTip(n, { nick: n, kind: 'we-accepted' });

    var acceptMsg = pick(orbit, {
      fr: MARK_ACCEPT_FR + '. Vous pouvez écrire.',
      en: MARK_ACCEPT_EN + '. You can write now.',
    });
    // Same queue as ACCEPT +nick above. irc.msg uses sendFirst and would reach
    // their +g before this ACCEPT, so they never see it and never resend.
    if (!sendQueuedPrivmsg(orbit, n, acceptMsg)) noticePeer(orbit, n, acceptMsg);

    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  /** Shield menu: add to the allow list. A pending request still uses the full accept notice. */
  function allowNick(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    if (pending.map[pendingKey(n)]) {
      acceptAndClear(orbit, n);
      return;
    }
    if (!sendAccept(orbit, n, true)) return;
    saveDenyNick(orbit, n, false);
    silenceNick(orbit, n, false);
    setAcceptedTip(n, { nick: n, kind: 'we-accepted' });
    pushStatus(orbit, pick(orbit, {
      fr: n + ' a été ajouté à votre liste blanche.',
      en: n + ' was added to your allow list.',
    }));
    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  /** Shield menu: drop ACCEPT only — not a block. */
  function removeFromAllowList(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    sendAccept(orbit, n, false);
    setAcceptedTip(n, null);
    pushStatus(orbit, pick(orbit, {
      fr: n + ' a été retiré de votre liste blanche.',
      en: n + ' was removed from your allow list.',
    }));
    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  function isOnAcceptList(nick) {
    var low = fold(nick);
    if (!low) return false;
    for (var i = 0; i < acceptList.nicks.length; i++) {
      if (fold(acceptList.nicks[i]) === low) return true;
    }
    return false;
  }

  /** Live ACCEPT list and/or persisted allow-list (survives a lagging ACCEPT dump). */
  function isAllowedNick(orbit, nick) {
    if (isOnAcceptList(nick)) return true;
    if (!orbit) return false;
    var low = fold(nick);
    if (!low) return false;
    return loadSavedAccept(orbit).some(function (n) { return fold(n) === low; });
  }

  /** Drop pending 718 entries for nicks already on the allow list. */
  function prunePendingAllowed(orbit) {
    var keys = Object.keys(pending.map);
    if (!keys.length) return;
    var changed = false;
    keys.forEach(function (k) {
      var req = pending.map[k];
      var n = (req && req.nick) || k;
      // Saved allow-list is not the server list. A 718 means the PM was just
      // blocked, so only a live ACCEPT entry should dismiss the request.
      if (isOnAcceptList(n) || acceptConfirmed[pendingKey(n)]) {
        delete pending.map[k];
        delete popupOpenFor[k];
        changed = true;
      }
    });
    if (changed) {
      pending.rev++;
      pending.listeners.forEach(function (l) { l(); });
    }
  }

  /** Soft decline: clear the 718 request, do NOT add to blocked / SILENCE. */
  function declineRequest(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    var key = pendingKey(n);
    setPending(n, null);
    delete popupOpenFor[key];
    // Leave ACCEPT untouched if already allowed; only drop a bare pending ask.
    // (Not on accept list yet for a normal 718.)
    if (!isOnAcceptList(n)) sendAccept(orbit, n, false);

    var refuseMsg = pick(orbit, {
      fr: MARK_REFUSE_FR + '.',
      en: MARK_REFUSE_EN + '.',
    });
    noticePeer(orbit, n, refuseMsg);

    pushStatus(orbit, pick(orbit, {
      fr: 'Demande de ' + n + ' refusée. Cette personne pourra redemander plus tard.',
      en: 'Request from ' + n + ' declined. They may ask again later.',
    }));
    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  /** Hard block: deny list + SILENCE + notify peer. */
  function blockRequest(orbit, nick) {
    var n = rememberNickCase(nick) || String(nick || '').trim();
    if (!n) return;
    var key = pendingKey(n);
    var hadPending = !!pending.map[key];
    var wasAccepted = isOnAcceptList(n);
    setPending(n, null);
    delete popupOpenFor[key];
    setAcceptedTip(n, null);
    sendAccept(orbit, n, false);
    saveDenyNick(orbit, n, true);
    silenceNick(orbit, n, true);

    var blockMsg = (wasAccepted || !hadPending)
      ? pick(orbit, {
        fr: MARK_REVOKED_FR + '. ' + MARK_BLOCK_FR + '.',
        en: MARK_REVOKED_EN + '. ' + MARK_BLOCK_EN + '.',
      })
      : pick(orbit, {
        fr: MARK_REFUSE_FR + '. ' + MARK_BLOCK_FR + '.',
        en: MARK_REFUSE_EN + '. ' + MARK_BLOCK_EN + '.',
      });
    if (!refuseNotified[key]) {
      noticePeer(orbit, n, blockMsg);
      refuseNotified[key] = true;
    }
    delete dismissedWeBlocked[key];

    pushStatus(orbit, pick(orbit, {
      fr: 'Vous avez bloqué ' + n + ' : cette personne ne pourra plus vous écrire en privé.',
      en: 'You blocked ' + n + ': they can no longer private-message you.',
    }));
    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
  }

  /** @deprecated use declineRequest — kept for older call sites / slash aliases */
  function refuseRequest(orbit, nick) {
    declineRequest(orbit, nick);
  }

  function ignoreRequest(nick) {
    // Back-compat alias — prefer declineRequest(orbit, nick) when orbit is available.
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

  function isRevokedNotice(text) {
    var t = String(text || '');
    return t.indexOf(MARK_REVOKED_FR) > -1 || t.indexOf(MARK_REVOKED_EN) > -1;
  }

  function isBlockNotice(text) {
    var t = String(text || '');
    return t.indexOf(MARK_BLOCK_FR) > -1 || t.indexOf(MARK_BLOCK_EN) > -1;
  }

  function isUnblockNotice(text) {
    var t = String(text || '');
    return t.indexOf(MARK_UNBLOCK_FR) > -1 || t.indexOf(MARK_UNBLOCK_EN) > -1;
  }

  /** CHATHISTORY / mphistory replay — must not reopen accept/wait banners. */
  function isReplayIrcMsg(msg) {
    var tags = (msg && msg.tags) || {};
    if (tags['+entrenous/mphistory'] !== undefined) return true;
    if (tags.batch) return true;
    return false;
  }

  /** Peer already accepted us / conversation is live — drop stale « en attente ». */
  function clearOutgoingWait(nick) {
    var n = String(nick || '').trim();
    if (!n) return;
    var cur = getOutgoing(n);
    if (!cur || cur.refused || cur.blocked) return;
    setOutgoing(n, null);
  }

  function handlePeerDecision(orbit, fromNick, text) {
    if (!fromNick) return;
    var nick = rememberNickCase(fromNick);
    if (isAcceptNotice(text)) {
      var acceptKey = pendingKey(nick);
      saveBlockedByNick(orbit, nick, false);
      setOutgoing(nick, null);
      openPm(orbit, nick);
      setAcceptedTip(nick, { nick: nick, kind: 'they-accepted' });
      markAcceptConfirmed(nick);
      resendUnconfirmed(orbit, nick);
      // In-app accepted tip banner — no OS notification.
      return;
    }
    if (isUnblockNotice(text)) {
      clearPeerBlockedUs(orbit, nick);
      openPm(orbit, nick);
      pushStatus(orbit, pick(orbit, {
        fr: nick + ' vous a débloqué. Votre message reste en attente d’autorisation.',
        en: nick + ' unblocked you. Your message is awaiting approval again.',
      }));
      return;
    }
    var hardBlock = isRevokedNotice(text) || isBlockNotice(text);
    if (hardBlock) {
      markPeerBlockedUs(orbit, nick);
      openPm(orbit, nick);
      pushStatus(orbit, pick(orbit, {
        fr: nick + ' vous a bloqué : impossible de lui envoyer des messages privés.',
        en: nick + ' blocked you: you cannot send them private messages.',
      }));
      return;
    }
    if (isRefuseNotice(text)) {
      markPeerDeclinedUs(orbit, nick);
      openPm(orbit, nick);
      pushStatus(orbit, pick(orbit, {
        fr: nick + ' a refusé votre demande. Vous pourrez réessayer plus tard.',
        en: nick + ' declined your request. You can try again later.',
      }));
    }
  }

  function openRequestPopup(orbit, req) {
    if (!req || !req.nick) return;
    var shown = rememberNickCase(req.nick);
    if (isOnAcceptList(shown) || acceptConfirmed[pendingKey(shown)]) {
      setPending(shown, null);
      return;
    }
    var key = pendingKey(shown);
    if (popupOpenFor[key]) return;
    if (typeof orbit.modal !== 'function') return;
    popupOpenFor[key] = true;
    var close = orbit.modal(function () {
      return h('div', { className: 'ocid-popup' },
        h('div', { className: 'ocid-popup__icon', 'aria-hidden': true }, h(ShieldIcon, { size: 36 })),
        h('p', { className: 'ocid-popup__lead' },
          h('span', { className: 'ocid-banner__nick' }, shown),
          ' ',
          pick(orbit, {
            fr: 'souhaite vous écrire en message privé.',
            en: 'wants to send you a private message.',
          })
        ),
        h('p', { className: 'ocid-modal__empty' },
          parentalActive
            ? pick(orbit, {
              fr: 'Le contrôle parental bloque les MP ( Messages Privés ) jusqu’à votre accord. '
                + 'Vous devez Accepter ou Refuser la conversation en cliquant sur le bouton ci-dessous '
                + '(Accepter ajoutera l’utilisateur à votre liste blanche).',
              en: 'Parental controls block PMs (private messages) until you agree. '
                + 'Accept or decline the conversation with the buttons below '
                + '(Accept adds them to your allow list).',
            })
            : pick(orbit, {
              fr: 'Vous filtrez les messages privés (mode +g). '
                + 'Accepter ajoute cette personne à votre liste blanche ; Refuser ignore cette demande ; '
                + 'Bloquer empêche les nouvelles tentatives.',
              en: 'You are filtering private messages (+g). '
                + 'Accept adds them to your allow list; Decline ignores this request; '
                + 'Block stops further attempts.',
            })
        ),
        h('div', { className: 'ocid-popup__actions' },
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () {
              acceptAndClear(orbit, shown);
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () {
              declineRequest(orbit, shown);
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'Refuser', en: 'Decline' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--danger',
            onClick: function () {
              blockRequest(orbit, shown);
              if (typeof close === 'function') close();
            },
          }, pick(orbit, { fr: 'Bloquer', en: 'Block' }))
        )
      );
    }, {
      title: pick(orbit, { fr: 'Demande de message privé', en: 'Private message request' }),
      wide: false,
    });
  }

  function openListView(orbit) {
    prunePendingAllowed(orbit);
    refreshAcceptList(orbit);
    var st = chatState(orbit);
    var cur = '';
    try { cur = (st && st.active) || orbit.state.active() || ''; } catch (e) { /* ignore */ }
    if (cur && !isAllowlistBuffer(cur)) listView.prevActive = cur;
    listView.switching = true;
    setListViewOpen(true);
    try {
      if (st && typeof st.setActive === 'function') st.setActive(ALLOWLIST_BUF);
    } catch (e2) { /* ignore */ }
    window.setTimeout(function () {
      listView.switching = false;
      hideNativeAllowlistRow();
    }, 0);
  }

  function closeListView(orbit, opts) {
    opts = opts || {};
    var restore = opts.restore !== false;
    if (!listView.open) {
      setListViewOpen(false);
      return;
    }
    var st = orbit ? chatState(orbit) : null;
    var prev = listView.prevActive || '';
    listView.prevActive = '';
    listView.switching = true;
    setListViewOpen(false);
    revealNativeAllowlistRows();
    try {
      if (st && typeof st.closeBuffer === 'function') st.closeBuffer(ALLOWLIST_BUF);
    } catch (e) { /* ignore */ }
    try {
      if (restore && prev && !isAllowlistBuffer(prev) && st && typeof st.setActive === 'function') {
        st.setActive(prev);
      }
    } catch (e2) { /* ignore */ }
    window.setTimeout(function () { listView.switching = false; }, 0);
  }

  /** @deprecated name kept for call sites — opens the full Status-like pane. */
  function openListModal(orbit) { openListView(orbit); }

  function injectStyles() {
    var style = document.getElementById('orbit-callerid-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'orbit-callerid-css';
      document.head.appendChild(style);
    }
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
      'body.ocid-view-open .messages,body.ocid-view-open .composer,body.ocid-view-open .chan-hero,body.ocid-view-open .main__room-bg,body.ocid-view-open .empty{display:none!important}',
      'body.ocid-view-open .main{background:var(--bg)}',
      'body.ocid-view-open .topbar__modes,body.ocid-view-open .topbar__pill,body.ocid-view-open .topbar__manage,body.ocid-view-open .members{display:none!important}',
      'body.ocid-view-open .topbar__sub{display:none!important}',
      'body.ocid-view-open.app,body.ocid-view-open .app{--ocid-nomembers:1}',
      '.ocid-view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:linear-gradient(180deg,color-mix(in srgb,#0ea5e9 6%,var(--bg,#fff)) 0,var(--bg,#fff) 8rem)}',
      '.ocid-view__head{display:flex;align-items:center;gap:.75rem;flex:none;padding:.85rem 1.15rem;border-bottom:1px solid var(--border,rgba(0,0,0,.1));background:color-mix(in srgb,#0ea5e9 8%,var(--bg,#fff))}',
      '.ocid-view__head-ic{display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:10px;background:color-mix(in srgb,#0ea5e9 18%,var(--bg,#fff));color:#0284c7;flex:none}',
      '.ocid-view__title{margin:0;font-size:1.12rem;font-weight:800;letter-spacing:-.02em}',
      '.ocid-view__sub{margin:.15rem 0 0;font-size:.84rem;color:var(--muted,var(--faint));font-weight:500;line-height:1.35}',
      '.ocid-view__body{flex:1 1 auto;min-height:0;overflow:auto;padding:1.1rem 1.15rem 1.6rem}',
      '.ocid-banner{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.55rem .85rem;margin:0;border-bottom:1px solid var(--border,rgba(0,0,0,.1));background:color-mix(in srgb,#0ea5e9 12%,var(--bg,#fff));color:var(--ink,inherit);font-size:.92rem;flex:none}',
      '.ocid-banner--chan{align-items:stretch;padding:.65rem .85rem .7rem}',
      /* Game shell covers the column; the parental strip overlaps Échecs / Petit Bac. */
      'body.oec-full .ocid-banner--chan,body.oec-split .ocid-banner--chan,body.opbac-full .ocid-banner--chan,body.opbac-split .ocid-banner--chan{display:none!important}',
      '.ocid-warn__top{display:flex;align-items:flex-start;gap:.4rem;width:100%}',
      '.ocid-warn{display:flex;flex-direction:column;gap:.38rem;flex:1;min-width:0}',
      '.ocid-warn__row{display:flex;align-items:flex-start;gap:.4rem;margin:0;line-height:1.35;font-size:.88rem}',
      '.ocid-warn__row--actions{align-items:center}',
      '.ocid-warn__ic{flex:none;width:1.35rem;text-align:center;line-height:1.35}',
      '.ocid-warn__tools{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;min-width:0}',
      '.ocid-warn__hint{font-weight:650}',
      '.ocid-bot{display:inline-flex;align-items:center;gap:.35rem;border:1px solid color-mix(in srgb,#6366f1 35%,var(--border,#ddd));background:var(--bg,#fff);color:inherit;border-radius:999px;padding:.12rem .55rem .12rem .12rem;cursor:pointer;font:inherit}',
      '.ocid-bot:hover{background:color-mix(in srgb,#6366f1 10%,var(--bg,#fff))}',
      '.ocid-bot__av{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(145deg,#818cf8,#6366f1);font-size:.95rem;line-height:1}',
      '.ocid-bot__name{font-weight:750;font-size:.84rem}',
      '.ocid-bot__badge{font-size:.62rem;font-weight:800;letter-spacing:.04em;color:#3730a3;background:#e0e7ff;border-radius:999px;padding:.05rem .32rem}',
      '.ocid-tag{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:750;font-size:.82rem;color:#fff;background:#2563eb;border-radius:999px;padding:.32rem .7rem}',
      '.ocid-tag:hover{filter:brightness(1.08)}',
      '.ocid-report{font:inherit}',
      '.ocid-banner--wait{background:color-mix(in srgb,#f59e0b 14%,var(--bg,#fff));border-bottom-color:color-mix(in srgb,#f59e0b 30%,var(--border,rgba(0,0,0,.1)))}',
      '.ocid-banner--blocked{background:color-mix(in srgb,#ef4444 12%,var(--bg,#fff));border-bottom-color:color-mix(in srgb,#ef4444 28%,var(--border,rgba(0,0,0,.1)))}',
      '.ocid-banner__txt{flex:1 1 12rem;min-width:0;line-height:1.4}',
      '.ocid-banner__nick{font-weight:600}',
      '.ocid-banner__actions{display:flex;align-items:center;gap:.35rem;flex:none;margin-left:auto}',
      '.ocid-banner__btn{appearance:none;border:1px solid var(--border,rgba(0,0,0,.15));background:var(--bg,#fff);color:inherit;border-radius:8px;padding:.32rem .75rem;cursor:pointer;font:inherit;font-size:.88rem}',
      '.ocid-banner__btn--ok{background:#0ea5e9;border-color:#0ea5e9;color:#fff}',
      '.ocid-banner__btn--danger{background:transparent;border-color:color-mix(in srgb,#ef4444 45%,var(--border));color:#dc2626}',
      '.ocid-banner__btn--danger:hover{background:color-mix(in srgb,#ef4444 10%,var(--bg,#fff))}',
      '.ocid-banner__btn:hover{filter:brightness(1.05)}',
      '.ocid-banner__btn--icon{display:inline-flex;align-items:center;justify-content:center;padding:.28rem;min-width:2rem;color:#0284c7}',
      '.ocid-banner__x{appearance:none;border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;font:inherit;font-size:1.15rem;line-height:1;padding:.2rem .4rem;border-radius:6px}',
      '.ocid-banner__x:hover{opacity:1;background:color-mix(in srgb,#0ea5e9 14%,transparent)}',
      '.ocid-page{display:flex;flex-direction:column;gap:1rem;max-width:42rem;margin:0 auto;width:100%}',
      '.ocid-card{border:1px solid var(--border,rgba(0,0,0,.1));border-radius:12px;background:var(--bg,#fff);box-shadow:0 1px 2px rgba(0,0,0,.04);overflow:hidden}',
      '.ocid-card__hd{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.65rem .9rem;border-bottom:1px solid var(--border,rgba(0,0,0,.08));background:var(--bg-soft,rgba(0,0,0,.02))}',
      '.ocid-card__hd h3{margin:0;font-size:.92rem;font-weight:800;letter-spacing:-.01em}',
      '.ocid-card__count{font-size:.75rem;font-weight:700;padding:.12rem .45rem;border-radius:999px;background:color-mix(in srgb,#0ea5e9 16%,var(--bg));color:#0369a1}',
      '.ocid-card__count--warn{background:color-mix(in srgb,#f59e0b 20%,var(--bg));color:#b45309}',
      '.ocid-card__count--danger{background:color-mix(in srgb,#ef4444 16%,var(--bg));color:#b91c1c}',
      '.ocid-card__bd{padding:.55rem .65rem .7rem;display:flex;flex-direction:column;gap:.45rem}',
      '.ocid-card__hint{margin:0;padding:.45rem .55rem;font-size:.8rem;line-height:1.4;color:var(--muted,inherit);opacity:.9;background:var(--bg-soft,rgba(0,0,0,.03));border-radius:8px;border:1px dashed var(--border,rgba(0,0,0,.12))}',
      '.ocid-card__hint--danger{background:color-mix(in srgb,#ef4444 8%,var(--bg,#fff));border-color:color-mix(in srgb,#ef4444 28%,var(--border,rgba(0,0,0,.12)));color:#991b1b}',
      '.ocid-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.65rem .7rem;border-radius:10px;border:1px solid var(--border,rgba(0,0,0,.1));background:color-mix(in srgb,var(--bg-soft,rgba(0,0,0,.02)) 80%,var(--bg,#fff))}',
      '.ocid-row:hover{background:var(--bg-soft,rgba(0,0,0,.04));border-color:color-mix(in srgb,#0ea5e9 28%,var(--border,rgba(0,0,0,.12)))}',
      '.ocid-row--blocked{background:color-mix(in srgb,#ef4444 9%,var(--bg,#fff));border-color:color-mix(in srgb,#ef4444 32%,var(--border,rgba(0,0,0,.12)))}',
      '.ocid-row--blocked:hover{background:color-mix(in srgb,#ef4444 14%,var(--bg,#fff));border-color:color-mix(in srgb,#ef4444 45%,var(--border))}',
      '.ocid-row--ok{background:color-mix(in srgb,#0ea5e9 8%,var(--bg,#fff));border-color:color-mix(in srgb,#0ea5e9 28%,var(--border,rgba(0,0,0,.12)))}',
      '.ocid-row__who{display:flex;align-items:center;gap:.55rem;min-width:0;flex:1}',
      '.ocid-row__av{flex:none;width:2rem;height:2rem;border-radius:9px;display:grid;place-items:center;font-size:.85rem;font-weight:800;color:#fff;background:#0ea5e9}',
      '.ocid-row--blocked .ocid-row__av{background:#dc2626}',
      '.ocid-row__nick{font-weight:750;font-size:.98rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink,inherit)}',
      '.ocid-row__meta{font-size:.75rem;opacity:.72;margin-top:.12rem;font-weight:550}',
      '.ocid-row__actions{display:flex;gap:.35rem;flex-wrap:wrap;flex:none}',
      '.ocid-empty{margin:0;padding:.85rem .5rem;font-size:.88rem;opacity:.65;text-align:center}',
      '.ocid-toolbar{display:flex;flex-direction:column;gap:.55rem;padding:.85rem .9rem}',
      '.ocid-toolbar__row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}',
      '.ocid-toolbar input[type=text]{flex:1 1 10rem;min-width:0;padding:.45rem .65rem;border:1px solid var(--border,rgba(0,0,0,.15));border-radius:8px;background:var(--bg,#fff);color:inherit;font:inherit}',
      '.ocid-check{display:flex;align-items:center;gap:.45rem;font-size:.86rem;cursor:pointer;user-select:none;padding:0 .15rem}',
      '.ocid-srow{display:flex;align-items:center;gap:.65rem;padding:.55rem 0;border-top:1px solid var(--border,rgba(0,0,0,.08))}',
      '.ocid-srow:first-of-type{border-top:0}',
      '.ocid-srow__ic{flex:none;font-size:1.1rem;line-height:1}',
      '.ocid-srow__txt{flex:1;min-width:0}',
      '.ocid-srow__label{font-weight:650;font-size:.92rem}',
      '.ocid-srow__hint{font-size:.78rem;opacity:.7;margin-top:.15rem;line-height:1.35}',
      '.ocid-srow .switch{appearance:none;border:0;width:2.4rem;height:1.35rem;border-radius:999px;background:var(--border,rgba(0,0,0,.2));position:relative;cursor:pointer;flex:none;padding:0}',
      '.ocid-srow .switch.is-on{background:#0ea5e9}',
      '.ocid-srow .switch.is-locked{opacity:.75;cursor:not-allowed}',
      '.ocid-srow .switch__dot{position:absolute;top:2px;left:2px;width:1.05rem;height:1.05rem;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
      '.ocid-srow .switch.is-on .switch__dot{transform:translateX(1.05rem)}',
      '.ocid-popup{display:flex;flex-direction:column;align-items:stretch;gap:.85rem;padding:.35rem .15rem .15rem;max-width:24rem}',
      '.ocid-popup--warn{max-width:none;width:100%;box-sizing:border-box}',
      '.ocid-popup__icon{align-self:center;color:#0ea5e9}',
      '.ocid-popup__icon--warn{color:#d97706}',
      '.ocid-popup__lead{margin:0;font-size:1.05rem;text-align:center;line-height:1.35}',
      '.ocid-popup__actions{display:flex;gap:.55rem;justify-content:center;flex-wrap:wrap}',
      '.ocid-modal__empty{opacity:.7;font-size:.92rem;margin:0}',
      /* Desktop: full text, no scrollbar. Mobile: scroll only if the body overflows. */
      '.ocid-warn__body{white-space:pre-wrap;text-align:left;line-height:1.45;max-height:none;overflow:visible}',
      '@media (max-width:560px){.ocid-warn__body{max-height:min(48vh,20rem);overflow:auto;-webkit-overflow-scrolling:touch}}',
      /* Shield: muted by default, blue if this PM is allowed, red if blocked. */
      '.topbar__search.ocid-topbar{position:relative;background:transparent;color:var(--muted)}',
      '.topbar__search.ocid-topbar:hover{background:var(--bg-soft-2);color:var(--ink)}',
      '.topbar__search.ocid-topbar.is-on{background:transparent!important;color:var(--accent-d,var(--accent))!important}',
      'button.topbar__search.ocid-topbar.ocid-shield--allow,button.topbar__search.ocid-topbar.ocid-shield--allow:hover,button.topbar__search.ocid-topbar.ocid-shield--allow.is-on,button.topbar__search.ocid-topbar.ocid-shield--allow.is-on:hover{color:#2563eb!important}',
      'button.topbar__search.ocid-topbar.ocid-shield--deny,button.topbar__search.ocid-topbar.ocid-shield--deny:hover,button.topbar__search.ocid-topbar.ocid-shield--deny.is-on,button.topbar__search.ocid-topbar.ocid-shield--deny.is-on:hover{color:#dc2626!important}',
      '.topbar__search.ocid-topbar .ocid-topbar__badge{position:absolute;top:2px;right:2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:#0ea5e9;color:#fff;font-size:.65rem;font-weight:800;line-height:14px;text-align:center}',
      /* +D enveloppe (MP muets): gris comme les autres / rouge si actif — jamais de fond bleu. */
      '.topbar__search.topbar__privdeaf{background:transparent!important;color:var(--muted)!important}',
      '.topbar__search.topbar__privdeaf:hover{background:var(--bg-soft-2)!important;color:var(--ink)!important}',
      '.topbar__search.topbar__privdeaf.is-on{background:transparent!important;color:var(--danger,#d6465f)!important}',
      '.topbar__search.topbar__privdeaf.is-on:hover{background:var(--bg-soft-2)!important;color:var(--danger,#d6465f)!important}',
      '.ocid-check--tip{display:flex;align-items:flex-start;gap:.5rem;margin:.35rem 0 0;font-size:.86rem;cursor:pointer;user-select:none;text-align:left}',
      '.ocid-check--tip input{margin:.15rem 0 0;flex:none}',
      '.ocid-shield__pop{width:max-content;max-width:min(22rem,calc(100vw - 1rem))}',
      '.ocid-shield__pop .nmenu__txt b{white-space:normal}',
      '.ocid-menuic--allow,.ocid-menuic--list,.ocid-menuic--unblock{color:#2563eb}',
      '.ocid-menuic--remove{color:#b45309}',
      '.nmenu__item--danger .ocid-menuic{color:var(--danger,#dc2626)}',
    ].join('');
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

  function MenuGlyph(props) {
    var name = props && props.name;
    var common = {
      viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
      stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    };
    if (name === 'allow') {
      return h('svg', common,
        h('circle', { cx: '12', cy: '12', r: '8' }),
        h('path', { d: 'M8.4 12.2 11 14.7 15.7 9.5' })
      );
    }
    if (name === 'block') {
      return h('svg', common,
        h('circle', { cx: '12', cy: '12', r: '8' }),
        h('path', { d: 'm7.4 7.4 9.2 9.2' })
      );
    }
    if (name === 'unblock') {
      return h('svg', common,
        h('rect', { x: '5', y: '11', width: '14', height: '9', rx: '2' }),
        h('path', { d: 'M8 11V8.2a4 4 0 0 1 7.4-2' })
      );
    }
    if (name === 'remove') {
      return h('svg', common,
        h('path', { d: 'M16 21v-1.5A3.5 3.5 0 0 0 12.5 16H7.4A3.5 3.5 0 0 0 4 19.5V21' }),
        h('circle', { cx: '10', cy: '8', r: '3' }),
        h('path', { d: 'M17 8h5' })
      );
    }
    return h(ShieldIcon, { size: 18 });
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
      role: 'button',
      tabIndex: 0,
      title: pick(orbit, { fr: 'Liste blanche ouverte', en: 'Allow list open' }),
      onClick: function () {
        try {
          var st = chatState(orbit);
          if (st && typeof st.setActive === 'function') st.setActive(ALLOWLIST_BUF);
        } catch (e) { /* ignore */ }
      },
      onKeyDown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          try { e.preventDefault(); } catch (err) { /* ignore */ }
          try {
            var st = chatState(orbit);
            if (st && typeof st.setActive === 'function') st.setActive(ALLOWLIST_BUF);
          } catch (e2) { /* ignore */ }
        }
      },
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
      n ? h('span', { className: 'room__badge' }, n > 99 ? '99+' : String(n)) : null,
      h('button', {
        type: 'button',
        className: 'room__close',
        title: pick(orbit, { fr: 'Fermer la liste blanche', en: 'Close allow list' }),
        'aria-label': pick(orbit, { fr: 'Fermer la liste blanche', en: 'Close allow list' }),
        onClick: function (e) {
          try { e.stopPropagation(); e.preventDefault(); } catch (err) { /* ignore */ }
          closeListView(orbit);
        },
      }, '✕')
    );
  }

  /** 'allow' | 'deny' | '' — block list wins if a nick is on both. */
  function queryListKind(orbit, nick) {
    if (!nick) return '';
    if (isDenied(orbit, nick)) return 'deny';
    if (isAllowedNick(orbit, nick)) return 'allow';
    return '';
  }

  function shieldActions(orbit, nick) {
    var shown = displayNick(orbit, nick) || nick;
    var kind = queryListKind(orbit, nick);
    var actions = [];
    if (kind === 'deny') {
      actions.push({
        id: 'unblock',
        label: pick(orbit, { fr: 'Débloquer ' + shown, en: 'Unblock ' + shown }),
        run: function () { unblockNick(orbit, nick); },
      });
    } else if (kind === 'allow') {
      actions.push({
        id: 'remove',
        label: pick(orbit, {
          fr: 'Supprimer ' + shown + ' de la liste blanche',
          en: 'Remove ' + shown + ' from the allow list',
        }),
        run: function () { removeFromAllowList(orbit, nick); },
      });
    } else {
      actions.push({
        id: 'allow',
        label: pick(orbit, { fr: 'Autoriser ' + shown, en: 'Allow ' + shown }),
        run: function () { allowNick(orbit, nick); },
      });
      actions.push({
        id: 'block',
        danger: true,
        label: pick(orbit, { fr: 'Bloquer ' + shown, en: 'Block ' + shown }),
        run: function () { blockRequest(orbit, nick); },
      });
    }
    actions.push({
      id: 'list',
      label: pick(orbit, { fr: 'Afficher la liste blanche', en: 'Show the allow list' }),
      run: function () { openListView(orbit); },
    });
    return actions;
  }

  function shieldMenuButtons(orbit, nick, onDone) {
    return shieldActions(orbit, nick).map(function (a) {
      return h('button', {
        key: a.id,
        type: 'button',
        className: 'nmenu__item' + (a.danger ? ' nmenu__item--danger' : ''),
        role: 'menuitem',
        onClick: function () {
          if (onDone) onDone();
          a.run();
        },
      }, h('span', { className: 'nmenu__ic ocid-menuic ocid-menuic--' + a.id, 'aria-hidden': true },
        h(MenuGlyph, { name: a.id })
      ),
      h('span', { className: 'nmenu__txt' }, h('b', null, a.label)));
    });
  }

  function useActiveName(orbit) {
    return useSyncExternalStore(
      function (cb) { return orbit.on('buffer.active', cb); },
      function () { return orbit.state.active(); },
      function () { return orbit.state.active(); }
    );
  }

  function TopbarButton(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeListView, getListViewSnap, getListViewSnap);
    useSyncExternalStore(subscribeAccept, getAcceptSnap, getAcceptSnap);
    useSyncExternalStore(subscribeDeny, getDenySnap, getDenySnap);
    var active = useActiveName(orbit);
    var openState = useState(false);
    var menuOpen = openState[0];
    var setMenuOpen = openState[1];
    var ref = useRef(null);
    var peer = isQueryPeer(active) ? active : '';
    useEffect(function () { setMenuOpen(false); }, [peer]);
    useEffect(function () {
      if (!menuOpen) return undefined;
      function onDoc(e) {
        if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false);
      }
      function onEsc(e) {
        if (e.key === 'Escape') setMenuOpen(false);
      }
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onEsc);
      return function () {
        document.removeEventListener('mousedown', onDoc);
        document.removeEventListener('keydown', onEsc);
      };
    }, [menuOpen]);
    if (!gate.callerid && !gate.parental && !listPending().length) return null;
    var n = listPending().length;
    var shown = peer ? (displayNick(orbit, peer) || peer) : '';
    var kind = queryListKind(orbit, peer);
    var title = peer
      ? pick(orbit, { fr: 'Gérer ' + shown, en: 'Manage ' + shown })
      : pick(orbit, { fr: 'Liste blanche des messages privés', en: 'Private-message allow list' });
    if (kind === 'allow') {
      title = pick(orbit, {
        fr: shown + ' est dans votre liste blanche',
        en: shown + ' is on your allow list',
      });
    } else if (kind === 'deny') {
      title = pick(orbit, {
        fr: shown + ' est dans votre liste des utilisateurs bloqués',
        en: shown + ' is on your blocked list',
      });
    }
    var tone = kind === 'allow' ? ' ocid-shield--allow' : kind === 'deny' ? ' ocid-shield--deny' : '';
    return h('span', { className: 'nmenu ocid-shield', ref: ref },
      h('button', {
        type: 'button',
        className: 'topbar__search ocid-topbar' + tone + ((n || listView.open || menuOpen) ? ' is-on' : ''),
        title: title,
        'aria-label': title,
        'aria-expanded': peer ? menuOpen : undefined,
        'aria-haspopup': peer ? 'menu' : undefined,
        onClick: function () {
          if (peer) {
            setMenuOpen(function (v) { return !v; });
            return;
          }
          if (listView.open) closeListView(orbit);
          else openListView(orbit);
        },
      },
        h(ShieldIcon, { size: 19 }),
        n ? h('span', { className: 'ocid-topbar__badge', 'aria-hidden': true }, n > 9 ? '9+' : String(n)) : null
      ),
      peer && menuOpen
        ? h('div', { className: 'nmenu__pop ocid-shield__pop', role: 'menu', 'aria-label': title },
          shieldMenuButtons(orbit, peer, function () { setMenuOpen(false); })
        )
        : null
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
    useEffect(function () {
      if (!listView.open) return undefined;
      hideNativeAllowlistRow();
      var root = document.querySelector('.rooms');
      if (!root || typeof MutationObserver === 'undefined') return undefined;
      var mo = new MutationObserver(function () { hideNativeAllowlistRow(); });
      mo.observe(root, { childList: true, subtree: true });
      return function () { mo.disconnect(); };
    }, [listView.open]);
    if (!listView.open) return null;
    return h('div', { className: 'ocid-view', role: 'region', 'aria-label': pick(orbit, { fr: 'Liste blanche', en: 'Allow list' }) },
      h('div', { className: 'ocid-view__head' },
        h('span', { className: 'ocid-view__head-ic', 'aria-hidden': true }, h(ShieldIcon, { size: 22 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h2', { className: 'ocid-view__title' },
            pick(orbit, { fr: 'Messages privés', en: 'Private messages' })
          ),
          h('p', { className: 'ocid-view__sub' },
            pick(orbit, {
              fr: 'Autorisez, refusez ou bloquez les personnes qui peuvent vous écrire.',
              en: 'Allow, decline or block who can private-message you.',
            })
          )
        ),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn',
          onClick: function () { closeListView(orbit); },
        }, pick(orbit, { fr: 'Fermer', en: 'Close' }))
      ),
      h('div', { className: 'ocid-view__body' },
        h(ListModalBody, { orbit: orbit, onClose: function () { closeListView(orbit); } })
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
    useSyncExternalStore(subscribeDeny, getDenySnap, getDenySnap);
    useSyncExternalStore(subscribeAcceptedTips, getAcceptedTipsSnap, getAcceptedTipsSnap);
    useSyncExternalStore(subscribeAccept, getAcceptSnap, getAcceptSnap);
    useSyncExternalStore(subscribeChannelWarn, getChannelWarnSnap, getChannelWarnSnap);
    var [, bumpDismiss] = useState(0);
    var active = useSyncExternalStore(
      function (cb) { return orbit.on('buffer.active', cb); },
      function () { return orbit.state.active(); },
      function () { return orbit.state.active(); }
    );

    // Composer sends don't go through the plugin hook. A bubble still on local-
    // was not echoed (+g dropped it) — show « en attente » even if 716 was missed.
    useEffect(function () {
      if (!isQueryPeer(active)) return undefined;
      var key = pendingKey(active);
      var tick = function () {
        if (dismissedOutgoingWait[key]) return;
        if (!hasUnconfirmedSelf(orbit, active)) return;
        var tipNow = getAcceptedTip(active);
        if (tipNow && tipNow.kind === 'they-accepted') return;
        if (isBlockedBy(orbit, active)) return;
        var cur = getOutgoing(active);
        if (cur && !cur.refused && !cur.blocked) return;
        setOutgoing(active, {
          nick: displayNick(orbit, active) || active,
          ts: Date.now(),
          informed: false,
          refused: false,
          blocked: false,
        });
      };
      tick();
      var timer = window.setInterval(tick, 500);
      return function () { window.clearInterval(timer); };
    }, [active]);

    // Stale 718 while already on the allow list (server race / reconnect).
    prunePendingAllowed(orbit);

    var nodes = [];

    if (isChannelName(active) && parentalActive && channelJoined(orbit, active) && !hideChannelWarnPref(orbit)) {
      var chWarn = getChannelWarn(active);
      if (chWarn && !chWarn.hidden) {
        var chName = chWarn.chan || active;
        nodes.push(h('div', { key: 'chwarn-' + fold(chName), className: 'ocid-banner ocid-banner--chan', role: 'status' },
          h('div', { className: 'ocid-warn__top' },
            h(ChannelWarnBody, { orbit: orbit, chan: chName }),
            h('button', {
              type: 'button',
              className: 'ocid-banner__x',
              'aria-label': pick(orbit, { fr: 'Masquer', en: 'Dismiss' }),
              title: pick(orbit, { fr: 'Masquer jusqu’à la prochaine entrée', en: 'Hide until you rejoin' }),
              onClick: function () { dismissChannelWarn(chName); },
            }, '×')
          )
        ));
      }
    }

    if (isQueryPeer(active)) {
      var tip = getAcceptedTip(active);
      var tipBlocked = isBlockedBy(orbit, active) || !!(getOutgoing(active) && getOutgoing(active).blocked);
      // A hard block replaces the accept tip (the notice is the source of truth).
      if (tipBlocked) tip = null;
      // Accept tip and « en attente » must never stack (refresh / 716 race).
      if (tip) clearOutgoingWait(active);
      if (tip) {
        var tipNick = tip.nick || active;
        var tipTxt = tip.kind === 'they-accepted'
          ? pick(orbit, {
            fr: tipNick + ' a accepté votre demande. Vous pouvez dialoguer.',
            en: tipNick + ' accepted your request. You can chat now.',
          })
          : tip.kind === 'we-started'
            ? pick(orbit, {
              fr: tipNick + ' a été ajouté à votre liste blanche, parce que vous avez commencé la conversation.',
              en: tipNick + ' was added to your allow list because you started the conversation.',
            })
            : pick(orbit, {
              fr: 'Vous avez accepté la conversation avec ' + tipNick + '. '
                + tipNick + ' a été ajouté à votre liste blanche. '
                + 'Gérez-la via l’icône bouclier en haut.',
              en: 'You accepted the conversation with ' + tipNick + '. '
                + tipNick + ' was added to your allow list. '
                + 'Manage it via the shield icon in the top bar.',
            });
        nodes.push(h('div', { key: 'accepted-' + pendingKey(tipNick), className: 'ocid-banner', role: 'status' },
          h('span', { className: 'ocid-banner__txt' }, tipTxt),
          h('span', { className: 'ocid-banner__actions' },
            tip.kind === 'we-accepted' || tip.kind === 'we-started'
              ? h('button', {
                type: 'button',
                className: 'ocid-banner__btn ocid-banner__btn--icon',
                title: pick(orbit, { fr: 'Liste blanche', en: 'Allow list' }),
                'aria-label': pick(orbit, { fr: 'Ouvrir la liste blanche', en: 'Open allow list' }),
                onClick: function () { openListView(orbit); },
              }, h(ShieldIcon, { size: 18 }))
              : null,
            h('button', {
              type: 'button',
              className: 'ocid-banner__x',
              'aria-label': pick(orbit, { fr: 'Fermer', en: 'Close' }),
              onClick: function () { setAcceptedTip(tipNick, null); },
            }, '×')
          )
        ));
      }
    }

    if (gate.callerid || listPending().length) {
      var items = listPending();
      if (items.length) {
        var req = items[0];
        var reqNick = displayNick(orbit, req.nick);
        nodes.push(h('div', { key: 'in-' + pendingKey(reqNick), className: 'ocid-banner', role: 'status' },
          h('span', { className: 'ocid-banner__txt' },
            h('span', { className: 'ocid-banner__nick' }, reqNick),
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
            onClick: function () { acceptAndClear(orbit, reqNick); },
          }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () { declineRequest(orbit, reqNick); },
          }, pick(orbit, { fr: 'Refuser', en: 'Decline' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--danger',
            onClick: function () { blockRequest(orbit, reqNick); },
          }, pick(orbit, { fr: 'Bloquer', en: 'Block' }))
        ));
      }
    }

    if (isQueryPeer(active)) {
      var shown = displayNick(orbit, active);
      var wait = getOutgoing(active);
      var peer = getPeer(active);
      // Never tell the requester this is « contrôle parental » — that would expose
      // a protected (often underage) account. Neutral callerid wording only.
      var peerCallerid = !!(peer && (peer.g || peer.group));
      var weKey = pendingKey(active);
      var storedBlock = isBlockedBy(orbit, active) || !!(wait && wait.blocked);
      var hardBlockedBy = storedBlock && !dismissedPeerBlocked[weKey];
      var softDeclined = !!(wait && wait.refused && !wait.blocked) && !storedBlock;
      var blockedByPeer = hardBlockedBy || softDeclined;
      var weBlocked = isDenied(orbit, active);

      if (weBlocked && !dismissedWeBlocked[weKey]) {
        nodes.push(h('div', { key: 'we-block-' + weKey, className: 'ocid-banner ocid-banner--blocked', role: 'status' },
          h('span', { className: 'ocid-banner__txt' },
            pick(orbit, {
              fr: 'Vous avez bloqué ' + shown + ' : cette personne ne peut plus vous écrire en privé.',
              en: 'You blocked ' + shown + ': they can no longer private-message you.',
            })
          ),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () {
              dismissedWeBlocked[weKey] = true;
              bumpDismiss(function (n) { return n + 1; });
            },
          }, pick(orbit, { fr: 'Masquer', en: 'Dismiss' })),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn ocid-banner__btn--ok',
            onClick: function () {
              unblockNick(orbit, shown);
              delete dismissedWeBlocked[weKey];
              bumpDismiss(function (n) { return n + 1; });
            },
          }, pick(orbit, { fr: 'Débloquer', en: 'Unblock' }))
        ));
      } else if (storedBlock || !getAcceptedTip(active)) {
        // Real outbound wait only (716 after we actually wrote). Peer +g alone is not
        // "message pending" — especially when they already wrote to us first.
        // If the peer already replied, the conversation is live → drop a stale wait.
        if (wait && !wait.refused && !wait.blocked && bufferHasPeerOutbound(orbit, active)
          && !hasUnconfirmedSelf(orbit, active)) {
          clearOutgoingWait(active);
          wait = null;
        }
        var realWait = !!(wait && hasRealOutboundAttempt(orbit, active) && !wait.refused && !storedBlock);
        var showPeerHint = !!(peerCallerid && !realWait && !blockedByPeer && !storedBlock
          && !bufferHasPeerOutbound(orbit, active));
        if (realWait || showPeerHint || blockedByPeer) {
          var waitTxt;
          if (hardBlockedBy) {
            waitTxt = pick(orbit, {
              fr: shown + ' vous a bloqué : impossible de lui envoyer des messages privés.',
              en: shown + ' blocked you: you cannot send them private messages.',
            });
          } else if (softDeclined) {
            waitTxt = pick(orbit, {
              fr: shown + ' a refusé votre demande. Vous pourrez réessayer plus tard.',
              en: shown + ' declined your request. You can try again later.',
            });
          } else if (realWait) {
            waitTxt = pick(orbit, {
              fr: 'Votre message est en attente : ' + shown + ' doit vous autoriser avant de pouvoir dialoguer en privé.',
              en: 'Your message is pending: ' + shown + ' must allow you before private chat.',
            });
          } else {
            waitTxt = pick(orbit, {
              fr: shown + ' n’accepte les messages privés que sur autorisation. Attendez son accord pour dialoguer.',
              en: shown + ' only accepts private messages when allowed. Wait for their approval to chat.',
            });
          }
          nodes.push(h('div', {
            key: 'out-' + fold(active),
            className: 'ocid-banner' + (hardBlockedBy ? ' ocid-banner--blocked' : ' ocid-banner--wait'),
            role: 'status',
          },
            h('span', { className: 'ocid-banner__txt' }, waitTxt),
            realWait || blockedByPeer
              ? h('button', {
                type: 'button',
                className: 'ocid-banner__btn',
                onClick: function () {
                  if (storedBlock) dismissedPeerBlocked[weKey] = true;
                  else dismissedOutgoingWait[weKey] = true;
                  setOutgoing(active, null);
                  bumpDismiss(function (n) { return n + 1; });
                },
              }, pick(orbit, { fr: 'Masquer', en: 'Dismiss' }))
              : null
          ));
        }
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

    function doAllow(nick) {
      var n = String(nick || '').trim();
      if (!n) return;
      sendAccept(orbit, n, true);
      saveDenyNick(orbit, n, false);
      silenceNick(orbit, n, false);
      window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
    }

    function doBlock(nick) {
      var n = String(nick || '').trim();
      if (!n) return;
      blockRequest(orbit, n);
    }

    return h('div', { className: 'ocid-page' },
      h('div', { className: 'ocid-card' },
        h('div', { className: 'ocid-card__hd' },
          h('h3', null, pick(orbit, { fr: 'Ajouter ou bloquer', en: 'Allow or block' }))
        ),
        h('div', { className: 'ocid-toolbar' },
          h('div', { className: 'ocid-toolbar__row' },
            h('input', {
              type: 'text',
              value: draft,
              placeholder: pick(orbit, { fr: 'Pseudo…', en: 'Nick…' }),
              onChange: function (e) { setDraft(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === 'Enter' && draft.trim()) {
                  doAllow(draft.trim());
                  setDraft('');
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'ocid-banner__btn ocid-banner__btn--ok',
              onClick: function () {
                if (!draft.trim()) return;
                doAllow(draft.trim());
                setDraft('');
              },
            }, pick(orbit, { fr: 'Autoriser', en: 'Allow' })),
            h('button', {
              type: 'button',
              className: 'ocid-banner__btn ocid-banner__btn--danger',
              onClick: function () {
                if (!draft.trim()) return;
                doBlock(draft.trim());
                setDraft('');
              },
            }, pick(orbit, { fr: 'Bloquer', en: 'Block' })),
            h('button', {
              type: 'button',
              className: 'ocid-banner__btn',
              onClick: function () { refreshAcceptList(orbit); bumpDeny(); },
            }, pick(orbit, { fr: 'Actualiser', en: 'Refresh' }))
          ),
          h('label', { className: 'ocid-check' },
            h('input', {
              type: 'checkbox',
              checked: persist,
              onChange: function (e) {
                var on = !!e.target.checked;
                setPersist(on);
                setPersistEnabled(orbit, on);
                if (on) nicks.forEach(function (n) { saveAcceptNick(orbit, n, true); });
              },
            }),
            pick(orbit, {
              fr: 'Conserver les autorisations entre les connexions',
              en: 'Keep allowed nicks across connections',
            })
          ),
          persist && saved.length
            ? h('p', { className: 'ocid-card__hint' },
              pick(orbit, {
                fr: 'Mémorisés : ' + saved.join(', '),
                en: 'Remembered: ' + saved.join(', '),
              })
            )
            : null
        )
      ),

      pendingItems.length
        ? h('div', { className: 'ocid-card' },
          h('div', { className: 'ocid-card__hd' },
            h('h3', null, pick(orbit, { fr: 'Demandes en cours', en: 'Pending requests' })),
            h('span', { className: 'ocid-card__count ocid-card__count--warn' }, String(pendingItems.length))
          ),
          h('div', { className: 'ocid-card__bd' },
            pendingItems.map(function (req) {
              var rn = displayNick(orbit, req.nick);
              var initial = String(rn || '?').charAt(0).toUpperCase();
              return h('div', { key: 'p-' + pendingKey(rn), className: 'ocid-row' },
                h('div', { className: 'ocid-row__who' },
                  h('span', { className: 'ocid-row__av', 'aria-hidden': true, style: { background: '#d97706' } }, initial),
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'ocid-row__nick' }, rn),
                    h('div', { className: 'ocid-row__meta' },
                      pick(orbit, { fr: 'En attente de votre réponse', en: 'Waiting for your reply' })
                    )
                  )
                ),
                h('span', { className: 'ocid-row__actions' },
                  h('button', {
                    type: 'button',
                    className: 'ocid-banner__btn ocid-banner__btn--ok',
                    onClick: function () { acceptAndClear(orbit, rn); },
                  }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
                  h('button', {
                    type: 'button',
                    className: 'ocid-banner__btn',
                    onClick: function () { declineRequest(orbit, rn); },
                  }, pick(orbit, { fr: 'Refuser', en: 'Decline' })),
                  h('button', {
                    type: 'button',
                    className: 'ocid-banner__btn ocid-banner__btn--danger',
                    onClick: function () { blockRequest(orbit, rn); },
                  }, pick(orbit, { fr: 'Bloquer', en: 'Block' }))
                )
              );
            })
          )
        )
        : null,

      h('div', { className: 'ocid-card' },
        h('div', { className: 'ocid-card__hd' },
          h('h3', null, pick(orbit, { fr: 'Personnes acceptées', en: 'Accepted' })),
          h('span', { className: 'ocid-card__count' }, String(nicks.length))
        ),
        h('div', { className: 'ocid-card__bd' },
          acceptList.loading && !nicks.length
            ? h('p', { className: 'ocid-empty' }, pick(orbit, { fr: 'Chargement…', en: 'Loading…' }))
            : null,
          !acceptList.loading && !nicks.length
            ? h('p', { className: 'ocid-empty' }, pick(orbit, {
              fr: 'Personne n’est encore autorisé.',
              en: 'Nobody allowed yet.',
            }))
            : null,
          nicks.map(function (nick) {
            var initial = String(nick || '?').charAt(0).toUpperCase();
            return h('div', { key: nick, className: 'ocid-row ocid-row--ok' },
              h('div', { className: 'ocid-row__who' },
                h('span', { className: 'ocid-row__av', 'aria-hidden': true }, initial),
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'ocid-row__nick' }, nick),
                  h('div', { className: 'ocid-row__meta' },
                    pick(orbit, { fr: 'Autorisé à vous écrire', en: 'Allowed to message you' })
                  )
                )
              ),
              h('span', { className: 'ocid-row__actions' },
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn',
                  onClick: function () {
                    sendAccept(orbit, nick, false);
                    window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
                  },
                }, pick(orbit, { fr: 'Retirer', en: 'Remove' })),
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn ocid-banner__btn--danger',
                  onClick: function () { blockRequest(orbit, nick); },
                }, pick(orbit, { fr: 'Bloquer', en: 'Block' }))
              )
            );
          })
        )
      ),

      h('div', { className: 'ocid-card' },
        h('div', { className: 'ocid-card__hd' },
          h('h3', null, pick(orbit, { fr: 'Personnes bloquées', en: 'Blocked' })),
          h('span', { className: 'ocid-card__count ocid-card__count--danger' }, String(denied.length))
        ),
        h('div', { className: 'ocid-card__bd' },
          h('p', { className: 'ocid-card__hint ocid-card__hint--danger' },
            pick(orbit, {
              fr: 'Ces personnes ne peuvent plus vous écrire (blocage / SILENCE). Débloquez pour autoriser une nouvelle demande.',
              en: 'These people cannot message you (block / SILENCE). Unblock to allow a new request.',
            })
          ),
          !denied.length
            ? h('p', { className: 'ocid-empty' }, pick(orbit, {
              fr: 'Aucun pseudo bloqué.',
              en: 'No blocked nicks.',
            }))
            : null,
          denied.map(function (nick) {
            var initial = String(nick || '?').charAt(0).toUpperCase();
            return h('div', { key: 'd-' + nick, className: 'ocid-row ocid-row--blocked' },
              h('div', { className: 'ocid-row__who' },
                h('span', { className: 'ocid-row__av', 'aria-hidden': true }, initial),
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'ocid-row__nick' }, nick),
                  h('div', { className: 'ocid-row__meta' },
                    pick(orbit, { fr: 'Bloqué — ne peut plus vous écrire', en: 'Blocked — cannot message you' })
                  )
                )
              ),
              h('span', { className: 'ocid-row__actions' },
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn ocid-banner__btn--ok',
                  onClick: function () { unblockNick(orbit, nick); },
                }, pick(orbit, { fr: 'Débloquer', en: 'Unblock' }))
              )
            );
          })
        )
      )
    );
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeAccept, getAcceptSnap, getAcceptSnap);
    useSyncExternalStore(subscribeDeny, getDenySnap, getDenySnap);
    var active = useActiveName(orbit);
    if (!gate.callerid && !gate.parental && !listPending().length) return null;
    var peer = isQueryPeer(active) ? active : '';
    if (peer) return h(React.Fragment, null, shieldMenuButtons(orbit, peer));
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

  function CalleridModeRow(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    var locked = !!(parentalActive || isParental(orbit));
    var enabled = locked || hasModeG(orbit) || wantCallerid(orbit);
    return h('div', { className: 'srow' },
      h('span', { className: 'srow__ic srow__ic--mode', 'aria-hidden': true }, '+g'),
      h('div', { className: 'srow__txt' },
        h('div', { className: 'srow__label' },
          pick(orbit, {
            fr: 'Filtrer les messages privés',
            en: 'Filter private messages',
          })
        ),
        h('div', { className: 'srow__hint' },
          locked
            ? pick(orbit, {
              fr: 'Imposé par le contrôle parental — non désactivable.',
              en: 'Required by parental controls — cannot be turned off.',
            })
            : pick(orbit, {
              fr: 'Seules les personnes acceptées peuvent t’écrire (+g)',
              en: 'Only accepted people can message you (+g)',
            })
        )
      ),
      h('button', {
        type: 'button',
        className: 'switch' + (enabled ? ' is-on' : '') + (locked ? ' is-locked' : ''),
        role: 'switch',
        'aria-checked': enabled,
        'aria-disabled': locked,
        title: locked
          ? pick(orbit, { fr: 'Verrouillé', en: 'Locked' })
          : pick(orbit, { fr: 'Activer ou désactiver +g', en: 'Toggle +g' }),
        onClick: function () {
          if (locked) {
            setVoluntaryCallerid(orbit, false);
            return;
          }
          setVoluntaryCallerid(orbit, !enabled);
        },
      }, h('span', { className: 'switch__dot', 'aria-hidden': true }))
    );
  }

  function ChannelWarnAppearanceRow(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    var hidden = useSyncExternalStore(
      function (cb) {
        window.addEventListener('ocid-channel-warn-pref', cb);
        return function () { window.removeEventListener('ocid-channel-warn-pref', cb); };
      },
      function () { return hideChannelWarnPref(orbit) ? '1' : '0'; },
      function () { return '0'; }
    );
    // Affichage only — and only while this session is under parental controls.
    if (!gate.parental) return null;
    var show = hidden !== '1';
    return h('div', { className: 'ocid-srow' },
      h('span', { className: 'ocid-srow__ic', 'aria-hidden': true }, '🛡️'),
      h('div', { className: 'ocid-srow__txt' },
        h('div', { className: 'ocid-srow__label' },
          pick(orbit, {
            fr: 'Avertissement salons mixtes',
            en: 'Mixed-channel warning',
          })
        ),
        h('div', { className: 'ocid-srow__hint' },
          pick(orbit, {
            fr: 'Sous contrôle parental : bandeau de sécurité en rejoignant un salon officiel (hors espace jeunes). La croix le masque jusqu’à ce que tu quittes et reviennes. Désactivez pour ne plus le voir.',
            en: 'With parental controls: a safety banner when joining an official channel (outside the youth space). The close button hides it until you leave and rejoin. Turn off to hide it entirely.',
          })
        )
      ),
      h('button', {
        type: 'button',
        className: 'switch' + (show ? ' is-on' : ''),
        role: 'switch',
        'aria-checked': show,
        'aria-label': pick(orbit, {
          fr: 'Avertissement salons mixtes',
          en: 'Mixed-channel warning',
        }),
        onClick: function () {
          setHideChannelWarnPref(orbit, show);
        },
      }, h('span', { className: 'switch__dot', 'aria-hidden': true }))
    );
  }

  function registerSettingsMode(orbit) {
    var render = function () { return h(CalleridModeRow, { orbit: orbit }); };
    if (typeof orbit.addSettingsMode === 'function') {
      orbit.addSettingsMode({ render: render });
      return;
    }
    if (typeof orbit.addSettingsSection === 'function') {
      orbit.addSettingsSection({
        label: pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
        icon: '🛡️',
        render: function () {
          return h('div', { className: 'scard' },
            h('div', { className: 'scard__body' },
              h('div', { className: 'sfield' },
                h('div', { className: 'sfield__intro' },
                  pick(orbit, {
                    fr: 'Mode callerid (+g) et liste blanche des messages privés.',
                    en: 'Callerid (+g) mode and private-message allow list.',
                  })
                )
              ),
              render()
            )
          );
        },
      });
    }
  }

  function registerSettingsAppearance(orbit) {
    var render = function () { return h(ChannelWarnAppearanceRow, { orbit: orbit }); };
    if (typeof orbit.addSettingsAppearance === 'function') {
      orbit.addSettingsAppearance({ render: render });
      return;
    }
    if (typeof orbit.addSettingsSection === 'function') {
      orbit.addSettingsSection({
        label: pick(orbit, { fr: 'Avertissements', en: 'Warnings' }),
        icon: '🛡️',
        render: function () {
          return h('div', { className: 'scard' },
            h('div', { className: 'scard__body' }, render())
          );
        },
      });
    }
  }

  function modesContainG(text) {
    var m = String(text || '');
    var idx = m.search(/modes\s+/i);
    if (idx > -1) m = m.slice(idx + 6);
    m = m.replace(/^\+/, '');
    return m.indexOf('g') > -1;
  }

  Orbit.plugin('orbit-callerid', function (orbit, log) {
    lastOrbit = orbit;
    injectStyles();
    // Never leave the full-pane view open from a previous session / HMR.
    try { document.body.classList.remove('ocid-view-open'); } catch (e) { /* ignore */ }
    listView.open = false;
    listView.prevActive = '';
    listView.switching = false;

    function boot() {
      myGroupsText = '';
      modesApplied = false;
      restoreDone = false;
      denyRestoreDone = false;
      popupOpenFor = Object.create(null);
      refuseNotified = Object.create(null);
      dismissedWeBlocked = Object.create(null);
      dismissedPeerBlocked = Object.create(null);
      outboundText = Object.create(null);
      acceptConfirmed = Object.create(null);
      resentFirst = Object.create(null);
      dismissedOutgoingWait = Object.create(null);
      sessionStartedAt = Date.now();
      peers.probedAt = Object.create(null);
      peers.loading = Object.create(null);
      acceptList.nicks = [];
      acceptList.loading = false;
      bumpAccept();
      setParental(false);
      setCallerid(false);
      closeListView(orbit, { restore: false });
      Object.keys(officialPending).forEach(function (k) { clearOfficialPending(k); });
      officialPending = Object.create(null);
      channelWarn.map = Object.create(null);
      bumpChannelWarn();
      channelWarnOpen = false;
      ensureOwnerSession(orbit, log);
      var me = orbit.state.nick();
      if (me) {
        requestWhois(orbit, me);
        try { orbit.irc.send('MODE ' + me); } catch (e) { /* ignore */ }
      }
      // +g alone → callerid only. Full mode package → parental.
      if (hasParentalModePackage(orbit)) activateParental(orbit, log, 'paquet-modes');
      else if (hasModeG(orbit)) activateCallerid(orbit, log, 'umodes');
      else window.setTimeout(function () { applyVoluntaryCallerid(orbit, log); }, 600);
      window.setTimeout(function () { syncPrivDeafTip(orbit); }, 800);
      window.setTimeout(function () { restoreSavedDeny(orbit, log); }, 400);
    }

    try {
      if (orbit.state.get().status === 'registered') boot();
    } catch (e) { /* ignore */ }
    orbit.on('connected', boot);
    hookOutboundCapture(orbit);

    orbit.on('friends:add', function (nick) { syncFriendAllowlist(orbit, nick, true); });
    orbit.on('friends:remove', function (nick) { syncFriendAllowlist(orbit, nick, false); });
    orbit.on('ignore:add', function (nick) { syncIgnoreDenylist(orbit, nick, true); });
    orbit.on('ignore:remove', function (nick) { syncIgnoreDenylist(orbit, nick, false); });

    orbit.on('buffer.active', function (name) {
      if (listView.switching) return;
      if (isAllowlistBuffer(name)) {
        if (!listView.open) {
          listView.prevActive = listView.prevActive || '';
          setListViewOpen(true);
          refreshAcceptList(orbit);
          window.setTimeout(hideNativeAllowlistRow, 0);
        }
        return;
      }
      // Navigated to another buffer — close allow-list without stealing focus back.
      if (listView.open) closeListView(orbit, { restore: false });
      if (isQueryPeer(name)) probePeer(orbit, name);
      else if (parentalActive && isChannelName(name)) maybeWarnOfficialJoin(orbit, name);
    });

    orbit.on('chanserv:chaninfo', function (info) {
      onOfficialInfo(orbit, info);
    });

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '');
      var params = msg.params || [];
      var me = orbit.state.nick() || '';
      var targetNick = params[1] || '';

      // SASL / ACCOUNT: identity may switch from nick → account; re-scope lists.
      if (cmd === '900' || cmd === 'ACCOUNT') {
        var prevOwner = sessionOwner;
        ensureOwnerSession(orbit, log);
        if (sessionOwner && sessionOwner !== prevOwner && calleridActive) {
          restoreDone = false;
          restoreSavedAccept(orbit, log);
        }
        if (sessionOwner && sessionOwner !== prevOwner) {
          denyRestoreDone = false;
          restoreSavedDeny(orbit, log);
        }
      }

      if (cmd === '221') {
        var umodeis = String(params[1] || params[0] || '');
        // Snapshot umodes may lag; use the numeric itself for package / +g checks.
        var fakeOrbit = {
          state: { get: function () { return { umodes: umodeis.replace(/^\+/, '') }; } },
          config: orbit.config.bind(orbit),
        };
        if (hasParentalModePackage(fakeOrbit)) activateParental(orbit, log, '221-paquet');
        else if (umodeis.indexOf('g') > -1) activateCallerid(orbit, log, '221');
        window.setTimeout(function () { syncPrivDeafTip(orbit); }, 0);
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
          window.setTimeout(function () { syncPrivDeafTip(orbit); }, 0);
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
        var doneKey = pendingKey(targetNick);
        delete peers.loading[doneKey];
        if (doneKey) peers.probedAt[doneKey] = Date.now();
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
            else if (wantCallerid(orbit) && !isParental(orbit)) applyVoluntaryCallerid(orbit, log);
            else if (!listPending().length) setCallerid(false);
            syncPrivDeafTip(orbit);
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
        var blocked = rememberNickCase(params[1] || '');
        if (blocked) {
          // +g still sends 716 when we are hard-blocked (not on ACCEPT). That is not an unblock.
          if (isBlockedBy(orbit, blocked)) {
            patchPeer(blocked, { nick: blocked, g: true });
            return;
          }
          captureOutboundText(orbit, blocked);
          // A dropped replay must be allowed to run again (accept notice eaten by +g).
          if (hasUnconfirmedSelf(orbit, blocked)) resentFirst[pendingKey(blocked)] = false;
          // TAGMSG (accusés de lecture) also hits +g — ignore unless we really wrote.
          if (!hasRealOutboundAttempt(orbit, blocked) && !hasUnconfirmedSelf(orbit, blocked)) {
            patchPeer(blocked, { nick: blocked, g: true });
            return;
          }
          ensurePendingVisible(orbit, blocked);
          // A live chat can emit a stray 716 (ACCEPT restored a moment later).
          // An unconfirmed bubble (still local-) means THIS send was dropped: show the wait.
          var blockedTip = getAcceptedTip(blocked);
          var liveAlready = (blockedTip && blockedTip.kind === 'they-accepted')
            || bufferHasPeerOutbound(orbit, blocked);
          if (liveAlready && !hasUnconfirmedSelf(orbit, blocked) && !hasFreshOutbound(orbit, blocked)) {
            saveBlockedByNick(orbit, blocked, false);
            clearOutgoingWait(blocked);
            return;
          }
          // 716 = wait for ACCEPT, never a hard block. Clear a stale « blocked by »
          // after the peer unblocked us (SILENCE gone) so the wait banner returns.
          saveBlockedByNick(orbit, blocked, false);
          setOutgoing(blocked, {
            nick: blocked,
            ts: Date.now(),
            informed: false,
            refused: false,
            blocked: false,
          });
        }
        return;
      }
      if (cmd === '717') {
        var informed = rememberNickCase(params[1] || '');
        if (informed) {
          if (isBlockedBy(orbit, informed)) {
            patchPeer(informed, { nick: informed, g: true });
            return;
          }
          captureOutboundText(orbit, informed);
          if (!hasRealOutboundAttempt(orbit, informed)) {
            patchPeer(informed, { nick: informed, g: true });
            return;
          }
          ensurePendingVisible(orbit, informed);
          if (getAcceptedTip(informed) || bufferHasPeerOutbound(orbit, informed)) {
            saveBlockedByNick(orbit, informed, false);
            clearOutgoingWait(informed);
            return;
          }
          saveBlockedByNick(orbit, informed, false);
          var prev = getOutgoing(informed) || { nick: informed, ts: Date.now() };
          setOutgoing(informed, {
            nick: informed,
            ts: prev.ts || Date.now(),
            informed: true,
            refused: false,
            blocked: false,
          });
        }
        return;
      }

      // Incoming callerid request (+g) — not automatically « parental »
      if (cmd === '718') {
        var fromNick = rememberNickCase(params[1] || '');
        var fromHost = params[2] || '';
        if (!fromNick) return;
        if (isDenied(orbit, fromNick)) {
          // Already blocked — one reminder max (Status log; no OS notification).
          var deniedKey = pendingKey(fromNick);
          if (!refuseNotified[deniedKey]) {
            noticePeer(orbit, fromNick, pick(orbit, {
              fr: MARK_REVOKED_FR + '. ' + MARK_BLOCK_FR + '.',
              en: MARK_REVOKED_EN + '. ' + MARK_BLOCK_EN + '.',
            }));
            refuseNotified[deniedKey] = true;
            pushStatus(orbit, pick(orbit, {
              fr: fromNick + ' a réessayé de vous écrire (toujours bloqué).',
              en: fromNick + ' tried to message you again (still blocked).',
            }));
          }
          return;
        }
        // 718 means the server did not deliver. A saved allow-list entry is not
        // enough — the nick is not on the server ACCEPT list right now.
        // Only skip the request when WE opened the PM during this connection.
        if (hasFreshOutbound(orbit, fromNick) && (parentalActive || isParental(orbit))) {
          allowStartedPeer(orbit, fromNick);
          setPending(fromNick, null);
          delete popupOpenFor[pendingKey(fromNick)];
          // Nael's accept PRIVMSG hits our +g before ACCEPT +Nael is on the server,
          // so the notice never arrives and the first PM stays local-. Replay it
          // behind the ACCEPT we just queued.
          resendUnconfirmed(orbit, fromNick);
          return;
        }
        activateCallerid(orbit, log, '718');
        setPending(fromNick, { nick: fromNick, host: fromHost, ts: Date.now() });
        openRequestPopup(orbit, { nick: fromNick, host: fromHost });
        return;
      }

      if (cmd === '281') {
        if (acceptList.loading) {
          var accepted = params.length >= 2 ? params[1] : params[0];
          if (accepted && (params.length < 2 || fold(accepted) !== fold(me))) {
            pushAcceptNick(accepted);
            markAcceptConfirmed(accepted);
          }
        }
        return;
      }
      // 457 ERR_ACCEPTEXIST — the nick is already on the server ACCEPT list.
      if (cmd === '457') {
        var existNick = params.length >= 2 ? params[1] : params[0];
        if (existNick && fold(existNick) !== fold(me)) markAcceptConfirmed(existNick);
        return;
      }
      if (cmd === '282') {
        endAcceptList();
        return;
      }

      // Join refused (limit, ban, invite, key, …) → no parental banner.
      if (cmd === '405' || cmd === '471' || cmd === '473' || cmd === '474' || cmd === '475'
          || cmd === '476' || cmd === '477' || cmd === '489' || cmd === '519' || cmd === '520' || cmd === '926') {
        var deniedChan = params[1] || '';
        if (isChannelName(deniedChan)) resetChannelWarnVisit(deniedChan);
      }

      // Self JOIN → avertissement salons officiels (hors salons « sûrs »)
      if (String(cmd).toUpperCase() === 'JOIN') {
        var joinNick = msg.nick || '';
        if (fold(joinNick) === fold(me)) {
          var joined = params[0] || '';
          // JOIN can be "#chan" or "#chan\x07key" depending on parser
          joined = String(joined).split('\u0007')[0].split(' ')[0];
          if (parentalActive) maybeWarnOfficialJoin(orbit, joined);
          else if (isParental(orbit)) {
            activateParental(orbit, log, 'join');
            maybeWarnOfficialJoin(orbit, joined);
          }
        }
      }

      // Quitter le salon remet le bandeau pour la prochaine entrée.
      if (String(cmd).toUpperCase() === 'PART' || String(cmd).toUpperCase() === 'KICK') {
        var leftNick = String(cmd).toUpperCase() === 'KICK' ? (params[1] || '') : (msg.nick || '');
        var leftChan = params[0] || '';
        if (fold(leftNick) === fold(me) && leftChan) resetChannelWarnVisit(leftChan);
      }

      var up = String(cmd).toUpperCase();
      if ((up === 'PRIVMSG' || up === 'NOTICE') && msg.nick) {
        // echo-message: our PRIVMSG reached the peer → no longer « en attente ».
        if (fold(msg.nick) === fold(me)) {
          var echoTarget = params[0] || '';
          // History replay of our own lines must not wipe « X vous a bloqué ».
          // A live echo is not an unblock either — only the unblock / accept notice is.
          if (up === 'PRIVMSG' && isQueryPeer(echoTarget) && !isReplayIrcMsg(msg)
            && !isBlockedBy(orbit, echoTarget)) {
            clearOutgoingWait(echoTarget);
          }
          return;
        }
        rememberNickCase(msg.nick);
        var body = (params.length >= 2 ? params[1] : '') || '';
        // Backup: parse ChanServ INFO Options for « official » when plugin emit is missing
        if (up === 'NOTICE' && fold(msg.nick) === 'chanserv') {
          var infoBody = String(body || '');
          var optMatch = infoBody.match(/options?\s*:\s*(.+)$/i);
          if (optMatch) {
            var optBlob = fold(optMatch[1]);
            var isOff = optBlob.indexOf('official') > -1 || optBlob.indexOf('officiel') > -1
              || optBlob.indexOf('salon officiel') > -1 || optBlob.indexOf('cs_official') > -1;
            var pendingKeys = Object.keys(officialPending);
            if (pendingKeys.length === 1) {
              onOfficialInfo(orbit, { chan: officialPending[pendingKeys[0]].chan, official: isOff });
            }
          }
        }
        var listed = String(body || '').match(/^(\S+) is now on your accept list/i);
        if (listed) markAcceptConfirmed(listed[1]);
        var isControl = isAcceptNotice(body) || isRefuseNotice(body) || isRevokedNotice(body)
          || isBlockNotice(body) || isUnblockNotice(body);
        if (isControl) {
          // History / mphistory replay must not reopen banners after refresh.
          if (!isReplayIrcMsg(msg)) handlePeerDecision(orbit, msg.nick, body);
          return;
        }
        if (up === 'PRIVMSG' && getOutgoing(msg.nick) && !getOutgoing(msg.nick).refused) {
          setOutgoing(msg.nick, null);
        }
      }
    });

    orbit.on('sysline:action', function (ev) {
      var action = ev && typeof ev === 'object' ? ev.action : ev;
      if (action === 'allowlist') openListView(orbit);
    });

    // Hide refuse/block NOTICEs from the PM (banner + Status are enough on Orbit).
    if (typeof orbit.addMessageFilter === 'function') {
      orbit.addMessageFilter(function (m) {
        if (!m || String(m.command || '').toUpperCase() !== 'NOTICE') return false;
        return isCalleridControlNotice(m.text);
      });
    }

    orbit.addUi('sidebar_item', function () { return h(SideBadge, { orbit: orbit }); });
    orbit.addUi('sidebar_room', function () { return h(WhitelistRoomRow, { orbit: orbit }); });
    orbit.addUi('overlay', function () { return h(MainOverlays, { orbit: orbit }); });
    orbit.addUi('topbar_item', function () { return h(TopbarButton, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });
    registerSettingsMode(orbit);
    registerSettingsAppearance(orbit);

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
          fr: 'Refuser une demande de MP (sans bloquer — la personne pourra redemander)',
          en: 'Decline a PM request (without blocking — they may ask again)',
        }),
        run: function (args, rest) {
          var nick = nickArg(args, rest);
          if (!nick) {
            pushStatus(orbit, pick(orbit, { fr: 'Usage : /refuser <pseudo>', en: 'Usage: /refuser <nick>' }));
            return;
          }
          declineRequest(orbit, nick);
        },
      });
      orbit.addCommand('bloquer', {
        help: pick(orbit, {
          fr: 'Bloquer un pseudo en MP (liste noire + SILENCE)',
          en: 'Block a nick from PMing you (deny list + SILENCE)',
        }),
        run: function (args, rest) {
          var nick = nickArg(args, rest);
          if (!nick) {
            pushStatus(orbit, pick(orbit, { fr: 'Usage : /bloquer <pseudo>', en: 'Usage: /bloquer <nick>' }));
            return;
          }
          blockRequest(orbit, nick);
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
