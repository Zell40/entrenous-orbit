/*!
 * orbit-conference — Jitsi video/audio for Orbit (EntreNous)
 * Tag: +entrenous.fr/conference
 * Requires Orbit apiVersion >= 7 (msgTagged + message tags on MessageInfo).
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

  var TAG = '+entrenous.fr/conference';
  var ROOM_TAG = '+entrenous.fr/conference-room';
  var REPLY_TAG = '+entrenous.fr/conference-reply';
  var SESSION_TAG = '+entrenous.fr/conference-sid';
  var EVT_SHOW = 'plugin-conference.show';
  var EVT_HIDE = 'plugin-conference.hide';
  var HEIGHT_KEY = 'panelHeightPx';
  var HEIGHT_KEY_MOBILE = 'panelHeightPxMobile';
  var NARROW = '(max-width: 880px)';

  var conf = { active: false, buffer: '', room: '', startedByMe: false, listeners: new Set() };
  /** Buffers currently being ended for everyone — blocks leaveConference from restoring the banner. */
  var endingSession = Object.create(null);
  function subscribeConf(cb) { conf.listeners.add(cb); return function () { conf.listeners.delete(cb); }; }
  function getConfSnap() { return conf.active ? conf.buffer : ''; }
  var lastViewHeight = '46%';
  /** Buffers already announced on IRC for the current conference session. */
  var announced = Object.create(null);
  /** Short-lived EXTJWT proofs (ircd tokens expire; 50s is well under typical TTL). */
  var jwtCache = Object.create(null);
  var jwtInflight = Object.create(null);
  var extJwtWarming = false;
  /** Buffers where the user dismissed the invite banner (won't re-show until a new invite). */
  var dismissed = Object.create(null);
  /** Buffers where the conference was stopped — show a "visio ended" notice. */
  var stoppedNote = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribeStoppedNote(cb) { stoppedNote.listeners.add(cb); return function () { stoppedNote.listeners.delete(cb); }; }
  function getStoppedNoteSnap() { return stoppedNote.rev; }
  function setStoppedNote(buffer, nick) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    if (nick !== null) stoppedNote.map[key] = nick || '';
    else delete stoppedNote.map[key];
    stoppedNote.rev++;
    stoppedNote.listeners.forEach(function (l) { l(); });
  }
  function getStoppedNoteFor(buffer) {
    if (!buffer) return null;
    var key = inviteKey(buffer);
    return Object.prototype.hasOwnProperty.call(stoppedNote.map, key) ? stoppedNote.map[key] : null;
  }

  // Pending invites (tagged IRC lines hidden in Orbit) — buffer → { nick, link }
  // `rev` must change on every update: returning the same mutated map from
  // getSnapshot makes useSyncExternalStore skip re-renders (no Join banner).
  var invites = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribeInvites(cb) { invites.listeners.add(cb); return function () { invites.listeners.delete(cb); }; }
  function getInvitesSnap() { return invites.rev; }
  function inviteKey(buffer) { return chanKey(buffer) || String(buffer || '').toLowerCase(); }
  function getInviteFor(buffer) {
    if (!buffer) return null;
    return invites.map[inviteKey(buffer)] || null;
  }
  function setInvite(buffer, data) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    if (data) {
      if (!data.at) data.at = Date.now();
      invites.map[key] = data;
    } else delete invites.map[key];
    invites.rev++;
    invites.listeners.forEach(function (l) { l(); });
  }

  function touchInvite(buffer) {
    var inv = getInviteFor(buffer);
    if (!inv) return;
    inv.at = Date.now();
    invites.rev++;
    invites.listeners.forEach(function (l) { l(); });
  }

  /** True for chathistory / old server-time events — must not (re)open the blue banner. */
  function isStaleConferenceEvent(tags, orbit) {
    tags = tags || {};
    if (tags.batch) return true;
    var t = tags.time || tags['server-time'];
    if (!t) return false;
    var ms = Date.parse(String(t));
    if (!ms) return false;
    var maxAge = 120000;
    try {
      maxAge = (confCfg(orbit).inviteMaxAgeSec || 120) * 1000;
    } catch (e) { /* ignore */ }
    return (Date.now() - ms) > maxAge;
  }

  // Self security-group fragments from WHOIS special lines
  var myGroupsText = '';
  /** Last Meet room id per channel (for -01/-02 collision suffixes). */
  var channelRooms = Object.create(null);
  /** Visio still live in channel (until explicit stop) — keeps rejoin banner after leaving the panel. */
  var liveVisio = Object.create(null);

  function markLiveVisio(buffer, nick, room, sid, meta) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    var prev = liveVisio[key];
    meta = meta || {};
    liveVisio[key] = {
      nick: String(nick || (prev && prev.nick) || ''),
      room: String(room || (prev && prev.room) || ''),
      sid: String(sid || (prev && prev.sid) || ''),
      buffer: String(buffer || (prev && prev.buffer) || ''),
      starter: meta.starter === true ? true : !!(prev && prev.starter),
      at: Date.now(),
    };
  }

  function clearLiveVisio(buffer) {
    if (!buffer) return;
    delete liveVisio[inviteKey(buffer)];
  }

  function restoreRejoinInvite(orbit, buffer) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    var live = liveVisio[key];
    if (!live) return;
    delete dismissed[key];
    setInvite(buffer, {
      nick: live.nick || (orbit.state.nick && orbit.state.nick()) || '',
      link: publicLink(orbit, buffer),
      sid: live.sid || '',
      at: Date.now(),
    });
  }

  var heartbeatTimer = null;

  function stopVisioHeartbeat() {
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function sendVisioHeartbeat(orbit, buffer) {
    if (!orbit || !buffer) return;
    var cfg = confCfg(orbit);
    var key = inviteKey(buffer);
    var live = liveVisio[key];
    var room = (conf.active && inviteKey(conf.buffer) === key && conf.room)
      ? conf.room
      : ((live && live.room) || meetRoomFor(orbit, buffer));
    var sid = (live && live.sid) || '';
    var tagPrefix = '@' + TAG + '=' + (cfg.tagID || '1')
      + ';' + REPLY_TAG + '=alive'
      + (room ? ';' + ROOM_TAG + '=' + room : '')
      + (sid ? ';' + SESSION_TAG + '=' + sid : '')
      + ' ';
    try {
      orbit.irc.send(tagPrefix + 'TAGMSG ' + buffer);
    } catch (e) { /* ignore */ }
    markLiveVisio(buffer, orbit.state.nick() || '', room, sid, { starter: true });
    touchInvite(buffer);
  }

  function heartbeatBuffer(orbit) {
    if (conf.active && conf.startedByMe && conf.buffer) return conf.buffer;
    var me = String((orbit.state.nick && orbit.state.nick()) || '').toLowerCase();
    if (!me) return '';
    for (var k in liveVisio) {
      if (!Object.prototype.hasOwnProperty.call(liveVisio, k)) continue;
      var L = liveVisio[k];
      if (L && L.starter && L.buffer && String(L.nick || '').toLowerCase() === me) return L.buffer;
    }
    return '';
  }

  function startVisioHeartbeat(orbit) {
    stopVisioHeartbeat();
    if (!orbit) return;
    var sec = confCfg(orbit).heartbeatSec || 45;
    heartbeatTimer = window.setInterval(function () {
      var buf = heartbeatBuffer(orbit);
      if (!buf || !isChannelName(buf)) {
        stopVisioHeartbeat();
        return;
      }
      sendVisioHeartbeat(orbit, buf);
    }, sec * 1000);
  }

  /** Drop blue banners that were never refreshed (missed stop / history ghost). */
  function expireStaleInvites(orbit) {
    var ttl = ((orbit && confCfg(orbit).inviteTtlSec) || 180) * 1000;
    var now = Date.now();
    var changed = false;
    Object.keys(invites.map).forEach(function (key) {
      var inv = invites.map[key];
      if (!inv) return;
      var at = Number(inv.at) || 0;
      if (at && (now - at) > ttl) {
        delete invites.map[key];
        delete liveVisio[key];
        changed = true;
      }
    });
    Object.keys(liveVisio).forEach(function (key) {
      if (invites.map[key]) return;
      var live = liveVisio[key];
      var at = Number(live && live.at) || 0;
      // Don't expire the room we're currently connected to.
      if (conf.active && inviteKey(conf.buffer) === key) return;
      if (at && (now - at) > ttl) {
        delete liveVisio[key];
        changed = true;
      }
    });
    if (changed) {
      invites.rev++;
      invites.listeners.forEach(function (l) { l(); });
    }
  }

  function setConf(buffer, room, meta) {
    meta = meta || {};
    var prevBuf = conf.buffer;
    conf.active = !!buffer;
    conf.buffer = buffer || '';
    conf.room = buffer ? (room || conf.room || '') : '';
    conf.startedByMe = !!(buffer && meta.startedByMe);
    document.body.classList.toggle('oconf-open', !!buffer);
    if (!buffer) document.body.classList.remove('oconf-away', 'oconf-idle-warn', 'oconf-open');
    if (buffer) {
      document.documentElement.style.setProperty('--oconf-h', lastViewHeight);
      // Keep invite in memory so the blue rejoin banner comes back after leaving the panel.
    } else {
      document.documentElement.style.removeProperty('--oconf-h');
      announced = Object.create(null);
      conf.startedByMe = false;
      // Closing the panel: next open must not reuse a near-expiry EXTJWT.
      if (prevBuf) {
        try { invalidateExtJwt(isChannelName(prevBuf) ? prevBuf : '*'); } catch (eInv) { /* ignore */ }
      }
    }
    conf.listeners.forEach(function (l) { l(); });
    if (!buffer) stopIdleWatch();
  }
  var idleWatch = { timer: null, last: 0, warned: false, orbit: null, moveGate: 0 };

  function bumpIdleActivity() {
    if (!conf.active) return;
    idleWatch.last = Date.now();
    if (idleWatch.warned) {
      idleWatch.warned = false;
      document.body.classList.remove('oconf-idle-warn');
    }
  }

  function stopIdleWatch() {
    if (idleWatch.timer) {
      window.clearInterval(idleWatch.timer);
      idleWatch.timer = null;
    }
    idleWatch.orbit = null;
    idleWatch.warned = false;
    document.body.classList.remove('oconf-idle-warn');
  }

  function startIdleWatch(orbit) {
    stopIdleWatch();
    if (!orbit || !conf.active) return;
    var cfg = confCfg(orbit);
    var timeoutMs = Math.max(0, Number(cfg.idleTimeoutSec) || 0) * 1000;
    if (!timeoutMs) return;
    var warnMs = Math.max(0, Number(cfg.idleWarnSec) || 0) * 1000;
    idleWatch.orbit = orbit;
    idleWatch.last = Date.now();
    idleWatch.warned = false;
    idleWatch.timer = window.setInterval(function () {
      if (!conf.active || !idleWatch.orbit) {
        stopIdleWatch();
        return;
      }
      var elapsed = Date.now() - idleWatch.last;
      if (elapsed >= timeoutMs) {
        var o = idleWatch.orbit;
        var buf = conf.buffer;
        stopIdleWatch();
        try {
          o.notify('Visio', o.i18n.pick({
            fr: 'Visio fermée pour inactivité (aucune réaction).',
            en: 'Video call closed due to inactivity.',
          }));
        } catch (e) { /* ignore */ }
        closeVisioPanel(o, buf);
        return;
      }
      if (!idleWatch.warned && warnMs > 0 && elapsed >= Math.max(0, timeoutMs - warnMs)) {
        idleWatch.warned = true;
        document.body.classList.add('oconf-idle-warn');
        try {
          idleWatch.orbit.notify('Visio', idleWatch.orbit.i18n.pick({
            fr: 'Toujours là ? La visio se fermera bientôt faute d’activité.',
            en: 'Still there? The video call will close soon due to inactivity.',
          }));
        } catch (e2) { /* ignore */ }
      }
    }, 4000);
  }

  function syncAwayClass(orbit) {
    var active = '';
    try { active = (orbit && orbit.state && orbit.state.active && orbit.state.active()) || ''; } catch (e) { /* ignore */ }
    var has = !!(conf.active && conf.buffer);
    var onVisioBuf = has && inviteKey(active) === inviteKey(conf.buffer);
    var away = has && !onVisioBuf;
    // Layout compression only on the salon that owns the visio — not on other buffers.
    document.body.classList.toggle('oconf-open', onVisioBuf);
    document.body.classList.toggle('oconf-away', away);
    if (!has) document.body.classList.remove('oconf-idle-warn');
  }

  /** Switch UI back to the buffer that owns the open visio. */
  function focusVisioBuffer(orbit, buffer) {
    if (!buffer) return;
    if (isChannelName(buffer)) {
      try { orbit.irc.join(buffer); } catch (e) { /* ignore */ }
      return;
    }
    try {
      var want = String(buffer).replace(/^#/, '').toLowerCase();
      var rooms = document.querySelectorAll('.room');
      for (var i = 0; i < rooms.length; i++) {
        var el = rooms[i];
        var nameEl = el.querySelector('.room__name');
        var label = String((nameEl && nameEl.textContent) || '').replace(/^#/, '').toLowerCase();
        if (label === want) {
          el.click();
          return;
        }
      }
    } catch (e2) { /* ignore */ }
    try {
      // Last resort: open/focus query by sending nothing invasive — join-like for nick N/A.
      if (orbit.irc && orbit.irc.msg) { /* no-op keep panel visible */ }
    } catch (e3) { /* ignore */ }
  }

  function bindIdleActivityListeners() {
    function onPointer() { bumpIdleActivity(); }
    function onMove() {
      var now = Date.now();
      if (now - idleWatch.moveGate < 2000) return;
      idleWatch.moveGate = now;
      bumpIdleActivity();
    }
    function onKey() { bumpIdleActivity(); }
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('touchstart', onPointer, { capture: true, passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) bumpIdleActivity();
    });
  }

  function confCfg(orbit) {
    var c = (orbit.config().conference) || {};
    var secure = !!c.secure;
    var out = {
      server: c.server || 'visio.entrenous.chat',
      secure: secure,
      tokenEndpoint: c.tokenEndpoint || '/app/plugins/third/orbit-conference/visio-jwt.php',
      inviteEndpoint: c.inviteEndpoint || '/app/plugins/third/orbit-conference/visio-invite.php',
      profileVisioHint: c.profileVisioHint || 'https://www.reseau-entrenous.fr/',
      tagID: c.tagID || '1',
      channels: c.channels !== false,
      queries: c.queries !== false,
      enabledInChannels: c.enabledInChannels || ['*'],
      disabledInChannels: c.disabledInChannels || [],
      viewHeight: c.viewHeight || '46%',
      viewHeightMobile: c.viewHeightMobile || '28%',
      inviteText: c.inviteText || '-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}',
      joinText: c.joinText || '-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}',
      secureInviteText: c.secureInviteText
        || '-{{ nick }}- a lancé une visio [room:{{ room }}]. Rejoignez-la via le bandeau Orbit ou votre profil EntreNous.',
      secureQueryInviteText: c.secureQueryInviteText
        || '-{{ nick }}- vous invite en visio. Acceptez ou refusez depuis le bandeau.',
      joinButtonText: c.joinButtonText || 'Rejoindre',
      requireAccount: c.requireAccount !== false,
      requireChannelOp: c.requireChannelOp !== false,
      startPrefixes: c.startPrefixes || '~&@',
      denyGroups: c.denyGroups || [],
      requireGroups: c.requireGroups || [],
      maxParticipantsChannel: c.maxParticipantsChannel || 20,
      maxParticipantsQuery: c.maxParticipantsQuery || 2,
      // Auto-leave if no user/Jitsi interaction (0 = disabled). Warn idleWarnSec before.
      idleTimeoutSec: Math.max(0, Number(c.idleTimeoutSec) || 600),
      idleWarnSec: Math.max(0, Number(c.idleWarnSec) || 60),
      // Blue banner expires if not refreshed (heartbeat / new announce). Prevents ghost invites.
      inviteTtlSec: Math.max(60, Number(c.inviteTtlSec) || 180),
      // Ignore IRC invites/stops older than this (chathistory replay).
      inviteMaxAgeSec: Math.max(30, Number(c.inviteMaxAgeSec) || 120),
      heartbeatSec: Math.max(20, Number(c.heartbeatSec) || 45),
      anyoneCanStartIn: Array.isArray(c.anyoneCanStartIn) ? c.anyoneCanStartIn : [],
      channelRules: c.channelRules && typeof c.channelRules === 'object' ? c.channelRules : {},
      // Secure mode never publishes a reusable Jitsi URL on IRC.
      publicLinkInInvite: secure ? false : (c.publicLinkInInvite !== false),
      hideInviteForOrbit: c.hideInviteForOrbit !== false,
    };
    lastViewHeight = out.viewHeight;
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia(NARROW).matches) {
      lastViewHeight = out.viewHeightMobile;
    }
    return out;
  }

  function isChannelName(name) { return /^[#&+!]/.test(name || ''); }

  function chanKey(name) {
    return String(name || '').replace(/^[#&+!]/, '').toLowerCase();
  }

  function inChanList(list, buffer) {
    var want = chanKey(buffer);
    if (!want || !list || !list.length) return false;
    for (var i = 0; i < list.length; i++) {
      if (chanKey(list[i]) === want) return true;
    }
    return false;
  }

  function channelRule(cfg, buffer) {
    var rules = (cfg && cfg.channelRules) || {};
    var want = chanKey(buffer);
    if (!want) return {};
    for (var k in rules) {
      if (Object.prototype.hasOwnProperty.call(rules, k) && chanKey(k) === want) {
        return rules[k] && typeof rules[k] === 'object' ? rules[k] : {};
      }
    }
    return {};
  }

  function requireOpToStart(cfg, buffer) {
    if (inChanList(cfg.anyoneCanStartIn || [], buffer)) return false;
    var rule = channelRule(cfg, buffer);
    if (typeof rule.requireChannelOp === 'boolean') return rule.requireChannelOp;
    return !!cfg.requireChannelOp;
  }

  function requireAccountFor(cfg, buffer) {
    // Account is global: anyoneCanStartIn / channelRules cannot drop it.
    if (cfg.requireAccount) return true;
    var rule = channelRule(cfg, buffer);
    return !!rule.requireAccount;
  }

  function maxParticipantsFor(cfg, buffer) {
    if (!isChannelName(buffer)) return cfg.maxParticipantsQuery;
    var rule = channelRule(cfg, buffer);
    var n = Number(rule.maxParticipants);
    if (isFinite(n) && n > 0) return n;
    return cfg.maxParticipantsChannel;
  }

  function bufferAllowed(orbit, name) {
    var cfg = confCfg(orbit);
    if (!name || name === 'Status') return false;
    var chan = isChannelName(name);
    if (chan && !cfg.channels) return false;
    if (!chan && !cfg.queries) return false;
    if (!chan) return true;
    var disabled = cfg.disabledInChannels || [];
    if (inChanList(disabled, name)) return false;
    var list = cfg.enabledInChannels || ['*'];
    if (list.indexOf('*') > -1) return true;
    return inChanList(list, name);
  }

  function findBuffer(st, buffer) {
    var buffers = st && st.buffers;
    if (!buffers) return null;
    if (buffers[buffer]) return buffers[buffer];
    var want = chanKey(buffer);
    var low = String(buffer || '').toLowerCase();
    for (var k in buffers) {
      if (!Object.prototype.hasOwnProperty.call(buffers, k)) continue;
      var b = buffers[k];
      if (k.toLowerCase() === low || chanKey(k) === want || chanKey(b && b.name) === want) return b;
    }
    return null;
  }

  function myPrefixIn(orbit, buffer) {
    try {
      var st = orbit.state.get();
      var b = findBuffer(st, buffer);
      var members = b && b.members;
      var nick = orbit.state.nick();
      var m = members && nick ? members[nick] : null;
      if (!m && members && nick) {
        var want = String(nick).toLowerCase();
        for (var k in members) {
          if (Object.prototype.hasOwnProperty.call(members, k) && String(k).toLowerCase() === want) {
            m = members[k];
            break;
          }
        }
      }
      return (m && (m.prefixes || m.prefix)) || '';
    } catch (e) { return ''; }
  }

  function groupsBlocked(orbit, cfg) {
    var blob = (myGroupsText || '').toLowerCase();
    var deny = cfg.denyGroups || [];
    for (var i = 0; i < deny.length; i++) {
      var d = String(deny[i] || '').toLowerCase();
      if (d && blob.indexOf(d) > -1) return 'deny:' + deny[i];
    }
    var req = cfg.requireGroups || [];
    if (req.length) {
      var ok = false;
      for (var j = 0; j < req.length; j++) {
        var r = String(req[j] || '').toLowerCase();
        if (r && blob.indexOf(r) > -1) { ok = true; break; }
      }
      if (!ok && blob) return 'require';
      // If we have no WHOIS groups yet, don't hard-block (account check still applies).
    }
    return '';
  }

  function canJoin(orbit, buffer) {
    var cfg = confCfg(orbit);
    if (!bufferAllowed(orbit, buffer)) return { ok: false, reason: 'Salon non autorisé pour la visio.' };
    if (requireAccountFor(cfg, buffer) && !orbit.state.account()) {
      return { ok: false, reason: 'Compte IRC enregistré requis pour la visio.' };
    }
    var g = groupsBlocked(orbit, cfg);
    if (g.indexOf('deny:') === 0) {
      return { ok: false, reason: 'Visio indisponible pour votre profil (contrôle parental / groupe).' };
    }
    if (g === 'require') {
      return { ok: false, reason: 'Votre compte n’a pas les droits nécessaires pour la visio.' };
    }
    return { ok: true };
  }

  function canStart(orbit, buffer) {
    var join = canJoin(orbit, buffer);
    if (!join.ok) return join;
    var cfg = confCfg(orbit);
    if (isChannelName(buffer) && requireOpToStart(cfg, buffer)) {
      var pref = myPrefixIn(orbit, buffer);
      var allowed = cfg.startPrefixes || '~&@';
      var ok = false;
      for (var i = 0; i < pref.length; i++) {
        if (allowed.indexOf(pref[i]) > -1) { ok = true; break; }
      }
      if (!ok) {
        return { ok: false, reason: 'Seuls les opérateurs du salon peuvent démarrer une visio.' };
      }
    }
    return { ok: true };
  }

  function roomNameFor(orbit, buffer) {
    if (isChannelName(buffer)) return buffer;
    // Display label with accent; Meet room id stays ASCII Privee-… (see queryMeetRoomId).
    var a = myAccountName(orbit);
    var b = peerAccountForQuery(orbit, buffer);
    var pair = [a, b].sort(function (x, y) {
      return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
    });
    return 'Privée-' + pair[0] + '-' + pair[1];
  }

  function myAccountName(orbit) {
    try {
      var a = orbit.state.account && orbit.state.account();
      if (a) return String(a);
    } catch (e) { /* ignore */ }
    try {
      var st = orbit.state.get && orbit.state.get();
      if (st && st.account) return String(st.account);
    } catch (e2) { /* ignore */ }
    return String(orbit.state.nick() || 'user');
  }

  /** Stable Jitsi label = NickServ account (fallback nick). Prevents anonymous nick clones. */
  function jitsiDisplayName(orbit) {
    var acct = '';
    try { acct = String(myAccountName(orbit) || '').trim(); } catch (e) { /* ignore */ }
    if (acct) return acct;
    return String((orbit.state.nick && orbit.state.nick()) || 'user').trim();
  }

  function normalizeJitsiIdent(s) {
    return String(s || '').trim().toLowerCase();
  }

  function peerAccountForQuery(orbit, buffer) {
    var meAcct = myAccountName(orbit).toLowerCase();
    var meNick = String(orbit.state.nick() || '').toLowerCase();
    var peerNick = String(buffer || '');
    try {
      var st = orbit.state.get && orbit.state.get();
      var b = findBuffer(st, buffer);
      var members = (b && b.members) || {};
      var direct = members[peerNick] || members[Object.keys(members).find(function (k) {
        return String(k).toLowerCase() === peerNick.toLowerCase();
      }) || ''];
      if (direct && direct.account) return String(direct.account);
      for (var k in members) {
        if (!Object.prototype.hasOwnProperty.call(members, k)) continue;
        var m = members[k];
        if (!m) continue;
        if (meNick && String(k).toLowerCase() === meNick) continue;
        if (m.account && String(m.account).toLowerCase() !== meAcct) return String(m.account);
      }
    } catch (e) { /* ignore */ }
    return peerNick;
  }

  /** Stable MP room: Privee-<compteA>-<compteB> (sorted). Never use nicks. */
  function queryMeetRoomId(orbit, buffer) {
    var a = sanitizeMeetId(myAccountName(orbit));
    var b = sanitizeMeetId(peerAccountForQuery(orbit, buffer));
    var pair = [a, b].sort(function (x, y) {
      return x.localeCompare(y, undefined, { sensitivity: 'base' });
    });
    return sanitizeMeetId('Privee-' + pair[0] + '-' + pair[1]);
  }

  /** Jitsi-safe id from an IRC channel / query label. */
  function sanitizeMeetId(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^[#&+!]/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'room';
  }

  /**
   * Meet room id. Channels: channel name (+ optional -01). Queries: always the
   * deterministic Privee-<acct1>-<acct2> pair (no serial forks — that caused
   * desync / duplicate self in MP).
   */
  function allocateMeetRoom(orbit, buffer, forceNew) {
    var key = inviteKey(buffer);
    if (!isChannelName(buffer)) {
      var qRoom = queryMeetRoomId(orbit, buffer);
      channelRooms[key] = { name: qRoom, serial: 1 };
      return qRoom;
    }
    var cur = channelRooms[key];
    if (!forceNew && conf.active && conf.buffer && inviteKey(conf.buffer) === key && conf.room) {
      return conf.room;
    }
    if (!forceNew && cur && cur.name) return cur.name;
    var serial = cur ? cur.serial + 1 : 1;
    var base = sanitizeMeetId(buffer);
    var name = serial <= 1 ? base : (base + '-' + (serial < 10 ? '0' + serial : String(serial)));
    channelRooms[key] = { name: name, serial: serial };
    return name;
  }

  function meetRoomFor(orbit, buffer) {
    if (!isChannelName(buffer)) {
      // Prefer room announced by peer (ROOM_TAG), else stable pair id.
      var live = liveVisio[inviteKey(buffer)];
      if (live && live.room) return live.room;
      var curQ = channelRooms[inviteKey(buffer)];
      if (curQ && curQ.name) return curQ.name;
      return queryMeetRoomId(orbit, buffer);
    }
    if (conf.active && conf.buffer && inviteKey(conf.buffer) === inviteKey(buffer) && conf.room) {
      return conf.room;
    }
    var cur = channelRooms[inviteKey(buffer)];
    if (cur && cur.name) return cur.name;
    return allocateMeetRoom(orbit, buffer, false);
  }

  function newSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function bindQueryRoom(buffer, room, sid, nick) {
    var key = inviteKey(buffer);
    if (room) channelRooms[key] = { name: room, serial: 1 };
    markLiveVisio(buffer, nick || '', room || '', sid || '');
  }

  function publicLink(orbit, buffer) {
    var cfg = confCfg(orbit);
    var domain = cfg.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return 'https://' + domain + '/' + meetRoomFor(orbit, buffer);
  }

  function conferenceInviteMatch(orbit, text, tags) {
    var cfgLive = confCfg(orbit);
    var host = String(cfgLive.server || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    var linkRe = host
      ? new RegExp('https?:\\/\\/' + host.replace(/\./g, '\\.') + '\\/[^\\s]+', 'i')
      : /https?:\/\/[^\s]+/i;
    var txt = String(text || '');
    var linkMatch = txt.match(linkRe);
    var hasTag = !!(tags && Object.prototype.hasOwnProperty.call(tags, TAG));
    var roomMark = txt.match(/\[room:([A-Za-z0-9._-]{1,90})\]/i);
    // Secure invites have no public URL — match by tag, [room:…], or known invite phrasing.
    var looksInvite = /a lanc[eé] une visio|invite en visio|invite à rejoindre la conférence|rejoindre la conférence/i.test(txt);
    if (!hasTag && !linkMatch && !roomMark && !looksInvite) return null;
    if (linkMatch && !hasTag && !roomMark && !/visio|conf[eé]rence|conference/i.test(txt)) return null;
    return {
      linkMatch: linkMatch,
      hasTag: hasTag,
      roomFromText: roomMark ? roomMark[1] : '',
    };
  }

  function conferenceStopMatch(text, tags) {
    if (tags && String(tags[REPLY_TAG] || '').toLowerCase() === 'stop') return true;
    var t = String(text || '');
    if (/\[stop:[A-Za-z0-9._-]+\]/i.test(t)) return true;
    return /-[^-]+-\s+a arr[eê]t[eé] la conf[eé]rence\.?/i.test(t)
      || /-[^-]+-\s+a arr[eê]t[eé] la visio\.?/i.test(t);
  }

  function conferenceRefuseMatch(text, tags) {
    if (tags && String(tags[REPLY_TAG] || '').toLowerCase() === 'refuse') return true;
    return /-[^-]+-\s+a refus[eé] la visio\.?/i.test(String(text || ''));
  }

  function beginEndSession(buffer) {
    if (!buffer) return;
    endingSession[inviteKey(buffer)] = true;
  }

  function isEndingSession(buffer) {
    return !!(buffer && endingSession[inviteKey(buffer)]);
  }

  function clearEndingSession(buffer) {
    if (!buffer) return;
    delete endingSession[inviteKey(buffer)];
  }

  /** Peer/operator stopped the visio — clear banner + close local panel. */
  function handleConferenceStopped(orbit, buffer, fromNick) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    beginEndSession(buffer);
    clearLiveVisio(buffer);
    setInvite(buffer, null);
    delete dismissed[key];
    delete announced[key];
    setStoppedNote(buffer, fromNick || '');
    if (conf.active && inviteKey(conf.buffer) === key) {
      try {
        orbit.notify('Visio', orbit.i18n.pick({
          fr: 'La conférence a été arrêtée.',
          en: 'The conference was stopped.',
        }));
      } catch (e) { /* ignore */ }
      setConf(null);
    }
    window.setTimeout(function () { clearEndingSession(buffer); }, 800);
  }

  /** Peer refused our query visio — close our panel and clear the live session. */
  function handleConferenceRefused(orbit, buffer, fromNick) {
    if (!buffer) return;
    var key = inviteKey(buffer);
    var room = (liveVisio[key] && liveVisio[key].room)
      || (conf.active && conf.buffer && inviteKey(conf.buffer) === key ? conf.room : '')
      || '';
    clearLiveVisio(buffer);
    setInvite(buffer, null);
    delete dismissed[key];
    try {
      orbit.notify('Visio', orbit.i18n.pick({
        fr: (fromNick || 'Votre contact') + ' a refusé la visio.',
        en: (fromNick || 'Your contact') + ' declined the video call.',
      }));
    } catch (e) { /* ignore */ }
    if (room) {
      try { revokeSecureInvites(orbit, buffer, room); } catch (e2) { /* ignore */ }
    }
    if (conf.active && conf.buffer && inviteKey(conf.buffer) === key) {
      setConf(null);
    }
  }

  /** Decline a query visio invite and tell the caller. */
  function refuseConference(orbit, buffer) {
    if (!buffer) return;
    var nick = orbit.state.nick() || 'user';
    var cfg = confCfg(orbit);
    var text = '* -' + nick + '- a refusé la visio.';
    var tags = {};
    tags[TAG] = cfg.tagID || '1';
    tags[REPLY_TAG] = 'refuse';
    try {
      if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, text, tags);
      else if (orbit.irc.msg) orbit.irc.msg(buffer, text);
      else orbit.irc.send('PRIVMSG ' + buffer + ' :' + text);
    } catch (e) {
      try { orbit.irc.msg(buffer, text); } catch (e2) { /* ignore */ }
    }
    try {
      orbit.irc.send('@' + TAG + '=' + (cfg.tagID || '1') + ';' + REPLY_TAG + '=refuse TAGMSG ' + buffer);
    } catch (e3) { /* ignore */ }
    clearLiveVisio(buffer);
    setInvite(buffer, null);
    dismissed[inviteKey(buffer)] = true;
  }

  function delayMs(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  /** Read EXTJWT payload.exp (ms). Returns 0 if unknown. */
  function extJwtExpiryMs(proof) {
    try {
      var parts = String(proof || '').split('.');
      if (parts.length < 2) return 0;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4;
      if (pad) b64 += '===='.slice(0, 4 - pad);
      var payload = JSON.parse(atob(b64));
      var exp = payload && payload.exp ? Number(payload.exp) : 0;
      return exp > 0 ? exp * 1000 : 0;
    } catch (e) {
      return 0;
    }
  }

  function rememberExtJwt(key, proof) {
    var expMs = extJwtExpiryMs(proof);
    // Never keep a proof more than ~20s locally: ircd EXTJWT TTLs are short,
    // and reopening a visio must not reuse an already-expired token.
    var cap = Date.now() + 20000;
    var until = expMs ? Math.min(expMs - 5000, cap) : cap;
    if (until <= Date.now() + 1000) return;
    jwtCache[key] = { proof: proof, exp: until };
  }

  function invalidateExtJwt(target) {
    var key = String(target || '*').toLowerCase();
    delete jwtCache[key];
    delete jwtInflight[key];
  }

  function requestExtJwtOnce(orbit, target, waitMs) {
    target = String(target || '*');
    return new Promise(function (resolve, reject) {
      var off;
      var acc = '';
      var timer = window.setTimeout(function () {
        if (off) off();
        reject(new Error('jwt_timeout'));
      }, waitMs || 3000);
      off = orbit.on('raw', function (msg) {
        var cmd = String(msg.command || '').toUpperCase();
        var params = msg.params || [];
        var p0 = params[0] || '';
        var p1 = params[1] || '';
        if (cmd === 'FAIL' && String(p0).toUpperCase() === 'EXTJWT') {
          window.clearTimeout(timer); off();
          reject(new Error(String(p1).toUpperCase() === 'NOT_ON_CHANNEL' ? 'no_such_target' : 'extjwt_unsupported'));
          return;
        }
        if (cmd === '421' && String(p1).toUpperCase() === 'EXTJWT') {
          window.clearTimeout(timer); off(); reject(new Error('extjwt_unsupported')); return;
        }
        if (cmd === '403' && String(p1).toLowerCase() === String(target).toLowerCase()) {
          window.clearTimeout(timer); off(); reject(new Error('no_such_target')); return;
        }
        if (cmd !== 'EXTJWT') return;
        if (String(p0).toLowerCase() !== String(target).toLowerCase()) return;
        var moreComing = params.length >= 4 && params[2] === '*';
        acc += params[params.length - 1] || '';
        if (moreComing) return;
        window.clearTimeout(timer);
        off();
        if (!acc) { reject(new Error('jwt_timeout')); return; }
        resolve(acc);
      });
      orbit.irc.send('EXTJWT ' + target);
    });
  }

  /** One in-flight EXTJWT per target (visio JWT + invites used to race).
   *  Several retries: right after connect / JOIN, ZNC playback or slow ircd often
   *  swallows or delays the first EXTJWT (quick-click visio → jwt_timeout).
   *  opts.force = bypass cache (after invalid/expired proof). */
  function requestExtJwt(orbit, target, opts) {
    opts = opts || {};
    target = String(target || '*');
    var key = target.toLowerCase();
    if (opts.force) {
      delete jwtCache[key];
    } else {
      var hit = jwtCache[key];
      if (hit && hit.exp > Date.now() && hit.proof) return Promise.resolve(hit.proof);
    }
    if (jwtInflight[key]) return jwtInflight[key];

    function attempt(n) {
      // 1st: 6s, 2nd: 10s, 3rd: 14s — quick launches after attach need headroom.
      var waitMs = n === 1 ? 6000 : (n === 2 ? 10000 : 14000);
      return requestExtJwtOnce(orbit, target, waitMs).catch(function (err) {
        var code = String((err && err.message) || '');
        var retryable = code === 'jwt_timeout' || code === 'no_such_target';
        if (!retryable || n >= 3) throw err;
        return delayMs(350 * n).then(function () { return attempt(n + 1); });
      });
    }

    jwtInflight[key] = attempt(1)
      .then(function (proof) {
        rememberExtJwt(key, proof);
        return proof;
      })
      .finally(function () { delete jwtInflight[key]; });
    return jwtInflight[key];
  }

  function scheduleExtJwtWarm(orbit) {
    if (!confCfg(orbit).secure) return;
    if (extJwtWarming) return;
    extJwtWarming = true;
    var n = 0;
    function tick() {
      n += 1;
      var buf = orbit.state.active();
      if (!buf || !isChannelName(buf)) {
        if (n < 40) window.setTimeout(tick, 250);
        else extJwtWarming = false;
        return;
      }
      requestExtJwt(orbit, buf).then(function () {
        extJwtWarming = false;
      }).catch(function (err) {
        var code = String((err && err.message) || '');
        if ((code === 'no_such_target' || code === 'jwt_timeout') && n < 12) {
          window.setTimeout(tick, 600);
          return;
        }
        extJwtWarming = false;
      });
    }
    // Wait a bit so JOIN / account settle before the first EXTJWT.
    window.setTimeout(tick, 600);
  }

  function clearExtJwtState() {
    jwtCache = Object.create(null);
    jwtInflight = Object.create(null);
    extJwtWarming = false;
  }

  function loadJitsiApi(domain) {
    domain = String(domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return new Promise(function (resolve, reject) {
      var settled = false;
      function ok() { if (!settled) { settled = true; resolve(); } }
      function fail() { if (!settled) { settled = true; reject(new Error('jitsi_script')); } }
      if (window.JitsiMeetExternalAPI) { ok(); return; }
      var existing = document.querySelector('script[data-oconf="' + domain + '"]');
      if (existing) {
        existing.addEventListener('load', ok);
        existing.addEventListener('error', fail);
        window.setTimeout(function () { if (window.JitsiMeetExternalAPI) ok(); }, 0);
        return;
      }
      var scr = document.createElement('script');
      scr.src = 'https://' + domain + '/external_api.js';
      scr.async = true;
      scr.dataset.oconf = domain;
      scr.onload = ok;
      scr.onerror = fail;
      document.head.appendChild(scr);
    });
  }

  function requestConferenceJwt(orbit, buffer, room) {
    var cfg = confCfg(orbit);
    var proofTarget = isChannelName(buffer) ? buffer : '*';
    function exchange(proof) {
      return fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + proof,
        },
        body: JSON.stringify({
          room: room,
          channel: isChannelName(buffer) ? buffer : '',
        }),
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error((data && data.error) || ('http_' + res.status));
          });
        }
        return res.json();
      }).then(function (data) {
        if (!data || !data.token) throw new Error('missing_jitsi_token');
        return String(data.token);
      });
    }
    return requestExtJwt(orbit, proofTarget).then(function (proof) {
      return exchange(proof).catch(function (err) {
        var code = String((err && err.message) || '');
        // Stale cached EXTJWT after closing/reopening a visio quickly.
        if (code !== 'invalid_extjwt' && code !== 'extjwt_expired') throw err;
        invalidateExtJwt(proofTarget);
        return requestExtJwt(orbit, proofTarget, { force: true }).then(exchange);
      });
    });
  }

  /** Collect NickServ accounts present in the active buffer (WHOX / account-tag). */
  function collectBufferAccounts(orbit, buffer) {
    var accounts = [];
    var seen = Object.create(null);
    function pushAcct(a) {
      a = String(a || '').trim();
      if (!a) return;
      var k = a.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      accounts.push(a);
    }
    try {
      var me = orbit.state.account && orbit.state.account();
      if (me) pushAcct(me);
      else {
        var st0 = orbit.state.get && orbit.state.get();
        if (st0 && st0.account) pushAcct(st0.account);
      }
    } catch (e) { /* ignore */ }
    try {
      var st = orbit.state.get && orbit.state.get();
      var buffers = (st && st.buffers) || {};
      var buf = buffers[buffer];
      if (!buf) {
        Object.keys(buffers).forEach(function (k) {
          if (String(k).toLowerCase() === String(buffer).toLowerCase()) buf = buffers[k];
        });
      }
      var members = (buf && buf.members) || {};
      Object.keys(members).forEach(function (nick) {
        var m = members[nick];
        if (m && m.account) pushAcct(m.account);
      });
      // Query: other party may only appear as buffer name + profile cache
      if (!isChannelName(buffer) && buf) {
        // no members map — invitee account often unknown until WHOIS
      }
    } catch (e2) { /* ignore */ }
    return accounts;
  }

  /** Refresh WHOX so member.account is filled before collecting invites / MP room id. */
  function refreshBufferAccounts(orbit, buffer) {
    return new Promise(function (resolve) {
      try {
        if (orbit.irc && orbit.irc.send) {
          // Same WHOX token as Orbit core (152) so 354 updates the member list.
          if (isChannelName(buffer)) orbit.irc.send('WHO ' + buffer + ' %tcnfar,152');
          else {
            orbit.irc.send('WHO ' + buffer + ' %tcnfar,152');
            orbit.irc.send('WHOIS ' + buffer);
          }
        }
      } catch (e) { /* ignore */ }
      setTimeout(resolve, isChannelName(buffer) ? 700 : 900);
    });
  }

  /** Register account-bound invites for non-Orbit clients (secure mode). */
  function publishSecureInvites(orbit, buffer, room, extraAccounts, opts) {
    var cfg = confCfg(orbit);
    if (!cfg.secure || !cfg.inviteEndpoint) return Promise.resolve(null);
    opts = opts || {};
    var action = opts.action === 'add' ? 'add' : 'create';
    var proofTarget = isChannelName(buffer) ? buffer : '*';
    return refreshBufferAccounts(orbit, buffer).then(function () {
      var accounts = collectBufferAccounts(orbit, buffer);
      if (Array.isArray(extraAccounts)) {
        extraAccounts.forEach(function (a) {
          a = String(a || '').trim();
          if (a && accounts.indexOf(a) === -1) accounts.push(a);
        });
      }
      // MP: only the two NickServ accounts of the pair (never expand via profile invites).
      if (!isChannelName(buffer)) {
        var pair = [];
        var meA = myAccountName(orbit);
        var peerA = peerAccountForQuery(orbit, buffer);
        if (meA) pair.push(meA);
        if (peerA && String(peerA).toLowerCase() !== String(meA).toLowerCase()) pair.push(peerA);
        accounts = pair;
      }
      return requestExtJwt(orbit, proofTarget).then(function (proof) {
        return fetch(cfg.inviteEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + proof,
          },
          body: JSON.stringify({
            action: action,
            room: room,
            channel: isChannelName(buffer) ? buffer : '',
            accounts: accounts,
          }),
        }).then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              throw new Error((data && data.error) || ('http_' + res.status));
            });
          }
          return res.json();
        });
      });
    }).then(function (data) {
      if (!data || !data.ok) return data;
      if (opts.silent) return data;
      try {
        var n = Array.isArray(data.accounts) ? data.accounts.length : 0;
        orbit.notify('Visio', orbit.i18n.pick({
          fr: n
            ? ('Invitations profil publiées pour ' + n + ' compte' + (n > 1 ? 's' : '') + ' NickServ.')
            : 'Invitation publiée (aucun autre compte NickServ détecté dans le salon).',
          en: n
            ? ('Profile invites published for ' + n + ' NickServ account' + (n > 1 ? 's' : '') + '.')
            : 'Invite published (no other NickServ accounts detected in the channel).',
        }));
      } catch (e) { /* ignore */ }
      return data;
    }).catch(function (err) {
      try {
        console.warn('[orbit-conference] publishSecureInvites failed', err);
        orbit.notify('Visio', orbit.i18n.pick({
          fr: 'Invitations profil non publiées (' + (err && err.message ? err.message : 'erreur') + ').',
          en: 'Profile invites not published (' + (err && err.message ? err.message : 'error') + ').',
        }));
      } catch (e) { /* ignore */ }
      return null;
    });
  }

  /** Announce the conference on IRC once per open session (starter only). */
  function announceConference(orbit, buffer, opts) {
    opts = opts || {};
    var aKey = inviteKey(buffer);
    if (!buffer || (announced[aKey] && !opts.force)) return;
    announced[aKey] = true;
    var cfg = confCfg(orbit);
    var room = meetRoomFor(orbit, buffer);
    var nick = orbit.state.nick() || 'user';
    var sid = (liveVisio[inviteKey(buffer)] && liveVisio[inviteKey(buffer)].sid) || newSessionId();
    bindQueryRoom(buffer, room, sid, nick);
    // Starter also keeps a local invite so the blue banner returns after leaving the panel.
    delete dismissed[inviteKey(buffer)];
    setStoppedNote(buffer, null);
    setInvite(buffer, { nick: nick, link: publicLink(orbit, buffer), sid: sid });

    var tagPrefix = '@' + TAG + '=' + (cfg.tagID || '1')
      + ';' + ROOM_TAG + '=' + room
      + ';' + SESSION_TAG + '=' + sid + ' ';

    if (cfg.secure) {
      publishSecureInvites(orbit, buffer, room);
      try {
        orbit.irc.send(tagPrefix + 'TAGMSG ' + buffer);
      } catch (e) { /* ignore */ }
      // Informative PRIVMSG — no Jitsi URL. In queries this PRIVMSG also opens the
      // peer's MP buffer (must not be swallowed by hideInviteForOrbit).
      var isQuery = !isChannelName(buffer);
      var secureTpl = isQuery
        ? (cfg.secureQueryInviteText || cfg.secureInviteText || '')
        : (cfg.secureInviteText || '');
      var secureText = '* ' + secureTpl
        .replace(/\{\{\s*nick\s*\}\}/g, nick)
        .replace(/\{\{\s*room\s*\}\}/g, room);
      secureText = secureText.replace(/\s+/g, ' ').trim();
      // Always include [room:…] so peers can join even if client-tags are stripped.
      if (room && !/\[room:[A-Za-z0-9._-]+\]/i.test(secureText)) {
        secureText = secureText.replace(/\.\s*$/, '') + ' [room:' + room + '].';
      }
      if (secureText && secureText !== '*') {
        var tagsS = {};
        tagsS[TAG] = cfg.tagID || '1';
        tagsS[ROOM_TAG] = room;
        tagsS[SESSION_TAG] = sid;
        try {
          if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, secureText, tagsS);
          else if (orbit.irc.msg) orbit.irc.msg(buffer, secureText);
          else orbit.irc.send('PRIVMSG ' + buffer + ' :' + secureText);
        } catch (e2) {
          try { orbit.irc.msg(buffer, secureText); } catch (e3) { /* ignore */ }
        }
      }
      return;
    }

    // No public Jitsi URL: TAGMSG for Orbit + a short PRIVMSG in queries so the
    // peer gets a real MP buffer / notification even with no prior conversation.
    if (!cfg.publicLinkInInvite) {
      try {
        orbit.irc.send(tagPrefix + 'TAGMSG ' + buffer);
      } catch (e) { /* ignore */ }
      if (!isChannelName(buffer)) {
        var qText = '* -' + nick + '- vous invite en visio.';
        var tagsQ = {};
        tagsQ[TAG] = cfg.tagID || '1';
        tagsQ[ROOM_TAG] = room;
        tagsQ[SESSION_TAG] = sid;
        try {
          if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, qText, tagsQ);
          else if (orbit.irc.msg) orbit.irc.msg(buffer, qText);
          else orbit.irc.send('PRIVMSG ' + buffer + ' :' + qText);
        } catch (eQ) { /* ignore */ }
      }
      return;
    }
    var link = publicLink(orbit, buffer);
    var isChan = isChannelName(buffer);
    var tpl = isChan ? (cfg.joinText || '') : (cfg.inviteText || '');
    var text = '* ' + tpl
      .replace(/\{\{\s*nick\s*\}\}/g, nick)
      .replace(/\{\{\s*link\s*\}\}/g, link);
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text === '*') return;
    var tags = {};
    tags[TAG] = cfg.tagID || '1';
    tags[ROOM_TAG] = room;
    tags[SESSION_TAG] = sid;
    try {
      if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, text, tags);
      else if (orbit.irc.msg) orbit.irc.msg(buffer, text);
      else orbit.irc.send('PRIVMSG ' + buffer + ' :' + text);
    } catch (e) {
      try { orbit.irc.msg(buffer, text); } catch (e2) { /* ignore */ }
    }
  }

  function revokeSecureInvites(orbit, buffer, room) {
    var cfg = confCfg(orbit);
    if (!cfg.secure || !cfg.inviteEndpoint || !room) return Promise.resolve(null);
    var proofTarget = isChannelName(buffer) ? buffer : '*';
    return requestExtJwt(orbit, proofTarget).then(function (proof) {
      return fetch(cfg.inviteEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + proof,
        },
        body: JSON.stringify({ action: 'end', room: room }),
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error((data && data.error) || ('http_' + res.status));
          });
        }
        return res.json();
      });
    }).catch(function (err) {
      try {
        console.warn('[orbit-conference] revokeSecureInvites failed', err);
      } catch (e) { /* ignore */ }
      return null;
    });
  }

  function announceConferenceStopped(orbit, buffer) {
    if (!buffer) return;
    var nick = orbit.state.nick() || 'user';
    var cfg = confCfg(orbit);
    var key = inviteKey(buffer);
    var room = (conf.active && inviteKey(conf.buffer) === key && conf.room)
      ? conf.room
      : ((liveVisio[key] && liveVisio[key].room) || (channelRooms[key] && channelRooms[key].name) || meetRoomFor(orbit, buffer));
    var sid = (liveVisio[key] && liveVisio[key].sid) || '';
    var tags = {};
    tags[TAG] = cfg.tagID || '1';
    tags[REPLY_TAG] = 'stop';
    if (room) tags[ROOM_TAG] = room;
    if (sid) tags[SESSION_TAG] = sid;
    var text = '* -' + nick + '- a arrêté la conférence.'
      + (room ? ' [stop:' + room + ']' : '');
    try {
      if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, text, tags);
      else if (orbit.irc.msg) orbit.irc.msg(buffer, text);
      else orbit.irc.send('PRIVMSG ' + buffer + ' :' + text);
    } catch (e) {
      try { orbit.irc.msg(buffer, text); } catch (e2) { /* ignore */ }
    }
    try {
      var tagPrefix = '@' + TAG + '=' + (cfg.tagID || '1')
        + ';' + REPLY_TAG + '=stop'
        + (room ? ';' + ROOM_TAG + '=' + room : '')
        + (sid ? ';' + SESSION_TAG + '=' + sid : '')
        + ' ';
      orbit.irc.send(tagPrefix + 'TAGMSG ' + buffer);
    } catch (eTag) { /* ignore */ }
    // Drop profile invites immediately so Mon identité stops offering the room.
    try {
      revokeSecureInvites(orbit, buffer, room);
    } catch (e3) { /* ignore */ }
    // Force a fresh EXTJWT on the next open (ircd proofs expire quickly).
    try {
      invalidateExtJwt(isChannelName(buffer) ? buffer : '*');
    } catch (e4) { /* ignore */ }
    clearLiveVisio(buffer);
    setInvite(buffer, null);
    delete dismissed[key];
    delete announced[key];
    setStoppedNote(buffer, nick);
  }

  /** Leave the Jitsi panel without ending the channel visio (blue rejoin banner stays). */
  /** True if Orbit still has a buffer for this visio target (channel or query). */
  function visioBufferStillOpen(orbit, buffer) {
    if (!buffer) return false;
    var key = inviteKey(buffer);
    try {
      var st = orbit.state.get && orbit.state.get();
      var bufs = st && st.buffers;
      if (!bufs) return false;
      if (bufs[buffer]) return true;
      for (var k in bufs) {
        if (!Object.prototype.hasOwnProperty.call(bufs, k)) continue;
        if (inviteKey(k) === key) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** Leave Jitsi when the user left/closed the salon/MP that owns the visio. */
  function dropVisioIfLeftBuffer(orbit) {
    if (!conf.active || !conf.buffer) return;
    if (visioBufferStillOpen(orbit, conf.buffer)) return;
    leaveConference(orbit, conf.buffer);
  }

  function leaveConference(orbit, buffer) {
    buffer = buffer || conf.buffer;
    if (!buffer) {
      setConf(null);
      return;
    }
    var key = inviteKey(buffer);
    // endConference / remote stop already cleared the session — do not resurrect the banner.
    if (isEndingSession(buffer) || (!liveVisio[key] && !getInviteFor(buffer) && getStoppedNoteFor(buffer) !== null)) {
      setConf(null);
      return;
    }
    var liveL = liveVisio[key];
    if (conf.room) {
      markLiveVisio(
        buffer,
        (liveL && liveL.nick) || orbit.state.nick() || '',
        conf.room,
        (liveL && liveL.sid) || ''
      );
    }
    setConf(null);
    restoreRejoinInvite(orbit, buffer);
  }

  /** Starter/op ends the visio for everyone. */
  function endConference(orbit, buffer) {
    buffer = buffer || conf.buffer;
    if (!buffer) {
      setConf(null);
      return;
    }
    beginEndSession(buffer);
    announceConferenceStopped(orbit, buffer);
    stopVisioHeartbeat();
    setConf(null);
    window.setTimeout(function () { clearEndingSession(buffer); }, 800);
  }

  /**
   * Close the local Jitsi UI:
   * - starter (opérateur qui a lancé) → stop for everyone
   * - participant → leave only (blue rejoin banner stays)
   */
  function closeVisioPanel(orbit, buffer) {
    buffer = buffer || conf.buffer;
    if (!buffer) {
      setConf(null);
      return;
    }
    if (conf.active && conf.startedByMe && inviteKey(conf.buffer) === inviteKey(buffer)) {
      endConference(orbit, buffer);
      return;
    }
    leaveConference(orbit, buffer);
  }

  function openConference(orbit, buffer, opts) {
    opts = opts || {};
    if (!bufferAllowed(orbit, buffer)) return;
    if (conf.active && conf.buffer === buffer) {
      // Closing an open panel = starter ends for all; participant leaves (rejoin banner).
      closeVisioPanel(orbit, buffer);
      orbit.emit(EVT_HIDE);
      return;
    }
    var key = inviteKey(buffer);
    var live = liveVisio[key];
    var hasLive = !!(live && live.room) || !!getInviteFor(buffer);
    // MP only: never fork a second room when a live invite exists.
    // Channels must still (re)announce so other Orbit clients get the blue banner.
    if (!opts.joinOnly && hasLive && !opts.forceNew && !isChannelName(buffer)) {
      opts = Object.assign({}, opts, { joinOnly: true });
    }
    var gate = opts.joinOnly ? canJoin(orbit, buffer) : canStart(orbit, buffer);
    if (!gate.ok) {
      orbit.notify('Visio', gate.reason || 'Accès refusé.');
      return;
    }
    if (conf.active && inviteKey(conf.buffer) !== inviteKey(buffer)) {
      var msg = orbit.i18n.pick({
        fr: 'Une visio est déjà ouverte ailleurs. La quitter pour en ouvrir une ici ? (elle restera rejoignable via le bandeau si elle n’est pas arrêtée pour tous)',
        en: 'A video call is already open elsewhere. Leave it to open one here? (Others can still rejoin unless it was ended for everyone)',
      });
      if (!window.confirm(msg)) return;
      // Leave only — do not end-for-all just because the user starts another buffer's visio.
      leaveConference(orbit, conf.buffer);
    }

    function go(room, sid, asStarter, announceForce) {
      room = String(room || '').replace(/[^A-Za-z0-9._-]/g, '');
      if (!room) {
        orbit.notify('Visio', 'Impossible de déterminer la salle visio.');
        return;
      }
      var useSid = sid || (live && live.sid) || (asStarter ? newSessionId() : '');
      bindQueryRoom(buffer, room, useSid, asStarter ? (orbit.state.nick() || '') : ((live && live.nick) || ''));
      if (asStarter) markLiveVisio(buffer, orbit.state.nick() || '', room, useSid, { starter: true });
      setConf(buffer, room, { startedByMe: !!asStarter });
      if (asStarter) {
        announceConference(orbit, buffer, announceForce ? { force: true } : {});
        startVisioHeartbeat(orbit);
        sendVisioHeartbeat(orbit, buffer);
      } else {
        markLiveVisio(buffer, (getInviteFor(buffer) && getInviteFor(buffer).nick) || (live && live.nick) || '', room, useSid);
      }
      startIdleWatch(orbit);
      syncAwayClass(orbit);
      bumpIdleActivity();
      orbit.emit(EVT_SHOW, { buffer: buffer });
    }

    if (opts.joinOnly) {
      var joinRoom = (live && live.room) || (channelRooms[key] && channelRooms[key].name) || '';
      if (!joinRoom && !isChannelName(buffer)) joinRoom = queryMeetRoomId(orbit, buffer);
      if (!joinRoom) joinRoom = meetRoomFor(orbit, buffer);
      go(joinRoom, (live && live.sid) || (getInviteFor(buffer) && getInviteFor(buffer).sid) || '', false, false);
      return;
    }

    // Fresh start: WHO peer account first so Privee-<acct1>-<acct2> is stable.
    // Re-check live invite after WHO — peer may have announced during the wait.
    var prep = Promise.resolve();
    if (!isChannelName(buffer)) {
      prep = refreshBufferAccounts(orbit, buffer).catch(function () { return null; });
    }
    prep.then(function () {
      var live2 = liveVisio[key];
      var inv2 = getInviteFor(buffer);
      if (!opts.forceNew && ((live2 && live2.room) || inv2)) {
        var joinR = (live2 && live2.room)
          || (channelRooms[key] && channelRooms[key].name)
          || (!isChannelName(buffer) ? queryMeetRoomId(orbit, buffer) : '')
          || meetRoomFor(orbit, buffer);
        if (!isChannelName(buffer)) {
          go(joinR, (live2 && live2.sid) || (inv2 && inv2.sid) || '', false, false);
          return;
        }
        // Channel: reopen the same room and re-broadcast the invite banner.
        go(joinR, (live2 && live2.sid) || (inv2 && inv2.sid) || newSessionId(), true, true);
        return;
      }
      var room = isChannelName(buffer)
        ? allocateMeetRoom(orbit, buffer, !!opts.newRoom)
        : queryMeetRoomId(orbit, buffer);
      go(room, newSessionId(), true, false);
    });
  }

  function useActiveBuffer(orbit) {
    return useSyncExternalStore(
      function (cb) {
        var off = orbit.on('buffer.active', cb);
        var id = window.setInterval(cb, 400);
        return function () { off(); window.clearInterval(id); };
      },
      function () { return orbit.state.active(); },
      function () { return orbit.state.active(); }
    );
  }

  function CameraIcon() {
    return h('svg', {
      viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none',
      stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, h('path', { d: 'M15.5 10.5 20 8v8l-4.5-2.5' }), h('rect', { x: 3, y: 7, width: 12.5, height: 10, rx: 2.2 }));
  }

  function WarningTriIcon() {
    return h('svg', {
      viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
      stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z' }),
      h('path', { d: 'M12 9v4' }),
      h('path', { d: 'M12 17h.01' })
    );
  }

  function awayBufferLabel(buffer) {
    var name = String(buffer || '').trim();
    if (!name) return '';
    if (isChannelName(name)) return name.charAt(0) === '#' ? name : ('#' + name);
    return name;
  }

  function HeaderButton(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var hasInvite = !!getInviteFor(activeBuf) || !!liveVisio[inviteKey(activeBuf)];
    if (!bufferAllowed(orbit, activeBuf) && !openBuf) return null;
    // Hide if cannot start and there is no invite to join (unless a visio is open elsewhere).
    if (!openBuf && !canStart(orbit, activeBuf).ok && !hasInvite) return null;
    if (!openBuf && !canJoin(orbit, activeBuf).ok) return null;
    var onHere = !!(openBuf && inviteKey(openBuf) === inviteKey(activeBuf));
    var onAway = !!(openBuf && !onHere);
    var iAmStarter = onHere && !!conf.startedByMe;
    // Menu camera stays a local open/close/join control — away return is the floating alert.
    var tip = iAmStarter
      ? orbit.i18n.pick({ fr: 'Arrêter la visio pour tous', en: 'End video for everyone' })
      : (hasInvite
        ? orbit.i18n.pick({ fr: 'Rejoindre la visio', en: 'Join video call' })
        : orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }));
    return h('span', { className: 'oconf-cam-wrap' },
      h('button', {
        type: 'button',
        className: 'topbar__search' + (onHere ? ' is-on' : ''),
        'aria-label': tip,
        'aria-pressed': onHere,
        onClick: function () {
          if (onHere) closeVisioPanel(orbit, activeBuf);
          else if (onAway) {
            if (!bufferAllowed(orbit, activeBuf)) {
              focusVisioBuffer(orbit, openBuf);
              return;
            }
            var liveHere = !!liveVisio[inviteKey(activeBuf)] || !!getInviteFor(activeBuf);
            openConference(orbit, activeBuf, { joinOnly: liveHere });
          } else {
            var live = !!liveVisio[inviteKey(activeBuf)] || !!getInviteFor(activeBuf);
            openConference(orbit, activeBuf, { joinOnly: live });
          }
        },
      }, h(CameraIcon)),
      h('span', { className: 'oconf-cam-tip', role: 'tooltip' }, tip)
    );
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var hasInvite = !!getInviteFor(activeBuf) || !!liveVisio[inviteKey(activeBuf)];
    var cfg = confCfg(orbit);
    if (!bufferAllowed(orbit, activeBuf) && !openBuf) return null;
    if (!openBuf && !canStart(orbit, activeBuf).ok && !hasInvite) return null;
    var joinGate = canJoin(orbit, activeBuf);
    if (!openBuf && !joinGate.ok && !hasInvite) return null;
    var needsRegister = !!(requireAccountFor(cfg, activeBuf) && !orbit.state.account());
    var registerUrl = (orbit.config().branding && orbit.config().branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
    var onHere = !!(openBuf && inviteKey(openBuf) === inviteKey(activeBuf));
    var onAway = !!(openBuf && !onHere);
    var label = onHere
      ? (conf.startedByMe
        ? orbit.i18n.pick({ fr: 'Arrêter la visio pour tous', en: 'End video for everyone' })
        : orbit.i18n.pick({ fr: 'Quitter la visio', en: 'Leave video' }))
      : (onAway
        ? orbit.i18n.pick({ fr: 'Visio ici (autre en cours)', en: 'Video here (another active)' })
        : (hasInvite
          ? (needsRegister
            ? orbit.i18n.pick({ fr: 'S’enregistrer pour la visio', en: 'Register to join video' })
            : orbit.i18n.pick({ fr: 'Rejoindre la visio', en: 'Join video call' }))
          : orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' })));
    return h('button', {
      type: 'button',
      className: 'nmenu__item' + (!onHere && !onAway && hasInvite && !joinGate.ok && !needsRegister ? ' is-disabled' : ''),
      role: 'menuitem',
      disabled: !onHere && !onAway && hasInvite && !joinGate.ok && !needsRegister,
      title: !onHere && !onAway && hasInvite && !joinGate.ok ? joinGate.reason : undefined,
      onClick: function () {
        if (onHere) {
          if (conf.startedByMe) {
            if (!window.confirm(orbit.i18n.pick({
              fr: 'Arrêter la visio pour tout le salon ?',
              en: 'End the video call for everyone in the channel?',
            }))) return;
          }
          closeVisioPanel(orbit, activeBuf);
        }
        else if (onAway) {
          if (!bufferAllowed(orbit, activeBuf)) {
            focusVisioBuffer(orbit, openBuf);
            return;
          }
          var liveAway = !!liveVisio[inviteKey(activeBuf)] || !!getInviteFor(activeBuf);
          openConference(orbit, activeBuf, { joinOnly: liveAway });
        }
        else if (hasInvite && !joinGate.ok && needsRegister) window.open(registerUrl, '_blank', 'noopener');
        else {
          var liveM = !!liveVisio[inviteKey(activeBuf)] || !!getInviteFor(activeBuf);
          openConference(orbit, activeBuf, { joinOnly: liveM });
        }
      },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(CameraIcon)),
      h('span', { className: 'nmenu__txt' }, h('b', null, label))
    );
  }

  function MoreMenuEndItem(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var live = !!liveVisio[inviteKey(activeBuf)];
    var on = openBuf === activeBuf;
    if (!bufferAllowed(orbit, activeBuf)) return null;
    if (!live && !on) return null;
    if (!canStart(orbit, activeBuf).ok) return null;
    // Only the current starter (or an op who can start) may end for everyone while live.
    if (on && !conf.startedByMe && !canStart(orbit, activeBuf).ok) return null;
    return h('button', {
      type: 'button',
      className: 'nmenu__item',
      role: 'menuitem',
      onClick: function () {
        if (!window.confirm(orbit.i18n.pick({
          fr: 'Arrêter la visio pour tout le salon ?',
          en: 'End the video call for everyone in the channel?',
        }))) return;
        endConference(orbit, activeBuf);
      },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, '⏹'),
      h('span', { className: 'nmenu__txt' }, h('b', null, orbit.i18n.pick({
        fr: 'Arrêter la visio pour tous',
        en: 'End video for everyone',
      })))
    );
  }

  /** True only while local Jitsi is open and the user is on another buffer. */
  function isAwayFromOpenVisio(activeBuf) {
    if (!conf.active || !conf.buffer) return false;
    if (!activeBuf) return true;
    return inviteKey(activeBuf) !== inviteKey(conf.buffer);
  }

  function AwayVisioBanner(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    // Re-subscribe so the alert mounts/unmounts with conf open/close.
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    // Alert only — never a permanent topbar icon.
    if (!isAwayFromOpenVisio(activeBuf) || !openBuf) return null;
    var label = awayBufferLabel(openBuf);
    var tip = orbit.i18n.pick({
      fr: isChannelName(openBuf)
        ? ('Visio toujours en cours sur le salon ' + label + ' — cliquez pour y accéder')
        : ('Visio toujours en cours avec ' + label + ' — cliquez pour y accéder'),
      en: isChannelName(openBuf)
        ? ('Video call still active on ' + label + ' — click to open it')
        : ('Video call still active with ' + label + ' — click to open it'),
    });
    return h('span', { className: 'oconf-away-wrap' },
      h('button', {
        type: 'button',
        className: 'oconf-away-alert',
        'aria-label': tip,
        title: tip,
        onClick: function () { focusVisioBuffer(orbit, openBuf); },
      }, h(CameraIcon)),
      h('span', { className: 'oconf-away-alert__tip', role: 'tooltip' },
        h('span', { className: 'oconf-away-alert__warn', 'aria-hidden': true }, h(WarningTriIcon)),
        h('span', null, tip)
      )
    );
  }

  function InviteBanner(props) {
    var orbit = props.orbit;
    var bufFromProp = props.buffer || null;
    var activeBuf = bufFromProp || useActiveBuffer(orbit);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    useSyncExternalStore(subscribeStoppedNote, getStoppedNoteSnap, getStoppedNoteSnap);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    expireStaleInvites(orbit);
    var stopped = getStoppedNoteFor(activeBuf);

    if (stopped !== null && !openBuf) {
      return h('div', { className: 'oconf-invite oconf-invite--stopped' },
        h('span', { className: 'oconf-invite__txt' },
          (stopped ? stopped + ' ' : '') + orbit.i18n.pick({ fr: 'a arr\u00eat\u00e9 la visio.', en: 'ended the video call.' })
        ),
        h('button', {
          type: 'button',
          className: 'oconf-invite__dismiss',
          'aria-label': orbit.i18n.pick({ fr: 'Fermer', en: 'Close' }),
          onClick: function () { setStoppedNote(activeBuf, null); },
        }, '\u2715')
      );
    }

    var inv = getInviteFor(activeBuf);
    var live = liveVisio[inviteKey(activeBuf)];
    if (!inv && live && !openBuf) {
      inv = { nick: live.nick || '', link: publicLink(orbit, activeBuf) };
    }
    if (!inv || openBuf) return null;
    if (dismissed[inviteKey(activeBuf)]) return null;
    var joinGate = canJoin(orbit, activeBuf);
    var cfg = confCfg(orbit);
    var needsRegister = !!(requireAccountFor(cfg, activeBuf) && !orbit.state.account());
    var registerUrl = (orbit.config().branding && orbit.config().branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
    var joinLabel = (cfg.joinButtonText || 'Rejoindre');
    if (/^rejoindre$/i.test(joinLabel)) joinLabel = 'Rejoindre la visio';
    var me = (orbit.state.nick && orbit.state.nick()) || '';
    var selfLive = me && inv.nick && String(inv.nick).toLowerCase() === String(me).toLowerCase();
    var isQuery = !isChannelName(activeBuf);
    var acceptLabel = selfLive
      ? orbit.i18n.pick({ fr: 'Reconnecter', en: 'Rejoin' })
      : (isQuery
        ? orbit.i18n.pick({ fr: 'Accepter', en: 'Accept' })
        : joinLabel);
    return h('div', { className: 'oconf-invite' },
      h('span', { className: 'oconf-invite__txt' },
        selfLive
          ? orbit.i18n.pick({
            fr: 'Visio en cours — reconnectez-vous via ce bandeau ou l’icône caméra.',
            en: 'Video call in progress — rejoin via this banner or the camera icon.',
          })
          : (isQuery
            ? ((inv.nick || 'Quelqu\u2019un') + ' ' + orbit.i18n.pick({
              fr: 'vous invite en visio.',
              en: 'invites you to a video call.',
            }) + (!joinGate.ok ? (' ' + (needsRegister
              ? orbit.i18n.pick({ fr: 'Inscrivez-vous pour accepter.', en: 'Register to accept.' })
              : joinGate.reason)) : ''))
            : ((inv.nick || 'Quelqu\u2019un') + ' ' + orbit.i18n.pick({ fr: 'a lanc\u00e9 une visio.', en: 'started a video call.' })
              + (!joinGate.ok ? (' ' + orbit.i18n.pick({
                fr: needsRegister ? 'Inscrivez-vous pour rejoindre la visio. ' : 'Acc\u00e8s impossible : ',
                en: needsRegister ? 'Register to join the video call. ' : 'Cannot join: ',
              }) + (needsRegister ? '' : joinGate.reason)) : '')))
      ),
      (needsRegister
        ? h('a', {
          className: 'oconf-invite__btn',
          href: registerUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, orbit.i18n.pick({ fr: 'S’inscrire', en: 'Register' }))
        : h('button', {
          type: 'button',
          className: 'oconf-invite__btn' + (!joinGate.ok ? ' is-disabled' : ''),
          disabled: !joinGate.ok,
          title: !joinGate.ok ? joinGate.reason : undefined,
          onClick: function () { openConference(orbit, activeBuf, { joinOnly: true }); },
        }, '\uD83D\uDCF9 ' + (!joinGate.ok
          ? orbit.i18n.pick({ fr: 'Acc\u00e8s refus\u00e9', en: 'Access denied' })
          : acceptLabel))),
      (!selfLive && isQuery && joinGate.ok
        ? h('button', {
          type: 'button',
          className: 'oconf-invite__btn oconf-invite__btn--refuse',
          onClick: function () { refuseConference(orbit, activeBuf); },
        }, orbit.i18n.pick({ fr: 'Refuser', en: 'Decline' }))
        : null),
      h('button', {
        type: 'button',
        className: 'oconf-invite__dismiss',
        'aria-label': orbit.i18n.pick({ fr: 'Ignorer', en: 'Dismiss' }),
        title: orbit.i18n.pick({
          fr: selfLive ? 'Masquer le bandeau (la visio reste active)' : 'Ignorer pour le moment',
          en: selfLive ? 'Hide banner (call stays active)' : 'Dismiss for now',
        }),
        onClick: function () {
          dismissed[inviteKey(activeBuf)] = true;
          setInvite(activeBuf, null);
        },
      }, '\u2715')
    );
  }
  function JoinCard(props) {
    // Kept for non-hidden mode; with hideInviteForOrbit the banner replaces this.
    var orbit = props.orbit;
    var m = props.m;
    var cfg = confCfg(orbit);
    if (cfg.hideInviteForOrbit) return null;
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    var buf = m.buffer || orbit.state.active();
    if (openBuf) return null;
    if (!bufferAllowed(orbit, buf)) return null;
    return h('span', { className: 'oconf-join' },
      h('button', {
        type: 'button',
        className: 'oconf-join__btn',
        onClick: function () { openConference(orbit, buf, { joinOnly: true }); },
      }, '📹 ' + (cfg.joinButtonText || 'Rejoindre'))
    );
  }

  function JitsiPanel(props) {
    var orbit = props.orbit;
    var buffer = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    var activeBuf = useActiveBuffer(orbit);
    var hostRef = useRef(null);
    var apiRef = useRef(null);
    var panelRef = useRef(null);
    var joinedState = useState(false);
    var joined = joinedState[0];
    var setJoined = joinedState[1];
    var errState = useState('');
    var err = errState[0];
    var setErr = errState[1];
    var heightState = useState(function () {
      try {
        var narrow = window.matchMedia && window.matchMedia(NARROW).matches;
        var v = orbit.storage.get(narrow ? HEIGHT_KEY_MOBILE : HEIGHT_KEY);
        var minH = narrow ? 120 : 180;
        var maxH = narrow ? 700 : 900;
        if (typeof v === 'number' && v >= minH && v <= maxH) return v;
      } catch (e) { /* ignore */ }
      return null;
    });
    var heightPx = heightState[0];
    var setHeightPx = heightState[1];
    var cfg = confCfg(orbit);

    useEffect(function () {
      if (!buffer || !hostRef.current) return;
      var cancelled = false;
      var host = hostRef.current;
      host.innerHTML = '';
      setJoined(false);
      setErr('');
      try {
        host.addEventListener('pointerdown', bumpIdleActivity);
        host.addEventListener('keydown', bumpIdleActivity);
      } catch (eHost) { /* ignore */ }

      var live = confCfg(orbit);
      var domain = live.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
      var isQuery = !isChannelName(buffer);
      var room = (conf.active && inviteKey(conf.buffer) === inviteKey(buffer) && conf.room)
        ? conf.room
        : meetRoomFor(orbit, buffer);
      var displayIdent = jitsiDisplayName(orbit);
      var myIdentKey = normalizeJitsiIdent(displayIdent);
      var maxP = isQuery ? 2 : maxParticipantsFor(live, buffer);
      var timers = [];

      function mountApi(jwt) {
        if (cancelled || !host) return;
        if (!window.JitsiMeetExternalAPI) {
          setErr(orbit.i18n.pick({
            fr: 'Impossible de charger l’API Jitsi.',
            en: 'Unable to load the Jitsi API.',
          }));
          return;
        }
        try {
          if (apiRef.current) {
            try { apiRef.current.dispose(); } catch (eDisp) { /* ignore */ }
            apiRef.current = null;
          }
          var cfgOver = {
            startWithAudioMuted: true,
            startWithVideoMuted: true,
            prejoinConfig: { enabled: false },
            prejoinPageEnabled: false,
            disableDeepLinking: true,
            bosh: 'https://' + domain + '/http-bind',
            websocket: 'wss://' + domain + '/xmpp-websocket',
            maxParticipants: maxP || undefined,
            disableInviteFunctions: true,
            enableWelcomePage: false,
            enableClosePage: false,
            disableProfile: true,
            readOnlyName: true,
          };
          var toolbar = [
            'microphone', 'camera', 'fullscreen', 'hangup',
            'settings', 'videoquality', 'filmstrip', 'fodeviceselection',
          ];
          if (isQuery) {
            // Private 1:1 — hard cap 2, hide invite/share, prefer P2P.
            cfgOver.maxParticipants = 2;
            cfgOver.p2p = { enabled: true };
            cfgOver.toolbarButtons = toolbar;
            // Kick kept available via API to drop duplicate account clones.
            cfgOver.remoteVideoMenu = { disableGrantModerator: true };
          } else {
            toolbar.push('stats', 'shortcuts');
          }
          var api = new window.JitsiMeetExternalAPI(domain, {
            roomName: room,
            parentNode: host,
            width: '100%',
            height: '100%',
            jwt: jwt || undefined,
            userInfo: { displayName: displayIdent },
            configOverwrite: cfgOver,
            interfaceConfigOverwrite: {
              SHOW_JITSI_WATERMARK: false,
              SHOW_WATERMARK_FOR_GUESTS: false,
              TOOLBAR_BUTTONS: toolbar,
              DISABLE_JOIN_LEAVE_NOTIFICATIONS: !!isQuery,
              HIDE_INVITE_MORE_HEADER: true,
            },
          });
          apiRef.current = api;
          bumpIdleActivity();
          var myParticipantId = '';
          try { api.executeCommand('displayName', displayIdent); } catch (e) { /* ignore */ }
          try { api.executeCommand('subject', roomNameFor(orbit, buffer)); } catch (e2) { /* ignore */ }

          function collectNameDupes() {
            var out = [];
            try {
              (api.getParticipantsInfo() || []).forEach(function (p) {
                if (!p) return;
                var id = String(p.participantId || p.id || '');
                if (myParticipantId && id && id === myParticipantId) return;
                var dn = normalizeJitsiIdent(p.displayName || '');
                var ctx = '';
                try { ctx = normalizeJitsiIdent((p.userContext && p.userContext.id) || ''); } catch (eC) { /* ignore */ }
                if ((dn && dn === myIdentKey) || (ctx && ctx === myIdentKey)) out.push(p);
              });
            } catch (eI) { /* ignore */ }
            return out;
          }

          function enforceUniqueIdentity(opts) {
            if (cancelled || !apiRef.current) return;
            var leaveIfStuck = !!(opts && opts.leaveIfStuck);
            var dupes = collectNameDupes();
            if (!dupes.length) return;
            var attempted = 0;
            dupes.forEach(function (p) {
              var id = String(p.participantId || p.id || '');
              if (!id) return;
              try { api.executeCommand('kickParticipant', id); attempted++; } catch (eK) { /* ignore */ }
            });
            if (attempted > 0 && !leaveIfStuck) {
              try {
                orbit.notify('Visio', orbit.i18n.pick({
                  fr: 'Doublon « ' + displayIdent + ' » déconnecté (un seul compte par salle).',
                  en: 'Duplicate “' + displayIdent + '” disconnected (one account per room).',
                }));
              } catch (eN) { /* ignore */ }
            }
            if (!leaveIfStuck) return;
            // Verify after Prosody processes the kick; hang up if the name is still taken.
            window.setTimeout(function () {
              if (cancelled || !apiRef.current) return;
              if (!collectNameDupes().length) return;
              setErr(orbit.i18n.pick({
                fr: 'Ce compte (« ' + displayIdent + ' ») est déjà dans la visio.',
                en: 'This account (“' + displayIdent + '”) is already in the video call.',
              }));
              orbit.notify('Visio', orbit.i18n.pick({
                fr: 'Connexion refusée : ce compte est déjà présent dans la salle.',
                en: 'Join refused: this account is already in the room.',
              }));
              try { api.executeCommand('hangup'); } catch (eH) { /* ignore */ }
            }, 900);
          }

          function onJitsiActivity() { bumpIdleActivity(); }
          ['audioMuteStatusChanged', 'videoMuteStatusChanged', 'participantJoined',
            'participantLeft', 'raiseHandUpdated', 'tileViewChanged', 'filmstripDisplayChanged',
            'chatUpdated', 'notificationTriggered'].forEach(function (evName) {
            try { api.addListener(evName, onJitsiActivity); } catch (eL) { /* ignore */ }
          });
          api.addListener('connectionFailed', function () {
            if (!cancelled) setErr(orbit.i18n.pick({
              fr: 'Connexion Meet impossible (WebSocket/XMPP).',
              en: 'Meet connection failed (WebSocket/XMPP).',
            }));
          });
          api.addListener('errorOccurred', function (ev) {
            if (cancelled) return;
            var blob = JSON.stringify(ev || {}).toLowerCase();
            if (/max|full|participants|conference_max_users/.test(blob)) {
              setErr(orbit.i18n.pick({
                fr: isQuery
                  ? 'Cette visio privée est limitée à 2 personnes.'
                  : 'La visio a atteint sa limite de participants.',
                en: isQuery
                  ? 'This private video call is limited to 2 people.'
                  : 'The conference reached its participant limit.',
              }));
              orbit.notify('Visio', orbit.i18n.pick({
                fr: isQuery
                  ? 'Visio MP limitée à 2 — pour plus, ouvrez une visio salon.'
                  : 'La visio est complète pour le moment.',
                en: isQuery
                  ? 'Query visio is limited to 2 — use a channel visio for more.'
                  : 'The conference is full right now.',
              }));
            }
          });
          if (isQuery) {
            api.addListener('participantJoined', function (ev) {
              if (cancelled || !apiRef.current) return;
              bumpIdleActivity();
              var joinedName = normalizeJitsiIdent((ev && ev.displayName) || '');
              if (!joinedName || joinedName === myIdentKey) {
                window.setTimeout(enforceUniqueIdentity, 200);
              }
              var n = 0;
              try { n = apiRef.current.getNumberOfParticipants(); } catch (eN) { n = 0; }
              if (n > 2) {
                setErr(orbit.i18n.pick({
                  fr: 'Visio MP limitée à 2 personnes. Utilisez une visio salon pour plus.',
                  en: 'Query visio is limited to 2. Use a channel visio for more.',
                }));
                orbit.notify('Visio', orbit.i18n.pick({
                  fr: 'Visio MP pleine (2 max). Ouvrez une visio salon pour plus de monde.',
                  en: 'Query visio full (max 2). Open a channel visio for more people.',
                }));
                try { apiRef.current.executeCommand('hangup'); } catch (eH) { /* ignore */ }
              }
            });
          } else {
            api.addListener('participantJoined', function (ev) {
              if (cancelled || !apiRef.current) return;
              bumpIdleActivity();
              var joinedName = normalizeJitsiIdent((ev && ev.displayName) || '');
              if (!joinedName || joinedName === myIdentKey) {
                window.setTimeout(enforceUniqueIdentity, 200);
              }
            });
          }
          api.addListener('displayNameChange', function () {
            if (cancelled) return;
            try { api.executeCommand('displayName', displayIdent); } catch (eDn) { /* ignore */ }
            window.setTimeout(enforceUniqueIdentity, 100);
          });
          var didJoin = false;
          function onJoined(ev) {
            if (cancelled || didJoin) return;
            didJoin = true;
            myParticipantId = String((ev && ev.id) || '');
            setJoined(true);
            setErr('');
            bumpIdleActivity();
            startIdleWatch(orbit);
            try { api.executeCommand('displayName', displayIdent); } catch (e3) { /* ignore */ }
            window.setTimeout(function () { enforceUniqueIdentity({ leaveIfStuck: true }); }, 400);
            window.setTimeout(function () { enforceUniqueIdentity({ leaveIfStuck: true }); }, 1500);
          }
          api.addListener('videoConferenceJoined', onJoined);
          // Title-only fallback if Meet never emits the join event.
          timers.push(window.setTimeout(function () {
            if (!cancelled && !didJoin) setJoined(true);
          }, 12000));
          api.addListener('readyToClose', function () {
            if (cancelled) return;
            closeVisioPanel(orbit, buffer);
          });
          api.addListener('videoConferenceLeft', function () {
            if (cancelled) return;
            if (isEndingSession(buffer)) {
              setConf(null);
              return;
            }
            // Hangup / leave Meet: starter ends for everyone; others keep the blue banner.
            closeVisioPanel(orbit, buffer);
          });
        } catch (e) {
          setErr(String(e));
        }
      }

      var tokenReady = live.secure
        ? requestConferenceJwt(orbit, buffer, room)
        : Promise.resolve('');
      function withJwtRetry(p) {
        return p.catch(function (e) {
          var code = String((e && e.message) || e || '');
          if (code !== 'jwt_timeout' && code !== 'no_such_target') throw e;
          if (cancelled) throw e;
          setErr(orbit.i18n.pick({
            fr: 'Connexion sécurisée en cours (nouvelle tentative)…',
            en: 'Secure connect in progress (retrying)…',
          }));
          // Drop stale cache / inflight so the retry issues a fresh EXTJWT.
          try {
            var tk = (isChannelName(buffer) ? buffer : '*').toLowerCase();
            delete jwtCache[tk];
            delete jwtInflight[tk];
          } catch (e2) { /* ignore */ }
          return delayMs(700).then(function () {
            if (cancelled) return Promise.reject(e);
            return requestConferenceJwt(orbit, buffer, room);
          });
        });
      }
      Promise.all([
        live.secure ? withJwtRetry(tokenReady) : tokenReady,
        loadJitsiApi(domain),
      ]).then(function (pair) {
        if (!cancelled) {
          setErr('');
          mountApi(live.secure ? pair[0] : undefined);
        }
      }).catch(function (e) {
        if (cancelled) return;
        var code = String((e && e.message) || e || '');
        setErr(({
          extjwt_unsupported: orbit.i18n.pick({
            fr: 'Ton serveur IRC ne supporte pas EXTJWT pour vérifier ton identité.',
            en: 'Your IRC server does not support EXTJWT identity proof.',
          }),
          jwt_timeout: orbit.i18n.pick({
            fr: 'Le serveur IRC n’a pas répondu à temps à la demande EXTJWT. Réessaie dans une seconde.',
            en: 'The IRC server did not answer the EXTJWT request in time. Try again in a moment.',
          }),
          no_such_target: orbit.i18n.pick({
            fr: 'Pas encore bien présent dans le salon — réessaie la visio dans une seconde.',
            en: 'Not fully joined yet — try the video call again in a moment.',
          }),
          invalid_extjwt: orbit.i18n.pick({
            fr: 'La preuve EXTJWT a été refusée par le service visio.',
            en: 'The EXTJWT proof was rejected by the conference service.',
          }),
          extjwt_expired: orbit.i18n.pick({
            fr: 'La preuve IRC a expiré — ferme et rouvre la visio.',
            en: 'The IRC proof expired — close and reopen the video call.',
          }),
          account_required: orbit.i18n.pick({
            fr: 'Un compte IRC enregistré est requis pour la visio sécurisée.',
            en: 'A registered IRC account is required for secure conference access.',
          }),
          server_not_configured: orbit.i18n.pick({
            fr: 'Le service visio sécurisé n’est pas encore configuré côté serveur.',
            en: 'The secure conference service is not configured yet on the server.',
          }),
          jitsi_script: orbit.i18n.pick({
            fr: 'Impossible de charger Jitsi (' + domain + ').',
            en: 'Unable to load Jitsi (' + domain + ').',
          }),
        })[code] || (live.secure ? ('Visio sécurisée: ' + code) : String(code)));
      });

      return function () {
        cancelled = true;
        timers.forEach(window.clearTimeout);
        if (apiRef.current) {
          try { apiRef.current.executeCommand('hangup'); } catch (eHang) { /* ignore */ }
          try { apiRef.current.dispose(); } catch (eDisp) { /* ignore */ }
          apiRef.current = null;
        }
      };
    }, [buffer]);

    function isNarrow() {
      return !!(window.matchMedia && window.matchMedia(NARROW).matches);
    }
    function clampPanelH(h, narrow) {
      var minH = narrow ? 120 : 180;
      var maxH = Math.round(window.innerHeight * (narrow ? 0.5 : 0.7));
      return Math.max(minH, Math.min(maxH, h));
    }
    function pointerY(e) {
      if (e.touches && e.touches[0]) return e.touches[0].clientY;
      if (e.changedTouches && e.changedTouches[0]) return e.changedTouches[0].clientY;
      return e.clientY;
    }

    function onResizeStart(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var panel = panelRef.current;
      if (!panel) return;
      var narrow = isNarrow();
      var startY = pointerY(ev);
      var startH = panel.getBoundingClientRect().height || (narrow ? 200 : 320);
      var iframe = panel.querySelector('iframe');
      var lastH = startH;
      var raf = 0;
      panel.classList.add('is-resizing');
      if (iframe) iframe.style.pointerEvents = 'none';
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.body.style.touchAction = 'none';

      function apply(h) {
        lastH = h;
        panel.style.height = h + 'px';
        panel.style.maxHeight = narrow ? '50vh' : '70vh';
      }

      function move(e) {
        if (e.cancelable) e.preventDefault();
        var nh = clampPanelH(Math.round(startH + (pointerY(e) - startY)), narrow);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { apply(nh); });
      }

      function up() {
        if (raf) cancelAnimationFrame(raf);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        document.removeEventListener('touchcancel', up);
        document.removeEventListener('blur', up);
        panel.classList.remove('is-resizing');
        if (iframe) iframe.style.pointerEvents = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.style.touchAction = '';
        var finalH = clampPanelH(Math.round(lastH), narrow);
        setHeightPx(finalH);
        try { orbit.storage.set(narrow ? HEIGHT_KEY_MOBILE : HEIGHT_KEY, finalH); } catch (err) { /* ignore */ }
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', up);
      document.addEventListener('touchcancel', up);
      document.addEventListener('blur', up);
    }

    if (!buffer) {
      return null;
    }

    var onVisioBuf = inviteKey(activeBuf) === inviteKey(buffer);
    var narrow = isNarrow();
    var style = heightPx
      ? { height: heightPx + 'px', maxHeight: narrow ? '50vh' : '70vh' }
      : { height: narrow ? cfg.viewHeightMobile : cfg.viewHeight };

    // Keep Jitsi mounted off-screen when browsing another salon so the call
    // continues, but the panel is only visible on the visio's own buffer.
    return h(React.Fragment, null,
      h('div', {
        className: 'oconf-panel' + (onVisioBuf ? '' : ' oconf-panel--detached'),
        style: style,
        ref: panelRef,
        'aria-hidden': onVisioBuf ? undefined : true,
      },
        h('div', { className: 'oconf-panel__bar' },
          h('strong', { className: 'oconf-panel__title' },
            joined
              ? (orbit.i18n.pick({ fr: 'Visio', en: 'Video' }) + ' · ' + roomNameFor(orbit, buffer))
              : orbit.i18n.pick({ fr: 'Connexion…', en: 'Connecting…' })
          ),
          h('button', {
            type: 'button',
            className: 'oconf-panel__close',
            'aria-label': 'Close',
            onClick: function () {
              closeVisioPanel(orbit, buffer);
            },
          }, '✕')
        ),
        err ? h('div', { className: 'oconf-panel__err' }, err) : null,
        h('div', { className: 'oconf-panel__stage' },
          (!joined && !err) ? h('div', { className: 'oconf-splash', role: 'status' },
            (((orbit.config().branding) || {}).icon)
              ? h('img', { className: 'oconf-splash__logo', src: orbit.config().branding.icon, alt: '' })
              : null,
            h('div', { className: 'oconf-splash__spin' }),
            h('div', { className: 'oconf-splash__txt' }, orbit.i18n.pick({
              fr: 'Connexion à la visio…',
              en: 'Connecting to video…',
            }))
          ) : null,
          h('div', { className: 'oconf-panel__host', ref: hostRef })
        ),
        h('div', {
          className: 'oconf-panel__resize',
          title: orbit.i18n.pick({ fr: 'Glisser pour redimensionner', en: 'Drag to resize' }),
          onMouseDown: onResizeStart,
          onTouchStart: onResizeStart,
        })
      )
    );
  }

  function injectStyles() {
    if (document.getElementById('orbit-conference-css')) return;
    var el = document.createElement('style');
    el.id = 'orbit-conference-css';
    el.textContent = [
      '.oconf-panel{position:relative;left:auto;right:auto;top:auto;z-index:20;flex:0 0 auto;width:100%;min-height:200px;max-height:70vh;display:flex;flex-direction:column;background:var(--bg,#111);border-bottom:1px solid var(--border,#333);box-shadow:0 8px 28px -16px rgba(0,0,0,.45)}',
      '@media (max-width:880px){.oconf-panel{max-height:50vh;min-height:120px}.oconf-panel__resize{height:18px;display:flex;align-items:center;justify-content:center}.oconf-panel__resize::after{content:"";width:42px;height:4px;border-radius:99px;background:rgba(127,127,127,.55)}}',
      '.oconf-panel__bar{flex:none;display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;background:var(--bg-soft,rgba(127,127,127,.08))}',
      '.oconf-panel__title{font-size:.85rem;font-weight:700;color:var(--ink)}',
      '.oconf-panel__close{margin-left:auto;border:0;background:transparent;color:var(--muted);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:1rem}',
      '.oconf-panel__close:hover{background:var(--bg-soft-2,rgba(127,127,127,.14));color:var(--ink)}',
      '.oconf-panel__err{padding:.5rem .75rem;color:#b91c1c;font-size:.85rem}',
      '.oconf-panel__stage{position:relative;flex:1;min-height:0;background:#0b0b0b}',
      '.oconf-panel__host{position:absolute;inset:0;z-index:1}',
      '.oconf-panel__host>div,.oconf-panel__host iframe{width:100%!important;height:100%!important}',
      '.oconf-splash{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.7rem;background:#0b0b0b;color:#e5e7eb;pointer-events:none}',
      '.oconf-splash__logo{width:52px;height:52px;object-fit:contain;border-radius:14px}',
      '.oconf-splash__spin{width:34px;height:34px;border:3px solid rgba(255,255,255,.18);border-top-color:#fff;border-radius:50%;animation:oconfSpin .75s linear infinite}',
      '.oconf-splash__txt{font-size:.82rem;font-weight:700;letter-spacing:.02em;opacity:.92}',
      '@keyframes oconfSpin{to{transform:rotate(360deg)}}',
      '.oconf-panel__resize{flex:none;height:10px;cursor:ns-resize;background:linear-gradient(to bottom,transparent,rgba(127,127,127,.28));touch-action:none;position:relative;z-index:2}',
      '.oconf-panel__resize:hover,.oconf-panel__resize:active{background:rgba(127,127,127,.35)}',
      '.oconf-panel.is-resizing iframe{pointer-events:none!important}',
      /* Shrink topic banner while video is open so chat keeps vertical space. */
      'body.oconf-open .chan-hero{grid-template-columns:40px 1fr;padding:.22rem .7rem;gap:.45rem;min-height:0}',
      'body.oconf-open .chan-hero__media{width:40px;height:40px;min-height:40px;border-radius:9px}',
      'body.oconf-open .chan-hero__topic{-webkit-line-clamp:1;font-size:.72rem;line-height:1.25}',
      'body.oconf-open .chan-hero__by,body.oconf-open .chan-hero__more{display:none}',
      'body.oconf-open .main__room-bg{height:min(22%,160px)!important}',
      '@media (max-width:880px){body.oconf-open .chan-hero{grid-template-columns:32px 1fr;padding:.15rem .45rem;gap:.35rem}body.oconf-open .chan-hero__media{width:32px;height:32px;min-height:32px;border-radius:8px}}',
      '.oconf-invite{flex:none;display:flex;align-items:center;gap:.7rem;padding:.52rem .85rem;border-bottom:1px solid #3b82f6;background:#1e3a8a;background:color-mix(in srgb,var(--accent,#2563eb) 24%,var(--bg,#111));box-shadow:inset 0 -1px 0 rgba(255,255,255,.06),0 8px 24px -18px rgba(37,99,235,.55);backdrop-filter:blur(3px)}',
      '.oconf-invite--stopped{background:color-mix(in srgb,#6b7280 20%,var(--bg,#111));border-bottom-color:color-mix(in srgb,#6b7280 35%,var(--border,#333));box-shadow:none}',
      '.oconf-invite--stopped .oconf-invite__txt{font-weight:600;opacity:.85}',
      '.oconf-invite__dismiss{flex:none;border:0;background:transparent;color:var(--muted,#888);width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:.95rem;display:flex;align-items:center;justify-content:center;margin-left:.1rem}',
      '.oconf-invite__dismiss:hover{background:rgba(127,127,127,.14);color:var(--ink)}',
      '.oconf-invite__txt{flex:1;min-width:0;font-size:.86rem;font-weight:800;color:#fff;color:var(--ink-strong,var(--ink));text-shadow:0 1px 0 rgba(255,255,255,.08)}',
      '.oconf-invite__btn{border:1px solid #93c5fd;border:1px solid color-mix(in srgb,var(--accent,#2563eb) 62%,white);cursor:pointer;font:inherit;font-size:.8rem;font-weight:800;padding:.38rem .82rem;border-radius:999px;background:#2563eb;background:linear-gradient(180deg,color-mix(in srgb,var(--accent,#2563eb) 92%,white),color-mix(in srgb,var(--accent,#2563eb) 74%,black 8%));color:#fff;box-shadow:0 0 0 0 rgba(37,99,235,.58),0 6px 18px -10px rgba(37,99,235,.75);animation:oconfInvitePulse 1.6s ease-out infinite;white-space:nowrap}',
      '.oconf-invite__btn:hover{filter:brightness(1.05);transform:translateY(-1px)}',
      '.oconf-invite__btn--refuse{background:linear-gradient(180deg,#6b7280,#4b5563);border-color:#9ca3af;animation:none;box-shadow:none}',
      '.oconf-invite__btn--refuse:hover{filter:brightness(1.08)}',
      '.oconf-invite__btn.is-disabled,.nmenu__item.is-disabled{opacity:.62;cursor:not-allowed;filter:none;transform:none}',
      '.oconf-invite__btn:focus-visible{outline:2px solid color-mix(in srgb,var(--accent,#2563eb) 75%,white);outline-offset:2px}',
      '@media (max-width:640px){.oconf-invite{flex-wrap:wrap;align-items:flex-start}.oconf-invite__txt{min-width:100%;margin-bottom:.15rem}.oconf-invite__btn{flex:1 1 auto;min-width:0;white-space:normal;text-align:center}.oconf-invite__dismiss{margin-left:auto}}',
      '@keyframes oconfInvitePulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.58),0 6px 18px -10px rgba(37,99,235,.75)}70%{box-shadow:0 0 0 10px rgba(37,99,235,0),0 8px 24px -12px rgba(37,99,235,.82)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0),0 6px 18px -10px rgba(37,99,235,.72)}}',
      '.oconf-join{display:inline-flex;margin-left:.45rem;vertical-align:middle}',
      '.oconf-join__btn{border:0;cursor:pointer;font:inherit;font-size:.78rem;font-weight:700;padding:.28rem .65rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#2563eb) 18%,transparent);color:var(--accent-d,var(--accent,#1d4ed8))}',
      '.topbar__search.is-on{background:var(--accent-soft,rgba(20,82,204,.14));color:var(--accent-d,var(--accent))}',
      '.oconf-cam-wrap{position:relative;display:inline-flex;align-items:center;vertical-align:middle}',
      '.oconf-cam-tip{position:absolute;top:calc(100% + 8px);right:0;z-index:95;min-width:200px;max-width:min(320px,70vw);padding:.55rem .7rem;border-radius:12px;background:#fff;color:#1c1917;font-size:.8rem;font-weight:650;line-height:1.35;text-align:left;box-shadow:0 12px 28px -10px rgba(0,0,0,.35);border:1px solid #d6d3d1;opacity:0;visibility:hidden;pointer-events:none;white-space:normal}',
      '.oconf-cam-tip::before{content:"";position:absolute;right:12px;bottom:100%;border:6px solid transparent;border-bottom-color:#fff;filter:drop-shadow(0 -1px 0 #d6d3d1)}',
      '.oconf-cam-wrap:hover .oconf-cam-tip,.oconf-cam-wrap:focus-within .oconf-cam-tip{opacity:1;visibility:visible}',
      '@media (max-width:880px){.oconf-cam-tip{right:auto;left:50%;transform:translateX(-50%);min-width:180px}.oconf-cam-tip::before{right:auto;left:50%;transform:translateX(-50%)}}',
      '.oconf-away-banner{display:none}',
      '.oconf-away-slot{display:none}',
      '.oconf-away-wrap{position:relative;display:inline-flex;align-items:center;vertical-align:middle;flex:none}',
      '.oconf-away-alert{position:relative;z-index:1;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;border-radius:9px;cursor:pointer;color:#fff;background:#b91c1c;box-shadow:0 0 0 0 rgba(220,38,38,.55);animation:oconfAwayPulse 1.6s ease-out infinite}',
      '.oconf-away-alert:hover,.oconf-away-alert:focus-visible{filter:brightness(1.08);outline:2px solid #fecaca;outline-offset:2px}',
      '.oconf-away-alert__tip{position:absolute;top:calc(100% + 8px);right:0;z-index:95;display:flex;align-items:flex-start;gap:.45rem;min-width:220px;max-width:min(340px,70vw);padding:.55rem .7rem;border-radius:12px;background:#fff;color:#1c1917;font-size:.8rem;font-weight:650;line-height:1.35;text-align:left;box-shadow:0 12px 28px -10px rgba(0,0,0,.35);border:1px solid #d6d3d1;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(4px);transition:opacity .15s ease,transform .15s ease,visibility .15s}',
      '.oconf-away-alert__tip::before{content:"";position:absolute;right:12px;bottom:100%;border:6px solid transparent;border-bottom-color:#fff;filter:drop-shadow(0 -1px 0 #d6d3d1)}',
      '.oconf-away-wrap:hover .oconf-away-alert__tip,.oconf-away-wrap:focus-within .oconf-away-alert__tip{opacity:1;visibility:visible;transform:translateY(0)}',
      '.oconf-away-alert__warn{flex:none;display:inline-flex;color:#d97706;margin-top:.08rem}',
      '@media (max-width:880px){.oconf-away-alert__tip{font-size:.76rem;min-width:200px;right:auto;left:50%;transform:translateX(-50%) translateY(4px)}.oconf-away-wrap:hover .oconf-away-alert__tip,.oconf-away-wrap:focus-within .oconf-away-alert__tip{transform:translateX(-50%) translateY(0)}.oconf-away-alert__tip::before{right:auto;left:50%;transform:translateX(-50%)}}',
      '@media (hover:none){.oconf-away-wrap:active .oconf-away-alert__tip{opacity:1;visibility:visible}}',
      '@keyframes oconfAwayPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.55)}70%{box-shadow:0 0 0 8px rgba(220,38,38,0)}}',
      'body.oconf-idle-warn .oconf-panel{outline:2px solid #d97706;outline-offset:-2px}',
      '.oconf-panel--detached{position:fixed!important;left:-9999px!important;top:0!important;width:2px!important;height:2px!important;min-height:0!important;max-height:none!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important;z-index:-1!important;border:0!important;box-shadow:none!important;outline:none!important;flex:none!important}',
    ].join('');
    document.head.appendChild(el);
  }

  Orbit.plugin('orbit-conference', function (orbit, log) {
    if ((orbit.apiVersion || 0) < 7) {
      log('Orbit apiVersion >= 7 required (msgTagged + message tags).');
    }
    injectStyles();
    bindIdleActivityListeners();
    var cfg = confCfg(orbit);
    log('conference → ' + cfg.server + ' (tag ' + TAG + '=' + cfg.tagID + ', idle ' + cfg.idleTimeoutSec + 's)');
    orbit.on('buffer.active', function () {
      syncAwayClass(orbit);
      expireStaleInvites(orbit);
      dropVisioIfLeftBuffer(orbit);
    });
    syncAwayClass(orbit);
    window.setInterval(function () {
      expireStaleInvites(orbit);
      dropVisioIfLeftBuffer(orbit);
    }, 15000);
    // Do not preload external_api.js: Jitsi JSON.parse()s the *parent* page
    // query string (nick, channel, age…). Guest URLs then spam
    // "Failed to parse URL parameter value" and can look like a failed IRC connect.

    // Warm WHOIS for group ACL (controle parental, etc.)
    try {
      var me = orbit.state.nick();
      if (me) orbit.irc.send('WHOIS ' + me);
    } catch (e) { /* ignore */ }
    // Prefetch EXTJWT during splash so the first visio click is not the first ircd round-trip.
    orbit.on('connected', function () {
      clearExtJwtState();
      scheduleExtJwtWarm(orbit);
    });
    orbit.on('boot:ready', function () { scheduleExtJwtWarm(orbit); });
    orbit.on('status', function (st) {
      var s = String(st || '');
      if (s === 'closed' || s === 'error' || s === 'connecting') clearExtJwtState();
    });
    scheduleExtJwtWarm(orbit);

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '');
      var cmdU = cmd.toUpperCase();
      // Self PART/KICK from the visio salon → hang up local Jitsi (others keep the call).
      if ((cmdU === 'PART' || cmdU === 'KICK') && conf.active && conf.buffer) {
        var meNick = String((orbit.state.nick && orbit.state.nick()) || '').toLowerCase();
        var who = cmdU === 'KICK'
          ? String((msg.params && msg.params[1]) || '').toLowerCase()
          : String(msg.nick || '').toLowerCase();
        var ch = String((msg.params && msg.params[0]) || '');
        if (meNick && who === meNick && inviteKey(ch) === inviteKey(conf.buffer)) {
          leaveConference(orbit, conf.buffer);
        }
      }
      // RPL_WHOISSPECIAL — security groups often appear here
      if (cmd === '320' && msg.params && msg.params[1] === orbit.state.nick()) {
        myGroupsText = (myGroupsText + ' ' + (msg.params[2] || '')).trim();
      }
      if (cmd === '318' && msg.params && msg.params[1] === orbit.state.nick()) {
        // end of whois — keep myGroupsText
      }
      if (String(cmd).toUpperCase() === 'TAGMSG') {
        var tagTags = msg.tags || {};
        var replyVal = String(tagTags[REPLY_TAG] || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(tagTags, TAG)
            && replyVal !== 'refuse' && replyVal !== 'stop' && replyVal !== 'alive') return;
        var tagTarget = (msg.params && msg.params[0]) || '';
        var tagBuf = isChannelName(tagTarget) ? tagTarget : (msg.nick || tagTarget);
        if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
        if (isStaleConferenceEvent(tagTags, orbit)) return;
        if (conferenceStopMatch('', tagTags) || replyVal === 'stop') {
          handleConferenceStopped(orbit, tagBuf, msg.nick || '');
          return;
        }
        if (conferenceRefuseMatch('', tagTags) || replyVal === 'refuse') {
          handleConferenceRefused(orbit, tagBuf, msg.nick || '');
          return;
        }
        // Keep blue banner fresh while the starter's session is still live.
        if (replyVal === 'alive') {
          var aliveRoom = String(tagTags[ROOM_TAG] || '').replace(/[^A-Za-z0-9._-]/g, '');
          var aliveSid = String(tagTags[SESSION_TAG] || '').replace(/[^A-Za-z0-9._-]/g, '');
          if (aliveRoom) channelRooms[inviteKey(tagBuf)] = { name: aliveRoom, serial: 1 };
          markLiveVisio(tagBuf, msg.nick || '', aliveRoom, aliveSid);
          if (getInviteFor(tagBuf)) touchInvite(tagBuf);
          else {
            delete dismissed[inviteKey(tagBuf)];
            setStoppedNote(tagBuf, null);
            setInvite(tagBuf, { nick: msg.nick || '', link: publicLink(orbit, tagBuf), sid: aliveSid });
          }
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(tagTags, TAG)) return;
        var meetId = String(tagTags[ROOM_TAG] || '').replace(/[^A-Za-z0-9._-]/g, '');
        var sid = String(tagTags[SESSION_TAG] || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!meetId && !isChannelName(tagBuf)) meetId = queryMeetRoomId(orbit, tagBuf);
        if (meetId) channelRooms[inviteKey(tagBuf)] = { name: meetId, serial: 1 };
        bindQueryRoom(tagBuf, meetId, sid, msg.nick || '');
        delete dismissed[inviteKey(tagBuf)];
        setStoppedNote(tagBuf, null);
        setInvite(tagBuf, { nick: msg.nick || '', link: publicLink(orbit, tagBuf), sid: sid });
        if (!isChannelName(tagBuf)) {
          try {
            orbit.notify('Visio', orbit.i18n.pick({
              fr: (msg.nick || 'Quelqu’un') + ' vous a envoyé une demande de visio.',
              en: (msg.nick || 'Someone') + ' sent you a video call request.',
            }));
          } catch (eN) { /* ignore */ }
        }
        return;
      }
      if (String(cmd).toUpperCase() !== 'PRIVMSG') return;
      var tags = msg.tags || {};
      var text = (msg.params && msg.params[1]) || '';
      if (isStaleConferenceEvent(tags, orbit)) return;
      if (conferenceRefuseMatch(text, tags)) {
        var refuseTarget = (msg.params && msg.params[0]) || '';
        var refuseBuf = isChannelName(refuseTarget) ? refuseTarget : (msg.nick || refuseTarget);
        if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
        handleConferenceRefused(orbit, refuseBuf, msg.nick || '');
        return;
      }
      if (conferenceStopMatch(text, tags)) {
        var targetStop = (msg.params && msg.params[0]) || '';
        var stopBuf = isChannelName(targetStop) ? targetStop : (msg.nick || targetStop);
        if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
        handleConferenceStopped(orbit, stopBuf, msg.nick || '');
        return;
      }
      var inviteMatch = conferenceInviteMatch(orbit, text, tags);
      if (!inviteMatch) return;
      var linkMatch = inviteMatch.linkMatch;
      var target = (msg.params && msg.params[0]) || '';
      var buf = isChannelName(target) ? target : (msg.nick || target);
      if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
      // Remember Meet room from the public link / [room:…] so joiners open the same room id.
      if (linkMatch) {
        try {
          var path = (linkMatch[0].split('/').filter(Boolean).pop() || '').split('?')[0];
          if (path) channelRooms[inviteKey(buf)] = { name: decodeURIComponent(path), serial: 1 };
        } catch (e) { /* ignore */ }
      }
      var privRoom = String(
        (tags && tags[ROOM_TAG])
        || inviteMatch.roomFromText
        || (channelRooms[inviteKey(buf)] && channelRooms[inviteKey(buf)].name)
        || ''
      ).replace(/[^A-Za-z0-9._-]/g, '');
      var privSid = String((tags && tags[SESSION_TAG]) || '').replace(/[^A-Za-z0-9._-]/g, '');
      if (!privRoom && !isChannelName(buf)) privRoom = queryMeetRoomId(orbit, buf);
      bindQueryRoom(buf, privRoom, privSid, msg.nick || '');
      delete dismissed[inviteKey(buf)];
      setStoppedNote(buf, null);
      setInvite(buf, { nick: msg.nick || '', link: linkMatch ? linkMatch[0] : publicLink(orbit, buf), sid: privSid });
      if (!isChannelName(buf)) {
        try {
          orbit.notify('Visio', orbit.i18n.pick({
            fr: (msg.nick || 'Quelqu’un') + ' vous a envoyé une demande de visio.',
            en: (msg.nick || 'Someone') + ' sent you a video call request.',
          }));
        } catch (eN2) { /* ignore */ }
      }
    });

    orbit.on('raw', function (msg) {
      if (String(msg.command || '').toUpperCase() !== 'JOIN') return;
      if (!conf.active || !conf.startedByMe || !isChannelName(conf.buffer)) return;
      var cfgJ = confCfg(orbit);
      var joinedBuf = (msg.params && msg.params[0]) || msg.target || '';
      if (!joinedBuf || inviteKey(joinedBuf) !== inviteKey(conf.buffer)) return;
      if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
      var key = inviteKey(joinedBuf);
      var now = Date.now();
      var last = announced[key + ':join'] || 0;
      if (now - last < 15000) return;
      announced[key + ':join'] = now;
      // Secure mode: refresh profile invites AND re-send Orbit banner (TAGMSG/PRIVMSG)
      // so late joiners see the blue bar — previously only Mon identité was updated.
      if (cfgJ.secure) {
        var room = meetRoomFor(orbit, joinedBuf);
        var joinerAcct = null;
        try {
          var stJ = orbit.state.get && orbit.state.get();
          var bufJ = stJ && stJ.buffers && stJ.buffers[joinedBuf];
          var mem = bufJ && bufJ.members && bufJ.members[msg.nick];
          if (mem && mem.account) joinerAcct = mem.account;
        } catch (eJ) { /* ignore */ }
        publishSecureInvites(orbit, joinedBuf, room, joinerAcct ? [joinerAcct] : null, {
          action: 'add',
          silent: true,
        });
        announceConference(orbit, joinedBuf, { force: true });
        orbit.notify('Visio', (msg.nick || 'Quelqu’un') + ' ' + orbit.i18n.pick({
          fr: 'a rejoint le salon : invitation visio renvoyée.',
          en: 'joined the room: conference invite sent again.',
        }));
        return;
      }
      announceConference(orbit, joinedBuf, { force: true });
      orbit.notify('Visio', (msg.nick || 'Quelqu’un') + ' ' + orbit.i18n.pick({
        fr: 'a rejoint le salon : invitation visio renvoyée.',
        en: 'joined the room: conference invite sent again.',
      }));
    });

    if (cfg.hideInviteForOrbit) {
      orbit.addMessageFilter(function (m) {
        // Never swallow query traffic: filtering a first-contact visio PRIVMSG
        // would prevent Orbit from opening the MP buffer (no banner, no notif).
        var target = String(m.target || '');
        if (target && !/^[#&+!]/.test(target)) return false;
        return conferenceStopMatch(m.text || '', m.tags || {})
          || conferenceRefuseMatch(m.text || '', m.tags || {})
          || !!conferenceInviteMatch(orbit, m.text || '', m.tags || {});
      });
    }

    orbit.addUi('topbar_item', function () { return h(HeaderButton, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuEndItem, { orbit: orbit }); });
    orbit.addUi('topbar_end', function () { return h(AwayVisioBanner, { orbit: orbit }); });
    orbit.addUi('overlay', function () { return h(JitsiPanel, { orbit: orbit }); });
    // Standalone invite/stopped banner rendered for all layouts via overlay slot.
    orbit.addUi('overlay', function () { return h(InviteBanner, { orbit: orbit }); });
    orbit.addMessageDecorator(function (m) {
      if (!m.tags || !Object.prototype.hasOwnProperty.call(m.tags, TAG)) return null;
      return h(JoinCard, { orbit: orbit, m: m });
    });
    orbit.addCommand('visio', {
      help: 'Ouvre / quitte la conférence vidéo (sans l’arrêter pour les autres)',
      run: function () {
        var buf = orbit.state.active();
        if (!buf || buf === 'Status') {
          orbit.notify('Visio', 'Ouvre un canal ou un MP d’abord.');
          return;
        }
        openConference(orbit, buf);
      },
    });
    orbit.addCommand('visio-stop', {
      help: 'Arrête la conférence vidéo pour tout le salon',
      run: function () {
        var buf = orbit.state.active();
        if (!buf || buf === 'Status') {
          orbit.notify('Visio', 'Ouvre un canal ou un MP d’abord.');
          return;
        }
        if (!canStart(orbit, buf).ok && !(conf.active && conf.startedByMe && conf.buffer === buf)) {
          orbit.notify('Visio', 'Seuls les opérateurs peuvent arrêter la visio pour tous.');
          return;
        }
        endConference(orbit, buf);
      },
    });
    orbit.on(EVT_HIDE, function () {
      if (conf.active && conf.buffer) closeVisioPanel(orbit, conf.buffer);
      else setConf(null);
    });
  });
})();
