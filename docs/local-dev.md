# Développement local du plugin contre Orbit

Pour tester `orbit-room-gallery.js` avec `npm run dev` dans le clone Orbit :

## Windows (PowerShell, en Admin si besoin)

```powershell
New-Item -ItemType SymbolicLink `
  -Path "C:\Users\famil\orbit\public\plugins\third\orbit-room-gallery.js" `
  -Target "C:\Users\famil\entrenous-orbit\plugins\orbit-room-gallery.js"
```

Puis dans `orbit/public/config.json`, ajoute temporairement (ne pas committer) :

```json
"/app/plugins/third/orbit-room-gallery.js?v=dev"
```

Ou copie `entrenous-orbit/config/config.json` par-dessus pour un test complet EntreNous.

## Linux / serveur

```bash
ln -sf /home/chat/irc/sources/entrenous-orbit/plugins/orbit-room-gallery.js \
       /home/chat/irc/sources/orbit-en/public/plugins/third/orbit-room-gallery.js
```
