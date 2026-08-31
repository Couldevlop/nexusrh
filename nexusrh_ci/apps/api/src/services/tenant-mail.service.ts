/**
 * Configuration d'envoi d'email d'un TENANT (expéditeur + serveur SMTP propre,
 * option C) — service partagé par tous les modules qui envoient des emails au
 * nom d'un tenant (settings, absences, bank-transfer…).
 *
 * Clean Architecture : la lecture/déchiffrement de la config vit ici (couche
 * service), les routes ne font qu'orchestrer. OWASP A02 : le mot de passe SMTP
 * est stocké chiffré (AES-256-GCM) et n'est déchiffré qu'au moment de l'envoi,
 * jamais renvoyé au client.
 */
import { pool } from '../db/pool.js'
import { decryptIfPresent } from '@nexusrhci/shared/crypto'
import type { TenantSmtp } from './email.js'

export interface TenantMailConfig {
  name: string
  primaryColor: string
  /** Adresse "From" configurée par le tenant — undefined → repli plateforme. */
  from: string | undefined
  /** Serveur SMTP du tenant (mot de passe déchiffré) — null → repli plateforme. */
  smtp: TenantSmtp | null
}

interface TenantMailRow {
  name: string
  primary_color: string | null
  sender_email: string | null
  sender_name: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: boolean | null
  smtp_user: string | null
  smtp_pass_enc: string | null
}

const MAIL_COLUMNS = `name, primary_color, sender_email, sender_name,
            smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc`

function buildTenantFrom(senderName: string | null | undefined, senderEmail: string | null | undefined): string | undefined {
  if (!senderEmail) return undefined
  return senderName ? `${senderName} <${senderEmail}>` : senderEmail
}

function toConfig(row: TenantMailRow | undefined): TenantMailConfig {
  const smtp: TenantSmtp | null = row?.smtp_host
    ? {
        host: row.smtp_host,
        port: row.smtp_port ?? 587,
        secure: row.smtp_secure ?? false,
        user: row.smtp_user,
        pass: decryptIfPresent(row.smtp_pass_enc),
      }
    : null
  return {
    name: row?.name ?? 'Votre entreprise',
    primaryColor: row?.primary_color ?? '#4F46E5',
    from: buildTenantFrom(row?.sender_name, row?.sender_email),
    smtp,
  }
}

/** Charge la config email d'un tenant par son id (JWT `tenantId`). */
export async function loadTenantMailById(tenantId: string): Promise<TenantMailConfig> {
  const r = await pool.query<TenantMailRow>(
    `SELECT ${MAIL_COLUMNS}
     FROM platform.tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  )
  return toConfig(r.rows[0])
}

/** Charge la config email d'un tenant par son schéma (JWT `schemaName`). */
export async function loadTenantMailBySchema(schemaName: string): Promise<TenantMailConfig> {
  const r = await pool.query<TenantMailRow>(
    `SELECT ${MAIL_COLUMNS}
     FROM platform.tenants WHERE schema_name = $1 LIMIT 1`,
    [schemaName],
  )
  return toConfig(r.rows[0])
}
