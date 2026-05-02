# NexusRH CI — Guide d'installation K8s (kind)

## PHASE 1 — DESTRUCTION

```powershell
# 1. Supprimer le déploiement Helm
helm uninstall nexusrh -n nexusrh

# 2. Supprimer les namespaces
kubectl delete namespace nexusrh
kubectl delete namespace cert-manager
kubectl delete namespace ingress-nginx

# 3. Détruire le cluster
$env:PATH = "$env:PATH;$env:LOCALAPPDATA\bin-k8s"
kind delete cluster --name nexusrh

# 4. Vérifier — doit retourner vide
kind get clusters
kubectl config get-contexts
```

---

## PHASE 2 — REPRODUCTION

### A. Construire les images Docker
```powershell
cd D:\OPENLAB\nexusrh\nexusrh_ci

docker build -t nexusrh/api:local -f apps/api/Dockerfile .
docker build -t nexusrh/web:local -f apps/web/Dockerfile .
```

### B. Créer le cluster kind
```powershell
$env:PATH = "$env:PATH;$env:LOCALAPPDATA\bin-k8s"

kind create cluster --name nexusrh --config k8s\kind-config.yaml

# Vérifier — tous les nœuds doivent être Ready
kubectl get nodes
```

### C. Installer cert-manager
```powershell
helm repo add jetstack https://charts.jetstack.io --force-update

helm upgrade --install cert-manager jetstack/cert-manager `
  --namespace cert-manager --create-namespace `
  --set crds.enabled=true --wait --timeout 3m

# Vérifier
kubectl get pods -n cert-manager
```

### D. Installer ingress-nginx
```powershell
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx `
  --namespace ingress-nginx --create-namespace `
  --set controller.allowSnippetAnnotations=true `
  --timeout 8m

kubectl wait deployment ingress-nginx-controller `
  -n ingress-nginx --for=condition=Available --timeout=480s
```

### E. Charger les images dans kind
> kind ne tire pas depuis Docker Hub — toutes les images doivent être chargées manuellement.

```powershell
kind load docker-image `
  nexusrh/api:local `
  nexusrh/web:local `
  postgres:16-alpine `
  redis:7-alpine `
  "minio/minio:RELEASE.2024-10-02T17-50-41Z" `
  busybox:1.36 `
  --name nexusrh
```

### F. Déployer avec Helm

```powershell
# Préparer le namespace pour Helm
kubectl create namespace nexusrh
kubectl annotate namespace nexusrh `
  "meta.helm.sh/release-name=nexusrh" `
  "meta.helm.sh/release-namespace=nexusrh"
kubectl label namespace nexusrh "app.kubernetes.io/managed-by=Helm"

# Déployer
cd D:\OPENLAB\nexusrh\nexusrh_ci\k8s

helm upgrade --install nexusrh charts/nexusrh `
  --namespace nexusrh `
  -f charts/nexusrh/values.yaml `
  -f charts/nexusrh/values.local.yaml `
  -f charts/nexusrh/values.secret.yaml

# Désactiver le worker (image non construite en local)
kubectl scale deployment nexusrh-worker -n nexusrh --replicas=0

# Surveiller le démarrage
kubectl get pods -n nexusrh -w
```

### G. Seed base de données
```powershell
$pod = kubectl get pod -n nexusrh `
  -l "app.kubernetes.io/component=api" `
  -o jsonpath="{.items[0].metadata.name}"

kubectl exec -n nexusrh $pod -- node dist/db/seed.js
```

---

## Comptes de connexion

| Email | Mot de passe | Rôle |
|-------|-------------|------|
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` | super_admin |
| `admin@sotra.ci` | `Admin1234!` | admin |
| `drh@sotra.ci` | `Admin1234!` | hr_manager |
| `manager@sotra.ci` | `Admin1234!` | manager |
| `employe@sotra.ci` | `Admin1234!` | employee |
| `admin@cabinet-expertise.ci` | `Admin1234!` | admin |
| `coulwao@gmail.com` | `Openlab2025!` | admin |

## Accès local

Ajouter dans `C:\Windows\System32\drivers\etc\hosts` :
```
127.0.0.1  nexusrh.local api.nexusrh.local
```

| Service | URL |
|---------|-----|
| Frontend | https://nexusrh.local |
| API | https://api.nexusrh.local |
| Swagger | https://api.nexusrh.local/docs |

## Commandes utiles

```powershell
# État des pods
kubectl get pods -n nexusrh

# Logs API en temps réel
kubectl logs -n nexusrh -l app.kubernetes.io/component=api -f

# Relancer le seed
kubectl exec -n nexusrh $pod -- node dist/db/seed.js

# Désinstaller sans détruire le cluster
helm uninstall nexusrh -n nexusrh
```
