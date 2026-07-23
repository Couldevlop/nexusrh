# Simulations d'entretien — Profil technique structuré (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured, optional `interview_focus` profile (technologies with years of experience, tools, methodologies, spoken-language CECRL levels) to job offers and to employees, so a later phase can generate interview-simulation questions calibrated on real job requirements instead of a generic prompt.

**Architecture:** New `jsonb` column `interview_focus` on `recruitment_jobs` and on `employees` (isolated from the existing `screening_criteria` column — zero risk to the CV pre-screening feature). A shared pure validation module normalizes/bounds the payload. Two symmetric pairs of dedicated REST endpoints (`GET`/`PUT .../interview-focus`) mirror the existing `screening-criteria` endpoint pattern exactly. Every write also appends an `audit_log` entry using an action name that the existing SIEM categorizer already recognizes (`categorizeAction()` → `config`), so no new export plumbing is needed. One shared React component (`InterviewFocusPanel`) is mounted on both the job page and the employee page.

**Tech Stack:** Fastify 4 + Zod (API), PostgreSQL `jsonb`, React + TanStack Query + react-i18next (web), Vitest.

## Global Constraints

- TypeScript strict — no `any`, no `@ts-ignore`.
- Every async operation has explicit error handling; no bare 500s where a clean 400/404 applies.
- `interview_focus` is entirely optional — offers/employees without it must keep working exactly as today. This phase does **not** touch question generation (`interview-sim-ai.service.ts`) at all.
- RBAC: only `admin`/`hr_manager`/`hr_officer` may write `interview_focus`. On **employees**, the `employee` role must be explicitly excluded (unlike the general employee self-service `PATCH /employees/:id`, which does allow the employee to edit their own profile) — this is not self-service data.
- Migrations are additive, idempotent (`ADD COLUMN IF NOT EXISTS`), added only to the lazy-migration path (`schema-migrations.ts` for `employees`, `provisioning.ts#ensureRecruitmentSchemaMigrated` for `recruitment_jobs`) — this matches the established pattern already used for columns like `badge_id` (never touches the raw `CREATE TABLE` in `provisioning.ts`, since every route already calls the lazy-migration function before touching data).
- Audit writes are non-blocking (`.catch()`), matching `recruitment.source_profiles`'s existing pattern — a logging failure must never fail the request.
- Commits: no Claude co-author line (per repo convention). Use `git add -f` under `nexusrh_ci/` (gitignored at the outer repo root).
- Run `pnpm --filter api exec tsc --noEmit` and `pnpm --filter web exec tsc --noEmit` after each backend/frontend task.

---

### Task 1: Shared types & validation module

**Files:**
- Create: `apps/api/src/services/interview-focus.service.ts`
- Test: `apps/api/src/services/interview-focus.service.test.ts`

**Interfaces:**
- Produces: `CECRL_LEVELS`, `CecrlLevel`, `InterviewFocus`, `InterviewFocusTechnology`, `InterviewFocusLanguage`, `parseInterviewFocus(input: unknown): InterviewFocus | null` — consumed by Task 3 and Task 4.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/services/interview-focus.service.test.ts
import { describe, it, expect } from 'vitest'
import { parseInterviewFocus, CECRL_LEVELS } from './interview-focus.service.js'

