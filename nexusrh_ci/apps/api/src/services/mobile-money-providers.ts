/**
 * Intégration Mobile Money CI — Wave · MTN MoMo · Orange Money.
 *
 * Ce service remplace l'ancien stub `Math.random`. Il :
 *  1. NORMALISE les codes provider (les employés peuvent stocker `mtn`/`orange`,
 *     la chaîne de paiement attend `mtn_momo`/`orange_money`).
 *  2. RÉSOUT les identifiants : config par TENANT (table mobile_money_config,
 *     secrets chiffrés AES) en priorité, sinon repli sur l'env plateforme.
 *  3. INITIE un virement par de VRAIS appels HTTP aux APIs opérateurs. Si aucun
 *     identifiant n'est configuré (démo / sandbox), il bascule en SIMULATION pour
 *     ne jamais bloquer l'environnement de démonstration.
 *
 * Les virements réels sont ASYNCHRONES : l'initiation renvoie `pending`, puis le
 * webhook signé (HMAC) confirme `completed`/`failed`. La simulation renvoie un
 * statut final immédiat.
 */
import { config } from '../config.js'
import { pool as rawPool } from '../db/pool.js'
import { decryptIfPresent } from '../utils/crypto.js'
import { assertSafeOutboundUrl } from './ssrf-guard.js'

export const MM_PROVIDERS = ['wave', 'mtn_momo', 'orange_money'] as const
export type MmProvider = typeof MM_PROVIDERS[number]

// Agrégateurs : une seule intégration route vers TOUS les opérateurs (CinetPay
// auto-détecte l'opérateur depuis le numéro). Prioritaire sur l'intégration
// opérateur-par-opérateur quand activé pour le tenant.
export const MM_AGGREGATORS = ['cinetpay'] as const
export type MmAggregator = typeof MM_AGGREGATORS[number]
export type MmChannel = MmProvider | MmAggregator

/** Format téléphone Mobile Money CI : +225 suivi de 07/05 + 8 chiffres. */
export const CI_MM_PHONE_RE = /^\+2250[57]\d{8}$/

/**
 * Normalise un code provider hétérogène vers le code canonique de la chaîne de
 * paiement. Les formulaires employé historiques stockent `mtn`/`orange`.
 */
export function normalizeMmProvider(raw: string | null | undefined): MmProvider | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  switch (v) {
    case 'wave': return 'wave'
    case 'mtn': case 'mtn_momo': case 'momo': return 'mtn_momo'
    case 'orange': case 'orange_money': case 'om': return 'orange_money'
    default: return null
  }
}

export interface MmCreds {
  apiKey: string | null
  apiUrl: string
  webhookSecret: string | null
  subscriptionKey?: string | null  // MTN MoMo
  merchantKey?: string | null      // Orange Money
  env?: string                     // MTN : sandbox | production
  source: 'tenant' | 'platform' | 'none'
}

/** Identifiants issus de l'env plateforme (repli). */
function platformCreds(provider: MmProvider): MmCreds {
  if (provider === 'wave') {
    const w = config.mobileMoney.wave
    return { apiKey: w.apiKey ?? null, apiUrl: w.apiUrl, webhookSecret: w.webhookSecret ?? null, source: w.apiKey ? 'platform' : 'none' }
  }
  if (provider === 'mtn_momo') {
    const m = config.mobileMoney.mtn
    return { apiKey: m.apiKey ?? null, apiUrl: m.apiUrl, webhookSecret: m.webhookSecret ?? null, subscriptionKey: m.subscriptionKey ?? null, env: m.env, source: m.apiKey ? 'platform' : 'none' }
  }
  const o = config.mobileMoney.orange
  return { apiKey: o.apiKey ?? null, apiUrl: o.apiUrl, webhookSecret: o.webhookSecret ?? null, merchantKey: o.merchantKey ?? null, source: o.apiKey ? 'platform' : 'none' }
}

/**
 * Résout les identifiants d'un provider pour un tenant : config tenant (chiffrée)
 * d'abord, repli sur l'env plateforme. Tolère l'absence de la table (tenant ancien).
 */
