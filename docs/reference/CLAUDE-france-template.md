# CLAUDE.md — NexusRH : SIRH SaaS Multi-Tenant

> Contexte maître pour Claude Code. Placé à la racine `/nexusrh/CLAUDE.md`.
> Les specs détaillées (référence, lues à la demande) sont dans `docs/reference/` — voir l'index en bas.

---

## MISSION

**NexusRH** — un SIRH SaaS **multi-tenant** production-ready.
Chaque entreprise cliente est un **tenant isolé** (schéma PostgreSQL dédié).
Un **super_admin** de plateforme gère les tenants. Chaque tenant a son propre **admin**.
**Fichiers complets. Pas de TODO, pas de pseudo-code, pas de confirmation.**

> Le projet est déjà scaffoldé dans `D:/OPENLAB/nexusrh/`. Ne pas régénérer la structure.

---

## RÈGLES ABSOLUES

1. Fichiers réels et complets — jamais de `// à compléter`
2. TypeScript strict — pas de `any`, pas de `@ts-ignore`
3. Gestion d'erreurs exhaustive — chaque async a son try/catch
4. Jamais de secrets hardcodés — toujours des variables d'environnement
5. Génère dans l'ordre : infra → shared → api → web → tests
6. Après chaque module : vérifie la compilation (`tsc --noEmit`)
7. **Le seed doit créer des données visibles et fonctionnelles dès le premier lancement**
8. **Chaque route et chaque bouton UI doivent fonctionner sans erreur 404/500**

---

## STACK TECHNIQUE (NE PAS DÉVIER)

```
Monorepo pnpm+Turborepo · React 18 + TS 5 + Vite 5 · shadcn/ui + Radix + Tailwind 3
Framer Motion 11 · Zustand 4 + TanStack Query 5 · React Hook Form + Zod · React Router 6
Backend Node 20 + Fastify 4 + TS · Drizzle ORM (PostgreSQL multi-schema) · PostgreSQL 16 + Redis 7
IA @anthropic-ai/sdk (claude-sonnet-4-20250514) · Auth @fastify/jwt + oauth2 + otplib (MFA)
PDF PDFKit + @react-pdf/renderer · Email Nodemailer + mjml · Files AWS SDK v3 (S3/MinIO)
Search Meilisearch · Charts Recharts · i18n react-i18next · Tests Vitest + Playwright
CI/CD GitHub Actions + Docker · Jobs BullMQ
```

---

## ARCHITECTURE MULTI-TENANT (CRITIQUE)

**Stratégie : schema-per-tenant.**

```
schema "platform"          ← tables globales (tenants, platform_users, settings)
schema "tenant_<slug>"     ← toutes les tables RH d'un client (isolées)
```

**Résolution du tenant (middleware Fastify) :**
1. JWT contient `{ userId, tenantId, schemaName, role }`
2. `tenant.ts` extrait `schemaName` du token
3. Chaque requête DB : `SET search_path = {schemaName}, shared`
4. Le code applicatif n'écrit **JAMAIS** le nom du schema en dur
5. `super_admin` = accès au schema `platform` uniquement (zéro donnée RH)

**Tables `platform`** : `tenants` (slug, name, planType, status, schemaName, maxUsers, maxEmployees, primaryColor, secondaryColor, logoUrl…), `platform_users` (super_admin), `tenant_invitations`.

**Tables par tenant** : `users, employees, departments, legal_entities, contracts, payroll_rules, pay_periods, pay_slips, variable_elements, absence_types, absence_balances, absences, recruitment_jobs, applications, trainings, training_sessions, training_enrollments, expenses, expense_items, career_skills, employee_skills, evaluations, hr_events, employee_documents, notifications, audit_log, refresh_tokens`.

---

## RÔLES ET PERMISSIONS (RBAC — appliqué API **ET** front)

```
super_admin  → Plateforme uniquement. Crée/gère les tenants. Zéro accès RH.
admin        → Admin d'un tenant. Tous les droits RH dans son tenant.
hr_manager   → Gère tous les employés, paie, absences, recrutement.
hr_officer   → Saisie et consultation RH, pas de clôture paie ni suppression.
manager      → Voit son équipe. Approuve absences/frais de ses subordonnés.
employee     → Uniquement son propre espace self-service.
readonly     → Consultation seule, aucune modification.
```

