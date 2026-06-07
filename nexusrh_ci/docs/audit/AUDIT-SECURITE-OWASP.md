# Audit de sécurité OWASP Top 10 (2021) — NexusRH CI

> Audit défensif **en lecture seule** du SIRH SaaS multi-tenant NexusRH CI.
> Aucune modification de code. Catégorie par catégorie A01→A10, avec sévérité,
> emplacement `fichier:ligne`, scénario d'exploitation et recommandation.
> Date : 2026-06-07 · Périmètre : `apps/api` (Fastify 4), `apps/web` (React 18).

---

## 1. Résumé exécutif

### Posture globale : **BONNE** (mature, durcissement OWASP visible et cohérent)

Le projet présente une **posture de sécurité nettement supérieure à la moyenne**
pour un SIRH. Les contrôles structurants sont en place et bien pensés :

- **Isolation multi-tenant solide** : validation centralisée du nom de schéma
  (`isValidSchemaName`, regex stricte) appliquée au choke point d'authentification
  ET à chaque point d'interpolation SQL d'identifiant.
- **Toutes les valeurs SQL sont paramétrées** (`$1`, `$2`...) — aucune
  interpolation de valeur utilisateur dans les requêtes échantillonnées. Seuls les
  **noms de schéma** sont interpolés, et systématiquement après whitelist.
- **Authentification robuste** : bcrypt 12 rounds, dummy-hash anti-timing,
  verrouillage de compte (Redis), rate-limit login 10/5min, anti-énumération,
  MFA TOTP avec backup codes hachés bcrypt, breach-check HIBP, historique mdp,
  expiration mdp.
- **A04/SoD exemplaire** : workflow de clôture de paie « 2 yeux » (l'initiateur
  ne peut pas auto-valider), bornes anti-fraude Mobile Money, idempotence webhooks.
- **A10/SSRF** : garde dédiée (`ssrf-guard.ts`) avec résolution DNS, blocage
  IP privées/loopback/link-local/metadata/CGNAT, `redirect: 'error'`, re-validation
  à chaque envoi (anti DNS-rebinding).
- **A05** : en-têtes de sécurité complets (CSP, HSTS, X-Frame-Options, COOP/CORP,
  Permissions-Policy), CORS allowlist, error handler sans stacktrace en prod,
  `Cache-Control: no-store` sur les réponses PDF/CSV sensibles.
- **A09** : audit_log non bloquant sur quasiment toutes les actions sensibles
  (auth, paie, employés, Mobile Money, IA, plateforme).

### Top vulnérabilités (par sévérité)

| # | Sévérité | Cat. | Constat |
|---|----------|------|---------|
| 1 | **Élevé** | A01 (IDOR) | `POST /absences` — un `employee` peut créer une absence pour un AUTRE employé via `body.employeeId` (aucun forçage self, contrairement aux expenses). |
| 2 | **Moyen** | A01 (IDOR) | `GET /employees/:id` — un `manager` peut lire le dossier complet (salaire, NNI/IBAN déchiffrés) de N'IMPORTE quel employé du tenant, pas seulement de son équipe. |
| 3 | **Moyen** | A05 | Swagger UI exposé sur `/docs` sans authentification ni restriction d'environnement (divulgation de la surface d'API en production). |
| 4 | **Moyen** | A07 | MFA TOTP sans anti-rejeu : un code à 6 chiffres valide est rejouable dans sa fenêtre (~30-60s). Les backup codes, eux, sont bien à usage unique. |
| 5 | **Moyen** | A02/A05 | `.env.example` livre un `JWT_SECRET` faible par défaut et un `ENCRYPTION_KEY` tout-à-zéro ; `ENCRYPTION_KEY` est `optional()` → l'app démarre sans clé et le chiffrement NNI/IBAN échoue au runtime au lieu d'échouer au boot. |

---

