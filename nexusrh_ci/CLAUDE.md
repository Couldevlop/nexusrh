# CLAUDE.md — NexusRH CI : SIRH SaaS Multi-Tenant · Côte d'Ivoire

> Contexte maître pour Claude Code. Placé dans `/nexusrh/nexusrh_ci/CLAUDE.md`.
> Projet **indépendant** de `/nexusrh/` : tout le code, schémas, config et données sont sous `/nexusrh/nexusrh_ci/`.
> Specs détaillées (lues à la demande) : `nexusrh_ci/docs/reference/` — voir l'index en bas.

---

## MISSION

**NexusRH CI** — premier SIRH SaaS **multi-tenant** production-ready pour les **entreprises ivoiriennes**.
Conformité native **Code du Travail CI + CNPS 2024 + ITS/DGI + OHADA**.
Tenant = entreprise isolée (schéma PostgreSQL dédié). Un **super_admin** gère les tenants ; chaque tenant a son **admin**.
**Fichiers complets. Pas de TODO, pas de pseudo-code, pas de confirmation.**

**Identité produit** : NexusRH CI · « La RH Intelligente, au service de l'Afrique qui avance » · Éditeur **OpenLab Consulting** (Abidjan) · Devise **FCFA (XOF)** exclusivement · Langue **français** (UI + IA + docs). Marché : PME/ETI/filiales/public/ONG — CI & CEDEAO. Contacts complets → `docs/reference/` (specs) ou section Contacts ci-dessous.

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
Monorepo pnpm+Turborepo · React 18 + TS 5 + Vite 5 · shadcn/ui + Radix + Tailwind 3
Framer Motion 11 · Zustand 4 + TanStack Query 5 · React Hook Form + Zod · React Router 6
Backend Node 20 + Fastify 4 + TS · Drizzle ORM (PostgreSQL multi-schema) · PostgreSQL 16 + Redis 7
IA @anthropic-ai/sdk (claude-sonnet-4-20250514) · Auth @fastify/jwt + oauth2 + otplib (MFA)
PDF PDFKit + @react-pdf/renderer · Email Nodemailer + mjml · Files AWS SDK v3 (S3/MinIO, hébergeable CI)
Search Meilisearch · Charts Recharts · i18n react-i18next (fr-CI) · Tests Vitest + Playwright
CI/CD GitHub Actions + Docker · Jobs BullMQ · Mobile Money Wave/MTN/Orange · PWA (offline partiel)
```

---

## ARCHITECTURE MULTI-TENANT (CRITIQUE)

**Stratégie : schema-per-tenant.**

```
schema "platform"      ← tables globales (tenants, platform_users, settings)
schema "tenant_<slug>" ← toutes les tables RH d'un client (isolées), ex. tenant_sotra
```

**Résolution du tenant (middleware Fastify) :**
1. JWT contient `{ userId, tenantId, schemaName, role }`
2. `tenant.ts` extrait `schemaName` du token
3. Chaque requête DB : `SET search_path = {schemaName}, shared`
4. Le code applicatif n'écrit **JAMAIS** le nom du schema en dur
5. `super_admin` = accès au schema `platform` uniquement (zéro donnée RH)

**Tables `platform`** : `tenants` (slug, name, planType `trial|starter|business|enterprise|public_sector`, status, schemaName, maxUsers, maxEmployees, primaryColor, secondaryColor, logoUrl, sector, city, trialEndsAt…), `platform_users` (super_admin), `tenant_invitations`.

**Tables par tenant** : `users, employees, departments, legal_entities, contracts, payroll_rules, pay_periods, pay_slips, variable_elements, absence_types, absence_balances, absences, recruitment_jobs, applications, trainings, training_sessions, training_enrollments, expense_reports, expense_lines, career_skills, employee_skills, evaluations, hr_events, employee_documents, notifications, audit_log, refresh_tokens, workflow_configs, mobile_money_payments, cnps_declarations, disa_records`.

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
| Contrats OHADA | RW | RW | R | - | R(sien) | R |
| Paie clôture | RW | RW | - | - | - | - |
| Bulletins (tous) | RW | RW | R | - | - | R |
| Mon bulletin | - | - | - | - | R | - |
| CNPS Déclarations | RW | RW | R | - | - | R |
| DISA Génération | RW | RW | - | - | - | - |
| Absences (saisie) | RW | RW | RW | RW(équipe) | RW(soi) | - |
| Absences (approbation) | RW | RW | - | RW(équipe) | - | - |
| Recrutement | RW | RW | RW | R | - | R |
| Formation / FDFP | RW | RW | RW | R | - | R |
| Formation (inscription) | - | - | - | - | RW | - |
| Notes de frais (saisie) | RW | RW | RW | RW(équipe) | RW(soi) | - |
| Notes de frais (valid.) | RW | RW | - | RW(équipe) | - | - |
| Carrière/Compétences | RW | RW | RW | RW(équipe) | R(soi) | R |
| Reporting | RW | RW | R | R(équipe) | - | R |
| IA Assistant | RW | RW | RW | RW | R(limité) | - |
| Mobile Money Paiements | RW | RW | - | - | - | R |
| Utilisateurs tenant | RW | - | - | - | - | - |

**3 variantes de dashboard** : plateforme (`/platform/dashboard`) · RH-admin-manager (`/dashboard`) · employee (`/mon-espace`, sidebar réduite). Détail des écrans, modules CI (CNPS/OHADA/Mobile Money/FDFP), portail super_admin → `docs/reference/specs-fonctionnelles.md`.

---

## VALEURS LÉGALES CI 2024 (CRITIQUE — source de vérité)

```typescript
export const CI_LEGAL_CONSTANTS_2024 = {
  // SMIG
  SMIG_MENSUEL: 60_000, SMIG_HORAIRE: 345, // FCFA

  // CNPS — DOUBLE PLAFOND (ne jamais confondre)
  PLAFOND_CNPS_AT_PF_MENSUEL: 70_000,        // AT, Prestations familiales, Maternité
  PLAFOND_CNPS_RETRAITE_MENSUEL: 1_647_315,  // Retraite
  TAUX_CNPS_RETRAITE_SAL: 0.063, TAUX_CNPS_RETRAITE_PAT: 0.077,
  TAUX_CNPS_PF_PAT: 0.05, TAUX_CNPS_MATERNITE_PAT: 0.0075,
  TAUX_CNPS_AT_COMMERCE: 0.02, TAUX_CNPS_AT_BTP: 0.03,
  TAUX_CNPS_AT_INDUSTRIE: 0.04, TAUX_CNPS_AT_EXTRACTION: 0.05,

  // ITS — abattement AVANT barème
  ABATTEMENT_ITS: 0.15,
  TRANCHES_ITS_MENSUELLES: [
    { min: 0, max: 75_000, taux: 0.0 },
    { min: 75_001, max: 240_000, taux: 0.015 },
    { min: 240_001, max: 800_000, taux: 0.05 },
    { min: 800_001, max: 2_000_000, taux: 0.1 },
    { min: 2_000_001, max: Infinity, taux: 0.15 },
  ],
  CREDIT_IMPOT_CELIBATAIRE: 0, CREDIT_IMPOT_MARIE_SANS_ENFANT: 5_500,
  CREDIT_IMPOT_PAR_ENFANT: [3_000, 6_000, 9_000], // 1, 2, 3+ enfants

  // Congés (jours OUVRABLES)
  JOURS_CONGES_PAR_MOIS: 2.5,
  ANCIENNETE_BONUS_JOURS: [ { annees: 5, joursSupp: 1 }, { annees: 10, joursSupp: 2 }, { annees: 15, joursSupp: 3 } ],

  // Heures supplémentaires (majorations)
  MAJORATIONS_HEURES_SUPP: { normal: 0.15 /*41–48h*/, nuit: 0.5 /*20h–5h*/, dimanche: 0.5, ferie: 1.0 },

  // Délais & FDFP
  DELAI_DISA_MOIS: 1, ECNPS_DELAI_MENSUEL: 15, TAUX_CONTRIBUTION_FDFP: 0.004, // 0,4% masse sal. (>10 sal.)
}
```

**Préavis** : essai employé 15j · essai cadre 1 mois · ancienneté <1 an 1 mois · 1–5 ans 2 mois · >5 ans 3 mois.
**Congés spéciaux** : maternité 14 sem. (6+8) · paternité 10j · deuil familial 3j.
**Plafonds CNPS, barème ITS détaillé, taux AT par secteur, jours fériés CI 2024, DISA (Loi 99-477)** → `docs/reference/paie-mobile-money-ia.md`.

`PLAN_DEFAULTS` (utilisé à la création de tenant — pièges #2) :
```typescript
const PLAN_DEFAULTS = {
  trial:         { maxUsers: 10,   maxEmployees: 20  },
  starter:       { maxUsers: 30,   maxEmployees: 30  },
  business:      { maxUsers: 100,  maxEmployees: 150 },
  enterprise:    { maxUsers: 9999, maxEmployees: 9999 },
  public_sector: { maxUsers: 200,  maxEmployees: 500 },
}
```

---

## PATTERNS ET PIÈGES — SPÉCIFIQUES CI

1. **CNPS — double plafond.** AT/PF/Maternité plafonnés à 70 000 FCFA ; Retraite à 1 647 315 FCFA. Jamais le même plafond pour toutes les branches. Tester avec un salaire à 2 000 000 FCFA.
2. **ITS — abattement AVANT tranches.** `net_imposable = BRUT × 0.85`, PUIS déduire cotisations CNPS salariales, PUIS appliquer le barème. Jamais les tranches directement sur le brut. `PLAN_DEFAULTS` (ci-dessus) toujours dans l'INSERT tenant.
3. **FCFA entiers.** Colonnes PostgreSQL `integer`/`bigint`, jamais `numeric(10,2)`. Aucun centime sur les bulletins.
4. **Mobile Money — numéros CI.** Format `+225 07…` (Wave/Orange) ou `+225 05…` (MTN). Valider `/^\+2250[57]\d{8}$/` avant tout virement.
5. **Hébergement souverain CI.** `hosting_location: 'ci'` (public/banques) force S3/MinIO vers endpoint local CI. Jamais vers AWS US/EU.
6. **DISA — annuelle.** Générée en janvier pour l'année précédente (job BullMQ `disa-annual` le 5 janvier). Agrège les 12 bulletins de l'année.
7. **findTenantAndUser.** Collecte TOUS les candidats puis compare le hash de chacun ; jamais retourner le premier tenant sans vérifier le mot de passe. Toujours passer le mot de passe en paramètre.
8. **safeEval moteur paie.** N'injecte que les variables calculées — PAS les taux. Embarquer le taux numériquement : `BASE_RETRAITE * 0.063` (pas `* TAUX_CNPS_SAL`).
9. **Congés — jours ouvrables.** Lundi→samedi inclus, hors fériés. `absence_types.calculation_mode = 'working_days'` pour le type CP. Pas de jours calendaires.
10. **Jours fériés CI 2024** (pour le calcul congés) :
```typescript
const JOURS_FERIES_CI_2024 = ["2024-01-01","2024-04-01","2024-04-10","2024-05-01","2024-05-09",
  "2024-05-20","2024-06-17","2024-07-07","2024-08-07","2024-08-15","2024-11-01","2024-11-15","2024-12-25"]
