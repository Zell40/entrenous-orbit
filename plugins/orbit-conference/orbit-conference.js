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

  var conf = { active: false, buffer: '', listeners: new Set() };
  function subscribeConf(cb) { conf.listeners.add(cb); return function () { conf.listeners.delete(cb); }; }
  function getConfSnap() { return conf.active ? conf.buffer : ''; }
  var lastViewHeight = '42%';

  function setConf(buffer) {
    conf.active = !!buffer;
    conf.buffer = buffer || '';
    document.body.classList.toggle('oconf-open', !!buffer);
    if (buffer) document.documentElement.style.setProperty('--oconf-h', lastViewHeight);
    else document.documentElement.style.removeProperty('--oconf-h');
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
      viewHeight: c.viewHeight || '42%',
      inviteText: c.inviteText || '{{ nick }} vous invite à un appel vidéo.',
      joinText: c.joinText || '{{ nick }} a rejoint la conférence.',
      joinButtonText: c.joinButtonText || 'Rejoindre',
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
    var list = (cfg.enabledInChannels || ['*']).map(function (x) { return String(x).toLowerCase(); });
    if (list.indexOf('*') > -1) return true;
    return list.indexOf(String(name).toLowerCase()) > -1;
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

  function openConference(orbit, buffer) {
    if (!bufferAllowed(orbit, buffer)) return;
    if (conf.active && conf.buffer === buffer) {
      setConf(null);
      orbit.emit(EVT_HIDE);
      return;
    }
    if (conf.active && conf.buffer !== buffer) {
      var msg = orbit.i18n.pick({ fr: 'Fermer la conférence en cours ?', en: 'Close the current conference?' });
      if (!window.confirm(msg)) return;
    }
    setConf(buffer);
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

  function HeaderButton(props) {
    var orbit = props.orbit;
    var activeBuf = useActiveBuffer(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    if (!bufferAllowed(orbit, activeBuf)) return null;
    var on = openBuf === activeBuf;
    return h('button', {
      type: 'button',
      className: 'topbar__search' + (on ? ' is-on' : ''),
      title: orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }),
      'aria-label': orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' }),
      'aria-pressed': on,
      onClick: function () { openConference(orbit, activeBuf); },
    }, h('svg', {
      viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none',
      stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, h('path', { d: 'M15.5 10.5 20 8v8l-4.5-2.5' }), h('rect', { x: 3, y: 7, width: 12.5, height: 10, rx: 2.2 })));
  }

  function JoinCard(props) {
    var orbit = props.orbit;
    var m = props.m;
    var cfg = confCfg(orbit);
    var openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    var buf = m.buffer || orbit.state.active();
    if (openBuf) return null;
    if (!bufferAllowed(orbit, buf)) return null;
    return h('span', { className: 'oconf-join' },
      h('button', {
        type: 'button',
        className: 'oconf-join__btn',
        onClick: function () { openConference(orbit, buf); },
      }, '📹 ' + (cfg.joinButtonText || 'Rejoindre'))
    );
  }

  function JitsiPanel(props) {
    var orbit = props.orbit;
    var buffer = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
    var hostRef = useRef(null);
    var apiRef = useRef(null);
    var joinedState = useState(false);
    var joined = joinedState[0];
    var setJoined = joinedState[1];
    var errState = useState('');
    var err = errState[0];
    var setErr = errState[1];
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
      var tagId = live.tagID || '1';
      var inviteTpl = isChannelName(buffer) ? (live.joinText || '') : (live.inviteText || '');

      function mountApi(jwt) {
        if (cancelled || !host || !window.JitsiMeetExternalAPI) return;
        try {
          var api = new window.JitsiMeetExternalAPI(domain, {
            roomName: room,
            parentNode: host,
            width: '100%',
            height: '100%',
            jwt: jwt || undefined,
            configOverwrite: {
              startWithAudioMuted: true,
              startWithVideoMuted: true,
              prejoinConfig: { enabled: false },
              prejoinPageEnabled: false,
              disableDeepLinking: true,
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
            onload: function () {
              api.executeCommand('displayName', nick);
              api.executeCommand('subject', ' ');
              api.once('videoConferenceJoined', function () {
                if (cancelled) return;
                setJoined(true);
                var text = '* ' + inviteTpl.replace(/\{\{\s*nick\s*\}\}/g, nick);
                if (orbit.irc.msgTagged) {
                  var tags = {};
                  tags[TAG] = tagId;
                  orbit.irc.msgTagged(buffer, text, tags);
                } else {
                  orbit.irc.msg(buffer, text);
                }
              });
              api.once('videoConferenceLeft', function () {
                if (!cancelled) setConf(null);
              });
            },
          });
          apiRef.current = api;
        } catch (e) {
          setErr(String(e));
        }
      }

      var existing = document.querySelector('script[data-oconf="' + domain + '"]');
      var timers = [];

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

    if (!buffer) return null;

    return h('div', { className: 'oconf-panel', style: { height: cfg.viewHeight } },
      h('div', { className: 'oconf-panel__bar' },
        h('strong', { className: 'oconf-panel__title' },
          joined ? roomNameFor(orbit, buffer) : orbit.i18n.pick({ fr: 'Connexion…', en: 'Connecting…' })
        ),
        h('button', {
          type: 'button',
          className: 'oconf-panel__close',
          'aria-label': 'Close',
          onClick: function () { setConf(null); },
        }, '✕')
      ),
      err ? h('div', { className: 'oconf-panel__err' }, err) : null,
      h('div', { className: 'oconf-panel__host', ref: hostRef })
    );
  }

  function injectStyles() {
    if (document.getElementById('orbit-conference-css')) return;
    var el = document.createElement('style');
    el.id = 'orbit-conference-css';
    el.textContent = [
      '.oconf-panel{position:fixed;left:248px;right:0;top:0;z-index:55;display:flex;flex-direction:column;background:var(--bg,#111);border-bottom:1px solid var(--border,#333);box-shadow:0 8px 28px -16px rgba(0,0,0,.45)}',
      '@media (max-width:880px){.oconf-panel{left:0}}',
      'body.oconf-open .app>.main{padding-top:var(--oconf-h,42%)}',
      '.oconf-panel__bar{flex:none;display:flex;align-items:center;gap:.6rem;padding:.35rem .75rem;background:var(--bg-soft,rgba(127,127,127,.08))}',
      '.oconf-panel__title{font-size:.85rem;font-weight:700;color:var(--ink)}',
      '.oconf-panel__close{margin-left:auto;border:0;background:transparent;color:var(--muted);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:1rem}',
      '.oconf-panel__close:hover{background:var(--bg-soft-2,rgba(127,127,127,.14));color:var(--ink)}',
      '.oconf-panel__err{padding:.5rem .75rem;color:#b91c1c;font-size:.85rem}',
      '.oconf-panel__host{flex:1;min-height:0}',
      '.oconf-panel__host>div,.oconf-panel__host iframe{width:100%!important;height:100%!important}',
      '.oconf-join{display:inline-flex;margin-left:.45rem;vertical-align:middle}',
      '.oconf-join__btn{border:0;cursor:pointer;font:inherit;font-size:.78rem;font-weight:700;padding:.28rem .65rem;border-radius:999px;background:color-mix(in srgb,var(--accent,#2563eb) 18%,transparent);color:var(--accent-d,var(--accent,#1d4ed8))}',
      '.oconf-join__btn:hover{filter:brightness(1.05)}',
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

    // Topbar (desktop) + composer (mobile / always visible) — same control.
    orbit.addUi('topbar_item', function () { return h(HeaderButton, { orbit: orbit }); });
    orbit.addUi('composer_button', function () { return h(HeaderButton, { orbit: orbit }); });
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
