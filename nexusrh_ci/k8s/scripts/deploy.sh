#!/usr/bin/env bash
# deploy.sh — Déploiement NexusRH via Helm (source unique de vérité)
# Usage : ./scripts/deploy.sh [preprod|prod]
set -euo pipefail

ENV="${1:-preprod}"
RELEASE="nexusrh-ci"
NAMESPACE="nexusrh-ci"
CHART="$(dirname "$0")/../charts/nexusrh"
SECRET_FILE="$CHART/values.secret.yaml"

case "$ENV" in
  prod)    VALUES_FILE="$CHART/values.prod.yaml" ;;
  preprod) VALUES_FILE="$CHART/values.yaml" ;;
  *)       echo "Usage: $0 [preprod|prod]"; exit 1 ;;
esac

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "ERREUR : $SECRET_FILE introuvable dans $CHART/"
  exit 1
fi

echo "=== NexusRH Deploy — ENV=$ENV ==="

# 0. Namespace (idempotent)
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# 1. Nettoyer les ressources kustomize conflictuelles (NetworkPolicies + infra custom)
echo "→ Nettoyage ressources kustomize..."
kubectl delete networkpolicy --all -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete statefulset postgres -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete deployment nexusrh-infra-redis nexusrh-infra-minio -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
kubectl delete svc postgres-svc postgres-headless redis-svc minio-svc -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true

# 2. Dépendances Helm (Bitnami sub-charts)
echo "→ Mise à jour dépendances Helm..."
helm dependency update "$CHART"

# 3. Déploiement
echo "→ Helm upgrade --install ($ENV)..."
helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  -f "$SECRET_FILE" \
  --set infra.enabled=false \
  --set postgres.enabled=true \
  --set redis.enabled=true \
  --set minio.enabled=true \
  --set meilisearch.enabled=true \
  --set networkPolicies.enabled=true \
  --wait --timeout=10m

echo ""
echo "=== Déploiement terminé (révision $(helm list -n $NAMESPACE -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["revision"])')) ==="
kubectl get pods -n "$NAMESPACE"