| Module | admin | hr_mgr | hr_off | manager | employee | readonly |
|---|---|---|---|---|---|---|
| Paramétrage tenant | RW | - | - | - | - | - |
| Employés (tous) | RW | RW | RW | R | - | R |
| Mon profil | - | - | - | - | R | - |
| Contrats | RW | RW | R | - | R(sien) | R |
| Paie clôture | RW | RW | - | - | - | - |
| Bulletins (tous) | RW | RW | R | - | - | R |
| Mon bulletin | - | - | - | - | R | - |
| Absences (saisie) | RW | RW | RW | RW(équipe) | RW(soi) | - |
| Absences (approbation) | RW | RW | - | RW(équipe) | - | - |
| Recrutement | RW | RW | RW | R | - | R |
| Formation (admin) | RW | RW | RW | R | - | R |
| Formation (inscription) | - | - | - | - | RW | - |
| Notes de frais (saisie) | RW | RW | RW | RW(équipe) | RW(soi) | - |
| Notes de frais (valid.) | RW | RW | - | RW(équipe) | - | - |
| Carrière/Compétences | RW | RW | RW | RW(équipe) | R(soi) | R |
| Reporting | RW | RW | R | R(équipe) | - | R |
| IA Assistant | RW | RW | RW | RW | R(limité) | - |
| Utilisateurs tenant | RW | - | - | - | - | - |

**3 variantes de dashboard** : plateforme (`/platform/dashboard`) · RH-admin-manager (`/dashboard`) · employee (`/mon-espace`, sidebar réduite). Détail des écrans → `docs/reference/specs-fonctionnelles.md`.

---

## PATTERNS ET PIÈGES — ACQUIS EN PRODUCTION

### 1. findTenantAndUser — email en double entre tenants
Si le même email est admin dans plusieurs tenants, retourner le premier candidat donne un mauvais hash → 401. **Solution** : collecter TOUS les candidats puis comparer le mot de passe pour chacun, retourner celui dont le hash valide. **Toujours passer le mot de passe en paramètre.**

```typescript
// auth.routes.ts — findTenantAndUser(pool, email, password)
const candidates = []
for (const tenant of tenants) {
  const user = await findUserInSchema(tenant.schema_name, email)
  if (user) candidates.push({ tenant, user })
}
if (candidates.length === 1) return candidates[0]
for (const c of candidates) {
  if (await bcrypt.compare(password, c.user.password_hash)) return c
}
```

### 2. maxUsers / maxEmployees — toujours dans l'INSERT tenant
```typescript
const PLAN_DEFAULTS = {
  trial:      { maxUsers: 10,   maxEmployees: 20   },
  starter:    { maxUsers: 50,   maxEmployees: 100  },
  pro:        { maxUsers: 200,  maxEmployees: 500  },
  enterprise: { maxUsers: 9999, maxEmployees: 9999 },
}
```

### 3. Email de bienvenue — Gmail App Password
Transporter Nodemailer Gmail : `requireTLS: true` + `tls: { rejectUnauthorized: false }` (sinon STARTTLS échoue silencieusement). Le mot de passe temporaire est **toujours renvoyé dans la réponse API** (`tempPassword`) comme filet si l'email échoue. Appel **non bloquant** (`.catch()`) après provisionnement.

### 4. Migration lazy — validation_level
Colonne ajoutée après création des tenants démo. Pour ne pas casser l'existant : `ensureSchemaMigrated(schemaName)` dans **chaque handler absences/expenses** + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (idempotent). Migration explicite : `pnpm --filter api run db:migrate-validation`.

### 5. Formules moteur de paie
`safeEval` n'injecte que les variables calculées (BRUT, TRANCHE_A…) — **PAS les taux**. Embarquer le taux numériquement :
```typescript
formula: 'BASE * RATE'    // FAUX — RATE absent du contexte
formula: 'BASE * 0.068'   // CORRECT
```

### 6. Portail super_admin — création tenant
- **Status initial** : plans non-trial créés `status = 'active'`. Le wizard expose un sélecteur "Statut initial" pour forcer `active` même en trial.
- **Récupération d'accès admin** :
  ```bash
  pnpm --filter api run admin:reset <email> <mot_de_passe>   # CLI
  POST /platform/tenants/:id/reset-admin                     # API → { adminEmail, tempPassword }
  GET  /platform/tenants/:id/admin-status                    # diagnostic (schemaExists, isActive, hasPasswordHash, issue)
  ```

