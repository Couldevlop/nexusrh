# Rapport statistique 360° — plan d'implémentation

> **Pour les agents :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les
> étapes utilisent des cases à cocher (`- [ ]`).

**But :** envoyer chaque dimanche et chaque début de mois un rapport 360° sur le
parc de tenants et de cabinets, en HTML dans le corps du mail et en PDF joint
pour les graphiques et le détail.

**Architecture :** un job BullMQ dans le worker. La collecte est le seul module
qui touche la base ; l'analyse et les rendus sont des fonctions pures, testables
sans base ni SMTP. Anti-doublon par une table `platform.report_runs`.

**Pile technique :** TypeScript strict (NodeNext), `pg`, `bullmq`, `nodemailer`,
`pdf-lib`, Vitest.

**Spec :** `docs/superpowers/specs/2026-09-01-rapport-statistique-360-design.md`

## Contraintes globales

- **Destinataires** : `waopron@openlabconsulting.com`, copie `coulwao@gmail.com`,
  surchargeables par `PLATFORM_REPORT_TO` / `PLATFORM_REPORT_CC`.
- **Aucune identité de salarié** dans le rapport : nombres et répartitions
  uniquement. Décision RGPD tracée dans la spec.
- **Échappement HTML obligatoire** sur toute valeur venant de la base.
- **Fuseau** : `Africa/Abidjan` (= UTC). Les bornes de période sont calculées en
  UTC, sans dépendance à l'heure locale du conteneur.
- **Garde d'identifiant** : tout nom de schéma interpolé dans du SQL doit passer
  `SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/` — patron imposé par
  `jobs/interview-sim-consent-purge.ts`. Les valeurs restent en `$1`.
- **Isolation par tenant** : un schéma en erreur ne fait jamais échouer le
  rapport entier.
- **TypeScript strict** : `noUncheckedIndexedAccess` est actif, tout accès
  indexé rend `T | undefined`.
- Tous les chemins ci-dessous sont relatifs à `nexusrh_ci/`.

---

### Task 1 : Bornes de période

Le calcul de période est la seule logique de dates du lot. Isolée et testée à
part, elle évite les erreurs de bornes (jour en trop, mois de janvier) qui ne se
verraient qu'un dimanche sur cinquante.

**Fichiers :**
- Créer : `apps/worker/src/report/period.ts`
- Test : `apps/worker/src/report/period.test.ts`

**Interfaces :**
- Produit : `type PeriodType = 'weekly' | 'monthly'`,
  `interface Period { type: PeriodType; start: Date; end: Date; label: string }`,
  `weeklyPeriod(now: Date): Period`, `monthlyPeriod(now: Date): Period`.
  `start` est inclus, `end` est **exclu**.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest'
import { weeklyPeriod, monthlyPeriod } from './period.js'

describe('weeklyPeriod', () => {
  it('couvre les 7 jours écoulés, dimanche précédent inclus au samedi', () => {
    // Dimanche 6 septembre 2026, 06:00 UTC — heure de déclenchement du cron.
    const p = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    expect(p.start.toISOString()).toBe('2026-08-30T00:00:00.000Z') // dimanche précédent
    expect(p.end.toISOString()).toBe('2026-09-06T00:00:00.000Z')   // exclu : ce dimanche
    expect(p.type).toBe('weekly')
  })

  it('ne dépend pas de l’heure de déclenchement', () => {
    const a = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
    const b = weeklyPeriod(new Date('2026-09-06T23:59:00Z'))
    expect(a.start.toISOString()).toBe(b.start.toISOString())
  })
})

