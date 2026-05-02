/**
 * Script de diagnostic pour l'upload de documents collaborateur
 * Usage : tsx src/scripts/test-document-upload.ts
 *
 * Teste :
 *  1. Connexion DB
 *  2. Création/validation de la table employee_documents
 *  3. INSERT direct
 *  4. Login HTTP → token JWT
 *  5. POST /employees/:id/documents (multipart)
 */
import { Pool } from 'pg'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import FormData from 'form-data'
import http from 'http'
import https from 'https'

// Try multiple locations: cwd-relative (pnpm run) then script-relative
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') })
dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../../../../.env') })

const DB_URL  = process.env['DATABASE_URL']!
const API_URL = (process.env['API_URL'] ?? 'http://localhost:4000').replace('localhost', '127.0.0.1')

const pool = new Pool({ connectionString: DB_URL })

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function httpRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
        method: options.method, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function log(label: string, ok: boolean, detail?: string) {
  const icon = ok ? '✅' : '❌'
  console.log(`${icon} ${label}${detail ? `\n   ${detail}` : ''}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log(' NexusRH — Diagnostic upload document')
  console.log('═══════════════════════════════════════════\n')

  // ── 1. Connexion DB ──────────────────────────────────────────────────────
  let schemaName = ''
  let employeeId = ''
  try {
    const res = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM platform.tenants WHERE slug = 'techcorp' LIMIT 1`,
    )
    schemaName = res.rows[0]?.schema_name ?? ''
    log('Connexion DB', !!schemaName, schemaName ? `schema = ${schemaName}` : 'tenant techcorp introuvable')
    if (!schemaName) { await pool.end(); return }
  } catch (err) {
    log('Connexion DB', false, String(err))
    await pool.end(); return
  }

  // ── 2. Récupérer un employé de test ──────────────────────────────────────
  try {
    const res = await pool.query<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM "${schemaName}".employees LIMIT 1`,
    )
    employeeId = res.rows[0]?.id ?? ''
    log('Employé de test', !!employeeId,
      employeeId ? `id=${employeeId} (${res.rows[0]?.first_name})` : 'aucun employé trouvé')
    if (!employeeId) { await pool.end(); return }
  } catch (err) {
    log('Récupérer employé', false, String(err))
    await pool.end(); return
  }

  // ── 3. Vérifier / créer table employee_documents ─────────────────────────
  try {
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
        signed_by_employee BOOLEAN DEFAULT false,
        signed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(
      `ALTER TABLE "${schemaName}".employee_documents ALTER COLUMN file_url DROP NOT NULL`
    ).catch(() => {})
    log('Table employee_documents', true, 'créée ou déjà existante')
  } catch (err) {
    log('Table employee_documents', false, String(err))
    await pool.end(); return
  }

  // ── 4. INSERT direct ─────────────────────────────────────────────────────
  let testDocId = ''
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "${schemaName}".employee_documents
         (employee_id, type, title, file_url, file_size, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [employeeId, 'contract', 'Test document', null, 1234, 'application/pdf'],
    )
    testDocId = res.rows[0]?.id ?? ''
    log('INSERT direct employee_documents', !!testDocId, `id=${testDocId}`)
    // Cleanup
    if (testDocId) await pool.query(`DELETE FROM "${schemaName}".employee_documents WHERE id = $1`, [testDocId])
  } catch (err) {
    log('INSERT direct employee_documents', false, String(err))
    await pool.end(); return
  }

  // ── 5. Login HTTP ─────────────────────────────────────────────────────────
  let token = ''
  try {
    const res = await httpRequest(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@techcorp.com', password: 'Admin1234!' }),
    })
    const json = JSON.parse(res.body) as { token?: string; accessToken?: string; data?: { token?: string; accessToken?: string } }
    token = json.accessToken ?? json.token ?? json.data?.accessToken ?? json.data?.token ?? ''
    log('Login HTTP', !!token, token ? 'token OK' : `status=${res.status} body=${res.body.slice(0, 200)}`)
    if (!token) { await pool.end(); return }
  } catch (err) {
    log('Login HTTP', false, String(err))
    await pool.end(); return
  }

  // ── 6. POST /employees/:id/documents (multipart) ─────────────────────────
  try {
    const form = new FormData()
    form.append('type', 'contract')
    form.append('title', 'Test contrat PDF')
    form.append('file', Buffer.from('%PDF-1.4 test'), {
      filename: 'test-contract.pdf',
      contentType: 'application/pdf',
    })

    const formHeaders = form.getHeaders() as Record<string, string>

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(`${API_URL}/employees/${employeeId}/documents`)
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: { ...formHeaders, Authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        },
      )
      req.on('error', reject)
      form.pipe(req)
    })

    let parsed2: { data?: unknown; warning?: string; error?: string; detail?: string } = {}
    try { parsed2 = JSON.parse(result.body) } catch { /* not JSON */ }
    const ok = result.status === 201

    log(
      `POST /employees/${employeeId}/documents`,
      ok,
      ok
        ? `status=201${parsed2.warning ? '\n   ⚠️  ' + parsed2.warning : ''}`
        : `status=${result.status}\n   error : "${parsed2.error ?? '(none)'}"\n   detail: "${parsed2.detail ?? '(none)'}"\n   raw   : ${result.body.slice(0, 500)}`,
    )
  } catch (err) {
    log('POST /documents HTTP', false, `Erreur : ${String(err)}`)
  }

  console.log('\n═══════════════════════════════════════════')
  await pool.end()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
