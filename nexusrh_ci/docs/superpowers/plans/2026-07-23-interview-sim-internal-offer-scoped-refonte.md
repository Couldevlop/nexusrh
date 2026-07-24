# Entretien interne offre-scopé + restitution redesignée — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le self-service générique d'entretien par un entraînement lancé depuis chaque offre interne (calibré sur l'offre, éphémère, en place dans la fiche) et redessiner la restitution via le skill frontend-design.

**Architecture:** Deux routes API authentifiées offre-scopées (`GET/POST /interview-sim/internal-jobs/:jobId/{start,submit}`) remplacent les routes employé-scopées ; elles rejouent la logique du flux public (calibrage sur `recruitment_jobs.interview_focus` + `experience_level`) mais authentifiées et éphémères (rien stocké). Côté web, un composant dédié `OfferInterviewRunner` déroule l'entretien dans la modale de `MesOffresInternes` ; la page self-service `MesSimulations` et son entrée de menu sont supprimées. `InterviewRestitution` (partagé interne+public) est retravaillé au skill frontend-design.

**Tech Stack:** Fastify 4 + Zod (API), PostgreSQL, React 18 + TanStack Query + react-i18next (web), Vitest + Testing Library.

## Global Constraints

- TypeScript strict — pas de `any`, pas de `@ts-ignore`.
- Chaque async a sa gestion d'erreur ; jamais de 500 brute là où un 400/404 propre s'applique.
- Scoping tenant via `request.user.schemaName` (JWT) uniquement ; `jobId`/`employeeId` jamais lus du body pour traverser un tenant (OWASP A01/A03).
- Flux interne **éphémère** : aucune écriture dans `interview_sim_attempts`. Au plus `incrementUsage` (compteur anonyme agrégé `platform.interview_sim_usage`).
- `roleKey` **normalisé côté serveur** (`normalizeRoleKey`) avant tout `incrementUsage` / `feedBank`.
- Pas de suppression de table ni de migration : `interview_sim_attempts` reste en place (inerte).
- Commits : pas de co-auteur Claude (convention dépôt). `git add -f` sous `nexusrh_ci/` (gitignoré à la racine).
- Après chaque tâche backend/frontend : `pnpm --filter api exec tsc --noEmit` / `pnpm --filter web exec tsc --noEmit`.
- Le golden `interview-sim.ui-contract.golden.test.ts` couple contrat API + web : il est mis à jour en **dernière tâche**, après tous les changements — il sera temporairement rouge entre-temps (chaque tâche intermédiaire ne lance que son propre test ciblé).

---

### Task 1: Backend — routes offre-scopées + retrait des routes génériques

**Files:**
- Modify: `apps/api/src/modules/interview-sim/interview-sim.routes.ts`
- Test (rewrite): `apps/api/src/modules/interview-sim/interview-sim.routes.internal.test.ts`

**Interfaces:**
- Consumes: `genererQuestions`, `produireRetour`, `PosteContext`, `TranscriptItem`, `InterviewFeedback` (`./interview-sim-ai.service.js`) ; `parseInterviewFocus` (`../../services/interview-focus.service.js`) ; `normalizeRoleKey`, `readBank`, `feedBank`, `incrementUsage` (`./interview-sim-bank.service.js`) ; `resolveAiCreds`, `loadTenantConfig`, `transcriptItemSchema`, `badRequest` (déjà dans le fichier).
- Produces: `GET /interview-sim/internal-jobs/:jobId/start` → `{ data: { jobId, jobTitle, langue, roleKey, nbQuestions, questions: string[], categories: string[] } }` ; `POST /interview-sim/internal-jobs/:jobId/submit` → `{ data: { retour: InterviewFeedback } }`. Consommés par Task 3 (`OfferInterviewRunner`).

- [ ] **Step 1: Rewrite the test file** (remplace intégralement le contenu de `interview-sim.routes.internal.test.ts`)

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../db/pool.js', () => ({ pool: { query: queryMock } }))
vi.mock('../../utils/schema-migrations.js', () => ({
  ensureTenantSchema: vi.fn().mockResolvedValue(undefined),
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: {
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    ai: { apiKey: null, model: 'claude-sonnet-4', maxTokens: 2048 },
    mistral: { apiKey: null, model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
  },
}))
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude: { apiKey: null, model: 'claude-sonnet-4', source: null },
    mistral: { apiKey: null, model: 'mistral-large', source: null },
    preferredProvider: 'claude',
  }),
}))

import authPlugin from '../../plugins/auth.js'
import interviewSimRoutes from './interview-sim.routes.js'

const SCHEMA = 'tenant_sotra'
const JOB_ID = '22222222-2222-2222-2222-222222222222'
let app: FastifyInstance

function tokenFor(employeeId: string | null, role = 'employee') {
  return app.jwt.sign({
    sub: 'u-1', tenantId: 't1', schemaName: SCHEMA, role,
    email: 'e@sotra.ci', firstName: 'E', lastName: 'M', employeeId,
  })
}

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(interviewSimRoutes, { prefix: '/interview-sim' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockReset() })

