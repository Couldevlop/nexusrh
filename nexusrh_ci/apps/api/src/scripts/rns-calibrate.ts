#!/usr/bin/env tsx
/**
 * Génère un PDF de calibration du Relevé Nominatif des Salaires (RNS).
 *
 * Le PDF superpose au template officiel CNPS :
 *  - Une grille graduée tous les 10 pt (axes x et y depuis le haut)
 *  - Un point rouge + label de chaque zone définie dans rns-coords.json
 *
 * Usage : `pnpm --filter api run rns:calibrate`
 *
 * Comment ajuster un décalage :
 *  1. Lancer la commande → produit dist/rns-calibration.pdf
 *  2. Ouvrir le PDF, comparer chaque marqueur rouge au cadre vierge du
 *     formulaire officiel
 *  3. Mesurer l'écart (x ou y) puis ajuster apps/api/src/assets/rns-coords.json
 *  4. Relancer la commande pour vérifier l'alignement
 *  5. Une fois OK, regénérer un RNS réel pour confirmer
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRnsCalibrationPdf } from '../services/rns-pdf.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR   = path.resolve(__dirname, '..', '..', 'dist')

async function main(): Promise<void> {
  try { mkdirSync(OUT_DIR, { recursive: true }) } catch { /* ok */ }
  const buf  = await generateRnsCalibrationPdf()
  const out  = path.join(OUT_DIR, 'rns-calibration.pdf')
  writeFileSync(out, buf)
  console.log(`✓ Calibration PDF généré : ${out}`)
  console.log(`  Ouvrez-le, comparez avec rns-template.pdf, ajustez rns-coords.json.`)
}

main().catch((err: unknown) => {
  console.error('Échec calibration :', err)
  process.exit(1)
})