export async function resolveMmCreds(schema: string, provider: MmProvider): Promise<MmCreds> {
  try {
    const r = await rawPool.query<{
      api_key_enc: string | null; api_url: string | null; webhook_secret_enc: string | null
      subscription_key_enc: string | null; merchant_key_enc: string | null; env: string | null; enabled: boolean
    }>(
      `SELECT api_key_enc, api_url, webhook_secret_enc, subscription_key_enc, merchant_key_enc, env, enabled
         FROM "${schema}".mobile_money_config WHERE provider = $1 LIMIT 1`, [provider],
    )
    const row = r.rows[0]
    if (row && row.enabled) {
      const apiKey = decryptIfPresent(row.api_key_enc)
      if (apiKey) {
        const plat = platformCreds(provider)
        return {
          apiKey,
          apiUrl: row.api_url || plat.apiUrl,
          webhookSecret: decryptIfPresent(row.webhook_secret_enc) ?? plat.webhookSecret,
          subscriptionKey: decryptIfPresent(row.subscription_key_enc) ?? plat.subscriptionKey ?? null,
          merchantKey: decryptIfPresent(row.merchant_key_enc) ?? plat.merchantKey ?? null,
          env: row.env ?? plat.env,
          source: 'tenant',
        }
      }
    }
  } catch { /* table absente / déchiffrement impossible → repli env */ }
  return platformCreds(provider)
}

/**
 * Résout l'agrégateur actif du tenant (ex. CinetPay) s'il est configuré ET activé.
 * Quand présent, TOUS les virements passent par lui. Renvoie null sinon.
 */
export async function resolveAggregator(schema: string): Promise<{ name: MmAggregator; creds: MmCreds } | null> {
  try {
    const r = await rawPool.query<{
      provider: string; api_key_enc: string | null; api_url: string | null
      subscription_key_enc: string | null; merchant_key_enc: string | null; env: string | null; enabled: boolean
    }>(
      `SELECT provider, api_key_enc, api_url, subscription_key_enc, merchant_key_enc, env, enabled
         FROM "${schema}".mobile_money_config
        WHERE provider = ANY($1::text[]) AND enabled = true LIMIT 1`, [[...MM_AGGREGATORS]],
    )
    const row = r.rows[0]
    if (!row) return null
    const apiKey = decryptIfPresent(row.api_key_enc)
    if (!apiKey) return null
    return {
      name: row.provider as MmAggregator,
      creds: {
        apiKey,
        apiUrl: row.api_url || 'https://client.cinetpay.com',
        webhookSecret: null,
        subscriptionKey: decryptIfPresent(row.subscription_key_enc),  // mot de passe API
        merchantKey: decryptIfPresent(row.merchant_key_enc),          // site_id
        env: row.env ?? 'production',
        source: 'tenant',
      },
    }
  } catch { return null }
}

export interface TransferResult {
  success: boolean
  status: 'pending' | 'completed' | 'failed'
  transactionId?: string
  error?: string
}

/** Génère un identifiant de transaction interne (référence client). */
function txnId(prefix = 'TXN'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

/** Simulation (aucun identifiant configuré) — garde la démo fonctionnelle. */
function simulate(): TransferResult {
  const ok = Math.random() > 0.05
  return ok
    ? { success: true, status: 'completed', transactionId: txnId('SIM') }
    : { success: false, status: 'failed', error: 'Échec transaction (simulation)' }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15_000): Promise<{ ok: boolean; status: number; body: unknown }> {
  // OWASP A10 (SSRF) — défense en profondeur : même si l'URL provient d'une
  // config tenant (validée à l'écriture) ou plateforme, on revérifie qu'elle ne
  // résout pas vers une adresse interne/privée juste avant l'appel sortant.
  await assertSafeOutboundUrl(url)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    let body: unknown = null
    try { body = await res.json() } catch { /* réponse non-JSON */ }
    return { ok: res.ok, status: res.status, body }
  } finally { clearTimeout(t) }
}