describe('GET /interview-sim/internal-jobs/:jobId/start', () => {
  it('401 sans token', async () => {
    const res = await app.inject({ method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start` })
    expect(res.statusCode).toBe(401)
  })

  it('400 si le compte n’est pas lié à un employé', async () => {
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor(null)}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l’offre n’est pas interne-visible / éligible', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".employees')) return Promise.resolve({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('200 : questions + catégories calibrées sur l’offre (repli banque)', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".employees')) return Promise.resolve({ rows: [{ id: 'emp-1', department_id: null, job_level: null, hire_date: null, legal_entity_id: null }] })
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [{ title: 'Développeur', interview_focus: { technologies: [{ name: 'Java', yearsRequired: 5 }], tools: [], methodologies: [], languages: [] }, experience_level: '3_7_ans' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      if (s.includes('interview_sim_config')) return Promise.resolve({ rows: [{ default_langue: 'fr', questions_count: 4, public_token_ttl_minutes: 60, consent_text: null }] })
      if (s.includes('interview_sim_question_banks')) return Promise.resolve({ rows: [{ questions: ['Q1', 'Q2'], source_model: 'claude' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'GET', url: `/interview-sim/internal-jobs/${JOB_ID}/start`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.jobTitle).toBe('Développeur')
    expect(Array.isArray(data.questions)).toBe(true)
    expect(data.langue).toBe('fr')
  })
})

describe('POST /interview-sim/internal-jobs/:jobId/submit — éphémère', () => {
  it('200 + retour, SANS écrire dans interview_sim_attempts', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [{ title: 'Développeur' }] })
      if (s.includes('FROM platform.tenants')) return Promise.resolve({ rows: [{ sector: 'IT' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: ['Q1'], categories: ['Java'], answers: [{ index: 0, question: 'Q1', transcript: 'ma réponse' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.retour).toBeTruthy()
    const insert = queryMock.mock.calls.find((c) => String(c[0]).includes('interview_sim_attempts'))
    expect(insert).toBeFalsy() // ÉPHÉMÈRE : rien de personnel stocké
    const usage = queryMock.mock.calls.find((c) => String(c[0]).includes('platform.interview_sim_usage'))
    expect(usage).toBeTruthy() // compteur anonyme agrégé
  })

  it('400 si body invalide', async () => {
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: [], answers: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 si l’offre n’est pas interne-visible', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql)
      if (s.includes('FROM "tenant_sotra".recruitment_jobs')) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: `/interview-sim/internal-jobs/${JOB_ID}/submit`,
      headers: { authorization: `Bearer ${tokenFor('emp-1')}` },
      payload: { langue: 'fr', questions: ['Q1'], answers: [{ index: 0, question: 'Q1', transcript: 'r' }] },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-sim.routes.internal.test.ts`
Expected: FAIL — les routes `/internal-jobs/:jobId/start` et `/submit` n'existent pas encore (404 route-not-found / assertions échouent).

- [ ] **Step 3: Add the two offer-scoped routes**

Dans `interview-sim.routes.ts`, ajouter d'abord ce schéma près de `submitSchema` (après la ligne `}).strict()` de `submitSchema`, ~ligne 47) :

```typescript
const internalJobSubmitSchema = z.object({
  langue: z.enum(['fr', 'en']),
  questions: z.array(z.string().min(1).max(2000)).min(1).max(30),
  categories: z.array(z.string().max(60)).max(30).optional(),
  answers: z.array(transcriptItemSchema).min(1).max(30),
}).strict()
```

Puis, dans le plugin `interviewSimRoutes`, ajouter les deux routes (par ex. juste avant `fastify.get('/config'`) :

```typescript
  // ── GET /interview-sim/internal-jobs/:jobId/start : entretien calibré sur une OFFRE INTERNE ──
  // Miroir AUTHENTIFIÉ du flux public : la source de calibrage est l'offre
  // (interview_focus + experience_level), plus jamais le poste de l'employé.
  fastify.get('/internal-jobs/:jobId/start', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Démarrer une simulation calibrée sur une offre interne' },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      const employeeId = user.employeeId
      if (!employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName
      const { jobId } = request.params as { jobId: string }

      const empRes = await pool.query<{ id: string; department_id: string | null; job_level: string | null; hire_date: string | null; legal_entity_id: string | null }>(
        `SELECT id, department_id, job_level, hire_date, legal_entity_id FROM "${schema}".employees WHERE id = $1 LIMIT 1`,
        [employeeId],
      )
      const emp = empRes.rows[0]
      if (!emp) return reply.status(404).send({ error: 'Offre introuvable' })
      const seniorityMonths = emp.hire_date
        ? Math.max(0, Math.floor((Date.now() - new Date(emp.hire_date).getTime()) / (1000 * 60 * 60 * 24 * 30.4375)))
        : 0

      // L'offre doit exister, être interne-visible, ouverte ET éligible pour cet
      // employé (mêmes filtres de ciblage que GET /recruitment/internal-jobs).
      // Sinon 404 neutre — OWASP A01 : ne jamais révéler une offre hors périmètre.
      const jobRes = await pool.query<{ title: string; interview_focus: unknown; experience_level: string | null }>(
        `SELECT rj.title, rj.interview_focus, rj.experience_level
           FROM "${schema}".recruitment_jobs rj
          WHERE rj.id = $1
            AND rj.visibility IN ('internal','both')
            AND rj.status = 'open'
            AND (COALESCE(cardinality(rj.target_departments), 0) = 0
                 OR ($2::uuid IS NOT NULL AND $2::uuid = ANY(rj.target_departments)))
            AND (COALESCE(cardinality(rj.target_job_levels), 0) = 0
                 OR ($3::varchar IS NOT NULL AND $3::varchar = ANY(rj.target_job_levels)))
            AND (rj.target_min_seniority_months IS NULL OR rj.target_min_seniority_months <= $4::int)
            AND (rj.target_legal_entity_id IS NULL OR rj.target_legal_entity_id = $5::uuid)
          LIMIT 1`,
        [jobId, emp.department_id, emp.job_level, seniorityMonths, emp.legal_entity_id],
      )
      const job = jobRes.rows[0]
      if (!job) return reply.status(404).send({ error: 'Offre introuvable' })

      const sec = await pool.query<{ sector: string | null }>(`SELECT sector FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema])
      const secteur = sec.rows[0]?.sector ?? null
      const cfg = await loadTenantConfig(schema)
      const langue = cfg.default_langue
      const roleKey = normalizeRoleKey(job.title, secteur)
      const bank = await readBank(roleKey, langue)
      const ctx: PosteContext = {
        title: job.title, secteur, langue,
        interviewFocus: parseInterviewFocus(job.interview_focus),
        experienceLevel: job.experience_level ?? null,
      }
      const creds = await resolveAiCreds(schema)
      const gen = await genererQuestions(ctx, bank?.questions ?? [], cfg.questions_count, creds)
      if (!gen.fromBank && gen.questions.length > 0) {
        await feedBank(roleKey, secteur, langue, gen.questions, gen.sourceModel)
      }
      return reply.send({
        data: {
          jobId, jobTitle: job.title, langue, roleKey, nbQuestions: cfg.questions_count,
          questions: gen.questions, categories: gen.categories,
        },
      })
    },
  })

  // ── POST /interview-sim/internal-jobs/:jobId/submit : retour ÉPHÉMÈRE (rien stocké) ──
  fastify.post('/internal-jobs/:jobId/submit', {
    preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser],
    schema: { tags: ['interview-sim'], summary: 'Soumettre l’entretien d’une offre interne (retour éphémère)' },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const user = request.user
      if (!user.employeeId) return badRequest(reply, 'Votre compte n’est pas lié à un employé.')
      const schema = user.schemaName
      const { jobId } = request.params as { jobId: string }
      const parsed = internalJobSubmitSchema.safeParse(request.body)
      if (!parsed.success) return badRequest(reply)
      const body = parsed.data

      const jobRes = await pool.query<{ title: string }>(
        `SELECT title FROM "${schema}".recruitment_jobs WHERE id = $1 AND visibility IN ('internal','both') LIMIT 1`,
        [jobId],
      )
      if (!jobRes.rows[0]) return reply.status(404).send({ error: 'Offre introuvable' })
      const title = jobRes.rows[0].title
      const sec = await pool.query<{ sector: string | null }>(`SELECT sector FROM platform.tenants WHERE schema_name = $1 LIMIT 1`, [schema])
      const secteur = sec.rows[0]?.sector ?? null

      const ctx: PosteContext = { title, secteur, langue: body.langue }
      const creds = await resolveAiCreds(schema)
      const retour: InterviewFeedback = await produireRetour(
        body.questions, body.answers as TranscriptItem[], ctx, creds, body.categories ?? [],
      )
      // ÉPHÉMÈRE : rien de personnel écrit. Au plus le compteur ANONYME agrégé.
      await incrementUsage(normalizeRoleKey(title, secteur), body.langue)
      return reply.send({ data: { retour } })
    },
  })
