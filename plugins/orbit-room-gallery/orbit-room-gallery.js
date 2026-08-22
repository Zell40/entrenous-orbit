/*
 * Orbit room gallery — a 100% plugin replacement for the built-in "Explorer
 * les salons" window: same search/sort/join/create-channel behaviour, plus a
 * grid view and a channel founder's picture on each tile/row. The founder
 * sets that picture from "Gérer mon chan" → Aperçu, just below "Accès & mot
 * de passe" — always restricted to +q, same as every other control there.
 * Once set, that same picture also replaces the default "#" tile in the
 * channel's topic banner and in its row in the sidebar's list of open rooms —
 * see syncChannelPictures() near the bottom. The topbar keeps the classic "#"
 * glyph. Setting or clearing a picture
 * also posts a "/me a mis à jour l'image du salon : <url>" line in the
 * channel itself (announcePictureChange()) so members actually notice —
 * unlike the picture's storage (see below), this line DOES travel over IRC
 * like any other message, by design.
 *
 * Nothing here patches, wraps, or imports any core Orbit file — it only uses
 * the public window.Orbit plugin API. Two bits of behaviour aren't covered by
 * an official extension point (there's no "modal replacement" or "inject
 * into ChanAdminModal" hook — see docs/PLUGINS.md's UiSlot list), so this
 * plugin does them itself, defensively, right at the bottom of this file:
 *
 *   1. Whenever the app is about to show its native Explore modal (sidebar
 *      button, the "aucun salon" CTA, or typing `/list`), this plugin notices
 *      the shared `modal` state flip to 'explore' and swaps in its own
 *      window instead — so there's still only ONE "browse rooms" entry
 *      point, it just happens to be plugin-rendered. For the two DOM buttons
 *      specifically, it also binds its own click listener straight on them
 *      (see interceptExploreButtons below) so the native modal never even
 *      mounts for a frame — belt-and-suspenders against a rare LIST/LIST
 *      race that briefly showed a stuck refresh spinner.
 *   2. Whenever "Gérer mon chan" is open on its Aperçu tab, this plugin finds
 *      the "Accès & mot de passe" section by its (translated) heading and
 *      inserts a small picture-picker section right after it, built with
 *      plain DOM calls (no React tree of ours to reconcile against Orbit's).
 *   3. Every frame, this plugin also looks for the currently open channel's
 *      topbar avatar (`.topbar--channel .topbar__av`) and every sidebar
 *      channel row's avatar (`.room__av`, found via its `.room__hash` child)
 *      and, if that channel has a picture, mutates just their `style`/a
 *      `data-rg-pic` attribute in place — never their childNodes — so this
 *      can never conflict with React's own reconciliation of those elements.
 *
 * All three watch read-only-ish state/DOM and gracefully do nothing extra if
 * a future Orbit version renames the 'explore' modal key or changes the
 * admin modal's/topbar's/sidebar's markup — the native UI keeps working
 * exactly as it does out of the box. This means the whole feature survives
 * an Orbit core update/reinstall untouched: drop this single file back in
 * and it keeps working.
 *
 * A channel's picture URL itself never travels over IRC (no topic tricks, no
 * trace for KiwiIRC/irssi/any other client to see). It lives in a tiny
 * same-origin companion endpoint — see ./room-images.php in this folder —
 * that only accepts a write when the caller proves, via a channel-scoped
 * EXTJWT (https://www.unrealircd.org/docs/Extjwt_block) signed by the ircd
 * itself, that they currently hold the founder mode on that channel. The
 * picture file itself is uploaded straight to that same endpoint in the same
 * authenticated request — it is NOT routed through the app's core
 * /FILEHOST -> /upload pipeline (the one the composer's image button uses):
 * that pipeline expects an operator-run IRC bot answering a bespoke
 * `FILEHOST` command, which most ircds don't have, so it just times out.
 *
 * Configure in config.json:
 *   "plugins": ["/app/plugins/third/orbit-room-gallery/orbit-room-gallery.js"]
 *
 * And deploy this folder's room-images.php next to the JS (see README).
 * Until the PHP is reachable, the gallery still works (grid/list browsing),
 * just without pictures. To point at a non-default location, edit
 * ROOM_IMAGES_ENDPOINT below.
 */
