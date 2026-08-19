#!/usr/bin/env bash
# jitsi-update.sh — vérification et mise à jour de docker-jitsi-meet.
#
# Usage :
#   ./jitsi-update.sh             # vérification seule (mode check)
#   ./jitsi-update.sh --update    # mise à jour si disponible
#   ./jitsi-update.sh --force     # mise à jour même si déjà à jour
#
# Cron recommandé (vérification quotidienne à 07h00) :
#   0 7 * * * /home/chat/irc/jitsi-docker-jitsi-meet-738058b/jitsi-update.sh \
#             >> /var/log/jitsi-update.log 2>&1
#
# Dépendances : docker, curl, python3 (ou jq), bash ≥ 4
# -----------------------------------------------------------------------------
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
JITSI_DIR="${JITSI_DIR:-/home/chat/irc/jitsi-docker-jitsi-meet-738058b}"
ENV_FILE="${ENV_FILE:-$JITSI_DIR/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-$(dirname "$JITSI_DIR")}"
# Fichier qui mémorise le dernier tag connu pour ne pas notifier deux fois.
KNOWN_FILE="${KNOWN_FILE:-/var/tmp/jitsi-last-known-tag}"
# Adresse e-mail pour la notification (vide = pas d'e-mail, juste le log).
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
# Commande mail (sendmail, msmtp, mail…).  Ignorée si NOTIFY_EMAIL est vide.
MAILER="${MAILER:-mail}"
# Nombre de secondes avant timeout des appels curl.
CURL_TIMEOUT=10
# -----------------------------------------------------------------------------

MODE="check"
[[ "${1:-}" == "--update" ]] && MODE="update"
[[ "${1:-}" == "--force"  ]] && MODE="force"

TS=$(date '+%Y-%m-%d %H:%M:%S')
LOGPFX="[$TS][jitsi-update]"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "$LOGPFX $*"; }
warn() { echo "$LOGPFX WARN: $*" >&2; }
die()  { echo "$LOGPFX ERROR: $*" >&2; exit 1; }

notify() {
    local subject="$1" body="$2"
    log "$subject"
    if [[ -n "$NOTIFY_EMAIL" ]]; then
        echo "$body" | $MAILER -s "$subject" "$NOTIFY_EMAIL" 2>/dev/null \
            || warn "Envoi de l'e-mail échoué (mailer=$MAILER)"
    fi
}

# ── Lecture de la version courante ────────────────────────────────────────────
read_current_version() {
    if [[ ! -f "$ENV_FILE" ]]; then
        die ".env introuvable : $ENV_FILE"
    fi
    local ver
    ver=$(grep -E '^JITSI_IMAGE_VERSION=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]"')
    if [[ -z "$ver" ]]; then
        # certaines installations utilisent des tags implicites dans docker-compose.yml
        ver=$(grep -E 'image:.*jitsi' "$JITSI_DIR/docker-compose.yml" 2>/dev/null \
              | head -1 | sed 's/.*:\([^ ]*\).*/\1/' | tr -d '[:space:]' || true)
    fi
    echo "${ver:-unknown}"
}

