/**
 * Couverture du service d'extraction de texte de CV.
 *
 * Couvre :
 *  - les constantes/policies exposées (MIME allowlist, tailles max)
 *  - isMagicByteConsistent pour chaque type (PDF, DOCX, DOC, TXT) + cas invalides
 *  - extractCvText : extraction PDF native (unpdf mocké), fallback PDF illisible,
 *    fallback UTF-8 pour les autres types, troncature à MAX_TEXT, jointure de pages.
 *
 * La librairie `unpdf` est mockée pour piloter le succès/échec de l'extraction PDF
 * sans dépendance binaire ni fichier réel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock de la lib d'extraction PDF (import dynamique dans le service).
const { getDocumentProxyMock, extractTextMock } = vi.hoisted(() => ({
  getDocumentProxyMock: vi.fn(),
  extractTextMock: vi.fn(),
}))
vi.mock('unpdf', () => ({
  getDocumentProxy: getDocumentProxyMock,
  extractText: extractTextMock,
}))

import {
  CV_ALLOWED_MIMES,
  CV_MAX_BYTES,
  CV_MAX_BYTES_PUBLIC,
  isMagicByteConsistent,
  extractCvText,
} from './cv-extraction.service.js'

const PDF_MIME = 'application/pdf'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC_MIME = 'application/msword'
const TXT_MIME = 'text/plain'

beforeEach(() => {
  getDocumentProxyMock.mockReset()
  extractTextMock.mockReset()
})

describe('cv-extraction — constantes de politique', () => {
  it('expose les MIME autorisés (PDF, DOC, DOCX, TXT)', () => {
    expect(CV_ALLOWED_MIMES.has(PDF_MIME)).toBe(true)
    expect(CV_ALLOWED_MIMES.has(DOC_MIME)).toBe(true)
    expect(CV_ALLOWED_MIMES.has(DOCX_MIME)).toBe(true)
    expect(CV_ALLOWED_MIMES.has(TXT_MIME)).toBe(true)
    expect(CV_ALLOWED_MIMES.has('application/x-msdownload')).toBe(false)
  })

  it('expose les tailles max RH (10 Mo) et publique (5 Mo)', () => {
    expect(CV_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(CV_MAX_BYTES_PUBLIC).toBe(5 * 1024 * 1024)
  })
})

describe('isMagicByteConsistent — signatures de fichiers (OWASP A03)', () => {
  it('rejette un buffer trop court (< 4 octets)', () => {
    expect(isMagicByteConsistent(Buffer.from([0x25, 0x50]), PDF_MIME)).toBe(false)
  })

  it('accepte un PDF avec la signature %PDF', () => {
    const buf = Buffer.from('%PDF-1.7 contenu', 'utf-8')
    expect(isMagicByteConsistent(buf, PDF_MIME)).toBe(true)
  })

  it('rejette un PDF avec une mauvaise signature', () => {
    const buf = Buffer.from('FAKE not a pdf', 'utf-8')
    expect(isMagicByteConsistent(buf, PDF_MIME)).toBe(false)
  })

  it('accepte un DOCX (signature ZIP PK\\x03\\x04)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
    expect(isMagicByteConsistent(buf, DOCX_MIME)).toBe(true)
  })

  it('accepte un DOCX avec variante PK\\x05', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00])
    expect(isMagicByteConsistent(buf, DOCX_MIME)).toBe(true)
  })

  it('rejette un DOCX avec une mauvaise signature', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(isMagicByteConsistent(buf, DOCX_MIME)).toBe(false)
  })

  it('accepte un DOC (signature OLE D0 CF 11 E0)', () => {
    const buf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00])
    expect(isMagicByteConsistent(buf, DOC_MIME)).toBe(true)
  })

  it('rejette un DOC avec une mauvaise signature', () => {
    const buf = Buffer.from([0x11, 0x22, 0x33, 0x44])
    expect(isMagicByteConsistent(buf, DOC_MIME)).toBe(false)
  })

  it('accepte un TXT (pas de signature fiable)', () => {
    const buf = Buffer.from('un simple texte', 'utf-8')
    expect(isMagicByteConsistent(buf, TXT_MIME)).toBe(true)
  })

  it('normalise le MIME en minuscules', () => {
    const buf = Buffer.from('%PDF-1.4', 'utf-8')
    expect(isMagicByteConsistent(buf, 'APPLICATION/PDF')).toBe(true)
  })

  it('rejette un MIME inconnu (hors allowlist)', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(isMagicByteConsistent(buf, 'image/png')).toBe(false)
  })
})

describe('extractCvText — extraction de texte', () => {
  it('extrait le texte d\'un PDF via unpdf (texte string)', async () => {
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: 'Jean   Konaté\n\n  Développeur  React' })
    const out = await extractCvText(Buffer.from('%PDF-1.4 fake'), PDF_MIME)
    expect(out).toBe('Jean Konaté Développeur React')
    expect(getDocumentProxyMock).toHaveBeenCalledOnce()
  })

  it('joint les pages quand unpdf retourne un tableau de textes', async () => {
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: ['Page 1 contenu', 'Page 2 contenu'] })
    const out = await extractCvText(Buffer.from('%PDF-1.4 fake'), PDF_MIME)
    expect(out).toBe('Page 1 contenu Page 2 contenu')
  })

  it('gère un text null retourné par unpdf (fallback UTF-8 car cleaned vide)', async () => {
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: null })
    const buf = Buffer.from('contenu brut du pdf', 'utf-8')
    const out = await extractCvText(buf, PDF_MIME)
    // cleaned vide → on retombe sur le buffer UTF-8
    expect(out).toBe('contenu brut du pdf')
  })

  it('fallback UTF-8 si l\'extraction PDF échoue (PDF corrompu)', async () => {
    getDocumentProxyMock.mockRejectedValueOnce(new Error('PDF illisible'))
    const buf = Buffer.from('texte de secours', 'utf-8')
    const out = await extractCvText(buf, PDF_MIME)
    expect(out).toBe('texte de secours')
  })

  it('décode un TXT directement en UTF-8 (pas d\'appel unpdf)', async () => {
    const buf = Buffer.from('CV en texte brut', 'utf-8')
    const out = await extractCvText(buf, TXT_MIME)
    expect(out).toBe('CV en texte brut')
    expect(getDocumentProxyMock).not.toHaveBeenCalled()
  })

  it('fallback UTF-8 pour DOCX (extraction native non implémentée)', async () => {
    const buf = Buffer.from('contenu docx', 'utf-8')
    const out = await extractCvText(buf, DOCX_MIME)
    expect(out).toBe('contenu docx')
  })

  it('tronque le texte extrait à 50 000 caractères', async () => {
    const huge = 'a'.repeat(60_000)
    const out = await extractCvText(Buffer.from(huge, 'utf-8'), TXT_MIME)
    expect(out.length).toBe(50_000)
  })

  it('tronque aussi le texte PDF extrait à 50 000 caractères', async () => {
    getDocumentProxyMock.mockResolvedValueOnce({})
    extractTextMock.mockResolvedValueOnce({ text: 'x'.repeat(60_000) })
    const out = await extractCvText(Buffer.from('%PDF-1.4 fake'), PDF_MIME)
    expect(out.length).toBe(50_000)
  })
})
