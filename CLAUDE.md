# CLAUDE.md — NexusRH : SIRH SaaS Multi-Tenant

> Contexte maître pour Claude Code. Placé à la racine `/nexusrh/CLAUDE.md`.

---

## MISSION

Générer **NexusRH** — un SIRH SaaS **multi-tenant** production-ready.
Chaque entreprise cliente est un **tenant isolé** (schéma PostgreSQL dédié).
Un **super_admin** de plateforme gère les tenants. Chaque tenant a son propre **admin**.
**Génère tous les fichiers complets. Pas de TODO, pas de pseudo-code, pas de confirmation.**

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
Monorepo      : pnpm workspaces + Turborepo
Frontend      : React 18 + TypeScript 5 + Vite 5
UI            : shadcn/ui + Radix UI + Tailwind CSS 3
Animations    : Framer Motion 11
State         : Zustand 4 + TanStack Query 5
Forms         : React Hook Form + Zod
Router        : React Router 6 (routes protégées par rôle)
Backend       : Node.js 20 LTS + Fastify 4 + TypeScript
ORM           : Drizzle ORM (PostgreSQL, mode multi-schema)
Base données  : PostgreSQL 16 + Redis 7
IA            : @anthropic-ai/sdk — claude-sonnet-4-20250514
Auth          : @fastify/jwt + @fastify/oauth2 + otplib (MFA)
PDF           : PDFKit + @react-pdf/renderer
Email         : Nodemailer + mjml
Files         : AWS SDK v3 (S3/MinIO)
Search        : Meilisearch
Charts        : Recharts
i18n          : react-i18next
Tests unit    : Vitest
Tests E2E     : Playwright
CI/CD         : GitHub Actions + Docker
Jobs async    : BullMQ
```

---

## ARCHITECTURE MULTI-TENANT (CRITIQUE)

### Stratégie : schema-per-tenant

```
PostgreSQL :
  schema "platform"        ← tables globales (tenants, platform_users, settings)
  schema "tenant_techcorp" ← toutes les tables RH de TechCorp (isolées)
  schema "tenant_artisanpro" ← toutes les tables RH d'ArtisanPro (isolées)
```

### Résolution du tenant (middleware Fastify)

```
1. JWT contient : { userId, tenantId, schemaName, role }
2. Middleware tenant.ts : extrait schemaName du token
3. Sur chaque requête DB : SET search_path = {schemaName}, shared
4. Le code applicatif n'écrit JAMAIS le nom du schema en dur
5. super_admin = accès au schema "platform" uniquement (pas aux données RH)
```

### Tables du schema "platform"

```
platform.tenants :
  id uuid PK | slug varchar unique | name varchar
  planType: trial|starter|pro|enterprise | status: active|suspended|trial
  schemaName varchar (ex: "tenant_techcorp")
  maxUsers int | maxEmployees int
  primaryColor varchar | secondaryColor varchar
  logoUrl text | faviconUrl text | customDomain varchar
  trialEndsAt | createdAt | updatedAt

platform.platform_users :
  id uuid PK | email unique | passwordHash | firstName | lastName
  role: super_admin | isActive | mfaEnabled | createdAt | updatedAt

platform.tenant_invitations :
  id uuid PK | tenantId FK | email | role | token unique
  expiresAt | acceptedAt | createdAt
