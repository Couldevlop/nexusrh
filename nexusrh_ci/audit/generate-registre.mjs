/**
 * Génère `audit/2026-08-30-registre-vulnerabilites.xlsx` — le registre des
 * vulnérabilités relevées lors de l'audit d'intrusion du 29-30/08/2026 et de
 * leurs correctifs.
 *
 * Regénérable : `node audit/generate-registre.mjs` (depuis la racine du dépôt).
 * Le classeur est un LIVRABLE versionné ; ce script en est la source de vérité,
 * de sorte qu'une mise à jour du registre se relise en diff.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// exceljs est une dépendance de l'API (utilisée par le module bank-transfer) :
// on la résout depuis ce workspace plutôt que d'en ajouter une à la racine.
const require = createRequire(import.meta.url)
const ExcelJS = require(require.resolve('exceljs', { paths: [join(HERE, '..', 'apps', 'api')] }))

// ── Palette ────────────────────────────────────────────────────────────────
const INK       = 'FF14201E'
const ACCENT    = 'FF0D5A52'
const HEAD_BG   = 'FF0D5A52'
const ZEBRA     = 'FFF2F6F5'
const SEV = {
  'Critique': { bg: 'FFF6E4E4', fg: 'FF8C1D1D' },
  'Élevée':   { bg: 'FFF8EADD', fg: 'FFA3501A' },
  'Moyenne':  { bg: 'FFF6EFD8', fg: 'FF7A5E0E' },
  'Faible':   { bg: 'FFE2EDF4', fg: 'FF2F5F80' },
  'Info':     { bg: 'FFEDF1F0', fg: 'FF475653' },
}
const STATUT = {
  'Corrigé':          { bg: 'FFDFEDE7', fg: 'FF1B6144' },
  'Corrigé (partiel)':{ bg: 'FFF6EFD8', fg: 'FF7A5E0E' },
  'Non applicable':   { bg: 'FFE2EDF4', fg: 'FF2F5F80' },
  'Accepté':          { bg: 'FFEDF1F0', fg: 'FF475653' },
}

const wb = new ExcelJS.Workbook()
wb.creator = 'Audit sécurité NexusRH CI'
wb.created = new Date('2026-08-30')

/** Applique l'habillage commun : en-tête, filtre, zébrage, bordures. */
function dress(ws, headers, rows, widths) {
  ws.columns = headers.map((h, i) => ({ header: h, key: `c${i}`, width: widths[i] }))
  rows.forEach(r => ws.addRow(r))

  const head = ws.getRow(1)
  head.height = 26
  head.eachCell(c => {
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
    c.border = { bottom: { style: 'medium', color: { argb: ACCENT } } }
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    row.alignment = { vertical: 'top', wrapText: true }
    row.font = { size: 10, name: 'Calibri', color: { argb: INK } }
    row.eachCell(c => {
      c.border = { bottom: { style: 'hair', color: { argb: 'FFD3DBD9' } } }
      if (r % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }
    })
  }
  return ws
}

/** Colore une colonne selon un dictionnaire de badges. */
function badge(ws, colIndex, dict) {
  for (let r = 2; r <= ws.rowCount; r++) {
    const c = ws.getRow(r).getCell(colIndex)
    const s = dict[String(c.value)]
    if (!s) continue
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } }
    c.font = { bold: true, size: 10, name: 'Calibri', color: { argb: s.fg } }
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. SYNTHÈSE
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet('Synthèse', { properties: { tabColor: { argb: ACCENT } } })
  ws.columns = [{ width: 46 }, { width: 20 }, { width: 20 }, { width: 58 }]

  ws.mergeCells('A1:D1')
  const t = ws.getCell('A1')
  t.value = 'NexusRH CI — Audit d’intrusion et remédiation'
  t.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  ws.getRow(1).height = 40

  ws.mergeCells('A2:D2')
  const s = ws.getCell('A2')
  s.value = 'Périmètre : nexusrh_ci (API, web, worker) · branche develop · 29–30 août 2026'
  s.font = { size: 11, italic: true, color: { argb: 'FF475653' } }
  ws.getRow(2).height = 22

  const bloc = (titre, lignes) => {
    ws.addRow([])
    const h = ws.addRow([titre])
    h.getCell(1).font = { bold: true, size: 12, color: { argb: ACCENT } }
    h.height = 22
    const head = ws.addRow(['Indicateur', 'Avant', 'Après', 'Commentaire'])
    head.eachCell(c => {
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
    })
    lignes.forEach(l => {
      const r = ws.addRow(l)
      r.alignment = { vertical: 'top', wrapText: true }
      r.getCell(2).alignment = { horizontal: 'center' }
      r.getCell(3).alignment = { horizontal: 'center' }
      r.getCell(3).font = { bold: true, color: { argb: 'FF1B6144' } }
    })
  }

  bloc('Vulnérabilités applicatives', [
    ['Constats de sécurité ouverts', 7, 0, 'Les 7 constats sont traités : 5 corrigés dans le code, 2 qualifiés non applicables preuves à l’appui'],
    ['Endpoints atteignables sans jeton', 0, 0, 'Déjà conforme avant l’audit — vérifié sur les 450 routes'],
    ['Contrôles de sécurité non exécutés', 1, 0, 'isMagicByteConsistent : écrit, testé, jamais appelé'],
    ['Évaluateurs de code dynamique', 1, 0, 'new Function() remplacé par un analyseur arithmétique'],
  ])

  bloc('Dépendances (pnpm audit)', [
    ['Total des avis', 118, 2, 'Réduction de 98 %'],
    ['Critiques', 4, 0, '3 non exploitables (fast-jwt) + vitest, tous éliminés par montée de version'],
    ['Élevées', 50, 0, 'Fastify 5, axios, undici, nodemailer, drizzle-orm, overrides transitifs'],
    ['Moyennes', 56, 2, 'Les 2 restantes : react-router, prouvées non applicables (pas de SSR, pas de navigation contrôlée par l’utilisateur)'],
    ['Faibles', 8, 0, ''],
  ])

  bloc('Architecture', [
    ['Implémentations de la piste d’audit', 47, 1, '4 exceptions documentées, au jeu de colonnes réellement différent'],
    ['Définitions locales de badRequest()', 11, 1, 'La variante Zod d’offboarding est conservée (autre contrat d’API)'],
    ['Hooks de migration recopiés', 22, 0, 'Un hook partagé, une seule contrainte d’ordonnancement à respecter'],
    ['Services orphelins (code mort)', 1, 0, 'cv-extraction.service.ts, qui portait un contrôle de sécurité'],
  ])

  bloc('Vérification', [
    ['Tests automatisés', 4805, 4835, '+30 tests : sécurité, antivirus, invariants d’architecture'],
    ['Fichiers de tests', 240, 243, ''],
    ['Suites en échec', 0, 0, 'API 4626 · web 132 · worker 77'],
    ['Typecheck / build', 'OK', 'OK', 'tsc --noEmit 3/3 · turbo build 3/3'],
  ])
}

