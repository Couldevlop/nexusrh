// Analyse lcov.info : classement des fichiers par lignes non couvertes.
// Usage : node scripts/coverage-summary.mjs [coverage/lcov.info]
import { readFileSync } from 'node:fs'

const lcovPath = process.argv[2] ?? 'coverage/lcov.info'
let raw
try {
  raw = readFileSync(lcovPath, 'utf8')
} catch (err) {
  console.error(`Impossible de lire ${lcovPath}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const records = raw.split('end_of_record')
const files = []
for (const rec of records) {
  const sf = rec.match(/SF:(.+)/)
  if (!sf) continue
  const lf = Number(rec.match(/LF:(\d+)/)?.[1] ?? 0)
  const lh = Number(rec.match(/LH:(\d+)/)?.[1] ?? 0)
  const brf = Number(rec.match(/BRF:(\d+)/)?.[1] ?? 0)
  const brh = Number(rec.match(/BRH:(\d+)/)?.[1] ?? 0)
  // Plages de lignes non couvertes (DA:line,0)
  const missed = [...rec.matchAll(/DA:(\d+),0/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
  const ranges = []
  for (const line of missed) {
    const last = ranges[ranges.length - 1]
    if (last && line === last[1] + 1) last[1] = line
    else ranges.push([line, line])
  }
  files.push({
    file: sf[1].replace(/\\/g, '/').replace(/^.*?src\//, 'src/'),
    lf, lh, missed: lf - lh,
    pct: lf ? (100 * lh) / lf : 100,
    brPct: brf ? (100 * brh) / brf : 100,
    ranges: ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(','),
  })
}

const totLf = files.reduce((s, f) => s + f.lf, 0)
const totLh = files.reduce((s, f) => s + f.lh, 0)
console.log(`TOTAL lignes : ${totLh}/${totLf} = ${((100 * totLh) / totLf).toFixed(2)}%`)
console.log(`Objectif 98% → il faut couvrir ${Math.max(0, Math.ceil(totLf * 0.98) - totLh)} lignes de plus\n`)

const full = process.argv.includes('--full')
files.sort((a, b) => b.missed - a.missed)
for (const f of files.filter((f) => f.missed > 0)) {
  console.log(`${f.missed.toString().padStart(5)} manquantes | ${f.pct.toFixed(1).padStart(5)}% L | ${f.brPct.toFixed(1).padStart(5)}% B | ${f.file}`)
  if (full || f.missed <= 40) console.log(`      lignes : ${f.ranges}`)
}