## 2. A01 — Broken Access Control

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| **Élevé** | `apps/api/src/modules/absences/absences.routes.ts:153-178` | `POST /absences` accepte `body.employeeId` et l'utilise directement (`let employeeId = body.employeeId ?? request.user.employeeId`). Aucun garde-fou ne restreint un `employee` à son propre `employeeId` (contrairement à `expenses.routes.ts:188` qui force le self). | Un salarié connecté (role `employee`) envoie `POST /absences` avec l'UUID d'un collègue → crée/consomme un solde d'absence au nom d'autrui ; pollue les soldes et le workflow d'approbation. | Si `role === 'employee'`, ignorer `body.employeeId` et forcer `request.user.employeeId` (aligner sur le pattern des notes de frais). |
| **Moyen** | `apps/api/src/modules/employees/employees.routes.ts:144-173` | `GET /employees/:id` : le seul garde-fou est `role === 'employee'` (limité à son propre email). Le `manager` (autorisé ligne 145) n'est PAS restreint à son équipe et peut lire tout dossier, NNI/IBAN **déchiffrés** inclus (lignes 170-171). | Un manager énumère les UUID employés et exfiltre salaires + NNI + IBAN de toute l'entreprise — au-delà de la matrice RBAC (manager = R sur son équipe seulement). | Pour `role === 'manager'`, vérifier `employees.manager_id = <empId du manager>` avant de renvoyer le dossier ; ne déchiffrer NNI/IBAN que pour les rôles RH. |
| Moyen | `apps/api/src/modules/employees/employees.routes.ts:106-141` | `GET /employees` filtre bien l'équipe pour `manager`, mais le filtre `departmentId`/`search` n'est pas restreint : pour un manager le `manager_id` est ANDé, donc OK. À surveiller si la liste expose des champs sensibles non masqués. | Faible directement (filtré), mais le payload `e.*` peut inclure NNI/IBAN chiffrés bruts. | Projeter explicitement les colonnes, exclure `nni`/`iban` des listes. |
| Faible | `apps/api/src/modules/absences/absences.routes.ts:57-85` | `GET /absences` accepte `employeeId` en query sans restriction pour les rôles RH (attendu par la matrice). Le `manager` est bien borné par `manager_id`. | N/A (conforme RBAC). | RAS — bonne pratique. |

**Bonnes pratiques constatées (A01) :**
- IDOR **bien géré** sur `my-payslips`, `my-absences`, `my-expenses`,
  `payslips/:id/transparency` (garde `employee` → son propre `employeeId`).
- `PATCH /employees/:id` : un `employee` ne peut modifier que SON profil
  (`employeeId !== id → 403`) ET seulement une whitelist de champs (`EMPLOYEE_SELF_FIELDS`).
- Approbation absences/frais : `manager` borné à son équipe directe
  (`managerCanActOnAbsence`, `managerCanActOnReport`) + auto-approbation interdite.
- **Cloisonnement super_admin / cabinet** (`app.ts:196-210`) : un contexte
  `schemaName='platform'` est refusé (403) sur toute route tenant.
- **Sessions cabinet on-behalf** re-validées à chaque `/auth/refresh`
  (`auth.routes.ts:647-662`, `assertAgencyCanActOnTenant`), TTL court 30 min.
- Le `role` provient toujours du **JWT signé**, jamais du body — pas d'élévation
  de privilège côté client.

---

