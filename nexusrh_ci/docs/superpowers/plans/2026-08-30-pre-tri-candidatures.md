# Pré-tri des candidatures — plan d'implémentation

> **Pour les agents d'exécution :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les étapes
> utilisent la syntaxe case à cocher (`- [ ]`) pour le suivi.

**Objectif :** rendre le pré-tri des candidatures opérationnel, consultable dans un écran de
revue dédié, et conforme (aucun rejet sans décision humaine).

**Architecture :** deux évaluations déterministes indépendantes — les questions éliminatoires
au dépôt (sans IA) et les règles dures sur l'extraction IA du CV — produisent un *verdict
machine*. Une *décision humaine* distincte, prise dans un écran deux volets, conditionne
seule l'entrée dans le kanban. Le moteur de règles existant (`evaluateScreening`, pur et
testé) est enfin branché.

**Pile :** Fastify 5, PostgreSQL (schéma par tenant), Zod, React 18 + TanStack Query,
Vitest 3, i18next.

**Spec :** `docs/superpowers/specs/2026-08-30-pre-tri-candidatures-design.md`

## Contraintes globales

- **Migrations** : uniquement dans `ensureRecruitmentSchemaMigrated`
  (`apps/api/src/db/provisioning.ts`). Jamais dans le seed — il ne s'exécute pas en
  production. La fonction **n'est pas mémoïsée** : chaque instruction doit être idempotente.
- **Piste d'audit** : `auditTenant` depuis `apps/api/src/utils/audit-log.ts`. Une écriture
  directe `INSERT INTO … audit_log` fait échouer `architecture-invariants.golden.test.ts`.
- **Erreurs 400** : `badRequest` / `badRequestFromZod` depuis `apps/api/src/utils/http-errors.ts`.
- **TypeScript strict** : pas de `any`, pas de `@ts-ignore`.
- **i18n** : toute clé ajoutée à `fr/recruitment.json` doit l'être aussi dans
  `en/recruitment.json`.
- **Fichiers nouveaux** : `git add -f` obligatoire (le `.gitignore` racine masque
  `nexusrh_ci/`).
- **Montants** : FCFA en entiers, jamais de décimale.
- **Commandes de test** : exécutées depuis `apps/api` (backend) ou `apps/web` (frontend).

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `apps/api/src/services/recruitment-screening.service.ts` *(modifié)* | Moteur pur. Ajout de `ScreeningQuestion`, `sanitizeQuestions`, `evaluateQuestions`, `combineVerdicts`. Aucune I/O. |
| `apps/api/src/modules/recruitment/screening.repository.ts` *(créé)* | Accès données du pré-tri. Reçoit le schéma à la construction — première application de la direction A-05 de l'audit. |
| `apps/api/src/modules/recruitment/screening.routes.ts` *(créé)* | Les 6 endpoints de pré-tri, enregistrés depuis `recruitment.routes.ts`. Évite d'agrandir un fichier de 2 000 lignes. |
| `apps/api/src/modules/recruitment/recruitment.routes.ts` *(modifié)* | Branchement du moteur dans `preselect` / `analyze-cv` ; questions au dépôt public ; filtre kanban. |
| `apps/api/src/db/provisioning.ts` *(modifié)* | Colonnes + rattrapage non rejouable. |
| `apps/web/src/pages/recruitment/ScreeningReview.tsx` *(créé)* | Écran deux volets. |
| `apps/web/src/pages/recruitment/RecruitmentPage.tsx` *(modifié)* | Nouvel onglet ; `ScreeningCriteriaPanel` déplacé vers le nouveau fichier. |

---

### Task 1 : Migration et rattrapage non rejouable

C'est la tâche la plus risquée du lot : un rattrapage mal écrit approuverait automatiquement
tous les dossiers en attente de revue. On la traite en premier, avec son test.

**Fichiers :**
- Modifier : `apps/api/src/db/provisioning.ts` (dans `ensureRecruitmentSchemaMigrated`, après la ligne `expected_salary bigint`)
- Test : `apps/api/src/db/screening-backfill.golden.test.ts` *(créé)*

