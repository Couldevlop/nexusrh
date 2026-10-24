/**
 * Invariant : toute colonne lue via un alias de table tenant (`a.col` avec
 * `FROM "${schema}".absences a`) existe dans le schéma réellement créé
 * (provisioning + migrations).
 *
 * Les tests de routes simulent la base (mocks pg) : une colonne inexistante y
 * passe au vert alors que Postgres la rejette en production. Ce test lit le
 * DDL et le SQL sources comme du texte — aucune base, aucun mock.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname)
const DDL_FILES = ['db/provisioning.ts', 'utils/schema-migrations.ts']

// Préfixe de table tenant tel qu'écrit dans le code : ${s}. ou "${schema}". etc.
const TENANT = String.raw`"?\$\{\w+\}"?\.`

function tenantSchemaColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  const add = (t: string, c: string) => {
    if (!tables.has(t)) tables.set(t, new Set())
    tables.get(t)!.add(c.toLowerCase())
  }
  for (const f of DDL_FILES) {
    const txt = readFileSync(join(SRC, f), 'utf-8')
    const create = new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${TENANT}"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)`, 'g')
    for (const m of txt.matchAll(create)) {
      for (const line of m[2]!.split('\n')) {
        const col = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(line)
        if (col && !/^(primary|unique|constraint|foreign|check)$/i.test(col[1]!)) add(m[1]!, col[1]!)
      }
    }
    const alter = new RegExp(String.raw`ALTER TABLE ${TENANT}"?(\w+)"?\s+ADD COLUMN IF NOT EXISTS\s+"?(\w+)"?`, 'g')
    for (const m of txt.matchAll(alter)) add(m[1]!, m[2]!)
  }
  return tables
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : []
  })
}

const SQL_KEYWORDS = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'full', 'cross', 'group',
  'order', 'limit', 'set', 'using', 'returning', 'and', 'or', 'as', 'union', 'having', 'natural', 'lateral', 'values', 'for'])

/** Références `alias.colonne` dont la colonne n'existe pas dans la table de l'alias. */
function unknownColumns(tables: Map<string, Set<string>>): string[] {
  const issues: string[] = []
  for (const file of sourceFiles(join(SRC, 'modules')).concat(sourceFiles(join(SRC, 'services')))) {
    const txt = readFileSync(file, 'utf-8')
    for (const lit of txt.matchAll(/`([^`]*)`/g)) {
      const sql = lit[1]!
      if (!/\b(select|update|insert|delete)\b/i.test(sql)) continue
      const aliases = new Map<string, string>()
      const from = new RegExp(String.raw`(?:FROM|JOIN)\s+${TENANT}"?(\w+)"?(?:\s+(?:AS\s+)?(\w+))?`, 'gi')
      for (const m of sql.matchAll(from)) {
        const alias = m[2]
        if (alias && !SQL_KEYWORDS.has(alias.toLowerCase())) aliases.set(alias, m[1]!)
      }
      for (const [alias, table] of aliases) {
        const cols = tables.get(table)
        if (!cols) continue // table créée ailleurs (module lazy) : hors périmètre
        for (const ref of sql.matchAll(new RegExp(String.raw`(?<![\w.$])${alias}\.([a-z_][a-z0-9_]*)\b`, 'g'))) {
          const col = ref[1]!.toLowerCase()
          if (!cols.has(col)) issues.push(`${relative(SRC, file)} : ${alias}.${col} (table ${table})`)
        }
      }
    }
  }
  return [...new Set(issues)].sort()
}

describe('SQL ↔ schéma tenant réel', () => {
  it('le DDL est bien lu (garde-fou du test lui-même)', () => {
    const tables = tenantSchemaColumns()
    expect(tables.get('absences')).toContain('days')
    expect(tables.get('absence_types')).toContain('code')
    expect(tables.get('absences')).toContain('validation_level') // ajoutée par migration
    expect(tables.get('absence_types')?.has('slug')).toBe(false)
  })

  it('aucune colonne inexistante lue via un alias de table tenant', () => {
    expect(unknownColumns(tenantSchemaColumns())).toEqual([])
  })
})