```

- [ ] **Step 4: Remove the five generic employee-scoped routes**

Supprimer de `interviewSimRoutes` les handlers : `fastify.get('/start', …)`, `fastify.post('/attempts/submit', …)`, `fastify.get('/my-attempts', …)`, `fastify.get('/my-attempts/:id', …)`, `fastify.delete('/my-attempts/:id', …)`. **Conserver** `fastify.get('/config'…)`, `fastify.put('/config'…)` et TOUT le bloc `interviewSimPublicRoutes`.

Supprimer aussi le `submitSchema` (devenu inutilisé) déclaré ~ligne 41. **Conserver** `transcriptItemSchema` (réutilisé par `internalJobSubmitSchema` et `publicSubmitSchema`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-sim.routes.internal.test.ts`
Expected: PASS.

- [ ] **Step 6: Run public routes + AI service suites (non-régression)**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-sim.routes.public.test.ts src/modules/interview-sim/interview-sim-ai.service.test.ts`
Expected: PASS (inchangés).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: 0 erreur.

- [ ] **Step 8: Commit**

```bash
git add -f apps/api/src/modules/interview-sim/interview-sim.routes.ts apps/api/src/modules/interview-sim/interview-sim.routes.internal.test.ts
git commit -m "feat(interview-sim): routes internes offre-scopées (éphémère) + retrait du self-service générique"
```

---

### Task 2: i18n — libellés offre + retrait de l'entrée menu

**Files:**
- Modify: `apps/web/src/i18n/locales/fr/monEspace.json`
- Modify: `apps/web/src/i18n/locales/en/monEspace.json`

**Interfaces:**
- Produces: `offers.trainInterview`, `offers.backToOffer` (namespace `monEspace`) consommés par Task 4. Retrait de `nav.interviewSim` + `nav.titles.interviewSim`.

- [ ] **Step 1: FR — ajouter les libellés d'offre**

Dans `fr/monEspace.json`, section `offers`, ajouter après `"viewOffer": "Voir l'offre",` :
```json
    "trainInterview": "S'entraîner à l'entretien",
    "backToOffer": "Retour à l'offre",
