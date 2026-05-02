# NexusRH — Déploiement Kubernetes (Helm)

Déploiement en ~10 min, local ou cloud, avec HTTPS automatique.  
**Helm** · **cert-manager** · **OWASP 2026** · **CIS K8s Benchmark** · **Pod Security Standards (restricted)**

---

## Démarrage rapide

### Windows (Docker Desktop ou Rancher Desktop)

```powershell
# 1. Prérequis — une seule fois (en admin)
PowerShell -ExecutionPolicy Bypass -File k8s\scripts\install-windows.ps1

# 2. Déployer
.\k8s\deploy.ps1
```

### Linux / macOS / WSL2

```bash
# 1. Prérequis — une seule fois
bash k8s/scripts/install-linux.sh

# 2. Déployer
bash k8s/deploy.sh
```

Résultat après ~8-10 min :

| URL | Description |
|-----|-------------|
| `https://nexusrh.local` | Frontend React |
| `https://api.nexusrh.local` | API Fastify |
| `https://api.nexusrh.local/docs` | Swagger |

---

## Sans Docker Desktop (Windows)

```powershell
# Option Rancher Desktop (gratuit, containerd)
.\k8s\scripts\install-windows.ps1 -UseRancherDesktop
# Redémarrer puis :
.\k8s\deploy.ps1

# Option WSL2 + Docker Engine
# Dans WSL2 :
curl -fsSL https://get.docker.com | bash
sudo usermod -aG docker $USER && newgrp docker
bash k8s/scripts/install-linux.sh && bash k8s/deploy.sh
```

---

## Structure du dossier

```
k8s/
├── deploy.sh / deploy.ps1          ← Script principal (tout-en-un)
├── charts/
│   └── nexusrh/                    ← Chart Helm NexusRH
│       ├── Chart.yaml              ← Dépendances : postgresql, redis, minio, meilisearch (Bitnami)
│       ├── values.yaml             ← Valeurs par défaut + sécurité OWASP
│       ├── values.local.yaml       ← Surcharges kind local
│       ├── values.prod.yaml        ← Surcharges production
│       ├── values.secret.yaml      ← [gitignored] Secrets générés par generate-secrets.sh
│       └── templates/
│           ├── _helpers.tpl        ← Fonctions communes
│           ├── namespace.yaml      ← Namespace + LimitRange + ResourceQuota
│           ├── rbac.yaml           ← ServiceAccounts + Roles (least privilege)
│           ├── networkpolicies.yaml← Default-deny + règles minimales
│           ├── configmap.yaml      ← Vars non-sensibles
│           ├── secret.yaml         ← K8s Secret (injecté depuis values.secret.yaml)
│           ├── api.yaml            ← Deployment + Service + HPA + PDB
│           ├── web.yaml            ← Deployment + Service + PDB
│           ├── worker.yaml         ← Deployment BullMQ
│           └── ingress.yaml        ← Ingress NGINX + headers sécurité + TLS
├── cert-manager/
│   └── issuers.yaml                ← CA locale + Let's Encrypt staging + prod
├── cluster/
│   └── kind.yaml                   ← Config cluster kind 3 nœuds
└── scripts/
    ├── generate-secrets.sh         ← Génère values.secret.yaml
    ├── install-linux.sh            ← kubectl + kind + helm + mkcert
    └── install-windows.ps1         ← Idem sur Windows
```

---

## Commandes de déploiement

```bash
# Linux / WSL2 / macOS
bash k8s/deploy.sh                  # Déploiement local complet
bash k8s/deploy.sh --no-build       # Sans rebuild images
bash k8s/deploy.sh --no-seed        # Sans seed BDD
bash k8s/deploy.sh --upgrade        # helm upgrade seul (chart modifié)
bash k8s/deploy.sh --seed           # Relancer uniquement le seed
bash k8s/deploy.sh --status         # kubectl get pods / ingress
bash k8s/deploy.sh --destroy        # Supprimer le cluster kind
bash k8s/deploy.sh --env prod       # Déploiement production
```

