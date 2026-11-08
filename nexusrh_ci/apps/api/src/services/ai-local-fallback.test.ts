/**
 * Repli de l'assistante sur un modèle LOCAL — elle cesse d'être muette.
 *
 * Constat : sans clé Claude ni Mistral, `POST /ai/chat` répondait 503 et
 * `GET /ai/status` « non configurée ». C'est arrivé en production le
 * 22/06/2026 (ANTHROPIC_API_KEY = placeholder) : l'assistante était hors
 * service alors que le reste du produit tournait.
 *
 * Trois propriétés tenues ici :
 *  1. le modèle local ne prend la main qu'en DERNIER recours — jamais à la
 *     place d'une clé qui marche, sinon on dégraderait la qualité sans le dire ;
 *  2. il est configuré par l'EXPLOITANT (variable d'environnement), jamais par
 *     un tenant : laisser un tenant choisir l'adresse du modèle, ce serait lui
 *     laisser exfiltrer les données RH qu'on y envoie (A10/SSRF) ;
 *  3. `/status` et `/chat` partagent la même décision — l'écran ne peut plus
 *     annoncer une IA que la route refuse.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `vi.mock` est hissé au-dessus des déclarations : la configuration mutable
// doit l'être aussi, sinon la factory lit `cfg` avant son initialisation.
const { cfg } = vi.hoisted(() => ({ cfg: {
  env: 'test',
  jwt: { secret: 'x'.repeat(40), expiresIn: '1h' },
  database: { url: 'postgresql://test' },
  redis: { url: 'redis://localhost:6380' },
  ai: { apiKey: null as string | null, model: 'claude-model', maxTokens: 1024, temperature: 0, defaultProvider: 'claude' },
  mistral: { apiKey: null as string | null, model: 'mistral-model', apiUrl: 'https://api.mistral.ai/v1' },
  aiLocal: { apiUrl: '', model: 'mistral-7b-instruct', apiKey: null as string | null },
} }))
vi.mock('../config.js', () => ({ config: cfg }))
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../db/pool.js', () => ({ pool: { query: queryMock } }))

import {
  DEFAULT_LOCAL_LABEL, envCreds, isUsableModelUrl, loadLocalModel, localModel,
  selectChatProvider, type AiCreds,
} from './ai-credentials.service.js'

const creds = (over: Partial<AiCreds> = {}): AiCreds => ({
  claude:  { apiKey: null, model: 'claude-model',  source: null },
  mistral: { apiKey: null, model: 'mistral-model', source: null },
  preferredProvider: 'claude',
  ...over,
})

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] })
  cfg.ai.apiKey = null
  cfg.mistral.apiKey = null
  cfg.aiLocal = { apiUrl: '', model: 'mistral-7b-instruct', apiKey: null }
})
afterEach(() => { vi.restoreAllMocks() })

describe('Configuration du modèle local', () => {
  it('non configuré par défaut : rien ne change pour les installations existantes', () => {
    expect(localModel()).toBeNull()
  })

  it('une URL suffit — la clé est facultative', () => {
    cfg.aiLocal.apiUrl = 'http://vllm.nexusrh-ci.svc:8000/v1'
    expect(localModel()).toEqual({
      apiUrl: 'http://vllm.nexusrh-ci.svc:8000/v1', model: 'mistral-7b-instruct', apiKey: null,
      label: 'modèle local',
    })
  })

  it('une URL vide ou blanche reste « non configuré »', () => {
    cfg.aiLocal.apiUrl = '   '
    expect(localModel()).toBeNull()
  })

  it('la clé est transmise quand la passerelle en exige une', () => {
    cfg.aiLocal.apiUrl = 'http://gateway/v1'
    cfg.aiLocal.apiKey = 'jeton-interne'
    expect(localModel()?.apiKey).toBe('jeton-interne')
  })
})

describe('Choix du fournisseur', () => {
  const local = { apiUrl: 'http://vllm/v1', model: 'lucie-7b', apiKey: null, label: 'Lucie 7B' }

  it('sans aucune clé, le modèle local répond au lieu du 503', () => {
    expect(selectChatProvider(creds(), local)).toBe('local')
  })

  it('mais une clé qui marche passe TOUJOURS devant lui', () => {
    expect(selectChatProvider(creds({ claude: { apiKey: 'k', model: 'c', source: 'platform' } }), local)).toBe('claude')
    expect(selectChatProvider(creds({ mistral: { apiKey: 'k', model: 'm', source: 'tenant' } }), local)).toBe('mistral')
  })

  it('la préférence du tenant est respectée quand sa clé existe', () => {
    const both = creds({
      claude:  { apiKey: 'kc', model: 'c', source: 'tenant' },
      mistral: { apiKey: 'km', model: 'm', source: 'tenant' },
      preferredProvider: 'mistral',
    })
    expect(selectChatProvider(both, local)).toBe('mistral')
  })

  it('une préférence sans clé se replie sur l’autre fournisseur, pas sur le local', () => {
    const only = creds({ mistral: { apiKey: 'km', model: 'm', source: 'tenant' }, preferredProvider: 'claude' })
    expect(selectChatProvider(only, local)).toBe('mistral')
  })

  it('sans clé ET sans modèle local : aucun fournisseur, l’indisponibilité est dite', () => {
    expect(selectChatProvider(creds(), null)).toBeNull()
  })
})

describe('Souveraineté de la configuration', () => {
  it('l’adresse du modèle local vient de l’environnement, jamais d’un tenant', () => {
    cfg.aiLocal.apiUrl = 'http://interne/v1'
    // `localModel()` ne prend AUCUN paramètre : il n'existe pas de chemin par
    // lequel un tenant pourrait faire pointer l'IA vers un serveur à lui.
    expect(localModel.length).toBe(0)
    expect(localModel()?.apiUrl).toBe('http://interne/v1')
  })

  it('le repli local n’est pas une clé plateforme : aucune consommation à facturer', () => {
    // `envCreds` ne fabrique pas de source pour le local : seuls Claude et
    // Mistral alimentent le suivi de conso (platform.ai_usage).
    const env = envCreds()
    expect(env.claude.source).toBeNull()
    expect(env.mistral.source).toBeNull()
    expect(env).not.toHaveProperty('local')
  })
})

/**
 * Le modèle auto-hébergé est PARAMÉTRÉ, pas codé : Lucie 7B aujourd'hui, Qwen
 * ou Llama demain. Le protocole (OpenAI-compatible) ne change pas, donc
 * changer de modèle ne doit toucher ni le code, ni le chart Helm.
 */
