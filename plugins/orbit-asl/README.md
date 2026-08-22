# orbit-asl

Active le **profil ASL** (âge / genre / ville) sur l’écran d’accueil Orbit, et
peut **bloquer le bouton de connexion** tant que les champs exigés ne sont pas
remplis.

Sans ce plugin dans `plugins`, les options `"asl"` de `config.json` sont ignorées.

## Config

```json
{
  "asl": {
    "requireAge": true,
    "requireGender": true,
    "requireCity": true,
    "minAge": 18
  },
  "plugins": ["/app/plugins/third/orbit-asl/orbit-asl.js?v=1"]
}
```

| Clé | Effet |
| --- | --- |
| `requireAge` | Connexion impossible sans âge |
| `requireGender` | Connexion impossible sans Homme / Femme |
| `requireCity` | Connexion impossible sans ville |
| `minAge` | Âge minimum (un âge vide est aussi refusé) |

La connexion via bouncer n’est pas bloquée (le profil vient du compte).
