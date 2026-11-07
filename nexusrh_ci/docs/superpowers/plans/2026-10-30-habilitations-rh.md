# Habilitations RH par groupes — plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer, pour les droits RH, le rôle unique par des groupes,
sous-groupes et fiches d'habilitation validées N+1/N+2, avec un périmètre
filiale appliqué dans le SQL. Les tenants existants sont repris d'office, sans
fiche.

**Architecture:** Un moteur unique (`services/habilitation.service.ts`) calcule
les droits effectifs (fiche ∩ plafond) et le périmètre d'un utilisateur. Le
décorateur `authorize()` de `plugins/auth.ts` le consulte via une table
route → (fonction, action). Les modules filtrent les employés avec un fragment
SQL `hrScopeSql()`, sur le modèle de `managerScopeSql()`. Les fiches, les
délégations et les alertes de cumul sont un module Fastify `habilitations`.
L'écran admin vit dans Paramètres.

**Tech Stack:** Fastify 5 + TypeScript strict, PostgreSQL (schéma par tenant,
DDL partagé provisioning / `ensureTenantSchema`), pdf-lib via
`renderHrDocumentPdf`, BullMQ (worker), React 18 + TanStack Query + i18next
FR/EN, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-habilitations-rh-design.md`

## Global Constraints

- Le schéma vient TOUJOURS du JWT. Tout nom de schéma interpolé passe par
  `assertValidSchemaName`.
- Le contrôle se fait côté serveur sur chaque route. L'interface ne fait que
  masquer.
- Le filtrage filiale est fait **dans le SQL**, jamais en mémoire après coup.
- Fermé par défaut : une fonction absente du plafond, ou une route RH sans
  correspondance (fonction, action), est refusée (403) à un utilisateur
  habilité.
- Un retrait de droit prend effet à la requête suivante, sans reconnexion :
  pas de cache des droits au-delà de la requête.
- L'audit ne contient jamais de valeur de donnée personnelle (salaire, NNI, RIB,
  téléphone) : uniquement des identifiants et des noms de champs.
- L'admin du tenant (`role = 'admin'`) reste hors grille, avec tous les droits.
- Données seed : aucun corps de seed n'est exécuté en prod. La reprise de
  l'existant est une migration idempotente.
- FR/EN pour chaque libellé. Les tests golden (`ui-api-contract`,
  `security-authz-sweep`, `architecture-invariants`, `sql-schema-columns`)
  restent verts.
- Commits sans `Co-Authored-By: Claude` ni footer « Generated with Claude
  Code ». Les nouveaux fichiers sont ajoutés avec `git add -f`. Branche issue
  de `develop`.
- Tests : `pnpm --filter api exec vitest run <fichier> --maxWorkers=2` (machine
  à mémoire limitée).

## Review Focus

1. **Accès à une autre filiale par un chemin détourné** : URL directe
   `/employees/:id`, export CSV, recherche globale, organigramme, assistant IA
   ou téléchargement de document. On attend un 404 ou une liste vide, jamais
   la donnée. Testé à la tâche 5 (balayage multi-routes).
2. **Retrait au plafond pendant une session ouverte** : la requête suivante
   est refusée sans reconnexion. Testé à la tâche 2.
3. **Agir sur son propre dossier** : un DRH avec toutes les cases modifie son
   propre salaire, valide sa propre absence ou crée une fiche pour lui-même.
   On attend 403. Testé aux tâches 4 et 9.
4. **Employé sans filiale renseignée** : il relève du siège (décision du
   porteur) et reste invisible pour un sous-groupe filiale. Testé à la tâche 2.
5. **Reprise rejouée deux fois, ou sur un tenant sans filiale** : pas de
   doublon, et `DRH Groupe` → `RH Siège` seulement. Testé à la tâche 7.

---

## Lot A — Moteur et contrôle d'accès

### Task 1: Tables et catalogue de la grille

**Files:**
- Create: `apps/api/src/db/habilitations.ts`
- Create: `apps/api/src/modules/habilitations/catalog.ts`
- Modify: `apps/api/src/db/provisioning.ts` (appel des statements après `audit_log`)
- Modify: `apps/api/src/utils/schema-migrations.ts` (même appel dans `ensureTenantSchema`)
- Test: `apps/api/src/db/habilitations.test.ts`, `apps/api/src/modules/habilitations/catalog.test.ts`

**Interfaces:**
- Produces:
  - `habilitationTableStatements(schemaName: string): string[]`
  - `HAB_FUNCTIONS`, la liste ordonnée des 18 clés de fonction :
    - `employees`, `contracts`, `absences`, `attendance`, `payroll` ;
    - `payroll_multi`, `declarations`, `payments`, `expenses` ;
    - `recruitment`, `lifecycle`, `discipline`, `training`, `talent` ;
    - `climate`, `signature`, `reporting`, `hr_settings`.
  - `HAB_ACTIONS` : `view`, `create`, `update`, `delete`, `validate`,
    `close`, `export`, `pay`, `configure`.
  - `HAB_EXTRA` : `sensitive_data`, `all_entities`, `manage_habilitations`.
  - `HAB_GRID: Record<HabFunction, readonly HabAction[]>` : les cases
    proposées par fonction (`pay` seulement pour `payments`, `configure`
    seulement pour `hr_settings` et `payroll`).
  - `type Permission = \`${HabFunction}:${HabAction}\``
  - `SENSITIVE_IMPLIED: HabFunction[]` = `['payroll', 'declarations', 'payments']`

