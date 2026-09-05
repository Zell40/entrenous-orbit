# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône **#** change selon le salon : **+** si non enregistré, **cadenas** si enregistré sans accès, **coche** (couleur accent) si tu as un accès ChanServ.

Le panneau du haut ne gère que le **salon** (onglets Salon / Sujet / Bot).
Kick, ban, op, voix, etc. sont dans le **menu de la liste** (clic sur un pseudo) :
onglet **Commandes &lt;bot du salon&gt;**, filtré selon l’accès ChanServ.

INFO / STATUS / BOTLIST passent par **JSON-RPC Anope** (`chanserv-rpc.php`, même API que wp_anope_sync). Aucun MP IRC pour ces lectures.

Les réponses IRC (PRIVMSG ou NOTICE) aux commandes sont masquées du tchat.

## Commandes (v1)

| Accès | Où | Actions |
| --- | --- | --- |
| Identifié, salon libre | Panneau | Enregistrer le salon |
| VOP+ | Liste (Commandes bot) | Voice / Devoice |
| HOP+ | Liste (Commandes bot) | Halfop / Dehalfop (si le réseau a `%`) |
| AOP+ | Liste (Commandes bot) | Op / Deop, Kick, Ban |
| AOP+ | Panneau → Sujet | Changer le sujet |
| AOP+ | Panneau → Bot | Dire / Action du bot |
| SOP / fondateur | Panneau → Bot | Assigner / retirer le bot |

Hors v1 : ACCESS, AKICK, SET, DROP.

## Config

```json
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=17"]
```

Créer une fois le fichier **sur le webroot** (pas seulement dans le clone git) :

`/home/chat/irc/webchat-new/plugins/third/orbit-chanserv/chanserv-rpc.local.php`

Même URL + jeton que `WP_ANOPE_RPC_URL` / `WP_ANOPE_RPC_TOKEN`. Variables attendues : `$ANOPE_RPC_URL` et `$ANOPE_RPC_TOKEN`. `deploy.sh` ne l’écrase pas ; s’il n’existe que dans le clone sources, le deploy le copie vers le webroot.
