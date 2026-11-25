/**
 * Rappels avant expiration du mot de passe (J-7, J-2, J-1).
 *
 * Ce que ce banc protège, c'est l'inverse du bruit : un rappel qui part trop
 * tôt n'est pas lu, un rappel qui part deux fois par jour discrédite les
 * suivants, et un rappel qui ne part pas enferme le salarié dehors. Le
 * 25/11/2026, faute de tout avertissement, 58 comptes sur 60 étaient expirés.
 *
 * Le non-rejeu est éprouvé autant que l'envoi, et le déclenchement est testé
 * sur « seuil atteint » et non sur « égalité » : une exécution manquée ne doit
 * pas faire sauter un palier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
const { addMock, closeMock } = vi.hoisted(() => ({ addMock: vi.fn(), closeMock: vi.fn() }))
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('pg', () => ({ Pool: vi.fn(function () { return { query: queryMock, end: vi.fn() } }) }))
vi.mock('../logger.js', () => ({ logger: loggerMock }))
vi.mock('../redis.js', () => ({ createClient: () => ({}) }))
vi.mock('bullmq', () => ({
  Queue: vi.fn(function () { return { add: addMock, close: closeMock } }),
}))

import {
  processPasswordExpiryNoticeJob,
  joursAvantExpiration,
  palierPour,
  corpsEmail,
  politiqueMaxAge,
  DEFAUT_MAX_AGE_JOURS,
  PALIERS,
} from './password-expiry-notice.js'

const job = () => ({ id: 'job-1', data: {} } as unknown as Job<unknown, void>)

beforeEach(() => {
  queryMock.mockReset(); addMock.mockReset(); closeMock.mockReset()
  loggerMock.info.mockReset(); loggerMock.warn.mockReset(); loggerMock.error.mockReset()
  closeMock.mockResolvedValue(undefined)
  addMock.mockResolvedValue(undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// Le calcul : il doit s'accorder avec le login, pas avec l'intuition
// ─────────────────────────────────────────────────────────────────────────────
describe('joursAvantExpiration', () => {
  const now = new Date('2026-11-25T12:00:00Z')
  const ilYA = (j: number) => new Date(now.getTime() - j * 86_400_000).toISOString()

  it('ne dit rien si l expiration est désactivée ou la date absente', () => {
    expect(joursAvantExpiration(ilYA(50), 0, now)).toBeNull()
    expect(joursAvantExpiration(null, 30, now)).toBeNull()
    expect(joursAvantExpiration('pas-une-date', 30, now)).toBeNull()
  })

  it('compte les jours restants', () => {
    expect(joursAvantExpiration(ilYA(23), 30, now)).toBe(7)
    expect(joursAvantExpiration(ilYA(28), 30, now)).toBe(2)
    expect(joursAvantExpiration(ilYA(29), 30, now)).toBe(1)
  })

  it('pile à l échéance, le login laisse passer : 1 jour, pas 0', () => {
    expect(joursAvantExpiration(ilYA(30), 30, now)).toBe(1)
  })

  it('renvoie 0 une fois l échéance franchie, jamais un négatif', () => {
    expect(joursAvantExpiration(ilYA(31), 30, now)).toBe(0)
    expect(joursAvantExpiration(ilYA(300), 30, now)).toBe(0)
  })
})

describe('politiqueMaxAge — le worker doit lire la politique comme l API', () => {
  it('retombe sur 30 jours, et non sur « désactivé », quand la valeur manque', () => {
    // Un repli à 0 faisait taire le worker pendant que le login, lui,
    // continuait d'expirer les comptes : le silence même qu'on corrige.
    expect(DEFAUT_MAX_AGE_JOURS).toBe(30)
    expect(politiqueMaxAge(null)).toBe(30)
    expect(politiqueMaxAge(undefined)).toBe(30)
    expect(politiqueMaxAge('pas-un-nombre')).toBe(30)
    expect(politiqueMaxAge({})).toBe(30)
  })

  it('respecte un 0 explicite en base : expiration réellement désactivée', () => {
    expect(politiqueMaxAge(0)).toBe(0)
    expect(politiqueMaxAge('0')).toBe(0)
  })

  it('lit un entier, y compris renvoyé sous forme de chaîne par pg', () => {
    expect(politiqueMaxAge(90)).toBe(90)
    expect(politiqueMaxAge('45')).toBe(45)
    expect(politiqueMaxAge(45.9)).toBe(45)
  })
})

describe('palierPour', () => {
  it('les paliers sont bien ceux demandés : 7, 2 et 1 jours', () => {
    expect([...PALIERS]).toEqual([7, 2, 1])
  })

  it('se tait au-delà de sept jours', () => {
    expect(palierPour(30)).toBeNull()
    expect(palierPour(8)).toBeNull()
  })

  it('déclenche sur seuil ATTEINT, pas sur égalité stricte', () => {
    // Si le worker a été arrêté le jour du J-7 exact, le rappel doit tout de
    // même partir au prochain réveil : sinon un palier saute définitivement.
    expect(palierPour(7)).toBe(7)
    expect(palierPour(6)).toBe(7)
    expect(palierPour(4)).toBe(7)
  })

  it('retient le palier le plus proche', () => {
    expect(palierPour(2)).toBe(2)
    expect(palierPour(1)).toBe(1)
  })

  it('se tait sur un compte déjà expiré ou une valeur aberrante', () => {
    expect(palierPour(0)).toBeNull()
    expect(palierPour(-3)).toBeNull()
    expect(palierPour(Number.NaN)).toBeNull()
    expect(palierPour(null)).toBeNull()
  })
})

describe('corpsEmail', () => {
  it('dit « moins de 24 heures » le dernier jour, et non « dans 1 jours »', () => {
    const m = corpsEmail({ firstName: 'Awa', joursRestants: 1 }, 'https://x/change-password')
    // Pas « demain » : le rappel part le matin, l'échéance peut tomber le soir.
    expect(m.subject).toContain('moins de 24 heures')
    expect(m.subject).not.toContain('demain')
    expect(m.text).toContain('Bonjour Awa,')
    expect(m.text).not.toContain('dans 1 jours')
  })

  it('reste correct sans prénom connu', () => {
    const m = corpsEmail({ firstName: null, joursRestants: 7 }, 'https://x/change-password')
    expect(m.text).toContain('Bonjour,')
    expect(m.subject).toContain('7 jours')
  })

  it('échappe le prénom : une fiche RH ne doit pas injecter de balise', () => {
    const m = corpsEmail(
      { firstName: '<img src=x onerror=alert(1)>', joursRestants: 2 },
      'https://x/change-password',
    )
    expect(m.html).not.toContain('<img')
    expect(m.html).toContain('&lt;img')
    // La version texte n'a rien à échapper : elle n'est jamais interprétée.
    expect(m.text).toContain('<img src=x onerror=alert(1)>')
  })

  it('porte toujours le lien de changement', () => {
    const m = corpsEmail({ firstName: 'Awa', joursRestants: 2 }, 'https://x/change-password')
    expect(m.html).toContain('https://x/change-password')
    expect(m.text).toContain('https://x/change-password')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le job complet
// ─────────────────────────────────────────────────────────────────────────────
interface Scenario {
  maxAge?: number
  tenants?: string[]
  /** Comptes par source, dans l'ordre : platform, agency, puis les tenants. */
  comptes?: Array<Array<{ id: string; email: string; first_name: string | null; jours: number }>>
  /** Lignes déjà notifiées : l'INSERT renverra 0. */
  dejaNotifies?: Set<string>
  /** Code d'erreur PostgreSQL à lever sur la source d'index donné. */
  echecSurSource?: { index: number; code?: string }
}

