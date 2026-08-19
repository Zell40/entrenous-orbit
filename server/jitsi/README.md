# Jitsi Meet — service systemd & mises à jour automatiques

## Fichiers

| Fichier | Rôle |
|---|---|
| `jitsi-meet.service` | Service systemd pour démarrer Jitsi au boot |
| `jitsi-update.sh` | Script de vérification / mise à jour |
| `jitsi-update.service` | Service one-shot déclenché par le timer |
| `jitsi-update.timer` | Timer systemd (quotidien à 07h00) |
| `jitsi-motd.sh` | Message affiché à la connexion SSH pour l'utilisateur `chat` |

---

## 1. Démarrage automatique au boot

```bash
sudo cp jitsi-meet.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jitsi-meet
```

Vérifier :
```bash
systemctl status jitsi-meet
```

---

## 2. Vérification automatique des mises à jour

```bash
# Copier les fichiers
sudo cp jitsi-update.sh /home/chat/irc/jitsi-docker-jitsi-meet-738058b/
sudo chmod +x /home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh

sudo cp jitsi-update.service jitsi-update.timer /etc/systemd/system/

# Activer
sudo systemctl daemon-reload
sudo systemctl enable --now jitsi-update.timer
```

Le script vérifie quotidiennement à 07h00 si une nouvelle version de
[docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet/releases) est disponible.

## 2bis. Message SSH pour l'utilisateur `chat` sous Ubuntu

Sous Ubuntu, pour afficher un état Jitsi à chaque connexion SSH de l'utilisateur
`chat`, utiliser `~/.profile` :

```bash
cp jitsi-motd.sh ~/jitsi-motd.sh
chmod +x ~/jitsi-motd.sh
echo 'source ~/jitsi-motd.sh' >> ~/.profile
```

Tester sans se reconnecter :

```bash
bash ~/jitsi-motd.sh
```

Le script n'effectue pas d'appel réseau au login SSH. Il lit seulement :

- la version locale dans `JITSI_IMAGE_VERSION` du `.env`
- le dernier tag déjà détecté dans `/var/tmp/jitsi-last-known-tag`
- l'état local des containers via `docker compose ps`

### Notification par e-mail

Décommenter dans `jitsi-update.service` :
```
Environment="NOTIFY_EMAIL=admin@entrenous.chat"
```

Ou passer directement la variable au script :
```bash
NOTIFY_EMAIL=admin@entrenous.chat /home/chat/irc/.../jitsi-update.sh
```

### Consulter les logs
```bash
journalctl -u jitsi-update.service -f
tail -f /var/log/jitsi-update.log
```

---

## 3. Appliquer une mise à jour manuellement

```bash
# Vérifier sans appliquer
/home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh

# Appliquer si une MAJ est disponible
/home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh --update

# Forcer la mise à jour même si déjà à jour (ex. rebuild)
/home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh --force
```

Le script :
1. Lit la version dans `.env` (`JITSI_IMAGE_VERSION`)
2. Interroge l'API GitHub pour le dernier tag publié
3. Si différent : crée une sauvegarde complète du dossier Jitsi dans un dossier frère horodaté
4. Sauvegarde aussi `.env`, met à jour `JITSI_IMAGE_VERSION`, `docker compose pull`, `docker compose up -d`
5. Vérifie l'état des containers après redémarrage et notifie en cas d'erreur

Exemple de sauvegarde créée avant MAJ :

```bash
/home/chat/irc/jitsi-docker-jitsi-meet-738058b.bak.20260819121530
```

### Restauration simple en cas de problème

Si la nouvelle version ne fonctionne pas, tu peux revenir en arrière en arrêtant
l'instance courante, puis en renommant le dossier sauvegardé :

```bash
cd /home/chat/irc
mv jitsi-docker-jitsi-meet-738058b jitsi-docker-jitsi-meet-738058b.failed
mv jitsi-docker-jitsi-meet-738058b.bak.20260819121530 jitsi-docker-jitsi-meet-738058b
cd jitsi-docker-jitsi-meet-738058b
docker compose up -d
```

Adapte bien l'horodatage au dossier de sauvegarde réellement créé.

### Compatibilité avec ton installation

La procédure est compatible avec une installation `docker-jitsi-meet` récupérée
initialement via `wget`, tant que ton instance tourne toujours depuis le dossier :

```bash
/home/chat/irc/jitsi-docker-jitsi-meet-738058b
```

Le script ne dépend pas de la méthode d'installation initiale. Il s'appuie
uniquement sur :

- le dossier existant `jitsi-docker-jitsi-meet-738058b`
- le fichier `.env` déjà en place
- le `docker-compose.yml` déjà utilisé par ton instance
- les volumes Docker existants

En pratique, il ne supprime pas ta configuration applicative : il met à jour
`JITSI_IMAGE_VERSION`, télécharge les nouvelles images puis relance
`docker compose up -d --remove-orphans`.

### Ce qui est sûr

- Le nom du dossier `jitsi-docker-jitsi-meet-738058b` ne pose pas de problème.
- Le fait que l'installation de départ ait été faite avec `wget` ne pose pas de problème.
- Le `.env` est conservé et sauvegardé avant modification.
- Les volumes Docker et donc les données persistantes restent utilisés.

### Ce qui peut nécessiter une vérification manuelle

- Si une future release de `docker-jitsi-meet` ajoute de nouvelles variables
  obligatoires dans `.env`
- Si le projet amont modifie fortement `docker-compose.yml`
- Si ton installation locale a été personnalisée à la main hors `.env`

Autrement dit : pour les mises à jour courantes, le script est adapté. Pour un
gros saut de version upstream, il reste conseillé de lire rapidement les notes
de release de `docker-jitsi-meet` avant d'appliquer la MAJ.

### Recommandation

Le mode le plus sûr est :

```bash
/home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh
```

Puis seulement si une MAJ est signalée :

```bash
/home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh --update
```

---

## 4. Variables d'environnement du script

| Variable | Défaut | Description |
|---|---|---|
| `JITSI_DIR` | `/home/chat/irc/jitsi-docker-jitsi-meet-738058b` | Chemin du dépôt |
| `ENV_FILE` | `$JITSI_DIR/.env` | Fichier .env Jitsi |
| `BACKUP_ROOT` | `$(dirname "$JITSI_DIR")` | Répertoire parent dans lequel créer les sauvegardes |
| `KNOWN_FILE` | `/var/tmp/jitsi-last-known-tag` | Tag déjà notifié (évite les doublons) |
| `NOTIFY_EMAIL` | *(vide)* | Adresse e-mail de notification |
| `MAILER` | `mail` | Commande mail (`mail`, `sendmail`, `msmtp`) |
| `CURL_TIMEOUT` | `10` | Timeout curl en secondes |
