# Handoff WordPress → Orbit

`handoff.php` reçoit le JWT en **POST** depuis MonIdentité (page test Orbit),
écrit `sessionStorage.tchatou_handoff`, pose le cookie HttpOnly `orbit_en_resume`,
puis redirige vers l’app Orbit.

`chat-resume.php` (réécrit en `/accounts/api/chat_resume/`) renouvelle un JWT
SASL à partir de ce cookie — utilisé au rechargement de page et à chaque
reconnexion WebSocket (`features.sessionResume` + `saslOauthBearer`).

Déployé automatiquement à la racine du webchat par `deploy.sh` :

```
webchat-new/handoff.php
webchat-new/chat-resume.php
webchat-new/chat-resume.local.php   ← secrets (à créer une fois)
```

Créer `chat-resume.local.php` depuis `chat-resume.local.php.example` avec le
**même** `jwt_secret` que WordPress MonIdentité / InspIRCd oauthbearer.

`deploy.sh` **ne touche jamais** à `chat-resume.local.php` (exclu du `rsync
--delete` + jamais écrasé par un `cp`). Seul `chat-resume.php` est mis à jour.

Il doit rester sur la **même origine** que le client Orbit (sessionStorage + cookie).
Le site WordPress (`EntreNous-web`, autre shell) se déploie à part, manuellement.

Avec `features.saslOauthBearer: true` dans `config.json`, Orbit authentifie
le JWT via **SASL OAUTHBEARER** (RFC 7628). Le champ POST `account` (login
NickServ) est passé en authzid quand le pseudo d’affichage diffère.

Les champs optionnels `age` / `sexe` (`H`|`F`|`A`) / `ville` construisent le
GECOS IRC `40 - Homme - Paris`, stocké dans `tchatou_handoff.realname` (badges
genre dans la liste des membres et le profil Orbit).

Côté WordPress, constantes dans `functions.php` :

- `ENTRENOUS_ORBIT_BASE` — ex. `https://webchat.entrenous.chat`
- `ENTRENOUS_ORBIT_HANDOFF` — `…/handoff.php`
- `ENTRENOUS_ORBIT_APP` — URL de l’app Orbit