function brancher(sc: Scenario) {
  const maxAge = sc.maxAge ?? 30
  const maintenant = Date.now()
  let sourceIdx = -1
  queryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('CREATE TABLE IF NOT EXISTS platform.password_expiry_notices')) {
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    if (sql.includes('password_max_age_days')) {
      return Promise.resolve({ rows: [{ d: maxAge }], rowCount: 1 })
    }
    if (sql.includes('FROM platform.tenants')) {
      return Promise.resolve({
        rows: (sc.tenants ?? []).map((s) => ({ schema_name: s })), rowCount: 0,
      })
    }
    if (sql.startsWith('SELECT id, email, first_name, password_changed_at')) {
      sourceIdx++
      if (sc.echecSurSource && sc.echecSurSource.index === sourceIdx) {
        const e = new Error('boom') as Error & { code?: string }
        e.code = sc.echecSurSource.code ?? '42P01'
        return Promise.reject(e)
      }
      const lot = (sc.comptes ?? [])[sourceIdx] ?? []
      return Promise.resolve({
        rows: lot.map((u) => ({
          id: u.id, email: u.email, first_name: u.first_name,
          // On exprime le scénario en « jours restants » et on remonte à la date.
          password_changed_at: new Date(
            maintenant - (maxAge - u.jours) * 86_400_000,
          ).toISOString(),
        })),
        rowCount: lot.length,
      })
    }
    if (sql.includes('INSERT INTO platform.password_expiry_notices')) {
      const cle = String((params ?? [])[0]) + ':' + String((params ?? [])[1]) + ':' + String((params ?? [])[2])
      if (sc.dejaNotifies?.has(cle)) return Promise.resolve({ rows: [], rowCount: 0 })
      return Promise.resolve({ rows: [{ id: 'n1' }], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}

describe('processPasswordExpiryNoticeJob', () => {
  it('n envoie rien quand l expiration est désactivée', async () => {
    brancher({ maxAge: 0 })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).not.toHaveBeenCalled()
  })

  it('n envoie rien quand personne n approche de l échéance', async () => {
    brancher({ comptes: [[{ id: 'u1', email: 'a@b.ci', first_name: 'A', jours: 20 }], []] })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).not.toHaveBeenCalled()
  })

  it('prévient à sept, deux et un jour', async () => {
    brancher({
      comptes: [[
        { id: 'u7', email: 'sept@b.ci', first_name: 'Sept', jours: 7 },
        { id: 'u2', email: 'deux@b.ci', first_name: 'Deux', jours: 2 },
        { id: 'u1', email: 'un@b.ci', first_name: 'Un', jours: 1 },
      ], []],
    })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(3)
    const destinataires = addMock.mock.calls.map((c) => (c[1] as { to: string }).to)
    expect(destinataires).toEqual(['sept@b.ci', 'deux@b.ci', 'un@b.ci'])
  })

  it('ne prévient pas un compte déjà expiré : l API impose déjà le changement', async () => {
    // « jours: -1 » = échéance franchie de 24 h. On n'écrit PAS « jours: 0 » :
    // cela placerait la date pile à l'échéance, cas où le login laisse encore
    // passer — il reste donc un jour, et le scénario deviendrait un
    // pile-ou-face sur la milliseconde séparant le banc du job.
    brancher({ comptes: [[{ id: 'u0', email: 'x@b.ci', first_name: null, jours: -1 }], []] })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).not.toHaveBeenCalled()
  })

  it('prévient encore le compte pile à l échéance, que le login accepte', async () => {
    // Frontière symétrique de la précédente : tant que le login laisse passer,
    // le rappel doit partir — c'est le dernier moment utile pour agir.
    brancher({ comptes: [[{ id: 'u0', email: 'x@b.ci', first_name: null, jours: 0.5 }], []] })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(1)
    expect((addMock.mock.calls[0]![1] as { subject: string }).subject).toContain('moins de 24 heures')
  })

  it('couvre les trois chemins de connexion : plateforme, cabinet et tenants', async () => {
    brancher({
      tenants: ['tenant_sotra'],
      comptes: [
        [{ id: 'p1', email: 'super@n.ci', first_name: 'S', jours: 2 }],
        [{ id: 'a1', email: 'cab@n.ci', first_name: 'C', jours: 2 }],
        [{ id: 't1', email: 'rh@sotra.ci', first_name: 'R', jours: 2 }],
      ],
    })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(3)
    // Le super_admin est précisément celui qui s'est retrouvé dehors : il doit
    // être couvert comme les autres.
    expect(addMock.mock.calls.map((c) => (c[1] as { to: string }).to)).toContain('super@n.ci')
    expect(addMock.mock.calls.map((c) => (c[1] as { to: string }).to)).toContain('cab@n.ci')
  })

  it('ne renvoie rien le lendemain pour le même palier', async () => {
    brancher({
      comptes: [[{ id: 'u2', email: 'deux@b.ci', first_name: 'D', jours: 2 }], []],
      dejaNotifies: new Set(['platform:u2:2']),
    })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).not.toHaveBeenCalled()
  })

  it('franchit le palier suivant même si le précédent a déjà été envoyé', async () => {
    brancher({
      comptes: [[{ id: 'u', email: 'u@b.ci', first_name: 'U', jours: 1 }], []],
      dejaNotifies: new Set(['platform:u:7', 'platform:u:2']),
    })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(1)
    expect((addMock.mock.calls[0]![1] as { subject: string }).subject)
      .toContain('moins de 24 heures')
  })

  it('un tenant non migré ne prive pas les autres de leur rappel', async () => {
    brancher({
      tenants: ['tenant_vieux', 'tenant_sotra'],
      comptes: [
        [], [],
        [],  // tenant_vieux : remplacé par l'échec ci-dessous
        [{ id: 't1', email: 'rh@sotra.ci', first_name: 'R', jours: 1 }],
      ],
      echecSurSource: { index: 2, code: '42P01' },
    })
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(1)
    expect((addMock.mock.calls[0]![1] as { to: string }).to).toBe('rh@sotra.ci')
  })

  it('ignore un schéma au nom inattendu au lieu de l interpoler', async () => {
    brancher({
      tenants: ['tenant_ok', 'public"; DROP TABLE users; --'],
      comptes: [[], [], [{ id: 't', email: 'ok@b.ci', first_name: 'O', jours: 1 }]],
    })
    await processPasswordExpiryNoticeJob(job())
    expect(loggerMock.warn).toHaveBeenCalled()
    const requetes = queryMock.mock.calls.map((c) => String(c[0]))
    expect(requetes.some((q) => q.includes('DROP TABLE'))).toBe(false)
  })

  it('un envoi impossible retire sa trace, pour que le palier soit réessayé', async () => {
    // La trace est posée AVANT l'envoi (anti-doublon). Si l'enfilage échoue,
    // la laisser en place annoncerait un rappel envoyé et perdrait le palier
    // pour de bon : on la retire.
    brancher({ comptes: [[{ id: 'u', email: 'u@b.ci', first_name: 'U', jours: 1 }], []] })
    addMock.mockRejectedValue(new Error('redis indisponible'))
    await processPasswordExpiryNoticeJob(job())
    const suppressions = queryMock.mock.calls
      .map((c) => String(c[0]))
      .filter((q) => q.includes('DELETE FROM platform.password_expiry_notices'))
    expect(suppressions).toHaveLength(1)
    expect(loggerMock.warn).toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
  })

  it("un incident d'enfilage ne prive pas les comptes suivants", async () => {
    // Un Redis qui bronche sur un compte ne doit pas faire tomber la tournée
    // entière : c'est exactement ce qui laisse une population sans rappel.
    brancher({
      comptes: [[
        { id: 'u1', email: 'un@b.ci', first_name: 'U', jours: 1 },
        { id: 'u2', email: 'deux@b.ci', first_name: 'D', jours: 2 },
      ], []],
    })
    addMock.mockRejectedValueOnce(new Error('redis indisponible')).mockResolvedValue(undefined)
    await processPasswordExpiryNoticeJob(job())
    expect(addMock).toHaveBeenCalledTimes(2)
    expect((addMock.mock.calls[1]![1] as { to: string }).to).toBe('deux@b.ci')
  })

  it("n'envoie rien en production quand APP_URL est absente", async () => {
    // Constaté en prod : APP_URL vide produisait un lien nu « /change-password »,
    // inutilisable depuis une boîte mail — et le non-rejeu aurait brûlé le
    // palier sur un email mort.
    const env = process.env['NODE_ENV']
    const url = process.env['APP_URL']
    process.env['NODE_ENV'] = 'production'
    process.env['APP_URL'] = '   '
    try {
      brancher({ comptes: [[{ id: 'u', email: 'u@b.ci', first_name: 'U', jours: 2 }], []] })
      await processPasswordExpiryNoticeJob(job())
      expect(addMock).not.toHaveBeenCalled()
      expect(loggerMock.error).toHaveBeenCalled()
    } finally {
      if (env === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = env
      if (url === undefined) delete process.env['APP_URL']; else process.env['APP_URL'] = url
    }
  })

  it('signale une colonne absente au lieu de perdre toute une population', async () => {
    // 42703 était avalé comme un tenant non migré : une colonne manquante
    // supprimait silencieusement tous les rappels d'une population entière.
    brancher({
      comptes: [[], [{ id: 'a', email: 'cab@b.ci', first_name: 'C', jours: 2 }]],
      echecSurSource: { index: 0, code: '42703' },
    })
    await processPasswordExpiryNoticeJob(job())
    expect(loggerMock.error).toHaveBeenCalled()
    // Les autres populations sont servies malgré tout.
    expect(addMock).toHaveBeenCalledTimes(1)
  })
})
