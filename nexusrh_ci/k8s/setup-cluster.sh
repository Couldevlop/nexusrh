#!/bin/bash
# setup-cluster.sh — Initialisation des secrets NexusRH CI sur k3s
# Transfert : scp nexusrh_ci/k8s/setup-cluster.sh root@62.238.11.20:/tmp/
# Exécution  : ssh -t root@62.238.11.20 "bash /tmp/setup-cluster.sh"

set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

NAMESPACE="nexusrh-ci"

echo "========================================"
echo " NexusRH CI — Setup cluster k3s"
echo "========================================"
echo ""

# ── Valeurs issues de values.secret.yaml + .env ───────────────────────────────
JWT_SECRET="Abidjan@2025@@!Azerrty?@_010405/Thomcoulwa@1451201*__03@"
SMTP_USER="coulwao@gmail.com"
SMTP_PASS="afma hrdo tvzi mxnk"
SMTP_FROM="NexusRH <coulwao@gmail.com>"
PG_PASSWORD="7ecb8a5d2116d59c82ec7b1ce70128a7b1f73f2305c56c04"
REDIS_PASSWORD="d0e6c9ebb72c7ae899928f34b1e42842c612c883c284b3de"
MINIO_PASSWORD="e228ff266bc4333ea1f13a439d522408bcf41a5c976dca63"
MEILI_KEY="26044cf067f14264a90ac4ec763ed43f260f52f7bcaf3a97"
# Clé de chiffrement AES-256 NNI/IBAN (64 hex). Régénérer en prod si besoin :
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY="9075f443fdc9a8a79beb8a0b420f4455a838e93607ef1c0bb9844302435a93d4"

# ── Clés IA ───────────────────────────────────────────────────────────────────
# Anthropic (Claude) : laisser vide si non utilisé.
read -rp "Anthropic API Key (sk-ant-api03-..., Entrée pour ignorer) : " ANTHROPIC_API_KEY
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
# Mistral : fournisseur IA par défaut plateforme (AI_DEFAULT_PROVIDER=mistral).
# C'est la clé qui fait fonctionner le chat IA si le tenant n'a pas la sienne.
read -rp "Mistral API Key (Entrée pour ignorer) : " MISTRAL_API_KEY
MISTRAL_API_KEY="${MISTRAL_API_KEY:-}"

echo ""
echo "── Création du namespace $NAMESPACE ──"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret applicatif (JWT, IA, SMTP) ──"
kubectl create secret generic nexusrh-app-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  --from-literal=encryption-key="$ENCRYPTION_KEY" \
  --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY" \
  --from-literal=mistral-api-key="$MISTRAL_API_KEY" \
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
echo "── Secrets créés ──"
kubectl get secrets -n "$NAMESPACE"

echo ""
echo "========================================"
echo " Kubeconfig encodé pour GitHub Secret"
echo " KUBECONFIG_PREPROD = valeur ci-dessous"
echo "========================================"
sed 's/127.0.0.1/62.238.11.20/g' /etc/rancher/k3s/k3s.yaml | base64 -w 0
echo ""
echo ""
echo "→ GitHub : Settings → Secrets → KUBECONFIG_PREPROD = valeur ci-dessus"
echo "→ GitHub : Settings → Variables → DOMAIN           = nexusrh-ci.openlabconsulting.com"
echo "→ GitHub : Settings → Variables → API_DOMAIN       = api.nexusrh-ci.openlabconsulting.com"
