# Variables d'environnement — .env.example complet

> Référence détaillée. Chargée à la demande depuis `CLAUDE.md`.
> Pour l'état réel actuel (port DB, SMTP Gmail), voir la section "ENV — ÉTAT ACTUEL" de `CLAUDE.md`.

```bash
NODE_ENV=development
APP_NAME=NexusRH
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
API_PORT=4000
LOG_LEVEL=info

DATABASE_URL=postgresql://nexusrh:nexusrh@localhost:5433/nexusrh
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=20

REDIS_URL=redis://localhost:6379

JWT_SECRET=change-me-minimum-32-characters-long!!
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
MFA_ISSUER=NexusRH

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:4000/auth/google/callback
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_CALLBACK_URL=http://localhost:4000/auth/microsoft/callback

ANTHROPIC_API_KEY=sk-ant-api03-...
AI_MODEL=claude-sonnet-4-20250514
AI_MAX_TOKENS=4096

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=NexusRH <noreply@nexusrh.com>

S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=nexusrh
S3_REGION=eu-west-1
S3_FORCE_PATH_STYLE=true

MEILISEARCH_URL=http://localhost:7700
MEILISEARCH_MASTER_KEY=nexusrh-dev-master-key

FEATURE_AI_ASSISTANT=true
FEATURE_PREDICTIVE_ANALYTICS=true
FEATURE_ELECTRONIC_SIGNATURE=true
FEATURE_MULTI_COUNTRY=false
FEATURE_KIOSK_MODE=true
```
