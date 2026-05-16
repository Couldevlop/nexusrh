# NexusRH CI

**SIRH SaaS Multi-Tenant · Côte d'Ivoire**
_La RH Intelligente, au service de l'Afrique qui avance_

Développé par **OpenLab Consulting** · Cocody, Rivièra Faya Lauriers 8, Abidjan
Propulsé par **Claude AI** (Anthropic)

---

## Spécificités CI

| Conformité       | Détail                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| **CNPS 2024**    | Retraite 6,3% sal. / 7,7% pat. · PF 5,75% pat. · AT 2–5% selon secteur |
| **ITS / DGI**    | Barème progressif · abattement 15% · crédits famille                   |
| **SMIG**         | 75 000 FCFA / mois                                                     |
| **Congés**       | 2,5 jours ouvrables / mois travaillé (Code du Travail CI)              |
| **DISA**         | Génération automatique (loi 99-477)                                    |
| **e-CNPS**       | Export compatible plateforme e-CNPS · avant le 15/mois                 |
| **Mobile Money** | Wave · MTN MoMo · Orange Money CI · COFINA                             |
| **OHADA**        | Contrats conformes droit OHADA                                         |
| **FDFP**         | Module formation · contribution 0,4% masse salariale                   |
| **Hébergement**  | Option souverain CI (conformité ARTCI)                                 |

---

## Démarrage rapide

```bash
# 1. Infrastructure
docker-compose up -d postgres redis meilisearch minio

# 2. Variables d'environnement
cp .env.example .env
# Éditer .env : JWT_SECRET + ANTHROPIC_API_KEY

# 3. Dépendances + seed
pnpm install
pnpm --filter api run db:seed

# 4. Lancer
pnpm run dev
```

| Service       | URL                        |
| ------------- | -------------------------- |
| Frontend      | http://localhost:3001      |
| API + Swagger | http://localhost:4001/docs |
| MinIO         | http://localhost:9003      |

---

## Comptes de démo

> Tous les comptes ci-dessous sont créés par `pnpm --filter @nexusrhci/api run db:seed` (idempotent, DO UPDATE password_hash à chaque run).
> En cas de login 401 après un déploiement, voir [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) → procédure « Reset des passwords démo ».

### Super Admin (plateforme)

| Email                       | Mot de passe      | Rôle        | Redirige vers          |
| --------------------------- | ----------------- | ----------- | ---------------------- |
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` | super_admin | `/platform/dashboard`  |

### SOTRA — Société des Transports Abidjanais · thème orange `#E85D04`

| Email                | Mot de passe | Rôle       | Redirige vers   |
| -------------------- | ------------ | ---------- | --------------- |
| `admin@sotra.ci`     | `Admin1234!` | admin      | `/dashboard`    |
| `rh@sotra.ci`        | `Admin1234!` | hr_manager | `/dashboard`    |
| `manager@sotra.ci`   | `Admin1234!` | manager    | `/dashboard`    |
| `employe@sotra.ci`   | `Admin1234!` | employee   | `/mon-espace`   |

### Cabinet Expertise CI · thème bleu `#1D4ED8`

| Email                            | Mot de passe | Rôle     | Redirige vers |
| -------------------------------- | ------------ | -------- | ------------- |
| `admin@cabinet-expertise.ci`     | `Admin1234!` | admin    | `/dashboard`  |
| `employe2@cabinet-expertise.ci`  | `Admin1234!` | employee | `/mon-espace` |

### OpenLab Consulting · thème violet `#7C3AED`

| Email               | Mot de passe   | Rôle  | Redirige vers |
| ------------------- | -------------- | ----- | ------------- |
| `coulwao@gmail.com` | `Openlab1234!` | admin | `/dashboard`  |

> **Procédure de reset si login 401** :
> ```bash
> # Workflow GitHub Actions (recommandé)
> # → Actions → "Reset Demo Passwords — NexusRH CI" → Run workflow
> #   target: nexusrh-ci · mode: apply · confirmation: RESET
>
> # OU SQL direct (urgence)
> kubectl exec -i -n nexusrh-ci nexusrh-ci-postgres-postgresql-0 \
>   -- psql -U nexusrh -d nexusrh \
>   < nexusrh_ci/scripts/reset-admin-passwords.sql
> ```

---

## Mode sans echec

Mode maintenance — comportement attendu  
 Oui, le super_admin doit garder l'accès. Voici la logique correcte :  
 ┌────────────────────────────────┬──────────────────────┬─────────────────────────────────────────┐
│ Requête │ Mode maintenance OFF │ Mode maintenance ON │
├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
│ POST /auth/login │ ✅ │ ✅ (sinon plus personne ne peut entrer)│
├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
│ GET /platform/_ (super_admin) │ ✅ │ ✅ │
├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
│ GET/POST /api/_ (tous tenants) │ ✅ │ ❌ 503 │
├────────────────────────────────┼────────────────────── ┼─────────────────────────────────────────┤
│ Frontend tenants │ ✅ │ 🔴 Bannière "Maintenance" │
└────────────────────────────────┴──────────────────────-┴─────────────────────────────────────────┘

## Sécurisation de l'application depuis le kuster k8

lancer le scan: https://securityheaders.com/

ensuite en fonction des recommandations, chercher à corriger

-

## Contact

**OpenLab Consulting**
📍 Cocody, Rivièra Faya Lauriers 8, Abidjan
📧 infos@openlabconsulting.com
📱 +225 07 09 32 05 94
🌐 www.openlabconsulting.com

---

_NexusRH CI — Conforme Code du Travail ivoirien & CNPS 2024_
