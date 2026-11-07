/**
 * Page d'accueil publique servie à la racine du domaine.
 *
 * Contraintes tenues :
 *   - la page est INERTE au chargement : aucun appel réseau tant que le
 *     visiteur n'a pas touché le formulaire de démo (cf. DemoForm) ;
 *   - AUCUNE ressource externe : la CSP est `default-src 'self'` — pas de
 *     police Google, pas de lecteur vidéo tiers, pas de traceur ;
 *   - palette autonome : la page ne dépend d'aucun thème de tenant.
 *
 * Direction visuelle : la palette vient du logo OpenLab lui-même — orange,
 * noir, blanc — avec le cyan NexusRH réservé aux chiffres. Page claire, mais
 * tenue par des aplats francs, une typographie large et une bande orange
 * pleine largeur pour la sécurité. La grammaire du bulletin de paie structure
 * la démonstration : filets, colonne de codes, chiffres tabulaires.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher'
import DemoForm from './DemoForm'
import {
  CATALOG_MODULE_COUNT, DEPLOY_POINTS, DEPLOY_ROWS, HOME_ANCHORS, HOME_DOMAINS, HOME_FAQ, PHONES, PROOF_CNPS, PUBLISHER,
} from './home-content'
// La vidéo passe par le build : son URL porte une empreinte de contenu, donc
// une nouvelle version change d'adresse et AUCUN cache ne peut servir
// l'ancienne. C'est ce qui permet le cache long côté nginx.
import videoUrl from '@/assets/nexusrh.mp4'

const EMAIL    = PUBLISHER.demoEmail
const WHATSAPP = PUBLISHER.whatsapp
const WHATSAPP_NUM = PUBLISHER.whatsappDisplay

/** Révèle un bloc à l'entrée dans le champ de vision. Dégradé proprement là
 *  où l'API n'existe pas (tests, très vieux navigateurs) : tout est visible. */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [shown, setShown] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (shown || !ref.current) return
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { setShown(true); io.disconnect() }
    }, { rootMargin: '-60px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [shown])
  return { ref, shown }
}

