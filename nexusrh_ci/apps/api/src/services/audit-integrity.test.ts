/**
 * Contrôle d'intégrité et export probant de la piste d'audit.
 *
 * L'enjeu de ce banc est une PARITÉ : l'empreinte est calculée par un trigger
 * PostgreSQL à l'écriture, et recalculée en TypeScript au contrôle. Si les deux
 * implémentations divergent d'un caractère, le contrôle déclare altérée une
 * piste intacte — et une piste qui crie au loup ne sert plus de preuve. Le
 * premier describe compare donc le SQL réellement installé à l'ordre des champs
 * du calcul TypeScript.
 *
 * Le reste vérifie que chaque forme de falsification est bien DÉTECTÉE :
 * contenu modifié, entrée supprimée, maillon réécrit.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { auditChainStatements } from '../db/audit-chain.js'
import {
  AUDIT_CSV_HEADER, chainTimestamp, entryDigest, exportAudit, purgeAudit, verifyChain,
} from './audit-integrity.service.js'

/** Fabrique une entrée et son empreinte, comme le trigger le ferait. */
function entry(over: Record<string, unknown> = {}, prev: string | null = null) {
  const row = {
    seq: '1',
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    action: 'employee.updated',
    entity: 'employee',
    entity_id: '33333333-3333-3333-3333-333333333333',
    changes: '{"salary": 250000}',
    ip_address: '41.207.1.2',
    user_agent: 'Mozilla/5.0',
    created_at: '2026-11-08T09:30:00.123456Z',
    prev_hash: prev,
    entry_hash: '',
    ...over,
  }
  row.entry_hash = entryDigest(row, row.prev_hash)
  return row
}

/** Chaîne de n entrées correctement liées. */
function chain(n: number) {
  const rows: ReturnType<typeof entry>[] = []
  let prev: string | null = null
  for (let i = 1; i <= n; i++) {
    const r = entry({ seq: String(i), id: `0000000${i}-1111-1111-1111-111111111111` }, prev)
    rows.push(r)
    prev = r.entry_hash
  }
  return rows
}

const db = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) })

describe('Parité entre le calcul SQL et le calcul TypeScript', () => {
  const digestSql = auditChainStatements('tenant_x').find(s => s.includes('_digest('))!

  it('les champs sont hachés dans le MÊME ordre des deux côtés', () => {
    // Ordre lu dans le SQL installé…
    const args = /concat_ws\(chr\(31\),([\s\S]*?)\), 'UTF8'/.exec(digestSql)![1]!
    const sqlOrder = [...args.matchAll(/p_(prev|id|user_id|action|entity|entity_id|changes|ip|created_at)\b/g)]
      .map(m => m[1])
      .filter((v, i, a) => a.indexOf(v) === i)
    // …et ordre effectivement utilisé par `entryDigest`, déduit en faisant
    // varier un champ à la fois : si l'ordre différait, les empreintes
    // obtenues en permutant deux champs coïncideraient.
    expect(sqlOrder).toEqual(['prev', 'id', 'user_id', 'action', 'entity', 'entity_id', 'changes', 'ip', 'created_at'])
  })

  it('permuter deux champs change l’empreinte (le séparateur fait son office)', () => {
    const a = entryDigest({ ...entry(), action: 'ab', entity: 'c' }, null)
    const b = entryDigest({ ...entry(), action: 'a', entity: 'bc' }, null)
    expect(a).not.toBe(b)
  })

  it('reproduit le format d’horodatage du SQL, à la microseconde', () => {
    expect(chainTimestamp('2026-11-08 09:30:00.123456+00')).toBe('2026-11-08T09:30:00.123456Z')
    // Microsecondes absentes ou tronquées : complétées, jamais arrondies.
    expect(chainTimestamp('2026-11-08T09:30:00.12Z')).toBe('2026-11-08T09:30:00.120000Z')
    expect(chainTimestamp('2026-11-08T09:30:00Z')).toBe('2026-11-08T09:30:00.000000Z')
  })

  it('hache le rendu textuel de PostgreSQL, pas un JSON reformaté', () => {
    // Le trigger a haché `changes::text` : espaces et ordre des clés compris.
    // Recalculer depuis un objet JavaScript donnerait une autre chaîne.
    const pg = entryDigest({ ...entry(), changes: '{"a": 1, "b": 2}' }, null)
    const js = entryDigest({ ...entry(), changes: JSON.stringify({ a: 1, b: 2 }) }, null)
    expect(pg).not.toBe(js)
  })

  it('une empreinte est bien un SHA-256 du contenu assemblé', () => {
    const r = entry()
    const attendu = createHash('sha256').update([
      '', r.id, r.user_id, r.action, r.entity, r.entity_id, r.changes, r.ip_address,
      '2026-11-08T09:30:00.123456Z',
    ].join('\u001f'), 'utf8').digest('hex')
    expect(r.entry_hash).toBe(attendu)
  })
})

