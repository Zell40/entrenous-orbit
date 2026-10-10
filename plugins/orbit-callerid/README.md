# orbit-callerid

UX Orbit pour le **contrôle parental** et le **filtre MP callerid (`+g`)** — deux notions distinctes.

## Ne pas mélanger

| Notion | Définition | UI |
| --- | --- | --- |
| **Contrôle parental** | Security group `controle-parentale`, **ou** le *paquet complet* de modes configuré (`+ixIgcRw`) | Badge « Contrôle parental actif » au-dessus d’Accueil ; `autoMode` peut (re)poser le paquet |
| **Callerid / +g** | Mode `+g` seul (ou demande **718**) — n’importe qui peut l’activer | Bannière / popup ACCEPT, liste blanche, avertissements demandeur |

Un utilisateur qui active seulement `+g` (ou `+i`, etc. un par un) **n’est pas** traité comme « contrôle parental ».

## Accepter / refuser

| Action | Effet |
| --- | --- |
| **Accepter** | `ACCEPT +nick`, ouvre le PV, message local (liste blanche + icône bouclier cliquable), envoie un message d’acceptation (le PRIVMSG d’origine n’a jamais traversé `+g` ; le demandeur Orbit le renvoie si possible) |
| **Refuser** | Pas d’ouverture de PV ; NOTICE de refus (affichée côté Orbit dans **Status**, pas dans le MP — bandeau local) ; **liste locale de refus** + `SILENCE` (si module présent). Les bloqués apparaissent dans la liste blanche → **Débloquer**. Bandeau aussi pour celui qui bloque (« Vous avez bloqué … »). |

Côté demandeur : textes neutres (jamais « contrôle parental »).

## Affichage

1. **Paramètres → Modes & confidentialité** : même ligne que les autres umodes (`+g`, libellé, interrupteur ; verrouillé sous contrôle parental). Les autres modes du paquet (`+ixIgcRw`) s’affichent **actifs et non désactivables**. `+x` (hôte masqué) n’est jamais désactivable.
2. **Au-dessus d’Accueil** : pastille parentale (marge haute) — groupe ou paquet complet uniquement.
3. **Liste blanche** : fermée par défaut ; l’icône bouclier ouvre un **buffer local** « Liste blanche » (indépendant du salon : topbar sans modes, pas de liste de membres). L’onglet bouclier apparaît alors dans la colonne de gauche.
4. **Haut du tchat** : bannière bleue + **popup** sur **718** (filtre MP).
5. **Côté demandeur** : bandeau ambre **neutre** (« n’accepte les MP que sur autorisation ») — **jamais** « contrôle parental » (ne pas exposer un compte protégé / mineur).
6. Menu **⋮** (mobile) → **Liste blanche MP**.
7. `/accepter` `/refuser` `/listeaccept`.
8. **Join salon officiel** (hors salons sûrs) : popup large (bureau) + message salon visible (fond bleu, triangle rouge) rédigés pour ados — adultes possibles, âge profil non fiable, pas d’infos perso. Case « Ne plus afficher » ; réactivation dans **Paramètres → Apparence**.
9. **Icône enveloppe (+D)** : gris comme les autres icônes ; **rouge** si les MP sont coupés (sans fond bleu). Popup d’aide à l’activation (bouton « J’ai compris » + case « Ne plus afficher »).

## Config

```json
{
  "callerid": {
    "group": "controle-parentale",
    "modes": "+ixIgcRw",
    "autoMode": true,
    "warnOfficialJoins": true,
    "safeChannels": ["#EntreJeunes.chat"],
    "officialSuffix": ".chat"
  },
  "plugins": [
    "/app/plugins/third/orbit-callerid/orbit-callerid.js?v=31"
  ]
}
```

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `group` | `controle-parentale` | Groupe WHOIS → parental |
| `modes` | `+ixIgcRw` | Paquet parental (tous les caractères requis pour le badge si pas de groupe visible) |
| `autoMode` | `true` | Repose le paquet **uniquement** si parental actif |
| `warnOfficialJoins` | `true` | Avertir au join des salons officiels / réseau |
| `safeChannels` | `["#EntreJeunes.chat"]` | Salons sans avertissement (espace jeunes) |
| `officialSuffix` | `.chat` | Salons réseau `*suffix` : avertissement immédiat (hors `safeChannels`), sans attendre ChanServ |

## Déploiement

`deploy.sh` → `plugins/third/orbit-callerid/`. Client Orbit : bannières en colonne centrale + `sidebar_item` au-dessus d’Accueil. Incrémenter `?v=` après modif JS.
