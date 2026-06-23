/**
 * Jours fériés légaux de Côte d'Ivoire (ABS-008).
 *
 * Couvre les jours fériés à DATE FIXE + les fêtes chrétiennes mobiles (calculées
 * à partir de Pâques). Les fêtes musulmanes (Aïd el-Fitr, Tabaski/Aïd el-Adha,
 * Maouloud) suivent le calendrier lunaire : leurs dates varient chaque année et
 * doivent être renseignées par tenant/année (table de paramétrage) — non incluses
 * ici. Le surensemble fixe + chrétien couvre la majorité des cas, dont la Fête
 * Nationale (7 août).
 *
 * Serveur en Africa/Abidjan (UTC) : les comparaisons de dates (YYYY-MM-DD) sont
 * faites sur les composantes locales = UTC, donc sans décalage.
 */

function pad(n: number): string { return n < 10 ? `0${n}` : String(n) }
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

/** Dimanche de Pâques (algorithme grégorien anonyme de Meeus/Jones/Butcher). */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3 = mars, 4 = avril
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

/** Ensemble des jours fériés CI (YYYY-MM-DD) pour une année donnée. */
export function joursFeriesCI(year: number): Set<string> {
  const set = new Set<string>()
  // Dates fixes (Code du Travail CI + décrets)
  for (const md of ['01-01', '05-01', '08-07', '08-15', '11-01', '11-15', '12-25']) {
    set.add(`${year}-${md}`)
  }
  // Fêtes chrétiennes mobiles (à partir de Pâques)
  const easter = easterSunday(year)
  const addOffset = (offset: number) => {
    const d = new Date(easter); d.setUTCDate(d.getUTCDate() + offset); set.add(ymd(d))
  }
  addOffset(1)  // Lundi de Pâques
  addOffset(39) // Ascension (jeudi)
  addOffset(50) // Lundi de Pentecôte
  return set
}

/** Le jour donné (Date) est-il férié en CI ? */
export function estJourFerieCI(d: Date): boolean {
  return joursFeriesCI(d.getFullYear()).has(ymd(d))
}
