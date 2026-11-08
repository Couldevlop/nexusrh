/**
 * Politique de classification — ce qui décide entre « registre » et « règle ».
 *
 * Deux risques opposés encadrent ce service, et ce banc tient les deux bords :
 *
 *  - ne RIEN appliquer alors que le client a paramétré sa grille : c'est le
 *    défaut qu'on corrige, et la raison d'être du module ;
 *  - appliquer quelque chose à un tenant qui n'a jamais rien demandé : une
 *    mise à jour qui ferme soudain un export en production serait une panne,
 *    et une panne attribuée à une fonctionnalité de conformité.
 *
 * D'où l'insistance sur `enforced` : il distingue « la grille autorise » de
 * « aucune grille ne s'applique », deux situations qui laissent passer mais
 * qui ne se journalisent pas pareil.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {

  decide, decideFor, invalidateClassificationPolicy, loadClassificationPolicy, maskFields,
} from './classification-policy.service.js'

/** Vide la politique en cache des schémas que ce banc utilise. */
function videCache(): void {
  for (const s of ['tenant_sotra', 'tenant_x', 'tenant_a', 'tenant_b']) invalidateClassificationPolicy(s)
}

/** Grille standard : niveau 3 = RH + DG + lecture seule, niveau 4 = RH seuls. */
const NIVEAUX = [
  { level: 1, allowed_roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly', 'dg'], export_allowed: true, encryption_required: false, audit_required: false },
  { level: 3, allowed_roles: ['admin', 'hr_manager', 'hr_officer', 'manager', 'dg', 'readonly'], export_allowed: true, encryption_required: true, audit_required: true },
  { level: 4, allowed_roles: ['admin', 'hr_manager', 'hr_officer'], export_allowed: false, encryption_required: true, audit_required: true },
]
const CATEGORIES = [
  { category_key: 'organigramme', level: 1 },
  { category_key: 'remuneration', level: 3 },
  { category_key: 'payslips', level: 3 },
  { category_key: 'medical', level: 4 },
  { category_key: 'disciplinary', level: 4 },
]

function db(niveaux: unknown[] = NIVEAUX, categories: unknown[] = CATEGORIES) {
  const query = vi.fn(async (sql: string) =>
    String(sql).includes('classification_levels') ? { rows: niveaux } : { rows: categories })
  return { query }
}

/** Base qui échoue avec un code PostgreSQL donné. */
function dbEnErreur(code: string) {
  return { query: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })) }
}

beforeEach(() => videCache())

describe('Chargement de la grille', () => {
  it('lit les niveaux ET la cartographie des catégories', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    expect(p?.rules.get(4)).toMatchObject({ exportAllowed: false, auditRequired: true })
    expect(p?.categories.get('medical')).toBe(4)
  })

  it('module non provisionné (table absente) : AUCUNE règle, comportement inchangé', async () => {
    // C'est la garantie de non-régression : un tenant d'avant la
    // fonctionnalité ne doit pas voir ses exports se fermer du jour au
    // lendemain.
    expect(await loadClassificationPolicy('tenant_sotra', dbEnErreur('42P01'))).toBeNull()
  })

  it('grille vide : rien à appliquer, plutôt que tout refuser', async () => {
    // Une table présente mais sans ligne n'est pas une politique restrictive :
    // l'interpréter comme « aucun rôle autorisé » bloquerait tout le tenant.
    expect(await loadClassificationPolicy('tenant_sotra', db([], []))).toBeNull()
    expect(await loadClassificationPolicy('tenant_x', db(NIVEAUX, []))).toBeNull()
  })

  it('refuse un nom de schéma non conforme (A03)', async () => {
    const d = db()
    expect(await loadClassificationPolicy('tenant"; DROP TABLE x --', d)).toBeNull()
    expect(d.query).not.toHaveBeenCalled()
  })

  it('reste dans le schéma du tenant', async () => {
    const d = db()
    await loadClassificationPolicy('tenant_sotra', d)
    for (const appel of d.query.mock.calls) {
      expect(String(appel[0])).toContain('"tenant_sotra".')
      expect(String(appel[0])).not.toMatch(/\bpublic\.|\bplatform\./)
    }
  })
})

describe('Cache', () => {
  it('ne relit pas la grille à chaque export', async () => {
    const d = db()
    await loadClassificationPolicy('tenant_sotra', d)
    await loadClassificationPolicy('tenant_sotra', d)
    await loadClassificationPolicy('tenant_sotra', d)
    // Sans cache, contrôler la politique coûterait deux requêtes par export —
    // et deviendrait une raison de ne pas la contrôler.
    expect(d.query).toHaveBeenCalledTimes(2)
  })

  it('ne mélange pas deux tenants', async () => {
    const d = db()
    await loadClassificationPolicy('tenant_a', d)
    await loadClassificationPolicy('tenant_b', d)
    expect(d.query).toHaveBeenCalledTimes(4)
  })

  it('un changement de grille prend effet SANS attendre l’expiration', async () => {
    const d = db()
    await loadClassificationPolicy('tenant_sotra', d)
    invalidateClassificationPolicy('tenant_sotra')
    await loadClassificationPolicy('tenant_sotra', d)
    // Sinon l'administrateur règle sa grille, ne voit rien changer, et conclut
    // que la fonctionnalité ne marche pas.
    expect(d.query).toHaveBeenCalledTimes(4)
  })

  it('met en cache l’absence de module, pas une panne passagère', async () => {
    // Objet absent = état stable.
    const absent = dbEnErreur('42P01')
    await loadClassificationPolicy('tenant_sotra', absent)
    await loadClassificationPolicy('tenant_sotra', absent)
    expect(absent.query).toHaveBeenCalledTimes(2) // un seul chargement (2 requêtes)

    // Coupure = passager : surtout ne pas désarmer la politique 30 secondes,
    // ce serait exactement la fenêtre où un export passerait.
    videCache()
    const coupure = dbEnErreur('57P01')
    await loadClassificationPolicy('tenant_sotra', coupure)
    await loadClassificationPolicy('tenant_sotra', coupure)
    expect(coupure.query).toHaveBeenCalledTimes(4)
  })
})

