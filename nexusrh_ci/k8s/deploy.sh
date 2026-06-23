#!/usr/bin/env bash
# deploy.sh — NexusRH : déploiement Helm sur kind (local) ou cloud en ~10 min
# Usage :
#   bash deploy.sh                  # local (kind) — RECOMMANDÉ
#   bash deploy.sh --env prod       # production (cluster existant)
#   bash deploy.sh --destroy        # supprime le cluster kind
#   bash deploy.sh --status         # état des pods
#   bash deploy.sh --seed           # relance le seed uniquement
#   bash deploy.sh --upgrade        # upgrade chart sans recréer le cluster
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
CLUSTER_NAME="nexusrh"
NAMESPACE="nexusrh"
RELEASE="nexusrh"
CHART="./k8s/charts/nexusrh"
ENV="local"
DOMAIN="nexusrh.local"
API_DOMAIN="api.nexusrh.local"
CERT_MANAGER_VERSION="v1.15.1"
INGRESS_NGINX_VERSION="4.10.1"
MEILISEARCH_HELM_REPO="https://meilisearch.github.io/meilisearch-kubernetes"
K8S_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$K8S_DIR")"
BUILD_IMAGES=true
RUN_SEED=true
DESTROY=false; STATUS=false; SEED_ONLY=false; UPGRADE_ONLY=false

# ── Couleurs ──────────────────────────────────────────────────────────────────
C_CYAN='\033[0;36m'; C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_BLUE='\033[0;34m'; C_NC='\033[0m'
ts() { date +%H:%M:%S; }
info()    { echo -e "${C_CYAN}[$(ts)] $*${C_NC}"; }
success() { echo -e "${C_GREEN}[$(ts)] ✓ $*${C_NC}"; }
warn()    { echo -e "${C_YELLOW}[$(ts)] ⚠ $*${C_NC}"; }
die()     { echo -e "${C_RED}[$(ts)] ✗ $*${C_NC}" >&2; exit 1; }
step()    { echo -e "\n${C_BLUE}══════════════════════════════════════${C_NC}"; \
            echo -e "${C_BLUE} $*${C_NC}"; \
            echo -e "${C_BLUE}══════════════════════════════════════${C_NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)       ENV="$2"; shift 2 ;;
    --env=*)     ENV="${1#*=}"; shift ;;
    --domain)    DOMAIN="$2"; shift 2 ;;
    --no-build)  BUILD_IMAGES=false; shift ;;
    --no-seed)   RUN_SEED=false; shift ;;
    --destroy)   DESTROY=true; shift ;;
    --status)    STATUS=true; shift ;;
    --seed)      SEED_ONLY=true; shift ;;
    --upgrade)   UPGRADE_ONLY=true; BUILD_IMAGES=false; shift ;;
    *) warn "Argument inconnu : $1"; shift ;;
  esac
done

[[ "$ENV" == "prod" ]] && { BUILD_IMAGES=false; warn "Mode prod : images attendues sur le registry."; }

