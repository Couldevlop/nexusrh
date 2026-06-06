import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api, formatFCFA } from '@/lib/api'
import { Calculator, Loader2, Info, TrendingDown, TrendingUp } from 'lucide-react'

interface ApiPayload {
  baseSalary: number
  maritalStatus: 'single' | 'married'
  childrenCount: number
  atRate: number
  primes: number
}

interface ApiResult {
  input: ApiPayload & { brut: number }
  cnps: { salarial: number; patronal: number }
  its: { base: number; brut: number; credit: number; net: number }
  net: { payable: number; smigCompliant: boolean }
  employerCost: number
  simulation: {
    avecUnEnfantSupp: {
      its: number; net: number; gain: number; message: string
    }
  }
  currency: string
}

const SECTEURS = [
  { value: 0.020, key: 'commerce' },
  { value: 0.030, key: 'btp' },
  { value: 0.040, key: 'industrie' },
  { value: 0.050, key: 'extraction' },
] as const

export default function ItsSimulatorPage() {
  const { t } = useTranslation('payroll')
  const [brutMensuel, setBrutMensuel] = useState(250000)
  const [situation, setSituation] = useState<'single' | 'married'>('married')
  const [enfants, setEnfants] = useState(2)
  const [atRate, setAtRate] = useState(0.020)
  const [primes, setPrimes] = useState(0)
  const [showEnfantSimu, setShowEnfantSimu] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)

  const simuMut = useMutation({
    mutationFn: () => api.post<ApiResult>('/ai/simulate-its', {
      baseSalary: brutMensuel,
      maritalStatus: situation,
      childrenCount: enfants,
      atRate,
      primes,
    }),
    onSuccess: (res) => setResult(res.data),
  })

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'

  const brut = result ? result.input.brut : brutMensuel + primes
  const tauxEffort = result ? Math.round((result.cnps.salarial + result.its.net) / result.input.brut * 100 * 10) / 10 : 0

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calculator className="h-6 w-6" />
          {t('simulator.title')}
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
            <label className="text-sm font-medium">{t('simulator.baseSalaryLabel')}</label>
            <input type="number" className={inputCls} value={brutMensuel}
              onChange={e => setBrutMensuel(parseInt(e.target.value) || 0)} min={60000} step={10000} />
            <p className="text-xs text-muted-foreground">{t('simulator.smigHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.primesLabel')}</label>
            <input type="number" className={inputCls} value={primes}
              onChange={e => setPrimes(parseInt(e.target.value) || 0)} min={0} step={5000} />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.maritalLabel')}</label>
            <select className={inputCls} value={situation}
              onChange={e => setSituation(e.target.value as 'single' | 'married')}>
              <option value="single">{t('simulator.maritalSingle')}</option>
              <option value="married">{t('simulator.maritalMarried')}</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.childrenLabel')}</label>
            <input type="number" className={inputCls} value={enfants}
              onChange={e => setEnfants(parseInt(e.target.value) || 0)} min={0} max={10} />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('simulator.sectorLabel')}</label>
            <select className={inputCls} value={atRate}
              onChange={e => setAtRate(parseFloat(e.target.value))}>
              {SECTEURS.map(s => <option key={s.value} value={s.value}>{t(`simulator.sectors.${s.key}`)}</option>)}
            </select>
          </div>

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

          {/* Aide barème */}
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 space-y-1.5">
            <p className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" /> {t('simulator.scaleTitle')}
            </p>
            {[
              { tranche: '0 – 75 000 FCFA', taux: '0 %' },
              { tranche: '75 001 – 240 000 FCFA', taux: '1,5 %' },
              { tranche: '240 001 – 800 000 FCFA', taux: '5 %' },
              { tranche: '800 001 – 2 000 000 FCFA', taux: '10 %' },
              { tranche: '> 2 000 000 FCFA', taux: '15 %' },
            ].map(({ tranche, taux }) => (
              <div key={tranche} className="flex justify-between text-xs text-blue-700">
                <span>{tranche}</span>
                <span className="font-mono font-semibold">{taux}</span>
              </div>
            ))}
            <p className="text-xs text-blue-600 pt-1 border-t border-blue-200">
              {t('simulator.scaleNote')}
            </p>
          </div>
        </div>

        {/* Résultats */}
        {result ? (
          <div className="space-y-4">
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: t('simulator.kpiGross'),        value: formatFCFA(brut),                    color: 'text-foreground',      bg: 'bg-card' },
                { label: t('simulator.kpiNetPayable'),   value: formatFCFA(result.net.payable),       color: 'text-green-700 font-bold', bg: 'bg-green-50 border-green-200' },
                { label: t('simulator.kpiCnpsSal'),      value: formatFCFA(result.cnps.salarial),     color: 'text-orange-700',      bg: 'bg-orange-50 border-orange-200' },
                { label: t('simulator.kpiItsFinal'),     value: formatFCFA(result.its.net),           color: 'text-blue-700',        bg: 'bg-blue-50 border-blue-200' },
                { label: t('simulator.kpiEmployerCost'), value: formatFCFA(result.employerCost),      color: 'text-purple-700',      bg: 'bg-purple-50 border-purple-200' },
                { label: t('simulator.kpiEffort'),       value: `${tauxEffort} %`,                   color: 'text-muted-foreground', bg: 'bg-muted/30' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className={`rounded-xl border p-3 ${bg}`}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-base font-mono ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* SMIG */}
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${result.net.smigCompliant ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {result.net.smigCompliant ? t('simulator.smigCompliant') : t('simulator.smigNotCompliant')}
            </span>

            {/* Détail CNPS */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-orange-500" /> {t('simulator.cnpsDetailTitle')}
              </h3>
              <div className="space-y-1.5 text-sm">
                {[
                  { label: t('simulator.cnps.grossSubject'),       value: formatFCFA(brut) },
                  { label: t('simulator.cnps.retirementBase'),     value: formatFCFA(Math.min(brut, 1_647_315)) },
                  { label: t('simulator.cnps.atPfBase'),           value: formatFCFA(Math.min(brut, 70_000)) },
                  { label: t('simulator.cnps.retirementEmployee'), value: formatFCFA(Math.floor(Math.min(brut, 1_647_315) * 0.063)), cls: 'text-orange-600' },
                  { label: t('simulator.cnps.retirementEmployer'), value: formatFCFA(Math.floor(Math.min(brut, 1_647_315) * 0.077)), cls: 'text-purple-600' },
                  { label: t('simulator.cnps.familyMaternity'),    value: formatFCFA(Math.floor(Math.min(brut, 70_000) * 0.0575)), cls: 'text-purple-600' },
                  { label: t('simulator.cnps.atMp', { rate: (atRate * 100).toFixed(0) }), value: formatFCFA(Math.floor(Math.min(brut, 70_000) * atRate)), cls: 'text-purple-600' },
                  { label: t('simulator.cnps.totalEmployer'),      value: formatFCFA(result.cnps.patronal), cls: 'text-purple-700 font-semibold border-t border-border pt-1.5 mt-1.5' },
                ].map(({ label, value, cls }) => (
                  <div key={label} className={`flex justify-between ${cls ?? ''}`}>
                    <span className={cls?.includes('text-') ? '' : 'text-muted-foreground'}>{label}</span>
                    <span className="font-mono">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Détail ITS */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-blue-500" /> {t('simulator.itsDetailTitle')}
              </h3>
              <div className="space-y-1.5 text-sm">
                {[
                  { label: t('simulator.its.gross'),             value: formatFCFA(brut) },
                  { label: t('simulator.its.abatement'),         value: `−${formatFCFA(Math.floor(brut * 0.15))}` },
                  { label: t('simulator.its.taxableBeforeCnps'), value: formatFCFA(Math.floor(brut * 0.85)) },
                  { label: t('simulator.its.minusCnps'),         value: `−${formatFCFA(result.cnps.salarial)}` },
                  { label: t('simulator.its.taxableNet'),        value: formatFCFA(result.its.base) },
                  { label: t('simulator.its.itsGross'),          value: formatFCFA(result.its.brut) },
                  { label: t('simulator.its.familyCredit'),      value: `−${formatFCFA(result.its.credit)}` },
                  { label: t('simulator.its.itsFinal'),          value: formatFCFA(result.its.net), bold: true },
                ].map(({ label, value, bold }) => (
                  <div key={label} className={`flex justify-between ${bold ? 'font-semibold border-t border-border pt-1.5 mt-1.5' : ''}`}>
                    <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
                    <span className="font-mono text-blue-700">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Simulation +1 enfant */}
            {showEnfantSimu && (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                <h3 className="text-sm font-semibold mb-3 text-green-800 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" /> {t('simulator.childSimTitle')}
                </h3>
                <p className="text-sm text-green-700 mb-3">{result.simulation.avecUnEnfantSupp.message}</p>
                <div className="space-y-1.5 text-sm text-green-700">
                  <div className="flex justify-between">
                    <span>{t('simulator.childSim.monthlyGain')}</span>
                    <span className="font-mono font-semibold">+{formatFCFA(result.simulation.avecUnEnfantSupp.gain)}</span>
                  </div>
                  <div className="flex justify-between font-semibold border-t border-green-200 pt-1.5 mt-1.5">
                    <span>{t('simulator.childSim.newNet')}</span>
                    <span className="font-mono">{formatFCFA(result.simulation.avecUnEnfantSupp.net)}</span>
                  </div>
                  <p className="text-xs mt-1 text-green-600">
                    {t('simulator.childSim.annualGain', { amount: formatFCFA(result.simulation.avecUnEnfantSupp.gain * 12) })}
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
