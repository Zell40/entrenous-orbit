# orbit-chanserv

Panneau **ChanServ / BotServ** pour le salon actif (Anope).

L’icône (bouclier) est dans la **barre du salon** (bureau) et dans le menu **⋮** (mobile).
Elle n’apparaît que si tu es **identifié** NickServ, et :

- le salon **n’est pas enregistré** → bouton pour l’enregistrer, ou
- tu as un **accès ChanServ** (VOP ou plus) → commandes filtrées.

Les notices INFO / STATUS / BOTLIST liées au panneau sont masquées du tchat et résumées dans le panneau.

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
"plugins": ["/app/plugins/third/orbit-chanserv/orbit-chanserv.js?v=1"]
```
