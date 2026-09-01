import type { ReportData } from './types.js'
import type { Analysis, Slice } from './analyze.js'

/**
 * Corps du mail.
 *
 * Contraintes des clients mail : pas de JavaScript, pas de SVG, feuilles de
 * style externes ignorees. Tout est donc en tableaux et styles en ligne, et les
 * « barres » sont des cellules de largeur proportionnelle — les vrais
 * graphiques sont dans le PDF joint.
 *
 * TOUTE valeur venant de la base passe par escapeHtml : les noms d'entreprises
 * et de cabinets sont saisis par des utilisateurs, et sans echappement on
 * ouvrirait une injection HTML dans la boite du destinataire.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const CSS_TABLE = 'width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 18px'
const CSS_TH = 'text-align:left;padding:6px 8px;background:#0f2a44;color:#fff;font-weight:600'
const CSS_TD = 'padding:6px 8px;border-bottom:1px solid #e2e8f0'

function bars(slices: Slice[]): string {
  if (slices.length === 0) return '<p style="color:#64748b">Aucune donnée sur la période.</p>'
  const max = Math.max(...slices.map((s) => s.value), 1)
  return `<table style="${CSS_TABLE}">` + slices.map((s) => `
    <tr>
      <td style="${CSS_TD};width:180px">${escapeHtml(s.label)}</td>
      <td style="${CSS_TD}">
        <span style="display:inline-block;height:12px;width:${Math.round(200 * s.value / max)}px;background:#E85D04"></span>
        <strong style="margin-left:6px">${s.value}</strong>
      </td>
    </tr>`).join('') + '</table>'
}

/** Date lisible, ou un tiret quand il n'y a jamais eu de connexion. */
function dateCourte(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '—'
}

