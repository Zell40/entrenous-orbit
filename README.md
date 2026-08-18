# entrenous-orbit

Personnalisations **EntreNous** pour [Orbit](https://github.com/Zell40/orbit) — plugins, sidecars PHP, config et déploiement.

Ce dépôt est **volontairement séparé** du client Orbit amont, pour pouvoir :
- recevoir les mises à jour du propriétaire d’Orbit sans conflit ;
- développer / versionner nos plugins indépendamment.

## Contenu

| Chemin | Rôle |
| --- | --- |
| `plugins/orbit-room-gallery/` | Galerie + `room-images.php` (tout le plugin) |
| `server/filehost/` | Endpoint `/upload` natif Orbit (composer) — racine web |
| `server/handoff/` | Bridge WordPress → Orbit (JWT / OAUTHBEARER) |
| `server/avatars/` | Bridge avatars WP → `POST /accounts/api/avatars/` |
| `config/config.json` | Config EntreNous (branding, plugins, IRC…) |
| `config/.htaccess` | Rewrites Apache (`/upload`, `/accounts/api/avatars/`) |
| `deploy.sh` | Build Orbit amont + overlay de ce dépôt |

## Sur le serveur

```
/home/chat/irc/sources/orbit               # clone propre d’Orbit (même nom que GitHub)
/home/chat/irc/sources/entrenous-orbit     # ce dépôt
/home/chat/irc/webchat-new                 # web root live
```

Après deploy, le web root contient notamment :

```
webchat-new/
  plugins/third/orbit-room-gallery/   ← JS + room-images.php + uploads
  filehost-upload.php                 ← composer /upload
  files/                              ← uploads composer
  handoff.php                         ← WordPress → Orbit SASL
  avatars.php                         ← WordPress → Orbit avatars
  config.json
  .htaccess
```

```bash
# Une fois : Orbit propre (fork Zell40 ou upstream)
git clone -b main https://github.com/Zell40/orbit.git /home/chat/irc/sources/orbit
# ou : git clone -b main https://git.devtronic.pro/orbit/orbit.git /home/chat/irc/sources/orbit

git clone https://github.com/Zell40/entrenous-orbit.git /home/chat/irc/sources/entrenous-orbit
chmod +x /home/chat/irc/sources/entrenous-orbit/deploy.sh
```

Puis :

```bash
/home/chat/irc/sources/entrenous-orbit/deploy.sh
# ou
/home/chat/irc/sources/entrenous-orbit/deploy.sh --force
```

Les dossiers runtime (`…/room-images-uploads/`, `files/`) et les secrets (`*.local.php`) ne sont **jamais** écrasés. `deploy.sh` crée les dossiers d’upload s’ils manquent, migre l’ancien layout racine vers le dossier plugin, puis **supprime** les copies obsolètes à la racine (`/room-images.php`, etc.) une fois le plugin en place.

## En local (Cursor)

Ouvre un workspace avec les **trois** dossiers liés :

```
C:\Users\famil\entrenous-orbit    ← plugins / config / deploy EntreNous (ce dépôt)
C:\Users\famil\orbit              ← client Orbit (suivi upstream)
C:\Users\famil\EntreNous-web     ← site WordPress (plugins + thème MonIdentité / Anope)
```

| Dossier | Rôle |
| --- | --- |
| `entrenous-orbit` | Personnalisations webchat EntreNous (plugins Orbit, sidecars PHP, `deploy.sh`) |
| `orbit` | Client webchat amont — ne pas y mettre de logique EntreNous |
| `EntreNous-web` | Site `reseau-entrenous.fr` : sync Anope (`wp-anope-sync`), loader, thème `customizr_enfant` (JWT SASL, MonIdentité, API profil) |

Fichier fourni : `entrenous-orbit.code-workspace` — double-clique-le dans Cursor.

Chaîne typique : **WordPress** (compte + JWT / API profil) → **Orbit** (client) ← overlay **entrenous-orbit** (plugins EntreNous).

Règle : **ne jamais modifier `orbit/src/`** pour une feature EntreNous. Tout nouveau comportement = plugin (et sidecar PHP si besoin) ici.

## Upstream Orbit

Dépôt amont : `https://git.devtronic.pro/orbit/orbit.git`

```bash
cd /path/to/orbit
git remote add upstream https://git.devtronic.pro/orbit/orbit.git   # une fois
git fetch upstream
git merge upstream/main
```

## Secrets

À côté des PHP déployés (jamais dans git) :

```php
<?php
// plugins/third/orbit-room-gallery/room-images.local.php
$EXTJWT_SECRET = '…';
$FOUNDER_CMODE = 'q';
```

```php
<?php
// plugins/third/orbit-conference/visio-jwt.local.php
$EXTJWT_SECRET = '…';      // même secret extjwt côté ircd
$JITSI_APP_ID = 'jitsi_app';
$JITSI_APP_SECRET = '…';   // même secret que Prosody/Jitsi token auth
$JITSI_DOMAIN = 'visio.entrenous.chat';
$JWT_AUDIENCE = '';        // vide = audience = JITSI_APP_ID
$JWT_TTL = 300;
```

```php
<?php
// filehost-upload.local.php  (racine web)
$JWT_SECRET = '…';
$JWT_ISSUER = 'FILEHOST';
```