**Interfaces :**
- Consomme : rien.
- Produit : colonnes `applications.screening_verdict` (NOT NULL, défaut `'pass'`),
  `screening_answers`, `screening_decided_by`, `screening_decided_at`, `screening_reason` ;
  `recruitment_jobs.screening_questions`. `screening_decision` change de sémantique :
  `'kept' | 'dismissed' | NULL` (décision humaine).

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/db/screening-backfill.golden.test.ts
/**
 * Golden — le rattrapage du pré-tri n'est PAS rejouable.
 *
 * `ensureRecruitmentSchemaMigrated` n'est pas mémoïsée : elle rejoue toutes ses
 * instructions à chaque appel. Un rattrapage naïf approuverait donc à chaque
 * requête les dossiers en attente de revue — exactement la garantie que le
 * pré-tri est censé offrir. La non-rejouabilité est ici STRUCTURELLE : après le
 * `SET NOT NULL` final, plus aucune ligne ne peut satisfaire la condition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test' } },
}))

import { ensureRecruitmentSchemaMigrated } from './provisioning.js'

const sqlOf = (calls: unknown[][]) => calls.map(c => String(c[0]).replace(/\s+/g, ' '))

beforeEach(() => { queryMock.mockClear() })

describe('Rattrapage du pré-tri', () => {
  it('pose le verdict en NOT NULL avec défaut, APRÈS le rattrapage', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const sql = sqlOf(queryMock.mock.calls)
    const iAdd  = sql.findIndex(s => /ADD COLUMN IF NOT EXISTS screening_verdict/.test(s))
    const iFill = sql.findIndex(s => /UPDATE .*applications SET screening_decision = COALESCE/.test(s))
    const iNn   = sql.findIndex(s => /ALTER COLUMN screening_verdict SET NOT NULL/.test(s))
    expect(iAdd, 'colonne screening_verdict ajoutée').toBeGreaterThanOrEqual(0)
    expect(iFill, 'rattrapage présent').toBeGreaterThan(iAdd)
    expect(iNn, 'NOT NULL posé APRÈS le rattrapage').toBeGreaterThan(iFill)
  })

  it('le rattrapage ne cible que les lignes SANS verdict', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const fill = sqlOf(queryMock.mock.calls)
      .find(s => /UPDATE .*applications SET screening_decision = COALESCE/.test(s))
    expect(fill).toBeDefined()
    // La condition doit porter sur screening_verdict, jamais sur screening_decision
    // seule : sinon chaque réexécution déciderait les dossiers en attente.
    expect(fill).toMatch(/WHERE screening_verdict IS NULL/)
    expect(fill).not.toMatch(/WHERE screening_decision IS NULL/)
  })

  it('rejouer dix fois produit exactement la même séquence', async () => {
    await ensureRecruitmentSchemaMigrated('tenant_demo')
    const first = sqlOf(queryMock.mock.calls)
    for (let i = 0; i < 9; i++) {
      queryMock.mockClear()
      await ensureRecruitmentSchemaMigrated('tenant_demo')
      expect(sqlOf(queryMock.mock.calls)).toEqual(first)
    }
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/db/screening-backfill.golden.test.ts
```
Attendu : ÉCHEC — « colonne screening_verdict ajoutée » reçoit `-1`.

- [ ] **Étape 3 : écrire la migration**

Dans `apps/api/src/db/provisioning.ts`, à la fin de `ensureRecruitmentSchemaMigrated`,
juste après `ADD COLUMN IF NOT EXISTS expected_salary bigint` :

```ts
  // ── Pré-tri : verdict MACHINE et décision HUMAINE, désormais distincts ──────
  // `screening_decision` portait le verdict machine dans l'intention d'origine,
  // mais n'a jamais été écrite (aucune ligne en production) : elle est
  // redéfinie ici en DÉCISION HUMAINE ('kept' | 'dismissed' | NULL).
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS screening_answers    jsonb DEFAULT '{}'`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS screening_verdict    varchar(10)`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS screening_decided_by uuid`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS screening_decided_at timestamptz`)
  await q(`ALTER TABLE ${s}.applications ADD COLUMN IF NOT EXISTS screening_reason     text`)
  await q(`ALTER TABLE ${s}.recruitment_jobs ADD COLUMN IF NOT EXISTS screening_questions jsonb DEFAULT '[]'`)

  // Rattrapage : une candidature SANS verdict est nécessairement antérieure à
  // cette migration. Sans ce rattrapage, la règle « rien n'entre dans le kanban
  // sans décision humaine » ferait disparaître tout l'historique.
  await q(`
    UPDATE ${s}.applications
       SET screening_decision = COALESCE(screening_decision, 'kept'),
           screening_verdict  = 'pass',
           screening_reason   = COALESCE(screening_reason,
             'Antériorité : candidature reçue avant la mise en place du pré-tri')
     WHERE screening_verdict IS NULL`)

  // Après ces deux instructions, AUCUNE ligne ne peut plus avoir un verdict NULL :
  // le rattrapage ci-dessus devient insatisfiable pour toujours. C'est ce qui le
  // rend non rejouable — pas une mémoïsation, qui n'existe pas ici.
  await q(`ALTER TABLE ${s}.applications ALTER COLUMN screening_verdict SET DEFAULT 'pass'`)
  await q(`ALTER TABLE ${s}.applications ALTER COLUMN screening_verdict SET NOT NULL`)
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

```
cd apps/api && npx vitest run src/db/screening-backfill.golden.test.ts
```
Attendu : 3 tests PASS.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/db/screening-backfill.golden.test.ts
git add nexusrh_ci/apps/api/src/db/provisioning.ts
git commit -m "feat(recruitment): verdict machine et décision humaine séparés en base"
```

---

### Task 2 : Questions éliminatoires — moteur pur

**Fichiers :**
- Modifier : `apps/api/src/services/recruitment-screening.service.ts` (ajouts en fin de fichier)
- Test : `apps/api/src/services/recruitment-screening.questions.test.ts` *(créé)*

**Interfaces :**
- Consomme : `ScreeningVerdict` (déjà exporté par ce fichier).
- Produit :
  - `interface ScreeningQuestion { id: string; label: string; type: 'boolean'|'number'|'choice'; options?: string[]; required: boolean; knockout: boolean; rule?: QuestionRule }`
  - `type QuestionRule = { op: 'is'; value: boolean } | { op: 'min'|'max'; value: number } | { op: 'in'; value: string[] }`
  - `sanitizeQuestions(input: unknown): ScreeningQuestion[]`
  - `evaluateQuestions(questions: ScreeningQuestion[], answers: Record<string, unknown>): { failedRules: string[] }`
  - `combineVerdicts(q: { failedRules: string[] }, cv: ScreeningVerdict | null): { verdict: 'pass'|'flagged'; failedRules: string[] }`

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/services/recruitment-screening.questions.test.ts
import { describe, it, expect } from 'vitest'
import {
  sanitizeQuestions, evaluateQuestions, combineVerdicts,
  type ScreeningQuestion,
} from './recruitment-screening.service.js'

const q = (over: Partial<ScreeningQuestion>): ScreeningQuestion => ({
  id: 'q1', label: 'Question', type: 'boolean', required: true, knockout: true,
  rule: { op: 'is', value: true }, ...over,
})

describe('evaluateQuestions — types et opérateurs', () => {
  it('booléen : réponse conforme → aucune règle échouée', () => {
    expect(evaluateQuestions([q({ label: 'Permis B ?' })], { q1: true }).failedRules).toEqual([])
  })

  it('booléen : réponse non conforme → règle échouée, libellé lisible', () => {
    const r = evaluateQuestions([q({ label: 'Permis B ?' })], { q1: false })
    expect(r.failedRules).toHaveLength(1)
    expect(r.failedRules[0]).toContain('Permis B ?')
  })

  it('numérique min : sous le seuil → échoue, au seuil → passe', () => {
    const question = q({ type: 'number', label: 'Années d’expérience', rule: { op: 'min', value: 5 } })
    expect(evaluateQuestions([question], { q1: 3 }).failedRules).toHaveLength(1)
    expect(evaluateQuestions([question], { q1: 5 }).failedRules).toEqual([])
  })

  it('numérique max : au-dessus du plafond → échoue', () => {
    const question = q({ type: 'number', label: 'Prétention', rule: { op: 'max', value: 500000 } })
    expect(evaluateQuestions([question], { q1: 800000 }).failedRules).toHaveLength(1)
  })

  it('choix : hors liste → échoue, dans la liste → passe', () => {
    const question = q({
      type: 'choice', label: 'Ville', options: ['Abidjan', 'Bouaké'],
      rule: { op: 'in', value: ['Abidjan'] },
    })
    expect(evaluateQuestions([question], { q1: 'Bouaké' }).failedRules).toHaveLength(1)
    expect(evaluateQuestions([question], { q1: 'Abidjan' }).failedRules).toEqual([])
  })
})

describe('evaluateQuestions — prudence', () => {
  it('réponse MANQUANTE → jamais d’exclusion (bascule en revue humaine)', () => {
    expect(evaluateQuestions([q({})], {}).failedRules).toEqual([])
    expect(evaluateQuestions([q({})], { q1: null }).failedRules).toEqual([])
  })

  it('question informative (knockout: false) → jamais d’exclusion', () => {
    expect(evaluateQuestions([q({ knockout: false })], { q1: false }).failedRules).toEqual([])
  })

  it('type et règle incohérents → ignorés plutôt qu’appliqués au hasard', () => {
    const bancal = q({ type: 'boolean', rule: { op: 'min', value: 5 } })
    expect(evaluateQuestions([bancal], { q1: false }).failedRules).toEqual([])
  })
})

describe('sanitizeQuestions', () => {
  it('rejette ce qui n’est pas un tableau', () => {
    expect(sanitizeQuestions(null)).toEqual([])
    expect(sanitizeQuestions({ a: 1 })).toEqual([])
  })

  it('borne à 15 questions et tronque les libellés à 300 caractères', () => {
    const many = Array.from({ length: 30 }, (_, i) => q({ id: `q${i}`, label: 'x'.repeat(500) }))
    const out = sanitizeQuestions(many)
    expect(out).toHaveLength(15)
    expect(out[0]!.label).toHaveLength(300)
  })

  it('knockout sans règle → dégradé en question informative', () => {
    const out = sanitizeQuestions([{ id: 'q1', label: 'L', type: 'boolean', required: true, knockout: true }])
    expect(out[0]!.knockout).toBe(false)
  })
})

describe('combineVerdicts', () => {
  const cvPass = { decision: 'review', knockoutFailed: false, belowScoreThreshold: false,
    failedRules: [], passedRules: [], autoRejectReason: null } as const

  it('questions OK + CV OK → pass', () => {
    expect(combineVerdicts({ failedRules: [] }, { ...cvPass }).verdict).toBe('pass')
  })

  it('CV non analysé → seules les questions comptent', () => {
    expect(combineVerdicts({ failedRules: [] }, null).verdict).toBe('pass')
    expect(combineVerdicts({ failedRules: ['Permis B exigé'] }, null).verdict).toBe('flagged')
  })

  it('l’un des deux échoue → flagged, et les motifs sont concaténés', () => {
    const cvKo = { ...cvPass, decision: 'auto_reject' as const, knockoutFailed: true,
      failedRules: ['5 ans exigés'] }
    const r = combineVerdicts({ failedRules: ['Permis B exigé'] }, cvKo)
    expect(r.verdict).toBe('flagged')
    expect(r.failedRules).toEqual(['Permis B exigé', '5 ans exigés'])
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/services/recruitment-screening.questions.test.ts
```
Attendu : ÉCHEC — `sanitizeQuestions is not a function`.

- [ ] **Étape 3 : implémenter**

À ajouter en fin de `apps/api/src/services/recruitment-screening.service.ts` :

```ts
// ── Questions éliminatoires (posées au dépôt) ────────────────────────────────
// Le filtre porte sur des données DÉCLARÉES par le candidat, pas inférées d'un
// CV : plus fiable, sans coût IA, et défendable face au candidat.

export type QuestionRule =
  | { op: 'is';  value: boolean }
  | { op: 'min'; value: number }
  | { op: 'max'; value: number }
  | { op: 'in';  value: string[] }

export interface ScreeningQuestion {
  id:       string
  label:    string
  type:     'boolean' | 'number' | 'choice'
  options?: string[]
  required: boolean
  /** false = informative : n'exclut jamais. */
  knockout: boolean
  rule?:    QuestionRule
}

