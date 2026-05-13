/**
 * Code du Travail CI — Loi n°2015-532 du 20 juillet 2015
 * Conventions Collectives CI
 * ITS / DGI — CGI CI
 * OHADA — Acte Uniforme Droit du Travail
 *
 * Source de seed uniquement — la source de vérité est PostgreSQL (schema droit_ci)
 */
export interface ArticleDroit {
  article_id: string; article_numero: string
  /** ISO-3 pays (CIV par défaut). Indispensable pour le filtre multi-pays. */
  country_code?: string
  source: string  // code_travail_civ, code_travail_ben, convention_collective_*
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; section?: string; titre_article: string
  texte: string; access_level: 'public'; tenant_id: 'public'
  payroll_codes?: string[]; keywords?: string[]
}

const P: Pick<ArticleDroit, 'access_level' | 'tenant_id'> = { access_level: 'public', tenant_id: 'public' }
const CT = 'code_travail_ci' as const

// ── LIVRE I — RELATIONS INDIVIDUELLES DE TRAVAIL ──────────────────────────────
const LI = 'Livre I — Relations individuelles de travail'

export const CODE_TRAVAIL_CI: ArticleDroit[] = [

  // ─── TITRE I — CONTRAT DE TRAVAIL ────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-11-1', article_numero: 'Art. 11.1', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. I — Définition',
    titre_article: 'Définition du contrat de travail',
    texte: 'Le contrat de travail est la convention par laquelle une personne physique s\'engage à mettre son activité professionnelle sous la direction et l\'autorité d\'une autre personne physique ou morale moyennant rémunération.',
    keywords: ['contrat travail', 'définition', 'lien subordination'] },

  { ...P, source: CT, article_id: 'art-11-2', article_numero: 'Art. 11.2', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. I — Définition',
    titre_article: 'Présomption de salariat',
    texte: 'Est présumée salariée toute personne physique placée dans un lien de subordination juridique à l\'égard d\'un employeur. La preuve contraire est à la charge de l\'employeur.',
    keywords: ['présomption salariat', 'subordination'] },

  { ...P, source: CT, article_id: 'art-11-3', article_numero: 'Art. 11.3', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. I — Définition',
    titre_article: 'Non-concurrence et exclusivité',
    texte: 'Le salarié est tenu à une obligation de loyauté envers son employeur. Une clause de non-concurrence doit être limitée dans le temps (max 2 ans), dans l\'espace et être assortie d\'une contrepartie financière. Sans contrepartie, elle est nulle.',
    keywords: ['non-concurrence', 'loyauté', 'exclusivité', 'clause nulle'] },

  { ...P, source: CT, article_id: 'art-12-1', article_numero: 'Art. 12.1', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. II — CDD',
    titre_article: 'Contrat à durée déterminée — Conditions',
    texte: 'Le contrat à durée déterminée (CDD) ne peut avoir ni pour objet ni pour effet de pourvoir durablement un emploi lié à l\'activité normale et permanente de l\'entreprise. Il est établi par écrit et précise son terme. La durée maximale est de 2 ans, renouvellements inclus.',
    keywords: ['CDD', 'durée déterminée', '2 ans', 'écrit'] },

  { ...P, source: CT, article_id: 'art-12-2', article_numero: 'Art. 12.2', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. II — CDD',
    titre_article: 'Cas de recours au CDD',
    texte: 'Le recours au CDD est autorisé pour : remplacement d\'un salarié absent, accroissement temporaire d\'activité, emplois saisonniers, travaux nécessitant des compétences non disponibles en interne, contrats dans le cadre de mesures pour l\'emploi.',
    keywords: ['CDD cas recours', 'remplacement', 'saisonnier', 'temporaire'] },

  { ...P, source: CT, article_id: 'art-12-3', article_numero: 'Art. 12.3', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. II — CDD',
    titre_article: 'Renouvellement du CDD',
    texte: 'Le CDD peut être renouvelé deux fois dans la limite de sa durée maximale (2 ans). Tout renouvellement fait l\'objet d\'un avenant écrit signé avant le terme du contrat. Au-delà de 2 renouvellements, le contrat est réputé à durée indéterminée.',
    keywords: ['renouvellement CDD', 'avenant', '2 renouvellements', 'limite'] },

  { ...P, source: CT, article_id: 'art-12-4', article_numero: 'Art. 12.4', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. II — CDD',
    titre_article: 'Requalification du CDD en CDI',
    texte: 'Tout contrat à durée déterminée conclu en méconnaissance des dispositions légales est réputé conclu pour une durée indéterminée. Le salarié peut saisir le tribunal du travail pour faire constater cette requalification.',
    keywords: ['requalification', 'CDD CDI', 'tribunal travail'] },

  { ...P, source: CT, article_id: 'art-12-5', article_numero: 'Art. 12.5', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. II — CDD',
    titre_article: 'Indemnité de fin de CDD',
    texte: 'À l\'échéance du CDD qui n\'est pas renouvelé ni suivi d\'un CDI, le salarié perçoit une indemnité de fin de contrat égale à 15% de la rémunération totale brute perçue pendant la durée du contrat.',
    keywords: ['indemnité fin CDD', '15%', 'fin contrat'] },

  { ...P, source: CT, article_id: 'art-13-1', article_numero: 'Art. 13.1', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. III — CDI',
    titre_article: 'Contrat à durée indéterminée',
    texte: 'Le contrat à durée indéterminée (CDI) est la forme normale et générale de la relation de travail. Il peut être conclu verbalement ou par écrit. L\'écrit est obligatoire pour les travailleurs étrangers.',
    keywords: ['CDI', 'durée indéterminée', 'forme normale'] },

  { ...P, source: CT, article_id: 'art-13-2', article_numero: 'Art. 13.2', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. III — CDI',
    titre_article: 'Contenu obligatoire du contrat de travail',
    texte: 'Le contrat de travail écrit doit mentionner : identité des parties, lieu de travail, intitulé du poste, date d\'embauche, rémunération (en FCFA), convention collective applicable, durée de la période d\'essai, numéro CNPS employeur, NNI du salarié.',
    keywords: ['contrat écrit', 'mentions obligatoires', 'NNI', 'CNPS', 'FCFA'] },

  { ...P, source: CT, article_id: 'art-13-3', article_numero: 'Art. 13.3', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. III — CDI',
    titre_article: 'Travail à temps partiel',
    texte: 'Est considéré comme salarié à temps partiel le salarié dont la durée du travail est inférieure à la durée légale (40h/sem). Le contrat doit être écrit et préciser la durée hebdomadaire, la répartition des heures, les cas de modification. Le salarié à temps partiel bénéficie des mêmes droits que le salarié à temps plein au prorata.',
    keywords: ['temps partiel', 'contrat temps partiel', 'prorata', 'durée hebdomadaire'] },

  // ─── TITRE II — PÉRIODE D'ESSAI ───────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-14-1', article_numero: 'Art. 14.1', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. IV — Période d\'essai',
    titre_article: 'Période d\'essai — Principe',
    texte: 'Le contrat de travail peut comporter une période d\'essai dont l\'objet est de permettre à l\'employeur d\'évaluer les compétences du salarié et au salarié d\'apprécier ses conditions de travail.',
    keywords: ['essai', 'période essai'] },

  { ...P, source: CT, article_id: 'art-14-3', article_numero: 'Art. 14.3', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. IV — Période d\'essai',
    titre_article: 'Durée de la période d\'essai',
    texte: 'La durée de la période d\'essai est fixée à 15 jours pour les travailleurs journaliers, 1 mois pour les travailleurs mensuels non-cadres, et 3 mois pour les cadres et assimilés. Elle est renouvelable une fois avec accord écrit des deux parties.',
    keywords: ['essai', 'durée', '1 mois', '3 mois cadre'] },

  { ...P, source: CT, article_id: 'art-14-5', article_numero: 'Art. 14.5', livre: LI,
    titre: 'Titre I — Contrat de travail', chapitre: 'Chap. IV — Période d\'essai',
    titre_article: 'Rupture pendant la période d\'essai',
    texte: 'Pendant la période d\'essai, chaque partie peut rompre le contrat sans préavis ni indemnité. Toutefois, si la rupture est abusive, des dommages-intérêts peuvent être accordés.',
    keywords: ['rupture essai', 'sans préavis', 'sans indemnité'] },

  // ─── TITRE III — SUSPENSION DU CONTRAT ───────────────────────────────────────
  { ...P, source: CT, article_id: 'art-18-1', article_numero: 'Art. 18.1', livre: LI,
    titre: 'Titre II — Suspension du contrat', chapitre: 'Chap. I — Cas de suspension',
    titre_article: 'Causes de suspension du contrat de travail',
    texte: 'Le contrat de travail est suspendu notamment : en cas de maladie ou accident du salarié dûment constatés, de maternité, de congés légaux et conventionnels, de mise à pied disciplinaire, de détention préventive, d\'accomplissement du service national.',
    keywords: ['suspension contrat', 'maladie', 'maternité', 'congé'], payroll_codes: ['1700', '1800', '1900'] },

  { ...P, source: CT, article_id: 'art-18-2', article_numero: 'Art. 18.2', livre: LI,
    titre: 'Titre II — Suspension du contrat', chapitre: 'Chap. I — Cas de suspension',
    titre_article: 'Suspension pour mise à pied disciplinaire',
    texte: 'La mise à pied disciplinaire suspend le contrat sans rémunération. Elle doit être notifiée par écrit et précéder ou accompagner une sanction disciplinaire. Sa durée maximale est fixée par le règlement intérieur et ne peut dépasser 15 jours.',
    keywords: ['mise à pied', 'disciplinaire', 'sanction', 'sans salaire', '15 jours'] },

  { ...P, source: CT, article_id: 'art-18-3', article_numero: 'Art. 18.3', livre: LI,
    titre: 'Titre II — Suspension du contrat', chapitre: 'Chap. I — Cas de suspension',
    titre_article: 'Effets de la suspension',
    texte: 'Pendant la suspension, l\'employeur ne peut rompre le contrat sauf faute grave du salarié ou impossibilité de maintenir le contrat pour un motif étranger à la maladie ou à l\'accident.',
    keywords: ['suspension', 'protection licenciement', 'faute grave'] },

  { ...P, source: CT, article_id: 'art-18-4', article_numero: 'Art. 18.4', livre: LI,
    titre: 'Titre II — Suspension du contrat', chapitre: 'Chap. I — Cas de suspension',
    titre_article: 'Reprise du travail après suspension',
    texte: 'À l\'issue de la période de suspension, le salarié retrouve son emploi ou un emploi similaire avec une rémunération au moins équivalente. L\'ancienneté acquise avant la suspension est conservée.',
    keywords: ['reprise travail', 'réintégration', 'ancienneté', 'suspension'] },

  // ─── TITRE IV — RUPTURE DU CONTRAT ───────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-19-1', article_numero: 'Art. 19.1', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. I — Modes de rupture',
    titre_article: 'Modes de rupture du CDI',
    texte: 'Le contrat à durée indéterminée peut prendre fin par : la démission du salarié, le licenciement par l\'employeur, la rupture conventionnelle d\'un commun accord, la retraite, le décès du salarié, la force majeure.',
    keywords: ['rupture CDI', 'démission', 'licenciement', 'retraite', 'rupture conventionnelle'] },

  { ...P, source: CT, article_id: 'art-19-2', article_numero: 'Art. 19.2', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. I — Modes de rupture',
    titre_article: 'Rupture conventionnelle',
    texte: 'La rupture conventionnelle permet à l\'employeur et au salarié de convenir d\'un commun accord des conditions de rupture du CDI. Elle donne lieu à une indemnité spécifique au moins égale à l\'indemnité légale de licenciement. Elle ne peut être imposée à l\'une ou l\'autre des parties.',
    keywords: ['rupture conventionnelle', 'accord commun', 'indemnité', 'CDI'] },

  { ...P, source: CT, article_id: 'art-20-1', article_numero: 'Art. 20.1', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Condition de forme du licenciement',
    texte: 'Tout licenciement doit être notifié par lettre recommandée avec accusé de réception. La lettre doit énoncer le ou les motifs du licenciement. L\'employeur doit convoquer le salarié à un entretien préalable avant toute décision.',
    keywords: ['licenciement', 'lettre recommandée', 'entretien préalable', 'motif'] },

  { ...P, source: CT, article_id: 'art-20-2', article_numero: 'Art. 20.2', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Cause réelle et sérieuse de licenciement',
    texte: 'Tout licenciement doit reposer sur une cause réelle et sérieuse : motif personnel (insuffisance professionnelle, faute) ou motif économique (suppression de poste, difficultés économiques). À défaut, le licenciement est abusif.',
    keywords: ['cause réelle sérieuse', 'licenciement abusif', 'motif personnel', 'motif économique'] },

  { ...P, source: CT, article_id: 'art-20-3', article_numero: 'Art. 20.3', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Licenciement pour insuffisance professionnelle',
    texte: 'L\'insuffisance professionnelle constitue un motif de licenciement si elle est réelle, objective, et non imputable à l\'employeur (absence de formation, changement de poste non justifié). L\'employeur doit avoir mis en garde le salarié préalablement.',
    keywords: ['insuffisance professionnelle', 'licenciement', 'mise en garde', 'formation'] },

  { ...P, source: CT, article_id: 'art-20-4', article_numero: 'Art. 20.4', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Licenciement pour motif économique',
    texte: 'Le licenciement économique est fondé sur la suppression ou transformation d\'emploi résultant de difficultés économiques, de mutations technologiques ou de réorganisation nécessaire à la compétitivité. L\'employeur doit reclasser le salarié avant toute rupture.',
    keywords: ['licenciement économique', 'reclassement', 'difficultés économiques', 'mutation technologique'] },

  { ...P, source: CT, article_id: 'art-20-5', article_numero: 'Art. 20.5', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Licenciement pour faute grave',
    texte: 'La faute grave prive le salarié de son droit au préavis et à l\'indemnité de licenciement. Constituent notamment des fautes graves : le vol, l\'insubordination caractérisée, les voies de fait, l\'ivresse habituelle au travail, la divulgation de secrets professionnels.',
    keywords: ['faute grave', 'sans préavis', 'sans indemnité', 'vol', 'insubordination'] },

  { ...P, source: CT, article_id: 'art-20-6', article_numero: 'Art. 20.6', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Faute lourde — Distinction avec faute grave',
    texte: 'La faute lourde, caractérisée par l\'intention de nuire à l\'entreprise, prive le salarié de toutes indemnités (préavis, licenciement, congés payés). Elle est appréciée strictement par les tribunaux.',
    keywords: ['faute lourde', 'intention nuire', 'zéro indemnité', 'congés payés perdus'] },

  { ...P, source: CT, article_id: 'art-20-7', article_numero: 'Art. 20.7', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. II — Licenciement',
    titre_article: 'Licenciement collectif — Procédure',
    texte: 'Le licenciement collectif pour motif économique (≥2 salariés sur 30 jours) nécessite : consultation des délégués du personnel, information de l\'Inspection du Travail, respect de l\'ordre des licenciements (ancienneté, charges de famille), délai de 30 jours minimum.',
    keywords: ['licenciement collectif', 'délégués', 'inspection travail', 'ordre licenciement', 'charges famille'] },

  // ─── PRÉAVIS ──────────────────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-23-1', article_numero: 'Art. 23.1', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. III — Préavis',
    titre_article: 'Durée du préavis de rupture',
    texte: 'La durée du préavis est fixée à : 15 jours pour les travailleurs ayant moins d\'un an d\'ancienneté ; 1 mois pour 1 à 5 ans ; 2 mois pour 5 à 10 ans ; 3 mois pour plus de 10 ans. Pour les cadres : 3 mois quelle que soit l\'ancienneté.',
    keywords: ['préavis', 'durée', 'ancienneté', 'CDI', 'licenciement', 'démission'] },

  { ...P, source: CT, article_id: 'art-23-2', article_numero: 'Art. 23.2', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. III — Préavis',
    titre_article: 'Heures pour recherche d\'emploi pendant le préavis',
    texte: 'Pendant le préavis, le salarié bénéficie de 2 heures par jour de travail pour rechercher un nouvel emploi. Ces heures sont rémunérées. Par accord, elles peuvent être groupées en journées entières.',
    keywords: ['préavis', 'heures recherche emploi', 'rémunérées', 'groupées'] },

  { ...P, source: CT, article_id: 'art-23-4', article_numero: 'Art. 23.4', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. III — Préavis',
    titre_article: 'Indemnité compensatrice de préavis',
    texte: 'Si l\'employeur dispense le salarié d\'effectuer son préavis, il lui doit une indemnité compensatrice égale au salaire et avantages qu\'il aurait perçus pendant la période de préavis.',
    keywords: ['indemnité préavis', 'dispense préavis', 'indemnité compensatrice'] },

  // ─── INDEMNITÉS ───────────────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-25-1', article_numero: 'Art. 25.1', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. IV — Indemnités',
    titre_article: 'Indemnité de licenciement — Calcul',
    texte: 'Tout salarié licencié ayant au moins 1 an d\'ancienneté a droit à une indemnité de licenciement calculée sur le salaire global moyen des 3 derniers mois : 30% du salaire mensuel par année pour les 10 premières années, 35% de la 11e à la 15e année, 40% au-delà de la 15e année.',
    keywords: ['indemnité licenciement', 'ancienneté', '30%', 'calcul'] },

  { ...P, source: CT, article_id: 'art-25-2', article_numero: 'Art. 25.2', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. IV — Indemnités',
    titre_article: 'Salaire de référence pour indemnités',
    texte: 'Le salaire de référence pour le calcul de l\'indemnité de licenciement est le salaire global moyen des 3 derniers mois comprenant : salaire de base, primes régulières, avantages en nature valorisés. Sont exclus : remboursements de frais, primes exceptionnelles.',
    keywords: ['salaire référence', 'indemnité licenciement', '3 mois', 'primes régulières'] },

  { ...P, source: CT, article_id: 'art-25-3', article_numero: 'Art. 25.3', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. IV — Indemnités',
    titre_article: 'Certificat de travail',
    texte: 'À l\'expiration du contrat de travail, l\'employeur doit remettre au salarié un certificat de travail mentionnant la date d\'entrée, la date de sortie et la nature des emplois successivement occupés.',
    keywords: ['certificat travail', 'fin contrat', 'mention'] },

  { ...P, source: CT, article_id: 'art-25-4', article_numero: 'Art. 25.4', livre: LI,
    titre: 'Titre III — Rupture du contrat', chapitre: 'Chap. IV — Indemnités',
    titre_article: 'Solde de tout compte',
    texte: 'L\'employeur remet au salarié à la rupture du contrat un reçu pour solde de tout compte qui peut être dénoncé dans les 6 mois suivant sa signature. Passé ce délai, il est libératoire pour l\'employeur.',
    keywords: ['solde tout compte', 'reçu', '6 mois', 'libératoire'] },

  // ─── CONGÉS ET REPOS ──────────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-25-8', article_numero: 'Art. 25.8', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. I — Congés payés',
    titre_article: 'Droit aux congés payés — 2,5 jours par mois',
    texte: 'Tout salarié acquiert droit à un congé payé à raison de 2,5 jours ouvrables par mois de travail effectif. La durée totale est de 30 jours ouvrables par an. Bonus d\'ancienneté : 1 jour supplémentaire après 5 ans, 2 jours après 10 ans, 3 jours après 15 ans d\'ancienneté.',
    keywords: ['congés payés', 'CP', '2,5 jours', 'ouvrables', 'ancienneté'], payroll_codes: ['1600'] },

  { ...P, source: CT, article_id: 'art-25-9', article_numero: 'Art. 25.9', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. I — Congés payés',
    titre_article: 'Indemnité de congés payés — Calcul',
    texte: 'L\'indemnité de congés payés est égale au dixième de la rémunération totale perçue au cours de l\'année de référence, ou au salaire qui aurait été perçu pendant la période de congé si ce mode de calcul est plus favorable.',
    keywords: ['indemnité congés', 'calcul', '1/10e', 'règle favorable'], payroll_codes: ['1600'] },

  { ...P, source: CT, article_id: 'art-25-10', article_numero: 'Art. 25.10', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. I — Congés payés',
    titre_article: 'Période de prise des congés',
    texte: 'Les congés sont pris en accord avec l\'employeur. Ils doivent être pris dans les 12 mois suivant l\'acquisition. Un minimum de 12 jours ouvrables consécutifs doit être accordé. L\'employeur fixe les dates en tenant compte des nécessités du service et des désirs du salarié.',
    keywords: ['prise congés', '12 mois', '12 jours consécutifs', 'planning'] },

  { ...P, source: CT, article_id: 'art-26-1', article_numero: 'Art. 26.1', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Congé de maternité — 14 semaines',
    texte: 'La travailleuse enceinte bénéficie d\'un congé de maternité de 14 semaines dont au moins 6 semaines après l\'accouchement. Ce congé est rémunéré. Les indemnités journalières de la CNPS sont avancées par l\'employeur qui les récupère auprès de la CNPS.',
    keywords: ['maternité', '14 semaines', 'CNPS', 'indemnités journalières', 'remboursement'], payroll_codes: ['1700'] },

  { ...P, source: CT, article_id: 'art-26-2', article_numero: 'Art. 26.2', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Protection contre le licenciement — Maternité',
    texte: 'L\'employeur ne peut licencier une salariée enceinte pendant la période de grossesse et de congé de maternité sauf faute grave non liée à la grossesse ou impossibilité de maintenir le contrat.',
    keywords: ['licenciement maternité', 'protection grossesse', 'interdiction'] },

  { ...P, source: CT, article_id: 'art-26-3', article_numero: 'Art. 26.3', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Congé de paternité — 10 jours',
    texte: 'Le père salarié bénéficie d\'un congé de paternité de 10 jours ouvrables à l\'occasion de la naissance de son enfant. Ce congé est rémunéré normalement et ne peut être refusé par l\'employeur.',
    keywords: ['paternité', 'naissance', '10 jours'] },

  { ...P, source: CT, article_id: 'art-26-4', article_numero: 'Art. 26.4', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Allaitement — Heure par jour',
    texte: 'Pendant les 15 premiers mois suivant l\'accouchement, la mère allaitante bénéficie d\'une heure par jour pour l\'allaitement, fractionnée en 2 périodes de 30 minutes. Cette heure est rémunérée et ne peut être refusée par l\'employeur.',
    keywords: ['allaitement', 'heure allaitement', '15 mois', 'rémunérée'] },

  { ...P, source: CT, article_id: 'art-26-5', article_numero: 'Art. 26.5', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Congés pour événements familiaux',
    texte: 'Des congés exceptionnels rémunérés sont accordés à l\'occasion des événements suivants : mariage du salarié : 5 jours ; naissance ou adoption : 3 jours ; décès du conjoint, d\'un enfant, d\'un parent : 3 jours.',
    keywords: ['congés familiaux', 'mariage', 'décès', 'naissance', 'événement familial'] },

  { ...P, source: CT, article_id: 'art-26-6', article_numero: 'Art. 26.6', livre: LI,
    titre: 'Titre IV — Congés et repos', chapitre: 'Chap. II — Congés spéciaux',
    titre_article: 'Congé de formation syndicale',
    texte: 'Les délégués syndicaux et membres des instances de représentation ont droit à des congés de formation syndicale d\'une durée maximale de 15 jours par an, non déductibles des congés annuels.',
    keywords: ['congé syndical', 'formation syndicale', '15 jours', 'délégués'] },

  // ─── MALADIE ET ACCIDENTS ─────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-42-1', article_numero: 'Art. 42.1', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. I — Maladie non professionnelle',
    titre_article: 'Maintien de salaire maladie — Règle du 100%',
    texte: 'En cas de maladie non professionnelle dûment constatée par un médecin agréé et notifiée dans les 48h, l\'employeur maintient : 100% du salaire le 1er mois pour cadres et agents de maîtrise, puis 50% les 2 mois suivants. Pour les ouvriers : 50% dès le 1er mois.',
    keywords: ['maladie', 'arrêt maladie', 'maintien 100%', 'certificat médical', '48 heures'], payroll_codes: ['1800'] },

  { ...P, source: CT, article_id: 'art-42-2', article_numero: 'Art. 42.2', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. I — Maladie non professionnelle',
    titre_article: 'Rupture du contrat pour maladie prolongée',
    texte: 'L\'employeur peut rompre le contrat si l\'absence pour maladie se prolonge au-delà de 6 mois et s\'il est dans la nécessité absolue de remplacer définitivement le salarié. Cette rupture ouvre droit à l\'indemnité de licenciement.',
    keywords: ['maladie prolongée', '6 mois', 'remplacement', 'indemnité licenciement'] },

  { ...P, source: CT, article_id: 'art-42-3', article_numero: 'Art. 42.3', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. I — Maladie non professionnelle',
    titre_article: 'Notification de l\'arrêt maladie',
    texte: 'Le salarié doit informer son employeur de son absence dans les 48 heures et lui faire parvenir un certificat médical. L\'employeur peut faire procéder à une contre-visite médicale. En cas de refus du salarié, le maintien de salaire peut être suspendu.',
    keywords: ['arrêt maladie', 'notification 48h', 'certificat médical', 'contre-visite'] },

  { ...P, source: CT, article_id: 'art-53-1', article_numero: 'Art. 53.1', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. II — Accidents du travail',
    titre_article: 'Définition de l\'accident du travail',
    texte: 'Est accident du travail, quelle qu\'en soit la cause, l\'accident survenu par le fait ou à l\'occasion du travail à toute personne salariée. L\'accident survenu pendant le trajet domicile-travail est assimilé à un accident du travail.',
    keywords: ['accident travail', 'AT', 'définition', 'trajet domicile travail'] },

  { ...P, source: CT, article_id: 'art-53-2', article_numero: 'Art. 53.2', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. II — Accidents du travail',
    titre_article: 'Déclaration et prise en charge AT',
    texte: 'L\'employeur déclare tout accident du travail à la CNPS dans les 48 heures. Le jour de l\'accident est payé intégralement par l\'employeur. À compter du lendemain, la CNPS prend en charge les indemnités journalières (IJ AT), exonérées d\'ITS et de cotisations sociales.',
    keywords: ['déclaration AT', 'CNPS 48h', 'indemnités journalières', 'exonération ITS', 'jour J employeur'], payroll_codes: ['1900'] },

  { ...P, source: CT, article_id: 'art-53-3', article_numero: 'Art. 53.3', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. II — Accidents du travail',
    titre_article: 'Maladie professionnelle',
    texte: 'Les maladies professionnelles sont assimilées aux accidents du travail. La liste des maladies reconnues est fixée par décret. Le délai de prise en charge court à compter de la première constatation médicale. L\'employeur supporte le coût de la cotisation AT.',
    keywords: ['maladie professionnelle', 'AT', 'liste décret', 'cotisation patronale'] },

  { ...P, source: CT, article_id: 'art-53-5', article_numero: 'Art. 53.5', livre: LI,
    titre: 'Titre V — Maladie et accident', chapitre: 'Chap. II — Accidents du travail',
    titre_article: 'Incapacité permanente — Indemnisation',
    texte: 'Lorsque l\'accident du travail entraîne une incapacité permanente, le salarié perçoit de la CNPS une rente calculée sur son salaire annuel et le taux d\'incapacité reconnu. En cas de décès, une rente de survie est versée aux ayants droit.',
    keywords: ['incapacité permanente', 'rente AT', 'décès AT', 'ayants droit'] },

  // ─── RÉMUNÉRATION ─────────────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-32-1', article_numero: 'Art. 32.1', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. I — SMIG',
    titre_article: 'Salaire Minimum Interprofessionnel Garanti (SMIG)',
    texte: 'Aucun employeur ne peut rémunérer un salarié en deçà du SMIG fixé par décret. Le SMIG est actuellement de 60 000 FCFA/mois (revalorisation 2023). En cas de non-respect, l\'employeur est passible de sanctions pénales.',
    keywords: ['SMIG', 'salaire minimum', '60000 FCFA', 'minimum légal'], payroll_codes: ['1000'] },

  { ...P, source: CT, article_id: 'art-32-2', article_numero: 'Art. 32.2', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. I — SMIG',
    titre_article: 'Éléments constitutifs du salaire',
    texte: 'Le salaire comprend : le salaire de base, les primes et indemnités (ancienneté, rendement, transport, logement), les avantages en nature évalués selon les barèmes fixés par la convention collective.',
    keywords: ['salaire', 'primes', 'indemnités', 'avantages nature', 'éléments salaire'] },

  { ...P, source: CT, article_id: 'art-32-3', article_numero: 'Art. 32.3', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. I — SMIG',
    titre_article: 'Prime d\'ancienneté — Obligation légale',
    texte: 'Tout salarié bénéficie d\'une prime d\'ancienneté à partir de 3 ans d\'ancienneté dans l\'entreprise. Les taux minimaux : 3% à partir de 3 ans, 5% à partir de 5 ans, 8% à partir de 8 ans, 10% à partir de 10 ans. La convention collective peut prévoir des taux plus favorables.',
    keywords: ['prime ancienneté', 'obligatoire', '3 ans', 'taux ancienneté'], payroll_codes: ['1100'] },

  { ...P, source: CT, article_id: 'art-32-4', article_numero: 'Art. 32.4', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. I — SMIG',
    titre_article: 'Égalité de rémunération H/F',
    texte: 'À qualification et travail équivalents, la rémunération ne peut varier selon le sexe du salarié. L\'employeur qui applique des écarts de rémunération non justifiés par des critères objectifs est passible de sanctions. Le principe est "à travail égal, salaire égal".',
    keywords: ['égalité H/F', 'salaire égal', 'discrimination salariale', 'travail égal'] },

  { ...P, source: CT, article_id: 'art-32-5', article_numero: 'Art. 32.5', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. II — Paiement',
    titre_article: 'Modalités et périodicité de paiement',
    texte: 'Le salaire mensuel est payé au moins une fois par mois, à date fixe. Il peut être payé en espèces ou par virement bancaire/Mobile Money. L\'employeur remet un bulletin de paie détaillé à chaque paiement. Le bulletin doit mentionner toutes les rubriques (gains et retenues).',
    keywords: ['paiement salaire', 'mensuel', 'bulletin paie', 'virement', 'Mobile Money'] },

  { ...P, source: CT, article_id: 'art-32-6', article_numero: 'Art. 32.6', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. II — Paiement',
    titre_article: 'Avance sur salaire',
    texte: 'L\'employeur peut consentir une avance sur salaire. La retenue mensuelle ne peut dépasser 1/3 du salaire net. Toute retenue sur salaire autre que légale, conventionnelle ou à titre d\'avance approuvée doit faire l\'objet d\'un accord écrit du salarié.',
    keywords: ['avance salaire', 'retenue', '1/3 salaire', 'accord écrit'], payroll_codes: ['5000'] },

  { ...P, source: CT, article_id: 'art-33-1', article_numero: 'Art. 33.1', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. III — Heures supplémentaires',
    titre_article: 'Heures supplémentaires — Majorations légales',
    texte: 'Les heures supplémentaires effectuées au-delà de 40h/semaine sont majorées de : 15% pour les 8 premières heures supp. (41e–48e h), 50% pour les heures de nuit (20h–5h) et du dimanche, 100% pour les jours fériés. Le repos compensateur peut remplacer la majoration.',
    keywords: ['heures supplémentaires', 'majoration 15%', 'majoration 50%', 'nuit', 'dimanche', 'férié'], payroll_codes: ['1400', '1500'] },

  { ...P, source: CT, article_id: 'art-33-2', article_numero: 'Art. 33.2', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. III — Heures supplémentaires',
    titre_article: 'Autorisation et plafond des heures supplémentaires',
    texte: 'Les heures supplémentaires doivent être autorisées par l\'employeur. Le contingent annuel d\'heures supplémentaires est fixé par décret (120h). Au-delà, une autorisation de l\'Inspection du Travail est requise.',
    keywords: ['autorisation heures supp', 'contingent', '120 heures', 'inspection travail'] },

  { ...P, source: CT, article_id: 'art-33-3', article_numero: 'Art. 33.3', livre: LI,
    titre: 'Titre VI — Rémunération', chapitre: 'Chap. III — Heures supplémentaires',
    titre_article: 'Durée maximale de travail',
    texte: 'La durée légale de travail est de 40 heures par semaine (8h/j × 5j). Elle peut être portée à 48 heures en cas de nécessité. Au-delà, le repos compensateur est obligatoire. Les heures de nuit (20h–5h) sont limitées à 8h par nuit.',
    keywords: ['durée légale', '40 heures', '48 heures', 'repos compensateur'] },

  // ─── SÉCURITÉ ET SANTÉ AU TRAVAIL ────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-41-1', article_numero: 'Art. 41.1', livre: LI,
    titre: 'Titre VII — Sécurité et santé', chapitre: 'Chap. I — Obligations générales',
    titre_article: 'Obligations de sécurité de l\'employeur',
    texte: 'L\'employeur est tenu d\'assurer la sécurité et la santé des travailleurs dans tous les aspects liés au travail. Il doit prendre les mesures de prévention nécessaires, organiser les secours, et informer les travailleurs des risques liés à leur poste.',
    keywords: ['sécurité travail', 'santé', 'prévention', 'risques professionnels'] },

  { ...P, source: CT, article_id: 'art-41-2', article_numero: 'Art. 41.2', livre: LI,
    titre: 'Titre VII — Sécurité et santé', chapitre: 'Chap. I — Obligations générales',
    titre_article: 'Équipements de protection individuelle (EPI)',
    texte: 'L\'employeur fournit gratuitement les équipements de protection individuelle adaptés aux risques du poste. Le salarié est tenu de les utiliser. Le refus répété constitue une faute pouvant justifier une sanction disciplinaire.',
    keywords: ['EPI', 'équipement protection', 'gratuit', 'obligation port EPI'] },

  { ...P, source: CT, article_id: 'art-41-5', article_numero: 'Art. 41.5', livre: LI,
    titre: 'Titre VII — Sécurité et santé', chapitre: 'Chap. II — Médecine du travail',
    titre_article: 'Médecine du travail — Visite médicale',
    texte: 'Tout salarié bénéficie d\'un suivi médical assuré par un médecin du travail. La visite médicale d\'embauche est obligatoire. Des visites périodiques ont lieu au moins une fois par an. Les frais sont à la charge de l\'employeur.',
    keywords: ['médecine travail', 'visite médicale', 'embauche', 'périodique', 'médecin travail'] },

  { ...P, source: CT, article_id: 'art-41-6', article_numero: 'Art. 41.6', livre: LI,
    titre: 'Titre VII — Sécurité et santé', chapitre: 'Chap. II — Médecine du travail',
    titre_article: 'Comité d\'Hygiène et de Sécurité (CHS)',
    texte: 'Dans les établissements occupant au moins 50 salariés, un Comité d\'Hygiène et de Sécurité (CHS) est constitué. Il est composé paritairement d\'employeurs et de salariés élus. Il se réunit au moins une fois par trimestre et enquête sur les accidents du travail.',
    keywords: ['CHS', 'comité hygiène sécurité', '50 salariés', 'paritaire', 'accident travail'] },

  // ─── PROTECTION CATÉGORIES SPÉCIALES ─────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-44-1', article_numero: 'Art. 44.1', livre: LI,
    titre: 'Titre VIII — Catégories spéciales', chapitre: 'Chap. I — Travailleurs mineurs',
    titre_article: 'Âge minimum de travail — 16 ans',
    texte: 'L\'âge minimum d\'admission au travail est fixé à 16 ans. Les mineurs âgés de 16 à 18 ans bénéficient d\'une protection particulière : durée de travail réduite à 7h/jour, interdiction de travail de nuit, de jours fériés et de tâches dangereuses.',
    keywords: ['travail mineur', '16 ans', 'âge minimum', 'protection mineur', 'travail nuit interdit'] },

  { ...P, source: CT, article_id: 'art-44-2', article_numero: 'Art. 44.2', livre: LI,
    titre: 'Titre VIII — Catégories spéciales', chapitre: 'Chap. II — Travailleurs handicapés',
    titre_article: 'Emploi des travailleurs handicapés — Quota',
    texte: 'Les entreprises de plus de 25 salariés sont tenues d\'employer des travailleurs handicapés à hauteur d\'au moins 5% de leur effectif. Le non-respect de cette obligation donne lieu à une contribution versée au Fonds de soutien à l\'emploi des handicapés.',
    keywords: ['handicapé', 'quota 5%', 'fonds emploi handicapé', '25 salariés'] },

  { ...P, source: CT, article_id: 'art-45-1', article_numero: 'Art. 45.1', livre: LI,
    titre: 'Titre VIII — Catégories spéciales', chapitre: 'Chap. III — Travailleurs étrangers',
    titre_article: 'Autorisation de travail pour travailleurs étrangers',
    texte: 'Tout employeur qui recrute un travailleur étranger doit obtenir une autorisation de travail délivrée par le ministère du travail. Le contrat doit être établi par écrit et enregistré. La violation expose l\'employeur à des sanctions pénales et administratives.',
    keywords: ['travailleur étranger', 'autorisation travail', 'contrat écrit', 'enregistrement'] },

  // ─── LIVRE II — RELATIONS COLLECTIVES ────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-61-1', article_numero: 'Art. 61.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre I — Conventions collectives',
    titre_article: 'Définition et portée des conventions collectives',
    texte: 'La convention collective est un accord écrit conclu entre syndicats de travailleurs et employeurs pour régler les conditions d\'emploi. Elle peut être étendue par arrêté ministériel, la rendant applicable à toutes les entreprises du secteur, qu\'elles soient ou non adhérentes.',
    keywords: ['convention collective', 'accord collectif', 'extension', 'syndicat'] },

  { ...P, source: CT, article_id: 'art-61-2', article_numero: 'Art. 61.2',
    livre: 'Livre II — Relations collectives', titre: 'Titre I — Conventions collectives',
    titre_article: 'Négociation de branche',
    texte: 'Les organisations syndicales représentatives et les organisations patronales sont tenues de se réunir au moins une fois par an pour négocier sur les salaires minima par catégorie, les conditions de travail, les modalités du droit à la formation.',
    keywords: ['négociation annuelle', 'branche', 'salaires minima', 'syndicats représentatifs'] },

  { ...P, source: CT, article_id: 'art-62-1', article_numero: 'Art. 62.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre I — Conventions collectives',
    titre_article: 'Hiérarchie des normes en droit social CI',
    texte: 'En cas de conflit entre la convention collective et le contrat de travail individuel, les dispositions du contrat individuel prévalent si elles sont plus favorables au salarié. La loi fixe le minimum ; la convention collective peut y ajouter ; le contrat peut encore améliorer.',
    keywords: ['hiérarchie normes', 'faveur salarié', 'contrat convention', 'plus favorable'] },

  { ...P, source: CT, article_id: 'art-65-1', article_numero: 'Art. 65.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre II — Liberté syndicale',
    titre_article: 'Liberté syndicale — Droit fondamental',
    texte: 'La liberté syndicale est garantie à tous les travailleurs. Tout salarié peut adhérer librement à un syndicat de son choix. Aucun employeur ne peut prendre en considération l\'appartenance syndicale lors d\'un recrutement, d\'une promotion ou d\'un licenciement.',
    keywords: ['liberté syndicale', 'droit syndical', 'discrimination syndicale', 'adhésion libre'] },

  { ...P, source: CT, article_id: 'art-65-2', article_numero: 'Art. 65.2',
    livre: 'Livre II — Relations collectives', titre: 'Titre II — Liberté syndicale',
    titre_article: 'Délégué syndical — Statut protecteur',
    texte: 'Le délégué syndical bénéficie d\'un statut protecteur : son licenciement est soumis à l\'autorisation préalable de l\'Inspection du Travail. Il dispose d\'un crédit d\'heures mensuel de 10 heures pour exercer ses fonctions syndicales.',
    keywords: ['délégué syndical', 'protection licenciement', 'inspection travail', '10 heures délégation'] },

  { ...P, source: CT, article_id: 'art-70-1', article_numero: 'Art. 70.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre III — Représentation du personnel',
    titre_article: 'Délégués du personnel — Seuil et élections',
    texte: 'Tout établissement occupant au moins 10 salariés de façon habituelle est tenu de procéder à l\'élection de délégués du personnel. Les élections ont lieu tous les 2 ans. Les délégués bénéficient d\'une protection spéciale contre le licenciement.',
    keywords: ['délégués personnel', '10 salariés', 'élections', 'protection licenciement'] },

  { ...P, source: CT, article_id: 'art-70-2', article_numero: 'Art. 70.2',
    livre: 'Livre II — Relations collectives', titre: 'Titre III — Représentation du personnel',
    titre_article: 'Missions des délégués du personnel',
    texte: 'Les délégués du personnel ont pour mission de présenter à l\'employeur les réclamations individuelles et collectives relatives aux salaires, à l\'application du Code du Travail et des conventions collectives. Ils sont reçus en audience par l\'employeur au moins une fois par mois.',
    keywords: ['délégués personnel', 'missions', 'réclamations', 'audience mensuelle'] },

  { ...P, source: CT, article_id: 'art-70-3', article_numero: 'Art. 70.3',
    livre: 'Livre II — Relations collectives', titre: 'Titre III — Représentation du personnel',
    titre_article: 'Heures de délégation des délégués du personnel',
    texte: 'Chaque délégué du personnel titulaire bénéficie d\'un crédit de 15 heures par mois pour l\'exercice de ses fonctions. Ces heures sont payées comme du temps de travail. Le délégué peut les utiliser à tout moment, sur ou hors temps de travail.',
    keywords: ['heures délégation', '15 heures', 'délégué personnel', 'payées'] },

  { ...P, source: CT, article_id: 'art-72-1', article_numero: 'Art. 72.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre III — Représentation du personnel',
    titre_article: 'Comité d\'établissement — Seuil 50 salariés',
    texte: 'Toute entreprise employant au moins 50 salariés doit mettre en place un comité d\'établissement. Il est consulté sur les questions relatives à la gestion et à l\'organisation économique de l\'entreprise, notamment les licenciements collectifs.',
    keywords: ['comité établissement', '50 salariés', 'consultation', 'licenciement collectif'] },

  { ...P, source: CT, article_id: 'art-78-1', article_numero: 'Art. 78.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre III — Représentation du personnel',
    titre_article: 'Règlement intérieur — Contenu obligatoire',
    texte: 'Tout établissement de plus de 10 salariés doit établir un règlement intérieur. Il fixe les règles de discipline, les sanctions applicables (avertissement, mise à pied, licenciement), les mesures d\'hygiène et de sécurité. Il est soumis à l\'Inspection du Travail pour visa.',
    keywords: ['règlement intérieur', 'discipline', 'sanctions', 'inspection travail', 'visa'] },

  { ...P, source: CT, article_id: 'art-80-1', article_numero: 'Art. 80.1',
    livre: 'Livre II — Relations collectives', titre: 'Titre IV — Grève',
    titre_article: 'Droit de grève',
    texte: 'Le droit de grève est reconnu aux travailleurs. La grève est un arrêt collectif et concerté du travail. Elle suspend le contrat de travail. Les salaires des jours de grève ne sont pas dus.',
    keywords: ['grève', 'droit grève', 'suspension contrat', 'salaires grève'] },

  { ...P, source: CT, article_id: 'art-80-2', article_numero: 'Art. 80.2',
    livre: 'Livre II — Relations collectives', titre: 'Titre IV — Grève',
    titre_article: 'Préavis de grève — Service minimum',
    texte: 'Dans les entreprises de service public, un préavis de 10 jours doit être déposé avant toute grève. Un service minimum est obligatoire pour assurer la continuité des services essentiels (eau, électricité, hôpital, transports). Son non-respect peut justifier des sanctions.',
    keywords: ['préavis grève', '10 jours', 'service minimum', 'service public', 'continuité'] },

  // ─── LIVRE III — DURÉE DU TRAVAIL ────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-21-1', article_numero: 'Art. 21.1',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Durée légale du travail — 40 heures hebdomadaires',
    texte: 'La durée légale de travail effectif est fixée à 40 heures par semaine pour tous les établissements et quelles que soient la forme juridique et la nature de l\'activité.',
    keywords: ['durée légale', '40 heures', 'hebdomadaire'] },

  { ...P, source: CT, article_id: 'art-21-2', article_numero: 'Art. 21.2',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Modulation du temps de travail',
    texte: 'Par accord collectif, la durée du travail peut être modulée sur l\'année : des semaines à plus de 40h compensent des semaines à moins de 40h. La durée annuelle ne peut dépasser 1 840 heures. Les heures excédentaires sont payées au taux majoré.',
    keywords: ['modulation', 'annualisation', 'accord collectif', '1840 heures'] },

  { ...P, source: CT, article_id: 'art-21-3', article_numero: 'Art. 21.3',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Travail posté et horaires décalés',
    texte: 'Le travail posté en 2x8, 3x8 ou équipes alternantes est autorisé avec accord de l\'Inspection du Travail. Les travailleurs postés bénéficient d\'une prime de poste dont le montant est fixé par la convention collective ou à défaut par accord d\'entreprise.',
    keywords: ['travail posté', '3x8', 'prime poste', 'équipes alternantes'] },

  { ...P, source: CT, article_id: 'art-21-5', article_numero: 'Art. 21.5',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Repos hebdomadaire obligatoire',
    texte: 'Le repos hebdomadaire est obligatoire. Il est au minimum de 24 heures consécutives, en principe le dimanche. Des dérogations sont possibles pour les entreprises dont l\'activité ne peut s\'interrompre.',
    keywords: ['repos hebdomadaire', '24 heures', 'dimanche', 'dérogation'] },

  { ...P, source: CT, article_id: 'art-21-6', article_numero: 'Art. 21.6',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Pause obligatoire',
    texte: 'Tout salarié travaillant plus de 6 heures consécutives bénéficie d\'un temps de pause de 30 minutes minimum. Cette pause n\'est pas comptée comme du temps de travail effectif sauf disposition conventionnelle contraire.',
    keywords: ['pause', '30 minutes', '6 heures', 'temps de travail effectif'] },

  { ...P, source: CT, article_id: 'art-21-7', article_numero: 'Art. 21.7',
    livre: 'Livre III — Durée du travail', titre: 'Titre I — Durée légale',
    titre_article: 'Astreintes',
    texte: 'L\'astreinte est la période pendant laquelle le salarié doit être disponible pour intervenir. Elle est différente du travail effectif. Elle ouvre droit à une compensation (financière ou en repos) fixée par accord. En cas d\'intervention, le temps est du travail effectif.',
    keywords: ['astreinte', 'disponibilité', 'compensation', 'intervention', 'travail effectif'] },

  { ...P, source: CT, article_id: 'art-21-8', article_numero: 'Art. 21.8',
    livre: 'Livre III — Durée du travail', titre: 'Titre II — Jours fériés',
    titre_article: 'Jours fériés légaux en Côte d\'Ivoire',
    texte: 'Les jours fériés légaux en CI sont : 1er janvier, Lundi de Pâques, 1er mai (Fête du Travail), Ascension, Lundi de Pentecôte, 7 août (Fête nationale), 15 août (Assomption), 1er novembre (Toussaint), 15 novembre (Journée de la Paix), 25 décembre, ainsi que les fêtes musulmanes (Eid Al-Fitr, Eid Al-Adha, Mouloud) aux dates variables.',
    keywords: ['jours fériés', 'fête nationale', 'fête travail', '7 août', 'CI', 'fêtes musulmanes'] },

  { ...P, source: CT, article_id: 'art-21-9', article_numero: 'Art. 21.9',
    livre: 'Livre III — Durée du travail', titre: 'Titre II — Jours fériés',
    titre_article: 'Travail un jour férié',
    texte: 'Le travail effectué un jour férié légal est majoré de 100% du salaire horaire. Pour les entreprises où le travail s\'impose (hôtels, hôpitaux, sécurité), un repos compensateur équivalent peut remplacer la majoration financière.',
    keywords: ['travail férié', 'majoration 100%', 'repos compensateur', 'férié travaillé'] },

  // ─── LIVRE IV — FORMATION PROFESSIONNELLE ─────────────────────────────────────
  { ...P, source: CT, article_id: 'art-15-1', article_numero: 'Art. 15.1',
    livre: 'Livre IV — Formation professionnelle', titre: 'Titre I — Formation',
    titre_article: 'Obligation de formation — FDFP',
    texte: 'Tout employeur de plus de 10 salariés est tenu de contribuer au financement de la formation professionnelle à raison de 0,4% de la masse salariale brute, versé au FDFP (Fonds de Développement de la Formation Professionnelle). Les formations agréées FDFP donnent lieu à remboursement partiel.',
    keywords: ['FDFP', 'formation professionnelle', '0,4%', 'masse salariale', 'remboursement'] },

  { ...P, source: CT, article_id: 'art-15-2', article_numero: 'Art. 15.2',
    livre: 'Livre IV — Formation professionnelle', titre: 'Titre I — Formation',
    titre_article: 'Plan de formation — Obligations',
    texte: 'L\'employeur élabore chaque année un plan de formation après consultation des délégués du personnel. Il recense les besoins en formation, les formations envisagées, leur durée et leur coût. Le plan est présenté au comité d\'établissement ou aux délégués du personnel.',
    keywords: ['plan formation', 'annuel', 'délégués personnel', 'consultation'] },

  { ...P, source: CT, article_id: 'art-15-3', article_numero: 'Art. 15.3',
    livre: 'Livre IV — Formation professionnelle', titre: 'Titre I — Formation',
    titre_article: 'Congé individuel de formation (CIF)',
    texte: 'Tout salarié ayant 2 ans d\'ancienneté peut bénéficier d\'un congé individuel de formation d\'une durée maximale de 6 mois pour se former à son initiative. La demande doit être faite 4 mois avant le début. L\'employeur ne peut refuser que pour raisons de service.',
    keywords: ['CIF', 'congé formation', '2 ans ancienneté', '6 mois', 'initiative salarié'] },

  { ...P, source: CT, article_id: 'art-15-4', article_numero: 'Art. 15.4',
    livre: 'Livre IV — Formation professionnelle', titre: 'Titre II — FDFP',
    titre_article: 'FDFP — Remboursement des formations',
    texte: 'Le FDFP rembourse partiellement les coûts de formation des salariés à condition que : la formation soit agréée FDFP, l\'entreprise soit à jour de ses cotisations, la formation se déroule dans un centre agréé. Le taux de remboursement varie selon le type de formation (40 à 70%).',
    keywords: ['FDFP', 'remboursement', 'agrément', 'centre agréé', 'taux remboursement'] },

  { ...P, source: CT, article_id: 'art-15-5', article_numero: 'Art. 15.5',
    livre: 'Livre IV — Formation professionnelle', titre: 'Titre III — Apprentissage',
    titre_article: 'Contrat d\'apprentissage',
    texte: 'Le contrat d\'apprentissage est un contrat de travail particulier associant formation théorique (centre de formation) et formation pratique en entreprise. La durée est de 1 à 3 ans. L\'apprenti perçoit une rémunération minimale fixée par décret.',
    keywords: ['apprentissage', 'contrat apprentissage', 'formation', 'alternance'] },

  // ─── LIVRE V — PROTECTION SOCIALE CNPS ────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-55-1', article_numero: 'Art. 55.1',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Affiliation obligatoire à la CNPS',
    texte: 'Tout employeur est tenu d\'affilier ses salariés à la CNPS (Caisse Nationale de Prévoyance Sociale) dès le premier jour d\'embauche. Les cotisations sont dues dès le premier franc de salaire. Le défaut d\'affiliation est une infraction pénale.',
    keywords: ['CNPS', 'affiliation', 'obligation', 'cotisations', 'pénale'] },

  { ...P, source: CT, article_id: 'art-55-2', article_numero: 'Art. 55.2',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Cotisations CNPS 2024 — Taux et plafonds',
    texte: 'Cotisations CNPS 2024 : Retraite : 6,3% salarié + 7,7% patronal (plafond 1 647 315 FCFA/mois). Prestations familiales : 5% patronal (plafond 70 000 FCFA/mois). Assurance maternité : 0,75% patronal (plafond 70 000 FCFA/mois). AT : 2 à 5% patronal selon secteur (plafond 70 000 FCFA/mois).',
    keywords: ['CNPS', 'taux cotisations', 'retraite 6,3%', '7,7%', 'prestations familiales', 'plafond'], payroll_codes: ['2000', '3000', '3100', '3200', '3300'] },

  { ...P, source: CT, article_id: 'art-55-3', article_numero: 'Art. 55.3',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Allocations familiales CNPS',
    texte: 'Les allocations familiales sont versées aux salariés pour leurs enfants à charge de moins de 21 ans (25 ans s\'ils poursuivent des études). Montant : 2 000 FCFA/mois par enfant. Elles sont financées par la cotisation patronale de 5% dans la limite du plafond de 70 000 FCFA.',
    keywords: ['allocations familiales', '2000 FCFA', 'enfant charge', 'CNPS', 'cotisation patronale'] },

  { ...P, source: CT, article_id: 'art-55-4', article_numero: 'Art. 55.4',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Pension de retraite CNPS — Conditions',
    texte: 'L\'âge légal de départ à la retraite est de 60 ans (55 ans pour les travaux pénibles). Pour liquider sa pension, le salarié doit justifier d\'au moins 15 ans de cotisations. La pension est calculée sur la base des salaires cotisés et du taux d\'annuité.',
    keywords: ['retraite', '60 ans', '55 ans pénible', '15 ans cotisations', 'pension CNPS', 'liquidation'] },

  { ...P, source: CT, article_id: 'art-55-5', article_numero: 'Art. 55.5',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Déclaration CNPS — e-CNPS et DISA',
    texte: 'L\'employeur est tenu de déclarer mensuellement les salaires versés via la plateforme e-CNPS avant le 15 du mois suivant. La DISA (Déclaration Individuelle Salaires Annuels) est due avant fin janvier de l\'année N+1. Le non-dépôt entraîne des majorations de retard.',
    keywords: ['e-CNPS', 'DISA', 'déclaration mensuelle', 'avant le 15', 'DISA annuelle'] },

  { ...P, source: CT, article_id: 'art-55-6', article_numero: 'Art. 55.6',
    livre: 'Livre V — Protection sociale', titre: 'Titre I — CNPS',
    titre_article: 'Sanctions pour non-paiement des cotisations CNPS',
    texte: 'En cas de retard de paiement des cotisations, des majorations de retard de 1,5% par mois sont appliquées. En cas de non-paiement répété, la CNPS peut procéder à une mise en demeure, puis à un redressement forcé. La responsabilité pénale du dirigeant peut être engagée.',
    keywords: ['sanction CNPS', 'majorations retard', '1,5%', 'redressement', 'responsabilité pénale'] },

  { ...P, source: CT, article_id: 'art-56-1', article_numero: 'Art. 56.1',
    livre: 'Livre V — Protection sociale', titre: 'Titre II — Prestations AT/Maladie pro',
    titre_article: 'Indemnités journalières AT — Calcul CNPS',
    texte: 'Les indemnités journalières AT versées par la CNPS sont calculées sur la base de 2/3 du salaire journalier moyen des 3 derniers mois dans la limite du plafond CNPS. Elles sont versées dès le 2e jour d\'arrêt (le 1er jour restant à la charge de l\'employeur). Elles sont exonérées d\'ITS.',
    keywords: ['IJ AT', '2/3 salaire', 'plafond CNPS', 'exonéré ITS', 'CNPS 2ème jour'], payroll_codes: ['1900'] },

  { ...P, source: CT, article_id: 'art-57-1', article_numero: 'Art. 57.1',
    livre: 'Livre V — Protection sociale', titre: 'Titre III — Maternité CNPS',
    titre_article: 'Indemnités journalières maternité CNPS',
    texte: 'Les indemnités journalières de maternité sont prises en charge par la CNPS. L\'employeur les avance au salarié et en obtient le remboursement auprès de la CNPS. Leur montant est égal à 100% du salaire journalier moyen plafonné. Elles sont exonérées d\'ITS et de cotisations CNPS.',
    keywords: ['maternité CNPS', 'indemnités journalières', 'avance employeur', 'remboursement CNPS', 'exonéré ITS'], payroll_codes: ['1700'] },

  { ...P, source: CT, article_id: 'art-57-2', article_numero: 'Art. 57.2',
    livre: 'Livre V — Protection sociale', titre: 'Titre III — Maternité CNPS',
    titre_article: 'Bordereau de remboursement CNPS — Maternité',
    texte: 'Pour obtenir le remboursement des indemnités de maternité avancées, l\'employeur soumet à la CNPS : le bordereau de remboursement, le certificat médical d\'accouchement, le justificatif de paiement au salarié, la déclaration de salaire du mois concerné.',
    keywords: ['bordereau remboursement', 'CNPS maternité', 'certificat accouchement', 'remboursement employeur'] },

  // ─── ITS — IMPÔT SUR LES TRAITEMENTS ET SALAIRES ────────────────────────────
  { ...P, source: CT, article_id: 'art-its-1', article_numero: 'CGI Art. 116',
    livre: 'Fiscal — ITS / DGI', titre: 'Impôt sur les Traitements et Salaires',
    titre_article: 'ITS — Barème progressif DGI CI 2024',
    texte: 'L\'ITS est calculé sur le salaire net imposable après abattement forfaitaire de 15% du brut. Barème mensuel : 0–75 000 FCFA → 0% ; 75 001–240 000 FCFA → 1,5% ; 240 001–800 000 FCFA → 5% ; 800 001–2 000 000 FCFA → 10% ; au-delà → 15%. Crédits famille : marié +5 500 FCFA, par enfant +3 000 à +9 000 FCFA.',
    keywords: ['ITS', 'impôt salaires', 'barème DGI', 'abattement 15%', 'crédit impôt famille'], payroll_codes: ['2100'] },

  { ...P, source: CT, article_id: 'art-its-2', article_numero: 'CGI Art. 117',
    livre: 'Fiscal — ITS / DGI', titre: 'Impôt sur les Traitements et Salaires',
    titre_article: 'ITS — Revenus exonérés',
    texte: 'Sont exonérés d\'ITS : les indemnités journalières d\'accident du travail (AT), les indemnités de maternité versées par la CNPS, les allocations familiales CNPS, les remboursements de frais professionnels sur justificatifs, les indemnités de licenciement dans la limite légale.',
    keywords: ['exonération ITS', 'AT exonéré', 'maternité exonérée', 'allocations familiales'], payroll_codes: ['1700', '1900'] },

  { ...P, source: CT, article_id: 'art-its-3', article_numero: 'CGI Art. 118',
    livre: 'Fiscal — ITS / DGI', titre: 'Impôt sur les Traitements et Salaires',
    titre_article: 'ITS — Retenue à la source et reversement DGI',
    texte: 'L\'ITS est retenu à la source par l\'employeur sur chaque bulletin de paie. Il doit être reversé à la DGI (Direction Générale des Impôts) au plus tard le 10 du mois suivant la paie. Le non-reversement expose l\'employeur à des pénalités de 10% et des intérêts de retard.',
    keywords: ['retenue source ITS', 'reversement DGI', 'avant le 10', 'pénalités 10%'] },

  { ...P, source: CT, article_id: 'art-its-4', article_numero: 'CGI Art. 120',
    livre: 'Fiscal — ITS / DGI', titre: 'Impôt sur les Traitements et Salaires',
    titre_article: 'ITS — Crédit d\'impôt famille (CIF)',
    texte: 'Le crédit d\'impôt famille est accordé en fonction de la situation familiale : Célibataire/divorcé sans enfant : 0 FCFA. Marié sans enfant : 5 500 FCFA/mois. 1 enfant à charge : +3 000 FCFA. 2 enfants : +6 000 FCFA. 3 enfants et plus : +9 000 FCFA.',
    keywords: ['crédit impôt famille', 'CIF', 'situation familiale', 'enfants charge', '5500 FCFA'], payroll_codes: ['2100'] },

  { ...P, source: CT, article_id: 'art-its-5', article_numero: 'CGI Art. 122',
    livre: 'Fiscal — ITS / DGI', titre: 'Impôt sur les Traitements et Salaires',
    titre_article: 'ITS — Déclaration annuelle des salaires DGI',
    texte: 'Chaque employeur doit déposer auprès de la DGI, avant le 31 mars de chaque année, une déclaration récapitulative des salaires versés l\'année précédente. Cette déclaration, cohérente avec la DISA CNPS, liste par salarié : NNI, nom, prénoms, salaires bruts, cotisations, ITS payé.',
    keywords: ['déclaration annuelle DGI', 'avant 31 mars', 'NNI', 'DISA', 'récapitulatif salaires'] },

  // ─── OHADA ────────────────────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-ohada-1', article_numero: 'OHADA — AUDTS',
    livre: 'OHADA — Droit du travail', titre: 'Acte Uniforme relatif au Droit du Travail',
    titre_article: 'Acte Uniforme OHADA — Droit du travail (AUDTS)',
    texte: 'L\'Acte Uniforme OHADA relatif au Droit du Travail fixe les règles communes aux pays membres. En CI, il s\'applique en complément du Code du Travail CI. Les contrats de travail doivent être conformes aux deux textes. En cas de conflit, la disposition plus favorable au salarié prévaut.',
    keywords: ['OHADA', 'AUDTS', 'acte uniforme', 'droit travail', 'harmonisation'] },

  { ...P, source: CT, article_id: 'art-ohada-2', article_numero: 'OHADA — Contrats',
    livre: 'OHADA — Droit du travail', titre: 'Contrats de travail OHADA',
    titre_article: 'Contrats OHADA — Mentions obligatoires',
    texte: 'Tout contrat de travail conforme à l\'OHADA doit mentionner : identité des parties, lieu de travail, nature du poste, convention collective applicable, période d\'essai, rémunération (devise FCFA), affiliation CNPS, NNI du salarié. L\'absence de mention peut entraîner la requalification.',
    keywords: ['contrat OHADA', 'mentions obligatoires', 'NNI', 'CNPS', 'FCFA'] },

  { ...P, source: CT, article_id: 'art-ohada-3', article_numero: 'OHADA — SYSCOHADA',
    livre: 'OHADA — Droit du travail', titre: 'Comptabilité et charges sociales',
    titre_article: 'SYSCOHADA — Charges de personnel CI',
    texte: 'Selon le SYSCOHADA (Système Comptable OHADA), les charges de personnel comprennent : salaires bruts (6111), cotisations sociales patronales CNPS (6311), mutuelle et assurance complémentaire (6312), formation professionnelle FDFP (6321). Ces comptes sont obligatoires pour les entreprises CI soumises à l\'OHADA.',
    keywords: ['SYSCOHADA', 'comptabilité', 'charges personnel', '6111', '6311', 'CNPS comptabilité'] },

  { ...P, source: CT, article_id: 'art-ohada-4', article_numero: 'OHADA — RCCM',
    livre: 'OHADA — Droit du travail', titre: 'Formalités administratives',
    titre_article: 'RCCM — Registre du Commerce et du Crédit Mobilier',
    texte: 'Toute entreprise établie en CI doit être immatriculée au RCCM (Registre du Commerce et du Crédit Mobilier) auprès du Tribunal de Commerce. Le numéro RCCM doit figurer sur tous les contrats de travail et bulletins de paie. Sans RCCM, l\'activité est clandestine.',
    keywords: ['RCCM', 'immatriculation', 'registre commerce', 'Tribunal Commerce', 'entreprise CI'] },

  // ─── INSPECTION ET SANCTIONS ──────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-91-1', article_numero: 'Art. 91.1',
    livre: 'Livre VI — Inspection du travail', titre: 'Titre I — Missions',
    titre_article: 'Missions de l\'inspection du travail',
    texte: 'L\'inspecteur du travail est chargé d\'assurer l\'application des lois et règlements du travail. Il peut pénétrer dans tout établissement sans avis préalable, exiger la communication de tout document, dresser procès-verbal des infractions constatées.',
    keywords: ['inspection travail', 'inspecteur', 'contrôle', 'procès-verbal'] },

  { ...P, source: CT, article_id: 'art-91-2', article_numero: 'Art. 91.2',
    livre: 'Livre VI — Inspection du travail', titre: 'Titre I — Missions',
    titre_article: 'Documents obligatoires devant l\'inspecteur',
    texte: 'L\'employeur doit tenir à disposition de l\'inspecteur : registre du personnel, registre des accidents du travail, bulletins de paie, contrats de travail, registre des délégués du personnel, document unique d\'évaluation des risques.',
    keywords: ['registre personnel', 'documents inspection', 'bulletins paie', 'contrats'] },

  { ...P, source: CT, article_id: 'art-92-1', article_numero: 'Art. 92.1',
    livre: 'Livre VI — Inspection du travail', titre: 'Titre II — Sanctions',
    titre_article: 'Sanctions pénales — Infractions au Code du Travail',
    texte: 'Les infractions aux dispositions du Code du Travail sont passibles d\'amendes allant de 100 000 à 5 000 000 FCFA selon la gravité, et/ou d\'une peine d\'emprisonnement de 1 à 6 mois. Le non-paiement du SMIG, le travail clandestin et le défaut d\'affiliation CNPS sont des infractions pénales.',
    keywords: ['sanctions', 'amendes', 'pénales', 'SMIG', 'travail clandestin'] },

  // ─── CONFLITS DU TRAVAIL ──────────────────────────────────────────────────────
  { ...P, source: CT, article_id: 'art-81-1', article_numero: 'Art. 81.1',
    livre: 'Livre VII — Conflits du travail', titre: 'Titre I — Conflits individuels',
    titre_article: 'Tribunal du Travail — Compétence',
    texte: 'Le tribunal du travail est compétent pour connaître des différends individuels nés à l\'occasion du contrat de travail entre employeurs et salariés. La procédure est gratuite. La tentative de conciliation est obligatoire avant tout jugement.',
    keywords: ['tribunal travail', 'litige', 'conciliation', 'compétence'] },

  { ...P, source: CT, article_id: 'art-81-2', article_numero: 'Art. 81.2',
    livre: 'Livre VII — Conflits du travail', titre: 'Titre I — Conflits individuels',
    titre_article: 'Délai de prescription des actions prud\'homales',
    texte: 'L\'action en justice liée à un contrat de travail se prescrit par 2 ans à compter du jour où celui qui l\'exerce a connu ou aurait dû connaître les faits lui permettant de l\'exercer. Pour les salaires, le délai est de 3 ans.',
    keywords: ['prescription', '2 ans', '3 ans salaires', 'action prud\'homal'] },

  { ...P, source: CT, article_id: 'art-82-1', article_numero: 'Art. 82.1',
    livre: 'Livre VII — Conflits du travail', titre: 'Titre II — Conflits collectifs',
    titre_article: 'Médiation et arbitrage des conflits collectifs',
    texte: 'Les conflits collectifs peuvent être soumis à médiation ou arbitrage. En cas d\'échec de la conciliation, le conflit est soumis à un médiateur désigné par l\'Inspecteur du Travail. La sentence arbitrale est obligatoire si les parties l\'ont accepté.',
    keywords: ['conflit collectif', 'médiation', 'arbitrage', 'inspecteur travail'] },
]

