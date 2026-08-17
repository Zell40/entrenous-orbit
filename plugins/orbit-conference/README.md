# Orbit Conference (Jitsi)

Plugin vidéo/audio pour Orbit — tag `+entrenous.fr/conference`.

## Fonctionnement

- Caméra en topbar (desktop) ; sur mobile dans le menu **⋮**
- Layout (desktop + mobile) : **topbar → visio → topic compact → chat**
- Topic réduit automatiquement pendant une visio pour laisser de la place au chat
- Démarrage salon : **opérateurs** (`~&@`) uniquement (configurable)
- Compte IRC enregistré requis (configurable) ; groupes refusés via WHOIS (`denyGroups`)
- Invite IRC envoyée **dès le démarrage** (par l’op), avec lien public ; Orbit masque la ligne et montre une bannière **Rejoindre**
- Le 1ᵉʳ participant (l’op qui démarre) est modérateur Meet sur une instance ouverte

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
    "disabledInChannels": ["#Mineurs.chat"],
    "viewHeight": "46%",
    "requireAccount": true,
    "requireChannelOp": true,
    "startPrefixes": "~&@",
    "denyGroups": ["controle-parentale"],
    "requireGroups": [],
    "maxParticipantsChannel": 25,
    "maxParticipantsQuery": 2,
    "publicLinkInInvite": true,
    "hideInviteForOrbit": true,
    "inviteText": "{{ nick }} vous invite à un appel vidéo. Rejoindre : {{ link }}",
    "joinText": "{{ nick }} a rejoint la conférence. Lien : {{ link }}",
    "joinButtonText": "Rejoindre"
  },
  "plugins": [
    "/app/plugins/third/orbit-conference/orbit-conference.js?v=7"
  ]
}
```

Ajuste `denyGroups` aux vrais noms de security groups InspIRCd.  
Limite dure côté serveur : `MAX_PARTICIPANTS` dans le `.env` Jitsi / Jicofo.  
Modérateur JWT (`secure: true` + EXTJWT) si tu veux des droits Meet plus stricts qu’« premier arrivé ».

## Tag IRC

Client tag : `+entrenous.fr/conference` (valeur `tagID`, défaut `1`).