const MAX_QUESTIONS = 15
const MAX_LABEL = 300

/** Une règle est-elle applicable au type de la question ? */
function ruleMatchesType(type: ScreeningQuestion['type'], rule: QuestionRule | undefined): boolean {
  if (!rule) return false
  if (type === 'boolean') return rule.op === 'is'
  if (type === 'number')  return rule.op === 'min' || rule.op === 'max'
  return rule.op === 'in'
}

/** Normalise et borne une définition de questions venue du client (jsonb libre). */
export function sanitizeQuestions(input: unknown): ScreeningQuestion[] {
  if (!Array.isArray(input)) return []
  const out: ScreeningQuestion[] = []
  for (const raw of input.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const type = r['type']
    if (type !== 'boolean' && type !== 'number' && type !== 'choice') continue
    const id = typeof r['id'] === 'string' && r['id'].trim() ? r['id'].trim().slice(0, 64) : null
    const label = typeof r['label'] === 'string' ? r['label'].trim().slice(0, MAX_LABEL) : ''
    if (!id || !label) continue
    const rule = r['rule'] as QuestionRule | undefined
    // Un knockout sans règle applicable ne peut rien exclure : on le dégrade en
    // question informative plutôt que de laisser un critère inopérant se croire actif.
    const knockout = r['knockout'] === true && ruleMatchesType(type, rule)
    const options = type === 'choice' && Array.isArray(r['options'])
      ? r['options'].filter((o): o is string => typeof o === 'string').slice(0, 20)
      : undefined
    out.push({
      id, label, type, required: r['required'] === true, knockout,
      ...(options ? { options } : {}),
      ...(knockout && rule ? { rule } : {}),
    })
  }
  return out
}

/**
 * Évalue les réponses du candidat contre les questions éliminatoires.
 * Prudence identique à `evaluateScreening` : une réponse MANQUANTE ne provoque
 * jamais d'exclusion — elle bascule le dossier en revue humaine.
 */
export function evaluateQuestions(
  questions: ScreeningQuestion[],
  answers: Record<string, unknown>,
): { failedRules: string[] } {
  const failedRules: string[] = []
  for (const q of questions) {
    if (!q.knockout || !q.rule || !ruleMatchesType(q.type, q.rule)) continue
    const a = answers[q.id]
    if (a === undefined || a === null || a === '') continue   // donnée absente → revue

    if (q.rule.op === 'is' && typeof a === 'boolean' && a !== q.rule.value) {
      failedRules.push(`${q.label} — réponse attendue : ${q.rule.value ? 'oui' : 'non'}`)
    } else if (q.rule.op === 'min' && typeof a === 'number' && a < q.rule.value) {
      failedRules.push(`${q.label} — minimum requis : ${q.rule.value} (déclaré : ${a})`)
    } else if (q.rule.op === 'max' && typeof a === 'number' && a > q.rule.value) {
      failedRules.push(`${q.label} — maximum accepté : ${q.rule.value} (déclaré : ${a})`)
    } else if (q.rule.op === 'in' && typeof a === 'string' && !q.rule.value.includes(a)) {
      failedRules.push(`${q.label} — réponse hors des valeurs acceptées`)
    }
  }
  return { failedRules }
}

/**
 * Combine le verdict des questions et celui des règles sur CV.
 * `cv` vaut null tant que le CV n'a pas été analysé : les questions suffisent
 * alors à trancher, ce qui rend le pré-tri utile AVANT toute dépense d'IA.
 */
export function combineVerdicts(
  q: { failedRules: string[] },
  cv: ScreeningVerdict | null,
): { verdict: 'pass' | 'flagged'; failedRules: string[] } {
  const failedRules = [...q.failedRules, ...(cv?.failedRules ?? [])]
  const flagged = q.failedRules.length > 0 || cv?.decision === 'auto_reject'
  return { verdict: flagged ? 'flagged' : 'pass', failedRules }
}
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

