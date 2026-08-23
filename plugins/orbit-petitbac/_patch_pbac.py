# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(r"C:\Users\famil\entrenous-orbit\plugins\orbit-petitbac\orbit-petitbac.js")
s = p.read_text(encoding="utf-8")

def replace_once(src, old, new, label):
    n = src.count(old)
    if n != 1:
        raise SystemExit("%s: found %d (expected 1)" % (label, n))
    return src.replace(old, new, 1)

old_badge = """    var headBadge = game.round && game.totalRounds
      ? ('Manche ' + game.round + '/' + game.totalRounds)
      : phaseLabel(phase, game.countdown);
    if (isGameEnd) {
      headBadge = pick({ fr: 'Partie terminée', en: 'Game over' });
    } else if (isRoundEnd) {
      headBadge = pick({ fr: 'Fin de manche', en: 'Round over' });
    }
    if (isLive && game.phase === 'paused') {
"""
new_badge = """    var headBadge = phaseLabel(phase, game.countdown);
    if (isGameEnd) {
      headBadge = pick({ fr: 'Partie terminée', en: 'Game over' });
    } else if (isRoundEnd) {
      headBadge = pick({ fr: 'Fin de manche', en: 'Round over' });
    } else if (game.round && game.totalRounds && (isLive || isPrep)) {
      headBadge = '';
    }
    if (isLive && game.phase === 'paused') {
"""
s = replace_once(s, old_badge, new_badge, "headBadge")

old_mode = """      var modeLbl = root.querySelector('[data-opbac-head-mode-lbl]');
      if (modeLbl) modeLbl.textContent = modeBadge || '';
      var modeWrap = root.querySelector('[data-opbac-mode-wrap]');
"""
new_mode = """      var modeIco = root.querySelector('[data-opbac-head-mode-ico]');
      if (modeIco) modeIco.textContent = modeBadgeIcon(game.mode);
      var modeBtn = root.querySelector('[data-act="mode-menu"]');
      if (modeBtn && modeBadge) {
        modeBtn.setAttribute('aria-label', modeBadge);
        modeBtn.setAttribute('title', modeBadge);
      }
      var modeWrap = root.querySelector('[data-opbac-mode-wrap]');
"""
s = replace_once(s, old_mode, new_mode, "mode incremental")

old_sig = """      JSON.stringify(game.topGlobal || []),
      (game.endNotes || []).join('\\n'),
"""
new_sig = """      JSON.stringify(game.topGlobal || []),
      JSON.stringify(game.serverRecords || []),
"""
s = replace_once(s, old_sig, new_sig, "endScreenSignature")

old_psig = """        '|' + JSON.stringify(game.roundScores || {}) +
        '|' + (game.endNotes || []).join('\\n');
"""
new_psig = """        '|' + JSON.stringify(game.roundScores || {}) +
        '|' + JSON.stringify(game.serverRecords || []) +
        '|' + JSON.stringify(game.topGlobal || []);
"""
s = replace_once(s, old_psig, new_psig, "panelSignature")

old_react = """                phase === 'game_end'
                  ? pick({ fr: 'Classement final', en: 'Final ranking' })"""
new_react = """                phase === 'game_end'
                  ? pick({ fr: 'Classement final de la partie', en: 'Final game ranking' })"""
s = replace_once(s, old_react, new_react, "react ranking")

p.write_text(s, encoding="utf-8")
print("plugin ok")

bp = Path(r"C:\Users\famil\Bac\plugins\PetitBac\local\game.py")
b = bp.read_text(encoding="utf-8")
old_bot = """            if wsp and wsp_user:
                irc.queueMsg(ircmsgs.privmsg(channel,
                    f"⚡ Vitesse hebdo : {wsp_user} — {wsp:.2f} sec"))
                    
            # --- TAG IRCv3 : fin de partie ---
"""
new_bot = """            if wsp and wsp_user:
                irc.queueMsg(ircmsgs.privmsg(channel,
                    f"⚡ Vitesse hebdo : {wsp_user} — {wsp:.2f} sec"))

            rec_payload = {}
            if players:
                rec_payload["score"] = "%s:%s" % (best_total[0], int(best_total[1].get("total_points", 0) or 0))
                rec_payload["combos"] = "%s:%s" % (best_fc[0], int(best_fc[1].get("full_combos", 0) or 0))
                rec_payload["active"] = "%s:%s" % (best_rounds[0], int(best_rounds[1].get("rounds_played", 0) or 0))
            if best_speed and best_speed_user:
                rec_payload["speed"] = "%s:%.2f" % (best_speed_user, best_speed)
            if ws.get("user"):
                rec_payload["wscore"] = "%s:%s" % (ws["user"], ws.get("points", 0))
            if wfc.get("user"):
                rec_payload["wcombo"] = "%s:%s" % (wfc["user"], wfc.get("count", 0))
            if wsp and wsp_user:
                rec_payload["wspeed"] = "%s:%.2f" % (wsp_user, wsp)
            if rec_payload:
                self._send_event(irc, channel, "server_records", **rec_payload)

            # --- TAG IRCv3 : fin de partie ---
"""
if old_bot not in b:
    raise SystemExit("bot block not found")
bp.write_text(b.replace(old_bot, new_bot, 1), encoding="utf-8")
print("bot ok")
