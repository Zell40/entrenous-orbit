import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConferenceConfig, MessageInfo, OrbitPluginApi } from './orbit';

const TAG = '+entrenous.fr/conference';
const EVT_SHOW = 'plugin-conference.show';
const EVT_HIDE = 'plugin-conference.hide';

type ConfState = {
  active: boolean;
  buffer: string;
  listeners: Set<() => void>;
};

const conf: ConfState = {
  active: false,
  buffer: '',
  listeners: new Set(),
};

function subscribeConf(cb: () => void) {
  conf.listeners.add(cb);
  return () => { conf.listeners.delete(cb); };
}
function getConfSnap() {
  return conf.active ? conf.buffer : '';
}
function setConf(buffer: string | null) {
  conf.active = !!buffer;
  conf.buffer = buffer || '';
  conf.listeners.forEach((l) => l());
}

function confCfg(orbit: OrbitPluginApi): Required<Pick<ConferenceConfig, 'server' | 'secure' | 'tagID' | 'channels' | 'queries' | 'viewHeight'>> & ConferenceConfig {
  const c = orbit.config().conference || {};
  return {
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
}

function isChannelName(name: string) {
  return /^[#&+!]/.test(name);
}

function bufferAllowed(orbit: OrbitPluginApi, name: string) {
  const cfg = confCfg(orbit);
  if (!name || name === 'Status') return false;
  const chan = isChannelName(name);
  if (chan && !cfg.channels) return false;
  if (!chan && !cfg.queries) return false;
  if (!chan) return true;
  const list = (cfg.enabledInChannels || ['*']).map((x) => x.toLowerCase());
  if (list.includes('*')) return true;
  return list.includes(name.toLowerCase());
}

function roomNameFor(orbit: OrbitPluginApi, buffer: string) {
  const nick = orbit.state.nick() || 'user';
  if (isChannelName(buffer)) return buffer;
  const members = [nick, buffer].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return `query-${members.join('+')}`;
}

function encodedRoom(orbit: OrbitPluginApi, buffer: string) {
  const net = orbit.server.network() || 'entrenous';
  const room = `${net}/${roomNameFor(orbit, buffer)}`;
  return [...room].map((c) => c.charCodeAt(0).toString(16)).join('');
}

function openConference(orbit: OrbitPluginApi, buffer: string) {
  if (!bufferAllowed(orbit, buffer)) return;
  if (conf.active && conf.buffer === buffer) {
    setConf(null);
    orbit.emit(EVT_HIDE);
    return;
  }
  if (conf.active && conf.buffer !== buffer) {
    if (!window.confirm(orbit.i18n.pick({
      fr: 'Fermer la conférence en cours ?',
      en: 'Close the current conference?',
    }))) return;
  }
  setConf(buffer);
  orbit.emit(EVT_SHOW, { buffer });
}

function useActiveBuffer(orbit: OrbitPluginApi) {
  return useSyncExternalStore(
    (cb) => {
      const off = orbit.on('buffer.active', cb);
      const id = window.setInterval(cb, 400);
      return () => { off(); window.clearInterval(id); };
    },
    () => orbit.state.active(),
    () => orbit.state.active(),
  );
}

// ── Topbar button ───────────────────────────────────────────────────────────
function HeaderButton({ orbit }: { orbit: OrbitPluginApi }) {
  const activeBuf = useActiveBuffer(orbit);
  const openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
  if (!bufferAllowed(orbit, activeBuf)) return null;
  const on = openBuf === activeBuf;
  return (
    <button
      type="button"
      className={`topbar__search ${on ? 'is-on' : ''}`}
      title={orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' })}
      aria-label={orbit.i18n.pick({ fr: 'Conférence vidéo', en: 'Video conference' })}
      aria-pressed={on}
      onClick={() => openConference(orbit, activeBuf)}
    >
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15.5 10.5 20 8v8l-4.5-2.5" />
        <rect x="3" y="7" width="12.5" height="10" rx="2.2" />
      </svg>
    </button>
  );
}

// ── Join card in chat ───────────────────────────────────────────────────────
function JoinCard({ orbit, m }: { orbit: OrbitPluginApi; m: MessageInfo }) {
  const cfg = confCfg(orbit);
  const openBuf = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
  const buf = m.buffer || orbit.state.active();
  if (openBuf) return null;
  if (!bufferAllowed(orbit, buf)) return null;
  const label = (isChannelName(buf) ? cfg.joinButtonText : cfg.joinButtonText) || 'Rejoindre';
  return (
    <span className="oconf-join">
      <button type="button" className="oconf-join__btn" onClick={() => openConference(orbit, buf)}>
        📹 {label}
      </button>
    </span>
  );
}

// ── Jitsi panel (overlay) ───────────────────────────────────────────────────
declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, opts: Record<string, unknown>) => {
      dispose: () => void;
      executeCommand: (cmd: string, ...args: unknown[]) => void;
      once: (event: string, fn: () => void) => void;
    };
  }
}

