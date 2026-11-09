/**
 * Simulateur de salaire — impôt, cotisations, net et coût employeur, pour le
 * PAYS choisi, à trois usages : chiffrer une EMBAUCHE avant de s'engager,
 * vérifier la situation d'un salarié EN POSTE, ou mesurer ce qu'une
 * REVALORISATION coûte et ce qu'elle rapporte réellement au salarié.
 *
 * L'écran était figé sur la Côte d'Ivoire : titre, barème, plafonds CNPS
 * (3 375 000 / 75 000) et taux (6,3 / 7,7 / 5,75 %) étaient recopiés en dur, et
 * le formulaire ignorait tout ce qui change le résultat : le pays, la catégorie
 * professionnelle et son minimum conventionnel (assiette de la prime
 * d'ancienneté), l'ancienneté, le conjoint sans emploi, les enfants couverts,
 * la prime de transport (exonérée dans la limite de la zone), les heures
 * supplémentaires et les avantages en nature.
 *
 * Deux sources, et seulement deux : le PACK du pays (lu via
 * `GET /settings/legislation?country=…`, qui pilote les champs affichés) et le
 * MOTEUR de paie (`POST /ai/simulate-its`, qui rend le détail ligne par ligne).
 * Aucun taux, plafond ou barème n'est écrit dans cette page.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/lib/api'
import {
  Calculator, Loader2, Info, TrendingDown, TrendingUp, Globe2, GraduationCap,
  Clock, BadgeCheck, ArrowRight,
} from 'lucide-react'

type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed'
type Purpose = 'hire' | 'current' | 'raise'
/** Conjoint : non renseigné (non compté), sans emploi, ou en emploi. */
type SpouseChoice = 'unknown' | 'covered' | 'employed'

interface Bracket { min: number; max: number | null; taux: number }

const OVERTIME_KINDS = ['weekly', 'weeklyBeyond', 'night', 'sunday', 'holiday', 'sundayHolidayNight'] as const
type OvertimeKind = (typeof OVERTIME_KINDS)[number]

interface QualificationLevel { key: string; label: string; yearsAfterBac: number; usualJobLevel: string }

/** Pack législatif, tel que le serveur le sert (extrait utile à l'écran). */
interface PackView {
  code: string
  countryCode: string
  name: string
  currency: string
  status: 'active' | 'stub'
  smigMensuel: number
  tranchesImpotSalaire: Bracket[]
  primeTransportExoneree?: { defaut: number; parZone?: Record<string, number> } | null
  cmu?: unknown
  seniorityBonus?: { base: 'category_minimum' | 'base_salary'; source: string } | null
  leaveRules?: { overtimeRates?: Partial<Record<OvertimeKind, number>> } | null
}

interface CountryOption {
  countryCode: string; packCode: string; name: string
  status: 'active' | 'stub'; currency: string; smigMensuel: number
}

interface LegislationView {
  countryCode: string
  countryLabel: string
  usable: boolean
  pack: PackView
  available: CountryOption[]
  qualificationLevels: QualificationLevel[]
}

interface SimLine {
  code: string
  label: string
  type: 'earning' | 'deduction' | 'employee_contribution' | 'employer_contribution' | 'reimbursement'
  base: number
  amount: number
}

interface Scenario {
  cnps: { salarial: number; patronal: number }
  cmu?: { salarial: number; patronal: number }
  its: { base: number; brut: number; credit: number; parts: number; net: number }
  net: { payable: number; smigCompliant: boolean }
  employerCost: number
  lines: SimLine[]
}

