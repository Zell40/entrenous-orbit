# orbit-petitbac

Interface **Orbit** pour le bot Limnoria **Petit Bac** sur EntreNous.

Le bot envoie l’état de la partie en **TAGMSG IRCv3** (`+pb=v1`, `+ev=…`) sans polluer le fil de chat. Ce plugin affiche un panneau moderne : lettre, catégories, compte à rebours, scores, tableau live des réponses, commandes.

Le mode **plein écran** recouvre tout le tchat (topic, messages et barre de saisie). Le mode **split** laisse le tchat visible en dessous.

## Prérequis

- Orbit avec support `on('raw')` et négociation **message-tags**
- Plugin Limnoria **PetitBac** chargé sur le réseau (TAGMSG depuis `#Baccalaureat.chat`)

## Installation

1. Déployer via `deploy.sh` (copie vers `webchat-new/plugins/third/orbit-petitbac/` + dossier `assets/`).
2. Vérifier l’entrée dans `config/config.json` :

```json
"petitbac": {
  "channels": ["#Baccalaureat.chat"],
  "showWhenIdle": true,
  "defaultCollapsed": false
},
"plugins": [
  "/app/plugins/third/orbit-petitbac/orbit-petitbac.js?v=1"
]
```

## Configuration

| Clé | Description |
|-----|-------------|
| `channels` | Salons où le panneau est actif (`["*"]` = tous les salons) |
| `showWhenIdle` | Afficher le panneau « En attente » avec bouton **Lancer une partie** |
| `defaultCollapsed` | Panneau réduit au chargement |

## Événements TAGMSG consommés

| `+ev` | Contenu |
|-------|---------|
| `game_start` | mode, duration, max_rounds, starter… |
| `rules_start` | règles pour un nouveau joueur |
| `countdown_start` | décompte avant GO (`+seconds`) |
| `game_go` | lancement |
| `round_start` | `+letter`, `+categories`, `+duration`, `+round` |
| `round_countdown` | alertes 20 / 10 / 5 s |
| `round_tick` | `+seconds_left` (resync timer, toutes les 5 s) |
| `state_sync` | état courant pour un joueur qui arrive en cours de partie |
| `word_ok` | `+nick` `+word` `+category` `+points` |
| `word_ko` | `+nick` `+word` `+reason` (`wrong_letter`, `already_used`, …) |
| `verify_hint` / `verify_pending` / `verify_ok` / `verify_ko` | proposition `!verifier` |
| `round_end` | `+round_scores` (JSON) |
| `game_end` | `+final_ranking`, `+top_global` (JSON) |

## Commandes Orbit

- Bouton **🎲** dans la barre du salon (lance `!jouer` si aucune partie)
- `/jouer` — équivalent IRC `!jouer` dans le salon actif

## Développement local (Windows)

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-petitbac\assets"
New-Item -ItemType SymbolicLink -Force `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-petitbac\orbit-petitbac.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-petitbac\orbit-petitbac.js"
Copy-Item -Recurse -Force `
  "C:\Users\famil\entrenous-orbit\plugins\orbit-petitbac\assets\*" `
  "C:\Users\famil\orbit\public\plugins\third\orbit-petitbac\assets\"
```

Ajouter le plugin dans la config locale Orbit, puis `npm run dev`.