// ══════════════════════════════════════════════════════════════════════════
// 2. VULNÉRABILITÉS
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet('Vulnérabilités')
  const rows = [
    ['S-01', 'Élevée', 'A03 — Injection / usurpation de contenu',
     'Contrôle anti-usurpation de fichier jamais exécuté',
     'modules/recruitment/recruitment.routes.ts · services/cv-extraction.service.ts',
     'isMagicByteConsistent() était documenté OWASP A03 et couvert par 21 tests, mais son service n’était importé nulle part : le fichier de routes hébergeait une copie tronquée. Le dépôt public et ANONYME de CV ne vérifiait donc que le type MIME déclaré par le client. Tout binaire annoncé application/pdf était stocké, puis servi à un poste RH en Content-Disposition: inline.',
     'grep -rn "cv-extraction" → aucun import. Service entièrement mort.',
     'Corrigé',
     'Copie locale supprimée, service importé, contrôle câblé sur les DEUX points de dépôt (public anonyme et RH authentifié).',
     '4 tests attaquant l’endpoint public réel : exécutable Windows, HTML et ZIP déguisés rejetés, vrai PDF accepté.',
     'modules/recruitment/cv-upload-signature.golden.test.ts'],

    ['S-02', 'Élevée', 'A07 — Défaut d’authentification',
     'Rate limiting réinitialisable via X-Forwarded-For',
     'app.ts · config.ts',
     'trustProxy: true fait confiance à TOUS les intermédiaires : request.ip suivait alors l’en-tête X-Forwarded-For fourni par le client. Le limiteur comptant par request.ip, un attaquant remettait son compteur à zéro à chaque requête, neutralisant les protections anti-force-brute du login (10/5 min) et du mot de passe oublié (3/15 min).',
     'Mesuré sur l’application montée : 260 requêtes avec XFF tournant → 0 bloquée ; avec XFF fixe → 60 bloquées (429).',
     'Corrigé',
     'trustProxy borné aux plages PRIVÉES (loopback, uniquelocal), paramétrable par TRUST_PROXY. Une connexion publique directe n’est plus un intermédiaire de confiance : son en-tête est ignoré en bloc.',
     '3 tests : la limite du login résiste à un XFF tournant ; un XFF forgé en exposition directe est ignoré ; trustProxy n’est jamais `true`.',
     'security-hardening-2026-08.golden.test.ts'],

    ['S-03', 'Élevée', 'A06 — Composants obsolètes',
     'Fastify 4.29.1 — branche en fin de vie, contournement de validation sans correctif',
     'apps/api (framework HTTP)',
     '4.29.1 est la DERNIÈRE version 4.x publiée. La faille « caractère tabulation dans Content-Type permettant de contourner la validation du corps » n’est corrigée qu’en 5.7.2. La validation Zod et les schémas de route étant la première ligne de défense des 450 endpoints, un contournement les court-circuite.',
     'npm view fastify versions → aucune 4.x postérieure à 4.29.1.',
     'Corrigé',
     'Migration Fastify 4 → 5.12.1 avec les 10 plugins associés (jwt 8→10, cors 9→11, cookie 9→11, multipart 8→9, oauth2 7→8, rate-limit 9→10, swagger 8→9, swagger-ui 4→6, websocket 8→11, fastify-plugin 4→5). maxParamLength déplacé sous routerOptions (déprécié en v5).',
     'Aucune API retirée n’était utilisée. 4626 tests API verts après migration.',
     'app.ts · plugins/*.ts'],

    ['S-04', 'Élevée', 'A06 — Composants obsolètes',
     '118 vulnérabilités de dépendances',
     'apps/api · apps/web · apps/worker · racine',
     'Quatre paquets à impact réel : axios (front, 7 avis dont vol d’identifiants et MITM par pollution de prototype), undici (dépendance directe ET moteur du garde SSRF, contournement de validation TLS), nodemailer (DoS de l’analyseur d’adresses, alimenté par des adresses saisies par les tenants), drizzle-orm (injection SQL par identifiants mal échappés). Le reste était transitif.',
     'pnpm audit : 4 critiques, 50 élevées, 56 moyennes, 8 faibles.',
     'Corrigé',
     'axios 1.15→1.20 · undici 7.25→7.29 · nodemailer 6→9 · drizzle-orm 0.31→0.45 · vitest 1→3 · turbo 1→2 · drizzle-kit 0.22→0.31 · tsx 4.21→4.23 · mjml SUPPRIMÉ (dépendance morte portant un avis élevé sans correctif) · 12 overrides pnpm pour les transitives.',
     'pnpm audit : 118 → 2. Suites complètes et build vérifiés après chaque montée.',
     'package.json (pnpm.overrides) · apps/*/package.json'],

    ['S-05', 'Moyenne', 'A08 — Défaut d’intégrité',
     'Aucune analyse antivirale sur les dépôts de fichiers',
     '7 points de dépôt, dont un anonyme',
     'Taille, type MIME et — depuis S-01 — signature de contenu sont vérifiés ; la CHARGE ne l’était pas. Un PDF authentique porteur d’un exploit de lecteur, ou un document macro-armé, atteignait le poste RH qui le télécharge.',
     'Revue des 7 handlers de dépôt : aucun appel d’analyse.',
     'Corrigé',
     'services/antivirus.service.ts — protocole clamd INSTREAM natif, sans nouvelle dépendance. Câblé sur les 7 dépôts. Désactivé par défaut (CLAMAV_HOST vide) ; une fois activé, un fichier NON analysable est REFUSÉ (échec fermé délibéré).',
     '9 tests contre un faux clamd en mémoire : fichier propre accepté, infecté refusé, injoignable refusé, délai dépassé refusé, découpage en blocs, signature non divulguée à l’utilisateur.',
     'services/antivirus.service.test.ts'],

    ['S-06', 'Moyenne', 'A03 — Injection',
     'Évaluateur new Function() dans le moteur de paie',
     'services/payroll-engine-ci.ts',
     'evalFormule() construisait une fonction JavaScript à partir d’une chaîne issue de payroll_rules.formula. Non exploitable en l’état (la liste blanche interdisait guillemets, virgules et crochets, et la fonction n’était pas encore appelée par le moteur), mais c’était un évaluateur non cloisonné en attente d’être branché sur une donnée modifiable par un administrateur de tenant.',
     'Revue de code : new Function(`return (${expr})`).',
     'Corrigé',
     'Remplacé par evalArithmetic() — analyseur par descente récursive (+ - * / parenthèses, unaire). Il ne peut construire QUE des nombres : aucun identifiant, appel ou portée JavaScript n’est atteignable, quelle que soit l’entrée.',
     '3 tests : non-régression arithmétique, 12 entrées hostiles retombant à 0, absence de trace globale. Invariant golden interdisant new Function()/eval() côté serveur.',
     'security-hardening-2026-08.golden.test.ts · architecture-invariants.golden.test.ts'],

    ['S-07', 'Info', 'A02 — Défaillance cryptographique',
     'Algorithme JWT déduit et non épinglé',
     'plugins/auth.ts',
     'pnpm audit remontait 3 CVE CRITIQUES sur fast-jwt. Vérification faite dans le code du paquet : AUCUNE n’était exploitable ici — la confusion d’algorithme exige une clé publique (le secret est symétrique, ce qui restreint de fait à HS256/384/512), la confusion de cache exige l’option cache (non activée), le secret HMAC vide exige un fournisseur de clé asynchrone (secret statique, ≥ 32 caractères imposés).',
     'Lecture de fast-jwt/src/verifier.js et crypto.js.',
     'Corrigé',
     'Algorithme épinglé explicitement : sign { algorithm: HS256 }, verify { algorithms: [HS256] }. La protection est désormais affirmée par la configuration, non déduite du type de la clé.',
     '3 tests : les jetons émis sont en HS256 ; alg:none rejeté ; jeton HS512 signé avec le VRAI secret rejeté.',
     'security-hardening-2026-08.golden.test.ts'],
  ]
  dress(ws,
    ['ID', 'Sévérité', 'Catégorie OWASP', 'Titre', 'Composant', 'Description', 'Preuve', 'Statut', 'Correctif appliqué', 'Vérification', 'Fichier de test'],
    rows,
    [7, 12, 26, 34, 34, 62, 34, 16, 56, 46, 40])
  badge(ws, 2, SEV)
  badge(ws, 8, STATUT)
  ws.getColumn(6).alignment = { wrapText: true, vertical: 'top' }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. DÉPENDANCES
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet('Dépendances')
  const rows = [
    ['fastify', '4.29.1', '5.12.1', 'Élevée', 'Production', 'Contournement de validation du corps via tabulation dans Content-Type', 'Corrigé', 'Branche 4.x en fin de vie : aucun correctif possible sans montée majeure'],
    ['@fastify/jwt', '8.0.1', '10.2.2', 'Critique', 'Production', 'fast-jwt : confusion d’algorithme, confusion de cache, secret HMAC vide', 'Corrigé', 'Les 3 CVE étaient non exploitables dans cette configuration (cf. S-07) ; montée + épinglage HS256'],
    ['axios', '1.15.0', '1.20.0', 'Élevée', 'Production (web)', '7 avis : vol d’identifiants, MITM, injection d’en-tête, ReDoS, fuite Proxy-Authorization', 'Corrigé', 'Exécuté chez chaque utilisateur du front'],
    ['undici', '7.25.0', '7.29.0', 'Élevée', 'Production', 'Contournement de validation TLS, routage inter-origines via SOCKS5, DoS WebSocket', 'Corrigé', 'Dépendance directe ET moteur du garde SSRF'],
    ['nodemailer', '6.10.1', '9.0.6', 'Élevée', 'Production', 'DoS par récursion de l’analyseur d’adresses ; option raw contournant disableFileAccess', 'Corrigé', 'Usage confiné à createTransport + sendMail : montée de 3 majeures sans adaptation'],
    ['drizzle-orm', '0.31.4', '0.45.2', 'Élevée', 'Production', 'Injection SQL via identifiants mal échappés', 'Corrigé', ''],
    ['mjml', '4.18.0', '(supprimé)', 'Élevée', 'Production', 'html-minifier : ReDoS SANS correctif disponible ; js-cookie : détournement de prototype', 'Corrigé', 'Dépendance DÉCLARÉE mais importée nulle part — sa suppression élimine un avis autrement incorrigible'],
    ['@fastify/swagger-ui', '4.2.0', '6.1.1', 'Élevée', 'Production', '@fastify/static : contournement de garde de route par traversée de chemin', 'Corrigé', ''],
    ['vitest', '1.6.1', '3.2.7', 'Critique', 'Développement', 'Lecture et exécution de fichier arbitraire quand le serveur Vitest UI écoute', 'Corrigé', '4626 tests verts après montée, 5 fichiers de tests ajustés au typage plus strict des mocks'],
    ['turbo', '1.13.4', '2.10.12', 'Moyenne', 'Développement', 'Avis moyen + faible sur l’orchestrateur de build', 'Corrigé', 'turbo.json migré : "pipeline" → "tasks"'],
    ['drizzle-kit', '0.22.8', '0.31.10', 'Moyenne', 'Développement', 'esbuild 0.18 via @esbuild-kit (déprécié)', 'Corrigé', 'Complété par un override esbuild ^0.25.12'],
    ['tsx', '4.21.0', '4.23.12', 'Faible', 'Développement', 'esbuild', 'Corrigé', ''],
    ['fast-uri', '3.1.0', '^3.1.5', 'Élevée', 'Production', 'Confusion d’hôte, traversée de chemin (5 avis)', 'Corrigé', 'Override pnpm — le parent (@fastify/swagger) ne l’a pas encore embarqué'],
    ['brace-expansion', '1.1.14 / 2.1.0', '^1.1.18 / ^2.1.4', 'Élevée', 'Production', 'DoS par expansion non bornée (6 avis)', 'Corrigé', 'Override pnpm sur les deux branches majeures'],
    ['ws', '8.20.0', '^8.21.3', 'Élevée', 'Production', 'DoS par épuisement mémoire', 'Corrigé', 'Override pnpm'],
    ['fast-xml-builder', '1.1.4', '^1.1.7', 'Élevée', 'Production', 'Contournement d’échappement des valeurs d’attributs', 'Corrigé', 'Override pnpm (via @aws-sdk/client-s3)'],
    ['@hapi/wreck', '18.1.0', '^18.1.2', 'Moyenne', 'Production', '2 avis (via @fastify/oauth2 → simple-oauth2)', 'Corrigé', 'Override pnpm'],
    ['joi', '17.13.3', '^17.13.4', 'Moyenne', 'Production', 'via simple-oauth2', 'Corrigé', 'Override pnpm'],
    ['uuid', '11.1.0', '^11.1.1', 'Moyenne', 'Production', 'via bullmq', 'Corrigé', 'Override pnpm'],
    ['@opentelemetry/core', '2.7.1', '^2.8.0', 'Moyenne', 'Production', 'via @elastic/elasticsearch', 'Corrigé', 'Override pnpm'],
    ['js-cookie', '3.0.5', '^3.0.8', 'Élevée', 'Production', 'Détournement de prototype par instance', 'Corrigé', 'Override pnpm ; la source (mjml) a par ailleurs été supprimée'],
    ['postcss / nanoid / js-yaml / @babel/core', 'diverses', 'épinglées', 'Élevée / Faible', 'Développement', 'Lecture de fichier arbitraire, boucles infinies, CPU quadratique', 'Corrigé', 'Overrides pnpm'],
    ['react-router / react-router-dom', '6.30.6', '6.30.6', 'Moyenne', 'Production (web)', 'Redirection ouverte via antislash dans <Link>/useNavigate ; injection de constructeur via deserializeErrors() en hydratation SSR', 'Non applicable', 'AUCUNE hydratation SSR dans l’application (createBrowserRouter, RouterProvider, hydrateRoot, StaticRouter tous absents) et les 2 seules navigations dynamiques ont un chemin en dur. Le correctif exige react-router 7 : migration front à risque de régression réel, pour zéro réduction de risque ici.'],
  ]
  dress(ws,
    ['Paquet', 'Avant', 'Après', 'Sévérité', 'Portée', 'Vulnérabilité', 'Statut', 'Note'],
    rows,
    [30, 18, 18, 14, 20, 58, 18, 76])
  badge(ws, 4, SEV)
  badge(ws, 7, STATUT)
}

