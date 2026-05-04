#!/bin/bash
# scripts/setup-cluster-ci.sh — Initialisation des secrets NexusRH CI sur k3s
# Transfert : scp scripts/setup-cluster-ci.sh root@62.238.11.20:/tmp/
# Exécution  : ssh -t root@62.238.11.20 "bash /tmp/setup-cluster-ci.sh"

set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

NAMESPACE="nexusrh-ci"

echo "========================================"
echo " NexusRH CI — Setup cluster k3s"
echo "========================================"
echo ""

read -rp  "JWT Secret (32+ chars)               : " JWT_SECRET
read -rp  "Anthropic API Key (sk-ant-api03-...) : " ANTHROPIC_API_KEY
read -rp  "SMTP user (email)                    : " SMTP_USER
read -rsp "SMTP password                        : " SMTP_PASS; echo ""
read -rp  "SMTP from                            : " SMTP_FROM
read -rsp "PostgreSQL password                  : " PG_PASSWORD; echo ""
read -rsp "Redis password                       : " REDIS_PASSWORD; echo ""
read -rsp "MinIO root password                  : " MINIO_PASSWORD; echo ""
read -rsp "Meilisearch master key               : " MEILI_KEY; echo ""

echo ""
echo "── Namespace $NAMESPACE ──"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret applicatif ──"
kubectl create secret generic nexusrh-app-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY" \
  --from-literal=smtp-user="$SMTP_USER" \
  --from-literal=smtp-pass="$SMTP_PASS" \
  --from-literal=smtp-from="$SMTP_FROM" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret PostgreSQL ──"
kubectl create secret generic nexusrh-postgres-secret \
  --namespace "$NAMESPACE" \
  --from-literal=postgres-password="$PG_PASSWORD" \
  --from-literal=password="$PG_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret Redis ──"
kubectl create secret generic nexusrh-redis-secret \
  --namespace "$NAMESPACE" \
  --from-literal=redis-password="$REDIS_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret MinIO ──"
kubectl create secret generic nexusrh-minio-secret \
  --namespace "$NAMESPACE" \
  --from-literal=root-password="$MINIO_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret Meilisearch ──"
kubectl create secret generic nexusrh-meilisearch-secret \
  --namespace "$NAMESPACE" \
  --from-literal=master-key="$MEILI_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
kubectl get secrets -n "$NAMESPACE"

echo ""
echo "========================================"
echo " Kubeconfig encodé pour GitHub Secret"
echo " → Copier dans KUBECONFIG_PREPROD"
echo "========================================"
sed 's/127.0.0.1/62.238.11.20/g' /etc/rancher/k3s/k3s.yaml | base64 -w 0
echo ""
