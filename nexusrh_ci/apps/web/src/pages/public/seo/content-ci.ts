/**
 * Pages de contenu Côte d'Ivoire : paie, congés, Mobile Money, guides ITS et CNPS.
 *
 * Source de vérité des chiffres : pack CIV_2024 (apps/api/src/services/
 * legislation-packs.ts) et nexusrh_ci/CLAUDE.md. Les exemples chiffrés sont
 * recalculés dans seo-content.test.ts : un changement de barème qui ne serait
 * pas reporté ici fait échouer les tests.
 */
import type { SeoPageContent } from './types'

const UPDATED = '2026-10-29'

export const PAYROLL_CI: SeoPageContent = {
  path: '/logiciel-paie-cote-divoire',
  lang: 'fr',
  kind: 'landing',
  title: "Logiciel de paie Côte d'Ivoire : CNPS, ITS 2024, DISA | NexusRH",
  description:
    "Logiciel de paie ivoirien en ligne : CNPS à double plafond, ITS 2024 avec RICF, " +
    'DISA, bulletins en FCFA et versement Mobile Money. Édité à Abidjan.',
  h1: "Logiciel de paie pour la Côte d'Ivoire",
  lead:
    "NexusRH CI calcule la paie selon les règles ivoiriennes en vigueur : cotisations CNPS avec " +
    "leurs deux plafonds, ITS réformé au 1er janvier 2024, réduction pour charges de famille, " +
    'puis produit les bulletins, les déclarations et le paiement des salaires.',
  crumb: 'Logiciel de paie',
  updated: UPDATED,
  sections: [
    {
      h2: 'Ce que le moteur de paie applique',
      blocks: [
        { type: 'ul', items: [
          'CNPS : retraite 6,3 % salarié et 7,7 % employeur, plafonnée à 1 647 315 FCFA par mois ; prestations familiales (5 %), maternité (0,75 %) et accident du travail (2 à 5 % selon le secteur) plafonnées à 70 000 FCFA.',
          "ITS : barème mensuel 0 / 16 / 21 / 24 / 28 / 32 % appliqué à 100 % du brut imposable (ordonnance n° 2023-719), sans abattement, puis réduction d'impôt pour charges de famille (RICF) selon le nombre de parts.",
          "Assiettes : primes d'ancienneté et de rendement, heures supplémentaires, indemnité de congés, gratifications et avantages en nature sont soumis à la CNPS et à l'ITS ; la prime de transport est exonérée jusqu'à 30 000 FCFA à Abidjan, 24 000 à Bouaké et 20 000 dans les autres villes.",
          'Contrôle du SMIG (75 000 FCFA par mois) et montants en FCFA entiers, sans centimes, sur chaque bulletin.',
          'Heures supplémentaires majorées, absences déduites, éléments variables saisis ou importés chaque mois.',
        ] },
        { type: 'links', items: [
          { to: '/guides/calcul-its-2024-cote-divoire', label: "Le calcul de l'ITS 2024 pas à pas" },
          { to: '/guides/cotisations-cnps-2024', label: 'Les cotisations CNPS 2024 détaillées' },
        ] },
      ],
    },
    {
      h2: 'Déclarations CNPS et DISA',
      blocks: [
        { type: 'p', text:
          "Les déclarations de cotisations CNPS sont produites à partir des bulletins clôturés, sans ressaisie. " +
          "La DISA (déclaration individuelle des salaires annuels) agrège les douze bulletins de l'année : elle est " +
          "générée en janvier pour l'année écoulée, prête à être déposée sur le portail de la CNPS." },
      ],
    },
    {
      h2: 'Bulletins, clôture et solde de tout compte',
      blocks: [
        { type: 'ul', items: [
          "Bulletins PDF mis en page avec le constructeur de bulletin (blocs déplaçables, aperçu immédiat) et consultables par chaque salarié dans son espace.",
          "Clôture de période réservée aux rôles habilités ; les agents RH saisissent, les responsables valident.",
          "Sortie d'un salarié : préavis selon la catégorie et l'ancienneté, indemnité de licenciement progressive (30 %, 35 % puis 40 % selon les tranches d'ancienneté), indemnité compensatrice de congés.",
          "Groupes multi-filiales : une paie par société, avec son propre circuit de validation, et une vue consolidée.",
        ] },
      ],
    },
    {
      h2: 'Du calcul au versement',
      blocks: [
        { type: 'p', text:
          "Une fois la paie validée, les salaires sont versés par Mobile Money (Wave, MTN, Orange) ou par virement, " +
          "avec un fichier au format de votre banque. Les entreprises qui conservent Sage Paie peuvent utiliser " +
          "NexusRH CI en amont et exporter employés, éléments variables et résultats de paie." },
        { type: 'links', items: [
          { to: '/paiement-salaires-mobile-money', label: 'Payer les salaires par Mobile Money ou virement' },
          { to: '/gestion-conges-cote-divoire', label: 'La gestion des congés, reliée à la paie' },
        ] },
      ],
    },
  ],
  faq: [
    { q: 'La réforme ITS du 1er janvier 2024 est-elle appliquée ?',
      a: "Oui. L'ancien régime (IS, CN, IGR, abattement de 15 %) n'est plus utilisé : le barème 2024 s'applique à 100 % du brut imposable, puis la RICF est déduite selon le nombre de parts." },
    { q: 'Le double plafond CNPS est-il géré ?',
      a: 'Oui. La retraite est plafonnée à 1 647 315 FCFA par mois ; prestations familiales, maternité et accident du travail le sont à 70 000 FCFA. Les deux plafonds ne sont jamais confondus.' },
    { q: 'Peut-on garder Sage Paie ?',
      a: 'Oui. Une interface exporte au format CSV les employés, les éléments variables et les résultats de paie vers Sage. La paie native de NexusRH CI reste disponible.' },
  ],
  related: ['/guides/calcul-its-2024-cote-divoire', '/guides/cotisations-cnps-2024', '/gestion-conges-cote-divoire', '/sirh-afrique-ouest'],
}

