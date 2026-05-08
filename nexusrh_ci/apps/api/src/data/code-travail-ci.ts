/**
 * Code du Travail CI — Articles indexés
 * Structure: Livre > Titre > Chapitre > Section > Article
 * Source: Loi n°2015-532 du 20 juillet 2015 portant Code du Travail CI
 */
export interface ArticleDroit {
  article_id:    string
  article_numero: string
  source:        'code_travail_ci' | 'convention_collective'
  convention_slug?: string
  livre?:        string
  titre?:        string
  chapitre?:     string
  section?:      string
  titre_article: string
  texte:         string
  access_level:  'public'
  tenant_id:     'public'
  payroll_codes?: string[]
  keywords?:     string[]
}

export const CODE_TRAVAIL_CI: ArticleDroit[] = [
  // ── LIVRE I — RELATIONS INDIVIDUELLES DE TRAVAIL ──────────────────────────
  {
    article_id: 'art-ct-11-1', article_numero: 'Article 11.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre I — Contrat de travail', chapitre: 'Chapitre I — Formation',
    titre_article: 'Définition du contrat de travail',
    texte: 'Le contrat de travail est la convention par laquelle une personne physique s\'engage à mettre son activité professionnelle sous la direction et l\'autorité d\'une autre personne physique ou morale moyennant rémunération.',
    keywords: ['contrat', 'travail', 'définition', 'rémunération'],
  },
  {
    article_id: 'art-ct-14-3', article_numero: 'Article 14.3',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre I — Contrat de travail', chapitre: 'Chapitre I — Formation',
    titre_article: 'Période d\'essai — Durée',
    texte: 'La durée de la période d\'essai est fixée à un (1) mois pour les travailleurs non-cadres et à trois (3) mois pour les cadres et assimilés. Elle est renouvelable une fois avec l\'accord écrit des deux parties.',
    keywords: ['période essai', 'essai', 'durée', 'cadre', 'non-cadre'],
    payroll_codes: [],
  },
  {
    article_id: 'art-ct-18-1', article_numero: 'Article 18.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre I — Contrat de travail', chapitre: 'Chapitre III — Suspension',
    titre_article: 'Cas de suspension du contrat de travail',
    texte: 'Le contrat de travail est suspendu notamment en cas de maladie ou d\'accident du salarié dûment constatés, de maternité, de congés légaux et conventionnels, de mise à pied, de détention préventive.',
    keywords: ['suspension', 'maladie', 'maternité', 'accident travail', 'congé'],
    payroll_codes: ['1700', '1800', '1900'],
  },
  {
    article_id: 'art-ct-23-1', article_numero: 'Article 23.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre I — Contrat de travail', chapitre: 'Chapitre IV — Rupture',
    titre_article: 'Préavis de rupture du contrat à durée indéterminée',
    texte: 'La résiliation du contrat de travail à durée indéterminée est subordonnée à un préavis donné par la partie qui prend l\'initiative. La durée du préavis est de 15 jours pour les travailleurs ayant moins d\'un an d\'ancienneté, d\'un mois pour ceux ayant de 1 à 5 ans, et de trois mois au-delà.',
    keywords: ['préavis', 'CDI', 'rupture', 'ancienneté', 'licenciement', 'démission'],
    payroll_codes: [],
  },
  {
    article_id: 'art-ct-25-1', article_numero: 'Article 25.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre I — Contrat de travail', chapitre: 'Chapitre IV — Rupture',
    titre_article: 'Indemnité de licenciement',
    texte: 'Tout travailleur licencié ayant accompli une période d\'ancienneté d\'au moins un an a droit à une indemnité de licenciement. Cette indemnité est calculée sur la base du salaire global mensuel des trois derniers mois et est égale à : 30% du salaire global mensuel par année d\'ancienneté pour les 10 premières années, 35% de la 11e à la 15e année, 40% au-delà de la 15e année.',
    keywords: ['licenciement', 'indemnité', 'ancienneté', 'calcul'],
    payroll_codes: [],
  },
  // ── LIVRE I — CONGÉS ET REPOS ─────────────────────────────────────────────
  {
    article_id: 'art-ct-25-8', article_numero: 'Article 25.8',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre II — Congés et repos', chapitre: 'Chapitre I — Congés payés',
    titre_article: 'Durée des congés payés',
    texte: 'Tout salarié acquiert droit à un congé payé à la charge de l\'employeur à raison de deux jours et demi ouvrables par mois de travail effectif. La durée totale ne peut excéder 30 jours ouvrables. Des jours supplémentaires sont accordés en fonction de l\'ancienneté : 1 jour supplémentaire après 5 ans, 2 jours après 10 ans, 3 jours après 15 ans.',
    keywords: ['congés payés', 'CP', '2,5 jours', 'ouvrables', 'ancienneté', 'repos'],
    payroll_codes: ['1600'],
  },
  {
    article_id: 'art-ct-23-8', article_numero: 'Article 23.8',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre II — Congés et repos', chapitre: 'Chapitre II — Congés spéciaux',
    titre_article: 'Congé de maternité',
    texte: 'La travailleuse enceinte bénéficie d\'un congé de maternité d\'une durée de quatorze (14) semaines dont au moins six (6) semaines après l\'accouchement. Pendant cette période, l\'employeur maintient le salaire intégral. Les indemnités journalières versées par la CNPS sont avancées par l\'employeur qui se fait rembourser.',
    keywords: ['maternité', 'congé maternité', '14 semaines', 'CNPS', 'remboursement', 'indemnités'],
    payroll_codes: ['1700'],
  },
  {
    article_id: 'art-ct-23-9', article_numero: 'Article 23.9',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre II — Congés et repos', chapitre: 'Chapitre II — Congés spéciaux',
    titre_article: 'Congé de paternité',
    texte: 'Le père salarié bénéficie d\'un congé de paternité de dix (10) jours ouvrables à l\'occasion de la naissance de son enfant. Ce congé est rémunéré normalement.',
    keywords: ['paternité', 'naissance', '10 jours'],
    payroll_codes: [],
  },
  {
    article_id: 'art-ct-42-1', article_numero: 'Article 42.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre I', titre: 'Titre III — Maladie et accident', chapitre: 'Chapitre I — Maladie',
    titre_article: 'Maintien de salaire en cas de maladie — Règle du 100%',
    texte: 'En cas de maladie dûment constatée par un médecin agréé et notifiée à l\'employeur dans les 48 heures, le contrat est suspendu. L\'employeur maintient le salaire intégral (100%) pendant le premier mois d\'arrêt pour les cadres et agents de maîtrise, puis 50% les deux mois suivants. Pour les ouvriers, le maintien est de 50% dès le premier mois.',
    keywords: ['maladie', 'arrêt maladie', '100%', 'maintien salaire', 'certificat médical', '48 heures'],
    payroll_codes: ['1800'],
  },
  // ── LIVRE II — RELATIONS COLLECTIVES ─────────────────────────────────────
  {
    article_id: 'art-ct-61-1', article_numero: 'Article 61.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre II', titre: 'Titre I — Conventions collectives',
    titre_article: 'Définition et portée des conventions collectives',
    texte: 'La convention collective est un accord écrit conclu entre une ou plusieurs organisations syndicales de travailleurs et un ou plusieurs employeurs ou organisations d\'employeurs, en vue de régler les conditions d\'emploi et les rapports entre employeurs et travailleurs.',
    keywords: ['convention collective', 'syndicat', 'accord collectif'],
  },
  // ── LIVRE III — DURÉE DU TRAVAIL ──────────────────────────────────────────
  {
    article_id: 'art-ct-21-2', article_numero: 'Article 21.2',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre III', titre: 'Titre I — Durée du travail',
    titre_article: 'Durée légale et heures supplémentaires',
    texte: 'La durée légale du travail est fixée à 40 heures par semaine. Les heures effectuées au-delà de cette durée sont des heures supplémentaires. Les 8 premières heures supplémentaires (41e à 48e) sont majorées de 15%. Les heures de nuit (20h à 5h) et du dimanche sont majorées de 50%. Les heures des jours fériés sont majorées de 100%.',
    keywords: ['heures supplémentaires', 'durée travail', '40 heures', 'majoration', 'nuit', 'dimanche', 'férié'],
    payroll_codes: ['1400', '1500'],
  },
  {
    article_id: 'art-ct-32-1', article_numero: 'Article 32.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre III', titre: 'Titre II — Salaires',
    titre_article: 'Salaire Minimum Interprofessionnel Garanti (SMIG)',
    texte: 'Aucun employeur ne peut rémunérer un travailleur en deçà du Salaire Minimum Interprofessionnel Garanti fixé par décret. Le SMIG est actuellement fixé à 60 000 FCFA par mois pour un travail à temps plein de 40 heures par semaine (revalorisation 2023).',
    keywords: ['SMIG', 'salaire minimum', '60000', 'FCFA', 'rémunération minimale'],
    payroll_codes: ['1000'],
  },
  // ── LIVRE IV — PROTECTION SOCIALE ─────────────────────────────────────────
  {
    article_id: 'art-ct-53-1', article_numero: 'Article 53.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre IV', titre: 'Titre I — Accidents du travail',
    titre_article: 'Déclaration et prise en charge — Accident du travail',
    texte: 'Tout accident survenu par le fait ou à l\'occasion du travail est un accident du travail. L\'employeur doit déclarer l\'accident à la CNPS dans les 48 heures. Le jour de l\'accident est intégralement payé par l\'employeur. À compter du lendemain, les indemnités journalières sont prises en charge par la CNPS et sont exonérées de l\'ITS et de toute cotisation sociale.',
    keywords: ['accident travail', 'AT', 'déclaration CNPS', 'indemnités journalières', 'IJ', 'exonération ITS'],
    payroll_codes: ['1900'],
  },
  {
    article_id: 'art-ct-55-1', article_numero: 'Article 55.1',
    source: 'code_travail_ci', access_level: 'public', tenant_id: 'public',
    livre: 'Livre IV', titre: 'Titre I — CNPS et cotisations',
    titre_article: 'Cotisations CNPS — Taux et bases 2024',
    texte: 'Les cotisations dues à la CNPS sont réparties comme suit : Branche retraite : 6,3% à la charge du salarié et 7,7% à la charge de l\'employeur sur une assiette plafonnée à 1 647 315 FCFA par mois. Branche prestations familiales et maternité : 5,75% patronal. Branche accidents du travail : de 2% à 5% selon le secteur d\'activité, plafonné à 70 000 FCFA par mois.',
    keywords: ['CNPS', 'cotisations', 'retraite', '6,3%', '7,7%', 'prestations familiales', 'AT', 'plafond'],
    payroll_codes: ['2000', '3000', '3100', '3200', '3300'],
  },
]

