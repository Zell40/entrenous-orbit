# Avatars WordPress → Orbit

Orbit résout les avatars des comptes enregistrés via un batch same-origin :

```http
POST /accounts/api/avatars/
Content-Type: application/json

{ "accounts": ["Zell", "Alice"] }
```

```json
{ "avatars": { "zell": "https://…/photo.jpg", "alice": null } }
```

(Les clés de réponse sont en **minuscules**, comme le cache client Orbit.)

## EntreNous

KiwiIRC utilise déjà l’API publique WordPress :

`GET https://www.reseau-entrenous.fr/wp-json/entrenous/v1/profile?account=<login>`

(`wp-anope-sync` → `entrenous_api_get_profile`, avatar Ultimate Member).

Ce sidecar PHP (`avatars.php`) implémente l’API attendue par Orbit et interroge
cette route WP pour chaque compte (avec cache court + `curl_multi`).

## Déploiement

`deploy.sh` copie `avatars.php` à la racine du webchat et ajoute la rewrite
Apache dans `config/.htaccess` :

```apache
RewriteRule ^accounts/api/avatars/?$ /avatars.php [L,QSA]
```

Pas de secret à configurer (l’API WP est déjà publique, comme pour Kiwi).

Override optionnel — `avatars.local.php` à côté du script déployé (jamais
écrasé par deploy) :

```php
<?php
$WP_PROFILE_URL = 'https://www.reseau-entrenous.fr/wp-json/entrenous/v1/profile';
$CACHE_TTL = 1800;
```

## Test rapide

```bash
curl -sS -X POST https://webchat.entrenous.chat/accounts/api/avatars/ \
  -H 'Content-Type: application/json' \
  -d '{"accounts":["Zell"]}'
```