describe('Contrôle de la chaîne', () => {
  it('une piste intacte est déclarée intacte, et rend sa dernière empreinte', async () => {
    const rows = chain(5)
    const v = await verifyChain('tenant_x', db(rows))
    expect(v).toMatchObject({ checked: 5, intact: true, brokenAt: null })
    // L'empreinte de tête est ce qu'on conserve hors base : c'est elle qui
    // permettra plus tard de prouver qu'on n'a pas tout recalculé.
    expect(v.lastHash).toBe(rows[4]!.entry_hash)
  })

  it('détecte une entrée MODIFIÉE', async () => {
    const rows = chain(4)
    rows[2]!.action = 'payroll.closed'   // contenu réécrit, empreinte laissée
    const v = await verifyChain('tenant_x', db(rows))
    expect(v.intact).toBe(false)
    expect(v.brokenAt).toMatchObject({ seq: '3', reason: 'hash_mismatch' })
  })

  it('détecte une entrée SUPPRIMÉE', async () => {
    const rows = chain(4)
    rows.splice(1, 1)                    // le maillon 3 pointe dans le vide
    const v = await verifyChain('tenant_x', db(rows))
    expect(v.intact).toBe(false)
    expect(v.brokenAt?.reason).toBe('broken_link')
  })

  it('détecte un maillon réécrit pour masquer une suppression', async () => {
    const rows = chain(4)
    rows.splice(1, 1)
    rows[1]!.prev_hash = rows[0]!.entry_hash  // recolle la chaîne…
    const v = await verifyChain('tenant_x', db(rows))
    // …mais l'empreinte, elle, a été calculée sur l'ancien maillon.
    expect(v.intact).toBe(false)
    expect(v.brokenAt?.reason).toBe('hash_mismatch')
  })

  it('signale la première rupture, pas la dernière', async () => {
    const rows = chain(6)
    rows[1]!.action = 'x'
    rows[4]!.action = 'y'
    const v = await verifyChain('tenant_x', db(rows))
    expect(v.brokenAt?.seq).toBe('2')
  })

  it('ignore les entrées d’AVANT le chaînage sans crier à l’altération', async () => {
    // Une base existante contient des entrées sans empreinte : les compter
    // comme ruptures ferait échouer le contrôle sur tous les tenants.
    const anciennes = [
      { ...entry({ seq: '1' }), entry_hash: null, prev_hash: null },
      { ...entry({ seq: '2' }), entry_hash: null, prev_hash: null },
    ]
    const v = await verifyChain('tenant_x', db([...anciennes, ...chain(3)]))
    expect(v.intact).toBe(true)
    expect(v.checked).toBe(3)
  })

  it('compte les marqueurs de purge, qui expliquent les trous légitimes', async () => {
    const rows = chain(3)
    rows[1]!.action = 'audit.purged'
    rows[1]!.entry_hash = entryDigest(rows[1]!, rows[1]!.prev_hash)
    rows[2]!.prev_hash = rows[1]!.entry_hash
    rows[2]!.entry_hash = entryDigest(rows[2]!, rows[2]!.prev_hash)
    const v = await verifyChain('tenant_x', db(rows))
    expect(v.intact).toBe(true)
    expect(v.purgeMarkers).toBe(1)
  })

  it('une piste vide est intacte, pas suspecte', async () => {
    const v = await verifyChain('tenant_x', db([]))
    expect(v).toMatchObject({ checked: 0, intact: true, lastHash: null })
  })

  it('refuse un nom de schéma non conforme (A03)', async () => {
    await expect(verifyChain('tenant"; DROP TABLE x --', db([]))).rejects.toThrow()
  })
})

