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

log() {
  echo "$(date -Is) $*"
}

trap 'echo "$(date -Is) ERROR line $LINENO: $BASH_COMMAND" >&2' ERR

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
# Video conference (Jitsi) — secrets live beside visio-jwt.php
CONFERENCE_DIR="plugins/third/orbit-conference"

# Orbit core filehost (composer /upload) — stays at web root
FILEHOST_UPLOAD_NAME="filehost-upload.php"
FILEHOST_FILES_DIR="files"

# --- pull both repos ---
log "sync orbit repo"
cd "$ORBIT_REPO"
git fetch --quiet origin "$ORBIT_BRANCH"
git checkout "$ORBIT_BRANCH" --quiet
git pull --ff-only --quiet origin "$ORBIT_BRANCH"
git branch --set-upstream-to="origin/$ORBIT_BRANCH" "$ORBIT_BRANCH" >/dev/null 2>&1 || true
ORBIT_HEAD=$(git rev-parse HEAD)

log "sync entrenous repo"
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

log "deploying orbit ${ORBIT_HEAD:0:8} + plugins ${PLUGINS_HEAD:0:8}"

# --- build Orbit (unchanged upstream tree) ---
log "install dependencies"
cd "$ORBIT_REPO"
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  npm ci
else
  log "WARN: no lockfile in $ORBIT_REPO, fallback to npm install"
  npm install
fi
log "build orbit"
npm run build

# --- publish Orbit dist, preserving runtime upload data + secrets ---
# IMPORTANT: any WEBROOT file not in dist/ is deleted by --delete unless
# excluded below. Operator secrets (*.local.php) must always be excluded.
log "publish orbit dist to webroot"
rsync -a --delete --backup --backup-dir="${WEBROOT}.bak" \
  --exclude="/$GALLERY_DIR/room-images.local.php" \
  --exclude="/$GALLERY_DIR/room-images.json" \
  --exclude="/$ROOM_IMAGES_UPLOADS_DIR" \
  --exclude="/$CONFERENCE_DIR/visio-jwt.local.php" \
  --exclude="/$FILEHOST_UPLOAD_NAME" \
  --exclude="/filehost-upload.local.php" \
  --exclude="/$FILEHOST_FILES_DIR" \
  --exclude="/chat-resume.local.php" \
  --exclude="/avatars.local.php" \
  --exclude="/handoff.php" \
  --exclude="/chat-resume.php" \
  --exclude="/room-images.php" \
  --exclude="/room-images.local.php" \
  --exclude="/room-images.json" \
  --exclude="/room-images-uploads" \
  --exclude="/.user.ini" \
  "$ORBIT_REPO/dist/" "$WEBROOT/"

# --- overlay EntreNous extras from THIS repo ---
log "overlay entrenous files"
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

# HelpServ welcome (AideMoi / SignalMoi query intro)
HELPSERV_WELCOME_DIR="plugins/third/orbit-helpserv-welcome"
mkdir -p "$WEBROOT/$HELPSERV_WELCOME_DIR"
cp -f "$PLUGINS_REPO/plugins/orbit-helpserv-welcome/orbit-helpserv-welcome.js" \
      "$WEBROOT/$HELPSERV_WELCOME_DIR/"

