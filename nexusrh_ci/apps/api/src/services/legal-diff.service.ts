/**
 * Analyse de différence entre un texte légal proposé et l'article actuel.
 *
 * Usage : un super_admin colle (ou un worker scraper fetch) un texte
 * candidat. Ce service appelle Claude pour :
 *   1. Détecter les changements substantiels (vs reformulations cosmétiques)
 *   2. Évaluer la confiance (0-100) qu'il s'agit d'une vraie mise à jour
 *      légale et non d'un faux positif
 *   3. Résumer les changements clés en 2-3 phrases
 *   4. Expliciter le raisonnement
 *
 * OWASP :
 *  - A02 : aucune clé en log, prompt strictement borné
 *  - A04 : refuse les textes > 30k chars (anti-DoS sur tokens Claude)
 *  - A09 : retourne suffisamment d'info pour audit_log côté route
 */
import { config } from '../config.js'

export interface DiffResult {
  has_changes:    boolean    // false = textes équivalents (juste reformulation)
  confidence:     number     // 0-100 — confiance qu'il s'agit d'une vraie MAJ légale
  summary:        string     // résumé court (2-3 phrases)
  reasoning:      string     // explication détaillée
  key_changes:    string[]   // bullet points des changements majeurs
  risk_level:     'low' | 'medium' | 'high'  // impact métier
  model_used:     string
}

const MAX_TEXT_LENGTH = 30_000  // anti-DoS tokens

function buildPrompt(currentText: string | null, proposedText: string, context?: string): string {
  return `Tu es un juriste expert en droit social ivoirien et OHADA.

Compare le texte légal actuel et le texte proposé en remplacement. Détermine s'il s'agit d'une vraie mise à jour législative ou d'une simple reformulation.

${context ? `CONTEXTE : ${context}\n\n` : ''}TEXTE ACTUEL :
${currentText ?? '(aucun — création d\'un nouvel article)'}

TEXTE PROPOSÉ :
${proposedText}

Réponds UNIQUEMENT en JSON valide (sans markdown, sans préambule) avec cette structure exacte :
{
  "has_changes": true|false,
  "confidence": <0-100>,
  "summary": "<résumé en 2-3 phrases en français>",
  "reasoning": "<explication détaillée du diff>",
  "key_changes": ["<changement 1>", "<changement 2>"],
  "risk_level": "low" | "medium" | "high"
}

Critères :
- confidence ≥ 80 si le texte proposé contient clairement des modifications de taux, plafonds, dates, formules ou règles légales nouvelles
- confidence < 50 si c'est juste une reformulation ou changement de ponctuation
- risk_level = "high" si impact direct sur la paie (taux, plafonds, formules), "medium" si processus RH, "low" si purement déclaratif`
}

function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('{')
  const end   = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Réponse IA sans JSON exploitable')
  }
  return JSON.parse(cleaned.slice(start, end + 1))
}

function normalize(raw: unknown, model: string): DiffResult {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse IA invalide')
  const r = raw as Record<string, unknown>
  const confidence = Math.max(0, Math.min(100, Math.round(Number(r['confidence']) || 0)))
  const risk = (['low', 'medium', 'high'] as const).find(v => v === r['risk_level']) ?? 'medium'
  return {
    has_changes: r['has_changes'] === true,
    confidence,
    summary:     typeof r['summary']   === 'string' ? r['summary']   : '',
    reasoning:   typeof r['reasoning'] === 'string' ? r['reasoning'] : '',
    key_changes: Array.isArray(r['key_changes'])
      ? (r['key_changes'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
      : [],
    risk_level: risk,
    model_used: model,
  }
}

export async function analyzeLegalDiff(
  currentText: string | null,
  proposedText: string,
  context?: string,
): Promise<DiffResult> {
  if (!proposedText || proposedText.trim().length < 10) {
    throw new Error('Texte proposé trop court (minimum 10 caractères)')
  }
  if (proposedText.length > MAX_TEXT_LENGTH) {
    throw new Error(`Texte proposé trop long (max ${MAX_TEXT_LENGTH} caractères)`)
  }
  if (currentText && currentText.length > MAX_TEXT_LENGTH) {
    throw new Error(`Texte actuel trop long (max ${MAX_TEXT_LENGTH} caractères)`)
  }
  if (!config.ai.apiKey) {
    throw new Error('Clé Anthropic non configurée (ANTHROPIC_API_KEY)')
  }

  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey: config.ai.apiKey })
  const msg = await client.messages.create({
    model:       config.ai.model,
    max_tokens:  2048,
    temperature: 0.1,  // factualité maximale pour l'analyse légale
    messages:    [{ role: 'user', content: buildPrompt(currentText, proposedText, context) }],
  })
  const textBlock = msg.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Réponse Claude vide')
  }
  return normalize(extractJson(textBlock.text), config.ai.model)
}

// Exports internes pour tests
export const __internals = { buildPrompt, extractJson, normalize, MAX_TEXT_LENGTH }
