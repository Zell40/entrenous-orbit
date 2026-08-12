# Handoff WordPress → Orbit

`handoff.php` reçoit le JWT en **POST** depuis MonIdentité (page test Orbit),
écrit `sessionStorage.tchatou_handoff`, puis redirige vers l’app Orbit.

Déployé automatiquement à la racine du webchat par `deploy.sh` :

```
webchat-new/handoff.php
```

Il doit rester sur la **même origine** que le client Orbit (sessionStorage).
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
