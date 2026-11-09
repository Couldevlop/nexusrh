/**
 * Bascule sur le modèle auto-hébergé quand le fournisseur externe ÉCHOUE.
 *
 * Constaté en production le 09/11/2026 sur SOTRA : l'assistante répondait
 * « Erreur IA », bandeau « Propulsé par Mistral AI », alors qu'un modèle
 * auto-hébergé était configuré. `selectChatProvider` ne regarde que
 * l'EXISTENCE d'une clé : une clé plateforme présente mais inopérante
 * (révoquée, expirée, quota épuisé) l'emportait sur le repli local, et le
 * masquait indéfiniment. Le repli était conditionné à l'absence de clé, jamais
 * à l'échec de l'appel.
 *
 * Trois propriétés tenues ici :
 *  1. un fournisseur externe qui échoue fait basculer sur le modèle local,
 *     plutôt que de rendre l'assistante muette ;
 *  2. la bascule ne se fait QUE si rien n'est encore parti au navigateur —
 *     après le premier mot, rejouer la requête collerait deux réponses bout à
 *     bout dans la même bulle ;
 *  3. la consommation n'est PAS imputée à la clé plateforme du fournisseur qui
 *     n'a rien répondu.
 *
 * Ce qui n'est PAS changé : l'ordre de préférence. Le modèle local reste le
 * dernier choix, jamais préféré à une clé qui fonctionne.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { queryMock, anthropicStreamMock, mistralChatMock, usageMock, LOCAL } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  anthropicStreamMock: vi.fn(),
  mistralChatMock: vi.fn(),
  usageMock: vi.fn(),
  // `vi.mock` est hissé au-dessus des déclarations : la config du modèle local
  // doit l'être aussi, sinon la factory la lit avant son initialisation.
  LOCAL: { apiUrl: 'http://lucie.nexusrh.svc:8000/v1', model: 'lucie-7b', apiKey: null as string | null, label: 'Lucie 7B' },
}))

vi.mock('pg', () => ({ Pool: vi.fn(() => ({ query: queryMock, end: vi.fn() })) }))
vi.mock('../../services/redis.js', () => ({
  blacklistToken: vi.fn().mockResolvedValue(undefined),
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { stream: anthropicStreamMock } })),
}))
vi.mock('./ai-mistral-chat.js', () => ({ streamMistralChat: mistralChatMock }))


// Clé Claude PRÉSENTE (donc préférée) ET modèle local disponible : c'est la
// configuration exacte où le défaut se manifestait.
vi.mock('../../services/ai-credentials.service.js', () => ({
  resolveAiCreds: vi.fn().mockResolvedValue({
    claude:  { apiKey: 'sk-ant-morte', model: 'claude-sonnet-4', source: 'platform' },
    mistral: { apiKey: null, model: 'mistral-large', source: null },
    preferredProvider: 'claude',
  }),
  loadLocalModel: async () => LOCAL,
  localModel: () => LOCAL,
  // Fonction RÉELLE : elle choisit Claude, puisqu'une clé existe. C'est tout
  // le sujet — le repli ne doit plus dépendre d'elle seule.
  selectChatProvider: (c: { preferredProvider: string; claude: { apiKey: string | null }; mistral: { apiKey: string | null } }, local: unknown) =>
    (c.preferredProvider === 'mistral' && c.mistral.apiKey ? 'mistral'
      : c.preferredProvider === 'claude' && c.claude.apiKey ? 'claude'
      : c.mistral.apiKey ? 'mistral'
      : c.claude.apiKey ? 'claude'
      : local ? 'local' : null),
}))

vi.mock('../../config.js', () => ({
  config: {
    env: 'test',
    jwt: { secret: 'test-secret-minimum-32-characters-ok!', expiresIn: '1h' },
    database: { url: 'postgresql://test' },
    redis: { url: 'redis://localhost:6380' },
    ai: { apiKey: 'sk-ant-morte', model: 'claude-sonnet-4', maxTokens: 1024, temperature: 0.3 },
    mistral: { apiKey: '', model: 'mistral-large', apiUrl: 'https://api.mistral.ai/v1' },
    aiLocal: LOCAL,
  },
}))

import authPlugin from '../../plugins/auth.js'
import aiRoutes from './ai.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(authPlugin)
  await app.register(aiRoutes, { prefix: '/ai' })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  anthropicStreamMock.mockReset()
  mistralChatMock.mockReset()
  usageMock.mockReset()
})

function token() {
  return app.jwt.sign({
    sub: 'u-admin', tenantId: 't1', schemaName: 'tenant_sotra', role: 'admin',
    email: 'admin@sotra.ci', firstName: 'Test', lastName: 'User', employeeId: null,
  })
}

const chat = () => app.inject({
  method: 'POST', url: '/ai/chat',
  headers: { authorization: `Bearer ${token()}` },
  payload: { messages: [{ role: 'user', content: 'Quel est le SMIG en Côte d’Ivoire ?' }] },
})

/** Réponse du modèle local, qui émet son texte via `onText`. */
function reponseLocale(texte: string) {
  return async (a: { onText: (t: string) => void }) => {
    a.onText(texte)
    return { usage: { input_tokens: 5, output_tokens: 9 }, stopReason: 'end_turn', toolsUsed: [], rounds: 0 }
  }
}