Tables, toutes dans le schéma tenant :

| Table | Colonnes clés |
|---|---|
| `hab_groups` | `id`, `name`, `created_at` |
| `hab_subgroups` | `id`, `group_id` → `hab_groups`, `name`, `kind` (`'siege'\|'entity'`), `legal_entity_id` (NULL si siège), `ceiling` (`text[]` de Permission + extras), `UNIQUE(legal_entity_id)` |
| `hab_assignments` (droits appliqués) | `id`, `user_id` UNIQUE, `subgroup_id`, `permissions text[]`, `source` (`'fiche'\|'reprise'\|'bootstrap'`), `fiche_id`, `effective_from date`, `revoked_at` |
| `hab_fiches` | `id`, `number` (`HAB-YYYY-NNNN`), `target_user_id`, `subgroup_id`, `permissions text[]`, `template_key`, `motive`, `effective_from`, `status` (`draft\|n1\|n2\|locked\|applied\|rejected\|superseded`), `kind` (`'grant'\|'revoke'`), `n1_user_id`, `n2_user_id`, `created_by`, `delegation_id`, `sod_alerts jsonb`, `locked_at`, `applied_at`, `applied_by`, `rejected_reason`, `created_at` |
| `hab_fiche_events` | `id`, `fiche_id`, `actor_id`, `event` (`created\|edited\|submitted\|validated\|rejected\|locked\|applied\|sod_accepted`), `diff jsonb` (avant/après des clés de permission uniquement), `ip`, `created_at` |
| `hab_delegations` | `id`, `delegator_id`, `delegate_id`, `subgroup_id` (périmètre), `starts_at`, `ends_at NOT NULL`, `revoked_at` |
| `hab_templates` | `id`, `key`, `label`, `permissions text[]` |
| `hab_sod_rules` | `id`, `label`, `left_perm`, `right_perm`, `active` |

- [ ] **Step 1: Écrire les tests en échec.**
  - `habilitations.test.ts` : `habilitationTableStatements('tenant_x')` crée
    les 8 tables en `IF NOT EXISTS`, avec un index unique sur
    `hab_assignments(user_id)` et sur `hab_subgroups(legal_entity_id)`.
  - `catalog.test.ts` : `HAB_FUNCTIONS.length === 18` ; `HAB_GRID.payments`
    contient `pay` ; aucune autre fonction ne contient `pay`.
- [ ] **Step 2:** Lancer `pnpm --filter api exec vitest run src/db/habilitations.test.ts src/modules/habilitations/catalog.test.ts --maxWorkers=2`. Attendu : FAIL (module introuvable).
- [ ] **Step 3: Implémenter les deux fichiers et les brancher.**
  - Brancher les statements dans `provisionTenantSchema` et
    `ensureTenantSchema`.
  - Ajouter les colonnes à `sql-schema-columns` si le golden les recense.
  - Remplir `hab_sod_rules` par `INSERT … ON CONFLICT DO NOTHING` avec ces
    défauts :
    - `payroll:validate` × `payments:pay`
    - `employees:create` × `payroll:validate`
    - `employees:create` × `payments:pay`
    - `payroll:configure` × `payroll:validate`
- [ ] **Step 4:** Relancer. Attendu : PASS. Lancer aussi
  `src/sql-schema-columns.golden.test.ts`.
- [ ] **Step 5:** Commit `feat(habilitations): tables et catalogue de la grille`.

### Task 2: Moteur — droits effectifs et périmètre SQL

**Files:**
- Create: `apps/api/src/services/habilitation.service.ts`
- Test: `apps/api/src/services/habilitation.service.test.ts`

**Interfaces:**
- Consumes: le catalogue de la tâche 1.
- Produces:
  - `interface HabContext { userId: string; subgroupId: string; kind: 'siege'|'entity'; legalEntityId: string|null; permissions: Set<string>; allEntities: boolean; sensitive: boolean; manageHabilitations: boolean; selfEmployeeId: string|null }`
  - `loadHabContext(schema: string, userId: string): Promise<HabContext|null>`
    — renvoie `null` si l'utilisateur n'a aucune affectation active
    (`revoked_at IS NULL AND effective_from <= current_date`). Une seule
    requête SQL, qui calcule l'intersection `permissions ∩ ceiling` en SQL.
    `sensitive` vaut vrai si `sensitive_data` est présent, ou si une fonction
    de `SENSITIVE_IMPLIED` figure dans les permissions.
  - `can(ctx: HabContext, fn: HabFunction, action: HabAction): boolean`
  - `hrScopeSql(schema: string, alias: string, ctx: HabContext|null): string`
    — fragment SQL booléen sur la ligne employé `alias` :
    - `ctx === null` → `TRUE` (accès hérité inchangé) ;
    - `kind = 'entity'` → `alias.legal_entity_id = '<uuid>'` ;
    - siège sans `allEntities` → `alias.legal_entity_id IS NULL` ;
    - siège avec `allEntities` → `TRUE`.
    L'uuid est validé par regex avant interpolation ; sinon, lever une erreur.

