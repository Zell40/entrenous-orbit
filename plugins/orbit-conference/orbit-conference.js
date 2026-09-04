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
  var EVT_SHOW = 'plugin-conference.show';
  var EVT_HIDE = 'plugin-conference.hide';
  var HEIGHT_KEY = 'panelHeightPx';
  var HEIGHT_KEY_MOBILE = 'panelHeightPxMobile';
  var NARROW = '(max-width: 880px)';

  var conf = { active: false, buffer: '', room: '', startedByMe: false, listeners: new Set() };
  function subscribeConf(cb) { conf.listeners.add(cb); return function () { conf.listeners.delete(cb); }; }
  function getConfSnap() { return conf.active ? conf.buffer : ''; }
  var lastViewHeight = '46%';
  /** Buffers already announced on IRC for the current conference session. */
  var announced = Object.create(null);
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
    if (data) invites.map[key] = data;
    else delete invites.map[key];
    invites.rev++;
    invites.listeners.forEach(function (l) { l(); });
  }

  // Self security-group fragments from WHOIS special lines
  var myGroupsText = '';
  /** Last Meet room id per channel (for -01/-02 collision suffixes). */
  var channelRooms = Object.create(null);

  function setConf(buffer, room, meta) {
    meta = meta || {};
    conf.active = !!buffer;
    conf.buffer = buffer || '';
    conf.room = buffer ? (room || conf.room || '') : '';
    conf.startedByMe = !!(buffer && meta.startedByMe);
    document.body.classList.toggle('oconf-open', !!buffer);
    if (buffer) {
      document.documentElement.style.setProperty('--oconf-h', lastViewHeight);
      setInvite(buffer, null);
    } else {
      document.documentElement.style.removeProperty('--oconf-h');
      announced = Object.create(null);
      dismissed = Object.create(null);
      conf.startedByMe = false;
    }
    conf.listeners.forEach(function (l) { l(); });
  }

  function confCfg(orbit) {
    var c = (orbit.config().conference) || {};
    var out = {
      server: c.server || 'visio.entrenous.chat',
      secure: !!c.secure,
      tokenEndpoint: c.tokenEndpoint || '/app/plugins/third/orbit-conference/visio-jwt.php',
      tagID: c.tagID || '1',
      channels: c.channels !== false,
      queries: c.queries !== false,
      enabledInChannels: c.enabledInChannels || ['*'],
      disabledInChannels: c.disabledInChannels || [],
      viewHeight: c.viewHeight || '46%',
      viewHeightMobile: c.viewHeightMobile || '28%',
      inviteText: c.inviteText || '-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}',
      joinText: c.joinText || '-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}',
      joinButtonText: c.joinButtonText || 'Rejoindre',
      requireAccount: c.requireAccount !== false,
      requireChannelOp: c.requireChannelOp !== false,
      startPrefixes: c.startPrefixes || '~&@',
      denyGroups: c.denyGroups || [],
      requireGroups: c.requireGroups || [],
      maxParticipantsChannel: c.maxParticipantsChannel || 20,
      maxParticipantsQuery: c.maxParticipantsQuery || 2,
      anyoneCanStartIn: Array.isArray(c.anyoneCanStartIn) ? c.anyoneCanStartIn : [],
      channelRules: c.channelRules && typeof c.channelRules === 'object' ? c.channelRules : {},
      publicLinkInInvite: c.publicLinkInInvite !== false,
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
    var nick = orbit.state.nick() || 'user';
    if (isChannelName(buffer)) return buffer;
    var members = [nick, buffer].sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return 'query-' + members.join('+');
  }

  /** Jitsi-safe id from an IRC channel / query label. */
  function sanitizeMeetId(s) {
    return String(s || '')
      .replace(/^[#&+!]/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'room';
  }

  /**
   * Meet room = IRC channel name (readable). Same channel → same room so everyone
   * meets. If a new parallel room is forced, append -01, -02, …
   */
  function allocateMeetRoom(orbit, buffer, forceNew) {
    var key = inviteKey(buffer);
    var cur = channelRooms[key];
    if (!forceNew && conf.active && conf.buffer && inviteKey(conf.buffer) === key && conf.room) {
      return conf.room;
    }
    if (!forceNew && cur && cur.name) return cur.name;
    var serial = cur ? cur.serial + 1 : 1;
    var base = isChannelName(buffer)
      ? sanitizeMeetId(buffer)
      : sanitizeMeetId('q-' + [orbit.state.nick() || 'user', buffer].sort(function (a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
      }).join('-'));
    var name = serial <= 1 ? base : (base + '-' + (serial < 10 ? '0' + serial : String(serial)));
    channelRooms[key] = { name: name, serial: serial };
    return name;
  }

  function meetRoomFor(orbit, buffer) {
    if (conf.active && conf.buffer && inviteKey(conf.buffer) === inviteKey(buffer) && conf.room) {
      return conf.room;
    }
    var cur = channelRooms[inviteKey(buffer)];
    if (cur && cur.name) return cur.name;
    return allocateMeetRoom(orbit, buffer, false);
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
    var linkMatch = String(text || '').match(linkRe);
    var hasTag = !!(tags && Object.prototype.hasOwnProperty.call(tags, TAG));
    if (!hasTag) {
      if (!linkMatch) return null;
      if (!/invite à rejoindre la conférence|rejoindre la conférence|visio/i.test(String(text || ''))) return null;
    }
    return { linkMatch: linkMatch, hasTag: hasTag };
  }

  function conferenceStopMatch(text) {
    return /-[^-]+-\s+a arrêté la conférence\./i.test(String(text || ''));
  }

  function requestExtJwt(orbit, target) {
    target = String(target || '*');
    return new Promise(function (resolve, reject) {
      var off;
      var acc = '';
      var timer = window.setTimeout(function () {
        if (off) off();
        reject(new Error('jwt_timeout'));
      }, 10000);
      off = orbit.on('raw', function (msg) {
        var cmd = String(msg.command || '').toUpperCase();
        var params = msg.params || [];
        var p0 = params[0] || '';
        var p1 = params[1] || '';
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
        resolve(acc);
      });
      orbit.irc.send('EXTJWT ' + target);
    });
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
    return requestExtJwt(orbit, proofTarget).then(function (proof) {
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
    });
  }

  /** Announce the conference on IRC once per open session (starter only). */
  function announceConference(orbit, buffer, opts) {
    opts = opts || {};
    if (!buffer || (announced[buffer] && !opts.force)) return;
    announced[buffer] = true;
    var cfg = confCfg(orbit);
    var room = meetRoomFor(orbit, buffer);
    // No public Jitsi URL: do not send a PRIVMSG that other IRC clients would
    // see as "cliquez sur le lien" with no link. Orbit clients get a TAGMSG.
    if (!cfg.publicLinkInInvite) {
      try {
        orbit.irc.send('@' + TAG + '=' + (cfg.tagID || '1') + ';' + ROOM_TAG + '=' + room + ' TAGMSG ' + buffer);
      } catch (e) { /* ignore */ }
      return;
    }
    var nick = orbit.state.nick() || 'user';
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
    try {
      if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, text, tags);
      else if (orbit.irc.msg) orbit.irc.msg(buffer, text);
      else orbit.irc.send('PRIVMSG ' + buffer + ' :' + text);
    } catch (e) {
      try { orbit.irc.msg(buffer, text); } catch (e2) { /* ignore */ }
    }
  }

  function announceConferenceStopped(orbit, buffer) {
    if (!buffer) return;
    var nick = orbit.state.nick() || 'user';
    var tags = {};
    tags[TAG] = confCfg(orbit).tagID || '1';
    var text = '* -' + nick + '- a arrêté la conférence.';
    try {
      if (orbit.irc.msgTagged) orbit.irc.msgTagged(buffer, text, tags);
      else if (orbit.irc.msg) orbit.irc.msg(buffer, text);
      else orbit.irc.send('PRIVMSG ' + buffer + ' :' + text);
    } catch (e) {
      try { orbit.irc.msg(buffer, text); } catch (e2) { /* ignore */ }
    }
  }

  function openConference(orbit, buffer, opts) {
    opts = opts || {};
    if (!bufferAllowed(orbit, buffer)) return;
    if (conf.active && conf.buffer === buffer) {
      if (conf.startedByMe) announceConferenceStopped(orbit, buffer);
      setConf(null);
      orbit.emit(EVT_HIDE);
      return;
    }
    var gate = opts.joinOnly ? canJoin(orbit, buffer) : canStart(orbit, buffer);
    if (!gate.ok) {
      orbit.notify('Visio', gate.reason || 'Accès refusé.');
      return;
    }
    if (conf.active && conf.buffer !== buffer) {
      var msg = orbit.i18n.pick({ fr: 'Fermer la conférence en cours ?', en: 'Close the current conference?' });
      if (!window.confirm(msg)) return;
    }
    // Starters allocate (or reuse) a readable Meet room; joiners reuse the same id.
    var room = opts.joinOnly
      ? meetRoomFor(orbit, buffer)
      : allocateMeetRoom(orbit, buffer, !!opts.newRoom);
    setConf(buffer, room, { startedByMe: !opts.joinOnly });
    // Starters announce immediately so other IRC clients see the invite even if
    // Meet's videoConferenceJoined event never fires.
    if (!opts.joinOnly) announceConference(orbit, buffer);
    orbit.emit(EVT_SHOW, { buffer: buffer });
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

  function HeaderButton(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var hasInvite = !!getInviteFor(activeBuf);
    if (!bufferAllowed(orbit, activeBuf)) return null;
    // Hide if cannot start and there is no invite to join.
    if (!openBuf && !canStart(orbit, activeBuf).ok && !hasInvite) return null;
    if (!openBuf && !canJoin(orbit, activeBuf).ok) return null;
    var on = openBuf === activeBuf;
    return h('button', {
      type: 'button',
      className: 'topbar__search' + (on ? ' is-on' : ''),
      title: orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }),
      'aria-label': orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }),
      'aria-pressed': on,
      onClick: function () {
        if (on) openConference(orbit, activeBuf, { joinOnly: true });
        else openConference(orbit, activeBuf, { joinOnly: hasInvite && !canStart(orbit, activeBuf).ok });
      },
    }, h(CameraIcon));
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var hasInvite = !!getInviteFor(activeBuf);
    var cfg = confCfg(orbit);
    if (!bufferAllowed(orbit, activeBuf)) return null;
    if (!openBuf && !canStart(orbit, activeBuf).ok && !hasInvite) return null;
    var joinGate = canJoin(orbit, activeBuf);
    if (!openBuf && !joinGate.ok && !hasInvite) return null;
    var needsRegister = !!(requireAccountFor(cfg, activeBuf) && !orbit.state.account());
    var registerUrl = (orbit.config().branding && orbit.config().branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
    var on = openBuf === activeBuf;
    var label = on
      ? orbit.i18n.pick({ fr: 'Fermer la visio', en: 'Close video' })
      : (hasInvite
        ? (needsRegister
          ? orbit.i18n.pick({ fr: 'S’enregistrer pour la visio', en: 'Register to join video' })
          : orbit.i18n.pick({ fr: 'Rejoindre la visio', en: 'Join video call' }))
        : orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }));
    return h('button', {
      type: 'button',
      className: 'nmenu__item' + (!on && hasInvite && !joinGate.ok && !needsRegister ? ' is-disabled' : ''),
      role: 'menuitem',
      disabled: !on && hasInvite && !joinGate.ok && !needsRegister,
      title: !on && hasInvite && !joinGate.ok ? joinGate.reason : undefined,
      onClick: function () {
        if (on) openConference(orbit, activeBuf, { joinOnly: true });
        else if (hasInvite && !joinGate.ok && needsRegister) window.open(registerUrl, '_blank', 'noopener');
        else openConference(orbit, activeBuf, { joinOnly: hasInvite && !canStart(orbit, activeBuf).ok });
      },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(CameraIcon)),
      h('span', { className: 'nmenu__txt' }, h('b', null, label))
    );
  }

  function InviteBanner(props) {
    var orbit = props.orbit;
    var bufFromProp = props.buffer || null;
    var activeBuf = bufFromProp || useActiveBuffer(orbit);
    useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    useSyncExternalStore(subscribeStoppedNote, getStoppedNoteSnap, getStoppedNoteSnap);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
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
    if (!inv || openBuf) return null;
    if (dismissed[inviteKey(activeBuf)]) return null;
    var joinGate = canJoin(orbit, activeBuf);
    var cfg = confCfg(orbit);
    var needsRegister = !!(requireAccountFor(cfg, activeBuf) && !orbit.state.account());
    var registerUrl = (orbit.config().branding && orbit.config().branding.registerUrl) || 'https://www.reseau-entrenous.fr/register/';
    var joinLabel = (cfg.joinButtonText || 'Rejoindre');
    if (/^rejoindre$/i.test(joinLabel)) joinLabel = 'Rejoindre la visio';
    return h('div', { className: 'oconf-invite' },
      h('span', { className: 'oconf-invite__txt' },
        (inv.nick || 'Quelqu\u2019un') + ' ' + orbit.i18n.pick({ fr: 'a lanc\u00e9 une visio.', en: 'started a video call.' })
        + (!joinGate.ok ? (' ' + orbit.i18n.pick({
          fr: needsRegister ? 'Inscrivez-vous pour rejoindre la visio. ' : 'Acc\u00e8s impossible : ',
          en: needsRegister ? 'Register to join the video call. ' : 'Cannot join: ',
        }) + (needsRegister ? '' : joinGate.reason)) : '')
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
        }, '\uD83D\uDCF9 ' + (!joinGate.ok ? orbit.i18n.pick({ fr: 'Acc\u00e8s refus\u00e9', en: 'Access denied' }) : joinLabel))),
      h('button', {
        type: 'button',
        className: 'oconf-invite__dismiss',
        'aria-label': orbit.i18n.pick({ fr: 'Ignorer', en: 'Dismiss' }),
        title: orbit.i18n.pick({ fr: 'Ne pas rejoindre', en: 'Dismiss' }),
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

      var live = confCfg(orbit);
      var domain = live.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
      var room = meetRoomFor(orbit, buffer);
      var nick = orbit.state.nick() || 'user';
      var maxP = maxParticipantsFor(live, buffer);
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
          var api = new window.JitsiMeetExternalAPI(domain, {
            roomName: room,
            parentNode: host,
            width: '100%',
            height: '100%',
            jwt: jwt || undefined,
            userInfo: { displayName: nick },
            configOverwrite: {
              startWithAudioMuted: true,
              startWithVideoMuted: true,
              prejoinConfig: { enabled: false },
              prejoinPageEnabled: false,
              disableDeepLinking: true,
              bosh: 'https://' + domain + '/http-bind',
              websocket: 'wss://' + domain + '/xmpp-websocket',
              maxParticipants: maxP || undefined,
            },
            interfaceConfigOverwrite: {
              SHOW_JITSI_WATERMARK: false,
              SHOW_WATERMARK_FOR_GUESTS: false,
              TOOLBAR_BUTTONS: [
                'microphone', 'camera', 'fullscreen', 'hangup',
                'settings', 'videoquality', 'filmstrip', 'fodeviceselection',
                'stats', 'shortcuts',
              ],
            },
          });
          apiRef.current = api;
          // Register immediately — videoConferenceJoined can fire before `onload`.
          try { api.executeCommand('displayName', nick); } catch (e) { /* ignore */ }
          try { api.executeCommand('subject', roomNameFor(orbit, buffer)); } catch (e2) { /* ignore */ }
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
                fr: 'La visio a atteint sa limite de participants.',
                en: 'The conference reached its participant limit.',
              }));
              orbit.notify('Visio', orbit.i18n.pick({
                fr: 'La visio est complète pour le moment.',
                en: 'The conference is full right now.',
              }));
            }
          });
          var didJoin = false;
          function onJoined() {
            if (cancelled || didJoin) return;
            didJoin = true;
            setJoined(true);
            setErr('');
          }
          api.addListener('videoConferenceJoined', onJoined);
          // Title-only fallback if Meet never emits the join event.
          timers.push(window.setTimeout(function () {
            if (!cancelled && !didJoin) setJoined(true);
          }, 12000));
          api.addListener('readyToClose', function () {
            if (cancelled) return;
            orbit.notify('Visio', orbit.i18n.pick({
              fr: 'La conférence est terminée.',
              en: 'The conference has ended.',
            }));
            setConf(null);
          });
          api.addListener('videoConferenceLeft', function () {
            if (cancelled) return;
            if (conf.active && conf.startedByMe && conf.buffer === buffer) announceConferenceStopped(orbit, buffer);
            setConf(null);
          });
        } catch (e) {
          setErr(String(e));
        }
      }

      var tokenReady = live.secure
        ? requestConferenceJwt(orbit, buffer, room)
        : Promise.resolve('');
      Promise.all([tokenReady, loadJitsiApi(domain)]).then(function (pair) {
        if (!cancelled) mountApi(live.secure ? pair[0] : undefined);
      }).catch(function (e) {
        if (cancelled) return;
        var code = String((e && e.message) || e || '');
        setErr(({
          extjwt_unsupported: orbit.i18n.pick({
            fr: 'Ton serveur IRC ne supporte pas EXTJWT pour vérifier ton identité.',
            en: 'Your IRC server does not support EXTJWT identity proof.',
          }),
          jwt_timeout: orbit.i18n.pick({
            fr: 'Le serveur IRC n’a pas répondu à temps à la demande EXTJWT.',
            en: 'The IRC server did not answer the EXTJWT request in time.',
          }),
          invalid_extjwt: orbit.i18n.pick({
            fr: 'La preuve EXTJWT a été refusée par le service visio.',
            en: 'The EXTJWT proof was rejected by the conference service.',
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
        if (apiRef.current) { apiRef.current.dispose(); apiRef.current = null; }
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

    var narrow = isNarrow();
    var style = heightPx
      ? { height: heightPx + 'px', maxHeight: narrow ? '50vh' : '70vh' }
      : { height: narrow ? cfg.viewHeightMobile : cfg.viewHeight };

    return h(React.Fragment, null,
      h('div', { className: 'oconf-panel', style: style, ref: panelRef },
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
              if (conf.active && conf.startedByMe && conf.buffer === buffer) announceConferenceStopped(orbit, buffer);
              setConf(null);
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
      '.oconf-invite__btn.is-disabled,.nmenu__item.is-disabled{opacity:.62;cursor:not-allowed;filter:none;transform:none}',
      '.oconf-invite__btn:focus-visible{outline:2px solid color-mix(in srgb,var(--accent,#2563eb) 75%,white);outline-offset:2px}',
      '@media (max-width:640px){.oconf-invite{flex-wrap:wrap;align-items:flex-start}.oconf-invite__txt{min-width:100%;margin-bottom:.15rem}.oconf-invite__btn{flex:1 1 auto;min-width:0;white-space:normal;text-align:center}.oconf-invite__dismiss{margin-left:auto}}',
      '@keyframes oconfInvitePulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.58),0 6px 18px -10px rgba(37,99,235,.75)}70%{box-shadow:0 0 0 10px rgba(37,99,235,0),0 8px 24px -12px rgba(37,99,235,.82)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0),0 6px 18px -10px rgba(37,99,235,.72)}}',
      '.oconf-join{display:inline-flex;margin-left:.45rem;vertical-align:middle}',
      '.oconf-join__btn{border:0;cursor:pointer;font:inherit;font-size:.78rem;font-weight:700;padding:.28rem .65rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#2563eb) 18%,transparent);color:var(--accent-d,var(--accent,#1d4ed8))}',
      '.topbar__search.is-on{background:var(--accent-soft,rgba(20,82,204,.14));color:var(--accent-d,var(--accent))}',
    ].join('');
    document.head.appendChild(el);
  }

  Orbit.plugin('orbit-conference', function (orbit, log) {
    if ((orbit.apiVersion || 0) < 7) {
      log('Orbit apiVersion >= 7 required (msgTagged + message tags).');
    }
    injectStyles();
    var cfg = confCfg(orbit);
    log('conference → ' + cfg.server + ' (tag ' + TAG + '=' + cfg.tagID + ')');
    // Do not preload external_api.js: Jitsi JSON.parse()s the *parent* page
    // query string (nick, channel, age…). Guest URLs then spam
    // "Failed to parse URL parameter value" and can look like a failed IRC connect.

    // Warm WHOIS for group ACL (controle parental, etc.)
    try {
      var me = orbit.state.nick();
      if (me) orbit.irc.send('WHOIS ' + me);
    } catch (e) { /* ignore */ }

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '');
      // RPL_WHOISSPECIAL — security groups often appear here
      if (cmd === '320' && msg.params && msg.params[1] === orbit.state.nick()) {
        myGroupsText = (myGroupsText + ' ' + (msg.params[2] || '')).trim();
      }
      if (cmd === '318' && msg.params && msg.params[1] === orbit.state.nick()) {
        // end of whois — keep myGroupsText
      }
      if (String(cmd).toUpperCase() === 'TAGMSG') {
        var tagTags = msg.tags || {};
        if (!Object.prototype.hasOwnProperty.call(tagTags, TAG)) return;
        var tagTarget = (msg.params && msg.params[0]) || '';
        var tagBuf = isChannelName(tagTarget) ? tagTarget : (msg.nick || tagTarget);
        if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
        var meetId = String(tagTags[ROOM_TAG] || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (meetId) channelRooms[inviteKey(tagBuf)] = { name: meetId, serial: 1 };
        setInvite(tagBuf, { nick: msg.nick || '', link: publicLink(orbit, tagBuf) });
        return;
      }
      if (String(cmd).toUpperCase() !== 'PRIVMSG') return;
      var tags = msg.tags || {};
      var text = (msg.params && msg.params[1]) || '';
      if (conferenceStopMatch(text)) {
        var targetStop = (msg.params && msg.params[0]) || '';
        var stopBuf = isChannelName(targetStop) ? targetStop : (msg.nick || targetStop);
        setInvite(stopBuf, null);
        if (conf.active && conf.buffer === stopBuf) {
          orbit.notify('Visio', orbit.i18n.pick({
            fr: 'La conférence a été arrêtée.',
            en: 'The conference was stopped.',
          }));
          setConf(null);
        }
        return;
      }
      var inviteMatch = conferenceInviteMatch(orbit, text, tags);
      if (!inviteMatch) return;
      var linkMatch = inviteMatch.linkMatch;
      var target = (msg.params && msg.params[0]) || '';
      var buf = isChannelName(target) ? target : (msg.nick || target);
      if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
      // Remember Meet room from the public link so joiners open the same room id.
      if (linkMatch) {
        try {
          var path = (linkMatch[0].split('/').filter(Boolean).pop() || '').split('?')[0];
          if (path) channelRooms[inviteKey(buf)] = { name: decodeURIComponent(path), serial: 1 };
        } catch (e) { /* ignore */ }
      }
      setInvite(buf, { nick: msg.nick || '', link: linkMatch ? linkMatch[0] : publicLink(orbit, buf) });
    });

    orbit.on('raw', function (msg) {
      if (String(msg.command || '').toUpperCase() !== 'JOIN') return;
      if (!conf.active || !conf.startedByMe || !isChannelName(conf.buffer)) return;
      var joinedBuf = (msg.params && msg.params[0]) || msg.target || '';
      if (!joinedBuf || inviteKey(joinedBuf) !== inviteKey(conf.buffer)) return;
      if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
      var key = inviteKey(joinedBuf);
      var now = Date.now();
      var last = announced[key + ':join'] || 0;
      if (now - last < 15000) return;
      announced[key + ':join'] = now;
      announceConference(orbit, joinedBuf, { force: true });
      orbit.notify('Visio', (msg.nick || 'Quelqu’un') + ' ' + orbit.i18n.pick({
        fr: 'a rejoint le salon : invitation visio renvoyée.',
        en: 'joined the room: conference invite sent again.',
      }));
    });

    if (cfg.hideInviteForOrbit) {
      orbit.addMessageFilter(function (m) {
        return conferenceStopMatch(m.text || '') || !!conferenceInviteMatch(orbit, m.text || '', m.tags || {});
      });
    }

    orbit.addUi('topbar_item', function () { return h(HeaderButton, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });
    orbit.addUi('overlay', function () { return h(JitsiPanel, { orbit: orbit }); });
    // Standalone invite/stopped banner rendered for all layouts via overlay slot.
    orbit.addUi('overlay', function () { return h(InviteBanner, { orbit: orbit }); });
    orbit.addMessageDecorator(function (m) {
      if (!m.tags || !Object.prototype.hasOwnProperty.call(m.tags, TAG)) return null;
      return h(JoinCard, { orbit: orbit, m: m });
    });
    orbit.addCommand('visio', {
      help: 'Ouvre / ferme la conférence vidéo du canal ou MP actif',
      run: function () {
        var buf = orbit.state.active();
        if (!buf || buf === 'Status') {
          orbit.notify('Visio', 'Ouvre un canal ou un MP d’abord.');
          return;
        }
        openConference(orbit, buf);
      },
    });
    orbit.on(EVT_HIDE, function () {
      if (conf.active && conf.startedByMe && conf.buffer) announceConferenceStopped(orbit, conf.buffer);
      setConf(null);
    });
  });
})();
