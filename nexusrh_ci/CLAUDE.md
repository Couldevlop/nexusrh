# CLAUDE.md — NexusRH CI : SIRH SaaS Multi-Tenant · Côte d'Ivoire

> Contexte maître pour Claude Code. Placé dans `/nexusrh/nexusrh_ci/CLAUDE.md`.
> Ce projet est **totalement indépendant** de `/nexusrh/`. Tout le code, les schémas, la configuration et les données sont dans `/nexusrh/nexusrh_ci/`.

---

## MISSION

Générer **NexusRH CI** — le premier SIRH SaaS **multi-tenant** production-ready conçu pour les **entreprises ivoiriennes**.
Conformité native **Code du Travail CI + CNPS 2024 + ITS/DGI + OHADA**.
Chaque entreprise cliente est un **tenant isolé** (schéma PostgreSQL dédié).
Un **super_admin** de plateforme gère les tenants. Chaque tenant a son propre **admin**.
**Génère tous les fichiers complets. Pas de TODO, pas de pseudo-code, pas de confirmation.**

---

## IDENTITÉ PRODUIT

```
Nom produit   : NexusRH CI
Slogan        : « La RH Intelligente, au service de l'Afrique qui avance »
Éditeur       : OpenLab Consulting
Adresse       : Cocody, Rivièra Faya Lauriers 8, Abidjan, Côte d'Ivoire
Email         : infos@openlabconsulting.com
Tel Abidjan   : +225 07 09 32 05 94
Tel France    : +33 06 19 24 53 29
Web           : www.openlabconsulting.com
IA            : Propulsé par Claude AI (Anthropic)
Marché cible  : PME, ETI, filiales, institutions publiques, ONG — Côte d'Ivoire & CEDEAO
Devise        : FCFA (XOF) exclusivement
Langue        : Français (interface + IA + documents générés)
```

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
9. **Toutes les valeurs monétaires sont en FCFA (entiers, pas de décimales)**
10. **Le moteur de paie applique CNPS 2024 + ITS/DGI CI — jamais les taux français**

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
Files         : AWS SDK v3 (S3/MinIO) · hébergeable en CI
Search        : Meilisearch
Charts        : Recharts
i18n          : react-i18next (fr-CI)
Tests unit    : Vitest
Tests E2E     : Playwright
CI/CD         : GitHub Actions + Docker
Jobs async    : BullMQ
Mobile Money  : API Wave · API MTN MoMo · API Orange Money CI
PWA           : Vite PWA plugin (offline partiel pour zones réseau limité)
```

---

## ARCHITECTURE MULTI-TENANT (CRITIQUE)

### Stratégie : schema-per-tenant

```
PostgreSQL :
  schema "platform"         ← tables globales (tenants, platform_users, settings)
  schema "tenant_sotra"     ← toutes les tables RH de SOTRA (isolées)
  schema "tenant_orange_ci" ← toutes les tables RH d'Orange CI (isolées)
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
  planType: trial|starter|business|enterprise|public_sector
  status: active|suspended|trial
  schemaName varchar (ex: "tenant_sotra")
  maxUsers int | maxEmployees int
  primaryColor varchar | secondaryColor varchar
  logoUrl text | faviconUrl text | customDomain varchar
  sector varchar (industrie|commerce|services|btp|finance|sante|oNG|public)
  city varchar (Abidjan|Bouaké|San-Pédro|Man|Daloa|Yamoussoukro)
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
training_enrollments, expense_reports, expense_lines, career_skills,
employee_skills, evaluations, hr_events, employee_documents,
notifications, audit_log, refresh_tokens, workflow_configs,
mobile_money_payments, cnps_declarations, disa_records
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
Module                   admin  hr_mgr  hr_off  manager  employee  readonly
─────────────────────────────────────────────────────────────────────────────
Paramétrage tenant         RW      -       -        -        -         -
Employés (tous)            RW     RW      RW        R        -         R
Mon profil                 -       -       -        -        R         -
Contrats OHADA             RW     RW       R        -      R(sien)     R
Paie clôture               RW     RW       -        -        -         -
Bulletins (tous)           RW     RW       R        -        -         R
Mon bulletin               -       -       -        -        R         -
CNPS Déclarations          RW     RW       R        -        -         R
DISA Génération            RW     RW       -        -        -         -
Absences (saisie)          RW     RW      RW    RW(équipe) RW(soi)    -
Absences (approbation)     RW     RW       -    RW(équipe)   -         -
Recrutement                RW     RW      RW        R        -         R
Formation / FDFP           RW     RW      RW        R        -         R
Formation (inscription)    -       -       -        -        RW        -
Notes de frais (saisie)    RW     RW      RW    RW(équipe) RW(soi)    -
Notes de frais (valid.)    RW     RW       -    RW(équipe)   -         -
Carrière/Compétences       RW     RW      RW    RW(équipe) R(soi)      R
Reporting                  RW     RW       R    R(équipe)   -          R
IA Assistant               RW     RW      RW       RW      R(limité)   -
Mobile Money Paiements     RW     RW       -        -        -         R
Utilisateurs tenant        RW      -       -        -        -         -
```

---

## CONFORMITÉ IVOIRIENNE — VALEURS LÉGALES 2024 (CRITIQUE)

### CNPS — Caisse Nationale de Prévoyance Sociale

```
Branche                       Part salariale   Part patronale   Plafond/mois
──────────────────────────────────────────────────────────────────────────────
Retraite                          6,30 %           7,70 %       1 647 315 FCFA
Prestations familiales + Mat.      0,00 %           5,75 %          70 000 FCFA
  dont Allocations familiales      0,00 %           5,00 %
  dont Assurance maternité         0,00 %           0,75 %