- [ ] **Step 1: Écrire les tests en échec** (pool mocké, routeur de requêtes
  comme dans `hire.service.test.ts`).
  - `can()` est faux pour `payroll:validate` quand ce droit est dans la fiche
    mais pas dans le plafond.
  - Après retrait du plafond (le mock renvoie un plafond sans la permission),
    un nouvel appel à `loadHabContext` donne `can() === false`.
  - `hrScopeSql` pour `entity` contient `legal_entity_id = '`.
  - Pour un siège sans `allEntities`, il contient `legal_entity_id IS NULL`.
  - Pour `null`, il vaut `TRUE`.
  - Un `legalEntityId` invalide (`"x' OR 1=1"`) lève une erreur.
  - Une affectation `effective_from` future donne `null`.
  - `sensitive === true` quand les permissions contiennent `payroll:view`.
- [ ] **Step 2:** Lancer `vitest run src/services/habilitation.service.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): moteur droits effectifs et périmètre SQL`.

### Task 3: Table route → permission et intégration à `authorize()`

**Files:**
- Create: `apps/api/src/modules/habilitations/route-permissions.ts`
- Modify: `apps/api/src/plugins/auth.ts:207-213`
- Modify: `apps/api/src/types/fastify.d.ts` (ou l'équivalent : `request.hab?: HabContext|null`)
- Modify: le handler `GET /auth/me` dans `apps/api/src/modules/auth/auth.routes.ts:904` (renvoie `permissions: string[]|null`, `habScope`)
- Test: `apps/api/src/modules/habilitations/route-permissions.test.ts`, `apps/api/src/plugins/auth.habilitations.test.ts`

**Interfaces:**
- Produces:
  - `HR_GRID_ROLES = ['hr_manager', 'hr_officer', 'raf_site'] as const`
  - `resolveRoutePermission(method: string, routeUrl: string): { fn: HabFunction; action: HabAction } | null`
    - Résolution par **préfixe de module** (`/employees` → `employees`,
      `/payroll/workflow` → `payroll_multi`, `/cnps` et `/disa` →
      `declarations`, `/bank-transfer` et `/mobile-money` → `payments`,
      `/onboarding` et `/offboarding` → `lifecycle`, `/org-chart`, `/dg` et
      `/reporting` → `reporting`, `/sage` → `payroll`, `/classification` →
      `hr_settings`, `/interview-sim` → `recruitment`, etc.).
    - Ensuite, verbe HTTP → action : GET → `view`, POST → `create`,
      PUT/PATCH → `update`, DELETE → `delete`.
    - Puis surcharges par suffixe : `/validate`, `/approve`, `/reject` →
      `validate` ; `/close`, `/submit` → `close` ; `/export` et `.csv` →
      `export` ; `/send`, `/pay` → `pay` ; `/settings`, `/config` →
      `configure`.
  - `authorize(...roles)` devient :
    1. vérifier le jeton (inchangé) ;
    2. si `role` ∈ roles et `role` ∉ `HR_GRID_ROLES` → autoriser (admin,
       manager, employee, dg, readonly : inchangé) ;
    3. sinon charger `request.hab = await loadHabContext(...)` (une fois par
       requête) ;
    4. si `request.hab` existe : autoriser seulement si `roles` contient au
       moins un rôle de `HR_GRID_ROLES` ET que `resolveRoutePermission(...)`
       n'est pas nul ET que `can()` est vrai. Sinon : 403
       `Accès interdit — habilitation insuffisante` ;
    5. sinon (aucune affectation) : comportement hérité `roles.includes(role)`.

- [ ] **Step 1: Écrire les tests en échec.**
  - `resolveRoutePermission('POST', '/payroll/periods/:id/close')` →
    `{ fn: 'payroll', action: 'close' }`.
  - `('GET', '/employees/export')` → `employees:export`.
  - `('GET', '/unknown-module')` → `null`.
  - Test d'invariant : chaque route enregistrée par `buildApp()` dont
    l'`authorize` contient `hr_manager` ou `hr_officer` se résout en une
    permission non nulle. Lister les routes via
    `app.printRoutes({ commonPrefix: false })` ou le hook `onRoute`.
  - Dans `auth.habilitations.test.ts`, un hr_officer habilité sans
    `payroll:close` reçoit 403 sur la clôture.
  - Le même utilisateur, sans affectation, garde le comportement hérité.
  - Un `admin` passe toujours.
  - Un utilisateur de rôle `employee` habilité avec `recruitment:view` passe
    sur `GET /recruitment/jobs` (`authorize('admin', 'hr_manager',
    'hr_officer')`).
  - `/auth/me` renvoie `permissions: null` sans affectation, et la liste avec
    une affectation.
  - Un employé habilité reste refusé sur une route `authorize('admin')`.
- [ ] **Step 2:** Lancer les deux fichiers. Attendu : FAIL.
- [ ] **Step 3: Implémenter.** Compléter la table jusqu'à ce que le test
  d'invariant passe : aucune route RH sans correspondance.
- [ ] **Step 4:** Relancer, puis `src/security-authz-sweep.golden.test.ts` et
  `src/ui-api-contract.golden.test.ts`. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): authorize() consulte la grille (route → fonction/action)`.

### Task 4: Garde « son propre dossier »

**Files:**
- Modify: `apps/api/src/services/habilitation.service.ts`
- Modify: les handlers d'écriture qui ciblent un employé :
  - employees (update salaire) ;
  - absences (approve) ;
  - expenses (approve) ;
  - discipline (create/update) ;
  - payroll (variable elements, validate).
- Test: `apps/api/src/services/habilitation-self.test.ts`

**Interfaces:**
- Produces: `assertNotSelf(ctx: HabContext|null, targetEmployeeId: string): void`
  — lève une erreur, traduite en 403 `Action interdite sur votre propre dossier`,
  quand `ctx && ctx.selfEmployeeId === targetEmployeeId`.

- [ ] **Step 1: Écrire les tests en échec.**
  - `assertNotSelf` lève une erreur pour un id identique.
  - Il ne lève rien pour `ctx = null`.
  - Route test : un DRH habilité (`employees:update`) reçoit 403 en modifiant
    son propre `base_salary`.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter et appeler la garde** dans les handlers listés.
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): aucune action RH sur son propre dossier`.

