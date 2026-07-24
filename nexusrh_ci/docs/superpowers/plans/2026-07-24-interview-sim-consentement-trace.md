# Consentement explicite + trace (interne & public) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exiger un consentement explicite AVANT tout entretien simulé (flux interne ET public) et en conserver une trace probante, à durée de conservation paramétrable par tenant et purgée automatiquement.

**Architecture:** Le consentement est recueilli avant la génération des questions ; son acceptation écrit une ligne dans une nouvelle table tenant `interview_sim_consents` (snapshot du texte consenti = preuve de l'objet du consentement). Côté interne la ligne porte l'`employee_id` (personne identifiée) ; côté public elle est STRICTEMENT ANONYME (`employee_id NULL`, aucun IP, seul un `session_id` aléatoire). Un réglage tenant `consent_retention_months` (défaut 36) borne la conservation, appliqué par un job de purge quotidien.

**Tech Stack:** Fastify 4 + Zod (API), PostgreSQL (schema-per-tenant), React 18 + TanStack Query + react-i18next (web), BullMQ worker + cron, Vitest.

## Global Constraints

- Base légale : RGPD art. 7-1 (démontrer le consentement). La trace est le SEUL élément conservé — les réponses/transcriptions restent ÉPHÉMÈRES et ne doivent jamais être persistées (la table `interview_sim_attempts` vient d'être supprimée pour cette raison ; ne pas la ressusciter).
- Trace publique STRICTEMENT ANONYME : `employee_id` NULL, **aucune adresse IP**, aucune donnée personnelle. Décision utilisateur du 2026-07-24.
- Conservation bornée et paramétrable par tenant (`consent_retention_months`, défaut 36) ; purge automatique obligatoire — une conservation illimitée recréerait le défaut corrigé le 2026-07-24.
- Tenant scoping via `request.user.schemaName` (JWT) côté interne ; via le `schema` du jeton signé côté public. Jamais depuis le body.
- Sans consentement enregistré, l'entretien NE DOIT PAS démarrer (refus serveur, pas seulement un garde-fou UI).
- TypeScript strict — pas de `any`, pas de `@ts-ignore`. Chaque async a sa gestion d'erreur.
- Migrations additives et idempotentes (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), ajoutées au chemin lazy (`schema-migrations.ts`) ET au provisioning (`provisioning.ts`).
- Commits : pas de co-auteur Claude. `git add -f` sous `nexusrh_ci/`.
- Après chaque tâche : `pnpm --filter api exec tsc --noEmit` / `pnpm --filter web exec tsc --noEmit`.

---

### Task 1: Persistance — table `interview_sim_consents` + réglage de conservation

**Files:**
- Modify: `apps/api/src/utils/schema-migrations.ts` (bloc interview-sim, là où `interview_sim_config` est créée et où `DROP TABLE ... interview_sim_attempts` a été ajouté)
- Modify: `apps/api/src/db/provisioning.ts` (bloc interview-sim)
- Test: `apps/api/src/modules/interview-sim/interview-sim.consent-migration.test.ts`

**Interfaces:**
- Produces: table `<schema>.interview_sim_consents` et colonne `interview_sim_config.consent_retention_months` — consommées par les Tasks 2 et 4.

DDL à ajouter dans LES DEUX chemins (lazy migration et provisioning), à l'identique :

```sql
CREATE TABLE IF NOT EXISTS "<schema>".interview_sim_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         varchar(10) NOT NULL CHECK (scope IN ('internal','public')),
  employee_id   uuid,              -- renseigné en INTERNE ; NULL en PUBLIC (trace anonyme)
  job_id        uuid NOT NULL,
  session_id    varchar(64) NOT NULL,
  consent_text  text NOT NULL,     -- snapshot EXACT du texte consenti (preuve de l'objet)
  accepted_at   timestamptz NOT NULL DEFAULT now()
)
```
puis un index : `CREATE INDEX IF NOT EXISTS idx_ISC_accepted_at ON "<schema>".interview_sim_consents (accepted_at)` (nom réel : `idx_interview_sim_consents_accepted_at`) — sert la purge.

Et la colonne de conservation :
```sql
ALTER TABLE "<schema>".interview_sim_config ADD COLUMN IF NOT EXISTS consent_retention_months int NOT NULL DEFAULT 36
```

- [ ] **Step 1: Write the failing test** — `interview-sim.consent-migration.test.ts`, sur le patron de `interview-sim.tenant-migration.test.ts` : lit les sources de `utils/schema-migrations.ts` et `db/provisioning.ts` et assert que LES DEUX contiennent `interview_sim_consents`, le `CHECK (scope IN ('internal','public'))`, l'index sur `accepted_at`, et `consent_retention_months int NOT NULL DEFAULT 36`. Assert AUSSI que `interview_sim_attempts` n'est jamais recréée (`CREATE TABLE` absent pour cette table) — non-régression du correctif RGPD.
- [ ] **Step 2: Run it, verify RED.** `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-sim.consent-migration.test.ts`
- [ ] **Step 3: Add the DDL** aux deux fichiers, avec un commentaire FR expliquant la base légale (art. 7-1) et l'anonymat strict de la trace publique.
- [ ] **Step 4: Run it, verify GREEN**, puis la suite interview-sim complète : `node_modules/.bin/vitest run src/modules/interview-sim`
- [ ] **Step 5: Typecheck** `pnpm --filter api exec tsc --noEmit`
- [ ] **Step 6: Commit** `feat(interview-sim): table interview_sim_consents + conservation paramétrable (RGPD art. 7-1)`

---

### Task 2: API — endpoints de consentement + blocage serveur de l'entretien

**Files:**
- Modify: `apps/api/src/modules/interview-sim/interview-sim.routes.ts`
- Test: `apps/api/src/modules/interview-sim/interview-sim.consent.routes.test.ts`

**Interfaces:**
- Consumes: table de la Task 1 ; `loadEligibleInternalJob`, `loadTenantConfig`, `verifyPublicToken` (déjà dans le fichier).
- Produces:
  - `POST /interview-sim/internal-jobs/:jobId/consent` → `{ data: { consentId: string, sessionId: string } }`
  - `POST /public/interview-sim/:token/consent` → `{ data: { consentId: string, sessionId: string } }`
  - `GET /interview-sim/internal-jobs/:jobId/start` accepte désormais `?sessionId=` **obligatoire** et refuse (403) si aucune trace de consentement ne correspond.
  Consommés par la Task 3.

Règles :
- `POST .../consent` (interne) : preHandlers habituels ; valide le body `{ consentAccepted: z.literal(true) }` strict ; vérifie l'éligibilité de l'offre via `loadEligibleInternalJob` (404 neutre sinon) ; lit `consent_text` de la config tenant (repli sur le texte par défaut existant) ; génère `sessionId` via `randomUUID()` ; INSERT `scope='internal'`, `employee_id = user.employeeId`, `job_id`, `session_id`, `consent_text` (snapshot) ; renvoie `consentId` + `sessionId`.
- `POST /public/interview-sim/:token/consent` : vérifie le jeton (401/410 comme les autres routes publiques) ; même INSERT mais `scope='public'` et **`employee_id = NULL`** ; `job_id` = `claims.jobId`. **N'enregistre AUCUNE IP.**
- `GET .../internal-jobs/:jobId/start` : exige `sessionId` (query, UUID) ; vérifie qu'il existe une ligne `interview_sim_consents` correspondante (`session_id`, `job_id`, `scope='internal'`, `employee_id` = celui du JWT) ; sinon `403 { error: 'Consentement requis' }` AVANT toute génération de questions.
- `GET /public/interview-sim/:token` : ne change PAS (il sert le texte de consentement et les questions comme aujourd'hui) ; en revanche `POST /public/interview-sim/:token/submit` exige déjà `consentAccepted: true` — ajouter la vérification que le `sessionId` fourni correspond à une trace enregistrée, sinon `403 { error: 'Consentement requis' }`.
- Ne PAS persister de réponses/transcriptions. Le flux reste éphémère hors trace de consentement.

- [ ] **Step 1: Write the failing tests** couvrant : 401 sans token (interne) ; 404 offre inéligible sur `/consent` ; 200 + INSERT vérifié avec `employee_id` du JWT et snapshot du texte (interne) ; INSERT avec `employee_id` NULL et AUCUNE IP (public) ; `start` en 403 sans `sessionId` ; `start` en 403 avec un `sessionId` inconnu ; `start` en 200 avec un `sessionId` valide ; et un test asservissant qu'aucune écriture ne touche `interview_sim_attempts`.
- [ ] **Step 2: Run, verify RED.**
- [ ] **Step 3: Implement** les deux routes + le blocage dans `start`/`submit`.
- [ ] **Step 4: Run, verify GREEN**, puis toute la suite `src/modules/interview-sim`.
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit** `feat(interview-sim): consentement explicite obligatoire + trace (interne & public)`

---

### Task 3: Web — écran de consentement dans les DEUX parcours

**Files:**
- Modify: `apps/web/src/components/interview-sim/OfferInterviewRunner.tsx` (+ son test)
- Modify: `apps/web/src/pages/public/PublicInterviewSimPage.tsx` (+ son test)
- Modify: `apps/web/src/i18n/locales/{fr,en}/interviewSim.json`

**Interfaces:** Consumes les endpoints de la Task 2.

- **Interne** (`OfferInterviewRunner`) : nouvel état initial `consent`. Au montage, NE PAS appeler `start`. Afficher le texte de consentement du tenant (récupéré via `GET /interview-sim/config` ou renvoyé par l'endpoint de consentement — choisir le chemin qui n'expose pas la config admin au salarié : si `GET /config` est réservé admin/hr_manager, faire renvoyer le texte par un endpoint accessible au salarié, ou l'inclure dans la réponse de `POST .../consent` n'a pas de sens **avant** l'acceptation → prévoir `GET /interview-sim/internal-jobs/:jobId/consent-text` accessible au salarié, à ajouter en Task 2 si nécessaire), un bouton d'acceptation explicite et un bouton retour. À l'acceptation : `POST .../consent`, récupérer le `sessionId`, puis seulement lancer `start` avec ce `sessionId`.
- **Public** (`PublicInterviewSimPage`) : l'écran de consentement existe déjà ; le câbler pour qu'à l'acceptation il appelle `POST /public/interview-sim/:token/consent`, mémorise le `sessionId` et le transmette au submit. Le refus/échec d'enregistrement doit empêcher de continuer (message d'erreur, pas de démarrage silencieux).
- i18n : ajouter les clés nécessaires (ex. `consentTitle`, `consentAccept` existe déjà côté public, `consentRequired`, `consentError`) en FR **et** EN, parité stricte, sans BOM.

- [ ] **Step 1: Write the failing tests** (les deux composants) : le consentement s'affiche AVANT toute question ; aucune requête `start` n'est émise tant que l'utilisateur n'a pas accepté ; après acceptation, `consent` puis `start` sont appelés dans cet ordre ; un échec d'enregistrement du consentement empêche le démarrage et affiche l'erreur.
- [ ] **Step 2: Run, verify RED.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run GREEN** + les tests voisins (`MesOffresInternes`, i18n).
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit** `feat(interview-sim): écran de consentement obligatoire avant l'entretien (interne & public)`

---

### Task 4: Réglage tenant + purge quotidienne

**Files:**
- Modify: `apps/api/src/modules/interview-sim/interview-sim.routes.ts` (config GET/PUT)
- Modify: la page de configuration du module côté web + i18n
- Create: job de purge côté `apps/worker` (suivre le patron de `apps/worker/src/attendance-cron.ts` : fan-out sur les tenants, `SAFE_SCHEMA`, cap)
- Tests: API config + worker purge

- Exposer `consentRetentionMonths` dans `GET/PUT /interview-sim/config` (Zod : entier, min 1, max 120) et dans le formulaire admin du module, avec libellés FR/EN.
- Purge : job quotidien qui, pour chaque tenant, exécute
  `DELETE FROM "<schema>".interview_sim_consents WHERE accepted_at < now() - (<consent_retention_months> || ' months')::interval`
  (valeur lue dans `interview_sim_config`, repli 36). Journaliser le nombre de lignes supprimées par tenant.

- [ ] **Step 1: Write failing tests** (config accepte/rejette les bornes ; la purge supprime bien au-delà de la durée et ne touche rien en deçà ; isolation par schéma).
- [ ] **Step 2: RED → Step 3: Implement → Step 4: GREEN.**
- [ ] **Step 5: Typechecks (api + web + worker).**
- [ ] **Step 6: Commit** `feat(interview-sim): durée de conservation du consentement paramétrable + purge quotidienne`

---

### Task 5: Goldens + suites complètes

**Files:**
- Modify: `apps/api/src/modules/interview-sim/interview-sim.ui-contract.golden.test.ts`
- Modify si nécessaire : `apps/api/src/ui-api-contract.golden.test.ts` (nouveaux endpoints)

- Verrouiller dans le golden : les deux routes `/consent`, le blocage de `start` sans consentement, la table `interview_sim_consents` provisionnée + migrée, la colonne `consent_retention_months`, l'anonymat de la trace publique (`employee_id` NULL en public, aucune IP enregistrée), et la NON-recréation de `interview_sim_attempts`.
- Lancer les suites COMPLÈTES (api, web, worker) + les trois typechecks. Tout doit être vert.
- [ ] **Commit** `test(interview-sim): golden consentement + trace`

## Notes d'exécution

- Le flux reste éphémère pour les réponses : SEULE la trace de consentement est conservée, et elle est bornée.
- Ne jamais enregistrer d'IP ni d'identifiant personnel côté public (décision utilisateur).
- Si un tenant n'a pas de `consent_text` configuré, le texte par défaut existant sert de snapshot — la preuve doit refléter ce qui a réellement été affiché.
