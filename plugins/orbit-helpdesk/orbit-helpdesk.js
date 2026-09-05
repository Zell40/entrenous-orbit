/*
 * Bottom-nav shortcut for HelpServ desks (AideMoi / SignalMoi / EcoutE).
 * One tab opens a menu: talk to the bot, join the salon, open the site —
 * grouped by desk (help / report / ideas).
 *
 * config.json:
 *   "helpdesk": { "label", "title", "desks": [ { "id", "label", "title", "bot",
 *     "channel", "links": [ { "label", "url" } ] } ] }
 *   "plugins": ["/app/plugins/third/orbit-helpdesk/orbit-helpdesk.js?v=4"]
 *
 * Omit helpdesk.desks to use the EntreNous defaults.
 */
Orbit.plugin('helpdesk', (orbit, log) => {
  const { useState, useEffect } = orbit.React;
  const html = orbit.html;
  const pick = orbit.i18n.pick.bind(orbit.i18n);

  function defaultDesks() {
    return [
      {
        id: 'aide',
        label: pick({ fr: 'Aide', en: 'Help' }),
        title: pick({ fr: 'Demander de l’aide', en: 'Get help' }),
        bot: 'AideMoi',
        channel: '#Aide.chat',
        links: [
          { label: pick({ fr: 'Aide sur le site', en: 'Help on the website' }), url: 'https://www.reseau-entrenous.fr/aide/' },
        ],
      },
      {
        id: 'signal',
        label: pick({ fr: 'Signalement', en: 'Report' }),
        title: pick({ fr: 'Signaler un problème', en: 'Report a problem' }),
        bot: 'SignalMoi',
        channel: '#Signalement.chat',
        links: [
          { label: pick({ fr: 'Aide signalement', en: 'Reporting help' }), url: 'https://www.reseau-entrenous.fr/salons/salon-signalement/' },
        ],
      },
      {
        id: 'idees',
        label: pick({ fr: 'Idées', en: 'Ideas' }),
        title: pick({ fr: 'Idées et suggestions', en: 'Ideas and suggestions' }),
        bot: 'EcoutE',
        channel: '#Idees.chat',
        links: [
          { label: pick({ fr: 'Le réseau EntreNous', en: 'EntreNous website' }), url: 'https://www.reseau-entrenous.fr/' },
        ],
      },
    ];
  }

  function loadDesks() {
    const cfg = (orbit.config() && orbit.config().helpdesk) || {};
    const raw = Array.isArray(cfg.desks) ? cfg.desks : null;
    if (!raw || !raw.length) return defaultDesks();
    return raw.map((d, i) => {
      if (!d || typeof d !== 'object') return null;
      const id = String(d.id || d.bot || ('desk-' + i)).trim();
      const bot = String(d.bot || '').trim();
      const channel = String(d.channel || '').trim();
      const links = Array.isArray(d.links)
        ? d.links.filter((l) => l && l.url && /^https?:\/\//i.test(String(l.url))).map((l) => ({
          label: String(l.label || l.url),
          url: String(l.url),
        }))
        : [];
      if (!id || (!bot && !channel && !links.length)) return null;
      return {
        id,
        label: String(d.label || bot || id),
        title: String(d.title || d.label || bot || id),
        bot,
        channel,
        links,
      };
    }).filter(Boolean);
  }

  const cfg = (orbit.config() && orbit.config().helpdesk) || {};
  const desks = loadDesks();
  if (!desks.length) { log('no desks configured'); return; }
  const tabLabel = String(cfg.label || pick({ fr: 'Aide', en: 'Help' }));
  const tabTitle = String(cfg.title || pick({ fr: 'Aide, signalement, idées', en: 'Help, report, ideas' }));

  const css = document.createElement('style');
  css.textContent = [
    '.hdk-panel{position:relative;overflow:visible}',
    '.hdk-panel__bar{display:flex;justify-content:flex-end;margin:-4px -4px 2px}',
    '.hdk-panel__x{border:0;background:transparent;color:var(--muted,#888);cursor:pointer;font-size:15px;width:28px;height:28px;border-radius:8px;line-height:1}',
    '.hdk-panel__x:hover,.hdk-panel__x:focus-visible{background:color-mix(in srgb,var(--ink,#111) 10%,transparent);color:var(--ink,#111);outline:none}',
    '.hdk-sec{border-radius:12px;padding:8px;margin-top:8px;border:1px solid transparent}',
    '.hdk-sec:first-child{margin-top:0}',
    '.hdk-head{display:flex;align-items:center;gap:6px;padding:1px 4px 5px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}',
    '.hdk-sec--aide{background:color-mix(in srgb,#2563eb 12%,var(--bg,#fff));border-color:color-mix(in srgb,#2563eb 32%,transparent)}',
    '.hdk-sec--aide .hdk-head{color:#1d4ed8}',
    '.hdk-sec--signal{background:color-mix(in srgb,#e11d48 11%,var(--bg,#fff));border-color:color-mix(in srgb,#e11d48 32%,transparent)}',
    '.hdk-sec--signal .hdk-head{color:#be123c}',
    '.hdk-sec--idees{background:color-mix(in srgb,#d97706 13%,var(--bg,#fff));border-color:color-mix(in srgb,#d97706 36%,transparent)}',
    '.hdk-sec--idees .hdk-head{color:#b45309}',
    '.hdk-row{display:flex;flex-direction:column;gap:1px;padding:.45rem .55rem;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;width:100%;text-decoration:none;transition:background .12s ease,box-shadow .12s ease}',
    '.hdk-row:hover,.hdk-row:focus-visible{outline:none;box-shadow:inset 3px 0 0 currentColor}',
    '.hdk-sec--aide .hdk-row:hover,.hdk-sec--aide .hdk-row:focus-visible{background:color-mix(in srgb,#2563eb 22%,transparent);color:#1d4ed8}',
    '.hdk-sec--signal .hdk-row:hover,.hdk-sec--signal .hdk-row:focus-visible{background:color-mix(in srgb,#e11d48 20%,transparent);color:#be123c}',
    '.hdk-sec--idees .hdk-row:hover,.hdk-sec--idees .hdk-row:focus-visible{background:color-mix(in srgb,#d97706 22%,transparent);color:#b45309}',
  ].join('');
  document.head.appendChild(css);

  const store = { open: false, anchor: null, subs: new Set() };
  function notify() { store.subs.forEach((f) => f()); }
  function useStore() {
    const [, set] = useState(0);
    useEffect(() => {
      const f = () => set((x) => x + 1);
      store.subs.add(f);
      return () => store.subs.delete(f);
    }, []);
    return store;
  }

  orbit.on('orbit:panel', (id) => {
    if (id !== 'helpdesk' && store.open) { store.open = false; notify(); }
  });

  function closeMenu() { store.open = false; notify(); }

  function openQuery(nick) {
    const st = orbit.state.get();
    if (st && typeof st.openQuery === 'function') st.openQuery(nick);
    else orbit.irc.msg(nick, '');
  }
  function goBot(desk) {
    if (!desk.bot) return;
    openQuery(desk.bot);
    try { orbit.emit('helpserv:welcome', desk.bot); } catch (e) { /* ignore */ }
    closeMenu();
  }
  function goChan(desk) {
    if (!desk.channel) return;
    orbit.irc.join(desk.channel);
    closeMenu();
  }

  function IconAide() {
    return html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 2-2.9 2.2-2.9 4" />
      <circle cx="12" cy="17.1" r=".7" fill="currentColor" stroke="none" />
    </svg>`;
  }
  function IconSignal() {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 21V4" /><path d="M5 4h12l-2.2 3.6L17 11H5" />
    </svg>`;
  }
  function IconIdees() {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6" /><path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 1 3.4 10.8c-.6.5-1.4 1.6-1.4 2.7h-4c0-1.1-.8-2.2-1.4-2.7A6 6 0 0 1 12 3z" />
    </svg>`;
  }
  function IconHelpSm() {
    return html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 2-2.9 2.2-2.9 4" />
      <circle cx="12" cy="17.1" r=".7" fill="currentColor" stroke="none" />
    </svg>`;
  }
  const SEC_ICONS = { aide: IconHelpSm, signal: IconSignal, idees: IconIdees };

  function HelpTab() {
    const s = useStore();
    return html`<button className=${'tab' + (s.open ? ' is-active' : '')} title=${tabTitle} aria-label=${tabTitle} aria-expanded=${s.open}
      onClick=${(e) => {
        s.anchor = e.currentTarget.getBoundingClientRect();
        s.open = !s.open;
        if (s.open) orbit.emit('orbit:panel', 'helpdesk');
        notify();
      }}>
      <span className="tab__ic"><${IconAide} /></span>
      <span className="tab__lb">${tabLabel}</span>
    </button>`;
  }

  function MenuRow({ title, sub, onClick, href }) {
    const inner = html`<span style=${{ fontWeight: 700, fontSize: '12.5px' }}>${title}</span>
      ${sub ? html`<small className="hdk-row__sub" style=${{ fontSize: '10.5px', opacity: .75 }}>${sub}</small>` : null}`;
    if (href) {
      return html`<a className="hdk-row" href=${href} target="_blank" rel="noopener noreferrer" onClick=${() => closeMenu()}>${inner}</a>`;
    }
    return html`<button className="hdk-row" type="button" onClick=${onClick}>${inner}</button>`;
  }

  function DeskBlock({ desk }) {
    const Ic = SEC_ICONS[desk.id] || IconHelpSm;
    const tone = (desk.id === 'signal' || desk.id === 'idees') ? desk.id : 'aide';
    return html`<div className=${'hdk-sec hdk-sec--' + tone}>
      <div className="hdk-head">
        <span style=${{ display: 'inline-flex' }}><${Ic} /></span>
        <span>${desk.label}</span>
      </div>
      ${desk.bot ? html`<${MenuRow} title=${pick({ fr: 'Discuter avec ' + desk.bot, en: 'Chat with ' + desk.bot })}
        sub=${pick({ fr: 'Message privé', en: 'Private message' })}
        onClick=${() => goBot(desk)} />` : null}
      ${desk.channel ? html`<${MenuRow} title=${pick({ fr: 'Rejoindre ' + desk.channel, en: 'Join ' + desk.channel })}
        onClick=${() => goChan(desk)} />` : null}
      ${desk.links.map((l) => html`<${MenuRow} key=${l.url} title=${l.label} href=${l.url} />`)}
    </div>`;
  }

  function HelpPanel() {
    const s = useStore();
    if (!s.open) return null;
    const A = s.anchor, W = window.innerWidth, H = window.innerHeight, PW = Math.min(300, W * 0.92);
    const pos = A
      ? { left: Math.round(Math.min(Math.max(A.left + A.width / 2 - PW / 2, 8), W - PW - 8)) + 'px', bottom: Math.round(H - A.top + 10) + 'px' }
      : { right: '14px', bottom: '74px' };
    return html`<div>
      <div style=${{ position: 'fixed', inset: 0, zIndex: 59 }} onClick=${closeMenu}></div>
      <div className="hdk-panel" role="menu" aria-label=${tabLabel} style=${{
        position: 'fixed', ...pos, zIndex: 60, width: PW + 'px',
        background: 'var(--bg,#15151a)', color: 'var(--ink,#eee)',
        border: '1px solid var(--border,#333)', borderRadius: '16px',
        boxShadow: '0 20px 50px -12px rgba(0,0,0,.55), 0 3px 10px -3px rgba(0,0,0,.35)',
        padding: '12px', animation: 'rise .18s ease both',
      }}>
        <div className="hdk-panel__bar">
          <button className="hdk-panel__x" type="button" onClick=${closeMenu} aria-label=${pick({ fr: 'Fermer', en: 'Close' })}>✕</button>
        </div>
        <div style=${{ display: 'flex', flexDirection: 'column' }}>
          ${desks.map((d) => html`<${DeskBlock} key=${d.id} desk=${d} />`)}
        </div>
      </div>
    </div>`;
  }

  orbit.addUi('nav_item', () => html`<${HelpTab} />`);
  orbit.addUi('overlay', () => html`<${HelpPanel} />`);
  log('ready (' + desks.map((d) => d.id).join(', ') + ')');
});
