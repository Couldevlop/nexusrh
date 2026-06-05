import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Mocks partagés pour le client @elastic/elasticsearch. Le constructeur Client
 * est espionné pour vérifier les options (TLS K3s, node, auth).
 */
const { mockExists, mockCreate, clientCtor } = vi.hoisted(() => ({
  mockExists: vi.fn(),
  mockCreate: vi.fn(),
  clientCtor: vi.fn(),
}))

vi.mock('@elastic/elasticsearch', () => {
  class Client {
    indices = { exists: mockExists, create: mockCreate }
    constructor(opts: unknown) {
      clientCtor(opts)
    }
  }
  return { Client }
})

describe('services/elasticsearch — ensureIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('retourne tôt (early return) si l\'index existe déjà', async () => {
    mockExists.mockResolvedValueOnce(true)
    const mod = await import('./elasticsearch.js')
    await mod.ensureIndex()
    expect(mockExists).toHaveBeenCalledWith({ index: 'nexusrhci_droit_ci' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('crée l\'index avec settings + mappings quand il n\'existe pas', async () => {
    mockExists.mockResolvedValueOnce(false)
    mockCreate.mockResolvedValueOnce({ acknowledged: true })
    const mod = await import('./elasticsearch.js')
    await mod.ensureIndex()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const arg = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg.index).toBe('nexusrhci_droit_ci')
    const settings = arg.settings as { analysis: { analyzer: { droit_ci: { type: string } } } }
    expect(settings.analysis.analyzer.droit_ci.type).toBe('french')
    const mappings = arg.mappings as { properties: Record<string, { type: string } | undefined> }
    expect(mappings.properties.tenant_id?.type).toBe('keyword')
    expect(mappings.properties.texte?.type).toBe('text')
  })

  it('respecte ES_INDEX_DROIT_CI personnalisé', async () => {
    vi.stubEnv('ES_INDEX_DROIT_CI', 'mon_index_custom')
    mockExists.mockResolvedValueOnce(true)
    const mod = await import('./elasticsearch.js')
    expect(mod.ES_INDEX).toBe('mon_index_custom')
    await mod.ensureIndex()
    expect(mockExists).toHaveBeenCalledWith({ index: 'mon_index_custom' })
  })
})

describe('services/elasticsearch — configuration du client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('utilise les valeurs par défaut (node/auth) hors production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    await import('./elasticsearch.js')
    const opts = clientCtor.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.node).toBe('http://localhost:9201')
    expect(opts.auth).toEqual({ username: 'elastic', password: 'nexusrhci-es-dev' })
    expect(opts.tls).toBeUndefined()
  })

  it('respecte ES_URL / ES_USER / ES_PASSWORD personnalisés', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('ES_URL', 'https://es.interne:9200')
    vi.stubEnv('ES_USER', 'svc')
    vi.stubEnv('ES_PASSWORD', 's3cr3t')
    await import('./elasticsearch.js')
    const opts = clientCtor.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.node).toBe('https://es.interne:9200')
    expect(opts.auth).toEqual({ username: 'svc', password: 's3cr3t' })
  })

  it('ajoute le bloc TLS K3s en production avec ES_CA_CERT', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ES_CA_CERT', '/certs/ca.pem')
    vi.stubEnv('ES_CLIENT_CERT', '/certs/client.pem')
    vi.stubEnv('ES_CLIENT_KEY', '/certs/client.key')
    await import('./elasticsearch.js')
    const opts = clientCtor.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.tls).toEqual({
      ca: '/certs/ca.pem',
      cert: '/certs/client.pem',
      key: '/certs/client.key',
      rejectUnauthorized: true,
    })
  })

  it('n\'ajoute PAS le bloc TLS en production sans ES_CA_CERT', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await import('./elasticsearch.js')
    const opts = clientCtor.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.tls).toBeUndefined()
  })
})
