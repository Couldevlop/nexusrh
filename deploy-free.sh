#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# NexusRH — Déploiement 100% GRATUIT
# Stack : Neon (PG) + Upstash (Redis) + Cloudflare R2 + Fly.io
# Durée estimée : 15-25 minutes
#
# Prérequis :
#   - Compte Neon       : https://neon.tech  (gratuit)
#   - Compte Upstash    : https://upstash.com (gratuit)
#   - Compte Cloudflare : https://cloudflare.com (gratuit)
#   - Compte Fly.io     : https://fly.io (gratuit — carte bancaire requise, 0€ débité)
#   - flyctl installé   : https://fly.io/docs/hands-on/install-flyctl/
#   - npx / Node 20+    : https://nodejs.org
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Couleurs ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()   { echo -e "${GREEN}✓${RESET} $*"; }
info()  { echo -e "${BLUE}ℹ${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
error() { echo -e "${RED}✗${RESET} $*" >&2; }
step()  { echo -e "\n${BOLD}${CYAN}━━ $* ━━${RESET}"; }
ask()   { echo -e "${YELLOW}?${RESET} $*"; }

# ── Bannière ──────────────────────────────────────────────────────────────────
echo -e "
${BOLD}${BLUE}
╔═══════════════════════════════════════════════════════╗
║          NexusRH — Déploiement Gratuit                ║
║  Neon · Upstash · Cloudflare R2 · Fly.io              ║
╚═══════════════════════════════════════════════════════╝
${RESET}"

# ── Vérification des prérequis ────────────────────────────────────────────────
step "Vérification des prérequis"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    error "$1 non trouvé. Installer : $2"
    exit 1
  fi
  log "$1 disponible"
}

check_cmd flyctl    "https://fly.io/docs/hands-on/install-flyctl/"
check_cmd node      "https://nodejs.org"
check_cmd pnpm      "npm install -g pnpm"
check_cmd git       "https://git-scm.com"

# ── Collecte des informations ─────────────────────────────────────────────────
step "Configuration"

# App name
ask "Nom de l'application Fly.io (ex: nexusrh-mycompany, doit être unique):"
read -r APP_NAME
APP_NAME="${APP_NAME:-nexusrh-app}"

ask "Région Fly.io [cdg=Paris, ams=Amsterdam, fra=Frankfurt] (défaut: cdg):"
read -r FLY_REGION
FLY_REGION="${FLY_REGION:-cdg}"

echo ""
info "Vous aurez besoin des informations suivantes (copiées depuis les dashboards):"
echo ""
echo "  1. Neon    → Connection string PostgreSQL"
echo "  2. Upstash → Redis URL (format: rediss://...)"
echo "  3. Cloudflare R2 → Account ID + Access Key ID + Secret Access Key"
echo ""

ask "DATABASE_URL (Neon connection string):"
read -r DATABASE_URL

ask "REDIS_URL (Upstash Redis URL, format rediss://):"
read -r REDIS_URL

ask "Cloudflare Account ID:"
read -r CF_ACCOUNT_ID

ask "Cloudflare R2 Access Key ID:"
read -r R2_ACCESS_KEY

ask "Cloudflare R2 Secret Access Key:"
read -r R2_SECRET_KEY

ask "Email Gmail (pour l'envoi d'emails):"
read -r SMTP_USER

ask "Gmail App Password (16 caractères, espaces optionnels):"
read -r SMTP_PASS

ask "Clé Anthropic API (optionnel, appuyer Entrée pour ignorer):"
read -r ANTHROPIC_API_KEY

# Generate JWT secret
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
log "JWT secret généré automatiquement (48 bytes)"

# ── Fly.io — Authentification ─────────────────────────────────────────────────
step "Authentification Fly.io"

if ! flyctl auth whoami &>/dev/null; then
  info "Connexion à Fly.io..."
  flyctl auth login
fi
log "Authentifié sur Fly.io : $(flyctl auth whoami)"

# ── Fly.io — Créer l'app API ──────────────────────────────────────────────────
step "Création de l'application API sur Fly.io"

WORKER_APP="${APP_NAME}-worker"

# Update fly.toml with actual app name
sed -i "s/app = \"nexusrh-api\"/app = \"${APP_NAME}\"/" fly.toml
sed -i "s/app = \"nexusrh-worker\"/app = \"${WORKER_APP}\"/" fly.worker.toml
sed -i "s/primary_region = \"cdg\"/primary_region = \"${FLY_REGION}\"/" fly.toml
sed -i "s/primary_region = \"cdg\"/primary_region = \"${FLY_REGION}\"/" fly.worker.toml

