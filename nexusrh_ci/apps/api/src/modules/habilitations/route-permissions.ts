/**
 * Habilitations RH — table de correspondance route → case de la grille.
 *
 * `authorize()` (plugins/auth.ts) l'utilise pour les utilisateurs habilités :
 * une route RH n'est ouverte que si la case (fonction, action) résolue ici est
 * cochée dans leurs droits effectifs. Une route sans correspondance est REFUSÉE
 * aux habilités (fermé par défaut) ; le test d'invariant
 * (route-permissions.test.ts) garantit qu'aucune route RH n'est dans ce cas.
 *
 * Résolution, dans l'ordre :
 *  0. table des exceptions (EXACT_ROUTES) ;
 *  1. fonction par préfixe d'URL (le plus long gagne) ;
 *  2. action par verbe HTTP (GET → view, POST → create, PUT/PATCH → update,
 *     DELETE → delete) ;
 *  3. surcharges par suffixe (dernier segment littéral de l'URL) ;
 *  4. aucune case de repli : si l'action obtenue n'existe pas dans la grille
 *     de la fonction (`HAB_GRID`), la route n'a PAS de correspondance (`null`,
 *     refusée aux habilités). Le test d'invariant l'interdit pour toute route
 *     RH : chaque cas particulier est écrit explicitement (EXACT_ROUTES,
 *     CONFIG_PREFIXES).
 */
import { HAB_GRID, type HabAction, type HabFunction } from './catalog.js'

/** Rôles RH dont l'accès passe par la grille dès qu'une affectation existe. */
export const HR_GRID_ROLES = ['hr_manager', 'hr_officer', 'raf_site'] as const

export interface RoutePermission {
  fn: HabFunction
  action: HabAction
}

/**
 * Préfixes d'URL → fonction. Choix (spec §5.3 et §6 bis) :
 *  - organigramme, vue DG et tableau de bord → reporting ;
 *  - export SAGE → payroll ; classification et référentiels → hr_settings ;
 *  - simulations d'entretien → recruitment ; marque employeur → climate ;
 *  - carrières, compétences, mobilité, succession, calibrage → talent ;
 *  - propositions de contrat (y compris sous /recruitment, cf. FUNCTION_PATTERNS)
 *    et contrats signés → contracts ;
 *  - paramètres de paie (éléments variables, modèle de bulletin, législation)
 *    → payroll ; paramètres Mobile Money → payments ; le reste de /settings,
 *    dont les rubriques (`payroll-rules`, spec §5.3 « Paramétrage RH ») et les
 *    imports en masse → hr_settings ;
 *  - référentiels plateforme lisibles par le tenant : packs pays → hr_settings,
 *    plateformes de sourcing → recruitment ;
 *  - IA : génération de documents (CDI/CDD/certificat) → contracts, analyse de
 *    rétention → talent (l'assistant conversationnel : cf. EXACT_ROUTES).
 */
const PREFIXES: ReadonlyArray<readonly [string, HabFunction]> = [
  ['/employees', 'employees'],
  ['/contracts', 'contracts'],
  ['/absences', 'absences'],
  ['/attendance', 'attendance'],
  ['/payroll', 'payroll'],
  ['/sage', 'payroll'],
  ['/payroll-workflow', 'payroll_multi'],
  ['/cnps', 'declarations'],
  ['/disa', 'declarations'],
  ['/bank-transfer', 'payments'],
  ['/mobile-money', 'payments'],
  ['/expenses', 'expenses'],
  ['/recruitment', 'recruitment'],
  ['/interview-sim', 'recruitment'],
  ['/onboarding', 'lifecycle'],
  ['/offboarding', 'lifecycle'],
  ['/discipline', 'discipline'],
  ['/training', 'training'],
  ['/careers', 'talent'],
  ['/competencies', 'talent'],
  ['/mobility', 'talent'],
  ['/succession', 'talent'],
  ['/calibration', 'talent'],
  ['/climate', 'climate'],
  ['/employer-brand', 'climate'],
  ['/signature', 'signature'],
  ['/reporting', 'reporting'],
  ['/org-chart', 'reporting'],
  ['/dg', 'reporting'],
  ['/settings', 'hr_settings'],
  ['/settings/variable-elements', 'payroll'],
  ['/settings/payslip-template', 'payroll'],
  ['/settings/legislation', 'payroll'],
  ['/settings/mobile-money', 'payments'],
  ['/classification', 'hr_settings'],
  ['/referentiels', 'hr_settings'],
  ['/platform/country-configs', 'hr_settings'],
  ['/platform/sourcing', 'recruitment'],
  ['/ai/generate-document', 'contracts'],
  ['/ai/retention', 'talent'],
]