describe('parseInterviewFocus', () => {
  it('accepte un profil complet et valide', () => {
    const input = {
      technologies: [
        { name: 'Java', yearsRequired: 5 },
        { name: 'Spring', yearsRequired: 3 },
      ],
      tools: ['Git', 'Jenkins'],
      methodologies: ['Scrum', 'SAFe'],
      languages: [{ language: 'Anglais', level: 'B2' }],
    }
    expect(parseInterviewFocus(input)).toEqual(input)
  })

  it('null/undefined → profil vide (non renseigné)', () => {
    const empty = { technologies: [], tools: [], methodologies: [], languages: [] }
    expect(parseInterviewFocus(null)).toEqual(empty)
    expect(parseInterviewFocus(undefined)).toEqual(empty)
  })

  it('rejette une technologie sans nom', () => {
    expect(parseInterviewFocus({ technologies: [{ name: '', yearsRequired: 5 }], tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette des années hors bornes (négatif ou > 40)', () => {
    expect(parseInterviewFocus({ technologies: [{ name: 'Java', yearsRequired: -1 }], tools: [], methodologies: [], languages: [] })).toBeNull()
    expect(parseInterviewFocus({ technologies: [{ name: 'Java', yearsRequired: 41 }], tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette un niveau CECRL invalide', () => {
    expect(parseInterviewFocus({ technologies: [], tools: [], methodologies: [], languages: [{ language: 'Anglais', level: 'Z9' }] })).toBeNull()
  })

  it('rejette plus de 15 technologies (borne anti-abus)', () => {
    const technologies = Array.from({ length: 16 }, (_, i) => ({ name: `Tech${i}`, yearsRequired: 1 }))
    expect(parseInterviewFocus({ technologies, tools: [], methodologies: [], languages: [] })).toBeNull()
  })

  it('rejette un champ inconnu (schema strict)', () => {
    expect(parseInterviewFocus({ technologies: [], tools: [], methodologies: [], languages: [], extra: 'x' })).toBeNull()
  })

  it('CECRL_LEVELS expose les 6 niveaux dans l\'ordre', () => {
    expect(CECRL_LEVELS).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && node_modules/.bin/vitest run src/services/interview-focus.service.test.ts`
Expected: FAIL — `Cannot find module './interview-focus.service.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/services/interview-focus.service.ts
/**
 * Profil technique structuré d'une offre / d'un employé, utilisé (phase
 * suivante) pour calibrer la génération de questions du module
 * `interview_sim` sur les VRAIES exigences du poste plutôt que sur un prompt
 * générique. Module PUR — aucune I/O, uniquement validation/normalisation.
 *
 * Isolé du champ `screening_criteria` existant (pré-tri de CV) : zéro risque
 * de régression sur cette feature. Entièrement optionnel — un profil absent
 * (NULL) laisse le comportement actuel de simulation inchangé.
 */
import { z } from 'zod'

export const CECRL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
export type CecrlLevel = (typeof CECRL_LEVELS)[number]

export interface InterviewFocusTechnology {
  name: string
  yearsRequired: number
}

export interface InterviewFocusLanguage {
  language: string
  level: CecrlLevel
}

export interface InterviewFocus {
  /** Ordre = priorité : la 1ère technologie est la plus prioritaire. */
  technologies: InterviewFocusTechnology[]
  tools: string[]
  methodologies: string[]
  languages: InterviewFocusLanguage[]
}

const EMPTY_FOCUS: InterviewFocus = { technologies: [], tools: [], methodologies: [], languages: [] }

const interviewFocusSchema = z.object({
  technologies: z.array(z.object({
    name: z.string().min(1).max(80),
    yearsRequired: z.number().int().min(0).max(40),
  })).max(15),
  tools: z.array(z.string().min(1).max(60)).max(15),
  methodologies: z.array(z.string().min(1).max(60)).max(10),
  languages: z.array(z.object({
    language: z.string().min(1).max(40),
    level: z.enum(CECRL_LEVELS),
  })).max(6),
}).strict()

/**
 * Valide et normalise un `interview_focus` reçu du client (body JSON ou
 * colonne jsonb relue). `null`/`undefined` (non renseigné) → profil vide,
 * jamais une erreur. Toute autre valeur non conforme au schéma → `null`
 * (à traiter comme "requête invalide" par l'appelant, jamais silencieusement
 * acceptée).
 */
export function parseInterviewFocus(input: unknown): InterviewFocus | null {
  if (input === null || input === undefined) return EMPTY_FOCUS
  const parsed = interviewFocusSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && node_modules/.bin/vitest run src/services/interview-focus.service.test.ts`
Expected: PASS — 8 tests passed

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 6: Commit**

```bash
git add -f apps/api/src/services/interview-focus.service.ts apps/api/src/services/interview-focus.service.test.ts
git commit -m "feat(interview-sim): profil technique structuré (interview_focus) — types + validation pure"
```

---

### Task 2: Database migrations (employees + recruitment_jobs)

**Files:**
- Modify: `apps/api/src/utils/schema-migrations.ts:701-712` (main tenant `alters` array, `ensureTenantSchema`)
- Modify: `apps/api/src/db/provisioning.ts:1454-1456` (`ensureRecruitmentSchemaMigrated`)
- Test: `apps/api/src/modules/interview-sim/interview-focus.migration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: column `interview_focus jsonb` on `<schema>.employees` and `<schema>.recruitment_jobs`, readable/writable by Task 3/4.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/interview-sim/interview-focus.migration.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')

describe('interview_focus — colonnes jsonb migrées lazy (employees + recruitment_jobs)', () => {
  const migrations = read('utils', 'schema-migrations.ts')
  const provisioning = read('db', 'provisioning.ts')

  it('employees.interview_focus ajouté par ensureTenantSchema', () => {
    expect(migrations).toMatch(/ALTER TABLE "\$\{schemaName\}"\.employees ADD COLUMN IF NOT EXISTS interview_focus jsonb/)
  })

  it('recruitment_jobs.interview_focus ajouté par ensureRecruitmentSchemaMigrated', () => {
    expect(provisioning).toMatch(/ALTER TABLE \$\{s\}\.recruitment_jobs ADD COLUMN IF NOT EXISTS interview_focus jsonb/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-focus.migration.test.ts`
Expected: FAIL — both assertions fail (pattern not found)

- [ ] **Step 3: Add the migration to `schema-migrations.ts`**

Find this exact block (end of the main `alters` array, right before the onboarding statements):

```typescript
    `CREATE TABLE IF NOT EXISTS "${schemaName}".interview_sim_config (
      id                      int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      default_langue          varchar(2) NOT NULL DEFAULT 'fr',
      questions_count         int NOT NULL DEFAULT 5,
      public_token_ttl_minutes int NOT NULL DEFAULT 60,
      consent_text            text,
      updated_at              timestamptz NOT NULL DEFAULT now()
    )`,

    // ── Parcours d'intégration (onboarding) — DDL partagé avec provisioning ──
    ...onboardingTableStatements(schemaName),
  ]
```

Replace with:

```typescript
    `CREATE TABLE IF NOT EXISTS "${schemaName}".interview_sim_config (
      id                      int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      default_langue          varchar(2) NOT NULL DEFAULT 'fr',
      questions_count         int NOT NULL DEFAULT 5,
      public_token_ttl_minutes int NOT NULL DEFAULT 60,
      consent_text            text,
      updated_at              timestamptz NOT NULL DEFAULT now()
    )`,
    // Profil technique structuré (technologies+années, outils, méthodologies,
    // langues CECRL) pour calibrer la génération de questions d'entretien sur
    // le poste de l'employé. Optionnel — NULL = non renseigné (repli générique).
    `ALTER TABLE "${schemaName}".employees ADD COLUMN IF NOT EXISTS interview_focus jsonb`,

    // ── Parcours d'intégration (onboarding) — DDL partagé avec provisioning ──
    ...onboardingTableStatements(schemaName),
  ]
```

- [ ] **Step 4: Add the migration to `provisioning.ts`**

Find this exact block:

```typescript
  // Critères de pré-tri paramétrables par offre (règles dures) — éditables depuis
  // l'interface admin du tenant. JSONB validé/borné applicativement (sanitizeCriteria).
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS screening_criteria jsonb`)
```

Replace with:

```typescript
  // Critères de pré-tri paramétrables par offre (règles dures) — éditables depuis
  // l'interface admin du tenant. JSONB validé/borné applicativement (sanitizeCriteria).
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS screening_criteria jsonb`)
  // Profil technique structuré (technologies+années, outils, méthodologies,
  // langues CECRL) pour calibrer la génération de questions d'entretien sur
  // cette offre. Isolé de screening_criteria. Optionnel — NULL = non renseigné.
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS interview_focus jsonb`)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-focus.migration.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 6: Run full interview-sim + employees + recruitment suites (non-regression)**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim src/modules/employees src/modules/recruitment`
Expected: all previously-passing tests still pass (no new failures)

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 8: Commit**

```bash
git add -f apps/api/src/utils/schema-migrations.ts apps/api/src/db/provisioning.ts apps/api/src/modules/interview-sim/interview-focus.migration.test.ts
git commit -m "feat(interview-sim): migration lazy interview_focus sur employees + recruitment_jobs"
```

---

### Task 3: Job offer endpoints (`GET`/`PUT /recruitment/jobs/:id/interview-focus`)

**Files:**
- Modify: `apps/api/src/modules/recruitment/recruitment.routes.ts` (add import + two routes, right after the existing `screening-criteria` routes, ~line 370)
- Test: `apps/api/src/modules/recruitment/interview-focus.routes.test.ts`

**Interfaces:**
- Consumes: `parseInterviewFocus` from Task 1 (`../../services/interview-focus.service.js`).
- Produces: `GET /recruitment/jobs/:id/interview-focus` → `{ data: { focus: InterviewFocus } }`; `PUT /recruitment/jobs/:id/interview-focus` → `{ data: { focus: InterviewFocus } }` on success, `400` on invalid payload, `404` if job not found.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/modules/recruitment/interview-focus.routes.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))
// Même patron que recruitment.routes.test.ts existant : remplacement complet
// (pas de spread ../orig()) — évite de charger le vrai provisioning.ts (et ses
// dépendances pool/pg) dans ce test isolé.
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: { jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' } },
}))

import authPlugin from '../../plugins/auth.js'
import recruitmentRoutes from './recruitment.routes.js'

const SCHEMA = 'tenant_sotra'
let app: FastifyInstance

function tokenFor(role: string) {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId: null,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(recruitmentRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /recruitment/jobs/:id/interview-focus', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: '/recruitment/jobs/job-1/interview-focus' })
    expect(res.statusCode).toBe(401)
  })

  it('404 si offre introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('200 : profil vide par défaut si colonne NULL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ interview_focus: null }] })
    const res = await app.inject({
      method: 'GET', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual({ technologies: [], tools: [], methodologies: [], languages: [] })
  })

  it('403 pour un rôle non autorisé (employee)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('employee')}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PUT /recruitment/jobs/:id/interview-focus', () => {
  const validFocus = {
    technologies: [{ name: 'Java', yearsRequired: 5 }],
    tools: ['Docker'],
    methodologies: ['Scrum'],
    languages: [{ language: 'Anglais', level: 'B2' }],
  }

  it('400 si le profil est invalide (années hors bornes)', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { focus: { technologies: [{ name: 'Java', yearsRequired: 99 }], tools: [], methodologies: [], languages: [] } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('403 pour le rôle employee', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('employee')}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(403)
  })

  it('200 : persiste, renvoie le profil ET journalise un audit_log', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('UPDATE') && s.includes('recruitment_jobs')) return Promise.resolve({ rows: [{ id: 'job-1' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'PUT', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual(validFocus)
    // L'action est un littéral dans le texte SQL (pas un paramètre) — même
    // patron que recruitment.source_profiles déjà en place.
    const audit = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(audit).toBeTruthy()
    expect(String(audit![0])).toContain('recruitment.job.interview_focus_updated')
  })

  it('404 si offre introuvable', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('UPDATE') && s.includes('recruitment_jobs')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'PUT', url: '/recruitment/jobs/job-1/interview-focus',
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/recruitment/interview-focus.routes.test.ts`
Expected: FAIL — 404s become 404 from route-not-found (fastify default), or connection errors; routes don't exist yet.

- [ ] **Step 3: Add the routes**

Add this import near the top of `recruitment.routes.ts` (alongside the other service imports, e.g. next to `import { sanitizeCriteria } from '../../services/recruitment-screening.service.js'`):

```typescript
import { parseInterviewFocus } from '../../services/interview-focus.service.js'
```

Add these two routes immediately after the existing `PUT /jobs/:id/screening-criteria` route (after its closing `})` — i.e. right before `fastify.delete('/jobs/:id', {`):

```typescript
  // GET /recruitment/jobs/:id/interview-focus — profil technique structuré de
  // l'offre (technologies+années, outils, méthodologies, langues), utilisé
  // (phase suivante) pour calibrer la génération de questions d'entretien.
  fastify.get('/jobs/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      try {
        const res = await pool.query<{ interview_focus: unknown }>(
          `SELECT interview_focus FROM "${schema}".recruitment_jobs WHERE id = $1 LIMIT 1`,
          [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        const focus = parseInterviewFocus(res.rows[0].interview_focus)
        return reply.send({ data: { focus: focus ?? { technologies: [], tools: [], methodologies: [], languages: [] } } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /recruitment/jobs/:id/interview-focus — enregistre le profil technique.
  // OWASP A03 : parseInterviewFocus borne/valide intégralement avant persistance.
  fastify.put('/jobs/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureRecruitmentSchemaMigrated(schema)
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { focus?: unknown }
      const focus = parseInterviewFocus(body.focus)
      if (focus === null) return reply.status(400).send({ error: 'Profil technique invalide' })
      try {
        const res = await pool.query<{ id: string }>(
          `UPDATE "${schema}".recruitment_jobs SET interview_focus = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [JSON.stringify(focus), id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
        // OWASP A09 — audit non bloquant. Action nommée pour matcher
        // categorizeAction() (security.service.ts) → catégorie 'config',
        // exportable SIEM sans plomberie supplémentaire.
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'recruitment.job.interview_focus_updated', 'recruitment_job', $2, $3, $4)`,
          [request.user.sub, id, JSON.stringify({ focus }), request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })
        return reply.send({ data: { focus } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/recruitment/interview-focus.routes.test.ts`
Expected: PASS — 8 tests passed

- [ ] **Step 5: Run full recruitment suite (non-regression)**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/recruitment`
Expected: all tests pass, including pre-existing `recruitment.routes.test.ts` / `.coverage.test.ts`

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 7: Commit**

```bash
git add -f apps/api/src/modules/recruitment/recruitment.routes.ts apps/api/src/modules/recruitment/interview-focus.routes.test.ts
git commit -m "feat(interview-sim): endpoints GET/PUT /recruitment/jobs/:id/interview-focus"
```

---

### Task 4: Employee endpoints (`GET`/`PUT /employees/:id/interview-focus`)

**Files:**
- Modify: `apps/api/src/modules/employees/employees.routes.ts` (add import + two routes, right after the existing `PATCH /:id` route, ~line 400ish, before `GET /:id/check-delete`)
- Test: `apps/api/src/modules/employees/interview-focus.routes.test.ts`

**Interfaces:**
- Consumes: `parseInterviewFocus` from Task 1.
- Produces: `GET /employees/:id/interview-focus` → `{ data: { focus: InterviewFocus } }`; `PUT /employees/:id/interview-focus` → same shape, `400`/`404`/`403` as Task 3. `employee` role is explicitly forbidden (403) on both routes — this is HR-only data, unlike the general `PATCH /employees/:id` which allows self-edit.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/modules/employees/interview-focus.routes.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: { jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' } },
}))

import authPlugin from '../../plugins/auth.js'
import employeesRoutes from './employees.routes.js'

const SCHEMA = 'tenant_sotra'
const EMP_ID = '11111111-1111-1111-1111-111111111111'
let app: FastifyInstance

function tokenFor(role: string, employeeId: string | null = null) {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(employeesRoutes, { prefix: '/employees' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /employees/:id/interview-focus', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: `/employees/${EMP_ID}/interview-focus` })
    expect(res.statusCode).toBe(401)
  })

  it('403 pour le rôle employee — même sur SA PROPRE fiche (pas de self-service ici)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('employee', EMP_ID)}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404 si employé introuvable', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('200 : profil vide par défaut si colonne NULL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ interview_focus: null }] })
    const res = await app.inject({
      method: 'GET', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual({ technologies: [], tools: [], methodologies: [], languages: [] })
  })
})

describe('PUT /employees/:id/interview-focus', () => {
  const validFocus = {
    technologies: [{ name: 'Comptabilité SYSCOHADA', yearsRequired: 4 }],
    tools: ['Sage'],
    methodologies: [],
    languages: [{ language: 'Français', level: 'C2' }],
  }

  it('403 pour le rôle employee', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('employee', EMP_ID)}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(403)
  })

  it('400 si profil invalide', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('hr_manager')}` },
      payload: { focus: { technologies: [{ name: '', yearsRequired: 1 }], tools: [], methodologies: [], languages: [] } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 : persiste et journalise un audit_log', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('UPDATE') && s.includes('.employees')) return Promise.resolve({ rows: [{ id: EMP_ID }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'PUT', url: `/employees/${EMP_ID}/interview-focus`,
      headers: { authorization: `Bearer ${tokenFor('admin')}` },
      payload: { focus: validFocus },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.focus).toEqual(validFocus)
    // L'action est un littéral dans le texte SQL (pas un paramètre).
    const audit = queryMock.mock.calls.find((c) => String(c[0]).includes('audit_log'))
    expect(audit).toBeTruthy()
    expect(String(audit![0])).toContain('employees.interview_focus_updated')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/employees/interview-focus.routes.test.ts`
Expected: FAIL — routes don't exist yet

- [ ] **Step 3: Add the routes**

Add this import near the top of `employees.routes.ts` (alongside the other service imports):

```typescript
import { parseInterviewFocus } from '../../services/interview-focus.service.js'
```

Add these two routes immediately after the `PATCH /:id` route's closing `})` (before `GET /:id/check-delete`):

```typescript
  // GET /employees/:id/interview-focus — profil technique structuré (RH only,
  // PAS de self-service — contrairement à PATCH /:id, l'employé n'a jamais
  // accès à sa propre fiche ici).
  fastify.get('/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer', 'manager', 'readonly')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureTenantSchema(schema)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      try {
        const res = await pool.query<{ interview_focus: unknown }>(
          `SELECT interview_focus FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
          [id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        const focus = parseInterviewFocus(res.rows[0].interview_focus)
        return reply.send({ data: { focus: focus ?? { technologies: [], tools: [], methodologies: [], languages: [] } } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

  // PUT /employees/:id/interview-focus — enregistre le profil technique.
  fastify.put('/:id/interview-focus', {
    preHandler: [fastify.authorize('admin', 'hr_manager', 'hr_officer')],
    handler: async (request, reply) => {
      const schema = request.user.schemaName
      await ensureTenantSchema(schema)
      const { id } = request.params as { id: string }
      if (!UUID_RE.test(id)) return reply.status(400).send({ error: 'id invalide (UUID requis)' })
      const body = (request.body ?? {}) as { focus?: unknown }
      const focus = parseInterviewFocus(body.focus)
      if (focus === null) return reply.status(400).send({ error: 'Profil technique invalide' })
      try {
        const res = await pool.query<{ id: string }>(
          `UPDATE "${schema}".employees SET interview_focus = $1, updated_at = now()
           WHERE id = $2 RETURNING id`,
          [JSON.stringify(focus), id],
        )
        if (!res.rows[0]) return reply.status(404).send({ error: 'Employé introuvable' })
        pool.query(
          `INSERT INTO "${schema}".audit_log (user_id, action, entity, entity_id, changes, ip_address)
           VALUES ($1, 'employees.interview_focus_updated', 'employee', $2, $3, $4)`,
          [request.user.sub, id, JSON.stringify({ focus }), request.ip ?? null],
        ).catch(() => { /* tenant sans audit_log : non bloquant */ })
        return reply.send({ data: { focus } })
      } catch (err) {
        fastify.log.error(err)
        return reply.status(500).send({ error: 'Erreur serveur' })
      }
    },
  })

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/employees/interview-focus.routes.test.ts`
Expected: PASS — 8 tests passed

- [ ] **Step 5: Run full employees suite (non-regression)**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/employees`
Expected: all tests pass

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 7: Commit**

```bash
git add -f apps/api/src/modules/employees/employees.routes.ts apps/api/src/modules/employees/interview-focus.routes.test.ts
git commit -m "feat(interview-sim): endpoints GET/PUT /employees/:id/interview-focus (RH only, pas de self-service)"
```

---

### Task 5: i18n namespace `interviewFocus` (FR/EN)

**Files:**
- Create: `apps/web/src/i18n/locales/fr/interviewFocus.json`
- Create: `apps/web/src/i18n/locales/en/interviewFocus.json`
- Modify: `apps/web/src/i18n/index.ts:50,90,100-101,116,130`
- Test: `apps/web/src/i18n/interview-focus-i18n.test.ts`

**Interfaces:**
- Produces: i18n namespace `interviewFocus`, consumed by Task 6's `InterviewFocusPanel` via `useTranslation('interviewFocus')`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/i18n/interview-focus-i18n.test.ts
import { describe, it, expect } from 'vitest'
import fr from './locales/fr/interviewFocus.json'
import en from './locales/en/interviewFocus.json'

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('i18n interviewFocus — parité FR/EN', () => {
  it('mêmes clés dans les deux langues', () => {
    expect(flatten(fr).sort()).toEqual(flatten(en).sort())
  })
  it('aucune valeur vide côté FR', () => {
    expect(flatten(fr).every((k) => {
      const v = k.split('.').reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], fr)
      return typeof v === 'string' && v.trim().length > 0
    })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node_modules/.bin/vitest run src/i18n/interview-focus-i18n.test.ts`
Expected: FAIL — `Cannot find module './locales/fr/interviewFocus.json'`

- [ ] **Step 3: Create the FR namespace file**

```json
{
  "panel": {
    "configure": "+ Profil technique de l'entretien",
    "hide": "− Masquer le profil technique",
    "intro": "Ces caractéristiques calibrent les simulations d'entretien (technologies, outils, méthodologie, langues). Entièrement optionnel.",
    "saveButton": "Enregistrer le profil",
    "saved": "Enregistré",
    "saveError": "Échec de l'enregistrement"
  },
  "technologies": {
    "title": "Technologies (de la plus prioritaire à la moins prioritaire)",
    "namePlaceholder": "Ex : Java, Spring Boot, Docker",
    "yearsLabel": "Années d'expérience exigées",
    "add": "+ Ajouter une technologie",
    "remove": "Retirer",
    "moveUp": "Monter",
    "moveDown": "Descendre"
  },
  "tools": {
    "title": "Outils (séparés par des virgules)",
    "placeholder": "Ex : Git, Jenkins, Jira"
  },
  "methodologies": {
    "title": "Méthodologie de travail",
    "other": "Autre (précisez, séparé par des virgules)",
    "otherPlaceholder": "Ex : Kanban, Waterfall"
  },
  "languages": {
    "title": "Langues parlées",
    "languagePlaceholder": "Ex : Anglais",
    "levelLabel": "Niveau CECRL",
    "add": "+ Ajouter une langue",
    "remove": "Retirer",
    "level": {
      "A1": "A1 — Débutant",
      "A2": "A2 — Élémentaire",
      "B1": "B1 — Intermédiaire",
      "B2": "B2 — Courant",
      "C1": "C1 — Avancé",
      "C2": "C2 — Bilingue"
    }
  }
}
```

- [ ] **Step 4: Create the EN namespace file**

```json
{
  "panel": {
    "configure": "+ Interview technical profile",
    "hide": "− Hide technical profile",
    "intro": "These characteristics calibrate interview simulations (technologies, tools, methodology, languages). Entirely optional.",
    "saveButton": "Save profile",
    "saved": "Saved",
    "saveError": "Failed to save"
  },
  "technologies": {
    "title": "Technologies (from most to least prioritized)",
    "namePlaceholder": "E.g.: Java, Spring Boot, Docker",
    "yearsLabel": "Years of experience required",
    "add": "+ Add a technology",
    "remove": "Remove",
    "moveUp": "Move up",
    "moveDown": "Move down"
  },
  "tools": {
    "title": "Tools (comma-separated)",
    "placeholder": "E.g.: Git, Jenkins, Jira"
  },
  "methodologies": {
    "title": "Working methodology",
    "other": "Other (specify, comma-separated)",
    "otherPlaceholder": "E.g.: Kanban, Waterfall"
  },
  "languages": {
    "title": "Spoken languages",
    "languagePlaceholder": "E.g.: English",
    "levelLabel": "CEFR level",
    "add": "+ Add a language",
    "remove": "Remove",
    "level": {
      "A1": "A1 — Beginner",
      "A2": "A2 — Elementary",
      "B1": "B1 — Intermediate",
      "B2": "B2 — Upper intermediate",
      "C1": "C1 — Advanced",
      "C2": "C2 — Bilingual"
    }
  }
}
```

- [ ] **Step 5: Register the namespace in `i18n/index.ts`**

Add after line 50 (`import frInterviewSim from './locales/fr/interviewSim.json'`):
```typescript
import frInterviewFocus from './locales/fr/interviewFocus.json'
```

Add after line 90 (`import enInterviewSim from './locales/en/interviewSim.json'`):
```typescript
import enInterviewFocus from './locales/en/interviewFocus.json'
```

In the `NAMESPACES` array (line 100), append `'interviewFocus'` at the end:
```typescript
  'monEspace', 'referentiels', 'raf', 'publicPages', 'dg', 'orgChart', 'discipline', 'offboarding', 'climate', 'succession', 'competencies', 'calibration', 'mobility', 'classification', 'signature', 'security', 'sage', 'attendance', 'interviewSim', 'interviewFocus',
```

In `resources.fr` (line 116), append:
```typescript
    attendance: frAttendance, interviewSim: frInterviewSim, interviewFocus: frInterviewFocus,
```

In `resources.en` (line 130), append:
```typescript
    attendance: enAttendance, interviewSim: enInterviewSim, interviewFocus: enInterviewFocus,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web && node_modules/.bin/vitest run src/i18n/interview-focus-i18n.test.ts`
Expected: PASS — 2 tests passed

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 8: Commit**

```bash
git add -f apps/web/src/i18n/locales/fr/interviewFocus.json apps/web/src/i18n/locales/en/interviewFocus.json apps/web/src/i18n/index.ts apps/web/src/i18n/interview-focus-i18n.test.ts
git commit -m "feat(interview-sim): namespace i18n interviewFocus (FR/EN)"
```

---

### Task 6: Shared `InterviewFocusPanel` component + wire into the job offer page

**Files:**
- Create: `apps/web/src/components/interview-focus/InterviewFocusPanel.tsx`
- Test: `apps/web/src/components/interview-focus/InterviewFocusPanel.test.tsx`
- Modify: `apps/web/src/pages/recruitment/RecruitmentPage.tsx:642` (mount the panel next to `ScreeningCriteriaPanel`)

**Interfaces:**
- Produces: `InterviewFocusPanel({ endpoint, queryKeyId }: { endpoint: string; queryKeyId: string })` — reusable by Task 7 for the employee page (different `endpoint`).
- Consumes: `api` client (`@/lib/api`) — same import already used for `ScreeningCriteriaPanel`.

- [ ] **Step 1: Write the failing test**

Mirrors the established test pattern for this codebase's component tests (see
`apps/web/src/pages/mon-espace/MesSimulations.test.tsx`): `react-i18next` is
mocked with a stub `t` that returns the raw key — no real i18n singleton is
loaded in the test, so assertions match on **i18n keys**, not translated text.

```typescript
// apps/web/src/components/interview-focus/InterviewFocusPanel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, put: putMock } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { InterviewFocusPanel } from './InterviewFocusPanel'

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InterviewFocusPanel endpoint="/recruitment/jobs/job-1/interview-focus" queryKeyId="job-1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => { getMock.mockReset(); putMock.mockReset() })
afterEach(() => cleanup())

describe('InterviewFocusPanel', () => {
  it('replié par défaut : ne charge rien tant que non ouvert', () => {
    renderPanel()
    expect(getMock).not.toHaveBeenCalled()
  })

  it('ouverture → charge le profil et permet d\'ajouter une technologie', async () => {
    getMock.mockResolvedValue({
      data: { data: { focus: { technologies: [], tools: [], methodologies: [], languages: [] } } },
    })
    renderPanel()
    fireEvent.click(screen.getByText('panel.configure'))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/recruitment/jobs/job-1/interview-focus'))
    fireEvent.click(await screen.findByText('technologies.add'))
    expect(await screen.findAllByPlaceholderText('technologies.namePlaceholder')).toHaveLength(1)
  })

  it('enregistrement : appelle PUT avec le profil courant', async () => {
    getMock.mockResolvedValue({
      data: { data: { focus: { technologies: [], tools: [], methodologies: [], languages: [] } } },
    })
    putMock.mockResolvedValue({ data: { data: { focus: {} } } })
    renderPanel()
    fireEvent.click(screen.getByText('panel.configure'))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    fireEvent.click(await screen.findByText('panel.saveButton'))
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      '/recruitment/jobs/job-1/interview-focus',
      { focus: { technologies: [], tools: [], methodologies: [], languages: [] } },
    ))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node_modules/.bin/vitest run src/components/interview-focus/InterviewFocusPanel.test.tsx`
Expected: FAIL — `Cannot find module './InterviewFocusPanel'`

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/interview-focus/InterviewFocusPanel.tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'

const CECRL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
type CecrlLevel = (typeof CECRL_LEVELS)[number]
const COMMON_METHODOLOGIES = ['Scrum', 'Agile', 'SAFe', 'Kanban', 'Waterfall']

interface Technology { name: string; yearsRequired: number }
interface Language { language: string; level: CecrlLevel }
interface InterviewFocus {
  technologies: Technology[]
  tools: string[]
  methodologies: string[]
  languages: Language[]
}
const EMPTY_FOCUS: InterviewFocus = { technologies: [], tools: [], methodologies: [], languages: [] }

interface InterviewFocusPanelProps {
  /** Endpoint complet, ex: `/recruitment/jobs/${id}/interview-focus` ou `/employees/${id}/interview-focus`. */
  endpoint: string
  /** Identifiant utilisé pour la clé de cache React Query (job id ou employee id). */
  queryKeyId: string
}

export function InterviewFocusPanel({ endpoint, queryKeyId }: InterviewFocusPanelProps) {
  const { t } = useTranslation('interviewFocus')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<InterviewFocus | null>(null)
  const [toolsText, setToolsText] = useState('')
  const [otherMethodologies, setOtherMethodologies] = useState('')
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery<{ data: { focus: InterviewFocus } }>({
    queryKey: ['interview-focus', queryKeyId],
    queryFn: () => api.get(endpoint).then((r) => r.data),
    enabled: open,
  })

  if (open && data && focus === null) {
    const f = data.data.focus
    setFocus(f)
    setToolsText(f.tools.join(', '))
    setOtherMethodologies(f.methodologies.filter((m) => !COMMON_METHODOLOGIES.includes(m)).join(', '))
  }

  const save = useMutation({
    mutationFn: (payload: InterviewFocus) => api.put(endpoint, { focus: payload }),
    onSuccess: () => {
      setSaved(true)
      queryClient.invalidateQueries({ queryKey: ['interview-focus', queryKeyId] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const set = (patch: Partial<InterviewFocus>) => setFocus((prev) => (prev ? { ...prev, ...patch } : prev))

  const addTechnology = () => focus && set({ technologies: [...focus.technologies, { name: '', yearsRequired: 0 }] })
  const removeTechnology = (i: number) => focus && set({ technologies: focus.technologies.filter((_, idx) => idx !== i) })
  const moveTechnology = (i: number, dir: -1 | 1) => {
    if (!focus) return
    const arr = [...focus.technologies]
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    set({ technologies: arr })
  }
  const updateTechnology = (i: number, patch: Partial<Technology>) => {
    if (!focus) return
    const arr = focus.technologies.map((t, idx) => (idx === i ? { ...t, ...patch } : t))
    set({ technologies: arr })
  }

  const addLanguage = () => focus && set({ languages: [...focus.languages, { language: '', level: 'B1' as CecrlLevel }] })
  const removeLanguage = (i: number) => focus && set({ languages: focus.languages.filter((_, idx) => idx !== i) })
  const updateLanguage = (i: number, patch: Partial<Language>) => {
    if (!focus) return
    const arr = focus.languages.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
    set({ languages: arr })
  }

  const toggleMethodology = (m: string) => {
    if (!focus) return
    const has = focus.methodologies.includes(m)
    set({ methodologies: has ? focus.methodologies.filter((x) => x !== m) : [...focus.methodologies, m] })
  }

  const handleSave = () => {
    if (!focus) return
    const tools = toolsText.split(',').map((x) => x.trim()).filter(Boolean)
    const extraMethodologies = otherMethodologies.split(',').map((x) => x.trim()).filter(Boolean)
    const commonSelected = focus.methodologies.filter((m) => COMMON_METHODOLOGIES.includes(m))
    save.mutate({
      technologies: focus.technologies.filter((t) => t.name.trim().length > 0),
      tools,
      methodologies: [...commonSelected, ...extraMethodologies],
      languages: focus.languages.filter((l) => l.language.trim().length > 0),
    })
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {open ? t('panel.hide') : t('panel.configure')}
      </button>

      {open && (
        <div className="mt-3">
          {isLoading || !focus ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="space-y-4">
              <p className="text-[11px] text-muted-foreground">{t('panel.intro')}</p>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('technologies.title')}</span>
                <div className="space-y-2">
                  {focus.technologies.map((tech, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={tech.name}
                        onChange={(e) => updateTechnology(i, { name: e.target.value })}
                        placeholder={t('technologies.namePlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <input
                        type="number" min={0} max={40} value={tech.yearsRequired}
                        onChange={(e) => updateTechnology(i, { yearsRequired: parseInt(e.target.value, 10) || 0 })}
                        title={t('technologies.yearsLabel')}
                        className="w-20 rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:border-primary"
                      />
                      <button type="button" onClick={() => moveTechnology(i, -1)} className="text-xs text-muted-foreground">↑</button>
                      <button type="button" onClick={() => moveTechnology(i, 1)} className="text-xs text-muted-foreground">↓</button>
                      <button type="button" onClick={() => removeTechnology(i)} className="text-xs text-red-600">{t('technologies.remove')}</button>
                    </div>
                  ))}
                  <button type="button" onClick={addTechnology} className="text-xs font-medium text-primary hover:underline">
                    {t('technologies.add')}
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium">{t('tools.title')}</span>
                <input
                  value={toolsText}
                  onChange={(e) => setToolsText(e.target.value)}
                  placeholder={t('tools.placeholder')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </label>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('methodologies.title')}</span>
                <div className="flex flex-wrap gap-3 mb-2">
                  {COMMON_METHODOLOGIES.map((m) => (
                    <label key={m} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={focus.methodologies.includes(m)}
                        onChange={() => toggleMethodology(m)}
                        className="h-4 w-4 rounded border-border"
                      />
                      {m}
                    </label>
                  ))}
                </div>
                <input
                  value={otherMethodologies}
                  onChange={(e) => setOtherMethodologies(e.target.value)}
                  placeholder={t('methodologies.otherPlaceholder')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>

              <div>
                <span className="mb-1 block text-xs font-medium">{t('languages.title')}</span>
                <div className="space-y-2">
                  {focus.languages.map((lang, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={lang.language}
                        onChange={(e) => updateLanguage(i, { language: e.target.value })}
                        placeholder={t('languages.languagePlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <select
                        value={lang.level}
                        onChange={(e) => updateLanguage(i, { level: e.target.value as CecrlLevel })}
                        className="rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:border-primary"
                      >
                        {CECRL_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>{t(`languages.level.${lvl}`)}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => removeLanguage(i)} className="text-xs text-red-600">{t('languages.remove')}</button>
                    </div>
                  ))}
                  <button type="button" onClick={addLanguage} className="text-xs font-medium text-primary hover:underline">
                    {t('languages.add')}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                {saved && <span className="text-xs text-emerald-600">{t('panel.saved')}</span>}
                {save.isError && <span className="text-xs text-red-600">{t('panel.saveError')}</span>}
                <button
                  onClick={handleSave}
                  disabled={save.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t('panel.saveButton')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && node_modules/.bin/vitest run src/components/interview-focus/InterviewFocusPanel.test.tsx`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Wire it into the job offer page**

In `apps/web/src/pages/recruitment/RecruitmentPage.tsx`, add the import near the top (alongside other component imports):
```typescript
import { InterviewFocusPanel } from '@/components/interview-focus/InterviewFocusPanel'
```

Find this exact line (~642):
```tsx
              {/* Règles dures de pré-tri — paramétrables par l'admin du tenant */}
              <ScreeningCriteriaPanel jobId={selectedJob.id} />
```

Replace with:
```tsx
              {/* Règles dures de pré-tri — paramétrables par l'admin du tenant */}
              <ScreeningCriteriaPanel jobId={selectedJob.id} />
              {/* Profil technique structuré — calibre les simulations d'entretien */}
              <InterviewFocusPanel
                endpoint={`/recruitment/jobs/${selectedJob.id}/interview-focus`}
                queryKeyId={selectedJob.id}
              />
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 7: Run the web test suite (non-regression)**

Run: `cd apps/web && node_modules/.bin/vitest run`
Expected: all pre-existing tests still pass, plus the 3 new ones (71 total)

- [ ] **Step 8: Commit**

```bash
git add -f apps/web/src/components/interview-focus/InterviewFocusPanel.tsx apps/web/src/components/interview-focus/InterviewFocusPanel.test.tsx apps/web/src/pages/recruitment/RecruitmentPage.tsx
git commit -m "feat(interview-sim): InterviewFocusPanel — profil technique sur la page offre"
```

---

### Task 7: Wire `InterviewFocusPanel` into the employee detail page

**Files:**
- Modify: `apps/web/src/pages/employees/EmployeeDetail.tsx`

**Interfaces:**
- Consumes: `InterviewFocusPanel` from Task 6 (`@/components/interview-focus/InterviewFocusPanel`), unchanged.

- [ ] **Step 1: Add the import**

Add near the top of `apps/web/src/pages/employees/EmployeeDetail.tsx`:
```typescript
import { InterviewFocusPanel } from '@/components/interview-focus/InterviewFocusPanel'
```

- [ ] **Step 2: Mount the panel**

Find this exact block (end of the "Infos contractuelles" card / end of the two-card grid, lines 210-217):
```tsx
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('detail.ibanNotSet')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

Replace with (inserting the panel as a full-width block right after the two-card grid closes, before the component's root `</div>`):
```tsx
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('detail.ibanNotSet')}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <InterviewFocusPanel
          endpoint={`/employees/${emp.id}/interview-focus`}
          queryKeyId={emp.id}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: no output (0 errors)

- [ ] **Step 4: Manual smoke check (no automated test needed — pure wiring, component already tested in Task 6)**

Run: `cd apps/web && node_modules/.bin/vitest run src/pages/employees`
Expected: all pre-existing employee page tests still pass (no new failures from the added import/JSX)

- [ ] **Step 5: Commit**

```bash
git add -f apps/web/src/pages/employees/EmployeeDetail.tsx
git commit -m "feat(interview-sim): InterviewFocusPanel sur la fiche employé"
```

---

### Task 8: Full non-regression verification

**Files:** none (verification only)

- [ ] **Step 1: Full API test suite**

Run: `cd apps/api && node_modules/.bin/vitest run`
Expected: all tests pass (baseline 4366 + this phase's new tests: 8 + 2 + 8 + 8 = 26 → ~4392 passed, 0 failed)

- [ ] **Step 2: Full web test suite**

Run: `cd apps/web && node_modules/.bin/vitest run`
Expected: all tests pass (baseline 68 + 3 (panel) + 2 (i18n) = 73 passed, 0 failed)

- [ ] **Step 3: Golden tests explicitly (module map / UI-API contract must be untouched by this phase)**

Run: `cd apps/api && node_modules/.bin/vitest run src/services/tenant-modules.golden.test.ts src/ui-api-contract.golden.test.ts src/modules/dg/ui-contract.golden.test.ts`
Expected: all pass unchanged — this phase adds sub-routes under already-declared prefixes (`/recruitment`, `/employees`), so no golden update should be required. If any fails, add the missing entry rather than weakening the assertion.

- [ ] **Step 4: Both typechecks**

Run: `pnpm --filter api exec tsc --noEmit`
Run: `pnpm --filter web exec tsc --noEmit`
Expected: no output (0 errors) for both

- [ ] **Step 5: Update the spec status**

In `docs/superpowers/specs/2026-07-22-interview-sim-structured-focus-design.md`, add a line under the title noting Phase 1 is implemented and merged, so Phase 2's spec can reference it as done.

- [ ] **Step 6: Final commit**

```bash
git add -f docs/superpowers/specs/2026-07-22-interview-sim-structured-focus-design.md
git commit -m "docs(interview-sim): Phase 1 (profil technique structuré) livré"
```
