/*
 * orbit-chanserv — commandes ChanServ / BotServ selon l’accès Anope.
 *
 * Icône barre du salon (desktop) + menu ⋮ (mobile). Panneau overlay.
 * Salon non enregistré → REGISTER (compte NickServ requis).
 * Salon enregistré → commandes filtrées (VOP/HOP/AOP/SOP/fondateur) + bot.
 *
 * config.json:
 *   "plugins": [".../orbit-chanserv/orbit-chanserv.js?v=2"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var COALESCE_MS = 600;
  var HIDE_MS = 8000;
  var CACHE_MS = 20000;
  var STYLE_ID = 'orbit-chanserv-css';

  var ACCESS_RANK = { none: 0, vop: 3, hop: 4, aop: 5, sop: 10, founder: 100 };

  Orbit.plugin('orbit-chanserv', function (orbit, log) {
    var React = orbit.React;
    var h = React.createElement;
    var useSyncExternalStore = React.useSyncExternalStore;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var pending = [];
    var coalesceTimer = 0;
    var pendingFrom = '';
    var hideUntil = 0;
    var expectKind = '';
    var expectChan = '';
    var cache = {};

    var ui = {
      open: false,
      chan: '',
      loading: false,
      registered: null,
      founder: '',
      bot: '',
      access: 'none',
      bots: [],
      infoText: '',
      flash: '',
      flashErr: false,
      listeners: new Set(),
    };
    var snap = copyUi();
    function copyUi() {
      return {
        open: ui.open, chan: ui.chan, loading: ui.loading, registered: ui.registered,
        founder: ui.founder, bot: ui.bot, access: ui.access, bots: ui.bots.slice(),
        infoText: ui.infoText, flash: ui.flash, flashErr: ui.flashErr,
      };
    }
    function subscribeUi(cb) { ui.listeners.add(cb); return function () { ui.listeners.delete(cb); }; }
    function uiSnap() { return snap; }
    function notifyUi() {
      snap = copyUi();
      ui.listeners.forEach(function (l) { l(); });
    }
    function patchUi(partial) {
      Object.keys(partial).forEach(function (k) { ui[k] = partial[k]; });
      notifyUi();
    }

    function pick(fr, en) {
      return orbit.i18n.pick({ fr: fr, en: en });
    }
    function isChannel(name) {
      return !!name && (name[0] === '#' || name[0] === '&');
    }
    function foldText(text) {
      return String(text || '').toLowerCase()
        .replace(/[àáâä]/g, 'a').replace(/[éèêë]/g, 'e')
        .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
        .replace(/[ùûü]/g, 'u').replace(/ç/g, 'c');
    }
    function stripIrc(text) {
      return String(text || '')
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
        .replace(/[\x02\x0f\x16\x1d\x1e\x1f]/g, '');
    }
    function hasHalfop() {
      try {
        var p = (orbit.server.isupport() || {}).PREFIX || '';
        return p.indexOf('%') !== -1;
      } catch (e) { return false; }
    }
    function rank() { return ACCESS_RANK[ui.access] || 0; }
    function can(min) { return rank() >= min; }
    function identified() { return !!orbit.state.account(); }

    function iconVisible(s, chan) {
      if (!isChannel(chan) || !identified()) return false;
      // Hide only once INFO/STATUS says registered + no ChanServ access.
      if (s.registered === true && s.access === 'none') return false;
      return true;
    }

    function cs(cmd) { orbit.irc.msg('ChanServ', cmd); }
    function bs(cmd) { orbit.irc.msg('BotServ', cmd); }

    function rememberCache(chan) {
      if (!chan) return;
      cache[chan.toLowerCase()] = {
        ts: Date.now(),
        registered: ui.registered,
        founder: ui.founder,
        bot: ui.bot,
        access: ui.access,
        infoText: ui.infoText,
      };
    }
    function applyCache(chan) {
      var c = cache[chan.toLowerCase()];
      if (!c || Date.now() - c.ts > CACHE_MS) return false;
      patchUi({
        chan: chan, loading: false, registered: c.registered, founder: c.founder,
        bot: c.bot, access: c.access, infoText: c.infoText, flash: '',
      });
      return true;
    }

    function beginExpect(kind, chan) {
      expectKind = kind;
      expectChan = chan;
      hideUntil = Date.now() + HIDE_MS;
      pending = [];
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = 0; }
    }

    function queryInfo(chan) {
      if (!isChannel(chan) || !identified()) {
        patchUi({ chan: chan, loading: false, registered: null, access: 'none', bot: '', founder: '', infoText: '' });
        return;
      }
      if (applyCache(chan)) return;
      patchUi({ chan: chan, loading: true, flash: '' });
      beginExpect('info', chan);
      cs('INFO ' + chan);
    }

    function queryStatus(chan) {
      beginExpect('status', chan);
      cs('STATUS ' + chan);
    }

    function queryBotlist() {
      beginExpect('botlist', expectChan || ui.chan);
      bs('BOTLIST');
    }

    function parseAccess(text) {
      var t = foldText(text);
      if (/pas (d[' ]?)?acces|no(t)? (have )?access|don't have access|dont have access|aucun acces/.test(t)
        && !/fondateur|founder|sop|aop|hop|vop|niveau|level/.test(t)) {
        return 'none';
      }
      if (/fondateur|founder/.test(t)) return 'founder';
      if (/\bsop\b/.test(t)) return 'sop';
      if (/\baop\b/.test(t)) return 'aop';
      if (/\bhop\b/.test(t) || /halfop/.test(t)) return 'hop';
      if (/\bvop\b/.test(t) || /\bvoice\b/.test(t) && /acces/.test(t)) return 'vop';
      var m = t.match(/niveau\s+(\d+)/) || t.match(/access(?:\s+level)?\s+(\d+)/) || t.match(/has access\s+(\d+)/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n >= 100 || n >= 10000) return 'founder';
        if (n >= 10) return 'sop';
        if (n >= 5) return 'aop';
        if (n >= 4) return 'hop';
        if (n >= 3) return 'vop';
        if (n > 0) return 'vop';
        return 'none';
      }
      if (/vous avez (un )?acces|you have access|has access/.test(t)) return 'aop';
      return '';
    }

    function parseInfo(text) {
      var raw = stripIrc(text);
      var t = foldText(raw);
      var out = { registered: true, founder: '', bot: '', infoText: raw.trim() };
      if (/n[' ]est pas enregistre|isn['\u2019 ]?t registered|is not registered|n[' ]existe pas/.test(t)) {
        out.registered = false;
        return out;
      }
      var fm = raw.match(/(?:fondateur|founder)\s*:\s*(\S+)/i);
      if (fm) out.founder = fm[1].replace(/[.,;]+$/, '');
      var bm = raw.match(/(?:^|\n)\s*(?:bot|botserv)\s*:\s*(\S+)/i);
      if (bm && !/^n\/?a$/i.test(bm[1]) && bm[1] !== '-' && bm[1] !== '*') {
        out.bot = bm[1].replace(/[.,;]+$/, '');
      }
      return out;
    }

    function parseBotlist(text) {
      var names = [];
      String(text || '').split(/\n/).forEach(function (line) {
        var s = stripIrc(line).trim();
        if (!s || /bot list|liste des bots|end of/i.test(s)) return;
        var m = s.match(/^[-*•]\s*(\S+)/) || s.match(/^(\S+)\s+\(/);
        if (m && !/chanserv|botserv|nickserv/i.test(m[1])) names.push(m[1]);
      });
      return names;
    }

    function applyKind(kind, text) {
      var chan = expectChan || ui.chan;
      if (kind === 'info') {
        var info = parseInfo(text);
        patchUi({
          loading: info.registered === true,
          registered: info.registered,
          founder: info.founder,
          bot: info.bot,
          infoText: info.infoText,
          access: info.registered ? ui.access : 'none',
        });
        if (info.registered) queryStatus(chan);
        else {
          rememberCache(chan);
          expectKind = '';
        }
        return;
      }
      if (kind === 'status') {
        var acc = parseAccess(text) || 'none';
        var me = foldText(orbit.state.nick() || '');
        var founder = foldText(ui.founder);
        if (founder && me && founder === me) acc = 'founder';
        patchUi({ access: acc, loading: false });
        rememberCache(chan);
        expectKind = '';
        if (ui.open && can(ACCESS_RANK.sop) && !ui.bot && !ui.bots.length) queryBotlist();
        return;
      }
      if (kind === 'botlist') {
        patchUi({ bots: parseBotlist(text), loading: false });
        expectKind = '';
        return;
      }
      if (kind === 'cmd') {
        var folded = foldText(text);
        var err = /permission|access denied|acces refuse|vous ne pouvez|you cannot|isn't registered|pas enregistre/.test(folded);
        patchUi({ flash: stripIrc(text).replace(/\s+/g, ' ').trim().slice(0, 280), flashErr: err, loading: false });
        expectKind = '';
        cache = {};
        if (ui.chan) setTimeout(function () { queryInfo(ui.chan); }, 400);
      }
    }

    function flush() {
      coalesceTimer = 0;
      if (!pending.length) return;
      var text = pending.join('\n');
      pending = [];
      var kind = expectKind || 'cmd';
      applyKind(kind, text);
    }

    function onRaw(msg) {
      if (!msg || String(msg.command || '').toUpperCase() !== 'NOTICE') return;
      var from = String(msg.nick || '').trim();
      if (!/^(chanserv|botserv)$/i.test(from)) return;
      if (Date.now() > hideUntil && !expectKind) return;
      var text = stripIrc((msg.params && msg.params[1]) || '');
      if (!text.trim()) return;
      if (pendingFrom && pendingFrom !== from.toLowerCase()) {
        flush();
      }
      pendingFrom = from.toLowerCase();
      pending.push(text);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flush, COALESCE_MS);
    }

    function shouldHideNotice(m) {
      if (Date.now() > hideUntil && !expectKind) return false;
      return /^(chanserv|botserv)$/i.test(String(m.nick || ''));
    }

    function runCmd(service, line, refresh) {
      if (!line) return;
      beginExpect(refresh ? 'cmd' : 'cmd', ui.chan);
      patchUi({ flash: '', loading: true });
      if (service === 'BotServ') bs(line);
      else cs(line);
    }

    function toggleOpen() {
      var chan = orbit.state.active();
      if (!isChannel(chan)) return;
      if (ui.open && ui.chan === chan) {
        patchUi({ open: false });
        return;
      }
      patchUi({ open: true, chan: chan, flash: '' });
      queryInfo(chan);
    }

    function closePanel() { patchUi({ open: false }); }

    function injectStyles() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = [
        '.ocs-panel{position:fixed;right:12px;top:58px;z-index:160;width:min(420px,calc(100vw - 1.5rem));',
        'max-height:min(78vh,640px);overflow:auto;background:var(--bg);color:var(--ink);',
        'border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-pop,0 18px 50px -16px rgba(20,30,45,.45));',
        'padding:1rem 1rem .9rem;display:flex;flex-direction:column;gap:.65rem}',
        '.ocs-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}',
        '.ocs-title{margin:0;font-size:1.02rem;font-weight:800}',
        '.ocs-x{border:0;background:transparent;color:var(--muted);font-size:1.3rem;cursor:pointer;border-radius:8px;padding:.1rem .35rem}',
        '.ocs-x:hover{background:var(--bg-soft);color:var(--ink)}',
        '.ocs-sub{font-size:.8rem;color:var(--muted);margin:0}',
        '.ocs-badge{display:inline-flex;align-items:center;gap:.35rem;font-size:.75rem;font-weight:700;',
        'background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:.15rem .55rem}',
        '.ocs-row{display:flex;flex-wrap:wrap;gap:.4rem}',
        '.ocs-field{display:flex;flex-direction:column;gap:.28rem}',
        '.ocs-label{font-size:.75rem;font-weight:700;color:var(--muted)}',
        '.ocs-input,.ocs-select{width:100%;box-sizing:border-box;min-height:38px;padding:.45rem .65rem;border-radius:10px;',
        'border:1px solid var(--border);background:var(--bg-soft);color:var(--ink);font:inherit}',
        '.ocs-btn{min-height:36px;padding:.4rem .7rem;border-radius:10px;border:1px solid var(--border);',
        'background:var(--bg-soft);color:var(--ink);font:inherit;font-weight:700;font-size:.82rem;cursor:pointer}',
        '.ocs-btn:hover{background:var(--bg-soft-2,var(--bg))}',
        '.ocs-btn--primary{background:var(--accent);color:#fff;border:0}',
        '.ocs-flash{font-size:.82rem;line-height:1.4;padding:.45rem .55rem;border-radius:10px;background:var(--bg-soft)}',
        '.ocs-flash.is-err{color:var(--danger,#dc2626);font-weight:650}',
        '.ocs-h{margin:.2rem 0 0;font-size:.78rem;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}',
        '.ocs-info{white-space:pre-wrap;font-size:.78rem;line-height:1.4;color:var(--muted);max-height:7rem;overflow:auto}',
        '@media (max-width:880px){.ocs-panel{top:auto;bottom:72px;right:8px;left:8px;width:auto}}',
      ].join('');
    }
    injectStyles();

    function ShieldIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M12 3 5 6.5v5.2c0 4.2 2.9 7.3 7 8.8 4.1-1.5 7-4.6 7-8.8V6.5L12 3z' }));
    }

    function useActiveBuffer() {
      return useSyncExternalStore(
        function (cb) {
          var off = orbit.on('buffer.active', cb);
          var id = window.setInterval(cb, 400);
          return function () { if (typeof off === 'function') off(); window.clearInterval(id); };
        },
        function () { return orbit.state.active(); },
        function () { return orbit.state.active(); }
      );
    }

    function HeaderButton() {
      var chan = useActiveBuffer();
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      useEffect(function () {
        if (!isChannel(chan) || !identified()) return undefined;
        if (s.chan === chan && s.registered !== null) return undefined;
        queryInfo(chan);
        return undefined;
      }, [chan, identified()]);
      if (!iconVisible(s, chan)) return null;
      var on = s.open && s.chan === chan;
      var title = pick('Services du salon (ChanServ)', 'Channel services (ChanServ)');
      return h('button', {
        type: 'button',
        className: 'topbar__search' + (on ? ' is-on' : ''),
        title: title,
        'aria-label': title,
        'aria-pressed': on,
        onClick: toggleOpen,
      }, h(ShieldIcon));
    }

    function MoreMenuItem() {
      var chan = useActiveBuffer();
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      if (!iconVisible(s, chan)) return null;
      var on = s.open && s.chan === chan;
      var label = pick('Services du salon', 'Channel services');
      return h('button', {
        type: 'button',
        className: 'nmenu__item',
        role: 'menuitem',
        onClick: toggleOpen,
      },
        h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(ShieldIcon)),
        h('span', { className: 'nmenu__txt' }, h('b', null, on ? pick('Fermer les services', 'Close services') : label))
      );
    }

    function Field(props) {
      return h('div', { className: 'ocs-field' },
        props.label ? h('label', { className: 'ocs-label' }, props.label) : null,
        props.children
      );
    }

    function Panel() {
      var s = useSyncExternalStore(subscribeUi, uiSnap, uiSnap);
      var chan = useActiveBuffer();
      var nickSt = useState('');
      var nick = nickSt[0];
      var setNick = nickSt[1];
      var reasonSt = useState('');
      var reason = reasonSt[0];
      var setReason = reasonSt[1];
      var topicSt = useState('');
      var topic = topicSt[0];
      var setTopic = topicSt[1];
      var descSt = useState('');
      var desc = descSt[0];
      var setDesc = descSt[1];
      var saySt = useState('');
      var say = saySt[0];
      var setSay = saySt[1];
      var botPickSt = useState('');
      var botPick = botPickSt[0];
      var setBotPick = botPickSt[1];
      var infoOpenSt = useState(false);
      var infoOpen = infoOpenSt[0];
      var setInfoOpen = infoOpenSt[1];

      useEffect(function () {
        if (s.open && isChannel(chan) && s.chan !== chan) {
          patchUi({ chan: chan, flash: '' });
          queryInfo(chan);
        }
      }, [chan, s.open]);

      if (!s.open) return null;
      var ch = s.chan || chan;
      var hop = hasHalfop();
      var kids = [
        h('div', { className: 'ocs-head' },
          h('h2', { className: 'ocs-title' }, pick('Services du salon', 'Channel services')),
          h('button', { type: 'button', className: 'ocs-x', onClick: closePanel, 'aria-label': pick('Fermer', 'Close') }, '×')
        ),
        h('p', { className: 'ocs-sub' }, ch),
      ];
      if (s.loading) kids.push(h('p', { className: 'ocs-sub' }, pick('Interrogation de ChanServ…', 'Asking ChanServ…')));
      if (s.registered === false) {
        kids.push(h(Field, { label: pick('Description (optionnel)', 'Description (optional)') },
          h('input', {
            className: 'ocs-input',
            value: desc,
            maxLength: 80,
            onChange: function (e) { setDesc(e.target.value); },
          })
        ));
        kids.push(h('button', {
          type: 'button',
          className: 'ocs-btn ocs-btn--primary',
          onClick: function () {
            var d = desc.trim() || pick('Salon EntreNous', 'EntreNous channel');
            runCmd('ChanServ', 'REGISTER ' + ch + ' ' + d, true);
          },
        }, pick('Enregistrer le salon', 'Register channel')));
      }
      if (s.registered === true) {
        kids.push(h('div', { className: 'ocs-row' },
          h('span', { className: 'ocs-badge' }, (s.access || 'none').toUpperCase()),
          s.bot ? h('span', { className: 'ocs-badge' }, pick('Bot', 'Bot') + ' ' + s.bot) : null
        ));
        kids.push(h('button', {
          type: 'button',
          className: 'ocs-btn',
          onClick: function () {
            setInfoOpen(true);
            beginExpect('info', ch);
            patchUi({ loading: true });
            cs('INFO ' + ch);
          },
        }, pick('Info du salon', 'Channel info')));
        if (infoOpen && s.infoText) kids.push(h('pre', { className: 'ocs-info' }, s.infoText));

        if (can(ACCESS_RANK.vop)) {
          kids.push(h('h3', { className: 'ocs-h' }, pick('Modération', 'Moderation')));
          kids.push(h(Field, { label: pick('Pseudo', 'Nick') },
            h('input', { className: 'ocs-input', value: nick, onChange: function (e) { setNick(e.target.value); } })
          ));
          kids.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'VOICE ' + ch + ' ' + nick.trim()); } }, 'Voice'),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'DEVOICE ' + ch + ' ' + nick.trim()); } }, 'Devoice'),
            hop && can(ACCESS_RANK.hop) ? h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'HALFOP ' + ch + ' ' + nick.trim()); } }, 'Halfop') : null,
            hop && can(ACCESS_RANK.hop) ? h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'DEHALFOP ' + ch + ' ' + nick.trim()); } }, 'Dehalfop') : null,
            can(ACCESS_RANK.aop) ? h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'OP ' + ch + ' ' + nick.trim()); } }, 'Op') : null,
            can(ACCESS_RANK.aop) ? h('button', { type: 'button', className: 'ocs-btn', onClick: function () { if (nick.trim()) runCmd('ChanServ', 'DEOP ' + ch + ' ' + nick.trim()); } }, 'Deop') : null
          ));
        }
        if (can(ACCESS_RANK.aop)) {
          kids.push(h(Field, { label: pick('Motif (kick / ban)', 'Reason (kick / ban)') },
            h('input', { className: 'ocs-input', value: reason, onChange: function (e) { setReason(e.target.value); } })
          ));
          kids.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (!nick.trim()) return;
              runCmd('ChanServ', 'KICK ' + ch + ' ' + nick.trim() + (reason.trim() ? ' ' + reason.trim() : ''));
            } }, 'Kick'),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (!nick.trim()) return;
              runCmd('ChanServ', 'BAN ' + ch + ' ' + nick.trim() + (reason.trim() ? ' ' + reason.trim() : ''));
            } }, 'Ban')
          ));
          kids.push(h(Field, { label: pick('Sujet', 'Topic') },
            h('input', { className: 'ocs-input', value: topic, onChange: function (e) { setTopic(e.target.value); } })
          ));
          kids.push(h('button', {
            type: 'button',
            className: 'ocs-btn ocs-btn--primary',
            onClick: function () { if (topic.trim()) runCmd('ChanServ', 'TOPIC ' + ch + ' ' + topic.trim()); },
          }, pick('Changer le sujet', 'Set topic')));
        }

        if (can(ACCESS_RANK.sop)) {
          kids.push(h('h3', { className: 'ocs-h' }, 'BotServ'));
          if (!s.bot) {
            if (!s.bots.length) {
              kids.push(h('button', { type: 'button', className: 'ocs-btn', onClick: queryBotlist },
                pick('Charger la liste des bots', 'Load bot list')));
            } else {
              kids.push(h(Field, { label: pick('Bot à assigner', 'Bot to assign') },
                h('select', {
                  className: 'ocs-select',
                  value: botPick,
                  onChange: function (e) { setBotPick(e.target.value); },
                }, [h('option', { value: '' }, '—')].concat(s.bots.map(function (b) {
                  return h('option', { key: b, value: b }, b);
                })))
              ));
              kids.push(h('button', {
                type: 'button',
                className: 'ocs-btn ocs-btn--primary',
                onClick: function () {
                  var b = botPick || s.bots[0];
                  if (b) runCmd('BotServ', 'ASSIGN ' + ch + ' ' + b, true);
                },
              }, pick('Assigner le bot', 'Assign bot')));
            }
          } else {
            kids.push(h('button', {
              type: 'button',
              className: 'ocs-btn',
              onClick: function () { runCmd('BotServ', 'UNASSIGN ' + ch, true); },
            }, pick('Retirer le bot', 'Unassign bot')));
          }
        }
        if (s.bot && can(ACCESS_RANK.aop)) {
          kids.push(h(Field, { label: pick('Message du bot', 'Bot message') },
            h('input', { className: 'ocs-input', value: say, onChange: function (e) { setSay(e.target.value); } })
          ));
          kids.push(h('div', { className: 'ocs-row' },
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (say.trim()) runCmd('BotServ', 'SAY ' + ch + ' ' + say.trim());
            } }, pick('Dire', 'Say')),
            h('button', { type: 'button', className: 'ocs-btn', onClick: function () {
              if (say.trim()) runCmd('BotServ', 'ACT ' + ch + ' ' + say.trim());
            } }, pick('Action', 'Act'))
          ));
        }
      }
      if (s.flash) kids.push(h('div', { className: 'ocs-flash' + (s.flashErr ? ' is-err' : ''), role: 'status' }, s.flash));
      return h('div', { className: 'ocs-panel', role: 'dialog', 'aria-label': pick('Services du salon', 'Channel services') }, kids);
    }

    orbit.on('raw', onRaw);
    orbit.on('status', function (st) {
      if (st === 'registered') return;
      cache = {};
      pending = [];
      expectKind = '';
      patchUi({ open: false, registered: null, access: 'none', bot: '', bots: [], loading: false });
    });
    orbit.addMessageFilter(function (m) {
      if (String(m.command || '').toUpperCase() !== 'NOTICE') return false;
      return shouldHideNotice(m);
    });
    orbit.addUi('topbar_item', function () { return h(HeaderButton); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem); });
    orbit.addUi('overlay', function () { return h(Panel); });
    log('ChanServ/BotServ panel — topbar + overlay');
  });
})();
