/**
 * Lecture du fichier déposé pour la reprise de données.
 *
 * Deux formats, un seul résultat. Le modèle téléchargé est un CSV, mais le
 * client l'ouvre dans Excel, le remplit et l'enregistre en .xlsx — c'est le
 * geste naturel, et jusqu'ici l'application le refusait.
 *
 * Le CSV est lu dans le navigateur ; le classeur est lu par le serveur, qui a
 * déjà la bibliothèque pour ça (l'embarquer dans le bundle coûterait plus d'un
 * mégaoctet à tous les écrans pour servir un seul geste). Les deux chemins
 * rendent la MÊME forme, et la suite — validation des colonnes, envoi à
 * l'import — ne sait pas lequel a été emprunté.
 */
import { api } from '@/lib/api'

export interface ImportTable {
  headers: string[]
  rows: string[][]
}

/** Formats acceptés au dépôt, et valeur de l'attribut `accept`. */
export const IMPORT_ACCEPTED_EXTENSIONS = ['.csv', '.xlsx'] as const
export const IMPORT_ACCEPT_ATTR = IMPORT_ACCEPTED_EXTENSIONS.join(',')

/** Fichier refusé pour une raison que l'utilisateur peut corriger. */
export class ImportFileError extends Error {}

export function extensionAcceptee(nom: string): boolean {
  const n = nom.toLowerCase()
  return IMPORT_ACCEPTED_EXTENSIONS.some((e) => n.endsWith(e))
}

export function estClasseur(nom: string): boolean {
  return nom.toLowerCase().endsWith('.xlsx')
}

export function parseCSV(text: string): ImportTable {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean.split('\n').filter((l) => l.trim())
  if (!lines[0]) return { headers: [], rows: [] }
  const sep = lines[0].includes(';') ? ';' : ','
  const splitLine = (l: string) => l.split(sep).map((v) => v.trim().replace(/^"|"$/g, ''))
  return {
    headers: splitLine(lines[0]),
    rows: lines.slice(1).map(splitLine).filter((r) => r.some((v) => v)),
  }
}

/**
 * Rend le contenu du fichier sous la forme attendue par l'import.
 *
 * Le message d'erreur du serveur est repris TEL QUEL : il dit précisément ce
 * qui cloche dans le classeur (feuille absente, trop de colonnes, fichier qui
 * n'est pas un .xlsx), ce qu'un message générique effacerait.
 */
export async function lireFichierImport(file: File): Promise<ImportTable> {
  if (!estClasseur(file.name)) return parseCSV(await file.text())

  const form = new FormData()
  form.append('file', file, file.name)
  try {
    const res = await api.post<{ data: ImportTable }>('/settings/import/parse', form)
    return res.data.data
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } }
    throw new ImportFileError(e.response?.data?.error ?? 'Classeur illisible.')
  }
}
