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

# ── Secrets : AUCUNE valeur en clair dans ce fichier ──────────────────────────
#
# POURQUOI. Ce fichier est versionné et le dépôt est public : une valeur écrite
# ici est publiée. Celles qui s'y trouvaient (signature des jetons, chiffrement
# NNI/IBAN, PostgreSQL, Redis, MinIO, Meilisearch, mot de passe d'application
# SMTP) l'ont été du 07/06/2026 au 26/11/2026. La clé de signature permettait à
# elle seule de forger un jeton `super_admin` sur n'importe quel tenant SANS se
# connecter : MFA, expiration des mots de passe, verrouillage et grille
# d'habilitations se trouvent tous APRÈS la vérification de signature.
#
# Ordre de résolution, pour chaque secret :
#   1. la variable d'environnement, si elle est fournie — c'est le geste de
#      rotation volontaire (`JWT_SECRET=$(openssl rand -hex 48) bash setup-cluster.sh`) ;
#   2. sinon la valeur DÉJÀ dans le cluster. C'est le cas d'une ré-exécution :
#      régénérer déconnecterait tout le monde, effacerait la clé IA en service,
#      ou rendrait illisibles des données chiffrées avec l'ancienne clé ;
#   3. à défaut seulement, une valeur aléatoire — première installation.
#
# Ce fichier ne doit plus jamais contenir d'affectation littérale. Deux filets
# le vérifient : le golden `apps/api/src/secrets-hors-depot.golden.test.ts`
# (tourne en local et en CI, balaie TOUS les fichiers versionnés) et le scan
# gitleaks bloquant du workflow « Quality & Security ».

## Valeur d'une clé d'un secret déjà présent dans le cluster, ou vide.
secret_du_cluster() {   # $1 = nom du secret, $2 = clé
  kubectl get secret "$1" -n "$NAMESPACE" -o jsonpath="{.data.$2}" 2>/dev/null \
    | base64 -d 2>/dev/null || true
}

## Résout un secret générable : environnement, puis cluster, puis aléatoire.
## La valeur n'est jamais affichée — seule l'origine l'est.
resoudre() {            # $1 = variable, $2 = secret, $3 = clé, $4 = octets (déf. 32)
  local var="$1" val="${!1:-}" octets="${4:-32}" origine="environnement"
  if [ -z "$val" ]; then
    val="$(secret_du_cluster "$2" "$3")"
    origine="cluster"
  fi
  if [ -z "$val" ]; then
    val="$(openssl rand -hex "$octets")"
    origine="GÉNÉRÉE (première installation)"
  fi
  printf -v "$var" '%s' "$val"
  printf '   %-20s ← %s\n' "$1" "$origine"
}

## Résout un secret NON générable (compte tiers) : environnement, cluster, saisie.
demander() {            # $1 = variable, $2 = secret, $3 = clé, $4 = invite
  local var="$1" val="${!1:-}" origine="environnement"
  if [ -z "$val" ]; then
    val="$(secret_du_cluster "$2" "$3")"
    origine="cluster"
  fi
  if [ -z "$val" ]; then
    read -rp "   $4 (Entrée pour laisser vide) : " val
    origine="saisie"
  fi
  printf -v "$var" '%s' "$val"
  printf '   %-20s ← %s\n' "$1" "$origine"
}

echo "── Résolution des secrets (aucune valeur n'est affichée) ──"

# Signature des jetons : 48 octets. Fournir JWT_SECRET pour faire tourner la clé
# — toutes les sessions en cours tombent alors, ce qui est l'effet recherché.
resoudre JWT_SECRET         nexusrh-app-secrets        jwt-secret        48

# Chiffrement AES-256 des NNI/IBAN : 32 octets = 64 hex, format exigé par
# `config.ts`. JAMAIS régénérée en silence sur un cluster qui en a déjà une :
# les NNI/IBAN en base deviendraient illisibles. Une rotation réelle demande un
# ré-chiffrement (lire avec l'ancienne, écrire avec la nouvelle) AVANT le retrait.
resoudre ENCRYPTION_KEY     nexusrh-app-secrets        encryption-key    32

# Scellement HMAC des exports de piste d'audit. La régénérer rendrait
# invérifiables tous les sceaux déjà remis à un tiers.
resoudre AUDIT_SIGNING_KEY  nexusrh-app-secrets        audit-signing-key 32

resoudre PG_PASSWORD        nexusrh-postgres-secret    postgres-password 24
resoudre REDIS_PASSWORD     nexusrh-redis-secret       redis-password    24
resoudre MINIO_PASSWORD     nexusrh-minio-secret       root-password     24
resoudre MEILI_KEY          nexusrh-meilisearch-secret master-key        24

# ── Comptes tiers ─────────────────────────────────────────────────────────────
# Reprises du cluster si elles y sont déjà : une ré-exécution ne doit pas
# effacer la clé IA qui fait tourner le chat, ni l'envoi d'emails.
demander SMTP_USER       nexusrh-app-secrets smtp-user        "Compte SMTP (adresse)"
demander SMTP_PASS       nexusrh-app-secrets smtp-pass        "Mot de passe d'application SMTP"
demander SMTP_FROM       nexusrh-app-secrets smtp-from        "Expéditeur affiché"
demander ANTHROPIC_API_KEY nexusrh-app-secrets anthropic-api-key "Clé API Anthropic"
demander MISTRAL_API_KEY nexusrh-app-secrets mistral-api-key  "Clé API Mistral"

echo ""
echo "── Création du namespace $NAMESPACE ──"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "── Secret applicatif (JWT, IA, SMTP) ──"
kubectl create secret generic nexusrh-app-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  --from-literal=encryption-key="$ENCRYPTION_KEY" \
  --from-literal=audit-signing-key="$AUDIT_SIGNING_KEY" \
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
