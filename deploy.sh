#!/usr/bin/env bash
# EntreNous deploy: build clean upstream Orbit, then overlay this repo's
# plugins / PHP sidecars / config on top of the web root.
#
# Layout on the server (recommended):
#   /home/chat/irc/sources/orbit              ← clean Orbit (matches GitHub name)
#   /home/chat/irc/sources/entrenous-orbit   ← THIS repo
#   /home/chat/irc/webchat-new               ← live web root
#
#   ./deploy.sh          # deploy if Orbit or this repo moved since last publish
#   ./deploy.sh --force  # rebuild + publish anyway
#
# Cron example:
#   */5 * * * * /home/chat/irc/sources/entrenous-orbit/deploy.sh >> /var/log/orbit-deploy.log 2>&1
set -euo pipefail

ORBIT_REPO="/home/chat/irc/sources/orbit"
PLUGINS_REPO="/home/chat/irc/sources/entrenous-orbit"
WEBROOT="/home/chat/irc/webchat-new"
ORBIT_BRANCH="main"          # upstream Orbit default branch
PLUGINS_BRANCH="master"

# Marker records BOTH commit hashes so a change in either repo triggers a deploy.
DEPLOYED_MARKER="$PLUGINS_REPO/.last-deployed-commits"

# Gallery plugin bundle (JS + room-images.php + uploads)
GALLERY_DIR="plugins/third/orbit-room-gallery"
ROOM_IMAGES_UPLOADS_DIR="$GALLERY_DIR/room-images-uploads"

# Orbit core filehost (composer /upload) — stays at web root
FILEHOST_UPLOAD_NAME="filehost-upload.php"
FILEHOST_FILES_DIR="files"

# --- pull both repos ---
cd "$ORBIT_REPO"
git fetch --quiet origin "$ORBIT_BRANCH"
git checkout "$ORBIT_BRANCH" --quiet
git pull --ff-only --quiet origin "$ORBIT_BRANCH"
git branch --set-upstream-to="origin/$ORBIT_BRANCH" "$ORBIT_BRANCH" >/dev/null 2>&1 || true
ORBIT_HEAD=$(git rev-parse HEAD)

cd "$PLUGINS_REPO"
git fetch --quiet origin "$PLUGINS_BRANCH"
git checkout "$PLUGINS_BRANCH" --quiet
git pull --ff-only --quiet origin "$PLUGINS_BRANCH"
git branch --set-upstream-to="origin/$PLUGINS_BRANCH" "$PLUGINS_BRANCH" >/dev/null 2>&1 || true
PLUGINS_HEAD=$(git rev-parse HEAD)

COMBO="${ORBIT_HEAD}+${PLUGINS_HEAD}"
LAST=""
[ -f "$DEPLOYED_MARKER" ] && LAST=$(cat "$DEPLOYED_MARKER")

if [ "$LAST" = "$COMBO" ] && [ "${1:-}" != "--force" ]; then
  echo "$(date -Is) already deployed orbit=${ORBIT_HEAD:0:8} plugins=${PLUGINS_HEAD:0:8}"
  exit 0
fi

echo "$(date -Is) deploying orbit ${ORBIT_HEAD:0:8} + plugins ${PLUGINS_HEAD:0:8}"

# --- build Orbit (unchanged upstream tree) ---
cd "$ORBIT_REPO"
npm ci --silent
npm run test
npm run build

# --- publish Orbit dist, preserving runtime upload data + secrets ---
rsync -a --delete --backup --backup-dir="${WEBROOT}.bak" \
  --exclude="/$GALLERY_DIR/room-images.local.php" \
  --exclude="/$GALLERY_DIR/room-images.json" \
  --exclude="/$ROOM_IMAGES_UPLOADS_DIR" \
  --exclude="/$FILEHOST_UPLOAD_NAME" \
  --exclude="/filehost-upload.local.php" \
  --exclude="/$FILEHOST_FILES_DIR" \
  --exclude="/room-images.php" \
  --exclude="/room-images.local.php" \
  --exclude="/room-images.json" \
  --exclude="/room-images-uploads" \
  "$ORBIT_REPO/dist/" "$WEBROOT/"

# --- overlay EntreNous extras from THIS repo ---
mkdir -p "$WEBROOT/$GALLERY_DIR"
cp -f "$PLUGINS_REPO/plugins/orbit-room-gallery/orbit-room-gallery.js" \
      "$WEBROOT/$GALLERY_DIR/"
cp -f "$PLUGINS_REPO/plugins/orbit-room-gallery/room-images.php" \
      "$WEBROOT/$GALLERY_DIR/"
# PHP upload limits (FPM reads .user.ini; mod_php can use .htaccess)
cp -f "$PLUGINS_REPO/plugins/orbit-room-gallery/.user.ini" \
      "$WEBROOT/$GALLERY_DIR/.user.ini"