export const LEAVE_CI: SeoPageContent = {
  path: '/gestion-conges-cote-divoire',
  lang: 'fr',
  kind: 'landing',
  title: "Gestion des congés Côte d'Ivoire : 2,2 jours par mois | NexusRH",
  description:
    "Congés payés selon le Code du travail ivoirien : 2,2 jours ouvrables par mois, jours " +
    "d'ancienneté, fériés, maternité 14 semaines. Soldes et paie reliés.",
  h1: "Gestion des congés en Côte d'Ivoire",
  lead:
    'NexusRH CI calcule les droits à congés comme le prévoit le Code du travail ivoirien : en jours ouvrables, ' +
    "avec les jours supplémentaires d'ancienneté et les jours fériés, puis reporte les absences sur la paie.",
  crumb: 'Gestion des congés',
  updated: UPDATED,
  sections: [
    {
      h2: 'Acquisition des congés payés',
      blocks: [
        { type: 'p', text:
          "Le salarié acquiert 2,2 jours ouvrables de congé par mois de service effectif (article 25.1 du Code du travail, " +
          "article 69 de la convention collective interprofessionnelle), soit 26,4 jours pour douze mois. Les jours ouvrables " +
          'vont du lundi au samedi, jours fériés exclus.' },
        { type: 'table', caption: "Jours supplémentaires selon l'ancienneté (article 25.2 du Code du travail)",
          head: ['Ancienneté dans l’entreprise', 'Jours ouvrables en plus'],
          rows: [['5 ans', '1'], ['10 ans', '2'], ['15 ans', '3'], ['20 ans', '5'], ['25 ans', '7'], ['30 ans', '8']] },
      ],
    },
    {
      h2: "L'allocation de congés",
      blocks: [
        { type: 'p', text:
          "L'allocation versée pendant le congé est calculée selon la méthode la plus favorable au salarié entre la " +
          "moyenne des salaires (article 71 de la convention collective) et la règle du douzième (décret n° 98-39). " +
          "Elle est soumise à la CNPS et à l'ITS comme un salaire." },
      ],
    },
    {
      h2: 'Congés spéciaux',
      blocks: [
        { type: 'ul', items: [
          'Maternité : 14 semaines (6 avant, 8 après l’accouchement), prolongées de 2 semaines en cas de naissance multiple et de 3 semaines en cas de maladie liée à la grossesse ; indemnité prise en charge par la CNPS.',
          'Paternité : 10 jours.',
          'Décès d’un proche : 3 jours.',
        ] },
      ],
    },
    {
      h2: 'Jours fériés ivoiriens',
      blocks: [
        { type: 'p', text:
          "Treize jours fériés sont exclus du décompte : Jour de l'An, lundi de Pâques, Aïd el-Fitr, fête du Travail, " +
          "Ascension, lundi de Pentecôte, Tabaski, Maouloud, fête de l'Indépendance (7 août), Assomption, Toussaint, " +
          'Journée nationale de la paix (15 novembre) et Noël. Les dates des fêtes religieuses musulmanes sont mises à jour chaque année.' },
      ],
    },
    {
      h2: 'Demandes, validation et soldes',
      blocks: [
        { type: 'ul', items: [
          'Le salarié pose sa demande depuis son espace ; son responsable la valide ou la refuse, avec notification.',
          'Le manager ne voit que les absences de son équipe ; les RH voient l’ensemble.',
          'Le solde est recalculé à chaque mouvement, et les absences validées alimentent directement la paie du mois.',
        ] },
        { type: 'links', items: [{ to: '/logiciel-paie-cote-divoire', label: "Le logiciel de paie ivoirien" }] },
      ],
    },
  ],
  related: ['/logiciel-paie-cote-divoire', '/guides/cotisations-cnps-2024', '/paiement-salaires-mobile-money'],
}