interface ApiResult extends Scenario {
  input: {
    baseSalary: number; primes: number; brut: number; atRate: number
    seniorityAmount: number; transportAllowance: number; countryCode: string
    categoryMinimum: number; categoryMinimumProvided: boolean
    professionalCategory: string | null; categoryLevel: number | null
    qualificationLevel: string | null; weeklyHours: number; benefitsInKind: number
  }
  seniority: { years: number; rate: number | null; base: number; amount: number; source: string | null }
  overtime: {
    total: number; hourlyRate: number
    lines: Array<{ category: OvertimeKind; label: string; hours: number; majoration: number; amount: number }>
  }
  compliance: { smig: boolean; smigMinimum: number; categoryMinimum: boolean | null }
  positioning: { usualJobLevel: string | null; salaryJobLevel: string; aligned: boolean; note: string }
  comparison: (Scenario & {
    input: { baseSalary: number; primes: number; brut: number; seniorityAmount: number }
    delta: {
      baseSalary: number; brut: number; netPayable: number; its: number
      cnpsSal: number; employerCost: number; brutPct: number; netSharePct: number | null
    }
  }) | null
  pack: {
    code: string; countryCode: string; name: string; currency: string; currencyLabel: string
    smigMensuel: number; usable: boolean; brackets: Bracket[]
    transportExoneration: { defaut: number; parZone?: Record<string, number> } | null
    hasCmu: boolean; hasSeniorityBonus: boolean
    overtimeRates: Partial<Record<OvertimeKind, number>> | null
  }
  simulation: { avecUnEnfantSupp: { its: number; net: number; gain: number; message: string } }
  currency: string
}

const PURPOSES: readonly Purpose[] = ['hire', 'current', 'raise']
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

/** Même règle que le serveur (`currencyLabel`) ; le résultat porte l'autorité. */
const currencyLabelOf = (code: string | undefined) =>
  code === 'XOF' || code === 'XAF' ? 'FCFA' : code ?? ''

const num = (v: string) => (v === '' ? undefined : Number(v))