Orbit.plugin('room-gallery', (orbit, log) => {
  const { useState, useEffect, useRef } = orbit.React;
  const html = orbit.html;
  const t = orbit.i18n.t; // reuse the core's own modals.join.* strings (already in all 10 locales)

  // Sibling PHP in this same deployed folder (Orbit base is /app/).
  const ROOM_IMAGES_ENDPOINT = '/app/plugins/third/orbit-room-gallery/room-images.php';
  // Display prefix for "channel founder" on most networks (UnrealIRCd,
  // Anope/Atheme default config) — used only to decide whether to *show* the
  // picture button; the real authorization check happens server-side against
  // the EXTJWT's signed `cmodes` claim, not this.
  const FOUNDER_PREFIX = '~';
  const MAX_BYTES = 8 * 1024 * 1024; // client-side courtesy cap; the uploader has its own limit too

  function hashHue(seed) { let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360; return h; }
  function avatarBg(seed) { const h = hashHue(seed); return `linear-gradient(140deg, hsl(${h},62%,55%), hsl(${(h + 40) % 360},58%,46%))`; }
  function stripMirc(s) {
    return (s || '').replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '').replace(/[\x02\x1D\x1F\x16\x0F]/g, '');
  }
  function amFounder(chan) {
    const st = orbit.state.get();
    const m = st.buffers[chan] && st.buffers[chan].members[st.nick];
    const pfx = (m && (m.prefixes || m.prefix)) || '';
    return pfx.indexOf(FOUNDER_PREFIX) !== -1;
  }

  // ---- shared, lazily-loaded "channel -> image url" map (from the endpoint) ----
  // IRC channel names are case-insensitive: the buffer name a founder sees
  // while setting a picture ("#MonChan") and the name a LIST reply reports
  // for the same channel ("#monchan") aren't guaranteed to be spelled with
  // the same case. imageMap is always keyed in lowercase (server-side,
  // room-images.php now does the same) so every lookup below normalizes too
  // — otherwise a freshly-set picture can silently never match anywhere.
  const normChan = (name) => (name || '').toLowerCase();
  let imageMap = {};
  let mapLoaded = false;
  const mapListeners = new Set();
  const MAP_CACHE_KEY = 'orbit-rg-map';

  function announceImagesReady() {
    mapLoaded = true;
    try { window.__orbitRoomImagesReady = true; } catch (e) { /* ignore */ }
    try { orbit.emit('room-images-ready'); } catch (e) { /* ignore */ }
    mapListeners.forEach((f) => f());
  }

  function writeCachedMap(map) {
    try { localStorage.setItem(MAP_CACHE_KEY, JSON.stringify({ ts: Date.now(), map: map || {} })); }
    catch (e) { /* quota / private */ }
  }

  function hydrateCachedMap() {
    try {
      const j = JSON.parse(localStorage.getItem(MAP_CACHE_KEY) || 'null');
      if (!j || !j.map || typeof j.map !== 'object' || Array.isArray(j.map)) return false;
      const norm = {};
      for (const k of Object.keys(j.map)) {
        if (typeof j.map[k] === 'string' && j.map[k]) norm[normChan(k)] = j.map[k];
      }
      imageMap = norm;
      announceImagesReady();
      return true;
    } catch (e) { return false; }
  }

  function warmImageCache(map) {
    const urls = Object.values(map || {}).filter((u) => typeof u === 'string' && /^https?:/i.test(u));
    for (let i = 0; i < urls.length && i < 40; i++) {
      const img = new Image();
      img.decoding = 'async';
      img.src = urls[i];
    }
  }

  async function loadImageMap(force) {
    if (mapLoaded && !force) return imageMap;
    try {
      const res = await fetch(ROOM_IMAGES_ENDPOINT, { credentials: 'omit', cache: 'no-store' });
      if (res.ok) {
        const raw = await res.json();
        const norm = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const k of Object.keys(raw)) norm[normChan(k)] = raw[k];
        }
        imageMap = norm;
        writeCachedMap(norm);
        warmImageCache(norm);
      } else {
        log('room-images GET failed', res.status);
      }
    } catch (e) { log('room-images fetch failed', e); }
    announceImagesReady();
    return imageMap;
  }
  // Seed / clear one channel in the in-memory map immediately (used after a
  // successful upload/remove so the topbar/sidebar/gallery update even before
  // the next GET round-trip — and even if that GET were somehow stale).
  function setLocalImage(channel, url) {
    const k = normChan(channel);
    if (url) imageMap[k] = url; else delete imageMap[k];
    mapLoaded = true;
    writeCachedMap(imageMap);
    mapListeners.forEach((f) => f());
  }
  function useImageMap() {
    const [, setN] = useState(0);
    useEffect(() => {
      const f = () => setN((x) => x + 1);
      mapListeners.add(f);
      // Always force-refresh on mount: this map can change at any time from
      // any other tab/session, and it's tiny — correctness here matters more
      // than saving one small fetch.
      loadImageMap(true);
      return () => mapListeners.delete(f);
    }, []);
    return imageMap;
  }

  // ---- identity proof: channel-scoped EXTJWT (the ircd signs the requester's cmodes) ----
  // The token often doesn't fit in one IRC line: InspIRCd's ircv3_extjwt
  // module (see CommandExtJWT::HandleLocal in inspircd-contrib's
  // 4/m_ircv3_extjwt.cpp) splits it into 200-char chunks across several
  // EXTJWT messages when needed — a very common case here, since the
  // payload (exp/iss/sub/account/umodes/channel/joined/cmodes) routinely
  // exceeds that. Each message is either:
  //   :server EXTJWT <chan> <service|*> * <chunk>   (4 params — more to come)
  //   :server EXTJWT <chan> <service|*> <chunk>     (3 params — final chunk)
  // Taking only the first message (as this used to do) silently produces a
  // truncated token that fails signature verification server-side — the
  // exact "Vérification d'identité invalide" bug this fixes.
  function requestChannelJwt(channel) {
    return new Promise((resolve, reject) => {
      let off;
      let acc = '';
      const timer = setTimeout(() => { off && off(); log('EXTJWT: no matching reply within 10s for', channel); reject(new Error('jwt_timeout')); }, 10000);
      off = orbit.on('raw', (msg) => {
        const p0 = (msg.params && msg.params[0]) || '';
        const p1 = (msg.params && msg.params[1]) || '';
        if (msg.command === '421' && p1.toUpperCase() === 'EXTJWT') { clearTimeout(timer); off(); reject(new Error('extjwt_unsupported')); }
        else if (msg.command === '403' && p1.toLowerCase() === channel.toLowerCase()) { clearTimeout(timer); off(); reject(new Error('no_such_channel')); }
        else if (msg.command === 'EXTJWT' && p0.toLowerCase() === channel.toLowerCase()) {
          const params = msg.params || [];
          const moreComing = params.length >= 4 && params[2] === '*';
          acc += params[params.length - 1] || '';
          if (moreComing) return; // wait for the remaining chunk(s)
          clearTimeout(timer); off(); resolve(acc);
        }
      });
      orbit.irc.send(`EXTJWT ${channel}`);
    });
  }

  // ---- register / clear a channel's picture on the companion endpoint ----
  // Clearing (url === null) is a plain JSON body; setting a picture from a
  // freshly-picked file goes through uploadRoomImage below instead, which
  // sends the file itself in the same authenticated request — no core
  // /FILEHOST -> /upload round-trip needed (most ircds don't implement the
  // bespoke bot protocol that pipeline expects; this endpoint hosts the file
  // itself, right next to room-images.json — see the PHP file's top comment).
  async function putRoomImage(channel, jwt, url) {
    const res = await fetch(`${ROOM_IMAGES_ENDPOINT}?channel=${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      let detail = `http_${res.status}`;
      try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* ignore */ }
      throw new Error(detail);
    }
  }
  async function uploadRoomImage(channel, jwt, file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${ROOM_IMAGES_ENDPOINT}?channel=${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` }, // no Content-Type: the browser sets the multipart boundary
      body: fd,
    });
    if (!res.ok) {
      let detail = `http_${res.status}`;
      try { const j = await res.json(); if (j && j.error) detail = j.error; } catch { /* ignore */ }
      throw new Error(detail);
    }
    const data = await res.json();
    return data.url;
  }
  // ---- announce a picture change in the channel itself ----
  // Sent as a normal CTCP ACTION (the "/me" style line), same as any other
  // message the founder could type by hand — so unlike the picture URL
  // storage itself (which deliberately never touches IRC), this one DOES
  // reach every member's client and any other IRC client on the channel,
  // by design: the whole point is for members to notice the change. The
  // URL is now always absolute (see room-images.php's detect_origin()), so
  // Orbit's own message renderer (src/lib/format.tsx) picks it up as an
  // inline image for everyone automatically, no special-casing needed here.
  // `channel` must be the currently active buffer (true for both call sites
  // below — the picture picker only exists while "Gérer mon chan" is open
  // for that same channel) — orbit.irc.say goes through the composer's own
  // /me command, which always targets whatever's active, same as if the
  // founder had typed it by hand. This gives proper CTCP framing/splitting
  // (client.action) for free, same code path core itself uses for /me.
  function announcePictureChange(url) {
    const text = url
      ? `${orbit.i18n.pick({ fr: "a mis à jour l'image du salon", en: 'updated the room picture' })}\u00A0: ${url}`
      : orbit.i18n.pick({ fr: "a retiré l'image du salon", en: 'removed the room picture' });
    orbit.irc.say(`/me ${text}`);
  }

  function errorLabel(err) {
    const code = (err && err.message) || String(err);
    const table = {
      extjwt_unsupported: { fr: "Ton serveur IRC ne supporte pas la vérification d'identité nécessaire (EXTJWT)", en: "Your IRC server doesn't support the identity check this needs (EXTJWT)" },
      no_such_channel: { fr: 'Salon introuvable', en: 'No such channel' },
      not_founder: { fr: "Le serveur ne t'a pas reconnu comme fondateur de ce salon", en: "The server didn't recognize you as this channel's founder" },
      channel_mismatch: { fr: 'Jeton invalide pour ce salon', en: 'Token not valid for this channel' },
      invalid_token: { fr: "Vérification d'identité invalide", en: 'Identity check invalid' },
      upload_failed: { fr: "L'envoi du fichier a échoué côté serveur", en: 'The file upload failed server-side' },
      too_large: { fr: 'Image trop lourde (8 Mo max)', en: 'Image too large (8MB max)' },
      invalid_type: { fr: "Format d'image non supporté (jpg, png, gif, webp)", en: 'Unsupported image format (jpg, png, gif, webp)' },
      save_failed: { fr: "Le serveur n'a pas pu enregistrer l'image (droits d'écriture ?)", en: "The server couldn't save the image (write permissions?)" },
      jwt_timeout: { fr: "Le serveur n'a pas répondu à la vérification d'identité (EXTJWT) à temps — ton serveur IRC la supporte-t-il ?", en: "The server didn't answer the identity check (EXTJWT) in time — does your IRC server support it?" },
      timeout: { fr: 'Délai dépassé, réessaie', en: 'Timed out, try again' },
    };
    return orbit.i18n.pick(table[code] || { fr: `Échec (${code})`, en: `Failed (${code})` });
  }

  // ---- styling (scoped under .rg / injected once — visually mirrors the core Explore window) ----
  const css = document.createElement('style');
  css.textContent = `
    .rg{display:flex;flex-direction:column;gap:.55rem;min-height:0}
    .rg__bar{display:flex;gap:.5rem;align-items:center}
    .rg__search{flex:1;min-width:0;position:relative;display:flex;align-items:center}
    .rg__search input{width:100%;padding:.62rem .8rem;border-radius:11px;border:1px solid var(--border,#333);background:var(--bg-soft,#0e0e12);color:var(--ink,inherit);font:inherit;outline:none}
    .rg__refresh{flex:none;width:42px;height:42px;border:1px solid var(--border,#333);border-radius:11px;background:var(--bg-soft,#0e0e12);color:var(--muted,#9aa);font-size:1.15rem;cursor:pointer}
    .rg__refresh.spin{animation:rg-spin .8s linear infinite}
    @keyframes rg-spin{to{transform:rotate(360deg)}}
    .rg__meta{display:flex;align-items:center;gap:.85rem;font-size:.8rem;color:var(--muted,#9aa);padding:0 .1rem}
    .rg__stat{display:inline-flex;align-items:center;gap:.32rem;font-weight:600}
    .rg__dot{width:7px;height:7px;border-radius:50%;background:var(--online,#1fd189);display:inline-block}
    .rg__seggroup{display:inline-flex;gap:2px;background:var(--bg-soft,#0e0e12);border-radius:9px;padding:2px}
    .rg__seggroup.push{margin-left:auto}
    .rg__seg{border:0;background:none;color:var(--muted,#9aa);font:inherit;font-size:.78rem;font-weight:700;padding:.28rem .6rem;border-radius:7px;cursor:pointer;line-height:1}
    .rg__seg.on{background:var(--bg,#17171c);color:var(--ink,inherit)}
    .rg__loading,.rg__empty{padding:1.4rem .5rem;text-align:center;color:var(--muted,#9aa);font-size:.85rem}
    .rg__stuck{display:flex;flex-direction:column;align-items:center;gap:.6rem;margin-top:.7rem}
    /* Fixed column counts (no auto-fill/minmax) on purpose: auto-fill's track
       count depends on the exact available inline size, which can come out
       borderline once overflow-y:auto/scrollbar-gutter reserve their own
       space — in some browsers that miscount silently strands 1-2 tiles in
       an extra, practically-empty track instead of reflowing them. A fixed
       count sidesteps that entirely; the breakpoint mirrors .modal--wide. */
    .rg__grid{max-height:min(58vh,540px);overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;padding:.05rem .4rem .05rem .05rem}
    @media (min-width: 560px) { .rg__grid{grid-template-columns:repeat(3,minmax(0,1fr))} }
    .rg__grid::-webkit-scrollbar,.rg__list::-webkit-scrollbar{width:9px}
    .rg__grid::-webkit-scrollbar-thumb,.rg__list::-webkit-scrollbar-thumb{background:var(--border,#333);border-radius:6px;background-clip:padding-box}
    .rg__grid::-webkit-scrollbar-thumb:hover,.rg__list::-webkit-scrollbar-thumb:hover{background:var(--muted,#9aa);background-clip:padding-box}
    .rg__tile{position:relative;height:128px;min-width:0;border-radius:13px;border:1px solid var(--border,#333);background-size:cover;background-position:center;cursor:pointer;overflow:hidden;padding:0;display:flex;align-items:flex-end;color:#fff;text-align:left}
    .rg__tile-shade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 28%,rgba(0,0,0,.8));pointer-events:none}
    .rg__tile-name{position:relative;padding:.5rem .6rem .1rem;font-weight:800;font-size:.85rem;line-height:1.25;text-shadow:0 1px 3px rgba(0,0,0,.7);width:100%;box-sizing:border-box;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
    .rg__tile-users{position:relative;display:inline-flex;align-items:center;gap:.3rem;padding:0 .6rem .5rem;font-size:.72rem;opacity:.95;text-shadow:0 1px 3px rgba(0,0,0,.6)}
    .rg__list{max-height:min(58vh,540px);overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:.15rem;padding:.05rem .4rem .05rem .05rem}
    .rg__row{display:flex;align-items:center;gap:.7rem;padding:.55rem;border-radius:11px;border:1px solid transparent;background:transparent;color:var(--ink,inherit);cursor:pointer;text-align:left;width:100%;box-sizing:border-box}
    .rg__row:hover{background:var(--bg-soft,#0e0e12);border-color:var(--border,#333)}
    .rg__row-av{flex:none;width:38px;height:38px;border-radius:11px;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
    .rg__row-main{flex:1;min-width:0}
    .rg__row-name{font-weight:700;font-size:.92rem}
    .rg__row-topic{font-size:.78rem;color:var(--muted,#9aa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rg__row-users{flex:none;display:inline-flex;align-items:center;gap:.3rem;font-size:.8rem;font-weight:700;color:var(--muted,#9aa)}
    .rg__create{margin-top:.1rem;display:flex;align-items:center;justify-content:center;gap:.4rem;width:100%;border:1px dashed var(--border,#333);background:var(--bg-soft,#0e0e12);color:var(--muted,#9aa);border-radius:11px;padding:.65rem;cursor:pointer;font:inherit;font-size:.85rem}
    .rg__pager{display:flex;align-items:center;justify-content:center;gap:.9rem;padding-top:.15rem}
    .rg__pagebtn{border:1px solid var(--border,#333);background:var(--bg-soft,#0e0e12);color:var(--ink,inherit);font:inherit;font-size:.82rem;font-weight:700;padding:.45rem .9rem;border-radius:9px;cursor:pointer}
    .rg__pagebtn:disabled{opacity:.4;cursor:default}
    .rg__pagebtn:not(:disabled):hover{border-color:var(--accent,#1452cc)}
    .rg__pageinfo{font-size:.8rem;color:var(--muted,#9aa);font-weight:700;min-width:4.5rem;text-align:center}
    .rg-ca-pic__row{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}
    .rg-ca-pic__thumb{flex:none;position:relative;width:54px;height:54px;border-radius:12px;background-size:cover;background-position:center;border:1px solid var(--border,#333);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden}
    .rg-ca-pic__thumb--busy::after{content:"";position:absolute;inset:0;background:rgba(0,0,0,.45)}
    .rg-ca-pic__spin{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .rg-ca-pic__spin::before{content:"";width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;animation:rg-ca-spin .7s linear infinite}
    @keyframes rg-ca-spin{to{transform:rotate(360deg)}}
    .rg-ca-pic__status{display:inline-flex;align-items:center;gap:.4rem;font-size:.78rem;font-weight:700;color:var(--muted,#9aa)}
    .rg-ca-pic__status-dot{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--border,#333);border-top-color:var(--accent,#1452cc);animation:rg-ca-spin .7s linear infinite}
    .rg-ca-pic__hint{flex-basis:100%;font-size:.76rem;color:var(--muted,#9aa)}
    /* Applied by syncChannelPictures() below. React re-sets
       style={{ background: gradient }} on these nodes every render, which
       clears any background-image we write via el.style — so we drive the
       picture through a CSS custom property + !important instead, which
       beats React's non-important inline shorthand. */
    .room__av[data-rg-pic],.chan-hero__media[data-rg-pic],.main__room-bg[data-rg-pic]{
      background-image:var(--rg-pic)!important;
      background-size:cover!important;
      background-position:center!important;
      color:transparent!important;
    }
    .room__av[data-rg-pic] .room__hash{color:transparent}
  `;
  document.head.appendChild(css);

  // ---- the gallery itself: a drop-in replacement for the core Explore window ----
  function GridTile({ c, img, onJoin }) {
    return html`<button class="rg__tile" style=${img ? { backgroundImage: `url(${img})` } : { background: avatarBg(c.name || '?') }} onClick=${onJoin}>
      <span class="rg__tile-shade"></span>
      <span class="rg__tile-name">${c.name || '?'}</span>
      <span class="rg__tile-users"><span class="rg__dot"></span>${c.users ?? 0}</span>
    </button>`;
  }
  function ListRow({ c, img, onJoin }) {
    return html`<button class="rg__row" onClick=${onJoin}>
      <span class="rg__row-av" style=${img ? { backgroundImage: `url(${img})` } : { background: avatarBg(c.name || '?') }}>${img ? '' : '#'}</span>
      <span class="rg__row-main">
        <div class="rg__row-name">${c.name || '?'}</div>
        <div class="rg__row-topic">${stripMirc(c.topic) || t('modals.join.noTopic')}</div>
      </span>
      <span class="rg__row-users"><span class="rg__dot"></span>${c.users ?? 0}</span>
    </button>`;
  }

  // Tiles need room to show a full (wrapped) name, so instead of cramming
  // everything into one scrollable strip, the grid shows a fixed page of
  // fully-visible squares and a "page suivante" pager for the rest. The list
  // view — already compact, one line per room — keeps a bigger page too.
  const PAGE_SIZE_GRID = 9;
  const PAGE_SIZE_LIST = 20;

  function GalleryBody({ close }) {
    const [view, setView] = useState(() => orbit.storage.get('view', 'grid'));
    const [q, setQ] = useState('');
    const [sort, setSort] = useState('pop');
    const [page, setPage] = useState(0);
    const [, force] = useState(0);
    const images = useImageMap();
    const loadingSince = useRef(0); // 0 = not currently loading; else Date.now() when it started

    function requestRefresh() {
      const s = orbit.state.get();
      if (typeof s.refreshChannels === 'function') s.refreshChannels(); else orbit.irc.list();
    }

    useEffect(() => {
      // Every entry point that can open this window (sidebar button, the
      // "aucun salon" CTA, /list) already calls refreshChannels() itself
      // right before setModal('explore') — which we intercept. IRC's LIST
      // replies carry no id to correlate them to a specific request, so
      // firing a SECOND refreshChannels() here too would send two overlapping
      // LIST commands and race their replies against each other (this is
      // what caused both the "stuck refreshing" and the missing-tile bugs).
      // Only kick one off ourselves if nothing is already in flight/loaded —
      // e.g. a future entry point that forgets to refresh first.
      const s0 = orbit.state.get();
      if (!s0.listLoading && !s0.channels.length) requestRefresh();
      const offRaw = orbit.on('raw', (msg) => {
        if (msg.command === '321' || msg.command === '322' || msg.command === '323') force((x) => x + 1);
      });
      // Watchdog: if a LIST never resolves (dropped by the server, flood
      // protection, network hiccup — no 323 ever arrives), listLoading would
      // otherwise spin forever with no way out. Only ticks while genuinely
      // stuck (loading with nothing to show) — otherwise it'd force a
      // pointless re-render every 2s for the whole time the gallery is open.
      const id = setInterval(() => {
        const s = orbit.state.get();
        if (s.listLoading && !s.channels.length) force((x) => x + 1);
      }, 2000);
      return () => { offRaw(); clearInterval(id); };
    }, []);

    function setViewMode(v) { setView(v); orbit.storage.set('view', v); setPage(0); }
    function setSortMode(v) { setSort(v); setPage(0); }
    function onSearch(v) { setQ(v); setPage(0); }
    function join(name) { orbit.irc.join(name); close(); }
    function submitSearch() {
      const needle = q.trim();
      if (!needle) return;
      const st = orbit.state.get();
      const wanted = (needle[0] === '#' || needle[0] === '&' ? needle : '#' + needle).toLowerCase();
      const exists = (st.channels || []).some((c) => c.name.toLowerCase() === wanted);
      if (!exists) join(wanted);
    }

    const st = orbit.state.get();
    // Defensive de-dupe: a LIST response merged across reconnects/partial
    // refreshes can end up with the same channel counted twice, which both
    // inflates "X salons" and — since two array entries would share the same
    // React key — can make one of a duplicate pair vanish from the grid on
    // a later re-render. Last one wins (freshest data for that name).
    const channels = Array.from(new Map((st.channels || []).map((c) => [c.name.toLowerCase(), c])).values());
    const query = q.trim().toLowerCase();
    const filtered = channels.filter((c) => !query || c.name.toLowerCase().includes(query) || (c.topic || '').toLowerCase().includes(query));
    const rows = [...filtered].sort((a, b) => (sort === 'az' ? a.name.localeCompare(b.name) : b.users - a.users));
    const totalUsers = channels.reduce((s, c) => s + c.users, 0);
    const wanted = query && (query[0] === '#' || query[0] === '&' ? query : '#' + query);
    const canCreate = !!query && !channels.some((c) => c.name.toLowerCase() === wanted);

    const pageSize = view === 'grid' ? PAGE_SIZE_GRID : PAGE_SIZE_LIST;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const curPage = Math.min(page, totalPages - 1);
    const pageRows = rows.slice(curPage * pageSize, curPage * pageSize + pageSize);

    if (st.listLoading) { if (!loadingSince.current) loadingSince.current = Date.now(); }
    else loadingSince.current = 0;
    const stuck = st.listLoading && loadingSince.current && (Date.now() - loadingSince.current) > 10000;

    return html`<div class="rg">
      <div class="rg__bar">
        <div class="rg__search">
          <input placeholder=${t('modals.join.search')} value=${q}
            onInput=${(e) => onSearch(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') submitSearch(); }} />
        </div>
        <button class=${'rg__refresh' + (st.listLoading ? ' spin' : '')} title=${t('modals.join.refresh')}
          onClick=${() => { loadingSince.current = 0; requestRefresh(); loadImageMap(true); setPage(0); }}>⟳</button>
      </div>

      <div class="rg__meta">
        <span class="rg__stat">${channels.length}\u00A0${t('modals.join.rooms')}</span>
        <span class="rg__stat"><span class="rg__dot"></span>${totalUsers}\u00A0${t('modals.join.online')}</span>
        <div class="rg__seggroup">
          <button class=${'rg__seg' + (sort === 'pop' ? ' on' : '')} onClick=${() => setSortMode('pop')}>${t('modals.join.sortPop')}</button>
          <button class=${'rg__seg' + (sort === 'az' ? ' on' : '')} onClick=${() => setSortMode('az')}>A–Z</button>
        </div>
        <div class="rg__seggroup push">
          <button class=${'rg__seg' + (view === 'list' ? ' on' : '')} title=${orbit.i18n.pick({ fr: 'Liste', en: 'List' })} onClick=${() => setViewMode('list')}>☰</button>
          <button class=${'rg__seg' + (view === 'grid' ? ' on' : '')} title=${orbit.i18n.pick({ fr: 'Grille', en: 'Grid' })} onClick=${() => setViewMode('grid')}>▦</button>
        </div>
      </div>

      ${st.listLoading && !rows.length ? html`<div class="rg__loading">
        ${t('modals.join.loading')}
        ${stuck ? html`<div class="rg__stuck">
          <div>${orbit.i18n.pick({ fr: 'Ça prend plus de temps que prévu…', en: 'This is taking longer than expected…' })}</div>
          <button class="rg__pagebtn" onClick=${() => { loadingSince.current = 0; requestRefresh(); }}>${orbit.i18n.pick({ fr: 'Réessayer', en: 'Retry' })}</button>
        </div>` : null}
      </div>` : null}
      ${!st.listLoading && !rows.length && !canCreate ? html`<div class="rg__empty">${query ? t('modals.join.emptyFound') : t('modals.join.emptyNone')}</div>` : null}
      ${pageRows.length
        ? (view === 'grid'
          ? html`<div class="rg__grid">${pageRows.map((c, i) => html`<${GridTile} key=${`${curPage}:${i}`} c=${c} img=${images[normChan(c.name)]} onJoin=${() => join(c.name)} />`)}</div>`
          : html`<div class="rg__list">${pageRows.map((c, i) => html`<${ListRow} key=${`${curPage}:${i}`} c=${c} img=${images[normChan(c.name)]} onJoin=${() => join(c.name)} />`)}</div>`)
        : null}

      ${totalPages > 1 ? html`<div class="rg__pager">
        <button class="rg__pagebtn" disabled=${curPage === 0} onClick=${() => setPage(curPage - 1)}>‹ ${orbit.i18n.pick({ fr: 'Précédent', en: 'Previous' })}</button>
        <span class="rg__pageinfo">${orbit.i18n.pick({ fr: 'Page', en: 'Page' })} ${curPage + 1} / ${totalPages}</span>
        <button class="rg__pagebtn" disabled=${curPage >= totalPages - 1} onClick=${() => setPage(curPage + 1)}>${orbit.i18n.pick({ fr: 'Suivant', en: 'Next' })} ›</button>
      </div>` : null}

      ${canCreate ? html`<button class="rg__create" onClick=${() => join(wanted)}>${t('modals.join.createRow')}\u00A0<b>${wanted}</b></button>` : null}
    </div>`;
  }

  function openGallery() {
    let close;
    close = orbit.modal(() => html`<${GalleryBody} close=${() => close()} />`,
      { title: t('modals.join.title'), wide: true });
  }

  // ---- intercept the two DOM entry points, before the core's own handler ----
  // Sidebar's "Explorer" button and the "aucun salon" CTA both just do
  // refreshChannels() + setModal('explore') on click. Left alone, that lets
  // the native ExploreModal mount for the split second before frameTick's
  // next animation frame notices modal==='explore' and swaps it out — and
  // ExploreModal's OWN mount effect (`useEffect(() => { refresh(); })`) fires
  // a SECOND refreshChannels() during that flash of a mount. IRC's LIST
  // replies carry no id to correlate them to a specific request, so two
  // overlapping LIST commands can have their 321/322/323 replies interleave
  // and race each other — this was the actual cause of the intermittent
  // "refresh spinner never stops / room list stays incomplete" bug (grid and
  // list views share the exact same data, so it could hit either, but the
  // odds of it doing so audibly depended on timing — hence "par moment").
  //
  // Binding our own click listener directly on the button and stopping the
  // event there (before it bubbles up to the core's delegated React handler)
  // means the native handler never runs at all for these two entry points:
  // modal never becomes 'explore', ExploreModal never mounts, and only ONE
  // refresh ever happens (GalleryBody's own effect, above). If a future
  // Orbit version renames these classes, this simply stops matching and the
  // native click goes through as before — nothing breaks, the frameTick
  // fallback below still covers it (e.g. for the /list slash command, which
  // has no button to bind to).
  function interceptExploreButtons() {
    const btns = document.querySelectorAll('.side-explore, .room-discover');
    for (const btn of btns) {
      if (btn.dataset.rgBound) continue;
      btn.dataset.rgBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openGallery();
      });
    }
  }

  // ---- founder's picture picker, injected into "Gérer mon chan" → Aperçu ----
  // Vanilla DOM (no React tree of ours), so there's nothing for Orbit's own
  // reconciler to fight over — we just attach a sibling node next to the
  // "Accès & mot de passe" section and keep it in sync with plain listeners.
  let picSection = null;   // the section element we own
  let picBusy = false;

  function findAccessSection() {
    const label = t('modals.chanadmin.access');
    const heads = document.querySelectorAll('.modal .ca-h');
    for (const h of heads) {
      if (h.textContent === label) return h.closest('.ca-sec');
    }
    return null;
  }

  function renderPicSection() {
    if (!picSection) return;
    const active = orbit.state.active();
    const img = imageMap[normChan(active)];
    picSection.innerHTML = '';

    const h = document.createElement('h4');
    h.className = 'ca-h';
    h.textContent = orbit.i18n.pick({ fr: 'Image du salon', en: 'Room picture' });
    picSection.appendChild(h);

    const row = document.createElement('div');
    row.className = 'ca-param rg-ca-pic__row';
    picSection.appendChild(row);

    const thumb = document.createElement('div');
    thumb.className = 'rg-ca-pic__thumb' + (picBusy ? ' rg-ca-pic__thumb--busy' : '');
    thumb.setAttribute('aria-busy', picBusy ? 'true' : 'false');
    if (img) thumb.style.backgroundImage = `url(${img})`; else { thumb.style.background = avatarBg(active); thumb.textContent = '#'; }
    if (picBusy) {
      const spin = document.createElement('span');
      spin.className = 'rg-ca-pic__spin';
      spin.setAttribute('aria-hidden', 'true');
      thumb.appendChild(spin);
    }
    row.appendChild(thumb);

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'upbtn upbtn--primary';
    pickBtn.disabled = picBusy;
    pickBtn.textContent = img
      ? orbit.i18n.pick({ fr: "Changer l'image", en: 'Change picture' })
      : orbit.i18n.pick({ fr: 'Choisir une image', en: 'Choose a picture' });
    row.appendChild(pickBtn);

    if (picBusy) {
      const status = document.createElement('span');
      status.className = 'rg-ca-pic__status';
      status.setAttribute('role', 'status');
      const dot = document.createElement('span');
      dot.className = 'rg-ca-pic__status-dot';
      dot.setAttribute('aria-hidden', 'true');
      status.appendChild(dot);
      status.appendChild(document.createTextNode(
        orbit.i18n.pick({ fr: 'Envoi en cours…', en: 'Uploading…' }),
      ));
      row.appendChild(status);
    }

    if (img) {
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'upbtn';
      rmBtn.disabled = picBusy;
      rmBtn.textContent = orbit.i18n.pick({ fr: 'Retirer', en: 'Remove' });
      rmBtn.addEventListener('click', async () => {
        picBusy = true; renderPicSection();
        try {
          const jwt = await requestChannelJwt(active);
          await putRoomImage(active, jwt, null);
          setLocalImage(active, null);
          await loadImageMap(true);
          announcePictureChange(null);
        }
        catch (err) { log('remove picture failed', err); orbit.notify(orbit.i18n.pick({ fr: 'Suppression impossible', en: 'Removal failed' }), errorLabel(err)); }
        finally { picBusy = false; renderPicSection(); }
      });
      row.appendChild(rmBtn);
    }

    const hint = document.createElement('div');
    hint.className = 'rg-ca-pic__hint';
    hint.textContent = orbit.i18n.pick({
      fr: 'Visible par tous dans Explorer les salons — réservé au fondateur (+q).',
      en: 'Shown to everyone in Explore rooms — founder (+q) only.',
    });
    row.appendChild(hint);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    picSection.appendChild(fileInput);

    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!f.type.startsWith('image/')) { orbit.notify(orbit.i18n.pick({ fr: 'Image invalide', en: 'Invalid image' })); return; }
      if (f.size > MAX_BYTES) { orbit.notify(orbit.i18n.pick({ fr: 'Image trop lourde (8 Mo max)', en: 'Image too large (8MB max)' })); return; }
      picBusy = true; renderPicSection();
      try {
        // One authenticated request does it all: the EXTJWT proves founder
        // status, the same POST carries the file — the endpoint hosts it
        // itself and records the mapping (see uploadRoomImage above).
        const jwt = await requestChannelJwt(active);
        const url = await uploadRoomImage(active, jwt, f);
        // Seed immediately from the POST response — don't wait on GET. The
        // map used to silently fail to persist on disk (unwritable webroot)
        // while still returning the URL, so /me worked and nothing else did.
        setLocalImage(active, url);
        await loadImageMap(true);
        announcePictureChange(url);
        orbit.notify(orbit.i18n.pick({ fr: 'Image du salon mise à jour', en: 'Room picture updated' }));
      } catch (err) {
        log('set picture failed', err);
        orbit.notify(orbit.i18n.pick({ fr: 'Envoi impossible', en: 'Upload failed' }), errorLabel(err));
      } finally { picBusy = false; renderPicSection(); }
    });
  }

  // Re-render (thumbnail/labels) whenever the image map reloads, without
  // waiting for the next animation frame.
  mapListeners.add(() => { if (picSection) renderPicSection(); });

  // ---- swap the default "#" tile for the founder's picture, wherever the
  // core UI would otherwise show it: the open channel's own header, and its
  // row in the sidebar's list of open rooms. Both are plain style/attribute
  // mutations on core-rendered nodes (no childNodes changes — see the CSS
  // comment above for why that matters), re-applied every frame below so a
  // channel switch or sidebar re-render can never leave a stale picture (or
  // strand the real one) for more than one frame.
  function applyPicStyle(el, img) {
    if (!el) return;
    if (img) {
      // url("...") via JSON.stringify so parentheses/quotes in the URL can't
      // break the CSS value. --rg-pic is read by the !important rule above.
      const next = `url(${JSON.stringify(img)})`;
      if (el.style.getPropertyValue('--rg-pic') !== next) el.style.setProperty('--rg-pic', next);
      if (!el.hasAttribute('data-rg-pic')) el.setAttribute('data-rg-pic', '1');
    } else if (el.hasAttribute('data-rg-pic')) {
      el.style.removeProperty('--rg-pic');
      el.removeAttribute('data-rg-pic');
    }
  }

  function syncChannelPictures() {
    if (!mapLoaded) return; // avoid a flash of "no picture" before the first fetch resolves

    // Topbar keeps the classic "#" tile — room pictures only go on the topic
    // banner (.chan-hero__media) and sidebar rows.
    const topAv = document.querySelector('.topbar--channel .topbar__av');
    if (topAv) applyPicStyle(topAv, null);

    // Message-list channel hero (topic banner) — room picture thumbnail.
    const heroMedia = document.querySelector('.chan-hero__media');
    const img = imageMap[normChan(orbit.state.active())];
    if (heroMedia) applyPicStyle(heroMedia, img);

    // Soft large backdrop behind the chat column (upper half of .main).
    const roomBg = document.querySelector('.main__room-bg');
    if (roomBg) applyPicStyle(roomBg, img);

    // Sidebar: every open channel row. There's no data attribute on a row
    // carrying its raw channel name to key off of — only channel rows render
    // the "#" glyph span at all, and the row's own label text is that same
    // name with the leading "#" stripped (see Sidebar.tsx's RoomRow), so
    // reconstructing it from there is reliable without needing one.
    const hashes = document.querySelectorAll('.room__hash');
    for (const hash of hashes) {
      const av = hash.closest('.room__av');
      const row = hash.closest('.room');
      const nameEl = row && row.querySelector('.room__name');
      const raw = nameEl ? nameEl.textContent : '';
      // Sidebar.tsx only strips a leading "#" for the label (`&` local
      // channels, rare, keep theirs) — put it back only if it's not there.
      const name = raw && raw[0] !== '#' && raw[0] !== '&' ? '#' + raw : raw;
      applyPicStyle(av, imageMap[normChan(name)]);
    }
  }

  function teardownPicSection() {
    if (picSection) { picSection.remove(); picSection = null; }
  }

  function syncAdminPicSection(chanAdminOpen) {
    const active = orbit.state.active();
    const founder = chanAdminOpen && !!active && (active[0] === '#' || active[0] === '&') && amFounder(active);
    if (!founder) { teardownPicSection(); return; }
    const accessSec = findAccessSection();
    if (!accessSec) { teardownPicSection(); return; } // e.g. a different tab is active
    if (picSection && picSection.isConnected && picSection.previousElementSibling === accessSec) return; // already in place
    teardownPicSection();
    picSection = document.createElement('div');
    picSection.className = 'ca-sec rg-ca-pic';
    accessSec.insertAdjacentElement('afterend', picSection);
    renderPicSection();
  }

  // ---- one shared per-frame watcher for both plugin-side UI swaps ----
  // No core file is touched: everything below only reads the shared `modal`
  // flag / active channel (exposed read-only-ish via orbit.state.get(), same
  // as every other plugin state read) or the DOM Orbit itself already
  // rendered. If a future Orbit version renames the 'explore' modal key or
  // reshapes the admin modal's markup, these simply stop triggering and the
  // native windows keep working exactly as they do out of the box.
  let lastModal = '';
  function frameTick() {
    const st = orbit.state.get();

    // 0) Keep the two "open Explore" buttons wired to short-circuit straight
    // to our gallery (see interceptExploreButtons above) — cheap, and self-
    // heals if the sidebar re-renders new button nodes (e.g. the CTA
    // mounting/unmounting as the room list goes from empty to non-empty).
    interceptExploreButtons();

    // 1) Explorer les salons → swap in our gallery instead of the native one.
    if (st.modal === 'explore' && lastModal !== 'explore') {
      if (typeof st.setModal === 'function') st.setModal('');
      lastModal = '';
      openGallery();
    } else {
      lastModal = st.modal;
    }

    // 2) Gérer mon chan → Aperçu: keep the picture picker section in sync.
    syncAdminPicSection(st.modal === 'chanadmin');

    // 3) Topbar + sidebar: swap in founders' pictures wherever the core UI
    // would show the default "#" tile.
    syncChannelPictures();

    requestAnimationFrame(frameTick);
  }
  requestAnimationFrame(frameTick);

  // Load the picture map right away (not just when the gallery/admin modal
  // happen to open) so the topbar/sidebar pictures show up on their own on
  // startup, and keep it modestly fresh afterwards so a picture another
  // founder just set appears for everyone without anyone needing to reopen
  // anything — it's a single small JSON fetch either way.
  hydrateCachedMap();
  loadImageMap(true);
  setInterval(() => loadImageMap(true), 60000);

  log('room-gallery ready');
});
