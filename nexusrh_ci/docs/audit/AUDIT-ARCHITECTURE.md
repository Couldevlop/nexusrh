# Audit Architecture, Cohérence & Bonnes Pratiques — NexusRH CI

> Audit **en lecture seule**. Périmètre : architecture, cohérence, bonnes pratiques.
> La sécurité OWASP est traitée par un audit séparé (les constats croisés ne sont
> notés ici que lorsqu'ils sautent aux yeux).
> Date : 2026-06-07 · Branche : `develop` · Commit de base : `8214c7e`

---

## 1. Résumé exécutif

NexusRH CI est un monorepo mature et cohérent : ~237 fichiers source (hors tests),
~30 000 LOC côté API, ~24 000 côté web, **113 fichiers de tests** et une couverture
annoncée à 99,9 %. Le respect du TypeScript strict est excellent (0 `@ts-ignore`,
0 `any` côté web, 26 `any` côté API concentrés sur Elasticsearch/référentiels). La
gestion d'erreurs est globalement professionnelle (error handler central avec mapping
des codes PostgreSQL, codes HTTP bien différenciés, pas de stack trace en prod). Le
moteur de paie est **unifié** (un seul `calculatePayrollCI`, appelé par le seed ET les
routes — zéro duplication de la logique métier critique), validé par 39 fixtures golden.
L'i18n est exhaustif (23 namespaces fr+en quasi à parité, 3 000+ appels `t()`). Le RBAC
est appliqué sur **les 255 routes** des modules.

Cependant l'audit révèle un **écart structurel majeur entre l'architecture documentée
(CLAUDE.md) et l'implémentation réelle de la couche d'accès aux données** :

### Les 5 priorités

1. **[Critique] Drizzle ORM n'est pas utilisé** pour les requêtes : ~500 requêtes
   raw `pool.query` avec le nom de schéma interpolé à la main (`"${schema}".table`).
   Le mécanisme de résolution tenant documenté (`getTenantDbForRequest`, `SET
   search_path`) est **du code mort**. La stack annonce Drizzle ; la réalité est du
   SQL brut partout.
2. **[Critique] ~16 instances `new Pool()` dispersées** (une par module) sans config
   de pool → jusqu'à ~160 connexions possibles vers un PostgreSQL souvent plafonné à
   100. Risque d'épuisement de connexions en production.
3. **[Majeur] DDL du schéma tenant éclatée sur 3 sources** non synchronisées :
   schéma Drizzle (`db/schema/tenant.ts`), `provisioning.ts` (50 `CREATE TABLE`),
   et `schema-migrations.ts` (98 `CREATE/ALTER` rejoués en `preHandler`). Source de
   dérive de schéma et de dette.
4. **[Majeur] Provisionnement de tenant sans transaction** : `CREATE SCHEMA` +
   ~50 `CREATE TABLE` + INSERT admin + INSERT rubriques s'exécutent en séquence non
   atomique → tenant à moitié créé en cas d'échec.
5. **[Majeur] Migrations lazy en `preHandler` sur chaque requête** : pattern coûteux
   et appliqué de façon incohérente (9 modules sur 23), avec un cache mémoire process
   qui ne survit pas aux redémarrages ni au multi-instance.

---

## 2. Multi-tenant

L'isolation logique est correcte **par construction** : chaque requête est cantonnée
au schéma du JWT, et le nom de schéma est systématiquement validé par
`assertValidSchemaName` / `isValidSchemaName` (whitelist `^[a-z][a-z0-9_]{0,62}$`)
avant toute interpolation — y compris au choke point central du plugin auth. Aucun
nom de schéma **codé en dur** dans le code applicatif des modules : il provient
toujours de `request.user.schemaName`. C'est une vraie force.

