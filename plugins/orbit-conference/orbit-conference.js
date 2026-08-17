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
  var EVT_SHOW = 'plugin-conference.show';
  var EVT_HIDE = 'plugin-conference.hide';
  var HEIGHT_KEY = 'panelHeightPx';

  var conf = { active: false, buffer: '', listeners: new Set() };
  function subscribeConf(cb) { conf.listeners.add(cb); return function () { conf.listeners.delete(cb); }; }
  function getConfSnap() { return conf.active ? conf.buffer : ''; }
  var lastViewHeight = '46%';
  /** Buffers already announced on IRC for the current conference session. */
  var announced = Object.create(null);

  // Pending invites (tagged IRC lines hidden in Orbit) — buffer → { nick, link }
  var invites = { map: Object.create(null), listeners: new Set() };
  function subscribeInvites(cb) { invites.listeners.add(cb); return function () { invites.listeners.delete(cb); }; }
  function getInvitesSnap() { return invites.map; }
  function setInvite(buffer, data) {
    if (!buffer) return;
    if (data) invites.map[buffer] = data;
    else delete invites.map[buffer];
    invites.listeners.forEach(function (l) { l(); });
  }

  // Self security-group fragments from WHOIS special lines
  var myGroupsText = '';

  function setConf(buffer) {
    conf.active = !!buffer;
    conf.buffer = buffer || '';
    document.body.classList.toggle('oconf-open', !!buffer);
    if (buffer) {
      document.documentElement.style.setProperty('--oconf-h', lastViewHeight);
      setInvite(buffer, null);
    } else {
      document.documentElement.style.removeProperty('--oconf-h');
      announced = Object.create(null);
    }
    conf.listeners.forEach(function (l) { l(); });
  }

  function confCfg(orbit) {
    var c = (orbit.config().conference) || {};
    var out = {
      server: c.server || 'visio.entrenous.chat',
      secure: !!c.secure,
      tagID: c.tagID || '1',
      channels: c.channels !== false,
      queries: c.queries !== false,
      enabledInChannels: c.enabledInChannels || ['*'],
      disabledInChannels: c.disabledInChannels || [],
      viewHeight: c.viewHeight || '46%',
      inviteText: c.inviteText || '{{ nick }} vous invite à un appel vidéo. Rejoindre : {{ link }}',
      joinText: c.joinText || '{{ nick }} a rejoint la conférence. Lien : {{ link }}',
      joinButtonText: c.joinButtonText || 'Rejoindre',
      requireAccount: c.requireAccount !== false,
      requireChannelOp: c.requireChannelOp !== false,
      startPrefixes: c.startPrefixes || '~&@',
      denyGroups: c.denyGroups || [],
      requireGroups: c.requireGroups || [],
      maxParticipantsChannel: c.maxParticipantsChannel || 25,
      maxParticipantsQuery: c.maxParticipantsQuery || 2,
      publicLinkInInvite: c.publicLinkInInvite !== false,
      hideInviteForOrbit: c.hideInviteForOrbit !== false,
    };
    lastViewHeight = out.viewHeight;
    return out;
  }

  function isChannelName(name) { return /^[#&+!]/.test(name || ''); }

  function bufferAllowed(orbit, name) {
    var cfg = confCfg(orbit);
    if (!name || name === 'Status') return false;
    var chan = isChannelName(name);
    if (chan && !cfg.channels) return false;
    if (!chan && !cfg.queries) return false;
    if (!chan) return true;
    var low = String(name).toLowerCase();
    var disabled = (cfg.disabledInChannels || []).map(function (x) { return String(x).toLowerCase(); });
    if (disabled.indexOf(low) > -1) return false;
    var list = (cfg.enabledInChannels || ['*']).map(function (x) { return String(x).toLowerCase(); });
    if (list.indexOf('*') > -1) return true;
    return list.indexOf(low) > -1;
  }

  function myPrefixIn(orbit, buffer) {
    try {
      var st = orbit.state.get();
      var b = st.buffers && st.buffers[buffer];
      var m = b && b.members && b.members[orbit.state.nick()];
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
    if (cfg.requireAccount && !orbit.state.account()) {
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
    if (isChannelName(buffer) && cfg.requireChannelOp) {
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

  function encodedRoom(orbit, buffer) {
    var net = orbit.server.network() || 'entrenous';
    var room = net + '/' + roomNameFor(orbit, buffer);
    return Array.prototype.map.call(room, function (c) {
      return c.charCodeAt(0).toString(16);
    }).join('');
  }

  function publicLink(orbit, buffer) {
    var cfg = confCfg(orbit);
    var domain = cfg.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return 'https://' + domain + '/' + encodedRoom(orbit, buffer);
  }

  /** Announce the conference on IRC once per open session (starter only). */
  function announceConference(orbit, buffer) {
    if (!buffer || announced[buffer]) return;
    announced[buffer] = true;
    var cfg = confCfg(orbit);
    var nick = orbit.state.nick() || 'user';
    var link = publicLink(orbit, buffer);
    var isChan = isChannelName(buffer);
    var tpl = isChan ? (cfg.joinText || '') : (cfg.inviteText || '');
    var text = '* ' + tpl
      .replace(/\{\{\s*nick\s*\}\}/g, nick)
      .replace(/\{\{\s*link\s*\}\}/g, cfg.publicLinkInInvite ? link : '');
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

  function openConference(orbit, buffer, opts) {
    opts = opts || {};
    if (!bufferAllowed(orbit, buffer)) return;
    if (conf.active && conf.buffer === buffer) {
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
    setConf(buffer);
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
    if (!bufferAllowed(orbit, activeBuf)) return null;
    // Hide if cannot start and there is no invite to join.
    if (!openBuf && !canStart(orbit, activeBuf).ok && !invites.map[activeBuf]) return null;
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
        else openConference(orbit, activeBuf, { joinOnly: !!invites.map[activeBuf] });
      },
    }, h(CameraIcon));
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    if (!bufferAllowed(orbit, activeBuf)) return null;
    if (!openBuf && !canStart(orbit, activeBuf).ok && !invites.map[activeBuf]) return null;
    if (!openBuf && !canJoin(orbit, activeBuf).ok) return null;
    var on = openBuf === activeBuf;
    var label = on
      ? orbit.i18n.pick({ fr: 'Fermer la visio', en: 'Close video' })
      : orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' });
    return h('button', {
      type: 'button',
      className: 'nmenu__item',
      role: 'menuitem',
      onClick: function () {
        if (on) openConference(orbit, activeBuf, { joinOnly: true });
        else openConference(orbit, activeBuf, { joinOnly: !!invites.map[activeBuf] });
      },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(CameraIcon)),
      h('span', { className: 'nmenu__txt' }, h('b', null, label))
    );
  }

  function InviteBanner(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var map = useSyncExternalStore(subscribeInvites, getInvitesSnap, getInvitesSnap);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    var inv = map[activeBuf];
    if (!inv || openBuf) return null;
    if (!canJoin(orbit, activeBuf).ok) return null;
    var cfg = confCfg(orbit);
    return h('div', { className: 'oconf-invite' },
      h('span', { className: 'oconf-invite__txt' },
        (inv.nick || 'Quelqu’un') + ' ' + orbit.i18n.pick({ fr: 'a lancé une visio.', en: 'started a video call.' })
      ),
      h('button', {
        type: 'button',
        className: 'oconf-invite__btn',
        onClick: function () { openConference(orbit, activeBuf, { joinOnly: true }); },
      }, '📹 ' + (cfg.joinButtonText || 'Rejoindre'))
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
        var v = orbit.storage.get(HEIGHT_KEY);
        if (typeof v === 'number' && v >= 180 && v <= 900) return v;
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
      var room = encodedRoom(orbit, buffer);
      var nick = orbit.state.nick() || 'user';
      var isChan = isChannelName(buffer);
      var maxP = isChan ? live.maxParticipantsChannel : live.maxParticipantsQuery;
      var timers = [];

      function mountApi(jwt) {
        if (cancelled || !host || !window.JitsiMeetExternalAPI) return;
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
          api.addListener('videoConferenceLeft', function () {
            if (!cancelled) setConf(null);
          });
        } catch (e) {
          setErr(String(e));
        }
      }

      var existing = document.querySelector('script[data-oconf="' + domain + '"]');

      if (live.secure) {
        var off = orbit.on('raw', function (msg) {
          if (String(msg.command || '').toUpperCase() !== 'EXTJWT') return;
          var token = msg.params && msg.params[msg.params.length - 1];
          if (!token || token.length < 20) return;
          off();
          mountApi(token);
        });
        orbit.irc.send('EXTJWT ' + roomNameFor(orbit, buffer));
        timers.push(window.setTimeout(function () { off(); if (!cancelled) mountApi(); }, 4000));
        return function () {
          cancelled = true;
          timers.forEach(window.clearTimeout);
          off();
          if (apiRef.current) { apiRef.current.dispose(); apiRef.current = null; }
        };
      }

      function start() { mountApi(); }
      if (window.JitsiMeetExternalAPI) {
        start();
      } else if (existing) {
        existing.addEventListener('load', start);
      } else {
        var scr = document.createElement('script');
        scr.src = 'https://' + domain + '/external_api.js';
        scr.async = true;
        scr.dataset.oconf = domain;
        scr.onload = start;
        scr.onerror = function () { setErr('Impossible de charger Jitsi (' + domain + ').'); };
        document.head.appendChild(scr);
      }

      return function () {
        cancelled = true;
        if (apiRef.current) { apiRef.current.dispose(); apiRef.current = null; }
      };
    }, [buffer]);

    function onResizeStart(ev) {
      if (window.matchMedia && window.matchMedia('(max-width: 880px)').matches) return;
      ev.preventDefault();
      var startY = ev.clientY;
      var startH = (panelRef.current && panelRef.current.getBoundingClientRect().height) || 320;
      function move(e) {
        var nh = Math.round(startH + (e.clientY - startY));
        nh = Math.max(180, Math.min(Math.round(window.innerHeight * 0.7), nh));
        setHeightPx(nh);
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try {
          var hnow = (panelRef.current && panelRef.current.getBoundingClientRect().height) || startH;
          orbit.storage.set(HEIGHT_KEY, Math.round(hnow));
        } catch (e) { /* ignore */ }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    if (!buffer) {
      return h(InviteBanner, { orbit: orbit });
    }

    var style = heightPx
      ? { height: heightPx + 'px', maxHeight: '70vh' }
      : { height: cfg.viewHeight };

    return h(React.Fragment, null,
      h(InviteBanner, { orbit: orbit }),
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
            onClick: function () { setConf(null); },
          }, '✕')
        ),
        err ? h('div', { className: 'oconf-panel__err' }, err) : null,
        h('div', { className: 'oconf-panel__host', ref: hostRef }),
        h('div', {
          className: 'oconf-panel__resize',
          title: orbit.i18n.pick({ fr: 'Glisser pour redimensionner', en: 'Drag to resize' }),
          onMouseDown: onResizeStart,
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
      '@media (max-width:880px){.oconf-panel{max-height:34vh;min-height:140px}.oconf-panel__resize{display:none!important}}',
      '.oconf-panel__bar{flex:none;display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;background:var(--bg-soft,rgba(127,127,127,.08))}',
      '.oconf-panel__title{font-size:.85rem;font-weight:700;color:var(--ink)}',
      '.oconf-panel__close{margin-left:auto;border:0;background:transparent;color:var(--muted);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:1rem}',
      '.oconf-panel__close:hover{background:var(--bg-soft-2,rgba(127,127,127,.14));color:var(--ink)}',
      '.oconf-panel__err{padding:.5rem .75rem;color:#b91c1c;font-size:.85rem}',
      '.oconf-panel__host{flex:1;min-height:0}',
      '.oconf-panel__host>div,.oconf-panel__host iframe{width:100%!important;height:100%!important}',
      '.oconf-panel__resize{flex:none;height:7px;cursor:ns-resize;background:linear-gradient(to bottom,transparent,rgba(127,127,127,.22));touch-action:none}',
      '.oconf-panel__resize:hover{background:rgba(127,127,127,.28)}',
      /* Shrink topic banner while video is open so chat keeps vertical space. */
      'body.oconf-open .chan-hero{grid-template-columns:40px 1fr;padding:.22rem .7rem;gap:.45rem;min-height:0}',
      'body.oconf-open .chan-hero__media{width:40px;height:40px;min-height:40px;border-radius:9px}',
      'body.oconf-open .chan-hero__topic{-webkit-line-clamp:1;font-size:.72rem;line-height:1.25}',
      'body.oconf-open .chan-hero__by,body.oconf-open .chan-hero__more{display:none}',
      'body.oconf-open .main__room-bg{height:min(22%,160px)!important}',
      '@media (max-width:880px){body.oconf-open .chan-hero{grid-template-columns:32px 1fr;padding:.15rem .45rem;gap:.35rem}body.oconf-open .chan-hero__media{width:32px;height:32px;min-height:32px;border-radius:8px}}',
      '.oconf-invite{flex:none;display:flex;align-items:center;gap:.65rem;padding:.4rem .75rem;border-bottom:1px solid var(--border,#333);background:color-mix(in srgb,var(--accent,#2563eb) 10%,transparent)}',
      '.oconf-invite__txt{flex:1;min-width:0;font-size:.82rem;font-weight:600;color:var(--ink)}',
      '.oconf-invite__btn{border:0;cursor:pointer;font:inherit;font-size:.78rem;font-weight:700;padding:.28rem .65rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#2563eb) 22%,transparent);color:var(--accent-d,var(--accent,#1d4ed8))}',
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
      if (String(cmd).toUpperCase() !== 'PRIVMSG') return;
      var tags = msg.tags || {};
      if (!Object.prototype.hasOwnProperty.call(tags, TAG)) return;
      var target = (msg.params && msg.params[0]) || '';
      var text = (msg.params && msg.params[1]) || '';
      var linkMatch = text.match(/https?:\/\/[^\s]+/i);
      var buf = isChannelName(target) ? target : (msg.nick || target);
      if (msg.nick && orbit.state.nick() && msg.nick.toLowerCase() === orbit.state.nick().toLowerCase()) return;
      setInvite(buf, { nick: msg.nick || '', link: linkMatch ? linkMatch[0] : publicLink(orbit, buf) });
    });

    if (cfg.hideInviteForOrbit) {
      orbit.addMessageFilter(function (m) {
        return !!(m.tags && Object.prototype.hasOwnProperty.call(m.tags, TAG));
      });
    }

    orbit.addUi('topbar_item', function () { return h(HeaderButton, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });
    orbit.addUi('overlay', function () { return h(JitsiPanel, { orbit: orbit }); });
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
    orbit.on(EVT_HIDE, function () { setConf(null); });
  });
})();