// ── CONVENTIONS COLLECTIVES ────────────────────────────────────────────────
export const CONVENTIONS_COLLECTIVES: ArticleDroit[] = [
  {
    article_id: 'cc-transport-1', article_numero: 'Article 1',
    source: 'convention_collective', convention_slug: 'transport_ci',
    access_level: 'public', tenant_id: 'public',
    livre: 'Convention Collective', titre: 'Transports urbains et interurbains de Côte d\'Ivoire',
    chapitre: 'Chapitre I — Champ d\'application',
    titre_article: 'Champ d\'application de la Convention Transport CI',
    texte: 'La présente convention collective s\'applique aux entreprises de transport urbain et interurbain de voyageurs et de marchandises établies en Côte d\'Ivoire, à leurs salariés : chauffeurs, contrôleurs, mécaniciens, agents de guichet, personnel administratif.',
    keywords: ['transport', 'chauffeur', 'contrôleur', 'mécanicien'],
  },
  {
    article_id: 'cc-transport-primes', article_numero: 'Article 15',
    source: 'convention_collective', convention_slug: 'transport_ci',
    access_level: 'public', tenant_id: 'public',
    livre: 'Convention Collective', titre: 'Transports — Côte d\'Ivoire',
    chapitre: 'Chapitre IV — Rémunération',
    titre_article: 'Primes spécifiques au secteur Transport',
    texte: 'En sus du salaire de base, les travailleurs du secteur transport bénéficient des primes suivantes : Prime de transport : 25 000 à 40 000 FCFA selon le grade. Prime de rendement : versée mensuellement sur justificatif de résultat. Prime d\'ancienneté : 5% du salaire de base après 3 ans, 10% après 5 ans.',
    keywords: ['prime transport', 'prime rendement', 'prime ancienneté', 'transport CI'],
    payroll_codes: ['1100', '1200', '1300'],
  },
  {
    article_id: 'cc-transport-licenciement', article_numero: 'Article 28',
    source: 'convention_collective', convention_slug: 'transport_ci',
    access_level: 'public', tenant_id: 'public',
    livre: 'Convention Collective', titre: 'Transports — Côte d\'Ivoire',
    chapitre: 'Chapitre VI — Rupture du contrat',
    titre_article: 'Indemnité de licenciement — Transport CI',
    texte: 'En cas de licenciement, l\'indemnité conventionnelle est calculée sur la base du salaire global des 3 derniers mois. Elle s\'élève à 35% du salaire mensuel moyen par année pour les 10 premières années, puis 40% au-delà, supérieure au minimum légal prévu à l\'article 25.1 du Code du Travail.',
    keywords: ['licenciement', 'indemnité', 'transport', 'ancienneté'],
    payroll_codes: [],
  },
  {
    article_id: 'cc-commerce-1', article_numero: 'Article 1',
    source: 'convention_collective', convention_slug: 'commerce_ci',
    access_level: 'public', tenant_id: 'public',
    livre: 'Convention Collective', titre: 'Commerce — Côte d\'Ivoire',
    chapitre: 'Chapitre I — Champ d\'application',
    titre_article: 'Convention Collective Commerce CI',
    texte: 'La présente convention s\'applique aux entreprises de commerce de détail et de gros établies en Côte d\'Ivoire, aux banques, assurances, et aux professions libérales commerciales. Elle régit les relations employeurs-salariés dans ces secteurs.',
    keywords: ['commerce', 'banque', 'assurance', 'détail', 'gros'],
  },
  {
    article_id: 'cc-btp-1', article_numero: 'Article 1',
    source: 'convention_collective', convention_slug: 'btp_ci',
    access_level: 'public', tenant_id: 'public',
    livre: 'Convention Collective', titre: 'BTP — Bâtiment et Travaux Publics CI',
    chapitre: 'Chapitre I — Champ d\'application',
    titre_article: 'Convention Collective BTP CI — Champ d\'application',
    texte: 'S\'applique à toutes les entreprises du bâtiment, des travaux publics et des activités annexes (menuiserie, plomberie, électricité, peinture) exerçant leur activité en Côte d\'Ivoire. Taux AT CNPS spécifique BTP : 3%.',
    keywords: ['BTP', 'bâtiment', 'travaux publics', 'construction', 'taux AT 3%'],
    payroll_codes: ['3300'],
  },
]

export const ALL_ARTICLES = [...CODE_TRAVAIL_CI, ...CONVENTIONS_COLLECTIVES]
