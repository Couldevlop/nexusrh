# Variables d'environnement — .env.example complet (CI)

> Référence détaillée. Chargée à la demande depuis `nexusrh_ci/CLAUDE.md`.
> Fichier réel : `nexusrh_ci/.env.example`. Ports prod/déploiement : voir mémoire projet.

```bash
NODE_ENV=development
APP_NAME=NexusRH CI
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
API_PORT=4000
LOG_LEVEL=info
LOCALE=fr-CI
CURRENCY=XOF
TIMEZONE=Africa/Abidjan

# Base de données
DATABASE_URL=postgresql://nexusrhci:nexusrhci@localhost:5434/nexusrhci
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10

# Redis
REDIS_URL=redis://localhost:6380

# JWT
JWT_SECRET=nexusrh-ci-super-secret-key-minimum-32-chars!!
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
MFA_ISSUER=NexusRH CI

# OAuth2 (optionnel)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback

# IA Anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...
AI_MODEL=claude-sonnet-4-20250514
AI_MAX_TOKENS=4096
AI_TEMPERATURE=0.3
AI_SYSTEM_LOCALE=ci  # calibration contexte ivoirien

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=NexusRH CI <noreply@nexusrh-ci.com>

# Stockage (MinIO / S3 hébergeable en CI)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=nexusrhci
S3_REGION=af-west-1
S3_FORCE_PATH_STYLE=true

# Meilisearch
MEILISEARCH_URL=http://localhost:7700
MEILISEARCH_MASTER_KEY=nexusrhci-dev-master-key

# Mobile Money CI
WAVE_API_KEY=
WAVE_API_URL=https://api.wave.com/v1
WAVE_WEBHOOK_SECRET=

MTN_MOMO_API_KEY=
MTN_MOMO_API_URL=https://sandbox.momodeveloper.mtn.com
MTN_MOMO_SUBSCRIPTION_KEY=
MTN_MOMO_ENV=sandbox  # production en prod

ORANGE_MONEY_API_KEY=
ORANGE_MONEY_API_URL=https://api.orange.com/orange-money-webpay/ci/v1
ORANGE_MONEY_MERCHANT_KEY=

# CNPS CI
ECNPS_EXPORT_FORMAT=csv  # format compatible plateforme e-CNPS

# Feature flags
FEATURE_AI_ASSISTANT=true
FEATURE_MOBILE_MONEY=true
FEATURE_CNPS_AUTO_EXPORT=true
FEATURE_DISA_GENERATOR=true
FEATURE_FDFP_MODULE=true
FEATURE_OHADA_CONTRACTS=true
FEATURE_MULTI_SITES=false
FEATURE_OFFLINE_PWA=true
```