// An, L.Pâques, Eid Al-Fitr, Travail, Ascension, L.Pentecôte, Tabaski, Mouloud, Fête Nat., Assomption, Toussaint, Paix, Noël
```

> Moteur de paie pas-à-pas, rubriques préconfigurées, intégration Mobile Money, prompt IA → `docs/reference/paie-mobile-money-ia.md`.

---

## DÉMARRAGE

```bash
cd D:/OPENLAB/nexusrh/nexusrh_ci
cp .env.example .env            # renseigner JWT_SECRET + ANTHROPIC_API_KEY au minimum
docker-compose up -d postgres redis meilisearch minio   # postgres:5434 redis:6380 meili:7701 minio:9002/9003
pnpm install
pnpm --filter api run db:seed   # platform + super_admin + SOTRA (80 emp) + Cabinet Expertise (25 emp)
pnpm run dev
```

| Service | URL (ports décalés pour cohabiter avec /nexusrh) |
|---|---|
| Frontend | http://localhost:3001 |
| API | http://localhost:4001 |
| Swagger | http://localhost:4001/docs |
| MinIO | http://localhost:9003 — `minioadmin` |

`.env.example` complet → `docs/reference/env-example.md`.

---

## COMPTES DE CONNEXION

**Plateforme** — `superadmin@nexusrh-ci.com` / `SuperAdmin1234!` → `/platform/dashboard`
> ⚠️ Seedé `ON CONFLICT DO NOTHING` : en PROD le mot de passe a été changé et survit aux re-seeds. `SuperAdmin1234!` ne marche que sur base neuve.

**SOTRA** (thème orange `#E85D04` · domaine **`@sotra.ci`**, pas `sotra-ci.com`) :
| Email | Mot de passe | Rôle | Redirige |
|---|---|---|---|
| `admin@sotra.ci` | `Admin1234!` | admin | `/dashboard` |
| `rh@sotra.ci` | `Admin1234!` | hr_manager | `/dashboard` |
| `chef.perso@sotra.ci` | `Admin1234!` | hr_officer | `/dashboard` |
| `manager@sotra.ci` | `Admin1234!` | manager | `/dashboard` |
| `employe@sotra.ci` | `Admin1234!` | employee | `/mon-espace` |
| `dg@sotra.ci` | `Admin1234!` | dg | `/dashboard` |