### Task 5: Périmètre filiale appliqué dans les modules

**Files:**
- Modify : chaque requête SQL qui lit ou modifie des employés pour un
  utilisateur RH, dans :
  - `employees`, `contracts`, `absences`, `attendance`, `payroll` ;
  - `expenses`, `recruitment` (embauche, candidatures internes) ;
  - `onboarding`, `offboarding`, `discipline`, `training` ;
  - `careers`, `competencies`, `mobility`, `succession`, `calibration` ;
  - `signature`, `org-chart`, `reporting`, `dg`, `ai` (outils), `sage`,
    `bank-transfer`, `mobile-money`, `cnps`.
- Test: `apps/api/src/habilitation-scope.golden.test.ts`

**Interfaces:**
- Consumes: `hrScopeSql(schema, alias, request.hab ?? null)` (tâche 2), à
  ajouter en `AND` dans la clause WHERE, à côté du filtre `managerScopeSql`
  existant.

- [ ] **Step 1: Écrire le golden en échec.**
  - Invariant statique : chaque fichier `*.routes.ts` de la liste ci-dessus
    qui contient `FROM "${schema}".employees` ou `JOIN …employees` importe et
    appelle `hrScopeSql`.
  - Balayage dynamique (pool mocké) : pour un contexte `entity` A, les
    requêtes envoyées par chacune des routes suivantes contiennent le
    fragment `legal_entity_id = '<A>'` :
    - `GET /employees`, `GET /employees/:id`, `GET /employees/export` ;
    - `GET /absences`, `GET /payroll/periods/:id/slips`,
      `GET /documents/:id/file` ;
    - `GET /org-chart`, `GET /reporting/headcount` ;
    - outil IA `search_employees`.
- [ ] **Step 2:** Lancer `vitest run src/habilitation-scope.golden.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Ajouter le fragment, module par module** (un commit par
  famille : dossiers et contrats ; temps et absences ; paie et paiements ;
  talents ; reporting et IA).
- [ ] **Step 4:** Relancer le golden, puis la suite de chaque module touché. Attendu : PASS.
- [ ] **Step 5:** Commit final `feat(habilitations): périmètre filiale appliqué dans tous les modules RH`.

### Task 6: Masquage des données sensibles

**Files:**
- Create: `apps/api/src/services/sensitive-mask.ts`
- Modify : les sérialiseurs de réponse employé, candidature, reporting et
  export CSV.
- Test: `apps/api/src/services/sensitive-mask.test.ts`

**Interfaces:**
- Produces:
  - `SENSITIVE_FIELDS = ['base_salary', 'salary', 'nni', 'iban', 'rib', 'bank_account', 'mobile_money_phone', 'cnps_number']`
  - `maskSensitive<T extends Record<string, unknown>>(row: T, ctx: HabContext|null): T`
    — remplace les valeurs par `null` quand `ctx && !ctx.sensitive`.

- [ ] **Step 1: Écrire le test en échec.**
  - Un contexte sans `sensitive` renvoie `base_salary: null`.
  - Un contexte `null` ne change rien.
  - Une ligne d'export CSV pour une chargée de recrutement a une colonne
    salaire vide.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter et appliquer** dans les sérialiseurs listés.
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): masquage des données sensibles hors case dédiée`.

## Lot B — Structure et reprise de l'existant

### Task 7: Reprise d'office des tenants existants et provisioning

**Files:**
- Create: `apps/api/src/db/habilitations-bootstrap.ts`
- Modify: `apps/api/src/utils/schema-migrations.ts` (appel après les tables)
- Modify : `provisioning.ts` (nouveau tenant) et la création de filiale dans
  `legal_entities` (création du sous-groupe).
- Test: `apps/api/src/db/habilitations-bootstrap.test.ts`

