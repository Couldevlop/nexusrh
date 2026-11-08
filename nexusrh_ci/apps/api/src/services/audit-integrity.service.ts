/**
 * Piste d'audit opposable — contrôle d'intégrité et export probant.
 *
 * Le chaînage (cf. `db/audit-chain.ts`) rend une falsification DÉTECTABLE ;
 * encore faut-il pouvoir la détecter et le prouver à un tiers. Ce service
 * fournit les deux gestes :
 *
 *  - `verifyChain` RECALCULE la chaîne entrée par entrée et désigne la première
 *    rupture. Il ne fait pas confiance aux empreintes stockées : il les
 *    recompose depuis le contenu, exactement comme un contrôleur extérieur le
 *    ferait. Une empreinte juste sur un contenu modifié est donc impossible à
 *    obtenir sans recalculer toute la suite.
 *  - `exportAudit` produit le journal ET un manifeste : période, nombre
 *    d'entrées, première et dernière empreintes, empreinte du fichier exporté,
 *    et — si une clé de scellement est configurée — un sceau HMAC-SHA256.
 *
 * Pourquoi le sceau : l'empreinte seule prouve qu'un fichier n'a pas changé
 * depuis… son calcul. Elle ne dit pas qui l'a calculée. Le HMAC lie l'export à
 * un secret détenu par l'exploitant, donc à l'organisation, et non au porteur
 * du fichier. Sans clé configurée, l'export reste utile mais le manifeste le
 * DIT (`sealed: false`) : un export qui se présenterait comme scellé sans
 * l'être serait pire que pas de sceau du tout.
 *
 * Le secret vient de l'environnement (`AUDIT_SIGNING_KEY`), jamais du code ni
 * de la base : un sceau dont la clé est stockée à côté des données ne vaut
 * rien, puisque qui modifie les données peut resceller.
 */
import { createHash, createHmac } from 'node:crypto'
import { assertValidSchemaName } from '../utils/schema-name.js'

/** Entrée telle qu'elle est relue pour le contrôle et l'export. */
export interface AuditRow extends Record<string, unknown> {
  seq: string
  id: string
  user_id: string | null
  action: string
  entity: string
  entity_id: string | null
  changes: unknown
  ip_address: string | null
  user_agent: string | null
  created_at: Date | string
  prev_hash: string | null
  entry_hash: string | null
}

interface Db {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>
}

const SEP = '\u001f'

/** Horodatage au format exact utilisé par le trigger SQL (UTC, microsecondes). */
export function chainTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  // `toISOString()` s'arrête aux millisecondes : la base, elle, stocke des
  // microsecondes. On repart donc de la valeur textuelle quand on en a une,
  // pour recalculer EXACTEMENT ce que le trigger a calculé.
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(value)
    if (m) {
      const frac = (m[3] ?? '.').slice(1).padEnd(6, '0').slice(0, 6)
      return `${m[1]}T${m[2]}.${frac}Z`
    }
  }
  return d.toISOString().replace('Z', '000Z').replace(/\.(\d{6})\d*Z$/, '.$1Z')
}

/**
 * Empreinte d'une entrée : même composition que la fonction SQL
 * `audit_log_chain_digest`. Les deux implémentations DOIVENT coïncider — c'est
 * ce qu'un test vérifie, car une divergence rendrait tout contrôle faussement
 * négatif (et donc la piste inutilisable comme preuve).
 */
export function entryDigest(row: Pick<AuditRow,
  'id' | 'user_id' | 'action' | 'entity' | 'entity_id' | 'changes' | 'ip_address' | 'created_at'
>, prevHash: string | null): string {
  const changes = typeof row.changes === 'string'
    ? row.changes
    : JSON.stringify(row.changes ?? {})
  const parts = [
    prevHash ?? '',
    row.id,
    row.user_id ?? '',
    row.action,
    row.entity,
    row.entity_id ?? '',
    changes || '{}',
    row.ip_address ?? '',
    chainTimestamp(row.created_at),
  ]
  return createHash('sha256').update(parts.join(SEP), 'utf8').digest('hex')
}

