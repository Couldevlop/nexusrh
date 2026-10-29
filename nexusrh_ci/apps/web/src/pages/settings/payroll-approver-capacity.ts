/**
 * Capacité du tenant à faire tourner le circuit de validation de la paie
 * (séparation des tâches) : un circuit à N niveaux exige N + 1 personnes
 * distinctes — l'initiateur de la clôture (administrateur / responsable RH)
 * puis un approbateur différent par niveau. Peuvent approuver : l'équipe RH
 * (admin, hr_manager) et un gestionnaire RH (hr_officer) uniquement s'il est
 * le valideur désigné d'un niveau.
 */
const TEAM_ROLES = new Set(['admin', 'hr_manager'])

export interface ApproverCapacity {
  required: number
  available: number
  sufficient: boolean
}

export function payrollApproverCapacity(
  levels: number,
  hrTeam: ReadonlyArray<{ id: string; role: string }>,
  designatedIds: ReadonlyArray<string>,
): ApproverCapacity {
  const people = new Set<string>()
  let initiators = 0
  for (const u of hrTeam) {
    if (TEAM_ROLES.has(u.role)) { people.add(u.id); initiators++ }
  }
  const officers = new Set(hrTeam.filter(u => u.role === 'hr_officer').map(u => u.id))
  for (const id of designatedIds) if (officers.has(id)) people.add(id)
  const required = Math.max(1, levels) + 1
  return { required, available: people.size, sufficient: initiators > 0 && people.size >= required }
}
