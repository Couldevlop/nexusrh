export const COUNTRIES = [
    { code: 'FR', label: 'France', currency: 'EUR', phonePrefix: '+33' },
    { code: 'BE', label: 'Belgique', currency: 'EUR', phonePrefix: '+32' },
    { code: 'CH', label: 'Suisse', currency: 'CHF', phonePrefix: '+41' },
    { code: 'LU', label: 'Luxembourg', currency: 'EUR', phonePrefix: '+352' },
    { code: 'DE', label: 'Allemagne', currency: 'EUR', phonePrefix: '+49' },
    { code: 'ES', label: 'Espagne', currency: 'EUR', phonePrefix: '+34' },
    { code: 'IT', label: 'Italie', currency: 'EUR', phonePrefix: '+39' },
    { code: 'PT', label: 'Portugal', currency: 'EUR', phonePrefix: '+351' },
    { code: 'NL', label: 'Pays-Bas', currency: 'EUR', phonePrefix: '+31' },
    { code: 'GB', label: 'Royaume-Uni', currency: 'GBP', phonePrefix: '+44' },
    { code: 'US', label: 'États-Unis', currency: 'USD', phonePrefix: '+1' },
    { code: 'CA', label: 'Canada', currency: 'CAD', phonePrefix: '+1' },
    { code: 'MA', label: 'Maroc', currency: 'MAD', phonePrefix: '+212' },
    { code: 'TN', label: 'Tunisie', currency: 'TND', phonePrefix: '+216' },
    { code: 'SN', label: 'Sénégal', currency: 'XOF', phonePrefix: '+221' },
    { code: 'CI', label: 'Côte d\'Ivoire', currency: 'XOF', phonePrefix: '+225' },
];
export const COUNTRIES_MAP = Object.fromEntries(COUNTRIES.map(c => [c.code, c]));
export const EU_COUNTRIES = COUNTRIES.filter(c => ['FR', 'BE', 'LU', 'DE', 'ES', 'IT', 'PT', 'NL'].includes(c.code));
//# sourceMappingURL=countries.js.map