# orbit-echecs

Interface **Orbit** pour le bot Limnoria **CapEchecs** sur EntreNous.

Le bot envoie l’état de la partie en **TAGMSG IRCv3** (`+ec=v1`, `+ev=…`) sans polluer le fil de chat. Ce plugin affiche un plateau cliquable et renvoie les coups en TAGMSG (`+ev=cmd`).

## Prérequis

- Orbit avec support `on('raw')` et négociation **message-tags**
- Plugin Limnoria **CapEchecs** chargé (TAGMSG depuis `#Echecs.chat`)

## Installation

1. Déployer via `deploy.sh` (copie vers `webchat-new/plugins/third/orbit-echecs/`).
2. Vérifier l’entrée dans `config/config.json` :

```json
"echecs": {
  "channels": ["#Echecs.chat"],
  "showWhenIdle": true
},
"plugins": [
  "/app/plugins/third/orbit-echecs/orbit-echecs.js?v=1"
]
```

## Configuration

| Clé | Description |
|-----|-------------|
| `channels` | Salons où le panneau est actif (`["*"]` = tous les salons) |
| `showWhenIdle` | Afficher le panneau « Prêt » avec les boutons de lancement |

## Protocole TAGMSG

### Bot → Orbit (`+ec=v1`)

| `+ev` | Contenu |
|-------|---------|
| `waiting` | `mode`, `creator`, `invited` |
| `game_start` | `mode`, `white`, `black`, `fen`, `turn`, `ply` |
| `move` | `san`, `san-fr`, `uci`, `from`, `to`, `fen`, `turn` |
| `state_sync` | état complet (FEN, joueurs, prises, historique) |
| `illegal` | `reason` (`illegal`, `not-turn`, `waiting`, `no-game`) |
| `draw_offer` | `nick` |
| `game_end` | `result`, `reason`, `winner`, `fen` |
| `cmd_err` | `name`, `text` |

Le FEN voyage avec des `_` à la place des espaces.

### Orbit → bot

```
@+ec=v1;+ev=cmd;+name=jouer;+arg=e2e4 TAGMSG #Echecs.chat
```

Commandes : `commencer`, `rejoindre`, `jouer`, `nul`, `abandonner`, `annuler`, `sync`.

## Développement local (Windows)

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-echecs"
New-Item -ItemType SymbolicLink -Force `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-echecs\orbit-echecs.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-echecs\orbit-echecs.js"
```

Ajouter le plugin dans la config locale Orbit, puis `npm run dev`.