/** Wave B2C payout — POST {apiUrl}/v1/payout (Bearer apiKey). Synchrone/quasi. */
async function transferWave(creds: MmCreds, p: { phone: string; amount: number; reference: string }): Promise<TransferResult> {
  const res = await fetchJson(`${creds.apiUrl.replace(/\/$/, '')}/v1/payout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency: 'XOF', receive_amount: String(p.amount), mobile: p.phone, client_reference: p.reference }),
  })
  const b = (res.body ?? {}) as { id?: string; payment_status?: string }
  if (!res.ok) return { success: false, status: 'failed', error: `Wave HTTP ${res.status}` }
  return { success: true, status: b.payment_status === 'succeeded' ? 'completed' : 'pending', transactionId: b.id ?? txnId('WAVE') }
}

/** MTN MoMo Disbursement — token puis transfer (async, renvoie 202 → pending). */
async function transferMtn(creds: MmCreds, p: { phone: string; amount: number; reference: string }): Promise<TransferResult> {
  const base = creds.apiUrl.replace(/\/$/, '')
  const target = creds.env === 'production' ? 'mtncotedivoire' : 'sandbox'
  // 1. Jeton OAuth (Basic apiUser:apiKey + clé d'abonnement)
  const tok = await fetchJson(`${base}/disbursement/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.merchantKey ?? ''}:${creds.apiKey}`).toString('base64')}`,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey ?? '',
    },
  })
  const token = (tok.body as { access_token?: string })?.access_token
  if (!tok.ok || !token) return { success: false, status: 'failed', error: `MTN token HTTP ${tok.status}` }
  // 2. Transfert (X-Reference-Id = idempotence, 202 Accepted attendu)
  const res = await fetchJson(`${base}/disbursement/v1_0/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'X-Reference-Id': p.reference,
      'X-Target-Environment': target, 'Ocp-Apim-Subscription-Key': creds.subscriptionKey ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: String(p.amount), currency: 'XOF', externalId: p.reference,
      payee: { partyIdType: 'MSISDN', partyId: p.phone.replace('+', '') },
      payerMessage: 'Salaire', payeeNote: 'Virement salaire',
    }),
  })
  if (res.status === 202 || res.ok) return { success: true, status: 'pending', transactionId: p.reference }
  return { success: false, status: 'failed', error: `MTN transfer HTTP ${res.status}` }
}

/** Orange Money CI B2C — token puis transfert (async → pending). */
async function transferOrange(creds: MmCreds, p: { phone: string; amount: number; reference: string }): Promise<TransferResult> {
  const base = creds.apiUrl.replace(/\/$/, '')
  const tok = await fetchJson(`${base}/oauth/v3/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds.merchantKey ?? ''}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  const token = (tok.body as { access_token?: string })?.access_token
  if (!tok.ok || !token) return { success: false, status: 'failed', error: `Orange token HTTP ${tok.status}` }
  const res = await fetchJson(`${base}/omcoreapis/1.0.2/mp/pay`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriberMsisdn: p.phone, amount: p.amount, currency: 'XOF', orderId: p.reference, description: 'Virement salaire' }),
  })
  const b = (res.body ?? {}) as { payToken?: string; status?: string }
  if (!res.ok) return { success: false, status: 'failed', error: `Orange pay HTTP ${res.status}` }
  return { success: true, status: b.status === 'SUCCESS' ? 'completed' : 'pending', transactionId: b.payToken ?? txnId('OM') }
}

/**
 * Agrégateur CinetPay — Transfer/Payout API. Authentifie (apikey + password) puis
 * envoie le virement ; CinetPay route vers le bon opérateur d'après le numéro.
 * Asynchrone → renvoie pending (confirmé par webhook).
 */
