# orbit-helpserv-welcome

Affiche un message d’accueil (faux PRIVMSG locaux via `pushLocal`) dès qu’un utilisateur ouvre un PV avec un bot HelpServ configuré.

## Emplacement

Plugin **EntreNous** (`entrenous-orbit`), pas dans le core Orbit.

- Fichier : `plugins/orbit-helpserv-welcome/orbit-helpserv-welcome.js`
- Déployé sous : `/app/plugins/third/orbit-helpserv-welcome/`
- Listé dans `config/config.json` → `plugins`

Orbit fournit seulement l’API (`buffer.active`, `state.get().pushLocal`). Les textes d’accueil sont entièrement dans ce plugin (+ conf).

## Bots par défaut

| Bot | Rôle |
|-----|------|
| **AideMoi** | Bonjour + guide doc EntreNous |
| **SignalMoi** | Bonjour + consignes signalement |
| **EcoutE** | Bonjour + consignes idées / avis |

Le bouton **Signaler** du profil utilise `config.report.query` (`SignalMoi`) : ouverture du PV + brouillon + accueil auto.

## Configuration (recommandé)

Dans `config.json` :

```json
"helpservWelcome": {
  "bots": [
    {
      "nick": "AideMoi",
      "needle": "reseau-entrenous.fr/aide/",
      "lines": [
        "Bonjour {{nick}}, comment puis-je vous aider ?",
        "Décrivez votre problème…"
      ]
    },
    {
      "nick": "SignalMoi",
      "needle": "Ne discutez pas des signalements en public",
      "lines": ["…"]
    },
    {
      "nick": "EcoutE",
      "needle": "idée ou un avis",
      "lines": [
        "Bonjour {{nick}}, merci de partager une idée ou un avis.",
        "Décrivez votre suggestion…"
      ]
    }
  ]
}
```

- `nick` : pseudo du bot (insensible à la casse)
- `lines` : une bulle par entrée ; `{{nick}}` → pseudo de l’utilisateur
- `needle` : sous-chaîne déjà présente dans le buffer → pas de réinjection (ex. après reconnect)

Sans bloc `helpservWelcome`, les 3 bots par défaut (ci-dessus) s’appliquent.

Après modification du `.js`, incrémenter `?v=` dans `plugins` pour forcer le cache navigateur.

## Photos / vocaux en MP

Oui côté **HelpServ Anope** : Orbit envoie l’upload en CTCP ACTION ; le module HelpServ l’attache au ticket (`Image: https://…` / note vocale) et l’affiche sur `#_BO` / `#_logs`. Sans ticket encore ouvert, le média est mis en attente puis joint dès la description.
