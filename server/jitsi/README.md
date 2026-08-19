# Jitsi Meet — service systemd & mises à jour automatiques

## Fichiers

| Fichier | Rôle |
|---|---|
| `jitsi-meet.service` | Service systemd pour démarrer Jitsi au boot |
| `jitsi-update.sh` | Script de vérification / mise à jour |
| `jitsi-update.service` | Service one-shot déclenché par le timer |
| `jitsi-update.timer` | Timer systemd (quotidien à 07h00) |

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
3. Si différent : sauvegarde `.env`, met à jour `JITSI_IMAGE_VERSION`, `docker compose pull`, `docker compose up -d`
4. Vérifie l'état des containers après redémarrage et notifie en cas d'erreur

---

## 4. Variables d'environnement du script

| Variable | Défaut | Description |
|---|---|---|
| `JITSI_DIR` | `/home/chat/irc/jitsi-docker-jitsi-meet-738058b` | Chemin du dépôt |
| `ENV_FILE` | `$JITSI_DIR/.env` | Fichier .env Jitsi |
| `KNOWN_FILE` | `/var/tmp/jitsi-last-known-tag` | Tag déjà notifié (évite les doublons) |
| `NOTIFY_EMAIL` | *(vide)* | Adresse e-mail de notification |
| `MAILER` | `mail` | Commande mail (`mail`, `sendmail`, `msmtp`) |
| `CURL_TIMEOUT` | `10` | Timeout curl en secondes |