describe('monthlyPeriod', () => {
  it('couvre le mois calendaire précédent', () => {
    const p = monthlyPeriod(new Date('2026-09-01T06:15:00Z'))
    expect(p.start.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(p.type).toBe('monthly')
  })

  it('remonte à décembre quand on est en janvier', () => {
    const p = monthlyPeriod(new Date('2027-01-01T06:15:00Z'))
    expect(p.start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/period.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./period.js"`.

- [ ] **Étape 3 : écrire l'implémentation**

```ts
/**
 * Bornes des périodes de rapport.
 *
 * Tout est calculé en UTC : le serveur tourne en Africa/Abidjan, qui EST UTC
 * (pas de décalage, pas d'heure d'été). Passer par les composantes locales
 * exposerait le calcul au fuseau du conteneur, qui n'est pas garanti.
 *
 * Convention : `start` est inclus, `end` est EXCLU. Toutes les requêtes de
 * collecte utilisent donc `>= start AND < end`, ce qui évite le grand classique
 * du dernier jour compté deux fois.
 */
export type PeriodType = 'weekly' | 'monthly'

export interface Period {
  type: PeriodType
  start: Date
  end: Date
  label: string
}

const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function jour(d: Date): string {
  return `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Les 7 jours écoulés : du dimanche précédent (inclus) à ce dimanche (exclu). */
export function weeklyPeriod(now: Date): Period {
  const end = utcMidnight(now)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 7)
  const dernierJour = new Date(end)
  dernierJour.setUTCDate(dernierJour.getUTCDate() - 1)
  return { type: 'weekly', start, end, label: `${jour(start)} — ${jour(dernierJour)}` }
}

/** Le mois calendaire précédent. */
export function monthlyPeriod(now: Date): Period {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return {
    type: 'monthly',
    start,
    end,
    label: `${MOIS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
  }
}
```

> `Date.UTC` accepte un mois à `-1` et bascule sur décembre de l'année
> précédente : c'est ce qui fait passer le test de janvier sans code spécial.

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Commande : `cd apps/worker && npx vitest run src/report/period.test.ts`
Attendu : 4 tests PASSENT.

- [ ] **Étape 5 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/period.ts nexusrh_ci/apps/worker/src/report/period.test.ts
git commit -m "feat(rapport): bornes des périodes hebdomadaire et mensuelle"
```

---

### Task 2 : Suivi des envois et anti-doublon

**Fichiers :**
- Créer : `apps/worker/src/report/report-runs.ts`
- Test : `apps/worker/src/report/report-runs.test.ts`

**Interfaces :**
- Consomme : `Period` (Task 1).
- Produit : `ensureReportRunsTable(pool: Pool): Promise<void>`,
  `claimRun(pool: Pool, period: Period, recipients: string): Promise<boolean>`,
  `markSent(pool, period): Promise<void>`,
  `markFailed(pool, period, message: string): Promise<void>`.

> **Précision par rapport à la spec :** la colonne `status` accepte aussi
> `'pending'`, en plus de `'sent'` et `'failed'`. Sans cet état intermédiaire,
> une tentative échouée ne pourrait jamais être rejouée : la contrainte d'unicité
> bloquerait le nouvel essai. `claimRun` prend la main sur une ligne neuve OU sur
> une ligne `failed`, jamais sur une ligne `sent` ou `pending`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { claimRun, markSent, markFailed, ensureReportRunsTable } from './report-runs.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

beforeEach(() => queryMock.mockReset())

describe('claimRun', () => {
  it('prend la main quand aucune ligne n’existe pour la période', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(true)
  })

  it('refuse quand un rapport a déjà été envoyé pour la période', async () => {
    // ON CONFLICT ... WHERE status = 'failed' ne renvoie aucune ligne.
    queryMock.mockResolvedValueOnce({ rows: [] })
    expect(await claimRun(pool, period, 'a@b.ci')).toBe(false)
  })

  it('borne la liste des destinataires écrite en base', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    await claimRun(pool, period, 'x'.repeat(5000))
    const params = queryMock.mock.calls[0]?.[1] as unknown[]
    expect(String(params[3]).length).toBeLessThanOrEqual(500)
  })
})

describe('markFailed', () => {
  it('tronque le message d’erreur au lieu de faire échouer l’écriture', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await markFailed(pool, period, 'e'.repeat(5000))
    const params = queryMock.mock.calls[0]?.[1] as unknown[]
    expect(String(params[2]).length).toBeLessThanOrEqual(1000)
  })
})

describe('markSent', () => {
  it('passe la ligne de la période en sent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await markSent(pool, period)
    expect(String(queryMock.mock.calls[0]?.[0])).toContain("'sent'")
  })
})

describe('ensureReportRunsTable', () => {
  it('crée la table de façon idempotente', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    await ensureReportRunsTable(pool)
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('CREATE TABLE IF NOT EXISTS platform.report_runs')
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/report-runs.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./report-runs.js"`.

- [ ] **Étape 3 : écrire l'implémentation**

```ts
import type { Pool } from 'pg'
import type { Period } from './period.js'

/**
 * Trace des rapports envoyés, et anti-doublon.
 *
 * La table est créée par le worker lui-même plutôt que par le provisioning de
 * l'API : le rapport est une fonctionnalité du worker, et lui faire dépendre du
 * cycle de démarrage d'un autre service ne servirait qu'à créer une panne au
 * premier déploiement où l'ordre change. `CREATE TABLE IF NOT EXISTS` est
 * idempotent et coûte une requête par exécution du job.
 */
const MAX_RECIPIENTS_LEN = 500
const MAX_ERROR_LEN = 1000

export async function ensureReportRunsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform.report_runs (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period_type   varchar(10)  NOT NULL,
      period_start  date         NOT NULL,
      period_end    date         NOT NULL,
      status        varchar(20)  NOT NULL,
      recipients    text         NOT NULL,
      error_message text,
      created_at    timestamptz  NOT NULL DEFAULT now(),
      updated_at    timestamptz  NOT NULL DEFAULT now(),
      UNIQUE (period_type, period_start)
    )
  `)
}

/**
 * Tente de prendre la main sur la période. Renvoie `false` si un rapport a déjà
 * été envoyé, ou si un envoi est en cours.
 *
 * Une ligne `failed` est reprise : sans cela, la contrainte d'unicité
 * transformerait le moindre échec SMTP en semaine définitivement perdue.
 */
export async function claimRun(pool: Pool, period: Period, recipients: string): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO platform.report_runs (period_type, period_start, period_end, recipients, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (period_type, period_start) DO UPDATE
       SET status = 'pending', recipients = EXCLUDED.recipients, updated_at = now()
       WHERE platform.report_runs.status = 'failed'
     RETURNING id`,
    [period.type, period.start, period.end, recipients.slice(0, MAX_RECIPIENTS_LEN)],
  )
  return res.rows.length > 0
}

export async function markSent(pool: Pool, period: Period): Promise<void> {
  await pool.query(
    `UPDATE platform.report_runs
        SET status = 'sent', error_message = NULL, updated_at = now()
      WHERE period_type = $1 AND period_start = $2`,
    [period.type, period.start],
  )
}

export async function markFailed(pool: Pool, period: Period, message: string): Promise<void> {
  await pool.query(
    `UPDATE platform.report_runs
        SET status = 'failed', error_message = $3, updated_at = now()
      WHERE period_type = $1 AND period_start = $2`,
    [period.type, period.start, message.slice(0, MAX_ERROR_LEN)],
  )
}
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Commande : `cd apps/worker && npx vitest run src/report/report-runs.test.ts`
Attendu : 6 tests PASSENT.

- [ ] **Étape 5 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/report-runs.ts nexusrh_ci/apps/worker/src/report/report-runs.test.ts
git commit -m "feat(rapport): trace des envois et anti-doublon par période"
```

---

### Task 3 : Types et collecte

**Fichiers :**
- Créer : `apps/worker/src/report/types.ts`, `apps/worker/src/report/collect.ts`
- Test : `apps/worker/src/report/collect.test.ts`

**Interfaces :**
- Consomme : `Period` (Task 1).
- Produit : `TenantStats`, `AgencyStats`, `ReportData` (types.ts) et
  `collectReport(pool: Pool, period: Period): Promise<ReportData>` (collect.ts).

- [ ] **Étape 1 : écrire `types.ts`**

```ts
import type { Period } from './period.js'

/** Statistiques d'une entreprise sur la période. Aucun champ nominatif. */
export interface TenantStats {
  tenantId: string
  name: string
  schemaName: string
  status: string
  planType: string
  sector: string | null
  maxUsers: number
  maxEmployees: number
  trialEndsAt: Date | null
  createdAt: Date
  /** false = schéma indisponible ; les compteurs sont alors à zéro. */
  collected: boolean
  headcount: number
  hires: number
  departures: number
  /** Répartition des arrivées par type de contrat — jamais de nom. */
  hiresByContract: Record<string, number>
  activeUsers: number
  usersLoggedIn: number
  lastLoginAt: Date | null
  loginSuccess: number
  loginFailed: number
  loginLocked: number
  mfaRequired: number
  auditWrites: number
  /** 'YYYY-MM-DD' → nombre de connexions réussies. */
  loginsByDay: Record<string, number>
}

export interface AgencyStats {
  agencyId: string
  name: string
  status: string
  tenantIds: string[]
  managedTenants: number
  headcount: number
  attached: number
  detached: number
}

export interface ReportData {
  period: Period
  generatedAt: Date
  tenants: TenantStats[]
  agencies: AgencyStats[]
}
```

- [ ] **Étape 2 : écrire le test qui échoue**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { collectReport } from './collect.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

const TENANT = {
  id: 't1', name: 'SOTRA', schema_name: 'tenant_sotra', status: 'active',
  plan_type: 'business', sector: 'transport', max_users: 100, max_employees: 150,
  trial_ends_at: null, created_at: new Date('2026-01-01T00:00:00Z'),
}

beforeEach(() => queryMock.mockReset())

describe('collectReport', () => {
  it('ignore un schéma au nom invalide plutôt que de l’interpoler', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...TENANT, schema_name: 'tenant"; DROP' }] })
      .mockResolvedValueOnce({ rows: [] })   // agences
      .mockResolvedValueOnce({ rows: [] })   // rattachements
    const data = await collectReport(pool, period)
    expect(data.tenants).toHaveLength(1)
    expect(data.tenants[0]?.collected).toBe(false)
    // Aucune requête n'a interpolé le nom hostile.
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).not.toContain('DROP')
  })

  it('isole un tenant dont le schéma est cassé sans faire échouer le rapport', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT, { ...TENANT, id: 't2', name: 'CABEX', schema_name: 'tenant_cabex' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // t1 : effectifs OK, puis users, puis audit
      .mockResolvedValueOnce({ rows: [{ headcount: 82, hires: 3, departures: 1 }] })
      .mockResolvedValueOnce({ rows: [{ contract_type: 'cdi', n: 3 }] })
      .mockResolvedValueOnce({ rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] })
      .mockResolvedValueOnce({ rows: [] })
      // t2 : le premier appel explose
      .mockRejectedValueOnce(Object.assign(new Error('relation absente'), { code: '42P01' }))

    const data = await collectReport(pool, period)
    expect(data.tenants[0]?.collected).toBe(true)
    expect(data.tenants[0]?.headcount).toBe(82)
    expect(data.tenants[1]?.collected).toBe(false)
  })

  it('agrège l’effectif des entreprises rattachées à chaque cabinet', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [TENANT] })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', name: 'Cabinet Expertise', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ agency_id: 'a1', tenant_id: 't1', attached: true, detached: false }] })
      .mockResolvedValueOnce({ rows: [{ headcount: 82, hires: 3, departures: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active_users: 10, logged_in: 7, last_login_at: null }] })
      .mockResolvedValueOnce({ rows: [] })

    const data = await collectReport(pool, period)
    expect(data.agencies[0]?.managedTenants).toBe(1)
    expect(data.agencies[0]?.headcount).toBe(82)
  })
})
```

- [ ] **Étape 3 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/collect.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./collect.js"`.

- [ ] **Étape 4 : écrire l'implémentation**

