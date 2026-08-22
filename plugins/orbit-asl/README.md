# orbit-asl

Active le **profil ASL** (âge / genre / ville) sur l’écran d’accueil Orbit.
Si les champs exigés manquent, le client affiche un **message d’erreur** et
entoure les cases (rouge = manquant, vert = ok).

Sans ce plugin dans `plugins`, les options `"asl"` de `config.json` sont ignorées.

## Config

```json
{
  "asl": {
    "requireAge": true,
    "requireGender": true,
    "requireCity": true,
    "minAge": 10
  },
  "plugins": ["/app/plugins/third/orbit-asl/orbit-asl.js?v=2"]
}
```

| Clé | Effet |
| --- | --- |
| `requireAge` | Connexion impossible sans âge |
| `requireGender` | Homme, Femme ou Non indiqué (GECOS : Autre) |
| `requireCity` | Connexion impossible sans ville |
| `minAge` | Âge minimum, 10 ans comme WordPress (un âge vide est aussi refusé) |

`deploy.sh` copie vers `plugins/third/orbit-asl/`. Sans ce fichier sur le
serveur, le navigateur charge une 404 HTML et Firefox affiche
`NS_ERROR_CORRUPTED_CONTENT`.

La connexion via bouncer n’est pas bloquée (le profil vient du compte).
