#!/usr/bin/env bash
# jitsi-motd.sh — état de Jitsi Meet + alerte MAJ, affiché à la connexion SSH.
#
# Deux modes d'installation (au choix) :
#
# A) SANS root — ajouter dans ~/.bash_profile ou ~/.profile de l'user chat :
#      source ~/jitsi-motd.sh
#    (ou copier le fichier où tu veux et sourcer depuis ~/.bash_profile)
#
# B) AVEC root — affichage pour tous les utilisateurs :
#      sudo cp jitsi-motd.sh /etc/update-motd.d/99-jitsi-status
#      sudo chmod +x /etc/update-motd.d/99-jitsi-status

JITSI_DIR="${JITSI_DIR:-/home/chat/irc/jitsi-docker-jitsi-meet-738058b}"
ENV_FILE="$JITSI_DIR/.env"
KNOWN_FILE="/var/tmp/jitsi-last-known-tag"

# Couleurs ANSI
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}━━━  Jitsi Meet  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

# ── Version installée ─────────────────────────────────────────────────────────
current=""
if [[ -f "$ENV_FILE" ]]; then
    current=$(grep -E '^JITSI_IMAGE_VERSION=' "$ENV_FILE" | head -1 \
              | cut -d= -f2 | tr -d '[:space:]"')
fi
echo -e "  Version installée : ${BOLD}${current:-inconnue}${RESET}"

# ── Mise à jour disponible ? (lecture du fichier local, pas d'appel réseau) ───
if [[ -f "$KNOWN_FILE" ]]; then
    latest=$(cat "$KNOWN_FILE" | tr -d '[:space:]')
    if [[ -n "$latest" && "$latest" != "$current" ]]; then
        echo -e "  ${YELLOW}${BOLD}⚠  Mise à jour disponible : $latest${RESET}"
        echo -e "  ${YELLOW}Lancer : $JITSI_DIR/jitsi-update.sh --update${RESET}"
    else
        echo -e "  ${GREEN}✔  À jour${RESET}"
    fi
else
    echo -e "  (Aucune vérification récente — timer actif ?)"
fi

# ── État des containers ───────────────────────────────────────────────────────
if command -v docker &>/dev/null && [[ -f "$JITSI_DIR/docker-compose.yml" ]]; then
    # Timeout court pour ne pas ralentir la connexion SSH
    status=$(timeout 3 docker compose -f "$JITSI_DIR/docker-compose.yml" \
             ps --format '{{.Name}}|{{.Status}}' 2>/dev/null || true)
    if [[ -n "$status" ]]; then
        echo -e "  ${BOLD}Containers :${RESET}"
        while IFS='|' read -r name state; do
            [[ -z "$name" ]] && continue
            if echo "$state" | grep -qi 'up'; then
                echo -e "    ${GREEN}▪${RESET} $name  ${GREEN}$state${RESET}"
            else
                echo -e "    ${RED}▪${RESET} $name  ${RED}$state${RESET}"
            fi
        done <<< "$status"
    else
        echo -e "  ${RED}Containers : non démarrés ou inaccessibles${RESET}"
    fi
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
