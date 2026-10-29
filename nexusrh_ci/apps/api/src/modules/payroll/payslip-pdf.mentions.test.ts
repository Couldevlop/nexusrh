/**
 * Bulletin PDF — mentions obligatoires (Code du travail CI) + libellé du mode
 * de paiement + avertissement RH (aperçu uniquement). Le texte est extrait des
 * flux de contenu du PDF généré (pdf-lib : flux Flate, texte en hexa WinAnsi).
 */
import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { renderPayslipPdf, type PayslipPdfData } from './payslip-pdf.js'

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    let content: string
    try { content = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1') } catch { content = m[1]! }
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      out.push(Buffer.from(t[1]!, 'hex').toString('latin1'))
    }
    for (const t of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]!)
  }
  return out.join('\n')
}

const base: PayslipPdfData = {
  tenantName: 'SOTRA',
  employer: { cnpsNumber: 'CI-0123456', city: 'Abidjan', rccm: 'CI-ABJ-2010-B-0045', dgiNumber: '1234567A' },
  employee: {
    firstName: 'Kouassi', lastName: 'Coulibaly', jobTitle: 'Comptable',
    cnpsNumber: 'CI-7654321', hireDate: '2019-03-15', category: '5ème catégorie',
  },
  month: '2026-10',
  lines: [{ code: '1000', label: 'Salaire de base', type: 'earning', base: 300000, amount: 300000 }],
  grossSalary: 300000, totalCnpsSal: 18900, its: 5000, totalDeductions: 23900,
  netPayable: 276100, employerCost: 340000, currency: 'XOF',
  paymentMethod: 'bank_transfer',
  worked: { days: 28, hours: 161.78 },
  leaveBalance: { year: 2026, acquired: 22, taken: 5, remaining: 17 },
}

describe('Bulletin PDF — mentions obligatoires', () => {
  it('imprime embauche + ancienneté, catégorie, temps de travail, congés, RCCM/DGI', async () => {
    const txt = pdfText(await renderPayslipPdf(base))
    expect(txt).toContain('Embauche : 15/03/2019')
    expect(txt).toContain('7 ans 7 mois')
    expect(txt).toContain('Catégorie : 5ème catégorie')
    expect(txt).toContain('28,0 jours')
    expect(txt).toContain('161,8 heures')
    expect(txt).toContain('acquis 22,0 j')
    expect(txt).toContain('restant 17,0 j')
    expect(txt).toContain('RCCM : CI-ABJ-2010-B-0045')
    expect(txt).toContain('(DGI) : 1234567A')
    expect(txt).toContain('N° CNPS employeur : CI-0123456')
    expect(txt).toContain('N° CNPS : CI-7654321')
  })

  it('caisse sociale du pack côté salarié ET employeur (Burkina : CNSS, Sénégal : IPRES)', async () => {
    const bf = pdfText(await renderPayslipPdf({
      ...base, caisseLabel: 'CNSS', impotLabel: 'IUTS — Impôt Unique sur Traitements et Salaires',
    }))
    expect(bf).toContain('N° CNSS employeur : CI-0123456')
    expect(bf).toContain('N° CNSS : CI-7654321')
    expect(bf).not.toContain('N° CNPS')
    const sn = pdfText(await renderPayslipPdf({ ...base, caisseLabel: 'IPRES + CSS', impotLabel: 'IR — Impôt sur le Revenu' }))
    expect(sn).toContain('N° IPRES : CI-7654321')
  })

  it('mode de paiement : libellé lisible, jamais le code brut', async () => {
    const t1 = pdfText(await renderPayslipPdf(base))
    expect(t1).toContain('Mode de paiement : Virement bancaire')
    expect(t1).not.toContain('bank_transfer')
    const t2 = pdfText(await renderPayslipPdf({ ...base, paymentMethod: 'mtn_momo' }))
    expect(t2).toContain('Mode de paiement : MTN MoMo')
    const t3 = pdfText(await renderPayslipPdf({ ...base, paymentMethod: 'mobile_money' }))
    expect(t3).toContain('Mode de paiement : Mobile Money')
  })

  it('N° CNPS employeur manquant : avertissement en aperçu RH seulement', async () => {
    const noCnps = { ...base, employer: { ...base.employer, cnpsNumber: null } }
    const hr = pdfText(await renderPayslipPdf({ ...noCnps, hrPreview: true }))
    expect(hr).toContain('ATTENTION (aperçu RH)')
    const employeeCopy = pdfText(await renderPayslipPdf(noCnps))
    expect(employeeCopy).not.toContain('ATTENTION')
    const complete = pdfText(await renderPayslipPdf({ ...base, hrPreview: true }))
    expect(complete).not.toContain('ATTENTION')
  })

  it('le bloc identité (mentions légales) reste présent même si la config tenant l’omet', async () => {
    const txt = pdfText(await renderPayslipPdf({
      ...base,
      template: { blocks: [{ id: 'table', enabled: true }, { id: 'identity', enabled: false }, { id: 'net', enabled: true }] },
    }))
    expect(txt).toContain('Embauche : 15/03/2019')
  })
})
