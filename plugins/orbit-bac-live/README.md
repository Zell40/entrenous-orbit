# orbit-bac-live

**Tableau live** pour le Petit Bac sur EntreNous — complément de `orbit-petitbac`.

Pendant une manche, affiche une grille **joueurs × catégories** qui se remplit en temps réel quand le bot valide les mots. Idéal pour suivre la course, copier un récap Markdown, ou voir qui a complété sa grille (🔥).

## Fonctionnalités

- Grille live des réponses validées (+1 / +2 points)
- Classement par points de manche
- Stats personnelles persistantes (mots, points, grilles complètes)
- Bouton **Copier le récap** (Markdown)
- Toggle via bouton 📊 ou `/bacboard`

## Prérequis

- Orbit avec `on('raw')`
- Salon `#Baccalaureat.chat` (ou config `bacLive.channels`)
- Fonctionne avec le bot Bac sans TAGMSG (parse les PRIVMSG)

## Installation

```json
"bacLive": {
  "channels": ["#Baccalaureat.chat"],
  "defaultOpen": true,
  "maxPlayers": 14
},
"plugins": [
  ".../orbit-petitbac/orbit-petitbac.js?v=6",
  ".../orbit-bac-live/orbit-bac-live.js?v=1"
]
```

Le panneau s’affiche sous le panneau Petit Bac (`orbit-petitbac`).

## Commandes

| Commande | Action |
|----------|--------|
| `/bacboard` | Afficher / masquer le tableau |
| 📊 (topbar) | Même action |