// ── CONVENTIONS COLLECTIVES ────────────────────────────────────────────────────
export const CONVENTIONS_COLLECTIVES: ArticleDroit[] = [

  // ─── CONVENTION INTERPROFESSIONNELLE CI ───────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'interprofessionnelle_ci',
    article_id: 'cc-ip-1', article_numero: 'Art. 1',
    livre: 'Convention Collective Interprofessionnelle CI', titre: 'Champ d\'application',
    titre_article: 'Convention Collective Interprofessionnelle CI — Champ d\'application',
    texte: 'La Convention Collective Interprofessionnelle CI (CCIP-CI) s\'applique à toutes les entreprises du secteur privé établies en Côte d\'Ivoire, quel que soit leur secteur d\'activité, à défaut de convention collective de branche plus favorable. Elle constitue le socle de base pour toute relation de travail en CI.',
    keywords: ['CCIP-CI', 'interprofessionnelle', 'toutes entreprises', 'secteur privé', 'socle'] },

  { ...P, source: 'convention_collective', convention_slug: 'interprofessionnelle_ci',
    article_id: 'cc-ip-2', article_numero: 'Art. 8',
    livre: 'Convention Collective Interprofessionnelle CI', titre: 'Rémunération',
    titre_article: 'Grille de classification interprofessionnelle CI',
    texte: 'La grille interprofessionnelle CI classe les emplois en 8 catégories. Chaque catégorie correspond à un coefficient et un salaire minimum. Le salaire de base ne peut être inférieur au SMIG. Les coefficients servent à calculer les minima de branche.',
    keywords: ['classification', '8 catégories', 'coefficient', 'salaire minimum', 'SMIG'] },

  { ...P, source: 'convention_collective', convention_slug: 'interprofessionnelle_ci',
    article_id: 'cc-ip-3', article_numero: 'Art. 15',
    livre: 'Convention Collective Interprofessionnelle CI', titre: 'Indemnités',
    titre_article: 'Indemnité de transport interprofessionnelle CI',
    texte: 'Tout salarié dont le lieu de travail est situé à plus de 3 km de son domicile a droit à une indemnité de transport. Le montant est fixé par arrêté conjoint des ministres du Travail et des Transports. Elle est exonérée d\'ITS et de CNPS dans la limite du plafond légal.',
    keywords: ['indemnité transport', 'domicile travail', 'exonérée ITS', 'CNPS transport'], payroll_codes: ['1300'] },

  { ...P, source: 'convention_collective', convention_slug: 'interprofessionnelle_ci',
    article_id: 'cc-ip-4', article_numero: 'Art. 22',
    livre: 'Convention Collective Interprofessionnelle CI', titre: 'Ancienneté',
    titre_article: 'Prime d\'ancienneté — Convention interprofessionnelle CI',
    texte: 'Selon la CCIP-CI : 3% après 3 ans, 5% après 5 ans, 7% après 7 ans, 10% après 10 ans, 12% après 12 ans, 15% après 15 ans et plus. La prime est calculée sur le salaire de base. Elle est due à tous les salariés sans condition.',
    keywords: ['prime ancienneté', 'CCIP-CI', '3%', '5%', '10%', '15%'], payroll_codes: ['1100'] },

  { ...P, source: 'convention_collective', convention_slug: 'interprofessionnelle_ci',
    article_id: 'cc-ip-5', article_numero: 'Art. 31',
    livre: 'Convention Collective Interprofessionnelle CI', titre: 'Formation',
    titre_article: 'Droit à la formation — Convention interprofessionnelle',
    texte: 'Chaque salarié bénéficie d\'un droit à la formation professionnelle continue. L\'employeur et le salarié s\'entendent sur les formations prioritaires dans le cadre du plan de formation. Le salarié peut demander une formation en dehors de son temps de travail.',
    keywords: ['droit formation', 'formation continue', 'plan formation', 'hors temps travail'] },

  // ─── TRANSPORT ────────────────────────────────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'transport_ci',
    article_id: 'cc-tp-1', article_numero: 'Art. 1',
    livre: 'Convention Collective — Transport CI', titre: 'Chap. I — Champ application',
    titre_article: 'Champ d\'application — Transport urbain et interurbain CI',
    texte: 'S\'applique aux entreprises de transport de voyageurs et de marchandises par route, aux sociétés de transport en commun (SOTRA, Yango, etc.), aux taxis et VTC exerçant en CI. Couvre : chauffeurs, contrôleurs, mécaniciens, guichetiers, personnel administratif.',
    keywords: ['transport', 'chauffeur', 'SOTRA', 'taxi', 'VTC', 'contrôleur'] },

  { ...P, source: 'convention_collective', convention_slug: 'transport_ci',
    article_id: 'cc-tp-5', article_numero: 'Art. 5',
    livre: 'Convention Collective — Transport CI', titre: 'Chap. II — Période essai',
    titre_article: 'Période d\'essai — Transport CI',
    texte: 'Chauffeur catégorie A (urbain) : 1 mois ; Chauffeur B (interurbain poids lourds) : 2 mois ; Mécanicien : 1 mois ; Cadre transport : 3 mois. Tout renouvellement doit être notifié par écrit avant l\'expiration de la période initiale.',
    keywords: ['essai transport', 'chauffeur', 'mécanicien', 'cadre transport'] },

  { ...P, source: 'convention_collective', convention_slug: 'transport_ci',
    article_id: 'cc-tp-15', article_numero: 'Art. 15',
    livre: 'Convention Collective — Transport CI', titre: 'Chap. IV — Rémunération',
    titre_article: 'Primes secteur Transport CI',
    texte: 'Primes spécifiques transport : Prime de transport : 25 000 à 45 000 FCFA selon grade. Prime de rendement : jusqu\'à 15% du salaire de base sur objectif. Prime d\'ancienneté : 5% après 3 ans, 8% après 5 ans, 12% après 10 ans. Prime de risque pour chauffeurs de nuit : +10%.',
    keywords: ['prime transport', 'prime rendement', 'prime ancienneté', 'prime risque nuit'], payroll_codes: ['1100', '1200', '1300'] },

  { ...P, source: 'convention_collective', convention_slug: 'transport_ci',
    article_id: 'cc-tp-20', article_numero: 'Art. 20',
    livre: 'Convention Collective — Transport CI', titre: 'Chap. V — Temps de travail',
    titre_article: 'Amplitude et conduite — Transport CI',
    texte: 'L\'amplitude journalière de travail d\'un chauffeur ne peut dépasser 14 heures. Le temps de conduite effectif est limité à 10 heures par jour. Une pause d\'au moins 30 minutes est obligatoire après 4h30 de conduite continue. Ces règles sont conformes à la réglementation CEDEAO.',
    keywords: ['amplitude conduite', '14 heures', '10 heures conduite', 'pause 30 min', 'CEDEAO'] },

  { ...P, source: 'convention_collective', convention_slug: 'transport_ci',
    article_id: 'cc-tp-28', article_numero: 'Art. 28',
    livre: 'Convention Collective — Transport CI', titre: 'Chap. VI — Rupture',
    titre_article: 'Indemnité de licenciement — Transport (supérieure au légal)',
    texte: 'Indemnité conventionnelle transport CI : 35% du salaire global mensuel moyen des 3 derniers mois par année d\'ancienneté pour les 10 premières années, 40% de la 11e à la 15e, 45% au-delà. Ces taux sont supérieurs au minimum légal de l\'art. 25.1 du Code du Travail.',
    keywords: ['licenciement transport', 'indemnité conventionnelle', '35%', 'supérieur légal'] },

  // ─── COMMERCE ─────────────────────────────────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'commerce_ci',
    article_id: 'cc-co-1', article_numero: 'Art. 1',
    livre: 'Convention Collective — Commerce CI', titre: 'Chap. I — Champ application',
    titre_article: 'Convention Collective Commerce — Champ d\'application CI',
    texte: 'Applicable aux entreprises commerciales (commerce de détail, de gros, grande distribution, banques, assurances, courtage, agences immobilières) établies en CI. Couvre le personnel de vente, administratif, logistique, caisse.',
    keywords: ['commerce', 'banque', 'assurance', 'grande distribution', 'vente'] },

  { ...P, source: 'convention_collective', convention_slug: 'commerce_ci',
    article_id: 'cc-co-8', article_numero: 'Art. 8',
    livre: 'Convention Collective — Commerce CI', titre: 'Chap. II — Travail du dimanche',
    titre_article: 'Travail dominical — Commerce CI',
    texte: 'Dans le commerce de détail et la grande distribution, le travail du dimanche est autorisé avec l\'accord de l\'Inspection du Travail. Majoration obligatoire : 50% en plus du salaire normal. Le salarié bénéficie d\'un repos compensateur dans la semaine.',
    keywords: ['travail dimanche', 'commerce', 'majoration 50%', 'repos compensateur', 'grande distribution'] },

  { ...P, source: 'convention_collective', convention_slug: 'commerce_ci',
    article_id: 'cc-co-12', article_numero: 'Art. 12',
    livre: 'Convention Collective — Commerce CI', titre: 'Chap. III — Classifications',
    titre_article: 'Grille de classification — Commerce CI',
    texte: 'Classification commerce CI en 8 catégories : Cat. 1 (employé stagiaire, SMIG), Cat. 2 (employé qualifié, +10% SMIG), Cat. 3 (agent de maîtrise niveau 1), Cat. 4 (agent de maîtrise niveau 2), Cat. 5–8 (cadres, salaire négocié). La catégorie détermine les minima salariaux.',
    keywords: ['classification', 'catégories', 'minima salariaux', 'grille salaire commerce'] },

  { ...P, source: 'convention_collective', convention_slug: 'commerce_ci',
    article_id: 'cc-co-18', article_numero: 'Art. 18',
    livre: 'Convention Collective — Commerce CI', titre: 'Chap. IV — Formation',
    titre_article: 'Formation commerciale — Remboursement FDFP',
    texte: 'Les formations agréées dans le secteur commerce (vente, merchandising, gestion stock, logistique) sont éligibles au remboursement FDFP. L\'employeur peut demander le remboursement jusqu\'à 70% des coûts pédagogiques sur présentation des justificatifs.',
    keywords: ['formation commerce', 'FDFP remboursement', '70%', 'vente', 'merchandising'] },

  // ─── BTP ──────────────────────────────────────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'btp_ci',
    article_id: 'cc-btp-1', article_numero: 'Art. 1',
    livre: 'Convention Collective — BTP CI', titre: 'Chap. I — Champ application',
    titre_article: 'BTP CI — Bâtiment Travaux Publics — Champ d\'application',
    texte: 'S\'applique aux entreprises du bâtiment, TP, VRD, génie civil, menuiserie, plomberie, peinture, électricité du bâtiment établies en CI. Taux AT CNPS spécifique : 3% (secteur classé à risque modéré). Couvre ouvriers, techniciens, cadres du BTP.',
    keywords: ['BTP', 'bâtiment', 'TP', 'VRD', 'génie civil', 'taux AT 3%'], payroll_codes: ['3300'] },

  { ...P, source: 'convention_collective', convention_slug: 'btp_ci',
    article_id: 'cc-btp-7', article_numero: 'Art. 7',
    livre: 'Convention Collective — BTP CI', titre: 'Chap. II — Hygiène et sécurité',
    titre_article: 'EPI obligatoires sur chantier — BTP CI',
    texte: 'Sur tout chantier BTP, l\'employeur fournit obligatoirement et gratuitement : casque de protection, chaussures de sécurité, gants, lunettes pour travaux dangereux, harnais pour travaux en hauteur (> 2m). Le port est obligatoire sous peine de sanctions disciplinaires.',
    keywords: ['EPI BTP', 'casque', 'chaussures sécurité', 'harnais', 'hauteur', 'chantier'] },

  { ...P, source: 'convention_collective', convention_slug: 'btp_ci',
    article_id: 'cc-btp-10', article_numero: 'Art. 10',
    livre: 'Convention Collective — BTP CI', titre: 'Chap. III — Rémunération',
    titre_article: 'Indemnité de déplacement et de chantier — BTP CI',
    texte: 'Tout travailleur BTP affecté sur un chantier situé à plus de 30 km de son lieu de résidence habituel perçoit une indemnité de déplacement couvrant hébergement et repas. Montant fixé par la convention selon la zone géographique : 3 500 à 8 000 FCFA/jour.',
    keywords: ['déplacement chantier', 'indemnité déplacement', 'hébergement', 'BTP'] },

  { ...P, source: 'convention_collective', convention_slug: 'btp_ci',
    article_id: 'cc-btp-15', article_numero: 'Art. 15',
    livre: 'Convention Collective — BTP CI', titre: 'Chap. III — Rémunération',
    titre_article: 'Prime de fin de chantier — BTP CI',
    texte: 'À la clôture d\'un chantier, tout travailleur ayant travaillé sur ce chantier pendant au moins 3 mois perçoit une prime de fin de chantier égale à 5% de sa rémunération brute totale perçue pendant la durée du chantier.',
    keywords: ['prime fin chantier', '5%', '3 mois', 'BTP', 'rémunération chantier'] },

  // ─── INDUSTRIE ────────────────────────────────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'industrie_ci',
    article_id: 'cc-ind-1', article_numero: 'Art. 1',
    livre: 'Convention Collective — Industrie CI', titre: 'Chap. I — Champ application',
    titre_article: 'Convention Collective Industrie — Taux AT 4%',
    texte: 'S\'applique aux entreprises industrielles de production (agroalimentaire, textile, chimie, métallurgie, papier, plastique) établies en CI. Taux AT CNPS : 4% (secteur à risque élevé). Horaires décalés possibles.',
    keywords: ['industrie', 'agroalimentaire', 'taux AT 4%', 'production'] },

  { ...P, source: 'convention_collective', convention_slug: 'industrie_ci',
    article_id: 'cc-ind-5', article_numero: 'Art. 5',
    livre: 'Convention Collective — Industrie CI', titre: 'Chap. II — Travail posté',
    titre_article: 'Prime de poste industriel CI',
    texte: 'Le salarié travaillant en équipes alternantes (2x8 ou 3x8) bénéficie d\'une prime de poste mensuelle. Montant minimal conventionnel : 10% du salaire de base pour équipe matin/après-midi, 15% pour équipe de nuit permanente. Ce montant peut être augmenté par accord d\'entreprise.',
    keywords: ['prime poste', '2x8', '3x8', 'nuit', '15%', 'industrie'] },

  { ...P, source: 'convention_collective', convention_slug: 'industrie_ci',
    article_id: 'cc-ind-10', article_numero: 'Art. 10',
    livre: 'Convention Collective — Industrie CI', titre: 'Chap. III — Hygiène sécurité',
    titre_article: 'Risques industriels — Surveillance médicale renforcée',
    texte: 'Les salariés exposés à des risques industriels (bruit > 85dB, poussières, produits chimiques, chaleur > 35°C) bénéficient d\'une surveillance médicale renforcée : visite médicale tous les 6 mois minimum. L\'employeur prend en charge 100% des frais.',
    keywords: ['risques industriels', 'surveillance médicale', '6 mois', 'bruit', 'poussières', 'produits chimiques'] },

  { ...P, source: 'convention_collective', convention_slug: 'industrie_ci',
    article_id: 'cc-ind-18', article_numero: 'Art. 18',
    livre: 'Convention Collective — Industrie CI', titre: 'Chap. IV — Vêtements travail',
    titre_article: 'Tenues de travail — Industrie CI',
    texte: 'L\'employeur fournit gratuitement les tenues de travail et les EPI adaptés aux risques. Pour les secteurs agroalimentaire et chimie, les tenues sont lavées sur site par l\'employeur. Le renouvellement annuel est obligatoire, ou plus fréquent selon l\'usure.',
    keywords: ['tenue travail', 'EPI industrie', 'agroalimentaire', 'chimie', 'lavage', 'renouvellement'] },

  // ─── AGRO-INDUSTRIE CI ────────────────────────────────────────────────────────
  { ...P, source: 'convention_collective', convention_slug: 'agro_industrie_ci',
    article_id: 'cc-agro-1', article_numero: 'Art. 1',
    livre: 'Convention Collective — Agro-Industrie CI', titre: 'Champ d\'application',
    titre_article: 'Agro-Industrie CI — Plantations, huileries, cacaoyers',
    texte: 'S\'applique aux entreprises agro-industrielles de CI : plantations (hévéa, palmier à huile, cacao, café), huileries, sucreries, conserveries, entreprises d\'égrenage du coton. Taux AT CNPS : 3% (risques modérés). Comprend les travailleurs agricoles permanents et saisonniers.',
    keywords: ['agro-industrie', 'plantation', 'cacao', 'palmier huile', 'hévéa', 'saisonnier CI'] },

  { ...P, source: 'convention_collective', convention_slug: 'agro_industrie_ci',
    article_id: 'cc-agro-5', article_numero: 'Art. 5',
    livre: 'Convention Collective — Agro-Industrie CI', titre: 'Logement et avantages',
    titre_article: 'Logement de fonction — Agro-Industrie CI',
    texte: 'Dans les plantations isolées, l\'employeur est tenu de fournir un logement décent aux salariés permanents et à leur famille. Ce logement constitue un avantage en nature évalué selon le barème conventionnel (5 à 10% du salaire de base selon la superficie) et inclus dans l\'assiette de cotisations.',
    keywords: ['logement fonction', 'plantation', 'avantage nature', 'barème', 'assiette cotisations'] },

  { ...P, source: 'convention_collective', convention_slug: 'agro_industrie_ci',
    article_id: 'cc-agro-10', article_numero: 'Art. 10',
    livre: 'Convention Collective — Agro-Industrie CI', titre: 'Travail saisonnier',
    titre_article: 'Contrat saisonnier agro-industrie CI',
    texte: 'Le contrat saisonnier agro-industriel peut être conclu pour les périodes de récolte (cacao : oct-fév ; café : oct-janv ; palmier à huile : toute l\'année). Sa durée est limitée à 6 mois renouvelables selon la saison. L\'indemnité de fin de contrat est de 10% du salaire total.',
    keywords: ['contrat saisonnier', 'récolte cacao', 'café', 'palmier', '10%', 'agro-industrie CI'] },
]

export const ALL_ARTICLES: ArticleDroit[] = [...CODE_TRAVAIL_CI, ...CONVENTIONS_COLLECTIVES]