```ts
import type { Pool } from 'pg'
import type { Period } from './period.js'
import type { AgencyStats, ReportData, TenantStats } from './types.js'

/**
 * Collecte du rapport — SEUL module du lot qui touche la base.
 *
 * Patron repris de jobs/interview-sim-consent-purge.ts : garde SAFE_SCHEMA
 * avant toute interpolation d'identifiant, cap anti-storm, et isolation stricte
 * par tenant. Un schéma cassé produit un TenantStats `collected: false`, jamais
 * une exception qui ferait perdre le rapport entier.
 */
const SAFE_SCHEMA = /^[a-z0-9_]{1,63}$/
const MAX_TENANTS = Number(process.env['PLATFORM_REPORT_MAX_TENANTS'] ?? 500)

const PG_UNDEFINED_TABLE = '42P01'
const PG_UNDEFINED_COLUMN = '42703'
function isMissingSchemaObject(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN
}

interface TenantRow {
  id: string; name: string; schema_name: string; status: string
  plan_type: string; sector: string | null; max_users: number
  max_employees: number; trial_ends_at: Date | null; created_at: Date
}

function emptyStats(t: TenantRow, collected: boolean): TenantStats {
  return {
    tenantId: t.id, name: t.name, schemaName: t.schema_name, status: t.status,
    planType: t.plan_type, sector: t.sector, maxUsers: t.max_users,
    maxEmployees: t.max_employees, trialEndsAt: t.trial_ends_at, createdAt: t.created_at,
    collected, headcount: 0, hires: 0, departures: 0, hiresByContract: {},
    activeUsers: 0, usersLoggedIn: 0, lastLoginAt: null, loginSuccess: 0,
    loginFailed: 0, loginLocked: 0, mfaRequired: 0, auditWrites: 0, loginsByDay: {},
  }
}

export async function collectReport(pool: Pool, period: Period): Promise<ReportData> {
  const tenantsRes = await pool.query<TenantRow>(
    `SELECT id, name, schema_name, status, plan_type, sector,
            max_users, max_employees, trial_ends_at, created_at
       FROM platform.tenants
      WHERE status NOT IN ('rejected', 'cancelled')
      ORDER BY name
      LIMIT $1`,
    [MAX_TENANTS],
  )

  const agenciesRes = await pool.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM platform.agencies ORDER BY name`,
  )

  const linksRes = await pool.query<{ agency_id: string; tenant_id: string; attached: boolean; detached: boolean }>(
    `SELECT agency_id, tenant_id,
            (assigned_at >= $1 AND assigned_at < $2) AS attached,
            (detached_at IS NOT NULL AND detached_at >= $1 AND detached_at < $2) AS detached
       FROM platform.agency_tenants
      WHERE detached_at IS NULL OR detached_at >= $1`,
    [period.start, period.end],
  )

  const tenants: TenantStats[] = []
  for (const t of tenantsRes.rows) {
    if (!SAFE_SCHEMA.test(t.schema_name)) {
      tenants.push(emptyStats(t, false))
      continue
    }
    try {
      tenants.push(await collectTenant(pool, t, period))
    } catch {
      // Isolation : ce tenant est marqué indisponible, les autres continuent.
      tenants.push(emptyStats(t, false))
    }
  }

  const agencies: AgencyStats[] = agenciesRes.rows.map((a) => {
    const links = linksRes.rows.filter((l) => l.agency_id === a.id)
    const tenantIds = links.filter((l) => !l.detached).map((l) => l.tenant_id)
    const headcount = tenantIds.reduce(
      (sum, id) => sum + (tenants.find((x) => x.tenantId === id)?.headcount ?? 0), 0,
    )
    return {
      agencyId: a.id, name: a.name, status: a.status, tenantIds,
      managedTenants: tenantIds.length, headcount,
      attached: links.filter((l) => l.attached).length,
      detached: links.filter((l) => l.detached).length,
    }
  })

  return { period, generatedAt: new Date(), tenants, agencies }
}