function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, shown } = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className={`nx-rv ${shown ? 'nx-in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

/** Compteur qui s'anime une fois, à la première apparition. */
function Counter({ to, decimals = 0 }: { to: number; decimals?: number }) {
  const { ref, shown } = useReveal<HTMLSpanElement>()
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!shown) return
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setV(to); return }
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1100)
      setV(to * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [shown, to])
  const out = decimals
    ? v.toFixed(decimals).replace('.', ',')
    : Math.round(v).toLocaleString('fr-FR').replace(/ |,/g, ' ')
  return <span ref={ref} className="nx-fig">{out}</span>
}

function SectionHead({ eyebrow, title, lead, id, invert = false }: {
  eyebrow: string; title: string; lead?: string; id?: string; invert?: boolean
}) {
  return (
    <header id={id} className="mb-12 scroll-mt-24">
      <p className={`mb-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] ${invert ? 'text-white' : 'text-[#F04E10]'}`}>
        <span className={`h-[3px] w-8 ${invert ? 'bg-white' : 'bg-[#F04E10]'}`} />{eyebrow}
      </p>
      <h2 className={`max-w-3xl text-3xl font-bold leading-[1.08] tracking-[-0.02em] sm:text-[2.7rem] ${invert ? 'text-white' : 'text-[#0F1214]'}`}>
        {title}
      </h2>
      {lead && <p className={`mt-5 max-w-2xl text-base leading-relaxed ${invert ? 'text-white/85' : 'text-[#5A6672]'}`}>{lead}</p>}
    </header>
  )
}

function Card({ title, text, i = 0, invert = false }: { title: string; text: string; i?: number; invert?: boolean }) {
  return (
    <Reveal delay={i * 60}>
      <div className={invert
        ? 'h-full rounded-xl border border-white/25 bg-white/10 p-6 transition-all duration-300 hover:-translate-y-1 hover:bg-white/15'
        : 'h-full rounded-xl border border-[#E4E8EB] bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-[#F04E10] hover:shadow-[0_18px_40px_-26px_#F04E10]'}>
        <h3 className={`text-[15px] font-bold tracking-tight ${invert ? 'text-white' : 'text-[#0F1214]'}`}>{title}</h3>
        <p className={`mt-2.5 text-sm leading-relaxed ${invert ? 'text-white/80' : 'text-[#5A6672]'}`}>{text}</p>
      </div>
    </Reveal>
  )
}

/** Liens internes vers les pages de contenu détaillées (maillage SEO). */
function MoreLinks({ items }: { items: { to: string; label: string }[] }) {
  return (
    <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
      {items.map(l => (
        <li key={l.to}>
          <Link to={l.to} className="text-[#C43C08] underline-offset-4 hover:underline">{l.label} <span aria-hidden>→</span></Link>
        </li>
      ))}
    </ul>
  )
}

export default function HomePage() {
  const { t } = useTranslation('home')
  const navLinks = [
    { href: '#produit', label: 'nav.product' },
    { href: '#conformite', label: 'nav.compliance' },
    { href: '#modules', label: 'nav.modules' },
    { href: `#${HOME_ANCHORS.deploy}`, label: 'nav.deploy' },
    { href: '#securite', label: 'nav.security' },
    { href: `#${HOME_ANCHORS.faq}`, label: 'nav.faq' },
  ]

  const audience   = ['sme', 'group', 'public', 'agency'] as const
  const compliance = ['cnps', 'its', 'labour', 'declarations', 'ohada', 'currency'] as const
  const ai         = ['assistant', 'screening', 'interview', 'control'] as const
  const security   = ['isolation', 'rbac', 'mfa', 'crypto', 'audit', 'hosting', 'sso', 'signature'] as const
  const legalDocs  = [
    { slug: 'mentions-legales', label: t('footerNav.legalNotice') },
    { slug: 'confidentialite',  label: t('footerNav.privacy') },
    { slug: 'conditions',       label: t('footerNav.terms') },
    { slug: 'cookies',          label: t('footerNav.cookies') },
  ]

  const payslipRows = PROOF_CNPS.rows.map(r => ({
    ...r, label: t(`proof.rows.${r.key}`), note: r.note ? t(`proof.rows.${r.note}`) : null,
  }))

  const marquee = HOME_DOMAINS.flatMap(d => d.modules.map(m => t(`domains.${d.key}.modules.${m.key}.title`))).join(' · ')

  return (
    <div className="min-h-screen bg-white text-[#0F1214] antialiased">
      <style>{`
        .nx-fig { font-variant-numeric: tabular-nums }
        .nx-rv { opacity: 0; transform: translateY(18px); transition: opacity .7s cubic-bezier(.2,.7,.3,1), transform .7s cubic-bezier(.2,.7,.3,1) }
        .nx-in { opacity: 1; transform: none }
        .nx-hero { background:
          radial-gradient(52% 46% at 88% 6%, rgba(240,78,16,.10), transparent 62%),
          radial-gradient(40% 40% at 4% 96%, rgba(8,145,178,.08), transparent 64%) }
        .nx-marquee { display:flex; width:max-content; animation: nx-slide 68s linear infinite }
        @keyframes nx-slide { from { transform: none } to { transform: translateX(-50%) } }
        .nx-marquee:hover { animation-play-state: paused }
        @media (prefers-reduced-motion: reduce) {
          .nx-rv { opacity: 1; transform: none; transition: none }
          .nx-marquee { animation: none }
        }
      `}</style>

      <a href="#contenu" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[#0F1214] focus:px-4 focus:py-2 focus:text-white">
        {t('meta.skipToContent')}
      </a>

      {/* ── Barre ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-[#E4E8EB] bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
          {/* Le logo de l'éditeur ouvre l'en-tête, en pleine taille. */}
          <a href="#contenu" className="flex items-center gap-3 sm:gap-4">
            <img src="/openlab.png" alt="OpenLab Consulting" className="h-9 w-auto sm:h-11" />
            <span className="h-8 w-px bg-[#E4E8EB]" />
            <span className="text-[15px] font-bold tracking-tight sm:text-[17px]">NexusRH</span>
          </a>
          <nav className="hidden items-center gap-7 text-sm font-medium text-[#5A6672] lg:flex">
            {navLinks.map(l => (
              <a key={l.href} href={l.href} className="transition-colors hover:text-[#0F1214]">{t(l.label)}</a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {/* Sous lg, le menu se replie : <details> reste utilisable sans JavaScript (prérendu). */}
            <details className="group relative lg:hidden">
              <summary className="cursor-pointer list-none rounded-lg border-2 border-[#0F1214] px-3 py-1.5 text-sm font-bold [&::-webkit-details-marker]:hidden">
                {t('nav.menu')}
              </summary>
              <nav aria-label={t('nav.menu')} className="absolute right-0 top-full mt-2 flex w-56 flex-col rounded-lg border-2 border-[#0F1214] bg-white py-2 text-sm font-medium shadow-[6px_6px_0_0_#F04E10]">
                {navLinks.map(l => (
                  <a key={l.href} href={l.href} className="px-4 py-2 hover:bg-[#F4F6F8]">{t(l.label)}</a>
                ))}
              </nav>
            </details>
            <LanguageSwitcher />
            <Link to="/login" className="hidden rounded-lg border-2 border-[#0F1214] px-4 py-1.5 text-sm font-bold transition-colors hover:bg-[#0F1214] hover:text-white sm:inline-block">
              {t('hero.ctaApp')}
            </Link>
            <a href="#demo" className="rounded-lg bg-[#F04E10] px-4 py-2 text-sm font-bold text-white transition-all hover:bg-[#C43C08]">
              {t('nav.demo')}
            </a>
          </div>
        </div>
      </header>

      <main id="contenu">
        {/* ── Accroche ────────────────────────────────────────────────── */}
        <section className="nx-hero border-b border-[#E4E8EB]">
          <div className="mx-auto grid max-w-6xl gap-14 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:items-center lg:py-24">
            <Reveal>
              <p className="mb-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-[#F04E10]">
                <span className="h-[3px] w-8 bg-[#F04E10]" />{t('hero.eyebrow')}
              </p>
              <h1 className="text-[2.8rem] font-bold leading-[1] tracking-[-0.035em] sm:text-[4.2rem]">
                {t('hero.title')}
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#5A6672]">{t('hero.lead')}</p>
              <p className="mt-4 max-w-xl border-l-4 border-[#F04E10] pl-4 text-sm font-semibold leading-relaxed text-[#0F1214]">{t('hero.reference')}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <a href="#demo" className="rounded-lg bg-[#F04E10] px-7 py-4 text-sm font-bold text-white transition-all hover:bg-[#C43C08] hover:shadow-[0_14px_30px_-12px_#F04E10]">
                  {t('hero.ctaDemo')}
                </a>
                <Link to="/login" className="rounded-lg border-2 border-[#0F1214] px-7 py-4 text-sm font-bold transition-colors hover:bg-[#0F1214] hover:text-white">
                  {t('hero.ctaApp')}
                </Link>
              </div>
              <div className="mt-10 flex items-center gap-4 border-t border-[#E4E8EB] pt-6">
                <img src="/openlab.png" alt="OpenLab Consulting" className="h-10 w-auto" />
                <p className="font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-[#8A97A3]">{t('hero.editor')}</p>
              </div>
            </Reveal>

            <Reveal delay={120}>
              <figure id="produit" className="scroll-mt-24 overflow-hidden rounded-xl border-2 border-[#0F1214] bg-white shadow-[10px_10px_0_0_#F04E10]">
                <figcaption className="flex items-center justify-between border-b border-[#E4E8EB] px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em]">
                  <span className="font-bold text-[#F04E10]">{t('video.label')}</span>
                  <span className="text-[#8A97A3]">NEXUSRH</span>
                </figcaption>
                <video controls preload="metadata" playsInline className="block aspect-video w-full bg-black" title={t('video.docTitle')}>
                  <source src={videoUrl} type="video/mp4" />
                  {t('video.unsupported')}
                </video>
                <p className="border-t border-[#E4E8EB] px-4 py-3 text-xs leading-relaxed text-[#5A6672]">{t('video.caption')}</p>
              </figure>
            </Reveal>
          </div>

          {/* Quatre chiffres qui disent le produit mieux qu'un argumentaire. */}
          <div className="mx-auto grid max-w-6xl gap-px overflow-hidden border-t border-[#E4E8EB] bg-[#E4E8EB] sm:grid-cols-2 lg:grid-cols-4">
            {[
              { v: <Counter to={2} />,                        l: t('compliance.cnps.title'), s: t('proof.title') },
              { v: <><Counter to={6.3} decimals={1} /> %</>,  l: 'CNPS',                     s: t('proof.rows.retirement') },
              { v: <Counter to={PROOF_CNPS.retirementCeiling} />, l: 'FCFA',                     s: t('proof.rows.retirementNote') },
              { v: <Counter to={CATALOG_MODULE_COUNT} />,     l: t('stats.modulesLabel'),    s: t('stats.modulesText') },
            ].map((k, i) => (
              <div key={i} className="bg-white px-6 py-7">
                <p className="font-mono text-2xl font-bold text-[#0891B2] sm:text-3xl">{k.v}</p>
                <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#F04E10]">{k.l}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-[#8A97A3]">{k.s}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Signature : le double plafond ───────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <SectionHead eyebrow={t('proof.eyebrow')} title={t('proof.title')} lead={t('proof.lead')} />
          <Reveal>
            <div className="overflow-hidden rounded-xl border-2 border-[#0F1214] bg-white">
              <p className="border-b border-[#E4E8EB] bg-[#FFF3EE] px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#C43C08]">
                {t('proof.case')}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-[#E4E8EB] text-left font-mono text-[10px] uppercase tracking-[0.14em] text-[#8A97A3]">
                      <th scope="col" className="px-5 py-3 font-normal">{t('proof.table.code')}</th>
                      <th scope="col" className="px-5 py-3 font-normal">{t('proof.table.label')}</th>
                      <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.base')}</th>
                      <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.rate')}</th>
                      <th scope="col" className="px-5 py-3 text-right font-normal">{t('proof.table.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslipRows.map(r => (
                      <tr key={r.code} className="border-b border-[#EDF0F2] align-top transition-colors last:border-0 hover:bg-[#FAFBFC]">
                        <td className="nx-fig px-5 py-4 font-mono text-xs font-bold text-[#F04E10]">{r.code}</td>
                        <td className="px-5 py-4">
                          <span className="font-semibold">{r.label}</span>
                          {r.note && <span className="mt-1 block font-mono text-[11px] text-[#8A97A3]">{r.note}</span>}
                        </td>
                        <td className="nx-fig px-5 py-4 text-right font-mono font-semibold text-[#0891B2]">{r.base}</td>
                        <td className="nx-fig px-5 py-4 text-right font-mono text-[#5A6672]">{r.rate}</td>
                        <td className="nx-fig px-5 py-4 text-right font-mono font-bold">{r.amount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-6 max-w-2xl border-l-4 border-[#F04E10] pl-5 text-sm leading-relaxed text-[#5A6672]">{t('proof.note')}</p>
          </Reveal>
        </section>

        {/* ── Publics ─────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHead eyebrow={t('audience.eyebrow')} title={t('audience.title')} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {audience.map((k, i) => <Card key={k} i={i} title={t(`audience.${k}.title`)} text={t(`audience.${k}.text`)} />)}
          </div>
        </section>

        {/* ── Conformité ──────────────────────────────────────────────── */}
        <section className="border-y border-[#E4E8EB] bg-[#F7F8F9]">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead id="conformite" eyebrow={t('compliance.eyebrow')} title={t('compliance.title')} lead={t('compliance.lead')} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {compliance.map((k, i) => <Card key={k} i={i} title={t(`compliance.${k}.title`)} text={t(`compliance.${k}.text`)} />)}
            </div>
            <MoreLinks items={[
              { to: '/logiciel-paie-cote-divoire', label: t('links.payroll') },
              { to: '/guides/calcul-its-2024-cote-divoire', label: t('links.its') },
              { to: '/guides/cotisations-cnps-2024', label: t('links.cnps') },
            ]} />
          </div>
        </section>

        {/* ── Bandeau défilant : l'ampleur de la couverture ───────────── */}
        <div className="overflow-hidden border-b border-[#E4E8EB] py-4" aria-hidden>
          <div className="nx-marquee gap-10 font-mono text-[11px] uppercase tracking-[0.18em] text-[#5A6672]">
            <span>{marquee}</span><span>{marquee}</span>
          </div>
        </div>

        {/* ── Fonctionnalités : six domaines ─────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <SectionHead id={HOME_ANCHORS.modules} eyebrow={t('modules.eyebrow')} title={t('modules.title')} lead={t('modules.lead')} />
          <div className="space-y-12">
            {HOME_DOMAINS.map((d, i) => (
              <div key={d.key} data-domain={d.key} className="border-t-2 border-[#0F1214] pt-6">
                <h3 className="mb-5 flex items-baseline gap-3 text-xl font-bold tracking-tight">
                  <span className="font-mono text-[11px] text-[#F04E10]">{String(i + 1).padStart(2, '0')}</span>
                  {t(`domains.${d.key}.title`)}
                </h3>
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {d.modules.map((m, j) => (
                    <li key={m.key} data-module={m.key}>
                      <Reveal delay={j * 40} className="h-full">
                        <div className="h-full rounded-xl border border-[#E4E8EB] bg-white p-5 transition-all duration-300 hover:-translate-y-1 hover:border-[#F04E10]">
                          <h4 className="text-[15px] font-bold tracking-tight">{t(`domains.${d.key}.modules.${m.key}.title`)}</h4>
                          <p className="mt-2 text-sm leading-relaxed text-[#5A6672]">{t(`domains.${d.key}.modules.${m.key}.text`)}</p>
                        </div>
                      </Reveal>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Deux modes de déploiement ───────────────────────────────── */}
        <section className="border-y border-[#E4E8EB] bg-[#F7F8F9]">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead id={HOME_ANCHORS.deploy} eyebrow={t('deploy.eyebrow')} title={t('deploy.title')} lead={t('deploy.lead')} />
            <div className="grid gap-4 md:grid-cols-2">
              {(['saas', 'onprem'] as const).map(mode => (
                <div key={mode} data-deploy={mode} className="rounded-xl border-2 border-[#0F1214] bg-white p-6">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#F04E10]">{t(`deploy.${mode}.tag`)}</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight">{t(`deploy.${mode}.title`)}</h3>
                  <ul className="mt-4 space-y-2.5">
                    {DEPLOY_POINTS[mode].map(p => (
                      <li key={p} className="flex gap-3 text-sm leading-relaxed text-[#3F4B56]">
                        <span aria-hidden className="mt-[0.55em] h-1.5 w-1.5 shrink-0 bg-[#F04E10]" />
                        <span>{t(`deploy.${mode}.${p}`)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-8 overflow-x-auto rounded-xl border border-[#E4E8EB] bg-white">
              <table className="w-full min-w-[36rem] text-sm">
                <caption className="border-b border-[#E4E8EB] px-5 py-3 text-left font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[#5A6672]">
                  {t('deploy.table.caption')}
                </caption>
                <thead>
                  <tr className="border-b border-[#E4E8EB] text-left">
                    <th scope="col" className="px-5 py-3 font-semibold">{t('deploy.table.criterion')}</th>
                    <th scope="col" className="px-5 py-3 font-semibold">{t('deploy.table.saas')}</th>
                    <th scope="col" className="px-5 py-3 font-semibold">{t('deploy.table.onprem')}</th>
                  </tr>
                </thead>
                <tbody>
                  {DEPLOY_ROWS.map(r => (
                    <tr key={r} className="border-b border-[#EDF0F2] align-top last:border-0">
                      <th scope="row" className="px-5 py-3 text-left font-semibold">{t(`deploy.rows.${r}.label`)}</th>
                      <td className="px-5 py-3 text-[#3F4B56]">{t(`deploy.rows.${r}.saas`)}</td>
                      <td className="px-5 py-3 text-[#3F4B56]">{t(`deploy.rows.${r}.onprem`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-6">
              <a href={`#${HOME_ANCHORS.demo}`} className="rounded-lg bg-[#F04E10] px-7 py-4 text-sm font-bold text-white transition-all hover:bg-[#C43C08]">
                {t('deploy.cta')}
              </a>
              <Link to="/sirh-saas-ou-on-premise" className="text-sm font-semibold text-[#C43C08] underline-offset-4 hover:underline">
                {t('deploy.more')} <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>

        {/* ── Versement + groupes ─────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHead eyebrow={t('pay.eyebrow')} title={t('pay.title')} lead={t('pay.lead')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title={t('pay.mobile.title')} text={t('pay.mobile.text')} />
            <Card title={t('pay.bank.title')} text={t('pay.bank.text')} i={1} />
          </div>
          <MoreLinks items={[{ to: '/paiement-salaires-mobile-money', label: t('links.mobileMoney') }]} />
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHead eyebrow={t('multi.eyebrow')} title={t('multi.title')} lead={t('multi.lead')} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title={t('multi.entities.title')} text={t('multi.entities.text')} />
            <Card title={t('multi.packs.title')} text={t('multi.packs.text')} i={1} />
            <Card title={t('multi.consolidation.title')} text={t('multi.consolidation.text')} i={2} />
          </div>
          <MoreLinks items={[{ to: '/sirh-afrique-ouest', label: t('links.westAfrica') }]} />
        </section>

        {/* ── IA ──────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <SectionHead eyebrow={t('ai.eyebrow')} title={t('ai.title')} lead={t('ai.lead')} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ai.map((k, i) => <Card key={k} i={i} title={t(`ai.${k}.title`)} text={t(`ai.${k}.text`)} />)}
          </div>
        </section>

        {/* ── Sécurité : le seul renversement de la page ──────────────── */}
        <section className="bg-[#F04E10]">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <SectionHead invert id="securite" eyebrow={t('security.eyebrow')} title={t('security.title')} lead={t('security.lead')} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {security.map((k, i) => <Card invert key={k} i={i} title={t(`security.${k}.title`)} text={t(`security.${k}.text`)} />)}
            </div>
          </div>
        </section>

        {/* ── Confiance : éditeur, données, documents publics ─────────── */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <SectionHead id={HOME_ANCHORS.trust} eyebrow={t('trust.eyebrow')} title={t('trust.title')} lead={t('trust.lead')} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border-2 border-[#0F1214] p-6 lg:row-span-2">
              <h3 className="text-[15px] font-bold tracking-tight">{t('trust.publisher.title')}</h3>
              <p className="mt-1 text-lg font-bold">{t('trust.publisher.name')}</p>
              <p className="mt-2 text-sm leading-relaxed text-[#5A6672]">{t('trust.publisher.text')}</p>
              <dl className="mt-5 space-y-3 text-sm">
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.address')}</dt>
                  <dd className="text-[#3F4B56]">{t('contact.address')}</dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.phones')}</dt>
                  <dd className="nx-fig text-[#3F4B56]">
                    {PHONES.map((ph, i) => (
                      <span key={ph.e164}>
                        {i > 0 && ' · '}
                        <a href={`tel:${ph.e164}`} className="hover:text-[#F04E10]">{ph.display}</a>
                      </span>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.emails')}</dt>
                  <dd className="break-all text-[#3F4B56]">
                    <a href={`mailto:${PUBLISHER.infoEmail}`} className="hover:text-[#F04E10]">{PUBLISHER.infoEmail}</a>
                    {' · '}
                    <a href={`mailto:${PUBLISHER.supportEmail}`} className="hover:text-[#F04E10]">{PUBLISHER.supportEmail}</a>
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.whatsapp')}</dt>
                  <dd><a href={WHATSAPP} target="_blank" rel="noreferrer noopener" className="nx-fig text-[#3F4B56] hover:text-[#F04E10]">{WHATSAPP_NUM}</a></dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.hours')}</dt>
                  <dd className="text-[#3F4B56]">{t('trust.supportHours')}</dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.web')}</dt>
                  <dd><a href={PUBLISHER.url} target="_blank" rel="noreferrer noopener" className="text-[#3F4B56] hover:text-[#F04E10]">www.openlabconsulting.com</a></dd>
                </div>
              </dl>
            </div>
            <Card title={t('trust.data.title')} text={t('trust.data.text')} />
            <Card title={t('trust.compliance.title')} text={t('trust.compliance.text')} i={1} />
            <div className="rounded-xl border border-[#E4E8EB] bg-white p-6 lg:col-span-2">
              <h3 className="text-[15px] font-bold tracking-tight">{t('trust.legalTitle')}</h3>
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                {legalDocs.map(l => (
                  <li key={l.slug}><Link to={`/legal/${l.slug}`} className="text-[#C43C08] underline-offset-4 hover:underline">{l.label}</Link></li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── FAQ visible (publiée aussi en FAQPage dans le JSON-LD) ──── */}
        <section className="border-y border-[#E4E8EB] bg-[#F7F8F9]">
          <div className="mx-auto max-w-4xl px-6 py-20">
            <SectionHead id={HOME_ANCHORS.faq} eyebrow={t('faq.eyebrow')} title={t('faq.title')} />
            <div className="divide-y divide-[#E4E8EB] border-y border-[#E4E8EB] bg-white">
              {HOME_FAQ.map(k => (
                <div key={k} data-faq={k} className="px-5 py-5">
                  <h3 className="text-[15px] font-bold">{t(`faq.items.${k}.q`)}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-[#3F4B56]">{t(`faq.items.${k}.a`)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Demande de démo ─────────────────────────────────────────── */}
        <section id="demo" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
            <div>
              <SectionHead eyebrow={t('contact.eyebrow')} title={t('form.title')} lead={t('form.lead')} />
              <dl className="space-y-5 border-t-2 border-[#0F1214] pt-6">
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('contact.emailLabel')}</dt>
                  <dd><a href={`mailto:${EMAIL}`} className="text-[15px] font-bold text-[#F04E10] underline-offset-4 hover:underline">{EMAIL}</a></dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('contact.whatsappLabel')}</dt>
                  <dd><a href={WHATSAPP} target="_blank" rel="noreferrer noopener" className="nx-fig text-[15px] font-bold underline-offset-4 hover:underline">{WHATSAPP_NUM}</a></dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('trust.labels.phones')}</dt>
                  {PHONES.map(ph => (
                    <dd key={ph.e164}><a href={`tel:${ph.e164}`} className="nx-fig text-[15px] font-bold underline-offset-4 hover:underline">{ph.display}</a></dd>
                  ))}
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('contact.addressLabel')}</dt>
                  <dd className="text-sm leading-relaxed text-[#5A6672]">{t('contact.address')}</dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A97A3]">{t('contact.hoursLabel')}</dt>
                  <dd className="text-sm leading-relaxed text-[#5A6672]">{t('contact.hours')}</dd>
                </div>
              </dl>
            </div>
            <Reveal delay={80}><DemoForm /></Reveal>
          </div>
        </section>
      </main>

      {/* ── Pied de page ────────────────────────────────────────────── */}
      <footer className="border-t-2 border-[#0F1214] bg-[#F7F8F9]">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <div className="flex items-center gap-2.5">
                <img src="/logo.svg" alt="" className="h-7 w-7" />
                <span className="text-[15px] font-bold tracking-tight">NexusRH</span>
              </div>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-[#5A6672]">{t('footer.tagline')}</p>
              <img src="/openlab.png" alt="OpenLab Consulting" className="mt-6 h-10 w-auto" />
            </div>

            <nav aria-label={t('footerNav.product')}>
              <p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#0F1214]">{t('footerNav.product')}</p>
              <ul className="space-y-2.5 text-sm text-[#5A6672]">
                <li><a href="#produit" className="transition-colors hover:text-[#F04E10]">{t('footerNav.overview')}</a></li>
                <li><a href="#modules" className="transition-colors hover:text-[#F04E10]">{t('footerNav.modulesLink')}</a></li>
                <li><a href="#conformite" className="transition-colors hover:text-[#F04E10]">{t('footerNav.complianceLink')}</a></li>
                <li><a href="#securite" className="transition-colors hover:text-[#F04E10]">{t('footerNav.securityLink')}</a></li>
                <li><a href={`#${HOME_ANCHORS.deploy}`} className="transition-colors hover:text-[#F04E10]">{t('footerNav.deployLink')}</a></li>
                <li><a href={`#${HOME_ANCHORS.trust}`} className="transition-colors hover:text-[#F04E10]">{t('footerNav.trustLink')}</a></li>
                <li><a href={`#${HOME_ANCHORS.faq}`} className="transition-colors hover:text-[#F04E10]">{t('footerNav.faqLink')}</a></li>
                <li><Link to="/login" className="transition-colors hover:text-[#F04E10]">{t('footerNav.signIn')}</Link></li>
              </ul>
            </nav>

            <nav aria-label={t('footerNav.resources')}>
              <p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#0F1214]">{t('footerNav.resources')}</p>
              <ul className="space-y-2.5 text-sm text-[#5A6672]">
                <li><Link to="/logiciel-paie-cote-divoire" className="transition-colors hover:text-[#F04E10]">{t('footerNav.payrollCi')}</Link></li>
                <li><Link to="/gestion-conges-cote-divoire" className="transition-colors hover:text-[#F04E10]">{t('footerNav.leaveCi')}</Link></li>
                <li><Link to="/paiement-salaires-mobile-money" className="transition-colors hover:text-[#F04E10]">{t('footerNav.mobileMoney')}</Link></li>
                <li><Link to="/sirh-afrique-ouest" className="transition-colors hover:text-[#F04E10]">{t('footerNav.westAfrica')}</Link></li>
                <li><Link to="/sirh-saas-ou-on-premise" className="transition-colors hover:text-[#F04E10]">{t('footerNav.deployLink')}</Link></li>
                <li><Link to="/guides/calcul-its-2024-cote-divoire" className="transition-colors hover:text-[#F04E10]">{t('footerNav.guideIts')}</Link></li>
                <li><Link to="/guides/cotisations-cnps-2024" className="transition-colors hover:text-[#F04E10]">{t('footerNav.guideCnps')}</Link></li>
              </ul>
            </nav>

            <nav aria-label={t('footerNav.legal')}>
              <p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#0F1214]">{t('footerNav.legal')}</p>
              <ul className="space-y-2.5 text-sm text-[#5A6672]">
                <li><Link to="/legal/mentions-legales" className="transition-colors hover:text-[#F04E10]">{t('footerNav.legalNotice')}</Link></li>
                <li><Link to="/legal/confidentialite" className="transition-colors hover:text-[#F04E10]">{t('footerNav.privacy')}</Link></li>
                <li><Link to="/legal/conditions" className="transition-colors hover:text-[#F04E10]">{t('footerNav.terms')}</Link></li>
                <li><Link to="/legal/cookies" className="transition-colors hover:text-[#F04E10]">{t('footerNav.cookies')}</Link></li>
              </ul>
            </nav>

            <div>
              <p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#0F1214]">{t('footerNav.contact')}</p>
              <ul className="space-y-2.5 text-sm text-[#5A6672]">
                <li><a href={`mailto:${EMAIL}`} className="break-all transition-colors hover:text-[#F04E10]">{EMAIL}</a></li>
                {PHONES.map(ph => (
                  <li key={ph.e164}><a href={`tel:${ph.e164}`} className="nx-fig transition-colors hover:text-[#F04E10]">{ph.display}</a></li>
                ))}
                <li><a href={WHATSAPP} target="_blank" rel="noreferrer noopener" className="nx-fig transition-colors hover:text-[#F04E10]">WhatsApp {WHATSAPP_NUM}</a></li>
                <li className="pt-1 text-xs leading-relaxed text-[#8A97A3]">{t('contact.address')}</li>
              </ul>
            </div>
          </div>

          <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-[#E4E8EB] pt-6 text-xs text-[#8A97A3]">
            <p>© {new Date().getFullYear()} {t('footer.editor')} — {t('footer.rights')}</p>
            <p className="font-mono uppercase tracking-[0.16em]">Abidjan · Côte d'Ivoire</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