**Cabinet Expertise CI** (thème bleu `#1D4ED8`) :
| Email | Mot de passe | Rôle |
|---|---|---|
| `admin@cabinet-expertise.ci` | `Admin1234!` | admin |
| `employe2@cabinet-expertise.ci` | `Admin1234!` | employee |

---

## CHECKLIST AVANT DE GÉNÉRER

- [ ] Architecture multi-tenant (schema-per-tenant) comprise
- [ ] Moteur de paie CI : CNPS (double plafond) + ITS (abattement 15% → barème DGI)
- [ ] SMIG 60 000 FCFA vérifié sur chaque bulletin · FCFA entiers partout (zéro décimale)
- [ ] Mobile Money : Wave + MTN + Orange (format +225, regex validée)
- [ ] Modules CI : CNPS/DISA, OHADA contrats, FDFP formation
- [ ] DISA agrégation annuelle (12 mois), génération janvier N+1
- [ ] Jours fériés CI 2024 dans le calcul congés (jours ouvrables) · 2,5 j/mois travaillé
- [ ] `findTenantAndUser` passe le mot de passe ET itère tous les candidats
- [ ] `max_users` / `max_employees` selon plan CI dans l'INSERT tenant
- [ ] `ensureSchemaMigrated` dans chaque handler absences/expenses/careers
- [ ] RBAC appliqué côté API (middleware) ET front (guards + sidebar)
- [ ] Seed : 2 tenants (SOTRA 80 + Cabinet 25), zéro écran vide
- [ ] PWA offline partiel · Ports décalés (4001/3001/5434/6380) · IA calibrée CI
- [ ] Compilation vérifiée après chaque module majeur

