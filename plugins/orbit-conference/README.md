# Orbit Conference (Jitsi)

Plugin vidéo/audio pour Orbit — même idée que `kiwiirc-plugin-conference`, adapté à EntreNous.

## Fonctionnement

- Bouton caméra dans la barre du salon / MP (desktop) et à côté du composeur (mobile)
- Commande `/visio` pour ouvrir / fermer
- Panneau Jitsi ancré en bas du chat
- À l’entrée dans la salle, envoie un PRIVMSG tagué `+entrenous.fr/conference`
- Les autres clients Orbit voient un bouton **Rejoindre**

## Prérequis

1. **Orbit** avec `apiVersion >= 7` (`irc.msgTagged` + tags sur les messages)
2. Cap IRCv3 `message-tags` sur le serveur
3. Instance **Jitsi Meet self-host** (recommandé), ex. `visio.entrenous.chat`

## Config (`config.json`)

```json
{
  "conference": {
    "server": "visio.entrenous.chat",
    "secure": false,
    "tagID": "1",
    "channels": true,
    "queries": true,
    "enabledInChannels": ["*"],
    "viewHeight": "42%",
    "inviteText": "{{ nick }} vous invite à un appel vidéo.",
    "joinText": "{{ nick }} a rejoint la conférence.",
    "joinButtonText": "Rejoindre"
  },
  "plugins": [
    "/app/plugins/third/orbit-conference/orbit-conference.js?v=3"
  ]
}
```

`secure: true` tente un `EXTJWT` avant d’ouvrir Jitsi (JWT self-host). Sans réponse, bascule sans JWT.

## Build (optionnel)

Le fichier prêt à servir est `orbit-conference.js` (à la racine du plugin).

Pour reconstruire depuis le TSX :

```bash
cd plugins/orbit-conference
npm install
npm run build
# → dist/orbit-conference.js
```

Copier vers le dossier servi :

`/app/plugins/third/orbit-conference/orbit-conference.js`

## Tag IRC

Client tag : `+entrenous.fr/conference` (valeur `tagID`, défaut `1`).
Pas d’interop avec l’ancien tag Kiwi `+kiwiirc.com/conference`.