async function collectTenant(pool: Pool, t: TenantRow, period: Period): Promise<TenantStats> {
  const s = t.schema_name  // déjà validé par SAFE_SCHEMA
  const stats = emptyStats(t, true)

  const emp = await pool.query<{ headcount: string; hires: string; departures: string }>(
    `SELECT count(*) FILTER (WHERE is_active)                                   AS headcount,
            count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)        AS hires,
            count(*) FILTER (WHERE NOT is_active AND updated_at >= $1 AND updated_at < $2) AS departures
       FROM "${s}".employees`,
    [period.start, period.end],
  )
  stats.headcount = Number(emp.rows[0]?.headcount ?? 0)
  stats.hires = Number(emp.rows[0]?.hires ?? 0)
  stats.departures = Number(emp.rows[0]?.departures ?? 0)

  const byContract = await pool.query<{ contract_type: string | null; n: string }>(
    `SELECT contract_type, count(*) AS n
       FROM "${s}".employees
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY contract_type`,
    [period.start, period.end],
  )
  for (const r of byContract.rows) {
    stats.hiresByContract[r.contract_type ?? 'non précisé'] = Number(r.n)
  }

  const users = await pool.query<{ active_users: string; logged_in: string; last_login_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE is_active)                                        AS active_users,
            count(*) FILTER (WHERE last_login_at >= $1 AND last_login_at < $2)       AS logged_in,
            max(last_login_at)                                                       AS last_login_at
       FROM "${s}".users`,
    [period.start, period.end],
  )
  stats.activeUsers = Number(users.rows[0]?.active_users ?? 0)
  stats.usersLoggedIn = Number(users.rows[0]?.logged_in ?? 0)
  stats.lastLoginAt = users.rows[0]?.last_login_at ?? null

  const audit = await pool.query<{ action: string; day: string; n: string }>(
    `SELECT action, to_char(created_at, 'YYYY-MM-DD') AS day, count(*) AS n
       FROM "${s}".audit_log
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY action, day`,
    [period.start, period.end],
  ).catch((e: unknown) => {
    if (isMissingSchemaObject(e)) return { rows: [] as { action: string; day: string; n: string }[] }
    throw e
  })
  for (const r of audit.rows) {
    const n = Number(r.n)
    stats.auditWrites += n
    if (r.action === 'auth.login.success') {
      stats.loginSuccess += n
      stats.loginsByDay[r.day] = (stats.loginsByDay[r.day] ?? 0) + n
    } else if (r.action === 'auth.login.failed') stats.loginFailed += n
    else if (r.action === 'auth.login.locked') stats.loginLocked += n
    else if (r.action === 'auth.login.mfa_required') stats.mfaRequired += n
  }

  return stats
}
```

> **`employees.updated_at` est bien présent** — vérifié à la rédaction de ce
> plan dans `provisioning.ts` ET dans la base de production (`tenant_sotra`).
> Le compteur `departures` s'appuie dessus sans condition.
>
> Limite assumée : un employé désactivé puis modifié pour une autre raison
> pendant la période compte comme un départ. C'est la meilleure approximation
> possible sans table d'historique, et elle est stable d'une semaine sur l'autre.

- [ ] **Étape 5 : lancer les tests et vérifier qu'ils passent**

Commande : `cd apps/worker && npx vitest run src/report/collect.test.ts`
Attendu : 3 tests PASSENT.

- [ ] **Étape 6 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/types.ts nexusrh_ci/apps/worker/src/report/collect.ts nexusrh_ci/apps/worker/src/report/collect.test.ts
git commit -m "feat(rapport): collecte multi-tenants isolée et gardée"
```

---

### Task 4 : Analyse et signaux d'attention

**Fichiers :**
- Créer : `apps/worker/src/report/analyze.ts`
- Test : `apps/worker/src/report/analyze.test.ts`

**Interfaces :**
- Consomme : `ReportData`, `TenantStats` (Task 3).
- Produit : `interface Slice { label: string; value: number }`,
  `interface Alert { severity: 'high' | 'medium'; tenant: string; detail: string }`,
  `interface Analysis { totals; byPlan: Slice[]; bySector: Slice[]; agencyShare: Slice[]; loginsByDay: Slice[]; topFailures: Slice[]; alerts: Alert[]; unavailable: string[] }`,
  `analyze(data: ReportData, now: Date): Analysis`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest'
import { analyze } from './analyze.js'
import { weeklyPeriod } from './period.js'
import type { ReportData, TenantStats } from './types.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const NOW = new Date('2026-09-06T06:00:00Z')

function tenant(over: Partial<TenantStats> = {}): TenantStats {
  return {
    tenantId: 't1', name: 'SOTRA', schemaName: 'tenant_sotra', status: 'active',
    planType: 'business', sector: 'transport', maxUsers: 100, maxEmployees: 150,
    trialEndsAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), collected: true,
    headcount: 82, hires: 3, departures: 1, hiresByContract: { cdi: 3 },
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: new Date('2026-09-05T10:00:00Z'),
    loginSuccess: 40, loginFailed: 2, loginLocked: 0, mfaRequired: 1,
    auditWrites: 300, loginsByDay: { '2026-09-05': 40 }, ...over,
  }
}
const data = (tenants: TenantStats[]): ReportData =>
  ({ period, generatedAt: NOW, tenants, agencies: [] })

describe('analyze', () => {
  it('alerte sur une entreprise sans connexion depuis 14 jours', () => {
    const a = analyze(data([tenant({ lastLoginAt: new Date('2026-08-01T00:00:00Z') })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('connexion'))).toBe(true)
  })

  it('alerte sur un essai arrivant à échéance sous 14 jours', () => {
    const a = analyze(data([tenant({ status: 'trial', trialEndsAt: new Date('2026-09-10T00:00:00Z') })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('essai'))).toBe(true)
  })

  it('alerte quand un plafond est atteint à 90 %', () => {
    const a = analyze(data([tenant({ headcount: 140, maxEmployees: 150 })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('plafond'))).toBe(true)
  })

  it('alerte quand l’effectif baisse sur la période', () => {
    const a = analyze(data([tenant({ hires: 0, departures: 4 })]), NOW)
    expect(a.alerts.some(x => x.detail.includes('effectif'))).toBe(true)
  })

  it('signale les tenants dont la collecte a échoué', () => {
    const a = analyze(data([tenant({ collected: false })]), NOW)
    expect(a.unavailable).toContain('SOTRA')
    expect(a.alerts.some(x => x.severity === 'high')).toBe(true)
  })

  it('n’invente rien quand il n’y a aucune donnée', () => {
    const a = analyze(data([]), NOW)
    expect(a.totals.tenants).toBe(0)
    expect(a.alerts).toEqual([])
    expect(a.byPlan).toEqual([])
  })

  it('classe les entreprises par échecs de connexion décroissants', () => {
    const a = analyze(data([
      tenant({ tenantId: 'a', name: 'A', loginFailed: 2 }),
      tenant({ tenantId: 'b', name: 'B', loginFailed: 9 }),
    ]), NOW)
    expect(a.topFailures[0]?.label).toBe('B')
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/analyze.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./analyze.js"`.

- [ ] **Étape 3 : écrire l'implémentation**

```ts
import type { ReportData, TenantStats } from './types.js'

export interface Slice { label: string; value: number }
export interface Alert { severity: 'high' | 'medium'; tenant: string; detail: string }

export interface Totals {
  tenants: number; active: number; trial: number; suspended: number
  newTenants: number; headcount: number; hires: number; departures: number
  activeUsers: number; usersLoggedIn: number
  loginSuccess: number; loginFailed: number; loginLocked: number; mfaRequired: number
}

export interface Analysis {
  totals: Totals
  byPlan: Slice[]
  bySector: Slice[]
  agencyShare: Slice[]
  loginsByDay: Slice[]
  topFailures: Slice[]
  alerts: Alert[]
  unavailable: string[]
}

const JOURS_SANS_CONNEXION = 14
const JOURS_AVANT_FIN_ESSAI = 14
const SEUIL_PLAFOND = 0.9
const JOUR_MS = 86_400_000

function groupe(items: TenantStats[], cle: (t: TenantStats) => string | null): Slice[] {
  const m = new Map<string, number>()
  for (const t of items) {
    const k = cle(t) ?? 'non précisé'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

export function analyze(data: ReportData, now: Date): Analysis {
  const { tenants, agencies, period } = data
  const vus = tenants.filter((t) => t.collected)

  const totals: Totals = {
    tenants: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    trial: tenants.filter((t) => t.status === 'trial').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
    newTenants: tenants.filter((t) => t.createdAt >= period.start && t.createdAt < period.end).length,
    headcount: vus.reduce((s, t) => s + t.headcount, 0),
    hires: vus.reduce((s, t) => s + t.hires, 0),
    departures: vus.reduce((s, t) => s + t.departures, 0),
    activeUsers: vus.reduce((s, t) => s + t.activeUsers, 0),
    usersLoggedIn: vus.reduce((s, t) => s + t.usersLoggedIn, 0),
    loginSuccess: vus.reduce((s, t) => s + t.loginSuccess, 0),
    loginFailed: vus.reduce((s, t) => s + t.loginFailed, 0),
    loginLocked: vus.reduce((s, t) => s + t.loginLocked, 0),
    mfaRequired: vus.reduce((s, t) => s + t.mfaRequired, 0),
  }

  const parJour = new Map<string, number>()
  for (const t of vus) {
    for (const [jour, n] of Object.entries(t.loginsByDay)) {
      parJour.set(jour, (parJour.get(jour) ?? 0) + n)
    }
  }

  const alerts: Alert[] = []
  for (const t of tenants) {
    if (!t.collected) {
      alerts.push({ severity: 'high', tenant: t.name, detail: 'données indisponibles — schéma inaccessible' })
      continue
    }
    if (!t.lastLoginAt || now.getTime() - t.lastLoginAt.getTime() > JOURS_SANS_CONNEXION * JOUR_MS) {
      alerts.push({ severity: 'high', tenant: t.name, detail: `aucune connexion depuis ${JOURS_SANS_CONNEXION} jours` })
    }
    if (t.status === 'trial' && t.trialEndsAt
        && t.trialEndsAt.getTime() - now.getTime() < JOURS_AVANT_FIN_ESSAI * JOUR_MS) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: 'essai arrivant à échéance' })
    }
    if (t.maxEmployees > 0 && t.headcount / t.maxEmployees >= SEUIL_PLAFOND) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `plafond employés atteint à ${Math.round(100 * t.headcount / t.maxEmployees)} %` })
    }
    if (t.maxUsers > 0 && t.activeUsers / t.maxUsers >= SEUIL_PLAFOND) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `plafond utilisateurs atteint à ${Math.round(100 * t.activeUsers / t.maxUsers)} %` })
    }
    if (t.departures > t.hires) {
      alerts.push({ severity: 'medium', tenant: t.name, detail: `effectif en baisse (${t.hires} arrivées, ${t.departures} départs)` })
    }
  }

  return {
    totals,
    byPlan: groupe(tenants, (t) => t.planType),
    bySector: groupe(tenants, (t) => t.sector),
    agencyShare: agencies.map((a) => ({ label: a.name, value: a.managedTenants }))
      .filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    loginsByDay: [...parJour.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    topFailures: vus.filter((t) => t.loginFailed > 0)
      .map((t) => ({ label: t.name, value: t.loginFailed }))
      .sort((a, b) => b.value - a.value).slice(0, 10),
    alerts,
    unavailable: tenants.filter((t) => !t.collected).map((t) => t.name),
  }
}
```

- [ ] **Étape 4 : lancer les tests et vérifier qu'ils passent**

Commande : `cd apps/worker && npx vitest run src/report/analyze.test.ts`
Attendu : 7 tests PASSENT.

- [ ] **Étape 5 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/analyze.ts nexusrh_ci/apps/worker/src/report/analyze.test.ts
git commit -m "feat(rapport): analyse et signaux d'attention"
```

---

### Task 5 : Rendu HTML du corps du mail

**Fichiers :**
- Créer : `apps/worker/src/report/render-html.ts`
- Test : `apps/worker/src/report/render-html.test.ts`

**Interfaces :**
- Consomme : `ReportData` (Task 3), `Analysis` (Task 4).
- Produit : `escapeHtml(s: string): string`,
  `renderHtml(data: ReportData, analysis: Analysis): string`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest'
import { renderHtml, escapeHtml } from './render-html.js'
import { analyze } from './analyze.js'
import { weeklyPeriod } from './period.js'
import type { ReportData, TenantStats } from './types.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const NOW = new Date('2026-09-06T06:00:00Z')

function tenant(over: Partial<TenantStats> = {}): TenantStats {
  return {
    tenantId: 't1', name: 'SOTRA', schemaName: 'tenant_sotra', status: 'active',
    planType: 'business', sector: 'transport', maxUsers: 100, maxEmployees: 150,
    trialEndsAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), collected: true,
    headcount: 82, hires: 3, departures: 1, hiresByContract: { cdi: 3 },
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: NOW,
    loginSuccess: 40, loginFailed: 2, loginLocked: 0, mfaRequired: 1,
    auditWrites: 300, loginsByDay: { '2026-09-05': 40 }, ...over,
  }
}

describe('escapeHtml', () => {
  it('neutralise les caractères actifs', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`))
      .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;')
  })
})

