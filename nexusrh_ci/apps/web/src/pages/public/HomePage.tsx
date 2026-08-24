/**
 * Page d'accueil publique servie à la racine du domaine.
 *
 * Contraintes tenues :
 *   - AUCUN appel à l'API : la page est publique, aucune donnée de tenant ne
 *     doit pouvoir transiter par elle (vérifié par home-page.test.tsx).
 *   - AUCUNE ressource externe : la CSP est `default-src 'self'` — pas de
 *     police Google, pas de lecteur vidéo tiers, pas de traceur. La vidéo est
 *     servie depuis notre propre domaine.
 *   - Palette et typographie autonomes : la page ne dépend pas du thème d'un
 *     tenant (il n'y en a pas avant connexion).
 *
 * Parti pris visuel : le bulletin de paie. Filets, colonne de codes et chiffres
 * en tabulaire — l'objet même que le produit doit rendre juste. L'élément
 * signature est un extrait de bulletin démontrant le double plafond CNPS.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher'

const PAPER  = '#F2F4F3'
const INK    = '#14201C'
const RULE   = '#C8D2CD'
const ACCENT = '#E85D04'
const BAND   = '#0B3B2E'

const EMAIL     = 'waopron@openlabconsulting.com'
const PHONE_CI  = '+225 07 09 32 05 94'
const PHONE_FR  = '+33 6 19 24 53 29'
const WHATSAPP  = 'https://wa.me/2250709320594'

/** Filet + intitulé de section, dans la langue du document de paie. */
function SectionHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <header className="mb-10 border-t pt-6" style={{ borderColor: RULE }}>
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: ACCENT }}>
        {eyebrow}
      </p>
      <h2 className="max-w-3xl text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl" style={{ color: INK }}>
        {title}
      </h2>
      {lead && <p className="mt-4 max-w-2xl text-base leading-relaxed opacity-70" style={{ color: INK }}>{lead}</p>}
    </header>
  )
}

/** Bloc de contenu réglé : un titre, un texte. Pas de carte flottante. */
function Ruled({ title, text }: { title: string; text: string }) {
  return (
    <div className="border-t py-5" style={{ borderColor: RULE }}>
      <h3 className="text-[15px] font-semibold tracking-tight" style={{ color: INK }}>{title}</h3>
      <p className="mt-2 text-sm leading-relaxed opacity-70" style={{ color: INK }}>{text}</p>
    </div>
  )
}