Accidents du travail (AT)         0,00 %         2,00–5,00 %        70 000 FCFA
  (taux AT variable par secteur — voir table ci-dessous)

PLAFOND MENSUEL AT/PF/Maternité : 70 000 FCFA (840 000 FCFA/an)
PLAFOND MENSUEL RETRAITE        : 1 647 315 FCFA

Taux AT par secteur :
  Commerce, services, tertiaire   : 2,00 %
  BTP, transports                 : 3,00 %
  Industrie, manufacture          : 4,00 %
  Extraction, mines               : 5,00 %

Date limite déclaration e-CNPS : avant le 15 du mois M+1
```

### ITS — Impôt sur les Traitements et Salaires (DGI CI 2024)

```
L'ITS se calcule sur le salaire net imposable après déduction des cotisations.
Barème progressif DGI CI (tranches mensuelles en FCFA) :

Tranche mensuelle              Taux
──────────────────────────────────────
0 – 75 000                     0 %
75 001 – 240 000                1,5 %
240 001 – 800 000               5 %
800 001 – 2 000 000            10 %
> 2 000 000                    15 %

Abattement forfaitaire : 15 % du salaire brut (plancher : 0, plafond non plafonné)
Crédit d'impôt famille :
  Célibataire sans enfant    :  0 FCFA/mois
  Marié sans enfant          :  5 500 FCFA/mois
  1 enfant à charge          :  3 000 FCFA/mois supplémentaires
  2 enfants                  :  6 000 FCFA/mois
  3 enfants et plus          :  9 000 FCFA/mois
```

### Autres obligations légales CI

```
SMIG mensuel (35h)             : 60 000 FCFA
Congés annuels                 : 2,5 jours ouvrables / mois travaillé
Heures supplémentaires         :
  41–48h / semaine             : +15 % du taux horaire normal
  Nuit (20h–5h) & dimanche     : +50 % du taux horaire normal
  Jours fériés                 : +100 %
Préavis (démission/licenciement) :
  Essai CDI employé            : 15 jours
  Essai CDI cadre              : 1 mois
  CDI ancienneté < 1 an        : 1 mois
  CDI ancienneté 1–5 ans       : 2 mois
  CDI ancienneté > 5 ans       : 3 mois
Maternité                      : 14 semaines (6 avant + 8 après)
Paternité                      : 10 jours
Deuil familial                 : 3 jours (parents, conjoint, enfant)