describe('renderHtml', () => {
  const data: ReportData = { period, generatedAt: NOW, tenants: [tenant()], agencies: [] }

  it('présente les sections attendues', () => {
    const html = renderHtml(data, analyze(data, NOW))
    for (const section of ['Vue plateforme', 'Cabinets', 'Entreprises', 'Connexions', 'attention']) {
      expect(html).toContain(section)
    }
  })

  it('échappe un nom d’entreprise hostile', () => {
    const hostile: ReportData = { ...data, tenants: [tenant({ name: '<script>alert(1)</script>' })] }
    const html = renderHtml(hostile, analyze(hostile, NOW))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('le dit explicitement quand il n’y a aucune donnée', () => {
    const vide: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [] }
    expect(renderHtml(vide, analyze(vide, NOW))).toContain('Aucune')
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/render-html.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./render-html.js"`.

- [ ] **Étape 3 : écrire l'implémentation**

```ts
import type { ReportData } from './types.js'
import type { Analysis, Slice } from './analyze.js'

/**
 * Corps du mail.
 *
 * Contraintes des clients mail : pas de JavaScript, pas de SVG, feuilles de
 * style externes ignorées. Tout est donc en tableaux et styles en ligne, et les
 * « barres » sont des cellules de largeur proportionnelle — les vrais
 * graphiques sont dans le PDF joint.
 *
 * TOUTE valeur venant de la base passe par escapeHtml : les noms d'entreprises
 * et de cabinets sont saisis par des utilisateurs, et sans échappement on
 * ouvrirait une injection HTML dans la boîte du destinataire.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const CSS_TABLE = 'width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 18px'
const CSS_TH = 'text-align:left;padding:6px 8px;background:#0f2a44;color:#fff;font-weight:600'
const CSS_TD = 'padding:6px 8px;border-bottom:1px solid #e2e8f0'

function bars(slices: Slice[]): string {
  if (slices.length === 0) return '<p style="color:#64748b">Aucune donnée sur la période.</p>'
  const max = Math.max(...slices.map((s) => s.value), 1)
  return `<table style="${CSS_TABLE}">` + slices.map((s) => `
    <tr>
      <td style="${CSS_TD};width:180px">${escapeHtml(s.label)}</td>
      <td style="${CSS_TD}">
        <span style="display:inline-block;height:12px;width:${Math.round(200 * s.value / max)}px;background:#E85D04"></span>
        <strong style="margin-left:6px">${s.value}</strong>
      </td>
    </tr>`).join('') + '</table>'
}

export function renderHtml(data: ReportData, a: Analysis): string {
  const t = a.totals
  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'

  const entreprises = data.tenants.length === 0
    ? '<p style="color:#64748b">Aucune entreprise dans le parc.</p>'
    : `<table style="${CSS_TABLE}">
        <tr><th style="${CSS_TH}">Entreprise</th><th style="${CSS_TH}">Effectif</th>
            <th style="${CSS_TH}">Arrivées</th><th style="${CSS_TH}">Départs</th>
            <th style="${CSS_TH}">Connectés</th><th style="${CSS_TH}">Échecs</th></tr>
        ${data.tenants.map((x) => `
        <tr><td style="${CSS_TD}">${escapeHtml(x.name)}${x.collected ? '' : ' <em style="color:#b91c1c">(indisponible)</em>'}</td>
            <td style="${CSS_TD}">${x.headcount}</td>
            <td style="${CSS_TD}">${x.hires}</td>
            <td style="${CSS_TD}">${x.departures}</td>
            <td style="${CSS_TD}">${x.usersLoggedIn}/${x.activeUsers}</td>
            <td style="${CSS_TD}">${x.loginFailed}</td></tr>`).join('')}
       </table>`

  const cabinets = data.agencies.length === 0
    ? '<p style="color:#64748b">Aucun cabinet enregistré.</p>'
    : `<table style="${CSS_TABLE}">
        <tr><th style="${CSS_TH}">Cabinet</th><th style="${CSS_TH}">Entreprises</th>
            <th style="${CSS_TH}">Effectif cumulé</th><th style="${CSS_TH}">Rattachées</th>
            <th style="${CSS_TH}">Détachées</th></tr>
        ${data.agencies.map((c) => `
        <tr><td style="${CSS_TD}">${escapeHtml(c.name)}</td>
            <td style="${CSS_TD}">${c.managedTenants}</td>
            <td style="${CSS_TD}">${c.headcount}</td>
            <td style="${CSS_TD}">${c.attached}</td>
            <td style="${CSS_TD}">${c.detached}</td></tr>`).join('')}
       </table>`

  const alertes = a.alerts.length === 0
    ? '<p style="color:#15803d">Aucun point d’attention sur la période.</p>'
    : `<ul>${a.alerts.map((x) => `<li><strong>${escapeHtml(x.tenant)}</strong> — ${escapeHtml(x.detail)}</li>`).join('')}</ul>`

  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:820px">
  <h1 style="color:#0f2a44;font-size:20px">${titre} — ${escapeHtml(data.period.label)}</h1>
  <p style="color:#64748b">NexusRH CI · OpenLab Consulting · le détail complet et les graphiques sont dans le PDF joint.</p>

  <h2 style="font-size:16px">Vue plateforme</h2>
  <table style="${CSS_TABLE}">
    <tr><td style="${CSS_TD}">Entreprises</td><td style="${CSS_TD}"><strong>${t.tenants}</strong> — ${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues</td></tr>
    <tr><td style="${CSS_TD}">Nouvelles sur la période</td><td style="${CSS_TD}"><strong>${t.newTenants}</strong></td></tr>
    <tr><td style="${CSS_TD}">Effectif consolidé</td><td style="${CSS_TD}"><strong>${t.headcount}</strong> — ${t.hires} arrivées, ${t.departures} départs</td></tr>
    <tr><td style="${CSS_TD}">Connexions</td><td style="${CSS_TD}"><strong>${t.loginSuccess}</strong> réussies, ${t.loginFailed} échouées, ${t.loginLocked} verrouillages</td></tr>
  </table>

  <h2 style="font-size:16px">Cabinets</h2>
  ${cabinets}

  <h2 style="font-size:16px">Entreprises</h2>
  ${entreprises}

  <h2 style="font-size:16px">Connexions réussies par jour</h2>
  ${bars(a.loginsByDay)}

  <h2 style="font-size:16px">Points d’attention</h2>
  ${alertes}
</div>`
}
```

- [ ] **Étape 4 : lancer les tests et vérifier qu'ils passent**

Commande : `cd apps/worker && npx vitest run src/report/render-html.test.ts`
Attendu : 5 tests PASSENT.

- [ ] **Étape 5 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/render-html.ts nexusrh_ci/apps/worker/src/report/render-html.test.ts
git commit -m "feat(rapport): corps HTML du mail, avec échappement"
```

---

### Task 6 : Rendu PDF avec graphiques

**Fichiers :**
- Modifier : `apps/worker/package.json` (ajout de `pdf-lib`)
- Créer : `apps/worker/src/report/render-pdf.ts`
- Test : `apps/worker/src/report/render-pdf.test.ts`

**Interfaces :**
- Consomme : `ReportData` (Task 3), `Analysis` et `Slice` (Task 4).
- Produit : `renderPdf(data: ReportData, analysis: Analysis): Promise<Uint8Array>`.

- [ ] **Étape 1 : ajouter la dépendance**

```bash
cd nexusrh_ci && pnpm --filter @nexusrhci/worker add pdf-lib@^1.17.1
```

Vérifier que le lockfile a bougé : `git status --porcelain nexusrh_ci/pnpm-lock.yaml`

- [ ] **Étape 2 : écrire le test qui échoue**

```ts
import { describe, it, expect } from 'vitest'
import { renderPdf } from './render-pdf.js'
import { analyze } from './analyze.js'
import { weeklyPeriod } from './period.js'
import type { ReportData, TenantStats } from './types.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const NOW = new Date('2026-09-06T06:00:00Z')

function tenant(i: number): TenantStats {
  return {
    tenantId: `t${i}`, name: `Entreprise ${i}`, schemaName: `tenant_${i}`, status: 'active',
    planType: 'business', sector: 'transport', maxUsers: 100, maxEmployees: 150,
    trialEndsAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), collected: true,
    headcount: 100 - i, hires: 1, departures: 0, hiresByContract: { cdi: 1 },
    activeUsers: 10, usersLoggedIn: 7, lastLoginAt: NOW,
    loginSuccess: 40, loginFailed: i, loginLocked: 0, mfaRequired: 0,
    auditWrites: 100, loginsByDay: { '2026-09-05': 40 },
  }
}

describe('renderPdf', () => {
  it('produit un document PDF valide', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [tenant(1)], agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1000)
  })

  it('reste borné quand le parc dépasse 50 entreprises', async () => {
    const many = Array.from({ length: 120 }, (_, i) => tenant(i + 1))
    const data: ReportData = { period, generatedAt: NOW, tenants: many, agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
    // Borne des 50 : le document ne doit pas croître linéairement sans fin.
    expect(pdf.byteLength).toBeLessThan(2_000_000)
  })

  it('produit un document même sans aucune donnée', async () => {
    const data: ReportData = { period, generatedAt: NOW, tenants: [], agencies: [] }
    const pdf = await renderPdf(data, analyze(data, NOW))
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-')
  })
})
```

- [ ] **Étape 3 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/render-pdf.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./render-pdf.js"`.

- [ ] **Étape 4 : écrire l'implémentation**

```ts
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'
import type { ReportData } from './types.js'
import type { Analysis, Slice } from './analyze.js'

/**
 * PDF joint : les vrais graphiques et le détail complet.
 *
 * `pdf-lib` est la bibliothèque déjà utilisée par l'API (bulletins,
 * organigramme, attestations). Les camemberts sont dessinés en chemins SVG :
 * pdf-lib n'a pas de primitive de secteur, `drawSvgPath` est la voie prévue.
 */
const A4 = { w: 595.28, h: 841.89 }
const MARGE = 40
const MAX_DETAIL = 50   // borne du détail par entreprise (spec)

const NAVY = rgb(0x0f / 255, 0x2a / 255, 0x44 / 255)
const ORANGE = rgb(0xe8 / 255, 0x5d / 255, 0x04 / 255)
const SLATE = rgb(0x47 / 255, 0x55 / 255, 0x69 / 255)
const PALETTE = [
  ORANGE, rgb(0.12, 0.5, 0.72), rgb(0.18, 0.65, 0.4), rgb(0.6, 0.35, 0.71),
  rgb(0.9, 0.75, 0.2), rgb(0.85, 0.33, 0.35), rgb(0.4, 0.45, 0.5),
]

/** Secteur de camembert en chemin SVG, centré en (cx, cy). */
function secteurPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const x1 = cx + r * Math.cos(from), y1 = cy + r * Math.sin(from)
  const x2 = cx + r * Math.cos(to), y2 = cy + r * Math.sin(to)
  const grand = to - from > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${grand} 1 ${x2} ${y2} Z`
}

function camembert(page: PDFPage, font: PDFFont, x: number, y: number, r: number, slices: Slice[]): void {
  const total = slices.reduce((s, v) => s + v.value, 0)
  if (total === 0) {
    page.drawText('Aucune donnée', { x: x - r, y, size: 10, font, color: SLATE })
    return
  }
  let angle = -Math.PI / 2
  slices.forEach((s, i) => {
    const part = (s.value / total) * 2 * Math.PI
    page.drawSvgPath(secteurPath(x, y, r, angle, angle + part), {
      color: PALETTE[i % PALETTE.length], borderWidth: 0,
    })
    angle += part
  })
  slices.forEach((s, i) => {
    const ly = y + r - i * 14
    page.drawRectangle({ x: x + r + 16, y: ly, width: 9, height: 9, color: PALETTE[i % PALETTE.length] })
    page.drawText(`${s.label} (${s.value})`, { x: x + r + 30, y: ly, size: 9, font, color: SLATE })
  })
}

function barres(page: PDFPage, font: PDFFont, x: number, y: number, w: number, h: number, slices: Slice[]): void {
  if (slices.length === 0) {
    page.drawText('Aucune donnée', { x, y: y + h / 2, size: 10, font, color: SLATE })
    return
  }
  const max = Math.max(...slices.map((s) => s.value), 1)
  const pas = w / slices.length
  slices.forEach((s, i) => {
    const hb = Math.max(1, (s.value / max) * h)
    page.drawRectangle({ x: x + i * pas + 2, y, width: pas - 4, height: hb, color: ORANGE })
    page.drawText(String(s.value), { x: x + i * pas + 2, y: y + hb + 3, size: 7, font, color: SLATE })
    page.drawText(s.label.slice(5), { x: x + i * pas + 2, y: y - 10, size: 7, font, color: SLATE })
  })
}

export async function renderPdf(data: ReportData, a: Analysis): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([A4.w, A4.h])
  let y = A4.h - MARGE

  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'
  page.drawText(`${titre} — ${data.period.label}`, { x: MARGE, y, size: 16, font: bold, color: NAVY })
  y -= 18
  page.drawText('NexusRH CI · OpenLab Consulting', { x: MARGE, y, size: 9, font, color: SLATE })
  y -= 30

  const t = a.totals
  for (const ligne of [
    `Entreprises : ${t.tenants} (${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues)`,
    `Nouvelles sur la période : ${t.newTenants}`,
    `Effectif consolidé : ${t.headcount} — ${t.hires} arrivées, ${t.departures} départs`,
    `Connexions : ${t.loginSuccess} réussies, ${t.loginFailed} échouées, ${t.loginLocked} verrouillages`,
  ]) {
    page.drawText(ligne, { x: MARGE, y, size: 10, font, color: NAVY })
    y -= 15
  }

  y -= 20
  page.drawText('Répartition par plan', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, MARGE + 70, y - 80, 55, a.byPlan)
  page.drawText('Part des cabinets', { x: A4.w / 2, y, size: 11, font: bold, color: NAVY })
  camembert(page, font, A4.w / 2 + 70, y - 80, 55, a.agencyShare)
  y -= 190

  page.drawText('Connexions réussies par jour', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70, a.loginsByDay)
  y -= 130

  // Détail par entreprise, borné.
  const detail = [...data.tenants].sort((x, z) => z.headcount - x.headcount).slice(0, MAX_DETAIL)
  page = doc.addPage([A4.w, A4.h])
  y = A4.h - MARGE
  page.drawText('Détail par entreprise', { x: MARGE, y, size: 14, font: bold, color: NAVY })
  y -= 24
  for (const x of detail) {
    if (y < MARGE + 30) { page = doc.addPage([A4.w, A4.h]); y = A4.h - MARGE }
    const suffixe = x.collected ? '' : '  (données indisponibles)'
    page.drawText(`${x.name}${suffixe}`, { x: MARGE, y, size: 10, font: bold, color: NAVY })
    y -= 13
    page.drawText(
      `effectif ${x.headcount} · arrivées ${x.hires} · départs ${x.departures} · `
      + `connectés ${x.usersLoggedIn}/${x.activeUsers} · échecs ${x.loginFailed}`,
      { x: MARGE + 10, y, size: 9, font, color: SLATE },
    )
    y -= 18
  }
  if (data.tenants.length > MAX_DETAIL) {
    page.drawText(`… et ${data.tenants.length - MAX_DETAIL} autres entreprises (agrégées dans la vue plateforme).`,
      { x: MARGE, y, size: 9, font, color: SLATE })
  }

  return doc.save()
}
```

- [ ] **Étape 5 : lancer les tests et vérifier qu'ils passent**

Commande : `cd apps/worker && npx vitest run src/report/render-pdf.test.ts`
Attendu : 3 tests PASSENT.

- [ ] **Étape 6 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/package.json nexusrh_ci/pnpm-lock.yaml \
  nexusrh_ci/apps/worker/src/report/render-pdf.ts nexusrh_ci/apps/worker/src/report/render-pdf.test.ts
git commit -m "feat(rapport): PDF joint avec camemberts, barres et détail par entreprise"
```

---

### Task 7 : Orchestration, envoi et câblage des crons

**Fichiers :**
- Créer : `apps/worker/src/jobs/platform-report.ts`
- Créer : `apps/worker/src/jobs/platform-report.test.ts`
- Modifier : `apps/worker/src/index.ts` (worker de la file + deux planifications)

**Interfaces :**
- Consomme : tout ce qui précède.
- Produit : `processPlatformReportJob(job: Job): Promise<void>`,
  `schedulePlatformReportCrons()` appelée depuis `registerSchedulers()`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock, sendMailMock } = vi.hoisted(() => ({
  queryMock: vi.fn(), sendMailMock: vi.fn(async () => ({ messageId: 'x' })),
}))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: sendMailMock }) } }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { processPlatformReportJob } from './platform-report.js'

