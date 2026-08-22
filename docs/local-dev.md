# Développement local du plugin contre Orbit

Pour tester les plugins EntreNous avec `npm run dev` dans le clone Orbit :

## Windows (PowerShell, en Admin si lien symbolique)

**Galerie :**

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-room-gallery"
New-Item -ItemType SymbolicLink `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-room-gallery\orbit-room-gallery.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-room-gallery\orbit-room-gallery.js"
```

**Visio (orbit-conference)** — sans ce fichier, la console affiche `[plugins] failed to load …/orbit-conference.js` :

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\famil\orbit\public\plugins\third\orbit-conference"
Copy-Item -Force `
  "C:\Users\famil\entrenous-orbit\plugins\orbit-conference\orbit-conference.js" `
  "C:\Users\famil\orbit\public\plugins\third\orbit-conference\orbit-conference.js"
```

(ou lien symbolique vers le même chemin si vous préférez.)

**Callerid, Petit Bac, etc.** — même principe : copier ou lier `entrenous-orbit/plugins/<nom>/` vers `orbit/public/plugins/third/<nom>/`.

Puis dans `orbit/public/config.json`, ajoute temporairement (ne pas committer) :

```json
"/app/plugins/third/orbit-room-gallery/orbit-room-gallery.js?v=dev"
```

Ou copie `entrenous-orbit/config/config.json` par-dessus pour un test complet EntreNous.

Le PHP `room-images.php` / `visio-jwt.php` se teste plutôt contre le serveur (même origine) ; en local pur sans PHP, la galerie fonctionne sans images et la visio sans JWT.

## Linux / serveur

```bash
mkdir -p /home/chat/irc/sources/orbit/public/plugins/third/orbit-room-gallery
ln -sf /home/chat/irc/sources/entrenous-orbit/plugins/orbit-room-gallery/orbit-room-gallery.js \
       /home/chat/irc/sources/orbit/public/plugins/third/orbit-room-gallery/orbit-room-gallery.js

mkdir -p /home/chat/irc/sources/orbit/public/plugins/third/orbit-conference
cp -f /home/chat/irc/sources/entrenous-orbit/plugins/orbit-conference/orbit-conference.js \
      /home/chat/irc/sources/orbit/public/plugins/third/orbit-conference/
```

Sur **webapp** (production), `deploy.sh` copie déjà `orbit-conference.js` vers `webchat-new/plugins/third/orbit-conference/` — si l’erreur persiste, relancer `./deploy.sh --force`.
