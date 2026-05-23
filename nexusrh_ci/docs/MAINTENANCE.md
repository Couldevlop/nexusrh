# Maintenance — Opérations de rotation et récupération

> Documentation des opérations manuelles sensibles (reset passwords, re-seed, etc.).
> Toutes ces opérations sont **manuelles et explicites** — jamais automatiques sur un rollout.

---

## OWASP — Politique de gestion des credentials

| Principe | Application |
|---|---|
| **A02 Cryptographic Failures** | bcrypt 12 rounds pour tous les hashes |
| **A05 Security Misconfiguration** | Pas de password en clair dans les logs (URL masquée) |
| **A07 Authentication Failures** | Rotation manuelle, jamais déclenchée par un deploy |
| **A09 Security Logging** | Logs horodatés via GitHub Actions, traçables |

---

## Reset des passwords de comptes démo

### Architecture

Trois niveaux de contrôle :

1. **Script TS** (`apps/api/src/db/reset-admin-passwords.ts`)
   - Modes : `--health-check`, `--dry-run`, `apply` (défaut)
   - Refuse de tourner en `NODE_ENV=production` sans `FORCE_RESET_PROD=true`
   - Bcrypt 12 rounds (OWASP A02)
   - Idempotent

2. **Job K8s standalone** (`k8s/jobs/reset-admin-passwords-job.yaml`)
   - Lancé à la demande via `kubectl apply`
   - Pas de hook helm → **n'interagit jamais avec un rollout**

3. **Workflow GitHub Actions** (`.github/workflows/reset-demo-passwords.yml`)
   - `workflow_dispatch` uniquement (pas de trigger sur push)
   - Confirmation obligatoire pour mode `apply` (taper "RESET")
   - Environment GitHub avec reviewers (preprod / production)
   - Image pinnée au SHA du pod actuellement déployé (pas `latest`)
   - Logs horodatés + traçables

### Quand utiliser ?

| Situation | Mode recommandé |
|---|---|
| Vérifier que la DB est joignable depuis l'API | `health-check` |
| Vérifier la liste des comptes ciblés | `dry-run` |
| Login 401 sur les comptes démo après un changement | `apply` |
| Première install d'une nouvelle preprod | `apply` (après le seed initial) |

### Procédure recommandée : GitHub Actions (le plus sûr)

1. Ouvrir l'onglet **Actions** du repo
2. Sélectionner `Reset Demo Passwords — NexusRH CI`
3. Cliquer **Run workflow**
4. Choisir :
   - `target` : `nexusrh-ci` (preprod) ou `nexusrh-prod`
   - `mode` : commencer par `health-check`
5. Vérifier le succès, puis relancer en `apply` avec confirmation `RESET`
6. Consulter les logs dans l'onglet Actions

### Procédure alternative : kubectl direct (urgence)

```bash
# 1. Cleanup éventuels jobs zombies
kubectl delete jobs -n nexusrh-ci \
  -l app.kubernetes.io/component=maintenance \
  --field-selector status.successful!=1 \
  --ignore-not-found

# 2. Health-check (recommandé avant un reset)
kubectl apply -f nexusrh_ci/k8s/jobs/debug-reset-passwords.yaml
kubectl logs -n nexusrh-ci job/debug-reset-passwords --follow

# 3. Reset effectif (si health-check OK)
kubectl apply -f nexusrh_ci/k8s/jobs/reset-admin-passwords-job.yaml
kubectl logs -n nexusrh-ci job/nexusrh-reset-passwords --follow
```

### Procédure ultime : SQL direct (downtime)

Si tout le reste a échoué (API down, K8s pods en crashloop) :

```bash
kubectl exec -i -n nexusrh-ci nexusrh-ci-postgres-postgresql-0 \
  -- psql -U nexusrh -d nexusrh \
  < nexusrh_ci/scripts/reset-admin-passwords.sql
```

---

## Comptes démo (CLAUDE.md fait foi)