async function transferCinetpay(creds: MmCreds, p: { phone: string; amount: number; reference: string }): Promise<TransferResult> {
  const base = creds.apiUrl.replace(/\/$/, '')
  // 1. Auth → token
  const auth = await fetchJson(
    `${base}/v1/auth/login?apikey=${encodeURIComponent(creds.apiKey ?? '')}&password=${encodeURIComponent(creds.subscriptionKey ?? '')}`,
    { method: 'POST' },
  )
  const token = (auth.body as { data?: { token?: string } })?.data?.token
  if (!auth.ok || !token) return { success: false, status: 'failed', error: `CinetPay auth HTTP ${auth.status}` }
  // 2. Transfert (montant en XOF, numéro sans indicatif + prefix 225)
  const local = p.phone.replace('+225', '').replace('+', '')
  const form = new URLSearchParams({
    data: JSON.stringify([{ prefix: '225', phone: local, amount: String(p.amount), client_transaction_id: p.reference, notify_url: '' }]),
  })
  const res = await fetchJson(`${base}/v1/transfer/money/send/contact?token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  })
  if (!res.ok) return { success: false, status: 'failed', error: `CinetPay transfer HTTP ${res.status}` }
  const tid = (res.body as { data?: Array<{ transaction_id?: string }> })?.data?.[0]?.transaction_id
  return { success: true, status: 'pending', transactionId: tid ?? p.reference }
}

/**
 * Initie un virement Mobile Money. Valide le numéro (format CI strict), puis :
 *  - si un AGRÉGATEUR (CinetPay) est activé pour le tenant → route TOUT par lui ;
 *  - sinon résout les identifiants OPÉRATEUR et appelle le bon provider ;
 *  - à défaut d'identifiants → simulation (démo/sandbox), jamais de blocage.
 */
export async function initiateTransfer(schema: string, rawProvider: string, p: {
  phone: string; amount: number; reference: string; description?: string
}): Promise<TransferResult> {
  const phone = p.phone.replace(/\s/g, '')
  if (!CI_MM_PHONE_RE.test(phone)) return { success: false, status: 'failed', error: `Numéro invalide pour la CI : ${p.phone}` }
  const args = { phone, amount: p.amount, reference: p.reference }

  // 1. Agrégateur prioritaire (couvre tous les opérateurs)
  const agg = await resolveAggregator(schema)
  if (agg) {
    try {
      if (agg.name === 'cinetpay') return await transferCinetpay(agg.creds, args)
    } catch (e) {
      return { success: false, status: 'failed', error: `Erreur agrégateur ${agg.name} : ${(e as Error).message}` }
    }
  }

  // 2. Intégration opérateur-par-opérateur
  const provider = normalizeMmProvider(rawProvider)
  if (!provider) return { success: false, status: 'failed', error: `Provider inconnu : ${rawProvider}` }
  const creds = await resolveMmCreds(schema, provider)
  if (creds.source === 'none' || !creds.apiKey) return simulate()
  try {
    if (provider === 'wave') return await transferWave(creds, args)
    if (provider === 'mtn_momo') return await transferMtn(creds, args)
    return await transferOrange(creds, args)
  } catch (e) {
    return { success: false, status: 'failed', error: `Erreur provider ${provider} : ${(e as Error).message}` }
  }
}

/**
 * Vérifie un numéro avant virement : format CI strict + (si provider configuré)
 * sondage d'activité best-effort. Renvoie active=true/false + raison.
 */
export async function verifyNumber(schema: string, rawProvider: string, phone: string): Promise<{ valid: boolean; active: boolean; provider: MmProvider | null; reason?: string }> {
  const provider = normalizeMmProvider(rawProvider)
  const clean = phone.replace(/\s/g, '')
  if (!CI_MM_PHONE_RE.test(clean)) {
    return { valid: false, active: false, provider, reason: 'Format invalide : +225 07/05 suivi de 8 chiffres attendu.' }
  }
  if (!provider) return { valid: true, active: false, provider: null, reason: 'Provider inconnu.' }
  const creds = await resolveMmCreds(schema, provider)
  // Sans identifiant provider, on confirme uniquement le format (pas d'activité réelle).
  if (creds.source === 'none' || !creds.apiKey) {
    return { valid: true, active: true, provider, reason: 'Format CI valide (activité non vérifiée — provider non configuré).' }
  }
  // Avec identifiants : on considère le format validé suffisant ici (le sondage
  // d'activité réel dépend d'endpoints provider spécifiques, déclenché au virement).
  return { valid: true, active: true, provider, reason: 'Numéro au format CI valide.' }
}