export const MOBILE_MONEY: SeoPageContent = {
  path: '/paiement-salaires-mobile-money',
  lang: 'fr',
  kind: 'landing',
  title: 'Paiement des salaires par Mobile Money (Wave, MTN, Orange)',
  description:
    'Versez les salaires par Wave, MTN ou Orange Money, en direct ou via CinetPay, ou par virement ' +
    "bancaire au format de votre banque, depuis la paie validée.",
  h1: 'Payer les salaires par Mobile Money ou virement',
  lead:
    "En Côte d'Ivoire, une partie des salariés est payée sur un portefeuille mobile, l'autre sur un compte bancaire. " +
    'NexusRH CI gère les deux à partir de la paie validée, sans ressaisie des montants.',
  crumb: 'Mobile Money',
  updated: UPDATED,
  sections: [
    {
      h2: 'Mobile Money : Wave, MTN et Orange',
      blocks: [
        { type: 'ul', items: [
          'Connexion directe aux opérateurs Wave, MTN et Orange, ou passage par l’agrégateur CinetPay.',
          'Numéros contrôlés au format ivoirien (+225 07 pour Wave et Orange, +225 05 pour MTN) avant tout envoi.',
          'Statut de chaque versement suivi jusqu’à la confirmation de l’opérateur.',
          'Identifiants des opérateurs propres à chaque entreprise, chiffrés au repos ; tant qu’ils ne sont pas renseignés, les versements restent en mode simulation.',
        ] },
      ],
    },
    {
      h2: 'Virement bancaire au format de votre banque',
      blocks: [
        { type: 'p', text:
          "Chaque salarié a son mode de paiement dans sa fiche (Mobile Money ou virement). Pour les virements, NexusRH CI " +
          "produit un fichier par banque. Le format est décrit une fois à partir d'un fichier d'exemple fourni par la banque, " +
          'versionné, puis réutilisé chaque mois ; le fichier peut être envoyé depuis l’adresse e-mail de votre entreprise.' },
      ],
    },
    {
      h2: 'Contrôles et droits',
      blocks: [
        { type: 'ul', items: [
          'Seuls les administrateurs et responsables RH lancent les paiements ; les autres rôles n’y ont pas accès.',
          'Chaque opération est tracée dans le journal d’audit de l’entreprise.',
        ] },
        { type: 'links', items: [
          { to: '/logiciel-paie-cote-divoire', label: 'Le calcul de la paie ivoirienne' },
          { to: '/sirh-afrique-ouest', label: 'Les autres pays de la zone UEMOA' },
        ] },
      ],
    },
  ],
  related: ['/logiciel-paie-cote-divoire', '/sirh-afrique-ouest'],
}