```

- [ ] **Step 2: FR — retirer l'entrée de menu**

Dans `fr/monEspace.json`, supprimer la clé `nav.interviewSim` (`"interviewSim": "Simulations d'entretien"`) et, sous `nav.titles`, la clé `interviewSim` si présente.

- [ ] **Step 3: EN — miroir**

Dans `en/monEspace.json`, section `offers`, ajouter après la clé `viewOffer` :
```json
    "trainInterview": "Practice the interview",
    "backToOffer": "Back to offer",
```
Puis supprimer `nav.interviewSim` et `nav.titles.interviewSim`.

- [ ] **Step 4: Vérifier la parité FR/EN**

Run: `cd apps/web && node -e "const fr=require('./src/i18n/locales/fr/monEspace.json'),en=require('./src/i18n/locales/en/monEspace.json');const f=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'?f(v,p+k+'.'):[p+k]);const a=f(fr).sort(),b=f(en).sort();console.log(JSON.stringify(a)===JSON.stringify(b)?'PARITY OK':'MISMATCH: '+JSON.stringify({onlyFr:a.filter(x=>!b.includes(x)),onlyEn:b.filter(x=>!a.includes(x))}))"`
Expected: `PARITY OK`.

- [ ] **Step 5: Commit**

```bash
git add -f apps/web/src/i18n/locales/fr/monEspace.json apps/web/src/i18n/locales/en/monEspace.json
git commit -m "i18n(interview-sim): libellés entretien par offre + retrait de l'entrée menu"
```

---

### Task 3: Web — composant `OfferInterviewRunner` (déroulé offre-scopé)

**Files:**
- Create: `apps/web/src/components/interview-sim/OfferInterviewRunner.tsx`
- Test: `apps/web/src/components/interview-sim/OfferInterviewRunner.test.tsx`

**Interfaces:**
- Consumes: `api` (`@/lib/api`), `useSpeech` (`@/hooks/useSpeech`), `InterviewRestitution` + `InterviewFeedback` (`@/components/interview-sim/InterviewRestitution`), routes de Task 1.
- Produces: `OfferInterviewRunner({ jobId, jobTitle, onBack }: { jobId: string; jobTitle: string; onBack: () => void })` — consommé par Task 4.

- [ ] **Step 1: Write the failing test**

Patron des tests composants du dépôt : `react-i18next` mocké avec un `t` qui renvoie la clé brute ; `@/lib/api` mocké ; `useSpeech` mocké non supporté (repli texte).

```tsx
// apps/web/src/components/interview-sim/OfferInterviewRunner.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/useSpeech', () => ({
  useSpeech: () => ({ supported: false, listening: false, speak: vi.fn(), startListening: vi.fn() }),
}))

import { OfferInterviewRunner } from './OfferInterviewRunner'

function renderRunner(onBack = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <OfferInterviewRunner jobId="job-1" jobTitle="Développeur" onBack={onBack} />
    </QueryClientProvider>,
  )
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset() })
afterEach(() => cleanup())

