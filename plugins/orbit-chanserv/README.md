# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône **#** change selon le salon : **+** si non enregistré, **cadenas** si enregistré sans accès, **coche** (couleur accent) si tu as un accès ChanServ.

Le panneau du haut : **Info**, **Topic**, **Modes**, **Bans**, **Accès**, **SET**, **Divers**.
Kick, ban, op, voix, etc. sont dans le **menu de la liste** (clic droit) :
**Commandes &lt;bot&gt;** (nom du bot assigné, sinon ChanServ).

- **Modes du salon** (`+v` / `+h` / `+o`…) : menu natif, sans créer d’accès Anope.
- **Accès Anope** (VOP / HOP / AOP / SOP / QOP) : sous-menu *Gérer les accès* — liste permanente.
- ChanServ `VOICE` / `OP` n’apparaît que si tu as un accès services sans être oppé sur le salon.

**Lectures** (INFO / STATUS / listes VOP–SOP) : JSON-RPC Anope (`chanserv-rpc.php`).
**Actions** (SET, TOPIC, MODE, KICK, …) : IRC `PRIVMSG` vers ChanServ / BotServ. Syntaxe Anope 2 : `SET option canal paramètres`.
Les réponses IRC sont masquées du tchat et affichées dans le bandeau du panneau (pas dans Status).

## Commandes (v1)

| Accès | Où | Actions |
| --- | --- | --- |
| Identifié, salon libre | Panneau | Enregistrer le salon |
| VOP+ | Liste (Accès Anope) | Accès Voice (VOP) |
| HOP+ | Liste (Accès Anope) | Accès HalfOp (HOP), si le réseau a `%` |
| AOP+ | Liste (Accès Anope / Modération) | Accès VOP/HOP, Kick, Ban, AKICK |
| SOP+ | Liste (Accès Anope) | Accès AOP/SOP, Admin (SOP) |
| Fondateur | Liste (Accès Anope) | Accès QOP (propriétaire) |
| AOP+ | Panneau → Topic | Topic, lock, keep |
| AOP+ | Panneau → Modes / Divers | MODE SET, LOCK ADD/DEL, MODE CLEAR, invite, status, messages d’accueil, SAY / ACT / INFO BotServ, YTSTATS |
| HOP+ | Panneau → Bans | UNBAN |
| AOP+ | Panneau → Bans | AKICK, BAN, MODE CLEAR bans |
| SOP+ | Panneau → Bans | Type de Ban (BANTYPE) |
| SOP+ | Panneau → Accès / SET | Liste ACCESS complète (`LIST * ALL`), ajout XOP (QOP fondateur), SET |
| SOP+ | Panneau → Set → Autres | Commandes fantaisies (FANTASY) |
| SOP+ | Panneau → Set → Modération | Kick automatique, BADWORDS |
| Fondateur | Panneau → Divers | Suppression du salon (popup Orbit + code ChanServ) |

L’assignation de bot (`ASSIGN` / `UNASSIGN` / `BOTLIST`) n’est pas dans le panneau : seuls les opérateurs IRC l’utilisent en ligne de commande.

Dans le tchat : `/cs` et `/chanserv` envoient à ChanServ (comme `/msg ChanServ`) ; `/bs` et `/botserv` envoient à BotServ (comme `/msg BotServ`). SAY / ACT : `SAY #salon message` / `ACT #salon message`.

Hors v1 : FLAGS.

## Config

```json
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=73"],
"chanserv": {
  "kickReason": "Vous n'êtes pas le bienvenu sur ce salon"
}
```

Kick / ban / kickban : le motif est facultatif. S’il est vide, `chanserv.kickReason` est envoyé (menu liste native + Commandes bot).

Créer une fois le fichier **sur le webroot** (pas seulement dans le clone git) :

`/home/chat/irc/webchat-new/plugins/third/orbit-chanserv/chanserv-rpc.local.php`

Même URL + jeton que `WP_ANOPE_RPC_URL` / `WP_ANOPE_RPC_TOKEN`. Variables attendues : `$ANOPE_RPC_URL` et `$ANOPE_RPC_TOKEN`. `deploy.sh` ne l’écrase pas ; s’il n’existe que dans le clone sources, le deploy le copie vers le webroot.
