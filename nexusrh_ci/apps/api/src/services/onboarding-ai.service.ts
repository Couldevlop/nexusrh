/**
 * Génération IA d'un parcours d'intégration — propulsé par Claude.
 *
 * Innovation : les RH décrivent le poste (intitulé, séniorité, contexte) et
 * l'IA produit un parcours complet calé sur les meilleures pratiques RH
 * (pré-boarding, jour J, première semaine, premier mois, fin de période
 * d'essai), avec responsables (RH, manager, collaborateur, IT, parrain),
 * échéances relatives à la date d'embauche et suggestions de ressources
 * (documents, vidéos, liens utiles). Le résultat est un BROUILLON éditable —
 * jamais enregistré sans validation humaine.
 *
 * Sécurité :
 *   A02 — clé API par tenant (chiffrée) via resolveAiCreds, repli plateforme.
 *   A03 — entrées utilisateur assainies avant injection dans le prompt ;
 *         sortie IA validée par Zod (types, enums, bornes) avant retour.
 */
import { z } from 'zod'
import { config } from '../config.js'
import { resolveAiCreds, type AiCreds } from './ai-credentials.service.js'
import { ONBOARDING_PHASES, ONBOARDING_OWNERS } from '../db/onboarding-tables.js'

const generatedResourceSchema = z.object({
  type:  z.enum(['document', 'video', 'link']),
  title: z.string().min(1).max(200),
  url:   z.string().max(2000).optional().default(''),
})

const generatedStepSchema = z.object({
  title:         z.string().min(1).max(255),
  description:   z.string().max(2000).optional().default(''),
  phase:         z.enum(ONBOARDING_PHASES),
  ownerRole:     z.enum(ONBOARDING_OWNERS),
  dueOffsetDays: z.number().int().min(-30).max(365),
  resources:     z.array(generatedResourceSchema).max(6).optional().default([]),
})

const generatedPlanSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  steps:       z.array(generatedStepSchema).min(3).max(40),
})

export type GeneratedOnboardingPlan = z.infer<typeof generatedPlanSchema>

// Anti prompt-injection : neutralise sauts de ligne / espaces multiples, borne.
function sanitize(raw: string | undefined, max = 200): string {
  if (!raw) return ''
  return raw.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

const SYSTEM_PROMPT = `Tu es un expert RH senior spécialisé dans l'onboarding (parcours d'intégration) en Afrique de l'Ouest, notamment en Côte d'Ivoire.
Tu conçois des parcours d'intégration selon les meilleures pratiques internationales :
- pré-boarding avant l'arrivée (contrat, matériel, annonce à l'équipe, message de bienvenue) ;
- jour J structuré (accueil, visite, remise du matériel, déjeuner d'équipe) ;
- première semaine (formations obligatoires : sécurité, outils ; rencontres clés ; définition des objectifs) ;
- premier mois (montée en compétence, point manager, feedback mutuel) ;
- fin de période d'essai (bilan, entretien de confirmation, plan de développement) ;
- un parrain/buddy est systématiquement assigné.
Tu réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format :
{
  "name": "string (nom du modèle)",
  "description": "string",
  "steps": [
    {
      "title": "string",
      "description": "string (1-2 phrases concrètes)",
      "phase": "before_start" | "day_one" | "first_week" | "first_month" | "probation_end",
      "ownerRole": "hr" | "manager" | "employee" | "it" | "buddy",
      "dueOffsetDays": number (jours par rapport à la date d'embauche, négatif = avant l'arrivée),
      "resources": [{ "type": "document" | "video" | "link", "title": "string", "url": "string (vide si à compléter par les RH)" }]
    }
  ]
}
Contraintes : 12 à 20 étapes, réparties sur les 5 phases ; descriptions en français ; ressources suggérées pertinentes (url vide quand il s'agit d'un document interne à fournir par l'entreprise).`

function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Réponse IA sans JSON exploitable')
  }
  return JSON.parse(cleaned.slice(start, end + 1))
}

export interface GenerateOnboardingInput {
  jobTitle: string
  seniority?: string
  department?: string
  companyContext?: string
  schemaName: string | null | undefined
}

export async function generateOnboardingPlan(input: GenerateOnboardingInput): Promise<GeneratedOnboardingPlan> {
  const creds: AiCreds = await resolveAiCreds(input.schemaName)
  const apiKey = creds.claude.apiKey
  if (!apiKey) {
    throw new Error('Clé Anthropic non configurée (ANTHROPIC_API_KEY ou clé tenant)')
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey })

  const userPrompt = `Conçois un parcours d'intégration pour le poste suivant :
- Intitulé du poste : ${sanitize(input.jobTitle)}
- Séniorité : ${sanitize(input.seniority) || 'non précisée'}
- Département / équipe : ${sanitize(input.department) || 'non précisé'}
- Contexte entreprise : ${sanitize(input.companyContext, 500) || 'PME ivoirienne, secteur non précisé'}

Retourne le JSON du parcours.`

  const msg = await client.messages.create({
    model:       creds.claude.model,
    max_tokens:  Math.min(config.ai.maxTokens, 4096),
    temperature: 0.4,
    system:      SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userPrompt }],
  })
  const textBlock = msg.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Réponse Claude vide')
  }
  // OWASP A03 — la sortie IA est validée strictement avant d'être renvoyée.
  return generatedPlanSchema.parse(extractJson(textBlock.text))
}