describe('OfferInterviewRunner', () => {
  it('charge les questions de l’offre au montage (start)', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    renderRunner()
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/start'))
    expect(await screen.findByText('Q1')).toBeTruthy()
  })

  it('soumet à la fin et affiche la restitution', async () => {
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    postMock.mockResolvedValue({ data: { data: { retour: { disponible: true, message: null, scoreGlobal: 80, scoresParCategorie: [], pointsForts: ['ok'], axesProgres: [], reponsesReperes: [] } } } })
    renderRunner()
    await screen.findByText('Q1')
    fireEvent.change(screen.getByPlaceholderText('answerPlaceholder'), { target: { value: 'ma réponse' } })
    fireEvent.click(screen.getByText('finishButton'))
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/submit', expect.objectContaining({ langue: 'fr', questions: ['Q1'] })))
    expect(await screen.findByText('feedbackTitle')).toBeTruthy()
  })

  it('le bouton retour appelle onBack', async () => {
    const onBack = vi.fn()
    getMock.mockResolvedValue({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
    renderRunner(onBack)
    fireEvent.click(await screen.findByText('offers.backToOffer'))
    expect(onBack).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node_modules/.bin/vitest run src/components/interview-sim/OfferInterviewRunner.test.tsx`
Expected: FAIL — `Cannot find module './OfferInterviewRunner'`.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/interview-sim/OfferInterviewRunner.tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { useSpeech } from '@/hooks/useSpeech'
import { InterviewRestitution, type InterviewFeedback } from '@/components/interview-sim/InterviewRestitution'

interface StartData {
  jobId: string; jobTitle: string; langue: 'fr' | 'en'
  roleKey: string; nbQuestions: number; questions: string[]; categories: string[]
}
type Answer = { index: number; question: string; transcript: string }

/**
 * Déroulé d'entretien calibré sur une OFFRE INTERNE, joué en place dans la fiche
 * offre (MesOffresInternes). Éphémère : rien n'est stocké — la restitution
 * s'affiche puis disparaît à la fermeture. Miroir authentifié du flux public.
 */
export function OfferInterviewRunner({ jobId, jobTitle, onBack }: { jobId: string; jobTitle: string; onBack: () => void }) {
  const { t } = useTranslation('interviewSim')
  const { t: tOffers } = useTranslation('monEspace')
  const speech = useSpeech()

  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>([])
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<InterviewFeedback | null>(null)

  const start = useQuery<StartData>({
    queryKey: ['interview-sim', 'internal-job', jobId],
    queryFn: async () => {
      const data = (await api.get(`/interview-sim/internal-jobs/${jobId}/start`)).data.data as StartData
      if (speech.supported && data.questions[0]) speech.speak(data.questions[0], data.langue === 'en' ? 'en-US' : 'fr-FR')
      return data
    },
    refetchOnWindowFocus: false,
  })

  const submit = useMutation({
    mutationFn: async (payload: { langue: string; questions: string[]; categories: string[]; answers: Answer[] }) =>
      (await api.post(`/interview-sim/internal-jobs/${jobId}/submit`, payload)).data.data as { retour: InterviewFeedback },
    onSuccess: (data) => setFeedback(data.retour),
  })

  const session = start.data

  function nextQuestion() {
    if (!session) return
    const item: Answer = { index: current, question: session.questions[current]!, transcript: draft.trim() }
    const nextAnswers = [...answers, item]
    setAnswers(nextAnswers); setDraft('')
    if (current + 1 < session.questions.length) {
      const n = current + 1; setCurrent(n)
      if (speech.supported) speech.speak(session.questions[n]!, session.langue === 'en' ? 'en-US' : 'fr-FR')
    } else {
      submit.mutate({ langue: session.langue, questions: session.questions, categories: session.categories ?? [], answers: nextAnswers })
    }
  }

  const backBtn = (
    <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> {tOffers('offers.backToOffer')}
    </button>
  )

  if (start.isLoading || !session) {
    return (
      <div className="space-y-4">
        {backBtn}
        <div className="flex justify-center py-8"><div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>
      </div>
    )
  }

  if (feedback) {
    return (
      <div className="space-y-4">
        {backBtn}
        <h3 className="text-lg font-semibold">{t('feedbackTitle')}</h3>
        <InterviewRestitution feedback={feedback} />
        <p className="text-xs text-muted-foreground">{t('ephemeralNotice')}</p>
      </div>
    )
  }

  const currentCategory = session.categories?.[current]
  return (
    <div className="space-y-4">
      {backBtn}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{t('questionProgress', { current: current + 1, total: session.questions.length })}</span>
        {currentCategory && currentCategory !== 'Général' && (
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{currentCategory}</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(current / session.questions.length) * 100}%` }} />
      </div>
      <p className="text-lg font-medium">{session.questions[current]}</p>
      <textarea className="w-full rounded border p-2" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('answerPlaceholder')} />
      <div className="flex gap-2">
        {speech.supported && (
          <button className="rounded border px-3 py-2" onClick={() => speech.startListening(session.langue === 'en' ? 'en-US' : 'fr-FR', (txt) => setDraft((d) => (d ? d + ' ' : '') + txt))}>
            {speech.listening ? t('listening') : t('speakButton')}
          </button>
        )}
        <button className="rounded bg-primary px-4 py-2 text-white" onClick={nextQuestion} disabled={submit.isPending}>
          {current + 1 < session.questions.length ? t('nextButton') : t('finishButton')}
        </button>
      </div>
      {!speech.supported && <p className="text-sm text-amber-600">{t('voiceUnsupported')}</p>}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && node_modules/.bin/vitest run src/components/interview-sim/OfferInterviewRunner.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: 0 erreur.

- [ ] **Step 6: Commit**

```bash
git add -f apps/web/src/components/interview-sim/OfferInterviewRunner.tsx apps/web/src/components/interview-sim/OfferInterviewRunner.test.tsx
git commit -m "feat(interview-sim): composant OfferInterviewRunner (entretien offre-scopé, éphémère)"
```

---

### Task 4: Web — bouton + entretien en place dans `MesOffresInternes` ; retrait du self-service

**Files:**
- Modify: `apps/web/src/pages/mon-espace/MesOffresInternes.tsx`
- Test (new): `apps/web/src/pages/mon-espace/MesOffresInternes.test.tsx`
- Modify: `apps/web/src/components/layout/EmployeeLayout.tsx` (retrait nav ligne ~31 + `ROUTE_TITLE_KEYS` ligne ~47)
- Modify: `apps/web/src/App.tsx` (retrait import ligne ~149 + route `path="simulations"` ligne ~522)
- Delete: `apps/web/src/pages/mon-espace/MesSimulations.tsx`
- Delete: `apps/web/src/pages/mon-espace/MesSimulations.test.tsx`

**Interfaces:**
- Consumes: `OfferInterviewRunner` (Task 3), libellés `offers.trainInterview`/`offers.backToOffer` (Task 2).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/pages/mon-espace/MesOffresInternes.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock }, formatFCFA: (n: number) => `${n} FCFA` }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/useSpeech', () => ({ useSpeech: () => ({ supported: false, listening: false, speak: vi.fn(), startListening: vi.fn() }) }))
vi.mock('@/lib/apec', () => ({ apecMetaPairs: () => [] }))

