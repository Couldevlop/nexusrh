/**
 * Code du Travail Togo — Loi n° 2021-012 du 18 juin 2021
 * Convention Collective Interprofessionnelle du Togo
 *
 * Sources :
 *   - droit-afrique.com/uploads/Togo-Code-2021-travail.pdf
 *   - assemblee-nationale.tg/wp-content/uploads/2021/06/...
 *   - CNSS Togo (cnss.tg)
 *
 * Sélection d'articles clés pour le SIRH.
 */
import type { ArticleDroit } from './code-travail-ci.js'

const P = { access_level: 'public' as const, tenant_id: 'public' as const, country_code: 'TGO' }
const CT_TGO = 'code_travail_tgo'
const CC_TGO_INTERPRO = 'convention_collective_tgo_interprofessionnelle'
const LI = 'Livre I — Relations individuelles de travail'
const LII = 'Livre II — Salaire et avantages'

export const CODE_TRAVAIL_TGO: ArticleDroit[] = [
  { ...P, source: CT_TGO, article_id: 'tgo-art-49', article_numero: 'Art. 49', livre: LI,
    titre: 'Titre III — Conclusion et exécution',
    titre_article: 'Période d\'essai — Durée maximale',
    texte: 'La durée de la période d\'essai, renouvellement compris, ne peut excéder : huit jours pour les travailleurs payés à l\'heure ; un mois pour les employés et les ouvriers ; trois mois pour les agents de maîtrise, techniciens et assimilés ; six mois pour les cadres et les ingénieurs.',
    keywords: ['essai', 'durée maximale', 'cadres', '6 mois'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-51', article_numero: 'Art. 51', livre: LI,
    titre: 'Titre III — Conclusion et exécution',
    titre_article: 'Effets de la période d\'essai',
    texte: 'Pendant la période d\'essai, les parties ont la faculté réciproque de rompre le contrat sans préavis ni indemnité, sauf celle relative aux congés payés. La période d\'essai est prise en compte dans le calcul de l\'ancienneté pour l\'avancement et le droit aux congés annuels.',
    keywords: ['essai', 'rupture', 'sans préavis', 'congés payés'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-156', article_numero: 'Art. 156', livre: LI,
    titre: 'Titre IV — Suspension du contrat',
    titre_article: 'Congés payés annuels',
    texte: 'Tout salarié a droit à un congé payé à la charge de l\'employeur, à raison de deux jours et demi (2,5) ouvrables par mois de service effectif, soit trente (30) jours ouvrables pour une année de travail complète. La période minimum donnant droit aux congés est de douze (12) mois.',
    keywords: ['congés payés', '2,5 jours/mois', '30 jours/an'],
    payroll_codes: ['1600'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-153', article_numero: 'Art. 153', livre: LI,
    titre: 'Titre IV — Suspension du contrat',
    titre_article: 'Congé de maternité',
    texte: 'La femme salariée a droit à un congé de maternité d\'une durée de quatorze (14) semaines, dont six (6) semaines avant la date présumée de l\'accouchement et huit (8) après. Ce congé peut être prolongé de trois (3) semaines en cas de maladie dûment constatée et résultant de la grossesse ou des couches. L\'indemnité journalière de maternité est servie par la CNSS.',
    keywords: ['maternité', '14 semaines', '6+8', 'CNSS', 'IJM'],
    payroll_codes: ['1700'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-79', article_numero: 'Art. 79', livre: LI,
    titre_article: 'Préavis de rupture du CDI',
    texte: 'Toute rupture d\'un contrat de travail à durée indéterminée sans observation totale ou partielle du préavis ouvre droit, au profit de la partie envers laquelle l\'engagement n\'a pas été respecté, à une indemnité de préavis correspondant à la rémunération et aux avantages dont aurait bénéficié le travailleur durant le délai de préavis non observé.',
    keywords: ['préavis', 'rupture', 'CDI', 'indemnité'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-118', article_numero: 'Art. 118', livre: LII,
    titre_article: 'SMIG — Salaire Minimum Interprofessionnel Garanti',
    texte: 'Le salaire minimum interprofessionnel garanti (SMIG) est fixé par décret pris en Conseil des Ministres. Le SMIG mensuel est de 52 500 FCFA pour une durée hebdomadaire de 40 heures.',
    keywords: ['SMIG', '52 500', 'salaire minimum'],
    payroll_codes: ['1000'] },

  { ...P, source: CT_TGO, article_id: 'tgo-art-141', article_numero: 'Art. 141', livre: LII,
    titre_article: 'Durée légale hebdomadaire',
    texte: 'La durée légale du travail effectif des salariés ne peut excéder quarante (40) heures par semaine pour toute personne employée dans les établissements non agricoles. Les heures effectuées au-delà donnent lieu à majoration.',
    keywords: ['durée travail', '40 heures', 'heures supp'] },

  { ...P, source: 'fiscal_its', country_code: 'TGO', article_id: 'tgo-cgi-irpp-2024',
    article_numero: 'CGI 2024 — IRPP',
    titre: 'Code Général des Impôts Togo',
    titre_article: 'IRPP — Barème annuel (Loi de Finances 2023 maintenue)',
    texte: 'L\'IRPP est calculé sur le revenu annuel après déduction des cotisations CNSS et application d\'un abattement forfaitaire de 28%. Barème 8 tranches : 0% (≤ 900 000), 3% (900 001–3 M), 10% (3–6 M), 15% (6–9 M), 20% (9–12 M), 25% (12–15 M), 30% (15–20 M), 35% (> 20 M). Déduction pour charges de famille : 10 000 FCFA/mois par personne (max 6).',
    keywords: ['IRPP', 'barème annuel', 'quotient familial'],
    payroll_codes: ['2100'] },
]

export const CONVENTIONS_COLLECTIVES_TGO: ArticleDroit[] = [
  { ...P, source: CC_TGO_INTERPRO, convention_slug: 'cc-interprofessionnelle-tgo',
    article_id: 'tgo-cc-interpro-anciennete',
    article_numero: 'CC Interpro. Togo — Art. 18',
    titre: 'Convention Collective Interprofessionnelle du Togo',
    titre_article: 'Prime d\'ancienneté',
    texte: 'Une prime d\'ancienneté est versée à tout salarié justifiant d\'au moins deux (2) ans de service effectif chez le même employeur. Elle est calculée sur le salaire de base : 2% après 2 ans, 4% après 5 ans, 6% après 10 ans, 8% après 15 ans, 10% après 20 ans.',
    keywords: ['ancienneté', 'prime', 'pourcentage'],
    payroll_codes: ['1100'] },
]
