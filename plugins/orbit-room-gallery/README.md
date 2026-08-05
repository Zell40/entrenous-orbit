# orbit-room-gallery

Plugin EntreNous : galerie grille/liste des salons + image fondateur.

## Contenu (déployé tel quel)

```
plugins/third/orbit-room-gallery/
  orbit-room-gallery.js      ← plugin Orbit
  room-images.php            ← API + stockage images de salon
  room-images.local.php      ← secrets (créé à la main, jamais écrasé)
  room-images-uploads/       ← fichiers + room-images.json (runtime)
```

Ce n’est **pas** le filehost du composer (`/upload` → `filehost-upload.php` +
`files/` à la **racine** du web root). Voir `server/filehost/`.

## Config

Dans `config/config.json` :

```json
"/app/plugins/third/orbit-room-gallery/orbit-room-gallery.js?v=…"
```

Endpoint PHP (constante dans le JS) :

```
/app/plugins/third/orbit-room-gallery/room-images.php
```

## Secrets

Créer à côté du PHP déployé :

```php
<?php
// room-images.local.php
$EXTJWT_SECRET = '…'; // secret extjwt de l’ircd
$FOUNDER_CMODE = 'q'; // lettre du mode fondateur (PREFIX)
```

## Fonctionnement (résumé)

1. Fondateur → « Gérer mon chan » → image du salon.
2. Client demande un `EXTJWT #channel`, POST le fichier à `room-images.php`.
3. PHP vérifie la signature + mode fondateur, enregistre sous
   `room-images-uploads/`, met à jour `room-images.json`.
4. GET public (sans auth) nourrit galerie / topbar / sidebar.

Détails EXTJWT, MIME, permissions : commentaires en tête de `room-images.php`.
