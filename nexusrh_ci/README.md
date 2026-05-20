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

## Qualité & non-régression

| Domaine | Couverture |
| ------- | ---------- |
| **Tests automatisés** | **473 tests verts** (Vitest) sur 14 fichiers — paie, recrutement, absences, contrats, employés, authentification, packs législatifs, référentiels, workflows |
| **Golden fixtures paie** | 9 cas type figés au franc CFA près (célibataire, marié + enfants, haut salaire, primes, congé maternité, maladie maintien 50%, AT avec jour J, heures supp, avance) |
| **Non-régression bloquante** | Toute modification du moteur `calculatePayrollCI` qui fait varier un montant déclenche un échec CI explicite |
| **Audit IA recrutement** | Chaque analyse de CV enregistre dans `audit_log` : utilisateur, modèle, score, signaux utilisés, note de risque démographique (OWASP A09) |
| **Audit de biais** | Le moteur IA expose les signaux concrets ayant influencé chaque score et alerte explicitement si un signal démographique (école, région, prénom, genre, âge estimé) a pesé — différenciant majeur sur le marché Afrique francophone |

```bash
# Lancer toute la suite
pnpm --filter @nexusrhci/api test

# Lancer uniquement les golden fixtures paie
pnpm --filter @nexusrhci/api run test:golden

# Approuver formellement une évolution réglementaire d'une fixture
pnpm --filter @nexusrhci/api run payroll:fixtures:approve <fixture-id> --reason "<motif réglementaire>"
```

> Les fixtures sont initialement des **snapshots** du comportement courant du moteur. Elles deviennent des **références légales** une fois validées par un expert paie ivoirien (date + nom + référence aux textes CNPS/DGI dans `metadata.validatedBy` et `metadata.changelog`).

### Conformité OWASP — couverture par module

| Module                    | A01 RBAC | A03 Inj./Validation | A07 Rate-limit | A09 Audit log                                            |
| ------------------------- | -------- | ------------------- | -------------- | -------------------------------------------------------- |
| **Recrutement**           | ✓        | ✓ + Zod + anti-prompt-injection | ✓ 3-10/min | `analyze_cv`, `preselect_batch`, `hired`, `rejected` |
| **Paie**                  | ✓        | ✓                   | ✓ 5/h export   | `payroll.closed`, `payroll.rejected`                     |
| **Workflow paie**         | ✓        | ✓                   | n/a            | (SoD vérifié `initiated_by ≠ approver`)                  |
| **Absences**              | ✓ + RBAC manager équipe directe | ✓ + Zod | n/a | `absence.created`, `absence.approved`/`approval_step`, `absence.rejected` |
| **Contrats**              | ✓        | ✓ + Zod (enum OHADA/CI, UUID, montants bornés) | n/a | `contract.created`, `contract.terminated`, `contract.deleted` |
| **Employés**              | ✓ + IDOR check sur PATCH self-service (employee ≠ son employeeId → 403) | ✓ + Zod (POST + PATCH .strict()) + UUID validation | n/a | `employee.created`, `employee.updated` (modifiedFields + bySelf), `employee.archived` (avec snapshot) |

> Les audit_log inserts sont systématiquement **non bloquants** (`.catch(() => {})`) pour ne pas casser le service principal sur les tenants en cours de migration.

---

## Recrutement IA — pré-sélection en lot

Le module recrutement combine l'analyse Claude/Mistral à un workflow Kanban pour pré-sélectionner les candidatures à l'échelle d'une offre.

| Étape | Comportement |
| ----- | ------------ |
| Saisie des priorités | Champ "Critères du recruteur" en langage naturel (ex : *« Privilégier SAP + anglais courant, pénaliser changements fréquents < 1 an »*) — persisté par offre dans `recruitment_jobs.ai_focus_text` |
| Pré-sélection batch | `POST /recruitment/jobs/:id/preselect` — analyse séquentielle des candidatures nouvelles (cap 50, rate-limit 3/min, RBAC admin/hr_manager/hr_officer) |
| Top 10 | Retour classé par score décroissant, refresh automatique des cartes Kanban avec les scores IA |
| Comparaison side-by-side | Vue 3 colonnes des candidats : forces / manques / alertes / signaux utilisés par l'IA |
| Comparaison libre N candidats | Cases à cocher sur les cartes Kanban + barre flottante "Comparer (N)" — l'utilisateur sélectionne qui il veut, au-delà du top automatique |
| Audit de biais | Bannière visible si l'IA reconnaît avoir pondéré le score à cause d'un signal démographique |
| **Feedback loop IA** | À chaque embauche ou rejet, le tenant alimente automatiquement un historique (`recruitment_decisions`). Les 8 dernières décisions sont injectées dans le prompt de la pré-sélection suivante en **few-shot examples** — l'IA apprend les préférences réelles de l'équipe sans aucune ré-entraînement ML. Visible dans le UI : *« Apprentissage actif : 23 décisions passées ont calibré ce scoring »* |
| **Historique d'apprentissage** | Endpoint `GET /recruitment/jobs/:id/decisions-history` + panneau UI dépliable « Historique apprentissage » sur le pipeline Kanban — compteurs ✓ recrutés / ✗ rejetés + timeline des décisions avec score IA prior. Transparence totale sur ce qui calibre le scoring |
| **CV viewer intégré** | Upload binaire (PDF/DOC/DOCX/TXT, MIME en allowlist, max 10 Mo) stocké en `applications.cv_blob`. Endpoint `GET /recruitment/applications/:id/cv-file` stream avec `X-Content-Type-Options: nosniff` + `Content-Disposition: inline`. Modal détail candidat affiche un **iframe PDF** (ou image) au lieu du texte brut, avec bouton Télécharger |
| **Extraction CV hybride** | À l'upload, extraction texte native via **unpdf** (PDF.js de Mozilla, sans dépendance binaire, free). À l'analyse IA, si le texte est satisfaisant (≥ 200 chars + ratio printable ≥ 70%) → mode texte cheap. Sinon (PDF scanné, layout complexe, OCR raté) → bascule automatique vers **Claude Vision** en mode `document` (le PDF binaire est envoyé directement, lecture native multi-page). Coût optimisé : 80% des CVs restent en mode texte (~$0.003), seuls les scans déclenchent le mode document. Mode renvoyé dans `ingestionMode: 'text' \| 'pdf-document'` |
| Traçabilité | Audit log `recruitment.preselect_batch` (modèle, stages, focus effectif, comptes analysés/skip/fail, `learningExamples`) |

**Sécurité (OWASP 2025)** :
- **A01** RBAC strict (admin/hr_manager/hr_officer), isolation tenant via schema-per-tenant
- **A03** SQL : tous paramètres bindés (`$1, $2, …`), nom de schéma issu du JWT uniquement / **Prompt injection** : sanitization des `candidate_anchor` (suppression \n\t, troncature 220 chars) + délimiteurs `=== DEBUT/FIN DECISIONS ===` + instruction explicite à l'IA de traiter ce bloc comme des données factuelles, jamais comme des consignes
- **A05** clés IA via env, swagger désactivé en prod, migrations lazy idempotentes
- **A07** rate-limit anti-abus IA (3/min pré-sélection lot, 10/min analyse unitaire), MFA TOTP disponible
- **A09** audit log dédié pour chaque hire/reject (`recruitment.hired` / `recruitment.rejected`) + pour chaque batch (`recruitment.preselect_batch`) + traçabilité IA (`recruitment.analyze_cv`). Tous non bloquants
- **A10** messages d'erreur génériques côté client, détails uniquement dans les logs serveur

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