const job = (periodType: string) => ({ id: 'j1', data: { periodType } } as unknown as Job)

beforeEach(() => {
  queryMock.mockReset(); sendMailMock.mockClear()
  queryMock.mockResolvedValue({ rows: [] })
})

describe('processPlatformReportJob', () => {
  it('n’envoie rien si la période a déjà été traitée', async () => {
    // ensure table, puis claim qui ne renvoie aucune ligne
    queryMock.mockResolvedValueOnce({ rows: [] })   // CREATE TABLE
    queryMock.mockResolvedValueOnce({ rows: [] })   // claim -> refusé
    await processPlatformReportJob(job('weekly'))
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('envoie au destinataire principal avec la copie et le PDF joint', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })            // CREATE TABLE
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] }) // claim -> pris
    queryMock.mockResolvedValue({ rows: [] })                 // collecte : parc vide
    await processPlatformReportJob(job('weekly'))
    const envoi = sendMailMock.mock.calls[0]?.[0] as {
      to: string; cc: string; subject: string; attachments: Array<{ filename: string }>
    }
    expect(envoi.to).toBe('waopron@openlabconsulting.com')
    expect(envoi.cc).toBe('coulwao@gmail.com')
    expect(envoi.attachments[0]?.filename).toMatch(/\.pdf$/)
  })

  it('marque l’échec et relance l’erreur pour que BullMQ retente', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
    queryMock.mockResolvedValue({ rows: [] })
    sendMailMock.mockRejectedValueOnce(new Error('SMTP indisponible'))
    await expect(processPlatformReportJob(job('weekly'))).rejects.toThrow('SMTP indisponible')
    const sql = queryMock.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).toContain("'failed'")
  })

  it('rejette un type de période inconnu', async () => {
    await expect(processPlatformReportJob(job('quotidien'))).rejects.toThrow()
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/jobs/platform-report.test.ts`
Attendu : ÉCHEC — `Failed to resolve import "./platform-report.js"`.

- [ ] **Étape 3 : écrire l'implémentation**

```ts
import type { Job } from 'bullmq'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { logger } from '../logger.js'
import { weeklyPeriod, monthlyPeriod, type Period } from '../report/period.js'
import { ensureReportRunsTable, claimRun, markSent, markFailed } from '../report/report-runs.js'
import { collectReport } from '../report/collect.js'
import { analyze } from '../report/analyze.js'
import { renderHtml } from '../report/render-html.js'
import { renderPdf } from '../report/render-pdf.js'

const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })

