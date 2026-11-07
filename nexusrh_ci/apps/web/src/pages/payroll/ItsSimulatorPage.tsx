/**
 * Simulateur de salaire — impôt sur les salaires, cotisations et net, pour le
 * PAYS choisi.
 *
 * L'écran était figé sur la Côte d'Ivoire : titre, barème, plafonds CNPS
 * (3 375 000 / 75 000) et taux (6,3 / 7,7 / 5,75 %) étaient recopiés en dur,
 * et le formulaire ignorait quatre données qui changent le net — le pays, le
 * conjoint sans emploi (CMU), les enfants de moins de 21 ans (distincts des
 * enfants à charge) et la prime de transport, exonérée dans la limite du
 * plafond de la ville de travail.
 *
 * Tout vient désormais du serveur : le détail est rendu ligne par ligne depuis
 * le moteur de paie, et le barème comme le SMIG sont ceux du pack du pays.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/lib/api'
import { Calculator, Loader2, Info, TrendingDown, TrendingUp, Globe2 } from 'lucide-react'

type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed'

interface Bracket { min: number; max: number | null; taux: number }

interface PackView {
  code: string
  countryCode: string
  name: string
  currency: string
  currencyLabel: string
  smigMensuel: number
  usable: boolean
  brackets: Bracket[]
  transportExoneration: { defaut: number; parZone?: Record<string, number> } | null
  hasCmu: boolean
  hasSeniorityBonus: boolean
}

interface SimLine {
  code: string
  label: string
  type: 'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution' | 'reimbursement'
  base: number
  amount: number
}

interface ApiResult {
  input: {
    baseSalary: number; primes: number; brut: number; atRate: number
    seniorityAmount: number; transportAllowance: number; countryCode: string
  }
  cnps: { salarial: number; patronal: number }
  cmu?: { salarial: number; patronal: number }
  its: { base: number; brut: number; credit: number; parts: number; net: number }
  net: { payable: number; smigCompliant: boolean }
  employerCost: number
  lines: SimLine[]
  pack: PackView
  simulation: {
    avecUnEnfantSupp: {
      its: number; net: number; gain: number; itsGain?: number; cmuCost?: number; message: string
    }
  }
  currency: string
}

/** Pays sélectionnables, tels que le serveur les déclare (packs législatifs). */
interface CountryOption {
  countryCode: string
  packCode: string
  name: string
  status: 'active' | 'stub'
  currency: string
  smigMensuel: number
}

const SITUATIONS: readonly MaritalStatus[] = ['single', 'married', 'divorced', 'widowed']
const SITUATION_KEYS: Record<MaritalStatus, string> = {
  single: 'maritalSingle', married: 'maritalMarried', divorced: 'maritalDivorced', widowed: 'maritalWidowed',
}

const SECTEURS = [
  { value: 0.020, key: 'commerce' },
  { value: 0.030, key: 'btp' },
  { value: 0.040, key: 'industrie' },
  { value: 0.050, key: 'extraction' },
] as const

/** Conjoint : non renseigné (le moteur ne le compte pas), sans emploi, ou en emploi. */
type SpouseChoice = 'unknown' | 'covered' | 'employed'

