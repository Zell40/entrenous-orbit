/*!
 * orbit-rss — bulles Actualités pour les TAGMSG +rss=v1 du bot Actu.
 * Le PRIVMSG/NOTICE +rss=v1 est masqué : les clients sans message-tags
 * gardent le texte. Pile sous le topic. Une bulle lue ou fermée ne revient pas.
 * Le bouton Actualités reste pour relire l’historique.
 */
(function () {
  'use strict';

  var ORX_VER = 3;
  var RSS = '+rss';
  var EV = '+ev';
  var MAX_ITEMS = 40;
  var MAX_BUBBLES = 4;

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (retry < 80) setTimeout(function () { boot(retry + 1); }, 50);
      return;
    }
    if (window.__ORBIT_RSS__ === ORX_VER) return;
    window.__ORBIT_RSS__ = ORX_VER;

    var pluginOrbit = null;
    var db = { seen: {}, items: {} };
    var ui = { expanded: '', archive: false, archiveId: '', rev: 0 };
    var root = null;

    function pick(table) {
      if (pluginOrbit && pluginOrbit.i18n && pluginOrbit.i18n.pick) return pluginOrbit.i18n.pick(table);
      var lang = (document.documentElement.lang || 'fr').slice(0, 2);
      return table[lang] || table.fr || table.en || '';
    }

    function normChan(name) {
      return String(name || '').trim().toLowerCase();
    }

    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
      });
    }

    function tagVal(tags, name) {
      if (!tags) return '';
      if (Object.prototype.hasOwnProperty.call(tags, name)) return String(tags[name] == null ? '' : tags[name]);
      var alt = name.charAt(0) === '+' ? name.slice(1) : '+' + name;
      if (Object.prototype.hasOwnProperty.call(tags, alt)) return String(tags[alt] == null ? '' : tags[alt]);
      return '';
    }

    function safeHttp(url) {
      var s = String(url || '').trim();
      if (/^https?:\/\//i.test(s)) return s;
      return '';
    }

    function botNick() {
      var cfg = (pluginOrbit && pluginOrbit.config && pluginOrbit.config()) || {};
      var rss = cfg.rss || {};
      return String(rss.bot || 'Actu');
    }

    function tagsOn() {
      try {
        return !!(pluginOrbit && pluginOrbit.server && pluginOrbit.server.hasCap &&
          pluginOrbit.server.hasCap('message-tags'));
      } catch (e) {
        return false;
      }
    }

    function bufferOf(chan) {
      var st = pluginOrbit && pluginOrbit.state && pluginOrbit.state.get ? pluginOrbit.state.get() : null;
      var buffers = st && st.buffers;
      if (!buffers) return null;
      if (buffers[chan]) return buffers[chan];
      var want = normChan(chan);
      var keys = Object.keys(buffers);
      for (var i = 0; i < keys.length; i++) {
        if (normChan(keys[i]) === want) return buffers[keys[i]];
      }
      return null;
    }

    function botInChannel(chan) {
      var buf = bufferOf(chan);
      var members = buf && buf.members;
      if (!members) return false;
      var want = botNick().toLowerCase();
      var keys = Object.keys(members);
      for (var i = 0; i < keys.length; i++) {
        var member = members[keys[i]] || {};
        var nick = String(member.nick || keys[i] || '').toLowerCase();
        if (nick === want) return true;
      }
      return false;
    }

    function gate(chan) {
      return !!(chan && chan.charAt(0) === '#' && tagsOn() && botInChannel(chan));
    }

    function loadDb() {
      var stored = null;
      try {
        if (pluginOrbit && pluginOrbit.storage) stored = pluginOrbit.storage.get('feeds', null);
      } catch (e) { stored = null; }
      if (!stored || typeof stored !== 'object') stored = { seen: {}, items: {} };
      if (!stored.seen || typeof stored.seen !== 'object') stored.seen = {};
      if (!stored.items || typeof stored.items !== 'object') stored.items = {};
      db = stored;
    }

    function saveDb() {
      try {
        if (pluginOrbit && pluginOrbit.storage) pluginOrbit.storage.set('feeds', db);
      } catch (e) { /* quota */ }
    }

    function chanKey(chan) {
      return normChan(chan);
    }

    function itemsOf(chan) {
      return db.items[chanKey(chan)] || [];
    }

    function seenMap(chan) {
      var key = chanKey(chan);
      if (!db.seen[key]) db.seen[key] = {};
      return db.seen[key];
    }

    function isSeen(chan, id) {
      return !!(id && seenMap(chan)[id]);
    }

    function markSeen(chan, id) {
      if (!id) return;
      seenMap(chan)[id] = Date.now();
      saveDb();
      ui.rev++;
    }

    function remember(chan, item) {
      var key = chanKey(chan);
      var list = db.items[key] ? db.items[key].slice() : [];
      if (list.some(function (it) { return it.id === item.id; })) return false;
      list.unshift(item);
      db.items[key] = list.slice(0, MAX_ITEMS);
      saveDb();
      ui.rev++;
      return true;
    }

    function unread(chan) {
      return itemsOf(chan).filter(function (it) { return !isSeen(chan, it.id); });
    }

    function bubbles(chan) {
      var list = unread(chan).slice(0, MAX_BUBBLES);
      if (ui.expanded) {
        var open = itemsOf(chan).filter(function (it) { return it.id === ui.expanded; })[0];
        if (open && !list.some(function (it) { return it.id === open.id; })) list.unshift(open);
      }
      return list;
    }

    function activeChan() {
      try {
        return (pluginOrbit && pluginOrbit.state && pluginOrbit.state.active && pluginOrbit.state.active()) || '';
      } catch (e) {
        return '';
      }
    }

    function itemFromTags(tags) {
      var title = tagVal(tags, '+title').trim();
      var link = safeHttp(tagVal(tags, '+link'));
      var feed = tagVal(tags, '+feed').trim();
      var id = tagVal(tags, '+id').trim() || link || (feed + '\n' + title);
      if (!title || !id) return null;
      return {
        id: id,
        feed: feed,
        feedtitle: tagVal(tags, '+feedtitle').trim(),
        title: title,
        link: link,
        date: tagVal(tags, '+date').trim(),
        desc: tagVal(tags, '+desc').trim(),
        ts: Date.now(),
      };
    }

    function handleItem(chan, tags) {
      if (tagVal(tags, RSS) !== 'v1') return;
      if (tagVal(tags, EV) !== 'item') return;
      var item = itemFromTags(tags);
      if (!item) return;
      remember(chan, item);
    }

    function injectStyles() {
      var css = document.getElementById('orx-css');
      if (!css) {
        css = document.createElement('style');
        css.id = 'orx-css';
        document.head.appendChild(css);
      }
      css.textContent = [
        '.chan-hero:has(.orx){overflow:visible}',
        '.chan-hero__body > .orx{align-self:stretch;width:100%;max-width:none;margin-top:.4rem;padding-top:0}',
        '.orx{position:relative;z-index:3;display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;max-width:min(280px,46vw);padding-top:.15rem}',
        '.orx__stack{display:flex;flex-direction:column;align-items:flex-end;gap:.35rem;width:100%}',
        '.orx__bubble{width:100%;text-align:left;background:var(--bg,#fff);color:var(--ink,#1c2430);border:1px solid var(--border,rgba(20,30,45,.12));border-radius:14px;box-shadow:0 8px 22px -14px rgba(20,30,45,.45);overflow:hidden}',
        '.orx__row{display:flex;align-items:flex-start;gap:.2rem}',
        '.orx__main{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;padding:.45rem .2rem .45rem .6rem;font:inherit}',
        '.orx__kicker{display:block;font-size:.62rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-d,var(--accent,#3b6cff));margin-bottom:.1rem}',
        '.orx__title{font-size:.78rem;font-weight:700;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
        '.orx__x{flex:none;width:1.7rem;height:1.7rem;margin:.25rem .3rem 0 0;border:0;border-radius:999px;background:transparent;color:var(--muted,#6b7280);cursor:pointer;font-size:1rem;line-height:1}',
        '.orx__x:hover{background:rgba(20,30,45,.06);color:var(--ink,#1c2430)}',
        '.orx__full{padding:0 .7rem .6rem;font-size:.75rem;line-height:1.4;color:var(--ink-2,#334155)}',
        '.orx__desc{margin:.25rem 0 .4rem;white-space:pre-wrap}',
        '.orx__meta{font-size:.68rem;color:var(--faint,#94a3b8);margin-bottom:.35rem}',
        '.orx__link{display:inline-block;font-size:.72rem;font-weight:700;color:var(--accent-d,var(--accent,#3b6cff));text-decoration:none}',
        '.orx__link:hover{text-decoration:underline}',
        '.orx__chip{display:inline-flex;align-items:center;gap:.4rem;border:0;background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;border-radius:999px;padding:.42rem .95rem;font:inherit;font-size:.84rem;font-weight:800;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 18px -6px rgba(29,78,216,.75)}',
        '.orx__chip:hover{filter:brightness(1.06)}',
        '.orx__chip.is-on{background:linear-gradient(180deg,#1e40af,#1e3a8a);color:#fff}',
        '.orx__n{min-width:1.15rem;height:1.15rem;padding:0 .3rem;border-radius:999px;background:#fff;color:#1d4ed8;font-size:.68rem;font-weight:800;line-height:1.15rem;text-align:center}',
        '.orx__arch{width:min(320px,70vw);max-height:min(60vh,420px);overflow:auto;background:var(--bg,#fff);color:var(--ink,#1c2430);border:1px solid var(--border,rgba(20,30,45,.12));border-radius:14px;box-shadow:0 16px 40px -24px rgba(20,30,45,.55);padding:.35rem}',
        '.orx__empty{padding:.7rem .6rem;font-size:.75rem;color:var(--muted,#6b7280)}',
        '.orx__hit{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:.45rem .5rem;border-radius:10px;font:inherit}',
        '.orx__hit:hover,.orx__hit.is-on{background:rgba(59,108,255,.08)}',
        '.orx__hit b{display:block;font-size:.75rem;font-weight:700;line-height:1.3}',
        '.orx__hit span{display:block;margin-top:.12rem;font-size:.65rem;color:var(--faint,#94a3b8)}',
        '@media (max-width:720px){.chan-hero__body > .orx{max-width:none}.orx__chip{align-self:flex-end}}'
      ].join('');
    }

    function bubbleHtml(chan, it) {
      var open = ui.expanded === it.id;
      var kicker = it.feedtitle || it.feed || pick({ fr: 'Actualité', en: 'News' });
      var full = '';
      if (open) {
        full = '<div class="orx__full">' +
          (it.date ? '<div class="orx__meta">' + esc(it.date) + '</div>' : '') +
          (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
          (it.link ? '<a class="orx__link" data-act="link" data-id="' + esc(it.id) + '" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
            pick({ fr: 'Ouvrir le lien', en: 'Open link' }) + '</a>' : '') +
          '</div>';
      }
      return '<article class="orx__bubble">' +
        '<div class="orx__row">' +
          '<button type="button" class="orx__main" data-act="open" data-id="' + esc(it.id) + '">' +
            '<span class="orx__kicker">' + esc(kicker) + '</span>' +
            '<span class="orx__title">' + esc(it.title) + '</span>' +
          '</button>' +
          '<button type="button" class="orx__x" data-act="close" data-id="' + esc(it.id) + '" aria-label="' +
            esc(pick({ fr: 'Fermer', en: 'Close' })) + '">×</button>' +
        '</div>' + full + '</article>';
    }

    function archiveHtml(chan) {
      if (!ui.archive) return '';
      var list = itemsOf(chan);
      if (!list.length) {
        return '<div class="orx__arch"><div class="orx__empty">' +
          esc(pick({ fr: 'Aucune actualité pour le moment.', en: 'No news yet.' })) +
          '</div></div>';
      }
      var rows = list.map(function (it) {
        var on = ui.archiveId === it.id ? ' is-on' : '';
        var detail = '';
        if (ui.archiveId === it.id) {
          detail = '<div class="orx__full">' +
            (it.date ? '<div class="orx__meta">' + esc(it.date) + '</div>' : '') +
            (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
            (it.link ? '<a class="orx__link" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
              esc(pick({ fr: 'Ouvrir le lien', en: 'Open link' })) + '</a>' : '') +
            '</div>';
        }
        return '<div><button type="button" class="orx__hit' + on + '" data-act="arch" data-id="' + esc(it.id) + '">' +
          '<b>' + esc(it.title) + '</b>' +
          '<span>' + esc(it.feedtitle || it.feed || '') + '</span>' +
          '</button>' + detail + '</div>';
      }).join('');
      return '<div class="orx__arch">' + rows + '</div>';
    }

    function render(chan) {
      var list = bubbles(chan);
      var n = unread(chan).length;
      var chipClass = 'orx__chip' + (ui.archive ? ' is-on' : '');
      var badge = n ? '<span class="orx__n">' + (n > 9 ? '9+' : String(n)) + '</span>' : '';
      root.innerHTML =
        '<div class="orx__stack">' + list.map(function (it) { return bubbleHtml(chan, it); }).join('') + '</div>' +
        '<button type="button" class="' + chipClass + '" data-act="chip">' +
          esc(pick({ fr: 'Actualités', en: 'News' })) + badge +
        '</button>' +
        archiveHtml(chan);
    }

    function onRootClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !root || !root.contains(el)) return;
      var chan = root.getAttribute('data-chan') || '';
      var act = el.getAttribute('data-act');
      var id = el.getAttribute('data-id') || '';
      if (act === 'chip') {
        ui.archive = !ui.archive;
        ui.archiveId = '';
        ui.rev++;
        paint();
        return;
      }
      if (act === 'open') {
        ev.preventDefault();
        if (ui.expanded === id) ui.expanded = '';
        else {
          ui.expanded = id;
          markSeen(chan, id);
        }
        paint();
        return;
      }
      if (act === 'close') {
        ev.preventDefault();
        ev.stopPropagation();
        if (ui.expanded === id) ui.expanded = '';
        markSeen(chan, id);
        paint();
        return;
      }
      if (act === 'link') {
        markSeen(chan, id);
        if (ui.expanded === id) ui.expanded = '';
        paint();
        return;
      }
      if (act === 'arch') {
        ev.preventDefault();
        ui.archiveId = ui.archiveId === id ? '' : id;
        ui.rev++;
        paint();
      }
    }

    function paint() {
      if (!pluginOrbit) return;
      var hero = document.querySelector('.chan-hero');
      var chan = hero ? (hero.getAttribute('data-chan') || activeChan()) : '';
      if (!hero || !gate(chan)) {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        return;
      }
      if (!root) {
        root = document.createElement('div');
        root.className = 'orx';
        root.addEventListener('click', onRootClick);
      }
      var slot = hero.querySelector('.chan-hero__body') || hero;
      if (root.parentNode !== slot) slot.appendChild(root);
      var shown = chanKey(chan);
      if (root.__orxChan && root.__orxChan !== shown) {
        ui.expanded = '';
        ui.archive = false;
        ui.archiveId = '';
      }
      root.__orxChan = shown;
      root.setAttribute('data-chan', chan);
      var sig = shown + '|' + ui.rev + '|' + ui.expanded + '|' + (ui.archive ? '1' : '0') + '|' +
        ui.archiveId + '|' + unread(chan).length + '|' + itemsOf(chan).length;
      if (root.__orxSig === sig) return;
      root.__orxSig = sig;
      render(chan);
    }

    Orbit.plugin('orbit-rss', function (orbit) {
      pluginOrbit = orbit;
      loadDb();
      injectStyles();
      console.info('[orbit-rss] loaded v' + ORX_VER);

      if (orbit.addMessageFilter) {
        orbit.addMessageFilter(function (m) {
          if (!m || tagVal(m.tags, RSS) !== 'v1') return false;
          var cmd = String(m.command || '').toUpperCase();
          return cmd === 'PRIVMSG' || cmd === 'NOTICE';
        });
      }

      orbit.on('raw', function (msg) {
        var cmd = String(msg.command || '').toUpperCase();
        if (cmd !== 'TAGMSG') return;
        var tags = msg.tags || {};
        if (tagVal(tags, RSS) !== 'v1') return;
        var target = (msg.params && msg.params[0]) || '';
        if (!target || target.charAt(0) !== '#') return;
        handleItem(target, tags);
        paint();
      });

      orbit.on('buffer.active', function () {
        ui.expanded = '';
        ui.archive = false;
        ui.archiveId = '';
        paint();
      });
      orbit.on('connected', paint);
      orbit.on('status', paint);
      setInterval(paint, 700);
      paint();
    });
  }

  boot(0);
})();
