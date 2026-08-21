# orbit-callerid

UX Orbit pour le **contrôle parental** InspIRCd : mode callerid `+g` (liste blanche des messages privés) et modes associés.

## À qui s’adresse

Actif uniquement si le compte appartient au security group **`controle-parentale`** (détecté via WHOIS numérique `320`), déjà déclaré dans `config.json` → `securityGroups`.

## Comportement

1. Après détection du groupe, envoie `MODE <nick> +ixIgcRw` (configurable) :
   - `i` invisible  
   - `x` host chiffré  
   - `I` salons cachés au WHOIS  
   - `g` liste blanche MP (callerid)  
   - `c` salon en commun pour MP  
   - `R` utilisateur enregistré pour MP  
   - `w` reçoit les WALLOPS  
2. Quand quelqu’un tente un MP : numérique **718** → bannière **Accepter** / **Ignorer**.
3. **Accepter** envoie `ACCEPT +nick` ; **Ignorer** ferme la demande (le blocage `+g` reste).
4. Menu ⋮ → **Messages privés** : liste blanche, ajouts / retraits.
5. Commandes slash :
   - `/accepter <pseudo>`
   - `/refuser <pseudo>`
   - `/listeaccept`

## Config (`config.json`)

```json
{
  "callerid": {
    "group": "controle-parentale",
    "modes": "+ixIgcRw",
    "autoMode": true
  },
  "plugins": [
    "/app/plugins/third/orbit-callerid/orbit-callerid.js?v=1"
  ]
}
```

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `group` | `controle-parentale` | Groupe WHOIS qui active le plugin |
| `modes` | `+ixIgcRw` | Modes appliqués automatiquement |
| `autoMode` | `true` | Si `false`, n’envoie pas `MODE` (seulement l’UI ACCEPT) |

Côté serveur, charger les modules InspIRCd correspondants (`callerid`, `commonchans`, `cloaking` / host, `hidechans`, etc.).

## Déploiement

Inclus dans `deploy.sh` (copie vers `plugins/third/orbit-callerid/`). Incrémenter `?v=` dans `config.json` après modification du JS.