function JitsiPanel({ orbit }: { orbit: OrbitPluginApi }) {
  const buffer = useSyncExternalStore(subscribeConf, getConfSnap, getConfSnap);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ dispose: () => void } | null>(null);
  const [joined, setJoined] = useState(false);
  const [err, setErr] = useState('');
  const cfg = confCfg(orbit);

  useEffect(() => {
    if (!buffer || !hostRef.current) return;
    let cancelled = false;
    const host = hostRef.current;
    host.innerHTML = '';
    setJoined(false);
    setErr('');

    const live = confCfg(orbit);
    const domain = live.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const room = encodedRoom(orbit, buffer);
    const nick = orbit.state.nick() || 'user';
    const tagId = live.tagID || '1';
    const inviteTpl = isChannelName(buffer) ? (live.joinText || '') : (live.inviteText || '');

    function mountApi(jwt?: string) {
      if (cancelled || !host || !window.JitsiMeetExternalAPI) return;
      try {
        const api = new window.JitsiMeetExternalAPI(domain, {
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
          onload: () => {
            api.executeCommand('displayName', nick);
            api.executeCommand('subject', ' ');
            api.once('videoConferenceJoined', () => {
              if (cancelled) return;
              setJoined(true);
              const text = `* ${inviteTpl.replace(/\{\{\s*nick\s*\}\}/g, nick)}`;
              orbit.irc.msgTagged(buffer, text, { [TAG]: tagId });
            });
            api.once('videoConferenceLeft', () => {
              if (!cancelled) setConf(null);
            });
          },
        });
        apiRef.current = api;
      } catch (e) {
        setErr(String(e));
      }
    }

    const existing = document.querySelector(`script[data-oconf="${domain}"]`) as HTMLScriptElement | null;

    if (live.secure) {
      const off = orbit.on('raw', (msg: unknown) => {
        const m = msg as { command?: string; params?: string[] };
        if (String(m.command || '').toUpperCase() !== 'EXTJWT') return;
        const token = m.params?.[m.params.length - 1];
        if (!token || token.length < 20) return;
        off();
        mountApi(token);
      });
      orbit.irc.send(`EXTJWT ${roomNameFor(orbit, buffer)}`);
      const t = window.setTimeout(() => { off(); if (!cancelled) mountApi(); }, 4000);
      return () => { cancelled = true; window.clearTimeout(t); off(); apiRef.current?.dispose(); apiRef.current = null; };
    }

    const start = () => mountApi();
    if (window.JitsiMeetExternalAPI) {
      start();
    } else if (existing) {
      existing.addEventListener('load', start);
    } else {
      const scr = document.createElement('script');
      scr.src = `https://${domain}/external_api.js`;
      scr.async = true;
      scr.dataset.oconf = domain;
      scr.onload = start;
      scr.onerror = () => setErr(`Impossible de charger Jitsi (${domain}).`);
      document.head.appendChild(scr);
    }

    return () => {
      cancelled = true;
      apiRef.current?.dispose();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only when the open buffer changes
  }, [buffer]);

  if (!buffer) return null;

  return (
    <div className="oconf-panel" style={{ height: cfg.viewHeight }}>
      <div className="oconf-panel__bar">
        <strong className="oconf-panel__title">
          {joined ? roomNameFor(orbit, buffer) : orbit.i18n.pick({ fr: 'Connexion…', en: 'Connecting…' })}
        </strong>
        <button type="button" className="oconf-panel__close" onClick={() => setConf(null)} aria-label="Close">✕</button>
      </div>
      {err && <div className="oconf-panel__err">{err}</div>}
      <div className="oconf-panel__host" ref={hostRef} />
    </div>
  );
}

