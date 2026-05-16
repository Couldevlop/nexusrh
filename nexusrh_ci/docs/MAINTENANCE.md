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

## Backup / Restore DB

À documenter dans une PR ultérieure. Pour l'instant, utiliser `pg_dump` /
`pg_restore` standard via un Job kubectl.