/** Variation signée, pour que « +3 » et « -3 » ne se lisent pas pareil. */
function signe(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

export function renderHtml(data: ReportData, a: Analysis): string {
  const t = a.totals
  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'

  const entreprises = data.tenants.length === 0
    ? '<p style="color:#64748b">Aucune entreprise dans le parc.</p>'
    : `<table style="${CSS_TABLE}">
        <tr><th style="${CSS_TH}">Entreprise</th><th style="${CSS_TH}">Effectif</th>
            <th style="${CSS_TH}">Arrivées</th><th style="${CSS_TH}">Départs</th>
            <th style="${CSS_TH}">Connectés</th><th style="${CSS_TH}">Dernière connexion</th>
            <th style="${CSS_TH}">Activité</th></tr>
        ${data.tenants.map((x) => `
        <tr><td style="${CSS_TD}">${escapeHtml(x.name)}${x.collected ? '' : ' <em style="color:#b91c1c">(indisponible)</em>'}</td>
            <td style="${CSS_TD}">${x.headcount}</td>
            <td style="${CSS_TD}">${x.hires}</td>
            <td style="${CSS_TD}">${x.departures}</td>
            <td style="${CSS_TD}">${x.usersLoggedIn}/${x.activeUsers}</td>
            <td style="${CSS_TD}">${dateCourte(x.lastLoginAt)}</td>
            <td style="${CSS_TD}">${x.auditWrites}</td></tr>`).join('')}
       </table>`

  const cabinets = data.agencies.length === 0
    ? '<p style="color:#64748b">Aucun cabinet enregistré.</p>'
    : `<table style="${CSS_TABLE}">
        <tr><th style="${CSS_TH}">Cabinet</th><th style="${CSS_TH}">Entreprises</th>
            <th style="${CSS_TH}">Effectif cumulé</th><th style="${CSS_TH}">Rattachées</th>
            <th style="${CSS_TH}">Détachées</th></tr>
        ${data.agencies.map((c) => `
        <tr><td style="${CSS_TD}">${escapeHtml(c.name)}</td>
            <td style="${CSS_TD}">${c.managedTenants}</td>
            <td style="${CSS_TD}">${c.headcount}</td>
            <td style="${CSS_TD}">${c.attached}</td>
            <td style="${CSS_TD}">${c.detached}</td></tr>`).join('')}
       </table>`

  const alertes = a.alerts.length === 0
    ? '<p style="color:#15803d">Aucun point d\'attention sur la période.</p>'
    : `<ul>${a.alerts.map((x) => `<li><strong>${escapeHtml(x.tenant)}</strong> — ${escapeHtml(x.detail)}</li>`).join('')}</ul>`

  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:820px">
  <h1 style="color:#0f2a44;font-size:20px">${titre} — ${escapeHtml(data.period.label)}</h1>
  <p style="color:#64748b">NexusRH CI · OpenLab Consulting · le détail complet et les graphiques sont dans le PDF joint.</p>

  <h2 style="font-size:16px">Vue plateforme</h2>
  <table style="${CSS_TABLE}">
    <tr><td style="${CSS_TD}">Entreprises</td><td style="${CSS_TD}"><strong>${t.tenants}</strong> — ${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues</td></tr>
    <tr><td style="${CSS_TD}">Nouvelles sur la période</td><td style="${CSS_TD}"><strong>${t.newTenants}</strong></td></tr>
    <tr><td style="${CSS_TD}">Effectif consolidé</td><td style="${CSS_TD}"><strong>${t.headcount}</strong> — variation ${signe(t.headcountChange)} (${t.hires} arrivées, ${t.departures} départs)</td></tr>
    <tr><td style="${CSS_TD}">Connexions réussies</td><td style="${CSS_TD}"><strong>${t.loginSuccess}</strong></td></tr>
    <tr><td style="${CSS_TD}">Volume d'activité</td><td style="${CSS_TD}"><strong>${t.auditWrites}</strong> écritures d'audit</td></tr>
  </table>

  <h2 style="font-size:16px">Échecs de connexion, ensemble de la plateforme</h2>
  <p style="color:#64748b;font-size:12px">Ces échecs ne sont PAS attribuables à une entreprise : au moment d'un échec
  d'identifiants, l'utilisateur n'est pas identifié, donc son entreprise non plus. Ils sont journalisés au niveau de la
  plateforme et présentés ici comme un total.</p>
  <table style="${CSS_TABLE}">
    <tr><td style="${CSS_TD}">Échecs d'identifiants</td><td style="${CSS_TD}"><strong>${t.loginFailed}</strong></td></tr>
    <tr><td style="${CSS_TD}">Verrouillages de compte</td><td style="${CSS_TD}"><strong>${t.loginLocked}</strong></td></tr>
    <tr><td style="${CSS_TD}">Refus « entreprise hors ligne » (par entreprise)</td><td style="${CSS_TD}"><strong>${t.blockedOffline}</strong></td></tr>
  </table>

  <h2 style="font-size:16px">Cabinets</h2>
  ${cabinets}

  <h2 style="font-size:16px">Entreprises</h2>
  ${entreprises}

  <h2 style="font-size:16px">Arrivées par type de contrat</h2>
  ${bars(a.byContract)}

  <h2 style="font-size:16px">Connexions réussies par jour</h2>
  ${bars(a.loginsByDay)}

  <h2 style="font-size:16px">Points d\'attention</h2>
  ${alertes}
</div>`
}

/**
 * Version texte du corps du mail.
 *
 * Nodemailer n'envoyait que la partie HTML : un client configuré en texte
 * seul recevait donc un message VIDE. La partie texte reprend l'essentiel,
 * sans balise ni échappement HTML (rien n'y est interprété).
 */
export function renderText(data: ReportData, a: Analysis): string {
  const t = a.totals
  const titre = data.period.type === 'weekly' ? 'Rapport hebdomadaire' : 'Rapport mensuel'
  const lignes: string[] = [
    `${titre} — ${data.period.label}`,
    'NexusRH CI · OpenLab Consulting — le détail complet et les graphiques sont dans le PDF joint.',
    '',
    'VUE PLATEFORME',
    `- Entreprises : ${t.tenants} (${t.active} actives, ${t.trial} en essai, ${t.suspended} suspendues)`,
    `- Nouvelles sur la période : ${t.newTenants}`,
    `- Effectif consolidé : ${t.headcount} — variation ${signe(t.headcountChange)} (${t.hires} arrivées, ${t.departures} départs)`,
    `- Connexions réussies : ${t.loginSuccess}`,
    `- Volume d'activité : ${t.auditWrites} écritures d'audit`,
    '',
    'ÉCHECS DE CONNEXION, ENSEMBLE DE LA PLATEFORME (non attribuables à une entreprise)',
    `- Échecs d'identifiants : ${t.loginFailed}`,
    `- Verrouillages de compte : ${t.loginLocked}`,
    `- Refus « entreprise hors ligne » : ${t.blockedOffline}`,
    '',
    'ENTREPRISES',
  ]
  if (data.tenants.length === 0) lignes.push('- Aucune entreprise dans le parc.')
  for (const x of data.tenants) {
    lignes.push(
      `- ${x.name}${x.collected ? '' : ' (données indisponibles)'} : effectif ${x.headcount}, `
      + `${x.hires} arrivées, ${x.departures} départs, connectés ${x.usersLoggedIn}/${x.activeUsers}, `
      + `dernière connexion ${dateCourte(x.lastLoginAt)}`,
    )
  }
  lignes.push('', 'CABINETS')
  if (data.agencies.length === 0) lignes.push('- Aucun cabinet enregistré.')
  for (const c of data.agencies) {
    lignes.push(`- ${c.name} : ${c.managedTenants} entreprises, effectif cumulé ${c.headcount}`)
  }
  lignes.push('', 'POINTS D\'ATTENTION')
  if (a.alerts.length === 0) lignes.push('- Aucun point d\'attention sur la période.')
  for (const x of a.alerts) lignes.push(`- ${x.tenant} : ${x.detail}`)
  return lignes.join('\n')
}
