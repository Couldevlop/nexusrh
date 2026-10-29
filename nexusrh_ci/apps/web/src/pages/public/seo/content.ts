import type { SeoPageContent } from './types'
import { SEO_PATHS, type SeoPath } from './paths'
import { GUIDE_CNPS, GUIDE_ITS, LEAVE_CI, MOBILE_MONEY, PAYROLL_CI } from './content-ci'
import { BENIN, BURKINA, SENEGAL, WEST_AFRICA, WEST_AFRICA_EN } from './content-west-africa'

const ALL: SeoPageContent[] = [
  PAYROLL_CI, LEAVE_CI, MOBILE_MONEY, WEST_AFRICA, SENEGAL, BURKINA, BENIN, GUIDE_ITS, GUIDE_CNPS, WEST_AFRICA_EN,
]

/** Pages de contenu, dans l'ordre de SEO_PATHS. */
export const SEO_PAGES: SeoPageContent[] = SEO_PATHS.map((p) => {
  const page = ALL.find((x) => x.path === p)
  if (!page) throw new Error(`Contenu manquant pour ${p}`)
  return page
})

export function getSeoPage(path: string): SeoPageContent | undefined {
  return SEO_PAGES.find((p) => p.path === (path as SeoPath))
}