/**
 * Routes dont l'action ne se déduit pas du verbe. L'assistant IA est un POST
 * de LECTURE : ouvert à qui consulte les indicateurs ; ses outils ne
 * renvoient que ce que le moteur autorise (spec §6 bis).
 */
export const EXACT_ROUTES: Readonly<Record<string, RoutePermission>> = {
  'POST /ai/chat': { fn: 'reporting', action: 'view' },
  // Paie : annuler une demande de clôture relève du même droit que la lancer.
  'POST /payroll/periods/:month/cancel': { fn: 'payroll', action: 'close' },
  // Paie multi-filiales : la grille n'a que 6 cases pour 4 populations (RAF de
  // site, gestionnaire RH, DRH). Répartition qui reproduit EXACTEMENT les rôles
  // historiques des routes (aucun gain à la reprise ; séparation des tâches : un
  // RAF ne valide jamais sa propre soumission). Écart assumé avec la spec §6 bis
  // (« le rôle raf devient Valider »), arbitré le 04/11 :
  //   view     : liste et chronologie (gestionnaire RH et RAF) ;
  //   update   : tout ce que fait le RAF (variables, état de préparation,
  //              validation d'une variable, soumission) ;
  //   validate : décision du gestionnaire RH (workflow, approuver, rejeter) ;
  //   close    : clôture ;
  //   create   : opérations réservées DRH (créer, envoyer aux sites, validation
  //              centrale, annulation).
  'POST /payroll-workflow/periods/:id/cancel': { fn: 'payroll_multi', action: 'create' },
  'POST /payroll-workflow/periods/:id/submit-by-raf': { fn: 'payroll_multi', action: 'update' },
  'POST /payroll-workflow/periods/:id/variables/:employeeId/validate': { fn: 'payroll_multi', action: 'update' },
  'GET /payroll-workflow/periods/:id/readiness': { fn: 'payroll_multi', action: 'update' },
  'GET /payroll-workflow/periods/:id/variables': { fn: 'payroll_multi', action: 'update' },
  'GET /payroll-workflow/periods/:id/workflow': { fn: 'payroll_multi', action: 'validate' },
  'POST /payroll-workflow/periods/:id/validate-central': { fn: 'payroll_multi', action: 'create' },
  // Paiements : exécuter une campagne ou relancer un paiement = payer ;
  // vérifier un numéro = consulter.
  'POST /mobile-money/campaigns/:reference/execute': { fn: 'payments', action: 'pay' },
  'PATCH /mobile-money/payments/:id/retry': { fn: 'payments', action: 'pay' },
  'POST /mobile-money/verify-number': { fn: 'payments', action: 'view' },
  // Fichier de virement généré (GET) = export.
  'GET /bank-transfer/file': { fn: 'payments', action: 'export' },
  // Aperçu du bulletin : lecture.
  // (réservé DRH : voir « Routes réservées au DRH » plus bas pour la case).
  'POST /settings/payslip-template/preview': { fn: 'payroll', action: 'configure' },
  // Import en masse (employés, bulletins, contrats…) : opération de paramétrage.
  'POST /settings/import/:type': { fn: 'hr_settings', action: 'configure' },
  // Notes de frais : la soumission est une saisie, pas une clôture.
  'PATCH /expenses/:id/submit': { fn: 'expenses', action: 'update' },
  // Dossier employé : la photo modifie la fiche.
  'POST /employees/:id/photo': { fn: 'employees', action: 'update' },
  // Contrats : rupture = modification du contrat existant.
  'POST /contracts/:id/terminate': { fn: 'contracts', action: 'validate' },
  // Signature : envoyer une demande relève de sa gestion (l'annuler : DRH, plus bas).
  'POST /signature/requests/:id/send': { fn: 'signature', action: 'update' },
  // Remboursement d'une note de frais = paiement.
  'PATCH /expenses/:id/pay': { fn: 'payments', action: 'pay' },
  // Réglages de module : paramétrage RH.
  'PUT /attendance/config': { fn: 'hr_settings', action: 'configure' },
  'PUT /interview-sim/config': { fn: 'hr_settings', action: 'configure' },
  // Paramétrage RH : la grille n'a ni « Créer » ni « Supprimer » ; créer ou
  // retirer un élément de référentiel (département, type d'absence, catégorie
  // de classification) est un acte de paramétrage.
  'POST /settings/departments': { fn: 'hr_settings', action: 'configure' },
  'DELETE /settings/departments/:id': { fn: 'hr_settings', action: 'configure' },
  'POST /settings/absence-types': { fn: 'hr_settings', action: 'configure' },
  'POST /classification/categories': { fn: 'hr_settings', action: 'configure' },
  'DELETE /classification/categories/:id': { fn: 'hr_settings', action: 'configure' },
  // Élément variable du mois (saisie de paie) : la paie n'a pas « Supprimer »,
  // retirer une saisie modifie la paie du mois.
  'DELETE /settings/variable-elements/:id': { fn: 'payroll', action: 'update' },

  // ── Routes réservées au DRH (admin + hr_manager seulement aujourd'hui) ──────
  // Elles partageraient leur case avec des routes ouvertes au gestionnaire RH
  // (hr_officer) : il les gagnerait à la reprise. Elles sont donc rangées dans
  // une case de la MÊME fonction que le gestionnaire RH n'a pas (configure là où
  // elle existe, sinon validate / export / delete). Le DRH possède toutes les
  // cases. Invariant : takeover-fidelity.test.ts.
  'GET /attendance/payroll-link': { fn: 'hr_settings', action: 'configure' },
  // Rapport d'impact paie CI 2023 : lecture seule, mais il chiffre un écart de
  // paramétrage — il reste dans la case « paramétrage de la paie » du DRH.
  'GET /payroll/ci-2023-impact': { fn: 'payroll', action: 'configure' },
  'GET /employer-brand/overview': { fn: 'climate', action: 'export' },
  'GET /cnps/declarations/:id/neva': { fn: 'declarations', action: 'validate' },
  'GET /cnps/rns/fields': { fn: 'declarations', action: 'validate' },
  'GET /employees/:id/check-delete': { fn: 'employees', action: 'delete' },
  'GET /settings/termination-rules': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/leave-policy': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/absence-types': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/payroll-rules': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/workflow': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/workflow/hr-team': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/workflow/unlinked-managers': { fn: 'hr_settings', action: 'configure' },
  // Intérims de validation : DÉSIGNER qui décide pendant un congé modifie le
  // circuit (configure) ; voir quels congés de valideurs sont couverts est une
  // consultation, que le gestionnaire RH garde — c'est lui qui relance les
  // dossiers en attente. La liste des intérims, elle, n'est pas dans la grille :
  // elle est ouverte à tout utilisateur, qui doit savoir ce qu'on attend de lui.
  'GET /settings/interims/coverage': { fn: 'hr_settings', action: 'view' },
  'POST /settings/interims': { fn: 'hr_settings', action: 'configure' },
  'DELETE /settings/interims/:id': { fn: 'hr_settings', action: 'configure' },
  'GET /settings/import/users-status': { fn: 'hr_settings', action: 'configure' },
  'GET /referentiels/stats': { fn: 'hr_settings', action: 'configure' },
  'POST /onboarding/templates': { fn: 'lifecycle', action: 'validate' },
  'POST /onboarding/templates/generate': { fn: 'lifecycle', action: 'validate' },
  'PATCH /onboarding/templates/:id': { fn: 'lifecycle', action: 'validate' },
  'PATCH /onboarding/journeys/:id': { fn: 'lifecycle', action: 'validate' },
  'GET /offboarding/reason-stats': { fn: 'lifecycle', action: 'export' },
  'GET /sage/export/employees.csv': { fn: 'payroll', action: 'configure' },
  'GET /sage/export/payroll.csv': { fn: 'payroll', action: 'configure' },
  'GET /sage/export/variable-elements.csv': { fn: 'payroll', action: 'configure' },
  'GET /sage/config': { fn: 'payroll', action: 'configure' },
  'GET /sage/legal-entities': { fn: 'payroll', action: 'configure' },
  'GET /settings/payslip-template': { fn: 'payroll', action: 'configure' },
  'GET /settings/variable-elements': { fn: 'payroll', action: 'configure' },
  'POST /settings/variable-elements': { fn: 'payroll', action: 'configure' },
  'POST /payroll/periods/:month': { fn: 'payroll', action: 'configure' },
  'POST /contracts': { fn: 'contracts', action: 'validate' },
  'POST /contracts/:id/renew': { fn: 'contracts', action: 'validate' },
  'PATCH /contracts/:id': { fn: 'contracts', action: 'validate' },
  'POST /recruitment/jobs/:id/source': { fn: 'recruitment', action: 'validate' },
  'POST /recruitment/jobs/:id/source/compare': { fn: 'recruitment', action: 'validate' },
  'POST /recruitment/jobs/:id/screening/apply': { fn: 'recruitment', action: 'validate' },
  'PUT /recruitment/jobs/:id/screening-questions': { fn: 'recruitment', action: 'validate' },
  'GET /recruitment/funnel-stats': { fn: 'recruitment', action: 'export' },
  'GET /interview-sim/config': { fn: 'recruitment', action: 'export' },
  'POST /signature/requests/:id/cancel': { fn: 'signature', action: 'validate' },
  'GET /careers/nine-box': { fn: 'talent', action: 'export' },
  'DELETE /succession/plans/:id': { fn: 'talent', action: 'validate' },
  'DELETE /competencies/catalog/:id': { fn: 'talent', action: 'validate' },
  'DELETE /competencies/job-profiles/:id': { fn: 'talent', action: 'validate' },
  'DELETE /calibration/sessions/:id': { fn: 'talent', action: 'validate' },
  'DELETE /mobility/requests/:id': { fn: 'talent', action: 'validate' },
}