function injectStyles() {
  if (document.getElementById('orbit-conference-css')) return;
  const el = document.createElement('style');
  el.id = 'orbit-conference-css';
  el.textContent = `
.oconf-panel {
  position: fixed; left: 248px; right: 0; bottom: 0; z-index: 55;
  display: flex; flex-direction: column;
  background: var(--bg, #111); border-top: 1px solid var(--border, #333);
  box-shadow: 0 -8px 28px -16px rgba(0,0,0,.45);
}
@media (max-width: 880px) {
  .oconf-panel { left: 0; }
}
.app.app--nomembers .oconf-panel { right: 0; }
.oconf-panel__bar {
  flex: none; display: flex; align-items: center; gap: .6rem;
  padding: .35rem .75rem; background: var(--bg-soft, rgba(127,127,127,.08));
}
.oconf-panel__title { font-size: .85rem; font-weight: 700; color: var(--ink); }
.oconf-panel__close {
  margin-left: auto; border: 0; background: transparent; color: var(--muted);
  width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 1rem;
}
.oconf-panel__close:hover { background: var(--bg-soft-2, rgba(127,127,127,.14)); color: var(--ink); }
.oconf-panel__err { padding: .5rem .75rem; color: #b91c1c; font-size: .85rem; }
.oconf-panel__host { flex: 1; min-height: 0; }
.oconf-panel__host > div, .oconf-panel__host iframe { width: 100% !important; height: 100% !important; }
.oconf-join { display: inline-flex; margin-left: .45rem; vertical-align: middle; }
.oconf-join__btn {
  border: 0; cursor: pointer; font: inherit; font-size: .78rem; font-weight: 700;
  padding: .28rem .65rem; border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #2563eb) 18%, transparent);
  color: var(--accent-d, var(--accent, #1d4ed8));
}
.oconf-join__btn:hover { filter: brightness(1.05); }
.topbar__search.is-on { background: var(--accent-soft, rgba(20,82,204,.14)); color: var(--accent-d, var(--accent)); }
`;
  document.head.appendChild(el);
}

Orbit.plugin('orbit-conference', (orbit, log) => {
  if (orbit.apiVersion < 7) {
    log('Orbit apiVersion >= 7 required (msgTagged + message tags).');
  }
  injectStyles();
  const cfg = confCfg(orbit);
  log(`conference → ${cfg.server} (tag ${TAG}=${cfg.tagID})`);

  orbit.addUi('topbar_item', () => <HeaderButton orbit={orbit} />);
  orbit.addUi('composer_button', () => <HeaderButton orbit={orbit} />);
  orbit.addUi('overlay', () => <JitsiPanel orbit={orbit} />);

  orbit.addMessageDecorator((m) => {
    if (!m.tags || !(TAG in m.tags)) return null;
    return <JoinCard orbit={orbit} m={m} />;
  });

  orbit.addCommand('visio', {
    help: 'Ouvre / ferme la conférence vidéo du canal ou MP actif',
    run: () => {
      const buf = orbit.state.active();
      if (!buf || buf === 'Status') {
        orbit.notify('Visio', 'Ouvre un canal ou un MP d’abord.');
        return;
      }
      openConference(orbit, buf);
    },
  });

  orbit.on(EVT_HIDE, () => setConf(null));
});
