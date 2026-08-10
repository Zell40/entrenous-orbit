# Handoff WordPress → Orbit

`handoff.php` reçoit le JWT en **POST** depuis MonIdentité (page test Orbit),
écrit `sessionStorage.tchatou_handoff`, puis redirige vers l’app Orbit.

**Déploiement manuel** (pas via `deploy.sh`) : copier ce fichier à la racine
du webchat Orbit, sur le shell chat, par ex. :

```
/home/chat/irc/webchat-new/handoff.php
```

Il doit être sur la **même origine** que le client Orbit (sessionStorage).
Le site WordPress (autre shell) n’héberge pas ce fichier.

Côté WordPress, constantes dans `functions.php` :

- `ENTRENOUS_ORBIT_BASE` — ex. `https://webchat.entrenous.chat`
- `ENTRENOUS_ORBIT_HANDOFF` — `…/handoff.php`
- `ENTRENOUS_ORBIT_APP` — URL de l’app Orbit