```

### Tables créées dans chaque schema tenant

```
users, employees, departments, legal_entities, contracts, payroll_rules,
pay_periods, pay_slips, variable_elements, absence_types, absence_balances,
absences, recruitment_jobs, applications, trainings, training_sessions,
training_enrollments, expenses, expense_items, career_skills,
employee_skills, evaluations, hr_events, employee_documents,
notifications, audit_log, refresh_tokens
```

---

## RÔLES ET PERMISSIONS (RBAC COMPLET)

### Hiérarchie des rôles

```
super_admin  → Plateforme uniquement. Crée/gère les tenants. Zéro accès aux données RH.
admin        → Admin d'un tenant. Tous les droits RH dans son tenant.
hr_manager   → Gère tous les employés, paie, absences, recrutement.
hr_officer   → Saisie et consultation RH, pas de clôture paie ni suppression.
manager      → Voit son équipe. Approuve absences/frais de ses subordonnés.
employee     → Uniquement son propre espace self-service.
readonly     → Consultation seule, aucune modification.
```

### Matrice des permissions

```
Module                  admin  hr_mgr  hr_off  manager  employee  readonly
────────────────────────────────────────────────────────────────────────────
Paramétrage tenant       RW      -       -        -        -         -
Employés (tous)          RW     RW      RW        R        -         R
Mon profil               -       -       -        -        R         -
Contrats                 RW     RW       R        -      R(sien)     R
Paie clôture             RW     RW       -        -        -         -
Bulletins (tous)         RW     RW       R        -        -         R
Mon bulletin             -       -       -        -        R         -
Absences (saisie)        RW     RW      RW     RW(équipe) RW(soi)    -
Absences (approbation)   RW     RW       -     RW(équipe)  -         -
Recrutement              RW     RW      RW        R        -         R
Formation (admin)        RW     RW      RW        R        -         R
Formation (inscription)  -       -       -        -        RW        -
Notes de frais (saisie)  RW     RW      RW     RW(équipe) RW(soi)    -
Notes de frais (valid.)  RW     RW       -     RW(équipe)  -         -
Carrière/Compétences     RW     RW      RW     RW(équipe) R(soi)     R
Reporting                RW     RW       R     R(équipe)   -         R
IA Assistant             RW     RW      RW       RW       R(limité)  -
Utilisateurs tenant      RW      -       -        -        -         -
```

---

## DASHBOARDS PAR RÔLE (AFFICHAGE DIFFÉRENCIÉ — CRITIQUE)

### Dashboard super_admin → `/platform/dashboard`

```
Redirection automatique depuis "/" si rôle = super_admin.
Sidebar : Tenants | Logs | Paramètres plateforme (UNIQUEMENT)

Contenu :
  KPI Cards : [Tenants actifs] [En trial] [Total employés] [MRR estimé]
  Tableau tenants : nom, plan, nb users, nb employés, status, actions
  Graphique : croissance tenants (12 mois, LineChart)
  Alertes : trials expirant sous 7 jours, tenants suspendus
  Actions : [+ Créer un tenant] [Voir logs]
```

### Dashboard admin / hr_manager / hr_officer → `/dashboard`

```
Sidebar complète avec tous les modules RH.

Contenu :
  KPI Cards : [Effectifs actifs] [Masse salariale] [Taux absentéisme] [Postes ouverts]
  Graphiques : évolution effectifs (LineChart 12 mois), répartition depts (BarChart)
  Insights IA : 3 alertes max (risque départ, essais qui expirent, absentéisme anormal)
  Panneaux : absences du jour | anniversaires du mois | entrées/sorties
```

### Dashboard manager → `/dashboard`

```
Sidebar : Tableau de bord | Mon équipe | Absences | Notes de frais | Formations (lecture)

