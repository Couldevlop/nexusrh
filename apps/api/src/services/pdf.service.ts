import PDFDocument from 'pdfkit'
import { PassThrough } from 'stream'
import type { PaySlip } from '../db/schema/payroll'
import type { Employee } from '../db/schema/employees'
import type { LegalEntity } from '../db/schema/employees'
import { formatCurrency } from '../utils/helpers'

const MONTHS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
]

export async function generatePaySlipPdf(
  paySlip: PaySlip & { employee: Employee; entity: LegalEntity }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Bulletin de paie — ${MONTHS_FR[(paySlip.month ?? 1) - 1]} ${paySlip.year}`,
        Author: 'NexusRH',
      },
    })

    const chunks: Buffer[] = []
    const stream = new PassThrough()

    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    doc.pipe(stream)

    // === HEADER ENTREPRISE ===
    doc
      .fillColor('#4F46E5')
      .rect(0, 0, doc.page.width, 80)
      .fill()

    doc
      .fillColor('white')
      .fontSize(20)
      .font('Helvetica-Bold')
      .text(paySlip.entity.name, 40, 25)

    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `SIRET : ${paySlip.entity.siret ?? 'N/A'} — Code APE : ${paySlip.entity.apeCode ?? 'N/A'}`,
        40,
        50
      )

    // === TITRE BULLETIN ===
    doc
      .fillColor('#1F2937')
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(
        `BULLETIN DE PAIE — ${(MONTHS_FR[(paySlip.month ?? 1) - 1] ?? '').toUpperCase()} ${paySlip.year}`,
        { align: 'center' }
      )
      .moveDown(0.5)

    // === INFOS SALARIÉ ===
    doc.fontSize(10).font('Helvetica')
    const yStart = 120

    // Colonne gauche : employé
    doc
      .fillColor('#374151')
      .font('Helvetica-Bold')
      .text('SALARIÉ', 40, yStart)
      .font('Helvetica')
      .text(
        `${paySlip.employee.firstName} ${paySlip.employee.lastName}`,
        40,
        yStart + 15
      )
      .text(`N° employé : ${paySlip.employee.employeeNumber ?? 'N/A'}`, 40, yStart + 28)
      .text(`Poste : ${paySlip.employee.jobTitle ?? 'N/A'}`, 40, yStart + 41)

    // Colonne droite : période
    doc
      .font('Helvetica-Bold')
      .text('PÉRIODE', 350, yStart)
      .font('Helvetica')
      .text(
        `Du 1er au ${new Date(paySlip.year ?? 0, (paySlip.month ?? 1) - 1, 0).getDate()} ${MONTHS_FR[(paySlip.month ?? 1) - 1]} ${paySlip.year}`,
        350,
        yStart + 15
      )
      .text(`Jours travaillés : ${paySlip.workingDays ?? 0}`, 350, yStart + 28)

    // === LIGNE SÉPARATRICE ===
    const tableTop = yStart + 65
    doc
      .moveTo(40, tableTop)
      .lineTo(doc.page.width - 40, tableTop)
      .strokeColor('#E5E7EB')
      .stroke()

    // === EN-TÊTES TABLEAU ===
    doc
      .fillColor('white')
      .rect(40, tableTop + 1, doc.page.width - 80, 20)
      .fill('#4F46E5')

    doc
      .fillColor('white')
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('Désignation', 45, tableTop + 5)
      .text('Base', 260, tableTop + 5)
      .text('Tx. Sal.', 320, tableTop + 5)
      .text('Montant sal.', 370, tableTop + 5)
      .text('Tx. Pat.', 430, tableTop + 5)
      .text('Montant pat.', 480, tableTop + 5)

    // === LIGNES BULLETIN ===
    let currentY = tableTop + 25
    const lines = paySlip.lines as Array<{
      ruleCode: string
      label: string
      base: number
      employeeRate?: number
      employerRate?: number
      employeeAmount: number
      employerAmount: number
      type: string
    }>

    let lastType = ''
    for (const line of lines) {
      if (line.type !== lastType) {
        lastType = line.type
        const sectionLabel =
          line.type === 'earning' ? 'ÉLÉMENTS DE RÉMUNÉRATION' :
          line.type === 'employee_contribution' ? 'COTISATIONS SALARIALES' :
          line.type === 'employer_contribution' ? 'COTISATIONS PATRONALES' :
          line.type === 'deduction' ? 'RETENUES' : ''

        if (sectionLabel) {
          doc
            .fillColor('#F3F4F6')
            .rect(40, currentY - 2, doc.page.width - 80, 16)
            .fill()
          doc
            .fillColor('#374151')
            .fontSize(8)
            .font('Helvetica-Bold')
            .text(sectionLabel, 45, currentY + 1)
          currentY += 18
        }
      }

      doc
        .fillColor('#374151')
        .fontSize(8.5)
        .font('Helvetica')
        .text(line.label, 45, currentY, { width: 210 })
        .text(formatCurrency(line.base), 255, currentY, { align: 'right', width: 60 })

      if (line.employeeRate) {
        doc.text(`${(line.employeeRate * 100).toFixed(2)}%`, 318, currentY, {
          align: 'right',
          width: 45,
        })
      }

      doc
        .fillColor(line.employeeAmount < 0 ? '#DC2626' : '#111827')
        .text(formatCurrency(Math.abs(line.employeeAmount)), 368, currentY, {
          align: 'right',
          width: 55,
        })

      if (line.employerRate) {
        doc
          .fillColor('#374151')
          .text(`${(line.employerRate * 100).toFixed(2)}%`, 427, currentY, {
            align: 'right',
            width: 45,
          })
      }

      if (line.employerAmount > 0) {
        doc
          .fillColor('#374151')
          .text(formatCurrency(line.employerAmount), 477, currentY, {
            align: 'right',
            width: 60,
          })
      }

      currentY += 14

      if (currentY > doc.page.height - 150) {
        doc.addPage()
        currentY = 40
      }
    }

    // === TOTAUX ===
    currentY += 10
    doc
      .moveTo(40, currentY)
      .lineTo(doc.page.width - 40, currentY)
      .strokeColor('#4F46E5')
      .lineWidth(2)
      .stroke()
    currentY += 8

    const totals = [
      { label: 'SALAIRE BRUT', value: formatCurrency(Number(paySlip.grossSalary)), bold: true },
      {
        label: 'Total cotisations salariales',
        value: formatCurrency(
          Number(paySlip.grossSalary) - Number(paySlip.netBeforeTax ?? 0)
        ),
        bold: false,
      },
      { label: 'NET AVANT IMPÔT', value: formatCurrency(Number(paySlip.netBeforeTax)), bold: true },
      {
        label: 'Prélèvement à la source',
        value: `-${formatCurrency(Number(paySlip.incomeTax))}`,
        bold: false,
      },
      {
        label: 'NET À PAYER',
        value: formatCurrency(Number(paySlip.netPayable)),
        bold: true,
        highlight: true,
      },
    ]

    for (const total of totals) {
      if (total.highlight) {
        doc
          .fillColor('#4F46E5')
          .rect(40, currentY - 3, doc.page.width - 80, 20)
          .fill()
        doc.fillColor('white')
      } else {
        doc.fillColor('#374151')
      }

      doc
        .fontSize(10)
        .font(total.bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(total.label, 45, currentY)
        .text(total.value, 0, currentY, {
          align: 'right',
          width: doc.page.width - 80,
        })

      currentY += 22
    }

    // === PIED DE PAGE ===
    doc
      .fontSize(8)
      .fillColor('#9CA3AF')
      .text(
        `Ce bulletin de paie est généré électroniquement par NexusRH — ${new Date().toLocaleDateString('fr-FR')}`,
        40,
        doc.page.height - 50,
        { align: 'center' }
      )

    doc.end()
  })
}
