# entrenous-orbit

Personnalisations **EntreNous** pour [Orbit](https://orbit.tchatou.fr) — plugins, sidecars PHP, config et déploiement.

Ce dépôt est **volontairement séparé** du client Orbit amont, pour pouvoir :
- recevoir les mises à jour du propriétaire d’Orbit sans conflit ;
- développer / versionner nos plugins indépendamment.

## Contenu

| Chemin | Rôle |
| --- | --- |
| `plugins/orbit-room-gallery.js` | Galerie grille/liste + images de salon |
| `server/room-images/` | Stockage des images de salon (`room-images.php`) |
| `server/filehost/` | Endpoint `/upload` natif Orbit (composer) |
| `config/config.json` | Config EntreNous (branding, plugins, IRC…) |
| `config/.htaccess` | Réécriture Apache `/upload` → `filehost-upload.php` |
| `deploy.sh` | Build Orbit amont + overlay de ce dépôt |

## Sur le serveur

```
/home/chat/irc/sources/orbit-en            # clone propre d’Orbit (upstream only)
/home/chat/irc/sources/entrenous-orbit     # ce dépôt
/home/chat/irc/webchat-new                 # web root live
```

```bash
# Une fois : Orbit propre (remplacer l’URL si tu as un fork qui suit l’upstream)
git clone https://git.devtronic.pro/orbit/orbit.git /home/chat/irc/sources/orbit-en

git clone https://github.com/Zell40/entrenous-orbit.git /home/chat/irc/sources/entrenous-orbit
chmod +x /home/chat/irc/sources/entrenous-orbit/deploy.sh
```

Puis :

```bash
/home/chat/irc/sources/entrenous-orbit/deploy.sh
# ou
/home/chat/irc/sources/entrenous-orbit/deploy.sh --force
```

Les dossiers runtime (`room-images-uploads/`, `files/`) et les secrets (`*.local.php`) ne sont **jamais** écrasés.

## En local (Cursor)

Ouvre un workspace avec les **deux** dossiers :

```
C:\Users\famil\orbit              ← client Orbit (suivi upstream)
C:\Users\famil\entrenous-orbit    ← ce dépôt (là où on développe)
```

Fichier fourni : `entrenous-orbit.code-workspace` — double-clique-le dans Cursor.

Règle : **ne jamais modifier `orbit/src/`** pour une feature EntreNous. Tout nouveau comportement = plugin (et sidecar PHP si besoin) ici.

## Upstream Orbit

Dépôt amont : `https://git.devtronic.pro/orbit/orbit.git`

```bash
cd /path/to/orbit
git remote add upstream https://git.devtronic.pro/orbit/orbit.git   # une fois
git fetch upstream
git merge upstream/master   # ou rebase, selon ton habitude
```

## Secrets

À côté des PHP déployés sur le web root (jamais dans git) :

```php
<?php
// room-images.local.php
$EXTJWT_SECRET = '…';
$FOUNDER_CMODE = 'q';
```

```php
<?php
// filehost-upload.local.php
$JWT_SECRET = '…';
$JWT_ISSUER = 'FILEHOST';
```
