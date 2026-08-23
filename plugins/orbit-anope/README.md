# orbit-anope

Écoute les **NOTICE NickServ** (Anope), les fusionne si LineWrapper les coupe,
puis émet des événements Orbit. L’invité n’est plus déduit d’un compte vide :
**sans notice NickServ, pas de popup.**

## Événements

| Événement | Quand |
| --- | --- |
| `anope:nickserv` | Toute notice NickServ coalescée `{ kind, from, text, nick }` |
| `anope:unregistered` | Pseudo pas enregistré / invitation à `/ns register` |
| `anope:identified` | Mot de passe accepté / déjà identifié |
| `anope:registered` | Pseudo vient d’être enregistré |
| `anope:ghost` | GHOST |
| `anope:denied` | Mauvais mot de passe / accès refusé |

`anope:unregistered` ouvre le popup **Pseudo non enregistré** (Créer mon profil /
J’ai déjà un compte / Plus tard). Si la notice est arrivée avant le chargement
du plugin, elle est relue dans les buffers.

« Plus tard » est mémorisé **par pseudo** (session), pas pour toute l’onglet.

```js
Orbit.plugin('autre', function (orbit) {
  orbit.on('anope:unregistered', function (p) { orbit.log(p.nick, p.text); });
});
```

## Config

```json
"plugins": ["/app/plugins/third/orbit-anope/orbit-anope.js?v=2"]
```

`branding.registerUrl` alimente **Créer mon profil**. `features.register: false`
coupe le popup (les événements restent).