# ── Prérequis ─────────────────────────────────────────────────────────────────
check_prereqs() {
  step "Vérification des prérequis"
  local miss=()
  for c in kubectl kind helm docker openssl; do
    command -v "$c" &>/dev/null || miss+=("$c")
  done
  [[ ${#miss[@]} -gt 0 ]] && die "Manquants : ${miss[*]}\nLancez : bash k8s/scripts/install-linux.sh"
  docker info &>/dev/null 2>&1 || die "Docker non démarré."
  success "Prérequis OK"
}

show_status() {
  kubectl get nodes -o wide 2>/dev/null || true
  echo ""; kubectl get pods -n "$NAMESPACE" 2>/dev/null || true
  echo ""; kubectl get ingress -n "$NAMESPACE" 2>/dev/null || true
}

# ── Cluster kind ──────────────────────────────────────────────────────────────
create_cluster() {
  step "Cluster kind '$CLUSTER_NAME'"
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    success "Cluster déjà existant"
    kind export kubeconfig --name "$CLUSTER_NAME" 2>/dev/null || true
    return 0
  fi
  kind create cluster --name "$CLUSTER_NAME" \
    --config "$K8S_DIR/cluster/kind.yaml" --wait 90s
  kubectl wait --for=condition=Ready nodes --all --timeout=120s
  success "Cluster prêt"
}

# ── Build + load images dans kind ────────────────────────────────────────────
build_and_load() {
  step "Build images Docker"
  docker build -t nexusrh/api:local    --file "$ROOT_DIR/apps/api/Dockerfile"    "$ROOT_DIR"
  docker build -t nexusrh/web:local    --file "$ROOT_DIR/apps/web/Dockerfile"    "$ROOT_DIR"
  kind load docker-image nexusrh/api:local nexusrh/web:local --name "$CLUSTER_NAME"
  if [[ -f "$ROOT_DIR/apps/worker/Dockerfile" ]]; then
    docker build -t nexusrh/worker:local --file "$ROOT_DIR/apps/worker/Dockerfile" "$ROOT_DIR"
    kind load docker-image nexusrh/worker:local --name "$CLUSTER_NAME"
  fi
  success "Images chargées dans kind"
}

# ── cert-manager ──────────────────────────────────────────────────────────────
install_cert_manager() {
  step "cert-manager $CERT_MANAGER_VERSION"
  kubectl get ns cert-manager &>/dev/null && { success "Déjà installé"; return; }
  helm repo add jetstack https://charts.jetstack.io --force-update
  helm upgrade --install cert-manager jetstack/cert-manager \
    -n cert-manager --create-namespace \
    --version "$CERT_MANAGER_VERSION" \
    --set crds.enabled=true \
    --set prometheus.enabled=false \
    --wait --timeout 5m
  kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s
  success "cert-manager prêt"
}

# ── ingress-nginx ─────────────────────────────────────────────────────────────
install_ingress() {
  step "ingress-nginx $INGRESS_NGINX_VERSION"
  kubectl get ns ingress-nginx &>/dev/null && { success "Déjà installé"; return; }
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    -n ingress-nginx --create-namespace \
    --version "$INGRESS_NGINX_VERSION" \
    --set controller.hostPort.enabled=true \
    --set controller.service.type=NodePort \
    --set controller.config.allow-snippet-annotations=true \
    --set controller.config.annotations-risk-level=Critical \
    --set "controller.nodeSelector.ingress-ready=true" \
    --set "controller.tolerations[0].key=node-role.kubernetes.io/control-plane" \
    --set "controller.tolerations[0].operator=Equal" \
    --set "controller.tolerations[0].effect=NoSchedule" \
    --wait --timeout 5m
  kubectl wait --for=condition=Available deployment/ingress-nginx-controller \
    -n ingress-nginx --timeout=120s
  success "ingress-nginx prêt"
}

# ── ClusterIssuers cert-manager ───────────────────────────────────────────────
apply_issuers() {
  step "ClusterIssuers TLS"
  local f="$K8S_DIR/cert-manager/issuers.yaml"
  if [[ "$ENV" == "prod" && -n "${ACME_EMAIL:-}" ]]; then
    sed "s/ACME_EMAIL_PLACEHOLDER/${ACME_EMAIL}/g" "$f" | kubectl apply -f -
  else
    kubectl apply -f "$f"
  fi
  sleep 5  # laissez le webhook cert-manager se stabiliser
  success "Issuers configurés"
}

# ── Helm repos pour les dépendances ──────────────────────────────────────────
add_helm_repos() {
  step "Repos Helm"
  helm repo add meilisearch "$MEILISEARCH_HELM_REPO" --force-update 2>/dev/null || true
  helm repo update
  helm dependency update "$CHART"
  success "Dépendances Helm à jour"
}

# ── Génération values.secret.yaml ────────────────────────────────────────────
generate_secrets() {
  local sec="$K8S_DIR/charts/nexusrh/values.secret.yaml"
  [[ -f "$sec" ]] && { success "values.secret.yaml existant"; return; }
  step "Génération des secrets"
  bash "$K8S_DIR/scripts/generate-secrets.sh"
}

# ── Helm install/upgrade ──────────────────────────────────────────────────────
helm_deploy() {
  step "Helm upgrade --install (overlay: $ENV)"
  local values_overlay="$K8S_DIR/charts/nexusrh/values.${ENV}.yaml"
  local values_secret="$K8S_DIR/charts/nexusrh/values.secret.yaml"

  [[ -f "$values_overlay" ]] || die "Overlay introuvable : $values_overlay"
  [[ -f "$values_secret"  ]] || die "Secrets introuvables : $values_secret\nLancez : bash k8s/scripts/generate-secrets.sh"

  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

  helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" \
    --values "$K8S_DIR/charts/nexusrh/values.yaml" \
    --values "$values_overlay" \
    --values "$values_secret" \
    --wait --timeout 10m \
    --atomic \
    --cleanup-on-fail

  success "Chart déployé"
}

# ── Attente pods ──────────────────────────────────────────────────────────────
wait_pods() {
  step "Attente pods prêts"
  for sts in postgres redis minio meilisearch; do
    kubectl rollout status statefulset -n "$NAMESPACE" \
      -l "app.kubernetes.io/name=$sts" --timeout=180s 2>/dev/null || \
    kubectl wait --for=condition=Ready pod -n "$NAMESPACE" \
      -l "app.kubernetes.io/name=$sts" --timeout=180s 2>/dev/null || \
      warn "$sts pas encore prêt (normal au premier déploiement)"
  done
  kubectl rollout status deployment/nexusrh-api -n "$NAMESPACE" --timeout=120s
  kubectl rollout status deployment/nexusrh-web -n "$NAMESPACE" --timeout=120s
  success "Tous les pods sont prêts"
}

# ── Seed ──────────────────────────────────────────────────────────────────────
run_seed() {
  step "Migration + Seed"
  local pod
  pod="$(kubectl get pod -n "$NAMESPACE" \
    -l "app.kubernetes.io/component=api" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -z "$pod" ]] && { warn "Pod API non trouvé, seed ignoré"; return; }

  kubectl exec "$pod" -n "$NAMESPACE" -- \
    sh -c "cd /app && node dist/db/migrate.js" 2>/dev/null || warn "Migration déjà à jour"
  [[ "$RUN_SEED" == "true" ]] && \
    kubectl exec "$pod" -n "$NAMESPACE" -- \
      sh -c "cd /app && node dist/db/seed.js" || true
  success "Base de données initialisée"
}

# ── Hosts + CA ────────────────────────────────────────────────────────────────
setup_local_access() {
  [[ "$ENV" != "local" ]] && return
  step "Configuration accès local"

  for h in "$DOMAIN" "$API_DOMAIN"; do
    grep -q "$h" /etc/hosts 2>/dev/null || \
      echo "127.0.0.1 $h" | sudo tee -a /etc/hosts > /dev/null
    success "hosts : $h"
  done

  # Extraire et importer la CA locale
  local ca="$HOME/.nexusrh-local-ca.crt"
  kubectl get secret nexusrh-local-ca-secret -n cert-manager \
    -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d > "$ca" 2>/dev/null || true

  if [[ -s "$ca" ]]; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      sudo cp "$ca" /usr/local/share/ca-certificates/nexusrh-local.crt 2>/dev/null && \
        sudo update-ca-certificates && success "CA importée (Linux)" || \
        warn "CA exportée : $ca — importez-la manuellement dans votre navigateur"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      sudo security add-trusted-cert -d -r trustRoot \
        -k /Library/Keychains/System.keychain "$ca" && \
        success "CA importée (macOS)" || \
        warn "CA exportée : $ca — importez-la manuellement dans votre navigateur"
    fi
  else
    warn "CA pas encore prête — réessayez dans 30s : bash deploy.sh --upgrade"
  fi
}

# ── Destroy ───────────────────────────────────────────────────────────────────
destroy() {
  step "Suppression cluster '$CLUSTER_NAME'"
  kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$" && \
    kind delete cluster --name "$CLUSTER_NAME" && success "Cluster supprimé" || \
    warn "Cluster introuvable"
}

# ── Résumé ────────────────────────────────────────────────────────────────────
summary() {
  local elapsed=$SECONDS
  echo ""
  echo -e "${C_GREEN}╔═══════════════════════════════════════════════════╗${C_NC}"
  echo -e "${C_GREEN}║       NexusRH K8s — Déployé en ${elapsed}s !            ║${C_NC}"
  echo -e "${C_GREEN}╚═══════════════════════════════════════════════════╝${C_NC}"
  [[ "$ENV" == "local" ]] && {
    echo -e "\n  ${C_CYAN}Frontend${C_NC} : https://$DOMAIN"
    echo -e "  ${C_CYAN}API${C_NC}      : https://$API_DOMAIN"
    echo -e "  ${C_CYAN}Swagger${C_NC}  : https://$API_DOMAIN/docs"
    echo -e "\n  ${C_YELLOW}superadmin@nexusrh.com / SuperAdmin1234!${C_NC}"
    echo -e "  ${C_YELLOW}admin@techcorp.com     / Admin1234!${C_NC}"
  }
  echo -e "\n  helm status $RELEASE -n $NAMESPACE"
  echo -e "  kubectl get pods -n $NAMESPACE"
  echo -e "  bash deploy.sh --destroy\n"
}

# ── Main ──────────────────────────────────────────────────────────────────────
$STATUS    && { show_status; exit 0; }
$DESTROY   && { destroy; exit 0; }
$SEED_ONLY && { run_seed; exit 0; }

check_prereqs

[[ "$ENV" == "local" ]] && create_cluster

install_cert_manager
install_ingress
apply_issuers
add_helm_repos
generate_secrets

$BUILD_IMAGES && build_and_load

helm_deploy
wait_pods
run_seed
setup_local_access
summary
