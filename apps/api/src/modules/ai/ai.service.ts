import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../utils/logger'

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey })

const NEXUSRH_SYSTEM = `Tu es NexusRH AI, l'assistant RH intelligent du SIRH NexusRH.
Tu es expert certifié en :
- Droit du travail français (Code du travail, CSS, jurisprudence)
- Gestion de la paie et cotisations sociales
- Convention collective (SYNTEC, Métallurgie, Commerce, BTP, etc.)
- RGPD appliqué aux RH
- Management et développement des talents

RÈGLES STRICTES :
1. Toujours répondre en français
2. Citer les textes légaux applicables (articles, décrets, circulaires)
3. Ne jamais divulguer le salaire d'un collaborateur à un autre
4. Signaler les délais légaux critiques avec ⚠️
5. Mentionner l'incertitude quand nécessaire
6. Pour les cas complexes : recommander un conseil juridique

CONTEXTE ENTREPRISE fourni dans chaque message.
DATE ACTUELLE : ${new Date().toLocaleDateString('fr-FR', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})}`

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompanyContext {
  name: string
  employeeCount: number
  collectiveAgreement?: string
  country: string
  currentUser: { name: string; role: string }
  pageContext?: Record<string, unknown>
}

export async function* streamChat(
  messages: ChatMessage[],
  context: CompanyContext
): AsyncGenerator<string> {
  const systemWithContext = `${NEXUSRH_SYSTEM}

[CONTEXTE ENTREPRISE]
${JSON.stringify(context, null, 2)}`

  try {
    const stream = await anthropic.messages.stream({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemWithContext,
      messages,
    })

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta'
      ) {
        yield chunk.delta.text
      }
    }
  } catch (err) {
    logger.error({ err }, 'Erreur streaming Claude')
    yield '\n\n*Une erreur est survenue. Veuillez réessayer.*'
  }
}

export async function generateHRDocument(
  documentType: string,
  data: Record<string, unknown>
): Promise<string> {
  const typePrompts: Record<string, string> = {
    cdi: 'un contrat de travail à durée indéterminée (CDI) complet et conforme au droit du travail français',
    cdd: 'un contrat de travail à durée déterminée (CDD) complet avec tous les éléments obligatoires selon L1242-12 CT',
    internship:
      'une convention de stage conforme à la loi du 10 juillet 2014 et L124-1 CT',
    job_offer:
      "une offre d'emploi attractive, inclusive (écriture inclusive), optimisée SEO, conforme aux règles de non-discrimination L1132-1 CT",
    warning:
      "un avertissement disciplinaire conforme à la procédure légale (entretien préalable si nécessaire)",
    termination:
      'une lettre de licenciement respectant la procédure L1232-6 CT avec motif réel et sérieux',
    conventional_termination:
      "un protocole de rupture conventionnelle homologuée conforme L1237-11 CT",
    certificate:
      'un certificat de travail conforme L1234-19 CT avec toutes les mentions obligatoires',
    amendment:
      "un avenant au contrat de travail conforme nécessitant l'accord des deux parties",
  }

  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Génère ${
          typePrompts[documentType] ?? documentType
        } pour :

${JSON.stringify(data, null, 2)}

EXIGENCES :
- Document complet et directement utilisable (pas de [à compléter])
- Toutes les mentions légales obligatoires
- Format Markdown structuré (titres, articles numérotés)
- Date : ${new Date().toLocaleDateString('fr-FR')}
- Langage juridique précis mais compréhensible
- Indiquer les délais légaux si applicable`,
      },
    ],
  })

  return response.content[0]?.type === 'text' ? response.content[0].text : ''
}

export async function analyzeRetentionRisk(
  employeeData: Record<string, unknown>
): Promise<{
  score: number
  risk: 'low' | 'medium' | 'high'
  factors: Array<{ label: string; impact: 'positive' | 'negative'; weight: number }>
  recommendations: string[]
}> {
  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Analyse ce profil RH et génère un score de rétention (probabilité de rester dans les 6 mois).

Données :
${JSON.stringify(employeeData, null, 2)}

Facteurs à considérer : ancienneté, évolution salariale récente, formations suivies,
absences répétées courtes, heures supp chroniques, évaluation dernière, ratio marché.

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de texte autour) :
{
  "score": 0.78,
  "risk": "low",
  "factors": [
    { "label": "Augmentation récente", "impact": "positive", "weight": 0.3 }
  ],
  "recommendations": [
    "Proposer un entretien de carrière dans les 30 jours"
  ]
}`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '{}'
    return JSON.parse(text) as ReturnType<typeof analyzeRetentionRisk> extends Promise<infer T> ? T : never
  } catch {
    return { score: 0.7, risk: 'low', factors: [], recommendations: [] }
  }
}

export async function generateDashboardInsights(
  dashboardData: Record<string, unknown>
): Promise<
  Array<{
    type: 'warning' | 'info' | 'success'
    message: string
    action?: string
    actionUrl?: string
  }>
> {
  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `En tant qu'assistant RH expert, analyse ces données de tableau de bord RH et génère 3 insights actionnables maximum pour les RH.

Données :
${JSON.stringify(dashboardData, null, 2)}

Réponds UNIQUEMENT en JSON valide :
[
  {
    "type": "warning",
    "message": "message concis et actionnable en français",
    "action": "Voir les détails",
    "actionUrl": "/employees?filter=atRisk"
  }
]`,
        },
      ],
    })

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '[]'
    return JSON.parse(text) as Array<{
      type: 'warning' | 'info' | 'success'
      message: string
      action?: string
      actionUrl?: string
    }>
  } catch {
    return []
  }
}
