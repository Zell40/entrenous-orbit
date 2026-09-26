# orbit-rss

Bulles **Actualités** pour le bot Limnoria **RSS_ircv3**.

Le bot envoie chaque titre en TAGMSG IRCv3 (`+rss=v1`, `+ev=item`). Ce plugin les affiche à droite du topic, sur le salon concerné. Une bulle lue ou fermée ne revient pas. Le bouton **Actualités** reste affiché pour relire l’historique, tant que le bot est dans le salon et que la capacité `message-tags` est négociée.

## Prérequis

- Orbit avec `on('raw')` et `orbit.server.hasCap`
- Plugin Limnoria **RSS_ircv3** (`tagAnnounce` activé sur le salon)
- Le bot (par défaut `Actu`) présent dans le salon

## Installation

1. Déployer via `deploy.sh` (copie vers `plugins/third/orbit-rss/`).
2. Entrée dans `config/config.json` :

```json
"rss": { "bot": "Actu" },
"plugins": [
  "/app/plugins/third/orbit-rss/orbit-rss.js?v=1"
]
```

`bot` est le nick dont la présence affiche le bouton Actualités.

## Protocole

```
@+rss=v1;+ev=item;+feed=<nom>;+title=...;+link=...;+date=...;+desc=...;+id=...;+feedtitle=... TAGMSG #salon
```

## Développement local (Windows)

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-rss"
New-Item -ItemType SymbolicLink -Force `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-rss\orbit-rss.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-rss\orbit-rss.js"
```

Ajouter le plugin dans la config locale Orbit, puis `npm run dev`.