```
cd apps/api && npx vitest run src/services/recruitment-screening.questions.test.ts
```
Attendu : 13 tests PASS.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/services/recruitment-screening.questions.test.ts
git add nexusrh_ci/apps/api/src/services/recruitment-screening.service.ts
git commit -m "feat(recruitment): moteur pur des questions éliminatoires"
```

---

### Task 3 : Brancher le moteur de règles dans `preselect`

C'est le correctif du constat central : `evaluateScreening` n'a jamais été appelé.

**Fichiers :**
- Modifier : `apps/api/src/modules/recruitment/recruitment.routes.ts` (import ligne 10 ; bloc `UPDATE` de `preselect`, vers la ligne 1133)
- Test : `apps/api/src/modules/recruitment/screening-wiring.golden.test.ts` *(créé)*

**Interfaces :**
- Consomme : `evaluateScreening`, `combineVerdicts`, `sanitizeCriteria` (Task 2).
- Produit : après `preselect`, `applications.screening_verdict` et
  `screening_failed_rules` sont renseignées.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/modules/recruitment/screening-wiring.golden.test.ts
/**
 * Golden — le moteur de règles dures est RÉELLEMENT appelé par `preselect`.
 *
 * Régression corrigée : `evaluateScreening` était pur, testé, exporté… et
 * n'apparaissait dans aucun code de production. Les critères saisis par le
 * recruteur étaient enregistrés puis jamais lus.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { evaluateScreening } from '../../services/recruitment-screening.service.js'

describe('Branchement du moteur de pré-tri', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('`evaluateScreening` est importé par le module de routes recrutement', async () => {
    const { readFileSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const { dirname, join } = await import('path')
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, 'recruitment.routes.ts'), 'utf8')
    expect(src).toMatch(/evaluateScreening/)
    expect(src).toMatch(/combineVerdicts/)
    expect(src).toMatch(/screening_verdict\s*=/)
  })

  it('le moteur reste pur et exploitable tel quel', () => {
    const v = evaluateScreening(
      { minExperienceYears: 5, knockoutEnabled: true },
      { yearsExperience: 2 },
      90,
    )
    expect(v.decision).toBe('auto_reject')
    expect(v.failedRules.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/modules/recruitment/screening-wiring.golden.test.ts
```
Attendu : ÉCHEC sur `expect(src).toMatch(/evaluateScreening/)`.

- [ ] **Étape 3 : brancher**

Ligne 10 de `recruitment.routes.ts`, remplacer l'import existant :

```ts
import {
  sanitizeCriteria, evaluateScreening, combineVerdicts,
  type CandidateExtracted,
} from '../../services/recruitment-screening.service.js'
```

Dans `preselect`, le bloc `UPDATE … SET ai_score = $1, …` devient (colonnes de pré-tri
ajoutées à la fin de la liste `SET`, avant `updated_at`) :

```ts
            // Le résultat IA est confronté aux RÈGLES DURES de l'offre. L'IA
            // extrait (flou) ; les règles décident (objectif, reproductible).
            const extracted: CandidateExtracted = {
              yearsExperience: result.yearsExperience ?? null,
              skills:          result.skills ?? [],
              highestDiploma:  result.diploma ?? null,
              location:        result.location ?? null,
              languages:       result.languages ?? [],
              expectedSalary:  c.expected_salary ?? null,
            }
            const cvVerdict = evaluateScreening(criteria, extracted, result.score)
            const combined  = combineVerdicts({ failedRules: [] }, cvVerdict)

            await pool.query(`
              UPDATE "${schema}".applications
              SET ai_score = $1,
                  ai_summary = $2,
                  ai_recommendation = $3,
                  ai_match_percentage = $4,
                  ai_strengths = $5,
                  ai_gaps = $6,
                  ai_red_flags = $7,
                  ai_interview_questions = $8,
                  ai_model_used = $9,
                  ai_signals_used = $10,
                  ai_demographic_risk_note = $11,
                  ai_analyzed_at = now(),
                  screening_verdict = $13,
                  screening_failed_rules = $14,
                  screened_at = now(),
                  updated_at = now()
              WHERE id = $12
            `, [
              /* … paramètres 1 à 12 inchangés … */
              combined.verdict,
              JSON.stringify(combined.failedRules),
            ])
```

`criteria` provient des critères de l'offre, déjà chargés dans ce handler ; s'ils ne le sont
pas encore, les lire une fois avant la boucle :

```ts
      const critRes = await pool.query<{ screening_criteria: unknown }>(
        `SELECT screening_criteria FROM "${schema}".recruitment_jobs WHERE id = $1 LIMIT 1`,
        [id],
      )
      const criteria = sanitizeCriteria(critRes.rows[0]?.screening_criteria ?? {})
```

- [ ] **Étape 4 : lancer les tests du module**

```
cd apps/api && npx vitest run src/modules/recruitment
```
Attendu : tout PASS, y compris `screening-wiring.golden.test.ts`.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening-wiring.golden.test.ts
git add nexusrh_ci/apps/api/src/modules/recruitment/recruitment.routes.ts
git commit -m "fix(recruitment): brancher le moteur de règles dures, jamais appelé jusqu'ici"
```

---

### Task 4 : Dépôt d'accès aux données (repository)

**Fichiers :**
- Créer : `apps/api/src/modules/recruitment/screening.repository.ts`
- Test : `apps/api/src/modules/recruitment/screening.repository.test.ts`

**Interfaces :**
- Consomme : `ScreeningQuestion` (Task 2), `pool` (`db/pool.js`).
- Produit : `screeningRepo(schema: string)` exposant `getQuestions`, `setQuestions`,
  `listPending`, `saveVerdict`, `queue`, `decide`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/modules/recruitment/screening.repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../config.js', () => ({
  config: { env: 'test', database: { url: 'postgresql://test' } },
}))

import { screeningRepo } from './screening.repository.js'

beforeEach(() => { queryMock.mockClear(); queryMock.mockResolvedValue({ rows: [] }) })

describe('screeningRepo', () => {
  it('cloisonne toutes ses requêtes dans le schéma reçu à la construction', async () => {
    const repo = screeningRepo('tenant_sotra')
    await repo.getQuestions('job-1')
    await repo.queue('job-1', 20, 0)
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).toContain('"tenant_sotra".')
    }
  })

  it('refuse un nom de schéma non conforme', () => {
    expect(() => screeningRepo('tenant"; DROP SCHEMA public; --')).toThrow()
  })

  it('la file ne renvoie que les dossiers SANS décision humaine', async () => {
    await screeningRepo('tenant_sotra').queue('job-1', 20, 0)
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/screening_decision IS NULL/)
  })

  it('la file ne remonte jamais le binaire du CV', async () => {
    await screeningRepo('tenant_sotra').queue('job-1', 20, 0)
    expect(String(queryMock.mock.calls[0]![0])).not.toMatch(/cv_blob(?!\s+IS)/)
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/modules/recruitment/screening.repository.test.ts
```
Attendu : ÉCHEC — module introuvable.

