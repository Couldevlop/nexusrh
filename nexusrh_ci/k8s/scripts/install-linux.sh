#!/usr/bin/env bash
# install-linux.sh — installe kubectl, kind, helm, mkcert sur Linux/WSL2/macOS
# Usage : bash scripts/install-linux.sh
set -euo pipefail

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
[[ "$ARCH" == "x86_64" ]] && ARCH="amd64"
[[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && ARCH="arm64"

KUBECTL_VERSION="v1.30.2"
KIND_VERSION="v0.23.0"
HELM_VERSION="v3.15.2"
MKCERT_VERSION="v1.4.4"

info()    { echo -e "\033[1;34m[INFO]\033[0m $*"; }
success() { echo -e "\033[1;32m[OK]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[WARN]\033[0m $*"; }
die()     { echo -e "\033[1;31m[ERR]\033[0m $*" >&2; exit 1; }

install_if_missing() {
  local name="$1"; shift
  if command -v "$name" &>/dev/null; then
    success "$name déjà installé ($(command -v "$name"))"
    return 0
  fi
  info "Installation de $name…"
  "$@"
}

# ── Docker / containerd ────────────────────────────────────────────────────────
check_container_runtime() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    success "Docker disponible"
    return 0
  fi
  if command -v nerdctl &>/dev/null; then
    success "nerdctl (containerd) disponible"
    return 0
  fi
  warn "Docker non trouvé. Installation Docker Engine (Linux)…"
  if [[ "$OS" == "linux" ]]; then
    curl -fsSL https://get.docker.com | bash
    sudo usermod -aG docker "$USER"
    warn "Déconnectez-vous et reconnectez-vous pour que le groupe docker soit actif."
    warn "Ou exécutez : newgrp docker"
  else
    die "Installez Docker Desktop : https://docs.docker.com/desktop/install/mac-install/"
  fi
}

# ── kubectl ────────────────────────────────────────────────────────────────────
install_kubectl() {
  curl -fsSLo /tmp/kubectl \
    "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl"
  chmod +x /tmp/kubectl
  sudo mv /tmp/kubectl /usr/local/bin/kubectl
}

# ── kind ──────────────────────────────────────────────────────────────────────
install_kind() {
  curl -fsSLo /tmp/kind \
    "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${OS}-${ARCH}"
  chmod +x /tmp/kind
  sudo mv /tmp/kind /usr/local/bin/kind
}

# ── Helm ──────────────────────────────────────────────────────────────────────
install_helm() {
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
}

# ── mkcert (CA locale pour trust navigateur) ──────────────────────────────────
install_mkcert() {
  local url="https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-${OS}-${ARCH}"
  curl -fsSLo /tmp/mkcert "$url"
  chmod +x /tmp/mkcert
  sudo mv /tmp/mkcert /usr/local/bin/mkcert
}

# ── Vérifications système ─────────────────────────────────────────────────────
check_wsl() {
  if grep -qi microsoft /proc/version 2>/dev/null; then
    info "WSL2 détecté"
    # Sur WSL2, /etc/hosts doit être modifié côté Windows aussi
    warn "Sur WSL2 : ajoutez aussi les entrées hosts dans C:\\Windows\\System32\\drivers\\etc\\hosts"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  info "=== Installation prérequis NexusRH K8s (${OS}/${ARCH}) ==="

  check_container_runtime
  check_wsl

  install_if_missing kubectl install_kubectl
  install_if_missing kind    install_kind
  install_if_missing helm    install_helm
  install_if_missing mkcert  install_mkcert

  echo ""
  success "=== Tous les prérequis sont installés ==="
  echo ""
  echo "  kubectl version : $(kubectl version --client -o json 2>/dev/null | grep -o '"gitVersion":"[^"]*"' | head -1)"
  echo "  kind version    : $(kind --version)"
  echo "  helm version    : $(helm version --short)"
  echo "  mkcert version  : $(mkcert --version 2>/dev/null || echo 'ok')"
}

main "$@"