**Interfaces:**
- Produces:
  - `ensureHabilitationStructure(schema: string): Promise<void>` — crée
    `DRH Groupe` → `RH Siège`, plus un `RH Filiale <legal_entities.name>` par
    filiale active. Idempotent, grâce à l'unicité de
    `hab_subgroups.legal_entity_id` et à un nom de groupe unique.
  - `ROLE_DEFAULT_PERMISSIONS: Record<'hr_manager'|'hr_officer'|'raf_site', string[]>`
    — dérivé de la matrice RBAC de `CLAUDE.md`. `hr_officer` n'a ni `close`,
    ni `delete`, ni `pay`, ni `payroll:validate`. `raf_site` a
    `payroll_multi:view|update|close|validate`.
  - `bootstrapExistingUsers(schema: string): Promise<number>` — pour chaque
    `users` actif de rôle `hr_manager`, `hr_officer` ou `raf_site` sans
    affectation :
    - sous-groupe = la filiale de son dossier employé, ou celle du `raf_site`
      (`raf_user_id` des périodes) ; sinon `RH Siège` ;
    - permissions = `ROLE_DEFAULT_PERMISSIONS[role]`, plus `sensitive_data`
      pour `hr_manager` et `raf_site` ;
    - plus `all_entities` pour un membre du siège de rôle `hr_manager` ou
      `hr_officer` (il voit tout aujourd'hui).

    Ensuite :
    - plafond de chaque sous-groupe = union des permissions de ses membres ;
    - `source = 'reprise'` ;
    - audit `habilitation.bootstrap`.

    Ne fait rien si l'utilisateur a déjà une affectation. Renvoie le nombre
    de personnes affectées.

- [ ] **Step 1: Écrire les tests en échec.**
  - Tenant sans filiale : un seul groupe et un seul sous-groupe `RH Siège`.
  - Deux exécutions donnent le même nombre de lignes (idempotence).
  - Un `raf_site` de la filiale B est affecté à `RH Filiale B`, sans
    `all_entities`.
  - Un `hr_officer` du siège a `all_entities` et pas `payroll:close`.
  - Le plafond de `RH Siège` est l'union de ses membres.
  - Un `admin` n'est pas affecté.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter et brancher.**
  - Le bootstrap s'exécute **une fois par schéma**, dans
    `ensureTenantSchema` : appeler `ensureHabilitationStructure`, puis
    `bootstrapExistingUsers` seulement si `hab_assignments` est vide et que
    la table n'a jamais été initialisée. Utiliser un marqueur dans
    `hab_groups` ou une ligne `platform.tenants.hab_bootstrapped_at`.
  - Pour un nouveau tenant : structure créée, aucune reprise. Le premier DRH
    est habilité par l'admin (`source = 'bootstrap'`, tâche 8).
- [ ] **Step 4:** Relancer, ainsi que `src/app.boot.golden.test.ts`. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): reprise d'office des tenants existants (sans fiche)`.

### Task 8: API admin — groupes, sous-groupes, plafonds, modèles, aperçu

**Files:**
- Create: `apps/api/src/modules/habilitations/structure.routes.ts`
- Modify: l'enregistrement des modules dans `apps/api/src/app.ts`
- Test: `apps/api/src/modules/habilitations/structure.routes.test.ts`

**Interfaces:**
- Produces les routes suivantes. Toutes, sauf indication contraire, sont
  `authorize('admin')`.

| Route | Rôle |
|---|---|
| `GET /habilitations/structure` | groupes, sous-groupes, plafonds, membres, nombre d'employés sans filiale (siège) |
| `POST /habilitations/groups`, `POST /habilitations/subgroups` | création |
| `PATCH /habilitations/subgroups/:id/ceiling` | body `{ ceiling: string[] }`, validé contre le catalogue ; audit avant/après |
| `GET/POST/PATCH /habilitations/templates` | modèles de fiche |
| `GET/PATCH /habilitations/sod-rules` | cumuls sensibles |
| `POST /habilitations/bootstrap-user` | `{ userId, subgroupId, permissions }` ; uniquement si le tenant n'a encore aucune affectation `fiche`/`bootstrap` (premier DRH) |
| `GET /habilitations/preview/:userId` | « Ce que voit X » ; renvoie `loadHabContext` sérialisé + filiales couvertes + champs masqués, calculé par le **même** moteur |

