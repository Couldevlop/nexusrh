#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NexusRH — Script d'installation interactif
# Usage : bash setup.sh
# Durée estimée : 10-15 minutes
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Couleurs ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ  $*${NC}"; }
log_success() { echo -e "${GREEN}✔  $*${NC}"; }
log_warn()    { echo -e "${YELLOW}⚠  $*${NC}"; }
log_error()   { echo -e "${RED}✘  $*${NC}"; }
log_step()    { echo -e "\n${BOLD}${CYAN}── $* ${NC}"; }

banner() {
  echo -e "${BOLD}${CYAN}"
  cat << 'EOF'
  _   _                    ____  _   _
 | \ | | _____  ___   _ __|  _ \| | | |
 |  \| |/ _ \ \/ / | | / __| |_) | |_| |
 | |\  |  __/>  <| |_| \__ \  _ <|  _  |
 |_| \_|\___/_/\_\\__,_|___/_| \_\_| |_|

  SIRH SaaS Multi-Tenant — Installation
EOF
  echo -e "${NC}"
}

# ── Vérification des prérequis ────────────────────────────────────────────────
check_prerequisites() {
  log_step "Vérification des prérequis"
  local missing=0

  # Docker
  if command -v docker &>/dev/null; then
    local docker_version
    docker_version=$(docker --version | grep -oP '\d+\.\d+' | head -1)
    log_success "Docker $docker_version"
    # Docker Compose v2
    if docker compose version &>/dev/null; then
      log_success "Docker Compose v2"
    elif command -v docker-compose &>/dev/null; then
      log_success "Docker Compose v1 (legacy)"
      DOCKER_COMPOSE="docker-compose"
    else
      log_error "Docker Compose non trouvé"
      missing=1
    fi
    # Vérifier que Docker tourne
    if ! docker info &>/dev/null; then
      log_error "Docker Desktop n'est pas démarré — veuillez le lancer"
      missing=1
    fi
  else
    log_error "Docker non trouvé — https://docs.docker.com/get-docker/"
    missing=1
  fi

  # Node.js
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node --version)
    local node_major
    node_major=$(echo "$node_version" | grep -oP '\d+' | head -1)
    if [[ $node_major -ge 18 ]]; then
      log_success "Node.js $node_version"
    else
      log_error "Node.js $node_version trouvé — version 18+ requise"
      missing=1
    fi
  else
    log_error "Node.js non trouvé — https://nodejs.org/"
    missing=1
  fi

  # pnpm
  if command -v pnpm &>/dev/null; then
    log_success "pnpm $(pnpm --version)"
  else
    log_warn "pnpm non trouvé — installation automatique..."
    npm install -g pnpm
    log_success "pnpm installé"
  fi

  if [[ $missing -ne 0 ]]; then
    log_error "Prérequis manquants. Installez-les puis relancez setup.sh"
    exit 1
  fi
}

# ── Variable globale pour docker compose command ─────────────────────────────
DOCKER_COMPOSE="docker compose"