const TO = process.env['PLATFORM_REPORT_TO'] ?? 'waopron@openlabconsulting.com'
const CC = process.env['PLATFORM_REPORT_CC'] ?? 'coulwao@gmail.com'

const isProduction = process.env['NODE_ENV'] === 'production'
const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'] ?? 'localhost',
  port: Number(process.env['SMTP_PORT'] ?? 587),
  secure: process.env['SMTP_SECURE'] === 'true',
  auth: { user: process.env['SMTP_USER'] ?? '', pass: process.env['SMTP_PASS'] ?? '' },
  requireTLS: true,
  tls: { rejectUnauthorized: isProduction, minVersion: 'TLSv1.2' },
})

export async function processPlatformReportJob(job: Job): Promise<void> {
  const periodType = (job.data as { periodType?: unknown })?.periodType
  if (periodType !== 'weekly' && periodType !== 'monthly') {
    throw new Error(`platform-report: periodType invalide (${String(periodType)})`)
  }
  const now = new Date()
  const period: Period = periodType === 'weekly' ? weeklyPeriod(now) : monthlyPeriod(now)

  await ensureReportRunsTable(pool)
  const recipients = `${TO}, ${CC}`
  if (!await claimRun(pool, period, recipients)) {
    logger.info({ periodType, start: period.start }, 'platform-report: période déjà traitée, envoi ignoré')
    return
  }

  try {
    const data = await collectReport(pool, period)
    const analysis = analyze(data, now)
    const html = renderHtml(data, analysis)
    const pdf = await renderPdf(data, analysis)

    const nom = `nexusrh-rapport-${period.type}-${period.start.toISOString().slice(0, 10)}.pdf`
    await transporter.sendMail({
      from: process.env['SMTP_FROM'] ?? 'NexusRH CI <noreply@nexusrh-ci.com>',
      to: TO,
      cc: CC,
      subject: `NexusRH CI — ${periodType === 'weekly' ? 'rapport hebdomadaire' : 'rapport mensuel'} · ${period.label}`,
      html,
      attachments: [{ filename: nom, content: Buffer.from(pdf), contentType: 'application/pdf' }],
    })

    await markSent(pool, period)
    // OWASP A09 — on journalise des COMPTES, jamais le contenu du rapport.
    logger.info(
      { periodType, tenants: data.tenants.length, agencies: data.agencies.length, alerts: analysis.alerts.length },
      'platform-report: rapport envoyé',
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erreur inconnue'
    await markFailed(pool, period, msg).catch(() => undefined)
    logger.error({ periodType, errMsg: msg }, 'platform-report: échec')
    throw e  // laisse BullMQ retenter
  }
}
```

- [ ] **Étape 4 : lancer les tests et vérifier qu'ils passent**

Commande : `cd apps/worker && npx vitest run src/jobs/platform-report.test.ts`
Attendu : 4 tests PASSENT.

- [ ] **Étape 5 : câbler la file et les deux planifications**

Dans `apps/worker/src/index.ts` :

1. Ajouter l'import :
```ts
import { processPlatformReportJob } from './jobs/platform-report.js'
```

2. Ajouter la fonction de planification, à côté des existantes :
```ts
// Rapport 360° : hebdomadaire le dimanche, mensuel le 1er du mois.
// Deux planifications distinctes sur la MÊME file : le handler distingue les
// deux par `periodType`, ce qui évite de dupliquer un worker.
async function schedulePlatformReportCrons(): Promise<void> {
  const q = new Queue('platform-report', { connection })
  const hebdo = process.env['PLATFORM_REPORT_WEEKLY_CRON'] ?? '0 6 * * 0'
  const mensuel = process.env['PLATFORM_REPORT_MONTHLY_CRON'] ?? '15 6 1 * *'
  await q.upsertJobScheduler(
    'weekly', { pattern: hebdo, tz: 'Africa/Abidjan' },
    { name: 'report', data: { periodType: 'weekly' }, opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  )
  await q.upsertJobScheduler(
    'monthly', { pattern: mensuel, tz: 'Africa/Abidjan' },
    { name: 'report', data: { periodType: 'monthly' }, opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  )
  logger.info({ hebdo, mensuel }, 'platform-report: crons programmés')
}
```

3. Dans `start()`, ajouter le consumer à la liste :
```ts
  workers.push(createWorker('platform-report', processPlatformReportJob as JobHandler))
```

4. Dans `registerSchedulers()`, ajouter l'appel :
```ts
  await schedulePlatformReportCrons()
```

> Le placer dans `registerSchedulers()` — et non dans `start()` — est essentiel :
> c'est ce qui fait réarmer les planifications après une coupure Redis
> (cf. `index.test.ts`). Les mettre ailleurs recréerait le défaut corrigé le
> 01/09/2026.

5. Ajouter `'platform-report'` à la liste des files du log « Workers started ».

- [ ] **Étape 6 : vérifier l'ensemble**

```bash
cd nexusrh_ci/apps/worker && npx tsc --noEmit -p tsconfig.json && npx vitest run
```
Attendu : typecheck propre, toutes les suites au vert (dont `index.test.ts`, qui
compte maintenant au moins 4 planifications au démarrage).

> Si `index.test.ts` échoue sur le nombre d'appels attendu, c'est normal : il
> attendait « au moins 3 » planifications. Mettre à jour l'attente à 5
> (3 crons existants + 2 rapports).

- [ ] **Étape 7 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/jobs/platform-report.ts \
  nexusrh_ci/apps/worker/src/jobs/platform-report.test.ts \
  nexusrh_ci/apps/worker/src/index.ts nexusrh_ci/apps/worker/src/index.test.ts
git commit -m "feat(rapport): orchestration, envoi et planification hebdomadaire et mensuelle"
```

---

### Task 8 : Évolution sur 12 périodes

La spec promet une évolution sur les 12 dernières périodes. Les tâches
précédentes ne collectent que la période courante : cette tâche comble l'écart.

**Deux séries seulement, et pour une raison précise** : les arrivées et les
connexions réussies sont exactement calculables depuis `employees.created_at` et
`audit_log`. L'effectif *historique*, lui, n'est pas reconstituable — rien ne
conserve l'état passé — et le reconstruire donnerait un graphique faux avec
l'apparence du vrai. On montre donc ce qui est mesurable.

**Fichiers :**
- Modifier : `apps/worker/src/report/types.ts` (ajout de `trend`)
- Modifier : `apps/worker/src/report/collect.ts` (ajout de `collectTrend`)
- Modifier : `apps/worker/src/report/render-pdf.ts` (deux graphiques de plus)
- Test : `apps/worker/src/report/trend.test.ts`

**Interfaces :**
- Consomme : `Period` (Task 1), `Pool`.
- Produit : `interface TrendPoint { label: string; hires: number; logins: number }`
  ajouté à `types.ts`, `trend: TrendPoint[]` ajouté à `ReportData`, et
  `collectTrend(pool: Pool, period: Period, buckets?: number): Promise<TrendPoint[]>`
  exporté depuis `collect.ts`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { collectTrend } from './collect.js'
import { weeklyPeriod } from './period.js'

const period = weeklyPeriod(new Date('2026-09-06T06:00:00Z'))
const queryMock = vi.fn()
const pool = { query: queryMock } as unknown as Pool

beforeEach(() => queryMock.mockReset())

describe('collectTrend', () => {
  it('rend une série continue de 12 points, même sans données', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra' }] })
    queryMock.mockResolvedValue({ rows: [] })
    const t = await collectTrend(pool, period)
    expect(t).toHaveLength(12)
    expect(t.every(p => p.hires === 0 && p.logins === 0)).toBe(true)
  })

  it('range chaque valeur dans la bonne tranche', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_sotra' }] })
    queryMock.mockResolvedValueOnce({ rows: [{ bucket: '2026-08-30', n: '2' }] })
    queryMock.mockResolvedValueOnce({ rows: [{ bucket: '2026-08-30', n: '40' }] })
    const t = await collectTrend(pool, period)
    expect(t[11]?.hires).toBe(2)
    expect(t[11]?.logins).toBe(40)
  })

  it('ignore un tenant dont le schéma est cassé', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ schema_name: 'tenant_ko' }] })
    queryMock.mockRejectedValue(Object.assign(new Error('absente'), { code: '42P01' }))
    const t = await collectTrend(pool, period)
    expect(t).toHaveLength(12)
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Commande : `cd apps/worker && npx vitest run src/report/trend.test.ts`
Attendu : ÉCHEC — `collectTrend` n'est pas exporté.

