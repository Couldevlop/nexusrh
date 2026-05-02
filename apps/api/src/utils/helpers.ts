import crypto from 'crypto'

export function generateEmployeeNumber(entityPrefix: string, sequence: number): string {
  return `${entityPrefix.toUpperCase().slice(0, 3)}${String(sequence).padStart(5, '0')}`
}

export function encryptField(value: string, key: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(key.padEnd(32).slice(0, 32)),
    iv
  )
  let encrypted = cipher.update(value, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return `${iv.toString('hex')}:${encrypted}`
}

export function decryptField(encryptedValue: string, key: string): string {
  const [ivHex, encrypted] = encryptedValue.split(':')
  if (!ivHex || !encrypted) throw new Error('Format de valeur chiffrée invalide')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key.padEnd(32).slice(0, 32)),
    iv
  )
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

export function workingDaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate()
  let workDays = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay()
    if (day !== 0 && day !== 6) workDays++
  }
  return workDays
}

export function frenchHolidays(year: number): Date[] {
  const easterOffset = getEasterOffset(year)
  const easter = new Date(year, 2, easterOffset)

  const addDays = (date: Date, days: number): Date => {
    const result = new Date(date)
    result.setDate(result.getDate() + days)
    return result
  }

  return [
    new Date(year, 0, 1),    // Jour de l'an
    addDays(easter, 1),       // Lundi de Pâques
    new Date(year, 4, 1),     // Fête du Travail
    new Date(year, 4, 8),     // Victoire 1945
    addDays(easter, 39),      // Ascension
    addDays(easter, 50),      // Lundi de Pentecôte
    new Date(year, 6, 14),    // Bastille
    new Date(year, 7, 15),    // Assomption
    new Date(year, 10, 1),    // Toussaint
    new Date(year, 10, 11),   // Armistice
    new Date(year, 11, 25),   // Noël
  ]
}

function getEasterOffset(year: number): number {
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
  return h + l - 7 * m + 114 - 31 * Math.floor((h + l - 7 * m + 114) / 31)
}

export function formatCurrency(amount: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
  }).format(amount)
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

export function maskNIR(nir: string): string {
  if (nir.length < 4) return '***'
  return '*'.repeat(nir.length - 4) + nir.slice(-4)
}

export function maskIBAN(iban: string): string {
  const clean = iban.replace(/\s/g, '')
  if (clean.length < 8) return '****'
  return clean.slice(0, 4) + ' **** **** ' + clean.slice(-4)
}
