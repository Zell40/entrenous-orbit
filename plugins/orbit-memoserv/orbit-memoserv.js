/*!
 * orbit-memoserv — boîte de mémos Anope (service « Message » sur Entre Nous).
 *
 * Envoi et lecture passent par PRIVMSG vers le pseudo MemoServ (LIST, READ,
 * SEND, RSEND, DEL, CHECK, CANCEL, IGNORE). Les notices de service sont
 * masquées du salon et affichées ici. SENDALL / STAFF restent en ligne
 * de commande (opérateurs).
 *
 * config.json :
 *   "memoserv": { "service": "Message" }
 *   "plugins": ["/app/plugins/third/orbit-memoserv/orbit-memoserv.js?v=1"]
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function boot(retry) {
    if (typeof Orbit === 'undefined' || !Orbit.plugin) {
      if (typeof window !== 'undefined' && retry < 80) {
        window.setTimeout(function () { boot(retry + 1); }, 50);
      }
      return;
    }
    if (window.__ORBIT_MEMOSERV__ === api.VER) return;
    window.__ORBIT_MEMOSERV__ = api.VER;
    startPlugin(api);
  }

  if (typeof window !== 'undefined') boot(0);

  function startPlugin(parse) {
    var BUF = 'Mémos';
    var TEXT_MAX = 200;
    var COALESCE_MS = 280;

    Orbit.plugin('orbit-memoserv', function (orbit, log) {
      var h = orbit.React.createElement;
      var useEffect = orbit.React.useEffect;
      var useSyncExternalStore = orbit.React.useSyncExternalStore;

      function pick(table) {
        return orbit.i18n.pick(table);
      }
      function fold(s) {
        return String(s || '').trim().toLowerCase();
      }
      function serviceNick() {
        var cfg = (orbit.config() && orbit.config().memoserv) || {};
        var nick = String(cfg.service || 'Message').trim();
        return nick || 'Message';
      }
      function isSvc(name) {
        return fold(name) === fold(serviceNick());
      }
      function state() {
        try { return orbit.state.get(); } catch (e) { return null; }
      }
      function myNick() {
        try { return orbit.state.nick() || ''; } catch (e) { return ''; }
      }
      function myAccount() {
        try { return orbit.state.account() || ''; } catch (e) { return ''; }
      }

      var ui = {
        open: false,
        prev: '',
        closing: false,
        screen: 'list',
        memos: [],
        ignores: [],
        reading: 0,
        to: '',
        draft: '',
        receipt: false,
        ignoreDraft: '',
        flash: '',
        flashErr: false,
        loading: false,
        needId: false,
        listed: false,
        unreadHint: 0,
        pendingArrivals: 0,
        rev: 0,
        subs: [],
      };
      var pending = { kind: '', lines: [], timer: 0, coalesce: 0 };
      var hideUntil = 0;
      var listTimer = 0;

      function bump() {
        ui.rev++;
        ui.subs.forEach(function (fn) { fn(); });
      }
      function subscribe(fn) {
        ui.subs.push(fn);
        return function () {
          ui.subs = ui.subs.filter(function (f) { return f !== fn; });
        };
      }
      function snap() { return ui.rev; }

      function listedUnread() {
        var n = 0;
        ui.memos.forEach(function (m) { if (m.unread) n++; });
        return n;
      }
      function badgeCount() {
        return Math.max(listedUnread(), ui.unreadHint || 0);
      }
      function findMemo(id) {
        for (var i = 0; i < ui.memos.length; i++) {
          if (ui.memos[i].id === id) return ui.memos[i];
        }
        return null;
      }

      function setFlash(text, err) {
        ui.flash = String(text || '').trim();
        ui.flashErr = !!err;
      }

      function injectCss() {
        var id = 'orbit-memoserv-css';
        if (document.getElementById(id)) return;
        var el = document.createElement('style');
        el.id = id;
        el.textContent = [
          'body.oms-open .messages,body.oms-open .composer,body.oms-open .chan-hero,body.oms-open .main__room-bg,body.oms-open .empty{display:none!important}',
          'body.oms-open .main{background:var(--bg)}',
          'body.oms-open .topbar__sub{display:none!important}',
          'body.oms-open .topbar__modes,body.oms-open .topbar__pill,body.oms-open .topbar__manage,body.oms-open .members{display:none!important}',
          'body.oms-open .topbar .topbar__search:not(.topbar__hide-mobile){display:none!important}',
          '.room__av[data-oms]{background:color-mix(in srgb,var(--accent,#2563eb) 16%,var(--bg,#fff));color:var(--accent-d,#1d4ed8)}',
          '.oms-view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg,#fff);color:var(--ink,#111)}',
          '.oms-bar{display:flex;align-items:center;gap:.4rem;flex:none;padding:.7rem 1rem;border-bottom:1px solid var(--border,rgba(0,0,0,.08))}',
          '.oms-bar__title{margin:0;font-size:1.02rem;font-weight:800;letter-spacing:-.02em;flex:1;min-width:0}',
          '.oms-bar__sub{display:block;font-size:.75rem;font-weight:500;color:var(--muted,var(--faint));margin-top:.1rem}',
          '.oms-iconbtn{border:0;background:transparent;color:var(--muted,#666);width:2rem;height:2rem;border-radius:8px;cursor:pointer;font:inherit;font-size:1rem;line-height:1}',
          '.oms-iconbtn:hover,.oms-iconbtn:focus-visible{background:color-mix(in srgb,var(--ink,#111) 8%,transparent);color:var(--ink,#111);outline:none}',
          '.oms-flash{margin:.75rem 1rem 0;padding:.55rem .7rem;border-radius:10px;font-size:.84rem;line-height:1.35;background:color-mix(in srgb,#16a34a 12%,var(--bg,#fff));color:var(--ink,#111)}',
          '.oms-flash--err{background:color-mix(in srgb,#e11d48 12%,var(--bg,#fff))}',
          '.oms-body{flex:1 1 auto;min-height:0;overflow:auto;padding:.4rem 0 1rem}',
          '.oms-empty{padding:1.4rem 1.2rem;color:var(--muted,var(--faint));font-size:.92rem;line-height:1.45}',
          '.oms-row{display:flex;gap:.7rem;align-items:flex-start;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border,rgba(0,0,0,.06));background:transparent;color:inherit;font:inherit;padding:.75rem 1rem;cursor:pointer}',
          '.oms-row:hover,.oms-row:focus-visible{background:color-mix(in srgb,var(--accent,#2563eb) 8%,transparent);outline:none}',
          '.oms-row.is-unread .oms-row__from{font-weight:800}',
          '.oms-dot{width:.55rem;height:.55rem;border-radius:50%;margin-top:.4rem;flex:none;background:transparent}',
          '.oms-row.is-unread .oms-dot{background:var(--accent,#2563eb)}',
          '.oms-row__from{font-size:.95rem;font-weight:700}',
          '.oms-row__when{display:block;font-size:.75rem;color:var(--muted,var(--faint));margin-top:.12rem}',
          '.oms-read{padding:1rem 1.15rem 1.4rem}',
          '.oms-read__who{margin:0;font-size:1.05rem;font-weight:800}',
          '.oms-read__when{margin:.2rem 0 .8rem;color:var(--muted,var(--faint));font-size:.8rem}',
          '.oms-read__text{margin:0;white-space:pre-wrap;word-break:break-word;font-size:.98rem;line-height:1.45}',
          '.oms-actions{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:1rem}',
          '.oms-btn{border:0;border-radius:10px;padding:.5rem .8rem;font:inherit;font-size:.86rem;font-weight:700;cursor:pointer;background:var(--bg-soft,#f3f4f6);color:var(--ink,#111)}',
          '.oms-btn:hover,.oms-btn:focus-visible{filter:brightness(.97);outline:none}',
          '.oms-btn--go{background:var(--accent,#2563eb);color:#fff}',
          '.oms-btn--warn{color:var(--danger,#be123c);background:color-mix(in srgb,#e11d48 10%,var(--bg,#fff))}',
          '.oms-form{display:flex;flex-direction:column;gap:.55rem;padding:1rem 1.15rem 1.3rem}',
          '.oms-form label{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;font-weight:700;color:var(--muted,var(--faint))}',
          '.oms-form input[type=text],.oms-form textarea{font:inherit;font-size:.95rem;font-weight:500;color:var(--ink,#111);background:var(--bg,#fff);border:1px solid var(--border,rgba(0,0,0,.15));border-radius:10px;padding:.55rem .7rem}',
          '.oms-form textarea{min-height:7rem;resize:vertical}',
          '.oms-check{flex-direction:row!important;align-items:center;gap:.45rem;font-size:.86rem!important;font-weight:600!important;color:var(--ink,#111)!important}',
          '.oms-hint{margin:0;font-size:.78rem;color:var(--muted,var(--faint));line-height:1.4}',
          '.oms-count{align-self:flex-end;font-size:.72rem;color:var(--muted,var(--faint))}',
          '.oms-ign{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.55rem 1rem;border-bottom:1px solid var(--border,rgba(0,0,0,.06))}',
          '.oms-ign span{font-weight:700}',
        ].join('');
        document.head.appendChild(el);
      }

      function hideNativeRow() {
        try {
          var rooms = document.querySelector('.rooms');
          if (!rooms) return;
          rooms.querySelectorAll('.room:not(.oms-room)').forEach(function (row) {
            var nm = row.querySelector('.room__name');
            var label = nm ? String(nm.textContent || '').trim() : '';
            if (fold(label) === fold(BUF)) {
              row.hidden = true;
              row.setAttribute('data-oms-hide', '1');
            }
          });
        } catch (e) { /* ignore */ }
      }

      function validTarget(raw) {
        var s = String(raw || '').trim();
        if (!s || /\s/.test(s) || s.length > 50) return '';
        if (s.charAt(0) === '#' || s.charAt(0) === '&') return s.length > 1 ? s : '';
        if (!/^[A-Za-z0-9\[\]\\`_^{|}-]+$/.test(s)) return '';
        if (isSvc(s)) return '';
        return s;
      }

      function cleanDraft(raw) {
        return String(raw || '').replace(/[\r\n\x01]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
      }

      function sendCmd(kind, line) {
        pending.kind = kind;
        pending.lines = [];
        hideUntil = Date.now() + 5000;
        ui.loading = true;
        bump();
        try { orbit.irc.msg(serviceNick(), line); }
        catch (e) { log('send failed', e); }
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(function () {
          if (pending.kind === kind) flush();
        }, 4500);
      }

      var queueList = false;
      function requestList() {
        if (!myNick()) return;
        if (pending.kind && pending.kind !== 'list') { queueList = true; return; }
        if (pending.kind === 'list') return;
        sendCmd('list', 'LIST');
      }
      function scheduleList() {
        if (listTimer) clearTimeout(listTimer);
        listTimer = setTimeout(function () {
          listTimer = 0;
          requestList();
        }, 600);
      }

      function applyList(lines) {
        var parsed = parse.parseList(lines);
        if (parsed.denied) {
          ui.needId = true;
          setFlash(parsed.note || pick({
            fr: 'Identifiez-vous auprès de NickServ pour utiliser les mémos.',
            en: 'Identify with NickServ to use memos.',
          }), true);
          return;
        }
        ui.needId = false;
        if (parsed.ok) {
          var kept = {};
          ui.memos.forEach(function (m) { if (m.text) kept[m.id] = m.text; });
          ui.memos = parsed.rows.map(function (r) {
            r.text = kept[r.id] || '';
            return r;
          });
          ui.listed = true;
          ui.pendingArrivals = 0;
          ui.unreadHint = 0;
          if (ui.reading && !findMemo(ui.reading)) ui.reading = 0;
        }
        if (parsed.denied) setFlash(parsed.note, true);
        else if (parsed.ok) setFlash('', false);
      }

      function applyRead(lines) {
        var reads = parse.parseRead(lines);
        if (!reads.length) {
          var note = parse.leftover(lines);
          setFlash(note || pick({ fr: 'Mémo introuvable.', en: 'Memo not found.' }), true);
          return;
        }
        reads.forEach(function (r) {
          var m = findMemo(r.id);
          if (!m) {
            m = { id: r.id, sender: r.sender, when: r.when, unread: false, text: r.text };
            ui.memos.push(m);
          }
          m.sender = r.sender || m.sender;
          m.when = r.when || m.when;
          m.text = r.text;
          m.unread = false;
          ui.reading = r.id;
        });
        ui.screen = 'read';
        ui.pendingArrivals = 0;
        ui.unreadHint = listedUnread();
        setFlash('', false);
      }

      function flush() {
        var kind = pending.kind;
        var lines = pending.lines.slice();
        pending.kind = '';
        pending.lines = [];
        hideUntil = 0;
        ui.loading = false;
        if (pending.timer) { clearTimeout(pending.timer); pending.timer = 0; }
        if (pending.coalesce) { clearTimeout(pending.coalesce); pending.coalesce = 0; }

        if (kind === 'list') applyList(lines);
        else if (kind === 'read') applyRead(lines);
        else if (kind === 'ignore') {
          var ig = parse.parseIgnore(lines);
          if (ig.ok) ui.ignores = ig.masks;
          var note = parse.leftover(lines);
          if (note) setFlash(note, parse.looksError(note));
          else setFlash('', false);
        } else if (kind) {
          var left = parse.leftover(lines);
          var err = parse.looksError(left);
          setFlash(left, err);
          if (kind === 'send' && left && !err) {
            ui.draft = '';
            ui.screen = 'list';
          }
          if (kind === 'del' && left && !err) requestList();
          if ((kind === 'ignore-add' || kind === 'ignore-del') && !err) {
            sendCmd('ignore', 'IGNORE LIST');
          }
        }
        bump();
        if (queueList && !pending.kind) {
          queueList = false;
          requestList();
        }
      }

      function pushLine(text) {
        pending.lines.push(text);
        hideUntil = Date.now() + 2000;
        if (pending.coalesce) clearTimeout(pending.coalesce);
        pending.coalesce = setTimeout(flush, COALESCE_MS);
      }

      function onArrival(from) {
        ui.pendingArrivals += 1;
        ui.unreadHint = listedUnread() + ui.pendingArrivals;
        bump();
        scheduleList();
        if (!ui.open || (typeof document !== 'undefined' && document.hidden)) {
          orbit.notify(
            pick({ fr: 'Nouveau mémo', en: 'New memo' }),
            from
              ? pick({ fr: 'De ' + from, en: 'From ' + from })
              : pick({ fr: 'Vous avez un nouveau mémo.', en: 'You have a new memo.' })
          );
        }
      }

      function onRaw(msg) {
        if (!msg) return;
        var cmd = String(msg.command || '').toUpperCase();
        if (cmd === '900') { ui.needId = false; scheduleList(); return; }
        if (cmd === 'ACCOUNT' && fold(msg.nick) === fold(myNick())) { ui.needId = false; scheduleList(); return; }
        if (cmd !== 'NOTICE' && cmd !== 'PRIVMSG') return;
        if (!isSvc(msg.nick)) return;
        var text = parse.stripIrc((msg.params && msg.params[1]) || '');
        if (!text || text.charAt(0) === '\x01') return;
        var info = parse.classifyNotice(text);
        if (info && info.type === 'arrival') onArrival(info.from);
        else if (info && info.type === 'channel') {
          onArrival('');
          if (info.channel) {
            setFlash(pick({
              fr: 'Nouveau mémo sur ' + info.channel + '.',
              en: 'New memo on ' + info.channel + '.',
            }), false);
          }
        } else if (info && info.type === 'count') {
          ui.unreadHint = Math.max(ui.unreadHint || 0, info.n);
          bump();
          scheduleList();
        } else if (info && info.type === 'full') {
          setFlash(text, true);
          bump();
        }
        if (pending.kind && Date.now() < hideUntil + 50) pushLine(text);
      }

      function shouldHide(m) {
        var cmd = String(m.command || '').toUpperCase();
        if (cmd !== 'NOTICE' && cmd !== 'PRIVMSG') return false;
        if (cmd === 'PRIVMSG' && isSvc(m.target)) return true;
        if (!isSvc(m.nick)) return false;
        var text = parse.stripIrc(m.text || '');
        if (!text || text.charAt(0) === '\x01') return false;
        if (parse.isQuietNotice(text)) return true;
        if (pending.kind && Date.now() < hideUntil) return true;
        return false;
      }

      function openView(screen) {
        injectCss();
        var st = state();
        var cur = '';
        try { cur = orbit.state.active() || ''; } catch (e) { /* ignore */ }
        if (cur && fold(cur) !== fold(BUF)) ui.prev = cur;
        ui.open = true;
        if (screen) ui.screen = screen;
        try { document.body.classList.add('oms-open'); } catch (e2) { /* ignore */ }
        bump();
        try { if (st && st.setActive) st.setActive(BUF); } catch (e3) { /* ignore */ }
        hideNativeRow();
        if (!ui.listed) requestList();
      }

      function closeView() {
        if (!ui.open && !ui.closing) {
          try { document.body.classList.remove('oms-open'); } catch (e) { /* ignore */ }
        }
        if (!ui.open) return;
        ui.closing = true;
        var prev = ui.prev;
        ui.open = false;
        ui.prev = '';
        try { document.body.classList.remove('oms-open'); } catch (e2) { /* ignore */ }
        bump();
        var st = state();
        try { if (st && st.closeBuffer) st.closeBuffer(BUF); } catch (e3) { /* ignore */ }
        if (prev && fold(prev) !== fold(BUF)) {
          try { if (st && st.setActive) st.setActive(prev); } catch (e4) { /* ignore */ }
        }
        ui.closing = false;
      }

      function openCompose(nick) {
        ui.to = nick || ui.to || '';
        ui.screen = 'write';
        ui.receipt = false;
        openView('write');
      }

      function sendMemo() {
        var target = validTarget(ui.to);
        var text = cleanDraft(ui.draft);
        if (!target) {
          setFlash(pick({
            fr: 'Indiquez un pseudo enregistré, ou un salon (#…).',
            en: 'Enter a registered nick, or a channel (#…).',
          }), true);
          bump();
          return;
        }
        if (!text) {
          setFlash(pick({ fr: 'Le message est vide.', en: 'The message is empty.' }), true);
          bump();
          return;
        }
        var self = fold(target) === fold(myNick()) || (myAccount() && fold(target) === fold(myAccount()));
        var cmd = (ui.receipt && !self) ? 'RSEND' : 'SEND';
        sendCmd('send', cmd + ' ' + target + ' ' + text);
      }

      function readMemo(id) {
        var m = findMemo(id);
        ui.reading = id;
        ui.screen = 'read';
        bump();
        if (m && m.text && !m.unread) return;
        sendCmd('read', 'READ ' + id);
      }

      function deleteMemo(id) {
        var ok = true;
        try {
          ok = window.confirm(pick({
            fr: 'Supprimer le mémo ' + id + ' ?',
            en: 'Delete memo ' + id + '?',
          }));
        } catch (e) { ok = true; }
        if (!ok) return;
        ui.screen = 'list';
        ui.reading = 0;
        sendCmd('del', 'DEL ' + id);
      }

      function IconMail() {
        return h('svg', {
          width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
          h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
          h('path', { d: 'M3 7l9 7 9-7' })
        );
      }

      function MemoRoomRow() {
        useSyncExternalStore(subscribe, snap, snap);
        var n = badgeCount();
        var sub = !ui.listed
          ? pick({ fr: 'Messages hors ligne', en: 'Offline messages' })
          : n
            ? (n > 1
              ? pick({ fr: n + ' non lus', en: n + ' unread' })
              : pick({ fr: '1 non lu', en: '1 unread' }))
            : pick({ fr: 'Aucun mémo', en: 'No memos' });
        return h('div', {
          className: 'room oms-room' + (ui.open ? ' is-active' : '') + (n ? ' has-unread' : ''),
          role: 'button',
          tabIndex: 0,
          title: pick({ fr: 'Mémos', en: 'Memos' }),
          onClick: function () { if (ui.open) openView(); else openView('list'); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              try { e.preventDefault(); } catch (err) { /* ignore */ }
              openView(ui.open ? ui.screen : 'list');
            }
          },
        },
          h('span', { className: 'room__av', 'data-oms': '1', 'aria-hidden': true }, h(IconMail)),
          h('span', { className: 'room__body' },
            h('span', { className: 'room__name' }, pick({ fr: 'Mémos', en: 'Memos' })),
            h('span', { className: 'room__sub' }, sub)
          ),
          n ? h('span', { className: 'room__badge' }, n > 99 ? '99+' : String(n)) : null,
          ui.open ? h('button', {
            type: 'button',
            className: 'room__close',
            title: pick({ fr: 'Fermer', en: 'Close' }),
            'aria-label': pick({ fr: 'Fermer les mémos', en: 'Close memos' }),
            onClick: function (e) {
              try { e.stopPropagation(); } catch (err) { /* ignore */ }
              closeView();
            },
          }, '✕') : null
        );
      }

      function bar(title, sub) {
        return h('div', { className: 'oms-bar' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h2', { className: 'oms-bar__title' }, title),
            sub ? h('span', { className: 'oms-bar__sub' }, sub) : null
          ),
          ui.screen !== 'list' ? h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Retour', en: 'Back' }),
            'aria-label': pick({ fr: 'Retour à la liste', en: 'Back to the list' }),
            onClick: function () { ui.screen = 'list'; setFlash('', false); bump(); },
          }, '←') : null,
          h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Actualiser', en: 'Refresh' }),
            'aria-label': pick({ fr: 'Actualiser les mémos', en: 'Refresh memos' }),
            onClick: function () { requestList(); },
          }, '↻'),
          ui.screen !== 'write' ? h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Nouveau mémo', en: 'New memo' }),
            'aria-label': pick({ fr: 'Nouveau mémo', en: 'New memo' }),
            onClick: function () { ui.screen = 'write'; setFlash('', false); bump(); },
          }, '+') : null
        );
      }

      function flashEl() {
        if (!ui.flash) return null;
        return h('div', {
          className: 'oms-flash' + (ui.flashErr ? ' oms-flash--err' : ''),
          role: 'status',
        }, ui.flash);
      }

      function ListScreen() {
        if (ui.loading && !ui.memos.length) {
          return h('p', { className: 'oms-empty' }, pick({ fr: 'Chargement des mémos…', en: 'Loading memos…' }));
        }
        if (ui.needId && !ui.memos.length) {
          return h('p', { className: 'oms-empty' }, pick({
            fr: 'Identifiez-vous auprès de NickServ. L’expéditeur et le destinataire doivent avoir un pseudo enregistré.',
            en: 'Identify with NickServ. Both the sender and the recipient need a registered nick.',
          }));
        }
        if (!ui.memos.length) {
          return h('div', { className: 'oms-empty' },
            h('p', { style: { margin: '0 0 .8rem' } }, pick({
              fr: 'Aucun mémo. Un mémo part vers un pseudo enregistré, qu’il soit en ligne ou non.',
              en: 'No memos. A memo goes to a registered nick, online or not.',
            })),
            h('button', {
              type: 'button', className: 'oms-btn oms-btn--go',
              onClick: function () { ui.screen = 'write'; bump(); },
            }, pick({ fr: 'Écrire un mémo', en: 'Write a memo' }))
          );
        }
        return h('div', null, ui.memos.map(function (m) {
          return h('button', {
            type: 'button',
            key: m.id,
            className: 'oms-row' + (m.unread ? ' is-unread' : ''),
            onClick: function () { readMemo(m.id); },
          },
            h('span', { className: 'oms-dot', 'aria-hidden': true }),
            h('span', null,
              h('span', { className: 'oms-row__from' }, m.sender),
              h('span', { className: 'oms-row__when' }, m.when)
            )
          );
        }));
      }

      function ReadScreen() {
        var m = findMemo(ui.reading);
        if (!m) {
          return h('p', { className: 'oms-empty' }, pick({ fr: 'Choisissez un mémo.', en: 'Choose a memo.' }));
        }
        return h('div', { className: 'oms-read' },
          h('p', { className: 'oms-read__who' }, m.sender),
          h('p', { className: 'oms-read__when' }, m.when || ''),
          ui.loading && !m.text
            ? h('p', { className: 'oms-hint' }, pick({ fr: 'Lecture…', en: 'Reading…' }))
            : h('p', { className: 'oms-read__text' }, m.text || pick({ fr: '(vide)', en: '(empty)' })),
          h('div', { className: 'oms-actions' },
            h('button', {
              type: 'button', className: 'oms-btn oms-btn--go',
              onClick: function () {
                ui.to = m.sender;
                ui.draft = '';
                ui.receipt = false;
                ui.screen = 'write';
                setFlash('', false);
                bump();
              },
            }, pick({ fr: 'Répondre', en: 'Reply' })),
            h('button', {
              type: 'button', className: 'oms-btn oms-btn--warn',
              onClick: function () { deleteMemo(m.id); },
            }, pick({ fr: 'Supprimer', en: 'Delete' }))
          )
        );
      }

      function WriteScreen() {
        var self = fold(ui.to) === fold(myNick()) || (myAccount() && fold(ui.to) === fold(myAccount()));
        var channel = ui.to.charAt(0) === '#' || ui.to.charAt(0) === '&';
        return h('form', {
          className: 'oms-form',
          onSubmit: function (e) {
            try { e.preventDefault(); } catch (err) { /* ignore */ }
            sendMemo();
          },
        },
          h('label', null,
            pick({ fr: 'Destinataire', en: 'Recipient' }),
            h('input', {
              type: 'text',
              name: 'memo-to',
              autoComplete: 'off',
              value: ui.to,
              placeholder: pick({ fr: 'Pseudo ou #salon', en: 'Nick or #channel' }),
              onChange: function (e) { ui.to = e.target.value; bump(); },
            })
          ),
          h('label', null,
            pick({ fr: 'Message', en: 'Message' }),
            h('textarea', {
              name: 'memo-text',
              maxLength: TEXT_MAX,
              value: ui.draft,
              placeholder: pick({ fr: 'Message court…', en: 'Short message…' }),
              onChange: function (e) { ui.draft = e.target.value.slice(0, TEXT_MAX); bump(); },
            })
          ),
          h('span', { className: 'oms-count' }, String(ui.draft.length) + ' / ' + TEXT_MAX),
          !self && !channel ? h('label', { className: 'oms-check' },
            h('input', {
              type: 'checkbox',
              checked: !!ui.receipt,
              onChange: function (e) { ui.receipt = !!(e.target && e.target.checked); bump(); },
            }),
            pick({ fr: 'Accusé de lecture', en: 'Read receipt' })
          ) : null,
          h('p', { className: 'oms-hint' }, pick({
            fr: 'Le destinataire doit être enregistré. S’il est en ligne, ' + serviceNick() + ' le prévient.',
            en: 'The recipient must be registered. If they are online, ' + serviceNick() + ' notifies them.',
          })),
          h('div', { className: 'oms-actions' },
            h('button', { type: 'submit', className: 'oms-btn oms-btn--go', disabled: ui.loading },
              pick({ fr: 'Envoyer', en: 'Send' })),
            !channel && validTarget(ui.to) ? h('button', {
              type: 'button', className: 'oms-btn',
              onClick: function () { sendCmd('check', 'CHECK ' + validTarget(ui.to)); },
            }, pick({ fr: 'Déjà lu ?', en: 'Already read?' })) : null,
            validTarget(ui.to) ? h('button', {
              type: 'button', className: 'oms-btn',
              onClick: function () { sendCmd('cancel', 'CANCEL ' + validTarget(ui.to)); },
            }, pick({ fr: 'Annuler le dernier', en: 'Cancel the last one' })) : null
          )
        );
      }

      function IgnoreScreen() {
        return h('div', null,
          h('form', {
            className: 'oms-form',
            onSubmit: function (e) {
              try { e.preventDefault(); } catch (err) { /* ignore */ }
              var nick = validTarget(ui.ignoreDraft);
              if (!nick || nick.charAt(0) === '#') {
                setFlash(pick({ fr: 'Indiquez un pseudo à ignorer.', en: 'Enter a nick to ignore.' }), true);
                bump();
                return;
              }
              ui.ignoreDraft = '';
              sendCmd('ignore-add', 'IGNORE ADD ' + nick);
            },
          },
            h('label', null,
              pick({ fr: 'Ignorer un pseudo', en: 'Ignore a nick' }),
              h('input', {
                type: 'text', name: 'memo-ignore', autoComplete: 'off',
                value: ui.ignoreDraft,
                onChange: function (e) { ui.ignoreDraft = e.target.value; bump(); },
              })
            ),
            h('p', { className: 'oms-hint' }, pick({
              fr: 'Cette personne ne pourra plus vous envoyer de mémo, sans en être avertie.',
              en: 'They will no longer be able to memo you, and will not be told.',
            })),
            h('button', { type: 'submit', className: 'oms-btn oms-btn--go' }, pick({ fr: 'Ajouter', en: 'Add' }))
          ),
          !ui.ignores.length
            ? h('p', { className: 'oms-empty' }, pick({ fr: 'Aucun pseudo ignoré.', en: 'Nobody ignored.' }))
            : ui.ignores.map(function (mask) {
              return h('div', { className: 'oms-ign', key: mask },
                h('span', null, mask),
                h('button', {
                  type: 'button', className: 'oms-btn',
                  onClick: function () { sendCmd('ignore-del', 'IGNORE DEL ' + mask); },
                }, pick({ fr: 'Retirer', en: 'Remove' }))
              );
            })
        );
      }

      function MemoPane() {
        useSyncExternalStore(subscribe, snap, snap);
        useEffect(function () {
          try { document.body.classList.toggle('oms-open', !!ui.open); } catch (e) { /* ignore */ }
          return function () {
            try { document.body.classList.remove('oms-open'); } catch (e2) { /* ignore */ }
          };
        }, [ui.open]);
        useEffect(function () {
          if (!ui.open) return undefined;
          hideNativeRow();
          var root = document.querySelector('.rooms');
          if (!root || typeof MutationObserver === 'undefined') return undefined;
          var mo = new MutationObserver(function () { hideNativeRow(); });
          mo.observe(root, { childList: true, subtree: true });
          return function () { mo.disconnect(); };
        }, [ui.open]);
        if (!ui.open) return null;
        var sub = serviceNick();
        var title = ui.screen === 'write'
          ? pick({ fr: 'Nouveau mémo', en: 'New memo' })
          : ui.screen === 'ignore'
            ? pick({ fr: 'Ignorés', en: 'Ignored' })
            : ui.screen === 'read'
              ? pick({ fr: 'Mémo', en: 'Memo' })
              : pick({ fr: 'Mémos', en: 'Memos' });
        return h('div', {
          className: 'oms-view',
          role: 'region',
          'aria-label': pick({ fr: 'Mémos', en: 'Memos' }),
          onKeyDown: function (e) {
            if (e.key !== 'Escape') return;
            if (ui.screen !== 'list') { ui.screen = 'list'; bump(); }
            else closeView();
          },
        },
          bar(title, pick({
            fr: 'Via ' + sub + ' · pseudo enregistré',
            en: 'Via ' + sub + ' · registered nick',
          })),
          flashEl(),
          h('div', { className: 'oms-body' },
            ui.screen === 'write' ? h(WriteScreen)
              : ui.screen === 'read' ? h(ReadScreen)
                : ui.screen === 'ignore' ? h(IgnoreScreen)
                  : h(ListScreen)
          ),
          ui.screen === 'list' ? h('div', { className: 'oms-actions', style: { padding: '0 1rem .9rem', flex: 'none' } },
            h('button', {
              type: 'button', className: 'oms-btn',
              onClick: function () {
                ui.screen = 'ignore';
                setFlash('', false);
                bump();
                sendCmd('ignore', 'IGNORE LIST');
              },
            }, pick({ fr: 'Pseudos ignorés', en: 'Ignored nicks' }))
          ) : null
        );
      }

      injectCss();
      orbit.on('raw', onRaw);
      orbit.on('connected', function () { scheduleList(); });
      orbit.on('buffer.active', function (name) {
        if (ui.closing || !ui.open) return;
        if (fold(name) === fold(BUF)) return;
        ui.open = false;
        ui.prev = '';
        try { document.body.classList.remove('oms-open'); } catch (e) { /* ignore */ }
        bump();
        ui.closing = true;
        try {
          var st = state();
          if (st && st.closeBuffer) st.closeBuffer(BUF);
        } catch (e2) { /* ignore */ }
        ui.closing = false;
        hideNativeRow();
      });
      if (typeof orbit.addMessageFilter === 'function') orbit.addMessageFilter(shouldHide);
      orbit.addUi('sidebar_room', function () { return h(MemoRoomRow); });
      orbit.addUi('overlay', function () { return h(MemoPane); });
      if (typeof orbit.addMemberMenu === 'function') {
        orbit.addMemberMenu(function (ctx) {
          var nick = ctx && ctx.nick;
          if (!nick || nick.charAt(0) === '#' || isSvc(nick) || fold(nick) === fold(myNick())) return null;
          return h('button', {
            type: 'button',
            className: 'memberctx__item',
            role: 'menuitem',
            onClick: function () {
              if (ctx.close) ctx.close();
              openCompose(nick);
            },
          }, pick({ fr: 'Envoyer un mémo', en: 'Send a memo' }));
        });
      }
      if (typeof orbit.addUserAction === 'function') {
        orbit.addUserAction(function (ctx) {
          var nick = ctx && ctx.nick;
          if (!nick || isSvc(nick)) return null;
          return h('button', {
            type: 'button',
            className: 'pm-chip',
            onClick: function () {
              if (ctx.close) ctx.close();
              openCompose(nick);
            },
          }, pick({ fr: 'Mémo', en: 'Memo' }));
        });
      }
      if (typeof orbit.addCommand === 'function') {
        orbit.addCommand('memo', {
          help: pick({ fr: '/memo — boîte. /memo pseudo texte — envoyer.', en: '/memo — inbox. /memo nick text — send.' }),
          run: function (args, rest) {
            if (!args || !args.length) { openView('list'); return; }
            var nick = args[0];
            var text = String(rest || '').replace(/^\S+\s*/, '');
            ui.to = nick;
            ui.draft = text;
            ui.screen = 'write';
            openView('write');
            if (text) sendMemo();
          },
        });
        orbit.addCommand('memos', {
          help: pick({ fr: 'Ouvre la boîte des mémos.', en: 'Opens the memo inbox.' }),
          run: function () { openView('list'); },
        });
      }
      log('mémos via ' + serviceNick());
      if (myNick()) scheduleList();
    });
  }
})(function () {
  var VER = 1;

  function stripIrc(s) {
    return String(s || '')
      .replace(/\x03\d{0,2}(,\d{1,2})?/g, '')
      .replace(/\x04[0-9a-fA-F]{0,6}/g, '')
      .replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, '')
      .replace(/\s+$/g, '')
      .replace(/^\s+/g, function (sp) { return sp.length > 8 ? '' : sp; });
  }

  function cleanToken(s) {
    return String(s || '').replace(/^[\s*]+|[\s,.:;]+$/g, '');
  }

  function classifyNotice(line) {
    var t = stripIrc(line).trim();
    if (!t) return null;
    var from = t.match(/new memo from\s+(\S+)/i) || t.match(/nouveau m[eé]mo de\s+(\S+)/i);
    if (from) return { type: 'arrival', from: cleanToken(from[1]) };
    var chan = t.match(/new memo on channel\s+(\S+)/i)
      || t.match(/nouveau m[eé]mo sur\s+(?:le\s+)?(?:canal|salon)\s+(\S+)/i);
    if (chan) return { type: 'channel', channel: cleanToken(chan[1]) };
    if (/maximum number of memos|nombre maximum de m[eé]mos|trop de m[eé]mos/i.test(t)) {
      return { type: 'full' };
    }
    var n = t.match(/\byou have\s+(\d+)\s+new memos?\b/i) || t.match(/\bvous avez\s+(\d+)\s+nouveaux? m[eé]mos?\b/i);
    if (n) return { type: 'count', n: parseInt(n[1], 10) };
    return null;
  }

  function isQuietNotice(line) {
    var t = stripIrc(line).trim();
    if (!t) return false;
    if (classifyNotice(t)) return true;
    if (/^(tapez|type)\b/i.test(t) && /\bREAD\b/.test(t)) return true;
    return false;
  }

  function looksError(text) {
    return /sorry|d[eé]sol|access denied|acc[eè]s refus|not a registered|pas un pseudo|n'est pas un|cannot|impossible|please wait|merci d'attendre|patientez|must confirm|devez confirmer|was cancelable|annulable|too many memos|trop de m[eé]mos|temporarily disabled|temporairement d[eé]sactiv/i.test(String(text || ''));
  }

  function looksDenied(text) {
    return /access denied|acc[eè]s refus|permission denied|must be identified|identifiez|not identified|n'êtes pas identifi|log in|vous connecter/i.test(String(text || ''));
  }

  function parseList(lines) {
    var rows = [];
    var note = '';
    var denied = false;
    var empty = false;
    (lines || []).forEach(function (raw) {
      var line = stripIrc(raw).replace(/\s+$/g, '');
      var trimmed = line.trim();
      if (!trimmed) return;
      if (classifyNotice(trimmed)) return;
      if (looksDenied(trimmed)) { denied = true; note = trimmed; return; }
      if (/you have no (new )?memos|pas de (nouveau )?m[eé]mo|aucun m[eé]mo/i.test(trimmed)) {
        empty = true;
        note = trimmed;
        return;
      }
      if (/^m[eé]mos pour\b|^memos for\b/i.test(trimmed)) return;
      if (/^(num[eé]ro|number)\b/i.test(trimmed)) return;
      var row = line.match(/^\s*(\*)?\s*(\d+)\s{2,}(\S+)\s{2,}(.+)$/);
      if (row) {
        rows.push({
          id: parseInt(row[2], 10),
          unread: row[1] === '*',
          sender: row[3],
          when: row[4].trim(),
          text: '',
        });
        return;
      }
      if (/^\s{2,}\S/.test(line) && rows.length) {
        rows[rows.length - 1].when += ' ' + trimmed;
        return;
      }
      if (!note) note = trimmed;
    });
    return {
      ok: !denied && (rows.length > 0 || empty),
      rows: rows,
      empty: empty && !rows.length,
      denied: denied,
      note: note,
    };
  }

  function isSkipReadLine(line) {
    return /to delete,\s*type|pour supprimer,\s*tapez|notification memo|m[eé]mo de notification|informing them you have|en les informant/i.test(line);
  }

  function parseRead(lines) {
    var out = [];
    var cur = null;
    function push() { if (cur) out.push(cur); cur = null; }
    (lines || []).forEach(function (raw) {
      var line = stripIrc(raw).trim();
      if (!line || classifyNotice(line)) return;
      var h = line.match(/^m[eé]mo\s+(\d+)\s+(?:par|from|de)\s+(.+?)\s+\((.+)\)\.?\s*$/i);
      if (h) {
        push();
        cur = { id: parseInt(h[1], 10), sender: h[2].trim(), when: h[3].trim(), text: '' };
        return;
      }
      if (!cur || isSkipReadLine(line)) return;
      cur.text = cur.text ? (cur.text + '\n' + line) : line;
    });
    push();
    return out;
  }

  function parseIgnore(lines) {
    var masks = [];
    var started = false;
    var empty = false;
    (lines || []).forEach(function (raw) {
      var line = stripIrc(raw).trim();
      if (!line) return;
      if (/ignore list is empty|liste des ignor[eé]s est vide|liste d'ignore est vide/i.test(line)) {
        empty = true;
        return;
      }
      if (/^ignore list\s*:|^liste des ignor/i.test(line)) { started = true; return; }
      if (/added to ignore|ajout[eé] [aà] la liste|removed from|retir[eé]|already on the ignore|d[eé]j[aà]|not on the ignore|pas sur la liste|n'est pas/i.test(line)) {
        return;
      }
      if (/^(mask|masque)$/i.test(line)) return;
      if (started) masks.push(line);
    });
    return { ok: started || empty, masks: masks, empty: empty && !masks.length };
  }

  function leftover(lines) {
    var bits = [];
    (lines || []).forEach(function (raw) {
      var line = stripIrc(raw).trim();
      if (!line || classifyNotice(line)) return;
      if (/^m[eé]mos pour\b|^memos for\b|^(num[eé]ro|number)\b/i.test(line)) return;
      if (/^\s*(\*)?\s*\d+\s{2,}\S+\s{2,}/.test(stripIrc(raw))) return;
      if (isSkipReadLine(line)) return;
      if (/^m[eé]mo\s+\d+\s+(?:par|from|de)\b/i.test(line)) return;
      bits.push(line);
    });
    return bits.join(' ');
  }

  return {
    VER: VER,
    stripIrc: stripIrc,
    classifyNotice: classifyNotice,
    isQuietNotice: isQuietNotice,
    looksError: looksError,
    parseList: parseList,
    parseRead: parseRead,
    parseIgnore: parseIgnore,
    leftover: leftover,
  };
});
