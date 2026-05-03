#!/usr/bin/env bash
# teardown.sh — Suppression propre de NexusRH
# Usage : ./scripts/teardown.sh [--purge]   (--purge supprime aussi les PVCs/données)
set -euo pipefail

RELEASE="nexusrh-ci"
NAMESPACE="nexusrh-ci"
PURGE="${1:-}"

echo "=== NexusRH Teardown ==="

helm uninstall "$RELEASE" -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete networkpolicy --all -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true

if [[ "$PURGE" == "--purge" ]]; then
  echo "→ Suppression PVCs (données perdues)..."
  kubectl delete pvc --all -n "$NAMESPACE" --ignore-not-found
  kubectl delete namespace "$NAMESPACE" --ignore-not-found
  echo "✓ Nettoyage complet."
else
  echo "✓ Release supprimée. PVCs conservés (données intactes)."
  echo "  Pour supprimer aussi les données : $0 --purge"
fi
