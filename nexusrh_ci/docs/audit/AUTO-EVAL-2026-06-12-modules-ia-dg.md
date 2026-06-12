# Rapport d'auto-évaluation — Modules par tenant · IA hybride · Vue DG 360°

**Date** : 12 juin 2026 · **Branche** : develop · **Périmètre** : nexusrh_ci/ (API + Web)

Chaque étape a été validée par un golden test dédié, la compilation TypeScript
stricte (API + Web) et la suite complète de tests (non-régression).

---

## Étape 1 — Modules activables/désactivables par tenant (super_admin)

**Besoin** : certains clients ne veulent pas tous les modules ; le super_admin
doit pouvoir activer/désactiver les modules d'un tenant, et en masse pour un ou
plusieurs tenants d'un cabinet.

**Implémentation**
- `platform.tenants.enabled_modules` (jsonb de surcharges, migration lazy
  idempotente) — `'{}'` = défauts → **zéro régression** sur les tenants existants.
- 14 clés canoniques (`services/tenant-modules.service.ts`) : contracts, payroll,
  absences, expenses, recruitment, onboarding, training, careers, cnps,
  mobile_money, reporting, integrations, ai, dg_view (opt-in).
- Routes super_admin : `GET/PUT /platform/tenants/:id/modules` +
  `POST /platform/tenants/modules-bulk` (tenantIds et/ou agencyId → tenants
  rattachés non détachés). Clés bornées (OWASP A03), audit log (A09), cache 30 s
  invalidé à chaque modification.
- **Enforcement côté API** (OWASP A01) : hook global Fastify — toute route d'un
  module désactivé → `403 { moduleDisabled: true, module }`. Exemptions :
  super_admin, contexte plateforme, webhooks signés, non-authentifié (la route
  rend son 401). Fail-open en cas d'erreur DB (un toggle commercial ne doit pas
  rendre la plateforme indisponible).
- `tenantConfig.enabledModules` exposé au login, `/auth/me` et à l'activation
  d'une session cabinet → la sidebar masque les modules désactivés
  (`lib/modules.ts` + `ModuleGuard`), le portail super_admin a un onglet
  « Modules » (tenant) et une section « Modules des tenants du cabinet »
  (sélection multi-tenants + application en masse).

**Validation** : `tenant-modules.golden.test.ts` — 19/19 ✓ (défauts, résolution,
mapping URL→module, fail-open, cache, migration, routes, enforcement, login).

**Auto-évaluation** : ✅ conforme. Limite assumée : la désactivation d'un module
coupe aussi le self-service employé lié (ex. paie désactivée → « Mes bulletins »
bloqué côté API), comportement cohérent avec « le client n'a pas le module ».

---

## Étape 2 — IA générative hybride (questions internes + externes)

**Besoin** : l'assistant doit répondre aux questions internes (« la DRH a-t-elle
validé la paie ? », « combien d'absents aujourd'hui ? », « quel employé est à
surveiller ? ») ET aux questions externes (« comment booster mes équipes en
tant que DG/DRH ? »).

**Implémentation**
- Tool use Anthropic sur `/ai/chat` (SSE conservé) : 6 outils LECTURE SEULE
  scopés tenant (`modules/ai/ai-tools.ts`) — statut paie (+ valideur), absents
  du jour, demandes en attente, effectifs, employés à risque (scoring IA
  nocturne), pipeline recrutement.
- Matrice rôle→outils alignée RBAC : admin/hr_manager/dg = tout ; hr_officer
  sans scoring rétention ; manager = agrégats sans liste nominative ; employee/
  readonly = aucun outil. Defense in depth : `executeAiTool` re-vérifie le rôle.
- Boucle tool_use bornée (5 tours max), usage tokens cumulé, outils appelés
  tracés dans l'audit log (qui a interrogé quoi via l'IA).
- System prompt mis à jour : 2 familles de questions, interdiction de deviner
  une donnée interne, conseils management adaptés au contexte CI.
- Rôle `dg` admis au chat IA.