export default function HomePage() {
  const { t } = useTranslation('home')

  const audience   = ['sme', 'group', 'public', 'agency'] as const
  const compliance = ['cnps', 'its', 'labour', 'declarations', 'ohada', 'currency'] as const
  const families   = ['payroll', 'people', 'time', 'talent', 'hiring', 'steering'] as const
  const ai         = ['assistant', 'screening', 'interview', 'control'] as const
  const security   = ['isolation', 'rbac', 'mfa', 'crypto', 'audit', 'hosting', 'sso', 'signature'] as const

  // Le double plafond CNPS, sur un brut de 2 000 000 FCFA. Chiffres calculés
  // avec les constantes légales 2024 (cf. CI_LEGAL_CONSTANTS_2024).
  const payslipRows = [
    { code: '2000', label: t('proof.rows.retirement'), note: t('proof.rows.retirementNote'), base: '1 647 315', rate: '6,3 %', amount: '103 781' },
    { code: '3300', label: t('proof.rows.accident'),   note: t('proof.rows.accidentNote'),   base: '70 000',    rate: '2,0 %', amount: '1 400' },
    { code: '3200', label: t('proof.rows.family'),     note: null,                            base: '70 000',    rate: '5,0 %', amount: '3 500' },
    { code: '2100', label: t('proof.rows.its'),        note: null,                            base: '1 700 000', rate: '15 %',  amount: '212 500' },
  ]

  return (
    <div className="min-h-screen" style={{ backgroundColor: PAPER, color: INK }}>
      <style>{`
        .nx-figure { font-variant-numeric: tabular-nums; }
        @keyframes nx-rise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
        .nx-rise { animation: nx-rise .7s cubic-bezier(.2,.7,.3,1) both }
        .nx-rise-2 { animation-delay: .09s }
        .nx-rise-3 { animation-delay: .18s }
        @media (prefers-reduced-motion: reduce) { .nx-rise { animation: none } }
      `}</style>

      <a href="#contenu" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:outline focus:outline-2">
        {t('meta.skipToContent')}
      </a>

      {/* ── Bandeau ─────────────────────────────────────────────────────── */}
      <div className="border-b" style={{ borderColor: RULE }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="" className="h-8 w-8" />
            <span className="text-[15px] font-semibold tracking-tight">NexusRH <span style={{ color: ACCENT }}>CI</span></span>
          </div>
          <div className="flex items-center gap-4">
            <LanguageSwitcher />
            <Link to="/login" className="hidden text-sm font-medium underline-offset-4 hover:underline sm:inline">
              {t('hero.ctaApp')}
            </Link>
          </div>
        </div>
      </div>

      <main id="contenu" className="mx-auto max-w-6xl px-6">

        {/* ── Accroche + vidéo ──────────────────────────────────────────── */}
        <section className="grid gap-12 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:py-24">
          <div className="nx-rise">
            <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: ACCENT }}>
              {t('hero.eyebrow')}
            </p>
            <h1 className="text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.02em] sm:text-6xl">
              {t('hero.title')}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed opacity-75">{t('hero.lead')}</p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a href="#contact"
                className="rounded-sm px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline focus:outline-2 focus:outline-offset-2"
                style={{ backgroundColor: ACCENT, outlineColor: INK }}>
                {t('hero.ctaDemo')}
              </a>
              <Link to="/login"
                className="rounded-sm border px-6 py-3.5 text-sm font-semibold transition-colors hover:bg-white focus:outline focus:outline-2 focus:outline-offset-2"
                style={{ borderColor: INK, color: INK, outlineColor: ACCENT }}>
                {t('hero.ctaApp')}
              </Link>
            </div>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.16em] opacity-50">{t('hero.editor')}</p>
          </div>

          {/* La vidéo, encadrée comme un document de paie. */}
          <figure className="nx-rise nx-rise-2 border bg-white" style={{ borderColor: INK }}>
            <figcaption className="flex items-center justify-between border-b px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em]" style={{ borderColor: RULE }}>
              <span style={{ color: ACCENT }}>{t('video.label')}</span>
              <span className="opacity-50">NEXUSRH-CI</span>
            </figcaption>
            <video
              controls
              preload="metadata"
              playsInline
              className="block aspect-video w-full bg-black"
              title={t('video.docTitle')}
            >
              <source src="/nexusrh.mp4" type="video/mp4" />
              {t('video.unsupported')}
            </video>
            <p className="border-t px-4 py-3 text-xs leading-relaxed opacity-60" style={{ borderColor: RULE }}>
              {t('video.caption')}
            </p>
          </figure>
        </section>

        {/* ── Signature : le double plafond CNPS ────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('proof.eyebrow')} title={t('proof.title')} lead={t('proof.lead')} />
          <div className="overflow-x-auto border bg-white" style={{ borderColor: INK }}>
            <p className="border-b px-5 py-3 font-mono text-[11px] uppercase tracking-[0.16em]" style={{ borderColor: RULE, color: ACCENT }}>
              {t('proof.case')}
            </p>
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b text-left font-mono text-[10px] uppercase tracking-[0.14em] opacity-55" style={{ borderColor: RULE }}>
                  <th scope="col" className="px-5 py-3 font-normal">{t('proof.table.code')}</th>
                  <th scope="col" className="px-5 py-3 font-normal">{t('proof.table.label')}</th>
                  <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.base')}</th>
                  <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.rate')}</th>
                  <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {payslipRows.map(r => (
                  <tr key={r.code} className="border-b align-top last:border-0" style={{ borderColor: RULE }}>
                    <td className="nx-figure px-5 py-4 font-mono text-xs" style={{ color: ACCENT }}>{r.code}</td>
                    <td className="px-5 py-4">
                      <span className="font-medium">{r.label}</span>
                      {r.note && <span className="mt-1 block font-mono text-[11px] opacity-55">{r.note}</span>}
                    </td>
                    <td className="nx-figure px-5 py-4 text-right font-mono">{r.base}</td>
                    <td className="nx-figure px-5 py-4 text-right font-mono opacity-70">{r.rate}</td>
                    <td className="nx-figure px-5 py-4 text-right font-mono font-semibold">{r.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-5 max-w-2xl border-l-2 pl-5 text-sm leading-relaxed" style={{ borderColor: ACCENT }}>
            {t('proof.note')}
          </p>
        </section>

        {/* ── À qui ça s'adresse ────────────────────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('audience.eyebrow')} title={t('audience.title')} />
          <div className="grid gap-x-12 sm:grid-cols-2">
            {audience.map(k => <Ruled key={k} title={t(`audience.${k}.title`)} text={t(`audience.${k}.text`)} />)}
          </div>
        </section>

        {/* ── Conformité ────────────────────────────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('compliance.eyebrow')} title={t('compliance.title')} lead={t('compliance.lead')} />
          <div className="grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
            {compliance.map(k => <Ruled key={k} title={t(`compliance.${k}.title`)} text={t(`compliance.${k}.text`)} />)}
          </div>
        </section>

        {/* ── Couverture fonctionnelle, en index de document ────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('modules.eyebrow')} title={t('modules.title')} lead={t('modules.lead')} />
          <div className="border-t" style={{ borderColor: RULE }}>
            {families.map(k => (
              <div key={k} className="grid gap-2 border-b py-6 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-8" style={{ borderColor: RULE }}>
                <h3 className="text-[15px] font-semibold tracking-tight">{t(`modules.${k}.title`)}</h3>
                <p className="text-sm leading-relaxed opacity-70">{t(`modules.${k}.items`)}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Versement des salaires ────────────────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('pay.eyebrow')} title={t('pay.title')} lead={t('pay.lead')} />
          <div className="grid gap-x-12 sm:grid-cols-2">
            <Ruled title={t('pay.mobile.title')} text={t('pay.mobile.text')} />
            <Ruled title={t('pay.bank.title')} text={t('pay.bank.text')} />
          </div>
        </section>

        {/* ── Groupes et multi-pays ─────────────────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('multi.eyebrow')} title={t('multi.title')} lead={t('multi.lead')} />
          <div className="grid gap-x-12 sm:grid-cols-3">
            <Ruled title={t('multi.entities.title')} text={t('multi.entities.text')} />
            <Ruled title={t('multi.packs.title')} text={t('multi.packs.text')} />
            <Ruled title={t('multi.consolidation.title')} text={t('multi.consolidation.text')} />
          </div>
        </section>

        {/* ── Intelligence artificielle ─────────────────────────────────── */}
        <section className="pb-20">
          <SectionHead eyebrow={t('ai.eyebrow')} title={t('ai.title')} lead={t('ai.lead')} />
          <div className="grid gap-x-12 sm:grid-cols-2">
            {ai.map(k => <Ruled key={k} title={t(`ai.${k}.title`)} text={t(`ai.${k}.text`)} />)}
          </div>
        </section>
      </main>

      {/* ── Sécurité : bande sombre, le seul renversement de la page ───── */}
      <section className="mt-4 py-20" style={{ backgroundColor: BAND, color: PAPER }}>
        <div className="mx-auto max-w-6xl px-6">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: ACCENT }}>
            {t('security.eyebrow')}
          </p>
          <h2 className="max-w-3xl text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl">{t('security.title')}</h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed opacity-75">{t('security.lead')}</p>
          <div className="mt-10 grid gap-x-12 sm:grid-cols-2 lg:grid-cols-4">
            {security.map(k => (
              <div key={k} className="border-t py-5" style={{ borderColor: 'rgba(242,244,243,.22)' }}>
                <h3 className="text-[15px] font-semibold tracking-tight">{t(`security.${k}.title`)}</h3>
                <p className="mt-2 text-sm leading-relaxed opacity-70">{t(`security.${k}.text`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Contact ───────────────────────────────────────────────────── */}
      <section id="contact" className="scroll-mt-8 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <SectionHead eyebrow={t('contact.eyebrow')} title={t('contact.title')} lead={t('contact.lead')} />
          <div className="grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.emailLabel')}</p>
              <a href={`mailto:${EMAIL}`} className="mt-2 block text-[15px] font-semibold underline-offset-4 hover:underline" style={{ color: ACCENT }}>
                {EMAIL}
              </a>
            </div>
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.whatsappLabel')}</p>
              <a href={WHATSAPP} rel="noreferrer noopener" target="_blank" className="nx-figure mt-2 block text-[15px] font-semibold underline-offset-4 hover:underline">
                {PHONE_CI}
              </a>
            </div>
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.phoneFrLabel')}</p>
              <a href={`tel:${PHONE_FR.replace(/\s/g, '')}`} className="nx-figure mt-2 block text-[15px] font-semibold underline-offset-4 hover:underline">
                {PHONE_FR}
              </a>
            </div>
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.addressLabel')}</p>
              <p className="mt-2 text-sm leading-relaxed opacity-75">{t('contact.address')}</p>
            </div>
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.hoursLabel')}</p>
              <p className="mt-2 text-sm leading-relaxed opacity-75">{t('contact.hours')}</p>
            </div>
            <div className="border-t py-5" style={{ borderColor: RULE }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55">{t('contact.alreadyClient')}</p>
              <Link to="/login" className="mt-2 block text-[15px] font-semibold underline-offset-4 hover:underline">
                {t('hero.ctaApp')}
              </Link>
            </div>
          </div>

          <div className="mt-12 flex flex-wrap gap-3">
            <a href={`mailto:${EMAIL}`}
              className="rounded-sm px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline focus:outline-2 focus:outline-offset-2"
              style={{ backgroundColor: ACCENT, outlineColor: INK }}>
              {t('hero.ctaDemo')}
            </a>
            <Link to="/login"
              className="rounded-sm border px-6 py-3.5 text-sm font-semibold transition-colors hover:bg-white focus:outline focus:outline-2 focus:outline-offset-2"
              style={{ borderColor: INK, color: INK, outlineColor: ACCENT }}>
              {t('hero.ctaApp')}
            </Link>
          </div>
        </div>
      </section>

      {/* ── Pied de page ──────────────────────────────────────────────── */}
      <footer className="border-t py-10" style={{ borderColor: RULE }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm">
          <p className="font-medium">{t('footer.tagline')}</p>
          <p className="opacity-60">
            © {new Date().getFullYear()} {t('footer.editor')} — {t('footer.rights')}
          </p>
        </div>
      </footer>
    </div>
  )
}
