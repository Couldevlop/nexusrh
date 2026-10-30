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
  'POST /payroll-workflow/periods/:id/cancel': { fn: 'payroll_multi', action: 'close' },
  // Paie multi-filiales : la soumission RAF et la validation centrale sont des
  // validations (spec §6 bis : le rôle raf devient « Valider »).
  'POST /payroll-workflow/periods/:id/submit-by-raf': { fn: 'payroll_multi', action: 'validate' },
  'POST /payroll-workflow/periods/:id/validate-central': { fn: 'payroll_multi', action: 'validate' },
  // Paiements : exécuter une campagne ou relancer un paiement = payer ;
  // vérifier un numéro = consulter.
  'POST /mobile-money/campaigns/:reference/execute': { fn: 'payments', action: 'pay' },
  'PATCH /mobile-money/payments/:id/retry': { fn: 'payments', action: 'pay' },
  'POST /mobile-money/verify-number': { fn: 'payments', action: 'view' },
  // Fichier de virement généré (GET) = export.
  'GET /bank-transfer/file': { fn: 'payments', action: 'export' },
  // Aperçu du bulletin : lecture.
  'POST /settings/payslip-template/preview': { fn: 'payroll', action: 'view' },
  // Import en masse (employés, bulletins, contrats…) : opération de paramétrage.
  'POST /settings/import/:type': { fn: 'hr_settings', action: 'configure' },
  // Notes de frais : la soumission est une saisie, pas une clôture.
  'PATCH /expenses/:id/submit': { fn: 'expenses', action: 'update' },
  // Dossier employé : la photo modifie la fiche.
  'POST /employees/:id/photo': { fn: 'employees', action: 'update' },
  // Contrats : rupture = modification du contrat existant.
  'POST /contracts/:id/terminate': { fn: 'contracts', action: 'update' },
  // Signature : envoyer ou annuler une demande relève de sa gestion.
  'POST /signature/requests/:id/send': { fn: 'signature', action: 'update' },
  'POST /signature/requests/:id/cancel': { fn: 'signature', action: 'update' },
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
  const exact = EXACT_ROUTES[`${method.toUpperCase()} ${url}`]
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
