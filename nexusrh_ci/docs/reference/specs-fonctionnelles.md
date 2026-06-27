# Specs fonctionnelles CI — Dashboards, Modules, Portail, Thématisation, Ordre de génération, Plans

> Référence détaillée. Chargée à la demande depuis `nexusrh_ci/CLAUDE.md`.

---

## DASHBOARDS PAR RÔLE (AFFICHAGE DIFFÉRENCIÉ — CRITIQUE)

### Dashboard super_admin → `/platform/dashboard`

```
Redirection automatique depuis "/" si rôle = super_admin.
Sidebar : Tenants | Logs | Paramètres plateforme (UNIQUEMENT)

Contenu :
  KPI Cards : [Tenants actifs] [En trial] [Total employés] [MRR estimé FCFA]
  Tableau tenants : nom, plan, nb users, nb employés, ville, status, actions
  Graphique : croissance tenants (12 mois, LineChart)
  Alertes : trials expirant sous 7 jours, déclarations CNPS à risque
  Actions : [+ Créer un tenant] [Voir logs]
```

### Dashboard admin / hr_manager / hr_officer → `/dashboard`

```
Sidebar complète avec tous les modules RH.

Contenu :
  KPI Cards : [Effectifs actifs] [Masse salariale FCFA] [Cotisations CNPS/mois] [Postes ouverts]
  Alertes critiques : CNPS à déclarer avant le 15 | DISA à produire | Essais qui expirent
  Graphiques : évolution effectifs (LineChart), répartition departments (BarChart)
  Insights IA : alertes rétention + absentéisme anormal + pics CNPS
  Panneaux : absences du jour | anniversaires du mois | entrées/sorties
  Widget Mobile Money : statut dernier virement salaire
```

### Dashboard manager → `/dashboard`

```
Sidebar : Tableau de bord | Mon équipe | Absences | Notes de frais | Formations

Contenu :
  KPI Cards : [Mon équipe] [Absences aujourd'hui] [Demandes à valider] [Formations en cours]
  Liste équipe directe avec statuts
  Demandes d'absence à approuver (badge rouge si en attente)
  Notes de frais à valider
```

### Dashboard employee → `/mon-espace` (SIDEBAR RÉDUITE)

```
Sidebar uniquement :
  Mon espace | Mes absences | Mes bulletins | Mes notes de frais
  Ma formation | Mon profil

Contenu dashboard :
  Soldes congés (CP, congé maladie) — barres de progression
  Prochain bulletin disponible (badge "Nouveau" si non consulté)
  Mes 3 dernières absences + statut
  Mes 3 dernières notes de frais + statut
  Mon numéro Mobile Money enregistré (Wave/MTN/Orange)
  Formations recommandées (2 cards)

AUCUN accès à : employés autres, paie globale, recrutement, reporting, IA avancée.
```

---

## MODULES SPÉCIFIQUES CI

### Module CNPS & Déclarations

```
GET    /cnps/declarations           → liste des déclarations mensuelles
POST   /cnps/declarations/:month/generate → génère déclaration e-CNPS
GET    /cnps/declarations/:id/export → export compatible plateforme e-CNPS
POST   /cnps/disa/generate          → génère DISA annuelle pour tous les employés
GET    /cnps/disa/:year/export      → export fichier DISA (CSV/XML)
GET    /cnps/employers/certificate  → attestation de conformité CNPS
```

### Module OHADA / Contrats CI

```
Types de contrats supportés :
  CDI (Contrat à Durée Indéterminée)
  CDD (Contrat à Durée Déterminée — max 2 ans, 2 renouvellements)
  Contrat saisonnier
  Contrat d'apprentissage (FDFP)
  Stage conventionné
  Mise à disposition

Clauses OHADA obligatoires :
  Lieu de travail | Convention collective applicable
  Période d'essai (durée légale CI) | Rémunération FCFA
  Affiliation CNPS | NNI salarié | Numéro CNPS employeur
```

### Module Mobile Money Paiements

```
GET    /payroll/mobile-money/campaigns     → campagnes de virement
POST   /payroll/mobile-money/campaigns     → créer campagne virement salaires
POST   /payroll/mobile-money/campaigns/:id/execute → déclencher les virements
GET    /payroll/mobile-money/campaigns/:id/status  → statut détaillé + callbacks
POST   /payroll/mobile-money/verify-number → vérifier numéro actif avant virement
```