describe('Paramétrage par la plateforme', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    rows: [{
      ai_local_api_url: 'http://lucie-7b.nexusrh-ci.svc.cluster.local:8000/v1',
      ai_local_model: 'lucie-7b', ai_local_label: 'Lucie 7B', ...over,
    }],
  })

  it('prend l’adresse, le modèle et le libellé réglés par le super_admin', async () => {
    queryMock.mockResolvedValue(row())
    await expect(loadLocalModel()).resolves.toEqual({
      apiUrl: 'http://lucie-7b.nexusrh-ci.svc.cluster.local:8000/v1',
      model: 'lucie-7b', apiKey: null, label: 'Lucie 7B',
    })
  })

  it('changer de modèle demain ne demande qu’une ligne de configuration', async () => {
    queryMock.mockResolvedValue(row({
      ai_local_api_url: 'http://qwen.ia.svc:8000/v1', ai_local_model: 'qwen2.5-7b-instruct',
      ai_local_label: 'Qwen 2.5',
    }))
    const m = await loadLocalModel()
    expect(m).toMatchObject({ apiUrl: 'http://qwen.ia.svc:8000/v1', model: 'qwen2.5-7b-instruct', label: 'Qwen 2.5' })
  })

  it('la configuration plateforme passe devant l’environnement', async () => {
    cfg.aiLocal.apiUrl = 'http://ancienne-adresse/v1'
    queryMock.mockResolvedValue(row())
    expect((await loadLocalModel())?.apiUrl).toContain('lucie-7b')
  })

  it('sans réglage plateforme, l’environnement sert de repli', async () => {
    cfg.aiLocal.apiUrl = 'http://depuis-env/v1'
    queryMock.mockResolvedValue({ rows: [{ ai_local_api_url: null, ai_local_model: null, ai_local_label: null }] })
    expect((await loadLocalModel())?.apiUrl).toBe('http://depuis-env/v1')
  })

  it('une adresse invalide ne remplace pas un repli valide', async () => {
    cfg.aiLocal.apiUrl = 'http://depuis-env/v1'
    queryMock.mockResolvedValue(row({ ai_local_api_url: 'pas-une-url' }))
    expect((await loadLocalModel())?.apiUrl).toBe('http://depuis-env/v1')
  })

  it('un libellé vide retombe sur un intitulé neutre, jamais sur un nom de modèle inventé', async () => {
    queryMock.mockResolvedValue(row({ ai_local_label: '  ' }))
    expect((await loadLocalModel())?.label).toBe(DEFAULT_LOCAL_LABEL)
  })

  it('une base indisponible n’empêche pas l’IA de fonctionner', async () => {
    cfg.aiLocal.apiUrl = 'http://depuis-env/v1'
    queryMock.mockRejectedValue(new Error('relation does not exist'))
    expect((await loadLocalModel())?.apiUrl).toBe('http://depuis-env/v1')
  })

  it('aucun réglage nulle part : pas de modèle local, l’indisponibilité est dite', async () => {
    await expect(loadLocalModel()).resolves.toBeNull()
  })
})

describe('Validation de l’adresse du modèle', () => {
  it('accepte un service du cluster — une adresse privée est ici légitime', () => {
    expect(isUsableModelUrl('http://lucie-7b.nexusrh-ci.svc.cluster.local:8000/v1')).toBe(true)
    expect(isUsableModelUrl('http://10.42.0.17:8000/v1')).toBe(true)
    expect(isUsableModelUrl('https://ia.openlabconsulting.com/v1')).toBe(true)
  })

  it('refuse ce qui n’est pas du http(s), et les identifiants dans l’URL', () => {
    for (const bad of ['', 'pas-une-url', 'file:///etc/passwd', 'ftp://h/v1',
                       'gopher://h', 'http://user:pass@h/v1']) {
      expect(isUsableModelUrl(bad), bad).toBe(false)
    }
  })
})
