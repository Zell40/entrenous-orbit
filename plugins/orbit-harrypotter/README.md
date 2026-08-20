# orbit-harrypotter

Interface **Orbit** pour le bot Limnoria **HarryPotter** sur EntreNous.

Le bot envoie l’état de la partie en **TAGMSG IRCv3** (`+hp=v1`, `+ev=…`) sans polluer le fil de chat. Ce plugin affiche un panneau : maisons, Choixpeau, questions, sorts, duels.

## Prérequis

- Orbit avec support `on('raw')` et négociation **message-tags**
- Plugin Limnoria **HarryPotter** chargé (TAGMSG depuis `#HarryPotter.chat`)

## Installation

1. Déployer via `deploy.sh` (copie vers `webchat-new/plugins/third/orbit-harrypotter/`).
2. Vérifier l’entrée dans `config/config.json` :

```json
"harrypotter": {
  "channels": ["#HarryPotter.chat"],
  "showWhenIdle": true
},
"plugins": [
  "/app/plugins/third/orbit-harrypotter/orbit-harrypotter.js?v=1"
]
```

## Configuration

| Clé | Description |
|---|---|
| `channels` | Salons où le panneau est actif (`["*"]` = tous les salons) |
| `showWhenIdle` | Afficher le panneau « En attente » avec les boutons Jouer / Rejoindre |
| `botNicks` | Pseudos du bot (optionnel) |

## Événements TAGMSG (`+hp=v1`)

| `+ev` | Rôle |
|---|---|
| `game_start` / `game_end` | début / Coupe des maisons |
| `sorting` | animation Choixpeau (`+step` 1–4) |
| `house_join` | attribution de maison |
| `nick_transform` | SANICK IRCOP |
| `year_start` | l’année commence |
| `question` / `answer_ok` / `answer_ko` / `question_expire` | quiz |
| `spell` / `spell_ok` / `spell_ko` / `spell_expire` | sortilège |
| `duel_start` / `duel_choice` / `duel_tie` / `duel_win` / `duel_expire` | duel |
| `score` / `state_sync` | scores + phase (`!etat`) |
| `ambiance` / `mimsy` | PNJ (tags seulement si `quietChannel`) |

## Développement local (Windows)

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-harrypotter"
New-Item -ItemType SymbolicLink -Force `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-harrypotter\orbit-harrypotter.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-harrypotter\orbit-harrypotter.js"
```

Ajouter le plugin dans la config locale Orbit, puis `npm run dev`.
