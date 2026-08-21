# orbit-callerid

UX Orbit pour le **contrôle parental** et le **filtre MP callerid (`+g`)** — deux notions distinctes.

## Ne pas mélanger

| Notion | Définition | UI |
| --- | --- | --- |
| **Contrôle parental** | Security group `controle-parentale`, **ou** le *paquet complet* de modes configuré (`+ixIgcRw`) | Badge « Contrôle parental actif » au-dessus d’Accueil ; `autoMode` peut (re)poser le paquet |
| **Callerid / +g** | Mode `+g` seul (ou demande **718**) — n’importe qui peut l’activer | Bannière / popup ACCEPT, liste blanche, avertissements demandeur |

Un utilisateur qui active seulement `+g` (ou `+i`, etc. un par un) **n’est pas** traité comme « contrôle parental ».

## Affichage

1. **Au-dessus d’Accueil** : pastille parentale (marge haute) — groupe ou paquet complet uniquement.
2. **Liste blanche** : fermée par défaut ; l’onglet n’apparaît dans la colonne **que** lorsque la vue est ouverte via l’**icône bouclier** (⋮ sur mobile).
3. **Haut du tchat** : bannière bleue + **popup** sur **718** (filtre MP).
4. **Côté demandeur** : bandeau ambre **neutre** (« n’accepte les MP que sur autorisation ») — **jamais** « contrôle parental » (ne pas exposer un compte protégé / mineur).
5. Menu **⋮** (mobile) → **Liste blanche MP**.
6. `/accepter` `/refuser` `/listeaccept`.

## Config

```json
{
  "callerid": {
    "group": "controle-parentale",
    "modes": "+ixIgcRw",
    "autoMode": true
  },
  "plugins": [
    "/app/plugins/third/orbit-callerid/orbit-callerid.js?v=8"
  ]
}
```

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `group` | `controle-parentale` | Groupe WHOIS → parental |
| `modes` | `+ixIgcRw` | Paquet parental (tous les caractères requis pour le badge si pas de groupe visible) |
| `autoMode` | `true` | Repose le paquet **uniquement** si parental actif |

## Déploiement

`deploy.sh` → `plugins/third/orbit-callerid/`. Client Orbit : bannières en colonne centrale + `sidebar_item` au-dessus d’Accueil. Incrémenter `?v=` après modif JS.
