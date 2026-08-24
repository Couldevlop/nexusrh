/**
 * Formulaire public « Demander une démo ».
 *
 * Points d'attention :
 *   - la page reste INERTE au chargement : le défi anti-robot n'est demandé
 *     qu'au premier contact réel avec le formulaire. Un visiteur qui ne fait
 *     que lire ne déclenche aucun appel réseau ;
 *   - le champ `website` est un piège à robots, masqué et exclu du parcours
 *     clavier et des lecteurs d'écran ;
 *   - les erreurs affichées sont génériques : le serveur ne renvoie jamais de
 *     détail technique, et on n'en invente pas côté client.
 */
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

type Status = 'idle' | 'sending' | 'sent' | 'error'

const HEADCOUNTS = ['1-49', '50-199', '200-999', '1000+'] as const

const EMPTY = {
  fullName: '', company: '', email: '', phone: '',
  headcount: '', message: '', captchaAnswer: '', website: '',
}

export default function DemoForm() {
  const { t, i18n } = useTranslation('home')
  const [form, setForm] = useState({ ...EMPTY })
  const [captcha, setCaptcha] = useState<{ token: string; question: string } | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(false)

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  /** Charge un défi. Appelé au premier contact, puis à la demande. */
  const loadCaptcha = useCallback(async () => {
    try {
      const lang = i18n.language?.startsWith('en') ? 'en' : 'fr'
      const res = await api.get<{ token: string; question: string }>(`/public/demo/captcha?lang=${lang}`)
      setCaptcha(res.data)
    } catch {
      setCaptcha(null)
    }
  }, [i18n.language])

  const onFirstTouch = () => {
    if (asked.current) return
    asked.current = true
    void loadCaptcha()
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    setError(null)
    try {
      await api.post('/public/demo/request', {
        fullName: form.fullName.trim(),
        company: form.company.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        headcount: form.headcount,
        message: form.message.trim(),
        captchaToken: captcha?.token ?? '',
        captchaAnswer: form.captchaAnswer.trim(),
        website: form.website,
      })
      setStatus('sent')
      setForm({ ...EMPTY })
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } } }
      setError(e2.response?.data?.error ?? t('form.errorGeneric'))
      setStatus('error')
      void loadCaptcha() // le défi précédent est consommé
      setForm(f => ({ ...f, captchaAnswer: '' }))
    }
  }

  if (status === 'sent') {
    return (
      <div className="rounded-2xl border border-[#22D3EE]/30 bg-[#0E1A20] p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#22D3EE]/15 text-2xl text-[#22D3EE]" aria-hidden>✓</div>
        <h3 className="text-xl font-semibold">{t('form.successTitle')}</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#93A4B1]">{t('form.successText')}</p>
        <button type="button" onClick={() => { setStatus('idle'); asked.current = false }}
          className="mt-6 text-sm font-medium text-[#22D3EE] underline-offset-4 hover:underline">
          {t('form.again')}
        </button>
      </div>
    )
  }

  const field = 'w-full rounded-lg border border-white/12 bg-[#0B1014] px-4 py-3 text-[15px] text-[#E6EDF3] outline-none transition-colors placeholder:text-[#5D6E7B] focus:border-[#22D3EE] focus:ring-1 focus:ring-[#22D3EE]'
  const label = 'mb-1.5 block text-xs font-medium uppercase tracking-[0.1em] text-[#93A4B1]'

  return (
    <form onSubmit={onSubmit} onFocusCapture={onFirstTouch} noValidate
      className="rounded-2xl border border-white/10 bg-[#111A21] p-6 sm:p-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="df-name">{t('form.fullName')}</label>
          <input id="df-name" className={field} value={form.fullName} onChange={set('fullName')}
            placeholder={t('form.fullNamePh')} required maxLength={120} autoComplete="name" />
        </div>
        <div>
          <label className={label} htmlFor="df-company">{t('form.company')}</label>
          <input id="df-company" className={field} value={form.company} onChange={set('company')}
            placeholder={t('form.companyPh')} required maxLength={160} autoComplete="organization" />
        </div>
        <div>
          <label className={label} htmlFor="df-email">{t('form.email')}</label>
          <input id="df-email" type="email" className={field} value={form.email} onChange={set('email')}
            placeholder={t('form.emailPh')} required maxLength={254} autoComplete="email" />
        </div>
        <div>
          <label className={label} htmlFor="df-phone">{t('form.phone')} <span className="normal-case opacity-60">({t('form.optional')})</span></label>
          <input id="df-phone" className={field} value={form.phone} onChange={set('phone')}
            placeholder={t('form.phonePh')} maxLength={40} autoComplete="tel" />
        </div>
        <div>
          <label className={label} htmlFor="df-headcount">{t('form.headcount')} <span className="normal-case opacity-60">({t('form.optional')})</span></label>
          <select id="df-headcount" className={field} value={form.headcount} onChange={set('headcount')}>
            <option value="">{t('form.headcountPick')}</option>
            {HEADCOUNTS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="df-captcha">{t('form.captcha')}</label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-lg border border-white/12 bg-[#0B1014] px-3 py-3 font-mono text-[15px] text-[#22D3EE]">
              {captcha?.question ?? '…'}
            </span>
            <input id="df-captcha" className={field} value={form.captchaAnswer} onChange={set('captchaAnswer')}
              inputMode="numeric" required maxLength={6} autoComplete="off"
              aria-describedby="df-captcha-hint" />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span id="df-captcha-hint" className="text-[11px] text-[#7C8B98]">{t('form.captchaHint')}</span>
            <button type="button" onClick={() => void loadCaptcha()}
              className="text-[11px] text-[#93A4B1] underline-offset-2 hover:underline">
              {t('form.captchaReload')}
            </button>
          </div>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="df-message">{t('form.message')} <span className="normal-case opacity-60">({t('form.optional')})</span></label>
          <textarea id="df-message" className={`${field} min-h-[110px] resize-y`} value={form.message}
            onChange={set('message')} placeholder={t('form.messagePh')} maxLength={2000} />
        </div>
      </div>

      {/* Piège à robots : hors flux, hors tabulation, hors lecteurs d'écran. */}
      <div aria-hidden className="absolute h-0 w-0 overflow-hidden opacity-0">
        <label htmlFor="df-website">Website</label>
        <input id="df-website" name="website" tabIndex={-1} autoComplete="off"
          value={form.website} onChange={set('website')} />
      </div>

      {error && (
        <p role="alert" className="mt-5 rounded-lg border border-[#F04E10]/40 bg-[#F04E10]/10 px-4 py-3 text-sm text-[#FFB59B]">
          {error}
        </p>
      )}

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <button type="submit" disabled={status === 'sending'}
          className="rounded-lg bg-[#F04E10] px-7 py-3.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_28px_-6px_#F04E10] disabled:opacity-60">
          {status === 'sending' ? t('form.submitting') : t('form.submit')}
        </button>
        <p className="max-w-sm text-xs leading-relaxed text-[#7C8B98]">{t('form.privacy')}</p>
      </div>
    </form>
  )
}
