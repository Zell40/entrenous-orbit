#!/usr/bin/env bash
# EntreNous deploy: build clean upstream Orbit, then overlay this repo's
# plugins / PHP sidecars / config on top of the web root.
#
# Layout on the server (recommended):
#   /home/chat/irc/sources/orbit-en          ← clean Orbit (upstream only)
#   /home/chat/irc/sources/entrenous-orbit   ← THIS repo
#   /home/chat/irc/webchat-new               ← live web root
#
#   ./deploy.sh          # deploy if Orbit or this repo moved since last publish
#   ./deploy.sh --force  # rebuild + publish anyway
#
# Cron example:
#   */5 * * * * /home/chat/irc/sources/entrenous-orbit/deploy.sh >> /var/log/orbit-deploy.log 2>&1
set -euo pipefail

ORBIT_REPO="/home/chat/irc/sources/orbit-en"
PLUGINS_REPO="/home/chat/irc/sources/entrenous-orbit"
WEBROOT="/home/chat/irc/webchat-new"
ORBIT_BRANCH="master"
PLUGINS_BRANCH="master"

# Marker records BOTH commit hashes so a change in either repo triggers a deploy.
DEPLOYED_MARKER="$PLUGINS_REPO/.last-deployed-commits"

ROOM_IMAGES_NAME="room-images.php"
ROOM_IMAGES_UPLOADS_DIR="room-images-uploads"
FILEHOST_UPLOAD_NAME="filehost-upload.php"
FILEHOST_FILES_DIR="files"

# --- pull both repos ---
cd "$ORBIT_REPO"
git fetch --quiet origin "$ORBIT_BRANCH"
git checkout "$ORBIT_BRANCH" --quiet
git pull --ff-only --quiet
ORBIT_HEAD=$(git rev-parse HEAD)

cd "$PLUGINS_REPO"
git fetch --quiet origin "$PLUGINS_BRANCH"
git checkout "$PLUGINS_BRANCH" --quiet
git pull --ff-only --quiet
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

# --- publish Orbit dist, preserving runtime upload data ---
rsync -a --delete --backup --backup-dir="${WEBROOT}.bak" \
  --exclude="/$ROOM_IMAGES_NAME" --exclude="/room-images.json" --exclude="/$ROOM_IMAGES_UPLOADS_DIR" \
  --exclude="/$FILEHOST_UPLOAD_NAME" --exclude="/$FILEHOST_FILES_DIR" \
  "$ORBIT_REPO/dist/" "$WEBROOT/"

# --- overlay EntreNous extras from THIS repo ---
# Custom plugins land next to Orbit's own public/plugins/third/* copies.
mkdir -p "$WEBROOT/plugins/third"
cp -f "$PLUGINS_REPO/plugins/"*.js "$WEBROOT/plugins/third/"

# Runtime config + Apache rewrite for /upload
cp -f "$PLUGINS_REPO/config/config.json" "$WEBROOT/config.json"
cp -f "$PLUGINS_REPO/config/.htaccess" "$WEBROOT/.htaccess"

# PHP sidecars (secrets stay in untouched *.local.php siblings)
cp -f "$PLUGINS_REPO/server/room-images/room-images.php" "$WEBROOT/$ROOM_IMAGES_NAME"
cp -f "$PLUGINS_REPO/server/filehost/filehost-upload.php" "$WEBROOT/$FILEHOST_UPLOAD_NAME"

echo "$COMBO" > "$DEPLOYED_MARKER"
echo "$(date -Is) deployed orbit=$(cd "$ORBIT_REPO" && git rev-parse --short HEAD) plugins=$(cd "$PLUGINS_REPO" && git rev-parse --short HEAD)"
