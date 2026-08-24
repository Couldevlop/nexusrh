/**
 * GOLDEN — Formulaire public « Demander une démo ».
 *
 * C'est le seul endpoint non authentifié qui accepte du texte libre et
 * déclenche un envoi d'email. Il concentre donc les risques : robots,
 * injection dans le courriel, rejeu de captcha, engorgement de la boîte.
 *
 * Ces tests verrouillent les défenses :
 *   - captcha signé, à usage unique, expirant ;
 *   - piège à robots (champ caché) qui absorbe sans rien envoyer ;
 *   - contenu utilisateur échappé avant d'entrer dans le HTML du courriel ;
 *   - validation stricte, aucun champ surnuméraire accepté.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))

const { consumeOnceMock } = vi.hoisted(() => ({ consumeOnceMock: vi.fn() }))
vi.mock('../../services/redis.js', () => ({
  consumeOnce: consumeOnceMock,
  blacklistTokenSafe: vi.fn(), isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))

const { sendDemoMock } = vi.hoisted(() => ({ sendDemoMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/email.js', () => ({ sendDemoRequestEmail: sendDemoMock }))

vi.mock('../../utils/schema-migrations.js', () => ({
  ensurePlatformSchema: vi.fn().mockResolvedValue(undefined),
  ensureTenantSchema:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    smtp: { from: 'NexusRH <no-reply@openlabconsulting.com>' },
  },
}))

import demoRoutes from './demo.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(demoRoutes, { prefix: '/public/demo' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [{ id: 'd1' }] })
  consumeOnceMock.mockReset().mockResolvedValue(true)
  sendDemoMock.mockReset().mockResolvedValue(undefined)
})

/** Récupère un défi et le résout comme le ferait un visiteur. */
async function solvedChallenge(): Promise<{ captchaToken: string; captchaAnswer: string }> {
  const res = await app.inject({ method: 'GET', url: '/public/demo/captcha' })
  const { token, question } = JSON.parse(res.body) as { token: string; question: string }
  // La question porte deux nombres et une opération : « 3 + sept », « 4 × deux »…
  const WORDS: Record<string, number> = {
    un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
    one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
  }
  const parts = question.replace('?', '').trim().split(/\s+/)
  const num = (s: string): number => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()] ?? NaN)
  const a = num(parts[0]!), op = parts[1]!, b = num(parts[2]!)
  const answer = op === '+' ? a + b : a * b
  return { captchaToken: token, captchaAnswer: String(answer) }
}

const BODY = {
  fullName: 'Awa Koné',
  company: 'SOTRA',
  email: 'awa.kone@sotra.ci',
  phone: '+225 07 09 32 05 94',
  headcount: '200-999',
  message: 'Nous voulons voir la paie CNPS sur notre cas.',
  website: '',
}

describe('GET /public/demo/captcha', () => {
  it('renvoie un défi et un jeton opaque', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/demo/captcha' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.question).toMatch(/\S+\s+[+×]\s+\S+/)
    expect(typeof body.token).toBe('string')
    // La réponse ne doit jamais voyager en clair dans le jeton.
    expect(body.token).not.toContain(String(body.answer))
    expect(body.answer).toBeUndefined()
  })
})

describe('POST /public/demo/request — chemin nominal', () => {
  it('enregistre la demande et envoie le courriel', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({ method: 'POST', url: '/public/demo/request', payload: { ...BODY, ...c } })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(sendDemoMock).toHaveBeenCalledTimes(1)
    expect(sendDemoMock.mock.calls[0]![0]).toMatchObject({ email: BODY.email, company: 'SOTRA' })
    const insert = queryMock.mock.calls.find(c2 => String(c2[0]).includes('INSERT INTO platform.demo_requests'))
    expect(insert, 'la demande doit être conservée en base').toBeTruthy()
  })
})

describe('POST /public/demo/request — défenses', () => {
  it('refuse une mauvaise réponse au captcha', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, captchaAnswer: String(Number(c.captchaAnswer) + 1) },
    })
    expect(res.statusCode).toBe(400)
    expect(sendDemoMock).not.toHaveBeenCalled()
  })

  it('refuse un jeton forgé', async () => {
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, captchaToken: 'aa.bb.cc', captchaAnswer: '4' },
    })
    expect(res.statusCode).toBe(400)
    expect(sendDemoMock).not.toHaveBeenCalled()
  })

  it('refuse le rejeu d\'un défi déjà consommé', async () => {
    const c = await solvedChallenge()
    consumeOnceMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const first = await app.inject({ method: 'POST', url: '/public/demo/request', payload: { ...BODY, ...c } })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: '/public/demo/request', payload: { ...BODY, ...c } })
    expect(second.statusCode).toBe(400)
    expect(sendDemoMock).toHaveBeenCalledTimes(1)
  })

  it('absorbe un robot qui remplit le champ piège, sans rien envoyer', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, website: 'http://spam.example' },
    })
    // Réponse volontairement identique au succès : le robot ne sait pas qu'il est filtré.
    expect(res.statusCode).toBe(200)
    expect(sendDemoMock).not.toHaveBeenCalled()
    expect(queryMock.mock.calls.some(x => String(x[0]).includes('INSERT INTO platform.demo_requests'))).toBe(false)
  })

  it('refuse un champ non prévu (schéma strict)', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, role: 'admin' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuse une adresse mail invalide', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, email: 'pas-une-adresse' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('transmet le contenu tel quel au service d\'email, qui l\'échappera', async () => {
    const c = await solvedChallenge()
    const hostile = '<script>alert(1)</script>'
    await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, message: hostile },
    })
    // La route ne bricole pas de HTML : elle passe des données, l'échappement
    // est la responsabilité — testée à part — du constructeur de courriel.
    expect(sendDemoMock.mock.calls[0]![0].message).toBe(hostile)
  })

  it('ne révèle rien au visiteur quand l\'envoi du courriel échoue', async () => {
    const c = await solvedChallenge()
    sendDemoMock.mockRejectedValueOnce(new Error('SMTP 535 auth failed on mail.openlab.internal'))
    const res = await app.inject({ method: 'POST', url: '/public/demo/request', payload: { ...BODY, ...c } })
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('SMTP')
    expect(res.body).not.toContain('openlab.internal')
  })
})

describe('POST /public/demo/request — durcissements issus de la revue', () => {
  it('refuse un retour chariot dans les champs repris en en-tête de courriel', async () => {
    const c = await solvedChallenge()
    // « Société » finit dans le sujet du message : un CR/LF y ouvrirait la
    // porte à l'ajout d'en-têtes (Bcc, Reply-To…).
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, company: 'SOTRA\r\nBcc: attaquant@example.com' },
    })
    expect(res.statusCode).toBe(400)
    expect(sendDemoMock).not.toHaveBeenCalled()
  })

  it('refuse un retour chariot dans le nom', async () => {
    const c = await solvedChallenge()
    const res = await app.inject({
      method: 'POST', url: '/public/demo/request',
      payload: { ...BODY, ...c, fullName: 'Awa\nKoné' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('purge les demandes au-delà de la durée annoncée dans la politique de confidentialité', async () => {
    const c = await solvedChallenge()
    await app.inject({ method: 'POST', url: '/public/demo/request', payload: { ...BODY, ...c } })
    const purge = queryMock.mock.calls.find(x => String(x[0]).includes('DELETE FROM platform.demo_requests'))
    expect(purge, 'aucune purge : la rétention annoncée ne serait pas tenue').toBeTruthy()
    expect(String(purge?.[0])).toContain('24 months')
  })
})