# Video conference (Jitsi). NEVER overwrite visio-jwt.local.php — rsync
# --delete is already excluded; only drop the example beside it once.
mkdir -p "$WEBROOT/$CONFERENCE_DIR"
if [ -f "$PLUGINS_REPO/plugins/orbit-conference/dist/orbit-conference.js" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-conference/dist/orbit-conference.js" \
        "$WEBROOT/$CONFERENCE_DIR/"
elif [ -f "$PLUGINS_REPO/plugins/orbit-conference/orbit-conference.js" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-conference/orbit-conference.js" \
        "$WEBROOT/$CONFERENCE_DIR/"
fi
if [ -f "$PLUGINS_REPO/plugins/orbit-conference/visio-jwt.php" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-conference/visio-jwt.php" \
        "$WEBROOT/$CONFERENCE_DIR/"
fi
if [ -f "$WEBROOT/$CONFERENCE_DIR/visio-jwt.local.php" ]; then
  echo "$(date -Is) keep $WEBROOT/$CONFERENCE_DIR/visio-jwt.local.php (secrets preserved)"
elif [ -f "$PLUGINS_REPO/plugins/orbit-conference/visio-jwt.local.php.example" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-conference/visio-jwt.local.php.example" \
        "$WEBROOT/$CONFERENCE_DIR/visio-jwt.local.php.example"
  echo "$(date -Is) NOTE: create $WEBROOT/$CONFERENCE_DIR/visio-jwt.local.php (EXTJWT + Jitsi token secrets)"
fi

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
# PHP-FPM upload limits for /upload (gallery already has its own .user.ini).
# Keep WEBROOT/.user.ini across rsync --delete (excluded above), then refresh.
if [ -f "$PLUGINS_REPO/server/filehost/.user.ini" ]; then
  cp -f "$PLUGINS_REPO/server/filehost/.user.ini" "$WEBROOT/.user.ini"
  echo "$(date -Is) installed $WEBROOT/.user.ini (upload_max_filesize)"
else
  echo "$(date -Is) WARN: missing $PLUGINS_REPO/server/filehost/.user.ini — WEBROOT upload limit may stay at PHP default 2M"
fi
# NEVER overwrite filehost-upload.local.php — only drop the example beside it once.
if [ -f "$WEBROOT/filehost-upload.local.php" ]; then
  echo "$(date -Is) keep $WEBROOT/filehost-upload.local.php (secrets preserved)"
elif [ -f "$PLUGINS_REPO/server/filehost/filehost-upload.local.php.example" ]; then
  cp -f "$PLUGINS_REPO/server/filehost/filehost-upload.local.php.example" "$WEBROOT/filehost-upload.local.php.example"
  echo "$(date -Is) NOTE: create $WEBROOT/filehost-upload.local.php (JWT secret = ircd <filehost>)"
fi

# WordPress → Orbit SASL handoff bridge (same-origin sessionStorage + resume cookie)
cp -f "$PLUGINS_REPO/server/handoff/handoff.php" "$WEBROOT/handoff.php"
cp -f "$PLUGINS_REPO/server/handoff/chat-resume.php" "$WEBROOT/chat-resume.php"
cp -f "$PLUGINS_REPO/server/handoff/wp-profile-gecos.inc.php" "$WEBROOT/wp-profile-gecos.inc.php"
cp -f "$PLUGINS_REPO/server/handoff/profile-gecos.php" "$WEBROOT/profile-gecos.php"
# NEVER overwrite chat-resume.local.php — only drop the example beside it once.
if [ -f "$WEBROOT/chat-resume.local.php" ]; then
  echo "$(date -Is) keep $WEBROOT/chat-resume.local.php (secrets preserved)"
elif [ -f "$PLUGINS_REPO/server/handoff/chat-resume.local.php.example" ]; then
  cp -f "$PLUGINS_REPO/server/handoff/chat-resume.local.php.example" "$WEBROOT/chat-resume.local.php.example"
  echo "$(date -Is) NOTE: create $WEBROOT/chat-resume.local.php (JWT secret = WordPress / oauthbearer)"
fi

# WordPress profile avatars → Orbit POST /accounts/api/avatars/
# (rewrite in config/.htaccess). Keep avatars.local.php if present.
cp -f "$PLUGINS_REPO/server/avatars/avatars.php" "$WEBROOT/avatars.php"

# OpenGraph unfurl for Orbit link previews (GET /accounts/api/unfurl/?url=)
cp -f "$PLUGINS_REPO/server/unfurl/unfurl.php" "$WEBROOT/unfurl.php"

# Ensure runtime upload dirs exist (PHP also mkdir's, but first deploy often
# fails on permissions if the parent isn't ready — create + relax ownership).
log "ensure runtime directories"
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

# Drop obsolete web-root gallery copies once the plugin bundle is in place.
# (rsync --exclude kept them forever; the JS only talks to $GALLERY_DIR/.)
if [ -f "$WEBROOT/$GALLERY_DIR/room-images.php" ]; then
  for stale in \
    "$WEBROOT/room-images.php" \
    "$WEBROOT/room-images.local.php" \
    "$WEBROOT/room-images.json"
  do
    if [ -e "$stale" ]; then
      rm -f "$stale"
      echo "$(date -Is) removed obsolete $(basename "$stale") from WEBROOT (use $GALLERY_DIR/)"
    fi
  done
  # Empty leftover uploads dir only — never delete if it still has files.
  if [ -d "$WEBROOT/room-images-uploads" ] \
    && [ -z "$(find "$WEBROOT/room-images-uploads" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]; then
    rmdir "$WEBROOT/room-images-uploads" 2>/dev/null \
      && echo "$(date -Is) removed empty WEBROOT/room-images-uploads/"
  elif [ -d "$WEBROOT/room-images-uploads" ]; then
    echo "$(date -Is) NOTE: WEBROOT/room-images-uploads/ still has files — migrate/merge then delete manually"
  fi
fi

log "write deployed marker"
echo "$COMBO" > "$DEPLOYED_MARKER"
log "deployed orbit=$(cd "$ORBIT_REPO" && git rev-parse --short HEAD) plugins=$(cd "$PLUGINS_REPO" && git rev-parse --short HEAD)"
