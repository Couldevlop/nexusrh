import { useState } from 'react'
import { useQuery, useMutation, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Smartphone, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

interface ProviderConfig {
  provider: 'wave' | 'mtn_momo' | 'orange_money' | 'cinetpay'
  enabled: boolean
  apiUrl: string | null
  env: string
  hasApiKey: boolean
  hasWebhookSecret: boolean
  hasSubscriptionKey: boolean
  hasMerchantKey: boolean
  platformFallback: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
  cinetpay: 'CinetPay (agrégateur)', wave: 'Wave', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money',
}

/** Onglet de configuration des identifiants Mobile Money par tenant. */
export default function MobileMoneyTab({ qc }: { qc: QueryClient }) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery<{ data: ProviderConfig[]; encryptionAvailable: boolean }>({
    queryKey: ['mm-config'],
    queryFn: () => api.get('/settings/mobile-money').then(r => r.data),
  })

  if (isLoading) {
    return <div className="flex items-center justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
  }

  const encryptionAvailable = data?.encryptionAvailable ?? false

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-primary" />
          {t('mobileMoney.title', 'Mobile Money — identifiants opérateurs')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('mobileMoney.subtitle', 'Configurez vos clés Wave / MTN / Orange pour activer les virements réels. Les secrets sont chiffrés. À défaut, les identifiants de la plateforme sont utilisés.')}
        </p>
      </div>

      {!encryptionAvailable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {t('mobileMoney.noEncryption', 'Chiffrement non configuré côté plateforme : impossible de stocker un secret pour le moment.')}
        </div>
      )}

      {(data?.data ?? []).map(cfg => (
        <ProviderCard key={cfg.provider} cfg={cfg} qc={qc} encryptionAvailable={encryptionAvailable} />
      ))}
    </div>
  )
}

function ProviderCard({ cfg, qc, encryptionAvailable }: { cfg: ProviderConfig; qc: QueryClient; encryptionAvailable: boolean }) {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [apiUrl, setApiUrl] = useState(cfg.apiUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [subscriptionKey, setSubscriptionKey] = useState('')
  const [merchantKey, setMerchantKey] = useState('')
  const [env, setEnv] = useState(cfg.env || 'sandbox')
  const [saved, setSaved] = useState(false)

  const isMtn = cfg.provider === 'mtn_momo'
  const isOrange = cfg.provider === 'orange_money'
  const isCinetpay = cfg.provider === 'cinetpay'

  const save = useMutation({
    mutationFn: () => {
      // Champ secret vide = inchangé (on n'écrase pas un secret déjà posé)
      const body: Record<string, unknown> = { provider: cfg.provider, enabled, apiUrl, env }
      if (apiKey) body.apiKey = apiKey
      if (webhookSecret) body.webhookSecret = webhookSecret
      if ((isMtn || isCinetpay) && subscriptionKey) body.subscriptionKey = subscriptionKey
      if ((isOrange || isCinetpay) && merchantKey) body.merchantKey = merchantKey
      return api.put('/settings/mobile-money', body)
    },
    onSuccess: () => {
      setSaved(true); setApiKey(''); setWebhookSecret(''); setSubscriptionKey(''); setMerchantKey('')
      qc.invalidateQueries({ queryKey: ['mm-config'] })
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const secretPlaceholder = (has: boolean) => has ? '•••••••• (laisser vide pour conserver)' : t('mobileMoney.notSet', 'non configuré')

  return (
    <div className={`rounded-xl border bg-card p-4 space-y-3 ${isCinetpay ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{PROVIDER_LABELS[cfg.provider]}</span>
          {isCinetpay && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {t('mobileMoney.aggregatorBadge', 'recommandé — couvre tous les opérateurs')}
            </span>
          )}
          {cfg.platformFallback && !cfg.hasApiKey && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t('mobileMoney.platformActive', 'plateforme active')}
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="h-4 w-4" />
          {t('mobileMoney.enabled', 'Activé')}
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground">URL API</label>
          <input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://api.wave.com"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('mobileMoney.apiKey', 'Clé API')}{cfg.hasApiKey && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={secretPlaceholder(cfg.hasApiKey)} autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        {!isCinetpay && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('mobileMoney.webhookSecret', 'Secret webhook')}{cfg.hasWebhookSecret && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
            <input type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} placeholder={secretPlaceholder(cfg.hasWebhookSecret)} autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          </div>
        )}
        {isCinetpay && (
          <>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('mobileMoney.cpPassword', 'Mot de passe API')}{cfg.hasSubscriptionKey && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
              <input type="password" value={subscriptionKey} onChange={e => setSubscriptionKey(e.target.value)} placeholder={secretPlaceholder(cfg.hasSubscriptionKey)} autoComplete="new-password"
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Site ID{cfg.hasMerchantKey && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
              <input value={merchantKey} onChange={e => setMerchantKey(e.target.value)} placeholder={secretPlaceholder(cfg.hasMerchantKey)} autoComplete="off"
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </>
        )}
        {isMtn && (
          <>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Subscription Key{cfg.hasSubscriptionKey && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
              <input type="password" value={subscriptionKey} onChange={e => setSubscriptionKey(e.target.value)} placeholder={secretPlaceholder(cfg.hasSubscriptionKey)} autoComplete="new-password"
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">{t('mobileMoney.env', 'Environnement')}</label>
              <select value={env} onChange={e => setEnv(e.target.value)}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                <option value="sandbox">sandbox</option>
                <option value="production">production</option>
              </select>
            </div>
          </>
        )}
        {isOrange && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">Merchant Key{cfg.hasMerchantKey && <CheckCircle2 className="ml-1 inline h-3 w-3 text-green-600" />}</label>
            <input type="password" value={merchantKey} onChange={e => setMerchantKey(e.target.value)} placeholder={secretPlaceholder(cfg.hasMerchantKey)} autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => save.mutate()} disabled={save.isPending || (!encryptionAvailable && !!(apiKey || webhookSecret))}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('common.save', 'Enregistrer')}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-green-600"><CheckCircle2 className="h-4 w-4" /> {t('mobileMoney.saved', 'Enregistré')}</span>}
        {save.isError && <span className="text-sm text-destructive">{t('mobileMoney.saveError', 'Échec de l\'enregistrement')}</span>}
      </div>
    </div>
  )
}
