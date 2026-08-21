/*!
 * orbit-callerid — contrôle parental / mode +g (ACCEPT) pour Orbit (EntreNous)
 *
 * Actif uniquement si le groupe security `controle-parentale` apparaît au WHOIS (320).
 * Force les modes parentaux, affiche les demandes de MP (718) et gère ACCEPT.
 *
 * config.json:
 *   "callerid": { "group": "controle-parentale", "modes": "+ixIgcRw", "autoMode": true }
 *   "plugins": [".../orbit-callerid/orbit-callerid.js?v=1"]
 */
(function () {
  'use strict';
  if (typeof Orbit === 'undefined' || !Orbit.plugin) return;

  var React = Orbit.React;
  var h = React.createElement;
  var useState = React.useState;
  var useSyncExternalStore = React.useSyncExternalStore;

  var DEFAULT_GROUP = 'controle-parentale';
  var DEFAULT_MODES = '+ixIgcRw';

  var myGroupsText = '';
  var parentalActive = false;
  var modesApplied = false;

  /** Pending callerid requests: nick → { nick, host, ts } */
  var pending = { map: Object.create(null), rev: 0, listeners: new Set() };
  function subscribePending(cb) { pending.listeners.add(cb); return function () { pending.listeners.delete(cb); }; }
  function getPendingSnap() { return pending.rev; }
  function pendingKey(nick) { return String(nick || '').toLowerCase(); }
  function listPending() {
    var out = [];
    Object.keys(pending.map).forEach(function (k) { out.push(pending.map[k]); });
    return out;
  }
  function setPending(nick, data) {
    var key = pendingKey(nick);
    if (!key) return;
    if (data) pending.map[key] = data;
    else delete pending.map[key];
    pending.rev++;
    pending.listeners.forEach(function (l) { l(); });
  }

  /** ACCEPT whitelist from RPL_ACCEPTLIST (281) */
  var acceptList = { nicks: [], rev: 0, listeners: new Set(), loading: false };
  function subscribeAccept(cb) { acceptList.listeners.add(cb); return function () { acceptList.listeners.delete(cb); }; }
  function getAcceptSnap() { return acceptList.rev; }
  function bumpAccept() {
    acceptList.rev++;
    acceptList.listeners.forEach(function (l) { l(); });
  }
  function beginAcceptList() {
    acceptList.nicks = [];
    acceptList.loading = true;
    bumpAccept();
  }
  function pushAcceptNick(nick) {
    if (!nick) return;
    acceptList.nicks.push(String(nick));
    bumpAccept();
  }
  function endAcceptList() {
    acceptList.loading = false;
    bumpAccept();
  }

  /** Parental gate flag for UI */
  var gate = { active: false, rev: 0, listeners: new Set() };
  function subscribeGate(cb) { gate.listeners.add(cb); return function () { gate.listeners.delete(cb); }; }
  function getGateSnap() { return gate.rev; }
  function setGate(on) {
    parentalActive = !!on;
    gate.active = parentalActive;
    gate.rev++;
    gate.listeners.forEach(function (l) { l(); });
  }

  function cfg(orbit) {
    var c = (orbit.config() && orbit.config().callerid) || {};
    return {
      group: String(c.group || DEFAULT_GROUP).toLowerCase(),
      modes: String(c.modes || DEFAULT_MODES),
      autoMode: c.autoMode !== false,
    };
  }

  function pick(orbit, table) {
    if (orbit.i18n && orbit.i18n.pick) return orbit.i18n.pick(table);
    return table.fr || table.en || '';
  }

  function fold(s) {
    return String(s || '').replace(/^[@+%~&]/, '').trim().toLowerCase();
  }

  function isParental(orbit) {
    var group = cfg(orbit).group;
    return myGroupsText.toLowerCase().indexOf(group) > -1;
  }

  function applyParentalModes(orbit) {
    var c = cfg(orbit);
    if (!c.autoMode) return;
    var nick = orbit.state.nick();
    if (!nick) return;
    var modes = c.modes;
    if (!modes || modes.charAt(0) !== '+' && modes.charAt(0) !== '-') modes = '+' + modes;
    try {
      orbit.irc.send('MODE ' + nick + ' ' + modes);
      modesApplied = true;
    } catch (e) { /* ignore */ }
  }

  function requestWhois(orbit) {
    var me = orbit.state.nick();
    if (!me) return;
    try { orbit.irc.send('WHOIS ' + me); } catch (e) { /* ignore */ }
  }

  function sendAccept(orbit, nick, add) {
    var n = String(nick || '').trim();
    if (!n) return false;
    if (n.charAt(0) === '+' || n.charAt(0) === '-') n = n.slice(1);
    if (!n) return false;
    try {
      orbit.irc.send('ACCEPT ' + (add ? '+' : '-') + n);
      return true;
    } catch (e) {
      return false;
    }
  }

  function refreshAcceptList(orbit) {
    beginAcceptList();
    try { orbit.irc.send('ACCEPT *'); } catch (e) { endAcceptList(); }
  }

  function activateIfParental(orbit, log) {
    if (!isParental(orbit)) {
      if (parentalActive) setGate(false);
      return;
    }
    if (!parentalActive) {
      setGate(true);
      log('callerid: contrôle parental actif');
    }
    if (!modesApplied) applyParentalModes(orbit);
  }

  function injectStyles() {
    if (document.getElementById('orbit-callerid-css')) return;
    var style = document.createElement('style');
    style.id = 'orbit-callerid-css';
    style.textContent = [
      '.ocid-banner{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.55rem .85rem;margin:0;border-bottom:1px solid var(--border,rgba(0,0,0,.1));background:color-mix(in srgb,#0ea5e9 12%,var(--bg,#fff));color:var(--ink,inherit);font-size:.92rem}',
      '.ocid-banner__txt{flex:1 1 12rem;min-width:0}',
      '.ocid-banner__nick{font-weight:600}',
      '.ocid-banner__btn{appearance:none;border:1px solid var(--border,rgba(0,0,0,.15));background:var(--bg,#fff);color:inherit;border-radius:6px;padding:.28rem .7rem;cursor:pointer;font:inherit}',
      '.ocid-banner__btn--ok{background:#0ea5e9;border-color:#0ea5e9;color:#fff}',
      '.ocid-banner__btn:hover{filter:brightness(1.05)}',
      '.ocid-modal{display:flex;flex-direction:column;gap:.75rem;min-width:min(22rem,92vw);max-width:28rem;padding:.25rem}',
      '.ocid-modal__row{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border,rgba(0,0,0,.08))}',
      '.ocid-modal__empty{opacity:.7;font-size:.92rem}',
      '.ocid-modal__actions{display:flex;gap:.5rem;flex-wrap:wrap}',
      '.ocid-modal input{flex:1 1 8rem;min-width:0;padding:.35rem .55rem;border:1px solid var(--border,rgba(0,0,0,.15));border-radius:6px;background:var(--bg,#fff);color:inherit;font:inherit}',
    ].join('');
    document.head.appendChild(style);
  }

  function ShieldIcon() {
    return h('svg', {
      viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
      stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M12 3 5 6.5v5.2c0 4.2 2.8 7.4 7 8.8 4.2-1.4 7-4.6 7-8.8V6.5L12 3z' })
    );
  }

  function RequestBanner(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    if (!gate.active) return null;
    var items = listPending();
    if (!items.length) return null;
    var req = items[0];
    return h('div', { className: 'ocid-banner', role: 'status' },
      h('span', { className: 'ocid-banner__txt' },
        h('span', { className: 'ocid-banner__nick' }, req.nick),
        ' ',
        pick(orbit, {
          fr: 'souhaite vous écrire en message privé.',
          en: 'wants to send you a private message.',
        })
      ),
      h('button', {
        type: 'button',
        className: 'ocid-banner__btn ocid-banner__btn--ok',
        onClick: function () {
          if (sendAccept(orbit, req.nick, true)) {
            setPending(req.nick, null);
            orbit.notify(
              pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, {
                fr: req.nick + ' peut maintenant vous écrire.',
                en: req.nick + ' can now message you.',
              })
            );
            refreshAcceptList(orbit);
          }
        },
      }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
      h('button', {
        type: 'button',
        className: 'ocid-banner__btn',
        onClick: function () { setPending(req.nick, null); },
      }, pick(orbit, { fr: 'Ignorer', en: 'Ignore' }))
    );
  }

  function openListModal(orbit) {
    if (typeof orbit.modal !== 'function') {
      refreshAcceptList(orbit);
      orbit.notify(
        pick(orbit, { fr: 'Liste blanche', en: 'Allow list' }),
        pick(orbit, {
          fr: 'Liste ACCEPT demandée (voir la fenêtre Status / réponses serveur).',
          en: 'ACCEPT list requested (see Status / server replies).',
        })
      );
      return;
    }
    refreshAcceptList(orbit);
    var close = orbit.modal(function () {
      return h(ListModalBody, {
        orbit: orbit,
        onClose: function () { if (typeof close === 'function') close(); },
      });
    }, {
      title: pick(orbit, { fr: 'Messages privés — liste blanche', en: 'Private messages — allow list' }),
      wide: false,
    });
  }

  function ListModalBody(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeAccept, getAcceptSnap, getAcceptSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    var [draft, setDraft] = useState('');
    var nicks = acceptList.nicks.slice();
    var pendingItems = listPending();

    return h('div', { className: 'ocid-modal' },
      h('p', { className: 'ocid-modal__empty' },
        pick(orbit, {
          fr: 'Seules les personnes acceptées peuvent vous écrire en privé (mode +g).',
          en: 'Only accepted people can private-message you (+g).',
        })
      ),
      pendingItems.length
        ? h('div', null,
          h('b', null, pick(orbit, { fr: 'Demandes en cours', en: 'Pending requests' })),
          pendingItems.map(function (req) {
            return h('div', { key: 'p-' + req.nick, className: 'ocid-modal__row' },
              h('span', null, req.nick),
              h('span', { className: 'ocid-modal__actions' },
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn ocid-banner__btn--ok',
                  onClick: function () {
                    sendAccept(orbit, req.nick, true);
                    setPending(req.nick, null);
                    refreshAcceptList(orbit);
                  },
                }, pick(orbit, { fr: 'Accepter', en: 'Accept' })),
                h('button', {
                  type: 'button',
                  className: 'ocid-banner__btn',
                  onClick: function () { setPending(req.nick, null); },
                }, pick(orbit, { fr: 'Ignorer', en: 'Ignore' }))
              )
            );
          })
        )
        : null,
      h('b', null, pick(orbit, { fr: 'Personnes acceptées', en: 'Accepted' })),
      acceptList.loading && !nicks.length
        ? h('p', { className: 'ocid-modal__empty' }, pick(orbit, { fr: 'Chargement…', en: 'Loading…' }))
        : null,
      !acceptList.loading && !nicks.length
        ? h('p', { className: 'ocid-modal__empty' }, pick(orbit, {
          fr: 'Aucune entrée pour l’instant.',
          en: 'No entries yet.',
        }))
        : null,
      nicks.map(function (nick) {
        return h('div', { key: nick, className: 'ocid-modal__row' },
          h('span', null, nick),
          h('button', {
            type: 'button',
            className: 'ocid-banner__btn',
            onClick: function () {
              sendAccept(orbit, nick, false);
              window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
            },
          }, pick(orbit, { fr: 'Retirer', en: 'Remove' }))
        );
      }),
      h('div', { className: 'ocid-modal__actions' },
        h('input', {
          type: 'text',
          value: draft,
          placeholder: pick(orbit, { fr: 'Pseudo à autoriser', en: 'Nick to allow' }),
          onChange: function (e) { setDraft(e.target.value); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' && draft.trim()) {
              sendAccept(orbit, draft.trim(), true);
              setDraft('');
              window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
            }
          },
        }),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn ocid-banner__btn--ok',
          onClick: function () {
            if (!draft.trim()) return;
            sendAccept(orbit, draft.trim(), true);
            setDraft('');
            window.setTimeout(function () { refreshAcceptList(orbit); }, 250);
          },
        }, pick(orbit, { fr: 'Ajouter', en: 'Add' })),
        h('button', {
          type: 'button',
          className: 'ocid-banner__btn',
          onClick: function () { refreshAcceptList(orbit); },
        }, pick(orbit, { fr: 'Actualiser', en: 'Refresh' }))
      )
    );
  }

  function MoreMenuItem(props) {
    var orbit = props.orbit;
    useSyncExternalStore(subscribeGate, getGateSnap, getGateSnap);
    useSyncExternalStore(subscribePending, getPendingSnap, getPendingSnap);
    if (!gate.active) return null;
    var n = listPending().length;
    var label = pick(orbit, { fr: 'Messages privés', en: 'Private messages' });
    if (n) label += ' (' + n + ')';
    return h('button', {
      type: 'button',
      className: 'nmenu__item',
      role: 'menuitem',
      onClick: function () { openListModal(orbit); },
    },
      h('span', { className: 'nmenu__ic', 'aria-hidden': true }, h(ShieldIcon)),
      h('span', { className: 'nmenu__txt' }, h('b', null, label))
    );
  }

  Orbit.plugin('orbit-callerid', function (orbit, log) {
    injectStyles();

    requestWhois(orbit);
    orbit.on('connected', function () {
      myGroupsText = '';
      modesApplied = false;
      setGate(false);
      requestWhois(orbit);
    });

    orbit.on('raw', function (msg) {
      var cmd = String(msg.command || '');
      var params = msg.params || [];
      var me = orbit.state.nick() || '';

      if (cmd === '320' && params[1] && fold(params[1]) === fold(me)) {
        myGroupsText = (myGroupsText + ' ' + (params[2] || '')).trim();
      }
      if (cmd === '318' && params[1] && fold(params[1]) === fold(me)) {
        activateIfParental(orbit, log);
        if (parentalActive) refreshAcceptList(orbit);
      }

      // RPL_UMODEGMSG — someone wants to PM you while you have +g
      if (cmd === '718') {
        var fromNick = params[1] || '';
        var fromHost = params[2] || '';
        if (!fromNick) return;
        if (!parentalActive && isParental(orbit)) activateIfParental(orbit, log);
        if (!parentalActive && !isParental(orbit)) return;
        setPending(fromNick, { nick: fromNick, host: fromHost, ts: Date.now() });
        orbit.notify(
          pick(orbit, { fr: 'Demande de message', en: 'Message request' }),
          pick(orbit, {
            fr: fromNick + ' souhaite vous écrire. Acceptez depuis la bannière ou le menu.',
            en: fromNick + ' wants to message you. Accept from the banner or menu.',
          })
        );
        return;
      }

      if (cmd === '281') {
        // RPL_ACCEPTLIST: <me> <nick> (Orbit: params[0]=me, params[1]=accepted)
        if (acceptList.loading) {
          var accepted = params.length >= 2 ? params[1] : params[0];
          if (accepted && (params.length < 2 || fold(accepted) !== fold(me))) {
            pushAcceptNick(accepted);
          }
        }
        return;
      }
      if (cmd === '282') {
        endAcceptList();
        return;
      }

      // Re-apply modes if the server (or user) clears parental flags while gated
      if (cmd === 'MODE' && parentalActive && cfg(orbit).autoMode) {
        var target = params[0] || '';
        if (fold(target) === fold(me)) {
          var modeStr = String(params[1] || '');
          if (modeStr.indexOf('-') > -1 && /[gixIRcRw]/.test(modeStr)) {
            window.setTimeout(function () {
              modesApplied = false;
              applyParentalModes(orbit);
            }, 400);
          }
        }
      }
    });

    orbit.addUi('overlay', function () { return h(RequestBanner, { orbit: orbit }); });
    orbit.addUi('topbar_more_item', function () { return h(MoreMenuItem, { orbit: orbit }); });

    if (typeof orbit.addCommand === 'function') {
      orbit.addCommand('accepter', {
        help: pick(orbit, {
          fr: 'Autoriser un pseudo à vous écrire (ACCEPT +nick)',
          en: 'Allow a nick to message you (ACCEPT +nick)',
        }),
        run: function (arg) {
          var nick = String(arg || '').trim().split(/\s+/)[0];
          if (!nick) {
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: 'Usage : /accepter <pseudo>', en: 'Usage: /accepter <nick>' }));
            return;
          }
          if (sendAccept(orbit, nick, true)) {
            setPending(nick, null);
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: nick + ' accepté.', en: nick + ' accepted.' }));
            refreshAcceptList(orbit);
          }
        },
      });
      orbit.addCommand('refuser', {
        help: pick(orbit, {
          fr: 'Retirer un pseudo de la liste ACCEPT',
          en: 'Remove a nick from the ACCEPT list',
        }),
        run: function (arg) {
          var nick = String(arg || '').trim().split(/\s+/)[0];
          if (!nick) {
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: 'Usage : /refuser <pseudo>', en: 'Usage: /refuser <nick>' }));
            return;
          }
          if (sendAccept(orbit, nick, false)) {
            setPending(nick, null);
            orbit.notify(pick(orbit, { fr: 'Messages privés', en: 'Private messages' }),
              pick(orbit, { fr: nick + ' retiré.', en: nick + ' removed.' }));
            refreshAcceptList(orbit);
          }
        },
      });
      orbit.addCommand('listeaccept', {
        help: pick(orbit, {
          fr: 'Afficher la liste blanche des messages privés',
          en: 'Show the private-message allow list',
        }),
        run: function () { openListModal(orbit); },
      });
    }

    log('orbit-callerid ready');
  });
})();