- [ ] **Step 1: Écrire les tests en échec.**
  - Retirer `payroll:close` du plafond rend `can()` faux pour un membre
    (contrôle via preview).
  - Un plafond contenant `foo:bar` → 400.
  - `bootstrap-user` → 409 si une fiche a déjà été appliquée.
  - Un `hr_manager` qui appelle ces routes → 403.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4:** Relancer avec les goldens. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): API structure, plafonds, modèles, aperçu`.

## Lot C — Fiche d'habilitation

### Task 9: Fiche et circuit N+1 → N+2 → admin

**Files:**
- Create: `apps/api/src/modules/habilitations/fiche.service.ts`
- Create: `apps/api/src/modules/habilitations/fiche.routes.ts`
- Test: `apps/api/src/modules/habilitations/fiche.service.test.ts`, `fiche.routes.test.ts`

**Interfaces:**
- Consumes: `loadHabContext`, `can`, catalogue, `auditTenant`, table `notifications`.
- Produces:
  - `canCreateFiche(ctx: HabContext|null, role: string, subgroupId: string, activeDelegation: Delegation|null): boolean`
    - `admin` : oui ;
    - `manage_habilitations` au niveau `DRH Groupe` (sous-groupe siège) :
      tout sous-groupe ;
    - `manage_habilitations` sur un sous-groupe `entity` : ce sous-groupe
      seulement ;
    - délégation active : le périmètre du délégant.
  - `resolveApprovers(schema: string, targetUserId: string, creatorId: string): Promise<{ n1: string|null; n2: string|null }>`
    - Lit `employees.manager_id` du dossier de la personne ciblée, puis celui
      du N+1, et retrouve leurs `users`.
    - Saute un validateur qui n'a pas de compte, qui est la personne ciblée,
      ou qui est le créateur.
    - Si N+2 est absent : prendre un titulaire de `manage_habilitations` du
      siège, sinon un `admin`.
  - `computeSodAlerts(schema: string, targetUserId: string, permissions: string[]): Promise<Array<{ ruleId: string; label: string }>>`
    — combine les permissions de la fiche avec celles de l'affectation
    existante.
  - Transitions (une fonction par transition, chacune écrit un
    `hab_fiche_events`) :
    - `submitFiche` : draft → n1 ; à chaque passage d'étape, une
      notification va à l'acteur suivant (N+1, puis N+2) ;
    - `validateFiche` : n1 → n2, puis n2 → locked, avec notification des
      admins seulement à ce moment ;
    - `rejectFiche` : n1, n2 ou locked → rejected, motif obligatoire ; retour
      au créateur, qui peut rééditer et resoumettre ;
    - `editFiche` : autorisé en draft par le créateur, en n1 par le N+1, en
      n2 par le N+2 ; jamais après locked ;
    - `applyFiche` : locked → applied (admin), upsert de `hab_assignments`,
      l'ancienne fiche passe à `superseded` ; si `effective_from` > aujourd'hui,
      l'affectation est créée avec cette date (le moteur l'ignore jusque-là).
  - Une fiche `kind = 'revoke'` met `revoked_at` à jour à l'application.
  - Validation : `permissions` ⊆ plafond du sous-groupe ; sinon 400, avec la
    liste des cases hors plafond.
  - Si `sod_alerts` n'est pas vide, valider exige `acceptSod: true` dans le
    body, et l'événement `sod_accepted` est tracé.
  - Routes `/habilitations/fiches` :
    - `GET /habilitations/fiches` : liste, filtrée par celles que je crée, que
      je valide ou que j'applique ;
    - `POST`, `PATCH /:id`, `POST /:id/submit|validate|reject|apply` ;
    - `GET /:id` avec ses événements ;
    - `GET /:id/pdf`.
  - Une route renvoie 403 si l'appelant n'est pas l'acteur attendu à l'étape.
    Elle renvoie 403 aussi si `target_user_id` est l'appelant lui-même
    (pas d'auto-habilitation).

- [ ] **Step 1: Écrire les tests en échec** (service).
  - Circuit nominal : draft → n1 → n2 → locked, avec une notification admin
    créée seulement à locked.
  - `editFiche` par le N+1 en n1 réussit, et le diff de l'événement contient
    uniquement des clés de permission.
  - `editFiche` en locked lève une erreur.
  - Un refus sans motif lève une erreur.
  - Un créateur qui est aussi le N+1 fait passer le N+1 au validateur suivant.
  - Une fiche hors plafond est rejetée en 400.
  - Une alerte de cumul sans `acceptSod` bloque la validation ; avec
    `acceptSod`, la fiche passe et l'événement `sod_accepted` existe.
  - `applyFiche` rend `loadHabContext` non nul pour la personne ciblée.
  - Un RH de filiale ne crée pas de fiche pour un autre sous-groupe.
  - Une fiche pour soi-même → 403.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter le service et les routes.**
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): fiche d'habilitation et circuit N+1/N+2/admin`.

### Task 10: PDF de la fiche

**Files:**
- Create: `apps/api/src/modules/habilitations/fiche-pdf.ts`
- Test: `apps/api/src/modules/habilitations/fiche-pdf.test.ts`

**Interfaces:**
- Consumes: `renderHrDocumentPdf(markdown, branding)` et
  `loadContractEmployer(schema, null)` (`recruitment/contract-proposal.service.ts`).
- Produces: `renderFichePdf(schema: string, ficheId: string): Promise<Uint8Array>`.
  - Le markdown contient :
    - le numéro de fiche ;
    - la personne : nom et matricule, sans aucune donnée sensible ;
    - le groupe et le sous-groupe ;
    - le périmètre ;
    - une table fonctions × actions cochées ;
    - les alertes de cumul ;
    - la chronologie des validations (nom, date).
  - `draftMark` vaut `'BROUILLON — fiche non verrouillée'` tant que le statut
    n'est pas `locked` ni `applied`.

- [ ] **Step 1: Écrire le test en échec.**
  - Le markdown généré (fonction interne exportée `ficheMarkdown`) contient
    le numéro et `RH Filiale`.
  - Il ne contient aucun montant.
  - La marque de brouillon est présente en statut `n1` et absente en `applied`.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter**, puis brancher `GET /habilitations/fiches/:id/pdf`.
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): PDF de la fiche à la charte de l'entreprise`.

### Task 11: Écrans web — structure, fiches, aperçu

