# NexusRH — SIRH SaaS Multi-Tenant

> Node.js 20 + React 18 + PostgreSQL 16 · Schema-per-tenant · Production-ready

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Démarrage rapide](#2-démarrage-rapide)
3. [Comptes de connexion](#3-comptes-de-connexion)
4. [Architecture multi-tenant](#4-architecture-multi-tenant)
5. [Cartographie du monorepo](#5-cartographie-du-monorepo)
6. [Backend Fastify](#6-backend-fastify)
7. [Frontend React](#7-frontend-react)
8. [Authentification et RBAC](#8-authentification-et-rbac)
9. [Moteur de paie](#9-moteur-de-paie)
10. [Workflows d'approbation](#10-workflows-dapprobation)
11. [Services transverses](#11-services-transverses)
12. [Portail super_admin](#12-portail-super_admin)
13. [Scripts utilitaires](#13-scripts-utilitaires)
14. [Variables d'environnement](#14-variables-denvironnement)
15. [Tests](#15-tests)
16. [Déploiement gratuit](#16-déploiement-gratuit-neon--upstash--cloudflare-r2--flyio)

---

## 1. Vue d'ensemble

NexusRH est un **SIRH SaaS multi-tenant** : un seul déploiement sert plusieurs entreprises clientes, chacune totalement isolée via un **schéma PostgreSQL dédié** (stratégie _schema-per-tenant_).

### Rôles disponibles

| Rôle | Périmètre |
|------|-----------|
| `super_admin` | Plateforme uniquement — gestion des tenants, logs, aucun accès RH |
| `admin` | Tous les droits RH dans son tenant |
| `hr_manager` | Paie, absences, recrutement, formations, reporting |
| `hr_officer` | Saisie RH, pas de clôture paie |
| `manager` | Son équipe uniquement — validation absences et frais |
| `employee` | Espace self-service uniquement |
| `readonly` | Consultation sans modification |

### Stack technique

```
Monorepo      pnpm workspaces + Turborepo
Backend       Node.js 20 LTS + Fastify 4 + TypeScript 5
ORM           Drizzle ORM (PostgreSQL, mode multi-schema)
Base          PostgreSQL 16 (port 5433) + Redis 7
Frontend      React 18 + Vite 5 + TypeScript 5
UI            shadcn/ui + Radix UI + Tailwind CSS 3 + Framer Motion 11
State         Zustand 4 + TanStack Query 5
Forms         React Hook Form + Zod
Auth          @fastify/jwt (HS256) + otplib (MFA TOTP)
Email         Nodemailer + MJML (Gmail App Password supporté)
Fichiers      AWS SDK v3 (S3/MinIO, fallback base64)
Recherche     Meilisearch
IA            @anthropic-ai/sdk — claude-sonnet-4-20250514
Tests         Vitest (unit) + Playwright (E2E)
```

---

## 2. Démarrage rapide

### Prérequis

- Docker Desktop lancé
- Node.js 20+
- pnpm (`npm i -g pnpm`)

### Installation

```bash
# 1. Variables d'environnement
cd D:/OPENLAB/nexusrh
cp .env.example .env
# Éditer .env — renseigner au minimum :
#   JWT_SECRET=<32 caractères minimum>
#   SMTP_HOST, SMTP_USER, SMTP_PASS  (pour les emails)

# 2. Infrastructure Docker
docker-compose up -d postgres redis meilisearch minio
# Attendre ~15 secondes

# 3. Dépendances
pnpm install

# 4. Base de données (schémas + données de démo)
pnpm --filter api run db:seed

# 5. Démarrage
pnpm run dev
```

### URLs

| Service | URL | Identifiants |
|---------|-----|-------------|
| **Frontend** | http://localhost:3000 | — |
| **API REST** | http://localhost:4000 | — |
| **Swagger** | http://localhost:4000/docs | — |
| **MinIO** | http://localhost:9001 | minioadmin / minioadmin |
| **PostgreSQL** | localhost:**5433** | nexusrh / nexusrh |

> **Note** : PostgreSQL tourne sur le port **5433** (pas 5432) pour éviter les conflits avec une instance locale.

---

## 3. Comptes de connexion

### Plateforme (super_admin)

| Email | Mot de passe | Redirige vers |
|-------|-------------|---------------|
| `superadmin@nexusrh.com` | `SuperAdmin1234!` | `/platform/dashboard` |

### TechCorp SAS — thème indigo `#4F46E5`

| Email | Mot de passe | Rôle | Page d'accueil |
|-------|-------------|------|----------------|
| `admin@techcorp.com` | `Admin1234!` | admin | `/dashboard` |
| `rh@techcorp.com` | `Admin1234!` | hr_manager | `/dashboard` |
| `manager@techcorp.com` | `Admin1234!` | manager | `/dashboard` |
| `employe@techcorp.com` | `Admin1234!` | employee | `/mon-espace` |

### Artisan Pro SARL — thème vert `#16A34A`

| Email | Mot de passe | Rôle | Page d'accueil |
|-------|-------------|------|----------------|
| `admin@artisanpro.com` | `Admin1234!` | admin | `/dashboard` |
| `employe2@artisanpro.com` | `Admin1234!` | employee | `/mon-espace` |

### Openlab Consulting — thème indigo

| Email | Mot de passe | Rôle | Page d'accueil |
|-------|-------------|------|----------------|
| `coulwao@gmail.com` | `Openlab2025!` | admin | `/dashboard` |

---

## 4. Architecture multi-tenant

### Stratégie : schema-per-tenant

```
PostgreSQL
├── schema platform              ← tables globales (tenants, platform_users)
├── schema tenant_techcorp       ← toutes les données RH de TechCorp
├── schema tenant_artisanpro     ← toutes les données RH d'ArtisanPro
└── schema tenant_openlab_...    ← toutes les données RH d'Openlab
```

Chaque schéma tenant contient exactement les mêmes tables (créées par `provisioning.ts`) : `users`, `employees`, `departments`, `contracts`, `payroll_rules`, `pay_slips`, `absences`, `expense_reports`, `training_courses`, etc.

### Résolution du tenant par requête

```
1. Le client envoie le JWT dans Authorization: Bearer <token>
2. JWT contient : { sub, email, role, tenantId, schemaName, employeeId }
3. Plugin tenant.ts extrait schemaName
4. getTenantDbForRequest(request) → pool Drizzle avec search_path = schemaName
5. Toutes les requêtes DB suivantes s'exécutent dans le bon schéma
```

**Fichiers clés** :
- `apps/api/src/plugins/tenant.ts` — middleware résolution
- `apps/api/src/db/client.ts` — pool par schéma
- `apps/api/src/db/provisioning.ts` — création d'un nouveau tenant

### Quotas par plan

| Plan | Max utilisateurs | Max employés |
|------|-----------------|--------------|
| trial | 10 | 20 |
| starter | 50 | 100 |
| pro | 200 | 500 |
| enterprise | 9 999 | 9 999 |

---

## 5. Cartographie du monorepo

```
nexusrh/
├── apps/
│   ├── api/                          ← Backend Fastify
│   │   └── src/
│   │       ├── app.ts                ← Enregistrement plugins + routes
│   │       ├── config.ts             ← Variables d'env (Zod)
│   │       ├── index.ts              ← Démarrage + migrations startup
│   │       ├── db/
│   │       │   ├── client.ts         ← Pools Drizzle par tenant
│   │       │   ├── schema/           ← Définitions tables (platform + tenant)
│   │       │   ├── provisioning.ts   ← Création schéma + tables d'un tenant
│   │       │   ├── migrate.ts        ← Migrations Drizzle
│   │       │   ├── migrate-validation-level.ts  ← Migration validation_level
│   │       │   └── seed.ts           ← Données TechCorp + ArtisanPro
│   │       ├── modules/
│   │       │   ├── auth/             ← Login (super_admin + tenant), MFA, refresh
│   │       │   ├── employees/        ← CRUD + my-profile endpoint
│   │       │   ├── payroll/          ← Moteur calcul + bulletins PDF
│   │       │   ├── absences/         ← Demandes + workflow multi-niveaux
│   │       │   ├── expenses/         ← Notes de frais + workflow multi-niveaux
│   │       │   ├── recruitment/      ← Offres + pipeline Kanban
│   │       │   ├── training/         ← Catalogue + inscriptions
│   │       │   ├── careers/          ← Compétences + 9-box + évaluations
│   │       │   ├── platform/         ← Gestion tenants (super_admin uniquement)
│   │       │   ├── settings/         ← Paramètres tenant + workflow configs
│   │       │   ├── reporting/        ← KPIs + exports
│   │       │   └── ai/               ← Chat SSE + génération documents
│   │       ├── plugins/              ← auth, tenant, cors, swagger, rateLimit
│   │       ├── scripts/
│   │       │   └── reset-tenant-admin.ts  ← Réinitialisation mot de passe admin
│   │       └── services/
│   │           ├── email.service.ts  ← Nodemailer + MJML (Gmail supporté)
│   │           ├── pdf.service.ts    ← PDFKit
│   │           ├── storage.service.ts ← S3/MinIO (fallback base64)
│   │           └── ai.service.ts     ← Anthropic SDK
│   │
│   └── web/                          ← Frontend React
│       └── src/
│           ├── App.tsx               ← Routeur + guards par rôle
│           ├── stores/authStore.ts   ← Zustand (user + tenantConfig)
│           ├── guards/               ← RoleGuard, PlatformGuard
│           ├── layouts/              ← Sidebar adaptative par rôle
│           ├── pages/
│           │   ├── auth/             ← LoginPage (thème tenant dynamique)
│           │   ├── dashboard/        ← 3 variantes (admin/manager/employee)
│           │   ├── platform/         ← Portail super_admin
│           │   ├── mon-espace/       ← Self-service (absences, bulletins,
│           │   │                        notes de frais, formation, profil)
│           │   ├── employees/
│           │   ├── payroll/
│           │   ├── absences/
│           │   ├── expenses/
│           │   ├── recruitment/
│           │   ├── training/
│           │   └── settings/
│           └── components/
│
├── packages/
│   └── shared/                       ← Types TypeScript partagés
│
├── docker-compose.yml
├── .env.example
├── CLAUDE.md                         ← Contexte maître Claude Code
└── README.md                         ← Ce fichier
```

---

## 6. Backend Fastify

### Pattern général d'une route

```typescript
fastify.get('/employees', {
  preHandler: [fastify.authorize('admin', 'hr_manager')],   // RBAC
  handler: async (request, reply) => {
    const db = getTenantDbForRequest(request)               // pool scopé au tenant
    const list = await db.query.employees.findMany({ ... })
    return reply.send({ data: list })
  },
})
```

### Migration lazy (pattern ensureSchemaMigrated)

Certaines colonnes ont été ajoutées après la création initiale des tenants. Pour éviter de casser les tenants existants, un mécanisme de migration lazy est utilisé :

```typescript
const migratedSchemas = new Set<string>()

async function ensureSchemaMigrated(schemaName: string) {
  if (migratedSchemas.has(schemaName)) return
  await pool.query(
    `ALTER TABLE "${schemaName}".absences ADD COLUMN IF NOT EXISTS validation_level INT NOT NULL DEFAULT 0`
  ).catch(() => undefined)
  migratedSchemas.add(schemaName)
}

// Appelé en début de chaque handler concerné :
await ensureSchemaMigrated(request.user.schemaName)
```

Ce pattern est utilisé dans `absences.routes.ts` et `expenses.routes.ts`.

### Modules API — routes principales

| Module | Préfixe | Rôles autorisés |
|--------|---------|-----------------|
| Auth | `/auth` | public |
| Employees | `/employees` | admin, hr_manager, hr_officer, manager |
| My Profile | `/employees/my-profile` | tous (employee propre profil) |
| Payroll | `/payroll` | admin, hr_manager |
| My Payslips | `/payroll/my-payslips` | employee |
| Absences | `/absences` | selon action |
| My Absences | `/absences/my-absences` | employee |
| Expenses | `/expenses/reports` | selon action |
| My Expenses | `/expenses/my-expenses` | employee |
| Platform | `/platform` | super_admin uniquement |
| Settings | `/settings/workflow` | admin, hr_manager |

---

## 7. Frontend React

### Routing par rôle

```
super_admin  →  /platform/*          (PlatformGuard)
admin        →  /dashboard, /employees, /payroll, ...
hr_manager   →  idem admin sauf settings tenant
manager      →  /dashboard (vue équipe), /absences, /expenses
employee     →  /mon-espace/*        (sidebar réduite, 5 pages)
```

Tout accès non autorisé est redirigé automatiquement :
- `employee` tentant d'accéder à `/employees` → redirigé vers `/mon-espace`
- Non authentifié → redirigé vers `/login`

### Thématisation dynamique

Au login, l'API retourne `tenantConfig: { primaryColor, secondaryColor, logoUrl, name }`.

```typescript
// App.tsx au boot
document.documentElement.style.setProperty('--primary', tenantConfig.primaryColor)
document.documentElement.style.setProperty('--secondary', tenantConfig.secondaryColor)
```

Les composants shadcn/ui héritent automatiquement de ces CSS variables.

### Espace self-service employé (`/mon-espace`)

| Page | Route | Fonctionnalité |
|------|-------|----------------|
| Dashboard | `/mon-espace` | Soldes congés, dernières absences/frais |
| Mes absences | `/mon-espace/absences` | Demander, suivre, annuler |
| Mes bulletins | `/mon-espace/bulletins` | Télécharger PDF, voir historique |
| Mes notes de frais | `/mon-espace/notes-de-frais` | Créer, soumettre, suivre |
| Ma formation | `/mon-espace/formation` | Catalogue, inscription |
| Mon profil | `/mon-espace/profil` | Modifier téléphone/adresse/IBAN, MFA |

### Calcul automatique TTC

Dans le formulaire de note de frais, le TTC est calculé automatiquement à partir du HT + TVA :

```typescript
onChange: (e) => {
  const ht = parseFloat(e.target.value) || 0
  const tva = parseFloat(String(watch(`items.${i}.tva`))) || 0
  setValue(`items.${i}.amountTtc`, parseFloat((ht * (1 + tva / 100)).toFixed(2)))
}
```

---

## 8. Authentification et RBAC

### Flux de login

```
POST /auth/login { email, password }
  ↓
1. Cherche dans platform.platform_users (super_admin)
2. Sinon : parcourt tous les tenants non suspendus → cherche l'email dans {schema}.users
3. Vérifie bcryptjs.compare(password, hash)
4. Si MFA activé → retourne { requiresMfa: true }
5. Signe JWT : { sub, email, role, tenantId, schemaName, employeeId }
6. Crée un refresh token (30j)
7. Retourne { accessToken, refreshToken, user, tenantConfig }
```

### JWT payload

```typescript
{
  sub: string          // users.id
  email: string
  role: string         // admin | hr_manager | hr_officer | manager | employee | super_admin
  tenantId: string     // platform.tenants.id
  schemaName: string   // ex: "tenant_techcorp"
  employeeId?: string  // employees.id (null pour admin/hr sans fiche employé)
}
```

### Middleware authorize

```typescript
fastify.authorize('admin', 'hr_manager')
// → vérifie JWT + rôle parmi la liste
// → 401 si non authentifié, 403 si rôle insuffisant
```

---

## 9. Moteur de paie

**Fichier clé** : `apps/api/src/modules/payroll/payroll.engine.ts`

### Algorithme de calcul

```
1. buildVariables() → BRUT, PLAFOND_SS, TRANCHE_A, TRANCHE_B, SMIC
   + variableElements du mois (primes, absences, heures supp)
2. Pour chaque payroll_rule (triée par order) :
   - Évaluer formula dans un contexte sécurisé (whitelist [A-Z0-9_+\-*/.()])
   - Stocker le résultat dans vars pour les règles suivantes
3. computeTotals() :
   grossSalary  = Σ(earning)
   netBeforeTax = grossSalary - Σ(employee_contribution) - Σ(deduction)
   employerCost = grossSalary + Σ(employer_contribution)
   netPayable   = netBeforeTax  (PAS via DSN)
```

### Constantes légales France 2024

```
SMIC mensuel 35h  : 1 766,92 €    Plafond SS mensuel : 3 864 €
CSG déductible    : 6,80 %        CSG non déductible : 2,40 %
CRDS              : 0,50 %        Maladie patronale  : 7,00 % (≥10 sal.)
AGIRC-ARRCO T1 sal: 3,15 %       AGIRC-ARRCO T1 pat : 4,72 %
Retraite base sal : 6,90 % (TA)  Retraite base pat  : 8,55 % (TA)
```

---

## 10. Workflows d'approbation

Les modules **absences** et **notes de frais** supportent un workflow multi-niveaux configurable (1 à 4 niveaux).

### Configuration

```typescript
// Table workflow_configs (créée automatiquement dans chaque schéma tenant)
{
  module: 'absences' | 'expenses',
  levels_count: 1,           // nombre de niveaux requis
  level1_role: 'manager',    // rôle requis au niveau 1
  level2_role: 'hr_manager', // rôle requis au niveau 2 (si levels_count >= 2)
}
```

### Fonctionnement

```
Demande soumise → status = 'pending' / 'submitted', validation_level = 0
Approbation N1  → validation_level = 1
  Si levels_count = 1 → status = 'approved', fin
  Si levels_count > 1 → reste en attente du N2
Approbation N2  → validation_level = 2
  Si levels_count = 2 → status = 'approved', fin
  ...
Refus à tout niveau → status = 'rejected', rejectionReason stocké
```

### API

```
PATCH /absences/:id/approve     → valide le niveau courant
PATCH /absences/:id/reject      → rejette
PATCH /expenses/reports/:id/approve
PATCH /expenses/reports/:id/reject
GET  /settings/workflow/:module → lire la config
PUT  /settings/workflow/:module → modifier la config
```

---

## 11. Services transverses

### Email (Nodemailer + MJML)

Configuré via variables d'environnement SMTP. Compatible **Gmail avec App Password** :

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre.adresse@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # App Password Gmail (16 caractères, espaces OK)
SMTP_FROM=NexusRH <votre.adresse@gmail.com>
```

Emails envoyés automatiquement :
- **Création tenant** → mot de passe temporaire à l'admin
- **Bulletin de paie** → notification avec PDF en pièce jointe
- **Demande d'absence** → notification au manager
- **Réinitialisation mot de passe** → lien sécurisé (1h)

### Stockage fichiers (S3/MinIO)

Si MinIO n'est pas disponible, le service bascule automatiquement en **fallback base64** (logos stockés comme data URI). Aucune erreur bloquante.

### IA (Anthropic claude-sonnet-4-20250514)

- Chat SSE en streaming : `GET /ai/chat`
- Génération de documents RH : `POST /ai/generate-document`
- Analyse de risque de départ : `POST /ai/retention-risk`

---

## 12. Portail super_admin

Accessible uniquement avec le rôle `super_admin`. Aucun accès aux données RH des tenants.

### Pages

```
/platform/dashboard      KPIs (tenants actifs, trial, employés total, MRR estimé)
/platform/tenants        Tableau paginé + recherche + filtres
/platform/tenants/new    Wizard création (3 étapes)
/platform/logs           Logs d'activité
/platform/settings       Paramètres globaux
```

### Création d'un tenant (wizard 3 étapes)

```
Étape 1 : Société
  Nom | Slug | Plan (trial/starter/pro/enterprise) | Max users | Max employés
  Statut initial (Actif / Trial) | Secteur

Étape 2 : Admin principal
  Prénom | Nom | Email | Téléphone

Étape 3 : Apparence
  Logo (upload — fallback base64 si MinIO indisponible)
  Couleur primaire | Couleur secondaire | Prévisualisation live

→ API :
  a. INSERT platform.tenants (avec max_users, max_employees selon plan)
  b. CREATE SCHEMA + toutes les tables RH (provisioning.ts)
  c. INSERT admin user (is_active = true, bcryptjs hash)
  d. Email de bienvenue avec mot de passe temporaire
  e. Retour du tempPassword dans la réponse (copie de secours)
```

### Gestion d'un tenant existant (drawer édition)

- **Statut** : bouton Activer (si trial/suspendu) ou Suspendre (si actif)
- **Plan** : modifier plan + maxUsers + maxEmployees + trialEndsAt
- **Apparence** : couleurs + logo (re-upload)
- **Admin access** : bouton "Réinitialiser le mot de passe admin" → génère nouveau mot de passe et l'affiche

### Endpoints plateforme

```
GET  /platform/tenants                    liste paginée
POST /platform/tenants                    créer
GET  /platform/tenants/:id                détail
PUT  /platform/tenants/:id                modifier
POST /platform/tenants/:id/logo           uploader logo
POST /platform/tenants/:id/activate       activer
POST /platform/tenants/:id/suspend        suspendre
POST /platform/tenants/:id/reset-admin    réinitialiser mot de passe admin
GET  /platform/tenants/:id/admin-status   diagnostic (schema, user, is_active)
GET  /platform/tenants/:id/users          utilisateurs du tenant
DELETE /platform/tenants/:id              supprimer (DROP SCHEMA CASCADE)
```

---

## 13. Scripts utilitaires

```bash
# Base de données
pnpm --filter api run db:seed              # Seed complet (TechCorp + ArtisanPro)
pnpm --filter api run db:migrate           # Migrations Drizzle
pnpm --filter api run db:migrate-validation # Ajoute validation_level aux tenants existants
pnpm --filter api run db:studio            # Drizzle Studio (UI d'exploration)

# Récupération d'accès (en cas de 401 inexpliqué)
pnpm --filter api run admin:reset <email> <nouveau_mot_de_passe>
# Exemple :
pnpm --filter api run admin:reset coulwao@gmail.com Openlab2025!

# Diagnostic tenant (via Swagger ou curl)
GET /platform/tenants/:id/admin-status
# Retourne : schemaExists, adminUser, is_active, hasPasswordHash, issue
```

### Connexion directe à PostgreSQL

```bash
# Depuis Docker
docker exec -it nexusrh-postgres psql -U nexusrh -d nexusrh

# Depuis le host (port 5433)
PGPASSWORD=nexusrh psql -h localhost -p 5433 -U nexusrh -d nexusrh

# Requêtes utiles
\dn                                        -- lister les schémas
SELECT * FROM platform.tenants;
SELECT email, is_active, role FROM tenant_techcorp.users;
SELECT count(*) FROM tenant_techcorp.employees;
```

---

## 14. Variables d'environnement

```bash
# Application
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
API_PORT=4000
JWT_SECRET=<min 32 caractères>

# Base de données
DATABASE_URL=postgresql://nexusrh:nexusrh@localhost:5433/nexusrh

# Redis
REDIS_URL=redis://localhost:6379

# Email (Gmail App Password)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
SMTP_FROM=NexusRH <votre@gmail.com>

# Stockage (MinIO local)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=nexusrh
S3_REGION=eu-west-1
S3_FORCE_PATH_STYLE=true

# IA (optionnel)
ANTHROPIC_API_KEY=sk-ant-api03-...
AI_MODEL=claude-sonnet-4-20250514

# Meilisearch
MEILISEARCH_URL=http://localhost:7700
MEILISEARCH_MASTER_KEY=nexusrh-dev-master-key
```

---

## 15. Tests

```bash
# Tests unitaires (Vitest)
pnpm --filter api run test
pnpm --filter api run test:watch

# Tests E2E (Playwright)
pnpm --filter web run test:e2e
```

### Couverture des tests unitaires API

| Fichier | Tests | Couverture |
|---------|-------|------------|
| `absences.logic.test.ts` | 19 tests | Workflow, calcul jours ouvrés, guards |
| `expenses.logic.test.ts` | 21 tests | Workflow, TTC auto, mois, approbation |
| `rbac.test.ts` | 20 tests | Matrix permissions, JWT payload |
| `employee.validator.test.ts` | 23 tests | Zod schemas, validations métier |
| `workflow.config.test.ts` | 21 tests | Config 1-4 niveaux, state machine |
| `auth.service.test.ts` | ≥10 tests | Hashing bcryptjs, tokens |
| `payroll.engine.test.ts` | ≥10 tests | Calcul cotisations, net à payer |

---

## Troubleshooting

### 401 au login

1. Vérifier que le tenant n'est pas `suspended` dans `platform.tenants`
2. Vérifier que l'utilisateur est `is_active = true` dans `{schema}.users`
3. Réinitialiser le mot de passe :
   ```bash
   pnpm --filter api run admin:reset email@exemple.com NouveauMotDePasse123!
   ```
4. Ou via l'UI : portail super_admin → éditer le tenant → "Réinitialiser le mot de passe admin"

### Email non reçu

1. Vérifier les variables SMTP dans `.env`
2. Pour Gmail : utiliser un **App Password** (pas le mot de passe principal)
   - Google Account → Sécurité → Validation en 2 étapes → Mots de passe d'application
3. Le mot de passe temporaire est aussi retourné dans la réponse API de création tenant (visible dans le wizard)

### Colonnes manquantes (500 sur absences/expenses)

Exécuter la migration de rattrapage :
```bash
pnpm --filter api run db:migrate-validation
```
Ou redémarrer l'API — la migration lazy s'exécute automatiquement au premier appel.

### Port PostgreSQL 5432 vs 5433

Le projet tourne sur le port **5433** (défini dans `docker-compose.yml`). Si vous avez une instance PostgreSQL locale sur 5432, les deux coexistent sans conflit.

---

## 16. Déploiement gratuit (Neon + Upstash + Cloudflare R2 + Fly.io)

Il est possible de déployer NexusRH **entièrement gratuitement** avec la stack suivante :

| Service | Rôle | Limite gratuite |
|---------|------|-----------------|
| [Neon](https://neon.tech) | PostgreSQL serverless | 0.5 GB, suspend après 5 min inactivité |
| [Upstash](https://upstash.com) | Redis (BullMQ) | 10 000 req/jour |
| [Cloudflare R2](https://cloudflare.com/r2) | Stockage fichiers (S3-compatible) | 10 GB, 1M opérations/mois |
| [Fly.io](https://fly.io) | API + Worker Node.js | 3 VMs partagées, 160 GB bande passante/mois |
| [Cloudflare Pages](https://pages.cloudflare.com) | Frontend React (CDN mondial) | 500 builds/mois, illimité |
| Gmail App Password | SMTP email | Gratuit |

> **Note :** Fly.io requiert une carte bancaire pour lutter contre les abus (0 € débité sur le tier gratuit).

### Déploiement automatique (script interactif)

```bash
chmod +x deploy-free.sh
./deploy-free.sh
```

Le script vous guide étape par étape (15–25 minutes) et configure automatiquement tous les secrets.

### Déploiement manuel

#### 1. Base de données — Neon

1. Créer un compte sur [neon.tech](https://neon.tech)
2. Nouveau projet → copier la **Connection string**
3. Format : `postgresql://user:pass@ep-xxx.region.aws.neon.tech/nexusrh?sslmode=require`

#### 2. Redis — Upstash

1. Créer un compte sur [upstash.com](https://upstash.com)
2. Create Database → Redis → région la plus proche
3. Copier l'**URL Redis** (format `rediss://default:xxx@xxx.upstash.io:6379`)

#### 3. Stockage — Cloudflare R2

1. Dashboard Cloudflare → **R2** → Create bucket `nexusrh`
2. **Manage R2 API tokens** → Create token → Read+Write
3. Copier : Account ID, Access Key ID, Secret Access Key

#### 4. Préparer le fichier .env

```bash
cp .env.free.example .env
# Remplir DATABASE_URL, REDIS_URL, S3_*, SMTP_*, JWT_SECRET
```

Générer un JWT_SECRET sécurisé :
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

#### 5. API — Fly.io

```bash
# Installer flyctl
curl -L https://fly.io/install.sh | sh

# Authentification
flyctl auth login

# Créer et déployer l'API
flyctl apps create nexusrh-api --org personal
flyctl secrets import --app nexusrh-api < .env
flyctl deploy --app nexusrh-api --config fly.toml --remote-only

# Initialiser la base de données
flyctl ssh console --app nexusrh-api --command "node dist/db/seed.js"

# Déployer le worker
flyctl apps create nexusrh-worker --org personal
flyctl secrets import --app nexusrh-worker < .env
flyctl deploy --app nexusrh-worker --config fly.worker.toml --remote-only
```

#### 6. Frontend — Cloudflare Pages

```bash
# Build avec l'URL de l'API Fly.io
VITE_API_URL=https://nexusrh-api.fly.dev pnpm --filter @nexusrh/shared build
VITE_API_URL=https://nexusrh-api.fly.dev pnpm --filter web build

# Déployer via wrangler
npx wrangler pages deploy apps/web/dist --project-name nexusrh-web
```

Ou depuis le dashboard Cloudflare Pages :
- Build command : `VITE_API_URL=https://nexusrh-api.fly.dev pnpm --filter web build`
- Output directory : `apps/web/dist`

#### 7. Recherche — Fallback automatique PostgreSQL

Sur le tier gratuit, Meilisearch n'est pas nécessaire. Le service `search.service.ts` détecte automatiquement que Meilisearch n'est pas configuré et bascule sur une **recherche PostgreSQL full-text** (utilise `plainto_tsquery('french', ...)`).

Pour activer Meilisearch plus tard (Render free tier par exemple) :
```bash
# Build l'image
docker build -f Dockerfile.meilisearch -t nexusrh-meilisearch .

# Variables à ajouter dans .env
MEILISEARCH_URL=https://votre-meilisearch.onrender.com
MEILISEARCH_MASTER_KEY=votre-cle-secrete
```

### Limites et optimisations pour le tier gratuit

| Limite | Impact | Solution |
|--------|--------|----------|
| Neon suspend après 5 min | Premier hit lent (~500ms) | Normal — wake-up automatique |
| Upstash 10k req/jour | BullMQ limité | Réduire la fréquence des jobs |
| Fly.io VM s'arrête si inactif | Cold start ~2s | `min_machines_running = 1` ($1.94/mois) |
| R2 1M opérations/mois | Uploads en prod | Très largement suffisant pour démarrer |

### Passer en production payante

Pour scaler, remplacer uniquement les composants qui atteignent leurs limites :

```
Neon → Neon Pro ($19/mois) ou Supabase Pro ($25/mois)
Upstash → Upstash Pay-as-you-go (~$0.20/100k req)
Fly.io → Performance-1x ($7.19/mois par VM)
R2 → R2 reste très bon marché ($0.015/GB/mois)
```

---

_NexusRH — SIRH SaaS Multi-Tenant · Propulsé par Claude AI · Fait pour les RH françaises_