import MesOffresInternes from './MesOffresInternes'

const JOB = { id: 'job-1', title: 'Développeur', department_name: 'IT', location: 'Abidjan', contract_type: 'cdi', salary_min: null, salary_max: null, description: 'desc', requirements: null, visibility: 'internal', target_min_seniority_months: null, created_at: '2026-01-01', already_applied: 0 }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MesOffresInternes /></QueryClientProvider>)
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset() })
afterEach(() => cleanup())

describe('MesOffresInternes — entretien par offre', () => {
  it('la modale de détail affiche le bouton « s’entraîner »', async () => {
    getMock.mockImplementation((url: string) => url === '/recruitment/internal-jobs'
      ? Promise.resolve({ data: { data: [JOB] } })
      : Promise.resolve({ data: { data: {} } }))
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    expect(await screen.findByText('offers.trainInterview')).toBeTruthy()
  })

  it('clic « s’entraîner » → bascule en entretien (start appelé)', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/recruitment/internal-jobs') return Promise.resolve({ data: { data: [JOB] } })
      if (url === '/interview-sim/internal-jobs/job-1/start') return Promise.resolve({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
      return Promise.resolve({ data: { data: {} } })
    })
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    fireEvent.click(await screen.findByText('offers.trainInterview'))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/start'))
    expect(await screen.findByText('Q1')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node_modules/.bin/vitest run src/pages/mon-espace/MesOffresInternes.test.tsx`
Expected: FAIL — pas de bouton `offers.trainInterview`.

- [ ] **Step 3: Wire the interview into the modal**

Dans `MesOffresInternes.tsx` :

(a) Ajouter l'import :
```tsx
import { OfferInterviewRunner } from '@/components/interview-sim/OfferInterviewRunner'
```

(b) Ajouter un état de mode près des autres `useState` (après `const [selected, setSelected] = useState<InternalJob | null>(null)`) :
```tsx
  const [mode, setMode] = useState<'detail' | 'interview'>('detail')
```

(c) À l'ouverture d'une offre, réinitialiser le mode. Remplacer le `onClick` du bouton « Voir l'offre » :
```tsx
                <button onClick={() => { setSelected(job); setMode('detail'); setError(null); setSuccess(null) }}
```
et la fermeture par fond, remplacer `onClick={() => setSelected(null)}` (ligne du conteneur `fixed inset-0`) par :
```tsx
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { setSelected(null); setMode('detail') }}>
```

(d) Dans la modale, englober le contenu de détail existant dans `mode === 'detail'` et ajouter la branche entretien. Juste après la ligne d'en-tête `<h3 className="text-lg font-semibold">{selected.title}</h3>` et son sous-titre, insérer la bascule : si `mode === 'interview'`, rendre le runner à la place du détail :
```tsx
            {mode === 'interview' ? (
              <div className="mt-4">
                <OfferInterviewRunner jobId={selected.id} jobTitle={selected.title} onBack={() => setMode('detail')} />
              </div>
            ) : (
              <>
                {/* … tout le bloc détail existant (méta APEC, description, formulaire de candidature) … */}
              </>
            )}
```
(Envelopper le bloc allant de la grille méta APEC jusqu'au bloc des boutons Annuler/Envoyer dans le `<>…</>` de la branche `detail`.)

(e) Dans la barre d'actions de la branche `detail`, ajouter le bouton « s'entraîner » à gauche de « Postuler ». Remplacer le conteneur `<div className="mt-5 flex justify-end gap-2">` par :
```tsx
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button onClick={() => setMode('interview')}
                className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary/5">
                {t('offers.trainInterview')}
              </button>
              <button onClick={() => setSelected(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-accent">
                {t('common.cancel')}
              </button>
              <button onClick={() => apply.mutate({ id: selected.id, cover_letter: coverLetter, phone })}
                disabled={apply.isPending || coverLetter.trim().length < 10}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {apply.isPending ? t('offers.sending') : t('offers.sendApplication')}
              </button>
            </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && node_modules/.bin/vitest run src/pages/mon-espace/MesOffresInternes.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Remove the self-service page, nav entry and route**

(a) Supprimer les fichiers :
```bash
git rm -f apps/web/src/pages/mon-espace/MesSimulations.tsx apps/web/src/pages/mon-espace/MesSimulations.test.tsx
```

(b) Dans `EmployeeLayout.tsx`, supprimer la ligne du tableau de nav :
```tsx
  { to: '/mon-espace/simulations',  labelKey: 'nav.interviewSim', icon: MessagesSquare, moduleKey: 'interview_sim' },
```
et l'entrée de `ROUTE_TITLE_KEYS` :
```tsx
  '/mon-espace/simulations': 'nav.titles.interviewSim',
```
Puis retirer `MessagesSquare` de l'import `lucide-react` s'il n'est plus utilisé ailleurs dans le fichier (vérifier avec une recherche `MessagesSquare` dans le fichier ; sinon laisser).

(c) Dans `App.tsx`, supprimer la déclaration lazy `const MesSimulations = lazy(...)` (~ligne 149) et la `<Route path="simulations" …>` (~lignes 522-525).

- [ ] **Step 6: Verify no dangling reference + typecheck**

Run: `cd apps/web && grep -rn "MesSimulations\|/mon-espace/simulations\|nav.interviewSim" src || echo "AUCUNE REF"`
Expected: `AUCUNE REF` (hors éventuelles occurrences dans le golden, traité en Task 6).

Run: `pnpm --filter web exec tsc --noEmit`
Expected: 0 erreur.

- [ ] **Step 7: Commit**

```bash
git add -f apps/web/src/pages/mon-espace/MesOffresInternes.tsx apps/web/src/pages/mon-espace/MesOffresInternes.test.tsx apps/web/src/components/layout/EmployeeLayout.tsx apps/web/src/App.tsx
git commit -m "feat(interview-sim): entretien en place dans la fiche offre interne + retrait du self-service"
```

---

### Task 5: Web — refonte esthétique de la restitution (skill frontend-design)

**Files:**
- Modify: `apps/web/src/components/interview-sim/InterviewRestitution.tsx`

**Interfaces:**
- L'API publique du composant NE CHANGE PAS : `InterviewRestitution({ feedback }: { feedback: InterviewFeedback })`, `InterviewFeedback`, `CategoryScore`, `scoreTone`, `ScoreGauge` restent exportés avec la même signature. Consommé par `OfferInterviewRunner` (interne) et `PublicInterviewSimPage` (public) — aucune modification chez les appelants.

- [ ] **Step 1: Invoke the frontend-design skill**

Invoquer `frontend-design:frontend-design` pour piloter la direction visuelle. Contraintes à respecter :
- Refondre la présentation du **score global** (jauge), des **scores par catégorie**, du bloc **forces / axes de progrès** et des **réponses repères**.
- Rester **thème-aware** via le design system existant (`bg-card`, `text-muted-foreground`, `border-border`, `bg-muted`, couleur `primary` du tenant). Pas de couleurs codées en dur hors de l'échelle sémantique déjà présente (`scoreTone` : rouge/ambre/vert).
- Accessibilité : conserver `role="img"` + `aria-label` sur la jauge SVG ; contrastes suffisants ; hiérarchie de titres cohérente.
- Responsive : disposition qui tient sur mobile (colonne) et desktop (jauge + catégories côte à côte).
- Ne PAS changer l'interface `InterviewFeedback` ni les noms exportés.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: 0 erreur.

- [ ] **Step 3: Run the consumers' tests (non-régression, API inchangée)**

Run: `cd apps/web && node_modules/.bin/vitest run src/components/interview-sim/OfferInterviewRunner.test.tsx src/pages/public/PublicInterviewSimPage.test.tsx src/pages/mon-espace/MesOffresInternes.test.tsx`
Expected: PASS (les tests portent sur la présence des libellés/flux, pas sur le pixel — inchangés).

- [ ] **Step 4: Commit**

```bash
git add -f apps/web/src/components/interview-sim/InterviewRestitution.tsx
git commit -m "feat(interview-sim): refonte esthétique de la restitution (frontend-design), partagée interne+public"
```

---

### Task 6: Golden contract + suites complètes vertes

**Files:**
- Modify: `apps/api/src/modules/interview-sim/interview-sim.ui-contract.golden.test.ts`

**Interfaces:**
- Consumes: état final backend (Task 1) + web (Tasks 2-4). Aucune interface produite.

- [ ] **Step 1: Update the golden assertions**

Dans `interview-sim.ui-contract.golden.test.ts` :

(a) Bloc `GOLDEN interview_sim — endpoints` → remplacer le test `routes internes + config` par :
```typescript
  it('routes internes offre-scopées + config', () => {
    expect(routes).toContain(`fastify.get('/internal-jobs/:jobId/start'`)
    expect(routes).toContain(`fastify.post('/internal-jobs/:jobId/submit'`)
    expect(routes).toContain(`fastify.get('/config'`)
    expect(routes).toContain(`fastify.put('/config'`)
  })
```

(b) Supprimer le test `isolation employee_id (jamais le body) + effacement` (les routes my-attempts/DELETE n'existent plus). Le remplacer par un test d'éphémérité :
```typescript
  it('flux interne éphémère : aucune référence à interview_sim_attempts dans les routes', () => {
    // Les routes offre-scopées ne persistent rien (RGPD, décision 2026-07-23).
    // (La route /config garde son INSERT INTO interview_sim_config — non concerné.)
    expect(routes).not.toContain('interview_sim_attempts')
    expect(routes).toContain(`incrementUsage(normalizeRoleKey(`)
  })
```

(c) Bloc `GOLDEN interview_sim — web` → remplacer les deux tests par :
```typescript
  it('bouton entretien sur la fiche offre interne (plus de menu self-service)', () => {
    const offres = readWeb('pages', 'mon-espace', 'MesOffresInternes.tsx')
    expect(offres).toContain('OfferInterviewRunner')
    expect(offres).toContain(`t('offers.trainInterview')`)
    expect(employeeLayout).not.toContain(`to: '/mon-espace/simulations'`)
    expect(appTsx).not.toContain('MesSimulations')
  })
  it('page publique inchangée + composant de restitution partagé', () => {
    expect(appTsx).toContain('PublicInterviewSimPage')
    expect(appTsx).toContain('/entrainement-entretien/:token')
    const runner = readWeb('components', 'interview-sim', 'OfferInterviewRunner.tsx')
    expect(runner).toContain('InterviewRestitution')
  })
```

(d) Bloc `GOLDEN interview_sim — i18n FR/EN` → le test vérifie `nav.interviewSim` défini dans `monEspace` : le remplacer par la vérification des nouveaux libellés d'offre :
```typescript
  it('namespace enregistré + libellés entretien par offre, sans BOM', () => {
    expect(i18nIndex).toMatch(/interviewSim/)
    for (const lang of ['fr', 'en']) {
      const raw = readWeb('i18n', 'locales', lang, 'interviewSim.json')
      expect(raw.charCodeAt(0)).not.toBe(0xfeff)
      const off = JSON.parse(readWeb('i18n', 'locales', lang, 'monEspace.json')) as { offers?: Record<string, unknown>; nav?: Record<string, unknown> }
      expect(off.offers?.trainInterview).toBeDefined()
      expect(off.offers?.backToOffer).toBeDefined()
      expect(off.nav?.interviewSim).toBeUndefined()
    }
  })
```

- [ ] **Step 2: Run the golden test**

Run: `cd apps/api && node_modules/.bin/vitest run src/modules/interview-sim/interview-sim.ui-contract.golden.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the FULL API + web suites (non-régression globale)**

Run: `cd apps/api && node_modules/.bin/vitest run`
Expected: tous verts (aucune référence résiduelle aux routes supprimées). Note flaky connu : un re-run peut être nécessaire si des fichiers échouent avec « 0 test » sous charge (transform timeout).

Run: `cd apps/web && node_modules/.bin/vitest run`
Expected: tous verts.

- [ ] **Step 4: Typechecks finaux**

Run: `pnpm --filter api exec tsc --noEmit && pnpm --filter web exec tsc --noEmit`
Expected: 0 erreur des deux côtés.

- [ ] **Step 5: Commit**

```bash
git add -f apps/api/src/modules/interview-sim/interview-sim.ui-contract.golden.test.ts
git commit -m "test(interview-sim): golden contrat aligné sur l'entretien offre-scopé"
```

---

## Notes d'exécution

- Entre Task 1 et Task 6, le golden `interview-sim.ui-contract.golden.test.ts` est **volontairement rouge** (il décrit encore l'ancien contrat). Chaque tâche intermédiaire ne lance que son test ciblé ; Task 6 réconcilie le golden et lance les suites complètes.
- Aucune migration ni table supprimée : zéro risque sur les tenants existants déjà déployés.
- Déploiement : une fois toutes les tâches vertes, suivre la routine de recette (push branche → PR `develop` → merge → PR `develop→main` → déploiement + reseed).