### Module Formation / FDFP

```
FDFP = Fonds de Développement de la Formation Professionnelle (CI)
  Contribution patronale obligatoire : 0,4 % masse salariale (entreprises > 10 sal.)
  Agrément formations : seules formations agréées FDFP sont remboursables

Routes supplémentaires :
  POST /training/fdfp/request     → demande de remboursement FDFP
  GET  /training/fdfp/eligible    → liste formations éligibles remboursement
```

---

## PORTAIL SUPER ADMIN — GESTION DES TENANTS

### Pages `/platform/*`

```
/platform/dashboard          ← KPIs globaux plateforme (en FCFA)
/platform/tenants            ← Tableau paginé (+ ville CI + secteur d'activité)
/platform/tenants/new        ← Wizard 3 étapes (+ taux AT secteur + ville)
/platform/tenants/:id        ← Détail + onglets paramétrage
/platform/tenants/:id/users  ← Utilisateurs tenant
/platform/logs               ← Logs d'activité
/platform/settings           ← Paramètres globaux
```

### Wizard création tenant (3 étapes)

```
Étape 1 : Infos société
  Nom entreprise | Slug | Plan | Secteur d'activité (commerce/industrie/BTP/services…)
  Ville (Abidjan/Bouaké/San-Pédro/Daloa/Man/Yamoussoukro)
  Numéro CNPS employeur | Numéro DGI | RCCM
  Taux AT CNPS (2–5% selon secteur) → pré-rempli selon secteur sélectionné

Étape 2 : Admin principal
  Email | Prénom | Nom | Téléphone (+225 XXXXXXXX)

Étape 3 : Apparence
  Couleur primaire | Couleur secondaire | Logo upload
  Prévisualisation live

→ API exécute :
  a. INSERT INTO platform.tenants
  b. CREATE SCHEMA tenant_{slug}
  c. Drizzle migrate sur ce schema
  d. INSERT INTO tenant_{slug}.users (role: admin)
  e. INSERT rubriques paie CI préconfigurées
  f. INSERT types absences CI (CP, Maladie, Maternité, Paternité, Deuil, Sans solde)
  g. Email d'invitation (Nodemailer) + tempPassword retourné dans la réponse
```

---

## THÉMATISATION DYNAMIQUE PAR TENANT

```
Au login, l'API retourne dans la réponse :
  { user, token, tenantConfig: { primaryColor, secondaryColor, logoUrl, name, slug, city } }

authStore stocke tenantConfig.

App.tsx à l'initialisation :
  document.documentElement.style.setProperty('--primary', tenantConfig.primaryColor)
  document.documentElement.style.setProperty('--secondary', tenantConfig.secondaryColor)

Sidebar : logo tenant (fallback initiales colorées) + nom entreprise + ville CI
LoginPage : logo tenant centré + couleur primaire sur le bouton + mention ville
```

---

## ORDRE DE GÉNÉRATION (référence scaffolding — projet déjà généré)