# Create API app
if flyctl apps list | grep -q "^${APP_NAME}"; then
  warn "L'application ${APP_NAME} existe déjà, on continue..."
else
  flyctl apps create "${APP_NAME}" --org personal
  log "Application ${APP_NAME} créée"
fi

# Create Worker app
if flyctl apps list | grep -q "^${WORKER_APP}"; then
  warn "L'application ${WORKER_APP} existe déjà, on continue..."
else
  flyctl apps create "${WORKER_APP}" --org personal
  log "Application ${WORKER_APP} créée"
fi

# ── Fly.io — Configurer les secrets ──────────────────────────────────────────
step "Configuration des secrets (variables d'environnement chiffrées)"

API_URL="https://${APP_NAME}.fly.dev"
APP_URL="https://${APP_NAME}-web.pages.dev"  # Placeholder, update after CF Pages deploy

set_secret() {
  local app="$1"
  shift
  flyctl secrets set "$@" --app "$app" --stage 2>/dev/null
}

# API secrets
set_secret "${APP_NAME}" \
  DATABASE_URL="${DATABASE_URL}" \
  REDIS_URL="${REDIS_URL}" \
  JWT_SECRET="${JWT_SECRET}" \
  API_URL="${API_URL}" \
  APP_URL="${APP_URL}" \
  SMTP_HOST="smtp.gmail.com" \
  SMTP_PORT="587" \
  SMTP_SECURE="false" \
  SMTP_USER="${SMTP_USER}" \
  SMTP_PASS="${SMTP_PASS}" \
  SMTP_FROM="NexusRH <${SMTP_USER}>" \
  S3_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY="${R2_ACCESS_KEY}" \
  S3_SECRET_KEY="${R2_SECRET_KEY}" \
  S3_BUCKET="nexusrh" \
  S3_REGION="auto" \
  S3_FORCE_PATH_STYLE="true" \
  MEILISEARCH_URL="" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  FEATURE_AI_ASSISTANT="${ANTHROPIC_API_KEY:+true}" \
  NODE_ENV="production"

log "Secrets API configurés"

# Worker gets same secrets
set_secret "${WORKER_APP}" \
  DATABASE_URL="${DATABASE_URL}" \
  REDIS_URL="${REDIS_URL}" \
  JWT_SECRET="${JWT_SECRET}" \
  S3_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY="${R2_ACCESS_KEY}" \
  S3_SECRET_KEY="${R2_SECRET_KEY}" \
  S3_BUCKET="nexusrh" \
  S3_REGION="auto" \
  S3_FORCE_PATH_STYLE="true" \
  SMTP_HOST="smtp.gmail.com" \
  SMTP_PORT="587" \
  SMTP_SECURE="false" \
  SMTP_USER="${SMTP_USER}" \
  SMTP_PASS="${SMTP_PASS}" \
  SMTP_FROM="NexusRH <${SMTP_USER}>" \
  NODE_ENV="production"

log "Secrets Worker configurés"

# ── Fly.io — Build & Deploy API ───────────────────────────────────────────────
step "Build et déploiement de l'API (5-10 minutes)"

flyctl deploy \
  --app "${APP_NAME}" \
  --config fly.toml \
  --dockerfile apps/api/Dockerfile \
  --build-target production \
  --build-arg NODE_VERSION=20 \
  --remote-only \
  --wait-timeout 300

log "API déployée sur https://${APP_NAME}.fly.dev"

# ── Fly.io — Seed de la base de données ───────────────────────────────────────
step "Initialisation de la base de données"

info "Lancement du seed (création des données de démo)..."
flyctl ssh console --app "${APP_NAME}" --command \
  "cd /app && node -e \"import('./dist/db/seed.js').then(m => m.default ? m.default() : m.seed()).catch(e => { console.error(e); process.exit(1); })\""

log "Base de données initialisée"

# ── Fly.io — Build & Deploy Worker ────────────────────────────────────────────
step "Déploiement du Worker BullMQ"

flyctl deploy \
  --app "${WORKER_APP}" \
  --config fly.worker.toml \
  --dockerfile apps/worker/Dockerfile \
  --build-target production \
  --build-arg NODE_VERSION=20 \
  --remote-only \
  --wait-timeout 300

log "Worker déployé"

# ── Cloudflare Pages — Frontend ───────────────────────────────────────────────
step "Build du frontend (Cloudflare Pages)"

info "Construction de l'application React..."
VITE_API_URL="${API_URL}" pnpm --filter @nexusrh/shared build
VITE_API_URL="${API_URL}" pnpm --filter web build