---

## CONTACTS OPENLAB CONSULTING

```
OpenLab Consulting · Cocody, Rivièra Faya Lauriers 8, Abidjan, CI
Email infos@openlabconsulting.com · Tel CI +225 07 09 32 05 94 · Tel FR +33 06 19 24 53 29 · www.openlabconsulting.com
Support NexusRH CI : WhatsApp +225 07 09 32 05 94 · support@nexusrh-ci.com · Lun–Ven 7h30–18h00 (Abidjan)
```

---

## INDEX DES RÉFÉRENCES (`docs/reference/` — lire à la demande)

| Fichier | Contenu |
|---|---|
| `docs/reference/specs-fonctionnelles.md` | Dashboards par rôle (détail), modules CI (CNPS/OHADA/Mobile Money/FDFP routes), portail super_admin + wizard, thématisation, ordre de génération, plans & tarification |
| `docs/reference/paie-mobile-money-ia.md` | Conformité CI détaillée (CNPS/ITS/préavis prose), moteur de paie pas-à-pas, 16 rubriques préconfigurées, intégration Mobile Money, prompt assistant IA |
| `docs/reference/seed.md` | Seed complet : SOTRA (80 emp, 480 bulletins, CNPS/DISA, Mobile Money) + Cabinet Expertise (25 emp) |
| `docs/reference/env-example.md` | `.env.example` complet (DB, IA, SMTP, Mobile Money, feature flags) |

---

_NexusRH CI — SIRH SaaS Multi-Tenant · Propulsé par Claude AI (Anthropic) · Conforme Code du Travail ivoirien & CNPS 2024 · OpenLab Consulting, Abidjan_