// ══════════════════════════════════════════════════════════════════════════
// 4. ARCHITECTURE
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet('Architecture')
  const rows = [
    ['A-01', 'Duplication', 'Piste d’audit recopiée 47 fois', '47 sites d’écriture', '1 implémentation + 4 exceptions documentées',
     '33 fichiers de routes hébergeaient leur propre fonction d’audit, plus 15 appels en ligne. 31 corps étaient rigoureusement identiques. Les variantes avaient déjà divergé : validation du nom de schéma présente dans une seule copie.',
     'utils/audit-log.ts — auditTenant() / auditPlatform() / activityPlatform(). Validation du schéma systématique. Les fonctions locales subsistent en adaptateurs d’une ligne, ce qui laisse tous les appelants inchangés.',
     'Corrigé', 'Invariant golden : toute nouvelle écriture directe fait échouer la suite'],
    ['A-02', 'Duplication', 'badRequest() redéfini 11 fois', '11 définitions', '1 + 1 variante justifiée',
     'Onze fichiers déclaraient la même fonction. Les variantes divergeaient déjà (message par défaut présent ici, obligatoire là), produisant des réponses différentes pour la même situation métier selon le module.',
     'utils/http-errors.ts — badRequest() et badRequestFromZod(). La variante d’offboarding est conservée : sa réponse a un AUTRE contrat (issues/field), consommé tel quel par le front.',
     'Corrigé', 'Invariant golden'],
    ['A-03', 'Duplication à conséquence', 'Hook de migration paresseuse recopié 22 fois', '22 copies', '1 hook partagé',
     'Le hook doit s’exécuter APRÈS authenticate, sinon request.user n’est pas résolu et la migration ne se fait jamais — incident déjà survenu sur ce dépôt le 19/07/2026. Avec 22 copies, cette contrainte devait être respectée 22 fois sans que rien ne la rappelle.',
     'utils/tenant-schema-hook.ts — ensureTenantSchemaHook, contrainte d’ordonnancement documentée en un seul endroit.',
     'Corrigé', 'Invariant golden'],
    ['A-04', 'Code mort', 'Service orphelin portant un contrôle de sécurité', '1 service mort', '0',
     'services/cv-extraction.service.ts n’était importé nulle part : le fichier de routes en avait recopié la fonction d’extraction, laissant le contrôle isMagicByteConsistent hors du chemin d’exécution. Ses 21 tests passaient et la couverture restait intacte pendant que la protection ne s’appliquait pas. C’est le mode de défaillance central de cet audit.',
     'Service importé, copie locale supprimée, contrôle câblé (cf. S-01).',
     'Corrigé', 'Invariant golden : détecte tout service jamais importé, en tenant compte des points d’entrée déclarés dans package.json'],
    ['A-05', 'Couplage', 'Persistance dans la couche HTTP', '872 requêtes SQL dans les handlers · 25 086 lignes de routes contre 7 268 de services · 1 seul repository', 'Inchangé — chantier de fond',
     'Les routes dépendent du Pool pg concret et non d’une abstraction. Toute évolution transverse de la persistance (Row Level Security, cache, traçabilité systématique) se paierait en 872 modifications. L’isolation multi-tenant est réaffirmée à la main 853 fois — correcte à 100 %, mais garantie par la répétition. NOTE : le nom de schéma est validé centralement dans plugins/auth.ts, l’invariant n’est donc pas troué, seulement fragile.',
     'NON traité : la migration des 872 sites ne peut pas se faire sans risque de régression dans le cadre de cet audit. Direction recommandée : introduire <module>.repository.ts sur les NOUVEAUX modules et sur ceux déjà ouverts, sans réécriture de masse.',
     'Accepté', 'Signalé comme chantier à planifier — hors périmètre d’une remédiation sans régression'],
  ]
  dress(ws,
    ['ID', 'Nature', 'Constat', 'Avant', 'Après', 'Détail', 'Correctif', 'Statut', 'Protection contre la récidive'],
    rows,
    [7, 24, 46, 40, 34, 76, 68, 18, 46])
  badge(ws, 8, STATUT)
}