| Email | Password | Rôle |
|---|---|---|
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` | super_admin (plateforme) |
| `admin@sotra.ci` | `Admin1234!` | admin SOTRA |
| `rh@sotra.ci` | `Admin1234!` | hr_manager SOTRA |
| `manager@sotra.ci` | `Admin1234!` | manager SOTRA |
| `employe@sotra.ci` | `Admin1234!` | employee SOTRA |
| `admin@cabinet-expertise.ci` | `Admin1234!` | admin Cabinet Expertise CI |
| `employe2@cabinet-expertise.ci` | `Admin1234!` | employee Cabinet Expertise CI |
| `coulwao@gmail.com` | `Openlab1234!` | admin OpenLab Consulting |

---

## Pourquoi pas de hook helm automatique ?

Initialement, un hook `helm.sh/hook: post-upgrade` avait été ajouté pour relancer
le reset après chaque rollout. **Cette approche a été retirée** après 4 échecs
de déploiement (Jobs 76, 77, 79, …) qui ont bloqué tout le helm upgrade.

Raisons du retrait :

1. **Couplage trop fort** entre rollout et maintenance — un fail du reset
   empêchait tout le deploy.
2. **Mauvaise UX** : les équipes devaient diagnostiquer un hook K8s pour
   débloquer un simple deploy d'app.
3. **Sécurité** : un reset password ne devrait JAMAIS être automatique
   (OWASP A07). Une rotation doit être traçable, confirmée, et audité.
4. **Image latest mutable** : le hook tirait `:latest` qui pouvait être
   désynchronisé du rollout en cours.

La solution actuelle (workflow GitHub Actions + Job standalone + script
multi-mode) résout tous ces points.

---

## Re-seed complet de la base

Différent du reset passwords : recrée toutes les données démo (tenants, employés,
bulletins, etc.). À utiliser **uniquement sur une preprod fraîche**.

```bash
kubectl apply -f nexusrh_ci/k8s/jobs/seed-job-prod.yaml
kubectl logs -n nexusrh-ci job/nexusrh-seed --follow
```

Note : le seed est **idempotent** (DO UPDATE/DO NOTHING selon les tables) —
mais en production, ne pas le relancer sans backup DB préalable.

---

## Migration des schémas tenants (multi-pays & évolutions de schéma)

### Le problème de rollout

Au démarrage de l'API (`index.ts`), seul **`createPlatformSchema()`** tourne. Il
applique automatiquement, à chaque (re)déploiement, les évolutions du schéma
`platform` (ex. `tenants.has_subsidiaries`, `payroll_mode`, `default_country_code`).

En revanche, les évolutions du **schéma de chaque tenant** vivent dans
`provisionTenantSchema()`, qui n'est appelé qu'à la **création** d'un tenant (et,
depuis le correctif multi-pays, lors de l'activation `has_subsidiaries=true` via
le portail super_admin). **Conséquence : sur `nexusrh.openlabconsulting.com`, les
tenants déjà provisionnés ne reçoivent PAS automatiquement** :

- les colonnes workflow `pay_periods` (`parent_period_id`, états, `raf_user_id`…),
- `legal_entities.country_code` / `legislation_pack_code`, `employees.legal_entity_id`,
- la **bascule de clé d'unicité** `pay_periods` : `UNIQUE(month)` → index
  `(month, legal_entity_id) NULLS NOT DISTINCT` (indispensable au multi-filiales).

Un filet de sécurité « lazy » existe (`ensureTenantSchema`, exécuté au 1ᵉʳ accès
aux routes paie/CNPS/absences/employés), mais il **avale les erreurs
silencieusement** et dépend du trafic. Pour un rollout maîtrisé, on utilise le
Job de migration explicite ci-dessous.

### Le runner de migration

1. **Script TS** (`apps/api/src/db/migrate-tenants.ts`)
   - Lit la liste **réelle** des tenants dans `platform.tenants` (jamais en dur)
   - Applique `provisionTenantSchema()` à chacun (idempotent : `… IF NOT EXISTS`,
     `DROP CONSTRAINT IF EXISTS`)
   - **Purement structurel** — ne touche aucune donnée RH
   - Modes : `--dry-run` (liste sans appliquer) | défaut (applique)
   - **OWASP A09** : chaque tenant tracé (succès / échec + raison), aucune erreur
     avalée ; exit code ≠ 0 si un tenant échoue ⇒ Job K8s marqué `Failed`

2. **Job K8s standalone** (`k8s/jobs/migrate-tenants-job.yaml`)
   - `kubectl apply` à la demande — **aucun hook helm**, n'interagit jamais avec
     un rollout (même politique que le reset passwords, cf. plus bas)

### Procédure de déploiement (nexusrh.openlabconsulting.com)

```bash
# 0. (Recommandé) backup DB avant toute migration de schéma
#    kubectl exec -n nexusrh <postgres-pod> -- pg_dump -U nexusrh nexusrh > backup.sql

# 1. Déployer la nouvelle image API (le boot applique createPlatformSchema)
#    via le pipeline habituel / helm upgrade — l'image doit être :prod à jour

# 2. (Optionnel) prévisualiser les tenants ciblés, sans rien appliquer
kubectl delete job -n nexusrh nexusrh-migrate-tenants --ignore-not-found
# éditer migrated-at, puis :
kubectl apply -f nexusrh_ci/k8s/jobs/migrate-tenants-job.yaml
kubectl logs -n nexusrh job/nexusrh-migrate-tenants --follow

