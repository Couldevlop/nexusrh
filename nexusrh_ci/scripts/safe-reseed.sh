#!/usr/bin/env bash
#
# Reseed SÉCURISÉ de NexusRH CI — fait un DUMP COMPLET de la base AVANT tout
# DROP/seed (filet de sécurité). À utiliser à la place d'un `node dist/db/seed.js`
# direct sur un environnement contenant des données à préserver.
#
# Rappels :
#  - Le seed ne DROP que les 4 schémas démo (tenant_sotra, tenant_cabinet_expertise_ci,
#    tenant_openlab_consulting, tenant_woyaa). Le schéma `platform` (registre des
#    tenants + super_admin) et tout tenant RÉEL ne sont JAMAIS touchés.
#  - Les mots de passe modifiés survivent au reseed (seed-credentials.ts : capture
#    avant DROP + restore après). Ce dump est une sécurité supplémentaire.
#
# Usage :   NS=nexusrh-ci ./scripts/safe-reseed.sh
# Restaurer : kubectl exec -i -n $NS <postgres-pod> -- psql -U <user> <db> < <backup.sql>
#
set -euo pipefail

NS="${NS:-nexusrh-ci}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="nexusrh-backup-${TS}.sql"

echo "[1/3] Localisation du pod PostgreSQL (ns=${NS})…"
PG="$(kubectl get pod -n "${NS}" -l app.kubernetes.io/name=postgresql -o name | head -1)"
if [ -z "${PG}" ]; then
  echo "  ✗ Pod PostgreSQL introuvable dans le namespace ${NS}" >&2
  exit 1
fi
echo "      ${PG}"

echo "[2/3] Dump complet de la base AVANT le seed → ${OUT}"
kubectl exec -n "${NS}" "${PG}" -- sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "${OUT}"
SIZE="$(wc -c < "${OUT}")"
if [ "${SIZE}" -lt 1000 ]; then
  echo "  ✗ Dump suspect (${SIZE} octets) — on N'EXÉCUTE PAS le seed. Vérifie l'accès." >&2
  exit 1
fi
echo "      ✓ Dump OK (${SIZE} octets) — conservé dans ${OUT}"

echo "[3/3] Seed (DROP+recréation des 4 tenants démo ; mots de passe préservés)…"
kubectl exec -n "${NS}" deploy/nexusrh-api -- node dist/db/seed.js

echo ""
echo "✓ Terminé. Sauvegarde pré-seed : ${OUT}"
echo "  Restauration éventuelle : kubectl exec -i -n ${NS} ${PG} -- psql -U <user> <db> < ${OUT}"