En revanche, la **stratégie technique diverge totalement de CLAUDE.md** :

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Critique | Tous les modules (`*.routes.ts`) | Le nom de schéma est interpolé manuellement dans ~500 requêtes (`FROM "${schema}".table`) au lieu de `SET search_path` (préconisé CLAUDE.md §Résolution du tenant pt.3) ou de Drizzle multi-schema. Chaque nouvelle requête est une occasion d'oublier la qualification → fuite cross-tenant. | Centraliser : soit un wrapper `tenantQuery(req, sql, params)` qui pose `SET search_path` sur une connexion dédiée, soit migrer vers Drizzle avec schéma dynamique. Interdire `pool.query` brut dans les modules via lint. |
| Critique | `db/client.ts:38-46`, `plugins/tenant.ts:5-9` | `getTenantDbForRequest` (résolution tenant Drizzle documentée) défini **deux fois** et **jamais appelé** pour des requêtes. Le plugin `tenant.ts` est un no-op (corps vide). Mécanisme officiel = code mort. | Supprimer le doublon, OU réellement router toutes les lectures/écritures via ce helper Drizzle. Trancher entre les deux paradigmes. |
| Mineur | `employees.routes.ts:5-6` | Imports `getTenantDbForRequest` et `createTenantSchema` présents mais inutilisés (vestiges de la tentative Drizzle). | Retirer les imports morts. |
| Mineur | `db/client.ts:53` | `setSearchPath` exécute `SET search_path` sur le **pool global** (connexion arbitraire), donc sans garantie que la requête suivante réutilise la même connexion. Fonction non appelée mais piège latent. | Supprimer ou ne l'utiliser que sur une connexion `pool.connect()` réservée. |

Risque de fuite cross-tenant **par construction** : faible aujourd'hui (qualification
explicite + validation stricte), mais la surface est énorme (500 sites manuels) et
fragile à toute future contribution.

---

## 3. RBAC

Le RBAC est **appliqué sur 100 % des routes** : les 255 routes des modules portent
toutes un `preHandler` `authorize(...)` ou `authenticate`. La fonction `authorize`
chaîne bien `verifyAndCheckBlacklist` puis le contrôle de rôle (`auth.ts:128-134`).
Côté frontend, les guards (`RoleGuard`, `PlatformGuard`, `EmployeeGuard`, `AgencyGuard`)
sont propres et cohérents.

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Majeur | `absences.routes.ts:75-80` (et patterns analogues employees, expenses) | Le filtre « équipe » du rôle `manager` n'est appliqué **que si** le manager est rattaché à une ligne `employees` via son email. Sinon le `WHERE manager_id` est silencieusement omis → le manager voit **toutes** les absences du tenant. RBAC-par-construction défaillant sur ce cas limite. | Si le manager n'a pas d'employeeId résolu, renvoyer un jeu vide (fail-closed) au lieu de ne pas filtrer. |
| Majeur | CLAUDE.md §Matrice vs code | Rôles `agency_owner`, `agency_member`, `raf_site` présents dans `authorize(...)` mais **absents de la matrice de permissions** documentée. La doc RBAC n'est plus la source de vérité. | Mettre à jour la matrice CLAUDE.md avec les rôles cabinet et RAF multi-sites, ou extraire la matrice dans une constante partagée testée. |
| Mineur | Modules (global) | Incohérence de style : `authorize('admin','hr_manager')` vs `authorize('admin', 'hr_manager')` (avec/sans espace), et combinaisons de rôles dupliquées 30+ fois à la main. | Définir des presets de rôles partagés (`ROLES.HR_WRITE`, `ROLES.HR_READ`…) pour éviter les divergences (ex. un module qui oublie `readonly`). |
| Mineur | `absences/employees/expenses` | Résolution de l'employeeId du user par lookup email répétée dans chaque handler self-service. | Factoriser `resolveEmployeeId(req)` (et idéalement le mettre dans le JWT au login, déjà partiellement présent via `employeeId`). |

---

## 4. TypeScript strict

Excellente conformité, parmi les points forts du projet.

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Mineur | `modules/referentiels/*` + `services/elasticsearch.ts` | 20 des 26 `any` de l'API sont concentrés ici (casts vers le client Elasticsearch et `req.query as any`). | Typer les requêtes ES via les types `@elastic/elasticsearch`, et valider `req.query` par Zod (`searchReferentiel(req.query as any)` → schéma Zod). |
| Mineur | `legal-articles.repository.ts:153-155` | `eq(legalArticles.source as any, …)` — casts pour contourner le typage des colonnes Drizzle. | Vérifier la déclaration de colonnes ; un cast `as any` sur une colonne Drizzle masque souvent un type de colonne mal déclaré. |
| Mineur | `recruitment-ai.service.ts:278` | `content: userContent as any` sur l'appel Anthropic. | Typer avec `MessageParam['content']` du SDK `@anthropic-ai/sdk`. |

Aucun `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` en source. 0 `any` côté web. 1 seul
TODO dans tout le code (et il est dans un test).

---

## 5. Gestion d'erreurs