export interface ChainVerdict {
  /** Entrées contrôlées. */
  checked: number
  /** La chaîne est-elle intacte de bout en bout ? */
  intact: boolean
  /** Première rupture constatée, s'il y en a une. */
  brokenAt: { seq: string; id: string; reason: 'hash_mismatch' | 'broken_link' | 'missing_hash' } | null
  /** Empreinte de la dernière entrée : à conserver hors de la base. */
  lastHash: string | null
  /** Entrées de purge rencontrées : elles expliquent les trous légitimes. */
  purgeMarkers: number
}

/**
 * Recalcule la chaîne et désigne la première rupture.
 *
 * Trois formes de rupture, distinguées parce qu'elles ne racontent pas la même
 * histoire : une empreinte qui ne correspond plus au contenu (`hash_mismatch` →
 * entrée modifiée), un maillon qui ne pointe pas sur l'entrée précédente
 * (`broken_link` → entrée supprimée ou insérée), une empreinte absente
 * (`missing_hash` → entrée écrite avant la mise en place du chaînage, ou
 * trigger désactivé).
 *
 * Les entrées ANTÉRIEURES au chaînage n'ont pas d'empreinte : elles sont
 * ignorées sans verdict d'altération, et le contrôle commence à la première
 * entrée chaînée. Les traiter comme des ruptures ferait crier au loup sur
 * chaque base existante.
 */
export async function verifyChain(
  schema: string, db: Db, opts: { limit?: number } = {},
): Promise<ChainVerdict> {
  assertValidSchemaName(schema)
  const limit = Math.min(Math.max(opts.limit ?? 50_000, 1), 500_000)
  const res = await db.query<AuditRow>(
    `SELECT seq::text AS seq, id::text AS id, user_id::text AS user_id, action, entity,
            entity_id::text AS entity_id,
            -- changes::text et NON l'objet : le trigger a haché le rendu
            -- textuel de PostgreSQL (clés réordonnées, espace après le deux-points).
            -- JSON.stringify produirait une autre chaîne, donc une autre
            -- empreinte, et le contrôle crierait au loup sur une piste intacte.
            changes::text AS changes, ip_address, user_agent,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            prev_hash, entry_hash
       FROM "${schema}".audit_log
      -- Qualifié À DESSEIN : un ORDER BY seq nu se résoudrait sur le NOM DE SORTIE,
      -- donc sur seq::text, et trierait 1, 10, 100, …, 99 — chaîne remontée
      -- dans le désordre, rupture annoncée à tort. Une référence qualifiée ne
      -- peut pas coïncider avec un alias de sortie.
      ORDER BY "${schema}".audit_log.seq ASC
      LIMIT $1`,
    [limit],
  )

  let checked = 0
  let purgeMarkers = 0
  let previous: AuditRow | null = null
  let brokenAt: ChainVerdict['brokenAt'] = null
  let lastHash: string | null = null

  for (const row of res.rows) {
    if (row.action === 'audit.purged') purgeMarkers++
    if (!row.entry_hash) {
      // Entrée d'avant le chaînage : rien à vérifier, et ce n'est pas une
      // altération. On ne la prend pas comme maillon précédent.
      continue
    }
    const expectedPrev = previous?.entry_hash ?? null
    if (previous && row.prev_hash !== expectedPrev) {
      brokenAt ??= { seq: row.seq, id: row.id, reason: 'broken_link' }
    } else if (entryDigest(row, row.prev_hash) !== row.entry_hash) {
      brokenAt ??= { seq: row.seq, id: row.id, reason: 'hash_mismatch' }
    }
    checked++
    previous = row
    lastHash = row.entry_hash
  }

  return { checked, intact: brokenAt === null, brokenAt, lastHash, purgeMarkers }
}