```powershell
# Windows
.\k8s\deploy.ps1                    # Déploiement local complet
.\k8s\deploy.ps1 -NoBuild           # Sans rebuild
.\k8s\deploy.ps1 -NoSeed            # Sans seed
.\k8s\deploy.ps1 -Upgrade           # helm upgrade seul
.\k8s\deploy.ps1 -SeedOnly          # Seed uniquement
.\k8s\deploy.ps1 -Status            # État du cluster
.\k8s\deploy.ps1 -Destroy           # Supprimer le cluster
.\k8s\deploy.ps1 -Env prod          # Production
```

---

## Helm — Opérations manuelles

```bash
# Inspecter les valeurs effectives
helm get values nexusrh -n nexusrh

# Voir les ressources générées sans déployer
helm template nexusrh k8s/charts/nexusrh \
  -f k8s/charts/nexusrh/values.local.yaml \
  -f k8s/charts/nexusrh/values.secret.yaml

# Rollback
helm rollback nexusrh -n nexusrh

# Désinstaller (conserve les PVC)
helm uninstall nexusrh -n nexusrh

# Supprimer aussi les PVC (données perdues !)
kubectl delete pvc --all -n nexusrh
```

---

## HTTPS — Certificats

### Local (automatique)

cert-manager crée une **CA auto-signée** → émet les certificats TLS pour `nexusrh.local` et `api.nexusrh.local`.  
Le script exporte et installe la CA dans le store OS.

Sur Windows/Chrome, si "non sécurisé" persiste :
```powershell
# Extraire le CA
kubectl get secret nexusrh-local-ca-secret -n cert-manager `
  -o jsonpath='{.data.tls\.crt}' | [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_)) `
  | Out-File nexusrh-ca.crt

# Importer dans Windows
certutil -addstore "Root" nexusrh-ca.crt
```

### Production (Let's Encrypt automatique)

```yaml
# values.prod.yaml — déjà configuré
ingress:
  certIssuer: letsencrypt-prod
```

cert-manager challenge HTTP-01 → renouvellement auto tous les 60 jours.

---

## Secrets en production

**Ne jamais committer `values.secret.yaml`.**

### Option 1 — Sealed Secrets (git-friendly)
```bash
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system

# Chiffrer
helm template nexusrh k8s/charts/nexusrh \
  -f values.secret.yaml -s templates/secret.yaml \
  | kubeseal -o yaml > k8s/charts/nexusrh/sealed-secret.yaml
# sealed-secret.yaml peut être commité
```

### Option 2 — External Secrets Operator (cloud)
Désactiver `templates/secret.yaml` dans `Chart.yaml` et déployer une `ExternalSecret` pointant vers AWS Secrets Manager, Azure Key Vault, ou HashiCorp Vault.

---

## Sécurité — OWASP 2026

| Contrôle | Implémentation |
|----------|----------------|
| **A01** Broken Access Control | RBAC least-privilege, NetworkPolicies default-deny ingress+egress |
| **A02** Cryptographic Failures | TLS partout, cert-manager, `values.secret.yaml` gitignored |
| **A04** Insecure Design | Pod Security Standards `restricted` enforced sur le namespace |
| **A05** Security Misconfiguration | `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: ALL`, `seccompProfile: RuntimeDefault` |
| **A06** Vulnerable Components | Tags d'images versionnées (`latest` interdit en prod) |
| **A07** Auth failures | JWT_SECRET injecté via K8s Secret (`stringData`), jamais ConfigMap |
| **A10** SSRF | Egress NetworkPolicies limitées aux ports 5432/6379/9000/587/443 |
| Headers HTTP | X-Frame-Options DENY, CSP, HSTS 1 an, X-Content-Type-Options, Referrer-Policy |
| Rate limiting | `limit-rps: 30`, `limit-connections: 10` sur Ingress NGINX |
| Quotas | LimitRange + ResourceQuota sur namespace |
| Anti-affinité | PodAntiAffinity pour API et Web (HA multi-nœuds) |
| PDB | PodDisruptionBudget sur API et Web (minAvailable: 1) |

---

## Parité local / cloud

| | Local (kind) | Cloud (AKS/GKE/EKS/k3s) |
|--|--|--|
| Cluster | `kind create cluster` | Votre cluster existant |
| Images | `kind load docker-image` | Registry CI/CD (ghcr.io, ECR…) |
| Storage | PVC local-path | PVC cloud (EBS, Disk…) |
| Ingress IP | `127.0.0.1` | LoadBalancer IP publique |
| TLS | CA auto-signée | Let's Encrypt auto |
| Secrets | `values.secret.yaml` local | Sealed Secrets / ESO |
| Commande | `bash deploy.sh` | `bash deploy.sh --env prod --no-build` |