export default function ItsSimulatorPage() {
  const { t, i18n } = useTranslation('payroll')
  const [brutMensuel, setBrutMensuel] = useState(250000)
  const [situation, setSituation] = useState<MaritalStatus>('married')
  const [enfants, setEnfants] = useState(2)
  const [atRate, setAtRate] = useState(0.020)
  const [primes, setPrimes] = useState(0)
  const [transport, setTransport] = useState(0)
  const [ville, setVille] = useState('')
  const [conjoint, setConjoint] = useState<SpouseChoice>('unknown')
  const [enfantsCmu, setEnfantsCmu] = useState<string>('')
  const [dateEmbauche, setDateEmbauche] = useState('')
  const [joursTravailles, setJoursTravailles] = useState<string>('')
  const [pays, setPays] = useState<string>('')
  const [showEnfantSimu, setShowEnfantSimu] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)

  // Pays pris en charge + pays du tenant (lecture ouverte aux rôles RH).
  const legislationQ = useQuery({
    queryKey: ['settings', 'legislation'],
    queryFn: async () => (await api.get('/settings/legislation')).data.data as {
      countryCode: string; countryLabel: string; available: CountryOption[]
    },
    staleTime: 10 * 60 * 1000,
  })

  // Sélection initiale = pays du tenant, sans écraser un choix de l'utilisateur.
  useEffect(() => {
    if (!pays && legislationQ.data?.countryCode) setPays(legislationQ.data.countryCode)
  }, [legislationQ.data?.countryCode, pays])

  const simuMut = useMutation({
    mutationFn: () => api.post<ApiResult>('/ai/simulate-its', {
      baseSalary: brutMensuel,
      maritalStatus: situation,
      childrenCount: enfants,
      atRate,
      primes,
      ...(pays ? { countryCode: pays } : {}),
      ...(transport > 0 ? { transportAllowance: transport } : {}),
      ...(ville.trim() ? { city: ville.trim() } : {}),
      ...(conjoint === 'unknown' ? {} : { cmuSpouseCovered: conjoint === 'covered' }),
      ...(enfantsCmu !== '' ? { cmuChildrenCovered: Number(enfantsCmu) } : {}),
      ...(dateEmbauche ? { hireDate: dateEmbauche } : {}),
      ...(joursTravailles !== '' ? { workedDays: Number(joursTravailles), workingDaysMonth: 26 } : {}),
    }),
    onSuccess: (res) => setResult(res.data),
  })

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'

  /** Devise du résultat (pays simulé), sinon celle du pays sélectionné. */
  const selectedCountry = legislationQ.data?.available.find((c) => c.countryCode === pays)
  const devise = result?.pack.currencyLabel ?? selectedCountry?.currency ?? ''
  const money = (n: number) =>
    `${Math.round(n).toLocaleString(i18n.language === 'en' ? 'en-US' : 'fr-FR').replace(/[  ]/g, ' ')} ${devise}`.trim()

  const brut = result ? result.input.brut : brutMensuel + primes
  // Taux d'effort salarial : cotisations + impôt + CMU rapportés au brut.
  const tauxEffort = result
    ? Math.round((result.cnps.salarial + result.its.net + (result.cmu?.salarial ?? 0)) / result.input.brut * 1000) / 10
    : 0

  const bracketLabel = (b: Bracket) =>
    b.max === null
      ? `> ${money(b.min - 1)}`
      : `${money(b.min)} – ${money(b.max)}`

  const lignesPatronales = result?.lines.filter((l) => l.type === 'employer_contribution') ?? []
  const lignesSalariales = result?.lines.filter((l) => l.type === 'employee_contribution' || l.type === 'deduction') ?? []

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calculator className="h-6 w-6" />
          {t('simulator.title', { country: result?.pack.name ?? legislationQ.data?.countryLabel ?? '' })}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('simulator.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Formulaire */}
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <h2 className="font-semibold">{t('simulator.paramsTitle')}</h2>

          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Globe2 className="h-3.5 w-3.5" /> {t('simulator.countryLabel')}
            </label>
            <select className={inputCls} value={pays} onChange={e => setPays(e.target.value)}>
              {(legislationQ.data?.available ?? []).map(c => (
                <option key={c.countryCode} value={c.countryCode}>
                  {c.name}{c.status === 'stub' ? ` — ${t('simulator.countryStub')}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('simulator.countryHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.baseSalaryLabel', { currency: devise })}</label>
            <input type="number" className={inputCls} value={brutMensuel}
              onChange={e => setBrutMensuel(parseInt(e.target.value) || 0)} min={0} step={10000} />
            <p className="text-xs text-muted-foreground">
              {t('simulator.smigHint', {
                amount: money(result?.pack.smigMensuel ?? selectedCountry?.smigMensuel ?? 0),
              })}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.primesLabel', { currency: devise })}</label>
            <input type="number" className={inputCls} value={primes}
              onChange={e => setPrimes(parseInt(e.target.value) || 0)} min={0} step={5000} />
            <p className="text-xs text-muted-foreground">{t('simulator.primesHint')}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.transportLabel', { currency: devise })}</label>
              <input type="number" className={inputCls} value={transport}
                onChange={e => setTransport(parseInt(e.target.value) || 0)} min={0} step={5000} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.cityLabel')}</label>
              <input type="text" className={inputCls} value={ville} placeholder={t('simulator.cityPlaceholder')}
                onChange={e => setVille(e.target.value)} maxLength={100} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            {result?.pack.transportExoneration
              ? t('simulator.transportHint', { amount: money(result.pack.transportExoneration.defaut) })
              : t('simulator.transportHintGeneric')}
          </p>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.maritalLabel')}</label>
            <select className={inputCls} value={situation}
              onChange={e => setSituation(e.target.value as MaritalStatus)}>
              {SITUATIONS.map(s => <option key={s} value={s}>{t(`simulator.${SITUATION_KEYS[s]}`)}</option>)}
            </select>
          </div>

          {situation === 'married' && (result?.pack.hasCmu ?? true) && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.spouseLabel')}</label>
              <select className={inputCls} value={conjoint}
                onChange={e => setConjoint(e.target.value as SpouseChoice)}>
                <option value="unknown">{t('simulator.spouseUnknown')}</option>
                <option value="covered">{t('simulator.spouseCovered')}</option>
                <option value="employed">{t('simulator.spouseEmployed')}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t('simulator.spouseHint')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.childrenLabel')}</label>
              <input type="number" className={inputCls} value={enfants}
                onChange={e => setEnfants(parseInt(e.target.value) || 0)} min={0} max={10} />
            </div>
            {(result?.pack.hasCmu ?? true) && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('simulator.cmuChildrenLabel')}</label>
                <input type="number" className={inputCls} value={enfantsCmu}
                  placeholder={t('simulator.cmuChildrenPlaceholder')}
                  onChange={e => setEnfantsCmu(e.target.value)} min={0} max={30} />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.sectorLabel')}</label>
            <select className={inputCls} value={atRate}
              onChange={e => setAtRate(parseFloat(e.target.value))}>
              {SECTEURS.map(s => <option key={s.value} value={s.value}>{t(`simulator.sectors.${s.key}`)}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.hireDateLabel')}</label>
              <input type="date" className={inputCls} value={dateEmbauche}
                onChange={e => setDateEmbauche(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('simulator.workedDaysLabel')}</label>
              <input type="number" className={inputCls} value={joursTravailles}
                placeholder={t('simulator.workedDaysPlaceholder')}
                onChange={e => setJoursTravailles(e.target.value)} min={0} max={31} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">{t('simulator.hireDateHint')}</p>

          <div className="flex items-center gap-3 pt-2">
            <button onClick={() => simuMut.mutate()} disabled={simuMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {simuMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <Calculator className="h-4 w-4" />
              {t('simulator.calculate')}
            </button>
            {result && (
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={showEnfantSimu}
                  onChange={e => setShowEnfantSimu(e.target.checked)} className="rounded" />
                {t('simulator.simulateOneChild')}
              </label>
            )}
          </div>

          {simuMut.isError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {(simuMut.error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? t('simulator.simulationError')}
            </div>
          )}

          {result && !result.pack.usable && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              {t('simulator.packStubWarning', { country: result.pack.name })}
            </div>
          )}

          {/* Barème du pays simulé */}
          {result && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 space-y-1.5">
              <p className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" /> {t('simulator.scaleTitle', { country: result.pack.name })}
              </p>
              {result.pack.brackets.map((b) => (
                <div key={`${b.min}-${b.max ?? 'max'}`} className="flex justify-between text-xs text-blue-700">
                  <span>{bracketLabel(b)}</span>
                  <span className="font-mono font-semibold">{(b.taux * 100).toFixed(b.taux * 100 % 1 === 0 ? 0 : 1)} %</span>
                </div>
              ))}
              <p className="text-xs text-blue-600 pt-1 border-t border-blue-200">
                {t('simulator.scaleNote')}
              </p>
            </div>
          )}
        </div>

        {/* Résultats */}
        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: t('simulator.kpiGross'),        value: money(brut),                      color: 'text-foreground',          bg: 'bg-card' },
                { label: t('simulator.kpiNetPayable'),   value: money(result.net.payable),        color: 'text-green-700 font-bold', bg: 'bg-green-50 border-green-200' },
                { label: t('simulator.kpiCnpsSal'),      value: money(result.cnps.salarial),      color: 'text-orange-700',          bg: 'bg-orange-50 border-orange-200' },
                { label: t('simulator.kpiItsFinal'),     value: money(result.its.net),            color: 'text-blue-700',            bg: 'bg-blue-50 border-blue-200' },
                { label: t('simulator.kpiEmployerCost'), value: money(result.employerCost),       color: 'text-purple-700',          bg: 'bg-purple-50 border-purple-200' },
                { label: t('simulator.kpiEffort'),       value: `${tauxEffort} %`,                color: 'text-muted-foreground',    bg: 'bg-muted/30' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className={`rounded-xl border p-3 ${bg}`}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-base font-mono ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${result.net.smigCompliant ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {result.net.smigCompliant
                ? t('simulator.smigCompliant', { amount: money(result.pack.smigMensuel) })
                : t('simulator.smigNotCompliant', { amount: money(result.pack.smigMensuel) })}
            </span>

            {result.input.seniorityAmount > 0 && (
              <div className="rounded-lg bg-muted/30 border border-border p-3 text-sm">
                <span className="text-muted-foreground">{t('simulator.seniorityIncluded')}</span>{' '}
                <span className="font-mono">{money(result.input.seniorityAmount)}</span>
              </div>
            )}

            {/* Détail des retenues salariales — lignes du moteur */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-orange-500" /> {t('simulator.employeeDetailTitle')}
              </h3>
              <div className="space-y-1.5 text-sm">
                {lignesSalariales.map((l) => (
                  <div key={l.code} className="flex justify-between">
                    <span className="text-muted-foreground">
                      {l.label}
                      {l.base > 0 && l.base !== brut && (
                        <span className="text-xs"> ({t('simulator.onBase', { amount: money(l.base) })})</span>
                      )}
                    </span>
                    <span className="font-mono text-orange-600">{money(l.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
                  <span>{t('simulator.taxableBase')}</span>
                  <span className="font-mono">{money(result.its.base)}</span>
                </div>
              </div>
            </div>

            {/* Détail des charges patronales — lignes du moteur */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-purple-500" /> {t('simulator.employerDetailTitle')}
              </h3>
              <div className="space-y-1.5 text-sm">
                {lignesPatronales.map((l) => (
                  <div key={l.code} className="flex justify-between">
                    <span className="text-muted-foreground">
                      {l.label}
                      {l.base > 0 && l.base !== brut && (
                        <span className="text-xs"> ({t('simulator.onBase', { amount: money(l.base) })})</span>
                      )}
                    </span>
                    <span className="font-mono text-purple-600">{money(l.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
                  <span>{t('simulator.cnps.totalEmployer')}</span>
                  <span className="font-mono text-purple-700">{money(result.cnps.patronal)}</span>
                </div>
              </div>
            </div>

            {/* Détail de l'impôt */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-blue-500" /> {t('simulator.itsDetailTitle')}
              </h3>
              <div className="space-y-1.5 text-sm">
                {[
                  { label: t('simulator.its.gross'),        value: money(brut) },
                  { label: t('simulator.its.taxable'),      value: money(result.its.base) },
                  { label: t('simulator.its.itsGross'),     value: money(result.its.brut) },
                  { label: t('simulator.its.parts'),        value: result.its.parts.toLocaleString('fr-FR') },
                  { label: t('simulator.its.familyCredit'), value: `−${money(result.its.credit)}` },
                  { label: t('simulator.its.itsFinal'),     value: money(result.its.net), bold: true },
                ].map(({ label, value, bold }) => (
                  <div key={label} className={`flex justify-between ${bold ? 'font-semibold border-t border-border pt-1.5 mt-1.5' : ''}`}>
                    <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
                    <span className="font-mono text-blue-700">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {showEnfantSimu && (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <h3 className="text-sm font-semibold mb-3 text-green-800 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" /> {t('simulator.childSimTitle')}
                </h3>
                <p className="text-sm text-green-700 mb-3">{result.simulation.avecUnEnfantSupp.message}</p>
                <div className="space-y-1.5 text-sm text-green-700">
                  <div className="flex justify-between">
                    <span>{t('simulator.childSim.monthlyGain')}</span>
                    <span className="font-mono font-semibold">{result.simulation.avecUnEnfantSupp.gain >= 0 ? '+' : '−'}{money(Math.abs(result.simulation.avecUnEnfantSupp.gain))}</span>
                  </div>
                  <div className="flex justify-between font-semibold border-t border-green-200 pt-1.5 mt-1.5">
                    <span>{t('simulator.childSim.newNet')}</span>
                    <span className="font-mono">{money(result.simulation.avecUnEnfantSupp.net)}</span>
                  </div>
                  <p className="text-xs mt-1 text-green-600">
                    {t('simulator.childSim.annualGain', { amount: money(result.simulation.avecUnEnfantSupp.gain * 12) })}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 flex flex-col items-center justify-center p-12 text-center">
            <Calculator className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-sm text-muted-foreground">
              <Trans i18nKey="simulator.emptyHint" ns="payroll" components={{ strong: <strong />, br: <br /> }} />
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
