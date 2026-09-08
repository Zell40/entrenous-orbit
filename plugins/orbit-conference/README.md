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
    "inviteEndpoint": "/app/plugins/third/orbit-conference/visio-invite.php",
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
    "publicLinkInInvite": false,
    "hideInviteForOrbit": true,
    "secureInviteText": "-{{ nick }}- a lancé une visio. Rejoignez-la depuis votre profil EntreNous (Mon identité) — aucun lien public.",
    "inviteText": "-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}",
    "joinText": "-{{ nick }}- vous invite à rejoindre la conférence. Cliquez sur le lien pour y acceder : {{ link }}",
    "joinButtonText": "Rejoindre"
  },
  "plugins": [
    "/app/plugins/third/orbit-conference/orbit-conference.js?v=18"
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
$INVITE_SHARED_SECRET = '...'; // même valeur que ENTRENOUS_VISIO_INVITE_SECRET (WP)
$INVITE_TTL = 3600;
$INVITE_MAX_REDEEMS = 3;
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

### 4. Principe (Orbit)

- Orbit demande `EXTJWT #salon` au serveur IRC
- `visio-jwt.php` vérifie cette preuve signée par l’ircd
- le script émet un JWT Jitsi limité à la salle demandée
- Jitsi n’accepte plus les accès directs sans jeton valide

### 5. Clients IRC externes (HexChat, mIRC, …) — via le profil web

**Pas de lien Jitsi dans l’IRC** (dangereux pour salons privés / secrets).

Flux :

1. L’op démarre la visio dans Orbit (`secure: true`).
2. Orbit appelle `visio-invite.php` (`action=create`) avec l’EXTJWT + la liste des **comptes NickServ** présents dans le salon.
3. Un message IRC **informatif** est envoyé (sans URL) : *« … Rejoignez-la depuis votre profil EntreNous »*.
4. L’utilisateur ouvre **Mon identité** sur le site → carte **Visio** → **Rejoindre**.
5. WordPress appelle `visio-invite.php` (`mine` / `redeem`) avec le secret partagé + le compte NS → JWT Jitsi court → ouverture de la salle.

#### Secrets

Dans `visio-jwt.local.php` (webchat) :

```php
$INVITE_SHARED_SECRET = 'long-random-secret';
$INVITE_TTL = 3600;
$INVITE_MAX_REDEEMS = 3;
```

Côté WordPress, copier `customizr_enfant/inc/visio-invites.local.php.example` → `visio-invites.local.php` :

```php
define('ENTRENOUS_VISIO_INVITE_URL', 'https://webapp2.entrenous.chat/app/plugins/third/orbit-conference/visio-invite.php');
define('ENTRENOUS_VISIO_INVITE_SECRET', 'long-random-secret'); // même valeur
```

#### Config Orbit (`conference`)

```json
{
  "secure": true,
  "publicLinkInInvite": false,
  "inviteEndpoint": "/app/plugins/third/orbit-conference/visio-invite.php",
  "secureInviteText": "-{{ nick }}- a lancé une visio. Rejoignez-la depuis votre profil EntreNous (Mon identité) — aucun lien public."
}
```

Fichiers : `visio-invite.php` (API), `visio-invites.json` (store runtime, créé automatiquement).

## Tag IRC

Client tag : `+entrenous.fr/conference` (valeur `tagID`, défaut `1`).
