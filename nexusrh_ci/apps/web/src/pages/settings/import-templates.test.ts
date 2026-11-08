/**
 * Modèles CSV de reprise de données — ce que le client télécharge doit couvrir
 * ce que le serveur lit.
 *
 * Défaut constaté le 07/11/2026 : le handler d'import des employés lisait
 * `heures_hebdo`, `categorie`, `iban` et `banque`, absentes du modèle. Le RIB,
 * la banque, le temps de travail hebdomadaire et la catégorie conventionnelle
 * étaient donc perdus à chaque reprise — silencieusement, puisque ces colonnes
 * sont optionnelles côté serveur. Et le client qui les ajoutait de lui-même
 * déclenchait l'avertissement « colonnes inconnues » de la validation.
 *
 * Ce banc fige la liste attendue par le serveur. Le pendant côté API
 * (import-schema-conformity.golden.test.ts) vérifie l'autre bout de la chaîne :
 * que les colonnes écrites existent dans le schéma du tenant.
 */
import { describe, it, expect } from 'vitest'
import { IMPORT_TEMPLATES } from './SettingsPage'

/** Colonnes lues par POST /settings/import/:type, relevées dans le handler. */
const SERVER_COLUMNS: Record<string, readonly string[]> = {
  employees: [
    'prenom', 'nom', 'email', 'date_naissance', 'telephone', 'poste', 'departement',
    'date_embauche', 'salaire_brut', 'type_contrat', 'statut', 'sexe', 'numero_cnps',
    'ville', 'matricule', 'heures_hebdo', 'categorie', 'iban', 'banque',
  ],
  departments: ['nom', 'code', 'responsable_email'],
  absences: ['email_employe', 'type_absence', 'date_debut', 'date_fin', 'statut', 'motif'],
  pay_slips: ['email_employe', 'periode', 'salaire_brut', 'cotis_cnps_sal', 'its', 'net_paye', 'cout_employeur'],
  contracts: ['email_employe', 'type_contrat', 'date_debut', 'date_fin', 'salaire_base', 'periode_essai_jours', 'convention_collective', 'lieu_travail'],
  mobile_money: ['email_employe', 'operateur', 'numero_telephone'],
  expenses: ['email_employe', 'titre', 'mois', 'montant_total', 'statut'],
}

describe('Modèles CSV de reprise de données', () => {
  it('un modèle existe pour chaque type d’import du serveur', () => {
    expect(IMPORT_TEMPLATES.map((t) => t.id).sort()).toEqual(Object.keys(SERVER_COLUMNS).sort())
  })

  for (const template of IMPORT_TEMPLATES) {
    describe(template.id, () => {
      it('propose exactement les colonnes lues par le serveur', () => {
        expect([...template.headers].sort()).toEqual([...SERVER_COLUMNS[template.id]!].sort())
      })

      it('chaque ligne d’exemple a autant de valeurs que de colonnes', () => {
        for (const row of template.example) {
          expect(row.length, `exemple de ${template.id}`).toBe(template.headers.length)
        }
      })
    })
  }
})