describe('Fournisseur externe en échec', () => {
  it('bascule sur le modèle auto-hébergé au lieu de rendre l’assistante muette', async () => {
    anthropicStreamMock.mockRejectedValue(new Error('401 Unauthorized'))
    mistralChatMock.mockImplementation(reponseLocale('Le SMIG ivoirien est de 75 000 FCFA.'))

    const res = await chat()
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('75 000 FCFA')
    expect(res.body).not.toContain('Erreur IA')
  })

  it('appelle bien le modèle LOCAL, pas une seconde fois le fournisseur externe', async () => {
    anthropicStreamMock.mockRejectedValue(new Error('429 quota dépassé'))
    mistralChatMock.mockImplementation(reponseLocale('ok'))

    await chat()
    expect(mistralChatMock).toHaveBeenCalledTimes(1)
    const a = mistralChatMock.mock.calls[0]![0] as { apiUrl: string; model: string }
    expect(a.apiUrl).toBe(LOCAL.apiUrl)
    expect(a.model).toBe(LOCAL.model)
  })

  it('n’impute PAS la consommation à la clé plateforme du fournisseur en échec', async () => {
    // Le modèle auto-hébergé tourne chez l'exploitant : il ne consomme aucun
    // quota facturé, et compter ses tokens sur la clé du super_admin
    // fausserait la refacturation.
    anthropicStreamMock.mockRejectedValue(new Error('401'))
    mistralChatMock.mockImplementation(reponseLocale('ok'))

    await chat()
    const inserts = queryMock.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes('ai_usage'))
    expect(inserts).toHaveLength(0)
  })

  it('si le modèle local échoue AUSSI, l’erreur est dite, pas avalée', async () => {
    anthropicStreamMock.mockRejectedValue(new Error('401'))
    mistralChatMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await chat()
    expect(res.body).toContain('Erreur IA')
  })
})

describe('Bascule seulement avant le premier mot', () => {
  it('une panne EN COURS de réponse ne rejoue pas la requête', async () => {
    // Sinon deux réponses se colleraient bout à bout dans la même bulle, et le
    // lecteur n'aurait aucun moyen de voir où la première s'arrête.
    anthropicStreamMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Le SMIG ' } }
        throw new Error('connexion coupée en plein flux')
      },
      finalMessage: vi.fn(),
    }))
    mistralChatMock.mockImplementation(reponseLocale('RÉPONSE LOCALE'))

    const res = await chat()
    expect(res.body).toContain('Le SMIG ')
    expect(res.body).toContain('Erreur IA')
    expect(mistralChatMock).not.toHaveBeenCalled()
    expect(res.body).not.toContain('RÉPONSE LOCALE')
  })
})

describe('Ce qui ne change pas', () => {
  it('une clé externe qui FONCTIONNE n’est jamais remplacée par le modèle local', async () => {
    // Le modèle auto-hébergé reste le dernier choix : basculer sans échec
    // dégraderait la qualité des réponses sans le dire à personne.
    anthropicStreamMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Réponse Claude.' } }
      },
      finalMessage: vi.fn().mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: 'end_turn',
      }),
    }))

    const res = await chat()
    expect(res.body).toContain('Réponse Claude.')
    expect(mistralChatMock).not.toHaveBeenCalled()
  })
})
