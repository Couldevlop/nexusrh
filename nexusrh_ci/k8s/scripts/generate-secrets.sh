#!/usr/bin/env bash
# generate-secrets.sh — génère values.secret.yaml pour helm (jamais commité)
# Usage : bash scripts/generate-secrets.sh [--env .env]
# Sortie : charts/nexusrh/values.secret.yaml (gitignored)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(dirname "$SCRIPT_DIR")/charts/nexusrh"
ENV_FILE="${1:-}"
OUT="$CHART_DIR/values.secret.yaml"

if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  echo "[secrets] Chargement de $ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
fi

gen() { openssl rand -hex 32; }

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(gen)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(gen)}"
MINIO_PASSWORD="${MINIO_PASSWORD:-$(gen)}"
JWT_SECRET="${JWT_SECRET:-$(gen)$(gen)}"
MEILI_KEY="${MEILISEARCH_MASTER_KEY:-$(gen)}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-sk-ant-api03-REPLACE_ME}"
SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
SMTP_USER="${SMTP_USER:-REPLACE@gmail.com}"
SMTP_PASS="${SMTP_PASS:-REPLACE_APP_PASSWORD}"
SMTP_FROM="${SMTP_FROM:-NexusRH <${SMTP_USER}>}"

cat > "$OUT" <<EOF
# !! GÉNÉRÉ AUTOMATIQUEMENT — NE PAS COMMITTER !!
# $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Usage : helm upgrade --install nexusrh k8s/charts/nexusrh -f k8s/charts/nexusrh/values.local.yaml -f k8s/charts/nexusrh/values.secret.yaml

postgres:
  auth:
    password: "${POSTGRES_PASSWORD}"

redis:
  auth:
    password: "${REDIS_PASSWORD}"

minio:
  auth:
    rootPassword: "${MINIO_PASSWORD}"

meilisearch:
  auth:
    masterKey: "${MEILI_KEY}"

api:
  secrets:
    jwtSecret: "${JWT_SECRET}"
    anthropicApiKey: "${ANTHROPIC_KEY}"
    smtpUser: "${SMTP_USER}"
    smtpPass: "${SMTP_PASS}"
    smtpFrom: "${SMTP_FROM}"
    googleClientId: "${GOOGLE_CLIENT_ID:-}"
    googleClientSecret: "${GOOGLE_CLIENT_SECRET:-}"
    microsoftClientId: "${MICROSOFT_CLIENT_ID:-}"
    microsoftClientSecret: "${MICROSOFT_CLIENT_SECRET:-}"
    microsoftTenantId: "${MICROSOFT_TENANT_ID:-common}"
EOF

echo "[secrets] ✓ Fichier créé : $OUT"
echo ""
echo "  POSTGRES_PASSWORD : ${POSTGRES_PASSWORD:0:8}..."
echo "  REDIS_PASSWORD    : ${REDIS_PASSWORD:0:8}..."
echo "  MINIO_PASSWORD    : ${MINIO_PASSWORD:0:8}..."
echo "  JWT_SECRET        : ${JWT_SECRET:0:8}..."
echo "  MEILI_KEY         : ${MEILI_KEY:0:8}..."
echo ""
echo "  Pensez à renseigner ANTHROPIC_API_KEY dans $OUT si besoin."