// ══════════════════════════════════════════════════════════════════════════
// 5. TESTS AJOUTÉS
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet('Tests ajoutés')
  const rows = [
    ['security-authz-sweep.golden.test.ts', 5, 'Balayage d’autorisation exhaustif',
     'Les 450 routes appelées sans jeton, avec un JWT forgé, avec un jeton employee. Toute nouvelle route publique doit être ajoutée à une liste explicite : ouvrir un endpoint devient un acte revu.'],
    ['modules/recruitment/cv-upload-signature.golden.test.ts', 4, 'Signature des fichiers déposés (S-01)',
     'Attaque l’endpoint public réel avec un exécutable Windows, du HTML et une archive ZIP déguisés en PDF ; vérifie qu’un vrai PDF passe toujours.'],
    ['security-hardening-2026-08.golden.test.ts', 9, 'Durcissements S-02, S-06, S-07',
     'Rejoue chaque vulnérabilité plutôt que d’inspecter la configuration : remettre trustProxy: true, retirer l’épinglage d’algorithme ou réintroduire un évaluateur de code fait échouer la suite.'],
    ['services/antivirus.service.test.ts', 9, 'Antivirus des dépôts (S-05)',
     'Un faux clamd en mémoire répond au protocole INSTREAM : le client réel est testé, pas un mock de lui-même. Couvre l’échec fermé (injoignable, délai dépassé).'],
    ['architecture-invariants.golden.test.ts', 5, 'Invariants d’architecture (A-01 à A-04)',
     'Échoue quand un module recopie une primitive partagée, laisse un service orphelin ou réintroduit new Function()/eval() — au moment de la revue, pas six mois plus tard.'],
  ]
  dress(ws, ['Fichier', 'Tests', 'Objet', 'Ce qu’il verrouille'], rows, [56, 10, 44, 96])
  ws.addRow([])
  const tot = ws.addRow(['TOTAL', 32, '', 'Suite complète après remédiation : API 4626 · web 132 · worker 77 = 4835 tests, 0 échec'])
  tot.font = { bold: true, color: { argb: ACCENT } }
}

const out = join(HERE, '2026-08-30-registre-vulnerabilites.xlsx')
await wb.xlsx.writeFile(out)
console.log('Écrit :', out)
