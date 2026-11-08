/**
 * Chaînage de la piste d'audit — ce que le provisioning pose réellement.
 *
 * Ce banc ne teste pas PostgreSQL : il teste les PROPRIÉTÉS du SQL qu'on lui
 * envoie, celles dont dépend l'opposabilité. Chacune des assertions ci-dessous
 * correspond à une façon concrète de rendre la piste contestable :
 *   - un trigger AFTER plutôt que BEFORE, et l'empreinte n'est jamais écrite ;
 *   - une concaténation sans séparateur, et deux entrées différentes partagent
 *     une empreinte ;
 *   - un UPDATE autorisé, et une ligne se corrige sans laisser de trace ;
 *   - un DELETE libre, et une période entière disparaît en silence ;
 *   - une purge qui supprime avant d'écrire son marqueur, et le trou n'est pas
 *     documenté.
 */
import { describe, it, expect } from 'vitest'
import { auditChainStatements, auditPurgeFunctionStatements } from './audit-chain.js'

const sql = auditChainStatements('tenant_x')
const purge = auditPurgeFunctionStatements('tenant_x')
const all = [...sql, ...purge]
const joined = all.join('\n')

describe('Colonnes et index', () => {
  it('ajoute les colonnes de chaînage sans toucher aux entrées existantes', () => {
    for (const col of ['seq bigserial', 'prev_hash char(64)', 'entry_hash char(64)', 'user_agent text']) {
      expect(sql.some(s => s.includes(`ADD COLUMN IF NOT EXISTS ${col}`)), col).toBe(true)
    }
  })

  it('ordonne la chaîne sur seq, pas sur l’horodatage', () => {
    // Deux entrées peuvent partager `created_at` à la microseconde, et une
    // horloge peut reculer : l'ordre doit venir d'un compteur.
    expect(sql.some(s => /CREATE UNIQUE INDEX .* ON "tenant_x".audit_log\(seq\)/.test(s))).toBe(true)
    expect(joined).toContain('ORDER BY seq DESC')
  })

  it('est rejouable sur un tenant déjà migré', () => {
    for (const s of all) {
      expect(/IF NOT EXISTS|CREATE OR REPLACE|DROP TRIGGER IF EXISTS|CREATE TRIGGER/.test(s), s.slice(0, 60)).toBe(true)
    }
  })

  it('reste dans le schéma du tenant', () => {
    for (const s of all) expect(s).not.toMatch(/\bpublic\.audit_log|\bshared\./)
  })
})

describe('Empreinte', () => {
  const digest = all.find(s => s.includes('_digest('))!

  it('sépare les champs par un caractère impossible dans les valeurs', () => {
    // Sans séparateur, « ab » + « c » et « a » + « bc » donnent la même
    // empreinte : deux entrées distinctes deviendraient interchangeables.
    expect(digest).toContain('concat_ws(chr(31)')
  })

  it('couvre tout ce qui fait la preuve, l’entrée précédente incluse', () => {
    for (const field of ['p_prev', 'p_id', 'p_user_id', 'p_action', 'p_entity',
                         'p_entity_id', 'p_changes', 'p_ip', 'p_created_at']) {
      expect(digest, field).toContain(field)
    }
  })

  it('utilise sha256 natif, sans extension à installer', () => {
    expect(digest).toContain('sha256(')
    expect(joined).not.toContain('pgcrypto')
    expect(digest).not.toContain('md5(')
  })

  it('fige le format d’horodatage en UTC, à la microseconde', () => {
    // Un format dépendant du fuseau ou de la locale du serveur rendrait
    // l'empreinte irreproductible — donc le contrôle impossible.
    expect(digest).toContain("AT TIME ZONE 'UTC'")
    expect(digest).toContain('HH24:MI:SS.US')
  })

  it('est déterministe : la fonction est déclarée IMMUTABLE', () => {
    expect(digest).toContain('IMMUTABLE')
  })
})

describe('Trigger de chaînage', () => {
  it('s’exécute AVANT l’insertion, sur chaque ligne', () => {
    const trg = sql.find(s => s.includes('CREATE TRIGGER audit_log_chain_trg'))!
    expect(trg).toContain('BEFORE INSERT')
    expect(trg).toContain('FOR EACH ROW')
  })

  it('sérialise les écritures concurrentes', () => {
    // Sans verrou, deux insertions simultanées lisent la même entrée
    // précédente : la chaîne fourche et le contrôle signale une rupture.
    expect(joined).toContain('pg_advisory_xact_lock')
  })

  it('prend pour maillon la dernière entrée CHAÎNÉE', () => {
    // Une base contenant des entrées d'avant le chaînage ne doit pas accrocher
    // la nouvelle entrée à une ligne sans empreinte.
    expect(joined).toContain('WHERE entry_hash IS NOT NULL')
  })
})

describe('Ajout seul', () => {
  it('refuse toute modification d’entrée, sans exception', () => {
    const trg = sql.find(s => s.includes('CREATE TRIGGER audit_log_no_update_trg'))!
    expect(trg).toContain('BEFORE UPDATE')
    const fn = sql.find(s => s.includes('_no_update()'))!
    expect(fn).toContain('RAISE EXCEPTION')
    // Aucune échappatoire : pas de drapeau qui permettrait un UPDATE.
    expect(fn).not.toContain('current_setting')
  })

  it('refuse les suppressions directes, y compris en SQL', () => {
    const trg = sql.find(s => s.includes('CREATE TRIGGER audit_log_no_delete_trg'))!
    expect(trg).toContain('BEFORE DELETE')
    const fn = sql.find(s => s.includes('_no_delete()'))!
    expect(fn).toContain('RAISE EXCEPTION')
    // La seule porte est le drapeau que pose la fonction de purge.
    expect(fn).toContain("current_setting('nexusrh.audit_purge'")
  })
})

describe('Purge de rétention', () => {
  const fn = purge[0]!

  it('ne supprime rien quand aucune durée n’est fixée', () => {
    // 0 = conservation sans limite : c'est le défaut, et c'est une décision
    // juridique du client, pas un réglage que l'éditeur impose.
    expect(fn).toContain('p_keep_days <= 0')
  })

  it('écrit le marqueur AVANT de supprimer', () => {
    const insertAt = fn.indexOf("'audit.purged'")
    const deleteAt = fn.indexOf('DELETE FROM')
    expect(insertAt).toBeGreaterThan(0)
    expect(deleteAt).toBeGreaterThan(insertAt)
  })

  it('consigne combien, jusqu’à quand, et la dernière empreinte supprimée', () => {
    for (const k of ['purged', 'until', 'keepDays', 'lastPurgedHash']) {
      expect(fn, k).toContain(k)
    }
  })

  it('n’ouvre le droit de suppression que le temps de sa transaction', () => {
    expect(fn).toContain("set_config('nexusrh.audit_purge', 'on', true)")
    // Le troisième argument `true` = local à la transaction : le drapeau ne
    // survit pas à la fin de l'appel, même en cas d'erreur.
    expect(fn).toContain("set_config('nexusrh.audit_purge', 'off', true)")
  })
})
