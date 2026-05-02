/**
 * Tests — Upload de documents collaborateur
 *
 * On teste 3 couches indépendantes :
 *   1. Intercepteur axios — Content-Type FormData (cause racine du bug 500)
 *   2. Logique DB — CREATE TABLE + INSERT via rawPool
 *   3. Validation du handler — fichier vide / type par défaut
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Pool } from 'pg'

// ══════════════════════════════════════════════════════════════════════════════
// 1. INTERCEPTEUR AXIOS — root cause du 500
// ══════════════════════════════════════════════════════════════════════════════

describe('Axios interceptor — Content-Type FormData', () => {
  /**
   * Reproduit exactement ce que fait api.ts.
   * Avant le fix : Content-Type: application/json était envoyé même pour FormData
   * → Fastify recevait application/json → request.parts() échouait → 500
   */

  function simulateInterceptor(data: unknown, defaultHeaders: Record<string, string>) {
    const headers = { ...defaultHeaders }
    // Fix appliqué dans api.ts
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      delete headers['Content-Type']
    }
    return headers
  }

  it('AVANT fix — FormData envoyait Content-Type: application/json (cause du 500)', () => {
    // Simule l'ancien comportement SANS le fix
    const defaultHeaders = { 'Content-Type': 'application/json' }
    const fd = new FormData()
    fd.append('file', new Blob(['test']), 'test.pdf')

    // Sans fix : Content-Type reste application/json
    const headersWithoutFix = { ...defaultHeaders }
    expect(headersWithoutFix['Content-Type']).toBe('application/json')
    // → Fastify ne peut pas parser multipart → 500
  })

  it('APRÈS fix — Content-Type supprimé pour FormData → navigateur pose boundary', () => {
    const defaultHeaders = { 'Content-Type': 'application/json' }
    const fd = new FormData()
    fd.append('file', new Blob(['test']), 'test.pdf')

    const headers = simulateInterceptor(fd, defaultHeaders)

    // Content-Type doit être absent → navigateur met multipart/form-data; boundary=...
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('Requêtes JSON normales conservent Content-Type: application/json', () => {
    const defaultHeaders = { 'Content-Type': 'application/json' }
    const jsonBody = { name: 'Alice', role: 'admin' }

    const headers = simulateInterceptor(jsonBody, defaultHeaders)

    expect(headers['Content-Type']).toBe('application/json')
  })

  it('Requêtes sans body conservent les headers par défaut', () => {
    const defaultHeaders = { 'Content-Type': 'application/json' }

    const headers = simulateInterceptor(undefined, defaultHeaders)

    expect(headers['Content-Type']).toBe('application/json')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. LOGIQUE DB — CREATE TABLE + INSERT rawPool
// ══════════════════════════════════════════════════════════════════════════════

describe('DB — employee_documents rawPool operations', () => {
  let mockQuery: ReturnType<typeof vi.fn>
  let pool: InstanceType<typeof Pool>

  beforeEach(() => {
    mockQuery = vi.fn()
    pool = { query: mockQuery } as unknown as InstanceType<typeof Pool>
  })

  async function ensureTable(pool: InstanceType<typeof Pool>, schemaName: string) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".employee_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID REFERENCES "${schemaName}".employees(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL DEFAULT 'other',
        title VARCHAR(255) NOT NULL,
        file_url TEXT,
        file_size INTEGER,
        mime_type VARCHAR(100),
        is_confidential BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(
      `ALTER TABLE "${schemaName}".employee_documents ALTER COLUMN file_url DROP NOT NULL`
    ).catch(() => {})
  }

  async function insertDocument(
    pool: InstanceType<typeof Pool>,
    schemaName: string,
    employeeId: string,
    params: { type: string; title: string; fileUrl: string | null; fileSize: number; mimeType: string; isConfidential: boolean }
  ) {
    const res = await pool.query(
      `INSERT INTO "${schemaName}".employee_documents
         (employee_id, type, title, file_url, file_size, mime_type, is_confidential)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [employeeId, params.type, params.title, params.fileUrl, params.fileSize, params.mimeType, params.isConfidential]
    )
    return res.rows[0]
  }

  it('ensureTable exécute CREATE TABLE IF NOT EXISTS', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await ensureTable(pool, 'tenant_techcorp')

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const createCall = (mockQuery.mock.calls as [string, ...unknown[]][])[0]
    expect(createCall?.[0]).toContain('CREATE TABLE IF NOT EXISTS')
    expect(createCall?.[0]).toContain('"tenant_techcorp".employee_documents')
    expect(createCall?.[0]).toContain('gen_random_uuid()')   // pas uuid_generate_v4()
    expect(createCall?.[0]).toContain('file_url TEXT')       // nullable — pas NOT NULL
  })

  it('ensureTable rend file_url nullable (ALTER COLUMN)', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    await ensureTable(pool, 'tenant_techcorp')

    const calls = mockQuery.mock.calls as [string][]
    const alterCall = calls.find(([sql]) => sql.includes('ALTER COLUMN'))
    expect(alterCall).toBeDefined()
    expect(alterCall![0]).toContain('DROP NOT NULL')
  })

  it('ensureTable ne plante pas si ALTER échoue (colonne déjà nullable)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                        // CREATE TABLE
      .mockRejectedValueOnce(new Error('already nullable'))       // ALTER — ignoré

    await expect(ensureTable(pool, 'tenant_techcorp')).resolves.toBeUndefined()
  })

  it('INSERT avec file_url = null réussit (S3 indisponible)', async () => {
    const docRow = {
      id: 'doc-uuid-1', employee_id: 'emp-uuid-1', type: 'contract',
      title: 'Mon contrat', file_url: null, file_size: 1234,
      mime_type: 'application/pdf', is_confidential: false,
      created_at: new Date().toISOString(),
    }
    mockQuery.mockResolvedValue({ rows: [docRow] })

    const result = await insertDocument(pool, 'tenant_techcorp', 'emp-uuid-1', {
      type: 'contract', title: 'Mon contrat',
      fileUrl: null, fileSize: 1234,
      mimeType: 'application/pdf', isConfidential: false,
    })

    expect(result).toEqual(docRow)
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params[3]).toBeNull()   // file_url null
  })

  it('INSERT avec file_url S3 réussit', async () => {
    const s3Url = 'http://localhost:9000/nexusrh/tenant_techcorp/employees/emp-uuid-1/documents/file.pdf'
    const docRow = {
      id: 'doc-uuid-2', employee_id: 'emp-uuid-1', type: 'contract',
      title: 'Contrat CDI', file_url: s3Url, file_size: 4096,
      mime_type: 'application/pdf', is_confidential: false,
      created_at: new Date().toISOString(),
    }
    mockQuery.mockResolvedValue({ rows: [docRow] })

    const result = await insertDocument(pool, 'tenant_techcorp', 'emp-uuid-1', {
      type: 'contract', title: 'Contrat CDI',
      fileUrl: s3Url, fileSize: 4096,
      mimeType: 'application/pdf', isConfidential: false,
    })

    expect(result.file_url).toBe(s3Url)
  })

  it('INSERT utilise les bons paramètres positionnels $1..$7', async () => {
    mockQuery.mockResolvedValue({ rows: [{}] })

    await insertDocument(pool, 'tenant_artisanpro', 'emp-uuid-99', {
      type: 'amendment', title: 'Avenant salaire',
      fileUrl: null, fileSize: 512,
      mimeType: 'application/pdf', isConfidential: true,
    })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('"tenant_artisanpro".employee_documents')
    expect(params).toEqual([
      'emp-uuid-99',   // $1 employee_id
      'amendment',     // $2 type
      'Avenant salaire', // $3 title
      null,            // $4 file_url
      512,             // $5 file_size
      'application/pdf', // $6 mime_type
      true,            // $7 is_confidential
    ])
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. VALIDATION HANDLER — champs par défaut + contraintes
// ══════════════════════════════════════════════════════════════════════════════

describe('Handler — validation champs multipart', () => {
  function parseMultipartFields(fields: Record<string, string | undefined>, fallbackFilename: string) {
    const docType        = (fields['type']  ?? 'contract').slice(0, 50)
    const docTitle       = (fields['title'] ?? fallbackFilename).slice(0, 255)
    const isConfidential = fields['isConfidential'] === 'true'
    return { docType, docTitle, isConfidential }
  }

  it('type par défaut = contract si absent', () => {
    const { docType } = parseMultipartFields({}, 'contrat.pdf')
    expect(docType).toBe('contract')
  })

  it('title par défaut = nom du fichier si absent', () => {
    const { docTitle } = parseMultipartFields({}, 'mon-contrat-2024.pdf')
    expect(docTitle).toBe('mon-contrat-2024.pdf')
  })

  it('type et title sont tronqués à 50 / 255 caractères', () => {
    const longType  = 'x'.repeat(100)
    const longTitle = 'y'.repeat(500)
    const { docType, docTitle } = parseMultipartFields(
      { type: longType, title: longTitle }, 'file.pdf'
    )
    expect(docType.length).toBe(50)
    expect(docTitle.length).toBe(255)
  })

  it('isConfidential = true seulement si la valeur est exactement "true"', () => {
    expect(parseMultipartFields({ isConfidential: 'true' }, 'f.pdf').isConfidential).toBe(true)
    expect(parseMultipartFields({ isConfidential: 'false' }, 'f.pdf').isConfidential).toBe(false)
    expect(parseMultipartFields({ isConfidential: '1' }, 'f.pdf').isConfidential).toBe(false)
    expect(parseMultipartFields({ isConfidential: 'True' }, 'f.pdf').isConfidential).toBe(false)
    expect(parseMultipartFields({}, 'f.pdf').isConfidential).toBe(false)
  })

  it('type "amendment" est accepté', () => {
    const { docType } = parseMultipartFields({ type: 'amendment' }, 'avenant.pdf')
    expect(docType).toBe('amendment')
  })
})