Mature dans l'ensemble : error handler central (`app.ts:341`) avec mapping des codes
PG (23505→409, 23503→422, 23502→400, 22P02→400, 42P01/42703→500 masqué), gestion
ZodError→400, pas de stack en prod, log serveur systématique. Chaque handler critique
a son try/catch avec `fastify.log.error`. Codes HTTP bien différenciés (400×211,
404×105, 403×45, 409×33, 422×24, 201/202/410/413/423 utilisés à bon escient).

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Mineur | 45 `.catch(() => {})` / `.catch(() => undefined)` en source API | Majoritairement légitimes (audit_log best-effort, `pool.end()` de scripts, tables optionnelles). Mais quelques-uns avalent le **résultat utile** d'une requête (ex. `agency.routes.ts:542` `.catch(() => ({ rows: [] }))`) masquant une vraie erreur DB en « liste vide ». | Distinguer « best-effort » (OK silencieux) de « erreur masquée en donnée vide » (logguer au moins en `warn`). |
| Mineur | Handlers retournant `status(500)` génériques (114 sites) | Doublon avec l'error handler central : beaucoup de try/catch locaux ne font que `log + 500`, ce que ferait déjà `setErrorHandler`. | Laisser remonter les erreurs inattendues vers l'error handler central ; ne garder les try/catch locaux que là où un message métier précis est requis. Réduit le bruit et garantit un format d'erreur homogène. |

---

## 6. Cohérence & duplication

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Majeur | `db/schema/tenant.ts` + `db/provisioning.ts` (50 CREATE TABLE) + `utils/schema-migrations.ts` (98 CREATE/ALTER) | La structure du schéma tenant est définie en **3 endroits** non synchronisés. Le schéma Drizzle sert surtout de types ; `provisioning.ts` crée les tables à la création de tenant ; `schema-migrations.ts` rejoue 170+ `ALTER … ADD COLUMN IF NOT EXISTS` en `preHandler`. Une colonne ajoutée à un seul endroit dérive. | Faire de Drizzle + drizzle-kit la **source unique** des migrations. Générer le DDL de provisioning depuis le schéma. Retirer les ALTER lazy une fois la migration de base alignée. |
| Mineur | `payroll-engine-ci.ts:127` `evalFormule` | Évaluateur de formules basé sur `new Function()` **exporté mais jamais appelé** hors tests (le moteur calcule en dur). Code mort + risque latent (eval) si un jour branché sur `payroll_rules.formula`. | Soit le supprimer, soit le brancher réellement et remplacer `new Function()` par un parseur d'expression sûr (ex. arborescence d'opérateurs whitelistés sans eval). |
| Mineur | Lookup employeeId par email (cf. §3), agrégations CNPS | Logique de résolution répétée ; les bases CNPS (plafonds, taux) viennent bien d'une source unique (`legislation-packs.ts` / constantes) — **bon point**, pas de duplication des taux entre seed et routes. | RAS sur les taux ; factoriser les helpers répétés. |
| Mineur | `seed.ts`, `seed-demo.ts`, `seed-demo-data.ts`, `seed-pme-test.ts` | 4 seeds coexistent avec du recouvrement probable. | Documenter le rôle de chacun ou consolider. |

**Point fort notable** : la logique de paie (la plus critique) n'est PAS dupliquée —
seed et routes appellent le même `calculatePayrollCI`. C'est exactement ce qu'il faut.

---

## 7. Structure & couplage

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Critique | ~16 `new Pool()` (modules + services + scripts) | Chaque module instancie son propre pool sans `min/max` → ~10 connexions × 16 = ~160 potentielles, hors worker. Seul `db/client.ts` respecte `DATABASE_POOL_MAX`. Risque d'épuisement PG en prod. | Exporter le pool unique de `db/client.ts` et l'importer partout ; supprimer les `new Pool()` locaux. Gain immédiat de robustesse. |
| Majeur | Logique métier dans les handlers | La quasi-totalité de la logique (SQL, règles, workflow) vit dans les `*.routes.ts` (recruitment 78 Ko, settings 73 Ko, cnps 65 Ko). Peu de couche `service`. Testabilité et réutilisation réduites. | Extraire progressivement la logique en services (le module `referentiels` montre déjà le bon pattern routes/service/repository). |
| Mineur | `services/` riche (email, pdf, cnps, its-dgi, ai, mobile-money…) | Bonne séparation des intégrations externes. | RAS — à généraliser aux modules métier. |

Pas de dépendance circulaire évidente détectée à l'inspection (les services ne
réimportent pas les routes).

---

## 8. Frontend

