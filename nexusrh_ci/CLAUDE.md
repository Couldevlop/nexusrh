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

**Tables par tenant** : `users, employees, departments, legal_entities, contracts, payroll_rules, pay_periods, pay_slips, variable_elements, absence_types, absence_balances, absences, recruitment_jobs, applications, trainings, training_sessions, training_enrollments, expense_reports, expense_lines, career_skills, employee_skills, evaluations, hr_events, employee_documents, employee_photos, notifications, audit_log, refresh_tokens, workflow_configs, mobile_money_payments, cnps_declarations, disa_records`.

> `employee_photos` (PII, `UNIQUE(employee_id)`) est servie par `GET /employees/:id/photo` **authentifié** — **jamais** par `/public/brand/:id`, qui reste réservé aux **logos publics**. Les en-têtes de webhook sont chiffrés au repos (`integration_webhooks.headers_enc`).

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
  SMIG_MENSUEL: 75_000, SMIG_HORAIRE: 433, // FCFA (en vigueur depuis le 01/01/2023)

  // CNPS — DOUBLE PLAFOND (ne jamais confondre)
  PLAFOND_CNPS_AT_PF_MENSUEL: 70_000,        // AT, Prestations familiales, Maternité
  PLAFOND_CNPS_RETRAITE_MENSUEL: 1_647_315,  // Retraite
  TAUX_CNPS_RETRAITE_SAL: 0.063, TAUX_CNPS_RETRAITE_PAT: 0.077,
  TAUX_CNPS_PF_PAT: 0.05, TAUX_CNPS_MATERNITE_PAT: 0.0075,
  TAUX_CNPS_AT_COMMERCE: 0.02, TAUX_CNPS_AT_BTP: 0.03,
  TAUX_CNPS_AT_INDUSTRIE: 0.04, TAUX_CNPS_AT_EXTRACTION: 0.05,

  // ITS — réforme au 01/01/2024 (Ordonnance n° 2023-719 du 13/09/2023) : remplace IS/CN/IGR.
  // Barème sur 100 % du brut imposable : PAS d'abattement, cotisations CNPS salariales NON déduites.
  ABATTEMENT_ITS: 0,
  TRANCHES_ITS_MENSUELLES: [
    { min: 0, max: 75_000, taux: 0.0 },
    { min: 75_001, max: 240_000, taux: 0.16 },
    { min: 240_001, max: 800_000, taux: 0.21 },
    { min: 800_001, max: 2_400_000, taux: 0.24 },
    { min: 2_400_001, max: 8_000_000, taux: 0.28 },
    { min: 8_000_001, max: Infinity, taux: 0.32 },
  ],
  // RICF (réduction pour charges de famille), imputée sur l'impôt brut : 5 500 par demi-part au-delà de 1.
  // Parts : célibataire/divorcé/veuf sans enfant 1 · marié 2 · +0,5/enfant · isolé avec ≥1 enfant 1,5 + 0,5/enfant · plafond 5.
  RICF_PAR_PARTS: { 1: 0, 1.5: 5_500, 2: 11_000, 2.5: 16_500, 3: 22_000, 3.5: 27_500, 4: 33_000, 4.5: 38_500, 5: 44_000 },
  // Exemples célibataire 0 enfant : brut 200 000 → 20 000 · 450 000 → 70 500 · 1 500 000 → 312 000

  // Congés (jours OUVRABLES) — CT art. 25.1 / CCI art. 69 : 2,2 j par mois de service
  CONGES_JOURS_PAR_MOIS: 2.2,
  // CT art. 25.2 (ordonnance 2021-902) : jours supplémentaires selon l'ancienneté
  ANCIENNETE_BONUS_JOURS: [ { annees: 5, joursSupp: 1 }, { annees: 10, joursSupp: 2 }, { annees: 15, joursSupp: 3 },
                            { annees: 20, joursSupp: 5 }, { annees: 25, joursSupp: 7 }, { annees: 30, joursSupp: 8 } ],

  // Assiette CNPS + ITS : primes (ancienneté, rendement), heures supp., ICP, gratifications et
  // avantages en nature SONT soumis. Prime de transport exonérée jusqu'à 30 000 F/mois (Abidjan),
  // 24 000 (Bouaké), 20 000 (autres villes) — CGI art. 116 al. 10, arrêté n° 2020-012/MEPS/CAB ;
  // excédent soumis. Hors bases : frais remboursés (6000), licenciement dans la limite légale,
  // indemnités maternité / AT. Paramétrable par rubrique (pack `traitementElementsVariables`,
  // tenant `payroll_rules.subject_social/subject_tax`).

  // Heures supplémentaires (majorations)
  MAJORATIONS_HEURES_SUPP: { normal: 0.15 /*41–48h*/, nuit: 0.5 /*20h–5h*/, dimanche: 0.5, ferie: 1.0 },

  // Délais & FDFP
  DELAI_DISA_MOIS: 1, ECNPS_DELAI_MENSUEL: 15, TAUX_CONTRIBUTION_FDFP: 0.004, // 0,4% masse sal. (>10 sal.)
}
```

**Préavis** (décret n° 96-200 du 7/03/1996, art. 18.4 CT / art. 34 CCI ; source de vérité = `terminationRules` du pack CIV_2024) : catégories 1–5 payées au mois : ≤ 6 ans 1 mois · ≤ 11 ans 2 mois · ≤ 16 ans 3 mois · > 16 ans 4 mois ; catégories 1–5 non mensualisées : ≤ 6 mois 8 j · ≤ 1 an 15 j, puis comme ci-dessus ; 6e catégorie et au-delà (maîtrise, cadres) : ≤ 16 ans 3 mois · > 16 ans 4 mois.
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
2. **ITS — barème 2024 sur 100 % du brut imposable.** Plus d'abattement de 15 % (supprimé au 01/01/2024) et les cotisations CNPS salariales ne sont PAS déduites de l'assiette : `its_brut = barème(brut_imposable)` (0/16/21/24/28/32 %), PUIS `ITS = max(0, its_brut − RICF(parts))`. Ne jamais réintroduire l'ancien régime (abattement, tranches 1,5/5/10/15 %, crédits 5 500 + 3 000/6 000/9 000). `PLAN_DEFAULTS` (ci-dessus) toujours dans l'INSERT tenant.
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

> ⚠️ **MFA OBLIGATOIRE EN PROD** (`mfa_required_super_admin` + `mfa_required_tenant_users` = `true`, PR #206/#207). Un compte sans MFA enrôlée reçoit au login un token restreint (`mfaPending`, 403 sur toute route métier) et est redirigé vers **`/mfa-setup`** : QR + 10 codes de secours affichés une seule fois, puis **reconnexion obligatoire**. Impossible à contourner par URL. Un code de secours s'utilise à la place du code TOTP dans le même champ. Détail → `docs/reference/specs-fonctionnelles.md` § Authentification.

> **Identifiants de démo (mots de passe + secret TOTP) → `nexusrh_ci/.credentials-local.md`** (fichier LOCAL, non versionné). Mot de passe `super_admin` **roté les 19-20/07/2026** (l'ancien avait fuité).
> Les valeurs sont pilotées par les variables d'env `SEED_SUPERADMIN_PASSWORD` / `SEED_DEMO_PASSWORD` / `SEED_OPENLAB_PASSWORD` / `SEED_MFA_TOTP_SECRET` (défauts fonctionnels dans `apps/api/src/db/seed.ts`). Aucun mot de passe n'est plus écrit en clair dans le dépôt.

**Plateforme** — `superadmin@nexusrh-ci.com` → `/platform/dashboard`
> ⚠️ Seedé `ON CONFLICT DO NOTHING` : en PROD le mot de passe a été changé et survit aux re-seeds. Le défaut ne marche que sur base neuve.

**SOTRA** (thème orange `#E85D04` · domaine **`@sotra.ci`**, pas `sotra-ci.com`) :
| Email | Rôle | Redirige |
|---|---|---|
| `admin@sotra.ci` | admin | `/dashboard` |
| `rh@sotra.ci` | hr_manager | `/dashboard` |
| `chef.perso@sotra.ci` | hr_officer | `/dashboard` |
| `manager@sotra.ci` | manager | `/dashboard` |
| `employe@sotra.ci` | employee | `/mon-espace` |
| `dg@sotra.ci` | dg | `/dashboard` |
| `mfa@sotra.ci` | hr_officer (MFA activé) | `/dashboard` |

**Cabinet Expertise CI** (thème bleu `#1D4ED8`) :
| Email | Rôle |
|---|---|
| `admin@cabinet-expertise.ci` | admin |
| `employe2@cabinet-expertise.ci` | employee |

---

## CHECKLIST AVANT DE GÉNÉRER

- [ ] Architecture multi-tenant (schema-per-tenant) comprise
- [ ] Moteur de paie CI : CNPS (double plafond) + ITS (barème 2024 0–32 % sur 100 % du brut → RICF par parts)
- [ ] SMIG 75 000 FCFA vérifié sur chaque bulletin · FCFA entiers partout (zéro décimale)
- [ ] Mobile Money : Wave + MTN + Orange (format +225, regex validée)
- [ ] Modules CI : CNPS/DISA, OHADA contrats, FDFP formation
- [ ] DISA agrégation annuelle (12 mois), génération janvier N+1
- [ ] Jours fériés CI 2024 dans le calcul congés (jours ouvrables) · 2,2 j ouvrables / mois de service (CT art. 25.1)
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