export default function ItsSimulatorPage() {
  const { t, i18n } = useTranslation('payroll')
  const [purpose, setPurpose] = useState<Purpose>('hire')
  const [pays, setPays] = useState('')
  const [payMonth, setPayMonth] = useState(() => new Date().toISOString().slice(0, 7))
  // Rémunération
  const [brutMensuel, setBrutMensuel] = useState(250000)
  const [primes, setPrimes] = useState(0)
  const [transport, setTransport] = useState(0)
  const [ville, setVille] = useState('')
  const [avantages, setAvantages] = useState(0)
  // Profil
  const [categorie, setCategorie] = useState('')
  const [minCategoriel, setMinCategoriel] = useState<string>('')
  const [qualification, setQualification] = useState('')
  const [situation, setSituation] = useState<MaritalStatus>('married')
  const [enfants, setEnfants] = useState(2)
  const [conjoint, setConjoint] = useState<SpouseChoice>('unknown')
  const [enfantsCmu, setEnfantsCmu] = useState<string>('')
  const [atRate, setAtRate] = useState(0.020)
  // Temps de travail
  const [heuresHebdo, setHeuresHebdo] = useState<string>('40')
  const [joursTravailles, setJoursTravailles] = useState<string>('')
  const [heuresSupp, setHeuresSupp] = useState<Partial<Record<OvertimeKind, string>>>({})
  // Ancienneté
  const [dateEmbauche, setDateEmbauche] = useState('')
  const [anneesAnciennete, setAnneesAnciennete] = useState<string>('')
  // Revalorisation
  const [nouveauSalaire, setNouveauSalaire] = useState<string>('')
  const [nouvellesPrimes, setNouvellesPrimes] = useState<string>('')

  const [showEnfantSimu, setShowEnfantSimu] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)

  // Pays du tenant + liste des pays + référentiel des qualifications.
  const tenantQ = useQuery({
    queryKey: ['settings', 'legislation'],
    queryFn: async () => (await api.get('/settings/legislation')).data.data as LegislationView,
    staleTime: 10 * 60 * 1000,
  })
  // Pack du pays SÉLECTIONNÉ : c'est lui qui décide des champs affichés.
  const packQ = useQuery({
    queryKey: ['settings', 'legislation', pays],
    queryFn: async () => (await api.get(`/settings/legislation?country=${pays}`)).data.data as LegislationView,
    enabled: !!pays,
    staleTime: 10 * 60 * 1000,
  })

  useEffect(() => {
    if (!pays && tenantQ.data?.countryCode) setPays(tenantQ.data.countryCode)
  }, [tenantQ.data?.countryCode, pays])

  const formPack = packQ.data?.pack ?? tenantQ.data?.pack ?? null
  const overtimeRates = formPack?.leaveRules?.overtimeRates ?? {}
  const overtimeKinds = OVERTIME_KINDS.filter((k) => overtimeRates[k] !== undefined)
  const hasCmu = !!formPack?.cmu
  const hasSeniority = !!formPack?.seniorityBonus
  const seniorityOnCategory = formPack?.seniorityBonus?.base === 'category_minimum'
  const qualifications = tenantQ.data?.qualificationLevels ?? []

  const simuMut = useMutation({
    mutationFn: () => {
      const ot = Object.fromEntries(
        overtimeKinds
          .map((k) => [k, num(heuresSupp[k] ?? '')] as const)
          .filter(([, v]) => v !== undefined && v > 0),
      )
      return api.post<ApiResult>('/ai/simulate-its', {
        baseSalary: brutMensuel,
        maritalStatus: situation,
        childrenCount: enfants,
        atRate,
        primes,
        payMonth,
        ...(pays ? { countryCode: pays } : {}),
        ...(transport > 0 ? { transportAllowance: transport } : {}),
        ...(ville.trim() ? { city: ville.trim() } : {}),
        ...(avantages > 0 ? { benefitsInKind: avantages } : {}),
        ...(categorie.trim() ? { professionalCategory: categorie.trim() } : {}),
        ...(num(minCategoriel) !== undefined ? { categoryMinimum: num(minCategoriel) } : {}),
        ...(qualification ? { qualificationLevel: qualification } : {}),
        ...(conjoint === 'unknown' ? {} : { cmuSpouseCovered: conjoint === 'covered' }),
        ...(num(enfantsCmu) !== undefined ? { cmuChildrenCovered: num(enfantsCmu) } : {}),
        ...(dateEmbauche ? { hireDate: dateEmbauche } : {}),
        ...(!dateEmbauche && num(anneesAnciennete) !== undefined ? { seniorityYears: num(anneesAnciennete) } : {}),
        ...(num(heuresHebdo) !== undefined ? { weeklyHours: num(heuresHebdo) } : {}),
        ...(num(joursTravailles) !== undefined ? { workedDays: num(joursTravailles), workingDaysMonth: 26 } : {}),
        ...(Object.keys(ot).length > 0 ? { overtimeHours: ot } : {}),
        ...(purpose === 'raise' && num(nouveauSalaire) !== undefined
          ? {
            comparison: {
              baseSalary: num(nouveauSalaire),
              ...(num(nouvellesPrimes) !== undefined ? { primes: num(nouvellesPrimes) } : {}),
            },
          }
          : {}),
      })
    },
    onSuccess: (res) => setResult(res.data),
  })

  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-ring outline-none'
  const labelCls = 'text-sm font-medium'
  const hintCls = 'text-xs text-muted-foreground'

  const devise = result?.pack.currencyLabel ?? currencyLabelOf(formPack?.currency)
  const money = (n: number) =>
    `${Math.round(n).toLocaleString(i18n.language === 'en' ? 'en-US' : 'fr-FR').replace(/[  ]/g, ' ')} ${devise}`.trim()
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`

  const brut = result ? result.input.brut : brutMensuel + primes
  // Un résultat porte sur le pays AVEC LEQUEL il a été calculé. Dès que
  // l'utilisateur en choisit un autre, ce résultat ne décrit plus l'écran :
  // le laisser piloter les repères affichait le SMIG et le barème du pays
  // précédent jusqu'au recalcul — un minimum légal faux, présenté comme
  // celui du pays sélectionné.
  const resultatDuPaysAffiche = result && result.input.countryCode === pays ? result : null
  const smig = resultatDuPaysAffiche?.pack.smigMensuel ?? formPack?.smigMensuel ?? 0
  const brackets = resultatDuPaysAffiche?.pack.brackets ?? formPack?.tranchesImpotSalaire ?? []
  // Le TITRE, lui, nomme le pays RÉELLEMENT simulé par le serveur, même s'il
  // diffère de la sélection : si le moteur retombe sur un autre pack, le titre
  // doit le dire plutôt que de reprendre docilement la liste déroulante.
  const packName = result?.pack.name ?? packQ.data?.countryLabel ?? tenantQ.data?.countryLabel ?? ''
  const packUsable = resultatDuPaysAffiche ? resultatDuPaysAffiche.pack.usable : (formPack?.status ?? 'active') === 'active'

  const tauxEffort = result
    ? Math.round((result.cnps.salarial + result.its.net + (result.cmu?.salarial ?? 0)) / result.input.brut * 1000) / 10
    : 0

  const bracketLabel = (b: Bracket) =>
    b.max === null || !Number.isFinite(b.max) ? `> ${money(b.min - 1)}` : `${money(b.min)} – ${money(b.max)}`
  const pctLabel = (rate: number) => `${(rate * 100).toFixed((rate * 100) % 1 === 0 ? 0 : 1)} %`

  const transportCap = result?.pack.transportExoneration?.defaut ?? formPack?.primeTransportExoneree?.defaut ?? null

  const lignesPatronales = useMemo(
    () => result?.lines.filter((l) => l.type === 'employer_contribution') ?? [], [result])
  const lignesSalariales = useMemo(
    () => result?.lines.filter((l) => l.type === 'employee_contribution' || l.type === 'deduction') ?? [], [result])

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calculator className="h-6 w-6" />
          {t('simulator.title', { country: packName })}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('simulator.subtitle')}</p>
      </div>

      {/* Usage : embauche · salarié en poste · revalorisation */}
      <div className="inline-flex rounded-lg border border-border bg-card p-1">
        {PURPOSES.map((p) => (
          <button key={p} onClick={() => setPurpose(p)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${purpose === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {t(`simulator.purpose.${p}`)}
          </button>
        ))}
      </div>
      <p className={hintCls}>{t(`simulator.purposeHint.${purpose}`)}</p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Formulaire ─────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* Pays et période */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="font-semibold flex items-center gap-2"><Globe2 className="h-4 w-4" /> {t('simulator.countrySection')}</h2>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.countryLabel')}</label>
              <select className={inputCls} value={pays} onChange={e => setPays(e.target.value)}>
                {(tenantQ.data?.available ?? []).map(c => (
                  <option key={c.countryCode} value={c.countryCode}>
                    {c.name}{c.status === 'stub' ? ` — ${t('simulator.countryStub')}` : ''}
                  </option>
                ))}
              </select>
              <p className={hintCls}>{t('simulator.countryHint')}</p>
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.payMonthLabel')}</label>
              <input type="month" className={inputCls} value={payMonth} onChange={e => setPayMonth(e.target.value)} />
            </div>
            {!packUsable && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                {t('simulator.packStubWarning', { country: packName })}
              </div>
            )}
          </div>

          {/* Rémunération */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="font-semibold">{t('simulator.paySection')}</h2>
            <div className="space-y-1.5">
              <label className={labelCls}>
                {t(purpose === 'hire' ? 'simulator.offeredSalaryLabel' : 'simulator.baseSalaryLabel', { currency: devise })}
              </label>
              <input type="number" className={inputCls} value={brutMensuel}
                onChange={e => setBrutMensuel(parseInt(e.target.value) || 0)} min={0} step={10000} />
              <p className={hintCls}>{t('simulator.smigHint', { amount: money(smig) })}</p>
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.primesLabel', { currency: devise })}</label>
              <input type="number" className={inputCls} value={primes}
                onChange={e => setPrimes(parseInt(e.target.value) || 0)} min={0} step={5000} />
              <p className={hintCls}>{t('simulator.primesHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.transportLabel', { currency: devise })}</label>
                <input type="number" className={inputCls} value={transport}
                  onChange={e => setTransport(parseInt(e.target.value) || 0)} min={0} step={5000} />
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.cityLabel')}</label>
                <input type="text" className={inputCls} value={ville} placeholder={t('simulator.cityPlaceholder')}
                  onChange={e => setVille(e.target.value)} maxLength={100} />
              </div>
            </div>
            <p className={hintCls}>
              {transportCap !== null
                ? t('simulator.transportHint', { amount: money(transportCap) })
                : t('simulator.transportHintGeneric')}
            </p>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.benefitsLabel', { currency: devise })}</label>
              <input type="number" className={inputCls} value={avantages}
                onChange={e => setAvantages(parseInt(e.target.value) || 0)} min={0} step={5000} />
              <p className={hintCls}>{t('simulator.benefitsHint')}</p>
            </div>
          </div>

          {/* Classification et famille */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="font-semibold flex items-center gap-2"><GraduationCap className="h-4 w-4" /> {t('simulator.profileSection')}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.categoryLabel')}</label>
                <input type="text" className={inputCls} value={categorie} placeholder={t('simulator.categoryPlaceholder')}
                  onChange={e => setCategorie(e.target.value)} maxLength={50} />
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.categoryMinimumLabel', { currency: devise })}</label>
                <input type="number" className={inputCls} value={minCategoriel} placeholder={t('simulator.categoryMinimumPlaceholder')}
                  onChange={e => setMinCategoriel(e.target.value)} min={0} step={5000} />
              </div>
            </div>
            <p className={hintCls}>
              {seniorityOnCategory ? t('simulator.categoryMinimumHintSeniority') : t('simulator.categoryMinimumHint')}
            </p>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.qualificationLabel')}</label>
              <select className={inputCls} value={qualification} onChange={e => setQualification(e.target.value)}>
                <option value="">{t('simulator.qualificationNone')}</option>
                {qualifications.map(q => <option key={q.key} value={q.key}>{q.label}</option>)}
              </select>
              <p className={hintCls}>{t('simulator.qualificationHint')}</p>
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.maritalLabel')}</label>
              <select className={inputCls} value={situation}
                onChange={e => setSituation(e.target.value as MaritalStatus)}>
                {SITUATIONS.map(s => <option key={s} value={s}>{t(`simulator.${SITUATION_KEYS[s]}`)}</option>)}
              </select>
            </div>
            {situation === 'married' && hasCmu && (
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.spouseLabel')}</label>
                <select className={inputCls} value={conjoint}
                  onChange={e => setConjoint(e.target.value as SpouseChoice)}>
                  <option value="unknown">{t('simulator.spouseUnknown')}</option>
                  <option value="covered">{t('simulator.spouseCovered')}</option>
                  <option value="employed">{t('simulator.spouseEmployed')}</option>
                </select>
                <p className={hintCls}>{t('simulator.spouseHint')}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.childrenLabel')}</label>
                <input type="number" className={inputCls} value={enfants}
                  onChange={e => setEnfants(parseInt(e.target.value) || 0)} min={0} max={10} />
              </div>
              {hasCmu && (
                <div className="space-y-1.5">
                  <label className={labelCls}>{t('simulator.cmuChildrenLabel')}</label>
                  <input type="number" className={inputCls} value={enfantsCmu}
                    placeholder={t('simulator.cmuChildrenPlaceholder')}
                    onChange={e => setEnfantsCmu(e.target.value)} min={0} max={30} />
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>{t('simulator.sectorLabel')}</label>
              <select className={inputCls} value={atRate} onChange={e => setAtRate(parseFloat(e.target.value))}>
                {SECTEURS.map(s => <option key={s.value} value={s.value}>{t(`simulator.sectors.${s.key}`)}</option>)}
              </select>
            </div>
          </div>

          {/* Ancienneté et temps de travail */}
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="font-semibold flex items-center gap-2"><Clock className="h-4 w-4" /> {t('simulator.timeSection')}</h2>
            {hasSeniority && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={labelCls}>{t('simulator.hireDateLabel')}</label>
                    <input type="date" className={inputCls} value={dateEmbauche}
                      onChange={e => setDateEmbauche(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>{t('simulator.seniorityYearsLabel')}</label>
                    <input type="number" className={inputCls} value={anneesAnciennete}
                      placeholder={t('simulator.seniorityYearsPlaceholder')} disabled={!!dateEmbauche}
                      onChange={e => setAnneesAnciennete(e.target.value)} min={0} max={60} />
                  </div>
                </div>
                <p className={hintCls}>{t('simulator.seniorityHint')}</p>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.weeklyHoursLabel')}</label>
                <input type="number" className={inputCls} value={heuresHebdo}
                  onChange={e => setHeuresHebdo(e.target.value)} min={1} max={84} />
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>{t('simulator.workedDaysLabel')}</label>
                <input type="number" className={inputCls} value={joursTravailles}
                  placeholder={t('simulator.workedDaysPlaceholder')}
                  onChange={e => setJoursTravailles(e.target.value)} min={0} max={31} />
              </div>
            </div>
            {overtimeKinds.length > 0 && (
              <div className="space-y-2">
                <p className={labelCls}>{t('simulator.overtimeLabel')}</p>
                <div className="grid grid-cols-2 gap-3">
                  {overtimeKinds.map((k) => (
                    <div key={k} className="space-y-1">
                      <label className="text-xs text-muted-foreground">
                        {t(`simulator.overtime.${k}`, { rate: pctLabel(overtimeRates[k] ?? 0) })}
                      </label>
                      <input type="number" className={inputCls} value={heuresSupp[k] ?? ''}
                        placeholder="0" min={0} max={200}
                        onChange={e => setHeuresSupp(h => ({ ...h, [k]: e.target.value }))} />
                    </div>
                  ))}
                </div>
                <p className={hintCls}>{t('simulator.overtimeHint')}</p>
              </div>
            )}
          </div>

          {/* Revalorisation */}
          {purpose === 'raise' && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-6 space-y-4">
              <h2 className="font-semibold flex items-center gap-2"><ArrowRight className="h-4 w-4" /> {t('simulator.raiseSection')}</h2>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>{t('simulator.newSalaryLabel', { currency: devise })}</label>
                  <input type="number" className={inputCls} value={nouveauSalaire}
                    placeholder={String(brutMensuel)} min={0} step={10000}
                    onChange={e => setNouveauSalaire(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>{t('simulator.newPrimesLabel', { currency: devise })}</label>
                  <input type="number" className={inputCls} value={nouvellesPrimes}
                    placeholder={String(primes)} min={0} step={5000}
                    onChange={e => setNouvellesPrimes(e.target.value)} />
                </div>
              </div>
              <p className={hintCls}>{t('simulator.raiseHint')}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
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

          {/* Barème du pays */}
          {brackets.length > 0 && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 space-y-1.5">
              <p className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" /> {t('simulator.scaleTitle', { country: packName })}
              </p>
              {brackets.map((b) => (
                <div key={`${b.min}-${b.max ?? 'max'}`} className="flex justify-between text-xs text-blue-700">
                  <span>{bracketLabel(b)}</span>
                  <span className="font-mono font-semibold">{pctLabel(b.taux)}</span>
                </div>
              ))}
              <p className="text-xs text-blue-600 pt-1 border-t border-blue-200">{t('simulator.scaleNote')}</p>
            </div>
          )}
        </div>

        {/* ── Résultats ──────────────────────────────────────────────────── */}
        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: t('simulator.kpiGross'),        value: money(brut),                 color: 'text-foreground',          bg: 'bg-card' },
                { label: t('simulator.kpiNetPayable'),   value: money(result.net.payable),   color: 'text-green-700 font-bold', bg: 'bg-green-50 border-green-200' },
                { label: t('simulator.kpiCnpsSal'),      value: money(result.cnps.salarial), color: 'text-orange-700',          bg: 'bg-orange-50 border-orange-200' },
                { label: t('simulator.kpiItsFinal'),     value: money(result.its.net),       color: 'text-blue-700',            bg: 'bg-blue-50 border-blue-200' },
                { label: t('simulator.kpiEmployerCost'), value: money(result.employerCost),  color: 'text-purple-700',          bg: 'bg-purple-50 border-purple-200' },
                { label: t('simulator.kpiEffort'),       value: `${tauxEffort} %`,           color: 'text-muted-foreground',    bg: 'bg-muted/30' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} className={`rounded-xl border p-3 ${bg}`}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-base font-mono ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {purpose === 'hire' && (
              <div className="rounded-xl border border-purple-200 bg-purple-50 p-4 text-sm">
                <p className="text-purple-800">
                  {t('simulator.hireTotal', {
                    monthly: money(result.employerCost), annual: money(result.employerCost * 12),
                  })}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${result.compliance.smig ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {result.compliance.smig
                  ? t('simulator.smigCompliant', { amount: money(result.compliance.smigMinimum) })
                  : t('simulator.smigNotCompliant', { amount: money(result.compliance.smigMinimum) })}
              </span>
              {result.compliance.categoryMinimum !== null && (
                <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${result.compliance.categoryMinimum ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {result.compliance.categoryMinimum
                    ? t('simulator.categoryMinimumCompliant', { amount: money(result.input.categoryMinimum) })
                    : t('simulator.categoryMinimumNotCompliant', { amount: money(result.input.categoryMinimum) })}
                </span>
              )}
            </div>

            {/* Revalorisation : avant / après / écart */}
            {result.comparison && (
              <div className="rounded-xl border border-blue-200 bg-card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-blue-500" />
                  {t('simulator.comparisonTitle', { pct: result.comparison.delta.brutPct })}
                </h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="text-left font-normal pb-1.5">{t('simulator.comparison.row')}</th>
                      <th className="text-right font-normal pb-1.5">{t('simulator.comparison.before')}</th>
                      <th className="text-right font-normal pb-1.5">{t('simulator.comparison.after')}</th>
                      <th className="text-right font-normal pb-1.5">{t('simulator.comparison.delta')}</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {[
                      { label: t('simulator.kpiGross'),        a: brut,                 b: result.comparison.input.brut,    d: result.comparison.delta.brut },
                      { label: t('simulator.kpiNetPayable'),   a: result.net.payable,   b: result.comparison.net.payable,   d: result.comparison.delta.netPayable, strong: true },
                      { label: t('simulator.kpiItsFinal'),     a: result.its.net,       b: result.comparison.its.net,       d: result.comparison.delta.its },
                      { label: t('simulator.kpiCnpsSal'),      a: result.cnps.salarial, b: result.comparison.cnps.salarial, d: result.comparison.delta.cnpsSal },
                      { label: t('simulator.kpiEmployerCost'), a: result.employerCost,  b: result.comparison.employerCost,  d: result.comparison.delta.employerCost },
                    ].map(({ label, a, b, d, strong }) => (
                      <tr key={label} className={strong ? 'font-semibold' : ''}>
                        <td className="py-0.5 font-sans text-muted-foreground">{label}</td>
                        <td className="py-0.5 text-right">{money(a)}</td>
                        <td className="py-0.5 text-right">{money(b)}</td>
                        <td className={`py-0.5 text-right ${d > 0 ? 'text-green-700' : d < 0 ? 'text-red-600' : ''}`}>{signed(d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.comparison.delta.netSharePct !== null && (
                  <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
                    {t('simulator.comparison.netShare', {
                      pct: result.comparison.delta.netSharePct,
                      cost: money(result.comparison.delta.employerCost),
                    })}
                  </p>
                )}
              </div>
            )}

            {/* Positionnement (repère) */}
            <div className="rounded-lg bg-muted/30 border border-border p-3 text-sm flex gap-2">
              <BadgeCheck className={`h-4 w-4 mt-0.5 shrink-0 ${result.positioning.aligned ? 'text-green-600' : 'text-amber-600'}`} />
              <span className="text-muted-foreground">{result.positioning.note}</span>
            </div>

            {/* Ancienneté */}
            {result.seniority.amount > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 text-sm space-y-1">
                <h3 className="text-sm font-semibold mb-2">{t('simulator.seniorityTitle')}</h3>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('simulator.seniority.years')}</span>
                  <span className="font-mono">{result.seniority.years}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('simulator.seniority.rate')}</span>
                  <span className="font-mono">{result.seniority.rate !== null ? pctLabel(result.seniority.rate) : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('simulator.seniority.base')}</span>
                  <span className="font-mono">{money(result.seniority.base)}</span>
                </div>
                <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
                  <span>{t('simulator.seniority.amount')}</span>
                  <span className="font-mono">{money(result.seniority.amount)}</span>
                </div>
                {result.seniority.source && (
                  <p className="text-xs text-muted-foreground pt-1">{result.seniority.source}</p>
                )}
              </div>
            )}

            {/* Heures supplémentaires */}
            {result.overtime.lines.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-green-600" />
                  {t('simulator.overtimeTitle', { rate: money(result.overtime.hourlyRate) })}
                </h3>
                <div className="space-y-1.5 text-sm">
                  {result.overtime.lines.map((l) => (
                    <div key={l.category} className="flex justify-between">
                      <span className="text-muted-foreground">
                        {l.label} <span className="text-xs">({t('simulator.overtimeHours', { hours: l.hours })})</span>
                      </span>
                      <span className="font-mono text-green-700">{money(l.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
                    <span>{t('simulator.overtimeTotal')}</span>
                    <span className="font-mono text-green-700">{money(result.overtime.total)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Retenues salariales */}
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

            {/* Charges patronales */}
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

            {/* Impôt */}
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
                    <span className="font-mono font-semibold">{signed(result.simulation.avecUnEnfantSupp.gain)}</span>
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
