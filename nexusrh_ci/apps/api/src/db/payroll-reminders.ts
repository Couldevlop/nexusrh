/**
 * Trace des RELANCES du circuit de validation de la paie
 * (services/payroll-validation-alerts.service). Une ligne = une relance
 * envoyée pour (période, niveau, entrée dans le niveau) : la contrainte
 * d'unicité rend la relance idempotente, y compris entre réplicas de l'API.
 * Après un rejet puis une ré-initiation, l'entrée dans le niveau change
 * (initiated_at) : une nouvelle fenêtre, donc une nouvelle relance possible.
 *
 * Partagé par le provisioning (nouveaux tenants) et la migration lazy
 * (ensureTenantSchema, tenants existants) — idempotent.
 */
export function payrollReminderTableStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.pay_period_reminders (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period_id    uuid NOT NULL REFERENCES ${s}.pay_periods(id) ON DELETE CASCADE,
      level        int NOT NULL,
      window_start timestamptz NOT NULL,
      recipients   int NOT NULL DEFAULT 0,
      emailed      int NOT NULL DEFAULT 0,
      sent_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (period_id, level, window_start)
    )`,
  ]
}