---

## Chargement des données de test (seed)

### Prérequis : images Docker dans le cluster

Le seed s'exécute dans le pod API. Il faut donc d'abord construire et charger les images :

```powershell
# Windows — depuis la racine du projet nexusrh_ci
docker build -t nexusrh/api:local -f apps/api/Dockerfile .
docker build -t nexusrh/web:local -f apps/web/Dockerfile .
kind load docker-image nexusrh/api:local nexusrh/web:local --name nexusrh

# Si un worker existe :
docker build -t nexusrh/worker:local -f apps/worker/Dockerfile .
kind load docker-image nexusrh/worker:local --name nexusrh
```

```bash
# Linux / WSL2
docker build -t nexusrh/api:local -f apps/api/Dockerfile .
docker build -t nexusrh/web:local -f apps/web/Dockerfile .
kind load docker-image nexusrh/api:local nexusrh/web:local --name nexusrh
```

### Déployer avec les images puis seeder

```powershell
# Windows — redéployer avec les images (upgrade sans rebuild)
.\k8s\deploy.ps1 -Upgrade -NoSeed

# Puis injecter les données
.\k8s\deploy.ps1 -SeedOnly
```

```bash
# Linux / WSL2
bash k8s/deploy.sh --upgrade --no-seed
bash k8s/deploy.sh --seed
```

Ce que fait le seed :

| Étape | Commande dans le pod | Résultat |
|-------|----------------------|---------|
| Migration | `node dist/db/migrate.js` | Crée les schémas PostgreSQL (platform, tenant_techcorp, tenant_artisanpro) |
| Seed | `node dist/db/seed.js` | Insère super_admin + TechCorp (50 emp.) + ArtisanPro (18 emp.) |

### Vérifier que le seed a fonctionné

```powershell
# Lister les pods — le pod API doit être Running
kubectl get pods -n nexusrh

# Voir les logs du seed
$pod = kubectl get pod -n nexusrh -l app.kubernetes.io/component=api -o jsonpath="{.items[0].metadata.name}"
kubectl logs $pod -n nexusrh | Select-String -Pattern "seed|Seed|tenant|error" | Select-Object -Last 30
```

```bash
# Linux
POD=$(kubectl get pod -n nexusrh -l app.kubernetes.io/component=api -o jsonpath="{.items[0].metadata.name}")
kubectl logs $POD -n nexusrh | grep -i "seed\|tenant\|error" | tail -30
```

### Relancer le seed uniquement (après un reset BDD)

```powershell
.\k8s\deploy.ps1 -SeedOnly          # Windows
bash k8s/deploy.sh --seed           # Linux
```

---

## Comptes de test (après seed)

| Email | Mot de passe | Rôle | Redirige vers |
|-------|-------------|------|--------------|
| `superadmin@nexusrh.com` | `SuperAdmin1234!` | super_admin | `/platform/dashboard` |
| `admin@techcorp.com` | `Admin1234!` | admin TechCorp | `/dashboard` |
| `rh@techcorp.com` | `Admin1234!` | hr_manager | `/dashboard` |
| `manager@techcorp.com` | `Admin1234!` | manager | `/dashboard` |
| `employe@techcorp.com` | `Admin1234!` | employee | `/mon-espace` |
| `admin@artisanpro.com` | `Admin1234!` | admin ArtisanPro | `/dashboard` |

---

## Dépannage

```bash
# Pod en erreur
kubectl describe pod <nom> -n nexusrh
kubectl logs <nom> -n nexusrh --previous

# Certificat TLS non émis
kubectl describe certificate -n nexusrh
kubectl describe clusterissuer nexusrh-local-issuer

# Helm debug
helm get values nexusrh -n nexusrh
helm history nexusrh -n nexusrh

# Port-forward direct (bypass Ingress)
kubectl port-forward svc/api-svc 4000:4000 -n nexusrh &
kubectl port-forward svc/web-svc 3000:3000 -n nexusrh &

# Reset complet
bash k8s/deploy.sh --destroy && bash k8s/deploy.sh
```
