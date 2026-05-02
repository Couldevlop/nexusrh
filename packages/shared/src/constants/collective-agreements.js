export const COLLECTIVE_AGREEMENTS = [
    { code: 'syntec', label: 'Syntec (Bureaux d\'études techniques)', idcc: '1486' },
    { code: 'metallurgie', label: 'Métallurgie', idcc: '1979' },
    { code: 'commerce', label: 'Commerce de détail et de gros', idcc: '3305' },
    { code: 'btp', label: 'Bâtiment et travaux publics', idcc: '1597' },
    { code: 'transport', label: 'Transports routiers', idcc: '16' },
    { code: 'hotellerie', label: 'Hôtels, cafés, restaurants', idcc: '1979' },
    { code: 'banque', label: 'Banque', idcc: '2120' },
    { code: 'assurance', label: 'Assurance', idcc: '1672' },
    { code: 'sante', label: 'Hospitalisation privée', idcc: '651' },
    { code: 'agriculture', label: 'Production agricole', idcc: '7024' },
    { code: 'chimie', label: 'Industries chimiques', idcc: '44' },
    { code: 'textile', label: 'Industries textiles', idcc: '18' },
    { code: 'alimentaire', label: 'Industrie alimentaire', idcc: '1747' },
    { code: 'nettoyage', label: 'Nettoyage de locaux', idcc: '3043' },
    { code: 'general', label: 'Convention collective générale', idcc: undefined },
];
export const COLLECTIVE_AGREEMENTS_MAP = Object.fromEntries(COLLECTIVE_AGREEMENTS.map(ca => [ca.code, ca]));
//# sourceMappingURL=collective-agreements.js.map