DISA (Déclaration Individuelle Salaires Annuels) :
  Base légale  : Loi 99-477 du 2 août 1999
  Fréquence    : Annuelle (clôture janvier de l'année N+1)
  Contenu      : NNI, nom, prénom, salaire annuel brut, cotisations, ITS
  Dépôt        : CNPS + DGI
  Sanction     : Amende + intérêts de retard
```

---

## MOTEUR DE PAIE CI — LOGIQUE COMPLÈTE

```
PayrollEngineCi.calculate(ctx) :

ÉTAPE 1 — buildVariables()
  BRUT_MENSUEL = salaire brut mensuel contractuel (FCFA)
  BRUT_PRORATA = BRUT_MENSUEL * (jours_travaillés / jours_ouvrables_mois)
  SMIG = 70_000 FCFA  (vérification plancher)
  PLAFOND_CNPS_AT_PF = 70_000 FCFA / mois
  PLAFOND_CNPS_RETRAITE = 1_647_315 FCFA / mois
  BASE_AT_PF = min(BRUT_PRORATA, PLAFOND_CNPS_AT_PF)
  BASE_RETRAITE = min(BRUT_PRORATA, PLAFOND_CNPS_RETRAITE)
  + variableElements (primes, heures supp majorées, IJSS CNPS si applicable)

ÉTAPE 2 — Calcul cotisations CNPS
  cotisation_retraite_sal  = BASE_RETRAITE × 0.063
  cotisation_retraite_pat  = BASE_RETRAITE × 0.077
  cotisation_pf_mat_pat    = BASE_AT_PF × 0.0575
  cotisation_at_pat        = BASE_AT_PF × taux_at_secteur  (2-5%)
  total_cotisations_sal    = cotisation_retraite_sal
  total_cotisations_pat    = cotisation_retraite_pat + cotisation_pf_mat_pat + cotisation_at_pat

ÉTAPE 3 — Calcul ITS/DGI
  salaire_net_imposable    = BRUT_PRORATA × (1 - 0.15)  [abattement 15%]
  salaire_imposable_net    = salaire_net_imposable - total_cotisations_sal
  its_brut                 = appliquer_bareme_DGI(salaire_imposable_net)
  credit_impot             = credit_selon_situation_familiale(nb_enfants, statut_marital)
  ITS                      = max(0, its_brut - credit_impot)

ÉTAPE 4 — computeTotals()
  salaire_brut             = BRUT_PRORATA + primes + heures_supp + autres_gains
  total_retenues_sal       = total_cotisations_sal + ITS
  salaire_net              = salaire_brut - total_retenues_sal
  cout_employeur           = salaire_brut + total_cotisations_pat
  VÉRIFICATION             : salaire_net >= SMIG (60 000 FCFA) si temps plein

ÉTAPE 5 — Génération bulletin PDF
  Mentions légales CI obligatoires :
    - Numéro CNPS employeur | Numéro NNI salarié
    - Période de paie | Date de paiement
    - Toutes les rubriques détaillées (gains + retenues)
    - Net à payer en FCFA + mode de paiement (virement / Mobile Money)
    - Cumuls annuels salaire brut / cotisations / ITS
```

### Rubriques de paie CI préconfigurées

```
Code   Libellé                           Type              Formule/Taux
────────────────────────────────────────────────────────────────────────────────
1000   Salaire de base                   earning            BRUT_MENSUEL
1100   Prime d'ancienneté                earning            VAR:PRIME_ANCIENNETE
1200   Prime de rendement                earning            VAR:PRIME_RENDEMENT
1300   Prime de transport                earning            VAR:PRIME_TRANSPORT
1400   Heures supplémentaires (+15%)     earning            VAR:HEURES_SUPP_NORM
1500   Heures supplémentaires (+50%)     earning            VAR:HEURES_SUPP_NUIT
1600   Indemnité de congés payés         earning            VAR:ICP
2000   CNPS Retraite (salarié 6,3%)      employee_contrib   BASE_RETRAITE * 0.063
2100   ITS (Impôt Traitements Salaires)  employee_contrib   ITS
3000   CNPS Retraite (patronal 7,7%)     employer_contrib   BASE_RETRAITE * 0.077
3100   CNPS Prestations familiales 5%    employer_contrib   BASE_AT_PF * 0.050
3200   CNPS Assurance maternité 0,75%    employer_contrib   BASE_AT_PF * 0.0075
3300   CNPS Accidents du travail         employer_contrib   BASE_AT_PF * taux_at
4000   Mutuelle/Assurance santé sal.     employee_contrib   VAR:MUTUELLE_SAL
4100   Mutuelle/Assurance santé pat.     employer_contrib   VAR:MUTUELLE_PAT
5000   Avance sur salaire                deduction          VAR:AVANCE
5100   Retenue absence non justifiée     deduction          VAR:RETENUE_ABSENCE
```

---

## MOBILE MONEY — INTÉGRATION CI

```
Opérateurs supportés :
  Wave          : API REST · /transfer · numéro +225 XXXXXXXX
  MTN MoMo      : USSD *133*166# (pour initiation) + API REST API
  Orange Money  : #144*453# + API Orange Money CI
  COFINA        : API REST partenaire

Table mobile_money_payments :
  id | tenantId | employeeId | amount (FCFA) | currency='XOF'
  provider: wave|mtn_momo|orange_money|cofina|bank_transfer
  phoneNumber | reference | status: pending|success|failed|cancelled
  initiatedAt | confirmedAt | createdAt

Flux de paiement salaire :
  1. Clôture paie → génère les ordres de virement (table mobile_money_payments)
  2. Admin valide la campagne de paiement
  3. API Mobile Money déclenche les transferts (bulk)
  4. Callback webhook → mise à jour status
  5. Notification SMS/WhatsApp envoyée à chaque salarié
  6. Bulletin PDF marqué "payé" avec référence de transaction

Note : En mode offline/réseau limité, la liste des paiements est mise en cache
et synchronisée dès la reconnexion (PWA + Service Worker).
```

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

## ASSISTANT IA — LOGIQUE CALIBRÉE CI

```
streamChat(messages, context) : SSE via anthropic.messages.stream()
  System prompt CI :
    "Tu es un expert RH et droit social ivoirien. Tu connais parfaitement le Code du Travail
     de Côte d'Ivoire, la réglementation CNPS 2024, les barèmes ITS/DGI, le droit OHADA.
     Tu réponds TOUJOURS en français. Tu cites les articles du Code du Travail CI, les
     circulaires CNPS et les textes DGI pertinents. Tes réponses sont adaptées au contexte
     ivoirien (SMIG 60 000 FCFA, FCFA comme devise, Mobile Money, FDFP…).
     Contexte tenant : {name} · {ville} · {secteur} · CCN applicable : {convention}"

Exemples de questions CI :
  "Combien de jours de congés pour 8 mois de travail ?" → 20 jours ouvrables
  "Quel est le taux AT pour une entreprise BTP ?" → 3 %
  "Comment calculer la DISA ?" → guide pas à pas
  "Notre salarié a été absent 5 jours. Impact sur la CNPS ?" → calcul prorata

generateHRDocument(type, data) — Types CI :
  cdi_ci | cdd_ci | contrat_apprentissage | contrat_stage | avenant
  lettre_embauche | avertissement | mise_en_demeure | lettre_licenciement
  rupture_conventionnelle_ci | certificat_travail | attestation_emploi
  attestation_cnps_employeur | reçu_solde_tout_compte

analyzeRetentionRisk(data) — calibré CI :
  Facteurs CI : ancienneté < 18 mois | salaire = SMIG depuis > 6 mois
  | absences maladie > 5j/trimestre | aucune formation depuis > 12 mois
  | score engagement < 3/5 | retard de paiement salaire
  Output : { score, risk: low|medium|high, factors[], recommendations[] }
```

---

## ORDRE DE GÉNÉRATION

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

## SEED — DONNÉES COMPLÈTES CI

**Règle absolue : après `db:seed`, toute l'application fonctionne sans erreur.**
**Toutes les listes affichent des données. Zéro écran vide.**

### Compte super_admin (schema platform)

```
Email    : superadmin@nexusrh-ci.com
Password : SuperAdmin1234!
```

### Tenant 1 — SOTRA (Société de Transport Abidjanais)

```
slug        : sotra | schema : tenant_sotra
Secteur     : Transport | Taux AT CNPS : 3,00 %
Ville       : Abidjan (Treichville)
Plan        : business | status : active
Convention  : Transport urbain CI
primaryColor : #E85D04 | secondaryColor : #F48C06
Logo        : SVG initiales "ST"
CNPS employeur : CI-00123456-X
DGI         : CI-DGI-7890
RCCM        : CI-ABJ-2005-B-123456

Utilisateurs tenant :
  admin@sotra.ci    / Admin1234!  → admin
  rh@sotra.ci       / Admin1234!  → hr_manager
  chef.perso@sotra.ci / Admin1234!  → hr_officer
  manager@sotra.ci  / Admin1234!  → manager (département Exploitation)
  employe@sotra.ci  / Admin1234!  → employee (lié à "Kouassi Jean-Paul")

80 employés (noms ivoiriens réalistes) :
  Exploitation    : 35 (chauffeurs, contrôleurs, chefs de ligne)
  Maintenance     : 15 (mécaniciens, électriciens, techniciens)
  Administration  : 15 (RH, comptabilité, juridique, informatique)
  Direction       : 5 (DG, DAF, DRH, Chef exploitation, Chef maintenance)
  Agents terrain  : 10 (guichetiers, agents sécurité)

Salaires selon poste (FCFA brut mensuel) :
  Chauffeur junior       : 150 000 – 200 000 FCFA
  Chauffeur confirmé     : 200 000 – 280 000 FCFA
  Contrôleur             : 120 000 – 180 000 FCFA
  Technicien             : 200 000 – 350 000 FCFA
  Cadre administratif    : 400 000 – 800 000 FCFA
  Cadre supérieur / DRH  : 800 000 – 1 500 000 FCFA

Mobile Money enregistré par employé :
  50 % Wave · 30 % MTN MoMo · 20 % Orange Money (numéros CI fictifs cohérents)

payrollRules : 16 rubriques CI préconfigurées (voir table rubriques ci-dessus)
payPeriods : 6 mois (juil–déc 2024), status = "closed"
paySlips : 80 employés × 6 mois = 480 bulletins, status = "generated"
  → netPayable calculé selon moteur CI (CNPS + ITS) pour chaque employé
  → Vérification SMIG 60 000 FCFA respectée pour tous

cnps_declarations : 6 déclarations mensuelles générées (juil–déc 2024)
  → Export e-CNPS CSV généré pour chaque mois
disa_records : DISA 2024 générée pour les 80 employés

absenceTypes : CP | Maladie | Maternité | Paternité | Deuil familial | Sans solde | Formation
absenceBalances pour tous (cohérents : 2,5j/mois × ancienneté)
absences : historique 12 mois, mix statuts
  → Kouassi Jean-Paul (employe@) : 2 approuvées + 1 en attente + 1 rejetée

expense_reports pour Kouassi Jean-Paul :
  3 notes (1 approuvée avec paiement Mobile Money, 1 soumise, 1 brouillon)
  Brouillon : 2 lignes (repas 8 500 FCFA + taxi 3 500 FCFA)

trainings : 10 formations catalogue (dont 4 agréées FDFP)
  (Sécurité routière, RGPD CI/ARTCI, Leadership, Excel, Gestion RH, …)
training_sessions : 5 sessions planifiées
training_enrollments : Kouassi inscrit à 2 formations

recruitment_jobs : 3 offres actives (Chauffeur senior, Technicien auto, RH officer)
applications : 12 candidatures (pipeline kanban)

career_skills : 12 compétences (techniques transport + soft skills)
employee_skills : 8 compétences par employé
evaluations : 1 entretien annuel 2024 par employé (modèle CI)

hr_events : embauche + au moins 1 événement (promotion/augmentation) par employé

mobile_money_payments :
  Campagne décembre 2024 : 80 virements
  → 40 Wave (success) + 24 MTN (success) + 14 Orange (success) + 2 (failed)
```

### Tenant 2 — Cabinet Expertise CI SARL (validation isolation)

```
slug        : cabinet-expertise | schema : tenant_cabinet_expertise
Secteur     : Services (audit, conseil) | Taux AT CNPS : 2,00 %
Ville       : Abidjan (Plateau)
Plan        : starter | status : active
primaryColor : #1D4ED8 | logo : initiales "CE"

Utilisateurs :
  admin@cabinet-expertise.ci  / Admin1234!  → admin
  employe2@cabinet-expertise.ci / Admin1234! → employee

25 employés (auditeurs, comptables, juristes, assistants)
3 mois de bulletins CI complets
Données absences, formations, frais : minimales mais fonctionnelles
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

PLAN_DEFAULTS = {
  trial:         { maxUsers: 10,   maxEmployees: 20  },
  starter:       { maxUsers: 30,   maxEmployees: 30  },
  business:      { maxUsers: 100,  maxEmployees: 150 },
  enterprise:    { maxUsers: 9999, maxEmployees: 9999 },
  public_sector: { maxUsers: 200,  maxEmployees: 500 },
}
```

---

## VARIABLES D'ENVIRONNEMENT (.env.example)

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

---

## DÉMARRAGE

> Le projet est dans `D:/OPENLAB/nexusrh/nexusrh_ci/`. Ne pas mélanger avec le dossier parent `/nexusrh/`.

### 1. Prérequis

- Docker Desktop lancé
- Node.js 20+, pnpm installé

### 2. Variables d'environnement

```bash
cd D:/OPENLAB/nexusrh/nexusrh_ci
cp .env.example .env
# Éditer .env : JWT_SECRET + ANTHROPIC_API_KEY au minimum
```

### 3. Infrastructure (ports différents de nexusrh pour cohabitation)

```bash
docker-compose up -d postgres redis meilisearch minio
# postgres : 5434 | redis : 6380 | meilisearch : 7701 | minio : 9002/9003
```

### 4. Dépendances + base de données

```bash
pnpm install
pnpm --filter api run db:seed
# Crée : schema platform + super_admin + SOTRA (80 emp) + Cabinet Expertise (25 emp)
```

### 5. Lancer le projet

```bash
pnpm run dev
```

| Service      | URL                                  |
| ------------ | ------------------------------------ |
| **Frontend** | http://localhost:3001                |
| **API**      | http://localhost:4001                |
| **Swagger**  | http://localhost:4001/docs           |
| **MinIO**    | http://localhost:9003 — `minioadmin` |

---

## COMPTES DE CONNEXION

### Plateforme (super_admin)

| Email                       | Mot de passe      | Redirige vers         |
| --------------------------- | ----------------- | --------------------- |
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` (base fraîche) — **en prod, mot de passe custom** | `/platform/dashboard` |

> ⚠️ Le super_admin est seedé avec `ON CONFLICT DO NOTHING` : en PROD le mot de passe
> a été changé et survit aux re-seeds. `SuperAdmin1234!` ne fonctionne que sur une base
> neuve. En prod, utiliser le mot de passe custom (cf. gestion des secrets).

### SOTRA — thème orange `#E85D04` · domaine **`@sotra.ci`** (pas `sotra-ci.com`)

| Email                  | Mot de passe | Rôle       | Redirige vers |
| ---------------------- | ------------ | ---------- | ------------- |
| `admin@sotra.ci`       | `Admin1234!` | admin      | `/dashboard`  |
| `rh@sotra.ci`          | `Admin1234!` | hr_manager | `/dashboard`  |
| `chef.perso@sotra.ci`  | `Admin1234!` | hr_officer | `/dashboard`  |
| `manager@sotra.ci`     | `Admin1234!` | manager    | `/dashboard`  |
| `employe@sotra.ci`     | `Admin1234!` | employee   | `/mon-espace` |
| `dg@sotra.ci`          | `Admin1234!` | dg         | `/dashboard`  |

### Cabinet Expertise CI — thème bleu `#1D4ED8`

| Email                           | Mot de passe | Rôle     |
| ------------------------------- | ------------ | -------- |
| `admin@cabinet-expertise.ci`    | `Admin1234!` | admin    |
| `employe2@cabinet-expertise.ci` | `Admin1234!` | employee |

---

## PATTERNS ET PIÈGES — SPÉCIFIQUES CI

### 1. Calcul CNPS — double plafond

La CNPS CI a **deux plafonds distincts** :

- `PLAFOND_AT_PF = 70 000 FCFA/mois` (branches AT, Prestations Familiales, Maternité)
- `PLAFOND_RETRAITE = 1 647 315 FCFA/mois`

Ne jamais appliquer le même plafond pour toutes les branches. Tester systématiquement avec un salaire à 2 000 000 FCFA pour vérifier.

### 2. ITS — abattement AVANT calcul des tranches

L'ITS se calcule sur `salaire_net_imposable = BRUT × 0.85`, PUIS on déduit les cotisations CNPS salariales, PUIS on applique le barème. Ne jamais appliquer les tranches DGI directement sur le brut.

### 3. SMIG en FCFA — pas de décimales

Toutes les valeurs monétaires sont en **FCFA entiers**. PostgreSQL : colonnes `integer` ou `bigint`, jamais `numeric(10,2)`. Les bulletins n'affichent jamais de centimes.

### 4. Mobile Money — numéros CI

Format téléphone CI : `+225 07 XX XX XX XX` (Wave, Orange) ou `+225 05 XX XX XX XX` (MTN). Toujours valider avec regex `/^\+2250[57]\d{8}$/` avant tout virement.

### 5. Hébergement souverain CI

Pour les clients sensibles (secteur public, banques), l'option `hosting_location: 'ci'` doit forcer toutes les connexions S3/MinIO vers un endpoint local CI. Ne jamais envoyer ces données vers AWS US/EU.

### 6. DISA — génération annuelle

La DISA se génère en **janvier** pour l'année précédente. Le job BullMQ `disa-annual` tourne le 5 janvier. Elle agrège les 12 bulletins de l'année, pas seulement le dernier.

### 7. findTenantAndUser — mêmes règles que NexusRH

Collecte tous les candidats, compare le hash pour chaque. Ne jamais retourner le premier tenant trouvé sans vérification du mot de passe.

### 8. Formules moteur de paie — safeEval

Le `safeEval` n'injecte que les variables calculées. Les taux doivent être numériques dans la formule :

```typescript
// FAUX
formula: "BASE_RETRAITE * TAUX_CNPS_SAL";
// CORRECT
formula: "BASE_RETRAITE * 0.063";
```

### 9. Congés CI — jours ouvrables vs jours calendaires

Le Code du Travail CI calcule les congés en **jours ouvrables** (lundi→samedi inclus, hors fériés). Ne pas utiliser les jours calendaires. La table `absence_types` doit avoir `calculation_mode: 'working_days'` pour le type CP.

### 10. Jours fériés CI 2024

```typescript
const JOURS_FERIES_CI_2024 = [
  "2024-01-01", // Jour de l'An
  "2024-04-01", // Lundi de Pâques
  "2024-04-10", // Eid Al-Fitr (Ramadan)
  "2024-05-01", // Fête du Travail
  "2024-05-09", // Ascension
  "2024-05-20", // Lundi de Pentecôte
  "2024-06-17", // Eid Al-Adha (Tabaski)
  "2024-07-07", // Mouloud
  "2024-08-07", // Fête Nationale CI
  "2024-08-15", // Assomption
  "2024-11-01", // Toussaint
  "2024-11-15", // Journée Nationale de la Paix
  "2024-12-25", // Noël
];
```

---

## CONSTANTES LÉGALES CI 2024

```typescript
export const CI_LEGAL_CONSTANTS_2024 = {
  // SMIG
  SMIG_MENSUEL: 60_000, // FCFA
  SMIG_HORAIRE: 345, // FCFA (60000/173.33h)

  // CNPS
  PLAFOND_CNPS_AT_PF_MENSUEL: 70_000, // FCFA
  PLAFOND_CNPS_RETRAITE_MENSUEL: 1_647_315, // FCFA
  TAUX_CNPS_RETRAITE_SAL: 0.063,
  TAUX_CNPS_RETRAITE_PAT: 0.077,
  TAUX_CNPS_PF_PAT: 0.05,
  TAUX_CNPS_MATERNITE_PAT: 0.0075,
  TAUX_CNPS_AT_COMMERCE: 0.02,
  TAUX_CNPS_AT_BTP: 0.03,
  TAUX_CNPS_AT_INDUSTRIE: 0.04,
  TAUX_CNPS_AT_EXTRACTION: 0.05,

  // ITS
  ABATTEMENT_ITS: 0.15,
  TRANCHES_ITS_MENSUELLES: [
    { min: 0, max: 75_000, taux: 0.0 },
    { min: 75_001, max: 240_000, taux: 0.015 },
    { min: 240_001, max: 800_000, taux: 0.05 },
    { min: 800_001, max: 2_000_000, taux: 0.1 },
    { min: 2_000_001, max: Infinity, taux: 0.15 },
  ],
  CREDIT_IMPOT_CELIBATAIRE: 0,
  CREDIT_IMPOT_MARIE_SANS_ENFANT: 5_500,
  CREDIT_IMPOT_PAR_ENFANT: [3_000, 6_000, 9_000], // 1, 2, 3+ enfants

  // Congés
  JOURS_CONGES_PAR_MOIS: 2.5,
  ANCIENNETE_BONUS_JOURS: [
    { annees: 5, joursSupp: 1 },
    { annees: 10, joursSupp: 2 },
    { annees: 15, joursSupp: 3 },
  ],

  // Heures supplémentaires
  MAJORATIONS_HEURES_SUPP: {
    normal: 0.15, // 41–48h
    nuit: 0.5, // 20h–5h
    dimanche: 0.5,
    ferie: 1.0,
  },

  // DISA
  DELAI_DISA_MOIS: 1, // avant fin janvier N+1
  ECNPS_DELAI_MENSUEL: 15, // avant le 15 du mois

  // FDFP
  TAUX_CONTRIBUTION_FDFP: 0.004, // 0,4% masse salariale (entreprises > 10 sal.)
};
```

---

## CHECKLIST AVANT DE GÉNÉRER

- [ ] CLAUDE.md intégralement lu
- [ ] Architecture multi-tenant (schema-per-tenant) comprise
- [ ] Moteur de paie CI : CNPS (double plafond) + ITS (abattement 15% → barème DGI) intégrés
- [ ] SMIG 60 000 FCFA vérifié sur chaque bulletin
- [ ] Mobile Money intégré : Wave + MTN + Orange Money (format téléphone +225)
- [ ] Modules CI spécifiques : CNPS/DISA, OHADA contrats, FDFP formation
- [ ] DISA : agrégation annuelle (12 mois), génération janvier N+1
- [ ] Jours fériés CI 2024 intégrés dans le calcul des congés (jours ouvrables)
- [ ] Congés : 2,5 jours ouvrables / mois travaillé (Code du Travail CI)
- [ ] FCFA entiers partout — zéro décimale dans les montants
- [ ] `findTenantAndUser` passe le mot de passe ET itère tous les tenants candidats
- [ ] `max_users` et `max_employees` selon plan CI dans l'INSERT tenant
- [ ] `ensureSchemaMigrated` dans chaque handler absences/expenses/careers
- [ ] RBAC appliqué côté API (middleware) ET frontend (guards + sidebar)
- [ ] Seed : 2 tenants (SOTRA 80 emp + Cabinet Expertise 25 emp), données complètes
- [ ] PWA activé : offline partiel pour zones réseau limité (CI)
- [ ] Ports différents de NexusRH pour cohabitation (4001, 3001, 5434, 6380)
- [ ] IA calibrée contexte ivoirien (Code du Travail CI, CNPS, OHADA, FCFA)
- [ ] Compilation vérifiée après chaque module majeur

---

## CONTACTS OPENLAB CONSULTING

```
OpenLab Consulting
Spécialiste en Innovation & Transformation Digitale

Adresse   : Cocody, Rivièra Faya Lauriers 8, Abidjan, Côte d'Ivoire
Email     : infos@openlabconsulting.com
Tel CI    : +225 07 09 32 05 94
Tel FR    : +33 06 19 24 53 29
Web       : www.openlabconsulting.com

Support client NexusRH CI :
  WhatsApp : +225 07 09 32 05 94
  Email    : support@nexusrh-ci.com
  Horaires : Lun–Ven 7h30–18h00 (GMT+0, heure d'Abidjan)
```

---

_NexusRH CI — SIRH SaaS Multi-Tenant · Propulsé par Claude AI (Anthropic)_
_Conforme Code du Travail ivoirien & CNPS 2024 · Développé par OpenLab Consulting · Abidjan_
