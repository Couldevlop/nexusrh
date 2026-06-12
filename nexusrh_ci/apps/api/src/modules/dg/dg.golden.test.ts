/**
 * GOLDEN — Vue DG 360° (rôle `dg`, module opt-in `dg_view`).
 *
 * Exigence produit : une vue Direction Générale AU-DESSUS du DRH pour
 * contrôler les actions des responsables (jour/semaine/mois, filtre par
 * personne, actions groupées par catégorie dépliables) + un dashboard 360°
 * riche (KPIs, graphes, données instantanées). Activable UNIQUEMENT par le
 * super_admin, et PAR TENANT.
 *
 * Invariants verrouillés :
 *  1. Toutes les routes /dg sont réservées au rôle `dg` (ni admin ni
 *     hr_manager — la vue sert à contrôler leurs actions) et en LECTURE SEULE.
 *  2. Le module dg_view est OPT-IN (défaut false) et enforcé par le hook
 *     global (préfixe /dg) — seul le super_admin peut l'activer (routes
 *     /platform/tenants/:id/modules, vérifiées par le golden modules).
 *  3. Journal d'activité : filtre par responsable (UUID validé — OWASP A03),
 *     bornes temporelles jour/semaine/mois, groupement par catégorie, borné.
 *  4. Les consultations DG sont elles-mêmes auditées (OWASP A09).
 *  5. Login : un utilisateur dg est redirigé vers /dg ; le rôle dg est
 *     attribuable par l'admin tenant ; compte de démo seedé (SOTRA).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MODULE_DEFAULTS, moduleKeyForUrl } from '../../services/tenant-modules.service.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

const dgRoutes       = read('modules', 'dg', 'dg.routes.ts')
const appTs          = read('app.ts')
const authRoutes     = read('modules', 'auth', 'auth.routes.ts')
const settingsRoutes = read('modules', 'settings', 'settings.routes.ts')
const seed           = read('db', 'seed.ts')

describe('GOLDEN vue DG — RBAC strict (rôle dg uniquement)', () => {
  it('chaque route /dg est protégée par authorize(\'dg\') exclusivement', () => {
    const guards = dgRoutes.match(/fastify\.authorize\([^)]*\)/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(3) // overview, activity, actors
    for (const g of guards) {
      expect(g).toBe(`fastify.authorize('dg')`)
    }
  })

  it('module en LECTURE SEULE — aucune route de mutation', () => {
    expect(dgRoutes).not.toMatch(/fastify\.(post|patch|put|delete)\(/)
  })

  it('ni admin ni hr_manager ne sont admis (la vue contrôle leurs actions)', () => {
    expect(dgRoutes).not.toMatch(/authorize\('dg',\s*'admin'/)
    expect(dgRoutes).not.toMatch(/authorize\('admin'/)
  })
})

describe('GOLDEN vue DG — module opt-in activable par le super_admin par tenant', () => {
  it('dg_view est désactivé PAR DÉFAUT (opt-in)', () => {
    expect(MODULE_DEFAULTS.dg_view).toBe(false)
  })

  it('le préfixe /dg est couvert par l\'enforcement modules (hook global)', () => {
    expect(moduleKeyForUrl('/dg/overview')).toBe('dg_view')
    expect(moduleKeyForUrl('/dg/activity')).toBe('dg_view')
    expect(moduleKeyForUrl('/dg/actors')).toBe('dg_view')
  })

  it('les routes /dg sont enregistrées dans app.ts', () => {
    expect(appTs).toContain(`fastify.register(dgRoutes,           { prefix: '/dg' })`)
  })
})

describe('GOLDEN vue DG — journal d\'activité des responsables', () => {
  it('filtre par responsable : UUID strictement validé (OWASP A03)', () => {
    expect(dgRoutes).toMatch(/UUID_RE\.test\(q\['userId'\]\)/)
    expect(dgRoutes).toContain(`'userId invalide (UUID requis)'`)
  })

  it('périodes jour / semaine / mois + bornes from/to explicites', () => {
    expect(dgRoutes).toMatch(/period === 'day'/)
    expect(dgRoutes).toMatch(/period === 'month'/)
    expect(dgRoutes).toContain('periodBounds')
  })

  it('actions groupées par catégorie (entity) avec compteur et détails dépliables', () => {
    expect(dgRoutes).toContain('groups.get(row.entity)')
    expect(dgRoutes).toMatch(/category, count: items\.length, items/)
  })

  it('acteur identifié sur chaque action (nom + rôle via JOIN users)', () => {
    expect(dgRoutes).toMatch(/LEFT JOIN "\$\{s\}"\.users u ON u\.id = l\.user_id/)
    expect(dgRoutes).toContain('userName')
    expect(dgRoutes).toContain('userRole')
  })

  it('requête bornée (LIMIT) — pas de full scan illimité', () => {
    expect(dgRoutes).toMatch(/LIMIT 1000/)
  })

  it('le dropdown des responsables ne liste que les rôles de gestion', () => {
    expect(dgRoutes).toContain(`role IN ('admin', 'hr_manager', 'hr_officer', 'manager', 'raf_site')`)
  })
})

describe('GOLDEN vue DG — dashboard 360°', () => {
  it('KPIs instantanés : effectifs, masse salariale, absents, validations, recrutement, formation, frais', () => {
    for (const kpi of [
      'activeEmployees', 'payrollMassFcfa', 'absentToday', 'pendingApprovals',
      'openJobs', 'upcomingTrainingSessions', 'expensesApprovedThisMonthFcfa',
    ]) {
      expect(dgRoutes).toContain(kpi)
    }
  })

  it('KPIs dérivés : taux d\'absentéisme, évolution masse salariale, candidatures', () => {
    expect(dgRoutes).toContain('absenteeismRatePct')
    expect(dgRoutes).toContain('payrollEvolutionPct')
    expect(dgRoutes).toContain('totalApplications')
  })

  it('séries graphiques : paie 12 mois, effectifs 12 mois, départements, absences par type, pipeline', () => {
    expect(dgRoutes).toContain('payrollSeries')
    expect(dgRoutes).toContain('headcountSeries')
    expect(dgRoutes).toContain('byDepartment')
    expect(dgRoutes).toContain('absencesByType')
    expect(dgRoutes).toContain('applicationsByStage')
  })

  it('statut de validation de la paie avec le NOM du valideur (contrôle du DRH)', () => {
    expect(dgRoutes).toMatch(/closed_by_name/)
    expect(dgRoutes).toMatch(/validated: x\.status === 'closed'/)
  })

  it('PIÈGE pay_periods.closed_by est varchar : jointure castée u.id::text (jamais uuid = varchar)', () => {
    // uuid = varchar → erreur d'opérateur PG → tout le bloc paie retombait sur []
    // (panneau « Statut de la paie » + KPI masse salariale vides). Idem outil IA.
    const aiTools = read('modules', 'ai', 'ai-tools.ts')
    expect(dgRoutes).toContain('u.id::text = p.closed_by')
    expect(dgRoutes).not.toMatch(/u\.id = p\.closed_by/)
    expect(aiTools).toContain('u.id::text = p.closed_by')
    expect(aiTools).not.toMatch(/u\.id = p\.closed_by/)
  })

  it('fail-soft : un module non provisionné ne casse jamais le dashboard', () => {
    expect(dgRoutes).toMatch(/const safe = async/)
    expect(dgRoutes).toMatch(/try \{ return await fn\(\) \} catch \{ return fallback \}/)
  })

  it('les consultations DG sont auditées (OWASP A09)', () => {
    expect(dgRoutes).toContain(`'dg.overview'`)
    expect(dgRoutes).toContain(`'dg.activity'`)
  })
})

describe('GOLDEN vue DG — intégration rôle dg', () => {
  it('login : un utilisateur dg est redirigé vers /dg', () => {
    expect(authRoutes).toMatch(/user\.role === 'dg' \? '\/dg'/)
  })

  it('l\'admin tenant peut attribuer le rôle dg (TENANT_ROLES)', () => {
    expect(settingsRoutes).toMatch(/TENANT_ROLES = \[[^\]]*'dg'\]/)
  })

  it('seed : compte de démo dg@sotra.ci + module dg_view activé sur SOTRA', () => {
    expect(seed).toContain(`'dg@sotra.ci'`)
    expect(seed).toMatch(/'Directeur', 'Général', 'dg'/)
    expect(seed).toContain(`'{"dg_view": true}'::jsonb`)
  })

  it('PIÈGE base vierge : enabled_modules créée par createPlatformSchema (le seed tourne AVANT le boot API)', () => {
    // Sans cette colonne dans le DDL du seed, l'activation dg_view échouait en
    // silence sur un déploiement neuf (la migration boot arrive trop tard).
    const provisioning = read('db', 'provisioning.ts')
    expect(provisioning).toContain(
      `ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS enabled_modules jsonb NOT NULL DEFAULT '{}'`,
    )
    // Et l'activation de la démo n'est PLUS avalée par un catch silencieux.
    expect(seed).not.toMatch(/dg_view[\s\S]{0,200}\.catch\(/)
  })
})

describe('GOLDEN vue DG — seed démo : AUCUN graphe/tableau/KPI vide sur SOTRA', () => {
  const demoData = read('db', 'seed-demo-data.ts')

  it('périodes de paie validées par la DRH (rh@sotra.ci) — le DG voit QUI a validé', () => {
    expect(seed).toContain(`WHERE email = 'rh@sotra.ci'`)
    expect(seed).toMatch(/closed_by\)\s*\n\s*VALUES \(\$1, 'closed', now\(\), \$2\)/)
    // Plus AUCUNE période seedée avec le libellé opaque 'seed' comme valideur.
    expect(seed).not.toContain(`VALUES ($1, 'closed', now(), 'seed')`)
  })

  it('scores rétention IA seedés (tableau « employés à surveiller » + outil IA non vides)', () => {
    expect(demoData).toContain('export async function seedRetentionScoresBulk')
    expect(demoData).toMatch(/retention_score = \$2, burnout_risk = \$3, ai_score_factors = \$4/)
    expect(seed).toContain('seedRetentionScoresBulk(pool, sotraSchema, sotraIds)')
  })

  it('frais approuvés du MOIS COURANT seedés (KPI frais non nul)', () => {
    expect(demoData).toContain('export async function seedCurrentMonthExpensesBulk')
    expect(demoData).toMatch(/monthOffsetStr\(0\)/)
    expect(seed).toContain('seedCurrentMonthExpensesBulk(pool, sotraSchema, sotraIds)')
  })

  it('absences couvrant AUJOURD\'HUI + historique par type (KPI absents + camembert)', () => {
    expect(demoData).toMatch(/couvrant AUJOURD'HUI/)
    expect(seed).toContain('seedAbsencesBulk(pool, sotraSchema, sotraIds, absTypeMap)')
  })

  it('l\'enrichissement DG est DANS le seed de démo uniquement — un client sans données de démo part de zéro', () => {
    // Les générateurs vivent dans seed-demo-data.ts (démo), pas dans le
    // provisionnement tenant (provisioning.ts) ni dans les routes.
    const provisioning = read('db', 'provisioning.ts')
    expect(provisioning).not.toContain('seedRetentionScoresBulk')
    expect(provisioning).not.toContain('seedCurrentMonthExpensesBulk')
  })
})
