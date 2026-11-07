/**
 * GOLDEN — Contrat UI ↔ API des habilitations RH.
 *
 * Le catalogue de la grille existe DEUX fois : côté serveur (autorité) et côté
 * écran (pour ne proposer que des cases valides). Une divergence serait
 * invisible à la relecture et se manifesterait en production par une case que
 * l'utilisateur coche et que l'API refuse. Ce banc fait échouer la CI plutôt.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { HAB_ACTIONS, HAB_EXTRA, HAB_FUNCTIONS, HAB_GRID } from './catalog.js'

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_SRC = join(API_SRC, '..', '..', '..', 'apps', 'web', 'src')
const readApi = (...p: string[]) => readFileSync(join(API_SRC, ...p), 'utf8')
const readWeb = (...p: string[]) => readFileSync(join(WEB_SRC, ...p), 'utf8')

const appTs = readApi('app.ts')
const webCatalog = readWeb('lib', 'habilitations.ts')
const sidebar = readWeb('components', 'layout', 'Sidebar.tsx')
const appTsx = readWeb('App.tsx')
const i18nIndex = readWeb('i18n', 'index.ts')
const navFr = JSON.parse(readWeb('i18n', 'locales', 'fr', 'nav.json')) as Record<string, unknown>
const navEn = JSON.parse(readWeb('i18n', 'locales', 'en', 'nav.json')) as Record<string, unknown>
const habFr = JSON.parse(readWeb('i18n', 'locales', 'fr', 'habilitations.json')) as Record<string, unknown>
const habEn = JSON.parse(readWeb('i18n', 'locales', 'en', 'habilitations.json')) as Record<string, unknown>

/** Extrait `nom = [ ... ]` ou `nom ... = { ... }` d'un source TypeScript. */
function block(source: string, name: string, open: '[' | '{'): string {
  const close = open === '[' ? ']' : '}'
  const start = source.indexOf(name)
  expect(start, `déclaration ${name} absente`).toBeGreaterThan(-1)
  const from = source.indexOf(open, start)
  let depth = 0
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === open) depth += 1
    else if (source[i] === close) {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1).replace(/\s+/g, ' ')
    }
  }
  throw new Error(`bloc ${name} non terminé`)
}

describe('GOLDEN habilitations — catalogue identique API ↔ écran', () => {
  it('les listes de fonctions, d\'actions et d\'extras sont les mêmes', () => {
    const fns = block(webCatalog, 'export const HAB_FUNCTIONS', '[')
    for (const fn of HAB_FUNCTIONS) expect(fns).toContain(`'${fn}'`)
    expect(fns.match(/'/g)?.length).toBe(HAB_FUNCTIONS.length * 2)

    const actions = block(webCatalog, 'export const HAB_ACTIONS', '[')
    for (const a of HAB_ACTIONS) expect(actions).toContain(`'${a}'`)
    expect(actions.match(/'/g)?.length).toBe(HAB_ACTIONS.length * 2)

    const extras = block(webCatalog, 'export const HAB_EXTRA', '[')
    for (const e of HAB_EXTRA) expect(extras).toContain(`'${e}'`)
    expect(extras.match(/'/g)?.length).toBe(HAB_EXTRA.length * 2)
  })

  it('la grille fonction → actions est identique, case par case', () => {
    const webGrid = block(webCatalog, 'export const HAB_GRID', '{')
    for (const fn of HAB_FUNCTIONS) {
      const expected = `${fn}: [${HAB_GRID[fn].map((a) => `'${a}'`).join(', ')}]`
      expect(webGrid, `grille divergente pour ${fn}`).toContain(expected)
    }
  })

  it('chaque fonction et chaque action a un libellé FR et EN', () => {
    const fnsFr = habFr.functions as Record<string, string>
    const fnsEn = habEn.functions as Record<string, string>
    for (const fn of HAB_FUNCTIONS) {
      expect(fnsFr[fn], `libellé FR manquant : ${fn}`).toBeTruthy()
      expect(fnsEn[fn], `libellé EN manquant : ${fn}`).toBeTruthy()
    }
    const actFr = habFr.gridActions as Record<string, string>
    const actEn = habEn.gridActions as Record<string, string>
    for (const a of HAB_ACTIONS) {
      expect(actFr[a], `libellé FR manquant : ${a}`).toBeTruthy()
      expect(actEn[a], `libellé EN manquant : ${a}`).toBeTruthy()
    }
    const exFr = habFr.extras as Record<string, string>
    const exEn = habEn.extras as Record<string, string>
    for (const e of HAB_EXTRA) {
      expect(exFr[e]).toBeTruthy()
      expect(exEn[e]).toBeTruthy()
    }
  })
})

describe('GOLDEN habilitations — routes et navigation', () => {
  it('les deux modules de routes sont enregistrés sous /habilitations', () => {
    expect(appTs).toContain('habilitationStructureRoutes')
    expect(appTs).toContain('habilitationFicheRoutes')
    expect(appTs).toMatch(/register\(habilitationStructureRoutes,\s*\{\s*prefix:\s*'\/habilitations'\s*\}\)/)
    expect(appTs).toMatch(/register\(habilitationFicheRoutes,\s*\{\s*prefix:\s*'\/habilitations'\s*\}\)/)
  })

  it('l\'écran est routé et son entrée de navigation existe en FR/EN', () => {
    expect(appTsx).toContain('HabilitationsPage')
    expect(appTsx).toMatch(/path="habilitations"/)
    expect(sidebar).toContain("to: '/habilitations'")
    expect(navFr.habilitations).toBeTruthy()
    expect(navEn.habilitations).toBeTruthy()
  })

  it('le namespace i18n est déclaré dans les deux langues', () => {
    expect(i18nIndex).toContain('habilitations: frHabilitations')
    expect(i18nIndex).toContain('habilitations: enHabilitations')
  })

  it('la navigation RH porte une fonction de grille sur ses entrées filtrables', () => {
    // Si ce compteur baisse, une rubrique RH est redevenue visible pour un
    // habilité qui n'a pas la case correspondante (403 au clic).
    const count = (sidebar.match(/habFn: '/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(25)
  })
})
