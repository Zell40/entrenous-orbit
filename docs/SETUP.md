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
# Orbit propre — si orbit-en contient encore nos vieux commits plugin,
# le plus simple est un clone frais de l’upstream (garde l’ancien en backup) :
mv /home/chat/irc/sources/orbit-en /home/chat/irc/sources/orbit-en.bak-mixed
git clone https://git.devtronic.pro/orbit/orbit.git /home/chat/irc/sources/orbit-en
# ou ton fork Zell40/orbit une fois réaligné sur l’upstream

git clone https://github.com/Zell40/entrenous-orbit.git /home/chat/irc/sources/entrenous-orbit
chmod +x /home/chat/irc/sources/entrenous-orbit/deploy.sh

# Pointer le cron vers le NOUVEAU deploy.sh :
#   /home/chat/irc/sources/entrenous-orbit/deploy.sh

/home/chat/irc/sources/entrenous-orbit/deploy.sh --force
```

Les `*.local.php` et dossiers d’upload dans `webchat-new/` restent en place.
