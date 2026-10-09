/*!
 * orbit-memoserv — boîte de mémos Anope (service « Message » sur Entre Nous).
 *
 * LIST, READ, SEND, RSEND, DEL, CHECK, CANCEL, IGNORE passent par
 * JSON-RPC Anope (memoserv-rpc.php, même jeton que ChanServ).
 * Repli IRC si le RPC n’est pas configuré. Les avis « nouveau mémo »
 * restent des notices Message, masquées du salon. SENDALL / STAFF
 * restent en ligne de commande (opérateurs).
 *
 * config.json :
 *   "memoserv": { "service": "Message" }
 *   "plugins": ["/app/plugins/third/orbit-memoserv/orbit-memoserv.js?v=14"]
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
        anchor: null,
        suggest: [],
        suggestHi: 0,
        presence: '',
        presenceNick: '',
        group: null,
        pendingSend: false,
        popups: [],
        help: false,
        rev: 0,
        subs: [],
      };
      var pending = { kind: '', lines: [], timer: 0, coalesce: 0 };
      var suggestTimer = 0;
      var suggestGen = 0;
      var groupGen = 0;
      var popupSeq = 0;
      var hideUntil = 0;
      var listStarted = 0;
      var listDone = 0;
      var listProbe = '';
      var lastPopupKey = '';
      var lastPopupAt = 0;
      var lastStatus = '';
      var sameStatus = 0;

      function statusLine(text) {
        var line = String(text || '');
        if (!line) return;
        if (line === lastStatus) {
          sameStatus++;
          if (sameStatus !== 3 && sameStatus !== 10) return;
          line += ' ×' + sameStatus;
        } else {
          lastStatus = line;
          sameStatus = 0;
        }
        log(line);
        try {
          var st = state();
          if (st && st.pushSystem) st.pushSystem('$server', '[Mémo] ' + line);
        } catch (e) { /* ignore */ }
      }

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
          '.oms-panel{display:flex;flex-direction:column;overflow:hidden;background:var(--bg,#fff);color:var(--ink,#17191c);border:1px solid var(--border,#e3e7eb);border-radius:18px;box-shadow:0 24px 60px -18px rgba(20,30,45,.35),0 8px 20px -10px rgba(20,30,45,.2)}',
          '.oms-bar{display:flex;align-items:center;gap:.35rem;flex:none;padding:.75rem .75rem .45rem}',
          '.oms-mark{width:2rem;height:2rem;border-radius:10px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--accent,#2563eb) 18%,transparent);color:var(--accent,#60a5fa)}',
          '.oms-bar__title{margin:0;font-size:.98rem;font-weight:800;letter-spacing:-.03em}',
          '.oms-bar__sub{display:block;font-size:.72rem;font-weight:500;color:var(--muted,#a1a1aa);margin-top:.05rem}',
          '.oms-iconbtn{border:0;background:transparent;color:var(--muted,#a1a1aa);width:2rem;height:2rem;border-radius:10px;cursor:pointer;font:inherit;font-size:1rem;line-height:1}',
          '.oms-iconbtn:hover,.oms-iconbtn:focus-visible{background:color-mix(in srgb,var(--ink,#fff) 8%,transparent);color:var(--ink,#fff);outline:none}',
          '.oms-iconbtn.is-on{color:var(--accent,#2563eb);background:color-mix(in srgb,var(--accent,#2563eb) 14%,transparent)}',
          '.oms-help{margin:0 .75rem .55rem;padding:.7rem .8rem .75rem;border-radius:14px;background:color-mix(in srgb,var(--accent,#2563eb) 10%,transparent);color:var(--ink,#17191c);font-size:.8rem;line-height:1.45}',
          '.oms-help p{margin:0 0 .45rem}',
          '.oms-help ul{margin:0;padding-left:1.05rem}',
          '.oms-help li{margin:.18rem 0}',
          '.oms-seg{display:flex;gap:.25rem;margin:0 .75rem .55rem;padding:.2rem;border-radius:12px;background:color-mix(in srgb,var(--ink,#fff) 6%,transparent);flex:none}',
          '.oms-seg button{flex:1;border:0;border-radius:10px;padding:.38rem .4rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer;background:transparent;color:var(--muted,#a1a1aa)}',
          '.oms-seg button.is-on{background:var(--bg,#16161c);color:var(--ink,#fff);box-shadow:0 1px 2px rgba(0,0,0,.18)}',
          '.oms-seg button:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:1px}',
          '.oms-flash{margin:0 .75rem .45rem;padding:.5rem .65rem;border-radius:12px;font-size:.8rem;line-height:1.35;background:color-mix(in srgb,#16a34a 16%,var(--bg,#16161c));color:var(--ink,#fff)}',
          '.oms-flash--err{background:color-mix(in srgb,#e11d48 16%,var(--bg,#16161c))}',
          '.oms-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 .4rem .7rem}',
          '.oms-empty{padding:1.1rem .85rem;color:var(--muted,#a1a1aa);font-size:.88rem;line-height:1.45}',
          '.oms-row{display:flex;gap:.65rem;align-items:center;width:100%;text-align:left;border:0;border-radius:14px;background:transparent;color:inherit;font:inherit;padding:.55rem .55rem;cursor:pointer}',
          '.oms-row:hover,.oms-row:focus-visible{background:color-mix(in srgb,var(--accent,#2563eb) 12%,transparent);outline:none}',
          '.oms-av{width:2.1rem;height:2.1rem;border-radius:12px;flex:none;display:grid;place-items:center;font-size:.82rem;font-weight:800;background:color-mix(in srgb,var(--accent,#2563eb) 16%,transparent);color:var(--accent,#93c5fd)}',
          '.oms-row.is-unread .oms-av{background:var(--accent,#2563eb);color:#fff}',
          '.oms-row__from{font-size:.92rem;font-weight:650}',
          '.oms-row.is-unread .oms-row__from{font-weight:800}',
          '.oms-row__when{display:block;font-size:.72rem;color:var(--muted,#a1a1aa);margin-top:.08rem}',
          '.oms-pill{margin-left:auto;flex:none;font-size:.65rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--accent,#93c5fd)}',
          '.oms-read{padding:.35rem .7rem .9rem}',
          '.oms-read__who{margin:0;font-size:1.05rem;font-weight:800;letter-spacing:-.02em}',
          '.oms-read__when{margin:.15rem 0 .75rem;color:var(--muted,#a1a1aa);font-size:.78rem}',
          '.oms-read__text{margin:0;white-space:pre-wrap;word-break:break-word;font-size:.95rem;line-height:1.5;padding:.75rem .8rem;border-radius:14px;background:color-mix(in srgb,var(--ink,#fff) 5%,transparent)}',
          '.oms-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.85rem}',
          '.oms-btn{border:0;border-radius:11px;padding:.48rem .75rem;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;background:color-mix(in srgb,var(--ink,#fff) 8%,transparent);color:var(--ink,#fff)}',
          '.oms-btn:hover,.oms-btn:focus-visible{filter:brightness(1.06);outline:none}',
          '.oms-btn:disabled{opacity:.55;cursor:default}',
          '.oms-btn--go{background:var(--accent,#2563eb);color:#fff}',
          '.oms-btn--warn{color:var(--danger,#d6465f);background:color-mix(in srgb,var(--danger,#d6465f) 12%,transparent)}',
          '.oms-form{display:flex;flex-direction:column;gap:.5rem;padding:.2rem .7rem .85rem}',
          '.oms-form label{display:flex;flex-direction:column;gap:.25rem;font-size:.72rem;font-weight:700;letter-spacing:.02em;color:var(--muted,#a1a1aa)}',
          '.oms-form input[type=text],.oms-form textarea{font:inherit;font-size:.92rem;font-weight:500;color:var(--ink,#fff);background:color-mix(in srgb,var(--ink,#fff) 5%,transparent);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:12px;padding:.55rem .7rem}',
          '.oms-form input:focus,.oms-form textarea:focus{outline:2px solid color-mix(in srgb,var(--accent,#2563eb) 55%,transparent);border-color:transparent}',
          '.oms-form textarea{min-height:6.5rem;resize:vertical}',
          '.oms-ac{position:relative;flex:1;min-width:0}',
          '.oms-ac input{width:100%;box-sizing:border-box}',
          '.oms-to{display:flex;align-items:center;gap:.4rem}',
          '.oms-pres{flex:none;font-size:.68rem;font-weight:800;letter-spacing:.01em;padding:.22rem .5rem;border-radius:999px;white-space:nowrap}',
          '.oms-pres--on{color:#15803d;background:color-mix(in srgb,#16a34a 16%,transparent)}',
          '.oms-pres--off{color:var(--muted,#5e6973);background:color-mix(in srgb,var(--ink,#111) 7%,transparent)}',
          '.oms-ac__list{position:absolute;z-index:2;left:0;right:0;top:calc(100% + 4px);margin:0;padding:.25rem;list-style:none;border-radius:12px;background:var(--bg,#fff);color:var(--ink,#17191c);border:1px solid var(--border,#e3e7eb);box-shadow:0 12px 30px -12px rgba(0,0,0,.28);max-height:11rem;overflow:auto}',
          '.oms-ac__opt{display:block;width:100%;text-align:left;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:.88rem;font-weight:650;padding:.4rem .5rem;cursor:pointer}',
          '.oms-ac__opt.is-on,.oms-ac__opt:hover{background:color-mix(in srgb,var(--accent,#2563eb) 18%,transparent)}',
          '.oms-ac__acc{display:block;margin-top:.05rem;font-size:.68rem;font-weight:650;color:var(--muted,#5e6973)}',
          '.oms-acct{margin:0;padding:.65rem .75rem;border-radius:12px;background:color-mix(in srgb,var(--accent,#2563eb) 10%,transparent);font-size:.8rem;line-height:1.45}',
          '.oms-acct p{margin:0 0 .35rem}',
          '.oms-acct p:last-child{margin:0}',
          '.oms-check{flex-direction:row!important;align-items:center;gap:.45rem;font-size:.82rem!important;font-weight:600!important;color:var(--ink,#fff)!important;letter-spacing:0!important}',
          '.oms-hint{margin:0;font-size:.74rem;color:var(--muted,#a1a1aa);line-height:1.4}',
          '.oms-count{align-self:flex-end;font-size:.7rem;color:var(--muted,#a1a1aa)}',
          '.oms-ign{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin:.15rem .35rem;padding:.45rem .55rem;border-radius:12px}',
          '.oms-ign:hover{background:color-mix(in srgb,var(--ink,#fff) 5%,transparent)}',
          '.oms-ign span{font-weight:700}',
          '@keyframes oms-pop{from{transform:translateY(10px) scale(.92);opacity:0}to{transform:none;opacity:1}}',
          '.oms-pop{position:fixed;z-index:70;top:4.6rem;right:.85rem;display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;width:min(250px,74vw);pointer-events:none}',
          '.oms-pop__card{pointer-events:auto;width:100%;display:flex;align-items:center;min-height:64px;border-radius:999px;border:3px solid var(--accent,#2563eb);background:linear-gradient(90deg,rgba(255,255,255,.94) 0%,rgba(255,255,255,.72) 100%);color:#1e293b;box-shadow:0 10px 18px -10px rgba(0,0,0,.55);animation:oms-pop .35s ease both}',
          '.oms-pop__main{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;padding:.4rem .2rem .4rem .9rem}',
          '.oms-pop__t{display:block;font-size:.78rem;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
          '.oms-pop__s{display:block;margin-top:.08rem;font-size:.68rem;font-weight:700;line-height:1.2;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
          '.oms-pop__x{flex:none;width:1.35rem;height:1.35rem;margin-right:.45rem;border:0;border-radius:999px;background:rgba(15,23,42,.08);color:#1e293b;cursor:pointer;font-size:.9rem;line-height:1}',
          '.oms-pop__x:hover{background:rgba(15,23,42,.16)}',
          '@media(max-width:880px){.oms-pop{top:3.6rem;right:.45rem;width:min(200px,58vw)}}',
        ].join('');
        document.head.appendChild(el);
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

      var RPC_PATH = '/app/plugins/third/orbit-memoserv/memoserv-rpc.php';
      var rpcState = 'try';
      var rpcGen = 0;

      function splitCmd(line) {
        var m = String(line || '').match(/^(\S+)(?:\s+([\s\S]*))?$/);
        var command = (m && m[1] ? m[1] : '').toUpperCase();
        var rest = (m && m[2] ? m[2] : '').trim();
        if (command === 'SEND' || command === 'RSEND') {
          var sp = rest.indexOf(' ');
          return { command: command, args: sp < 0 ? [rest] : [rest.slice(0, sp), rest.slice(sp + 1)] };
        }
        if (!rest) return { command: command, args: [] };
        return { command: command, args: rest.split(/\s+/) };
      }

      function rpcPost(body) {
        return fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.text().then(function (txt) {
            var data = null;
            try { data = txt ? JSON.parse(txt) : null; } catch (e) { return { ok: false, error: 'bad_json' }; }
            if (!data || typeof data !== 'object') return { ok: false, error: 'empty' };
            if (!r.ok && data.ok !== true) data.error = data.error || ('http_' + r.status);
            return data;
          });
        });
      }

      function sendIrc(kind, line) {
        if (kind === 'list') statusLine('envoi IRC LIST');
        pending.kind = kind;
        pending.lines = [];
        hideUntil = Date.now() + 5000;
        ui.loading = true;
        bump();
        try { orbit.irc.msg(serviceNick(), line); }
        catch (e) { log('irc send failed', e); }
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(function () {
          if (pending.kind === kind) flush();
        }, 4500);
      }

      function rpcLines(text) {
        return String(text || '').split(/\r\n|\n|\r/);
      }

      function finishRpc(kind, lines) {
        pending.kind = kind;
        pending.lines = lines;
        flush();
      }

      function sendCmd(kind, line) {
        var account = myAccount();
        if (rpcState === 'off' || !account || typeof fetch !== 'function') {
          sendIrc(kind, line);
          return;
        }
        var parts = splitCmd(line);
        var gen = ++rpcGen;
        pending.kind = kind;
        pending.lines = [];
        ui.loading = true;
        bump();
        rpcPost({
          account: account,
          nick: myNick(),
          service: serviceNick(),
          command: parts.command,
          args: parts.args,
        }).then(function (data) {
          if (gen !== rpcGen) return;
          if (data && data.ok) {
            rpcState = 'on';
            var reply = String((data && data.text) || '');
            if (kind === 'send' && !reply.trim()) {
              var raw = data && data.raw ? String(data.raw) : '';
              statusLine('envoi RPC sans réponse' + (raw ? ' · ' + raw.slice(0, 80) : '') + ', repli IRC');
              sendIrc(kind, line);
              return;
            }
            if (kind === 'list') {
              var got = rpcLines(data.text).filter(function (s) { return String(s).trim(); });
              var preview = got.slice(0, 3).map(function (s) { return String(s).trim().slice(0, 70); }).join(' | ');
              statusLine('rpc ok · ' + got.length + ' ligne' + (got.length > 1 ? 's' : '') + (preview ? ' · ' + preview : ''));
            }
            finishRpc(kind, rpcLines(data.text));
            return;
          }
          var err = (data && data.error) || 'rpc';
          statusLine((kind === 'send' ? 'envoi' : kind) + ' rpc ' + err);
          if (err === 'not_configured' && rpcState !== 'on') {
            rpcState = 'off';
            pending.kind = '';
            ui.loading = false;
            statusLine('RPC non configuré — memoserv-rpc.local.php');
            if (kind === 'list') {
              setFlash(pick({
                fr: 'RPC non configuré. Il faut memoserv-rpc.local.php (même adresse et jeton que ChanServ).',
                en: 'RPC is not configured. memoserv-rpc.local.php needs the same URL and token as ChanServ.',
              }), true);
              bump();
              return;
            }
            sendIrc(kind, line);
            return;
          }
          pending.kind = '';
          ui.loading = false;
          setFlash(pick({
            fr: 'Le service des mémos ne répond pas.',
            en: 'Memo service did not answer.',
          }), true);
          bump();
          if (queueList && !pending.kind) {
            queueList = false;
            requestList(queueWhy || 'file');
            queueWhy = '';
          }
        }).catch(function (err) {
          if (gen !== rpcGen) return;
          var detail = err && err.message ? err.message : String(err || 'reseau');
          statusLine((kind === 'send' ? 'envoi' : kind) + ' injoignable · ' + detail);
          if (rpcState !== 'on') {
            rpcState = 'off';
            pending.kind = '';
            ui.loading = false;
            sendIrc(kind, line);
            return;
          }
          pending.kind = '';
          ui.loading = false;
          setFlash(pick({
            fr: 'Le service des mémos ne répond pas.',
            en: 'Memo service did not answer.',
          }), true);
          bump();
        });
      }

      var queueList = false;
      var queueWhy = '';
      function requestList(why) {
        var reason = why || 'manuel';
        if (reason === 'manuel' || reason === 'panneau' || reason === 'démarrage') listProbe = '';
        if (!myNick()) return;
        if (pending.kind) {
          queueList = true;
          queueWhy = reason;
          return;
        }
        listStarted = Date.now();
        statusLine('LIST → ' + reason);
        sendCmd('list', 'LIST');
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
        if (parsed.rows.length) {
          var kept = {};
          ui.memos.forEach(function (m) { if (m.text) kept[m.id] = m.text; });
          ui.memos = parsed.rows.map(function (r) {
            r.text = kept[r.id] || '';
            return r;
          });
          ui.listed = true;
          ui.pendingArrivals = 0;
          ui.unreadHint = 0;
          listProbe = '';
          if (ui.reading && !findMemo(ui.reading)) ui.reading = 0;
          setFlash('', false);
          return;
        }
        if (parsed.denied) {
          listProbe = '';
          setFlash(parsed.note, true);
          return;
        }
        if (parsed.empty) {
          ui.memos = [];
          ui.listed = true;
          ui.pendingArrivals = 0;
          ui.unreadHint = 0;
          listProbe = '';
          setFlash('', false);
          return;
        }
        if (parsed.sawHeader && listProbe !== 'read') {
          listProbe = 'read';
          var brut = (lines || []).map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, 4).join(' | ').slice(0, 160);
          statusLine('liste sans ligne reconnue · ' + brut);
          sendCmd('read-new', 'READ NEW');
          return;
        }
        if (parsed.note) setFlash(parsed.note, false);
      }

      function applyRead(lines, fromList) {
        var reads = parse.parseRead(lines);
        if (!reads.length) {
          var note = parse.leftover(lines);
          if (fromList) {
            statusLine('READ NEW sans mémo · ' + String(note || '').slice(0, 120));
          }
          setFlash(note || pick({ fr: 'Mémo introuvable.', en: 'Memo not found.' }), true);
          return;
        }
        reads.forEach(function (r) {
          var m = findMemo(r.id);
          if (!m) {
            m = { id: r.id, sender: r.sender, when: r.when, unread: !!fromList, text: r.text };
            ui.memos.push(m);
          }
          m.sender = r.sender || m.sender;
          m.when = r.when || m.when;
          m.text = r.text;
          if (!fromList) m.unread = false;
          ui.reading = r.id;
        });
        if (fromList) {
          ui.listed = true;
          ui.pendingArrivals = 0;
          ui.unreadHint = listedUnread();
          if (ui.screen === 'read') ui.screen = 'list';
        } else {
          ui.screen = 'read';
          ui.pendingArrivals = 0;
          ui.unreadHint = listedUnread();
        }
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

        if (kind === 'list' || kind === 'list-new') {
          applyList(lines);
          listDone = Date.now();
          var waited = listStarted ? (listDone - listStarted) : 0;
          statusLine('liste affichée · ' + ui.memos.length + ' mémo' + (ui.memos.length > 1 ? 's' : '')
            + (ui.needId ? ' · identification requise' : '')
            + ' · ' + waited + ' ms');
        }
        else if (kind === 'read' || kind === 'read-new') applyRead(lines, kind === 'read-new');
        else if (kind === 'ignore') {
          var ig = parse.parseIgnore(lines);
          if (ig.ok) ui.ignores = ig.masks;
          var note = parse.leftover(lines);
          if (note) setFlash(note, parse.looksError(note));
          else setFlash('', false);
        } else if (kind) {
          var left = parse.leftover(lines);
          var err = !left || parse.looksError(left);
          setFlash(left, err && !!left);
          if (kind === 'send' || kind === 'check' || kind === 'cancel') {
            var label = kind === 'send' ? 'envoi' : kind === 'check' ? 'vérification' : 'annulation';
            statusLine(label + (err ? ' refusé · ' : ' ok · ') + String(left || 'réponse vide').slice(0, 160));
          }
          if (kind === 'send' && left && !err) {
            ui.draft = '';
            ui.screen = 'list';
            requestList('envoi');
          }
          if (kind === 'cancel' && left && !err) requestList('annulation');
          if (kind === 'del' && left && !err) requestList('suppression');
          if ((kind === 'ignore-add' || kind === 'ignore-del') && !err) {
            sendCmd('ignore', 'IGNORE LIST');
          }
        }
        bump();
        if (queueList && !pending.kind) {
          queueList = false;
          var again = queueWhy || 'file';
          queueWhy = '';
          requestList(again);
        }
      }

      function pushLine(text) {
        pending.lines.push(text);
        hideUntil = Date.now() + 2000;
        if (pending.coalesce) clearTimeout(pending.coalesce);
        pending.coalesce = setTimeout(flush, COALESCE_MS);
      }

      function dismissPopup(id) {
        var next = ui.popups.filter(function (p) { return p.id !== id; });
        if (next.length === ui.popups.length) return;
        ui.popups = next;
        bump();
      }

      function showMemoPopup(from, channel) {
        var key = (from || '') + '|' + (channel || '');
        var now = Date.now();
        if (key === lastPopupKey && now - lastPopupAt < 30000) return;
        lastPopupKey = key;
        lastPopupAt = now;
        var id = ++popupSeq;
        ui.popups = ui.popups.concat([{
          id: id,
          from: from || '',
          channel: channel || '',
        }]).slice(-3);
        bump();
        setTimeout(function () { dismissPopup(id); }, 14000);
      }

      function openFromPopup(id) {
        dismissPopup(id);
        openView('list');
      }

      function onArrival(from, channel) {
        ui.pendingArrivals += 1;
        ui.unreadHint = listedUnread() + ui.pendingArrivals;
        bump();
        showMemoPopup(from, channel);
        if (!ui.open || (typeof document !== 'undefined' && document.hidden)) {
          orbit.notify(
            pick({ fr: 'Nouveau mémo', en: 'New memo' }),
            from
              ? pick({ fr: 'De ' + from, en: 'From ' + from })
              : channel
                ? pick({ fr: 'Sur ' + channel, en: 'On ' + channel })
                : pick({ fr: 'Vous avez un nouveau mémo.', en: 'You have a new memo.' })
          );
        }
      }

      function onRaw(msg) {
        if (!msg) return;
        var cmd = String(msg.command || '').toUpperCase();
        if (cmd === '900') { ui.needId = false; return; }
        if (cmd === 'ACCOUNT' && fold(msg.nick) === fold(myNick())) {
          ui.needId = false;
          return;
        }
        if (cmd !== 'NOTICE' && cmd !== 'PRIVMSG') return;
        if (!isSvc(msg.nick)) return;
        var text = parse.stripIrc((msg.params && msg.params[1]) || '');
        if (!text || text.charAt(0) === '\x01') return;
        var info = parse.classifyNotice(text);
        if (info && info.type === 'arrival') onArrival(info.from, info.channel || '');
        else if (info && info.type === 'channel') {
          onArrival('', info.channel);
        } else if (info && info.type === 'count') {
          ui.unreadHint = Math.max(ui.unreadHint || 0, info.n);
          bump();
          if (info.n > 0) showMemoPopup('', '');
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
        var wasOpen = ui.open;
        ui.open = true;
        if (screen) ui.screen = screen;
        ui.suggest = [];
        bump();
        try { orbit.emit('orbit:panel', 'orbit-memoserv'); } catch (e) { /* ignore */ }
        if (!wasOpen) requestList('panneau');
      }

      function closeView() {
        if (!ui.open) return;
        ui.open = false;
        ui.suggest = [];
        ui.help = false;
        bump();
      }

      function toggleView(anchor) {
        if (ui.open) {
          closeView();
          return;
        }
        ui.anchor = anchor || null;
        openView(ui.screen === 'read' ? 'list' : (ui.screen || 'list'));
      }

      function openCompose(nick) {
        ui.screen = 'write';
        ui.receipt = false;
        if (nick) queueSuggest(nick);
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
        var channel = target.charAt(0) === '#' || target.charAt(0) === '&';
        var g = channel ? null : currentGroup();
        if (g && groupShared(g) && !g.registered && g.account) {
          statusLine('envoi sur le compte ' + g.account + ' · ' + target + ' n’est pas enregistré');
          target = g.account;
          ui.to = g.account;
          ui.group = {
            nick: g.account,
            account: g.account,
            nicks: g.nicks,
            registered: true,
          };
        }
        var self = fold(target) === fold(myNick()) || (myAccount() && fold(target) === fold(myAccount()));
        var cmd = (ui.receipt && !self && !channel) ? 'RSEND' : 'SEND';
        statusLine('envoi → ' + target);
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

      function IconMail(props) {
        var size = (props && props.size) || 18;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
          h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
          h('path', { d: 'M3 7l9 7 9-7' })
        );
      }

      function MemoTab() {
        useSyncExternalStore(subscribe, snap, snap);
        var n = badgeCount();
        var label = pick({ fr: 'Mémo', en: 'Memo' });
        return h('button', {
          type: 'button',
          className: 'tab' + (ui.open ? ' is-active' : ''),
          title: label,
          'aria-label': label,
          'aria-expanded': ui.open ? 'true' : 'false',
          onClick: function (e) {
            var rect = null;
            try { rect = e.currentTarget.getBoundingClientRect(); } catch (err) { rect = null; }
            toggleView(rect);
          },
        },
          h('span', { className: 'tab__ic' },
            h(IconMail, { size: 22 }),
            n ? h('span', { className: 'tab__badge' }, n > 99 ? '99+' : String(n)) : null
          ),
          h('span', { className: 'tab__lb' }, label)
        );
      }

      function goScreen(name) {
        ui.screen = name;
        ui.suggest = [];
        setFlash('', false);
        bump();
        if (name === 'list') requestList('reçus');
        if (name === 'ignore') sendCmd('ignore', 'IGNORE LIST');
      }

      function bar() {
        var n = badgeCount();
        var sub = ui.screen === 'read'
          ? pick({ fr: 'Lecture', en: 'Reading' })
          : !ui.listed
            ? pick({ fr: 'Messages hors ligne', en: 'Offline messages' })
            : n
              ? (n > 1
                ? pick({ fr: n + ' non lus', en: n + ' unread' })
                : pick({ fr: '1 non lu', en: '1 unread' }))
              : pick({ fr: 'Aucun mémo en attente', en: 'No memo waiting' });
        return h('div', { className: 'oms-bar' },
          ui.screen === 'read' ? h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Retour', en: 'Back' }),
            'aria-label': pick({ fr: 'Retour à la liste', en: 'Back to the list' }),
            onClick: function () { goScreen('list'); },
          }, '←') : h('span', { className: 'oms-mark', 'aria-hidden': true }, h(IconMail, { size: 16 })),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h2', { className: 'oms-bar__title' }, pick({ fr: 'Mémo', en: 'Memo' })),
            h('span', { className: 'oms-bar__sub' }, sub)
          ),
          h('button', {
            type: 'button',
            className: 'oms-iconbtn' + (ui.help ? ' is-on' : ''),
            title: pick({ fr: 'À quoi sert Mémo ?', en: 'What is Memo for?' }),
            'aria-label': pick({ fr: 'À quoi sert Mémo ?', en: 'What is Memo for?' }),
            'aria-expanded': ui.help ? 'true' : 'false',
            onClick: function () { ui.help = !ui.help; bump(); },
          }, '?'),
          h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Actualiser', en: 'Refresh' }),
            'aria-label': pick({ fr: 'Actualiser les mémos', en: 'Refresh memos' }),
            onClick: function () { listDone = 0; requestList('manuel'); },
          }, '↻'),
          h('button', {
            type: 'button', className: 'oms-iconbtn',
            title: pick({ fr: 'Fermer', en: 'Close' }),
            'aria-label': pick({ fr: 'Fermer', en: 'Close' }),
            onClick: function () { closeView(); },
          }, '✕')
        );
      }

      function helpEl() {
        if (!ui.help) return null;
        return h('div', { className: 'oms-help' },
          h('p', null, pick({
            fr: 'Un message privé IRC n’arrive que si l’autre personne est connectée en même temps. Mémo dépose le texte sur son compte enregistré : elle le lit à sa prochaine visite, même si elle est absente.',
            en: 'A private IRC message only arrives if the other person is online at the same time. Memo leaves the text on their registered account, so they can read it on their next visit.',
          })),
          h('ul', null,
            h('li', null, pick({
              fr: 'Le message attend, que la personne soit en ligne ou non.',
              en: 'The message waits, whether they are online or not.',
            })),
            h('li', null, pick({
              fr: 'Il reste jusqu’à ce qu’elle le lise ou le supprime.',
              en: 'It stays until they read or delete it.',
            })),
            h('li', null, pick({
              fr: 'On peut aussi laisser un mémo sur un salon enregistré, pour ceux qui n’étaient pas là.',
              en: 'You can also leave a memo on a registered channel, for people who were away.',
            })),
            h('li', null, pick({
              fr: 'L’accusé de lecture prévient quand le mémo a été ouvert.',
              en: 'A read receipt tells you when the memo was opened.',
            }))
          )
        );
      }

      function segments() {
        if (ui.screen === 'read') return null;
        var items = [
          ['list', pick({ fr: 'Reçus', en: 'Inbox' })],
          ['write', pick({ fr: 'Écrire', en: 'Write' })],
          ['ignore', pick({ fr: 'Ignorés', en: 'Ignored' })],
        ];
        return h('div', { className: 'oms-seg', role: 'tablist' },
          items.map(function (it) {
            return h('button', {
              type: 'button',
              key: it[0],
              role: 'tab',
              'aria-selected': ui.screen === it[0] ? 'true' : 'false',
              className: ui.screen === it[0] ? 'is-on' : '',
              onClick: function () { goScreen(it[0]); },
            }, it[1]);
          })
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
        if (rpcState === 'off' && !ui.memos.length) {
          return h('p', { className: 'oms-empty' }, pick({
            fr: 'Le RPC n’est pas configuré. Renseignez memoserv-rpc.local.php avec la même adresse et le même jeton que ChanServ, puis redéployez.',
            en: 'RPC is not configured. Set memoserv-rpc.local.php to the same URL and token as ChanServ, then redeploy.',
          }));
        }
        if (ui.loading && !ui.memos.length && !ui.listed) {
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
            h('span', { className: 'oms-av', 'aria-hidden': true },
              String(m.sender || '?').replace(/^[#&]/, '').charAt(0).toUpperCase() || '?'),
            h('span', { style: { minWidth: 0, flex: 1 } },
              h('span', { className: 'oms-row__from' }, m.sender),
              h('span', { className: 'oms-row__when' }, m.when)
            ),
            m.unread ? h('span', { className: 'oms-pill' }, pick({ fr: 'Nouveau', en: 'New' })) : null
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
                ui.draft = '';
                ui.receipt = false;
                ui.screen = 'write';
                setFlash('', false);
                queueSuggest(m.sender);
              },
            }, pick({ fr: 'Répondre', en: 'Reply' })),
            h('button', {
              type: 'button', className: 'oms-btn oms-btn--warn',
              onClick: function () { deleteMemo(m.id); },
            }, pick({ fr: 'Supprimer', en: 'Delete' }))
          )
        );
      }

      function clearPresence() {
        ui.presence = '';
        ui.presenceNick = '';
      }

      function setPresence(nick, online) {
        ui.presence = online ? 'on' : 'off';
        ui.presenceNick = nick;
      }

      function clearGroup() {
        groupGen += 1;
        ui.group = null;
        ui.pendingSend = false;
      }

      function sugNick(item) {
        if (typeof item === 'string') return item;
        return (item && item.nick) ? String(item.nick) : '';
      }

      function groupShared(g) {
        if (!g || !g.account) return false;
        return !g.registered || (g.nicks && g.nicks.length > 1);
      }

      function currentGroup() {
        var g = ui.group;
        if (!g || fold(g.nick) !== fold(ui.to)) return null;
        return g;
      }

      function fetchGroup(q) {
        var nick = String(q || '').trim();
        if (nick.length < 2 || nick.charAt(0) === '#' || nick.charAt(0) === '&' || !myAccount()) {
          clearGroup();
          return;
        }
        var gen = ++groupGen;
        rpcPost({
          action: 'group',
          account: myAccount(),
          nick: myNick(),
          q: nick,
        }).then(function (data) {
          if (gen !== groupGen || fold(ui.to) !== fold(nick)) return;
          var account = (data && data.account) ? String(data.account) : '';
          var nicks = (data && Array.isArray(data.nicks)) ? data.nicks.filter(Boolean).slice(0, 16) : [];
          var registered = !!(data && data.registered);
          ui.group = {
            nick: nick,
            account: account,
            nicks: nicks,
            registered: registered,
          };
          ui.pendingSend = false;
          bump();
        }).catch(function () {
          if (gen !== groupGen) return;
          ui.group = { nick: nick, account: '', nicks: [], registered: true };
          ui.pendingSend = false;
          if (fold(ui.to) === fold(nick)) statusLine('compte introuvable pour ' + nick);
          bump();
        });
      }

      function resolvePresence(q, items) {
        if (!q || q.charAt(0) === '#' || q.charAt(0) === '&') {
          clearPresence();
          return;
        }
        var exact = '';
        var longer = false;
        (items || []).forEach(function (item) {
          var name = sugNick(item);
          if (!name) return;
          if (fold(name) === fold(q)) exact = name;
          else if (fold(name).indexOf(fold(q)) === 0) longer = true;
        });
        if (exact) { setPresence(exact, true); return; }
        if (longer) { clearPresence(); return; }
        if (validTarget(q) && q.length >= 2) setPresence(q, false);
        else clearPresence();
      }

      function queueSuggest(raw) {
        ui.to = raw;
        ui.suggestHi = 0;
        var q = String(raw || '');
        var chan = q.charAt(0) === '#';
        var ready = chan ? q.length >= 2 : q.length >= 1;
        if (!ready || /\s/.test(q) || !myAccount()) {
          ui.suggest = [];
          clearPresence();
          clearGroup();
          if (suggestTimer) clearTimeout(suggestTimer);
          bump();
          return;
        }
        if (fold(ui.presenceNick) !== fold(q)) clearPresence();
        if (!ui.group || fold(ui.group.nick) !== fold(q)) ui.group = null;
        bump();
        if (suggestTimer) clearTimeout(suggestTimer);
        var gen = ++suggestGen;
        suggestTimer = setTimeout(function () {
          rpcPost({
            action: 'suggest',
            account: myAccount(),
            nick: myNick(),
            q: q,
          }).then(function (data) {
            if (gen !== suggestGen || ui.to !== q) return;
            ui.suggest = (data && data.ok && Array.isArray(data.items)) ? data.items.slice(0, 12) : [];
            ui.suggestHi = 0;
            if (!chan) {
              resolvePresence(q, ui.suggest);
              if (fold(ui.presenceNick) === fold(q) && q.length >= 2) fetchGroup(q);
              else clearGroup();
            } else {
              clearPresence();
              clearGroup();
            }
            bump();
          }).catch(function () {
            if (gen !== suggestGen) return;
            ui.suggest = [];
            bump();
          });
        }, 200);
      }

      function pickSuggest(item) {
        var name = sugNick(item);
        if (!name) return;
        ui.to = name;
        ui.suggest = [];
        ui.suggestHi = 0;
        if (name.charAt(0) === '#') {
          clearPresence();
          clearGroup();
        } else {
          setPresence(name, true);
          fetchGroup(name);
        }
        bump();
      }

      function memoDest() {
        var target = validTarget(ui.to);
        if (!target) return '';
        var g = currentGroup();
        if (g && groupShared(g) && !g.registered && g.account) return g.account;
        return target;
      }

      function sendLabel() {
        var g = currentGroup();
        if (g && groupShared(g) && !g.registered && g.account) {
          return pick({ fr: 'Envoyer sur ' + g.account, en: 'Send to ' + g.account });
        }
        return pick({ fr: 'Envoyer', en: 'Send' });
      }

      function accountBox() {
        var g = currentGroup();
        if (!g || !groupShared(g) || !g.account) return null;
        var account = g.account;
        var names = (g.nicks || []).slice(0, 8);
        var list = names.join(', ');
        if ((g.nicks || []).length > names.length) list += '…';
        var same = fold(ui.to) === fold(account);
        var lead = !g.registered
          ? pick({
            fr: ui.to + ' n’est pas un pseudo enregistré. Cette personne est identifiée sur le compte NickServ ' + account + '.',
            en: ui.to + ' is not a registered nick. This person is identified on the NickServ account ' + account + '.',
          })
          : same
            ? pick({
              fr: 'Le compte ' + account + ' regroupe plusieurs pseudos. MemoServ ne peut pas écrire à un seul d’entre eux.',
              en: 'The account ' + account + ' has several nicks. MemoServ cannot address only one of them.',
            })
            : pick({
              fr: ui.to + ' fait partie du compte NickServ ' + account + '. MemoServ ne peut pas écrire à un seul pseudo de ce compte.',
              en: ui.to + ' belongs to the NickServ account ' + account + '. MemoServ cannot address only one nick of that account.',
            });
        var share = list
          ? pick({
            fr: 'Le mémo sera déposé sur le compte ' + account + ', donc lisible par tous ses pseudos : ' + list + '.',
            en: 'The memo is stored on the account ' + account + ', so every nick of that account can read it: ' + list + '.',
          })
          : pick({
            fr: 'Le mémo sera déposé sur le compte ' + account + ', donc lisible par tous les pseudos de ce compte.',
            en: 'The memo is stored on the account ' + account + ', so every nick of that account can read it.',
          });
        return h('div', { className: 'oms-acct' },
          h('p', null, lead),
          h('p', null, share)
        );
      }

      function presenceEl() {
        if (!ui.presence || fold(ui.presenceNick) !== fold(ui.to)) return null;
        if (ui.to.charAt(0) === '#' || ui.to.charAt(0) === '&') return null;
        var on = ui.presence === 'on';
        return h('span', { className: 'oms-pres ' + (on ? 'oms-pres--on' : 'oms-pres--off') },
          on ? pick({ fr: 'en ligne', en: 'online' }) : pick({ fr: 'hors ligne', en: 'offline' }));
      }

      function WriteScreen() {
        var self = fold(ui.to) === fold(myNick()) || (myAccount() && fold(ui.to) === fold(myAccount()));
        var channel = ui.to.charAt(0) === '#' || ui.to.charAt(0) === '&';
        return h('form', {
          className: 'oms-form',
          onSubmit: function (e) {
            try { e.preventDefault(); } catch (err) { /* ignore */ }
            var viaSend = false;
            try { viaSend = !!(e.nativeEvent && e.nativeEvent.submitter && e.nativeEvent.submitter.getAttribute('data-send')); } catch (err2) { viaSend = false; }
            if (ui.suggest.length && !viaSend) {
              pickSuggest(ui.suggest[ui.suggestHi] || ui.suggest[0]);
              return;
            }
            sendMemo();
          },
        },
          h('label', null,
            pick({ fr: 'Destinataire', en: 'Recipient' }),
            h('div', { className: 'oms-to' },
              h('div', { className: 'oms-ac' },
                h('input', {
                  type: 'text',
                  name: 'memo-to',
                  autoComplete: 'off',
                  role: 'combobox',
                  'aria-autocomplete': 'list',
                  'aria-expanded': ui.suggest.length ? 'true' : 'false',
                  value: ui.to,
                  placeholder: pick({ fr: 'Pseudo ou #salon', en: 'Nick or #channel' }),
                  onChange: function (e) { queueSuggest(e.target.value); },
                  onKeyDown: function (e) {
                    if (!ui.suggest.length) return;
                    if (e.key === 'ArrowDown') {
                      try { e.preventDefault(); } catch (err) { /* ignore */ }
                      ui.suggestHi = Math.min(ui.suggest.length - 1, ui.suggestHi + 1);
                      bump();
                    } else if (e.key === 'ArrowUp') {
                      try { e.preventDefault(); } catch (err2) { /* ignore */ }
                      ui.suggestHi = Math.max(0, ui.suggestHi - 1);
                      bump();
                    } else if (e.key === 'Escape') {
                      try { e.preventDefault(); e.stopPropagation(); } catch (err3) { /* ignore */ }
                      ui.suggest = [];
                      bump();
                    }
                  },
                }),
                ui.suggest.length ? h('ul', { className: 'oms-ac__list', role: 'listbox' },
                  ui.suggest.map(function (item, i) {
                    var name = sugNick(item);
                    var acc = (item && typeof item === 'object' && item.account) ? String(item.account) : '';
                    if (!name) return null;
                    return h('li', { key: name },
                      h('button', {
                        type: 'button',
                        className: 'oms-ac__opt' + (i === ui.suggestHi ? ' is-on' : ''),
                        role: 'option',
                        'aria-selected': i === ui.suggestHi ? 'true' : 'false',
                        onMouseDown: function (e) {
                          try { e.preventDefault(); } catch (err) { /* ignore */ }
                          pickSuggest(item);
                        },
                      },
                        name,
                        acc && fold(acc) !== fold(name)
                          ? h('span', { className: 'oms-ac__acc' }, pick({ fr: 'compte ' + acc, en: 'account ' + acc }))
                          : null
                      )
                    );
                  })
                ) : null
              ),
              presenceEl()
            )
          ),
          accountBox(),
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
            h('button', { type: 'submit', 'data-send': '1', className: 'oms-btn oms-btn--go', disabled: pending.kind === 'send' },
              sendLabel()),
            !channel && memoDest() ? h('button', {
              type: 'button', className: 'oms-btn',
              onClick: function () { sendCmd('check', 'CHECK ' + memoDest()); },
            }, pick({ fr: 'Déjà lu ?', en: 'Already read?' })) : null,
            memoDest() ? h('button', {
              type: 'button', className: 'oms-btn',
              onClick: function () { sendCmd('cancel', 'CANCEL ' + memoDest()); },
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

      function panelBox() {
        var W = 400;
        var H = 640;
        var left = 8;
        var bottom = 74;
        try {
          W = Math.min(400, window.innerWidth - 16);
          var A = ui.anchor;
          if (A && A.width) {
            left = Math.round(Math.min(Math.max(A.left + A.width / 2 - W / 2, 8), window.innerWidth - W - 8));
            bottom = Math.round(window.innerHeight - A.top + 10);
          } else {
            left = Math.max(8, Math.round((window.innerWidth - W) / 2));
          }
          H = Math.min(640, Math.max(220, window.innerHeight - bottom - 12));
        } catch (e) { /* ignore */ }
        return {
          position: 'fixed',
          left: left + 'px',
          bottom: bottom + 'px',
          zIndex: 60,
          width: W + 'px',
          maxHeight: H + 'px',
        };
      }

      function MemoToasts() {
        if (!ui.popups.length) return null;
        return h('div', { className: 'oms-pop', 'aria-live': 'polite' },
          ui.popups.map(function (p) {
            var sub = p.channel
              ? pick({ fr: 'Sur ' + p.channel, en: 'On ' + p.channel })
              : p.from
                ? pick({ fr: 'De ' + p.from, en: 'From ' + p.from })
                : pick({ fr: 'Vous avez un nouveau mémo.', en: 'You have a new memo.' });
            return h('div', { key: p.id, className: 'oms-pop__card' },
              h('button', {
                type: 'button',
                className: 'oms-pop__main',
                onClick: function () { openFromPopup(p.id); },
              },
                h('span', { className: 'oms-pop__t' }, pick({ fr: 'Nouveau mémo', en: 'New memo' })),
                h('span', { className: 'oms-pop__s' }, sub)
              ),
              h('button', {
                type: 'button',
                className: 'oms-pop__x',
                'aria-label': pick({ fr: 'Fermer', en: 'Close' }),
                onClick: function (e) {
                  try { e.stopPropagation(); } catch (err) { /* ignore */ }
                  dismissPopup(p.id);
                },
              }, '×')
            );
          })
        );
      }

      function MemoPane() {
        useSyncExternalStore(subscribe, snap, snap);
        useEffect(function () {
          if (!ui.open) return undefined;
          function onKey(e) {
            if (e.key !== 'Escape' || !ui.open) return;
            if (ui.help) { ui.help = false; bump(); return; }
            if (ui.suggest.length) {
              ui.suggest = [];
              bump();
              return;
            }
            if (ui.screen === 'read') goScreen('list');
            else closeView();
          }
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }, [ui.open]);
        var toasts = h(MemoToasts);
        if (!ui.open) return toasts;
        return h('div', null,
          toasts,
          h('div', {
            style: { position: 'fixed', inset: 0, zIndex: 59 },
            onClick: function () { closeView(); },
          }),
          h('div', {
            className: 'oms-panel',
            role: 'dialog',
            'aria-label': pick({ fr: 'Mémo', en: 'Memo' }),
            style: panelBox(),
          },
            bar(),
            helpEl(),
            segments(),
            flashEl(),
            h('div', { className: 'oms-body' },
              ui.screen === 'write' ? h(WriteScreen)
                : ui.screen === 'read' ? h(ReadScreen)
                  : ui.screen === 'ignore' ? h(IgnoreScreen)
                    : h(ListScreen)
            )
          )
        );
      }

      injectCss();
      orbit.on('raw', onRaw);
      var booted = false;
      function bootList() {
        if (booted || !myNick()) return;
        booted = true;
        requestList('démarrage');
      }
      orbit.on('connected', function () {
        booted = false;
        setTimeout(bootList, 600);
      });
      orbit.on('orbit:panel', function (id) {
        if (id !== 'orbit-memoserv' && ui.open) closeView();
      });
      if (typeof orbit.addMessageFilter === 'function') orbit.addMessageFilter(shouldHide);
      orbit.addUi('nav_item', function () { return h(MemoTab); });
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
      setTimeout(bootList, 600);
    });
  }
})(function () {
  var VER = 14;

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
    var sawHeader = false;
    var flat = [];
    (lines || []).forEach(function (raw) {
      String(raw || '').split(/\r\n|\n|\r/).forEach(function (part) { flat.push(part); });
    });
    flat.forEach(function (raw) {
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
      if (/^m[eé]mos pour\b|^memos for\b/i.test(trimmed)) { sawHeader = true; return; }
      if (/^(num[eé]ro|number)\b/i.test(trimmed)) { sawHeader = true; return; }
      var row = line.match(/^\s*(\*)?\s*(\d+)\s+(\S+)\s+(.+)$/);
      if (!row) row = line.match(/^\s*(\*?)(\d+)\s+(\S+)\s+(.+)$/);
      if (!row) {
        var phrase = trimmed.match(/^(?:\*|★)?\s*(\d+)\s*:\s*(?:envoy[ée]e?\s+par|sent\s+by)\s+(\S+)\s+(?:le|on)\s+(.+)$/i);
        if (phrase) {
          rows.push({
            id: parseInt(phrase[1], 10),
            unread: /^\s*(?:\*|★)/.test(line),
            sender: phrase[2],
            when: phrase[3].trim(),
            text: '',
          });
          return;
        }
      }
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
      sawHeader: sawHeader,
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
