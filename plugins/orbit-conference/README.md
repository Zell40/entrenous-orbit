# Orbit Conference (Jitsi)

Plugin vidéo/audio pour Orbit — tag `+entrenous.fr/conference`.

## Fonctionnement

- Caméra en topbar (desktop) ; sur mobile dans le menu **⋮**
- Layout (desktop + mobile) : **topbar → visio → topic compact → chat**
- Topic réduit automatiquement pendant une visio pour laisser de la place au chat
- Démarrage salon : **opérateurs** (`~&@`) uniquement (configurable)
- Compte IRC enregistré requis (configurable) ; groupes refusés via WHOIS (`denyGroups`)
- Invite IRC envoyée **dès le démarrage** (par l’op), avec lien public ; Orbit masque la ligne et montre une bannière **Rejoindre**
- Nom de salle Meet = nom du salon IRC (lisible) ; suffixe `-01`, `-02`… si une nouvelle salle parallèle est forcée
- Le 1ᵉʳ participant (l’op qui démarre) est modérateur Meet sur une instance ouverte

## Config (`config.json`)

```json
{
  "conference": {
    "server": "visio.entrenous.chat",
    "secure": false,
    "tokenEndpoint": "/app/plugins/third/orbit-conference/visio-jwt.php",
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
    "inviteText": "-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}",
    "joinText": "-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}",
    "joinButtonText": "Rejoindre"
  },
  "plugins": [
    "/app/plugins/third/orbit-conference/orbit-conference.js?v=8"
  ]
}
```

Ajuste `denyGroups` aux vrais noms de security groups InspIRCd.  
Limite dure côté serveur : `MAX_PARTICIPANTS` dans le `.env` Jitsi / Jicofo.  
Pour une visio vraiment privée, active `secure: true` et fais vérifier un `EXTJWT`
IRC par `visio-jwt.php`, qui renvoie ensuite un JWT Jitsi de courte durée.

## Mode sécurisé

### 1. Config Orbit

```json
{
  "conference": {
    "server": "visio.entrenous.chat",
    "secure": true,
    "tokenEndpoint": "/app/plugins/third/orbit-conference/visio-jwt.php",
    "publicLinkInInvite": false
  }
}
```

`publicLinkInInvite: false` évite de diffuser un lien Jitsi brut réutilisable.

### 2. Secrets côté webchat

Créer `plugins/third/orbit-conference/visio-jwt.local.php` :

```php
<?php
$EXTJWT_SECRET = '...';      // même secret que l’ircd extjwt {}
$JITSI_APP_ID = 'jitsi_app'; // app_id / app_id prosody token
$JITSI_APP_SECRET = '...';   // secret partagé avec Prosody/Jitsi
$JITSI_DOMAIN = 'visio.entrenous.chat';
$JWT_AUDIENCE = '';          // vide = audience = JITSI_APP_ID (recommandé)
$JWT_TTL = 300;
$START_CMODES = ['q', 'a', 'o']; // lettres PREFIX : ~ & @
```

Le JWT pose `affiliation=owner` seulement si l’EXTJWT du salon contient un de ces modes. Les autres participants reçoivent `member`.

### 3. Jitsi : ne plus promouvoir tout le monde

Sans ça, Jicofo considère **tout utilisateur JWT** comme modérateur. Dans le `.env` Jitsi :

```env
ENABLE_AUTO_OWNER=0
JICOFO_ENABLE_AUTH=0
XMPP_MUC_MODULES=token_affiliation
```

Puis :

```bash
docker compose up -d --force-recreate prosody jicofo web
```

### 4. Principe

- Orbit demande `EXTJWT #salon` au serveur IRC
- `visio-jwt.php` vérifie cette preuve signée par l’ircd
- le script émet un JWT Jitsi limité à la salle demandée
- Jitsi n’accepte plus les accès directs sans jeton valide

### 5. Clients IRC externes

Le même endpoint peut accepter un `EXTJWT` obtenu depuis un autre client IRC
enregistré. Il faut donc prévoir, côté UX, soit :

- une petite page web de passerelle où coller / transmettre ce `EXTJWT`
- soit un service/bot qui convertit la preuve IRC en lien court

## Tag IRC

Client tag : `+entrenous.fr/conference` (valeur `tagID`, défaut `1`).
