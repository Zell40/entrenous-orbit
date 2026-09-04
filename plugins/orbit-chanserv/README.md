# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône **#** est dans la **barre du salon** (bureau) et dans le menu **⋮** (mobile).
Elle n’apparaît que si tu es **identifié** NickServ, et :

- le salon **n’est pas enregistré** → bouton pour l’enregistrer, ou
- tu as un **accès ChanServ** (VOP ou plus) → commandes filtrées.

INFO / STATUS / BOTLIST passent par **JSON-RPC Anope** (`chanserv-rpc.php`, même API que wp_anope_sync). Aucun MP IRC pour ces lectures.

Les réponses IRC (PRIVMSG ou NOTICE) aux commandes du panneau (OP, KICK, …) sont masquées du tchat et résumées dans le panneau.

## Commandes (v1)

| Accès | Actions |
| --- | --- |
| Identifié, salon libre | Enregistrer le salon |
| VOP+ | Voice / Devoice |
| HOP+ | Halfop / Dehalfop (si le réseau a `%`) |
| AOP+ | Op / Deop, Kick, Ban, Topic, Dire / Action du bot |
| SOP / fondateur | Assigner / retirer le bot |

Hors v1 : ACCESS, AKICK, SET, DROP.

## Config

```json
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=8"]
```

Créer une fois le fichier **sur le webroot** (pas seulement dans le clone git) :

`/home/chat/irc/webchat-new/plugins/third/orbit-chanserv/chanserv-rpc.local.php`

Même URL + jeton que `WP_ANOPE_RPC_URL` / `WP_ANOPE_RPC_TOKEN`. Variables attendues : `$ANOPE_RPC_URL` et `$ANOPE_RPC_TOKEN`. `deploy.sh` ne l’écrase pas ; s’il n’existe que dans le clone sources, le deploy le copie vers le webroot.
