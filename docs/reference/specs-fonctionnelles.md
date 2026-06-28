# Specs fonctionnelles — Dashboards, Portail, Thématisation, Espace employé

> Référence détaillée. Chargée à la demande depuis `CLAUDE.md`.

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

## ORDRE DE GÉNÉRATION (référence scaffolding initial — projet déjà généré)

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