log "Frontend compilé dans apps/web/dist/"

echo ""
warn "Déploiement Cloudflare Pages — 2 options :"
echo ""
echo "  Option A — Interface graphique (recommandée) :"
echo "    1. https://dash.cloudflare.com → Pages → Create project"
echo "    2. Connecter votre repo GitHub ou 'Upload assets'"
echo "    3. Build command : VITE_API_URL=${API_URL} pnpm --filter web build"
echo "    4. Output directory : apps/web/dist"
echo "    5. Ajouter variable env : VITE_API_URL = ${API_URL}"
echo ""
echo "  Option B — CLI wrangler (si wrangler installé) :"
echo "    npx wrangler pages deploy apps/web/dist --project-name nexusrh-web"
echo ""

ask "Voulez-vous déployer via wrangler maintenant ? [o/N]:"
read -r DEPLOY_CF

if [[ "${DEPLOY_CF,,}" == "o" || "${DEPLOY_CF,,}" == "oui" ]]; then
  if ! command -v wrangler &>/dev/null; then
    info "Installation de wrangler..."
    npm install -g wrangler
  fi

  wrangler login
  CF_PAGES_URL=$(wrangler pages deploy apps/web/dist \
    --project-name nexusrh-web \
    --commit-dirty=true \
    2>&1 | grep -o 'https://[^ ]*\.pages\.dev' | head -1)

  if [[ -n "${CF_PAGES_URL}" ]]; then
    log "Frontend déployé sur ${CF_PAGES_URL}"

    # Update APP_URL in API secrets
    flyctl secrets set APP_URL="${CF_PAGES_URL}" --app "${APP_NAME}"
    log "APP_URL mis à jour dans les secrets de l'API"
    APP_URL="${CF_PAGES_URL}"
  fi
fi

# ── Vérification finale ───────────────────────────────────────────────────────
step "Vérification du déploiement"

info "Test de l'API..."
sleep 5  # Attendre que l'app soit prête

if curl -sf "https://${APP_NAME}.fly.dev/health" | grep -q '"status":"ok"'; then
  log "API opérationnelle : https://${APP_NAME}.fly.dev"
else
  warn "L'API n'est pas encore prête (normal si elle vient de démarrer)"
  info "Vérifier les logs : flyctl logs --app ${APP_NAME}"
fi

# ── Résumé ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  ✅  NexusRH déployé avec succès !                    ${RESET}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}Frontend  :${RESET} ${APP_URL}"
echo -e "  ${BOLD}API       :${RESET} https://${APP_NAME}.fly.dev"
echo -e "  ${BOLD}Swagger   :${RESET} https://${APP_NAME}.fly.dev/docs"
echo -e "  ${BOLD}Worker    :${RESET} https://${WORKER_APP}.fly.dev"
echo ""
echo -e "  ${BOLD}Comptes de connexion :${RESET}"
echo ""
echo -e "  ${CYAN}Super Admin${RESET}"
echo -e "    Email    : superadmin@nexusrh.com"
echo -e "    Password : SuperAdmin1234!"
echo ""
echo -e "  ${CYAN}TechCorp (thème indigo)${RESET}"
echo -e "    Admin    : admin@techcorp.com / Admin1234!"
echo -e "    RH       : rh@techcorp.com / Admin1234!"
echo -e "    Manager  : manager@techcorp.com / Admin1234!"
echo -e "    Employé  : employe@techcorp.com / Admin1234!"
echo ""
echo -e "  ${CYAN}ArtisanPro (thème vert)${RESET}"
echo -e "    Admin    : admin@artisanpro.com / Admin1234!"
echo ""
echo -e "  ${BOLD}Commandes utiles :${RESET}"
echo -e "    Logs API    : flyctl logs --app ${APP_NAME}"
echo -e "    Logs Worker : flyctl logs --app ${WORKER_APP}"
echo -e "    Redéployer  : flyctl deploy --app ${APP_NAME} --remote-only"
echo -e "    SSH API     : flyctl ssh console --app ${APP_NAME}"
echo ""
echo -e "  ${YELLOW}⚠ Limites du tier gratuit :${RESET}"
echo -e "    Fly.io  : 3 VMs partagées, 160GB bande passante/mois"
echo -e "    Neon    : 0.5GB stockage, suspend après 5 min d'inactivité"
echo -e "    Upstash : 10 000 requêtes Redis/jour"
echo -e "    R2      : 10GB stockage, 1M opérations/mois"
echo ""