**Validation** : `ai-hybrid.golden.test.ts` — 17/17 ✓ + tests existants
`ai.routes.test.ts` 17/17 ✓ (non-régression du SSE/sanitization/rate-limit).

**Auto-évaluation** : ✅ conforme. Limites assumées : les outils du manager ne
sont pas (encore) scopés à son équipe — choix : ne lui donner que des agrégats
anonymes ; les questions internes nécessitent une clé IA configurée (tenant ou
plateforme), comportement inchangé.

---

## Étape 3 — Vue DG 360° (contrôle au-dessus du DRH)

**Besoin** : une vue Directeur Général pour contrôler les actions du DRH et des
responsables (jour/semaine/mois, filtre par personne, actions groupées par
catégorie dépliables) + un dashboard très riche (KPIs, graphes, camemberts,
tableaux, données instantanées). Activable UNIQUEMENT par le super_admin, par
tenant.

**Implémentation**
- Rôle tenant dédié `dg` (attribuable par l'admin tenant, redirigé vers `/dg`
  au login). Module `dg_view` opt-in (défaut **désactivé**) → seul le
  super_admin l'active (onglet Modules), enforcement par le hook global.
- API `modules/dg/dg.routes.ts` (lecture seule, `authorize('dg')` strict — ni
  admin ni hr_manager, puisque la vue sert à les contrôler) :
  - `GET /dg/overview` : KPIs (effectifs, masse salariale + évolution %, taux
    d'absentéisme du jour, validations en attente, postes ouverts +
    candidatures, formations, frais du mois) + séries (paie 12 mois, effectifs
    12 mois, départements, absences par type, pipeline) + statut des 3
    dernières paies avec le NOM du valideur + top 5 employés à risque.
  - `GET /dg/activity` : audit_log joint aux users — filtre par responsable
    (UUID validé), période jour/semaine/mois ou from/to, groupé par catégorie
    avec détails (acteur, rôle, action, changements), borné à 1000 lignes.
  - `GET /dg/actors` : responsables filtrables (admin, hr_manager, hr_officer,
    manager, raf_site).
  - Les consultations DG sont elles-mêmes auditées.
- Web : `DgDashboardPage` (8 cartes KPI + 5 graphes Recharts + 2 panneaux) et
  `DgActivityPage` (filtres + accordéons par catégorie), sidebar dédiée au rôle
  dg (Vue 360° + Activité uniquement), i18n FR/EN (namespace `dg`).
- Seed démo : `dg@sotra.ci / Admin1234!` + `dg_view` activé sur SOTRA.

**Validation** : `dg.golden.test.ts` — 21/21 ✓ et `ui-contract.golden.test.ts`
(contrat UI↔API) — 15/15 ✓.

**Auto-évaluation** : ✅ conforme. Limite assumée : la profondeur du journal
dépend de la couverture de l'audit log existant (paie, absences, frais,
employés, reporting, IA, auth, settings sont couverts) ; l'évolution des
effectifs 12 mois est calculée sur les embauches des employés actifs
(approximation en l'absence de date de sortie dédiée).

---

## Non-régression (suite complète)

- `tsc --noEmit` API : ✓ 0 erreur · `tsc --noEmit` Web : ✓ 0 erreur.
- Suite API complète : 3414 tests — 1 échec détecté par le golden exhaustif
  `ui-api-contract.golden.test.ts` (les nouveaux appels `/dg/*` du web devaient
  être déclarés dans la carte des préfixes du test) → corrigé, re-passage
  complet vert.
- Golden tests ajoutés : 4 fichiers, 72 assertions au total.

## Sécurité (OWASP 2025)

- **A01** : enforcement modules côté API (pas seulement le masquage UI) ; vue DG
  réservée au rôle `dg` ; outils IA re-vérifiés serveur ; manager sans données
  nominatives.
- **A03** : clés de modules bornées ; UUID/dates validés ; mois d'outil IA
  validé par regex avant paramétrage ; aucune interpolation non validée.
- **A09** : toutes les actions sensibles auditées (toggles modules, bulk,
  consultations DG, outils IA appelés).