describe('Décision', () => {
  it('niveau 4 : accessible aux RH, exportable par PERSONNE', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    expect(decide(p, 'medical', 'hr_manager')).toMatchObject({ level: 4, canAccess: true, canExport: false, enforced: true })
    expect(decide(p, 'medical', 'manager')).toMatchObject({ canAccess: false, canExport: false })
  })

  it('niveau 3 : exportable par les rôles autorisés', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    expect(decide(p, 'remuneration', 'hr_manager')).toMatchObject({ canAccess: true, canExport: true })
    expect(decide(p, 'remuneration', 'employee')).toMatchObject({ canAccess: false, canExport: false, enforced: true })
  })

  it('super_admin n’accède à AUCUNE donnée RH, quel que soit le paramétrage', async () => {
    // Non négociable : c'est l'isolation de la plateforme, pas un réglage de
    // tenant. Même une grille qui le listerait ne doit rien ouvrir.
    const p = await loadClassificationPolicy('tenant_sotra', db([
      { level: 3, allowed_roles: ['super_admin', 'admin'], export_allowed: true, encryption_required: false, audit_required: false },
    ]))
    expect(decide(p, 'remuneration', 'super_admin')).toMatchObject({ canAccess: false, canExport: false })
  })

  it('catégorie non cartographiée : rien à appliquer (et ce n’est pas un refus)', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    const d = decide(p, 'categorie_inventee', 'manager')
    expect(d).toMatchObject({ enforced: false, canAccess: true, canExport: true, level: null })
  })

  it('niveau cartographié mais sans règle : rien à appliquer', async () => {
    // Supprimer la règle d'un niveau ne doit pas transformer ses catégories en
    // données inaccessibles.
    const p = await loadClassificationPolicy('tenant_sotra', db(
      [NIVEAUX[0]!], [{ category_key: 'medical', level: 4 }],
    ))
    expect(decide(p, 'medical', 'hr_manager').enforced).toBe(false)
  })

  it('rend la clé du niveau, pour un message compréhensible', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    expect(decide(p, 'medical', 'manager').levelKey).toBe('restricted')
    expect(decide(p, 'remuneration', 'manager').levelKey).toBe('confidential')
  })

  it('exige la journalisation sur les niveaux qui le demandent', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    expect(decide(p, 'remuneration', 'hr_manager').auditRequired).toBe(true)
    expect(decide(p, 'organigramme', 'manager').auditRequired).toBe(false)
  })

  it('decideFor enchaîne chargement et décision', async () => {
    expect(await decideFor('tenant_sotra', db(), 'medical', 'manager'))
      .toMatchObject({ canExport: false, enforced: true })
  })
})

describe('Masquage', () => {
  const CHAMPS = { remuneration: ['base_salary', 'currency'], medical: ['medical_notes'] } as const
  const LIGNE = { id: 'e1', last_name: 'Koné', base_salary: 250_000, currency: 'XOF', medical_notes: 'apte' }

  it('vide les champs de la catégorie fermée, et les NOMME', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    const { row, masked } = maskFields(LIGNE, CHAMPS, p, 'employee')
    expect(row.base_salary).toBeNull()
    expect(row.currency).toBeNull()
    // Nommer les champs cachés permet à l'écran de dire « réservé » au lieu de
    // laisser croire à une donnée absente.
    expect(masked).toEqual(['base_salary', 'currency', 'medical_notes'])
  })

  it('laisse intact ce que le rôle a le droit de voir', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    const { row, masked } = maskFields(LIGNE, CHAMPS, p, 'hr_manager')
    expect(row).toEqual(LIGNE)
    expect(masked).toEqual([])
  })

  it('masque la santé sans toucher au salaire quand seule la santé est fermée', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    const { row, masked } = maskFields(LIGNE, CHAMPS, p, 'manager')
    // Le manager est autorisé au niveau 3 (rémunérations) et pas au niveau 4 :
    // le masquage doit donc être CHIRURGICAL. Tout masquer dès qu'une seule
    // catégorie est fermée rendrait la fiche inutilisable au quotidien.
    expect(row.medical_notes).toBeNull()
    expect(row.base_salary).toBe(250_000)
    expect(masked).toEqual(['medical_notes'])
  })

  it('sans grille : la ligne passe telle quelle', () => {
    const { row, masked } = maskFields(LIGNE, CHAMPS, null, 'employee')
    expect(row).toBe(LIGNE)
    expect(masked).toEqual([])
  })

  it('ne modifie pas la ligne d’origine', async () => {
    const p = await loadClassificationPolicy('tenant_sotra', db())
    const origine = { ...LIGNE }
    maskFields(LIGNE, CHAMPS, p, 'employee')
    expect(LIGNE).toEqual(origine)
  })
})