```
ÉTAPE 1 — Infrastructure
  docker-compose.yml · docker-compose.prod.yml · .env.example
  package.json (root) · pnpm-workspace.yaml · turbo.json · tsconfig.base.json

ÉTAPE 2 — Package shared
  types/tenant.ts · user.ts · employee.ts · payroll-ci.ts
  types/contract-ci.ts · absence-ci.ts · expense.ts · api.ts
  types/cnps.ts · mobile-money.ts · disa.ts
  validators/* (Zod) · constants/ci/* (smig, taux CNPS, barème ITS, jours fériés CI,
  villes CI, secteurs, conventions collectives CI, taux AT par secteur)

ÉTAPE 3 — Schémas Drizzle
  db/platform/schema.ts
  db/tenant/schema/ (toutes les tables + cnps_declarations + disa_records + mobile_money_payments)
  db/client.ts · db/provisioning.ts (createTenantSchema + migrations + seed rubriques CI)
  drizzle.config.ts

ÉTAPE 4 — API Backend
  config.ts · utils/ (errors, logger, helpers, fcfa-formatter)
  plugins/auth.ts · plugins/tenant.ts · plugins/cors.ts
  plugins/swagger.ts · plugins/rateLimit.ts · plugins/multipart.ts
  services/email.ts · services/pdf-ci.ts · services/storage.ts
  services/mobile-money.ts (Wave + MTN + Orange)
  services/cnps.ts (calcul + export e-CNPS + DISA)
  services/its-dgi.ts (calcul ITS selon barème DGI)
  services/ai-ci.ts (Claude calibré CI)
  modules/platform/ (tenants CRUD + provisionnement CI)
  modules/auth/ (login unifié, MFA, OAuth2, refresh)
  modules/employees/ (CRUD + numéro CNPS + NNI + Mobile Money)
  modules/contracts/ (CDI/CDD OHADA, PDF, workflow)
  modules/payroll/ (moteur CI, bulletins PDF, CNPS, ITS, Mobile Money)
  modules/absences/ (workflow, soldes CI, planning)
  modules/recruitment/ (ATS, IA scoring, contrat OHADA embauche)
  modules/training/ (FDFP, catalogue, sessions, attestations)
  modules/expenses/ (OCR reçus, barème DGI, Mobile Money remboursement)
  modules/careers/ (9-box, compétences, entretiens annuels CI)
  modules/cnps/ (déclarations mensuelles, DISA, certificats)
  modules/mobile-money/ (campagnes virement, callbacks, statuts)
  modules/reporting/ (KPIs en FCFA, masse salariale, CNPS analytique)
  modules/ai/ (chat SSE calibré CI, génération docs OHADA, scoring rétention CI)
  app.ts · index.ts · db/seed.ts · Dockerfile

ÉTAPE 5 — Worker (BullMQ)
  queues.ts · jobs/payroll-ci · jobs/cnps-declaration · jobs/disa-annual
  jobs/mobile-money-callback · jobs/email · jobs/ai-scoring-ci
  jobs/cleanup · index.ts · Dockerfile

ÉTAPE 6 — Frontend React
  lib/ (axios interceptors, queryClient, fcfaFormatter)
  stores/ (authStore avec tenantConfig CI, uiStore, aiStore)
  guards/ (RoleGuard, TenantGuard, PlatformGuard)
  components/layout/ (Sidebar adaptative, SidebarEmployee, SidebarPlatform)
  components/payroll-ci/ (BulletinCI, RubriquesCI, CNPS widget)
  components/mobile-money/ (PaymentStatus, BulkPaymentCampaign)
  components/cnps/ (DeclarationForm, DISAExport)
  pages/platform/ · pages/auth/ · pages/dashboard/
  pages/mon-espace/ (self-service — 5 sous-pages)
  pages/employees/ · pages/payroll/ · pages/absences/
  pages/recruitment/ · pages/training/ · pages/expenses/
  pages/careers/ · pages/cnps/ · pages/reporting/ · pages/settings/
  App.tsx · main.tsx · Dockerfile

ÉTAPE 7 — Tests
  payroll-ci.engine.test.ts (SMIG, CNPS, ITS, heures supp)
  cnps.declaration.test.ts · auth.service.test.ts · rbac.test.ts
  e2e/auth.spec.ts · e2e/employee-selfservice.spec.ts
  e2e/tenant-creation-ci.spec.ts · e2e/payroll-ci.spec.ts
  e2e/cnps-declaration.spec.ts

ÉTAPE 8 — CI/CD
  .github/workflows/ci.yml · deploy.yml · README.md
```

---

## PLANS & TARIFICATION (FCFA)

```
Plan                Périmètre                          Tarif indicatif
──────────────────────────────────────────────────────────────────────────────
Trial               30j gratuit · 10 users · 20 sal.   0 FCFA
Starter             30 sal. · Paie + Congés + Portail  < 70 000 FCFA/mois TTC
Business            150 sal. · Tous modules + IA + ATS < 10 000 FCFA/sal/mois
Enterprise          150+ sal. · SLA premium + multi-sites Sur devis
Secteur Public/ONG  Tarif préférentiel · OHADA inclus   Sur convention

Toutes les offres incluent :
  → CNPS & ITS natifs mis à jour automatiquement
  → Génération e-CNPS & DISA
  → Support WhatsApp OpenLab Abidjan
  → Formation initiale (3h RH + 1h30 managers)
  → Accès API REST documentée
```

> `PLAN_DEFAULTS` (maxUsers/maxEmployees par plan) est dans le cœur `CLAUDE.md`.
