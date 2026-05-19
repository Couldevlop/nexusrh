-- =============================================================================
-- Reset admin passwords — bcrypt 12 rounds (OWASP A02 Cryptographic Failures)
-- Généré le 2026-05-15 — passwords documentés dans CLAUDE.md/README.md
-- =============================================================================
--
-- À exécuter en cas de régression auth 401 sur les comptes démo.
-- Idempotent : peut être rejoué sans risque.
--
-- Exécution en prod K8s :
--   kubectl cp nexusrh_ci/scripts/reset-admin-passwords.sql nexusrh/postgres-0:/tmp/reset.sql
--   kubectl exec -n nexusrh postgres-0 -- psql -U nexusrh -d nexusrh -f /tmp/reset.sql
--
-- OU directement par stdin :
--   kubectl exec -i -n nexusrh postgres-0 -- psql -U nexusrh -d nexusrh < nexusrh_ci/scripts/reset-admin-passwords.sql
--
-- Comptes :
--   superadmin@nexusrh-ci.com       SuperAdmin1234!
--   admin@sotra.ci                  Admin1234!
--   rh@sotra.ci                     Admin1234!
--   manager@sotra.ci                Admin1234!
--   employe@sotra.ci                Admin1234!
--   admin@cabinet-expertise.ci      Admin1234!
--   employe2@cabinet-expertise.ci   Admin1234!
--   coulwao@gmail.com               Openlab1234!
-- =============================================================================

BEGIN;

UPDATE "platform".platform_users
   SET password_hash = '$2a$12$ObgKORnMiNSY/7GCQ60Zguuc4VaMkObNCwuL9UWhx2crU.OWLx6tG',
       is_active = true, updated_at = now()
 WHERE email = 'superadmin@nexusrh-ci.com';

UPDATE "tenant_sotra".users
   SET password_hash = '$2a$12$3SjM4wffJJ2.7brsum9gmOVkr1Ib3HpxtYHGZkYGdK5JKjvL9Aj2y',
       is_active = true, updated_at = now()
 WHERE email = 'admin@sotra.ci';

UPDATE "tenant_sotra".users
   SET password_hash = '$2a$12$RMHksYFFjhVb1fQ0MyuB8upWHT77OdVndn3Ka0gtJJB.DrrgadohS',
       is_active = true, updated_at = now()
 WHERE email = 'rh@sotra.ci';

UPDATE "tenant_sotra".users
   SET password_hash = '$2a$12$rLk9L0rA57h9IDczP1xdTuf1e/1ZEOBXwtoLweFHVZKBoeFP3AKJm',
       is_active = true, updated_at = now()
 WHERE email = 'manager@sotra.ci';

UPDATE "tenant_sotra".users
   SET password_hash = '$2a$12$gKZexlysN.K/7h7QHnvWE.N7qCUUyJwAH.xHLZEi10akIhKNQHDcC',
       is_active = true, updated_at = now()
 WHERE email = 'employe@sotra.ci';

UPDATE "tenant_cabinet_expertise_ci".users
   SET password_hash = '$2a$12$8ARklISaldpoCcMmwdFCVOmrWVbGhkwC78WnduRQkjG7Bw8ZcDHBy',
       is_active = true, updated_at = now()
 WHERE email = 'admin@cabinet-expertise.ci';

UPDATE "tenant_cabinet_expertise_ci".users
   SET password_hash = '$2a$12$0hjRf7pkutPM3Fghv3szJ.dj8cgqI3WTER5ywXZENAFVci4cBSuzi',
       is_active = true, updated_at = now()
 WHERE email = 'employe2@cabinet-expertise.ci';

UPDATE "tenant_openlab_consulting".users
   SET password_hash = '$2a$12$xsdey78KfSj6Y.zIQxh7g.QFDIlbmdcdiASkMiBXfuYEWBFMbrtO.',
       is_active = true, updated_at = now()
 WHERE email = 'coulwao@gmail.com';

COMMIT;

-- Vérification post-reset
SELECT 'platform' AS scope, email, is_active FROM "platform".platform_users WHERE email = 'superadmin@nexusrh-ci.com'
UNION ALL
SELECT 'sotra', email, is_active FROM "tenant_sotra".users WHERE email LIKE '%@sotra.ci'
UNION ALL
SELECT 'cabinet', email, is_active FROM "tenant_cabinet_expertise_ci".users WHERE email LIKE '%cabinet-expertise.ci'
UNION ALL
SELECT 'openlab', email, is_active FROM "tenant_openlab_consulting".users WHERE email = 'coulwao@gmail.com';