**Files:**
- Create: `apps/web/src/pages/habilitations/HabilitationsPage.tsx`, avec trois
  onglets :
  - Structure : arbre, plafonds en grille à cocher, compteur d'employés sans
    filiale ;
  - Fiches : liste par étape, formulaire grille préremplissable par modèle,
    actions selon l'étape, téléchargement PDF ;
  - Délégations.
- Create: `apps/web/src/components/habilitations/PermissionGrid.tsx`
  (grille 18 × 9, n'affiche que `HAB_GRID[fn]`, accepte `ceiling` pour
  griser ce qui est hors plafond).
- Create: `apps/web/src/components/habilitations/PreviewDrawer.tsx` (« Ce que voit X »).
- Create: `apps/web/src/i18n/locales/{fr,en}/habilitations.json`
- Modify: `apps/web/src/App.tsx` (route `/habilitations`).
- Modify: `apps/web/src/components/layout/Sidebar.tsx`. L'entrée est visible
  pour `admin`, pour un titulaire de `hr_settings:manage_habilitations` et
  pour un validateur ayant des fiches en attente.
- Modify: `apps/web/src/stores/auth.ts`. Il stocke `permissions` depuis
  `/auth/me`. La Sidebar filtre une entrée RH par `fn` quand
  `permissions !== null`.
- Modify: `apps/web/src/guards/RoleGuard.tsx` et la redirection post-login.
  Un utilisateur de rôle `employee` dont `permissions !== null` a l'espace RH
  (`/dashboard`, `MainLayout`) au lieu de `/mon-espace`. Il garde l'accès à
  son self-service par l'entrée épinglée « Mon espace ».
- Test: `apps/web/src/components/habilitations/permission-grid.test.tsx`, `apps/web/src/pages/habilitations/habilitations-page.test.tsx`

- [ ] **Step 1: Écrire les tests en échec.**
  - La grille ne propose pas « Payer » sur la ligne Paie.
  - Une case hors plafond est désactivée.
  - En statut `locked`, le formulaire est en lecture seule.
  - Une alerte de cumul affiche une case « J'ai pris connaissance du cumul »,
    obligatoire avant « Valider ».
  - La Sidebar d'un utilisateur dont `permissions` ne contient aucune
    permission `payroll:*` masque Paie.
- [ ] **Step 2:** Lancer `pnpm --filter web exec vitest run src/components/habilitations src/pages/habilitations --maxWorkers=2`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** et ajouter les clés FR/EN.
- [ ] **Step 4:** Relancer, puis `pnpm --filter web exec tsc --noEmit`. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): écrans structure, fiches et aperçu`.

## Lot D — Délégation, échéances, audit, sortie

### Task 12: Délégation et job quotidien

**Files:**
- Create: `apps/api/src/modules/habilitations/delegation.routes.ts`
- Create: `apps/worker/src/jobs/habilitations-daily.ts`
- Modify: `apps/worker/src/index.ts`. Ajouter la queue
  `habilitations-daily`, avec un cron quotidien à 01:00 Africa/Abidjan, sur le
  modèle de `interview-sim-consent-purge`.
- Test: `delegation.routes.test.ts`, `apps/worker/src/jobs/habilitations-daily.test.ts`

**Interfaces:**
- Produces:
  - `POST /habilitations/delegations` `{ delegateId, endsAt }`, accessible à
    un titulaire de `manage_habilitations`. Les règles :
    - `endsAt` est obligatoire, dans le futur et à 90 jours au plus ;
    - le délégataire doit être membre d'un sous-groupe du périmètre du
      délégant ;
    - un délégataire ne peut pas déléguer à son tour ;
    - la délégation est tracée dans l'audit.
  - `DELETE /habilitations/delegations/:id` révoque la délégation.
  - `activeDelegation(schema, userId): Promise<Delegation|null>` filtre sur
    `now() BETWEEN starts_at AND ends_at AND revoked_at IS NULL`.
    L'expiration est donc effective sans job.
  - `processHabilitationsDailyJob()` : pour chaque tenant actif, il trace
    `delegation.expired` pour les délégations échues du jour et
    `habilitation.activated` pour les affectations dont `effective_from` est
    aujourd'hui (audit seulement : le moteur filtre déjà par date).

- [ ] **Step 1: Écrire les tests en échec.**
  - Une délégation sans `endsAt` → 400.
  - Une délégation de plus de 90 jours → 400.
  - Un délégataire qui délègue → 403.
  - Après `ends_at`, `canCreateFiche` est faux.
  - Le job écrit un événement `delegation.expired`, une seule fois par
    délégation.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4:** Relancer, puis `apps/worker/src/architecture-invariants.golden.test.ts`. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): délégation temporaire et job quotidien`.

### Task 13: Piste d'audit filtrable et traçage des actions RH

**Files:**
- Modify: `apps/api/src/plugins/auth.ts`. Ajouter un hook `onResponse` : pour
  un utilisateur habilité, les requêtes non-GET réussies, les exports et les
  GET d'un dossier ou d'un document sensible écrivent `auditTenant` avec
  `action: 'hr.<fn>.<action>'`, `entity: fn`, `entityId` (`params.id` si uuid)
  et `changes: { route, subgroupId }`, sans body.
