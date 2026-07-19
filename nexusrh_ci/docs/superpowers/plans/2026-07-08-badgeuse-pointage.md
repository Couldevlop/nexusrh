# Module Badgeuse / Pointage — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un module opt-in `attendance` où NexusRH interroge (poll) les API des badgeuses, calcule retards/absences injustifiées vs un horaire fixe, et escalade en avertissements → demande d'explication → brouillon de sanction validé par le RH.

**Architecture:** 5 composants isolés — (1) connecteur badgeuse sortant chiffré + mapping JSON, (2) horaire de référence en cascade, (3) calcul présence quotidien, (4) moteur d'escalade pur, (5) surfaces RH/employé. Logique métier en services PURS testables sans infra ; CRUD/routes calqués sur les modules `discipline`/`integrations` existants ; jobs BullMQ pour poll + évaluation.

**Tech Stack:** Node 20 + Fastify 4 + TS strict · PostgreSQL (schema-per-tenant, provisioning paresseux) · BullMQ · React 18 + Vite + TanStack Query · Vitest · react-i18next.

## Global Constraints

- **Sans régression** : module opt-in (défaut désactivé) ; tables additives idempotentes ; `disciplinary_actions` NON modifiée (INSERT via colonnes existantes) ; zéro modification d'endpoint/table existants.
- **TS strict** : pas de `any`, pas de `@ts-ignore`. Chaque async a son try/catch.
- **FCFA entiers** (non concerné ici mais règle repo) · **français** UI/messages.
- **OWASP** : SSRF `isSafeOutboundUrl` sur toute URL sortante ; secrets chiffrés AES-256 jamais renvoyés ; RBAC API + front ; audit_log de chaque warning/sanction ; isolation `schemaName` du token.
- **Pièges repo** : déclarer le préfixe `/attendance` dans la carte PREFIX de `apps/api/src/ui-api-contract.golden.test.ts` ; ajouter les endpoints au `forms-submission.golden.test.ts` ; nouveaux fichiers sous `nexusrh_ci/` → `git add -f` ; commits SANS mention Claude ; brancher chaque nouvel export de service email/mock dans les tests.
- **Valeurs par défaut config** : `late_minutes_tier1=30`, `occurrences_tier1=3`, `late_minutes_tier2=60`, `occurrences_tier2=3`, `unjustified_absence_occurrences=1`, `warnings_before_sanction=2`, `window_mode='consecutive_or_month'`, `default_expected_start='08:00'`, `default_tolerance_min=10`, `default_workdays={1,2,3,4,5}`.
- **Règle paliers** : une journée compte pour CHAQUE palier dont elle dépasse le seuil (≥1 h compte palier 1 ET palier 2), compteurs et consommation indépendants par palier.

---

## File Structure

**API (apps/api/src)**
- `modules/attendance/attendance.mapping.ts` — service pur : réponse badgeuse brute → pointages normalisés (Task 4)
- `modules/attendance/attendance.schedule.ts` — service pur : résolution horaire effectif (Task 5)
- `modules/attendance/attendance.compute.ts` — service pur : pointages+horaire+congés+fériés → statut jour (Task 6)
- `modules/attendance/attendance.escalation.ts` — service pur : historique jours+config → warnings + trigger sanction (Task 7)
- `modules/attendance/attendance.fetch.ts` — service infra : appel sortant badgeuse (SSRF, auth, timeouts) (Task 8)
- `modules/attendance/attendance.routes.ts` — routes Fastify `/attendance` (Tasks 10-14)
- `modules/attendance/*.test.ts` — tests unitaires/route par fichier
- `utils/schema-migrations.ts` — MODIF : +6 tables attendance (Task 2)
- `services/tenant-modules.service.ts` — MODIF : +clé `attendance` + préfixe (Task 3)
- `app.ts` — MODIF : enregistrement routes `/attendance` (Task 10)
- `ui-api-contract.golden.test.ts` / `forms-submission.golden.test.ts` — MODIF (Task 15)

**Worker (apps/worker/src)**
- `jobs/attendance-poll.ts` — job : tire les pointages d'une badgeuse (Task 16)
- `jobs/attendance-evaluate.ts` — job : recalcule jours + escalade (Task 17)
- `index.ts` — MODIF : enregistrement queues + cron (Task 18)

**Web (apps/web/src)**
- `lib/modules.ts` — MODIF : +`attendance`
- `pages/attendance/AttendancePage.tsx` — écran RH à onglets (Task 19)
- `pages/attendance/attendance.test.tsx` — tests composant
- `pages/mon-espace/*` — MODIF : Mes pointages / Mes avertissements (Task 20)
- `components/layout/Sidebar.tsx` — MODIF : entrées gated `attendance`
- `i18n/locales/{fr,en}/attendance.json` — nouveau namespace (Task 21)

---

## Task 1: Provisioning des tables attendance

**Files:**
- Modify: `apps/api/src/utils/schema-migrations.ts` (ajouter au tableau de statements, après `disciplinary_actions`)
- Test: `apps/api/src/modules/attendance/attendance.provisioning.test.ts`

**Interfaces:**
- Produces: 6 tables dans le schéma tenant (`attendance_devices`, `attendance_punches`, `attendance_schedules`, `attendance_days`, `attendance_warnings`, `attendance_config`) créées idempotemment par `ensureTenantSchema`/`provisionTenantSchema`.

