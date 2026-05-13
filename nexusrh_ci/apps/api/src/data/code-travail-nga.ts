/**
 * Nigeria Labour Act (CAP L1, LFN 2004) + Pensions Reform Act 2014 + NTA 2025
 *
 * Sources :
 *   - lawsofnigeria.placng.org/laws/L1.pdf (texte officiel)
 *   - nelex.gov.ng/documents/LABOUR_ACT.pdf
 *   - taxsummaries.pwc.com/nigeria (PwC Tax Summaries)
 *   - National Industrial Court of Nigeria (NICN) jurisprudence
 *
 * ATTENTION : Nigeria = hors zone franc, devise NGN. Semaine de 40h lun-ven.
 * Le texte officiel est en anglais — traductions françaises ici sont libres.
 */
import type { ArticleDroit } from './code-travail-ci.js'

const P = { access_level: 'public' as const, tenant_id: 'public' as const, country_code: 'NGA' }
const LABOUR_ACT = 'code_travail_nga'

export const CODE_TRAVAIL_NGA: ArticleDroit[] = [
  { ...P, source: LABOUR_ACT, article_id: 'nga-s7', article_numero: 'Section 7',
    titre: 'Labour Act CAP L1 — Part I',
    titre_article: 'Contract of employment — Written terms',
    texte: 'Not later than three months after the beginning of a worker\'s period of employment, the employer shall give to the worker a written statement specifying : the name of the employer, the worker, the date of engagement, the nature of employment, place of work, hours of work, wages and method of calculation, terms relating to leave and pay, terms relating to incapacity for work due to sickness or injury.',
    keywords: ['contract', 'written', '3 months', 'statement'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-s11', article_numero: 'Section 11',
    titre: 'Labour Act CAP L1 — Part I',
    titre_article: 'Notice periods — Statutory minima',
    texte: 'Notice required to terminate a contract of employment under Section 11(2) : (a) one day, where the contract has continued for a period of three months or less ; (b) one week, where the contract has continued for more than three months but less than two years ; (c) two weeks, where the contract has continued for a period of two years but less than five years ; (d) one month, where the contract has continued for five years or more. Notice must be in writing.',
    keywords: ['notice period', 'termination', 'statutory', 'tenure'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-s18', article_numero: 'Section 18',
    titre: 'Labour Act CAP L1 — Part II',
    titre_article: 'Annual leave entitlement',
    texte: 'Every worker shall be entitled, after twelve months of continuous service, to a holiday with full pay of at least six working days. For workers under the age of sixteen years (including apprentices), this minimum is twelve working days. The holiday may be deferred by agreement between employer and worker, provided the holiday-earning period shall not exceed 24 months continuous service.',
    keywords: ['annual leave', '6 days', 'continuous service', '12 months'],
    payroll_codes: ['1600'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-s54', article_numero: 'Section 54',
    titre: 'Labour Act CAP L1 — Part VI',
    titre_article: 'Maternity leave and protection',
    texte: 'A female worker shall be entitled to twelve weeks of maternity leave (six weeks before and six weeks after delivery). She shall, if she has been in continuous employment for six months or more, be entitled to receive not less than fifty percent (50%) of the wages she would have earned had she not been absent. Dismissal during maternity leave or for pregnancy-related reasons is unlawful.',
    keywords: ['maternity', '12 weeks', '50%', 'six months service', 'protection'],
    payroll_codes: ['1700'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-s55', article_numero: 'Section 55',
    titre: 'Labour Act CAP L1 — Part VI',
    titre_article: 'Nursing breaks',
    texte: 'Where a nursing mother resumes work after maternity leave, she shall be entitled, for a period of six months, to be allowed one half-hour twice daily during her working hours, for the purpose of nursing her child.',
    keywords: ['nursing', 'breastfeeding', 'breaks', '6 months'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-pra-2014', article_numero: 'PRA 2014',
    titre: 'Pension Reform Act 2014',
    titre_article: 'Mandatory pension contribution',
    texte: 'Under the Pension Reform Act 2014, both employer and employee make mandatory contributions to a Retirement Savings Account (RSA). Minimum rates: employer 10% of monthly emoluments, employee 8% of monthly emoluments. "Monthly emoluments" means basic salary, housing and transport allowances. Companies with fewer than 3 employees are exempt.',
    keywords: ['pension', 'PRA 2014', 'RSA', 'PenCom', '10%', '8%'],
    payroll_codes: ['2000', '3000'] },

  { ...P, source: 'fiscal_its', country_code: 'NGA', article_id: 'nga-paye-2024',
    article_numero: 'Personal Income Tax Act',
    titre: 'Personal Income Tax Act — PAYE 2024',
    titre_article: 'PAYE — Annual tax bands (pre-NTA 2025)',
    texte: 'PAYE annual bands (PITA, current 2024) : 7% (first 300 000 NGN), 11% (next 300 000), 15% (next 500 000), 19% (next 500 000), 21% (next 1 600 000), 24% (above 3 200 000). Consolidated Relief Allowance (CRA) deductible : 200 000 NGN + 20% of gross income. Note: Nigeria Tax Act (NTA) 2025 introduces a more progressive scale effective 2026.',
    keywords: ['PAYE', 'bands', 'CRA', 'NTA 2025'],
    payroll_codes: ['2100'] },

  { ...P, source: LABOUR_ACT, article_id: 'nga-min-wage', article_numero: 'National Minimum Wage Act 2024',
    titre_article: 'National Minimum Wage — NGN 70,000',
    texte: 'The National Minimum Wage Act 2024 sets the national minimum wage at NGN 70,000 per month, effective 1 May 2024 (replacing the previous NGN 30,000). Employees earning at or below the minimum wage are exempt from PAYE deductions.',
    keywords: ['minimum wage', 'NGN 70 000', 'PAYE exempt'],
    payroll_codes: ['1000'] },
]