/**
 * Sous-arbres de configuration : toute écriture y vaut `configure` de la
 * fonction indiquée, toute lecture `view`. Profils de fichier de virement et
 * annuaire bancaire → paramétrage de la paie.
 */
const CONFIG_PREFIXES: ReadonlyArray<readonly [string, HabFunction]> = [
  ['/bank-transfer/templates', 'payroll'],
  ['/bank-transfer/directory', 'payroll'],
]

/** Fonction déduite d'un motif placé au milieu de l'URL (prime sur les préfixes). */
const FUNCTION_PATTERNS: ReadonlyArray<readonly [RegExp, HabFunction]> = [
  [/\/contract-proposals?(\/|$)/, 'contracts'],
]

/** Préfixes triés du plus long au plus court : le plus spécifique gagne. */
const SORTED_PREFIXES = [...PREFIXES].sort((a, b) => b[0].length - a[0].length)

/** Suffixes (dernier segment littéral) qui changent l'action d'une écriture. */
const WRITE_SUFFIX_ACTIONS: Readonly<Record<string, HabAction>> = {
  validate: 'validate',
  approve: 'validate',
  reject: 'validate',
  close: 'close',
  submit: 'close',
  send: 'pay',
  pay: 'pay',
  settings: 'configure',
  config: 'configure',
}