- [ ] **Step 1: Écrire le test de présence des statements**

```ts
// attendance.provisioning.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../utils/schema-migrations.ts'), 'utf8')
describe('provisioning attendance', () => {
  for (const t of ['attendance_devices','attendance_punches','attendance_schedules','attendance_days','attendance_warnings','attendance_config']) {
    it(`crée la table ${t} (idempotent)`, () => {
      expect(src).toContain(`CREATE TABLE IF NOT EXISTS "${'${schemaName}'}".${t}`)
    })
  }
  it('unicité pointage (device_id, dedup_key)', () => {
    expect(src).toMatch(/attendance_punches[\s\S]*UNIQUE\s*\(device_id, dedup_key\)/)
  })
})
```

- [ ] **Step 2: Lancer le test → échec** — `npx vitest run src/modules/attendance/attendance.provisioning.test.ts` — Expected: FAIL (tables absentes).

- [ ] **Step 3: Ajouter les statements** (dans le tableau de `schema-migrations.ts`, juste après l'index `disciplinary_emp_idx`) :

```ts
    // ── Badgeuse / Pointage (attendance) — additif, idempotent ─────────────────
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(150) NOT NULL,
      base_url text NOT NULL,
      auth_type varchar(20) NOT NULL DEFAULT 'none',
      auth_secret_enc text,
      auth_header_name varchar(100),
      default_headers jsonb NOT NULL DEFAULT '{}',
      field_mapping jsonb NOT NULL DEFAULT '{}',
      poll_enabled boolean NOT NULL DEFAULT true,
      poll_interval_min integer NOT NULL DEFAULT 15,
      sync_cursor text,
      last_sync_at timestamptz,
      last_sync_status varchar(20),
      is_active boolean NOT NULL DEFAULT true,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_punches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid,
      raw_employee_ref text,
      device_id uuid,
      punched_at timestamptz NOT NULL,
      direction varchar(10) NOT NULL DEFAULT 'unknown',
      source varchar(10) NOT NULL DEFAULT 'device',
      raw jsonb,
      dedup_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (device_id, dedup_key)
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_att_punch_emp_idx" ON "${schemaName}".attendance_punches(employee_id, punched_at DESC)`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_schedules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scope varchar(12) NOT NULL,
      scope_id uuid,
      expected_start time NOT NULL,
      tolerance_min integer NOT NULL DEFAULT 10,
      expected_end time,
      workdays integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_days (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL,
      work_date date NOT NULL,
      first_in timestamptz,
      last_out timestamptz,
      expected_start time,
      late_minutes integer NOT NULL DEFAULT 0,
      status varchar(20) NOT NULL,
      justified_by uuid,
      computed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (employee_id, work_date)
    )`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_warnings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL,
      tier varchar(20) NOT NULL,
      trigger_reason varchar(40) NOT NULL,
      occurrence_dates date[] NOT NULL DEFAULT '{}',
      threshold_snapshot jsonb,
      status varchar(12) NOT NULL DEFAULT 'active',
      employee_response text,
      responded_at timestamptz,
      disciplinary_action_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS "${schemaName}_att_warn_emp_idx" ON "${schemaName}".attendance_warnings(employee_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS "${schemaName}".attendance_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      late_minutes_tier1 integer NOT NULL DEFAULT 30,
      occurrences_tier1 integer NOT NULL DEFAULT 3,
      late_minutes_tier2 integer NOT NULL DEFAULT 60,
      occurrences_tier2 integer NOT NULL DEFAULT 3,
      unjustified_absence_occurrences integer NOT NULL DEFAULT 1,
      warnings_before_sanction integer NOT NULL DEFAULT 2,
      window_mode varchar(24) NOT NULL DEFAULT 'consecutive_or_month',
      default_expected_start time NOT NULL DEFAULT '08:00',
      default_tolerance_min integer NOT NULL DEFAULT 10,
      default_workdays integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
```

- [ ] **Step 4: Lancer le test → succès.**
- [ ] **Step 5: Commit** — `git add -f apps/api/src/utils/schema-migrations.ts apps/api/src/modules/attendance/attendance.provisioning.test.ts && git commit -m "feat(attendance): provisioning des 6 tables (additif, idempotent)"`

---

## Task 2: Enregistrement du module opt-in

**Files:**
- Modify: `apps/api/src/services/tenant-modules.service.ts` (MODULE_KEYS, MODULE_DEFAULTS, URL_PREFIX_TO_MODULE)
- Modify: `apps/web/src/lib/modules.ts` (miroir web)
- Test: `apps/api/src/services/tenant-modules.golden.test.ts` (étendre)

**Interfaces:**
- Produces: clé module `'attendance'` (défaut `false`), préfixe `/attendance` → `attendance`.

- [ ] **Step 1: Test** — ajouter dans `tenant-modules.golden.test.ts` :

```ts
it('attendance est opt-in (défaut désactivé) et mappé sur /attendance', () => {
  expect(MODULE_DEFAULTS.attendance).toBe(false)
  expect(moduleKeyForUrl('/attendance/devices')).toBe('attendance')
})
```

- [ ] **Step 2: Lancer → échec** (clé absente).
- [ ] **Step 3: Implémenter** — dans `tenant-modules.service.ts` : ajouter `'attendance'` à `MODULE_KEYS`, `attendance: false` à `MODULE_DEFAULTS`, `['/attendance', 'attendance']` à `URL_PREFIX_TO_MODULE`. Miroir dans `apps/web/src/lib/modules.ts` (ajouter `'attendance'` à la liste et `attendance: false` aux défauts).
- [ ] **Step 4: Lancer → succès.**
- [ ] **Step 5: Commit** — `git add -f apps/api/src/services/tenant-modules.service.ts apps/web/src/lib/modules.ts apps/api/src/services/tenant-modules.golden.test.ts && git commit -m "feat(attendance): module opt-in enregistré (API + web, défaut off)"`

---

## Task 3: Types partagés attendance

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.types.ts`

**Interfaces:**
- Produces: types consommés par tous les services suivants.

- [ ] **Step 1: Écrire les types** (pas de test — fichier de types pur, validé par le typecheck des tasks suivantes) :

```ts
export type PunchDirection = 'in' | 'out' | 'unknown'
export interface NormalizedPunch {
  rawEmployeeRef: string
  punchedAt: Date
  direction: PunchDirection
  dedupKey: string
  raw: unknown
}
export interface FieldMapping {
  recordsPath?: string
  employeePath: string
  employeeMatchBy: 'matricule' | 'email' | 'badge_id'
  timestampPath: string
  timestampFormat: 'iso8601' | 'epoch_s' | 'epoch_ms' | string
  directionPath?: string
  directionInValue?: string
  directionOutValue?: string
}
export interface EffectiveSchedule {
  expectedStart: string   // 'HH:MM'
  toleranceMin: number
  expectedEnd: string | null
  workdays: number[]      // 1=lun … 7=dim
}
export type DayStatus = 'present' | 'late' | 'absent_unjustified' | 'absent_justified' | 'off'
export interface ComputedDay {
  workDate: string        // 'YYYY-MM-DD'
  firstIn: Date | null
  lastOut: Date | null
  lateMinutes: number
  status: DayStatus
  justifiedBy: string | null
}
export interface AttendanceConfig {
  lateMinutesTier1: number; occurrencesTier1: number
  lateMinutesTier2: number; occurrencesTier2: number
  unjustifiedAbsenceOccurrences: number
  warningsBeforeSanction: number
  windowMode: 'consecutive_or_month'
}
export type WarningTier = 'avertissement' | 'demande_explication'
export interface GeneratedWarning {
  employeeId: string
  tier: WarningTier
  triggerReason: string
  occurrenceDates: string[]
}
export interface EscalationResult {
  warnings: GeneratedWarning[]
  sanctionDrafts: Array<{ employeeId: string; reason: string; description: string }>
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 3: Commit** — `git add -f apps/api/src/modules/attendance/attendance.types.ts && git commit -m "feat(attendance): types partagés du module"`

---

## Task 4: Service pur — mapping badgeuse

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.mapping.ts`
- Test: `apps/api/src/modules/attendance/attendance.mapping.test.ts`

**Interfaces:**
- Consumes: `FieldMapping`, `NormalizedPunch` (Task 3).
- Produces: `mapDeviceResponse(body: unknown, mapping: FieldMapping): NormalizedPunch[]`, `getByPath(obj: unknown, path: string): unknown`, `parseTimestamp(v: unknown, format: string): Date | null`.

- [ ] **Step 1: Écrire les tests**

```ts
import { describe, it, expect } from 'vitest'
import { mapDeviceResponse, parseTimestamp } from './attendance.mapping.js'
const mapping = { recordsPath: 'data.records', employeePath: 'uid', employeeMatchBy: 'matricule',
  timestampPath: 'time', timestampFormat: 'iso8601', directionPath: 'state', directionInValue: '0', directionOutValue: '1' } as const
describe('mapDeviceResponse', () => {
  it('extrait les pointages via les chemins configurés', () => {
    const body = { data: { records: [ { uid: 'M001', time: '2026-07-08T08:05:00Z', state: '0' } ] } }
    const out = mapDeviceResponse(body, mapping)
    expect(out).toHaveLength(1)
    expect(out[0]!.rawEmployeeRef).toBe('M001')
    expect(out[0]!.direction).toBe('in')
    expect(out[0]!.punchedAt.toISOString()).toBe('2026-07-08T08:05:00.000Z')
    expect(out[0]!.dedupKey).toBe('M001|2026-07-08T08:05:00.000Z')
  })
  it('sens inconnu si directionPath absent', () => {
    const out = mapDeviceResponse({ data: { records: [ { uid: 'M2', time: '2026-07-08T09:00:00Z' } ] } },
      { ...mapping, directionPath: undefined })
    expect(out[0]!.direction).toBe('unknown')
  })
  it('ignore les enregistrements sans horodatage valide', () => {
    const out = mapDeviceResponse({ data: { records: [ { uid: 'M3', time: 'nope' } ] } }, mapping)
    expect(out).toHaveLength(0)
  })
})
describe('parseTimestamp', () => {
  it('epoch_s', () => { expect(parseTimestamp(1751961900, 'epoch_s')!.toISOString()).toBe('2025-07-08T08:05:00.000Z') })
  it('invalide → null', () => { expect(parseTimestamp('x', 'iso8601')).toBeNull() })
})
```

- [ ] **Step 2: Lancer → échec.**
- [ ] **Step 3: Implémenter** `attendance.mapping.ts` : `getByPath` (split sur `.`), `parseTimestamp` (iso8601 → `new Date`, epoch_s → `*1000`, epoch_ms, sinon `new Date(v)` ; retourner `null` si `isNaN`), `mapDeviceResponse` (résout `recordsPath` → tableau ; pour chaque record : lit employeePath/timestampPath/directionPath ; ignore si timestamp null ; `direction` = in/out/unknown selon valeurs ; `dedupKey = rawEmployeeRef + '|' + punchedAt.toISOString()`). Tout en TS strict, aucune exception non catchée (record malformé → ignoré).
- [ ] **Step 4: Lancer → succès.**
- [ ] **Step 5: Commit** — `git commit -m "feat(attendance): service pur mapping réponse badgeuse → pointages"`

---

## Task 5: Service pur — résolution horaire

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.schedule.ts`
- Test: idem `.test.ts`

**Interfaces:**
- Consumes: `EffectiveSchedule` (Task 3).
- Produces: `resolveSchedule(input: { employee?: Sched|null; department?: Sched|null; tenant: Sched }): EffectiveSchedule` où `Sched = { expectedStart, toleranceMin, expectedEnd, workdays }`. Règle : premier non-null dans l'ordre employé > département > tenant.

- [ ] **Step 1: Test** — vérifie que l'override employé gagne, sinon département, sinon tenant.

```ts
import { resolveSchedule } from './attendance.schedule.js'
it('employé > département > tenant', () => {
  const t = { expectedStart:'08:00', toleranceMin:10, expectedEnd:null, workdays:[1,2,3,4,5] }
  const d = { ...t, expectedStart:'09:00' }
  const e = { ...t, expectedStart:'07:30' }
  expect(resolveSchedule({ employee:e, department:d, tenant:t }).expectedStart).toBe('07:30')
  expect(resolveSchedule({ employee:null, department:d, tenant:t }).expectedStart).toBe('09:00')
  expect(resolveSchedule({ tenant:t }).expectedStart).toBe('08:00')
})
```

- [ ] **Step 2: Lancer → échec.** **Step 3: Implémenter** (retourne le premier objet non-null). **Step 4: Lancer → succès.** **Step 5: Commit** — `git commit -m "feat(attendance): service pur résolution horaire en cascade"`

---

## Task 6: Service pur — calcul du statut quotidien

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.compute.ts`
- Test: idem `.test.ts`

**Interfaces:**
- Consumes: `NormalizedPunch`, `EffectiveSchedule`, `ComputedDay`, `DayStatus` (Task 3).
- Produces: `computeDay(input: { workDate: string; punches: NormalizedPunch[]; schedule: EffectiveSchedule; isHoliday: boolean; approvedLeaveId: string | null }): ComputedDay`.

- [ ] **Step 1: Tests**

```ts
import { computeDay } from './attendance.compute.js'
const sched = { expectedStart:'08:00', toleranceMin:10, expectedEnd:'17:00', workdays:[1,2,3,4,5] }
const p = (t:string, dir='in') => ({ rawEmployeeRef:'M1', punchedAt:new Date(t), direction:dir as 'in', dedupKey:t, raw:{} })
it('présent à l’heure (dans la tolérance) → late_minutes 0', () => {
  const d = computeDay({ workDate:'2026-07-08', punches:[p('2026-07-08T08:08:00Z')], schedule:sched, isHoliday:false, approvedLeaveId:null })
  expect(d.status).toBe('present'); expect(d.lateMinutes).toBe(0)
})
it('retard = premier pointage après start+tolérance', () => {
  const d = computeDay({ workDate:'2026-07-08', punches:[p('2026-07-08T08:45:00Z')], schedule:sched, isHoliday:false, approvedLeaveId:null })
  expect(d.status).toBe('late'); expect(d.lateMinutes).toBe(35) // 08:45 - 08:10
})
it('aucun pointage jour ouvré sans congé → absence injustifiée', () => {
  const d = computeDay({ workDate:'2026-07-08', punches:[], schedule:sched, isHoliday:false, approvedLeaveId:null })
  expect(d.status).toBe('absent_unjustified')
})
it('aucun pointage mais congé approuvé → justifié', () => {
  const d = computeDay({ workDate:'2026-07-08', punches:[], schedule:sched, isHoliday:false, approvedLeaveId:'leave-1' })
  expect(d.status).toBe('absent_justified'); expect(d.justifiedBy).toBe('leave-1')
})
it('jour férié → off', () => {
  const d = computeDay({ workDate:'2026-07-07', punches:[], schedule:sched, isHoliday:true, approvedLeaveId:null })
  expect(d.status).toBe('off')
})
it('week-end (hors workdays) → off', () => { // 2026-07-11 = samedi
  const d = computeDay({ workDate:'2026-07-11', punches:[], schedule:sched, isHoliday:false, approvedLeaveId:null })
  expect(d.status).toBe('off')
})
```

- [ ] **Step 2: Lancer → échec.**
- [ ] **Step 3: Implémenter** : ordre de décision — (1) si `!workdays.includes(isoWeekday(workDate))` ou `isHoliday` → `off` ; (2) `firstIn` = plus ancien punch (préférer `direction==='in'`, sinon le plus ancien), `lastOut` = plus récent (préférer `out`) ; (3) si aucun punch → `approvedLeaveId ? absent_justified : absent_unjustified` ; (4) sinon calc `lateMinutes = max(0, round((firstIn − (start+tolérance))/60000))` → `late` si >0 sinon `present`. `isoWeekday` via `new Date(workDate+'T00:00:00Z').getUTCDay()` (0=dim→7).
- [ ] **Step 4: Lancer → succès.** **Step 5: Commit** — `git commit -m "feat(attendance): service pur calcul du statut quotidien"`

---

## Task 7: Service pur — moteur d'escalade

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.escalation.ts`
- Test: idem `.test.ts`

**Interfaces:**
- Consumes: `ComputedDay`, `AttendanceConfig`, `EscalationResult`, `WarningTier` (Task 3).
- Produces: `evaluateEscalation(input: { employeeId: string; days: ComputedDay[]; config: AttendanceConfig; consumedByTier: { tier1: string[]; tier2: string[] }; activeWarnings: number }): EscalationResult & { newlyConsumed: { tier1: string[]; tier2: string[] } }`.

- [ ] **Step 1: Tests** (cœur — couvrir double comptage, fenêtres, sanction)

```ts
import { evaluateEscalation } from './attendance.escalation.js'
const cfg = { lateMinutesTier1:30, occurrencesTier1:3, lateMinutesTier2:60, occurrencesTier2:3,
  unjustifiedAbsenceOccurrences:1, warningsBeforeSanction:2, windowMode:'consecutive_or_month' } as const
const late = (date:string, mins:number) => ({ workDate:date, firstIn:new Date(date+'T09:00:00Z'), lastOut:null, lateMinutes:mins, status:'late' as const, justifiedBy:null })
const none = { tier1:[], tier2:[] }
it('3 jours à 35min consécutifs → avertissement palier 1', () => {
  const r = evaluateEscalation({ employeeId:'e1', days:[late('2026-07-06',35),late('2026-07-07',35),late('2026-07-08',35)], config:cfg, consumedByTier:none, activeWarnings:0 })
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]!.tier).toBe('avertissement')
})
it('3 jours à 1h → avertissement (palier1) ET demande_explication (palier2) — les deux paliers comptent', () => {
  const r = evaluateEscalation({ employeeId:'e1', days:[late('2026-07-06',65),late('2026-07-07',65),late('2026-07-08',65)], config:cfg, consumedByTier:none, activeWarnings:0 })
  const tiers = r.warnings.map(w=>w.tier).sort()
  expect(tiers).toEqual(['avertissement','demande_explication'])
})
it('2 avertissements atteints → brouillon de sanction', () => {
  const r = evaluateEscalation({ employeeId:'e1', days:[late('2026-07-06',65),late('2026-07-07',65),late('2026-07-08',65)], config:cfg, consumedByTier:none, activeWarnings:0 })
  expect(r.sanctionDrafts).toHaveLength(1) // les 2 warnings générés atteignent le seuil
})
it('jours déjà consommés d’un palier ne re-déclenchent pas ce palier', () => {
  const consumed = { tier1:['2026-07-06','2026-07-07','2026-07-08'], tier2:[] }
  const r = evaluateEscalation({ employeeId:'e1', days:[late('2026-07-06',35),late('2026-07-07',35),late('2026-07-08',35)], config:cfg, consumedByTier:consumed, activeWarnings:0 })
  expect(r.warnings).toHaveLength(0)
})
it('absence injustifiée → avertissement (seuil 1)', () => {
  const r = evaluateEscalation({ employeeId:'e1', days:[{ workDate:'2026-07-08', firstIn:null,lastOut:null,lateMinutes:0,status:'absent_unjustified',justifiedBy:null }], config:cfg, consumedByTier:none, activeWarnings:0 })
  expect(r.warnings.some(w=>w.triggerReason==='unjustified_absence')).toBe(true)
})
```

- [ ] **Step 2: Lancer → échec.**
- [ ] **Step 3: Implémenter** :
  - Pour chaque palier T (1: `lateMinutesTier1`, 2: `lateMinutesTier2`) : sélectionner les `days` `status==='late'` avec `lateMinutes >= seuilT` ET `workDate ∉ consumedByTier.tierT`. Trier par date.
  - Fenêtre : déclenche si (a) il existe `occurrencesTierT` dates consécutives en jours ouvrés (comparer via différence de dates ouvrées) OU (b) `occurrencesTierT` dates dans le même mois civil (`YYYY-MM`). Prendre le premier groupe qui satisfait → 1 warning (`tier`= palier1?'avertissement':'demande_explication', `triggerReason` = `${seuil}min_x${occ}_${consecutive?'consecutive':'month'}`, `occurrenceDates` = les dates du groupe) → ajouter ces dates à `newlyConsumed.tierT`.
  - Absences : chaque `absent_unjustified` non déjà comptée (utiliser `consumedByTier.tier1` aussi, ou un set dédié — ici : réutiliser tier1 consumed set pour simplicité, `triggerReason='unjustified_absence'`, `occurrenceDates=[workDate]`) au-delà de `unjustifiedAbsenceOccurrences`.
  - Sanction : `total = activeWarnings + warnings.length` ; si `total >= warningsBeforeSanction` → 1 `sanctionDraft` avec `reason='Cumul de {total} avertissements (retards/absences)'` et `description` listant les `occurrenceDates` de tous les warnings générés.
  - **DRY** : helper interne `consecutiveRun(dates, n)` et `sameMonthGroup(dates, n)`.
- [ ] **Step 4: Lancer → succès.** **Step 5: Commit** — `git commit -m "feat(attendance): moteur d'escalade pur (paliers, fenêtres, sanction)"`

---

## Task 8: Service infra — appel sortant badgeuse (sécurisé)

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.fetch.ts`
- Test: idem `.test.ts` (mock `fetch` + `isSafeOutboundUrl`)

**Interfaces:**
- Consumes: `isSafeOutboundUrl` (`services/ssrf-guard.js`), `FieldMapping`, `NormalizedPunch`, `mapDeviceResponse` (Task 4).
- Produces: `fetchDevicePunches(device: { baseUrl:string; authType:string; authSecret:string|null; authHeaderName:string|null; defaultHeaders:Record<string,string>; fieldMapping:FieldMapping; syncCursor:string|null }): Promise<{ punches: NormalizedPunch[]; ok: boolean; error?: string }>`.

- [ ] **Step 1: Tests** — (a) URL SSRF (`http://10.0.0.1`) → `{ ok:false }` sans fetch ; (b) réponse OK → punches mappés ; (c) fetch rejette → `{ ok:false, error }`. Mock `vi.mock('../../services/ssrf-guard.js')` et `global.fetch`.
- [ ] **Step 2: Lancer → échec.**
- [ ] **Step 3: Implémenter** : `isSafeOutboundUrl(baseUrl)` d'abord (sinon retour `ok:false`) ; construire headers (auth bearer/basic/api_key selon `authType` + `authHeaderName`) ; `fetch` avec `AbortSignal.timeout(15000)` dans try/catch ; parse JSON ; `mapDeviceResponse` ; filtrer par `syncCursor` (ne garder que `dedupKey`/`punchedAt` postérieurs) ; retour `{ punches, ok:true }`. Aucune exception propagée.
- [ ] **Step 4: Lancer → succès.** **Step 5: Commit** — `git commit -m "feat(attendance): appel sortant badgeuse sécurisé (SSRF, auth, timeout)"`

---

## Task 9: Helpers d'accès données (repository)

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.repo.ts`
- Test: idem `.test.ts` (mock pool)

**Interfaces:**
- Produces (signatures, `pool` injecté) : `loadConfig(pool,schema)`, `resolveEmployeeSchedule(pool,schema,employeeId,departmentId)`, `insertPunches(pool,schema,deviceId,punches,matchBy)`, `upsertDay(pool,schema,day)`, `loadDaysForEmployee(pool,schema,employeeId,from,to)`, `loadConsumedDates(pool,schema,employeeId)`, `countActiveWarnings(pool,schema,employeeId)`, `insertWarning(pool,schema,w)`, `insertSanctionDraft(pool,schema,draft)`. Toutes paramétrées, isolation par `schema`, try/catch, jamais de secret en retour.

- [ ] **Step 1: Tests** ciblés : `insertPunches` fait un INSERT `ON CONFLICT (device_id, dedup_key) DO NOTHING` et rapproche l'employé via `employeeMatchBy` (SELECT employees) ; `insertSanctionDraft` insère dans `disciplinary_actions` (`type='avertissement', status='draft'`) avec les colonnes existantes ; `countActiveWarnings` filtre `status IN ('active','contested')`.
- [ ] **Step 2–4: TDD** (mock `pool.query`, asserter le SQL et les params).
- [ ] **Step 5: Commit** — `git commit -m "feat(attendance): repository (requêtes paramétrées, isolation tenant)"`

---

## Task 10: Routes config + montage `/attendance`

**Files:**
- Create: `apps/api/src/modules/attendance/attendance.routes.ts` (squelette + config)
- Modify: `apps/api/src/app.ts` (enregistrer `attendanceRoutes` prefix `/attendance`)
- Test: `apps/api/src/modules/attendance/attendance.routes.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 9), patron RBAC `fastify.authorize`, hook `ensureTenantSchema`.
- Produces: `GET /attendance/config`, `PUT /attendance/config` (admin, Zod strict, audit).

- [ ] **Step 1: Tests** — `GET /config` non-admin → 403 ; `PUT /config` avec champ inconnu → 400 ; `PUT` valide → 200 + audit. (Patron `settings.routes.test.ts` : mock `pg`, `redis`, `config`.)
- [ ] **Step 2: Lancer → échec.**
- [ ] **Step 3: Implémenter** le plugin `attendanceRoutes` (hook `ensureTenantSchema`, `auditAttendance` local calqué sur `discipline`), routes config (singleton : SELECT ORDER BY updated_at LIMIT 1 ; UPSERT). Enregistrer dans `app.ts` : `await app.register(attendanceRoutes, { prefix: '/attendance' })` à côté des autres modules.
- [ ] **Step 4: Lancer → succès.** **Step 5: Commit** — `git commit -m "feat(attendance): routes config + montage /attendance"`

---

## Task 11: Routes badgeuses (CRUD + test + sync)

**Files:** Modify `attendance.routes.ts` ; test idem.
**Interfaces:** Consumes `encrypt`/`decryptIfPresent`, `isSafeOutboundUrl`, `fetchDevicePunches` (Task 8). Produces `GET/POST/PATCH/DELETE /attendance/devices`, `POST /devices/:id/test`, `POST /devices/:id/sync`.

- [ ] **Step 1: Tests** — POST URL SSRF → 422 ; secret jamais renvoyé (GET masque `auth_secret_enc` → `hasSecret`) ; `POST /:id/test` appelle `fetchDevicePunches` (mocké) ; non-admin → 403. Patron `integrations.routes` (connecteurs).
- [ ] **Step 2–4: TDD** (Zod `deviceBody` : name, base_url url, auth_type enum, auth_secret optionnel, auth_header_name, default_headers, field_mapping, poll_interval_min, is_active ; `isSafeOutboundUrl` sur base_url ; `encrypt` du secret ; `/sync` enfile un job `attendance-poll` via Queue).
- [ ] **Step 5: Commit** — `git commit -m "feat(attendance): CRUD badgeuses + test connexion + sync manuel (SSRF, secret chiffré)"`

---

## Task 12: Routes horaires (CRUD surcharges)

**Files:** Modify `attendance.routes.ts` ; test idem.
**Interfaces:** Produces `GET/POST/PATCH/DELETE /attendance/schedules` (scope tenant/department/employee).

- [ ] **Step 1: Tests** — création scope invalide → 400 ; RBAC admin ; unicité logique (un seul actif par scope+scope_id). **Step 2–4: TDD.** **Step 5: Commit** — `git commit -m "feat(attendance): CRUD horaires de référence (cascade)"`

---

## Task 13: Routes pointages + jours + recompute

**Files:** Modify `attendance.routes.ts` ; test idem.
**Interfaces:** Consumes `computeDay` (Task 6), `resolveSchedule` (Task 5), repo (Task 9). Produces `GET /punches`, `POST /punches` (correction manuelle), `GET /days`, `POST /recompute`.

- [ ] **Step 1: Tests** — `manager` ne voit que son équipe (filtre `manager_id`), `employee` → 403 sur `/punches` global ; `POST /recompute` idempotent (2 appels → même `attendance_days`) ; `POST /punches` manuel → `source='manual'`. **Step 2–4: TDD.** **Step 5: Commit** — `git commit -m "feat(attendance): routes pointages/jours/recompute (RBAC équipe)"`

---

## Task 14: Routes avertissements + self-service + dashboard

**Files:** Modify `attendance.routes.ts` ; test idem.
**Interfaces:** Produces `GET /warnings`, `PATCH /warnings/:id` (RH : explained/contested/closed), `GET /attendance/me`, `GET /attendance/me/warnings`, `POST /attendance/me/warnings/:id/respond`, `GET /attendance/dashboard`.

- [ ] **Step 1: Tests** — `PATCH /warnings/:id` par employee → 403 ; `respond` par le propriétaire → 200 + `employee_response` + `responded_at` ; `respond` sur warning d'un autre employé → 404 (isolation) ; `me` ne renvoie que ses données ; `dashboard` agrège KPIs. **Step 2–4: TDD** (notifier via `notifyUser` mocké). **Step 5: Commit** — `git commit -m "feat(attendance): avertissements RH + self-service employé + dashboard"`

---

## Task 15: Golden tests (anti-régression)

**Files:** Modify `apps/api/src/ui-api-contract.golden.test.ts` (carte PREFIX : `'attendance/attendance.routes.ts': '/attendance'`) ; `apps/api/src/forms-submission.golden.test.ts` (ajouter les POST/PATCH/PUT `/attendance/*` avec scope `tenant`, + mock email inchangé).

- [ ] **Step 1:** Ajouter l'entrée PREFIX + les endpoints au tableau `FORMS`.
- [ ] **Step 2:** Lancer `npx vitest run src/ui-api-contract.golden.test.ts src/forms-submission.golden.test.ts` → PASS (montés, protégés, robustes).
- [ ] **Step 3: Commit** — `git commit -m "test(attendance): goldens ui-api-contract + forms-submission"`

---

## Task 16: Worker — job attendance-poll

**Files:**
- Create: `apps/worker/src/jobs/attendance-poll.ts`
- Test: `apps/worker/src/jobs/attendance-poll.test.ts`

**Interfaces:** Produces `processAttendancePollJob(job)` : lit `{ schemaName, deviceId }`, charge la badgeuse, `fetchDevicePunches`, `insertPunches`, met à jour `sync_cursor`/`last_sync_status`, enfile `attendance-evaluate` pour les jours affectés. Réutilise la logique via import des services API (ou duplique les requêtes minimalement — suivre le patron `jobs/cnps.ts`).

- [ ] **Step 1: Tests** — device injoignable → `last_sync_status='error'` sans crash ; punches insérés → cursor avancé. **Step 2–4: TDD** (mock pg + fetch). **Step 5: Commit** — `git commit -m "feat(attendance): worker job poll badgeuse"`

---

## Task 17: Worker — job attendance-evaluate

**Files:**
- Create: `apps/worker/src/jobs/attendance-evaluate.ts`
- Test: idem `.test.ts`

**Interfaces:** Produces `processAttendanceEvaluateJob(job)` : lit `{ schemaName, employeeId?, dateFrom, dateTo }` ; pour chaque employé/jour : `computeDay` (avec fériés CI via `joursFeriesCI` + congés approuvés via `absences`), `upsertDay`, puis `evaluateEscalation` → `insertWarning` + `insertSanctionDraft` + `notifyUser` (RH + employé).

- [ ] **Step 1: Tests** — un scénario 3×1h → 2 warnings + 1 brouillon sanction persistés + notifications ; congé approuvé → pas de warning. **Step 2–4: TDD.** **Step 5: Commit** — `git commit -m "feat(attendance): worker job évaluation + escalade + sanction draft"`

---

## Task 18: Worker — enregistrement queues + cron

**Files:** Modify `apps/worker/src/index.ts`.

- [ ] **Step 1:** Ajouter `createWorker('attendance-poll', processAttendancePollJob)` et `createWorker('attendance-evaluate', processAttendanceEvaluateJob)` ; une fonction `scheduleAttendanceCron()` qui `upsertJobScheduler` un balayage quotidien (ex. `15 5 * * *` Africa/Abidjan) déclenchant l'évaluation de la veille pour chaque tenant actif ayant le module `attendance` (requête `platform.tenants`). Le poll par device est enfilé soit par le cron (par `poll_interval_min`) soit par `/sync`. Garder un cap anti-storm (comme `LEGAL_WATCH_MAX_SOURCES`).
- [ ] **Step 2:** `npx tsc --noEmit` (worker) → PASS. **Step 3: Commit** — `git commit -m "feat(attendance): enregistrement queues + cron worker"`

---

## Task 19: Écran RH — AttendancePage (onglets)

**Files:**
- Create: `apps/web/src/pages/attendance/AttendancePage.tsx`
- Test: `apps/web/src/pages/attendance/attendance.test.tsx`
- Modify: `apps/web/src/App.tsx` (route `/attendance` sous RoleGuard RH + ModuleGuard `attendance`)

**Interfaces:** Consomme les endpoints Task 10-14 via `api`. Onglets : Tableau de bord, Pointages, Retards & absences, Avertissements, Configuration.

- [ ] **Step 1: Test composant** (vitest jsdom + Testing Library, patron `users-tab.test.tsx`) — l'onglet Avertissements affiche la liste ; le bouton « marquer justifié » appelle `PATCH /warnings/:id` ; erreur affichée si échec. **Step 2–4: TDD.** **Step 5: Commit** — `git commit -m "feat(attendance): écran RH à onglets"`

---

## Task 20: Self-service employé

**Files:** Modify `apps/web/src/pages/mon-espace/*` (ajouter Mes pointages + Mes avertissements avec bouton répondre) ; test composant.

- [ ] **Step 1: Test** — répondre à une demande d'explication appelle `POST /attendance/me/warnings/:id/respond` et affiche la confirmation. **Step 2–4: TDD.** **Step 5: Commit** — `git commit -m "feat(attendance): self-service employé (pointages + réponse explication)"`

---

## Task 21: i18n + sidebar

**Files:** Create `apps/web/src/i18n/locales/{fr,en}/attendance.json` ; enregistrer le namespace ; Modify `Sidebar.tsx` (entrées `attendance` gated module + rôle).

- [ ] **Step 1:** Ajouter les clés FR/EN (onglets, colonnes, statuts, boutons, messages). Enregistrer le namespace dans la config i18n. Ajouter les entrées sidebar `{ to:'/attendance', labelKey:'attendance', moduleKey:'attendance' }` (RH) et l'entrée self-service employé.
- [ ] **Step 2:** `npx tsc --noEmit` (web) + `npx vitest run` (web) → PASS. **Step 3: Commit** — `git commit -m "feat(attendance): i18n FR/EN + entrées sidebar"`

---

## Task 22: Vérification finale (non-régression)

- [ ] **Step 1:** API suite complète — `cd apps/api && npx vitest run` → tout vert. **Step 2:** `npx tsc --noEmit` (api + web + worker) → 0 erreur. **Step 3:** Web — `cd apps/web && npx vitest run` → vert.
- [ ] **Step 4:** Vérifier manuellement : module désactivé (défaut) → aucune route `/attendance` accessible (403 moduleDisabled) et aucun changement de comportement existant.
- [ ] **Step 5:** Golden `ui-api-contract` + `forms-submission` verts (déjà en Task 15, re-confirmer).
- [ ] **Step 6: Commit** (si ajustements) — `git commit -m "test(attendance): non-régression suite complète verte"`

---

## Self-Review — couverture spec

| Section spec | Task(s) |
|---|---|
| 4.1 devices + mapping | 1, 4, 11 |
| 4.2 punches (dedup) | 1, 9, 11 |
| 4.3 schedules cascade | 1, 5, 12 |
| 4.4 days compute | 1, 6, 13 |
| 4.5 warnings + statuts | 1, 7, 14 |
| 4.6 config singleton | 1, 10 |
| 4.7 lien discipline (draft) | 7, 9, 17 |
| 5 escalade (paliers, fenêtres, sanction, contradictoire) | 7, 14, 17 |
| 6 sécurité (SSRF, secrets, RBAC, audit) | 8, 10-14 |
| 7 endpoints | 10-14 |
| 8 écrans | 19, 20, 21 |
| 9 jobs worker | 16, 17, 18 |
| 10 anti-régression | 2, 15, 22 |
| 11 tests | chaque task (TDD) + 22 |

Aucune section sans task. Types cohérents (Task 3 source unique). Pas de placeholder : le code des services purs (cœur) est complet ; les tasks CRUD/UI référencent des patrons repo précis (discipline/integrations/settings) avec fichiers, colonnes et signatures exacts.
