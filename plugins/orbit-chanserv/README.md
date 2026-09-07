# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône **#** change selon le salon : **+** si non enregistré, **cadenas** si enregistré sans accès, **coche** (couleur accent) si tu as un accès ChanServ.

Le panneau du haut : **Info**, **Topic**, **Modes**, **Accès**, **SET**, **Divers**.
Kick, ban, op, voix, etc. sont dans le **menu de la liste** (clic droit) :
**Commandes &lt;bot&gt;** (nom du bot assigné, sinon ChanServ).

**Lectures** (INFO / STATUS / listes VOP–SOP) : JSON-RPC Anope (`chanserv-rpc.php`).
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
| AOP+ | Panneau → Modes / Divers | MODE SET, LOCK ADD/DEL, invite, status, messages d’accueil, SAY / ACT / INFO BotServ, YTSTATS |
| SOP+ | Panneau → Accès / SET | Liste ACCESS complète (`LIST * ALL`), ajout XOP, SET |
| SOP+ | Panneau → SET → Autres | FANTASY (ON/OFF) |
| SOP+ | Panneau → SET → Modération | Kickers BotServ, BADWORDS |
| Fondateur | Panneau → Divers | Suppression du salon (popup Orbit + code ChanServ) |

L’assignation de bot (`ASSIGN` / `UNASSIGN` / `BOTLIST`) n’est pas dans le panneau : seuls les opérateurs IRC l’utilisent en ligne de commande.

Dans le tchat : `/cs` et `/chanserv` envoient à ChanServ (comme `/msg ChanServ`) ; `/bs` et `/botserv` envoient à BotServ (comme `/msg BotServ`). SAY / ACT : `SAY #salon message` / `ACT #salon message`.

Hors v1 : AKICK, FLAGS.

## Config

```json
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=54"],
"chanserv": {
  "kickReason": "Vous n'êtes pas le bienvenu sur ce salon"
}
```

Kick / ban / kickban : le motif est facultatif. S’il est vide, `chanserv.kickReason` est envoyé (menu liste native + Commandes bot).

Créer une fois le fichier **sur le webroot** (pas seulement dans le clone git) :

`/home/chat/irc/webchat-new/plugins/third/orbit-chanserv/chanserv-rpc.local.php`

Même URL + jeton que `WP_ANOPE_RPC_URL` / `WP_ANOPE_RPC_TOKEN`. Variables attendues : `$ANOPE_RPC_URL` et `$ANOPE_RPC_TOKEN`. `deploy.sh` ne l’écrase pas ; s’il n’existe que dans le clone sources, le deploy le copie vers le webroot.