export const GUIDE_ITS: SeoPageContent = {
  path: '/guides/calcul-its-2024-cote-divoire',
  lang: 'fr',
  kind: 'guide',
  title: "Calcul de l'ITS 2024 en Côte d'Ivoire : barème et exemples",
  description:
    "Barème ITS 2024 (0 à 32 %) sur 100 % du brut imposable, RICF par parts et exemples chiffrés : " +
    'la méthode de calcul issue de l’ordonnance n° 2023-719.',
  h1: "Calcul de l'ITS 2024 en Côte d'Ivoire",
  lead:
    "Depuis le 1er janvier 2024, l'impôt sur les traitements et salaires (ITS) remplace l'IS, la contribution nationale " +
    "et l'IGR. Le calcul tient en deux étapes : un barème progressif sur le brut imposable, puis une réduction pour " +
    'charges de famille.',
  crumb: "Calcul de l'ITS 2024",
  published: UPDATED,
  updated: UPDATED,
  sections: [
    {
      h2: "Ce qui a changé au 1er janvier 2024",
      blocks: [
        { type: 'ul', items: [
          "L'ordonnance n° 2023-719 du 13 septembre 2023 fusionne les anciens impôts sur salaire en un ITS unique.",
          "L'abattement forfaitaire de 15 % est supprimé : le barème s'applique à 100 % du brut imposable.",
          "Les cotisations CNPS du salarié ne sont pas déduites de l'assiette de l'ITS.",
          "Les anciens crédits d'impôt sont remplacés par la réduction d'impôt pour charges de famille (RICF).",
        ] },
      ],
    },
    {
      h2: 'Étape 1 : le barème mensuel',
      blocks: [
        { type: 'table', caption: 'Barème mensuel de l’ITS 2024 (FCFA)',
          head: ['Tranche de brut imposable mensuel', 'Taux'],
          rows: [
            ['0 à 75 000', '0 %'],
            ['75 001 à 240 000', '16 %'],
            ['240 001 à 800 000', '21 %'],
            ['800 001 à 2 400 000', '24 %'],
            ['2 400 001 à 8 000 000', '28 %'],
            ['Au-delà de 8 000 000', '32 %'],
          ],
          note: 'Chaque taux ne s’applique qu’à la part du salaire comprise dans sa tranche.' },
        { type: 'p', text:
          "Exemple pour un brut imposable de 450 000 FCFA : 165 000 × 16 % = 26 400 sur la deuxième tranche, " +
          "puis 210 000 × 21 % = 44 100 sur la troisième. L'ITS brut est de 70 500 FCFA." },
      ],
    },
    {
      h2: 'Étape 2 : la RICF selon le nombre de parts',
      blocks: [
        { type: 'p', text:
          "Le nombre de parts dépend de la situation de famille : 1 part pour une personne seule sans enfant, 2 parts pour " +
          "une personne mariée, une demi-part de plus par enfant à charge, et une demi-part de majoration pour le parent " +
          "isolé ayant au moins un enfant. Le nombre de parts est plafonné à 5." },
        { type: 'table', caption: 'Réduction mensuelle pour charges de famille (FCFA)',
          head: ['Parts', 'RICF'],
          rows: [
            ['1', '0'], ['1,5', '5 500'], ['2', '11 000'], ['2,5', '16 500'], ['3', '22 000'],
            ['3,5', '27 500'], ['4', '33 000'], ['4,5', '38 500'], ['5', '44 000'],
          ] },
        { type: 'p', text: "L'ITS dû est l'ITS brut diminué de la RICF, sans pouvoir devenir négatif." },
      ],
    },
    {
      h2: 'Exemples chiffrés',
      blocks: [
        { type: 'table', caption: 'ITS mensuel selon le brut imposable et la situation de famille (FCFA)',
          head: ['Brut imposable', 'ITS brut', 'Seul, sans enfant (1 part)', 'Marié, 2 enfants (3 parts)'],
          rows: [
            ['200 000', '20 000', '20 000', '0'],
            ['450 000', '70 500', '70 500', '48 500'],
            ['1 500 000', '312 000', '312 000', '290 000'],
          ] },
        { type: 'p', text:
          "La prime de transport n'entre pas dans le brut imposable jusqu'à 30 000 FCFA par mois à Abidjan " +
          "(24 000 à Bouaké, 20 000 dans les autres villes) ; l'excédent est imposable." },
      ],
    },
    {
      h2: "Calculer l'ITS dans NexusRH CI",
      blocks: [
        { type: 'p', text:
          "Le moteur de paie applique ce barème et la RICF à chaque bulletin, à partir de la situation de famille " +
          "enregistrée dans la fiche du salarié. Un simulateur ITS, adossé au même moteur, est disponible dans l'application." },
        { type: 'links', items: [
          { to: '/logiciel-paie-cote-divoire', label: "Le logiciel de paie ivoirien" },
          { to: '/guides/cotisations-cnps-2024', label: 'Le calcul des cotisations CNPS' },
        ] },
      ],
    },
  ],
  related: ['/guides/cotisations-cnps-2024', '/logiciel-paie-cote-divoire'],
}