function prefixMatches(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`)
}

function verbAction(method: string): HabAction | null {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'view'
    case 'POST':
      return 'create'
    case 'PUT':
    case 'PATCH':
      return 'update'
    case 'DELETE':
      return 'delete'
    default:
      return null
  }
}

/** Dernier segment littéral (les paramètres `:id` sont ignorés). */
function lastLiteralSegment(url: string): string {
  const segments = url.split('/').filter((s) => s !== '' && !s.startsWith(':'))
  return segments[segments.length - 1] ?? ''
}

/** Vrai pour un fichier généré (segment `export`, extension, PDF ou XML NEVA). */
function isExport(url: string): boolean {
  return /\/export(\/|\.|$)/.test(url) || /\.(csv|pdf|svg|xlsx)$/.test(url) || /\/(pdf|neva)$/.test(url)
}

/**
 * Case (fonction, action) d'une route, ou `null` si la route n'est pas une
 * route RH connue. `routeUrl` est le motif de route Fastify complet
 * (`/payroll/periods/:id/close`), préfixe du module inclus.
 */
export function resolveRoutePermission(method: string, routeUrl: string): RoutePermission | null {
  const url = routeUrl.split('?')[0] ?? ''
  // HEAD est servi par la route GET : même case.
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const exact = EXACT_ROUTES[`${verb} ${url}`]
  if (exact) return exact
  let action = verbAction(method)
  if (action === null) return null
  const isRead = action === 'view'

  const config = CONFIG_PREFIXES.find(([prefix]) => prefixMatches(url, prefix))
  if (config) return { fn: config[1], action: isRead ? 'view' : 'configure' }

  const fn =
    FUNCTION_PATTERNS.find(([re]) => re.test(url))?.[1] ??
    SORTED_PREFIXES.find(([prefix]) => prefixMatches(url, prefix))?.[1]
  if (!fn) return null

  if (isRead) {
    // Un export est un téléchargement : seulement en lecture (GET/HEAD).
    if (isExport(url)) action = 'export'
  } else {
    // Un GET n'écrit jamais : les surcharges ne valent que pour les écritures.
    const override = WRITE_SUFFIX_ACTIONS[lastLiteralSegment(url)]
    if (override) action = override
  }

  // Pas de repli : une action absente de la grille de la fonction = aucune case.
  return (HAB_GRID[fn] as readonly HabAction[]).includes(action) ? { fn, action } : null
}
