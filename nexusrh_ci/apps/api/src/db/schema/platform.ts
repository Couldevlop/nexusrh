import { pgSchema, uuid, varchar, boolean, integer, timestamp, text, jsonb, customType } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea'
  },
})

export const platformSchema = pgSchema('platform')

export const tenants = platformSchema.table('tenants', {
  id:            uuid('id').primaryKey().defaultRandom(),
  slug:          varchar('slug', { length: 63 }).notNull().unique(),
  name:          varchar('name', { length: 255 }).notNull(),
  schemaName:    varchar('schema_name', { length: 63 }).notNull().unique(),
  planType:      varchar('plan_type', { length: 30 }).notNull().default('trial'),
  status:        varchar('status', { length: 20 }).notNull().default('trial'),
  // CI-specific
  sector:        varchar('sector', { length: 50 }),
  city:          varchar('city', { length: 100 }),
  cnpsNumber:    varchar('cnps_number', { length: 50 }),
  dgiNumber:     varchar('dgi_number', { length: 50 }),
  rccm:          varchar('rccm', { length: 100 }),
  atRate:        varchar('at_rate', { length: 10 }).default('0.020'), // taux AT CNPS
  // limits
  maxUsers:      integer('max_users').notNull().default(10),
  maxEmployees:  integer('max_employees').notNull().default(20),
  // branding
  primaryColor:  varchar('primary_color', { length: 7 }).default('#E85D04'),
  secondaryColor: varchar('secondary_color', { length: 7 }).default('#F48C06'),
  logoUrl:       text('logo_url'),
  faviconUrl:    text('favicon_url'),
  customDomain:  varchar('custom_domain', { length: 255 }),
  // modules activables (surcharges { module: boolean } — '{}' = défauts)
  enabledModules: jsonb('enabled_modules').notNull().default('{}'),
  // dates
  trialEndsAt:   timestamp('trial_ends_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const platformUsers = platformSchema.table('platform_users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName:    varchar('first_name', { length: 100 }).notNull(),
  lastName:     varchar('last_name', { length: 100 }).notNull(),
  role:         varchar('role', { length: 20 }).notNull().default('super_admin'),
  isActive:     boolean('is_active').notNull().default(true),
  mfaEnabled:   boolean('mfa_enabled').notNull().default(false),
  mfaSecret:    varchar('mfa_secret', { length: 255 }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tenantInvitations = platformSchema.table('tenant_invitations', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email:      varchar('email', { length: 255 }).notNull(),
  role:       varchar('role', { length: 20 }).notNull().default('admin'),
  token:      varchar('token', { length: 255 }).notNull().unique(),
  expiresAt:  timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Cabinets de recrutement (acteur multi-tenant, CI uniquement) ───────────────
// Un cabinet est une organisation multi-utilisateurs qui gère plusieurs tenants
// clients. Le super_admin pilote les cabinets ; un cabinet peut onboarder ses
// propres tenants clients (auto-rattachés). Tables isolées dans le schema platform :
// aucun schema tenant n'est modifié.
export const agencies = platformSchema.table('agencies', {
  id:           uuid('id').primaryKey().defaultRandom(),
  slug:         varchar('slug', { length: 63 }).notNull().unique(),
  name:         varchar('name', { length: 255 }).notNull(),
  status:       varchar('status', { length: 20 }).notNull().default('active'), // active | suspended
  countryCode:  varchar('country_code', { length: 3 }).notNull().default('CIV'),
  city:         varchar('city', { length: 100 }),
  contactEmail: varchar('contact_email', { length: 255 }),
  contactPhone: varchar('contact_phone', { length: 30 }),
  primaryColor: varchar('primary_color', { length: 7 }).default('#1D4ED8'),
  logoUrl:      text('logo_url'),
  senderEmail:  varchar('sender_email', { length: 255 }),
  senderName:   varchar('sender_name', { length: 150 }),
  createdBy:    uuid('created_by'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const brandAssets = platformSchema.table('brand_assets', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mime:      varchar('mime', { length: 100 }).notNull(),
  bytes:     bytea('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agencyUsers = platformSchema.table('agency_users', {
  id:                uuid('id').primaryKey().defaultRandom(),
  agencyId:          uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  email:             varchar('email', { length: 255 }).notNull().unique(),
  passwordHash:      varchar('password_hash', { length: 255 }).notNull(),
  firstName:         varchar('first_name', { length: 100 }).notNull(),
  lastName:          varchar('last_name', { length: 100 }).notNull(),
  role:              varchar('role', { length: 20 }).notNull().default('agency_member'), // agency_owner | agency_member
  isActive:          boolean('is_active').notNull().default(true),
  mfaEnabled:        boolean('mfa_enabled').notNull().default(false),
  mfaSecret:         varchar('mfa_secret', { length: 255 }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt:       timestamp('last_login_at', { withTimezone: true }),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const agencyTenants = platformSchema.table('agency_tenants', {
  id:         uuid('id').primaryKey().defaultRandom(),
  agencyId:   uuid('agency_id').notNull().references(() => agencies.id, { onDelete: 'cascade' }),
  tenantId:   uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  assignedBy: uuid('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  detachedAt: timestamp('detached_at', { withTimezone: true }),
})