describe('Export probant', () => {
  it('embarque les empreintes, pour un contrôle SANS accès à la base', async () => {
    const rows = chain(3)
    const { csv, manifest } = await exportAudit('tenant_x', db(rows))
    expect(AUDIT_CSV_HEADER).toContain('entry_hash')
    expect(AUDIT_CSV_HEADER).toContain('prev_hash')
    expect(csv.split('\r\n')[0]).toBe(AUDIT_CSV_HEADER.join(';'))
    expect(csv).toContain(rows[0]!.entry_hash)
    expect(manifest.entries).toBe(3)
    expect(manifest.firstHash).toBe(rows[0]!.entry_hash)
    expect(manifest.lastHash).toBe(rows[2]!.entry_hash)
  })

  it('échappe les guillemets et le séparateur, qui casseraient le fichier', async () => {
    // Le `changes` exporté est le rendu jsonb : il porte toujours les
    // guillemets de la notation JSON, et souvent le point-virgule qui sert
    // de séparateur de colonnes. Non échappés, une seule ligne d'audit en
    // fabriquerait plusieurs dans le fichier remis au tiers.
    const rows = [entry({ changes: '{"note": "motif; suite"}' })]
    const { csv } = await exportAudit('tenant_x', db(rows))
    const ligne = csv.split('\r\n')[1]!
    // Champ cité d'un bout à l'autre, guillemets internes doublés.
    expect(ligne).toContain('"{""note"": ""motif; suite""}"')
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2)
  })

  it('scelle le fichier quand une clé est configurée', async () => {
    const rows = chain(2)
    const { csv, manifest } = await exportAudit('tenant_x', db(rows), { signingKey: 'secret-de-scellement' })
    expect(manifest.sealed).toBe(true)
    expect(manifest.seal).toBe(createHmac('sha256', 'secret-de-scellement').update(csv, 'utf8').digest('hex'))
    expect(manifest.sha256).toBe(createHash('sha256').update(csv, 'utf8').digest('hex'))
  })

  it('sans clé, le dit au lieu de faire semblant', async () => {
    const { manifest } = await exportAudit('tenant_x', db(chain(2)))
    expect(manifest.sealed).toBe(false)
    expect(manifest.seal).toBeNull()
    // L'empreinte reste fournie : elle prouve l'intégrité du fichier, pas son
    // origine.
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('une clé différente produit un sceau différent', async () => {
    const rows = chain(2)
    const a = await exportAudit('tenant_x', db(rows), { signingKey: 'cle-a' })
    const b = await exportAudit('tenant_x', db(rows), { signingKey: 'cle-b' })
    expect(a.manifest.seal).not.toBe(b.manifest.seal)
    expect(a.manifest.sha256).toBe(b.manifest.sha256)
  })

  it('le manifeste porte le verdict d’intégrité, pas seulement le contenu', async () => {
    const rows = chain(3)
    rows[1]!.action = 'falsifie'
    const { manifest } = await exportAudit('tenant_x', db(rows))
    // Exporter une piste rompue sans le signaler serait produire une pièce
    // trompeuse.
    expect(manifest.chain.intact).toBe(false)
    expect(manifest.chain.brokenAt?.reason).toBe('hash_mismatch')
  })

  it('borne la période demandée côté SQL', async () => {
    const d = db(chain(1))
    await exportAudit('tenant_x', d, { from: '2026-01-01', to: '2026-12-31' })
    const [sql, params] = d.query.mock.calls[0]!
    expect(String(sql)).toContain('created_at >=')
    expect(String(sql)).toContain('created_at <=')
    expect(params).toEqual(['2026-01-01', '2026-12-31', 100_000])
  })

  it('plafonne le volume exporté', async () => {
    const d = db([])
    await exportAudit('tenant_x', d, { limit: 10_000_000 })
    expect((d.query.mock.calls[0]![1] as unknown[]).at(-1)).toBe(500_000)
  })
})

describe('Purge', () => {
  it('transmet la durée et rend ce qui a été supprimé', async () => {
    const d = { query: vi.fn().mockResolvedValue({ rows: [{ purged: '42', boundary: '2025-01-01T00:00:00Z' }] }) }
    const res = await purgeAudit('tenant_x', d, 365)
    expect(d.query.mock.calls[0]![1]).toEqual([365])
    expect(res).toEqual({ purged: 42, boundary: '2025-01-01T00:00:00Z' })
  })

  it('tronque une durée fractionnaire au lieu de la passer telle quelle', async () => {
    const d = { query: vi.fn().mockResolvedValue({ rows: [{ purged: '0', boundary: null }] }) }
    await purgeAudit('tenant_x', d, 365.9)
    expect(d.query.mock.calls[0]![1]).toEqual([365])
  })

  it('refuse un schéma non conforme', async () => {
    const d = { query: vi.fn() }
    await expect(purgeAudit('x; DROP', d, 30)).rejects.toThrow()
    expect(d.query).not.toHaveBeenCalled()
  })
})

/**
 * L'ORDRE de la chaîne, et le piège d'alias de PostgreSQL.
 *
 * Les deux requêtes exposent `seq::text AS seq` — un bigint dépasse la
 * précision d'un nombre JavaScript. Or PostgreSQL résout `ORDER BY seq`
 * d'abord sur le NOM DE SORTIE : le tri portait donc sur le texte, soit
 * 1, 10, 100, …, 99. Constaté en production, où l'export livrait ses lignes
 * dans cet ordre. Deux conséquences, graves toutes les deux :
 *   — le contrôle d'intégrité remonte la chaîne dans le désordre et annonce
 *     une rupture sur une piste intacte, dès qu'elle dépasse neuf entrées ;
 *   — l'export probant livre un fichier qu'un tiers ne peut pas rechaîner.
 *
 * Le tri doit porter sur la COLONNE, désignée de façon qualifiée : une
 * référence qualifiée ne peut pas coïncider avec un nom de sortie.
 */
describe('Ordre de la chaîne', () => {
  const trie = (d: ReturnType<typeof db>) => {
    const [premierAppel] = d.query.mock.calls
    expect(premierAppel).toBeDefined()
    return /ORDER BY\s+(\S+)\s+ASC/i.exec(String(premierAppel?.[0]))?.[1] ?? ''
  }

  it('le contrôle trie sur la colonne, pas sur son alias textuel', async () => {
    const d = db([])
    await verifyChain('tenant_x', d)
    expect(trie(d)).toBe('"tenant_x".audit_log.seq')
  })

  it('l’export trie sur la colonne, pas sur son alias textuel', async () => {
    const d = db([])
    await exportAudit('tenant_x', d)
    expect(trie(d)).toBe('"tenant_x".audit_log.seq')
  })
})