- Create: `apps/api/src/modules/habilitations/audit.routes.ts`
- Modify: `HabilitationsPage.tsx` (4e onglet « Piste d'audit »).
- Test: `audit.routes.test.ts`

**Interfaces:**
- Produces: `GET /habilitations/audit?role=&subgroupId=&groupId=&matricule=&userId=&from=&to=&format=csv`
  (admin). Jointure `audit_log` → `users` (rôle) → `hab_assignments`
  (sous-groupe, groupe) → `employees` (matricule). Paginé à 100 lignes. Le
  CSV est encodé en UTF-8 avec BOM.

- [ ] **Step 1: Écrire les tests en échec.**
  - Le filtre `matricule=MAT00084` génère la clause sur
    `employees.employee_number`.
  - Le filtre `subgroupId` filtre bien.
  - Une écriture RH (POST) d'un utilisateur habilité génère un audit sans
    body.
  - Un GET de liste ne génère rien.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): piste d'audit filtrable (rôle, groupe, matricule, utilisateur)`.

**Amendement du 04/11/2026 (demande du porteur : « toutes ses actions doivent
être tracées et consultables ») — prime sur les étapes ci-dessus :**
- Tracer TOUTES les requêtes d'un utilisateur habilité, GET de liste compris
  (`action: 'hr.<fn>.view'`), avec un champ `result` :
  `allowed` | `denied_permission` (403 grille) | `denied_scope` (404 dû au
  périmètre filiale) | `denied_self` (garde « son propre dossier ») |
  `masked` (réponse avec `maskedFields`, liste des noms de champs).
- Le 404 de périmètre est distingué d'un vrai 404 par un marqueur posé sur la
  requête au moment du refus (ex. `request.habDenial = 'scope'`) ; la réponse
  HTTP reste un 404 identique (pas de fuite d'existence), seule la trace
  interne porte la cause.
- Toujours sans body ni valeur personnelle ; pour les GET, `changes` porte
  la route et les noms des filtres utilisés, jamais leurs valeurs.
- `GET /habilitations/audit` ajoute le filtre `result=` et l'onglet « Piste
  d'audit » permet de filtrer « Accès refusés ».
- Tests : un GET de liste génère une trace `allowed` (remplace « ne génère
  rien ») ; un 403 grille, un 404 de périmètre et un refus « propre dossier »
  génèrent chacun leur `result` ; un vrai 404 hors périmètre-habilitation ne
  porte pas `denied_scope`.

### Task 14: Coupure automatique au départ

**Files:**
- Modify: le handler de clôture d'offboarding dans
  `apps/api/src/modules/offboarding/offboarding.routes.ts`, et la
  désactivation d'utilisateur dans `employees.routes.ts`.
- Test: `apps/api/src/modules/offboarding/offboarding-habilitations.test.ts`

**Interfaces:**
- Produces: `revokeAllForUser(schema: string, userId: string, reason: 'offboarding'|'user_disabled'): Promise<void>`
  (dans `habilitation.service.ts`). Elle pose `revoked_at`, révoque les
  délégations données et reçues, et trace l'audit `habilitation.revoked`.

- [ ] **Step 1: Écrire le test en échec.**
  - Après clôture de la sortie, `loadHabContext` renvoie `null`.
  - Les délégations de la personne ont `revoked_at`.
- [ ] **Step 2:** Lancer. Attendu : FAIL.
- [ ] **Step 3: Implémenter et appeler** la révocation aux deux endroits.
- [ ] **Step 4:** Relancer. Attendu : PASS.
- [ ] **Step 5:** Commit `feat(habilitations): coupure des droits au départ`.

### Task 15: Mise en prod et recette avec fiches

- [ ] **Step 1:** Suites complètes api et web, plus `tsc --noEmit`. Attendu :
  tout vert. Puis PR → develop, CI verte, merge, PR develop → main, merge,
  attendre le déploiement (workflow « Build & Deploy — NexusRH CI »).
- [ ] **Step 2: Recette reprise** (Chrome, prod, SOTRA via le compte cabinet).
  - Paramètres → Habilitations montre `DRH Groupe` → `RH Siège`, et un
    sous-groupe par filiale SOTRA.
  - `rh@sotra.ci` et `chef.perso@sotra.ci` y sont, avec des droits
    identiques à avant.
  - « Ce que voit X » est cohérent.
  - Aucun écran ne régresse pour ces comptes.
- [ ] **Step 3: Recette fiche.**
  - Créer une fiche « Chargé de recrutement » pour un employé de test de
    SOTRA, sans « Voir les salaires ».
  - Valider en N+1, modifier en N+2, valider. La fiche est verrouillée et
    l'admin est notifié.
  - Télécharger le PDF (logo, mentions, marque absente).
  - Habiliter, puis vérifier que l'aperçu montre le recrutement, sans
    salaire, et dans le périmètre attendu.
  - Retirer « Créer » du plafond : l'aperçu se met à jour aussitôt.
  - Vérifier le filtrage de la piste d'audit par matricule.

  Ne pas créer de compte réel en prod sans l'accord du porteur. Utiliser un
  employé et un compte de test qu'il désigne.
- [ ] **Step 4:** Mettre à jour la mémoire du projet (habilitations livrées,
  pièges rencontrés).