---

## ENV — ÉTAT ACTUEL (réel)

```bash
# Base de données — port 5433 (pas 5432)
DATABASE_URL=postgresql://nexusrh:nexusrh@localhost:5433/nexusrh

# Email Gmail App Password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=coulwao@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # App Password 16 caractères
SMTP_FROM=NexusRH <coulwao@gmail.com>
```

`.env.example` complet → `docs/reference/env-example.md`.

---

## DÉMARRAGE

```bash
cd D:/OPENLAB/nexusrh
cp .env.example .env            # renseigner JWT_SECRET (≥32 chars) + ANTHROPIC_API_KEY (optionnel IA)
docker-compose up -d postgres redis meilisearch minio   # attendre ~15s
pnpm install
pnpm --filter api run db:seed   # platform + super_admin + TechCorp (50 emp) + ArtisanPro (18 emp)
pnpm run dev
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:4000 |
| Swagger | http://localhost:4000/docs |
| MinIO | http://localhost:9001 — `minioadmin / minioadmin` |

---

## COMPTES DE CONNEXION

**Plateforme** — `superadmin@nexusrh.com` / `SuperAdmin1234!` → `/platform/dashboard`

**TechCorp SAS** (thème indigo `#4F46E5`) :
| Email | Mot de passe | Rôle | Redirige |
|---|---|---|---|
| `admin@techcorp.com` | `Admin1234!` | admin | `/dashboard` |
| `rh@techcorp.com` | `Admin1234!` | hr_manager | `/dashboard` |
| `manager@techcorp.com` | `Admin1234!` | manager | `/dashboard` |
| `employe@techcorp.com` | `Admin1234!` | employee | `/mon-espace` |

**Artisan Pro SARL** (thème vert `#16A34A`) :
| Email | Mot de passe | Rôle | Redirige |
|---|---|---|---|
| `admin@artisanpro.com` | `Admin1234!` | admin | `/dashboard` |
| `employe2@artisanpro.com` | `Admin1234!` | employee | `/mon-espace` |

**Openlab Consulting** (créé via portail) — `coulwao@gmail.com` / `Openlab2025!` → admin → `/dashboard`

---

## CHECKLIST AVANT DE GÉNÉRER

- [ ] Architecture multi-tenant (schema-per-tenant) comprise
- [ ] `findTenantAndUser` passe le mot de passe ET itère tous les candidats
- [ ] `max_users` / `max_employees` définis selon plan dans l'INSERT tenant
- [ ] Email de bienvenue appelé après provisionnement (non bloquant — `.catch()`)
- [ ] `ensureSchemaMigrated` appelé dans chaque handler absences/expenses
- [ ] RBAC appliqué côté API (middleware) ET côté front (guards + sidebar)
- [ ] Dashboard différent selon rôle (3 variantes)
- [ ] Espace employee : 5 sections entièrement fonctionnelles
- [ ] Portail super_admin : création tenant + apparence + reset-admin OK
- [ ] Thématisation CSS variables appliquée dynamiquement au login
- [ ] Seed : 2 tenants, données complètes, zéro écran vide
- [ ] Compilation vérifiée après chaque module majeur

---

## INDEX DES RÉFÉRENCES (`docs/reference/` — lire à la demande)

| Fichier | Contenu |
|---|---|
| `docs/reference/specs-fonctionnelles.md` | Dashboards par rôle (détail écrans), portail super_admin (pages + wizard + onglets), thématisation dynamique, espace employé (5 sections), ordre de génération |
| `docs/reference/seed.md` | Détail complet du seed : TechCorp (50 emp, 20 rubriques SYNTEC, 300 bulletins…) + ArtisanPro |
| `docs/reference/paie-ia-legal.md` | Moteur de paie (logique calculate), assistant IA (streamChat / generateHRDocument / retention), constantes légales France 2024 |
| `docs/reference/env-example.md` | `.env.example` complet (toutes les variables) |

---

_NexusRH — SIRH SaaS Multi-Tenant · Propulsé par Claude AI · Fait pour les RH françaises_
