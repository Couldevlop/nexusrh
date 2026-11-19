# Rapport de tests de sécurité — NexusRH

**Date** : 19 novembre 2026
**Périmètre** : `nexusrh_ci/` (API Fastify, web React, worker BullMQ, package shared)
**Environnements testés** : local (code + application en exécution) puis k8s `nexusrh-ci` sur l'hôte `nexusrh-preprod` (62.238.11.20)
**Autorisation** : propriétaire de l'application et de l'infrastructure
**Nature des tests** : non destructifs — aucune écriture sur données réelles, aucun test de déni de service

---

## 1. Synthèse exécutive

| Volet | Résultat |
|---|---|
| Suite de tests du projet | **416 fichiers / 7 242 tests — 0 échec** |
| Tests dédiés sécurité | **68 fichiers / 898 tests** — tous verts |
| SAST (Semgrep OWASP + secrets) | 8 remontées → **1 vraie**, 7 faux positifs, **0 secret** |
| Audit de dépendances | **86 avis : 2 critiques, 32 élevés, 44 moyens, 8 faibles** |
| Tests dynamiques (application en exécution) | **28 OK / 1 échec / 1 non concluant** |
| Durcissement k8s | Conforme (non-root, FS en lecture seule, capacités retirées, seccomp, NetworkPolicies) |
| TLS / en-têtes / WAF | TLS 1.3, CSP stricte, ModSecurity + CRS actifs en blocage |

### Verdict

**La posture applicative est solide.** L'authentification, le RBAC, l'isolation multi-tenant, la
validation d'entrée et le durcissement infrastructure résistent à l'ensemble des sondes passées.
Aucune faille d'authentification, d'élévation de privilège ou de fuite inter-tenant n'a été trouvée.

**Le risque réel est concentré sur la chaîne de dépendances**, qui a dérivé : un correctif de sécurité
Fastify portant sur un **contournement d'authentification** n'est pas appliqué. C'est le point d'action
numéro un.

### Priorités