# ── Récupération du dernier tag GitHub ────────────────────────────────────────
fetch_latest_tag() {
    local api_url="https://api.github.com/repos/jitsi/docker-jitsi-meet/releases/latest"
    local tag
    # Préfère jq si disponible, sinon python3, sinon grep/sed.
    if command -v jq &>/dev/null; then
        tag=$(curl -fsSL --max-time "$CURL_TIMEOUT" "$api_url" | jq -r '.tag_name')
    elif command -v python3 &>/dev/null; then
        tag=$(curl -fsSL --max-time "$CURL_TIMEOUT" "$api_url" \
              | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
    else
        tag=$(curl -fsSL --max-time "$CURL_TIMEOUT" "$api_url" \
              | grep -o '"tag_name":"[^"]*"' | head -1 | sed 's/"tag_name":"//;s/"//')
    fi
    echo "${tag:-}"
}

create_full_backup() {
    local stamp backup_dir
    stamp=$(date +%Y%m%d%H%M%S)
    backup_dir="$BACKUP_ROOT/$(basename "$JITSI_DIR").bak.$stamp"

    [[ -d "$JITSI_DIR" ]] || die "Répertoire Jitsi introuvable : $JITSI_DIR"
    [[ ! -e "$backup_dir" ]] || die "Le dossier de sauvegarde existe déjà : $backup_dir"

    echo "$LOGPFX Création de la sauvegarde complète : $backup_dir" >&2
    cp -a "$JITSI_DIR" "$backup_dir"
    echo "$LOGPFX Sauvegarde complète terminée" >&2

    echo "$backup_dir"
}

# ── Procédure de mise à jour ───────────────────────────────────────────────────
do_update() {
    local latest="$1" backup_dir
    log "=== Début de la mise à jour vers $latest ==="

    cd "$JITSI_DIR"

    # 1. Sauvegarde complète du dossier Jitsi
    backup_dir=$(create_full_backup)

    # 2. Sauvegarder aussi le .env actuel séparément
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    log ".env sauvegardé"

    # 3. Mettre à jour JITSI_IMAGE_VERSION dans le .env
    if grep -qE '^JITSI_IMAGE_VERSION=' "$ENV_FILE"; then
        sed -i "s|^JITSI_IMAGE_VERSION=.*|JITSI_IMAGE_VERSION=$latest|" "$ENV_FILE"
        log "JITSI_IMAGE_VERSION mis à jour → $latest"
    else
        echo "JITSI_IMAGE_VERSION=$latest" >> "$ENV_FILE"
        log "JITSI_IMAGE_VERSION ajouté → $latest"
    fi

    # 4. Tirer les nouvelles images
    log "docker compose pull..."
    docker compose pull 2>&1 | sed "s/^/$LOGPFX [docker] /"

    # 5. Recréer les containers
    log "docker compose up -d --remove-orphans..."
    docker compose up -d --remove-orphans 2>&1 | sed "s/^/$LOGPFX [docker] /"

    # 6. Vérification rapide (attendre 10s que les containers démarrent)
    sleep 10
    local status
    status=$(docker compose ps --format '{{.Name}}: {{.Status}}' 2>/dev/null || docker compose ps)
    log "=== État après mise à jour ==="
    echo "$status" | sed "s/^/$LOGPFX /"

    # Détecter un container en erreur
    if echo "$status" | grep -qiE '(exit|error|restarting)'; then
        notify "[JITSI] ⚠ Mise à jour $latest : container(s) en erreur" \
"La mise à jour docker-jitsi-meet vers $latest a été appliquée MAIS certains
containers semblent en erreur.

État :
$status

Vérifier avec : docker compose -f $JITSI_DIR/docker-compose.yml logs

Sauvegarde disponible :
$backup_dir
"
        return 1
    fi

    # 7. Mémoriser le tag mis à jour
    echo "$latest" > "$KNOWN_FILE"

    notify "[JITSI] ✅ Mise à jour $latest réussie" \
"docker-jitsi-meet a été mis à jour vers $latest avec succès.

Répertoire : $JITSI_DIR
Sauvegarde : $backup_dir
Date       : $TS

État des containers :
$status
"
    log "=== Mise à jour $latest terminée avec succès ==="
}

# ── Main ──────────────────────────────────────────────────────────────────────
current=$(read_current_version)
log "Version actuelle : $current"

log "Interrogation de GitHub..."
latest=$(fetch_latest_tag)

if [[ -z "$latest" ]]; then
    warn "Impossible de récupérer le dernier tag (réseau ou API GitHub indisponible)."
    exit 0
fi

log "Dernière version disponible : $latest"

# Lire le dernier tag notifié pour éviter les doublons
known=""
[[ -f "$KNOWN_FILE" ]] && known=$(cat "$KNOWN_FILE" | tr -d '[:space:]')

if [[ "$latest" == "$current" ]] && [[ "$MODE" != "force" ]]; then
    log "Déjà à jour ($current). Rien à faire."
    exit 0
fi

if [[ "$latest" == "$known" ]] && [[ "$MODE" == "check" ]]; then
    log "Mise à jour $latest déjà signalée. Relancer avec --update pour l'appliquer."
    exit 0
fi

# ── Notification ou mise à jour selon le mode ─────────────────────────────────
case "$MODE" in
    check)
        notify "[JITSI] 🔔 Mise à jour disponible : $latest (actuel : $current)" \
"Une nouvelle version de docker-jitsi-meet est disponible.

  Actuelle  : $current
  Disponible: $latest

Pour appliquer la mise à jour, exécuter sur le serveur :
  $JITSI_DIR/jitsi-update.sh --update

Ou si ce script n'est pas encore en place :
  cd $JITSI_DIR && docker compose pull && docker compose up -d --remove-orphans
"
        echo "$latest" > "$KNOWN_FILE"
        ;;
    update|force)
        do_update "$latest"
        ;;
esac