- [ ] **Étape 3 : implémenter**

```ts
// apps/api/src/modules/recruitment/screening.repository.ts
/**
 * Accès aux données du pré-tri.
 *
 * Le schéma du tenant est reçu UNE FOIS à la construction et validé ici : les
 * appelants ne peuvent plus l'oublier dans une requête. C'est la première
 * application de la direction A-05 de l'audit du 30/08/2026 (872 requêtes SQL
 * écrites à la main dans les handlers), appliquée sur du code neuf.
 */
import { pool } from '../../db/pool.js'
import { isValidSchemaName } from '../../utils/schema-name.js'
import { sanitizeQuestions, type ScreeningQuestion } from '../../services/recruitment-screening.service.js'

export interface QueueRow {
  id: string; first_name: string; last_name: string; email: string
  screening_verdict: 'pass' | 'flagged'
  screening_failed_rules: string[]
  screening_answers: Record<string, unknown>
  ai_score: number | null; ai_summary: string | null
  has_cv: boolean; created_at: string
}

export function screeningRepo(schema: string) {
  if (!isValidSchemaName(schema)) throw new Error('Schéma tenant non conforme')
  const s = `"${schema}"`

  return {
    async getQuestions(jobId: string): Promise<ScreeningQuestion[]> {
      const r = await pool.query<{ screening_questions: unknown }>(
        `SELECT screening_questions FROM ${s}.recruitment_jobs WHERE id = $1 LIMIT 1`, [jobId])
      return sanitizeQuestions(r.rows[0]?.screening_questions ?? [])
    },

    async setQuestions(jobId: string, questions: ScreeningQuestion[]): Promise<boolean> {
      const r = await pool.query(
        `UPDATE ${s}.recruitment_jobs SET screening_questions = $1, updated_at = now()
          WHERE id = $2 RETURNING id`,
        [JSON.stringify(questions), jobId])
      return r.rows.length > 0
    },

    /** Candidatures de l'offre encore sans décision humaine — base de l'évaluation. */
    async listPending(jobId: string) {
      const r = await pool.query(
        `SELECT id, screening_answers, ai_score, ai_years_experience, ai_skills,
                ai_diploma, ai_location, ai_languages, expected_salary, ai_analyzed_at
           FROM ${s}.applications
          WHERE job_id = $1 AND screening_decision IS NULL`, [jobId])
      return r.rows
    },

    async saveVerdict(appId: string, verdict: 'pass' | 'flagged', failedRules: string[]) {
      await pool.query(
        `UPDATE ${s}.applications
            SET screening_verdict = $1, screening_failed_rules = $2,
                screened_at = now(), updated_at = now()
          WHERE id = $3`,
        [verdict, JSON.stringify(failedRules), appId])
    },

    /** File de revue : jamais le binaire du CV, seulement le drapeau. */
    async queue(jobId: string, limit: number, offset: number): Promise<QueueRow[]> {
      const r = await pool.query<QueueRow>(
        `SELECT id, first_name, last_name, email, screening_verdict,
                screening_failed_rules, screening_answers, ai_score, ai_summary,
                (cv_blob IS NOT NULL) AS has_cv, created_at
           FROM ${s}.applications
          WHERE job_id = $1 AND screening_decision IS NULL
          ORDER BY (screening_verdict = 'flagged'), created_at ASC
          LIMIT $2 OFFSET $3`,
        [jobId, limit, offset])
      return r.rows
    },

    async decide(appId: string, decision: 'kept' | 'dismissed', reason: string | null, userId: string) {
      const stage = decision === 'kept' ? 'screening' : 'rejected'
      const r = await pool.query<{ id: string; screening_verdict: string }>(
        `UPDATE ${s}.applications
            SET screening_decision = $1, screening_reason = $2,
                screening_decided_by = $3, screening_decided_at = now(),
                stage = $4, updated_at = now()
          WHERE id = $5 AND screening_decision IS NULL
          RETURNING id, screening_verdict`,
        [decision, reason, userId, stage, appId])
      return r.rows[0] ?? null
    },
  }
}
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

```
cd apps/api && npx vitest run src/modules/recruitment/screening.repository.test.ts
```
Attendu : 4 tests PASS.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening.repository.ts nexusrh_ci/apps/api/src/modules/recruitment/screening.repository.test.ts
git commit -m "feat(recruitment): dépôt d'accès aux données du pré-tri"
```

---

### Task 5 : Endpoints de pré-tri

**Fichiers :**
- Créer : `apps/api/src/modules/recruitment/screening.routes.ts`
- Modifier : `apps/api/src/modules/recruitment/recruitment.routes.ts` (enregistrer le sous-plugin)
- Test : `apps/api/src/modules/recruitment/screening.routes.test.ts`

**Interfaces :**
- Consomme : `screeningRepo` (Task 4), `evaluateQuestions`/`combineVerdicts`/`evaluateScreening` (Task 2), `auditTenant`, `badRequest`.
- Produit : 6 routes sous `/recruitment` — `GET|PUT /jobs/:id/screening-questions`,
  `POST /jobs/:id/screening/preview`, `POST /jobs/:id/screening/apply`,
  `GET /jobs/:id/screening/queue`, `PATCH /applications/:id/screening-decision`.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/modules/recruitment/screening.routes.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn().mockResolvedValue({ rows: [] }) }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  getTokenEpoch: vi.fn().mockResolvedValue(0),
}))
vi.mock('../../config.js', () => ({
  config: { env: 'test', jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
            database: { url: 'postgresql://test' }, redis: { url: 'redis://localhost:6380' } },
}))
vi.mock('../../db/provisioning.js', () => ({
  ensureRecruitmentSchemaMigrated: vi.fn().mockResolvedValue(undefined),
}))

import authPlugin from '../../plugins/auth.js'
import screeningRoutes from './screening.routes.js'

const JOB = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
let app: FastifyInstance

const token = (role: string) => app.jwt.sign({
  sub: '33333333-3333-4333-8333-333333333333', jti: 'j', tenantId: 't',
  schemaName: 'tenant_demo', role, email: 'a@b.ci', firstName: 'A', lastName: 'B',
  employeeId: null,
})
const auth = (role = 'hr_manager') => ({ authorization: `Bearer ${token(role)}` })

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(screeningRoutes, { prefix: '/recruitment' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { queryMock.mockClear(); queryMock.mockResolvedValue({ rows: [] }) })

describe('Questions éliminatoires', () => {
  it('un salarié ne peut pas lire la définition des questions', async () => {
    const r = await app.inject({ method: 'GET', url: `/recruitment/jobs/${JOB}/screening-questions`,
      headers: auth('employee') })
    expect(r.statusCode).toBe(403)
  })

  it('PUT borne à 15 questions et dégrade un knockout sans règle', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: JOB }] })
    const r = await app.inject({
      method: 'PUT', url: `/recruitment/jobs/${JOB}/screening-questions`, headers: auth(),
      payload: { questions: [{ id: 'q1', label: 'Permis B ?', type: 'boolean', required: true, knockout: true }] },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.questions[0].knockout).toBe(false)
  })
})

