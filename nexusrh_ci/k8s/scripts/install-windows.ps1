#Requires -RunAsAdministrator
# install-windows.ps1 — installe kubectl, kind, helm sur Windows (avec ou sans Docker Desktop)
# Usage : PowerShell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
# Prérequis : PowerShell 5.1+ ou PowerShell 7+

param(
  [switch]$SkipDockerCheck,
  [switch]$UseRancherDesktop   # alternative gratuite à Docker Desktop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$KUBECTL_VERSION = "v1.30.2"
$KIND_VERSION    = "v0.23.0"
$HELM_VERSION    = "v3.15.2"
$BIN_DIR         = "$env:ProgramFiles\NexusRH-K8s"

function Write-Info    { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK]   $msg" -ForegroundColor Green }
function Write-Warn    { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err     { param($msg) Write-Host "[ERR]  $msg" -ForegroundColor Red }

function Test-Command { param($Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-ToPath { param($Dir)
  $current = [Environment]::GetEnvironmentVariable("PATH", "Machine")
  if ($current -notlike "*$Dir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$current;$Dir", "Machine")
    $env:PATH = "$env:PATH;$Dir"
    Write-Success "Ajouté au PATH : $Dir"
  }
}

function Install-Binary {
  param($Name, $Url, $OutFile)
  if (Test-Command $Name) {
    Write-Success "$Name déjà installé"
    return
  }
  Write-Info "Téléchargement $Name…"
  New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null
  $dest = "$BIN_DIR\$OutFile"
  Invoke-WebRequest -Uri $Url -OutFile $dest -UseBasicParsing
  Add-ToPath $BIN_DIR
  Write-Success "$Name installé dans $dest"
}

function Install-Winget-Package {
  param($Id)
  if (Test-Command winget) {
    winget install --id $Id --silent --accept-package-agreements --accept-source-agreements
  } else {
    Write-Warn "winget non disponible. Installez manuellement : $Id"
  }
}

# ── Vérification runtime conteneur ────────────────────────────────────────────
function Check-ContainerRuntime {
  if (-not $SkipDockerCheck) {
    $dockerOk = $false
    if (Test-Command docker) {
      try {
        docker info 2>$null | Out-Null
        $dockerOk = $true
        Write-Success "Docker Desktop détecté et opérationnel"
      } catch {}
    }

    if (-not $dockerOk) {
      Write-Warn "Docker Desktop non trouvé ou non démarré."
      if ($UseRancherDesktop) {
        Write-Info "Installation Rancher Desktop (alternative gratuite)…"
        Install-Winget-Package "suse.RancherDesktop"
        Write-Warn "Redémarrez et relancez ce script après l'installation de Rancher Desktop."
        exit 0
      } else {
        Write-Warn "Options :"
        Write-Warn "  1. Installez Docker Desktop : https://www.docker.com/products/docker-desktop/"
        Write-Warn "  2. Relancez avec -UseRancherDesktop pour Rancher Desktop (gratuit)"
        Write-Warn "  3. Activez WSL2 et installez Docker Engine dans WSL2"
        $choice = Read-Host "Continuer sans Docker ? (o/N)"
        if ($choice -notmatch '^[oO]$') { exit 1 }
      }
    }
  }
}

# ── kubectl ────────────────────────────────────────────────────────────────────
function Install-Kubectl {
  $url = "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/windows/amd64/kubectl.exe"
  Install-Binary "kubectl" $url "kubectl.exe"
}

# ── kind ──────────────────────────────────────────────────────────────────────
function Install-Kind {
  $url = "https://kind.sigs.k8s.io/dl/$KIND_VERSION/kind-windows-amd64"
  Install-Binary "kind" $url "kind.exe"
}

# ── Helm ──────────────────────────────────────────────────────────────────────
function Install-Helm {
  if (Test-Command helm) {
    Write-Success "helm déjà installé"
    return
  }
  Write-Info "Installation Helm via script officiel…"
  $helmScript = "$env:TEMP\get-helm.ps1"
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3" `
    -OutFile $helmScript -UseBasicParsing
  # Helm installe dans C:\Program Files\helm\windows-amd64\
  & "$env:ProgramFiles\Git\bin\bash.exe" $helmScript 2>$null
  if (-not (Test-Command helm)) {
    # Fallback : winget
    Install-Winget-Package "Helm.Helm"
  }
  Write-Success "Helm installé"
}

# ── mkcert ────────────────────────────────────────────────────────────────────
function Install-Mkcert {
  if (Test-Command mkcert) {
    Write-Success "mkcert déjà installé"
    return
  }
  Write-Info "Installation mkcert…"
  Install-Winget-Package "FiloSottile.mkcert"
  if (-not (Test-Command mkcert)) {
    $url = "https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe"
    Install-Binary "mkcert" $url "mkcert.exe"
  }
}

# ── Modifier hosts Windows ────────────────────────────────────────────────────
function Add-HostsEntries {
  param([string[]]$Hosts)
  $hostsFile = "C:\Windows\System32\drivers\etc\hosts"
  $content = Get-Content $hostsFile -Raw
  foreach ($h in $Hosts) {
    if ($content -notmatch [regex]::Escape($h)) {
      Add-Content $hostsFile "`n127.0.0.1 $h"
      Write-Success "Ajouté dans hosts : $h"
    } else {
      Write-Success "Déjà dans hosts : $h"
    }
  }
}

# ── Main ──────────────────────────────────────────────────────────────────────
function Main {
  Write-Info "=== Installation prérequis NexusRH K8s (Windows) ==="

  Check-ContainerRuntime
  Install-Kubectl
  Install-Kind
  Install-Helm
  Install-Mkcert

  Write-Info "Ajout des entrées hosts locales…"
  Add-HostsEntries @("nexusrh.local", "api.nexusrh.local")

  Write-Host ""
  Write-Success "=== Tous les prérequis sont installés ==="
  Write-Host ""
  Write-Host "  kubectl : $(kubectl version --client --short 2>$null)"
  Write-Host "  kind    : $(kind --version)"
  Write-Host "  helm    : $(helm version --short)"
  Write-Host ""
  Write-Warn "Redémarrez votre terminal pour que le PATH soit pris en compte."
  Write-Host "Ensuite : .\deploy.ps1"
}

Main