/** Échappement CSV : guillemets doublés, champ cité dès qu'il peut casser la ligne. */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  return /[",;\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

export const AUDIT_CSV_HEADER = [
  'seq', 'id', 'created_at', 'user_id', 'action', 'entity', 'entity_id',
  'ip_address', 'user_agent', 'changes', 'prev_hash', 'entry_hash',
] as const

export interface AuditExport {
  csv: string
  manifest: {
    schema: string
    generatedAt: string
    entries: number
    from: string | null
    to: string | null
    firstHash: string | null
    lastHash: string | null
    /** Empreinte du CSV exporté : ce qu'on vérifie sur le fichier reçu. */
    sha256: string
    /** Sceau HMAC-SHA256 du CSV, si une clé de scellement est configurée. */
    seal: string | null
    sealed: boolean
    chain: ChainVerdict
  }
}

/**
 * Journal exporté en CSV + manifeste.
 *
 * Le CSV embarque les empreintes de chaque entrée : le destinataire peut donc
 * refaire le contrôle lui-même, sans accès à la base — c'est ce qui distingue
 * un export probant d'une simple extraction.
 *
 * `signingKey` vient de l'appelant (qui la lit de l'environnement) : ce service
 * ne lit aucune variable, pour rester testable et pour qu'un secret ne soit
 * jamais capté implicitement.
 */
export async function exportAudit(
  schema: string, db: Db,
  opts: { from?: string | null; to?: string | null; limit?: number; signingKey?: string | null } = {},
): Promise<AuditExport> {
  assertValidSchemaName(schema)
  const limit = Math.min(Math.max(opts.limit ?? 100_000, 1), 500_000)
  const params: unknown[] = []
  const where: string[] = []
  if (opts.from) { params.push(opts.from); where.push(`created_at >= $${params.length}::timestamptz`) }
  if (opts.to)   { params.push(opts.to);   where.push(`created_at <= $${params.length}::timestamptz`) }
  params.push(limit)

  const res = await db.query<AuditRow>(
    `SELECT seq::text AS seq, id::text AS id, user_id::text AS user_id, action, entity,
            entity_id::text AS entity_id,
            -- changes::text et NON l'objet : le trigger a haché le rendu
            -- textuel de PostgreSQL (clés réordonnées, espace après le deux-points).
            -- JSON.stringify produirait une autre chaîne, donc une autre
            -- empreinte, et le contrôle crierait au loup sur une piste intacte.
            changes::text AS changes, ip_address, user_agent,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            prev_hash, entry_hash
       FROM "${schema}".audit_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      -- Qualifié À DESSEIN : un ORDER BY seq nu se résoudrait sur le NOM DE SORTIE,
      -- donc sur seq::text, et trierait 1, 10, 100, …, 99 — chaîne remontée
      -- dans le désordre, rupture annoncée à tort. Une référence qualifiée ne
      -- peut pas coïncider avec un alias de sortie.
      ORDER BY "${schema}".audit_log.seq ASC
      LIMIT $${params.length}`,
    params,
  )

  const lines = [AUDIT_CSV_HEADER.join(';')]
  for (const r of res.rows) {
    lines.push([
      r.seq, r.id, r.created_at, r.user_id, r.action, r.entity, r.entity_id,
      r.ip_address, r.user_agent,
      typeof r.changes === 'string' ? r.changes : JSON.stringify(r.changes ?? {}),
      r.prev_hash, r.entry_hash,
    ].map(csvCell).join(';'))
  }
  // CRLF : le fichier s'ouvre tel quel dans Excel, qui reste l'outil du
  // destinataire. Le séparateur ';' suit la même raison (locale FR).
  const csv = lines.join('\r\n') + '\r\n'

  const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex')
  const key = (opts.signingKey ?? '').trim()
  const seal = key ? createHmac('sha256', key).update(csv, 'utf8').digest('hex') : null

  const first = res.rows[0]
  const last = res.rows[res.rows.length - 1]
  return {
    csv,
    manifest: {
      schema,
      generatedAt: new Date().toISOString(),
      entries: res.rows.length,
      from: first ? String(first.created_at) : null,
      to:   last  ? String(last.created_at)  : null,
      firstHash: first?.entry_hash ?? null,
      lastHash:  last?.entry_hash  ?? null,
      sha256,
      seal,
      sealed: seal !== null,
      chain: await verifyChain(schema, db, { limit }),
    },
  }
}

/**
 * Applique la rétention : supprime les entrées plus anciennes que `keepDays` en
 * laissant un marqueur. `keepDays <= 0` ne supprime rien.
 */
export async function purgeAudit(
  schema: string, db: Db, keepDays: number,
): Promise<{ purged: number; boundary: string | null }> {
  assertValidSchemaName(schema)
  const res = await db.query<{ purged: string; boundary: string | null }>(
    `SELECT purged::text AS purged, boundary FROM "${schema}".audit_log_purge($1)`,
    [Math.trunc(keepDays)],
  )
  const row = res.rows[0]
  return { purged: Number(row?.purged ?? 0), boundary: row?.boundary ?? null }
}