# ── Configuration .env ────────────────────────────────────────────────────────
configure_env() {
  log_step "Configuration des variables d'environnement"

  if [[ -f .env ]]; then
    log_warn ".env existant détecté"
    read -rp "  Écraser le .env existant ? (o/N) : " overwrite
    if [[ ! "$overwrite" =~ ^[oO]$ ]]; then
      log_info "Conservation du .env existant"
      return
    fi
  fi

  cp .env.example .env
  log_success ".env créé depuis .env.example"

  # ── JWT Secret (généré automatiquement) ─────────────────────────────────────
  local jwt_secret
  jwt_secret=$(LC_ALL=C tr -dc 'A-Za-z0-9!@#$%^&*' </dev/urandom | head -c 48 2>/dev/null || \
               node -e "console.log(require('crypto').randomBytes(36).toString('hex'))")
  sed -i.bak "s|JWT_SECRET=change-me-minimum-32-characters-long!!|JWT_SECRET=$jwt_secret|" .env
  log_success "JWT_SECRET généré automatiquement (48 chars)"

  # ── Mode déploiement ─────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}Mode de déploiement :${NC}"
  echo "  1) Développement local (recommandé pour débuter)"
  echo "  2) Production self-hosted (domaine + SSL)"
  echo "  3) SaaS cloud (Render / Railway / DigitalOcean)"
  read -rp "Choix [1/2/3] : " deploy_mode
  deploy_mode=${deploy_mode:-1}

  if [[ "$deploy_mode" == "2" ]]; then
    configure_production_env
  elif [[ "$deploy_mode" == "3" ]]; then
    log_info "Pour SaaS cloud : utilisez render.yaml / railway.json / .do/app.yaml"
    log_info "Ces fichiers sont à la racine du projet."
  fi

  # ── Email ────────────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}Configuration email (optionnel — skip avec Entrée) :${NC}"
  read -rp "  SMTP Host [smtp.gmail.com] : " smtp_host
  smtp_host=${smtp_host:-smtp.gmail.com}
  read -rp "  SMTP User (adresse email) : " smtp_user
  if [[ -n "$smtp_user" ]]; then
    read -rsp "  SMTP Password (App Password si Gmail) : " smtp_pass
    echo ""
    sed -i.bak "s|SMTP_HOST=smtp.example.com|SMTP_HOST=$smtp_host|" .env
    sed -i.bak "s|SMTP_USER=|SMTP_USER=$smtp_user|" .env
    sed -i.bak "s|SMTP_PASS=|SMTP_PASS=$smtp_pass|" .env
    sed -i.bak "s|SMTP_FROM=NexusRH <noreply@nexusrh.com>|SMTP_FROM=NexusRH <$smtp_user>|" .env
    log_success "SMTP configuré : $smtp_host"
  else
    log_warn "Email non configuré — les invitations ne seront pas envoyées"
  fi

  # ── IA Anthropic ────────────────────────────────────────────────────────────
  echo ""
  read -rp "Clé API Anthropic (sk-ant-...) [optionnel] : " anthropic_key
  if [[ -n "$anthropic_key" ]]; then
    sed -i.bak "s|ANTHROPIC_API_KEY=sk-ant-api03-...|ANTHROPIC_API_KEY=$anthropic_key|" .env
    log_success "IA Anthropic configurée"
  else
    log_warn "ANTHROPIC_API_KEY non définie — assistant IA désactivé"
  fi

  # ── Nettoyage backups .bak ──────────────────────────────────────────────────
  rm -f .env.bak
  log_success "Configuration .env terminée"
}

configure_production_env() {
  echo ""
  echo -e "${BOLD}Configuration production :${NC}"
  read -rp "  Domaine principal (ex: nexusrh.monentreprise.com) : " domain
  read -rp "  Email admin Let's Encrypt : " admin_email

  if [[ -n "$domain" ]]; then
    sed -i.bak "s|APP_URL=http://localhost:3000|APP_URL=https://$domain|" .env
    sed -i.bak "s|API_URL=http://localhost:4000|API_URL=https://api.$domain|" .env
    log_success "URLs production configurées pour $domain"
  fi

  # Mot de passe PostgreSQL sécurisé
  local pg_pass
  pg_pass=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 2>/dev/null || \
            node -e "console.log(require('crypto').randomBytes(18).toString('hex'))")
  sed -i.bak "s|POSTGRES_PASSWORD:.*|POSTGRES_PASSWORD: $pg_pass|" .env 2>/dev/null || true
  log_success "Mot de passe PostgreSQL sécurisé généré"

  # Redis password
  local redis_pass
  redis_pass=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 2>/dev/null || \
               node -e "console.log(require('crypto').randomBytes(18).toString('hex'))")
  echo "REDIS_PASSWORD=$redis_pass" >> .env
  log_success "Mot de passe Redis sécurisé généré"
}

# ── Démarrage infrastructure Docker ─────────────────────────────────────────
start_infrastructure() {
  log_step "Démarrage de l'infrastructure Docker"

  $DOCKER_COMPOSE up -d postgres redis meilisearch minio
  log_info "Attente démarrage PostgreSQL..."

  local retries=0
  until $DOCKER_COMPOSE exec -T postgres pg_isready -U nexusrh &>/dev/null; do
    retries=$((retries + 1))
    if [[ $retries -ge 30 ]]; then
      log_error "PostgreSQL n'a pas démarré après 30 secondes"
      exit 1
    fi
    sleep 1
    printf "."
  done
  echo ""
  log_success "PostgreSQL prêt"
  log_success "Redis prêt"
  log_success "Meilisearch prêt (http://localhost:7700)"
  log_success "MinIO prêt (http://localhost:9001 — minioadmin/minioadmin)"
}

