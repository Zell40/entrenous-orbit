# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône **#** change selon le salon : **+** si non enregistré, **cadenas** si enregistré sans accès, **coche** (couleur accent) si tu as un accès ChanServ.

Le panneau du haut : **Info**, **Topic**, **Modes**, **Accès**, **SET**, **Divers** (une seule ligne ; le panneau s’élargit).
Kick, ban, op, voix, etc. sont dans le **menu de la liste** (clic droit) :
**Commandes ChanServ** (ou le bot du salon), filtré selon l’accès ChanServ.

**Lectures** (INFO / STATUS / BOTLIST / listes VOP–SOP) : JSON-RPC Anope (`chanserv-rpc.php`).
**Actions** (SET, TOPIC, MODE, KICK, …) : IRC `PRIVMSG` vers ChanServ / BotServ. Syntaxe Anope 2 : `SET option canal paramètres`.
Les réponses IRC sont masquées du tchat et affichées dans le bandeau du panneau (pas dans Status).

## Commandes (v1)

| Accès | Où | Actions |
| --- | --- | --- |
| Identifié, salon libre | Panneau | Enregistrer le salon |
| VOP+ | Liste (Commandes bot) | Voice / Devoice |
| HOP+ | Liste (Commandes bot) | Halfop / Dehalfop (si le réseau a `%`) |
| AOP+ | Liste (Commandes bot) | Op / Deop, Kick, Ban, accès VOP/HOP |
| SOP+ | Liste (Commandes bot) | Admin (`&`), accès AOP/SOP |
| Fondateur | Liste (Commandes bot) | Fondateur (`~`) |
| AOP+ | Panneau → Topic | Topic, lock, keep |
| AOP+ | Panneau → Modes / Divers | MODE SET, LOCK ADD/DEL, invite, status, entrymsg |
| SOP+ | Panneau → Accès / SET | Liste XOP visible, ajout/retrait, SET |
| Fondateur | Panneau → Divers | Suppression du salon (popup Orbit + code ChanServ) |

Hors v1 : AKICK, FLAGS.

## Config

```json
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=33"],
"chanserv": {
  "kickReason": "Vous n'êtes pas le bienvenu sur ce salon"
}
```

Kick / ban / kickban : le motif est facultatif. S’il est vide, `chanserv.kickReason` est envoyé (menu liste native + Commandes bot).

Créer une fois le fichier **sur le webroot** (pas seulement dans le clone git) :

`/home/chat/irc/webchat-new/plugins/third/orbit-chanserv/chanserv-rpc.local.php`

Même URL + jeton que `WP_ANOPE_RPC_URL` / `WP_ANOPE_RPC_TOKEN`. Variables attendues : `$ANOPE_RPC_URL` et `$ANOPE_RPC_TOKEN`. `deploy.sh` ne l’écrase pas ; s’il n’existe que dans le clone sources, le deploy le copie vers le webroot.