export const GUIDE_CNPS: SeoPageContent = {
  path: '/guides/cotisations-cnps-2024',
  lang: 'fr',
  kind: 'guide',
  title: 'Cotisations CNPS 2024 : taux, double plafond et exemple',
  description:
    'Taux CNPS 2024 salarié et employeur, plafonds de 1 647 315 et 70 000 FCFA, taux accident du ' +
    'travail par secteur et un calcul complet à 2 000 000 FCFA.',
  h1: 'Cotisations CNPS 2024 : taux et plafonds',
  lead:
    "La Caisse nationale de prévoyance sociale (CNPS) finance la retraite, les prestations familiales, la maternité " +
    "et les accidents du travail. Chaque branche a son taux, et toutes ne partagent pas le même plafond.",
  crumb: 'Cotisations CNPS 2024',
  published: UPDATED,
  updated: UPDATED,
  sections: [
    {
      h2: 'Taux et plafonds par branche',
      blocks: [
        { type: 'table', caption: 'Cotisations CNPS 2024 (plafonds mensuels en FCFA)',
          head: ['Branche', 'Salarié', 'Employeur', 'Plafond mensuel'],
          rows: [
            ['Retraite', '6,3 %', '7,7 %', '1 647 315'],
            ['Prestations familiales', '—', '5 %', '70 000'],
            ['Maternité', '—', '0,75 %', '70 000'],
            ['Accident du travail', '—', '2 à 5 %', '70 000'],
          ] },
      ],
    },
    {
      h2: 'Le double plafond',
      blocks: [
        { type: 'p', text:
          "La retraite se calcule sur le salaire dans la limite de 1 647 315 FCFA par mois. Les prestations familiales, " +
          "la maternité et l'accident du travail se calculent sur 70 000 FCFA au plus. Appliquer un plafond unique à toutes " +
          "les branches est l'erreur la plus fréquente : elle fausse les cotisations dès que le salaire dépasse 70 000 FCFA." },
      ],
    },
    {
      h2: 'Taux accident du travail selon le secteur',
      blocks: [
        { type: 'table', caption: 'Taux employeur de la branche accident du travail',
          head: ['Secteur', 'Taux'],
          rows: [['Commerce et services', '2 %'], ['Bâtiment et travaux publics', '3 %'], ['Industrie', '4 %'], ['Extraction et mines', '5 %']] },
      ],
    },
    {
      h2: 'Exemple : salaire brut de 2 000 000 FCFA (commerce)',
      blocks: [
        { type: 'table', caption: 'Cotisations CNPS mensuelles (FCFA, arrondies au franc)',
          head: ['Branche', 'Assiette', 'Taux', 'Montant'],
          rows: [
            ['Retraite — part salarié', '1 647 315', '6,3 %', '103 781'],
            ['Retraite — part employeur', '1 647 315', '7,7 %', '126 843'],
            ['Prestations familiales', '70 000', '5 %', '3 500'],
            ['Maternité', '70 000', '0,75 %', '525'],
            ['Accident du travail', '70 000', '2 %', '1 400'],
          ],
          note: 'Total salarié : 103 781 FCFA. Total employeur : 132 268 FCFA.' },
        { type: 'p', text:
          "Ce que la CNPS retient sur le salaire n'est pas déduit de l'assiette de l'ITS depuis la réforme 2024 : " +
          "les deux calculs partent du même brut." },
      ],
    },
    {
      h2: 'Déclarations',
      blocks: [
        { type: 'p', text:
          "Les cotisations sont déclarées à la CNPS à partir des bulletins ; chaque année, la DISA récapitule les salaires " +
          "de chaque salarié sur les douze mois. NexusRH CI produit les deux à partir de la paie clôturée." },
        { type: 'links', items: [
          { to: '/logiciel-paie-cote-divoire', label: 'Le logiciel de paie ivoirien' },
          { to: '/guides/calcul-its-2024-cote-divoire', label: "Le calcul de l'ITS 2024" },
        ] },
      ],
    },
  ],
  related: ['/guides/calcul-its-2024-cote-divoire', '/logiciel-paie-cote-divoire', '/gestion-conges-cote-divoire'],
}
