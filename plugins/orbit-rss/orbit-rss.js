/*!
 * orbit-rss — bulles Actualités pour les TAGMSG +rss=v1 du bot Actu.
 * Le PRIVMSG/NOTICE +rss=v1 est masqué : les clients sans message-tags
 * gardent le texte. Pile sous le topic, par-dessus les messages.
 * Repli : titre et date. Clic : le texte entier. Une bulle lue ou fermée ne revient pas.
 * Le bouton Actualités reste pour relire l’historique.
 */
(function () {
  'use strict';

  var ORX_VER = 26;
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
    var imgWait = {};
    var imgReady = {};
    var imgMiss = {};
    var asked = {};
    var ui = { expanded: '', archive: false, archiveId: '', rev: 0 };
    var root = null;
    var archLayer = null;
    var drag = { on: false, moved: false, id: 0, x: 0, y: 0, top: 0, right: 0 };

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

    function listMax() {
      var cfg = (pluginOrbit && pluginOrbit.config && pluginOrbit.config()) || {};
      var n = parseInt(cfg.rss && cfg.rss.max, 10);
      if (!isFinite(n) || n < 1) n = 10;
      if (n > MAX_ITEMS) n = MAX_ITEMS;
      return n;
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

    function hasLink(it) {
      return !!(it && safeHttp(it.link));
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
      var changed = false;
      Object.keys(db.items).forEach(function (key) {
        var next = (db.items[key] || []).filter(hasLink);
        if (next.length !== (db.items[key] || []).length) {
          db.items[key] = next;
          changed = true;
        }
      });
      if (changed) saveDb();
    }

    function saveDb() {
      try {
        if (pluginOrbit && pluginOrbit.storage) pluginOrbit.storage.set('feeds', db);
      } catch (e) { /* quota */ }
    }

    function chanKey(chan) {
      return normChan(chan);
    }

    function itemTime(it) {
      var d = parseWhen(it && it.date) || parseWhen(it && it.ts);
      return d ? d.getTime() : 0;
    }

    function byDateDesc(a, b) {
      return itemTime(b) - itemTime(a);
    }

    function itemsOf(chan) {
      return (db.items[chanKey(chan)] || []).filter(hasLink).slice().sort(byDateDesc);
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
      if (!hasLink(item)) return false;
      var key = chanKey(chan);
      var list = db.items[key] ? db.items[key].slice() : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== item.id) continue;
        var prev = list[i];
        var changed = false;
        var keys = ['img', 'imgKind', 'date', 'title', 'desc', 'link', 'feed', 'feedtitle', 'site'];
        for (var k = 0; k < keys.length; k++) {
          var field = keys[k];
          if (!prev[field] && item[field]) {
            prev[field] = item[field];
            changed = true;
          }
        }
        if (changed) {
          list.sort(byDateDesc);
          db.items[key] = list.slice(0, listMax());
          saveDb();
          ui.rev++;
        }
        return false;
      }
      list.unshift(item);
      list.sort(byDateDesc);
      db.items[key] = list.slice(0, listMax());
      saveDb();
      ui.rev++;
      return true;
    }

    function unread(chan) {
      return itemsOf(chan).filter(function (it) { return !isSeen(chan, it.id); });
    }

    function bubbles(chan) {
      var list = unread(chan).slice(0, isNarrow() ? 3 : MAX_BUBBLES);
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
      if (!title || !id || !link) return null;
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

    function parseLine(text) {
      var raw = String(text || '').replace(/\s+/g, ' ').trim();
      var m = raw.match(/^(.*)\s+<(https?:\/\/[^>\s]+)>\s*$/);
      if (!m) return null;
      var head = m[1].trim();
      var link = safeHttp(m[2]);
      if (!link) return null;
      var feed = '';
      var title = '';
      var date = '';
      var news = head.match(/^News from\s+(.+?):\s+(.+)$/i);
      if (news) {
        feed = news[1].trim();
        title = news[2].trim();
      } else {
        var sep = head.indexOf(': ');
        if (sep < 1) return null;
        date = head.slice(0, sep).trim();
        title = head.slice(sep + 2).trim();
      }
      if (!title) return null;
      return {
        id: link + '\n' + title,
        feed: feed,
        feedtitle: feed,
        title: title,
        link: link,
        img: '',
        date: date,
        desc: '',
        ts: Date.now(),
      };
    }

    function fromBot(nick) {
      return String(nick || '').toLowerCase() === botNick().toLowerCase();
    }

    function ingest(chan, tags, text, nick) {
      if (!chan || chan.charAt(0) !== '#') return;
      if (tagVal(tags, RSS) === 'v1' && tagVal(tags, EV) === 'item' && tagVal(tags, '+title')) {
        if (handleItem(chan, tags)) return;
      }
      if (tags && tagVal(tags, RSS) === 'v1' && fromBot(nick)) {
        var parsed = parseLine(text);
        if (parsed) remember(chan, parsed);
        return;
      }
      if (fromBot(nick)) {
        var line = parseLine(text);
        if (line) remember(chan, line);
      }
    }

    function tagEscape(s) {
      return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\:')
        .replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    }

    function requestHistory(chan) {
      var key = chanKey(chan);
      var now = Date.now();
      if (asked[key] && now - asked[key] < 10 * 60 * 1000) return;
      if (!pluginOrbit || !pluginOrbit.irc || !pluginOrbit.irc.send) return;
      if (!tagsOn()) return;
      asked[key] = now;
      try {
        pluginOrbit.irc.send('@+rss=v1;+ev=recent;+chan=' + tagEscape(chan) +
          ' TAGMSG ' + botNick());
      } catch (e) { /* ignore */ }
    }

    function rememberHist(chan, tags) {
      if (tagVal(tags, EV) !== 'hist') return;
      if (!chan || chan.charAt(0) !== '#') return;
      if (!tagVal(tags, '+title')) return;
      var item = itemFromTags(tags);
      if (!item) return;
      var added = remember(chan, item);
      if (added) markSeen(chan, item.id);
    }

    function harvest(chan) {
      var buf = bufferOf(chan);
      var msgs = buf && buf.messages;
      if (!msgs || !msgs.length) return;
      var before = ui.rev;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m) continue;
        ingest(chan, m.tags, m.text, m.from);
      }
      if (ui.rev !== before) saveDb();
    }

    function handleItem(chan, tags) {
      if (tagVal(tags, RSS) !== 'v1') return false;
      if (tagVal(tags, EV) !== 'item') return false;
      var item = itemFromTags(tags);
      if (!item) return false;
      remember(chan, item);
      return true;
    }

    function parseWhen(raw) {
      if (typeof raw === 'number' && isFinite(raw)) {
        var fromNum = new Date(raw);
        if (!isNaN(fromNum.getTime()) && fromNum.getFullYear() > 1990) return fromNum;
      }
      var s = String(raw || '').trim();
      if (!s) return null;
      if (/^\d{10,13}$/.test(s)) {
        var n = parseInt(s, 10);
        if (s.length === 10) n *= 1000;
        var fromEpoch = new Date(n);
        if (!isNaN(fromEpoch.getTime())) return fromEpoch;
      }
      var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0));
      var dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ Tàa]*(\d{1,2})[h:](\d{2}))?/);
      if (dmy) {
        var year = +dmy[3];
        if (year < 100) year += 2000;
        return new Date(year, +dmy[2] - 1, +dmy[1], +(dmy[4] || 0), +(dmy[5] || 0));
      }
      var months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      var ctime = s.match(/^[A-Za-z]{3,}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2})(?::\d{2})?\s+(\d{4})/);
      if (ctime && months[ctime[1].toLowerCase()] != null) {
        return new Date(+ctime[5], months[ctime[1].toLowerCase()], +ctime[2], +ctime[3], +ctime[4]);
      }
      var parsed = new Date(s);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990) return parsed;
      return null;
    }

    function shortDate(s) {
      var d = parseWhen(s);
      if (!d) return '';
      function p(n) { return n < 10 ? '0' + n : String(n); }
      return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) +
        ' à ' + p(d.getHours()) + 'h' + p(d.getMinutes());
    }

    function whenLabel(it) {
      return shortDate(it && it.date) || shortDate(it && it.ts);
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
        '.main > .orx{position:absolute;z-index:30;right:.7rem;display:flex;flex-direction:column;align-items:flex-end;gap:.35rem;width:min(240px,72vw);max-height:min(70%,520px);pointer-events:none;visibility:hidden}',
        '.main > .orx.orx--set{visibility:visible}',
        '.ohp-head > .orx,.oec-head > .orx,.opbac-head > .orx,.ohp-head__actions > .orx,.oec-head__actions > .orx,.opbac-head__actions > .orx{position:relative;top:auto;right:auto;left:auto;bottom:auto;z-index:5;width:auto;max-width:none;max-height:none;flex:none;margin:0 .28rem 0 0;visibility:hidden}',
        '.ohp-head > .orx.orx--set,.oec-head > .orx.orx--set,.opbac-head > .orx.orx--set,.ohp-head__actions > .orx.orx--set,.oec-head__actions > .orx.orx--set,.opbac-head__actions > .orx.orx--set{visibility:visible}',
        '.orx--game .orx__stack,.orx--game .orx__arch{display:none}',
        '.orx-arch-layer{position:fixed;z-index:400;box-sizing:border-box;width:min(360px,92vw);max-height:min(70vh,520px);overflow:auto;overflow-anchor:none;display:flex;flex-direction:column;gap:.45rem;padding:.45rem;pointer-events:auto;border-radius:16px;background:color-mix(in srgb,#0b1220 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 18px 40px rgba(0,0,0,.45)}',
        '.orx-arch-layer .orx__arch{width:100%;max-height:none;overflow:visible;padding:0}',
        '.orx-arch-layer[hidden]{display:none!important}',
        '@media(max-width:880px){.orx-arch-layer{left:8px;right:8px;width:auto;max-width:none}.ohp-head__actions>.orx .orx__chip,.oec-head__actions>.orx .orx__chip,.opbac-head__actions>.orx .orx__chip,.ohp-head>.orx .orx__chip,.oec-head>.orx .orx__chip,.opbac-head>.orx .orx__chip{padding:.22rem .5rem;font-size:.66rem;max-width:36vw}.main>.orx{width:min(168px,52vw);right:.4rem;max-height:min(38%,240px)}.main>.orx:has(.is-open){width:min(230px,76vw);max-height:min(52%,320px)}.main>.orx .orx__chip{padding:.2rem .5rem;font-size:.64rem}.main>.orx .orx__bubble{height:44px;margin-top:-18px;border-width:2px}.main>.orx .orx__bubble:first-child{margin-top:0}.main>.orx .orx__bubble.is-open{min-height:44px;margin-top:4px}.main>.orx .orx__row{min-height:40px}.main>.orx .orx__main{padding:.16rem .15rem .16rem .5rem}.main>.orx .orx__title{font-size:.64rem}.main>.orx .orx__date{font-size:.52rem}.main>.orx .orx__x{width:1rem;height:1rem;margin-right:.25rem;font-size:.75rem}.main>.orx .orx__spin{right:1.45rem;width:.8rem;height:.8rem;margin-top:-.4rem}.main>.orx .orx__full{padding:0 .55rem .45rem;font-size:.7rem}}',
        '.main > .orx:has(.is-open),.main > .orx:has(.orx__arch){width:min(320px,90vw)}',
        '.orx__chip,.orx__bubble,.orx__arch{pointer-events:auto}',
        '.main > .orx .orx__chip{touch-action:none;cursor:grab}',
        '.main > .orx.orx--drag .orx__chip{cursor:grabbing}',
        '.main > .orx.orx--drag{user-select:none}',
        '.orx__stack{display:flex;flex-direction:column;align-items:flex-end;width:100%}',
        '@keyframes orx-pop{from{transform:translateY(12px) scale(.88);opacity:0}to{transform:none;opacity:1}}',
        '@keyframes orx-glow{0%,100%{box-shadow:0 10px 18px -10px rgba(0,0,0,.55),0 0 0 0 transparent}50%{box-shadow:0 14px 22px -8px rgba(0,0,0,.5),0 0 0 4px color-mix(in srgb,var(--orx-c,#3b82f6) 55%,transparent)}}',
        '.orx__bubble{position:relative;width:100%;height:72px;margin-top:-22px;border-radius:999px;border:3px solid var(--orx-c,#3b82f6);background:transparent;color:#1e293b;overflow:hidden;animation:orx-pop .4s ease both,orx-glow 2.8s ease-in-out infinite}',
        '.orx__bubble:first-child{margin-top:0}',
        '.orx__bg{position:absolute;inset:0;z-index:0;background-color:#e7eef8;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 240 72\'%3E%3Cdefs%3E%3ClinearGradient id=\'g\' x1=\'0\' y1=\'0\' x2=\'1\' y2=\'1\'%3E%3Cstop offset=\'0\' stop-color=\'%23f8fbff\'/%3E%3Cstop offset=\'1\' stop-color=\'%23d5e3f4\'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=\'240\' height=\'72\' fill=\'url(%23g)\'/%3E%3Ccircle cx=\'186\' cy=\'20\' r=\'9\' fill=\'%23fde68a\'/%3E%3Cpath d=\'M148 60l28-26 18 16 20-22 22 32H148z\' fill=\'%2394a3b8\'/%3E%3Cpath d=\'M162 60l20-16 16 16H162z\' fill=\'%2364748b\'/%3E%3C/svg%3E");background-position:center;background-size:cover;background-repeat:no-repeat}',
        '@keyframes orx-spin{to{transform:rotate(360deg)}}',
        '.orx__spin{display:none;position:absolute;z-index:3;right:2.15rem;top:50%;width:1.05rem;height:1.05rem;margin-top:-.52rem;border-radius:999px;border:2px solid rgba(37,99,235,.28);border-top-color:#2563eb;animation:orx-spin .7s linear infinite}',
        '.orx__bubble.is-wait .orx__spin{display:block}',
        '.orx__bubble.is-wait .orx__main{padding-right:1.7rem}',
        '.orx__bubble.is-icon .orx__bg{background-size:42%;background-color:#e7eef8}',
        '.orx__bubble::before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(90deg,rgba(255,255,255,.88) 0%,rgba(255,255,255,.55) 52%,rgba(255,255,255,.2) 100%);pointer-events:none}',
        '.orx__bubble.is-photo{color:#fff}',
        '.orx__bubble.is-photo::before{background:linear-gradient(90deg,rgba(6,10,18,.58) 0%,rgba(6,10,18,.22) 46%,rgba(6,10,18,.08) 100%)}',
        '.orx__bubble:hover,.orx__bubble.is-open{z-index:50 !important;animation:none}',
        '.orx__bubble.is-open{height:auto;min-height:72px;margin-top:8px;border-radius:22px}',
        '.orx__row{position:relative;z-index:2;display:flex;align-items:center;min-height:66px}',
        '.orx__main{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;padding:.35rem .3rem .35rem .85rem;font:inherit}',
        '.orx__title{display:block;font-size:.78rem;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.orx__bubble.is-open .orx__title{white-space:normal}',
        '.orx__date{display:block;margin-top:.08rem;font-size:.62rem;font-weight:700;line-height:1.2;color:#475569}',
        '.orx__bubble.is-photo .orx__title,.orx__bubble.is-photo .orx__headline,.orx__bubble.is-photo .orx__desc,.orx__bubble.is-photo .orx__full{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.65)}',
        '.orx__bubble.is-photo .orx__date{color:rgba(255,255,255,.92);text-shadow:0 1px 2px rgba(0,0,0,.65)}',
        '.orx__x{position:relative;z-index:2;flex:none;width:1.35rem;height:1.35rem;margin-right:.45rem;border:0;border-radius:999px;background:rgba(15,23,42,.08);color:#1e293b;cursor:pointer;font-size:.9rem;line-height:1}',
        '.orx__bubble.is-photo .orx__x{background:rgba(0,0,0,.4);color:#fff}',
        '.orx__x:hover{background:rgba(15,23,42,.16)}',
        '.orx__bubble.is-photo .orx__x:hover{background:rgba(0,0,0,.62)}',
        '.orx__full{position:relative;z-index:2;padding:0 .8rem .65rem;font-size:.78rem;line-height:1.4;color:#1e293b}',
        '.orx__headline{font-size:.8rem;font-weight:700;line-height:1.35;margin:0 0 .35rem}',
        '.orx__desc{margin:0 0 .45rem;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.orx__link{display:inline-block;font-size:.74rem;font-weight:800;color:#1d4ed8;text-decoration:underline}',
        '.orx__bubble.is-photo .orx__link{color:#fff}',
        '.orx__chip{display:inline-flex;align-items:center;gap:.35rem;border:0;background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;border-radius:999px;padding:.32rem .75rem;font:inherit;font-size:.74rem;font-weight:800;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 18px -6px rgba(29,78,216,.75)}',
        '.orx__chip:hover{filter:brightness(1.06)}',
        '.orx__chip.is-on{background:linear-gradient(180deg,#1e40af,#1e3a8a);color:#fff}',
        '.orx__chip-x{display:inline-flex;align-items:center;justify-content:center;width:1.05rem;height:1.05rem;border-radius:999px;background:rgba(255,255,255,.22);font-size:.88rem;line-height:1;font-weight:800}',
        '.orx__n{min-width:1.05rem;height:1.05rem;padding:0 .28rem;border-radius:999px;background:#fff;color:#1d4ed8;font-size:.62rem;font-weight:800;line-height:1.05rem;text-align:center}',
        '.orx__arch{width:100%;max-height:min(62vh,460px);overflow:auto;overflow-anchor:none;display:flex;flex-direction:column;gap:.45rem;padding:0 .15rem .15rem 0;background:transparent;border:0;box-shadow:none}',
        '.orx__arch::-webkit-scrollbar{width:6px}',
        '.orx__arch::-webkit-scrollbar-thumb{background:rgba(15,23,42,.28);border-radius:999px}',
        '.orx__bubble--list{margin-top:0;height:64px;flex:none;animation:none}',
        '.orx__bubble--list.is-open{height:auto;min-height:64px;margin-top:0;border-radius:22px}',
        '.orx__empty{padding:.55rem .8rem;font-size:.74rem;font-weight:700;color:#fff;background:#0f172a;border-radius:999px}'
      ].join('');
    }

    function bubbleStyle(it, i) {
      var color = feedColor(it.feed || it.feedtitle || it.id);
      return '--orx-c:' + color + ';z-index:' + (24 - i) + ';animation-delay:' + (i * 0.07) + 's';
    }

    function bgStyle(it) {
      var img = cssUrl(it.img);
      if (!img || imgReady[img] !== 1) return '';
      return 'background-image:url("' + img + '")';
    }

    function paintBubble(id, img, kind) {
      if (!root) return;
      var nodes = root.querySelectorAll('.orx__bubble');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-id') !== id) continue;
        nodes[i].classList.remove('is-wait', 'is-idle', 'is-photo', 'is-icon');
        nodes[i].classList.add(kind === 'icon' ? 'is-icon' : 'is-photo');
        nodes[i].setAttribute('data-img', img);
        var bg = nodes[i].querySelector('.orx__bg');
        if (!bg) continue;
        bg.style.backgroundImage = 'url("' + img + '")';
        if (kind === 'icon') {
          bg.style.backgroundSize = '42%';
          bg.style.backgroundColor = '#e7eef8';
        }
      }
    }

    function idleBubble(id) {
      if (!root) return;
      var nodes = root.querySelectorAll('.orx__bubble');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-id') !== id) continue;
        nodes[i].classList.remove('is-wait');
        nodes[i].classList.add('is-idle');
      }
    }

    function acceptPicture(chan, it, url, kind) {
      var img = cssUrl(url);
      if (!img) return;
      imgReady[img] = 1;
      var list = db.items[chanKey(chan)] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== it.id) continue;
        if (list[i].img !== img || list[i].imgKind !== kind) {
          list[i].img = img;
          list[i].imgKind = kind;
          saveDb();
          ui.rev++;
        }
      }
      paintBubble(it.id, img, kind);
    }

    function probePictures(chan, it, pics) {
      var step = 0;
      function next() {
        if (step >= pics.length) {
          imgMiss[it.id] = true;
          idleBubble(it.id);
          return;
        }
        var pic = pics[step++];
        var img = cssUrl(pic.url);
        if (!img) { next(); return; }
        if (imgReady[img] === 1) {
          acceptPicture(chan, it, img, pic.kind || 'photo');
          return;
        }
        if (imgReady[img] === -1) { next(); return; }
        imgReady[img] = 0;
        var im = new Image();
        im.onload = function () {
          var kind = pic.kind === 'icon' || (im.naturalWidth && im.naturalWidth < 96) ? 'icon' : 'photo';
          acceptPicture(chan, it, img, kind);
        };
        im.onerror = function () {
          imgReady[img] = -1;
          next();
        };
        im.src = img;
      }
      next();
    }

    function siteHost(link) {
      var url = safeHttp(link);
      var m = url.match(/^https?:\/\/([^/?#]+)/i);
      if (!m) return '';
      return m[1].replace(/^www\./i, '');
    }

    function genericFeed(name) {
      return /^(actualit[eé]s?|news|actus?)$/i.test(String(name || '').trim());
    }

    function bubbleLabel(it) {
      var feedTitle = String((it && it.feedtitle) || '').trim();
      var feed = String((it && it.feed) || '').trim();
      var title = String((it && it.title) || '').trim();
      var site = String((it && it.site) || '').trim() || siteHost(it && it.link);
      if (feedTitle && !genericFeed(feedTitle) && feedTitle.toLowerCase() !== feed.toLowerCase()) return feedTitle;
      if (title && title.toLowerCase() !== feed.toLowerCase()) return title;
      if (feedTitle && !genericFeed(feedTitle)) return feedTitle;
      if (feed && !genericFeed(feed)) return feed;
      return site || title || pick({ fr: 'Actualité', en: 'News' });
    }

    function bubbleState(it) {
      var img = cssUrl(it && it.img);
      if (img && imgReady[img] === 1) return it.imgKind === 'icon' ? ' is-icon' : ' is-photo';
      if (imgMiss[it && it.id]) return ' is-idle';
      if ((it && it.link) || img) return ' is-wait';
      return ' is-idle';
    }

    function absUrl(link, raw) {
      var url = String(raw || '').replace(/&amp;/g, '&').trim();
      if (url.indexOf('//') === 0) url = 'https:' + url;
      else if (url.charAt(0) === '/') {
        var origin = String(link || '').match(/^https?:\/\/[^/]+/);
        if (origin) url = origin[0] + url;
      }
      return safeHttp(url);
    }

    function pushPic(list, link, raw, kind) {
      var url = absUrl(link, raw);
      if (!url) return;
      if (/spacer|pixel|1x1|blank\.|tracker|badge|emoji|doubleclick|analytics/i.test(url)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === url) return;
      }
      list.push({ url: url, kind: kind || 'photo' });
    }

    function picsFromHtml(html, link) {
      var page = String(html || '');
      var pics = [];
      var patterns = [
        [/property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/gi, 'photo'],
        [/content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/gi, 'photo'],
        [/name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)/gi, 'photo'],
        [/content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/gi, 'photo']
      ];
      var p, match;
      for (p = 0; p < patterns.length; p++) {
        while ((match = patterns[p][0].exec(page))) pushPic(pics, link, match[1], patterns[p][1]);
      }
      var icons = page.match(/<link\b[^>]*>/gi) || [];
      for (p = 0; p < icons.length; p++) {
        if (!/rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["']/i.test(icons[p])) continue;
        var href = icons[p].match(/href=["']([^"']+)/i);
        if (href) pushPic(pics, link, href[1], 'icon');
      }
      var imgs = page.match(/<img\b[^>]*?\bsrc=["']([^"']+)/gi) || [];
      for (p = 0; p < imgs.length && pics.length < 6; p++) {
        var src = imgs[p].match(/src=["']([^"']+)/i);
        if (src) pushPic(pics, link, src[1], 'photo');
      }
      return pics;
    }

    function siteIcons(link) {
      var match = safeHttp(link).match(/^https?:\/\/[^/]+/);
      var host = match ? match[0] : '';
      if (!host) return [];
      return [
        { url: host + '/apple-touch-icon.png', kind: 'icon' },
        { url: host + '/apple-touch-icon-precomposed.png', kind: 'icon' },
        { url: host + '/favicon.ico', kind: 'icon' }
      ];
    }

    function fillImage(chan, it) {
      if (!it || imgWait[it.id] || imgMiss[it.id]) return;
      if (it.img && imgReady[cssUrl(it.img)] === 1) return;
      var known = [];
      if (it.img) pushPic(known, it.link, it.img, it.imgKind || 'photo');
      if (!it.link) {
        if (known.length) {
          imgWait[it.id] = true;
          probePictures(chan, it, known);
        } else imgMiss[it.id] = true;
        return;
      }
      if (it.img && it.site) {
        imgWait[it.id] = true;
        probePictures(chan, it, known.concat(siteIcons(it.link)));
        return;
      }
      imgWait[it.id] = true;
      var link = it.link;
      fetch(link, { credentials: 'omit' }).then(function (res) {
        if (!res.ok) throw new Error('http');
        return res.text();
      }).then(function (html) {
        var page = String(html || '');
        var pics = known.concat(picsFromHtml(page, link)).concat(siteIcons(link));
        var siteMatch = page.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)/i) ||
          page.match(/content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
        var name = siteMatch ? siteMatch[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
        if (name && name.length < 80) {
          var list = db.items[chanKey(chan)] || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === it.id && !list[i].site) {
              list[i].site = name;
              saveDb();
              ui.rev++;
              paint();
            }
          }
        }
        probePictures(chan, it, pics);
      }).catch(function () {
        probePictures(chan, it, known.concat(siteIcons(link)));
      });
    }

    function bubbleHtml(chan, it, i) {
      var open = ui.expanded === it.id;
      var when = whenLabel(it);
      var label = bubbleLabel(it);
      var img = cssUrl(it.img);
      var full = '';
      if (open) {
        full = '<div class="orx__full">' +
          (it.title ? '<div class="orx__headline">' + esc(it.title) + '</div>' : '') +
          (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
          (it.link ? '<a class="orx__link" data-act="link" data-id="' + esc(it.id) + '" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
            pick({ fr: 'Ouvrir le lien', en: 'Open link' }) + '</a>' : '') +
          '</div>';
      }
      return '<article class="orx__bubble' + bubbleState(it) + (open ? ' is-open' : '') + '" data-id="' + esc(it.id) + '" data-img="' + esc(img) + '" style="' + esc(bubbleStyle(it, i)) + '">' +
        '<span class="orx__bg" style="' + esc(bgStyle(it)) + '"></span>' +
        '<span class="orx__spin" aria-hidden="true"></span>' +
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
      var list = itemsOf(chan).slice(0, listMax());
      list.forEach(function (it) { fillImage(chan, it); });
      if (!list.length) {
        return '<div class="orx__arch"><div class="orx__empty">' +
          esc(pick({ fr: 'Aucune actualité pour le moment.', en: 'No news yet.' })) +
          '</div></div>';
      }
      var rows = list.map(function (it, i) {
        var open = ui.archiveId === it.id;
        var when = whenLabel(it);
        var label = bubbleLabel(it);
        var img = cssUrl(it.img);
        var full = '';
        if (open) {
          full = '<div class="orx__full">' +
            (it.title ? '<div class="orx__headline">' + esc(it.title) + '</div>' : '') +
            (it.desc ? '<div class="orx__desc">' + esc(it.desc) + '</div>' : '') +
            (it.link ? '<a class="orx__link" data-act="link" href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' +
              pick({ fr: 'Ouvrir le lien', en: 'Open link' }) + '</a>' : '') +
            '</div>';
        }
        return '<article class="orx__bubble orx__bubble--list' + bubbleState(it) + (open ? ' is-open' : '') + '" data-id="' + esc(it.id) + '" data-img="' + esc(img) + '" style="' + esc(bubbleStyle(it, i)) + '">' +
          '<span class="orx__bg" style="' + esc(bgStyle(it)) + '"></span>' +
          '<span class="orx__spin" aria-hidden="true"></span>' +
          '<div class="orx__row">' +
            '<button type="button" class="orx__main" data-act="arch" data-id="' + esc(it.id) + '">' +
              '<span class="orx__title">' + esc(label) + '</span>' +
              (when ? '<span class="orx__date">' + esc(when) + '</span>' : '') +
            '</button>' +
          '</div>' + full + '</article>';
      }).join('');
      return '<div class="orx__arch">' + rows + '</div>';
    }

    function render(chan) {
      var list = bubbles(chan);
      list.forEach(function (it) { fillImage(chan, it); });
      var n = unread(chan).length;
      var chipClass = 'orx__chip' + (ui.archive ? ' is-on' : '');
      var badge = n ? '<span class="orx__n">' + (n > 9 ? '9+' : String(n)) + '</span>' : '';
      var close = ui.archive ? '<span class="orx__chip-x" aria-hidden="true">×</span>' : '';
      var game = root.classList.contains('orx--game');
      var portal = game || isNarrow();
      var dragHint = game ? '' : ' title="' + esc(pick({ fr: 'Glisser pour déplacer', en: 'Drag to move' })) + '"';
      root.innerHTML =
        '<button type="button" class="' + chipClass + '" data-act="chip" aria-expanded="' + (ui.archive ? 'true' : 'false') + '"' + dragHint + '>' +
          esc(pick({ fr: 'Actualités', en: 'News' })) + badge + close +
        '</button>' +
        (ui.archive || game ? '' : '<div class="orx__stack">' + list.map(function (it, i) { return bubbleHtml(chan, it, i); }).join('') + '</div>') +
        (portal ? '' : archiveHtml(chan));
    }

    function onRootClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !root) return;
      if (!root.contains(el) && !(archLayer && archLayer.contains(el))) return;
      var chan = root.getAttribute('data-chan') || '';
      var act = el.getAttribute('data-act');
      var id = el.getAttribute('data-id') || '';
      if (act === 'chip') {
        if (root.__orxSkipClick) {
          root.__orxSkipClick = false;
          return;
        }
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

    function gameFull() {
      var body = document.body.classList;
      var rootEl = document.documentElement.classList;
      return body.contains('ohp-full') || body.contains('oec-full') || body.contains('opbac-full') ||
        rootEl.contains('ohp-full') || rootEl.contains('oec-full') || rootEl.contains('opbac-full');
    }

    function shownBox(el) {
      if (!el || !el.getClientRects || !el.getClientRects().length) return null;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
      var box = el.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return null;
      return box;
    }

    function isNarrow() {
      return window.innerWidth < 880;
    }

    function hideArchLayer() {
      if (!archLayer) return;
      archLayer.hidden = true;
      archLayer.innerHTML = '';
      archLayer.removeAttribute('data-orx');
    }

    function useArchLayer() {
      return !!(root && root.classList.contains('orx--set') && (root.classList.contains('orx--game') || isNarrow()));
    }

    function pinArchLayer(chan) {
      if (!archLayer) {
        archLayer = document.createElement('div');
        archLayer.id = 'orx-arch-layer';
        archLayer.className = 'orx-arch-layer';
        archLayer.hidden = true;
        archLayer.addEventListener('click', onRootClick);
        document.body.appendChild(archLayer);
      }
      if (!ui.archive || !root || !useArchLayer()) {
        hideArchLayer();
        return;
      }
      var chip = root.querySelector('.orx__chip');
      var box = chip && chip.getBoundingClientRect();
      if (!box || box.width < 8) {
        hideArchLayer();
        return;
      }
      var key = chanKey(chan) + '|' + ui.archiveId + '|' + ui.rev;
      if (archLayer.getAttribute('data-orx') !== key) {
        var keep = archLayer.scrollTop;
        archLayer.innerHTML = archiveHtml(chan);
        archLayer.setAttribute('data-orx', key);
        archLayer.scrollTop = keep;
      }
      var vv = window.visualViewport;
      var vw = Math.round((vv && vv.width) || window.innerWidth);
      var vh = Math.round((vv && vv.height) || window.innerHeight);
      var topOff = vv ? Math.round(vv.offsetTop || 0) : 0;
      var head = root.closest('.ohp-head, .oec-head, .opbac-head');
      var headBox = shownBox(head);
      var top = Math.round((headBox ? headBox.bottom : box.bottom) + 8);
      var maxH = Math.max(140, vh + topOff - top - 16);
      archLayer.hidden = false;
      archLayer.style.top = top + 'px';
      archLayer.style.maxHeight = maxH + 'px';
      if (isNarrow()) {
        archLayer.style.left = '8px';
        archLayer.style.right = '8px';
        archLayer.style.width = 'auto';
      } else {
        var width = Math.min(360, vw - 16);
        var right = Math.max(8, Math.round(vw - box.right));
        if (vw - right - width < 8) right = Math.max(8, vw - width - 8);
        archLayer.style.left = 'auto';
        archLayer.style.right = right + 'px';
        archLayer.style.width = width + 'px';
      }
    }

    function conceal() {
      if (root) {
        root.__orxPlace = '';
        root.__orxSince = 0;
        root.classList.remove('orx--set');
      }
      hideArchLayer();
    }

    function hidePlace() {
      conceal();
    }

    function chatOnlyPanel(panel) {
      return !!(panel && (
        panel.classList.contains('ohp-panel--chat') ||
        panel.classList.contains('oec-panel--chat') ||
        panel.classList.contains('opbac-panel--chat')
      ));
    }

    function markedFullPanel(panel) {
      return gameFull() || !!(panel && (
        panel.classList.contains('ohp-panel--full') ||
        panel.classList.contains('oec-panel--full') ||
        panel.classList.contains('opbac-panel--full')
      ));
    }

    function panelCovers(panel) {
      var box = shownBox(panel);
      var main = document.querySelector('.main');
      var mainBox = main && main.getBoundingClientRect();
      if (!box || !mainBox || mainBox.height < 40 || mainBox.width < 40) return false;
      return box.height > mainBox.height * 0.55 && box.width > mainBox.width * 0.72;
    }

    function visibleGameHead() {
      var heads = document.querySelectorAll('.ohp-head, .oec-head, .opbac-head');
      for (var i = 0; i < heads.length; i++) {
        var head = heads[i];
        if (!shownBox(head)) continue;
        var panel = head.closest('#ohp-dom-panel, #oec-dom-panel, #opbac-dom-panel');
        if (!panel || panel.hidden || !shownBox(panel)) continue;
        return head;
      }
      return null;
    }

    function visibleFullGamePanel() {
      var ids = ['ohp-dom-panel', 'oec-dom-panel', 'opbac-dom-panel'];
      for (var i = 0; i < ids.length; i++) {
        var panel = document.getElementById(ids[i]);
        if (!panel || panel.hidden || chatOnlyPanel(panel) || !shownBox(panel)) continue;
        if (markedFullPanel(panel) || panelCovers(panel)) return panel;
      }
      return null;
    }

    function topicBottom(hero) {
      var heroBox = shownBox(hero);
      if (!heroBox || hero.offsetHeight < 36) return null;
      return {
        bottom: heroBox.bottom,
        mark: Math.round(heroBox.top) + ':' + Math.round(heroBox.height)
      };
    }

    function dockInHead(head) {
      root.classList.add('orx--game');
      root.style.top = '';
      root.style.right = '';
      root.style.left = '';
      root.style.bottom = '';
      var actions = head.querySelector('.ohp-head__actions, .oec-head__actions, .opbac-head__actions');
      var host = actions || head;
      if (root.parentNode !== host || (actions && root !== actions.firstChild)) {
        if (actions) actions.insertBefore(root, actions.firstChild);
        else head.appendChild(root);
      }
    }

    function dockInMain(main) {
      root.classList.remove('orx--game');
      if (root.parentNode !== main) main.appendChild(root);
    }

    function posMap() {
      try {
        var stored = pluginOrbit && pluginOrbit.storage && pluginOrbit.storage.get('rssPos', {});
        return stored && typeof stored === 'object' ? stored : {};
      } catch (e) {
        return {};
      }
    }

    function savedPos(chan) {
      var p = posMap()[chanKey(chan)];
      if (!p || !isFinite(p.top) || !isFinite(p.right)) return null;
      return { top: Number(p.top), right: Number(p.right) };
    }

    function savePos(chan, top, right) {
      var all = posMap();
      all[chanKey(chan)] = { top: Math.round(top), right: Math.round(right) };
      try {
        if (pluginOrbit && pluginOrbit.storage) pluginOrbit.storage.set('rssPos', all);
      } catch (e) { /* quota */ }
    }

    function salonBounds(main) {
      var mainBox = main.getBoundingClientRect();
      var minTop = 8;
      var bar = shownBox(main.querySelector('.topbar'));
      if (bar) minTop = Math.max(minTop, Math.ceil(bar.bottom - mainBox.top + 6));
      var maxBottom = mainBox.height - 8;
      var foot = shownBox(main.querySelector('.composer'));
      if (foot) maxBottom = Math.min(maxBottom, Math.floor(foot.top - mainBox.top - 8));
      if (maxBottom < minTop + 28) maxBottom = mainBox.height - 8;
      return { minTop: minTop, maxBottom: maxBottom, width: mainBox.width };
    }

    function clampPos(main, top, right) {
      var room = salonBounds(main);
      var box = root.getBoundingClientRect();
      var w = Math.max(box.width, 72);
      var h = Math.max(box.height, 28);
      var maxTop = Math.max(room.minTop, room.maxBottom - h);
      return {
        top: Math.min(Math.max(room.minTop, top), maxTop),
        right: Math.min(Math.max(8, right), Math.max(8, room.width - w - 8))
      };
    }

    function applyPos(main, top, right) {
      var p = clampPos(main, top, right);
      root.style.top = p.top + 'px';
      root.style.right = p.right + 'px';
      root.style.left = 'auto';
      return p;
    }

    function onDragMove(ev) {
      if (!drag.on || ev.pointerId !== drag.id || !root) return;
      var dx = ev.clientX - drag.x;
      var dy = ev.clientY - drag.y;
      if (!drag.moved && dx * dx + dy * dy < 36) return;
      drag.moved = true;
      var main = root.parentNode;
      if (!main || !main.classList.contains('main')) return;
      applyPos(main, drag.top + dy, drag.right - dx);
      ev.preventDefault();
    }

    function onDragEnd(ev) {
      if (!drag.on || ev.pointerId !== drag.id) return;
      drag.on = false;
      if (root) root.classList.remove('orx--drag');
      window.removeEventListener('pointermove', onDragMove, true);
      window.removeEventListener('pointerup', onDragEnd, true);
      window.removeEventListener('pointercancel', onDragEnd, true);
      if (!drag.moved || !root) return;
      var main = root.parentNode;
      if (!main || !main.classList.contains('main')) return;
      var box = root.getBoundingClientRect();
      var mainBox = main.getBoundingClientRect();
      var p = applyPos(main, box.top - mainBox.top, mainBox.right - box.right);
      savePos(root.getAttribute('data-chan') || activeChan(), p.top, p.right);
      root.__orxSkipClick = true;
    }

    function onDragStart(ev) {
      if (!root || root.classList.contains('orx--game')) return;
      var chip = ev.target && ev.target.closest ? ev.target.closest('.orx__chip') : null;
      if (!chip || !root.contains(chip)) return;
      var main = root.parentNode;
      if (!main || !main.classList.contains('main')) return;
      var box = root.getBoundingClientRect();
      var mainBox = main.getBoundingClientRect();
      drag.on = true;
      drag.moved = false;
      drag.id = ev.pointerId;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      drag.top = box.top - mainBox.top;
      drag.right = mainBox.right - box.right;
      root.classList.add('orx--drag');
      try { chip.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      window.addEventListener('pointermove', onDragMove, true);
      window.addEventListener('pointerup', onDragEnd, true);
      window.addEventListener('pointercancel', onDragEnd, true);
    }

    function bindDrag() {
      if (!root || root.__orxDrag) return;
      root.__orxDrag = true;
      root.addEventListener('pointerdown', onDragStart);
    }

    function moveTop(viewportTop) {
      root.style.top = '0px';
      var origin = root.getBoundingClientRect().top;
      root.style.top = Math.max(0, Math.round(viewportTop - origin)) + 'px';
    }

    function holdPlace(key, verify) {
      var now = Date.now();
      if (root.__orxPlace !== key) {
        root.__orxPlace = key;
        root.__orxSince = now;
        root.classList.remove('orx--set');
      }
      if (verify && !verify()) {
        root.classList.remove('orx--set');
        root.__orxSince = now;
        return;
      }
      if (root.classList.contains('orx--set')) return;
      if (now - root.__orxSince < 280) {
        if (!root.__orxTimer) {
          root.__orxTimer = setTimeout(function () {
            root.__orxTimer = 0;
            paint();
          }, 300);
        }
        return;
      }
      root.classList.add('orx--set');
    }

    function place(main, hero) {
      if (drag.on) return;
      var head = visibleGameHead();
      if (!head && visibleFullGamePanel()) {
        dockInMain(main);
        root.classList.add('orx--game');
        hidePlace();
        return;
      }
      if (head) {
        dockInHead(head);
        holdPlace('game:' + (head.className || 'head') + ':' + Math.round((shownBox(head) || {}).width || 0), function () {
          if (!head.contains(root)) return false;
          var again = shownBox(head);
          var box = root.getBoundingClientRect();
          if (!again || box.width < 8 || box.height < 8) return false;
          var mid = box.top + Math.min(box.height, 36) / 2;
          return mid >= again.top - 2 && mid <= again.bottom + 2 &&
            box.left >= again.left - 4 && box.right <= again.right + 4;
        });
        return;
      }
      dockInMain(main);
      var saved = savedPos(root.__orxChan || (hero && hero.getAttribute('data-chan')) || '');
      if (saved) {
        applyPos(main, saved.top, saved.right);
        root.__orxPlace = 'moved:' + Math.round(saved.top) + ':' + Math.round(saved.right);
        root.classList.add('orx--set');
        return;
      }
      root.style.right = '';
      var banner = topicBottom(hero);
      if (!banner) {
        hidePlace();
        return;
      }
      moveTop(banner.bottom + 8);
      holdPlace('chat:' + banner.mark, function () {
        var again = topicBottom(hero);
        if (!again || Math.abs(again.bottom - banner.bottom) > 3) return false;
        var box = root.getBoundingClientRect();
        return box.top + 2 >= again.bottom && box.top <= again.bottom + 36;
      });
    }

    function paint() {
      if (!pluginOrbit) return;
      var hero = document.querySelector('.chan-hero');
      var main = hero && hero.closest ? hero.closest('.main') : null;
      var chan = hero ? (hero.getAttribute('data-chan') || activeChan()) : '';
      var live = chanKey(activeChan());
      var shown = chanKey(chan);
      if (!hero || !main || !gate(chan) || (live && shown && live !== shown)) {
        conceal();
        if ((!hero || !main || !gate(chan)) && root && root.parentNode) root.parentNode.removeChild(root);
        return;
      }
      if (!root) {
        root = document.createElement('div');
        root.className = 'orx';
        root.addEventListener('click', onRootClick);
      }
      bindDrag();
      if (root.__orxChan && root.__orxChan !== shown) {
        ui.expanded = '';
        ui.archive = false;
        ui.archiveId = '';
        conceal();
      }
      root.__orxChan = shown;
      place(main, hero);
      requestHistory(chan);
      harvest(chan);
      root.setAttribute('data-chan', chan);
      var sig = shown + '|' + ui.rev + '|' + ui.expanded + '|' + (ui.archive ? '1' : '0') + '|' +
        ui.archiveId + '|' + unread(chan).length + '|' + itemsOf(chan).length;
      if (root.__orxSig === sig) {
        pinArchLayer(chan);
        return;
      }
      root.__orxSig = sig;
      var archKeep = 0;
      var archNow = root.querySelector('.orx__arch');
      if (archNow) archKeep = archNow.scrollTop;
      render(chan);
      var archNext = root.querySelector('.orx__arch');
      if (archNext) {
        archNext.scrollTop = archKeep;
        requestAnimationFrame(function () {
          if (archNext.isConnected) archNext.scrollTop = archKeep;
        });
      }
      place(main, hero);
      pinArchLayer(chan);
    }

    Orbit.plugin('orbit-rss', function (orbit) {
      pluginOrbit = orbit;
      loadDb();
      injectStyles();
      console.info('[orbit-rss] loaded v' + ORX_VER);

      if (orbit.addMessageFilter) {
        orbit.addMessageFilter(function (m) {
          if (!m) return false;
          var cmd = String(m.command || '').toUpperCase();
          if ((cmd === 'PRIVMSG' || cmd === 'NOTICE') &&
              /(?:^|\s)rss_?ircv3\s+recent\b/i.test(String(m.text || '')) &&
              (fromBot(m.nick) || fromBot(m.target))) return true;
          if (tagVal(m.tags, RSS) !== 'v1') return false;
          if (cmd !== 'PRIVMSG' && cmd !== 'NOTICE') return false;
          ingest(m.target, m.tags, m.text, m.nick);
          paint();
          return true;
        });
      }

      orbit.on('raw', function (msg) {
        var cmd = String(msg.command || '').toUpperCase();
        if (cmd !== 'TAGMSG') return;
        var tags = msg.tags || {};
        if (tagVal(tags, RSS) !== 'v1') return;
        var histChan = tagVal(tags, '+chan');
        if (tagVal(tags, EV) === 'hist' && histChan) {
          rememberHist(histChan, tags);
          paint();
          return;
        }
        var target = (msg.params && msg.params[0]) || '';
        if (!target || target.charAt(0) !== '#') return;
        handleItem(target, tags);
        paint();
      });

      document.addEventListener('pointerdown', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('.room') : null;
        if (!t || t.classList.contains('is-active')) return;
        if (ev.target.closest && ev.target.closest('.room__close')) return;
        conceal();
        ui.expanded = '';
        ui.archive = false;
        ui.archiveId = '';
      }, true);
      orbit.on('buffer.active', function () {
        conceal();
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
