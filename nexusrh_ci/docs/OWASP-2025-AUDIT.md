# Audit OWASP Top 10 — Version 2025

> Périmètre : commits récents NexusRH CI couvrant recrutement multi-source IA,
> packs législatifs multi-pays UEMOA+, workflow paie centralisé draft→site→central,
> règles de congés par pays, référentiel juridique multi-pays.
>
> Référence : [OWASP Top 10:2025](https://owasp.org/Top10/2025/)
> Date de l'audit : mai 2026

## Résumé

| Catégorie | Statut | Patches appliqués |
|-----------|--------|-------------------|
| A01:2025 Broken Access Control (+SSRF) | ✅ Conforme | RBAC strict, scoping tenant via JWT |
| A02:2025 Security Misconfiguration | ⚠️→✅ Conforme | Rate limit dédié `/analyze-cv` (10/min) |
| A03:2025 Software Supply Chain Failures | ⚠️ Acceptable | Limitations documentées |
| A04:2025 Cryptographic Failures | ✅ Conforme | Clés en env, bcrypt hash existant |
| A05:2025 Injection | ✅ Conforme | Paramètres SQL, validation Zod |
| A06:2025 Insecure Design | ✅ Conforme | Refus packs stub, transitions état strictes |
| A07:2025 Identification & Auth | ✅ Conforme | JWT existant, scoping `raf_site` |
| A08:2025 Software & Data Integrity | ✅ Conforme | Normalisation LLM, clamp, enum |
| A09:2025 Logging & Alerting | ⚠️→✅ Conforme | Audit log ajouté workflow + analyze-cv |
| A10:2025 Mishandling Exceptional Conditions | ⚠️→✅ Conforme | Messages erreurs sanitizés |

3 patches appliqués au cours de l'audit. Aucune vulnérabilité critique restante.

---

## A01:2025 — Broken Access Control (inclut SSRF)

**Risque évalué** : un utilisateur peut accéder à des ressources hors de son
périmètre (autre tenant, autre filiale, autre RAF).

**Mesures en place** :
- Chaque route applicative passe par `fastify.authorize(...roles)` (plugin
  `auth.ts`). Le rôle vient du JWT, vérifié à chaque requête.
- Toutes les requêtes SQL utilisent `"${request.user.schemaName}".table` où
  `schemaName` est issu du **JWT signé**, jamais d'un paramètre utilisateur.
- `/internal-jobs` filtre côté SQL sur `department/category/seniority/legal_entity`
  de l'employé connecté. Pas de risque de voir les offres d'un autre.
- `/internal-jobs/:id/apply` refuse les doublons par `(job_id, internal_employee_id)`.
- Workflow paie : un `raf_site` ne peut soumettre qu'une période dont
  `raf_user_id === jwt.sub` (vérifié explicitement avant le UPDATE).
- Page carrières publique : seules les offres `status='open' AND visibility IN ('external','both')`
  remontent. Les offres internes ne fuitent jamais.

- **Cabinet de recrutement** : un utilisateur de cabinet n'accède à un tenant
  client que via un **point de contrôle unique** (`assertAgencyCanActOnTenant` :
  membre ∈ cabinet ∧ tenant rattaché actif ∧ tenant CI ∧ schéma valide), qui
  émet un **token scopé TTL 30 min** (re-validé au refresh). Les endpoints owner
  sont scopés à l'`agencyId` **du token**, jamais du body.
- **Cloisonnement contexte-plateforme** : un acteur `schemaName='platform'`
  (super_admin / cabinet hors session) atteignant une route tenant reçoit
  **403** (garde central dans `app.ts`) — fin des 500 par requête sur
  `platform.<table_tenant>`. Golden : `platform-context-guard.golden.test.ts`.

**SSRF (depuis l'ajout de la Connectivité)** : NexusRH effectue désormais des
appels **sortants** pilotés par la configuration tenant (webhooks, connecteurs
REST). Ils sont protégés par un **garde anti-SSRF** (`services/ssrf-guard.ts`) :
http(s) uniquement, pas d'identifiants dans l'URL, **blocage des IP privées /
loopback / link-local / metadata** (169.254.169.254…) après **résolution DNS**,
et `redirect: 'error'` (aucun suivi de redirection — anti DNS-rebinding). Le
service IA, lui, parle toujours à des endpoints fixés en config.

**Conclusion** : conforme.

---

## A02:2025 — Security Misconfiguration

**Risque évalué** : config manquante (rate limit, headers sécurité,
limites upload) facilitant DoS / cost abuse.

**Mesures existantes** :
- Rate limit global : 200 req/min/IP (`app.ts`)
- Headers sécurité (X-Content-Type-Options, HSTS, etc.) via `onSend` hook
- Multipart limite 10 MB

**🔧 Patch appliqué** : rate limit dédié sur `POST /recruitment/applications/:id/analyze-cv`
à **10 req/min/IP**. Justification : un appel IA coûte $0.01–0.05 chez
Anthropic. Sans limit, un attaquant disposant d'un compte HR peut saigner
le quota / la facture en quelques minutes.

```typescript
fastify.post('/applications/:id/analyze-cv', {
  preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  ...
})
```

**Reste à faire (non critique)** : rate limit sur `POST /platform/tenants` (3/min)
pour éviter spam de création tenants par super_admin compromis.

---

## A03:2025 — Software Supply Chain Failures

**Risque évalué** : nouvelle dépendance Mistral via `fetch` direct. Pas de
SDK officiel installé.

**Mesures** :
- `@anthropic-ai/sdk` est verrouillé en `package.json` (déjà existant)
- Mistral utilise `fetch` standard, donc TLS + validation cert Node
- Pas de packages npm ajoutés (réutilisation deps existantes)
- Le service IA `recruitment-ai.service.ts` est isolé : si l'API Mistral
  change ou disparaît, seul ce module est impacté

**Limitations honnêtes** :
- Pas de pinning par hash des réponses LLM. Mais ces réponses sont
  **toujours** normalisées (clamp, enum, filtrage string) avant persistance
  (cf. A08).
- Les packs législatifs UEMOA/Tchad/Nigeria sont des fichiers TypeScript
  versionnés dans le repo, pas des données externes téléchargées. Le
  risque chaîne d'approvisionnement est donc nul pour eux.

**Conclusion** : acceptable. Une revue trimestrielle des dépendances
(`pnpm audit`) reste recommandée.

---

## A04:2025 — Cryptographic Failures

**Risque évalué** : secrets en clair, hash faibles, données sensibles non
chiffrées.

**Mesures** :
- Mots de passe : `bcrypt` rounds=12 (`seed.ts`, `platform.routes.ts`)
- JWT signé avec `JWT_SECRET` 32+ chars (validé en config.ts via Zod)
- Clés API (`ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`) en variables d'env, jamais dans le code
- Tests vérifient que `config.ts` rejette un JWT_SECRET trop court

**Aucune donnée RH sensible ajoutée en clair** dans les commits récents.
Les `cv_text` stockés en `text` (PostgreSQL) — c'est acceptable pour un CV
volontairement partagé par le candidat, et reste protégé par le schéma
tenant isolé.

**Conclusion** : conforme.

---

## A05:2025 — Injection

**Risque évalué** : SQL injection via concat, XSS via réponse JSON.

**Mesures** :
- 100 % des requêtes utilisent des **paramètres préparés** (`$1, $2…`).
  Vérifié manuellement sur les 4 nouveaux fichiers de routes
  (`recruitment`, `payroll-workflow`, `referentiels` ajouts, `platform` ajouts).
- Le seul élément concaténé est `"${schemaName}"` — mais `schemaName` est
  une valeur **interne du JWT signé**, jamais un input utilisateur.
- Validation Zod côté API sur les querystrings (`/referentiels/search`
  avec regex `[A-Z]{3}` pour countryCode).
- Frontend : React échappe les chaînes par défaut. Pas de `dangerouslySetInnerHTML`
  introduit.

**Conclusion** : conforme.

---

## A06:2025 — Insecure Design

**Risque évalué** : workflow autorise des actions illogiques (clôturer
une période non validée, calculer sur un pack non fiable…).

**Mesures de design défensif** :
- Le moteur de paie **refuse** explicitement de calculer sur un pack
  `status: 'stub'` → throw avec message clair. C'est documenté dans
  `legislation-packs.ts`.
- Workflow paie : chaque transition vérifie l'état précédent (409 si
  statut incompatible). Pas de saut d'état.
- `validate-central` exige que **toutes** les filiales soient en
  `completed_by_site` (sinon 409). Empêche les clôtures partielles.
- Recruitment : `/internal-jobs/:id/apply` empêche le double-postulation.

**Conclusion** : conforme.

---

## A07:2025 — Identification and Authentication Failures

**Risque évalué** : nouveau rôle `raf_site` mal scoped.

**Mesures** :
- Le rôle `raf_site` n'est accepté que sur 2 routes explicites :
  `/payroll-workflow/periods/:id/submit-by-raf` et `GET /payroll-workflow/periods`.
- Sur `submit-by-raf`, vérification supplémentaire `period.raf_user_id === jwt.sub`.
  Un `raf_site` qui aurait un JWT valide ne peut pas soumettre la
  période d'un autre site.
- Routes recrutement ne mentionnent pas `raf_site` → 403 par défaut.

**Reste à faire** : pas de création UI pour le rôle `raf_site`
(création manuelle SQL pour l'instant). À implémenter dans
`PlatformTenantUsers` lorsque le palier 3 sera élargi.

**Conclusion** : conforme. Le rôle est conservatorialement non-exposé
par défaut.

---

## A08:2025 — Software and Data Integrity Failures

**Risque évalué** : la réponse LLM (Claude/Mistral) est une donnée externe
non-fiable utilisée directement dans le système.

**Mesures** :
- `recruitment-ai.service.ts` parse le JSON LLM avec extraction tolérante
  aux balises markdown, puis normalise via `normalize()` :
  - `score` et `matchPercentage` clampés à [0, 100]
  - `recommendation` forcé dans l'enum `strong_yes|yes|maybe|no`
    (toute autre valeur → `maybe`)
  - `strengths/gaps/redFlags/interviewQuestions` filtrés sur `typeof === 'string'`
    et limités à 10 entrées
  - `summary` typé string, fallback vide
- Aucun `eval()`, `Function()` ou JSON injection possible sur la donnée IA.
- Le moteur de paie (legacy CI) utilise déjà un `safeEval` whitelist sur
  les formules — pas touché par les commits récents.

**Conclusion** : conforme.

---

## A09:2025 — Security Logging and Alerting Failures

**Risque évalué** : pas de trace pour les actions critiques (analyse IA,
transitions workflow paie, accès référentiel restreint).

**Mesures existantes** : `tenant.audit_log` (user_id, action, entity, entity_id, changes, ip, ua).

**🔧 Patchs appliqués** :
- `POST /recruitment/applications/:id/analyze-cv` insère désormais dans
  `audit_log` (action `recruitment.analyze_cv`) avec model utilisé + score.
- Chaque transition workflow paie (`workflow.send_to_sites`,
  `workflow.submit_by_raf`, `workflow.validate_central`, `workflow.close`)
  insère un audit log avec userId + IP + payload résumé.
- Tous les inserts audit sont **non-bloquants** (catch silencieux) pour
  ne pas casser le métier si la table audit_log n'existe pas encore
  (tenants pré-migration).

**Reste à faire (non critique)** : forwarder l'audit_log vers un SIEM
externe (Loki/CloudWatch) pour rétention long-terme. À planifier en
ops.

---

## A10:2025 — Mishandling of Exceptional Conditions (NOUVEAU 2025)

**Risque évalué** : messages d'erreur leakant détails internes ; failing
open sur exceptions ; race conditions sur transitions d'état.

**🔧 Patch appliqué** : `analyze-cv` ne retourne plus le message brut de
l'exception au client. La logique :

```typescript
const isUserActionable = /CV trop court|configurée|inconnu|stub/i.test(raw)
return reply.status(500).send({
  error: isUserActionable ? raw : 'Erreur lors de l\'analyse IA. Réessayez plus tard.',
})
```

Seuls les messages **utiles à l'utilisateur** sont remontés (CV manquant,
clé non configurée, pack stub). Tout le reste devient un message
générique safe ; le détail va dans `fastify.log.error`.

**Failing open vérifié** :
- Migration lazy `ensureRecruitmentSchemaMigrated` ne fait que des
  `ADD COLUMN IF NOT EXISTS` — idempotent et sûr.
- Audit log : si insert échoue, on log côté serveur mais on **ne casse pas**
  l'action métier (catch silencieux explicite).
- Service IA : si la clé est manquante, throw clair avec instruction de
  config — pas de fallback vers une donnée vide silencieuse.

**Race conditions transitions paie** : pour l'instant `SELECT status → UPDATE`
n'est pas en transaction. Pour un MVP c'est acceptable, mais à terme il
faut wrapper en transaction `BEGIN ... COMMIT` ou ajouter un check
`WHERE status = 'expected'` dans le UPDATE pour rendre l'opération
atomique. **À planifier dans un sprint d'hygiène.**

---

## Recommandations pour les prochains sprints

1. **Transactions DB** pour les transitions workflow paie (atomicité).
2. **UI création rôle `raf_site`** dans le portail super_admin.
3. **Audit log forwarding** vers SIEM (Loki / CloudWatch / Elasticsearch).
4. **Tests E2E Playwright** : installer @playwright/test pour activer
   `apps/web/tests/e2e/referentiel-country-selector.spec.ts`.
5. **`pnpm audit` automatisé** dans CI/CD (déjà ?) — à vérifier.
6. **Validation signature LLM** (HMAC sur les réponses) si offert par
   Anthropic/Mistral à l'avenir.

---

---

## Addendum — modules récents (cabinet de recrutement & connectivité)

### Cabinet de recrutement (acteur multi-tenant)
- **A01** : point de contrôle unique `assertAgencyCanActOnTenant` (membre ∈ cabinet
  ∧ tenant rattaché ∧ actif ∧ **CI** ∧ schéma valide) ; token scopé **TTL 30 min**
  re-validé au refresh ; CRUD cabinets réservé super_admin ; endpoints owner
  scopés à l'`agencyId` du token. Golden d'isolation : un cabinet scopé sur le
  tenant A ne peut pas activer/atteindre le tenant B.
- **A04** : mots de passe owner/membres bcrypt(12) ; secrets jamais en clair.
- **A07** : login cabinet réutilise lockout + MFA + rate-limit ; révocation
  immédiate (blacklist des `sub`) à la suspension d'un cabinet.
- **A09** : `agency.session.activated` (on-behalf), `agency.activate.denied`,
  CRUD/attach/detach/suspend, `agency.client_tenant.created`.
- **Garde-fou CI** : rattachement/onboarding refusés (422) hors Côte d'Ivoire.

### Connectivité (webhooks / clés API / connecteurs)
- **A01** : CRUD admin tenant only ; API publique `/integrations/v1/*` par **clé
  API à scopes** (`employees:read`…), scope insuffisant → 403.
- **A02 (chiffrement)** : secrets de connecteurs **AES-256** ; clés API **hachées
  SHA-256** (jamais stockées en clair, préfixe non secret) ; webhooks **signés
  HMAC SHA-256** (en-têtes NexusRH non écrasables par la config).
- **A05 (injection)** : Zod strict, whitelist d'événements et de scopes.
- **A09** : `integration.webhook/apikey/connector.*`.
- **A10 (SSRF)** : garde sur tout appel sortant (IP privées/loopback/metadata
  bloquées, DNS résolu, pas de suivi de redirection) — voir A01 ci-dessus.

### Sourcing IA — pays imposé serveur
- **A01** : `resolveSourcingCountries` force le pays du tenant pour un tenant
  mono-pays (le `countries` du client est ignoré) ; multi-pays = sélection
  validée. Empêche un tenant mono-pays de sourcer hors de son pays.

---

_Audit réalisé manuellement, fichier par fichier, contre les
définitions officielles OWASP Top 10:2025. Source :
https://owasp.org/Top10/2025/_
