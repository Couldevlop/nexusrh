import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  text,
  integer,
} from 'drizzle-orm/pg-core'

// ─── platform.tenants ────────────────────────────────────────────────────────
export const platformTenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    planType: varchar('plan_type', { length: 20 }).notNull().default('trial'),
    // trial | starter | pro | enterprise
    status: varchar('status', { length: 20 }).notNull().default('trial'),
    // active | suspended | trial
    schemaName: varchar('schema_name', { length: 100 }).notNull(),
    maxUsers: integer('max_users').notNull().default(100),
    maxEmployees: integer('max_employees').notNull().default(200),
    primaryColor: varchar('primary_color', { length: 7 }).notNull().default('#4F46E5'),
    secondaryColor: varchar('secondary_color', { length: 7 }).notNull().default('#818CF8'),
    logoUrl: text('logo_url'),
    faviconUrl: text('favicon_url'),
    customDomain: varchar('custom_domain', { length: 255 }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Table in schema "platform" — enforced via SET search_path at runtime
)

// ─── platform.platform_users ─────────────────────────────────────────────────
export const platformUsers = pgTable('platform_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  role: varchar('role', { length: 30 }).notNull().default('super_admin'),
  isActive: boolean('is_active').notNull().default(true),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaSecret: varchar('mfa_secret', { length: 255 }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─── platform.tenant_invitations ─────────────────────────────────────────────
export const platformTenantInvitations = pgTable('tenant_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => platformTenants.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 30 }).notNull().default('admin'),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PlatformTenant = typeof platformTenants.$inferSelect
export type NewPlatformTenant = typeof platformTenants.$inferInsert
export type PlatformUser = typeof platformUsers.$inferSelect
export type NewPlatformUser = typeof platformUsers.$inferInsert
export type PlatformTenantInvitation = typeof platformTenantInvitations.$inferSelect
export type NewPlatformTenantInvitation = typeof platformTenantInvitations.$inferInsert
