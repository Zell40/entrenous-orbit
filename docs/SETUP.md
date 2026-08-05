# Mise en place GitHub + serveur

## 1. Créer le dépôt GitHub (une fois)

Sur https://github.com/new :
- Nom : `entrenous-orbit`
- Privé recommandé
- **Sans** README / .gitignore (le dépôt local existe déjà)

Puis dans PowerShell :

```powershell
cd C:\Users\famil\entrenous-orbit
git remote add origin https://github.com/Zell40/entrenous-orbit.git
git push -u origin master
```

## 2. Ouvrir le workspace Cursor

Double-clique :

`C:\Users\famil\entrenous-orbit\entrenous-orbit.code-workspace`

Ça ouvre les deux dossiers : plugins + Orbit amont.

## 3. Sur le serveur

```bash
# Backup de l’ancien Orbit modifié, puis clone propre sous le nom « orbit »
mv /home/chat/irc/sources/orbit-en /home/chat/irc/sources/orbit.bak-mixed 2>/dev/null || true
mv /home/chat/irc/sources/orbit /home/chat/irc/sources/orbit.bak-mixed 2>/dev/null || true

git clone -b main https://github.com/Zell40/orbit.git /home/chat/irc/sources/orbit
# ou : git clone -b main https://git.devtronic.pro/orbit/orbit.git /home/chat/irc/sources/orbit

git clone https://github.com/Zell40/entrenous-orbit.git /home/chat/irc/sources/entrenous-orbit
chmod +x /home/chat/irc/sources/entrenous-orbit/deploy.sh

# Pointer le cron vers le NOUVEAU deploy.sh :
#   /home/chat/irc/sources/entrenous-orbit/deploy.sh

/home/chat/irc/sources/entrenous-orbit/deploy.sh --force
```

Les `*.local.php` et dossiers d’upload dans `webchat-new/` restent en place.
Au premier deploy avec le nouveau layout, `deploy.sh` migre
`room-images.local.php` + `room-images-uploads/` de la racine vers
`plugins/third/orbit-room-gallery/` si besoin.

Après migration, tu peux supprimer à la main les anciens fichiers racine
(`room-images.php`, dossier `room-images-uploads/` vide) une fois que les
images s’affichent correctement.