describe('Décision de pré-tri', () => {
  it('refuse une dérogation sans motif (400)', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: APP, screening_verdict: 'flagged' }] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'kept' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/motif/i)
  })

  it('accepte une dérogation motivée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ screening_verdict: 'flagged' }] })
      .mockResolvedValueOnce({ rows: [{ id: APP, screening_verdict: 'flagged' }] })
      .mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(),
      payload: { decision: 'kept', reason: 'Parcours remarquable malgré 4 ans' },
    })
    expect(r.statusCode).toBe(200)
  })

  it('404 si la candidature est déjà décidée', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ screening_verdict: 'pass' }] })
      .mockResolvedValueOnce({ rows: [] })
    const r = await app.inject({
      method: 'PATCH', url: `/recruitment/applications/${APP}/screening-decision`,
      headers: auth(), payload: { decision: 'dismissed', reason: 'Profil hors périmètre' },
    })
    expect(r.statusCode).toBe(404)
  })
})

describe('Simulation', () => {
  it('preview n’écrit rien', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const r = await app.inject({
      method: 'POST', url: `/recruitment/jobs/${JOB}/screening/preview`,
      headers: auth(), payload: { criteria: { minExperienceYears: 5 }, questions: [] },
    })
    expect(r.statusCode).toBe(200)
    const writes = queryMock.mock.calls.filter(c => /UPDATE|INSERT|DELETE/i.test(String(c[0])))
    expect(writes).toEqual([])
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/modules/recruitment/screening.routes.test.ts
```
Attendu : ÉCHEC — `./screening.routes.js` introuvable.

- [ ] **Étape 3 : implémenter**

Créer `apps/api/src/modules/recruitment/screening.routes.ts` avec les 6 routes. Points
imposés :

- rôles : lecture `admin, hr_manager, hr_officer` ; écriture des questions `admin, hr_manager` ;
  décision `admin, hr_manager, hr_officer` ;
- `preHandler: [fastify.authorize(...), ensureSchema]` où `ensureSchema` appelle
  `ensureRecruitmentSchemaMigrated(request.user.schemaName)` **après** `authenticate` ;
- validation Zod, erreurs via `badRequestFromZod` ;
- `PATCH …/screening-decision` : lire d'abord `screening_verdict`, imposer `reason` (≥ 10
  caractères) dès que la décision contredit le verdict, puis `repo.decide(...)`, `404` si
  `decide` renvoie `null` ;
- audit : `auditTenant(schema, { userId, action: 'recruitment.screening_decided',
  entity: 'application', entityId: appId, changes: { verdict, decision, reason }, ip })` ;
- `preview` : ne fait aucune écriture — lit `listPending`, applique
  `evaluateQuestions` + `evaluateScreening` + `combineVerdicts` en mémoire, renvoie
  `{ total, pass, flagged, pending, byRule }` où `byRule` agrège les motifs d'échec ;
- `apply` : même calcul, suivi de `repo.saveVerdict` pour chaque candidature.

Puis, dans `recruitment.routes.ts`, à la fin du plugin :

```ts
  await fastify.register(screeningRoutes)
```

(le préfixe `/recruitment` est déjà appliqué par `app.ts` au plugin parent.)

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

```
cd apps/api && npx vitest run src/modules/recruitment/screening.routes.test.ts
```
Attendu : 6 tests PASS.

- [ ] **Étape 5 : vérifier le balayage d'autorisation**

```
cd apps/api && npx vitest run src/security-authz-sweep.golden.test.ts
```
Attendu : PASS. Les 6 routes sont authentifiées ; aucune entrée à ajouter dans
`PUBLIC_ROUTES`.

- [ ] **Étape 6 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening.routes.ts nexusrh_ci/apps/api/src/modules/recruitment/screening.routes.test.ts
git add nexusrh_ci/apps/api/src/modules/recruitment/recruitment.routes.ts
git commit -m "feat(recruitment): endpoints de pré-tri (questions, simulation, file, décision)"
```

---

### Task 6 : Dépôt public — questions exposées et réponses évaluées

**Fichiers :**
- Modifier : `apps/api/src/modules/recruitment/recruitment.routes.ts`
  (`GET /public/:tenantSlug/jobs/:jobId` vers la ligne 1315 ; `publicApplySchema` ligne 46 ;
  handler `apply` et son `INSERT` vers la ligne 1500)
- Test : `apps/api/src/modules/recruitment/screening-public.golden.test.ts`

**Interfaces :**
- Consomme : `evaluateQuestions`, `combineVerdicts`, `sanitizeQuestions` (Task 2).
- Produit : `GET …/jobs/:jobId` renvoie `screeningQuestions` **sans les règles** ;
  `POST …/apply` accepte `answers` et écrit `screening_verdict` dès l'insertion.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/modules/recruitment/screening-public.golden.test.ts
/**
 * Golden — dépôt public : les questions sont posées, les seuils jamais divulgués.
 *
 * Un candidat qui verrait `{ op: 'min', value: 5 }` saurait quoi répondre.
 * L'endpoint public ne doit exposer que les libellés et les types.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
// … mêmes mocks que screening.routes.test.ts (pg, redis, config, provisioning,
//    recruitment-ai.service, ai-credentials.service, sourcing-countries.service) …

describe('Dépôt public et questions éliminatoires', () => {
  it('GET /public/:slug/jobs/:jobId expose les libellés, JAMAIS les règles', async () => {
    // recruitment_jobs.screening_questions contient une règle min: 5
    const r = await app.inject({ method: 'GET', url: `/recruitment/public/sotra/jobs/${JOB}` })
    expect(r.statusCode).toBe(200)
    const body = r.body
    expect(body).toContain('Années d’expérience')
    expect(body).not.toContain('"rule"')
    expect(body).not.toContain('"min"')
  })

  it('une réponse non conforme donne un verdict flagged, jamais un rejet', async () => {
    const r = await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'A', last_name: 'B', email: 'a@b.ci', answers: { q1: 2 } },
    })
    expect(r.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find(c => /INSERT INTO .*applications/.test(String(c[0])))
    expect(String(insert![0])).toContain('screening_verdict')
    expect((insert![1] as unknown[])).toContain('flagged')
    // Et surtout : le stage reste 'new', il n'y a PAS de rejet automatique.
    expect((insert![1] as unknown[])).not.toContain('rejected')
  })

  it('une question `required` sans réponse est refusée en 400', async () => {
    const r = await app.inject({
      method: 'POST', url: `/recruitment/public/sotra/jobs/${JOB}/apply`,
      payload: { first_name: 'A', last_name: 'B', email: 'a@b.ci', answers: {} },
    })
    expect(r.statusCode).toBe(400)
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/modules/recruitment/screening-public.golden.test.ts
```

- [ ] **Étape 3 : implémenter**

1. `publicApplySchema` : ajouter `answers: z.record(z.union([z.boolean(), z.number(), z.string().max(200)])).optional()`.
2. Dans `GET /public/:tenantSlug/jobs/:jobId`, ajouter au `SELECT` la colonne
   `screening_questions`, puis projeter sans les règles :

```ts
      const questions = sanitizeQuestions(job.screening_questions ?? [])
        .map(({ id, label, type, options, required }) => ({ id, label, type, options, required }))
```

3. Dans le handler `apply`, avant l'`INSERT` :

```ts
      const questions = sanitizeQuestions(jobRow.screening_questions ?? [])
      const answers   = (body.answers ?? {}) as Record<string, unknown>
      const manquantes = questions.filter(q => q.required &&
        (answers[q.id] === undefined || answers[q.id] === null || answers[q.id] === ''))
      if (manquantes.length > 0) {
        return reply.status(400).send({
          error: 'Réponses obligatoires manquantes',
          details: manquantes.map(q => ({ path: q.id, message: q.label })),
        })
      }
      // Verdict calculé DÈS le dépôt : aucun appel IA, aucun coût.
      const combined = combineVerdicts(evaluateQuestions(questions, answers), null)
```

4. L'`INSERT` reçoit trois colonnes de plus : `screening_answers`, `screening_verdict`,
   `screening_failed_rules`. `stage` reste `'new'` et `screening_decision` reste `NULL` :
   le dossier part en file de revue, il n'est jamais rejeté automatiquement.

- [ ] **Étape 4 : lancer les tests du module**

```
cd apps/api && npx vitest run src/modules/recruitment
```

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening-public.golden.test.ts
git add nexusrh_ci/apps/api/src/modules/recruitment/recruitment.routes.ts
git commit -m "feat(recruitment): questions éliminatoires au dépôt public"
```

---

### Task 7 : Le kanban n'accueille que les dossiers décidés

**Fichiers :**
- Modifier : `apps/api/src/modules/recruitment/recruitment.routes.ts`
  (`GET /applications`, vers la ligne 546)
- Test : `apps/api/src/modules/recruitment/screening-gate.golden.test.ts`

**Interfaces :**
- Consomme : la colonne `screening_decision` (Task 1).
- Produit : `GET /applications` accepte `?pending=true` pour la file ; par défaut il
  n'expose que les candidatures décidées.

- [ ] **Étape 1 : écrire le test qui échoue**

```ts
// apps/api/src/modules/recruitment/screening-gate.golden.test.ts
/**
 * Golden — RGPD art. 22 traduit en test.
 *
 * Aucune candidature ne peut apparaître dans le pipeline tant qu'un humain n'a
 * pas tranché. C'est l'invariant central du pré-tri : le verdict machine est une
 * proposition, jamais une décision.
 */
describe('Barrière du pré-tri', () => {
  it('GET /applications exclut les dossiers sans décision humaine', async () => {
    await app.inject({ method: 'GET', url: '/recruitment/applications', headers: auth() })
    const sql = String(queryMock.mock.calls[0]![0])
    expect(sql).toMatch(/screening_decision IS NOT NULL/)
  })

  it('?pending=true renvoie au contraire UNIQUEMENT les dossiers en attente', async () => {
    queryMock.mockClear()
    await app.inject({ method: 'GET', url: '/recruitment/applications?pending=true', headers: auth() })
    expect(String(queryMock.mock.calls[0]![0])).toMatch(/screening_decision IS NULL/)
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/api && npx vitest run src/modules/recruitment/screening-gate.golden.test.ts
```

- [ ] **Étape 3 : implémenter**

Dans `GET /applications`, après la construction du `WHERE` existant :

```ts
      // Barrière du pré-tri : le pipeline n'affiche que des dossiers tranchés par
      // un humain. `?pending=true` sert la file de revue, qui montre l'inverse.
      const pending = (request.query as { pending?: string }).pending === 'true'
      sql += pending
        ? ` AND a.screening_decision IS NULL`
        : ` AND a.screening_decision IS NOT NULL`
```

- [ ] **Étape 4 : lancer la suite complète du module**

```
cd apps/api && npx vitest run src/modules/recruitment
```
Attendu : tout PASS. Si un test existant supposait que toutes les candidatures remontent,
l'ajuster en ajoutant `screening_decision: 'kept'` à sa fixture — et **jamais** en
supprimant la barrière.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening-gate.golden.test.ts
git add nexusrh_ci/apps/api/src/modules/recruitment/recruitment.routes.ts
git commit -m "feat(recruitment): rien n'entre dans le pipeline sans décision humaine"
```

---

### Task 8 : Écran de revue en deux volets

**Fichiers :**
- Créer : `apps/web/src/pages/recruitment/ScreeningReview.tsx`
- Modifier : `apps/web/src/pages/recruitment/RecruitmentPage.tsx` (onglet ; déplacement de `ScreeningCriteriaPanel`, lignes 3624-3700, vers le nouveau fichier)
- Modifier : `apps/web/src/i18n/locales/fr/recruitment.json` et `en/recruitment.json`
- Test : `apps/web/src/pages/recruitment/ScreeningReview.test.tsx`

**Interfaces :**
- Consomme : `GET /recruitment/jobs/:id/screening/queue`,
  `POST …/screening/preview`, `PATCH /recruitment/applications/:id/screening-decision`.
- Produit : onglet `screening` dans `RecruitmentPage`.

- [ ] **Étape 1 : écrire le test qui échoue**

```tsx
// apps/web/src/pages/recruitment/ScreeningReview.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ScreeningReview from './ScreeningReview'

vi.mock('../../lib/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { data: [{
      id: 'a1', first_name: 'Awa', last_name: 'Koné', email: 'awa@x.ci',
      screening_verdict: 'flagged', screening_failed_rules: ['Permis B — réponse attendue : oui'],
      screening_answers: {}, ai_score: 71, ai_summary: null, has_cv: true,
      created_at: '2026-08-30T10:00:00Z',
    }] } }),
    post: vi.fn().mockResolvedValue({ data: { data: { total: 1, pass: 0, flagged: 1, pending: 1, byRule: [] } } }),
    patch: vi.fn().mockResolvedValue({ data: { data: { id: 'a1' } } }),
  },
}))

const wrap = (ui: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
)

describe('ScreeningReview', () => {
  it('affiche les règles échouées du dossier', async () => {
    wrap(<ScreeningReview jobId="job-1" />)
    expect(await screen.findByText(/Permis B/)).toBeInTheDocument()
  })

  it('exige un motif quand la décision contredit le verdict machine', async () => {
    const api = (await import('../../lib/api')).default
    wrap(<ScreeningReview jobId="job-1" />)
    fireEvent.click(await screen.findByRole('button', { name: /retenir/i }))
    // Le dossier est `flagged` : retenir est une dérogation → motif obligatoire,
    // aucun appel API tant qu'il est vide.
    expect(api.patch).not.toHaveBeenCalled()
    expect(await screen.findByLabelText(/motif/i)).toBeInTheDocument()
  })
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

```
cd apps/web && npx vitest run src/pages/recruitment/ScreeningReview.test.tsx
```

- [ ] **Étape 3 : implémenter**

`ScreeningReview.tsx` : mise en page `grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4`.

- **Volet gauche** — `ScreeningCriteriaPanel` (déplacé depuis `RecruitmentPage.tsx`),
  l'éditeur de questions, et le bandeau de compteurs alimenté par `screening/preview` avec
  un anti-rebond de 400 ms. `byRule` listé sous les compteurs, trié par nombre décroissant.
- **Volet droit** — le dossier courant : identité, réponses en regard des libellés, règles
  échouées en rouge, CV inline (réutiliser le mécanisme blob existant de
  `RecruitmentPage.tsx` lignes 1722-1740), résumé IA s'il existe. Trois boutons : Retenir,
  Écarter, Repêcher. Le champ motif s'affiche et devient obligatoire dès que la décision
  contredit `screening_verdict`. Raccourcis `J`/`K` pour naviguer.

Dans `RecruitmentPage.tsx` : `useState<'jobs' | 'screening' | 'pipeline' | 'ai-sourcing'>`,
onglet inséré entre `jobs` et `pipeline`, avec en pastille le nombre de dossiers en attente
(`GET /recruitment/applications?pending=true`). Retirer `<ScreeningCriteriaPanel …>` de
l'onglet pipeline (ligne 643) et la définition du composant (lignes 3624-3700).

Clés i18n à créer dans **les deux** fichiers `recruitment.json` :
`screening.tab`, `screening.pending`, `screening.keep`, `screening.dismiss`,
`screening.override`, `screening.reason`, `screening.reasonRequired`,
`screening.counters.total|pass|flagged|pending`, `screening.byRule`,
`screening.questions.title|add|label|type|required|knockout|rule`,
`screening.empty`, `screening.discriminationWarning`.

Le libellé de `screening.discriminationWarning` (FR) :

> « Ne fondez aucune question sur l'âge, le sexe, l'origine, la situation de famille, l'état
> de santé, les convictions religieuses ou l'appartenance syndicale. Ces critères sont
> interdits à l'embauche. »

- [ ] **Étape 4 : lancer les tests web**

```
cd apps/web && npx vitest run
```
Attendu : tout PASS (les 132 existants + les 2 nouveaux).

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/web/src/pages/recruitment/ScreeningReview.tsx nexusrh_ci/apps/web/src/pages/recruitment/ScreeningReview.test.tsx
git add nexusrh_ci/apps/web/src/pages/recruitment/RecruitmentPage.tsx nexusrh_ci/apps/web/src/i18n/locales/fr/recruitment.json nexusrh_ci/apps/web/src/i18n/locales/en/recruitment.json
git commit -m "feat(web): écran de revue du pré-tri en deux volets"
```

---

### Task 9 : Golden de bout en bout et vérification finale

**Fichiers :**
- Créer : `apps/api/src/modules/recruitment/screening-pipeline.golden.test.ts`

**Interfaces :**
- Consomme : tout ce qui précède.
- Produit : rien — c'est le filet.

- [ ] **Étape 1 : écrire le test de parcours complet**

```ts
// apps/api/src/modules/recruitment/screening-pipeline.golden.test.ts
/**
 * Golden — parcours complet du pré-tri, de la question posée à l'entrée en pipeline.
 * Définition des questions → dépôt → verdict → file de revue → décision → pipeline.
 */
describe('Parcours complet du pré-tri', () => {
  it('un dossier non décidé n’apparaît jamais dans le pipeline', async () => {
    /* dépôt → GET /applications ne le contient pas → GET ?pending=true le contient */
  })

  it('après décision « retenir », le dossier entre au stage `screening`', async () => {
    /* PATCH screening-decision kept → stage = 'screening' → visible dans /applications */
  })

  it('la décision est tracée dans la piste d’audit avec le verdict et le motif', async () => {
    /* auditTenant appelé avec action recruitment.screening_decided */
  })
})
```

- [ ] **Étape 2 : implémenter le corps des trois tests**

Reprendre les mocks de `screening.routes.test.ts`. Chaque test pilote `queryMock` par
`mockResolvedValueOnce` successifs, dans l'ordre des requêtes du handler.

- [ ] **Étape 3 : lancer la suite complète de l'API**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run
```
Attendu : typecheck propre, 0 échec.

- [ ] **Étape 4 : lancer web et worker, puis le build**

```
cd apps/web && npx vitest run
cd ../worker && npx vitest run
cd ../.. && pnpm run build
```
Attendu : 3 suites vertes, build 3/3.

- [ ] **Étape 5 : commit**

```bash
git add -f nexusrh_ci/apps/api/src/modules/recruitment/screening-pipeline.golden.test.ts
git commit -m "test(recruitment): golden de bout en bout du pré-tri"
```

---

## Auto-relecture

**Couverture de la spec**

| Section de la spec | Tâche |
|---|---|
| §5.1 questions sur l'offre | 1 (colonne), 2 (type), 5 (API) |
| §5.2 colonnes de verdict/décision | 1 |
| §5.3 rattrapage non rejouable | 1 |
| §6.1 définition des questions | 5 |
| §6.2 preview / apply | 5 |
| §6.3 file et décision, motif obligatoire | 5 |
| §6.4 dépôt public | 6 |
| §7.1 `evaluateQuestions` | 2 |
| §7.2 `combineVerdicts` | 2 |
| §7.3 branchement `preselect` | 3 |
| §9 conformité (art. 22, audit, avertissement) | 5 (audit), 7 (barrière), 8 (avertissement) |
| §10 écran deux volets | 8 |
| §11 intégration (`auditTenant`, `badRequest`, repository) | 4, 5 |
| §12 tests | 1, 2, 4, 5, 6, 7, 8, 9 |

Aucune section sans tâche.

**Cohérence des types** — `ScreeningQuestion`, `QuestionRule`, `sanitizeQuestions`,
`evaluateQuestions`, `combineVerdicts`, `screeningRepo`, `QueueRow` portent le même nom et
la même signature de la Task 2 à la Task 8. `evaluateScreening` et `ScreeningVerdict`
conservent leur signature d'origine — aucune rupture pour les tests existants.

**Ordre d'exécution** — les tâches 1 → 9 sont séquentielles : chacune consomme les
interfaces de la précédente. La Task 3 livre déjà de la valeur seule (le pré-tri se met à
fonctionner) sans aucune interface nouvelle.