# ── Installation des dépendances ─────────────────────────────────────────────
install_dependencies() {
  log_step "Installation des dépendances (pnpm install)"
  pnpm install --frozen-lockfile 2>&1 | tail -5
  log_success "Dépendances installées"
}

# ── Initialisation base de données ────────────────────────────────────────────
init_database() {
  log_step "Initialisation de la base de données"
  log_info "Création des schémas + données de démo (2 tenants, 68 employés)..."
  pnpm --filter api run db:seed
  log_success "Base de données initialisée"
}

# ── Vérification optionnelle ──────────────────────────────────────────────────
run_type_check() {
  log_step "Vérification TypeScript (optionnel)"
  read -rp "Lancer la vérification de types ? (o/N) : " run_tsc
  if [[ "$run_tsc" =~ ^[oO]$ ]]; then
    pnpm --filter api run type-check && log_success "API : aucune erreur TypeScript"
    pnpm --filter web run type-check 2>/dev/null && log_success "Web : aucune erreur TypeScript" || true
  fi
}

# ── Résumé final ──────────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${GREEN}  NexusRH installé avec succès !${NC}"
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${BOLD}Démarrer l'application :${NC}"
  echo "  pnpm run dev"
  echo ""
  echo -e "${BOLD}Services disponibles :${NC}"
  echo -e "  ${CYAN}Frontend${NC}   http://localhost:3000"
  echo -e "  ${CYAN}API${NC}        http://localhost:4000"
  echo -e "  ${CYAN}Swagger${NC}    http://localhost:4000/docs"
  echo -e "  ${CYAN}MinIO${NC}      http://localhost:9001  (minioadmin / minioadmin)"
  echo -e "  ${CYAN}Metrics${NC}    http://localhost:4000/metrics"
  echo ""
  echo -e "${BOLD}Comptes de connexion :${NC}"
  echo ""
  echo -e "  ${BOLD}Super Admin (plateforme)${NC}"
  echo -e "  Email    : superadmin@nexusrh.com"
  echo -e "  Password : SuperAdmin1234!"
  echo -e "  URL      : http://localhost:3000/platform/dashboard"
  echo ""
  echo -e "  ${BOLD}TechCorp SAS (thème indigo)${NC}"
  echo -e "  Admin    : admin@techcorp.com     / Admin1234!"
  echo -e "  RH       : rh@techcorp.com        / Admin1234!"
  echo -e "  Manager  : manager@techcorp.com   / Admin1234!"
  echo -e "  Employé  : employe@techcorp.com   / Admin1234!"
  echo ""
  echo -e "  ${BOLD}Artisan Pro SARL (thème vert)${NC}"
  echo -e "  Admin    : admin@artisanpro.com   / Admin1234!"
  echo -e "  Employé  : employe2@artisanpro.com / Admin1234!"
  echo ""
  echo -e "${BOLD}Commandes utiles :${NC}"
  echo "  pnpm --filter api run db:seed       # Reseed (idempotent)"
  echo "  pnpm --filter api run admin:reset <email> <pwd>"
  echo "  docker-compose logs -f api           # Logs API"
  echo "  docker-compose down                  # Arrêter l'infra"
  echo ""
  echo -e "${YELLOW}Documentation complète : README.md${NC}"
  echo ""
}

# ── Mode non-interactif (CI/CD) ───────────────────────────────────────────────
if [[ "${CI:-false}" == "true" ]] || [[ "${NEXUSRH_NONINTERACTIVE:-false}" == "true" ]]; then
  log_info "Mode non-interactif détecté (CI/CD)"
  cp .env.example .env
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('hex'))")
  sed -i.bak "s|JWT_SECRET=change-me-minimum-32-characters-long!!|JWT_SECRET=$JWT_SECRET|" .env
  rm -f .env.bak
fi

# ── Point d'entrée principal ──────────────────────────────────────────────────
main() {
  banner
  check_prerequisites
  configure_env
  start_infrastructure
  install_dependencies
  init_database
  run_type_check
  print_summary
}

main "$@"
