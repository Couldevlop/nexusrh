/**
 * Code du Travail Tchad — Loi n° 38/PR/96 du 11 décembre 1996
 * (révisions ultérieures incluses)
 *
 * Sources :
 *   - cnps-tchad.com (Guide employeur)
 *   - rivermate.com/guides/chad/leave
 *   - wageindicator.org/fr-td/travail-au-tchad
 *   - PwC Tax Summaries Chad (taxsummaries.pwc.com/chad)
 *
 * ATTENTION : Tchad = zone CEMAC, devise XAF (pas XOF UEMOA).
 */
import type { ArticleDroit } from './code-travail-ci.js'

const P = { access_level: 'public' as const, tenant_id: 'public' as const, country_code: 'TCD' }
const CT_TCD = 'code_travail_tcd'
const LI = 'Livre I — Relations individuelles de travail'

export const CODE_TRAVAIL_TCD: ArticleDroit[] = [
  { ...P, source: CT_TCD, article_id: 'tcd-art-46', article_numero: 'Art. 46', livre: LI,
    titre: 'Titre II — Contrat de travail',
    titre_article: 'Période d\'essai',
    texte: 'La durée de la période d\'essai et celle de son renouvellement éventuel sont fixées par voie de convention collective ou par accord particulier entre les parties. Elle ne peut excéder six mois, y compris le renouvellement. Pendant cette période, les parties peuvent rompre le contrat sans préavis.',
    keywords: ['essai', '6 mois', 'rupture', 'sans préavis'] },

  { ...P, source: CT_TCD, article_id: 'tcd-art-107', article_numero: 'Art. 107', livre: LI,
    titre: 'Titre IV — Suspension du contrat',
    titre_article: 'Congé de maternité',
    texte: 'La femme enceinte bénéficie d\'un congé de maternité de quatorze (14) semaines, qui commence six (6) semaines avant la date présumée de l\'accouchement et se termine huit (8) semaines après. Ce congé peut être prolongé de trois (3) semaines en cas de maladie dûment constatée résultant de la grossesse ou des couches.',
    keywords: ['maternité', '14 semaines', '6+8', 'prolongation'],
    payroll_codes: ['1700'] },

  { ...P, source: CT_TCD, article_id: 'tcd-art-108', article_numero: 'Art. 108', livre: LI,
    titre: 'Titre IV — Suspension du contrat',
    titre_article: 'Indemnité journalière de maternité',
    texte: 'Pendant son congé de maternité, la femme a droit, à la charge de la Caisse Nationale de Prévoyance Sociale, à une indemnité journalière égale au salaire effectivement perçu au moment de la suspension du contrat. L\'employeur ne supporte aucune charge salariale pendant cette période.',
    keywords: ['IJSS maternité', 'CNPS Tchad', 'salaire effectif'],
    payroll_codes: ['1700'] },

  { ...P, source: CT_TCD, article_id: 'tcd-art-110', article_numero: 'Art. 110', livre: LI,
    titre_article: 'Protection de l\'emploi pendant la maternité',
    texte: 'Aucun employeur ne peut résilier le contrat de travail d\'une femme en état de grossesse médicalement constatée ni pendant son congé de maternité. Toute disposition contraire est nulle de plein droit.',
    keywords: ['maternité', 'protection', 'licenciement nul'] },

  { ...P, source: CT_TCD, article_id: 'tcd-art-198', article_numero: 'Art. 198', livre: LI,
    titre_article: 'Congés payés annuels',
    texte: 'Le travailleur acquiert droit au congé payé annuel à la charge de l\'employeur à raison de deux (2) jours ouvrables par mois de service effectif, soit vingt-quatre (24) jours pour une année complète. Ce droit s\'acquiert après une période de référence de douze mois.',
    keywords: ['congés payés', '2 jours/mois', '24 jours/an'],
    payroll_codes: ['1600'] },

  { ...P, source: CT_TCD, article_id: 'tcd-smig', article_numero: 'SMIG 2024',
    titre_article: 'SMIG — Salaire Minimum Interprofessionnel Garanti',
    texte: 'Le SMIG mensuel au Tchad est fixé à 60 000 FCFA (XAF) depuis 2011. Ce salaire est resté stable malgré plusieurs tentatives de revalorisation. Le SMIG est fixé par décret pris en Conseil des Ministres conformément à l\'article 121 du Code du Travail.',
    keywords: ['SMIG', '60 000', 'XAF', 'stagnant 2011'],
    payroll_codes: ['1000'] },

  { ...P, source: CT_TCD, article_id: 'tcd-maladie-anciennete',
    article_numero: 'Convention collective interprof.',
    titre_article: 'Maintien de salaire en cas de maladie selon ancienneté',
    texte: 'En cas de maladie non professionnelle, le maintien du salaire est : moins de 5 ans d\'ancienneté — six (6) mois à plein traitement ; entre 5 et 10 ans — six (6) mois plein traitement puis six (6) mois à demi-traitement ; au-delà de 10 ans — douze (12) mois à plein traitement.',
    keywords: ['maladie', 'maintien salaire', 'ancienneté', '5 ans', '10 ans'] },
]