| # | Action | Gravité | Effort |
|---|---|---|---|
| 1 | Monter `fastify` ≥ 5.12.5 (contournement d'authentification CVE-2026-76169) | **Critique** | Faible |
| 2 | Monter `undici` ≥ 7.30.1 (contournement de validation de certificat TLS) | **Élevée** | Faible |
| 3 | Monter `@fastify/busboy` ≥ 3.2.2, `fast-uri` ≥ 3.1.9, `joi` ≥ 17.13.9, `fast-jwt` ≥ 6.3.4 | **Élevée** | Faible |
| 4 | Monter `nodemailer` ≥ 10.1.4 (fuite d'identifiants SMTP inter-tenant) | **Élevée** | Moyen |
| 5 | Monter `tinypool` ≥ 2.1.2 et `vitest`/`vite` (RCE chaîne de build) | **Critique (CI)** | Faible |
| 6 | Intercepter les UUID invalides en paramètre de route (500 → 400) | Moyenne | Faible |
| 7 | Imposer `authTagLength: 16` sur le déchiffrement AES-GCM | Moyenne | Très faible |
| 8 | Remplacer `SecRuleRemoveById 911100` par une liste de méthodes autorisées | Moyenne | Faible |
| 9 | Monter `follow-redirects` ≥ 1.16.2 et `react-router` (front) | Moyenne | Moyen |

---

## 2. Volet 1 — Suite de tests du projet (local)

Commande : `pnpm run test` (Turborepo, 5 paquets).

```
@nexusrhci/api     325 fichiers  6 551 tests   ✓   360 s
@nexusrhci/web      66 fichiers              ✓   244 s
@nexusrhci/worker   19 fichiers              ✓    20 s
@nexusrhci/shared    6 fichiers              ✓     8 s
TOTAL              416 fichiers  7 242 tests  0 échec
```

### 2.1 Tests dédiés à la sécurité — 68 fichiers, 898 tests

Répartition par domaine :

| Domaine | Fichiers | Tests notables |
|---|---|---|
| Habilitations / RBAC fin | 20 | `habilitation-scope.golden` (76), `habilitation-scope.payroll` (47), `habilitation.service` (34), `fiche.service` (32), `structure.routes` (28) |
| Authentification / MFA | 14 | `auth.routes.coverage` (37), `auth-mfa.routes` (27), `auth-mfa.routes.coverage` (21), `token-jti-revocation` (11) |
| Politique de sécurité / audit | 8 | `security-policy.service` (28), `security.routes` (27), `security-mfa-policy.golden` (13) |
| Isolation tenant | 7 | `tenant-modules.golden` (23), `tenant-params.golden` (16), `employee-photo-isolation.golden` (10), `agency-isolation.golden` (3) |
| Verrouillage de compte | 3 | `account-lockout.service` (13), `account-lockout-login.golden` (4) |
| CSRF / cookies | 1 | `csrf-cookie-auth` (18) |
| En-têtes de sécurité | 2 | `app.security-headers` (9), `nginx-security-headers` (4) |
| Garde MFA côté front | 1 | `mfa-pending-guard` (37) |
| Durcissement historisé | 3 | `security-hardening-2026-08.golden` (9), `security-hardening-bc.golden` (6), `security-authz-sweep.golden` (5) |

### 2.2 Le balayage d'autorisation intégré

`apps/api/src/security-authz-sweep.golden.test.ts` est un véritable test d'intrusion
automatisé, exécuté à chaque CI. Il énumère **toutes** les routes déclarées dans
`modules/**/*.routes.ts`, les monte réellement via `buildApp()` et vérifie pour chacune :

1. sans jeton → 401 (jamais 200, 404 ou 500) ;
2. avec un JWT signé d'une **autre clé** → 401 (pas de confusion de signature) ;
3. avec un jeton de contexte plateforme sur une route tenant → 403.

Un 404 signalerait une route mal montée, un 500 un handler atteint sans authentification.
Les **23 routes délibérément publiques** sont inscrites dans une liste d'autorisation explicite :
parcours d'authentification (5), branding avant login (2), site vitrine (2), offres d'emploi
publiques et candidature (3), entraînement à l'entretien par jeton HMAC éphémère (3), webhook
Mobile Money signé HMAC (1). Toute nouvelle route publique doit y être ajoutée — l'ouverture
d'un endpoint est donc un acte conscient et revu.

**C'est le dispositif le plus fort de ce projet** : il rend structurellement impossible
l'oubli d'authentification sur une nouvelle route.

### 2.3 Tests explicitement rattachés à l'OWASP Top 10

Relevés dans la sortie de test : A01 (contrôle d'accès), A02 (défaillances
cryptographiques — secret TOTP chiffré au repos, jeton de réinitialisation à usage unique),
A03 (injection — schémas Zod stricts), A05 (mauvaise configuration), A07 (défaillances
d'authentification — verrouillage de compte, comparaison en temps constant), A09 (journalisation).

---

## 3. Volet 2 — Analyse statique (SAST)

Outil : **Semgrep 1.145.0**, jeux de règles `p/owasp-top-ten` + `p/secrets`,
cible `apps/api/src apps/web/src apps/worker/src packages` (tests exclus).

**8 remontées : 2 ERROR, 6 WARNING. Aucun secret détecté.**

### 3.1 VRAIE — Longueur du tag d'authentification AES-GCM non imposée

- **Fichier** : `packages/shared/src/crypto.ts:43`
- **Règle** : `javascript.node-crypto.security.gcm-no-tag-length`
- **Gravité** : **Moyenne**

```ts
const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'))
decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
```

Node accepte par défaut des tags GCM de 4, 8, 12, 13, 14, 15 ou 16 octets. Un attaquant
capable d'écrire dans les colonnes chiffrées (`integration_webhooks.headers_enc`, secrets
Mobile Money, clés IA par tenant, secrets TOTP) pourrait stocker un cryptogramme accompagné
d'un tag **tronqué à 4 octets**, ramenant la résistance à la falsification de 2^128 à 2^32 —
atteignable par force brute. L'exploitation suppose un accès en écriture à la base, donc
post-compromission : c'est une défense en profondeur, pas une faille directe.

**Correctif** (deux lignes) :

```ts
if (tagHex.length !== 32) throw new Error('Invalid auth tag length')
const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'), { authTagLength: 16 })
```

Le chiffrement est par ailleurs correct : AES-256-GCM, IV aléatoire de 12 octets par
opération, format `iv:tag:ciphertext`, clé refusée si elle ne fait pas 64 caractères hex.

### 3.2 Faux positifs (7) — vérifiés un par un

| Règle | Emplacement | Pourquoi c'est un faux positif |
|---|---|---|
| `detected-bcrypt-hash` | `auth/auth.routes.ts:76` | `DUMMY_BCRYPT_HASH` est un hash factice **délibéré**, commenté « OWASP A02 », comparé quand l'email est introuvable pour garder un temps de réponse constant. C'est une **bonne pratique**, pas une fuite. |
| `direct-response-write` ×6 | `bank-transfer.routes.ts:320,719` · `mobile-money.routes.ts:397` · `referentiels.routes.ts:34,108,117` | Règle écrite pour Express et le rendu HTML (`resp.render()`). Fastify sérialise `reply.send()` en JSON selon le schéma de réponse ; il n'y a pas de rendu HTML, donc pas de vecteur XSS. |

---

## 4. Volet 3 — Audit des dépendances

Commande : `pnpm audit --audit-level=low`.
**86 avis : 2 critiques · 32 élevés · 44 moyens · 8 faibles.**

C'est le volet le plus préoccupant du rapport. Le `pnpm.overrides` de `package.json`
a servi par le passé à épingler des versions corrigées, mais il a **dérivé** : il fixe
`fast-uri: ^3.1.5`, ce qui résout aujourd'hui 3.1.6 — toujours vulnérable.

### 4.1 Chemin d'exécution en production — à traiter

#### Fastify 5.12.1 → **5.12.5** — le point le plus grave

| CVE | Gravité | Nature |
|---|---|---|
| **CVE-2026-76169** | **Élevée** | **Contournement d'authentification** : des URL malformées atteignent les handlers « not-found » encapsulés, en court-circuitant les hooks d'authentification du plugin englobant |
| CVE-2026-84504 | Élevée | Remplacement du corps de requête par collision de résultat de validation asynchrone |
| CVE-2026-84469 | Élevée | Contournement de validation via schémas booléens `false` ignorés |
| CVE-2026-84428 | Élevée | Contournement de validation d'en-tête (normalisation de casse incomplète) |
| CVE-2026-92081 | Moyenne | Déni de service sur réponses à trailers HTTP/2 |

CVE-2026-76169 touche directement le modèle de sécurité de NexusRH : l'authentification
est appliquée par hook Fastify, et l'ensemble du RBAC et de l'isolation tenant en dépend.
Le balayage d'autorisation du projet teste les routes **déclarées** ; cette CVE concerne
les chemins **non déclarés** qui tombent sur un handler encapsulé. Le test ne peut donc
pas la détecter — d'où l'importance de la mise à jour.

#### undici 7.29.0 → **7.30.1**

| CVE | Gravité | Nature |
|---|---|---|
| CVE-2026-109383 | Élevée | **Contournement de validation de certificat TLS** (options `tls` perdues dans `Agent`) |
| CVE-2026-84961 | Élevée | **Contournement de validation de certificat TLS** (`BalancedPool`) |
| CVE-2026-109829 | Élevée | Empoisonnement de cache et divulgation inter-utilisateurs via redirections cross-origin |
| CVE-2026-109869 | Élevée | DoS via encodages de contenu excessifs |
| CVE-2026-87018 | Élevée | DoS via renégociation TLS 1.2 avec changement de certificat |
| CVE-2026-84933 | Moyenne | Divulgation de cookies inter-utilisateurs via mise en cache de `Set-Cookie` |
| + ~8 autres | Moyenne/Faible | DoS divers, contournement SRI, troncature de réponse |

undici est le client HTTP de `@nexusrhci/shared` — donc du **garde SSRF**, des appels
Mobile Money (Wave/MTN/Orange/CinetPay), des webhooks sortants et de l'IA. Deux
contournements de validation de certificat TLS sur ce chemin signifient qu'un attaquant
en position d'interception pourrait se faire passer pour un agrégateur de paiement.

#### @fastify/busboy 3.2.0 → **3.2.2** (via `@fastify/multipart`)

| CVE | Gravité | Nature |
|---|---|---|
| CVE-2026-19484 | Élevée | DoS via frontière multipart surdimensionnée |
| CVE-2026-19481 | Élevée | DoS via en-tête de partie nommé comme une propriété de prototype |
| CVE-2026-74866 | Moyenne | **Injection CRLF** via `filename` et `name` du `Content-Disposition` |

Chemin exposé : tout téléversement — CV de candidature (**route publique**, non
authentifiée), photos d'employés, documents, fichiers bancaires exemples. L'injection
CRLF sur un nom de fichier fourni par un candidat anonyme est le vecteur le plus direct
de ce rapport.

#### fast-uri 3.1.6 → **3.1.9**

| CVE | Gravité | Nature |
|---|---|---|
| CVE-2026-84292 | Élevée | Injection d'autorité via port non validé dans `serialize` |
| CVE-2026-84394 | Élevée | Confusion d'hôte via crochet non fermé dans l'autorité |
| CVE-2026-110306 | Moyenne | Usurpation de schéma d'URI via décodage de schéma percent-encodé |
| CVE-2026-110180 | Moyenne | Confusion d'hôte via canonicalisation WHATWG non vérifiée |
| + 3 autres | Moyenne/Faible | Équivalence de chemin, injection de schéma, casse d'hôte |

Les confusions d'hôte et usurpations de schéma sont le mécanisme classique de
**contournement d'un garde SSRF** basé sur une liste d'autorisation d'hôtes — ce que
`packages/shared/src/ssrf-guard.ts` met en œuvre.

#### nodemailer 9.0.6 → **10.1.4**

| Avis | Gravité | Nature |
|---|---|---|
| Quadratic `addressparser` | Élevée | DoS distant via liste d'adresses forgée |
| Backtracking quadratique (fallback texte libre) | Élevée | DoS distant |
| **Cache DNS global de processus** | Moyenne | **Divulgation d'identifiants SMTP inter-tenant** : le `servername` TLS est réutilisé entre transports |
| 9 autres | Moyenne | Contournements de validation de domaine destinataire (IDN/punycode, commentaires RFC 5322, `;` et `>` dans chaînes citées) → livraison vers un domaine contrôlé par l'attaquant |

L'avis sur le cache DNS est **spécifiquement pertinent** : NexusRH implémente le SMTP
**par tenant** (`transporterFor`, secrets chiffrés). C'est exactement la configuration
multi-transports que cet avis décrit, avec un risque de fuite d'identifiants SMTP d'un
tenant vers un autre.

#### fast-jwt 6.3.2 → **6.3.4** (via `@fastify/jwt`)

CVE-2026-107719 (Moyenne) : **le cache du vérificateur accepte des JWT expirés** quand
le jeton ne porte pas de `iat`. Les jetons NexusRH portent bien `iat` (vérifié sur un
jeton réel émis en local), ce qui limite fortement l'exposition — mais la révocation
par `jti` et la rotation d'époque reposent sur cette couche.

#### Autres paquets du chemin d'exécution

| Paquet | Actuel → Cible | Gravité | Nature |
|---|---|---|---|
| `joi` (via `@fastify/oauth2`) | 17.13.6 → **17.13.9** | Élevée ×2 | ReDoS sur `isoDate()` et `email({multiple:true})` ; CVE-2026-90771 remplacement de prototype |
| `zod` | 3.25.76 → 4.6.6 | Élevée | CVE-2023-54404 épuisement mémoire sur collections contraintes surdimensionnées. **Montée majeure** — à planifier, Zod est au cœur de toute la validation |
| `brace-expansion` | 1.1.18 / 2.1.4 / 5.0.9 | Élevée ×3 | DoS par récursion non contrôlée et expansion quadratique (via `exceljs`→`archiver`, `@fastify/static`) |
| `source-map-js` | 1.2.1 → 1.2.2 | Élevée | DoS de la boucle d'événements |
| `fast-copy` (via `pino-pretty`) | 3.0.2 → 3.1.0 | Moyenne | Épuisement de pile |
| `glob` / `minimatch` | — | Moyenne | Contournement d'annulation `AbortSignal`, amplification `globparts` |
| `fast-xml-parser` (AWS SDK) | 5.11.1 → 5.12.0 | Faible | Consommation CPU quadratique |

#### Front (`apps/web`)

| Paquet | Actuel → Cible | Gravité | Nature |
|---|---|---|---|
| `follow-redirects` (via `axios`) | 1.16.0 → **1.16.2** | Élevée ×3 | CVE-2026-111756 / 111755 / 116689 : **fuite d'en-têtes d'identifiants** à travers les redirections cross-origin |
| `react-router` | 6.30.6 → 7.18.0 | Moyenne ×2 | CVE-2026-53669 redirection ouverte via antislash dans `<Link>`/`useNavigate` ; CVE-2026-53666 **injection de constructeur arbitraire** via `deserializeErrors()` en hydratation SSR |
| `postcss-selector-parser` | 6.1.2 → 6.1.5 | Moyenne | Complexité quadratique, récursion AST non contrôlée |
| `browserslist` | 4.28.2 → 4.28.7 | Élevée ×2 | Croissance mémoire non bornée ; écriture de prototype via stats non fiables |

L'application fait du **prérendu SSR** (`vite build --ssr`, `scripts/prerender.mjs`) —
CVE-2026-53666 touche donc un chemin réellement emprunté.

### 4.2 Chaîne de build et CI — 2 critiques

| Paquet | Gravité | Nature |
|---|---|---|
| **tinypool ≤ 2.1.0** (via `vitest`) | **Critique ×2** | CVE-2026-104848 / 104849 : **pollution de prototype menant à l'exécution de code à distance** dans les options de worker et de `run()` → **2.1.2** |
| `vite` ≤ 6.4.3 | Élevée + Moyenne ×3 | `launch-editor` : contournement de `fs.existsSync()`, mauvaise interprétation de drapeaux CLI → exécution de commande arbitraire ; service de fichiers hors `server.fs.allow` → **6.4.4** |
| `@vitest/mocker` | Moyenne ×2 | CVE-2026-112949 injection de code via enregistrement de mock non authentifié ; CVE-2026-84373 traversée de chemin / lecture de fichier arbitraire |

Ces paquets ne tournent pas en production, mais ils s'exécutent **dans la CI GitHub Actions
avec accès au dépôt et aux secrets**. Une RCE dans le lanceur de tests est une voie de
compromission de la chaîne d'approvisionnement : à traiter avec la même urgence que la prod.

### 4.3 Correctif recommandé

Mettre à jour `pnpm.overrides` dans `nexusrh_ci/package.json` :

```jsonc
"fast-uri": "^3.1.9",        // était ^3.1.5 → résolvait 3.1.6, vulnérable
"undici": "^7.30.1",
"@fastify/busboy": "^3.2.2",
"joi": "^17.13.9",           // était ^17.13.4
"fast-jwt": "^6.3.4",
"brace-expansion@^1": "^1.1.21",
"brace-expansion@^2": "^2.1.7",
"brace-expansion@^5": "^5.0.12",
"source-map-js": "^1.2.2",
"tinypool": "^2.1.2",
"vite": "^6.4.4",            // était ^6.4.3
"follow-redirects": "^1.16.2",
"postcss-selector-parser": "^6.1.5",
"browserslist": "^4.28.7",
"fast-copy": "^3.1.0",
"fast-xml-parser": "^5.12.0"
```

Et dans les dépendances directes : `fastify` ≥ 5.12.5, `nodemailer` ≥ 10.1.4.

À planifier séparément (montées majeures, risque de régression) : `zod` 4.x et
`react-router` 7.x. Les 7 242 tests du projet constituent un filet de sécurité
sérieux pour ces deux migrations.

---

## 5. Volet 4 — Tests dynamiques sur application en exécution (local)

Application réellement démarrée : PostgreSQL 16 + Redis 7 (conteneurs), API sur `:4001`,
base seedée (SOTRA 81 employés, Cabinet Expertise 25, 6 mois de bulletins).
**28 OK / 1 échec / 1 non concluant.**

### 5.1 Authentification — 6/6

| Test | Attendu | Obtenu |
|---|---|---|
| Route protégée sans jeton | 401 | **401** |
| JWT signé d'une autre clé | 401 | **401** |
| JWT `alg=none` (confusion d'algorithme) | 401 | **401** |
| `Bearer` vide | 401 | **401** |
| Jeton tronqué | 401 | **401** |
| Charge utile modifiée (`role: super_admin`) | 401 | **401** |

Aucun contournement. La confusion d'algorithme et la falsification de charge utile
sont correctement rejetées.

### 5.2 RBAC et élévation de privilège — 6/6

| Test | Obtenu |
|---|---|
| `employee` → liste de tous les employés | **403** |
| `employee` → création d'utilisateur | **403** |
| `employee` → clôture de paie | **404** |
| `employee` → paramètres du tenant | **403** |
| `employee` → piste d'audit de sécurité | **404** |
| `admin` tenant → portail plateforme | **403** |

Le 404 (plutôt que 403) sur les routes hors périmètre est le comportement documenté
du projet : ne pas révéler l'existence d'une ressource à qui n'y a pas droit.

### 5.3 Isolation multi-tenant / IDOR — 5/5

Deux tenants réels, jetons réels, identifiants d'employés réels extraits de chaque tenant.

| Test | Obtenu |
|---|---|
| Admin SOTRA lit un employé du Cabinet (UUID valide) | **404** |
| Admin Cabinet lit un employé SOTRA (UUID valide) | **404** |
| Admin SOTRA lit la **photo (PII)** d'un employé Cabinet | **404** |
| En-tête `X-Tenant-Id` forgé vers le tenant SOTRA | **ignoré** — le tenant provient exclusivement du JWT |
| Photo d'employé (PII) servie par la route publique `/public/brand/:id` | **404** |

**L'isolation tenant tient.** C'est l'exigence non négociable du produit (un SIRH
multi-tenant qui fuite entre clients est inexploitable) et elle est vérifiée ici sur
données réelles, pas seulement en test unitaire mocké.

### 5.4 Injection — 3/4, un échec

| Test | Attendu | Obtenu |
|---|---|---|
| SQLi `' OR 1=1--` dans la recherche employés | 200/400 | **200**, aucune fuite (requête paramétrée) |
| SQLi `UNION SELECT version()--` | 200/400 | **200**, aucune fuite |
| Traversée de chemin `/employees/../../platform/tenants` | 4xx | **403** |
| **Paramètre de route non-UUID** | 400/404 | **500** ❌ |

#### Échec D3 — UUID invalide en paramètre de route → 500

**Gravité : Moyenne** (robustesse / divulgation d'information, pas injection).

```
GET /employees/pas-un-uuid        → HTTP 500
GET /employees/1';DROP TABLE...   → HTTP 500
```

Journal API confirmant la cause :

```
"file": "uuid.c", "routine": "string_to_uuid"
"url": "/employees/pas-un-uuid"
```

La chaîne non validée est transmise à PostgreSQL, qui lève l'erreur `22P02`
(*invalid input syntax for type uuid*). Cette erreur n'est pas interceptée et
remonte en 500.

**Ce n'est pas une injection SQL** — la requête est bien paramétrée, c'est précisément
pourquoi PostgreSQL se plaint du type. Mais :

- un 500 là où un 400 est attendu signale au balayeur automatisé qu'un handler a été
  atteint et a échoué de façon non maîtrisée ;
- cela viole la règle absolue n° 3 du projet (« chaque async a son try/catch ») et
  la règle n° 8 (« aucune route ne doit renvoyer 404/500 ») ;
- le code vérifie déjà `SCHEMA_NAME_RE` pour les noms de schéma, mais pas les UUID
  de paramètres de route ;
- cela consomme une connexion du pool et génère du bruit de journalisation sur un
  chemin trivialement atteignable.

**Correctif** : ajouter un schéma de validation des paramètres sur les routes à
`:id`, par exemple `z.object({ id: z.string().uuid() })`, ou un schéma Fastify
`params: { id: { type: 'string', format: 'uuid' } }`. Fastify renverra alors 400
avant d'atteindre le handler. Un test de non-régression devrait être ajouté au
balayage d'autorisation : *toute* route à paramètre `:id` répond 400 sur entrée
non-UUID.

### 5.5 Validation d'entrée et schémas stricts — 4/4

| Test | Obtenu |
|---|---|
| Champ en trop au login (`role: super_admin`) — Zod `.strict()` | **400** |
| Types invalides (`email: 123`, `password: ["x"]`) | **400** |
| JSON malformé | **400** |
| Corps de 1 Mo sur `/auth/login` | **400** |

Le rejet du champ surnuméraire est la protection contre l'**affectation massive**
(*mass assignment*) : impossible d'injecter un `role` élevé dans une charge utile de
login. C'est exactement le mécanisme qui avait causé la régression du chat IA
(`streaming:false` rejeté par `.strict()`) — ici il joue son rôle de sécurité.

### 5.6 Divulgation d'information — conforme

| Test | Résultat |
|---|---|
| Trace d'exécution dans les messages d'erreur | **Aucune** — pas de `.ts:`, `node_modules`, chemins `/src/` |
| Route inexistante | **404** propre, `{"error":"Route introuvable"}` |
| En-têtes `Server` / `X-Powered-By` | **Absents** |
| Swagger `/docs` | 200 en local — **verrouillé par `config.enableDocs`** (voir §6.4) |

#### Énumération de comptes — conforme (vérifié par le code)

Le test dynamique a été **interrompu par le rate-limiting du login** (429 sur la seconde
requête) — ce qui constitue en soi une démonstration que la protection fonctionne.
Vérification faite par lecture du code :

- `auth.routes.ts:582` — **un seul point de sortie** pour tous les échecs :
  `reply.status(401).send({ error: 'Email ou mot de passe incorrect' })` ;
- `auth.routes.ts:445` — `bcrypt.compare(password, DUMMY_BCRYPT_HASH)` joué même quand
  l'email est introuvable, avec un coût de 12 tours identique aux hashs réels, afin de
  maintenir un temps de réponse constant.

Message identique **et** temps constant : l'énumération de comptes est correctement
contrée, par message comme par canal auxiliaire temporel.

### 5.7 Limitation de débit — active et bien calibrée

Relevé dans `app.ts:132-135` et `auth.routes.ts:91-93`, et **confirmé empiriquement**
(mes propres requêtes de test ont été bloquées en 429) :

| Portée | Limite |
|---|---|
| Global | 200 / minute |
| `POST /auth/login` | **10 / 5 minutes** |
| `POST /auth/change-password` | 5 / 5 minutes |
| `POST /auth/refresh-token` | 60 / minute |

En-têtes `x-ratelimit-limit` / `-remaining` / `-reset` correctement émis.
Une limite de 10 tentatives par 5 minutes rend le bourrage d'identifiants
(*credential stuffing*) non viable, et elle se cumule avec le verrouillage
applicatif de compte (13 tests dédiés dans `account-lockout.service`).

### 5.8 En-têtes de sécurité de l'API (local)

```
content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY
cross-origin-resource-policy: same-origin
cross-origin-opener-policy: same-origin
referrer-policy: strict-origin-when-cross-origin
permissions-policy: geolocation=(), microphone=(), camera=()
x-xss-protection: 0
```

`default-src 'none'` pour une API JSON est le réglage le plus strict possible.
`x-xss-protection: 0` est **correct et volontaire** : l'auditeur XSS des anciens
navigateurs était lui-même une source de vulnérabilités, le désactiver est la
recommandation actuelle.

### 5.9 CORS

| Test | Résultat |
|---|---|
| `Origin: https://evil.example.com` sur `/health` | **Aucun `access-control-allow-origin` renvoyé** |
| Préflight `OPTIONS` sur `/auth/login` depuis `evil.example.com` | 204, **aucun `access-control-allow-origin`** |

`access-control-allow-credentials: true` est présent, mais **sans** `allow-origin`
en écho : le navigateur bloque. La liste d'autorisation d'origines fonctionne.
C'est le point exact où beaucoup d'applications échouent (`allow-origin: *` combiné
à `credentials: true`), et il est correctement traité.

---

## 6. Volet 5 — Environnement k8s `nexusrh-ci`

Hôte `nexusrh-preprod` (62.238.11.20), k3s, nœud unique.
Accès par SSH existant ; inspection en lecture seule.

### 6.1 Charges de travail

```
lucie-7b-686f49c969-mhkvl                       1/1 Running   11d
nexusrh-api-74d55f4dc4-fbdgq                    1/1 Running   7d14h
nexusrh-web-8465fdcbd5-z7s6n                    1/1 Running   7d14h
nexusrh-worker-58cb9f8f6d-9qt2f                 1/1 Running   7d14h
nexusrh-ci-infra-postgres-0                     1/1 Running  196d
nexusrh-ci-infra-redis-87b8ccbc6-7d2zf          1/1 Running   7d14h
nexusrh-ci-infra-meilisearch-6ff4d4bc8d-mq7zr   1/1 Running   28d
nexusrh-ci-infra-minio-0                        1/1 Running  196d
```

> **Note de périmètre** : le cluster ne contient **qu'un seul** namespace NexusRH
> (`nexusrh-ci`), dont l'ingress sert `nexusrh.openlabconsulting.com` et
> `api.nexusrh.openlabconsulting.com`. Il n'y a pas d'environnement de test NexusRH
> distinct ; `staging.nexusrh-ci.com` (référencé dans `k8s/overlays/staging/`)
> **n'existe pas en DNS**. L'hôte étant nommé `nexusrh-preprod`, c'est bien cet
> environnement qui a été testé.

### 6.2 Durcissement des conteneurs — conforme

Relevé dans `k8s/charts/nexusrh/templates/{api,web,worker}.yaml` :

| Contrôle | api | web | worker |
|---|---|---|---|
| `runAsNonRoot: true` | ✅ | ✅ | ✅ |
| `runAsUser` | 1001 | 101 | 1001 |
| `readOnlyRootFilesystem: true` | ✅ | ✅ | ✅ |
| `allowPrivilegeEscalation: false` | ✅ | ✅ | ✅ |
| `capabilities.drop: [ALL]` | ✅ | ✅ | ✅ |
| `seccompProfile` | ✅ | ✅ | ✅ |
| Limites CPU/mémoire | ✅ | ✅ | ✅ |

`NetworkPolicy` présente (`templates/networkpolicies.yaml`).
Secrets injectés depuis `nexusrh-app-secrets` (`existingSecret`), pas en clair
dans les manifestes ; le modèle porte une annotation de politique de rotation à 30 j.

C'est un niveau de durcissement conforme aux *Pod Security Standards* « restricted ».

### 6.3 TLS et en-têtes

```
Protocole : TLSv1.3
Chiffrement : TLS_AES_256_GCM_SHA384
Émetteur : Let's Encrypt (CN=YR2)
Sujet : CN = nexusrh.openlabconsulting.com
Validité : 6 oct. 2026 → 4 janv. 2027   (renouvellement cert-manager automatique)
```

En-têtes du front en k8s :

```
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:;
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';
  upgrade-insecure-requests
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

CSP solide : `script-src 'self'` sans `unsafe-inline` ni `unsafe-eval`,
`object-src 'none'`, `frame-ancestors 'none'`. Le `'unsafe-inline'` sur `style-src`
est le compromis habituel de Tailwind et ne constitue pas un vecteur XSS exécutable.
Aucune fuite d'en-tête `Server` ou `X-Powered-By`.

**Remarque mineure** : `x-frame-options: SAMEORIGIN` est moins strict que
`frame-ancestors 'none'` de la CSP. Les navigateurs modernes privilégient la CSP,
donc l'effet réel est « aucune mise en cadre » ; aligner les deux sur `DENY`
éviterait toute ambiguïté sur un navigateur ancien.

### 6.4 Vérification en exécution sur l'environnement k8s

| Test | Résultat |
|---|---|
| `GET /employees` sans jeton | **401** |
| `GET /payroll/periods` sans jeton | **401** |
| `GET /settings/users` sans jeton | **401** |
| `GET /platform/tenants` sans jeton | **401** |
| `GET /docs` (Swagger) | **404 — correctement verrouillé** |
| `GET /docs/json` (spec OpenAPI) | **404 — correctement verrouillé** |
| `GET /health` | 200 |

Le verrouillage de Swagger est confirmé dans `app.ts:117-120` :

```ts
// OWASP A05 — Swagger /docs n'est servi qu'en dev (ou via ENABLE_DOCS=true) :
// ne pas divulguer toute la surface d'API en production.
if (config.enableDocs) { await fastify.register(swaggerPlugin) }
```

La surface d'API n'est donc pas divulguée hors développement. **Non-problème confirmé
par test**, et non par simple lecture de configuration.

### 6.5 Pare-feu applicatif (WAF)

ModSecurity est **actif et en mode blocage** sur le contrôleur ingress :

```
enable-modsecurity: "true"
enable-owasp-modsecurity-crs: "true"
SecRuleEngine On
SecDefaultAction "phase:1,log,auditlog,deny,status:403"
```

Les exceptions définies au niveau du contrôleur (désactivation du moteur sur
`/admin`, seuil d'anomalie relevé à 20) sont **limitées à l'hôte
`openlabconsulting.com`** et n'affectent pas NexusRH.

Annotations de l'ingress `nexusrh-ingress` :

```
force-ssl-redirect: "true"       ssl-redirect: "true"
limit-rps: "30"                  limit-connections: "10"
proxy-body-size: "50m"           proxy-connect-timeout: "10"
proxy-read-timeout: "60"         proxy-send-timeout: "60"
modsecurity-snippet: "SecRuleRemoveById 911100"
```

#### Constat — règle CRS 911100 retirée

**Gravité : Moyenne.**

La règle CRS **911100** (*Method is not allowed by policy*) est supprimée pour NexusRH.
L'historique du projet indique le motif : elle bloquait **tous** les `PUT`, `PATCH` et
`DELETE` en production, rendant l'application inutilisable. Le contournement est donc
compréhensible, mais il **désactive entièrement la politique de méthodes HTTP** au
niveau du WAF, au lieu de l'élargir.

**Correctif recommandé** — déclarer les méthodes autorisées plutôt que retirer la règle :

```
SecAction "id:900200,phase:1,nolog,pass,t:none,\
  setvar:'tx.allowed_methods=GET HEAD POST PUT PATCH DELETE OPTIONS'"
```

La politique reste alors appliquée (un `TRACE`, un `CONNECT` ou une méthode exotique
est toujours rejeté) tout en laissant passer le REST légitime.

**Risque opérationnel associé** : `nexusrh_ci/k8s/**` est modifié dans l'arbre de
travail git sans être commité. Committer cet état en l'état **supprimerait l'exception
WAF** et casserait à nouveau tous les `PUT`/`PATCH`/`DELETE` en production. Le
correctif ci-dessus doit être porté dans le chart **et** commité, pour que
l'état git et l'état du cluster convergent.

#### Autre remarque

`proxy-body-size: 50m` est généreux pour un SIRH. Les téléversements légitimes
(CV, photos, documents) dépassent rarement quelques mégaoctets. Combiné aux CVE
DoS de `@fastify/busboy` (§4.1), abaisser cette limite à `10m` — avec une
exception ciblée sur les routes d'import de fichiers volumineux si nécessaire —
réduirait la surface d'attaque à coût nul.

---

## 7. Ce qui n'a pas été testé

Pour que le périmètre du rapport soit sans ambiguïté :

| Non couvert | Raison |
|---|---|
| Déni de service / test de charge | Exclu volontairement : l'environnement sert des démonstrations client |
| Écritures inter-tenant (`PUT`/`PATCH`/`DELETE` croisés) | Les sondes de lecture suffisent à établir l'isolation sans risque pour les données réelles |
| Parcours MFA complet en k8s | Nécessite le secret TOTP des comptes de production (`.credentials-local.md`, accès refusé durant cette session) |
| Scan de vulnérabilités des images conteneur (Trivy) | Trivy absent de la machine ; la CI l'exécute déjà (job « SAST & Secrets ») |
| Scan de secrets dans l'historique git (gitleaks / trufflehog) | Outils absents de la machine ; Semgrep `p/secrets` n'a rien trouvé dans l'arbre courant |
| XSS stocké de bout en bout | Nécessite un pilotage navigateur sur données réelles ; la CSP `script-src 'self'` et React bloquent le vecteur principal |
| Sécurité des webhooks entrants (signature HMAC) | Nécessite les secrets de webhook par tenant |

---

## 8. Plan d'action

### Immédiat (cette semaine)

1. **Monter Fastify ≥ 5.12.5.** CVE-2026-76169 est un contournement d'authentification
   sur le mécanisme dont dépendent tout le RBAC et toute l'isolation tenant.
2. **Monter `undici` ≥ 7.30.1.** Deux contournements de validation de certificat TLS sur
   le chemin des paiements Mobile Money et du garde SSRF.
3. **Monter `@fastify/busboy` ≥ 3.2.2.** Injection CRLF atteignable depuis la route
   publique de dépôt de CV, sans authentification.
4. **Monter `tinypool` ≥ 2.1.2 et `vite` ≥ 6.4.4.** RCE dans la chaîne de test qui
   s'exécute avec les secrets de la CI.
5. **Rafraîchir `pnpm.overrides`** (§4.3) — le bloc actuel a dérivé et épingle des
   versions désormais vulnérables.

### Court terme (ce mois)

6. Monter `fast-uri` ≥ 3.1.9, `joi` ≥ 17.13.9, `fast-jwt` ≥ 6.3.4,
   `nodemailer` ≥ 10.1.4, `follow-redirects` ≥ 1.16.2, `brace-expansion`, `source-map-js`.
7. **Valider les UUID de paramètres de route** (§5.4) et ajouter le test de
   non-régression correspondant au balayage d'autorisation.
8. **Imposer `authTagLength: 16`** au déchiffrement AES-GCM (§3.1) — deux lignes.
9. **Remplacer `SecRuleRemoveById 911100`** par une déclaration de méthodes autorisées,
   et **commiter le chart** pour réconcilier git et cluster (§6.5).
10. Abaisser `proxy-body-size` à `10m` hors routes d'import.
11. Aligner `x-frame-options` sur `DENY`.

### À planifier (montées majeures)

12. `zod` 3.x → 4.x — cœur de la validation, à mener avec la suite de 7 242 tests comme filet.
13. `react-router` 6.x → 7.x — touche le prérendu SSR.
14. Installer **Trivy** et **gitleaks** en local pour pouvoir reproduire le job CI
    « SAST & Secrets » hors CI, et scanner les images conteneur.
15. Créer un **véritable namespace de test** sur le cluster (`nexusrh-staging`), afin que
    les futurs tests d'intrusion ne visent plus l'environnement qui sert les démonstrations.
    L'overlay `k8s/overlays/staging/` existe déjà mais son DNS n'est pas provisionné.

---

## 9. Conclusion

Le code de NexusRH résiste aux tests. Les contrôles qui comptent dans un SIRH SaaS
multi-tenant — l'isolation entre clients, le RBAC, l'anti-énumération, la validation
stricte, la limitation de débit, le durcissement des conteneurs — sont non seulement
présents mais **vérifiés en exécution sur données réelles**, et protégés contre la
régression par 898 tests dédiés et un balayage d'autorisation qui énumère
automatiquement toutes les routes.

Le dispositif le plus remarquable est `security-authz-sweep.golden.test.ts` : en
imposant qu'une route publique soit inscrite explicitement dans une liste
d'autorisation, il transforme l'ouverture d'un endpoint en décision revue plutôt
qu'en accident possible. Peu de projets de cette taille ont cet invariant.

La faiblesse est ailleurs, et elle est classique : **la chaîne de dépendances a
dérivé**. 2 critiques et 32 élevés, dont un contournement d'authentification Fastify
et deux contournements de validation de certificat TLS, sont corrigés en amont mais
pas encore appliqués ici. Le `pnpm.overrides` qui servait précisément à épingler les
versions corrigées est devenu obsolète et épingle aujourd'hui des versions vulnérables —
c'est le genre de dette qui se paie en silence.

Aucune de ces montées de version n'est risquée, et la suite de tests existante les
couvre. **Le volet §8 « Immédiat » refermerait l'essentiel du risque résiduel de cette
application en une demi-journée de travail.**

---

*Rapport produit le 19 novembre 2026. Tests exécutés par Claude Code sur autorisation
du propriétaire de l'application et de l'infrastructure. Environnements : local
(application démarrée, base seedée) et k8s `nexusrh-ci` sur `nexusrh-preprod`.*