## 3. A02 — Cryptographic Failures

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| **Moyen** | `apps/api/src/config.ts:20` + `.env.example:31` | `ENCRYPTION_KEY` est `z.string().length(64).optional()`. L'app démarre **sans** clé ; `utils/crypto.ts:7` lève alors une erreur seulement au premier chiffrement (création employé avec NNI/IBAN). De plus `.env.example` propose `ENCRYPTION_KEY=0000…0000`. | Déploiement sans clé → erreurs 500 runtime ; ou déploiement avec la clé d'exemple tout-à-zéro → chiffrement AES trivialement réversible par quiconque connaît l'exemple. | Rendre `ENCRYPTION_KEY` **obligatoire** (non-optional) en production ; refuser le démarrage si absente. Ne jamais committer une clé d'exemple « valide » (mettre un placeholder évident non hex/longueur ≠ 64). |
| Moyen | `.env.example:29` | `JWT_SECRET=nexusrh-ci-super-secret-key-minimum-32-chars!!` est un secret faible/public par défaut. | Si déployé tel quel, un attaquant forge des JWT arbitraires (n'importe quel `role`/`schemaName`) → compromission totale multi-tenant. | Générer le secret au déploiement (≥ 256 bits aléatoires) ; documenter clairement « À REMPLACER ». Envisager un check de boot rejetant la valeur d'exemple. |
| Faible | `apps/api/src/modules/auth/auth.routes.ts:33` (`authCookieOptions`) | Cookie de session `secure` activé uniquement si `NODE_ENV==='production'` ; `sameSite:'lax'`. Correct, mais `lax` laisse passer les navigations GET top-level (acceptable car mutations protégées par CSRF). | Faible. | RAS ; envisager `sameSite:'strict'` pour le cookie d'auth si l'UX le permet. |

**Bonnes pratiques constatées (A02) :**
- **AES-256-GCM** authentifié (IV aléatoire 12 octets + tag) pour NNI/IBAN
  (`utils/crypto.ts`). Format `iv:tag:ciphertext`.
- **bcrypt 12 rounds** partout (login, change-password, reset, backup codes MFA).
- **Dummy bcrypt hash** anti-timing quand l'email est inconnu (`auth.routes.ts:51,378`).
- Cookie JWT **httpOnly** (anti-XSS exfiltration) + `secure` en prod.
- **CSRF double-submit** (token JWT `aud:'csrf'` vérifié `app.ts:150-187`) sur
  les mutations cookie-authentifiées.
- HMAC SHA-256 **timing-safe** pour webhooks Mobile Money et webhooks sortants.

---

## 4. A03 — Injection

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| Faible | `apps/api/src/services/payroll-engine-ci.ts:127-152` (`evalFormule`) | Utilise `new Function('return (' + expr + ')')`. Atténué par une whitelist `^[A-Z0-9_\s+\-*/.()]+$` (pas de minuscules → impossible d'écrire `constructor`/`process`/`fetch`) et substitution préalable des variables. La source des formules = `payroll_rules.formula` (config admin RH, pas d'entrée publique). | Très faible : il faudrait un admin malveillant ET contourner une whitelist majuscule-only. Un token majuscule non substitué provoque un ReferenceError capté → 0. | Remplacer à terme par un évaluateur d'AST sans `Function` (ex. expr-eval) pour éliminer la classe de risque. Documenter que `formula` n'est jamais alimentée par une entrée non-admin. |
| Faible | Multiples handlers (ex. `payroll.routes.ts`, `employees.routes.ts`, `mobile-money.routes.ts`) | Interpolation de `"${schema}"` dans les requêtes brutes. | Aucune (voir atténuation). | RAS — `schema` vient du JWT signé et est revalidé par regex (`isValidSchemaName`) au middleware `authenticate` ET souvent localement. C'est une **bonne pratique**, pas une faille. |

**Bonnes pratiques constatées (A03) :**
- **Toutes les valeurs** sont paramétrées (`$1…$n`) — aucune concaténation de
  valeur utilisateur dans le SQL des modules échantillonnés (employees, payroll,
  absences, expenses, mobile-money, platform, recruitment, integrations).
- **Validation Zod stricte** (`.strict()`) sur quasiment tous les bodies/queries,
  avec bornes numériques anti-overflow (salaires, montants, enfants…).
- Filtres dynamiques (`WHERE` conditionnels) construits avec compteur d'index
  paramétré, jamais par interpolation de valeur (ex. `employees.routes.ts:118-136`).
- UUID/month/reference validés par regex avant tout usage.
- **XSS (web)** : aucun `dangerouslySetInnerHTML` problématique repéré dans le
  flux principal ; le CV servi (`recruitment:720-723`) force `X-Content-Type-Options:
  nosniff` et n'accepte que pdf/doc/docx/txt (pas de HTML/SVG → pas de stored XSS).
- Anti **prompt-injection** côté IA (voir A04).

---

## 5. A04 — Insecure Design

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| Faible | `apps/api/src/modules/platform/platform.routes.ts:388,411` | `reset-admin` génère un `tempPassword` via `randomBytes(6)` (~48 bits) **retourné en clair** dans la réponse API (filet documenté si l'email échoue). | Faible : route réservée `super_admin`, mot de passe temporaire à usage immédiat. 48 bits restent bruteforce-résistants à court terme. | Acceptable pour un usage super_admin. Idéalement, forcer le changement au 1er login (déjà géré via `must_change_password`) et porter l'entropie à `randomBytes(12)`. |
| Faible | `apps/api/src/modules/mobile-money/mobile-money.routes.ts:71-101` | `initiateMobileMoneyPayment` est une **simulation** (95% succès aléatoire). | Aucune en prod réelle (à remplacer par les vrais SDK). | Veiller à ce que le code de prod n'expédie jamais la simulation ; ajouter un garde-fou env `MTN_MOMO_ENV`/feature-flag bloquant la simulation hors dev. |

**Bonnes pratiques constatées (A04) — point fort du projet :**
- **Séparation des pouvoirs (SoD)** sur la clôture de paie : workflow N-niveaux,
  l'initiateur ne peut pas approuver (`payroll.routes.ts:603-608`), pas d'approbation
  en double par la même personne (`:610-619`), clôture définitive seulement après
  le nombre requis d'approbations.
- **Bornes anti-fraude Mobile Money** : plafond 50M FCFA/paiement, max 1000
  virements/lot, re-vérification du plafond à l'exécution ET au retry.
- **Idempotence webhooks** (anti-replay) : un paiement déjà `completed` ne peut
  être re-modifié ; conflit de référence → 409 + audit.
- **Anti-token-burn IA** : plafonds chars/message, total cumulé, nb messages.
- Anti prompt-injection : variables tenant **sanitizées** (`sanitizeForPrompt`),
  encadrées « données, pas instructions », instruction explicite d'ignorer le
  contenu des crochets (`ai.routes.ts:49-174`).

---

## 6. A05 — Security Misconfiguration

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| **Moyen** | `apps/api/src/plugins/swagger.ts:37-40` + `app.ts:108` | Swagger UI servi sur `/docs` **sans authentification** et **quelle que soit `NODE_ENV`** (un CSP permissif `DOCS_CSP` est même prévu pour lui). | En prod, un attaquant cartographie toute la surface d'API (routes, schémas, paramètres) → facilite l'exploitation ciblée. | Désactiver `/docs` en production, ou le protéger (basic auth / restriction IP / rôle super_admin). |
| Faible | `apps/api/src/modules/ai/ai.routes.ts:181` | La réponse SSE `/ai/chat` pose `Access-Control-Allow-Origin: *`, contournant la CORS allowlist stricte pour ce flux. | Faible : la route exige un JWT (preHandler `authorize`) ; mais `*` + credentials est incohérent et déconseillé. | Refléter l'origine autorisée (allowlist) au lieu de `*`, ou retirer l'en-tête (la CORS globale gère déjà). |
| Faible | `apps/api/src/app.ts:291-294`, `:224-238` | Middlewares maintenance/offline en **fail-open** si la DB est injoignable (choix assumé pour la disponibilité). | Faible : un tenant suspendu pourrait rester accessible pendant un incident DB. | Acceptable ; documenter le compromis disponibilité vs. confinement. |

**Bonnes pratiques constatées (A05) :**
- En-têtes complets (`app.ts:111-138`) : **CSP** (API `default-src 'none'`),
  **HSTS** `preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, **COOP/CORP** `same-origin`.
- **CORS allowlist** (`plugins/cors.ts`) — pas de wildcard global, origines dev vs prod.
- **Error handler** : pas de stacktrace en prod, mapping fin des codes PG, masquage
  des erreurs `undefined_table/column` en prod (`app.ts:341-395`).
- `Cache-Control: no-store` sur PDF/CSV/XML sensibles (postes RH partagés).
- Validation des variables d'env au boot via Zod (`config.ts`).

---

## 7. A06 — Vulnerable & Outdated Components

> Analyse statique du `apps/api/package.json` (aucun `npm install`/`audit` exécuté — read-only).

| Sévérité | Emplacement | Constat | Recommandation |
|----------|-------------|---------|----------------|
| Faible | `apps/api/package.json` (`@anthropic-ai/sdk: ^0.24.3`) | SDK Anthropic très ancien (branche 0.24, antérieure de plusieurs versions majeures). Pas de CVE connue critique mais surface non maintenue. | Mettre à jour vers une version récente du SDK (et aligner `AI_MODEL`). |
| Faible | `bcryptjs: ^2.4.3` | Implémentation **pure-JS** (plus lente que `bcrypt` natif), mais sans vulnérabilité connue. Le coût 12 rounds reste correct. | Acceptable ; envisager `bcrypt` natif pour la performance sous charge. |
| Info | Ensemble des deps en `^` | Fastify 4.x, `@fastify/jwt` 8, `drizzle-orm` 0.31, `pg` 8.12, `zod` 3.23 — versions cohérentes, pas de paquet notoirement vulnérable repéré. Le `^` autorise la dérive. | Exécuter régulièrement `pnpm audit` / Dependabot ; figer via lockfile (présent) ; planifier des montées de version. |

---

## 8. A07 — Identification & Authentication Failures

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| **Moyen** | `apps/api/src/modules/auth/auth-mfa.routes.ts:283-284` (login-verify) et `:208` (verify) | TOTP validé par `authenticator.check()` **sans mémoriser le dernier timestep/code consommé**. Un code à 6 chiffres reste donc rejouable dans sa fenêtre de validité (`window:1` ⇒ ~90s effectifs). | Un attaquant qui intercepte un code TOTP (shoulder-surfing, phishing en temps réel, MITM) peut le rejouer dans la minute pour ouvrir une 2e session. | Stocker le dernier `step`/hash de code TOTP accepté par utilisateur et refuser sa réutilisation (les backup codes sont déjà à usage unique — appliquer le même principe au TOTP). |
| Faible | `apps/api/src/modules/auth/auth.routes.ts:316,538` | MFA obligatoire (super_admin/tenant) **désactivé par défaut** (paramétrable). Choix produit assumé (débloque la création de tenant). | Faible si activé en prod sur les comptes privilégiés. | Recommander/forcer le MFA pour `super_admin` et `admin` en production. |

**Bonnes pratiques constatées (A07) — point fort :**
- **Verrouillage de compte** anti-bruteforce (Redis, `account-lockout.service`),
  contrôlé AVANT toute vérif mdp, fail-open si Redis down, réponse 423 + `Retry-After`.
- **Rate-limit** login 10/5min, change-password 5/5min, refresh 60/min, forgot-password
  3/15min, global 200/min.
- **Anti-énumération** : message login générique « Email ou mot de passe incorrect » ;
  forgot-password répond toujours « si ce compte existe… » ; webhook ne révèle pas
  l'existence d'une référence ; tenants/cabinets hors-ligne ne sont révélés
  qu'**après** validation du mdp.
- **HIBP breach-check** au login et au changement de mdp (non bloquant si offline).
- **Historique de mots de passe** anti-réutilisation + **expiration** (durée de vie)
  → token restreint `pwdResetRequired` limité à `/auth/change-password`.
- **MFA** : secret base32 otplib, QR, **10 backup codes hachés bcrypt** à usage unique,
  mot de passe requis pour désactiver le MFA.
- **Révocation de session** : blacklist Redis du `jti` au logout, vérifiée au middleware.
- `findTenantAndUser` itère **tous** les candidats et compare le hash (pas de faux
  401 sur email dupliqué multi-tenant).

---

## 9. A08 — Software & Data Integrity Failures

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| Faible | `recruitment.routes.ts:1228-1239` & `:649-664` | Validation du type de CV par **MIME déclaré uniquement** (header `part.mimetype`), pas par magic bytes. Allowlist : pdf/doc/docx/txt ; taille bornée (5 Mo public / 10 Mo global). | Faible : un attaquant peut faire passer un fichier arbitraire en l'étiquetant `application/pdf`. Servi ensuite en `inline` + `nosniff` → exécution navigateur improbable (pas de HTML/SVG autorisé). | Valider la signature binaire (magic bytes) en plus du MIME ; forcer `Content-Disposition: attachment` pour les CV non-PDF. |
| Faible | `mobile-money.routes.ts:557` (webhook) | HMAC calculé sur `JSON.stringify(request.body)` re-sérialisé (et non sur le **raw body**). Dépend d'une canonicalisation JSON identique côté provider. | Faible : risque de faux négatifs (rejets légitimes) plus que de bypass. | Capturer le raw body (rawBody) et calculer le HMAC dessus pour une intégrité exacte. |

**Bonnes pratiques constatées (A08) :**
- **HMAC SHA-256 timing-safe** sur webhooks entrants (Mobile Money) ET sortants
  (intégrations), fail-closed si secret non configuré.
- Clés API entrantes **hachées SHA-256** en base (jamais en clair), scopes en
  whitelist, expiration, `last_used_at`.
- Pas de désérialisation non sûre (pas de `eval` de payload, JSON parsé par Fastify).
- Webhooks sortants : **pas de suivi de redirection** (`redirect:'error'`),
  re-validation SSRF à chaque tentative.

---

## 10. A09 — Security Logging & Monitoring Failures

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| Faible | `mobile-money.routes.ts:629,657` ; `recruitment.routes.ts:1338` | `audit_log.user_id` reçoit parfois la chaîne `'webhook'` ou `NULL` (action publique). Si la colonne est `uuid NOT NULL`, l'INSERT échoue silencieusement (catch). | Perte de traçabilité sur certaines actions automatiques/publiques. | Prévoir un acteur système dédié (UUID réservé) ou rendre `user_id` nullable + colonne `actor_label`. |
| Info | Global | L'audit est **non bloquant** (`.catch(() => {})`) : robuste, mais une indisponibilité de la table passe inaperçue. | Faible. | Compter/alerter les échecs d'écriture audit (métrique). |

**Bonnes pratiques constatées (A09) :**
- `audit_log` (IP, user-agent, changes JSON) sur : login OK/KO/locked, logout,
  change-password (+ reuse/breach blocked), création/modif/archivage employé,
  absences (créées/approuvées/rejetées), clôture/rejet paie, simulations paie,
  campagnes & exécutions Mobile Money, appels IA (tokens), actions super_admin.
- **Pas de secret/mdp loggé** : les erreurs internes (login, IA, DB) sont logguées
  côté serveur sans fuiter au client ; les valeurs sensibles (NNI, mdp) ne sont
  pas dans `changes` (seules les clés modifiées le sont).
- Endpoint conformité ARTCI `GET /payroll/my-access-log` (journal d'accès perso).

---

## 11. A10 — Server-Side Request Forgery (SSRF)

| Sévérité | Emplacement | Constat | Exploitation | Recommandation |
|----------|-------------|---------|--------------|----------------|
| Faible | `apps/api/src/services/ssrf-guard.ts:55-88` | La garde résout le DNS et bloque les IP privées, MAIS entre la validation (`lookup`) et le `fetch`, le hostname pourrait re-résoudre (TOCTOU/DNS-rebinding). Atténué par `redirect:'error'` et re-validation à chaque tentative, sans pinning de l'IP résolue. | Très faible : fenêtre étroite, nécessite un attaquant contrôlant le DNS + timing précis. | Pour un durcissement maximal, résoudre l'IP puis se connecter à cette IP (pinning) avec l'en-tête `Host` d'origine. |

**Bonnes pratiques constatées (A10) — point fort :**
- Garde SSRF **centralisée** appliquée à TOUS les appels sortants configurables
  par le tenant (webhooks, connecteurs REST) : schéma http(s) only, refus des
  credentials dans l'URL, blocage `localhost`/`.local`/`.internal`/metadata.
- Blocage exhaustif des plages privées **IPv4 et IPv6** (10/8, 127/8, 169.254/16
  incl. metadata cloud, 172.16-31, 192.168, CGNAT 100.64/10, multicast ; ::1, fc/fd,
  fe80, IPv4-mapped).
- **`redirect:'error'`** (pas de suivi de redirection) + timeout 8s + **re-validation
  à chaque envoi** (anti DNS-rebinding partiel).
- Appels IA (Anthropic) vers un endpoint fixe de confiance, clé tenant chiffrée.

---

## 12. Plan de remédiation priorisé

### Priorité 1 — À corriger rapidement (avant prod / sprint courant)

1. **[A01 Élevé]** `POST /absences` : forcer `employeeId = request.user.employeeId`
   pour le rôle `employee` (ignorer `body.employeeId`). *(absences.routes.ts:168)*
2. **[A01 Moyen]** `GET /employees/:id` : restreindre le `manager` à son équipe
   directe ; ne déchiffrer NNI/IBAN que pour les rôles RH. *(employees.routes.ts:144-173)*
3. **[A05 Moyen]** Désactiver/protéger Swagger `/docs` en production. *(swagger.ts)*
4. **[A02 Moyen]** Rendre `ENCRYPTION_KEY` obligatoire (échec au boot si absente)
   et bannir la valeur tout-à-zéro ; refuser le `JWT_SECRET` d'exemple. *(config.ts:20-21)*

### Priorité 2 — Durcissement (sprint suivant)

5. **[A07 Moyen]** Anti-rejeu TOTP : mémoriser le dernier timestep accepté.
   *(auth-mfa.routes.ts:208,284)*
6. **[A08 Faible]** Validation magic-bytes des CV + `attachment` pour non-PDF.
7. **[A05 Faible]** Remplacer `Access-Control-Allow-Origin: *` par l'allowlist sur
   `/ai/chat`. *(ai.routes.ts:181)*
8. **[A06 Faible]** Mettre à jour `@anthropic-ai/sdk` ; activer Dependabot/`pnpm audit` en CI.

### Priorité 3 — Améliorations défensives (backlog)

9. **[A03 Faible]** Remplacer `new Function` du moteur de paie par un évaluateur AST.
10. **[A10 Faible]** Pinning d'IP post-résolution sur les appels sortants.
11. **[A09 Faible]** Acteur système pour l'audit des actions publiques/webhook ;
    métrique d'échec d'écriture audit.
12. **[A04/A07]** Forcer le MFA sur `super_admin`/`admin` en production ;
    porter l'entropie du `tempPassword` reset-admin à 12 octets.

---

## 13. Conclusion

NexusRH CI démontre une **ingénierie de sécurité mature** : isolation multi-tenant
rigoureuse, paramétrage SQL systématique, authentification de niveau professionnel
(lockout, rate-limit, MFA, HIBP, historique mdp), séparation des pouvoirs sur la
paie, garde SSRF complète, en-têtes et CSP corrects, audit log étendu. Le projet
porte clairement les traces d'un durcissement OWASP itératif.

Les constats les plus importants sont **deux contrôles d'accès incomplets**
(création d'absence pour autrui par un employé ; lecture de dossier hors-équipe par
un manager) et des **points de configuration** (Swagger en prod, secrets d'exemple,
`ENCRYPTION_KEY` optionnelle). Aucune vulnérabilité critique de type injection,
RCE ou contournement d'isolation tenant n'a été identifiée dans le périmètre
échantillonné. Une fois la Priorité 1 traitée, la posture passe de « bonne » à
« très bonne ».