- [ ] **Étape 3 : ajouter le type dans `types.ts`**

```ts
/** Un point de la série d'évolution. `label` est la date de début de tranche. */
export interface TrendPoint {
  label: string
  hires: number
  logins: number
}
```

et, dans `ReportData` :

```ts
  /** 12 dernières périodes, de la plus ancienne à la plus récente. */
  trend: TrendPoint[]
```

- [ ] **Étape 4 : implémenter `collectTrend` dans `collect.ts`**

```ts
const BUCKETS = 12

/** Début de la tranche n avant la période courante (0 = la plus récente). */
function bucketStart(period: Period, n: number): Date {
  const d = new Date(period.start)
  if (period.type === 'weekly') d.setUTCDate(d.getUTCDate() - 7 * n)
  else d.setUTCMonth(d.getUTCMonth() - n)
  return d
}

/**
 * Évolution sur les 12 dernières périodes, tous tenants confondus.
 *
 * Deux séries seulement : arrivées et connexions réussies. L'effectif
 * historique n'est pas reconstituable — rien ne conserve l'état passé — et le
 * reconstruire produirait un graphique faux avec l'apparence du vrai.
 */
export async function collectTrend(pool: Pool, period: Period, buckets = BUCKETS): Promise<TrendPoint[]> {
  const debut = bucketStart(period, buckets - 1)
  const fin = period.end
  // 'week' ou 'month' : deux littéraux écrits ici, jamais une valeur reçue.
  // C'est la seule raison qui rend cette interpolation acceptable — PostgreSQL
  // ne permet pas de paramétrer l'unité de date_trunc.
  const unite = period.type === 'weekly' ? 'week' : 'month'

  const points: TrendPoint[] = []
  for (let i = buckets - 1; i >= 0; i--) {
    points.push({ label: bucketStart(period, i).toISOString().slice(0, 10), hires: 0, logins: 0 })
  }
  const index = new Map(points.map((p, i) => [p.label, i]))

  const tenants = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM platform.tenants
      WHERE status NOT IN ('rejected', 'cancelled') LIMIT $1`,
    [MAX_TENANTS],
  )

  for (const t of tenants.rows) {
    const s = t.schema_name
    if (!SAFE_SCHEMA.test(s)) continue
    try {
      const hires = await pool.query<{ bucket: string; n: string }>(
        `SELECT to_char(date_trunc('${unite}', created_at), 'YYYY-MM-DD') AS bucket, count(*) AS n
           FROM "${s}".employees
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY bucket`,
        [debut, fin],
      )
      for (const r of hires.rows) {
        const i = index.get(r.bucket)
        if (i !== undefined) points[i]!.hires += Number(r.n)
      }

      const logins = await pool.query<{ bucket: string; n: string }>(
        `SELECT to_char(date_trunc('${unite}', created_at), 'YYYY-MM-DD') AS bucket, count(*) AS n
           FROM "${s}".audit_log
          WHERE action = 'auth.login.success' AND created_at >= $1 AND created_at < $2
          GROUP BY bucket`,
        [debut, fin],
      )
      for (const r of logins.rows) {
        const i = index.get(r.bucket)
        if (i !== undefined) points[i]!.logins += Number(r.n)
      }
    } catch {
      // Isolation : ce tenant ne contribue pas à la tendance, les autres si.
    }
  }
  return points
}
```

Puis, dans `collectReport`, remplacer le `return` final par :

```ts
  const trend = await collectTrend(pool, period)
  return { period, generatedAt: new Date(), tenants, agencies, trend }
```

Compléter enfin les jeux d'essai existants (`collect.test.ts`, `analyze.test.ts`,
`render-html.test.ts`, `render-pdf.test.ts`) avec `trend: []` partout où un
`ReportData` est construit à la main — sinon le typecheck échoue.

- [ ] **Étape 5 : ajouter les deux graphiques au PDF**

Dans `render-pdf.ts`, après le graphique des connexions par jour :

```ts
  y -= 40
  page.drawText('Arrivées sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.hires })))
  y -= 130
  page.drawText('Connexions réussies sur 12 périodes', { x: MARGE, y, size: 11, font: bold, color: NAVY })
  barres(page, font, MARGE, y - 90, A4.w - 2 * MARGE, 70,
    data.trend.map((p) => ({ label: p.label, value: p.logins })))
```

- [ ] **Étape 6 : vérifier l'ensemble**

Commande : `cd apps/worker && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Attendu : typecheck propre, toutes les suites au vert.

- [ ] **Étape 7 : commiter**

```bash
git add -f nexusrh_ci/apps/worker/src/report/
git commit -m "feat(rapport): évolution des arrivées et des connexions sur 12 périodes"
```

---

## Vérification de bout en bout avant livraison

- [ ] `cd nexusrh_ci && pnpm run typecheck` → 5/5
- [ ] `cd nexusrh_ci && pnpm run test` → 5/5
- [ ] **Essai réel hors production** : lancer le job à la main sur une base de
      développement et ouvrir le mail reçu (smtp4dev), en vérifiant que le PDF
      s'ouvre et que les camemberts sont dessinés.
- [ ] Confirmer que les variables `PLATFORM_REPORT_TO` / `PLATFORM_REPORT_CC` ne
      sont **pas** définies en production, pour que les valeurs par défaut
      s'appliquent — ou les définir explicitement dans le ConfigMap.
- [ ] **Rappel de déploiement** : le worker n'est redémarré par le script de
      déploiement que si `ci-deploy.sh` a été réinstallé sur le serveur. Sans
      cela, le nouveau code ne sera jamais pris et aucun rapport ne partira.

## Ce que ce plan ne fait pas

- Pas de capture des erreurs applicatives (table dédiée) — chantier suivant.
- Pas d'écran de consultation dans le portail super_admin.
- Pas d'export CSV ni d'envoi à la demande.
