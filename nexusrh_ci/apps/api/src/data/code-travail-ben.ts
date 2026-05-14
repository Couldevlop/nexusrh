/**
 * Code du Travail Bénin — Loi n° 98-004 du 27 janvier 1998
 * Convention Collective Générale du Travail du Bénin
 *
 * Sources :
 *   - sgg.gouv.bj/doc/loi-98-004/ (texte officiel)
 *   - ilo.org/dyn/natlex (Bénin Code du travail)
 *   - Code Général des Impôts Bénin 2024 (api.impots.bj)
 *
 * Sélection d'articles clés pour le SIRH. Ne couvre pas l'intégralité du code.
 */
import type { ArticleDroit } from './code-travail-ci.js'

const P = { access_level: 'public' as const, tenant_id: 'public' as const, country_code: 'BEN' }
const CT_BEN = 'code_travail_ben'
const CC_BEN_INTERPRO = 'convention_collective_ben_interprofessionnelle'
const LI = 'Livre I — Relations individuelles de travail'
const LII = 'Livre II — Salaire'
const LIII = 'Livre III — Conditions de travail'

export const CODE_TRAVAIL_BEN: ArticleDroit[] = [
  { ...P, source: CT_BEN, article_id: 'ben-art-9', article_numero: 'Art. 9', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. I — Définition',
    titre_article: 'Définition du contrat de travail',
    texte: 'Le contrat de travail est une convention par laquelle une personne s\'engage à mettre son activité professionnelle, moyennant rémunération, sous la direction et l\'autorité d\'une autre personne, physique ou morale, publique ou privée.',
    keywords: ['contrat travail', 'définition'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-15', article_numero: 'Art. 15', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. III — Période d\'essai',
    titre_article: 'Période d\'essai',
    texte: 'Le contrat de travail peut comporter une période d\'essai. La durée de la période d\'essai ne peut excéder huit jours pour les travailleurs payés à l\'heure, un mois pour les employés et trois mois pour les agents de maîtrise et cadres. Pendant la période d\'essai, les parties peuvent se délier sans préavis.',
    keywords: ['essai', 'durée essai', 'huit jours', 'un mois', 'trois mois'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-39', article_numero: 'Art. 39', livre: LI,
    titre: 'Titre II — Suspension du contrat',
    titre_article: 'Congés payés annuels',
    texte: 'Le travailleur acquiert droit au congé payé, à la charge de l\'employeur, à raison de deux jours ouvrables par mois de service effectif, soit vingt-quatre (24) jours ouvrables pour une année complète. Cette durée est augmentée d\'un jour ouvrable supplémentaire après cinq ans d\'ancienneté chez le même employeur.',
    keywords: ['congés payés', '2 jours/mois', '24 jours/an', 'ancienneté'],
    payroll_codes: ['1600'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-43', article_numero: 'Art. 43', livre: LI,
    titre: 'Titre II — Suspension du contrat',
    titre_article: 'Congé de maternité',
    texte: 'Toute femme enceinte bénéficie d\'un congé de maternité de quatorze (14) semaines, dont six (6) avant et huit (8) après l\'accouchement. Pendant cette période, elle perçoit une indemnité égale à son salaire intégral, à la charge pour moitié de l\'employeur et pour moitié de la Caisse Nationale de Sécurité Sociale.',
    keywords: ['maternité', '14 semaines', '6+8', 'CNSS', '50/50'],
    payroll_codes: ['1700'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-47', article_numero: 'Art. 47', livre: LI,
    titre_article: 'Préavis de licenciement',
    texte: 'En cas de rupture du contrat à durée indéterminée à l\'initiative de l\'employeur ou du travailleur, hors faute lourde, la durée minimum du préavis est égale à la durée de la période d\'essai applicable à l\'emploi occupé. La rupture peut intervenir sans préavis en cas de faute lourde, sous réserve de l\'appréciation de la juridiction compétente.',
    keywords: ['préavis', 'rupture', 'licenciement', 'faute lourde'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-118', article_numero: 'Art. 118', livre: LII,
    titre: 'Titre I — Salaire',
    titre_article: 'SMIG — Salaire Minimum Interprofessionnel Garanti',
    texte: 'Le salaire minimum interprofessionnel garanti (SMIG) est fixé par décret pris en Conseil des Ministres. Depuis le 1er janvier 2023, le SMIG est fixé à 52 000 FCFA pour une durée hebdomadaire de travail de 40 heures.',
    keywords: ['SMIG', '52 000', 'salaire minimum', '40 heures'],
    payroll_codes: ['1000'] },

  { ...P, source: CT_BEN, article_id: 'ben-art-142', article_numero: 'Art. 142', livre: LIII,
    titre_article: 'Durée hebdomadaire du travail',
    texte: 'La durée légale du travail effectif des employés ne peut excéder quarante (40) heures par semaine pour toute personne employée dans le secteur non-agricole. La durée légale du travail dans les exploitations agricoles est fixée à 2 400 heures par an.',
    keywords: ['durée travail', '40 heures/semaine'] },

  { ...P, source: 'fiscal_its', country_code: 'BEN', article_id: 'ben-cgi-its-2024',
    article_numero: 'CGI 2024 — Art. 168 et s.',
    titre: 'Code Général des Impôts Bénin 2024',
    titre_article: 'Impôt sur les Traitements et Salaires (ITS)',
    texte: 'L\'ITS est un impôt progressif prélevé à la source sur les traitements, salaires, indemnités et émoluments. Barème mensuel 2024 : 0% (≤ 60 000 FCFA), 10% (60 001 à 150 000), 15% (150 001 à 250 000), 19% (250 001 à 500 000), 30% (> 500 000 FCFA). Source : Code Général des Impôts Bénin 2024.',
    keywords: ['ITS', 'impôt salaires', 'barème', 'progressif'],
    payroll_codes: ['2100'] },
]

export const CONVENTIONS_COLLECTIVES_BEN: ArticleDroit[] = [
  { ...P, source: CC_BEN_INTERPRO, convention_slug: 'cc-interprofessionnelle-ben',
    article_id: 'ben-cc-interpro-mat-maint',
    article_numero: 'CC Interpro. Art. 56',
    titre: 'Convention Collective Générale du Travail du Bénin',
    titre_article: 'Maintien de salaire en cas de maladie',
    texte: 'En cas de maladie non professionnelle dûment constatée, le travailleur ayant au moins un an d\'ancienneté chez le même employeur perçoit l\'intégralité de son salaire pendant le premier mois, puis la moitié du salaire pendant les deux mois suivants.',
    keywords: ['maladie', 'maintien salaire', 'ancienneté'] },
]
