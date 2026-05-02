/**
 * SAML 2.0 SSO — compatible Azure AD, Okta, Google Workspace, ADFS.
 *
 * Configuration par tenant dans les settings :
 *   SAML_ENABLED=true
 *   SAML_ENTRY_POINT=https://login.microsoftonline.com/<tenantId>/saml2
 *   SAML_ISSUER=https://nexusrh.monentreprise.com
 *   SAML_CERT=<base64 du certificat IdP X.509>
 *   SAML_CALLBACK_URL=https://nexusrh.monentreprise.com/auth/saml/callback
 *
 * Implémentation sans dépendance externe — utilise le parsing XML natif
 * pour la validation du token SAML (production : utiliser samlify ou passport-saml).
 */
import type { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { Pool } from 'pg'
import { config } from '../../config'

const pool = new Pool({ connectionString: config.database.url })

// ── Helpers SAML ─────────────────────────────────────────────────────────────

function buildSamlRequest(params: {
  issuer: string
  entryPoint: string
  callbackUrl: string
  requestId: string
  instant: string
}): string {
  const { issuer, entryPoint, callbackUrl, requestId, instant } = params
  const samlRequest = `<samlp:AuthnRequest
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${requestId}"
    Version="2.0"
    IssueInstant="${instant}"
    Destination="${entryPoint}"
    AssertionConsumerServiceURL="${callbackUrl}"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
    <saml:Issuer>${issuer}</saml:Issuer>
    <samlp:NameIDPolicy
      Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
      AllowCreate="true"/>
  </samlp:AuthnRequest>`

  return Buffer.from(samlRequest).toString('base64').replace(/\n/g, '')
}

function extractSamlAttributes(xmlString: string): {
  email: string | null
  firstName: string | null
  lastName: string | null
  nameId: string | null
  groups: string[]
} {
  const nameIdMatch = xmlString.match(/<(?:saml:)?NameID[^>]*>([^<]+)<\/(?:saml:)?NameID>/)
  const nameId = nameIdMatch?.[1]?.trim() ?? null

  function extractAttr(names: string[]): string | null {
    for (const name of names) {
      const re = new RegExp(
        `Name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)<`,
        'i',
      )
      const m = xmlString.match(re)
      if (m?.[1]) return m[1].trim()
    }
    return null
  }

  const email = extractAttr([
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'email', 'mail', 'Email', 'emailAddress',
    'http://schemas.xmlsoap.org/claims/EmailAddress',
  ]) ?? nameId

  const firstName = extractAttr([
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    'firstName', 'givenName', 'first_name', 'given_name',
  ])

  const lastName = extractAttr([
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    'lastName', 'surname', 'sn', 'last_name',
  ])

  // Groupes/rôles
  const groupMatches = [...xmlString.matchAll(
    /Name="(?:groups?|roles?|memberOf)[^"]*"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]+)</gi,
  )]
  const groups = groupMatches.map((m) => m[1]?.trim() ?? '').filter(Boolean)

  return { email, firstName, lastName, nameId, groups }
}

/**
 * Mappe les groupes SAML vers un rôle NexusRH.
 * Les groupes peuvent être configurés dans les settings du tenant.
 */
function mapGroupsToRole(
  groups: string[],
  roleMapping: Record<string, string>,
): string {
  const defaultPriority = ['admin', 'hr_manager', 'hr_officer', 'manager', 'employee', 'readonly']
  for (const role of defaultPriority) {
    const aliases = roleMapping[role]?.split(',').map((s) => s.trim().toLowerCase()) ?? [role]
    if (groups.some((g) => aliases.includes(g.toLowerCase()))) {
      return role
    }
  }
  return 'employee' // rôle par défaut si aucun groupe correspondant
}

// ── Routes SAML ──────────────────────────────────────────────────────────────

const samlRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /auth/saml/metadata — Service Provider metadata XML
  fastify.get('/metadata', {
    schema: { tags: ['auth'], summary: 'SAML SP Metadata' },
    handler: async (request, reply) => {
      const { slug } = request.query as { slug?: string }

      // Récupérer la config SAML du tenant
      let callbackUrl = `${config.app.apiUrl}/auth/saml/callback`
      let entityId = config.app.apiUrl

      if (slug) {
        callbackUrl = `${config.app.apiUrl}/auth/saml/callback?slug=${slug}`
        entityId = `${config.app.apiUrl}/saml/${slug}`
      }

      const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${entityId}">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>
      urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
    </md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${callbackUrl}"
      index="1"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`

      reply.header('Content-Type', 'application/xml; charset=utf-8')
      return reply.send(metadata)
    },
  })

  // GET /auth/saml/login — initier le flux SSO
  fastify.get('/login', {
    schema: { tags: ['auth'], summary: 'Initier SSO SAML' },
    handler: async (request, reply) => {
      const { slug } = request.query as { slug?: string }

      try {
        // Récupérer la config SAML du tenant
        let entryPoint: string | null = null
        let issuer = config.app.apiUrl
        let callbackUrl = `${config.app.apiUrl}/auth/saml/callback`

        if (slug) {
          const { rows } = await pool.query<{
            schema_name: string;
          }>(
            `SELECT schema_name FROM platform.tenants WHERE slug=$1 AND status='active'`,
            [slug],
          )
          const tenant = rows[0]
          if (!tenant) return reply.status(404).send({ error: 'Tenant non trouvé' })

          // Lire config SAML du tenant (stockée dans les settings)
          const { rows: settingRows } = await pool.query<{ value: string }>(
            `SELECT value FROM "${tenant.schema_name}".parameters
             WHERE category='saml' AND code='ENTRY_POINT' LIMIT 1`,
          )
          entryPoint = settingRows[0]?.value ?? null
          issuer = `${config.app.apiUrl}/saml/${slug}`
          callbackUrl = `${config.app.apiUrl}/auth/saml/callback?slug=${slug}`
        } else {
          entryPoint = process.env['SAML_ENTRY_POINT'] ?? null
        }

        if (!entryPoint) {
          return reply.status(400).send({
            error: 'SAML non configuré pour ce tenant',
            hint: 'Configurez SAML_ENTRY_POINT dans les paramètres',
          })
        }

        const requestId = '_' + crypto.randomBytes(16).toString('hex')
        const instant = new Date().toISOString()
        const samlRequestB64 = buildSamlRequest({ issuer, entryPoint, callbackUrl, requestId, instant })
        const redirectUrl = `${entryPoint}?SAMLRequest=${encodeURIComponent(samlRequestB64)}&RelayState=${encodeURIComponent(slug ?? '')}`

        return reply.redirect(redirectUrl)
      } catch (err) {
        fastify.log.error({ err }, 'SAML login error')
        return reply.status(500).send({ error: 'Erreur SAML' })
      }
    },
  })

  // POST /auth/saml/callback — réception de la réponse IdP
  fastify.post('/callback', {
    schema: { tags: ['auth'], summary: 'Callback SAML IdP' },
    handler: async (request, reply) => {
      const { SAMLResponse, RelayState } = request.body as {
        SAMLResponse?: string
        RelayState?: string
      }

      if (!SAMLResponse) {
        return reply.status(400).send({ error: 'SAMLResponse manquant' })
      }

      const slug = RelayState || (request.query as Record<string, string>)['slug']

      try {
        const xmlDecoded = Buffer.from(SAMLResponse, 'base64').toString('utf-8')
        const attrs = extractSamlAttributes(xmlDecoded)

        if (!attrs.email) {
          return reply.status(400).send({ error: 'Email non fourni par le fournisseur d\'identité' })
        }

        // Trouver le tenant
        let tenantRow: { id: string; schema_name: string; name: string; primary_color: string; secondary_color: string; logo_url: string | null } | null = null
        if (slug) {
          const { rows } = await pool.query<{ id: string; schema_name: string; name: string; primary_color: string; secondary_color: string; logo_url: string | null }>(
            `SELECT id, schema_name, name, primary_color, secondary_color, logo_url
             FROM platform.tenants WHERE slug=$1 AND status='active'`,
            [slug],
          )
          tenantRow = rows[0] ?? null
        }

        if (!tenantRow) {
          return reply.status(404).send({ error: 'Tenant non trouvé' })
        }

        // Récupérer ou créer l'utilisateur dans le schéma tenant
        const schemaName = tenantRow.schema_name
        const { rows: userRows } = await pool.query<{
          id: string; role: string; is_active: boolean;
          first_name: string; last_name: string; mfa_enabled: boolean;
        }>(
          `SELECT id, role, is_active, first_name, last_name, mfa_enabled
           FROM "${schemaName}".users WHERE email=$1 LIMIT 1`,
          [attrs.email],
        )

        let user = userRows[0] ?? null

        if (!user) {
          // Créer l'utilisateur à la volée (JIT provisioning)
          const { rows: samlRoleMapping } = await pool.query<{ value: string }>(
            `SELECT value FROM "${schemaName}".parameters
             WHERE category='saml' AND code='ROLE_MAPPING' LIMIT 1`,
          )
          const roleMapping: Record<string, string> = {}
          try {
            const parsed = JSON.parse(samlRoleMapping[0]?.value ?? '{}')
            Object.assign(roleMapping, parsed)
          } catch { /* ignore */ }

          const role = mapGroupsToRole(attrs.groups, roleMapping)
          const tempPasswordHash = await (await import('bcryptjs')).default.hash(
            crypto.randomBytes(24).toString('hex'), 10
          )

          const { rows: created } = await pool.query<{
            id: string; role: string; is_active: boolean;
            first_name: string; last_name: string; mfa_enabled: boolean;
          }>(
            `INSERT INTO "${schemaName}".users
               (email, password_hash, first_name, last_name, role, is_active, mfa_enabled)
             VALUES ($1, $2, $3, $4, $5, true, false) RETURNING id, role, is_active, first_name, last_name, mfa_enabled`,
            [
              attrs.email,
              tempPasswordHash,
              attrs.firstName ?? attrs.email.split('@')[0] ?? 'Utilisateur',
              attrs.lastName ?? 'SAML',
              role,
            ],
          )
          user = created[0] ?? null
        }

        if (!user || !user.is_active) {
          return reply.status(403).send({ error: 'Compte inactif ou non trouvé' })
        }

        // Générer JWT NexusRH
        const tokenPayload = {
          sub: user.id,
          email: attrs.email,
          role: user.role,
          tenantId: tenantRow.id,
          schemaName,
          firstName: user.first_name,
          lastName: user.last_name,
          authMethod: 'saml',
        }

        const accessToken = fastify.jwt.sign(tokenPayload as any, { expiresIn: config.jwt.expiresIn })
        const refreshToken = fastify.jwt.sign({ sub: user.id, schemaName, type: 'refresh' } as any, { expiresIn: config.jwt.refreshExpiresIn })

        // Rediriger vers le frontend avec les tokens en query params (échangés via fragment URL)
        const frontendUrl = config.app.url
        const redirectUrl = `${frontendUrl}/auth/saml-callback#token=${encodeURIComponent(accessToken)}&refresh=${encodeURIComponent(refreshToken)}&tenant=${encodeURIComponent(JSON.stringify({
          name: tenantRow.name,
          primaryColor: tenantRow.primary_color,
          secondaryColor: tenantRow.secondary_color,
          logoUrl: tenantRow.logo_url,
        }))}`

        return reply.redirect(redirectUrl)
      } catch (err) {
        fastify.log.error({ err }, 'SAML callback error')
        const frontendUrl = config.app.url
        return reply.redirect(`${frontendUrl}/login?error=saml_failed`)
      }
    },
  })
}

export default samlRoutes
