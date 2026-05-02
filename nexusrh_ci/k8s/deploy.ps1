# deploy.ps1 - NexusRH K8s (Helm) - Windows PowerShell 5.1+
# Usage :
#   .\deploy.ps1                       # local kind
#   .\deploy.ps1 -Env prod             # production
#   .\deploy.ps1 -Destroy              # supprime cluster
#   .\deploy.ps1 -Status               # etat
#   .\deploy.ps1 -Upgrade              # helm upgrade sans rebuild
param(
  [string]$Env      = "local",
  [string]$Domain   = "nexusrh.local",
  [switch]$Destroy,
  [switch]$Status,
  [switch]$SeedOnly,
  [switch]$NoBuild,
  [switch]$NoSeed,
  [switch]$Upgrade
)

# Ne PAS mettre ErrorActionPreference = Stop globalement :
# les commandes natives (kind, helm, kubectl) ecrivent sur stderr
# et cela declenche NativeCommandError en mode Stop.
$ErrorActionPreference = "Continue"

# Ajouter kind/helm au PATH de la session si installes localement
$localBin = "$env:LOCALAPPDATA\bin-k8s"
if ((Test-Path $localBin) -and ($env:PATH -notlike "*$localBin*")) {
  $env:PATH = "$env:PATH;$localBin"
}

$CLUSTER_NAME     = "nexusrh"
$NAMESPACE        = "nexusrh"
$RELEASE          = "nexusrh"
$CHART            = "$PSScriptRoot\charts\nexusrh"
$CERT_MGR_VERSION = "v1.15.1"
$INGRESS_VERSION  = "4.10.1"
$K8S_DIR          = $PSScriptRoot
$ROOT_DIR         = Split-Path $K8S_DIR -Parent
$BUILD_IMAGES     = (-not $NoBuild) -and ($Env -eq "local") -and (-not $Upgrade)
$START            = Get-Date