Contenu :
  KPI Cards : [Mon équipe] [Absences aujourd'hui] [Demandes à valider] [Formations en cours]
  Liste de son équipe directe avec statuts
  Demandes d'absence à approuver (badge rouge si en attente)
  Notes de frais à valider
```

### Dashboard employee → `/mon-espace` (SIDEBAR RÉDUITE)

```
Sidebar uniquement :
  Mon espace (dashboard) | Mes absences | Mes bulletins | Mes notes de frais
  Ma formation | Mon profil

Contenu dashboard :
  Soldes congés (CP, RTT, récup) — barres de progression colorées
  Prochain bulletin disponible (badge "Nouveau" si non consulté)
  Mes 3 dernières absences + statut (badge couleur)
  Mes 3 dernières notes de frais + statut
  Formations recommandées (2 cards)

AUCUN accès à : employés autres, paie globale, recrutement, reporting, paramétrage, IA avancée.
Toute tentative de navigation vers ces routes → redirection vers /mon-espace.
```

---

## PORTAIL SUPER ADMIN — GESTION DES TENANTS

### Pages `/platform/*`

```
/platform/dashboard          ← KPIs globaux plateforme
/platform/tenants            ← Tableau paginé de tous les tenants
/platform/tenants/new        ← Formulaire création tenant (wizard 3 étapes)
/platform/tenants/:id        ← Détail + 4 onglets de paramétrage
/platform/tenants/:id/users  ← Utilisateurs du tenant (lecture + suspension)
/platform/logs               ← Logs d'activité cross-tenant
/platform/settings           ← Paramètres globaux plateforme
```

### Workflow création tenant

```
Étape 1 : Infos société
  Nom | Slug (auto + modifiable) | Plan | Pays | Secteur

Étape 2 : Admin principal
  Email | Prénom | Nom | Téléphone

Étape 3 : Apparence
  Couleur primaire (color picker) | Couleur secondaire | Logo (upload)
  Prévisualisation live

→ API exécute :
  a. INSERT INTO platform.tenants
  b. CREATE SCHEMA tenant_{slug}
  c. Drizzle migrate programmatique sur ce schema
  d. INSERT INTO tenant_{slug}.users (role: admin, isActive: true)
  e. Envoi email d'invitation avec mot de passe temporaire
```

### Onglets paramétrage tenant (`/platform/tenants/:id`)

```
Apparence  : logo, favicon, couleur primaire/secondaire, prévisualisation live
Plan       : type (trial|starter|pro|enterprise), maxUsers, maxEmployees, trialEndsAt
             [Suspendre] / [Réactiver]
Modules    : feature flags par tenant (activer/désactiver modules individuellement)
Données    : stats (nb employés, users, espace S3), export RGPD, [Supprimer tenant]
```

---

## THÉMATISATION DYNAMIQUE PAR TENANT

```
Au login, l'API retourne dans la réponse :
  { user, token, tenantConfig: { primaryColor, secondaryColor, logoUrl, name, slug } }

authStore stocke tenantConfig.

App.tsx à l'initialisation :
  document.documentElement.style.setProperty('--primary', tenantConfig.primaryColor)
  document.documentElement.style.setProperty('--secondary', tenantConfig.secondaryColor)

tailwind.config.js utilise CSS variables pour --primary, --secondary.
shadcn/ui components héritent automatiquement des variables.

Sidebar : logo tenant (fallback initiales colorées si pas de logo).
LoginPage : logo tenant centré + couleur primaire sur le bouton.
```

---

## ESPACE EMPLOYÉ — TOUTES LES SECTIONS FONCTIONNELLES

### Mes absences (`/mon-espace/absences`)

```
Soldes actuels : CP, RTT, récupération (barres de progression + jours restants)
Calendrier mensuel : mes absences colorées par type
Formulaire "Nouvelle demande" (bouton "+ Demander une absence") :
  type | date début | date fin | demi-journée toggle | motif
  → POST /api/absences (validation Zod client + serveur)
  → status = "pending", notification manager
Liste historique : badge statut coloré (pending=orange, approved=vert, rejected=rouge)
Bouton "Annuler" si status = pending
```

### Mes bulletins de paie (`/mon-espace/bulletins`)

```
Liste des 24 derniers bulletins : mois/année | net à payer | statut | actions
Bouton "Télécharger PDF" → GET /api/payroll/my-payslips/:id/pdf
Aperçu intégré (iframe PDF ou react-pdf viewer)
Badge "Nouveau" si viewed_by_employee_at IS NULL
→ GET /api/payroll/my-payslips filtre automatiquement sur token.employeeId
```

### Mes notes de frais (`/mon-espace/notes-de-frais`)

```
Liste avec statut (brouillon|soumis|approuvé|remboursé|refusé)
Formulaire "+ Nouvelle note" :
  titre | date | catégorie (transport|repas|hébergement|autre)
  Lignes : description | montant HT | TVA | montant TTC | justificatif (upload)
  [Sauvegarder brouillon] [Soumettre]
Note soumise → workflow : manager valide → RH rembourse
→ GET/POST/PATCH /api/expenses/my-expenses
```

### Ma formation (`/mon-espace/formation`)

```
Catalogue formations (cards : titre, durée, format, places restantes)
Bouton "S'inscrire" → POST /api/training/enroll (vérifie places disponibles)
Mes inscriptions : en cours | passées | attestations téléchargeables
```

### Mon profil (`/mon-espace/profil`)

```
Lecture : identité, poste, département, manager, date embauche, ancienneté calculée
Modification autorisée : téléphone, adresse personnelle, IBAN (confirmation double)
Upload photo de profil (recadrage intégré)
Changement mot de passe (ancien + nouveau + confirmation)
Activation MFA (QR code TOTP + codes de secours)
```

---

## ORDRE DE GÉNÉRATION

```
ÉTAPE 1 — Infrastructure
  docker-compose.yml · docker-compose.prod.yml · .env.example
  package.json (root) · pnpm-workspace.yaml · turbo.json · tsconfig.base.json

ÉTAPE 2 — Package shared
  types/tenant.ts · user.ts · employee.ts · payroll.ts
  types/contract.ts · absence.ts · expense.ts · api.ts
  validators/* (Zod) · constants/* (pays, CCN, plans SaaS, types absences)

ÉTAPE 3 — Schémas Drizzle
  db/platform/schema.ts (tenants, platform_users, tenant_invitations)
  db/tenant/schema/ (toutes les tables RH — identiques pour chaque tenant)
  db/client.ts (pool PG + getTenantDb(schemaName) + setPlatformPath())
  db/provisioning.ts (createTenantSchema + runTenantMigrations programmatique)
  drizzle.config.ts

ÉTAPE 4 — API Backend
  config.ts · utils/ (errors, logger Pino, helpers)
  plugins/auth.ts (JWT + set search_path automatique)
  plugins/tenant.ts (middleware résolution tenant)
  plugins/cors.ts · swagger.ts · rateLimit.ts · multipart.ts · websocket.ts
  services/ (email, pdf, storage, search Meilisearch, redis, notification)
  modules/platform/ (tenants CRUD + provisioning + feature flags + branding)
  modules/auth/ (login unifié : super_admin vs tenant, MFA TOTP, OAuth2, refresh)
  modules/employees/ (CRUD, import CSV, export, search, filtre équipe manager)
  modules/contracts/ (CRUD, PDF, workflow signature)
  modules/payroll/ (moteur calcul, bulletins PDF, DSN, SEPA, my-payslips endpoint)
  modules/absences/ (CRUD, workflow approbation, soldes, planning, my-absences)
  modules/recruitment/ (offres, candidatures, pipeline kanban)
  modules/training/ (catalogue, sessions, inscription self-service, attestations)
  modules/expenses/ (CRUD, workflow, upload justificatifs, my-expenses endpoint)
  modules/careers/ (compétences, 9-box, entretiens)
  modules/reporting/ (KPIs, dashboards, exports)
  modules/ai/ (chat SSE, génération docs, scoring rétention)
  app.ts · index.ts · db/seed.ts · Dockerfile

ÉTAPE 5 — Worker (BullMQ)
  queues.ts · jobs/payroll · jobs/dsn · jobs/email
  jobs/ai-scoring · jobs/cleanup · index.ts · Dockerfile

ÉTAPE 6 — Frontend React
  lib/ (axios interceptors, queryClient, utils fr-FR)
  stores/ (authStore avec tenantConfig, uiStore, aiStore)
  guards/ (RoleGuard, TenantGuard, PlatformGuard)
  components/layout/ (Sidebar adaptative, SidebarEmployee, SidebarPlatform,
                      Header, TenantBranding, Breadcrumb)
  components/ui · components/shared · components/ai
  components/charts · components/employees · components/payroll
  pages/platform/ (portail super_admin — toutes les pages)
  pages/auth/ (Login avec logo tenant dynamique, MFA, Onboarding)
  pages/dashboard/ (adaptatif selon rôle, 3 variantes)
  pages/mon-espace/ (self-service — 5 sous-pages entièrement fonctionnelles)
  pages/employees/ · pages/payroll/ · pages/absences/
  pages/recruitment/ · pages/training/ · pages/expenses/
  pages/careers/ · pages/reporting/ · pages/settings/
  App.tsx (React Router 6 avec guards + redirection par rôle) · main.tsx · Dockerfile

ÉTAPE 7 — Tests
  platform.provisioning.test.ts · payroll.engine.test.ts
  auth.service.test.ts · rbac.middleware.test.ts
  e2e/auth.spec.ts · e2e/employee-selfservice.spec.ts
  e2e/tenant-creation.spec.ts · e2e/absence-workflow.spec.ts
  vitest.config.ts · playwright.config.ts

ÉTAPE 8 — CI/CD
  .github/workflows/ci.yml · deploy.yml · README.md complet
```

---

## SEED — DONNÉES COMPLÈTES ET FONCTIONNELLES

**Règle absolue : après `db:seed`, toute l'application doit fonctionner sans erreur.**
**Toutes les listes doivent afficher des données. Zéro écran vide.**

### Compte super_admin (schema platform)

```
Email    : superadmin@nexusrh.com
Password : SuperAdmin1234!
```

### Tenant 1 — TechCorp SAS

```
slug     : techcorp | schema : tenant_techcorp
CCN      : SYNTEC | plan : pro | status : active
primaryColor : #4F46E5 | secondaryColor : #818CF8
Logo     : SVG initiales "TC" généré inline (pas d'URL externe)
Sites    : Paris (siège), Lyon, Bordeaux
Depts    : Engineering (20), Product (8), Marketing (7), Sales (10), Finance (5)

Utilisateurs tenant :
  admin@techcorp.com       / Admin1234!  → admin
  rh@techcorp.com          / Admin1234!  → hr_manager
  manager@techcorp.com     / Admin1234!  → manager (dept Engineering, lié à un employé)
  employe@techcorp.com     / Admin1234!  → employee (lié à l'employé "Alice Martin")

50 employés (noms réalistes, mix genres et origines) :
  Engineering : 20 (Dev, Lead, Arch, QA, DevOps)
  Product : 8 (PM, PO, Designer, UX)
  Marketing : 7 (Digital, Content, Brand)
  Sales : 10 (Commercial, Account, SDR)
  Finance : 5 (Comptable, Contrôleur, DAF)
  Salaires selon poste : Junior 32–40k, Confirmé 42–58k, Senior/Lead 60–80k
  Photos : générées (initiales colorées aléatoires, pas d'URL externe)

payrollRules (rubriques SYNTEC standard, 20 rubriques) :
  1000 - Salaire de base (earning, formula: BRUT)
  2000 - Congés payés (earning, formula: VAR:CONGES_PAYES)
  3000 - IJSS (deduction, formula: VAR:IJSS si applicable)
  4100 - CSG déductible (employee_contribution, rate: 0.0680, base: BRUT*0.9825)
  4110 - CSG non déductible (employee_contribution, rate: 0.0240, base: BRUT*0.9825)
  4120 - CRDS (employee_contribution, rate: 0.0050, base: BRUT*0.9825)
  4200 - Maladie salarié (employee_contribution, rate: 0.0000) [supprimée 2018]
  4210 - Maladie employeur (employer_contribution, rate: 0.0700)
  4300 - Alloc. familiales (employer_contribution, rate: 0.0345)
  4400 - AT/MP (employer_contribution, rate: 0.0222)
  4500 - Vieillesse plafonnée sal. (employee_contribution, rate: 0.0690, ceiling: 1)
  4510 - Vieillesse plafonnée pat. (employer_contribution, rate: 0.0855, ceiling: 1)
  4520 - Vieillesse déplafonnée sal. (employee_contribution, rate: 0.0040)
  4530 - Vieillesse déplafonnée pat. (employer_contribution, rate: 0.0175)
  4600 - AGIRC-ARRCO T1 sal. (employee_contribution, rate: 0.0315, ceiling: 1)
  4610 - AGIRC-ARRCO T1 pat. (employer_contribution, rate: 0.0472, ceiling: 1)
  4620 - AGIRC-ARRCO T2 sal. (employee_contribution, rate: 0.0864, base: TRANCHE_B)
  4630 - AGIRC-ARRCO T2 pat. (employer_contribution, rate: 0.1295, base: TRANCHE_B)
  5000 - Mutuelle sal. (employee_contribution, formula: 45)
  5010 - Mutuelle pat. (employer_contribution, formula: 90)

payPeriods : 6 périodes (juil–déc 2024), toutes status = "closed"
paySlips : 50 employés × 6 mois = 300 bulletins, status = "generated"
  → netPayable calculé correctement par le moteur pour chaque employé

absenceTypes : CP | RTT | Maladie | Maternité | Paternité | Événement familial | Sans solde
absenceBalances pour tous les 50 employés (cohérents : acquired ≥ taken + pending)
absences historique 12 mois, mix statuts
  → Alice Martin (employe@) : 2 absences approuvées + 1 en attente + 1 rejetée

expenses pour Alice Martin : 3 notes (1 approuvée, 1 soumise, 1 brouillon)
  Brouillon : 2 lignes (repas 23€ + taxi 15€)

trainings catalogue : 15 formations
  (React Avancé, Leadership, Excel, RGPD, PowerBI, Gestion de projet, etc.)
training_sessions : 8 sessions planifiées (dates futures)
training_enrollments : Alice inscrite à 2 formations

recruitment_jobs : 5 offres actives
applications : 20 candidatures (réparties en pipeline)

career_skills : 15 compétences dans le référentiel
employee_skills : 10 compétences par employé avec niveaux
evaluations : 1 entretien annuel 2024 par employé

hr_events : embauche + au moins 1 événement (promotion/augmentation) par employé
```

### Tenant 2 — Artisan Pro SARL (validation isolation multi-tenant)

```
slug     : artisanpro | schema : tenant_artisanpro
CCN      : Bâtiment | plan : starter
primaryColor : #16A34A | logo : initiales "AP"
Depts    : Chantiers (15), Administration (3)

Utilisateurs :
  admin@artisanpro.com     / Admin1234!  → admin
  employe2@artisanpro.com  / Admin1234!  → employee

18 employés (noms réalistes BTP)
3 mois de bulletins
absences, formations, frais : données minimales mais fonctionnelles
```

---

## MOTEUR DE PAIE — LOGIQUE

```
PayrollEngine.calculate(ctx) :
1. buildVariables → BRUT, BRUT_PRORATA, ETP, PLAFOND_SS, TRANCHE_A, TRANCHE_B, SMIC
   + expansion variableElements par ruleCode + JOURS_ABSENCE, HEURES_SUPP
2. Pour chaque rule (triée par order, filtrée par ruleApplies) :
   - Évaluer formula (whitelist [A-Z0-9_\s\+\-\*\/\.\(\)]+)
   - Préfixe "VAR:CODE" = lire élément variable directement
   - Exposer résultat dans vars pour règles suivantes
3. computeTotals :
   grossSalary = Σ earning
   netBeforeTax = grossSalary + Σ (deduction + employee_contribution) [négatifs]
   employerCost = grossSalary + Σ employerAmount
   netPayable = netBeforeTax (incomeTax = 0, PAS via DSN ultérieurement)
4. Résultat : { lines[], grossSalary, netBeforeTax, incomeTax, netPayable, employerCost, workingDays }
```

---

## ASSISTANT IA — LOGIQUE

```
streamChat(messages, context) : SSE via anthropic.messages.stream()
  System = expert RH France + contexte tenant (nom, CCN, user courant, page active)
  Réponse toujours en français + références légales (articles CT, CSS)

generateHRDocument(type, data) :
  Types : cdi | cdd | internship | job_offer | warning | termination
          | conventional_termination | certificate | amendment
  Output : Markdown complet, mentions légales, 0 placeholder

analyzeRetentionRisk(data) → { score, risk: low|medium|high, factors[], recommendations[] }
  Worker nocturne met à jour employees.retentionScore + burnoutRisk
```

---

## CONSTANTES LÉGALES FRANCE 2024

```
SMIC mensuel 35h    : 1 766,92 €      Plafond SS mensuel : 3 864 €
CSG déductible      : 6,80 %          CSG non déductible : 2,40 %     CRDS : 0,50 %
Maladie patronale   : 13,00 % (<10)   ou 7,00 % (≥10 salariés)
Alloc. familiales   : 3,45 % (≤3,5x SMIC) | 5,25 % (>3,5x SMIC)
AT/MP               : variable (seed : 2,22 %)
Retraite base       : sal 6,90 % TA | pat 8,55 % TA
AGIRC-ARRCO T1      : sal 3,15 % + pat 4,72 %
AGIRC-ARRCO T2      : sal 8,64 % + pat 12,95 %
RGPD                : NIR + IBAN AES-256 | bulletins 50 ans | dossier 5 ans post-départ
CDD                 : 18 mois max, 2 renouvellements, délai carence 1/3 durée
Essai CDI           : 2 mois employé | 3 mois cadre (renouvelable 1x)
DSN                 : avant le 5 M+1 (≥50 sal) | 15 M+1 (<50 sal)
```

---

## VARIABLES D'ENVIRONNEMENT (.env.example)

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

---

## DÉMARRAGE

> Le projet est déjà scaffoldé dans `D:/OPENLAB/nexusrh/`. Ne pas régénérer la structure.

### 1. Prérequis

- Docker Desktop lancé
- Node.js 20+, pnpm installé (`npm i -g pnpm`)

### 2. Variables d'environnement

```bash
cd D:/OPENLAB/nexusrh
cp .env.example .env
```

Éditer `.env` et renseigner au minimum :
```bash
JWT_SECRET=nexusrh-super-secret-key-minimum-32-chars
ANTHROPIC_API_KEY=sk-ant-api03-...   # optionnel pour l'IA
```

### 3. Démarrer l'infrastructure

```bash
docker-compose up -d postgres redis meilisearch minio
# Attendre ~15s que PostgreSQL soit prêt
```

### 4. Installer les dépendances

```bash
pnpm install
```

### 5. Initialiser la base de données

```bash
pnpm --filter api run db:seed
# Crée : schema platform + super_admin + TechCorp (50 emp) + ArtisanPro (18 emp)
```

### 6. Lancer le projet

```bash
pnpm run dev
```

| Service | URL |
|---------|-----|
| **Frontend** | http://localhost:3000 |
| **API** | http://localhost:4000 |
| **Swagger** | http://localhost:4000/docs |
| **MinIO** (fichiers) | http://localhost:9001 — `minioadmin / minioadmin` |

---

## COMPTES DE CONNEXION

### Plateforme (super_admin)

| Email | Mot de passe | Redirige vers |
|-------|-------------|---------------|
| `superadmin@nexusrh.com` | `SuperAdmin1234!` | `/platform/dashboard` |

---

### TechCorp SAS — thème indigo `#4F46E5`

| Email | Mot de passe | Rôle | Redirige vers |
|-------|-------------|------|---------------|
| `admin@techcorp.com` | `Admin1234!` | admin | `/dashboard` |
| `rh@techcorp.com` | `Admin1234!` | hr_manager | `/dashboard` |
| `manager@techcorp.com` | `Admin1234!` | manager | `/dashboard` |
| `employe@techcorp.com` | `Admin1234!` | employee | `/mon-espace` |

### Artisan Pro SARL — thème vert `#16A34A`

| Email | Mot de passe | Rôle | Redirige vers |
|-------|-------------|------|---------------|
| `admin@artisanpro.com` | `Admin1234!` | admin | `/dashboard` |
| `employe2@artisanpro.com` | `Admin1234!` | employee | `/mon-espace` |

### Openlab Consulting (tenant créé via portail)

| Email | Mot de passe | Rôle | Redirige vers |
|-------|-------------|------|---------------|
| `coulwao@gmail.com` | `Openlab2025!` | admin | `/dashboard` |

---

## PATTERNS ET PIÈGES — ACQUIS EN PRODUCTION

### 1. findTenantAndUser — email en double entre tenants

**Problème** : Si le même email est utilisé comme admin dans plusieurs tenants, `findTenantAndUser` retournait le premier tenant trouvé (mauvais hash → 401).

**Solution** : La fonction collecte TOUS les candidats, puis compare le mot de passe pour chaque. Elle retourne le tenant dont le hash valide.

```typescript
// auth.routes.ts — findTenantAndUser(pool, email, password)
const candidates = []
for (const tenant of tenants) {
  const user = await findUserInSchema(tenant.schema_name, email)
  if (user) candidates.push({ tenant, user })
}
if (candidates.length === 1) return candidates[0]
// Multiple tenants : trouver celui dont le password valide
for (const c of candidates) {
  if (await bcrypt.compare(password, c.user.password_hash)) return c
}
```

**Règle** : toujours passer le mot de passe en paramètre à `findTenantAndUser`.

### 2. maxUsers / maxEmployees — valeurs par plan

La création de tenant via `POST /platform/tenants` doit toujours inclure `max_users` et `max_employees` dans l'INSERT. Les valeurs par défaut par plan :

```typescript
const PLAN_DEFAULTS = {
  trial:      { maxUsers: 10,   maxEmployees: 20   },
  starter:    { maxUsers: 50,   maxEmployees: 100  },
  pro:        { maxUsers: 200,  maxEmployees: 500  },
  enterprise: { maxUsers: 9999, maxEmployees: 9999 },
}
```

### 3. Email de bienvenue — Gmail App Password

Pour Gmail, le transporter Nodemailer doit avoir `requireTLS: true` et `tls: { rejectUnauthorized: false }`. Sans ces options, la connexion STARTTLS échoue silencieusement.

Le mot de passe temporaire est **toujours retourné dans la réponse API** (`tempPassword`) en plus de l'email, comme filet de sécurité si l'email échoue.

### 4. Migration lazy — validation_level

La colonne `validation_level` a été ajoutée après la création initiale des tenants de démo. Pour éviter de casser les tenants existants :
- `ensureSchemaMigrated(schemaName)` dans chaque handler absences/expenses
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — idempotent
- Scripte de migration explicite : `pnpm --filter api run db:migrate-validation`

### 5. Formules moteur de paie

Le `safeEval` n'injecte que les variables calculées (BRUT, TRANCHE_A, etc.) — PAS les taux de cotisation. Les formules dans les tests doivent embarquer le taux numériquement :

```typescript
// FAUX — RATE n'est pas dans le contexte
formula: 'BASE * RATE'
// CORRECT
formula: 'BASE * 0.068'
```

### 6. Portail super_admin — création tenant

**Status initial** : les plans non-trial sont créés avec `status = 'active'` par défaut. Le wizard expose un sélecteur "Statut initial" pour forcer `active` même sur un plan trial.

**Récupération d'accès** : si l'admin d'un tenant ne peut pas se connecter :
```bash
# Option 1 — CLI
pnpm --filter api run admin:reset <email> <nouveau_mot_de_passe>

# Option 2 — API (super_admin)
POST /platform/tenants/:id/reset-admin
# Retourne { adminEmail, tempPassword }

# Option 3 — Diagnostic
GET /platform/tenants/:id/admin-status
# Retourne schemaExists, adminUser.isActive, adminUser.hasPasswordHash, issue
```

---

## VARIABLES D'ENVIRONNEMENT — ÉTAT ACTUEL

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

---

## CHECKLIST AVANT DE GÉNÉRER

- [ ] CLAUDE.md intégralement lu
- [ ] Architecture multi-tenant (schema-per-tenant) comprise
- [ ] `findTenantAndUser` passe le mot de passe ET itère tous les tenants candidats
- [ ] `max_users` et `max_employees` définis selon plan dans l'INSERT tenant
- [ ] Email de bienvenue appelé après provisionnement (non bloquant — .catch())
- [ ] `ensureSchemaMigrated` appelé dans chaque handler absences/expenses
- [ ] RBAC appliqué côté API (middleware) ET côté frontend (guards + sidebar)
- [ ] Dashboard différent selon rôle (3 variantes : plateforme / RH-admin-manager / employee)
- [ ] Espace employee : 5 sections entièrement fonctionnelles
- [ ] Portail super_admin : création tenant + paramétrage apparence + reset-admin fonctionnels
- [ ] Thématisation CSS variables appliquée dynamiquement au login
- [ ] Seed : 2 tenants seedés (TechCorp + ArtisanPro), données complètes, zéro écran vide
- [ ] Compilation vérifiée après chaque module majeur

**Lance maintenant : `docker-compose.yml` → `.env.example` → `package.json` (root)**

---

_NexusRH — SIRH SaaS Multi-Tenant · Propulsé par Claude AI · Fait pour les RH françaises_

