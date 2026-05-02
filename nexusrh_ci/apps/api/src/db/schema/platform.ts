import { pgSchema, uuid, varchar, boolean, integer, timestamp, text } from 'drizzle-orm/pg-core'

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