cp -f "$PLUGINS_REPO/plugins/orbit-room-gallery/.htaccess" \
      "$WEBROOT/$GALLERY_DIR/.htaccess"

# Runtime config + Apache rewrite for /upload
cp -f "$PLUGINS_REPO/config/config.json" "$WEBROOT/config.json"
cp -f "$PLUGINS_REPO/config/.htaccess" "$WEBROOT/.htaccess"

# PWA manifest (EntreNous branding) — avoid Play Store “related app” traps
if [ -f "$PLUGINS_REPO/config/manifest.webmanifest" ]; then
  cp -f "$PLUGINS_REPO/config/manifest.webmanifest" "$WEBROOT/manifest.webmanifest"
fi
# Optional branded icons (icon-192.png / icon-512.png / apple-touch-icon.png)
if [ -d "$PLUGINS_REPO/config/pwa-icons" ]; then
  cp -f "$PLUGINS_REPO/config/pwa-icons/"*.png "$WEBROOT/" 2>/dev/null || true
fi

# Filehost PHP at web root (Orbit core /upload — not part of the gallery plugin)
cp -f "$PLUGINS_REPO/server/filehost/filehost-upload.php" "$WEBROOT/$FILEHOST_UPLOAD_NAME"

# WordPress → Orbit SASL handoff bridge (same-origin sessionStorage)
cp -f "$PLUGINS_REPO/server/handoff/handoff.php" "$WEBROOT/handoff.php"

# WordPress profile avatars → Orbit POST /accounts/api/avatars/
# (rewrite in config/.htaccess). Keep avatars.local.php if present.
cp -f "$PLUGINS_REPO/server/avatars/avatars.php" "$WEBROOT/avatars.php"

# Ensure runtime upload dirs exist (PHP also mkdir's, but first deploy often
# fails on permissions if the parent isn't ready — create + relax ownership).
mkdir -p "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR" "$WEBROOT/$FILEHOST_FILES_DIR"
chmod 2775 "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR" "$WEBROOT/$FILEHOST_FILES_DIR" 2>/dev/null || true
# Map file must be group-writable: www-data is in group `users`, deploy runs as `chat`.
if [ -f "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR/room-images.json" ]; then
  chmod 664 "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR/room-images.json" 2>/dev/null || true
fi

# One-time migration from the old web-root layout (room-images.php + uploads
# at WEBROOT/) into plugins/third/orbit-room-gallery/.
# Never migrate a "local" that is actually a full copy of the main PHP —
# requiring that causes infinite recursion and HTTP 500.
if [ -f "$WEBROOT/room-images.local.php" ] && [ ! -f "$WEBROOT/$GALLERY_DIR/room-images.local.php" ]; then
  if cmp -s "$WEBROOT/room-images.local.php" "$WEBROOT/$GALLERY_DIR/room-images.php" 2>/dev/null \
     || cmp -s "$WEBROOT/room-images.local.php" "$PLUGINS_REPO/plugins/orbit-room-gallery/room-images.php" 2>/dev/null; then
    echo "$(date -Is) SKIP migrate room-images.local.php (looks like a full script copy, not secrets)"
  else
    cp -a "$WEBROOT/room-images.local.php" "$WEBROOT/$GALLERY_DIR/room-images.local.php"
    echo "$(date -Is) migrated room-images.local.php → $GALLERY_DIR/"
  fi
fi
if [ -d "$WEBROOT/room-images-uploads" ] && [ -z "$(find "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]; then
  # Move contents (keep dir itself so old exclude/paths don't surprise Apache)
  shopt -s dotglob nullglob
  for item in "$WEBROOT/room-images-uploads"/*; do
    mv "$item" "$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR/"
  done
  shopt -u dotglob nullglob
  echo "$(date -Is) migrated room-images-uploads/ → $ROOM_IMAGES_UPLOADS_DIR/"
fi
# Rewrite absolute URLs inside the map that still point at the old web-root path.
# Guard against re-running: only touch maps that do not already use the new prefix.
MAP="$WEBROOT/$ROOM_IMAGES_UPLOADS_DIR/room-images.json"
if [ -f "$MAP" ] \
  && grep -q '/room-images-uploads/' "$MAP" 2>/dev/null \
  && ! grep -q 'orbit-room-gallery/room-images-uploads' "$MAP" 2>/dev/null; then
  sed -i \
    -e 's|/room-images-uploads/|/app/plugins/third/orbit-room-gallery/room-images-uploads/|g' \
    "$MAP"
  echo "$(date -Is) rewrote legacy room-images URLs in room-images.json"
fi

echo "$COMBO" > "$DEPLOYED_MARKER"
echo "$(date -Is) deployed orbit=$(cd "$ORBIT_REPO" && git rev-parse --short HEAD) plugins=$(cd "$PLUGINS_REPO" && git rev-parse --short HEAD)"
