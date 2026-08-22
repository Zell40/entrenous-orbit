#!/usr/bin/env bash
# EntreNous deploy: build clean upstream Orbit, then overlay this repo's
# plugins / PHP sidecars / config on top of the web root.
#
# Layout on the server (recommended):
#   /home/chat/irc/sources/orbit              ← clean Orbit (matches GitHub name)
#   /home/chat/irc/sources/entrenous-orbit   ← THIS repo
#   /home/chat/irc/webchat-new               ← test (webapp2.entrenous.chat)
#   /home/chat/irc/webchat                   ← prod (webapp.entrenous.chat)
#
#   ./deploy.sh                 # test, if Orbit or this repo moved
#   ./deploy.sh --force         # rebuild + publish test anyway
#   ./deploy.sh --prod          # same overlay → webchat (manuel only)
#   ./deploy.sh --prod --force
#
# Cron = test only. Never add --prod to cron, or every test commit goes live:
#   */5 * * * * /home/chat/irc/sources/entrenous-orbit/deploy.sh >> /var/log/orbit-deploy.log 2>&1
set -euo pipefail

log() {
  echo "$(date -Is) $*"
}

usage() {
  cat <<'EOF'
Usage: deploy.sh [--force] [--prod]

  (default)  Publish to /home/chat/irc/webchat-new (webapp2)
  --prod     Publish to /home/chat/irc/webchat (webapp) — manuel only, never cron
  --force    Rebuild even if both repos are unchanged
EOF
}

DEPLOY_PROD=0
DEPLOY_FORCE=0
for arg in "$@"; do
  case "$arg" in
    --prod) DEPLOY_PROD=1 ;;
    --force) DEPLOY_FORCE=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

trap 'echo "$(date -Is) ERROR line $LINENO: $BASH_COMMAND" >&2' ERR

ORBIT_REPO="/home/chat/irc/sources/orbit"
PLUGINS_REPO="/home/chat/irc/sources/entrenous-orbit"
ORBIT_BRANCH="main"          # upstream Orbit default branch
PLUGINS_BRANCH="master"

WEBROOT="/home/chat/irc/webchat-new"
# Marker records BOTH commit hashes so a change in either repo triggers a deploy.
# Prod uses a separate file so a test publish does not skip a later --prod.
DEPLOYED_MARKER="$PLUGINS_REPO/.last-deployed-commits"
if [ "$DEPLOY_PROD" = 1 ]; then
  WEBROOT="/home/chat/irc/webchat"
  DEPLOYED_MARKER="$PLUGINS_REPO/.last-deployed-commits-prod"
fi

# Refuse rsync --delete over a live Kiwi tree (index/static layout).
webroot_looks_like_kiwi() {
  local root="$1"
  [ -d "$root" ] || return 1
  if [ -f "$root/index.html" ] && grep -qiE 'kiwiirc|kiwi-irc' "$root/index.html"; then
    return 0
  fi
  if [ -d "$root/static" ] && [ ! -d "$root/assets" ]; then
    return 0
  fi
  if [ -f "$root/kiwi.json" ] || [ -f "$root/static/js/kiwiirc.js" ]; then
    return 0
  fi
  return 1
}

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

# git pull may have replaced this script on disk; the current shell still runs
# the version that was loaded at startup — re-exec once so new deploy steps apply.
if [ "${ENTRENOUS_DEPLOY_REEXEC:-}" != 1 ]; then
  export ENTRENOUS_DEPLOY_REEXEC=1
  exec bash "$PLUGINS_REPO/deploy.sh" "$@"
fi

COMBO="${ORBIT_HEAD}+${PLUGINS_HEAD}"
LAST=""
[ -f "$DEPLOYED_MARKER" ] && LAST=$(cat "$DEPLOYED_MARKER")

if [ "$LAST" = "$COMBO" ] && [ "$DEPLOY_FORCE" != 1 ]; then
  echo "$(date -Is) already deployed orbit=${ORBIT_HEAD:0:8} plugins=${PLUGINS_HEAD:0:8} -> $WEBROOT"
  exit 0
fi

if [ "$DEPLOY_PROD" = 1 ] && webroot_looks_like_kiwi "$WEBROOT"; then
  log "ERROR: $WEBROOT ressemble encore à Kiwi — refus d'écraser (rsync --delete)."
  log "Backup d'abord :"
  log "  mv $WEBROOT ${WEBROOT}-kiwi-\$(date +%Y%m%d) && mkdir -p $WEBROOT"
  log "puis : $PLUGINS_REPO/deploy.sh --prod"
  exit 1
fi

if [ "$DEPLOY_PROD" = 1 ]; then
  log "cible PROD $WEBROOT"
else
  log "cible TEST $WEBROOT"
fi

log "deploying orbit ${ORBIT_HEAD:0:8} + plugins ${PLUGINS_HEAD:0:8} -> $WEBROOT"

log "build orbit"
cd "$ORBIT_REPO"
BUILD_LOG="$(mktemp)"
cleanup_build_log() { rm -f "$BUILD_LOG"; }
trap cleanup_build_log EXIT
NPM_FLAGS=(--no-fund --no-audit --loglevel=error)
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  if ! npm ci "${NPM_FLAGS[@]}" >"$BUILD_LOG" 2>&1; then
    log "ERROR npm ci failed"
    cat "$BUILD_LOG" >&2
    exit 1
  fi