Solide : axios centralisé (`lib/api.ts`) avec intercepteurs JWT + CSRF + gestion 401/503,
formatteurs FCFA/date partagés, guards propres, i18n exhaustif.

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Majeur | `pages/` (44/48 pages avec TanStack Query) | Très bonne adoption de `useQuery`/`useMutation`, mais les pages sont énormes (RecruitmentPage 184 Ko, SettingsPage 108 Ko). États loading/empty/error présents (575 occurrences `isLoading/isError/useState`) mais noyés dans des composants monolithiques. | Découper les grandes pages en sous-composants + hooks de données dédiés. |
| Mineur | i18n fr vs en | Quasi-parité (nav/common/dashboard/settings identiques) ; légers écarts payroll (fr 930 / en 938) et recruitment (1378/1380). | Ajouter un test de parité de clés fr↔en en CI pour éviter les clés manquantes silencieuses. |
| Mineur | `lib/api.ts:101` `formatFCFA` | `parseInt(amount)` sans base — OK ici mais fragile sur chaînes à zéros initiaux. | `parseInt(amount, 10)` ou `Number()`. |

---

## 9. Drizzle / SQL

| Sévérité | Emplacement | Constat | Recommandation |
|---|---|---|---|
| Critique | Global | Drizzle ORM utilisé pour ~2 requêtes réelles dans les modules ; tout le reste est du SQL brut paramétré. L'ORM mandaté par la stack est de fait absent de la couche requête. | Décision d'architecture à acter : assumer le SQL brut (et alors retirer Drizzle de la promesse + sécuriser via wrapper tenant unique) OU réinvestir dans Drizzle. L'état hybride actuel cumule les inconvénients des deux. |
| Majeur | `provisioning.ts:303+` | Provisionnement tenant multi-étapes **non transactionnel** (CREATE SCHEMA + tables + INSERTs séquentiels). Échec à mi-parcours = schéma incohérent. | Envelopper dans `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` (le DDL Postgres est transactionnel). |
| Majeur | Seules `legal-watch` et `recruitment` utilisent des transactions | Opérations multi-écritures (clôture paie en masse, campagnes Mobile Money, workflows) sans atomicité explicite. | Identifier les écritures multi-tables/multi-lignes et les passer en transaction. |
| Mineur | `schema-migrations.ts` en `preHandler` | Migrations rejouées par requête (cache `Set` mémoire process, perdu au restart, non partagé entre instances). Surcoût et incohérence (9/23 modules seulement). | Exécuter les migrations **une fois au démarrage** (ou via drizzle-kit en déploiement), pas par requête. |
| Mineur | Requêtes paramétrées | Bon usage de `$1,$2…` partout pour les **valeurs** (le seul vecteur d'injection résiduel est l'identifiant de schéma, déjà whitelisté). Index présents dans provisioning (`CREATE INDEX IF NOT EXISTS`). | RAS — bonne hygiène SQL sur les paramètres. |

---

## 10. Annexe — Métriques

| Métrique | Valeur |
|---|---|
| Fichiers source (hors tests, api+web+packages) | ~237 |
| LOC API (src, hors tests) | ~29 612 |
| LOC Web (src, hors tests) | ~24 184 |
| Fichiers de tests | 113 |
| Couverture annoncée | 99,9 % |
| Fixtures golden paie | 39 |
| Modules API | 22 |
| Routes API (modules) | 255 — toutes avec `authorize`/`authenticate` |
| `any` en source API (hors tests) | 26 (dont ~20 Elasticsearch/référentiels) |
| `any` en source Web | 0 |
| `@ts-ignore` / `@ts-nocheck` | 0 |
| TODO/FIXME en source | 0 (1 dans un test) |
| Instances `new Pool()` | ~16 (dont ~13 hors `db/client.ts`) |
| Requêtes raw `pool.query` (modules) | ~499 |
| Interpolations `"${schema}".` (modules) | ~515 |
| Appels Drizzle ORM (select/insert/update/delete, modules) | 2 |
| `CREATE TABLE` provisioning.ts | 50 |
| `CREATE/ALTER` schema-migrations.ts | 98 |
| `new Function()` / `eval` | 1 (`evalFormule`, code mort) |
| Namespaces i18n | 23 (fr + en) |
| Appels `t()` (pages) | ~3 063 |
| Codes HTTP distincts utilisés | 400/401/403/404/409/410/413/422/423/500/502/503 + 201/202 |
| Moteurs de paie | 1 (unifié, zéro duplication) |

---

_Audit en lecture seule — aucune modification de code effectuée. Recommandations
uniquement._
