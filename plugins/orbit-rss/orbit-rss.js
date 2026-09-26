/*!
 * orbit-rss — bulles Actualités pour les TAGMSG +rss=v1 du bot Actu.
 * Le PRIVMSG/NOTICE +rss=v1 est masqué : les clients sans message-tags
 * gardent le texte. Pile sous le topic, par-dessus les messages.
 * Repli : titre et date. Clic : le texte entier. Une bulle lue ou fermée ne revient pas.
 * Le bouton Actualités reste pour relire l’historique.
 */
(function () {
  'use strict';

  var ORX_VER = 5;
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
        img: safeHttp(tagVal(tags, '+img')),
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

    function shortDate(s) {
      var raw = String(s || '').trim();
      if (!raw) return '';
      var d = new Date(raw);
      if (isNaN(d.getTime())) return '';
      function p(n) { return n < 10 ? '0' + n : String(n); }
      return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) +
        ' à ' + p(d.getHours()) + 'h' + p(d.getMinutes());
    }

    var FEED_COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

    function feedColor(name) {
      var s = String(name || 'rss');
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
      return FEED_COLORS[h % FEED_COLORS.length];
    }

    function cssUrl(url) {
      return safeHttp(url).replace(/["'\\()]/g, '');
    }

    function injectStyles() {
      var css = document.getElementById('orx-css');
      if (!css) {
        css = document.createElement('style');
        css.id = 'orx-css';
        document.head.appendChild(css);
      }
      css.textContent = [
        '.main > .orx{position:absolute;z-index:30;right:.7rem;display:flex;flex-direction:column;align-items:flex-end;gap:.35rem;width:min(240px,72vw);max-height:min(70%,520px);pointer-events:none}',
        '.main > .orx:has(.is-open),.main > .orx:has(.orx__arch){width:min(320px,90vw)}',
        '.orx__chip,.orx__bubble,.orx__arch{pointer-events:auto}',
        '.orx__stack{display:flex;flex-direction:column;align-items:flex-end;width:100%}',
        '@keyframes orx-pop{from{transform:translateY(12px) scale(.88);opacity:0}to{transform:none;opacity:1}}',
        '@keyframes orx-glow{0%,100%{box-shadow:0 10px 18px -10px rgba(0,0,0,.55),0 0 0 0 transparent}50%{box-shadow:0 14px 22px -8px rgba(0,0,0,.5),0 0 0 4px color-mix(in srgb,var(--orx-c,#3b82f6) 55%,transparent)}}',
        '.orx__bubble{position:relative;width:100%;height:72px;margin-top:-22px;border-radius:999px;border:3px solid var(--orx-c,#3b82f6);background:#0f172a center/cover no-repeat;color:#fff;overflow:hidden;animation:orx-pop .4s ease both,orx-glow 2.8s ease-in-out infinite}',
        '.orx__bubble:first-child{margin-top:0}',
        '.orx__bubble::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,10,18,.72),rgba(6,10,18,.28) 62%,rgba(6,10,18,.5));pointer-events:none}',
        '.orx__bubble:hover,.orx__bubble.is-open{z-index:50 !important;animation:none}',
        '.orx__bubble.is-open{height:auto;min-height:72px;margin-top:8px;border-radius:22px}',
        '.orx__row{position:relative;z-index:1;display:flex;align-items:center;min-height:66px}',
        '.orx__main{flex:1;min-width:0;border:0;background:transparent;color:#fff;text-align:left;cursor:pointer;padding:.35rem .3rem .35rem .85rem;font:inherit}',
        '.orx__title{display:block;font-size:.78rem;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.65)}',
        '.orx__bubble.is-open .orx__title{white-space:normal}',
        '.orx__date{display:block;margin-top:.08rem;font-size:.62rem;font-weight:700;line-height:1.2;color:rgba(255,255,255,.92);text-shadow:0 1px 2px rgba(0,0,0,.65)}',
        '.orx__x{position:relative;z-index:2;flex:none;width:1.35rem;height:1.35rem;margin-right:.45rem;border:0;border-radius:999px;background:rgba(0,0,0,.4);color:#fff;cursor:pointer;font-size:.9rem;line-height:1}',
        '.orx__x:hover{background:rgba(0,0,0,.62)}',
        '.orx__full{position:relative;z-index:1;padding:0 .8rem .65rem;font-size:.78rem;line-height:1.4;color:#fff}',
        '.orx__headline{font-size:.8rem;font-weight:700;line-height:1.35;margin:0 0 .35rem;text-shadow:0 1px 2px rgba(0,0,0,.55)}',
        '.orx__desc{margin:0 0 .45rem;white-space:pre-wrap;overflow-wrap:anywhere;text-shadow:0 1px 2px rgba(0,0,0,.55)}',
        '.orx__link{display:inline-block;font-size:.74rem;font-weight:800;color:#fff;text-decoration:underline}',
        '.orx__chip{display:inline-flex;align-items:center;gap:.35rem;border:0;background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;border-radius:999px;padding:.32rem .75rem;font:inherit;font-size:.74rem;font-weight:800;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 18px -6px rgba(29,78,216,.75)}',
        '.orx__chip:hover{filter:brightness(1.06)}',
        '.orx__chip.is-on{background:linear-gradient(180deg,#1e40af,#1e3a8a);color:#fff}',
        '.orx__n{min-width:1.05rem;height:1.05rem;padding:0 .28rem;border-radius:999px;background:#fff;color:#1d4ed8;font-size:.62rem;font-weight:800;line-height:1.05rem;text-align:center}',
        '.orx__arch{width:100%;max-height:min(52vh,380px);overflow:auto;background:var(--bg,#fff);color:var(--ink,#1c2430);border:1px solid var(--border,rgba(20,30,45,.12));border-radius:12px;box-shadow:0 16px 40px -18px rgba(20,30,45,.55);padding:.3rem}',
        '.orx__empty{padding:.6rem .5rem;font-size:.74rem;color:var(--muted,#6b7280)}',
        '.orx__hit{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:.4rem .45rem;border-radius:8px;font:inherit}',
        '.orx__hit:hover,.orx__hit.is-on{background:rgba(59,108,255,.08)}',
        '.orx__full--arch{color:var(--ink,#1c2430);text-shadow:none}',
        '.orx__full--arch .orx__headline,.orx__full--arch .orx__desc{color:var(--ink-2,#334155);text-shadow:none}',
        '.orx__full--arch .orx__link{color:var(--accent-d,var(--accent,#3b6cff))}',
        '.orx__hit b{display:block;font-size:.74rem;font-weight:700;line-height:1.3}',
        '.orx__hit span{display:block;margin-top:.1rem;font-size:.62rem;color:var(--faint,#94a3b8)}'
      ].join('');
    }

    function bubbleStyle(it, i) {
      var color = feedColor(it.feed || it.feedtitle || it.id);
      var img = cssUrl(it.img);
      var bg = img ? 'background-image:url("' + img + '");' : '';
      return '--orx-c:' + color + ';z-index:' + (24 - i) + ';' + bg + 'animation-delay:' + (i * 0.07) + 's';
    }

    function bubbleHtml(chan, it, i) {
      var open = ui.expanded === it.id;
      var when = shortDate(it.date);
      var label = it.feedtitle || it.feed || pick({ fr: 'Actualité', en: 'News' });
      var full = '';
      if (open) {
        full = '<div class="orx__full">' +
          (it.title ? '<div class="orx__headline">' + esc(it.title) + '</div>' : '') +
          (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
          (it.link ? '<a class="orx__link" data-act="link" data-id="' + esc(it.id) + '" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
            pick({ fr: 'Ouvrir le lien', en: 'Open link' }) + '</a>' : '') +
          '</div>';
      }
      return '<article class="orx__bubble' + (open ? ' is-open' : '') + '" style="' + esc(bubbleStyle(it, i)) + '">' +
        '<div class="orx__row">' +
          '<button type="button" class="orx__main" data-act="open" data-id="' + esc(it.id) + '">' +
            '<span class="orx__title">' + esc(label) + '</span>' +
            (when ? '<span class="orx__date">' + esc(when) + '</span>' : '') +
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
          detail = '<div class="orx__full orx__full--arch">' +
            (it.title ? '<div class="orx__headline">' + esc(it.title) + '</div>' : '') +
            (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
            (it.link ? '<a class="orx__link" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
              esc(pick({ fr: 'Ouvrir le lien', en: 'Open link' })) + '</a>' : '') +
            '</div>';
        }
        var when = shortDate(it.date);
        return '<div><button type="button" class="orx__hit' + on + '" data-act="arch" data-id="' + esc(it.id) + '">' +
          '<b>' + esc(it.feedtitle || it.feed || it.title) + '</b>' +
          '<span>' + esc(when || it.title) + '</span>' +
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
        '<button type="button" class="' + chipClass + '" data-act="chip">' +
          esc(pick({ fr: 'Actualités', en: 'News' })) + badge +
        '</button>' +
        (ui.archive ? '' : '<div class="orx__stack">' + list.map(function (it, i) { return bubbleHtml(chan, it, i); }).join('') + '</div>') +
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
        ui.expanded = ui.expanded === id ? '' : id;
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
      if (act === 'link') return;
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
      var main = hero && hero.closest ? hero.closest('.main') : null;
      var chan = hero ? (hero.getAttribute('data-chan') || activeChan()) : '';
      if (!hero || !main || !gate(chan)) {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        return;
      }
      if (!root) {
        root = document.createElement('div');
        root.className = 'orx';
        root.addEventListener('click', onRootClick);
      }
      if (root.parentNode !== main) main.appendChild(root);
      root.style.top = (hero.offsetTop + hero.offsetHeight + 8) + 'px';
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