# 3. Vérifier la sortie : "<N> migré(s) · 0 échec(s)".
#    En cas d'échec, la cause la plus probable est un doublon (month) AVANT
#    bascule de clé — investiguer le tenant listé, dédupliquer, relancer (idempotent).
```

> Localement : `pnpm --filter @nexusrhci/api run db:migrate-tenants:dry-run`
> puis `pnpm --filter @nexusrhci/api run db:migrate-tenants`.
> Adapter le `namespace` selon l'environnement (`nexusrh` prod / `nexusrh-ci` preprod).

### Activer le multi-pays sur un tenant (après migration)

1. Portail super_admin → fiche tenant → bascule **Multi-pays**. Le `PATCH`
   (re)provisionne le schéma **avant** de basculer le flag (OWASP A04 — pas
   d'état `flag=true` avec colonnes manquantes), puis trace `tenant.subsidiaries_enabled`.
2. Créer les `legal_entities` (pays + pack + RAF) et rattacher les employés.
3. **Les utilisateurs du tenant doivent se reconnecter** : `hasSubsidiaries` est
   figé dans `tenantConfig` au login → c'est ce qui révèle la sidebar « Paie
   multi-pays », le sélecteur de filiale, etc.

---

## Veille réglementaire (legal-watch)

Module de détection automatique des mises à jour d'articles juridiques.
Architecture en 3 couches :

1. **Worker BullMQ** (`legal-watch` queue)
   - Fetch les sources configurées
   - Compare SHA-256 avec texte actuel
   - Insert proposition `pending` si changement

2. **API super_admin** (`/platform/legal-watch/*`)
   - `POST /analyze` : analyse Claude on-demand (super_admin colle texte)
   - `GET /proposals` : liste paginée
   - `POST /proposals/:id/approve` : transaction archive + update + checksum
   - `POST /proposals/:id/reject` : marque rejected

3. **UI** (`/platform/legal-watch`)
   - Diff viewer side-by-side ou unified
   - Notes de revue obligatoires en production recommandées

### Activation du cron worker

Par défaut **désactivé** (zéro fetch sortant). Pour activer :

```bash
# Variables d'env worker (ConfigMap nexusrh-config + Secret optionnel)
LEGAL_WATCH_ENABLED=true
LEGAL_WATCH_CRON="0 3 * * *"   # cron format, défaut 3h Africa/Abidjan
LEGAL_WATCH_SOURCES='[
  {
    "articleId": "ct_ci_art_36",
    "sourceUrl": "https://www.cnps.ci/article-36-cotisation",
    "source": "cnps",
    "countryCode": "CIV",
    "sourceType": "scraper"
  },
  ...
]'
```

### Sources officielles recommandées (catalogue)

Le catalogue complet est exposé via `GET /platform/legal-watch/sources-catalog`
(filtrable par `?country=CIV`). Voir aussi `apps/api/src/data/legal-sources-catalog.ts`.

**Priorité absolue aux sites gouvernementaux officiels** :

| Pays | Source clé | URL principale |
|---|---|---|
| 🇨🇮 Côte d'Ivoire | SGG (Journal Officiel) | https://www.sgg.gouv.ci/ |
| 🇨🇮 Côte d'Ivoire | DGI | https://www.dgi.gouv.ci/ |
| 🇨🇮 Côte d'Ivoire | CNPS | https://www.cnps.ci/ |
| 🇨🇮 Côte d'Ivoire | Ministère Travail | https://www.emploi.gouv.ci/ |
| 🇸🇳 Sénégal | JO | http://www.jo.gouv.sn/ |
| 🇸🇳 Sénégal | DGID | https://www.impotsetdomaines.gouv.sn/ |
| 🇸🇳 Sénégal | IPRES | https://www.ipres.sn/ |
| 🇸🇳 Sénégal | CSS | https://www.css.sn/ |
| 🇧🇯 Bénin | Min. Travail | https://travail.gouv.bj/ |
| 🇧🇯 Bénin | CNSS | https://www.cnss.bj/ |
| 🇹🇬 Togo | CNSS | https://www.cnss.tg/ |
| 🇧🇫 Burkina | CNSS | https://www.cnssbf.com/ |
| 🇲🇱 Mali | INPS | https://www.inps.ml/ |
| 🇳🇪 Niger | CNSS | https://www.cnss.ne/ |
| 🇨🇲 Cameroun | CNPS | https://www.cnps.cm/ |
| 🇨🇲 Cameroun | DGI | https://www.impots.cm/ |
| 🇹🇩 Tchad | CNPS | https://www.cnpstchad.org/ |
| 🇳🇬 Nigeria | NSITF | https://nsitf.gov.ng/ |
| 🇳🇬 Nigeria | FIRS | https://www.firs.gov.ng/ |
| 🇳🇬 Nigeria | PenCom | https://www.pencom.gov.ng/ |
| 🇬🇭 Ghana | SSNIT | https://ssnit.org.gh/ |
| 🇬🇭 Ghana | GRA | https://gra.gov.gh/ |

⚠️ **Ne jamais** scraper des agrégateurs tiers (Blog RH, Doctrine.fr, etc.) :
les sources officielles sont la SEULE source de vérité juridique.

### Audit OWASP

- **A02** : SHA-256 checksum stocké sur chaque version (`articles.checksum_sha256` + `articles_history`)
- **A04** : fetch limité à 1MB + timeout 30s (anti-DoS) ; `proposed_text` max 30k chars
- **A07** : `authorize('super_admin')` sur toutes les routes
- **A08** : transaction `approve` = archive + update atomique avec rollback
- **A09** : audit applicatif via `fastify.log.info` (actor, action, proposal_id, article_id, checksum)
- **A10 SSRF** : ⚠️ en production, configurer une allowlist d'URLs sources via reverse-proxy ou Network Policy K8s

### Backup / Restore DB

À documenter dans une PR ultérieure. Pour l'instant, utiliser `pg_dump` /
`pg_restore` standard via un Job kubectl.