else
  if ! npm install "${NPM_FLAGS[@]}" >"$BUILD_LOG" 2>&1; then
    log "ERROR npm install failed"
    cat "$BUILD_LOG" >&2
    exit 1
  fi
fi
if ! npm run build >"$BUILD_LOG" 2>&1; then
  log "ERROR npm run build failed"
  cat "$BUILD_LOG" >&2
  exit 1
fi
cleanup_build_log
trap 'echo "$(date -Is) ERROR line $LINENO: $BASH_COMMAND" >&2' ERR
log "build orbit ok"

# --- publish Orbit dist, preserving runtime upload data + secrets ---
# IMPORTANT: any WEBROOT file not in dist/ is deleted by --delete unless
# excluded below. Operator secrets (*.local.php) must always be excluded.
log "publish orbit dist to webroot"
rsync -a --delete --backup --backup-dir="${WEBROOT}.bak" \
  --exclude="/$GALLERY_DIR/room-images.local.php" \
  --exclude="/$GALLERY_DIR/room-images.json" \
  --exclude="/$ROOM_IMAGES_UPLOADS_DIR" \
  --exclude="/$CONFERENCE_DIR/visio-jwt.local.php" \
  --exclude="/$CONFERENCE_DIR/" \
  --exclude="/plugins/third/orbit-helpserv-welcome/" \
  --exclude="/plugins/third/orbit-petitbac/" \
  --exclude="/plugins/third/orbit-bac-live/" \
  --exclude="/plugins/third/orbit-echecs/" \
  --exclude="/plugins/third/orbit-harrypotter/" \
  --exclude="/plugins/third/orbit-callerid/" \
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

# Petit Bac (Limnoria TAGMSG UI)
PETITBAC_DIR="plugins/third/orbit-petitbac"

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

# Petit Bac — Orbit overlay for Limnoria game TAGMSG (incl. live board)
mkdir -p "$WEBROOT/$PETITBAC_DIR/assets"
cp -f "$PLUGINS_REPO/plugins/orbit-petitbac/orbit-petitbac.js" \
      "$WEBROOT/$PETITBAC_DIR/"
if [ -d "$PLUGINS_REPO/plugins/orbit-petitbac/assets" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-petitbac/assets/"*.svg \
        "$WEBROOT/$PETITBAC_DIR/assets/" 2>/dev/null || true
fi

# Échecs (CapEchecs TAGMSG UI)
ECHECS_DIR="plugins/third/orbit-echecs"
mkdir -p "$WEBROOT/$ECHECS_DIR/assets"
cp -f "$PLUGINS_REPO/plugins/orbit-echecs/orbit-echecs.js" \
      "$WEBROOT/$ECHECS_DIR/"
if [ -d "$PLUGINS_REPO/plugins/orbit-echecs/assets" ]; then
  cp -f "$PLUGINS_REPO/plugins/orbit-echecs/assets/"* \
        "$WEBROOT/$ECHECS_DIR/assets/" 2>/dev/null || true
fi

# Harry Potter (Limnoria TAGMSG UI)
HARRYPOTTER_DIR="plugins/third/orbit-harrypotter"
mkdir -p "$WEBROOT/$HARRYPOTTER_DIR"
cp -f "$PLUGINS_REPO/plugins/orbit-harrypotter/orbit-harrypotter.js" \
      "$WEBROOT/$HARRYPOTTER_DIR/"

# CallerID / contrôle parental (ACCEPT + modes)
CALLERID_DIR="plugins/third/orbit-callerid"
mkdir -p "$WEBROOT/$CALLERID_DIR"
cp -f "$PLUGINS_REPO/plugins/orbit-callerid/orbit-callerid.js" \
      "$WEBROOT/$CALLERID_DIR/"

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

if [ ! -f "$WEBROOT/$PETITBAC_DIR/orbit-petitbac.js" ]; then
  log "ERROR: missing $WEBROOT/$PETITBAC_DIR/orbit-petitbac.js after overlay"
  exit 1
fi
if ! grep -q 'orbit-petitbac' "$WEBROOT/config.json"; then
  log "ERROR: config.json missing orbit-petitbac plugin entry"
  exit 1
fi
log "verified orbit-petitbac (plugin file + config.json entry)"

if [ ! -f "$WEBROOT/$ECHECS_DIR/orbit-echecs.js" ]; then
  log "ERROR: missing $WEBROOT/$ECHECS_DIR/orbit-echecs.js after overlay"
  exit 1
fi
if ! grep -q 'orbit-echecs' "$WEBROOT/config.json"; then
  log "ERROR: config.json missing orbit-echecs plugin entry"
  exit 1
fi
log "verified orbit-echecs (plugin file + config.json entry)"

if [ ! -f "$WEBROOT/$HARRYPOTTER_DIR/orbit-harrypotter.js" ]; then
  log "ERROR: missing $WEBROOT/$HARRYPOTTER_DIR/orbit-harrypotter.js after overlay"
  exit 1
fi
if ! grep -q 'orbit-harrypotter' "$WEBROOT/config.json"; then
  log "ERROR: config.json missing orbit-harrypotter plugin entry"
  exit 1
fi
log "verified orbit-harrypotter (plugin file + config.json entry)"

log "deployed orbit=$(cd "$ORBIT_REPO" && git rev-parse --short HEAD) plugins=$(cd "$PLUGINS_REPO" && git rev-parse --short HEAD) webroot=$WEBROOT"
