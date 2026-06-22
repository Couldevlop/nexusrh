/**
 * Chat IA via Mistral (API OpenAI-compatible : /chat/completions, streaming SSE,
 * function calling). Sert d'équivalent au chemin Anthropic du module ai.routes,
 * pour que les tenants basculés sur Mistral aient TOUT en Mistral — chat compris.
 *
 * - Streaming texte renvoyé via le callback `onText` (même rendu SSE que Claude).
 * - Outils internes (lecture seule, scope tenant+rôle) exposés en function
 *   calling Mistral ; les `tool_calls` sont exécutés via `executeAiTool` puis
 *   réinjectés (messages role:'tool'), boucle bornée (anti-DoS).
 * - Aucune dépendance SDK : appel `fetch` natif (Node 20).
 *
 * Sécurité : la clé n'est jamais loggée ; les erreurs sont remontées brutes à
 * l'appelant (la route masque le détail au client — OWASP A10).
 */
import type { Pool } from 'pg'
import type { AiToolContext, AiToolDef } from './ai-tools.js'
import { executeAiTool } from './ai-tools.js'

export interface MistralChatArgs {
  apiKey:        string
  apiUrl:        string   // ex. https://api.mistral.ai/v1
  model:         string
  systemPrompt:  string
  messages:      Array<{ role: 'user' | 'assistant'; content: string }>
  tools:         AiToolDef[]
  toolCtx:       AiToolContext
  pool:          Pool
  maxTokens:     number
  maxToolRounds: number
  onText:        (text: string) => void
}

export interface MistralChatResult {
  usage:     { input_tokens: number; output_tokens: number }
  toolsUsed: string[]
  stopReason: string
  rounds:    number
}

interface MistralMessage {
  role:          'system' | 'user' | 'assistant' | 'tool'
  content:       string | null
  tool_calls?:   Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?:         string
}

interface AccTool { id: string; name: string; args: string }

export async function streamMistralChat(a: MistralChatArgs): Promise<MistralChatResult> {
  const convo: MistralMessage[] = [
    { role: 'system', content: a.systemPrompt },
    ...a.messages.map(m => ({ role: m.role, content: m.content })),
  ]
  const mistralTools = a.tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))

  const usage = { input_tokens: 0, output_tokens: 0 }
  const toolsUsed: string[] = []
  let rounds = 0
  let stopReason = 'stop'

  for (;;) {
    const res = await fetch(`${a.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${a.apiKey}`,
        'Content-Type':  'application/json',
        'Accept':        'text/event-stream',
      },
      body: JSON.stringify({
        model:      a.model,
        max_tokens: a.maxTokens,
        stream:     true,
        messages:   convo,
        ...(mistralTools.length > 0 ? { tools: mistralTools, tool_choice: 'auto' } : {}),
      }),
    })

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Mistral API ${res.status}: ${txt.slice(0, 200)}`)
    }

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let assistantText = ''
    const acc: AccTool[] = []
    let finishReason = 'stop'
    let streamDone = false

    while (!streamDone) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { streamDone = true; break }
        let json: {
          choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        try { json = JSON.parse(data) } catch { continue }
        const choice = json.choices?.[0]
        if (choice) {
          const delta = choice.delta ?? {}
          if (delta.content) { assistantText += delta.content; a.onText(delta.content) }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              if (!acc[i]) acc[i] = { id: '', name: '', args: '' }
              if (tc.id) acc[i].id = tc.id
              if (tc.function?.name) acc[i].name += tc.function.name
              if (tc.function?.arguments) acc[i].args += tc.function.arguments
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        if (json.usage) {
          usage.input_tokens  += json.usage.prompt_tokens     ?? 0
          usage.output_tokens += json.usage.completion_tokens ?? 0
        }
      }
    }

    stopReason = finishReason
    const calls = acc.filter(c => c && c.name)

    if (finishReason === 'tool_calls' && calls.length > 0 && rounds < a.maxToolRounds) {
      rounds++
      // Réinjecte le message assistant (avec ses tool_calls) puis les résultats.
      convo.push({
        role: 'assistant',
        content: assistantText.length > 0 ? assistantText : null,
        tool_calls: calls.map((c, i) => ({
          id: c.id || `call_${i}_${c.name}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      })
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i]!
        toolsUsed.push(c.name)
        let input: unknown = {}
        try { input = c.args ? JSON.parse(c.args) : {} } catch { input = {} }
        const result = await executeAiTool(a.pool, a.toolCtx, c.name, input)
        convo.push({
          role:         'tool',
          tool_call_id: c.id || `call_${i}_${c.name}`,
          name:         c.name,
          content:      JSON.stringify(result),
        })
      }
      continue
    }
    break
  }

  return { usage, toolsUsed, stopReason, rounds }
}
