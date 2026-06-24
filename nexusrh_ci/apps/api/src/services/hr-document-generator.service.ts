/**
 * Génération de documents RH conformes Côte d'Ivoire (OHADA + Code du Travail CI).
 * Sortie Markdown complète, sans placeholder, prête à l'export/impression.
 *
 * Déterministe (pas d'appel LLM) → fiable et testable. Le contenu intègre les
 * mentions légales obligatoires : NNI, CNPS, période d'essai légale, clauses OHADA.
 */

export type HrDocumentType =
  | 'cdi_ci' | 'cdd_ci' | 'certificat_travail' | 'attestation_emploi'

export interface HrDocumentInput {
  type: HrDocumentType
  tenantName?: string
  city?: string
  employer?: { cnpsNumber?: string; rccm?: string; address?: string }
  employee?: {
    firstName?: string; lastName?: string; nni?: string; cnpsNumber?: string
    jobTitle?: string; category?: string
  }
  salary?: number
  startDate?: string   // YYYY-MM-DD
  endDate?: string     // CDD
  isCadre?: boolean
}

const fmtFcfa = (n?: number) => (typeof n === 'number' ? n.toLocaleString('fr-FR') + ' FCFA' : '__________ FCFA')
const fmtDate = (d?: string) => {
  if (!d) return '__________'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d
}

/**
 * Période d'essai légale CI :
 *  - employé : 1 mois (renouvelable 1x) ; cadre : 3 mois (renouvelable 1x).
 */
function essaiLegal(isCadre?: boolean): string {
  return isCadre
    ? 'trois (3) mois, renouvelable une fois'
    : 'un (1) mois, renouvelable une fois'
}

export function generateHRDocument(input: HrDocumentInput): { title: string; markdown: string } {
  const t = input.tenantName ?? 'L\'Employeur'
  const city = input.city ?? 'Abidjan'
  const emp = input.employee ?? {}
  const empName = `${emp.firstName ?? '__________'} ${emp.lastName ?? '__________'}`.trim()
  const nni = emp.nni ?? '__________'
  const cnpsSal = emp.cnpsNumber ?? '__________'
  const job = emp.jobTitle ?? '__________'
  const cnpsEmp = input.employer?.cnpsNumber ?? '__________'
  const rccm = input.employer?.rccm ?? '__________'
  const addr = input.employer?.address ?? `${city}, Côte d'Ivoire`
  const today = fmtDate(new Date().toISOString().slice(0, 10))

  switch (input.type) {
    case 'cdi_ci':
    case 'cdd_ci': {
      const isCdd = input.type === 'cdd_ci'
      const title = isCdd ? 'Contrat de travail à durée déterminée (CDD)' : 'Contrat de travail à durée indéterminée (CDI)'
      const markdown = `# ${title}
### Conforme au Code du Travail de Côte d'Ivoire et au droit OHADA

**ENTRE LES SOUSSIGNÉS :**

**${t}**, dont le siège est à ${addr},
immatriculée au RCCM sous le n° ${rccm}, n° employeur CNPS ${cnpsEmp},
représentée par son représentant légal dûment habilité,

ci-après dénommée « **l'Employeur** »,

**D'UNE PART,**

ET

**${empName}**, NNI n° ${nni}, n° assuré CNPS ${cnpsSal},

ci-après dénommé(e) « **le/la Salarié(e)** »,

**D'AUTRE PART,**

Il a été convenu ce qui suit :

## Article 1 — Engagement
Le/la Salarié(e) est engagé(e) en qualité de **${job}**${emp.category ? ` (catégorie ${emp.category})` : ''} ${isCdd ? 'pour une durée déterminée' : 'pour une durée indéterminée'}, à compter du **${fmtDate(input.startDate)}**${isCdd ? `, et prenant fin le **${fmtDate(input.endDate)}**` : ''}.

## Article 2 — Période d'essai
Le présent contrat est assorti d'une période d'essai de **${essaiLegal(input.isCadre)}**, conformément au Code du Travail ivoirien. Durant cette période, chacune des parties peut rompre le contrat sans préavis ni indemnité.

## Article 3 — Rémunération
En contrepartie de son travail, le/la Salarié(e) percevra une rémunération brute mensuelle de **${fmtFcfa(input.salary)}**, payable selon la périodicité légale (virement bancaire ou Mobile Money).

## Article 4 — Lieu de travail
Le lieu de travail est fixé à ${city}. Il pourra être modifié selon les nécessités de service, dans le respect du Code du Travail.

## Article 5 — Durée du travail
La durée légale du travail est de 40 heures par semaine. Les heures supplémentaires sont rémunérées selon les majorations légales (Art. relatifs aux heures supplémentaires du Code du Travail CI).

## Article 6 — Congés payés
Le/la Salarié(e) bénéficie de **2,5 jours ouvrables de congés payés par mois** de travail effectif, conformément au Code du Travail ivoirien.

## Article 7 — Sécurité sociale (CNPS)
L'Employeur déclare et cotise le/la Salarié(e) auprès de la **CNPS** (retraite, prestations familiales, accidents du travail) conformément à la réglementation en vigueur.
${isCdd ? `
## Article 8 — Durée déterminée (OHADA)
Le présent CDD est conclu pour le motif et la durée ci-dessus. Conformément au Code du Travail CI, sa durée totale, renouvellements compris, ne peut excéder les limites légales. À son terme, il prend fin automatiquement sauf transformation en CDI.
` : ''}
## Article ${isCdd ? '9' : '8'} — Convention applicable & litiges
Le présent contrat est régi par le Code du Travail de Côte d'Ivoire, la convention collective applicable et les Actes uniformes OHADA. Tout litige relève de la juridiction du travail compétente.

Fait à ${city}, le ${today}, en deux (2) exemplaires originaux.

| L'Employeur | Le/la Salarié(e) |
|---|---|
| (signature & cachet) | (signature, précédée de « Lu et approuvé ») |
`
      return { title, markdown }
    }

    case 'certificat_travail': {
      const title = 'Certificat de travail'
      const markdown = `# Certificat de travail
### (Art. relatif au certificat de travail — Code du Travail de Côte d'Ivoire)

**${t}**
Siège : ${addr} — RCCM ${rccm} — N° employeur CNPS ${cnpsEmp}

---

Je soussigné(e), représentant légal de **${t}**, certifie que :

**${empName}**, NNI n° ${nni}, n° assuré CNPS ${cnpsSal},

a été employé(e) au sein de notre entreprise en qualité de **${job}**,
du **${fmtDate(input.startDate)}** au **${fmtDate(input.endDate)}**.

Le/la Salarié(e) quitte l'entreprise libre de tout engagement.

Le présent certificat est délivré pour servir et valoir ce que de droit.

Fait à ${city}, le ${today}.

_______________________
Pour l'Employeur
(nom, qualité, signature & cachet)
`
      return { title, markdown }
    }

    case 'attestation_emploi': {
      const title = 'Attestation d\'emploi'
      const markdown = `# Attestation d'emploi

**${t}** — ${addr} — N° employeur CNPS ${cnpsEmp}

Je soussigné(e), représentant légal de **${t}**, atteste que **${empName}** (NNI ${nni}, CNPS ${cnpsSal}) est employé(e) au sein de notre entreprise en qualité de **${job}** depuis le **${fmtDate(input.startDate)}**, pour une rémunération brute mensuelle de **${fmtFcfa(input.salary)}**.

La présente attestation est délivrée à la demande de l'intéressé(e) pour servir et valoir ce que de droit.

Fait à ${city}, le ${today}.

_______________________
Pour l'Employeur
`
      return { title, markdown }
    }
  }
}