# -- Helpers --
function Write-Step    { param($m) Write-Host "" ; Write-Host "=== $m ===" -ForegroundColor Blue }
function Write-Info    { param($m) Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Success { param($m) Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Warn    { param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Err     { param($m) Write-Host "[ERR]  $m" -ForegroundColor Red ; exit 1 }
function Test-Cmd      { param($n) return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

# Executer une commande native, retourner $true si exitcode = 0
function Invoke-Cmd {
  param([scriptblock]$Block, [switch]$PassThru)
  $out = & $Block 2>&1
  if ($PassThru) { return $out }
  return ($LASTEXITCODE -eq 0)
}

# Tester si un namespace k8s existe
function Test-Namespace {
  param($Name)
  kubectl get namespace $Name 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# Tester si un cluster kind existe
function Test-KindCluster {
  param($Name)
  $out = kind get clusters 2>&1
  $strings = $out | Where-Object { $_ -is [string] }
  return ($strings -contains $Name)
}

# -- Prerequis --
function Check-Prereqs {
  Write-Step "Verification des prerequis"
  $miss = @()
  foreach ($c in @("kubectl","kind","helm","docker")) {
    if (-not (Test-Cmd $c)) { $miss += $c }
  }
  if ($miss.Count -gt 0) {
    Write-Err ("Manquants : " + ($miss -join ", ") + " - Lancez : scripts\install-windows.ps1")
  }
  docker ps 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Docker non demarre. Lancez Docker Desktop."
  }
  Write-Success "Prerequis OK"
}

# -- Statut --
function Show-Status {
  kubectl get nodes -o wide 2>&1
  kubectl get pods -n $NAMESPACE 2>&1
  kubectl get ingress -n $NAMESPACE 2>&1
}

# -- Cluster kind --
function New-Cluster {
  Write-Step "Cluster kind '$CLUSTER_NAME'"
  if (Test-KindCluster $CLUSTER_NAME) {
    Write-Success "Deja existant"
    kind export kubeconfig --name $CLUSTER_NAME 2>&1 | Out-Null
    return
  }
  Write-Info "Creation du cluster (3 noeuds, ~2 min)..."
  kind create cluster --name $CLUSTER_NAME --config "$K8S_DIR\cluster\kind.yaml" --wait 90s
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec creation cluster kind." }
  kubectl wait --for=condition=Ready nodes --all --timeout=120s
  Write-Success "Cluster pret"
}

# -- Build images --
function Build-Images {
  Write-Step "Build images Docker"
  docker build -t nexusrh/api:local --file "$ROOT_DIR\apps\api\Dockerfile" $ROOT_DIR
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec build nexusrh/api" }
  docker build -t nexusrh/web:local --file "$ROOT_DIR\apps\web\Dockerfile" $ROOT_DIR
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec build nexusrh/web" }
  kind load docker-image nexusrh/api:local nexusrh/web:local --name $CLUSTER_NAME
  if (Test-Path "$ROOT_DIR\apps\worker\Dockerfile") {
    docker build -t nexusrh/worker:local --file "$ROOT_DIR\apps\worker\Dockerfile" $ROOT_DIR
    kind load docker-image nexusrh/worker:local --name $CLUSTER_NAME
  }
  Write-Success "Images chargees dans kind"
}

# -- cert-manager --
function Install-CertManager {
  Write-Step "cert-manager $CERT_MGR_VERSION"
  if (Test-Namespace "cert-manager") { Write-Success "Deja installe" ; return }
  helm repo add jetstack https://charts.jetstack.io --force-update 2>&1 | Out-Null
  helm upgrade --install cert-manager jetstack/cert-manager `
    -n cert-manager --create-namespace `
    --version $CERT_MGR_VERSION `
    --set crds.enabled=true `
    --set prometheus.enabled=false `
    --wait --timeout 5m
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec installation cert-manager" }
  kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s
  Write-Success "cert-manager pret"
}

# -- ingress-nginx --
function Install-Ingress {
  Write-Step "ingress-nginx $INGRESS_VERSION"
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>&1 | Out-Null
  # Sans --wait : le pull de l'image prend parfois >5min sur kind
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx `
    -n ingress-nginx --create-namespace `
    --version $INGRESS_VERSION `
    --set controller.hostPort.enabled=true `
    --set controller.service.type=NodePort `
    --set controller.allowSnippetAnnotations=true `
    --set-string "controller.nodeSelector.ingress-ready=true" `
    --set "controller.tolerations[0].key=node-role.kubernetes.io/control-plane" `
    --set "controller.tolerations[0].operator=Equal" `
    --set "controller.tolerations[0].effect=NoSchedule"
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec installation ingress-nginx" }
  Write-Info "Attente ingress-nginx controller (jusqu'a 8 min)..."
  kubectl wait --for=condition=Available deployment/ingress-nginx-controller `
    -n ingress-nginx --timeout=480s
  if ($LASTEXITCODE -ne 0) { Write-Warn "ingress-nginx pas encore Available - verifiez : kubectl get pods -n ingress-nginx" }
  Write-Success "ingress-nginx pret"
}

# -- ClusterIssuers --
function Apply-Issuers {
  Write-Step "ClusterIssuers TLS"
  kubectl apply -f "$K8S_DIR\cert-manager\issuers.yaml"
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec application des issuers" }
  Start-Sleep 5
  Write-Success "Issuers configures"
}

# -- Repos Helm + dependances --
function Add-HelmRepos {
  Write-Step "Repos Helm et dependances"
  helm repo add meilisearch "https://meilisearch.github.io/meilisearch-kubernetes" --force-update 2>&1 | Out-Null
  helm repo update 2>&1 | Out-Null
  Write-Info "helm dependency update (telechargement des sous-charts)..."
  helm dependency update $CHART
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec dependency update" }
  Write-Success "Dependances Helm OK"
}

# -- Secrets (generation PowerShell native, pas besoin de bash) --
function New-RandomHex { param($Bytes = 32) ; -join ((1..$Bytes) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }

function Generate-Secrets {
  $sec = "$CHART\values.secret.yaml"
  if (Test-Path $sec) { Write-Success "values.secret.yaml existant" ; return }
  Write-Step "Generation des secrets"

  $pgPass    = New-RandomHex 24
  $redisPass = New-RandomHex 24
  $minioPass = New-RandomHex 24
  $jwtSecret = (New-RandomHex 32) + (New-RandomHex 32)
  $meiliKey  = New-RandomHex 24

  # Lire valeurs depuis .env si present
  $envFile = "$ROOT_DIR\.env"
  $anthropicKey = "sk-ant-api03-REPLACE_ME"
  $smtpUser = "REPLACE@gmail.com"
  $smtpPass = "REPLACE_APP_PASSWORD"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match "^ANTHROPIC_API_KEY=(.+)") { $anthropicKey = $Matches[1].Trim() }
      if ($_ -match "^SMTP_USER=(.+)")          { $smtpUser     = $Matches[1].Trim() }
      if ($_ -match "^SMTP_PASS=(.+)")          { $smtpPass     = $Matches[1].Trim() }
      if ($_ -match "^JWT_SECRET=(.+)")         { $jwtSecret    = $Matches[1].Trim() }
    }
  }

  $content = @"
# GENERE AUTOMATIQUEMENT - NE PAS COMMITTER
# $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
postgres:
  auth:
    password: "$pgPass"

redis:
  auth:
    password: "$redisPass"

minio:
  auth:
    rootPassword: "$minioPass"

meilisearch:
  auth:
    masterKey: "$meiliKey"

api:
  secrets:
    jwtSecret: "$jwtSecret"
    anthropicApiKey: "$anthropicKey"
    smtpUser: "$smtpUser"
    smtpPass: "$smtpPass"
    smtpFrom: "NexusRH <$smtpUser>"
    googleClientId: ""
    googleClientSecret: ""
    microsoftClientId: ""
    microsoftClientSecret: ""
    microsoftTenantId: "common"
"@
  $content | Out-File -FilePath $sec -Encoding utf8 -Force
  Write-Success "values.secret.yaml cree : $sec"
  Write-Info ("  JWT_SECRET    : " + $jwtSecret.Substring(0,8) + "...")
  Write-Info ("  POSTGRES_PASS : " + $pgPass.Substring(0,8) + "...")
  Write-Warn "Renseignez ANTHROPIC_API_KEY dans $sec si besoin."
}

# -- Helm install/upgrade --
function Invoke-HelmDeploy {
  Write-Step "Helm upgrade --install (overlay: $Env)"
  $valOverlay = "$CHART\values.$Env.yaml"
  $valSecret  = "$CHART\values.secret.yaml"
  if (-not (Test-Path $valOverlay)) { Write-Err "Overlay introuvable : $valOverlay" }
  if (-not (Test-Path $valSecret))  { Write-Err "Secrets introuvables : $valSecret - lancez : bash scripts/generate-secrets.sh" }

  # Pre-creer le namespace avec les labels Helm pour eviter le conflit d'adoption
  kubectl create namespace $NAMESPACE 2>&1 | Out-Null
  kubectl annotate namespace $NAMESPACE "meta.helm.sh/release-name=$RELEASE" "meta.helm.sh/release-namespace=$NAMESPACE" --overwrite 2>&1 | Out-Null
  kubectl label namespace $NAMESPACE "app.kubernetes.io/managed-by=Helm" --overwrite 2>&1 | Out-Null

  # En local : pas d'--atomic (les images app peuvent manquer si -NoBuild)
  if ($Env -eq "local") {
    helm upgrade --install $RELEASE $CHART `
      --namespace $NAMESPACE `
      --values "$CHART\values.yaml" `
      --values $valOverlay `
      --values $valSecret
  } else {
    helm upgrade --install $RELEASE $CHART `
      --namespace $NAMESPACE `
      --values "$CHART\values.yaml" `
      --values $valOverlay `
      --values $valSecret `
      --wait --timeout 10m `
      --atomic `
      --cleanup-on-fail
  }

  if ($LASTEXITCODE -ne 0) { Write-Err "Echec helm upgrade --install" }
  Write-Success "Chart deploye"
}

# -- Attente pods --
function Wait-Pods {
  Write-Step "Attente que les pods soient prets"
  if (-not $BUILD_IMAGES -and $Env -eq "local") {
    Write-Warn "Images non construites (-NoBuild). Pods app non demarres - relancez sans -NoBuild pour un deploiement complet."
    return
  }
  kubectl rollout status deployment/nexusrh-api -n $NAMESPACE --timeout=120s
  if ($LASTEXITCODE -ne 0) { Write-Warn "nexusrh-api pas encore pret (pod en cours de demarrage ?)" }
  kubectl rollout status deployment/nexusrh-web -n $NAMESPACE --timeout=120s
  if ($LASTEXITCODE -ne 0) { Write-Warn "nexusrh-web pas encore pret" }
  Write-Success "Verification pods terminee"
}

# -- Seed --
function Run-Seed {
  Write-Step "Migration et Seed base de donnees"
  # Recuperer uniquement les pods Running, filtrer les erreurs kubectl
  $pod = kubectl get pod -n $NAMESPACE `
    -l "app.kubernetes.io/component=api" `
    --field-selector=status.phase=Running `
    -o jsonpath="{.items[0].metadata.name}" 2>$null
  if (-not $pod -or $pod -eq "" -or $pod -match "^error") {
    Write-Warn "Pod API non trouve ou non Running."
    Write-Warn "Verifiez : kubectl get pods -n $NAMESPACE"
    Write-Warn "Relancez avec -SeedOnly une fois le pod pret."
    return
  }
  Write-Info ("Pod API : " + $pod)
  kubectl exec -n $NAMESPACE $pod -- sh -c 'cd /app && node dist/db/migrate.js'
  if ($LASTEXITCODE -ne 0) { Write-Err "Echec migration BDD" }
  if (-not $NoSeed) {
    kubectl exec -n $NAMESPACE $pod -- sh -c 'cd /app && node dist/db/seed.js'
    if ($LASTEXITCODE -ne 0) { Write-Err "Echec seed BDD" }
    Write-Success "Seed termine"
  }
}

# -- Hosts Windows --
function Update-Hosts {
  if ($Env -ne "local") { return }
  Write-Step "Mise a jour hosts Windows"
  $hf = "C:\Windows\System32\drivers\etc\hosts"
  $content = Get-Content $hf -Raw -ErrorAction SilentlyContinue
  foreach ($h in @($Domain, ("api." + $Domain))) {
    if ($content -notmatch [regex]::Escape($h)) {
      Add-Content $hf ("`n127.0.0.1 " + $h)
      Write-Success ("hosts : " + $h)
    } else {
      Write-Success ("Deja dans hosts : " + $h)
    }
  }
}

# -- Destroy --
function Remove-Cluster {
  Write-Step "Suppression cluster '$CLUSTER_NAME'"
  if (Test-KindCluster $CLUSTER_NAME) {
    kind delete cluster --name $CLUSTER_NAME
    Write-Success "Cluster supprime"
  } else {
    Write-Warn "Cluster '$CLUSTER_NAME' introuvable"
  }
}

# -- Resume --
function Print-Summary {
  $elapsed = [int]((Get-Date) - $START).TotalSeconds
  Write-Host ""
  Write-Host "============================================" -ForegroundColor Green
  Write-Host ("  NexusRH K8s deploye via Helm en " + $elapsed + "s") -ForegroundColor Green
  Write-Host "============================================" -ForegroundColor Green
  if ($Env -eq "local") {
    Write-Host ""
    Write-Host ("  Frontend : https://" + $Domain)              -ForegroundColor Cyan
    Write-Host ("  API      : https://api." + $Domain)          -ForegroundColor Cyan
    Write-Host ("  Swagger  : https://api." + $Domain + "/docs") -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  superadmin@nexusrh.com / SuperAdmin1234!" -ForegroundColor Yellow
    Write-Host "  admin@techcorp.com     / Admin1234!"      -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host ("  helm status " + $RELEASE + " -n " + $NAMESPACE)
  Write-Host ("  kubectl get pods -n " + $NAMESPACE)
  Write-Host "  .\deploy.ps1 -Destroy"
  Write-Host ""
}

# -- Main --
if ($Status)   { Show-Status    ; exit 0 }
if ($Destroy)  { Remove-Cluster ; exit 0 }
if ($SeedOnly) { Run-Seed       ; exit 0 }

Check-Prereqs

if ($Env -eq "local") { New-Cluster }

Install-CertManager
Install-Ingress
Apply-Issuers
Add-HelmRepos
Generate-Secrets

if ($BUILD_IMAGES) { Build-Images }

Invoke-HelmDeploy
Wait-Pods

if (-not $NoSeed) { Run-Seed }
if ($Env -eq "local") { Update-Hosts }

Print-Summary
